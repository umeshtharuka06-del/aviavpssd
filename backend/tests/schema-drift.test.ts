// Reproduces the production failure "The server rejected the upload: An internal error occurred."
// + ANALYSIS UNAVAILABLE: the API code is newer than the database schema (migrations not applied).
// A separate database is migrated only to 0003, i.e. without the forecast ledger (0004) and the
// continuity columns (0005); then the real routes are called with the extension's request shapes.
import { copyFileSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { defaultMigrationsDir, migrate, schemaStatus } from '../src/database/migrate.js';
import { createPool, type Pool } from '../src/database/pool.js';
import { StatisticalAnalysisProvider } from '../src/engine/statistical-provider.js';
import { adminHeaders, bearer, createAdmin, createHarness, generate, redeem, type Harness } from './helpers.js';

const name = `aviator_drift_${Date.now()}`;
const baseUrl = inject('databaseUrl');
const url = (() => {
  const u = new URL(baseUrl);
  u.pathname = `/${name}`;
  return u.toString();
})();
let admin: Pool;
let h: Harness;
let token: string;

/** A migrations folder with only the files up to and including `last`. */
function migrationsUpTo(last: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'aviator-mig-'));
  for (const f of readdirSync(defaultMigrationsDir())) if (f <= last) copyFileSync(join(defaultMigrationsDir(), f), join(dir, f));
  return dir;
}

beforeAll(async () => {
  admin = createPool(baseUrl, 2);
  await admin.query(`CREATE DATABASE ${name}`);
  const p = createPool(url, 2);
  await migrate(p, migrationsUpTo('0003_device_scoped_analysis.sql'));
  await p.end();
  h = await createHarness({ provider: new StatisticalAnalysisProvider({ minSampleSize: 10 }), env: { DATABASE_URL: url } });
  await createAdmin(h.pool);
  const [c] = await generate(h, await adminHeaders(h), { plan: '30d' });
  token = (await redeem(h, c!.code)).body.session.token;
});
afterAll(async () => {
  await h?.close();
  await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await admin.end();
});

const device = async () => (await h.pool.query('SELECT id FROM device_activations LIMIT 1')).rows[0].id as number;
const backfill = () =>
  h.app.inject({
    method: 'POST',
    url: '/v1/history/backfill',
    headers: bearer(token),
    payload: { batchId: randomUUID(), siteId: 'devfixture', adapterVersion: '1.0.0', multipliers: [1.5, 2.25, 1.07, 13.4, 3.1] },
  });
const analysis = () => h.app.inject({ method: 'POST', url: '/v1/analysis', headers: bearer(token), payload: { siteId: 'devfixture' } });
const logged = (msg: string) => h.logs.map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l.msg === msg);

describe('API code newer than the database schema (migrations 0004–0006 not applied)', () => {
  it('reports the pending migrations on readiness (503) and in the log', async () => {
    expect(await schemaStatus(h.pool)).toEqual({ pending: ['0004_round_forecast_ledger.sql', '0005_round_continuity.sql', '0006_range_strategy.sql'], modified: [] });
    const res = await h.app.inject({ method: 'GET', url: '/v1/health/ready' });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.message).toBe('Service is not ready.'); // nothing about the schema in public
    expect(logged('database schema does not match this build')[0]).toMatchObject({
      pendingMigrations: ['0004_round_forecast_ledger.sql', '0005_round_continuity.sql', '0006_range_strategy.sql'],
    });
  });

  it('the backfill upload fails with 503 naming the cause (was a bare 500 "An internal error occurred.") and the log names the missing column', async () => {
    const res = await backfill();
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({
      error: {
        code: 'SERVICE_UNAVAILABLE',
        message: "The server's database is missing a required migration, so this request cannot be completed. The operator must run the migrate service.",
        requestId: expect.any(String),
        details: { cause: 'database_schema_outdated' },
      },
    });
    expect(JSON.stringify(res.json())).not.toMatch(/game_observations|source|column/); // no schema names in public
    const entry = logged('unhandled error').at(-1)!;
    expect(entry).toMatchObject({ method: 'POST', route: '/v1/history/backfill', err: { code: '42703' } });
    expect(String((entry.err as { message: string }).message)).toMatch(/column "source" of relation "game_observations" does not exist/);
    // the transaction rolled back: nothing half-stored
    expect(Number((await h.pool.query('SELECT count(*) FROM game_observations')).rows[0].count)).toBe(0);
  });

  it('analysis fails with 503 ANALYSIS_UNAVAILABLE and the log now says why (it was discarded before)', async () => {
    // existing history recorded before the upgrade (no ledger tables yet)
    const d = await device();
    await h.pool.query(
      `INSERT INTO game_observations (site_id, multiplier, device_activation_id)
       SELECT 'devfixture', 1 + (g % 7) * 0.73, $1 FROM generate_series(1, 30) g`,
      [d],
    );
    const res = await analysis();
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toMatchObject({ code: 'ANALYSIS_UNAVAILABLE', details: { stage: 'next_round_forecast', cause: 'database_schema_outdated' } });
    const entry = logged('request failed').at(-1)!;
    expect(entry).toMatchObject({ route: '/v1/analysis', appCode: 'ANALYSIS_UNAVAILABLE', cause: { code: expect.stringMatching(/^42703|42P01$/) } });
  });

  it('logs never contain the bearer token or the submitted multipliers', () => {
    const all = h.logs.join('\n');
    expect(all).not.toContain(token);
    // Timing fields are numbers like 13.494…, which would match the multiplier by chance; drop them first.
    const withoutTimings = all.replace(/"(responseTime|time)":[0-9.]+/g, '');
    expect(withoutTimings).not.toContain('13.4');
  });

  it('after the pending migrations run, the same requests succeed and existing history is preserved', async () => {
    const before = (await h.pool.query('SELECT id, multiplier::float AS m FROM game_observations ORDER BY id')).rows;
    expect(before).toHaveLength(30);
    expect(await migrate(h.pool)).toEqual(['0004_round_forecast_ledger.sql', '0005_round_continuity.sql', '0006_range_strategy.sql']);
    expect((await h.app.inject({ method: 'GET', url: '/v1/health/ready' })).statusCode).toBe(200);
    const after = (await h.pool.query('SELECT id, multiplier::float AS m, source FROM game_observations ORDER BY id')).rows;
    expect(after.map(({ id, m }) => ({ id, m }))).toEqual(before); // every stored round kept, unchanged
    expect(after.every((r) => r.source === 'live')).toBe(true);
    const a = await analysis();
    expect(a.statusCode).toBe(200);
    expect(a.json().nextRound).toMatchObject({ state: 'experimental', rounds: 30, current: { outcome: { status: 'pending' } } });
    expect((await backfill()).statusCode).toBe(200);
  });
});
