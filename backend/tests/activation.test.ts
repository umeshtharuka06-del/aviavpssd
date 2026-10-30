import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  adminHeaders,
  bearer,
  createAdmin,
  createHarness,
  DAY,
  generate,
  newDeviceId,
  redeem,
  resetDb,
  type Harness,
} from './helpers.js';

let h: Harness;
let admin: Record<string, string>;

beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => h.close());
beforeEach(async () => {
  await resetDb(h.pool);
  h.clock.t = new Date('2026-01-01T00:00:00.000Z');
  await createAdmin(h.pool);
  admin = await adminHeaders(h);
});

describe('redemption', () => {
  it('activates a 30-day code and starts the period at first activation', async () => {
    const [c] = await generate(h, admin, { plan: '30d' });
    h.clock.advance(5 * DAY); // generated earlier; period must start at redemption, not creation
    const { res, body } = await redeem(h, c!.code);
    expect(res.statusCode).toBe(200);
    expect(body.result).toBe('activated');
    expect(body.subscription).toMatchObject({
      plan: '30d',
      status: 'active',
      activatedAt: '2026-01-06T00:00:00.000Z',
      expiresAt: '2026-02-05T00:00:00.000Z',
      deviceLimit: 5, // default for new codes
      devicesInUse: 1,
    });
    expect(body.session.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('activates a 365-day code with a 365×24 h period', async () => {
    const [c] = await generate(h, admin, { plan: '365d' });
    const { body } = await redeem(h, c!.code);
    expect(body.subscription.expiresAt).toBe('2027-01-01T00:00:00.000Z');
  });

  it('rejects unknown and malformed codes with CODE_INVALID', async () => {
    for (const code of ['AVX-0000-0000-0000-0000-0000', 'definitely-not-a-valid-code']) {
      const { res, body } = await redeem(h, code);
      expect(res.statusCode).toBe(404);
      expect(body.error.code).toBe('CODE_INVALID');
    }
  });

  it('accepts the code in any case / spacing', async () => {
    const [c] = await generate(h, admin, { plan: '30d' });
    const { body } = await redeem(h, ` ${c!.code.toLowerCase().replace(/-/g, ' ')} `);
    expect(body.result).toBe('activated');
  });

  it('rejects a revoked code with CODE_REVOKED', async () => {
    const [c] = await generate(h, admin, { plan: '30d' });
    await h.app.inject({ method: 'POST', url: `/v1/admin/codes/${c!.id}/revoke`, headers: admin, payload: { reason: 'test revoke' } });
    const { res, body } = await redeem(h, c!.code);
    expect(res.statusCode).toBe(410);
    expect(body.error.code).toBe('CODE_REVOKED');
  });

  it('rejects a code whose redeem-by date passed with CODE_EXPIRED', async () => {
    const [c] = await generate(h, admin, { plan: '30d', redeemWithinDays: 10 });
    h.clock.advance(10 * DAY);
    const { res, body } = await redeem(h, c!.code);
    expect(res.statusCode).toBe(410);
    expect(body.error).toMatchObject({ code: 'CODE_EXPIRED', details: { reason: 'not_redeemed_in_time' } });
  });

  it('ignores client-supplied plan/expiry fields (strict schema)', async () => {
    const [c] = await generate(h, admin, { plan: '30d' });
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/activation/redeem',
      payload: { code: c!.code, deviceId: newDeviceId(), expiresAt: '2099-01-01T00:00:00Z', plan: '365d' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_FAILED');
  });
});

describe('one-time redemption & device limits', () => {
  it('one-time redemption: a code never starts a second subscription (1-device code)', async () => {
    const [c] = await generate(h, admin, { plan: '30d', deviceLimit: 1 });
    expect((await redeem(h, c!.code)).body.result).toBe('activated');
    const second = await redeem(h, c!.code);
    expect(second.res.statusCode).toBe(409);
    expect(second.body.error).toMatchObject({ code: 'DEVICE_LIMIT_REACHED', details: { reason: 'device_limit_reached', deviceLimit: 1, devicesInUse: 1 } });
    const subs = await h.pool.query('SELECT count(*)::int AS n FROM subscriptions');
    expect(subs.rows[0].n).toBe(1);
  });

  it('same device re-entering the code restores access without restarting the period', async () => {
    const [c] = await generate(h, admin, { plan: '30d' });
    const first = await redeem(h, c!.code);
    h.clock.advance(3 * DAY);
    const again = await redeem(h, c!.code, first.deviceId);
    expect(again.body.result).toBe('device_restored');
    expect(again.body.subscription.expiresAt).toBe(first.body.subscription.expiresAt);
    // the previous session for that device is revoked
    const old = await h.app.inject({ method: 'GET', url: '/v1/subscription', headers: bearer(first.body.session.token) });
    expect(old.json().error.code).toBe('SESSION_INVALID');
  });

  it('enforces the configured device limit server-side', async () => {
    const [c] = await generate(h, admin, { plan: '365d', deviceLimit: 2 });
    expect((await redeem(h, c!.code)).body.result).toBe('activated');
    expect((await redeem(h, c!.code)).body.result).toBe('device_added');
    const third = await redeem(h, c!.code);
    expect(third.res.statusCode).toBe(409);
    expect(third.body.error.code).toBe('DEVICE_LIMIT_REACHED');
  });

  it('admin device reset frees slots but never extends the subscription', async () => {
    const [c] = await generate(h, admin, { plan: '30d' });
    const first = await redeem(h, c!.code);
    h.clock.advance(DAY);
    admin = await adminHeaders(h); // admin sessions last 8 h
    const reset = await h.app.inject({ method: 'POST', url: `/v1/admin/codes/${c!.id}/reset-devices`, headers: admin, payload: { reason: 'new laptop' } });
    expect(reset.statusCode).toBe(200);
    expect(reset.json().code.devicesInUse).toBe(0);
    // old device session is dead
    const old = await h.app.inject({ method: 'GET', url: '/v1/subscription', headers: bearer(first.body.session.token) });
    expect(old.statusCode).toBe(401);
    // new device can attach; expiry unchanged
    const replacement = await redeem(h, c!.code);
    expect(replacement.body.result).toBe('device_added');
    expect(replacement.body.subscription.expiresAt).toBe(first.body.subscription.expiresAt);
    const events = await h.pool.query("SELECT detail FROM security_events WHERE event_type = 'admin.devices_reset'");
    expect(events.rows[0].detail).toMatchObject({ id: c!.id, devicesReset: 1, reason: 'new laptop' });
  });

  it('handles concurrent redemption of a 1-device code: exactly one activation wins', async () => {
    const [c] = await generate(h, admin, { plan: '30d', deviceLimit: 1 });
    const results = await Promise.all(Array.from({ length: 12 }, () => redeem(h, c!.code)));
    const ok = results.filter((r) => r.res.statusCode === 200);
    const conflicts = results.filter((r) => r.res.statusCode === 409);
    expect(ok).toHaveLength(1);
    expect(ok[0]!.body.result).toBe('activated');
    expect(conflicts).toHaveLength(11);
    const db = await h.pool.query(`SELECT (SELECT count(*)::int FROM subscriptions) AS subs,
      (SELECT count(*)::int FROM device_activations WHERE deactivated_at IS NULL) AS devices`);
    expect(db.rows[0]).toEqual({ subs: 1, devices: 1 });
  });

  it('concurrent redemptions with device limit 3 never exceed 3 devices', async () => {
    const [c] = await generate(h, admin, { plan: '30d', deviceLimit: 3 });
    const results = await Promise.all(Array.from({ length: 10 }, () => redeem(h, c!.code)));
    expect(results.filter((r) => r.res.statusCode === 200)).toHaveLength(3);
    const db = await h.pool.query('SELECT count(*)::int AS n FROM device_activations WHERE deactivated_at IS NULL');
    expect(db.rows[0].n).toBe(3);
  });
});

describe('subscription status & expiry', () => {
  it('reports active, then SUBSCRIPTION_EXPIRED after exactly 30 days', async () => {
    const [c] = await generate(h, admin, { plan: '30d' });
    const { body } = await redeem(h, c!.code);
    const token = body.session.token;
    // keep the session fresh so the subscription check is what fails
    h.clock.advance(30 * DAY - 1000);
    let res = await h.app.inject({ method: 'GET', url: '/v1/subscription', headers: bearer(token) });
    // session TTL (7 days) has passed → refresh is needed, but subscription is still active
    expect(res.json().error.code).toBe('SESSION_EXPIRED');
    h.clock.advance(1000);
    res = await h.app.inject({ method: 'GET', url: '/v1/subscription', headers: bearer(token) });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('SUBSCRIPTION_EXPIRED');
    // re-entering the code after expiry does not restart anything
    const again = await redeem(h, c!.code);
    expect(again.body.error).toMatchObject({ code: 'CODE_EXPIRED', details: { reason: 'subscription_ended' } });
  });

  it('a revoked code immediately invalidates its subscription', async () => {
    const [c] = await generate(h, admin, { plan: '365d' });
    const { body } = await redeem(h, c!.code);
    await h.app.inject({ method: 'POST', url: `/v1/admin/codes/${c!.id}/revoke`, headers: admin, payload: { reason: 'chargeback' } });
    const res = await h.app.inject({ method: 'GET', url: '/v1/subscription', headers: bearer(body.session.token) });
    expect(res.statusCode).toBe(401); // device slots deactivated + sessions revoked
    const sub = await h.pool.query('SELECT revoked_at FROM subscriptions');
    expect(sub.rows[0].revoked_at).not.toBeNull();
  });

  it('the redeem endpoint is rate limited per IP', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      const res = await h.app.inject({
        method: 'POST',
        url: '/v1/activation/redeem',
        payload: { code: 'AVX-0000-0000-0000-0000-0000', deviceId: newDeviceId() },
        remoteAddress: '192.0.2.77',
      });
      statuses.push(res.statusCode);
    }
    expect(statuses.slice(0, 10).every((s) => s === 404)).toBe(true);
    expect(statuses[10]).toBe(429);
  });
});
