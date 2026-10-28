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

describe('collector continuity (PostgreSQL, extension 0.2.1+)', () => {
  const chain = randomUUID();
  const ingestC = (multipliers: number[], c: { chain: string; index: number }) =>
    h.app.inject({
      method: 'POST',
      url: '/v1/history',
      headers: bearer(token),
      payload: { batchId: randomUUID(), siteId: 'devfixture', adapterVersion: '1.0.0', observations: multipliers.map((m) => ({ multiplier: m })), continuity: c },
    });
  const breaks = async () => (await h.pool.query('SELECT break_before AS b, chain_index AS i FROM game_observations ORDER BY id')).rows as Array<{ b: boolean | null; i: number | null }>;

  it('records verified successors along one chain, and a break where a batch is missing', async () => {
    expect((await ingestC(seq(3), { chain, index: 0 })).statusCode).toBe(200);
    await ingestC(seq(2, 3), { chain, index: 3 });
    await ingestC(seq(1, 9), { chain, index: 9 }); // positions 5–8 never arrived
    expect(await breaks()).toEqual([
      { b: true, i: 0 },
      { b: false, i: 1 },
      { b: false, i: 2 },
      { b: false, i: 3 },
      { b: false, i: 4 },
      { b: true, i: 9 },
    ]);
  });

  it('a new chain is a break even seconds later; the warm-up needs 20 verified consecutive rounds', async () => {
    await ingestC(seq(15), { chain, index: 0 });
    await ingestC(seq(15, 15), { chain: randomUUID(), index: 0 }); // the collector lost track in between
    let s = await signal();
    expect(s.rounds).toBe(30);
    expect(s.state).toBe('warming_up');
    expect(s).toMatchObject({ currentRun: 15, longestRun: 15 });
    expect(s.reason).toMatch(/15 of 20 consecutive verified rounds/);
    const c2 = (await h.pool.query('SELECT chain_id FROM game_observations ORDER BY id DESC LIMIT 1')).rows[0].chain_id as string;
    await ingestC(seq(5, 30), { chain: c2, index: 15 });
    s = await signal();
    expect(s.state).toBe('experimental');
    expect(s).toMatchObject({ currentRun: 20, longestRun: 20 });
  });

  it('a forecast across a lost round is void even without a time gap; a verified successor is scored even after a delay', async () => {
    await ingestC(seq(20), { chain, index: 0 });
    await ingestC([2.5], { chain, index: 21 }); // position 20 lost
    let s = await signal();
    expect(s.performance).toMatchObject({ scored: 0, voided: 1 });
    // a delayed upload (12 minutes later) of the verified next round still counts
    await h.pool.query("UPDATE game_observations SET received_at = received_at - interval '12 minutes'");
    await ingestC([1.4], { chain, index: 22 });
    s = await signal();
    expect(s.performance).toMatchObject({ scored: 1, voided: 1 });
  });

  it('backfill aligned by value continues the stored chain; its live rounds follow it', async () => {
    await ingestC(seq(10), { chain, index: 0 });
    const c2 = randomUUID();
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/history/backfill',
      headers: bearer(token),
      payload: { batchId: randomUUID(), siteId: 'devfixture', adapterVersion: '1.0.0', multipliers: [...seq(6, 4), 7.77, 8.88], continuity: { chain: c2, index: 0 } },
    });
    expect(res.json()).toEqual({ result: 'stored', accepted: 2, alreadyStored: 6 });
    await ingestC([1.5], { chain: c2, index: 8 });
    const rows = await breaks();
    expect(rows.slice(-3)).toEqual([
      { b: false, i: 6 }, // verified by the value alignment
      { b: false, i: 7 },
      { b: false, i: 8 }, // the first live round right after the backfill
    ]);
  });

  it('rounds from older clients keep NULL continuity and the 120 s time rule', async () => {
    await ingest(seq(20));
    expect((await breaks()).every((r) => r.b === null && r.i === null)).toBe(true);
    expect((await signal()).state).toBe('experimental');
  });
});
