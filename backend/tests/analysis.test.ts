import { randomUUID } from 'node:crypto';
import { AnalysisResponseSchema } from '@aviator/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { StatisticalAnalysisProvider } from '../src/engine/statistical-provider.js';
import { adminHeaders, bearer, createAdmin, createHarness, generate, redeem, resetDb, type Harness } from './helpers.js';

let h: Harness;
let token: string;

beforeAll(async () => {
  h = await createHarness({ provider: new StatisticalAnalysisProvider() });
});
afterAll(async () => h.close());
beforeEach(async () => {
  await resetDb(h.pool);
  await createAdmin(h.pool);
  const [c] = await generate(h, await adminHeaders(h), { plan: '30d' });
  token = (await redeem(h, c!.code)).body.session.token;
});

const ingest = (multipliers: number[]) =>
  h.app.inject({
    method: 'POST',
    url: '/v1/history',
    headers: bearer(token),
    payload: {
      batchId: randomUUID(),
      siteId: 'devfixture',
      adapterVersion: '1.0.0',
      observations: multipliers.map((m) => ({ multiplier: m })),
    },
  });

const analyze = () =>
  h.app.inject({
    method: 'POST',
    url: '/v1/analysis',
    headers: bearer(token),
    payload: { siteId: 'devfixture' },
  });

describe('analysis (statistical provider)', () => {
  it('returns insufficient_data with no observations', async () => {
    const res = await analyze();
    expect(res.statusCode).toBe(200);
    const body = AnalysisResponseSchema.parse(res.json());
    expect(body.status).toBe('insufficient_data');
    expect(body.isTestData).toBe(false);
    expect(body.engine).toEqual({ kind: 'live', version: 'stat-1' });
    expect(body.observationsConsidered).toBe(0);
  });

  it('returns insufficient_data with fewer than 10 observations', async () => {
    await ingest([1.5, 2, 3, 4, 5]);
    const res = await analyze();
    const body = AnalysisResponseSchema.parse(res.json());
    expect(body.status).toBe('insufficient_data');
    expect(body.observationsConsidered).toBe(5);
    expect(body.engine.kind).toBe('live');
  });

  it('returns ok with 10+ observations and full statistics', async () => {
    await ingest([1, 1.5, 2, 2.5, 3, 5, 7.5, 10, 15, 50]);
    const res = await analyze();
    expect(res.statusCode).toBe(200);
    const body = AnalysisResponseSchema.parse(res.json());
    expect(body.status).toBe('ok');
    expect(body.isTestData).toBe(false);
    expect(body.engine).toEqual({ kind: 'live', version: 'stat-1' });
    expect(body.observationsConsidered).toBe(10);
    expect(body.windowHours).toBe(12);
    expect(body.items.length).toBe(14);
    expect(body.items.length).toBeLessThanOrEqual(20);
  });

  it('response validates against AnalysisResponseSchema', async () => {
    await ingest([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    const res = await analyze();
    expect(() => AnalysisResponseSchema.parse(res.json())).not.toThrow();
    const body = AnalysisResponseSchema.parse(res.json());
    for (const { label, value } of body.items) {
      expect(label.length).toBeLessThanOrEqual(80);
      expect(value.length).toBeLessThanOrEqual(80);
    }
    expect(body.notice.length).toBeLessThanOrEqual(400);
  });

  it('contains no predictive language in the response', async () => {
    await ingest([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const res = await analyze();
    const json = JSON.stringify(res.json());
    expect(json).not.toMatch(/predict(ed|ion)?\s*[:=]|accuracy|win rate|next round|guarantee|confidence score|betting/i);
  });

  it('accumulates observations across multiple batches', async () => {
    await ingest([1, 2, 3, 4, 5]);
    await ingest([6, 7, 8, 9, 10]);
    const res = await analyze();
    const body = AnalysisResponseSchema.parse(res.json());
    expect(body.status).toBe('ok');
    expect(body.observationsConsidered).toBe(10);
  });

  it('requires an active subscription', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/analysis',
      payload: { siteId: 'devfixture' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('includes device-scoped structured metrics with thresholds and Wilson intervals', async () => {
    //                1  1.5 1.99  2  3  4.99  5  7  9.99  10  20  50   (12 rounds)
    await ingest([1, 1.5, 1.99, 2, 3, 4.99, 5, 7, 9.99, 10, 20, 50]);
    const body = AnalysisResponseSchema.parse((await analyze()).json());
    expect(body.metrics).toBeDefined();
    const m = body.metrics!;
    expect(m.scope).toBe('device');
    expect(m.quality).toBe('ok');
    expect(m.totalRounds).toBe(12);
    expect(body.observationsConsidered).toBe(12);
    expect(m.latestRoundAt).not.toBeNull();

    const all = m.windows.find((w) => w.window === 'all')!;
    expect(all.sampleSize).toBe(12);
    const stat = (t: number, d: 'at_least' | 'below') => all.thresholds.find((x) => x.threshold === t && x.direction === d)!;
    expect(stat(2, 'at_least').count).toBe(9);
    expect(stat(2, 'below').count).toBe(3);
    expect(stat(5, 'at_least').count).toBe(6);
    expect(stat(10, 'at_least').count).toBe(3);
    for (const s of all.thresholds) {
      expect(s.total).toBe(12);
      expect(s.proportion).toBeCloseTo(s.count / 12, 10);
      expect(s.ciLow).toBeGreaterThanOrEqual(0);
      expect(s.ciHigh).toBeLessThanOrEqual(1);
      expect(s.ciLow).toBeLessThanOrEqual(s.proportion);
      expect(s.ciHigh).toBeGreaterThanOrEqual(s.proportion);
    }
  });

  it('includes recent-pattern comparisons, streaks and distribution', async () => {
    // Most recent three rounds (sent last) are low → a current low streak of 3.
    await ingest([3, 4, 5, 6, 7, 8, 9, 10, 11, 1.1, 1.2, 1.3]);
    const body = AnalysisResponseSchema.parse((await analyze()).json());
    expect(body.patterns).toBeDefined();
    const p = body.patterns!;
    expect(p.recentWindow).toBe(50);
    expect(p.baselineWindow).toBe('all');
    expect(p.comparisons.map((c) => c.threshold)).toEqual([2, 5, 10]);
    expect(p.lowStreak.currentStreak).toBe(3);
    expect(p.highMultipliers.buckets).toHaveLength(4);
    expect(p.warnings.some((w) => /more or less likely next/i.test(w))).toBe(true);
  });

  it('reports metrics with a clear status even when data is insufficient', async () => {
    await ingest([1.5, 2, 3]);
    const body = AnalysisResponseSchema.parse((await analyze()).json());
    expect(body.status).toBe('insufficient_data');
    expect(body.metrics?.quality).toBe('insufficient_data');
    expect(body.metrics?.totalRounds).toBe(3);
    expect(body.metrics?.windows.find((w) => w.window === 'all')?.sampleSize).toBe(3);
  });

  it('includes a device-scoped signal report with descriptive classifications', async () => {
    await ingest([1, 1.5, 2, 3, 5, 7, 9, 10, 20, 50, 2.2, 4.4]);
    const body = AnalysisResponseSchema.parse((await analyze()).json());
    expect(body.signal).toBeDefined();
    const s = body.signal!;
    expect(s.scope).toEqual({ kind: 'device', siteId: 'devfixture' });
    expect(s.isHistoricalOnly).toBe(true);
    expect(s.roundsAnalyzed).toBe(12);
    expect(s.classifications.map((c) => c.threshold)).toEqual([2, 5, 10]);
    // 12 rounds: below the per-threshold minimum recent window → insufficient_data, not a verdict.
    for (const c of s.classifications) expect(c.classification).toBe('insufficient_data');
    expect(s.limitations[0]).toMatch(/not forecasts of future rounds/i);
  });
});
