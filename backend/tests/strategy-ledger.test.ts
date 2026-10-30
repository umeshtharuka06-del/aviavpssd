// Range state machine through the real API and PostgreSQL ledger: recorded with every forecast,
// scored once (TARGET and RANGE separately), unchanged by reloads, service restarts, repeated or
// failed uploads.
import { randomUUID } from 'node:crypto';
import { AnalysisResponseSchema, NextRoundSignalSchema } from '@aviator/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { StatisticalAnalysisProvider } from '../src/engine/statistical-provider.js';
import { adminHeaders, bearer, createAdmin, createHarness, generate, redeem, resetDb, type Harness } from './helpers.js';

let h: Harness;
let token: string;
const provider = () => new StatisticalAnalysisProvider({ minSampleSize: 10 });

beforeAll(async () => {
  h = await createHarness({ provider: provider() });
});
afterAll(async () => h.close());
beforeEach(async () => {
  await resetDb(h.pool);
  await createAdmin(h.pool);
  const [c] = await generate(h, await adminHeaders(h), { plan: '30d' });
  token = (await redeem(h, c!.code)).body.session.token;
});

const ingest = (multipliers: number[], batchId: string = randomUUID(), on: Harness = h) =>
  on.app.inject({
    method: 'POST',
    url: '/v1/history',
    headers: bearer(token),
    payload: { batchId, siteId: 'devfixture', adapterVersion: '1.0.0', observations: multipliers.map((m) => ({ multiplier: m })) },
  });

async function signal(on: Harness = h) {
  const res = await on.app.inject({ method: 'POST', url: '/v1/analysis', headers: bearer(token), payload: { siteId: 'devfixture' } });
  expect(res.statusCode).toBe(200);
  return NextRoundSignalSchema.parse(AnalysisResponseSchema.parse(res.json()).nextRound);
}
const count = async (sql: string) => Number((await h.pool.query(sql)).rows[0].count);
/** 20 warm-up rounds ending ≥ 2×, so the low count starts at 0. */
const WARM = Array.from({ length: 20 }, (_, i) => [1.25, 2.4, 1.07, 5.6, 1.9, 13.2, 3.3][i % 7]!).map((m, i) => (i === 19 ? 3.3 : m));

describe('range state machine in the PostgreSQL ledger', () => {
  it('records the state with every forecast and scores TARGET and RANGE apart, once', async () => {
    await ingest(WARM);
    for (const m of [1.1, 1.2, 1.3, 1.4, 1.5]) await ingest([m]);
    let s = await signal();
    expect(s.current!.strategy).toMatchObject({ state: 'elevated_range_watch', consecutiveLow: 5, predictedRange: 1, targetThreshold: 2 });

    await ingest([1.99]); // TARGET MISS → the watch keeps its target
    s = await signal();
    expect(s.history[1]!.outcome).toMatchObject({ status: 'scored', multiplier: 1.99, targetHit: false, strategyRangeHit: false });
    expect(s.current!.strategy).toMatchObject({ state: 'elevated_range_watch', consecutiveLow: 6, watchForecast: 2, predictedRange: 1 });

    await ingest([5.0]); // above the predicted range: RANGE MISS, TARGET HIT
    s = await signal();
    expect(s.history[1]!.outcome).toMatchObject({ multiplier: 5, targetHit: true, strategyRangeHit: false });
    expect(s.current!.strategy).toMatchObject({ state: 'low_range_tracking', consecutiveLow: 0 });

    // stored columns agree with the response
    const { rows } = await h.pool.query(
      `SELECT o.actual_multiplier::text AS m, o.target_hit, o.strategy_range_hit, f.strategy->>'state' AS state
         FROM forecast_outcomes o JOIN round_forecasts f ON f.id = o.forecast_id ORDER BY f.id DESC LIMIT 2`,
    );
    expect(rows).toEqual([
      { m: '5.00', target_hit: true, strategy_range_hit: false, state: 'elevated_range_watch' },
      { m: '1.99', target_hit: false, strategy_range_hit: false, state: 'elevated_range_watch' },
    ]);
    expect(s.strategyPerformance!.eligible).toBe(s.performance.scored);
  });

  it('a page reload (repeated analysis requests) and a service restart give the same state and history', async () => {
    await ingest(WARM);
    for (const m of [1.1, 1.2, 1.3, 1.4, 1.5, 1.6]) await ingest([m]);
    const before = await signal();
    expect(await signal()).toMatchObject({ current: before.current, history: before.history }); // reload

    const restarted = await createHarness({ provider: provider() }); // new process: new pool, new app, same database
    try {
      const after = await signal(restarted);
      expect(after.current).toEqual(before.current);
      expect(after.history).toEqual(before.history);
      expect(after.current!.strategy).toMatchObject({ state: 'elevated_range_watch', consecutiveLow: 6 });
      await ingest([1.7], randomUUID(), restarted); // the next round after the restart continues the count
      expect((await signal(restarted)).current!.strategy).toMatchObject({ consecutiveLow: 7, watchForecast: 3 });
    } finally {
      await restarted.close();
    }
  });

  it('duplicate rounds (retried batch) do not advance the count or score twice', async () => {
    await ingest(WARM);
    const id = randomUUID();
    for (let k = 0; k < 3; k++) await ingest([1.4], id);
    const s = await signal();
    expect(s.current!.strategy!.consecutiveLow).toBe(1);
    expect(await count('SELECT count(*) FROM forecast_outcomes')).toBe(1);
    expect(await count('SELECT count(*) FROM round_forecasts')).toBe(2);
  });

  it('a failed upload stores nothing and changes no state; its retry is applied exactly once', async () => {
    await ingest(WARM);
    for (const m of [1.1, 1.2, 1.3, 1.4]) await ingest([m]);
    const before = await signal();
    await h.pool.query(`CREATE FUNCTION fail_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'simulated outage'; END; $$`);
    await h.pool.query('CREATE TRIGGER fail_insert BEFORE INSERT ON game_observations FOR EACH ROW EXECUTE FUNCTION fail_insert()');
    const id = randomUUID();
    try {
      const failed = await ingest([1.5], id);
      expect(failed.statusCode).toBeGreaterThanOrEqual(500);
    } finally {
      await h.pool.query('DROP TRIGGER fail_insert ON game_observations');
      await h.pool.query('DROP FUNCTION fail_insert()');
    }
    const mid = await signal();
    expect(mid.current).toEqual(before.current); // nothing half-applied
    expect(mid.current!.strategy!.consecutiveLow).toBe(4);

    expect((await ingest([1.5], id)).statusCode).toBe(200); // the extension retries with the same batchId
    await ingest([1.5], id);
    const s = await signal();
    expect(s.history[1]!.outcome).toMatchObject({ status: 'scored', multiplier: 1.5 });
    expect(s.current!.strategy).toMatchObject({ state: 'elevated_range_watch', consecutiveLow: 5 });
    expect(await count("SELECT count(*) FROM game_observations WHERE multiplier = 1.5")).toBe(1);
  });

  it('forecasts recorded before migration 0006 (no strategy) still load, without target scoring', async () => {
    await ingest(WARM);
    await h.pool.query('ALTER TABLE round_forecasts DISABLE TRIGGER round_forecasts_immutable');
    await h.pool.query('UPDATE round_forecasts SET strategy = NULL');
    await h.pool.query('ALTER TABLE round_forecasts ENABLE TRIGGER round_forecasts_immutable');
    await ingest([2.5]);
    const s = await signal();
    expect(s.history[1]!.strategy).toBeNull();
    expect(s.history[1]!.outcome).toMatchObject({ status: 'scored', multiplier: 2.5 });
    expect(s.history[1]!.outcome).not.toHaveProperty('targetHit');
    expect(s.strategyPerformance!.eligible).toBe(0);
  });
});
