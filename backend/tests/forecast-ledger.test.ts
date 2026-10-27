import { randomUUID } from 'node:crypto';
import { AnalysisResponseSchema, NextRoundSignalSchema, SIGNAL_WARMUP_ROUNDS } from '@aviator/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { syncLedger } from '../src/engine/sequential/ledger-service.js';
import { StatisticalAnalysisProvider } from '../src/engine/statistical-provider.js';
import { purgeExpiredHistory } from '../src/retention/purge.js';
import { adminHeaders, bearer, createAdmin, createHarness, generate, redeem, resetDb, type Harness } from './helpers.js';

let h: Harness;
let token: string;

beforeAll(async () => {
  h = await createHarness({ provider: new StatisticalAnalysisProvider({ minSampleSize: 10 }) });
});
afterAll(async () => h.close());
beforeEach(async () => {
  await resetDb(h.pool);
  await createAdmin(h.pool);
  const [c] = await generate(h, await adminHeaders(h), { plan: '30d' });
  token = (await redeem(h, c!.code)).body.session.token;
});

const ingest = (multipliers: number[], batchId: string = randomUUID()) =>
  h.app.inject({
    method: 'POST',
    url: '/v1/history',
    headers: bearer(token),
    payload: { batchId, siteId: 'devfixture', adapterVersion: '1.0.0', observations: multipliers.map((m) => ({ multiplier: m })) },
  });

const backfill = (multipliers: number[], batchId: string = randomUUID()) =>
  h.app.inject({ method: 'POST', url: '/v1/history/backfill', headers: bearer(token), payload: { batchId, siteId: 'devfixture', adapterVersion: '1.0.0', multipliers } });

async function signal() {
  const res = await h.app.inject({ method: 'POST', url: '/v1/analysis', headers: bearer(token), payload: { siteId: 'devfixture' } });
  expect(res.statusCode).toBe(200);
  const body = AnalysisResponseSchema.parse(res.json());
  return NextRoundSignalSchema.parse(body.nextRound);
}

const seq = (n: number, from = 0) => Array.from({ length: n }, (_, i) => [1.25, 2.4, 1.07, 5.6, 1.9, 13.2, 3.3][(i + from) % 7]!);
const count = async (table: string) => Number((await h.pool.query(`SELECT count(*) FROM ${table}`)).rows[0].count);

describe('forecast ledger (PostgreSQL)', () => {
  it('warms up below 20 rounds, then issues one forecast for the next round', async () => {
    await ingest(seq(SIGNAL_WARMUP_ROUNDS - 1));
    let s = await signal();
    expect(s.state).toBe('warming_up');
    expect(s.current).toBeNull();
    expect(s.rounds).toBe(19);
    expect(await count('round_forecasts')).toBe(0);

    await ingest(seq(1, 19));
    s = await signal();
    expect(s.state).toBe('experimental');
    expect(s.current?.inputRounds).toBe(20);
    expect(s.current?.outcome).toEqual({ status: 'pending' });
    expect(s.current!.probabilities.reduce((a, v) => a + v, 0)).toBeCloseTo(1, 9);
  });

  it('scores the open forecast with the next round, then issues the next forecast, once each', async () => {
    await ingest(seq(20));
    const first = (await signal()).current!;
    await signal(); // repeated requests do not issue again
    expect(await count('round_forecasts')).toBe(1);

    await ingest([7.77]);
    const s = await signal();
    expect(s.history[1]!.id).toBe(first.id);
    expect(s.history[1]!.outcome).toMatchObject({ status: 'scored', multiplier: 7.77, range: 2 });
    expect(s.history[1]!.probabilities).toEqual(first.probabilities); // unchanged by scoring
    expect(s.current!.id).not.toBe(first.id);
    expect(s.performance.scored).toBe(1);
    expect(await count('round_forecasts')).toBe(2);
    expect(await count('forecast_outcomes')).toBe(1);
  });

  it('a batch of several rounds scores the open forecast with the FIRST of them and issues one new forecast', async () => {
    await ingest(seq(20));
    await signal();
    await ingest([1.5, 2.5, 3.5]);
    const s = await signal();
    expect(s.history).toHaveLength(2);
    expect(s.history[1]!.outcome).toMatchObject({ status: 'scored', multiplier: 1.5 });
    expect(s.current!.inputRounds).toBe(23);
  });

  it('issues at upload time, so a forecast exists even if the panel never asked', async () => {
    await ingest(seq(20));
    expect(await count('round_forecasts')).toBe(1);
    await ingest([2.2]);
    await ingest([4.4]);
    expect(await count('round_forecasts')).toBe(3);
    expect(await count('forecast_outcomes')).toBe(2);
  });

  it('a retried upload (same batchId) neither stores, scores nor issues anything again', async () => {
    await ingest(seq(20));
    const id = randomUUID();
    await ingest([3.1], id);
    await ingest([3.1], id);
    expect(await count('game_observations')).toBe(21);
    expect(await count('round_forecasts')).toBe(2);
    expect(await count('forecast_outcomes')).toBe(1);
  });

  it('concurrent requests create exactly one forecast per input round', async () => {
    await h.pool.query(
      `INSERT INTO game_observations (site_id, multiplier, device_activation_id) SELECT 'devfixture', 1.5 + g % 3, (SELECT id FROM device_activations LIMIT 1) FROM generate_series(1, 25) g`,
    );
    await Promise.all(Array.from({ length: 6 }, () => signal()));
    expect(await count('round_forecasts')).toBe(1);
  });

  it('recorded forecasts and outcomes cannot be modified', async () => {
    await ingest(seq(20));
    await ingest([2.2]);
    await expect(h.pool.query("UPDATE round_forecasts SET state = 'validated'")).rejects.toThrow(/immutable/);
    await expect(h.pool.query('UPDATE forecast_outcomes SET actual_range = 0')).rejects.toThrow(/immutable/);
  });

  it('voids (does not score) a forecast whose next stored round came after a collection break', async () => {
    await ingest(seq(20));
    const device = (await h.pool.query('SELECT id FROM device_activations LIMIT 1')).rows[0].id as number;
    await h.pool.query(
      `INSERT INTO game_observations (site_id, multiplier, device_activation_id, received_at) VALUES ('devfixture', 3.3, $1, now() + interval '10 minutes')`,
      [device],
    );
    const snap = await syncLedger(h.pool, device, 'devfixture');
    expect(snap.entries[0]!.outcome).toMatchObject({ status: 'void', reason: 'gap' });
    const s = await signal();
    expect(s.performance.voided).toBe(1);
    expect(s.performance.scored).toBe(0);
  });

  it('retention removes forecasts with the history they came from', async () => {
    await ingest(seq(20));
    await ingest([2.2]);
    await h.pool.query("ALTER TABLE round_forecasts DISABLE TRIGGER round_forecasts_immutable");
    await h.pool.query("UPDATE round_forecasts SET issued_at = now() - interval '13 hours'");
    await h.pool.query("ALTER TABLE round_forecasts ENABLE TRIGGER round_forecasts_immutable");
    const r = await purgeExpiredHistory(h.pool);
    expect(r.forecasts).toBe(2);
    expect(await count('forecast_outcomes')).toBe(0);
  });
});

describe('backfill of the visible results (PostgreSQL)', () => {
  const shown = seq(25);

  it('stores the visible list once, marked as backfill, and the first forecast follows at once', async () => {
    const res = await backfill(shown);
    expect(res.json()).toEqual({ result: 'stored', accepted: 25, alreadyStored: 0 });
    const s = await signal();
    expect(s.rounds).toBe(25);
    expect(s.backfillRounds).toBe(25);
    expect(s.liveRounds).toBe(0);
    expect(s.state).toBe('experimental');
    expect(s.current?.inputRounds).toBe(25);
  });

  it('after a reload, stores only the rounds that are new', async () => {
    await backfill(shown);
    await ingest([2.71, 1.11]);
    const after = [...shown.slice(5), 2.71, 1.11, 6.02, 1.34];
    const res = await backfill(after);
    expect(res.json()).toEqual({ result: 'stored', accepted: 2, alreadyStored: 22 });
    const rows = (await h.pool.query('SELECT multiplier::float AS m, source FROM game_observations ORDER BY id')).rows;
    expect(rows.slice(-4)).toEqual([
      { m: 2.71, source: 'live' },
      { m: 1.11, source: 'live' },
      { m: 6.02, source: 'backfill' },
      { m: 1.34, source: 'backfill' },
    ]);
  });

  it('stores nothing when the list cannot be aligned with rounds stored moments ago', async () => {
    await ingest(seq(10));
    const res = await backfill([9.01, 8.02, 7.03, 6.04, 5.05]);
    expect(res.json()).toMatchObject({ result: 'rejected', accepted: 0 });
    expect(await count('game_observations')).toBe(10);
  });

  it('a repeated backfill batch is ignored', async () => {
    const id = randomUUID();
    await backfill(shown, id);
    const res = await backfill(shown, id);
    expect(res.json()).toMatchObject({ result: 'duplicate_batch', accepted: 0 });
    expect(await count('game_observations')).toBe(25);
  });
});
