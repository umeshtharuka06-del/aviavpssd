import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { inject } from 'vitest';
import { buildApp } from '../src/api/app.js';
import { hashPassword } from '../src/auth/admin-auth.js';
import { loadEnv, type Env } from '../src/config/env.js';
import type { AppContext } from '../src/context.js';
import { createPool, type Pool } from '../src/database/pool.js';
import { MockAnalysisProvider } from '../src/engine/mock-provider.js';
import type { AnalysisProvider } from '../src/engine/provider.js';

/** Test-only secrets. Generated per run would also work; fixed values keep failures reproducible. */
export const TEST_SECRETS = {
  CODE_PEPPER: 'test-only-code-pepper-0123456789abcdef0123',
  DEVICE_PEPPER: 'test-only-device-pepper-0123456789abcdef01',
  IP_HASH_PEPPER: 'test-only-ip-pepper-0123456789abcdef012345',
  ADMIN_SERVICE_KEY: 'test-only-admin-service-key-0123456789abcd',
};

export function testEnv(overrides: Record<string, string> = {}): Env {
  return loadEnv({
    NODE_ENV: 'test',
    DATABASE_URL: inject('databaseUrl'),
    LOG_LEVEL: 'silent',
    ACCEPTED_SITE_IDS: 'onexbet,melbet,starz888,devfixture',
    ...TEST_SECRETS,
    ...overrides,
  });
}

/** Controllable trusted clock. Starts at a fixed UTC instant. */
export class TestClock {
  constructor(public t = new Date('2026-01-01T00:00:00.000Z')) {}
  now = () => new Date(this.t);
  advance(ms: number) {
    this.t = new Date(this.t.getTime() + ms);
  }
}
export const HOUR = 3600_000;
export const DAY = 24 * HOUR;

export interface Harness {
  app: FastifyInstance;
  ctx: AppContext;
  pool: Pool;
  clock: TestClock;
  logs: string[];
  close: () => Promise<void>;
}

export async function createHarness(opts: { provider?: AnalysisProvider; env?: Record<string, string>; clock?: TestClock } = {}): Promise<Harness> {
  const env = testEnv(opts.env);
  const pool = createPool(env.DATABASE_URL, 15);
  const clock = opts.clock ?? new TestClock();
  const ctx: AppContext = { env, pool, now: clock.now, analysisProvider: opts.provider ?? new MockAnalysisProvider() };
  const logs: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      logs.push(chunk.toString());
      cb();
    },
  });
  const app = await buildApp({ ...ctx, env: { ...env, LOG_LEVEL: 'info' } }, { logStream: stream });
  return {
    app,
    ctx,
    pool,
    clock,
    logs,
    close: async () => {
      await app.close();
      await pool.end();
    },
  };
}

export async function resetDb(pool: Pool) {
  await pool.query(`TRUNCATE game_observations, ingest_batches, customer_sessions, device_activations,
    subscriptions, activation_codes, admin_sessions, admin_users, security_events, worker_heartbeats RESTART IDENTITY CASCADE`);
}

export const serviceHeaders = () => ({ 'x-admin-service-key': TEST_SECRETS.ADMIN_SERVICE_KEY });

export const ADMIN_EMAIL = 'owner@example.test';
export const ADMIN_PASSWORD = 'correct horse battery staple';

let cachedHash: string | undefined;
export async function createAdmin(pool: Pool, email = ADMIN_EMAIL, password = ADMIN_PASSWORD) {
  const hash = password === ADMIN_PASSWORD ? (cachedHash ??= await hashPassword(password)) : await hashPassword(password);
  await pool.query('INSERT INTO admin_users (email, password_hash) VALUES ($1, $2)', [email, hash]);
}

/** Distinct client IPs keep per-IP rate limits from interfering between tests. */
let ipCounter = 0;
export const nextIp = () => `10.${(ipCounter >> 16) & 255}.${(ipCounter >> 8) & 255}.${ipCounter++ & 255}`;

export async function adminLogin(h: Harness): Promise<string> {
  const res = await h.app.inject({
    method: 'POST',
    url: '/v1/admin/auth/login',
    headers: { ...serviceHeaders(), 'x-admin-client-ip': nextIp() },
    payload: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  if (res.statusCode !== 200) throw new Error(`admin login failed: ${res.body}`);
  return res.json().token;
}

export async function adminHeaders(h: Harness) {
  return { ...serviceHeaders(), authorization: `Bearer ${await adminLogin(h)}` };
}

/** Generates codes through the real admin API and returns the plaintext + public id. */
export async function generate(h: Harness, headers: Record<string, string>, body: Record<string, unknown>) {
  const res = await h.app.inject({ method: 'POST', url: '/v1/admin/codes', headers, payload: body });
  if (res.statusCode !== 200) throw new Error(`generate failed: ${res.body}`);
  return res.json().codes as Array<{ id: string; code: string; plan: string; status: string; deviceLimit: number }>;
}

export const newDeviceId = () => randomUUID();

export async function redeem(h: Harness, code: string, deviceId = newDeviceId()) {
  const res = await h.app.inject({ method: 'POST', url: '/v1/activation/redeem', payload: { code, deviceId }, remoteAddress: nextIp() });
  return { res, body: res.json(), deviceId };
}

export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
