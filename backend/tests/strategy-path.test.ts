// The range state machine along the REAL data path: extension-shaped uploads (one round per batch,
// collector continuity, backfill after a page reload) → game_observations → forecast ledger →
// /v1/analysis response. SIMULATED multipliers, local test database only.
// Set STRATEGY_TABLE_OUT=<file> to also write the evidence table (markdown).
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { AnalysisResponseSchema, NextRoundSignalSchema, type NextRoundSignal } from '@aviator/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { StatisticalAnalysisProvider } from '../src/engine/statistical-provider.js';
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

/** A collector read chain, as the content script keeps it (src/content/controller.ts). */
class Collector {
  chain = randomUUID();
  index = 0;
  async round(m: number) {
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/history',
      headers: bearer(token),
      payload: { batchId: randomUUID(), siteId: 'devfixture', adapterVersion: '1.0.0', observations: [{ multiplier: m }], continuity: { chain: this.chain, index: this.index } },
    });
    expect(res.statusCode).toBe(200);
    this.index++;
  }
  /** Page reload: a new chain; the visible list (oldest first) is sent once as backfill at index 0. */
  async reload(visible: number[]) {
    this.chain = randomUUID();
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/history/backfill',
      headers: bearer(token),
      payload: { batchId: randomUUID(), siteId: 'devfixture', adapterVersion: '1.0.0', multipliers: visible, continuity: { chain: this.chain, index: 0 } },
    });
    this.index = visible.length;
    return res.json() as { result: string; accepted: number; alreadyStored: number };
  }
}

async function signal(): Promise<NextRoundSignal> {
  const res = await h.app.inject({ method: 'POST', url: '/v1/analysis', headers: bearer(token), payload: { siteId: 'devfixture' } });
  expect(res.statusCode).toBe(200);
  return NextRoundSignalSchema.parse(AnalysisResponseSchema.parse(res.json()).nextRound);
}
const stored = async () => (await h.pool.query('SELECT multiplier::float AS m FROM game_observations ORDER BY id')).rows.map((r) => r.m as number);
/** Independent count: consecutive stored multipliers below 2.00× at the end (no break handling). */
const tailLows = (ms: number[]) => {
  let n = 0;
  for (let i = ms.length - 1; i >= 0 && ms[i]! < 2; i--) n++;
  return n;
};
const WARM = [1.25, 2.4, 1.07, 5.6, 1.9, 13.2, 3.3, 1.25, 2.4, 1.07, 5.6, 1.9, 13.2, 3.3, 1.25, 2.4, 1.07, 5.6, 1.9, 3.3]; // ends ≥ 2×

type Step = { input: number; state: string; low: number; target: number; targetP: number; scoredTarget: string; scoredRange: string; prevState: string };

describe('range state machine on the real upload → ledger → response path (SIMULATED rounds)', () => {
  it('follows the specified sequence exactly: 4 lows track, 5 enter the watch, misses keep it, 2.00× / 4.00× / 5.00× hit and reset', async () => {
    const col = new Collector();
    for (const m of WARM) await col.round(m);
    const S = [1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.99, 2.0, 1.1, 1.2, 1.3, 1.4, 1.5, 4.0, 1.1, 1.2, 1.3, 1.4, 1.5, 5.0];
    const steps: Step[] = [];
    for (const m of S) {
      await col.round(m);
      const s = await signal();
      const st = s.current!.strategy!;
      const prev = s.history[1]!; // the forecast this round resolved
      const o = prev.outcome;
      if (o.status !== 'scored') throw new Error('expected the previous forecast to be scored');
      expect(o.multiplier).toBe(m); // scored by exactly this round
      steps.push({
        input: m,
        prevState: prev.strategy!.state,
        scoredTarget: o.targetHit ? 'TARGET HIT' : 'TARGET MISS',
        scoredRange: o.strategyRangeHit ? 'RANGE HIT' : 'RANGE MISS',
        state: st.state,
        low: st.consecutiveLow,
        target: st.targetThreshold,
        targetP: st.targetProbability,
      });
      // the server's count equals an independent count over the stored rounds, in id order
      expect(st.consecutiveLow).toBe(tailLows(await stored()));
    }
    const expected: Array<[string, number, string, string]> = [
      // state after the round, low count, scored TARGET, scored RANGE (of the forecast that round resolved)
      ['low_range_tracking', 1, 'TARGET MISS', 'RANGE HIT'],
      ['low_range_tracking', 2, 'TARGET MISS', 'RANGE HIT'],
      ['low_range_tracking', 3, 'TARGET MISS', 'RANGE HIT'],
      ['low_range_tracking', 4, 'TARGET MISS', 'RANGE HIT'],
      ['elevated_range_watch', 5, 'TARGET MISS', 'RANGE HIT'],
      ['elevated_range_watch', 6, 'TARGET MISS', 'RANGE MISS'], // 1.60× under the watch: miss, target kept
      ['elevated_range_watch', 7, 'TARGET MISS', 'RANGE MISS'], // 1.99×: miss, target kept
      ['low_range_tracking', 0, 'TARGET HIT', 'RANGE HIT'], // 2.00×: hit, reset
      ['low_range_tracking', 1, 'TARGET MISS', 'RANGE HIT'],
      ['low_range_tracking', 2, 'TARGET MISS', 'RANGE HIT'],
      ['low_range_tracking', 3, 'TARGET MISS', 'RANGE HIT'],
      ['low_range_tracking', 4, 'TARGET MISS', 'RANGE HIT'],
      ['elevated_range_watch', 5, 'TARGET MISS', 'RANGE HIT'],
      ['low_range_tracking', 0, 'TARGET HIT', 'RANGE HIT'], // 4.00×: inside 2.00×–4.99×
      ['low_range_tracking', 1, 'TARGET MISS', 'RANGE HIT'],
      ['low_range_tracking', 2, 'TARGET MISS', 'RANGE HIT'],
      ['low_range_tracking', 3, 'TARGET MISS', 'RANGE HIT'],
      ['low_range_tracking', 4, 'TARGET MISS', 'RANGE HIT'],
      ['elevated_range_watch', 5, 'TARGET MISS', 'RANGE HIT'],
      ['low_range_tracking', 0, 'TARGET HIT', 'RANGE MISS'], // 5.00×: above 2.00×–4.99×
    ];
    expect(steps.map((x) => [x.state, x.low, x.scoredTarget, x.scoredRange])).toEqual(expected);
    expect(steps.every((x) => x.target === 2)).toBe(true);
    if (process.env.STRATEGY_TABLE_OUT) {
      const name = (s: string) => (s === 'elevated_range_watch' ? 'WATCH' : 'TRACKING');
      const rows = steps.map(
        (x, i) =>
          `| ${i + 1} | ${x.input.toFixed(2)}× | ${name(expected[i]![0])}, ${expected[i]![1]} | ${name(x.state)}, ${x.low} | ≥ ${x.target.toFixed(2)}× (${(x.targetP * 100).toFixed(1)}%) | ${name(x.prevState)} → ${x.scoredTarget} · ${x.scoredRange} |`,
      );
      writeFileSync(
        process.env.STRATEGY_TABLE_OUT,
        ['| # | Actual round | Expected next state, low count | Actual next state, low count | Target (est. P) | Forecast this round resolved |', '|---|---|---|---|---|---|', ...rows].join('\n') + '\n',
      );
    }
  });

  it('the requested literal sequence 1.10 1.40 1.20 1.80 1.50 → WATCH; 1.30 keeps it; 1.99 MISS; 2.00 HIT + reset; 4.00, 5.00 HIT', async () => {
    const col = new Collector();
    for (const m of WARM) await col.round(m);
    const got: Array<[string, number, number, string]> = [];
    for (const m of [1.1, 1.4, 1.2, 1.8, 1.5, 1.3, 1.99, 2.0, 4.0, 5.0]) {
      await col.round(m);
      const s = await signal();
      const st = s.current!.strategy!;
      const o = s.history[1]!.outcome;
      if (o.status !== 'scored') throw new Error('expected a scored outcome');
      got.push([st.state, st.consecutiveLow, st.targetThreshold, `${o.targetHit ? 'HIT' : 'MISS'}/${o.strategyRangeHit ? 'HIT' : 'MISS'}`]);
      expect(st.consecutiveLow).toBe(tailLows(await stored()));
      if (st.state === 'elevated_range_watch') expect(st.predictedRange).toBe(1); // 2.00×–4.99×
    }
    const T = 'low_range_tracking';
    const W = 'elevated_range_watch';
    expect(got).toEqual([
      [T, 1, 2, 'MISS/HIT'],
      [T, 2, 2, 'MISS/HIT'],
      [T, 3, 2, 'MISS/HIT'],
      [T, 4, 2, 'MISS/HIT'],
      [W, 5, 2, 'MISS/HIT'],
      [W, 6, 2, 'MISS/MISS'],
      [W, 7, 2, 'MISS/MISS'],
      [T, 0, 2, 'HIT/HIT'],
      [T, 0, 2, 'HIT/MISS'],
      [T, 0, 2, 'HIT/MISS'],
    ]);
  });

  it('a repeated upload (same batch) neither counts a round twice nor scores twice', async () => {
    const col = new Collector();
    for (const m of WARM) await col.round(m);
    const batchId = randomUUID();
    const send = () =>
      h.app.inject({
        method: 'POST',
        url: '/v1/history',
        headers: bearer(token),
        payload: { batchId, siteId: 'devfixture', adapterVersion: '1.0.0', observations: [{ multiplier: 1.4 }], continuity: { chain: col.chain, index: col.index } },
      });
    await send();
    await send();
    await send();
    const s = await signal();
    expect(s.current!.strategy!.consecutiveLow).toBe(1);
    expect(Number((await h.pool.query('SELECT count(*) FROM forecast_outcomes')).rows[0].count)).toBe(1);
  });

  it('a real gap (rounds lost between two uploads) restarts the count: the true run length is unknown', async () => {
    const col = new Collector();
    for (const m of WARM) await col.round(m);
    for (const m of [1.1, 1.2, 1.3]) await col.round(m);
    col.index += 2; // two rounds never arrived
    await col.round(1.4);
    expect((await signal()).current!.strategy!.consecutiveLow).toBe(1);
  });

  it('a game-page reload that loses nothing (the visible list is already stored) keeps the count', async () => {
    const col = new Collector();
    for (const m of WARM) await col.round(m);
    for (const m of [1.1, 1.2, 1.3]) await col.round(m);
    expect((await signal()).current!.strategy!.consecutiveLow).toBe(3);
    // reload: the page shows the last 10 results, all of them stored already
    const visible = (await stored()).slice(-10);
    expect(await col.reload(visible)).toEqual({ result: 'stored', accepted: 0, alreadyStored: 10 });
    await col.round(1.4); // the first live round after the reload, verified to follow the list
    const s = await signal();
    expect(s.current!.strategy!.consecutiveLow).toBe(4);
    await col.round(1.5);
    expect((await signal()).current!.strategy).toMatchObject({ state: 'elevated_range_watch', consecutiveLow: 5 });
    // the forecast across the reload was scored, not voided
    expect((await signal()).performance.voided).toBe(0);
  });

  it('a mid-page re-sync: without the visible-list backfill the next round is a break (count restarts); with it the count continues, and a round missed meanwhile is recovered', async () => {
    // extension ≤ 0.2.5: after a re-sync the first round on the new chain is sent at index 0, no backfill
    const old = new Collector();
    for (const m of WARM) await old.round(m);
    for (const m of [1.1, 1.2, 1.3]) await old.round(m);
    old.chain = randomUUID();
    old.index = 0;
    await old.round(1.4);
    expect((await signal()).current!.strategy!.consecutiveLow).toBe(1); // 4 lows in a row, counted as 1

    // fixed collector: the new chain opens with the visible list as a backfill
    await resetDb(h.pool);
    await createAdmin(h.pool);
    const [c] = await generate(h, await adminHeaders(h), { plan: '30d' });
    token = (await redeem(h, c!.code)).body.session.token;
    const col = new Collector();
    for (const m of WARM) await col.round(m);
    for (const m of [1.1, 1.2, 1.3]) await col.round(m);
    expect(await col.reload((await stored()).slice(-10))).toMatchObject({ accepted: 0, alreadyStored: 10 });
    await col.round(1.4);
    expect((await signal()).current!.strategy).toMatchObject({ state: 'low_range_tracking', consecutiveLow: 4 });
    // a round (1.45×) completed while the strip was blank: it is on the visible list, so the backfill stores it, verified
    expect(await col.reload([...(await stored()).slice(-9), 1.45])).toMatchObject({ accepted: 1, alreadyStored: 9 });
    await col.round(1.5);
    const s = await signal();
    expect(s.current!.strategy).toMatchObject({ state: 'elevated_range_watch', consecutiveLow: 6, targetThreshold: 2 });
    expect(s.current!.strategy!.consecutiveLow).toBe(tailLows(await stored()));
    expect(s.performance.voided).toBe(0);
  });

  it('the reload link proves only the next position: a lost round after it, or a round stored meanwhile by the old tab, is still a break', async () => {
    const col = new Collector();
    for (const m of WARM) await col.round(m);
    for (const m of [1.1, 1.2]) await col.round(m);
    expect((await col.reload((await stored()).slice(-10))).accepted).toBe(0);
    col.index += 1; // the first live round on the new chain was lost
    await col.round(1.3);
    expect((await signal()).current!.strategy!.consecutiveLow).toBe(1);

    const col2 = new Collector();
    for (const m of WARM) await col2.round(m);
    await col2.round(1.1);
    const oldTab = { chain: col2.chain, index: col2.index };
    expect((await col2.reload((await stored()).slice(-10))).accepted).toBe(0);
    // the old tab is still open and stores the next round on its own chain: the link no longer points at the latest round
    await h.app.inject({
      method: 'POST',
      url: '/v1/history',
      headers: bearer(token),
      payload: { batchId: randomUUID(), siteId: 'devfixture', adapterVersion: '1.0.0', observations: [{ multiplier: 1.2 }], continuity: oldTab },
    });
    await col2.round(1.3); // the new tab's next position: not verified to follow 1.20×
    expect((await h.pool.query('SELECT break_before FROM game_observations ORDER BY id DESC LIMIT 1')).rows[0].break_before).toBe(true);
  });
});
