import { randomUUID } from 'node:crypto';
import { AnalysisResponseSchema } from '@aviator/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MockAnalysisProvider } from '../src/engine/mock-provider.js';
import { adminHeaders, bearer, createAdmin, createHarness, generate, redeem, resetDb, type Harness } from './helpers.js';

/**
 * Schema validation + backward compatibility (Phase 9 item 12). The structured fields
 * (metrics/patterns/signal) are optional: a provider that omits them (the mock) still produces a
 * response that validates, and an older response shape with none of them is still valid. Old
 * extension builds that ignore the new fields keep working.
 */
let h: Harness;
let token: string;

beforeAll(async () => {
  h = await createHarness({ provider: new MockAnalysisProvider() });
});
afterAll(async () => h.close());
beforeEach(async () => {
  await resetDb(h.pool);
  await createAdmin(h.pool);
  token = (await redeem(h, (await generate(h, await adminHeaders(h), { plan: '30d' }))[0]!.code)).body.session.token;
});

describe('analysis response backward compatibility', () => {
  it('a provider without structured fields still returns a valid response', async () => {
    await h.app.inject({
      method: 'POST',
      url: '/v1/history',
      headers: bearer(token),
      payload: { batchId: randomUUID(), siteId: 'devfixture', adapterVersion: '1.0.0', observations: [{ multiplier: 2 }, { multiplier: 3 }] },
    });
    const res = await h.app.inject({ method: 'POST', url: '/v1/analysis', headers: bearer(token), payload: { siteId: 'devfixture' } });
    const body = AnalysisResponseSchema.parse(res.json());
    expect(body.engine.kind).toBe('mock');
    expect(body.isTestData).toBe(true);
    expect(body.items.length).toBeGreaterThan(0);
    // Optional structured fields are simply absent — not null, not empty objects.
    expect(body.metrics).toBeUndefined();
    expect(body.patterns).toBeUndefined();
    expect(body.signal).toBeUndefined();
  });

  it('an old-shaped response (no metrics/patterns/signal) still validates', () => {
    const legacy = {
      engine: { kind: 'live', version: 'stat-1' },
      isTestData: false,
      status: 'ok',
      siteId: 'devfixture',
      generatedAt: '2026-01-01T00:00:00.000Z',
      windowHours: 12,
      observationsConsidered: 10,
      items: [{ label: 'Rounds in window', value: '10' }],
      notice: 'Historical frequencies. Past results do not predict future outcomes.',
    };
    expect(() => AnalysisResponseSchema.parse(legacy)).not.toThrow();
  });
});
