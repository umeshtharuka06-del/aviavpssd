import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { adminHeaders, bearer, createAdmin, createHarness, DAY, generate, redeem, resetDb, type Harness } from './helpers.js';

let h: Harness;
let token: string;

beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => h.close());
beforeEach(async () => {
  await resetDb(h.pool);
  h.clock.t = new Date('2026-01-01T00:00:00.000Z');
  await createAdmin(h.pool);
  const [c] = await generate(h, await adminHeaders(h), { plan: '30d', deviceLimit: 2 });
  token = (await redeem(h, c!.code)).body.session.token;
});

const batch = (observations: unknown[], extra: Record<string, unknown> = {}) => ({
  batchId: randomUUID(),
  siteId: 'devfixture',
  adapterVersion: '1.0.0',
  observations,
  ...extra,
});
const post = (payload: unknown, headers: Record<string, string> = bearer(token)) =>
  h.app.inject({ method: 'POST', url: '/v1/history', headers, payload: payload as object });

describe('history ingestion', () => {
  it('accepts valid observations and stamps server-side received_at', async () => {
    const res = await post(batch([{ multiplier: 1.5 }, { multiplier: 23.07, roundRef: 'r-1001' }]));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ result: 'accepted', accepted: 2, duplicates: 0 });
    const rows = await h.pool.query(`SELECT multiplier::text, round_ref, abs(extract(epoch FROM now() - received_at)) < 60 AS fresh
                                       FROM game_observations ORDER BY id`);
    expect(rows.rows).toEqual([
      { multiplier: '1.50', round_ref: null, fresh: true },
      { multiplier: '23.07', round_ref: 'r-1001', fresh: true },
    ]);
  });

  it('rejects client-supplied timestamps (cannot extend retention)', async () => {
    const res = await post(batch([{ multiplier: 2, receivedAt: '2099-01-01T00:00:00Z' }]));
    expect(res.statusCode).toBe(400);
    const top = await post(batch([{ multiplier: 2 }], { receivedAt: '2099-01-01T00:00:00Z' }));
    expect(top.statusCode).toBe(400);
  });

  it.each([
    ['empty batch', batch([])],
    ['multiplier below 1', batch([{ multiplier: 0.99 }])],
    ['too many decimals', batch([{ multiplier: 1.234 }])],
    ['non-numeric multiplier', batch([{ multiplier: '2.00' }])],
    ['huge multiplier', batch([{ multiplier: 1e9 }])],
    ['51 observations', batch(Array.from({ length: 51 }, () => ({ multiplier: 2 })))],
    ['bad site id', batch([{ multiplier: 2 }], { siteId: 'Bad Site!' })],
    ['bad roundRef', batch([{ multiplier: 2, roundRef: '<script>' }])],
    ['missing batchId', { siteId: 'devfixture', adapterVersion: '1', observations: [{ multiplier: 2 }] }],
    ['unsupported site', batch([{ multiplier: 2 }], { siteId: 'somecasino' })],
    ['duplicate roundRef in batch', batch([{ multiplier: 2, roundRef: 'a' }, { multiplier: 3, roundRef: 'a' }])],
  ])('rejects invalid payload: %s', async (_name, payload) => {
    const res = await post(payload);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_FAILED');
    expect((await h.pool.query('SELECT count(*)::int AS n FROM game_observations')).rows[0].n).toBe(0);
  });

  it('rejects oversized bodies with 413', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/history',
      headers: { ...bearer(token), 'content-type': 'application/json' },
      payload: JSON.stringify(batch([{ multiplier: 2, roundRef: 'x'.repeat(9000) }])),
    });
    expect(res.statusCode).toBe(413);
    expect(res.json().error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('rejects malformed JSON and non-JSON content types', async () => {
    const bad = await h.app.inject({ method: 'POST', url: '/v1/history', headers: { ...bearer(token), 'content-type': 'application/json' }, payload: '{"batchId":' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('VALIDATION_FAILED');
    const text = await h.app.inject({ method: 'POST', url: '/v1/history', headers: { ...bearer(token), 'content-type': 'text/plain' }, payload: 'hello' });
    expect(text.statusCode).toBe(415);
  });

  it('makes retries idempotent by batchId', async () => {
    const payload = batch([{ multiplier: 1.1 }, { multiplier: 4.2 }]);
    expect((await post(payload)).json()).toEqual({ result: 'accepted', accepted: 2, duplicates: 0 });
    expect((await post(payload)).json()).toEqual({ result: 'duplicate_batch', accepted: 0, duplicates: 2 });
    expect((await h.pool.query('SELECT count(*)::int AS n FROM game_observations')).rows[0].n).toBe(2);
  });

  it('de-duplicates a repeated roundRef within a device but keeps each device isolated', async () => {
    const other = (await redeem(h, (await generate(h, await adminHeaders(h), { plan: '30d' }))[0]!.code)).body.session.token;
    // Same round reported twice by ONE device is stored once (retry/overlap de-dup).
    expect((await post(batch([{ multiplier: 3.3, roundRef: 'round-77' }]))).json().accepted).toBe(1);
    expect((await post(batch([{ multiplier: 3.3, roundRef: 'round-77' }]))).json()).toMatchObject({ accepted: 0, duplicates: 1 });
    // A DIFFERENT device reporting the same round keeps its own copy — histories are not merged.
    expect((await post(batch([{ multiplier: 3.3, roundRef: 'round-77' }]), bearer(other))).json()).toMatchObject({ accepted: 1, duplicates: 0 });
    const rows = await h.pool.query("SELECT count(*)::int AS n FROM game_observations WHERE round_ref = 'round-77'");
    expect(rows.rows[0].n).toBe(2);
  });

  it('requires a valid session and an active subscription', async () => {
    expect((await post(batch([{ multiplier: 2 }]), {})).statusCode).toBe(401);
    h.clock.advance(31 * DAY);
    const res = await post(batch([{ multiplier: 2 }]));
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('SUBSCRIPTION_EXPIRED');
  });

  it('rate limits ingestion per session', async () => {
    let last = 0;
    for (let i = 0; i < 61; i++) last = (await post(batch([{ multiplier: 2 }]))).statusCode;
    expect(last).toBe(429);
  });
});
