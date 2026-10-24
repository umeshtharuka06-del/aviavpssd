import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AnalysisProvider } from '../src/engine/provider.js';
import { purgeExpiredHistory, retentionHealth } from '../src/retention/purge.js';
import { runRetentionOnce } from '../src/retention/run-once.js';
import { adminHeaders, bearer, createAdmin, createHarness, generate, redeem, resetDb, type Harness } from './helpers.js';

/** Provider that always fails — proves analysis failure cannot block deletion. */
class FailingProvider implements AnalysisProvider {
  readonly kind = 'mock' as const;
  readonly version = 'failing';
  readonly isTestData = true;
  calls = 0;
  async analyze(): Promise<never> {
    this.calls++;
    throw new Error('engine crashed');
  }
}

let h: Harness;
const failing = new FailingProvider();

beforeAll(async () => {
  h = await createHarness({ provider: failing });
});
afterAll(async () => h.close());
beforeEach(async () => {
  await resetDb(h.pool);
});

/**
 * Inserts observations with a received_at relative to the DATABASE clock. Only tests may set
 * received_at directly; the API never accepts it.
 */
async function insertAged(ageSql: string, count = 1, site = 'devfixture') {
  await h.pool.query(
    `INSERT INTO game_observations (site_id, multiplier, received_at)
     SELECT $1, 2.00, now() - $2::interval FROM generate_series(1, $3)`,
    [site, ageSql, count],
  );
}
const count = async () => (await h.pool.query('SELECT count(*)::int AS n FROM game_observations')).rows[0].n as number;

describe('12-hour history retention', () => {
  it('deletes observations older than 12 hours and keeps recent ones', async () => {
    await insertAged('13 hours', 3);
    await insertAged('12 hours 1 second', 2);
    await insertAged('11 hours 59 minutes', 4);
    await insertAged('5 minutes', 5);
    const r = await purgeExpiredHistory(h.pool);
    expect(r.observations).toBe(5);
    expect(await count()).toBe(9);
    const oldest = await h.pool.query("SELECT bool_and(received_at >= now() - interval '12 hours') AS ok FROM game_observations");
    expect(oldest.rows[0].ok).toBe(true);
  });

  it('deletes expired rows even though analysis never ran', async () => {
    await insertAged('13 hours', 10);
    expect(failing.calls).toBe(0);
    await purgeExpiredHistory(h.pool);
    expect(await count()).toBe(0);
  });

  it('deletes expired rows even when analysis fails', async () => {
    await createAdmin(h.pool);
    const [c] = await generate(h, await adminHeaders(h), { plan: '30d' });
    const token = (await redeem(h, c!.code)).body.session.token;
    await insertAged('13 hours', 4);
    await insertAged('1 hour', 2);
    const res = await h.app.inject({ method: 'POST', url: '/v1/analysis', headers: bearer(token), payload: { siteId: 'devfixture' } });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('ANALYSIS_UNAVAILABLE');
    expect(failing.calls).toBeGreaterThan(0);
    await purgeExpiredHistory(h.pool);
    expect(await count()).toBe(2);
  });

  it('is safe to run repeatedly (idempotent)', async () => {
    await insertAged('20 hours', 3);
    expect((await purgeExpiredHistory(h.pool)).observations).toBe(3);
    expect((await purgeExpiredHistory(h.pool)).observations).toBe(0);
  });

  it('works through a large backlog in bounded batches (e.g. after downtime)', async () => {
    await insertAged('2 days', 12_345);
    await insertAged('1 hour', 7);
    const r = await purgeExpiredHistory(h.pool, 1_000);
    expect(r.observations).toBe(12_345);
    expect(await count()).toBe(7);
  });

  it('also expires ingestion idempotency keys after 12 hours', async () => {
    await createAdmin(h.pool);
    const [c] = await generate(h, await adminHeaders(h), { plan: '30d' });
    await redeem(h, c!.code);
    await h.pool.query(`INSERT INTO ingest_batches (device_activation_id, batch_id, accepted_count, duplicate_count, received_at)
      VALUES (1, gen_random_uuid(), 1, 0, now() - interval '13 hours'), (1, gen_random_uuid(), 1, 0, now())`);
    expect((await purgeExpiredHistory(h.pool)).batches).toBe(1);
  });

  it('never touches subscriptions, codes or devices', async () => {
    await createAdmin(h.pool);
    const [c] = await generate(h, await adminHeaders(h), { plan: '30d' });
    await redeem(h, c!.code);
    await insertAged('13 hours', 5);
    await purgeExpiredHistory(h.pool);
    const r = await h.pool.query(`SELECT (SELECT count(*)::int FROM activation_codes) a, (SELECT count(*)::int FROM subscriptions) s,
      (SELECT count(*)::int FROM device_activations) d`);
    expect(r.rows[0]).toEqual({ a: 1, s: 1, d: 1 });
  });

  it('analysis excludes rows past 12 hours even before the worker deletes them', async () => {
    const h2 = await createHarness(); // mock provider
    try {
      await createAdmin(h2.pool);
      const [c] = await generate(h2, await adminHeaders(h2), { plan: '30d' });
      const token = (await redeem(h2, c!.code)).body.session.token;
      await insertAged('13 hours', 6);
      await insertAged('2 hours', 3);
      const res = await h2.app.inject({ method: 'POST', url: '/v1/analysis', headers: bearer(token), payload: { siteId: 'devfixture' } });
      expect(res.json().observationsConsidered).toBe(3);
    } finally {
      await h2.close();
    }
  });
});

describe('retention worker pass', () => {
  it('records a heartbeat and the deleted count', async () => {
    await insertAged('13 hours', 4);
    const r = await runRetentionOnce(h.pool, 90);
    expect(r).toEqual({ skipped: false, deleted: 4 });
    const hb = await h.pool.query('SELECT total_runs, last_deleted_count, last_error, last_success_at IS NOT NULL AS ok FROM worker_heartbeats');
    expect(hb.rows[0]).toEqual({ total_runs: 1, last_deleted_count: 4, last_error: null, ok: true });
  });

  it('continues after a restart: a fresh pass deletes the backlog', async () => {
    await runRetentionOnce(h.pool, 90);
    await insertAged('30 hours', 8); // accumulated while the worker was "down"
    expect((await runRetentionOnce(h.pool, 90)).deleted).toBe(8);
  });

  it('only one pass runs at a time (advisory lock); the other skips', async () => {
    await insertAged('13 hours', 2);
    const holder = await h.pool.connect();
    try {
      await holder.query("SELECT pg_advisory_lock(hashtext('aviator.retention'))");
      expect(await runRetentionOnce(h.pool, 90)).toEqual({ skipped: true, deleted: 0 });
    } finally {
      await holder.query("SELECT pg_advisory_unlock(hashtext('aviator.retention'))");
      holder.release();
    }
    expect((await runRetentionOnce(h.pool, 90)).deleted).toBe(2);
  });

  it('health reports unhealthy when the worker never ran or stale rows exist', async () => {
    expect((await retentionHealth(h.pool, 300)).healthy).toBe(false); // never ran
    await runRetentionOnce(h.pool, 90);
    expect((await retentionHealth(h.pool, 300)).healthy).toBe(true);
    await insertAged('13 hours', 1);
    const stale = await retentionHealth(h.pool, 300);
    expect(stale.healthy).toBe(false);
    expect(stale.oldestAgeSeconds).toBeGreaterThan(12 * 3600);
  });

  it('is exposed to admins via /v1/admin/system/retention', async () => {
    await createAdmin(h.pool);
    await runRetentionOnce(h.pool, 90);
    const res = await h.app.inject({ method: 'GET', url: '/v1/admin/system/retention', headers: await adminHeaders(h) });
    expect(res.json()).toMatchObject({ retentionHours: 12, healthy: true, worker: { totalRuns: 1 }, observations: { count: 0 } });
  });
});
