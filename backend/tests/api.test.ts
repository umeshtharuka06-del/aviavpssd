import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AnalysisResponseSchema, ErrorBodySchema } from '@aviator/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/api/app.js';
import { loadEnv } from '../src/config/env.js';
import { createPool } from '../src/database/pool.js';
import { MockAnalysisProvider } from '../src/engine/mock-provider.js';
import { adminHeaders, bearer, createAdmin, createHarness, generate, redeem, resetDb, TEST_SECRETS, testEnv, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => h.close());
beforeEach(async () => resetDb(h.pool));

describe('health', () => {
  it('liveness reveals no infrastructure details', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/v1/health' });
    expect(res.statusCode).toBe(200);
    expect(Object.keys(res.json()).sort()).toEqual(['status', 'time', 'version']);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('readiness checks the database', async () => {
    expect((await h.app.inject({ method: 'GET', url: '/v1/health/ready' })).statusCode).toBe(200);
  });

  it('readiness returns 503 SERVICE_UNAVAILABLE when the database is unreachable', async () => {
    const env = testEnv({ DATABASE_URL: 'postgres://nobody:nothing@127.0.0.1:1/none' });
    const pool = createPool(env.DATABASE_URL, 1);
    const app = await buildApp({ env, pool, now: () => new Date(), analysisProvider: new MockAnalysisProvider() }, { logger: false });
    try {
      const res = await app.inject({ method: 'GET', url: '/v1/health/ready' });
      expect(res.statusCode).toBe(503);
      expect(res.json().error.code).toBe('SERVICE_UNAVAILABLE');
      expect(res.body).not.toContain('127.0.0.1');
      expect(res.body).not.toContain('postgres://');
    } finally {
      await app.close();
      await pool.end();
    }
  });
});

describe('error contract', () => {
  it('unknown routes and every error use the documented shape with a request id', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/v1/nope' });
    expect(res.statusCode).toBe(404);
    const body = ErrorBodySchema.parse(res.json());
    expect(body.error.requestId).toBe(res.headers['x-request-id']);
  });

  it('validation errors list paths but never echo submitted values', async () => {
    const res = await h.app.inject({ method: 'POST', url: '/v1/activation/redeem', payload: { code: 'AVX-SECRET-VALUE-XXXX', deviceId: 'not-a-uuid' } });
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain('not-a-uuid');
    expect(res.body).not.toContain('SECRET');
  });

  it('ignores client-supplied request ids', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/v1/health', headers: { 'x-request-id': 'attacker-controlled' } });
    expect(res.headers['x-request-id']).not.toBe('attacker-controlled');
  });
});

describe('analysis (mock provider)', () => {
  it('returns clearly labelled test data and no engine internals', async () => {
    await createAdmin(h.pool);
    const [c] = await generate(h, await adminHeaders(h), { plan: '30d' });
    const token = (await redeem(h, c!.code)).body.session.token;
    const empty = await h.app.inject({ method: 'POST', url: '/v1/analysis', headers: bearer(token), payload: { siteId: 'devfixture' } });
    expect(AnalysisResponseSchema.parse(empty.json())).toMatchObject({ status: 'insufficient_data', isTestData: true, engine: { kind: 'mock' } });

    await h.app.inject({
      method: 'POST',
      url: '/v1/history',
      headers: bearer(token),
      payload: { batchId: crypto.randomUUID(), siteId: 'devfixture', adapterVersion: '1', observations: [{ multiplier: 1.2 }, { multiplier: 5 }] },
    });
    const res = await h.app.inject({ method: 'POST', url: '/v1/analysis', headers: bearer(token), payload: { siteId: 'devfixture' } });
    const body = AnalysisResponseSchema.parse(res.json());
    expect(body).toMatchObject({ status: 'ok', isTestData: true, observationsConsidered: 2, windowHours: 12 });
    expect(body.notice).toMatch(/TEST DATA/);
    expect(body.notice).toMatch(/not .*prediction/i);
    expect(JSON.stringify(body)).not.toMatch(/predict(ed|ion)?\s*[:=]|accuracy|win rate|next round/i);
  });

  it('requires an active subscription', async () => {
    const res = await h.app.inject({ method: 'POST', url: '/v1/analysis', payload: { siteId: 'devfixture' } });
    expect(res.statusCode).toBe(401);
  });
});

describe('configuration', () => {
  const base = { DATABASE_URL: 'postgres://u:p@localhost:5432/db', ...TEST_SECRETS };

  it('refuses to start with missing, short, placeholder or reused secrets — without printing values', () => {
    expect(() => loadEnv({ ...base, CODE_PEPPER: undefined })).toThrow(/CODE_PEPPER/);
    expect(() => loadEnv({ ...base, DEVICE_PEPPER: 'short' })).toThrow(/at least 32/);
    expect(() => loadEnv({ ...base, IP_HASH_PEPPER: 'change-me-change-me-change-me-change-me' })).toThrow(/placeholder/);
    try {
      loadEnv({ ...base, ADMIN_SERVICE_KEY: TEST_SECRETS.CODE_PEPPER });
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).toMatch(/must all differ/);
      expect((e as Error).message).not.toContain(TEST_SECRETS.CODE_PEPPER);
    }
  });

  it('rejects the dev fixture site in production', () => {
    expect(() => loadEnv({ ...base, NODE_ENV: 'production', ACCEPTED_SITE_IDS: 'onexbet,devfixture' })).toThrow(/devfixture/);
  });

  it('accepts devfixture in development mode', () => {
    const env = loadEnv({ ...base, NODE_ENV: 'development', ACCEPTED_SITE_IDS: 'onexbet,devfixture' });
    expect(env.ACCEPTED_SITE_IDS).toContain('devfixture');
  });

  it('Zod default for ACCEPTED_SITE_IDS does not contain devfixture', () => {
    const env = loadEnv({ ...base });
    expect(env.ACCEPTED_SITE_IDS).not.toContain('devfixture');
  });

  it('allows mock and statistical analysis providers, rejects unknown', () => {
    loadEnv({ ...base, ANALYSIS_PROVIDER: 'mock' });
    loadEnv({ ...base, ANALYSIS_PROVIDER: 'statistical' });
    expect(() => loadEnv({ ...base, ANALYSIS_PROVIDER: 'live' })).toThrow();
    expect(() => loadEnv({ ...base, ANALYSIS_PROVIDER: 'bogus' })).toThrow();
  });
});

describe('site allow-list', () => {
  const base = { DATABASE_URL: 'postgres://u:p@localhost:5432/db', ...TEST_SECRETS };
  it('accepts listed keys, "*" accepts any key, and production never accepts devfixture', async () => {
    const { isSiteAccepted } = await import('../src/config/env.js');
    expect(isSiteAccepted({ ACCEPTED_SITE_IDS: ['onexbet'], NODE_ENV: 'production' }, 'onexbet')).toBe(true);
    expect(isSiteAccepted({ ACCEPTED_SITE_IDS: ['onexbet'], NODE_ENV: 'production' }, 'example-casino-com')).toBe(false);
    expect(isSiteAccepted({ ACCEPTED_SITE_IDS: ['*'], NODE_ENV: 'production' }, 'example-casino-com')).toBe(true);
    expect(isSiteAccepted({ ACCEPTED_SITE_IDS: ['*'], NODE_ENV: 'production' }, 'devfixture')).toBe(false);
    expect(isSiteAccepted({ ACCEPTED_SITE_IDS: ['*'], NODE_ENV: 'development' }, 'devfixture')).toBe(true);
  });

  it('ACCEPTED_SITE_DOMAINS: accepts the canonical key of each listed hostname, nothing else', async () => {
    const { isSiteAccepted, loadEnv: load } = await import('../src/config/env.js');
    const env = load({ ...base, NODE_ENV: 'production', ACCEPTED_SITE_IDS: 'onexbet', ACCEPTED_SITE_DOMAINS: '1xlite-2781.pro' });
    expect(env.ACCEPTED_SITE_DOMAINS).toEqual(['1xlite-2781.pro']);
    expect(isSiteAccepted(env, '1xlite-2781-pro')).toBe(true);
    expect(isSiteAccepted(env, 'onexbet')).toBe(true);
    expect(isSiteAccepted(env, '1xlite-2782-pro')).toBe(false); // another mirror is not implied
    expect(isSiteAccepted(env, '1xlite-2781.pro')).toBe(false); // raw domain is not a site key
    expect(isSiteAccepted(env, 'spribegaming-com')).toBe(false); // game provider frame is not the site
  });

  it('refuses wildcard, URL-shaped or malformed site configuration at startup', () => {
    for (const bad of ['*', '*.1xlite-2781.pro', 'https://1xlite-2781.pro', '1xlite-2781.pro/x', '1xlite-2781.pro:443']) {
      expect(() => loadEnv({ ...base, ACCEPTED_SITE_DOMAINS: bad }), bad).toThrow(/ACCEPTED_SITE_DOMAINS/);
    }
    expect(() => loadEnv({ ...base, ACCEPTED_SITE_IDS: 'onexbet,1xlite-2781.pro' })).toThrow(/ACCEPTED_SITE_IDS/);
  });

  it('stores history and serves analysis for a domain-listed site; rejects unlisted keys', async () => {
    const h2 = await createHarness({ env: { ACCEPTED_SITE_IDS: 'onexbet', ACCEPTED_SITE_DOMAINS: '1xlite-2781.pro' } });
    try {
      await createAdmin(h2.pool);
      const [c] = await generate(h2, await adminHeaders(h2), { plan: '365d' });
      const token = (await redeem(h2, c!.code)).body.session.token;
      const post = (siteId: string) =>
        h2.app.inject({
          method: 'POST',
          url: '/v1/history',
          headers: bearer(token),
          payload: { batchId: crypto.randomUUID(), siteId, adapterVersion: 'generic-1.0.0', observations: [{ multiplier: 1.62 }, { multiplier: 2.1 }] },
        });
      const ok = await post('1xlite-2781-pro');
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toEqual({ result: 'accepted', accepted: 2, duplicates: 0 });
      const stored = await h2.pool.query("SELECT multiplier::text AS m FROM game_observations WHERE site_id = '1xlite-2781-pro' ORDER BY id");
      expect(stored.rows.map((r) => r.m)).toEqual(['1.62', '2.10']);

      const rejected = await post('1xlite-9999-pro');
      expect(rejected.statusCode).toBe(400);
      expect(rejected.json().error).toMatchObject({ code: 'VALIDATION_FAILED', details: { issues: [{ path: 'siteId' }] } });

      const analysis = await h2.app.inject({ method: 'POST', url: '/v1/analysis', headers: bearer(token), payload: { siteId: '1xlite-2781-pro' } });
      expect(analysis.statusCode).toBe(200);
      const unlisted = await h2.app.inject({ method: 'POST', url: '/v1/analysis', headers: bearer(token), payload: { siteId: '1xlite-9999-pro' } });
      expect(unlisted.statusCode).toBe(400);
    } finally {
      await h2.close();
    }
  });

  it('a listed site still requires an active subscription', async () => {
    const h2 = await createHarness({ env: { ACCEPTED_SITE_DOMAINS: '1xlite-2781.pro' } });
    try {
      const res = await h2.app.inject({
        method: 'POST',
        url: '/v1/history',
        headers: bearer('A'.repeat(43)),
        payload: { batchId: crypto.randomUUID(), siteId: '1xlite-2781-pro', adapterVersion: 'generic-1.0.0', observations: [{ multiplier: 1.5 }] },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await h2.close();
    }
  });

  it('wildcard servers store history for generic site keys', async () => {
    const h2 = await createHarness({ env: { ACCEPTED_SITE_IDS: '*' } });
    try {
      await createAdmin(h2.pool);
      const [c] = await generate(h2, await adminHeaders(h2), { plan: '30d' });
      const token = (await redeem(h2, c!.code)).body.session.token;
      const res = await h2.app.inject({
        method: 'POST',
        url: '/v1/history',
        headers: bearer(token),
        payload: { batchId: crypto.randomUUID(), siteId: 'example-casino-com', adapterVersion: 'generic-1.0.0', observations: [{ multiplier: 1.5 }] },
      });
      expect(res.json()).toEqual({ result: 'accepted', accepted: 1, duplicates: 0 });
    } finally {
      await h2.close();
    }
  });
});

describe('deployment templates must not contain devfixture', () => {
  const root = resolve(import.meta.dirname, '../..');

  function extractAcceptedSiteIds(text: string): string | undefined {
    const match = text.match(/ACCEPTED_SITE_IDS[=:]([^\n]+)/);
    return match?.[1]?.trim();
  }

  it('backend/.env.example', () => {
    const content = readFileSync(resolve(root, 'backend/.env.example'), 'utf8');
    const value = extractAcceptedSiteIds(content);
    expect(value).toBeDefined();
    expect(value).not.toContain('devfixture');
  });

  it('deploy/vps/.env.example', () => {
    const content = readFileSync(resolve(root, 'deploy/vps/.env.example'), 'utf8');
    const value = extractAcceptedSiteIds(content);
    expect(value).toBeDefined();
    expect(value).not.toContain('devfixture');
  });

  it('deploy/vps/docker-compose.yml Compose default', () => {
    const content = readFileSync(resolve(root, 'deploy/vps/docker-compose.yml'), 'utf8');
    const value = extractAcceptedSiteIds(content);
    expect(value).toBeDefined();
    expect(value).not.toContain('devfixture');
  });
});
