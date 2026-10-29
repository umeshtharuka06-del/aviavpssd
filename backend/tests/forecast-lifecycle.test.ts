/**
 * Forecast lifecycle through the real API and PostgreSQL: refresh idempotence, history order, exactly-once
 * scoring, and range hits / target hits judged from the actual multiplier. (Own file: each test file has
 * its own app, so the admin code-generation rate limit is not shared with forecast-ledger.test.ts.)
 */
import { randomUUID } from 'node:crypto';
import { AnalysisResponseSchema, NextRoundSignalSchema, rangeHit, targetHit } from '@aviator/contracts';
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

const ingest = (multipliers: number[], batchId: string = randomUUID()) =>
  h.app.inject({
    method: 'POST',
    url: '/v1/history',
    headers: bearer(token),
    payload: { batchId, siteId: 'devfixture', adapterVersion: '1.0.0', observations: multipliers.map((m) => ({ multiplier: m })) },
  });

async function signal() {
  const res = await h.app.inject({ method: 'POST', url: '/v1/analysis', headers: bearer(token), payload: { siteId: 'devfixture' } });
  expect(res.statusCode).toBe(200);
  const body = AnalysisResponseSchema.parse(res.json());
  return NextRoundSignalSchema.parse(body.nextRound);
}

const seq = (n: number, from = 0) => Array.from({ length: n }, (_, i) => [1.25, 2.4, 1.07, 5.6, 1.9, 13.2, 3.3][(i + from) % 7]!);
const count = async (table: string) => Number((await h.pool.query(`SELECT count(*) FROM ${table}`)).rows[0].count);

describe('forecast lifecycle (PostgreSQL)', () => {
  it('refreshes without a new round change nothing: no new forecast, no outcome, identical history', async () => {
    await ingest(seq(20));
    await ingest([4.0]);
    const before = await signal();
    for (let i = 0; i < 5; i++) expect(await signal()).toMatchObject({ current: before.current, history: before.history });
    expect(await count('round_forecasts')).toBe(2);
    expect(await count('forecast_outcomes')).toBe(1);
  });

  it('history is newest first and each forecast is scored once, from the numeric multiplier (range hit and target hits apart)', async () => {
    await ingest(seq(20));
    // boundary values, one round per upload, a refresh after each
    const actual = [1.99, 2.0, 4.99, 5.0, 9.99, 10.0, 4.0, 1.0];
    for (const m of actual) {
      await ingest([m]);
      await signal();
    }
    const s = await signal();
    expect(s.history).toHaveLength(actual.length + 1);
    expect(s.history[0]!.id).toBe(s.current!.id); // the open forecast first, then older ones
    const issued = s.history.map((r) => Date.parse(r.issuedAt));
    expect([...issued].sort((a, b) => b - a)).toEqual(issued);
    const resolved = s.history.slice(1).reverse(); // oldest first, in round order
    expect(resolved.map((r) => (r.outcome.status === 'scored' ? r.outcome.multiplier : null))).toEqual(actual);
    expect(new Set(s.history.map((r) => r.id)).size).toBe(s.history.length); // no duplicates
    for (const r of resolved) {
      const o = r.outcome;
      if (o.status !== 'scored') throw new Error('expected scored');
      const top = r.probabilities.indexOf(Math.max(...r.probabilities));
      expect(o.topRangeHit).toBe(rangeHit(o.multiplier, top));
    }
    // 2× / 5× / 10× events come from the actual multipliers (≥), not from a range label
    for (const t of s.performance.thresholds) {
      expect(t.events).toBe(actual.filter((m) => targetHit(m, t.threshold)).length);
    }
    expect(s.performance.thresholds.map((t) => t.events)).toEqual([6, 3, 1]);
    expect(await count('forecast_outcomes')).toBe(actual.length);
  });

});
