import { randomUUID } from 'node:crypto';
import { AnalysisResponseSchema } from '@aviator/contracts';
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
    expect(body.engine).toEqual({ kind: 'live', version: 'stat-5' });
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
    expect(body.engine).toEqual({ kind: 'live', version: 'stat-5' });
    expect(body.observationsConsidered).toBe(10);
    expect(body.windowHours).toBe(12);
    expect(body.items.length).toBe(6);
    expect(body.summary?.sufficiency).toBe('sufficient');
    // 10 rounds are far below the forecast minimum: the experiment reports that, with no estimate.
    expect(body.forecast).toMatchObject({ method: 'walk_forward_v2', status: 'insufficient_data', sampleSize: 10, minSampleSize: 100, thresholds: [] });
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
    // The mandatory disclaimer names "prediction"/"betting" to deny them; check everything else.
    const { notice, ...rest } = res.json();
    expect(notice).toMatch(/not a signal, prediction, or betting recommendation/);
    const json = JSON.stringify(rest);
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

  it('includes the device-scoped historical summary with threshold counts', async () => {
    //                1  1.5 1.99  2  3  4.99  5  7  9.99  10  20  50   (12 rounds)
    await ingest([1, 1.5, 1.99, 2, 3, 4.99, 5, 7, 9.99, 10, 20, 50]);
    const body = AnalysisResponseSchema.parse((await analyze()).json());
    const s = body.summary!;
    expect(s.scope).toBe('device');
    expect(s.sampleSize).toBe(12);
    expect(s.minSampleSize).toBe(10);
    expect(s.sufficiency).toBe('sufficient');
    expect(s.thresholds).toEqual([
      { threshold: 2, count: 9, frequency: 9 / 12 },
      { threshold: 5, count: 6, frequency: 6 / 12 },
      { threshold: 10, count: 3, frequency: 3 / 12 },
    ]);
    expect(s.below2x).toEqual({ threshold: 2, count: 3, frequency: 3 / 12 });
    expect(s.averageMultiplier).toBeCloseTo(116.47 / 12, 6);
    expect(s.latestRoundAt).not.toBeNull();
    expect(s.isHistoricalOnly).toBe(true);
  });

  it('no longer returns rolling-window, baseline or signal fields', async () => {
    await ingest([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    const raw = (await analyze()).json();
    expect(raw).not.toHaveProperty('metrics');
    expect(raw).not.toHaveProperty('patterns');
    expect(raw).not.toHaveProperty('signal');
  });

  it('reports a collecting summary with the real sample size when data is insufficient', async () => {
    await ingest([1.5, 2, 3]);
    const body = AnalysisResponseSchema.parse((await analyze()).json());
    expect(body.status).toBe('insufficient_data');
    expect(body.summary?.sufficiency).toBe('collecting');
    expect(body.summary?.sampleSize).toBe(3);
    expect(body.summary?.thresholds[0]).toEqual({ threshold: 2, count: 2, frequency: 2 / 3 });
  });

  it('a retried batch (same batchId) is counted once', async () => {
    const payload = { batchId: randomUUID(), siteId: 'devfixture', adapterVersion: '1.0.0', observations: [{ multiplier: 2 }, { multiplier: 3 }] };
    for (let i = 0; i < 2; i++) await h.app.inject({ method: 'POST', url: '/v1/history', headers: bearer(token), payload });
    const body = AnalysisResponseSchema.parse((await analyze()).json());
    expect(body.summary?.sampleSize).toBe(2);
  });
});
