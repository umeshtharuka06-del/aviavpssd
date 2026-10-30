import { randomUUID } from 'node:crypto';
import { AnalysisResponseSchema } from '@aviator/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { StatisticalAnalysisProvider } from '../src/engine/statistical-provider.js';
import { adminHeaders, bearer, createAdmin, createHarness, generate, newDeviceId, redeem, resetDb, type Harness } from './helpers.js';

/**
 * Phase 2: each device's analysis is independent. Observations are scoped to the
 * device_activation_id of the authenticated session, so one device never sees another's
 * history — even on the same subscription and the same site.
 */
let h: Harness;

beforeAll(async () => {
  h = await createHarness({ provider: new StatisticalAnalysisProvider({ minSampleSize: 10 }) });
});
afterAll(async () => h.close());
beforeEach(async () => {
  await resetDb(h.pool);
  await createAdmin(h.pool);
});

const ingest = (token: string, multipliers: number[]) =>
  h.app.inject({
    method: 'POST',
    url: '/v1/history',
    headers: bearer(token),
    payload: { batchId: randomUUID(), siteId: 'devfixture', adapterVersion: '1.0.0', observations: multipliers.map((m) => ({ multiplier: m })) },
  });

const analyze = async (token: string) => {
  const res = await h.app.inject({ method: 'POST', url: '/v1/analysis', headers: bearer(token), payload: { siteId: 'devfixture' } });
  return { statusCode: res.statusCode, body: AnalysisResponseSchema.parse(res.json()) };
};

/** Redeems two device slots on one subscription; returns both device session tokens. */
async function twoDevicesOneSubscription(deviceLimit = 5) {
  const [c] = await generate(h, await adminHeaders(h), { plan: '30d', deviceLimit });
  const a = (await redeem(h, c!.code, newDeviceId())).body.session.token as string;
  const b = (await redeem(h, c!.code, newDeviceId())).body.session.token as string;
  return { a, b };
}

describe('device isolation (per-device analysis)', () => {
  it('a device analysis sees only its own observations, not another device on the same subscription', async () => {
    const { a, b } = await twoDevicesOneSubscription();
    await ingest(a, [1, 1.5, 2, 2.5, 3, 5, 7.5, 10, 15, 50, 2.2, 4.4]); // 12 rounds
    await ingest(b, [1.1, 1.2, 1.3]); // 3 rounds

    const ra = await analyze(a);
    expect(ra.body.observationsConsidered).toBe(12);
    expect(ra.body.status).toBe('ok');

    const rb = await analyze(b);
    expect(rb.body.observationsConsidered).toBe(3); // NOT 15 — histories are not pooled
    expect(rb.body.status).toBe('insufficient_data');
  });

  it('a device sees nothing from a device on a different subscription', async () => {
    const { a } = await twoDevicesOneSubscription();
    const [c2] = await generate(h, await adminHeaders(h), { plan: '30d' });
    const other = (await redeem(h, c2!.code, newDeviceId())).body.session.token as string;

    await ingest(a, [2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    await ingest(other, [1.01, 1.02, 1.03, 1.04, 1.05]);

    expect((await analyze(a)).body.observationsConsidered).toBe(10);
    expect((await analyze(other)).body.observationsConsidered).toBe(5);
  });

  it('the same round reported by two devices is counted once per device', async () => {
    const { a, b } = await twoDevicesOneSubscription();
    const roundRef = (n: number) => ({ multiplier: 2 + n / 10, roundRef: `shared-${n}` });
    const shared = Array.from({ length: 10 }, (_, n) => roundRef(n));
    const req = (token: string) =>
      h.app.inject({ method: 'POST', url: '/v1/history', headers: bearer(token), payload: { batchId: randomUUID(), siteId: 'devfixture', adapterVersion: '1.0.0', observations: shared } });

    expect((await req(a)).json()).toMatchObject({ accepted: 10, duplicates: 0 });
    expect((await req(b)).json()).toMatchObject({ accepted: 10, duplicates: 0 }); // device B keeps its own copies

    expect((await analyze(a)).body.observationsConsidered).toBe(10);
    expect((await analyze(b)).body.observationsConsidered).toBe(10);
  });

  it('empty history for a device is reported as that device having no data', async () => {
    const { a, b } = await twoDevicesOneSubscription();
    await ingest(a, [2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    const rb = await analyze(b);
    expect(rb.statusCode).toBe(200);
    expect(rb.body.observationsConsidered).toBe(0);
    expect(rb.body.status).toBe('insufficient_data');
  });
});
