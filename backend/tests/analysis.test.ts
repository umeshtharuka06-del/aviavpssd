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
});
