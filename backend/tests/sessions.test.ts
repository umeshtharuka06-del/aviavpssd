import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { adminHeaders, bearer, createAdmin, createHarness, DAY, generate, newDeviceId, redeem, resetDb, type Harness } from './helpers.js';

let h: Harness;
let token: string;
let deviceId: string;
let codeId: string;

beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => h.close());
beforeEach(async () => {
  await resetDb(h.pool);
  h.clock.t = new Date('2026-01-01T00:00:00.000Z');
  await createAdmin(h.pool);
  const [c] = await generate(h, await adminHeaders(h), { plan: '365d' });
  codeId = c!.id;
  const r = await redeem(h, c!.code);
  token = r.body.session.token;
  deviceId = r.deviceId;
});

const status = (headers: Record<string, string> = {}) => h.app.inject({ method: 'GET', url: '/v1/subscription', headers });

describe('customer session validation', () => {
  it('returns subscription status computed by the server', async () => {
    const res = await status(bearer(token));
    expect(res.statusCode).toBe(200);
    expect(res.json().subscription).toMatchObject({ plan: '365d', status: 'active', expiresAt: '2027-01-01T00:00:00.000Z' });
  });

  it('rejects missing, malformed and unknown tokens with SESSION_INVALID', async () => {
    for (const headers of [{}, { authorization: 'Bearer short' }, { authorization: `Basic ${token}` }, bearer('A'.repeat(43))]) {
      const res = await status(headers);
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe('SESSION_INVALID');
    }
  });

  it('expires sessions after the TTL (7 days) with SESSION_EXPIRED', async () => {
    h.clock.advance(7 * DAY);
    const res = await status(bearer(token));
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('SESSION_EXPIRED');
  });

  it('refresh rotates the token and requires the bound device id', async () => {
    h.clock.advance(8 * DAY); // session expired but within the refresh grace period
    const wrong = await h.app.inject({ method: 'POST', url: '/v1/session/refresh', headers: bearer(token), payload: { deviceId: newDeviceId() } });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json().error.code).toBe('DEVICE_MISMATCH');

    const ok = await h.app.inject({ method: 'POST', url: '/v1/session/refresh', headers: bearer(token), payload: { deviceId } });
    expect(ok.statusCode).toBe(200);
    const fresh = ok.json().session.token as string;
    expect(fresh).not.toBe(token);
    expect((await status(bearer(fresh))).statusCode).toBe(200);
    expect((await status(bearer(token))).json().error.code).toBe('SESSION_INVALID'); // old one revoked
  });

  it('refresh is refused 30 days after session expiry', async () => {
    h.clock.advance(7 * DAY + 31 * DAY);
    const res = await h.app.inject({ method: 'POST', url: '/v1/session/refresh', headers: bearer(token), payload: { deviceId } });
    expect(res.json().error.code).toBe('SESSION_EXPIRED');
  });

  it('sessions never outlive the subscription', async () => {
    const r = await h.pool.query('SELECT max(expires_at) AS e FROM customer_sessions');
    expect(new Date(r.rows[0].e).getTime()).toBeLessThanOrEqual(new Date('2027-01-01T00:00:00Z').getTime());
  });

  it('logout revokes the session', async () => {
    const out = await h.app.inject({ method: 'POST', url: '/v1/session/logout', headers: bearer(token) });
    expect(out.statusCode).toBe(204);
    expect((await status(bearer(token))).statusCode).toBe(401);
  });

  it('revoking the code returns 401 to the extension (sessions + slots revoked)', async () => {
    await h.app.inject({ method: 'POST', url: `/v1/admin/codes/${codeId}/revoke`, headers: await adminHeaders(h), payload: { reason: 'abuse' } });
    expect((await status(bearer(token))).statusCode).toBe(401);
  });

  it('customer tokens are not accepted by admin endpoints', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/v1/admin/codes', headers: bearer(token) });
    expect(res.statusCode).toBe(403);
    const withKey = await h.app.inject({
      method: 'GET',
      url: '/v1/admin/codes',
      headers: { ...bearer(token), 'x-admin-service-key': h.ctx.env.ADMIN_SERVICE_KEY },
    });
    expect(withKey.statusCode).toBe(401);
    expect(withKey.json().error.code).toBe('ADMIN_UNAUTHORIZED');
  });
});
