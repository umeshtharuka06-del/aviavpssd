import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ADMIN_EMAIL,
  adminHeaders,
  createAdmin,
  createHarness,
  DAY,
  generate,
  redeem,
  resetDb,
  serviceHeaders,
  TEST_SECRETS,
  type Harness,
} from './helpers.js';

let h: Harness;

beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => h.close());
beforeEach(async () => {
  await resetDb(h.pool);
  h.clock.t = new Date('2026-01-01T00:00:00.000Z');
  await createAdmin(h.pool);
});

const login = (password: string, ip = '203.0.113.9') =>
  h.app.inject({
    method: 'POST',
    url: '/v1/admin/auth/login',
    headers: { ...serviceHeaders(), 'x-admin-client-ip': ip },
    payload: { email: ADMIN_EMAIL, password },
  });

describe('admin authorization', () => {
  const protectedRoutes = [
    ['GET', '/v1/admin/me'],
    ['GET', '/v1/admin/codes'],
    ['GET', '/v1/admin/codes/stats'],
    ['POST', '/v1/admin/codes'],
    ['POST', '/v1/admin/codes/ac_0000000000000000/revoke'],
    ['POST', '/v1/admin/codes/ac_0000000000000000/reset-devices'],
    ['GET', '/v1/admin/system/retention'],
  ] as const;

  it('rejects every admin route without the service key (403), even with a valid session', async () => {
    const auth = await adminHeaders(h);
    for (const [method, url] of protectedRoutes) {
      const res = await h.app.inject({ method, url, headers: { authorization: auth.authorization }, payload: method === 'POST' ? {} : undefined });
      expect(res.statusCode, url).toBe(403);
      expect(res.json().error.code).toBe('ADMIN_FORBIDDEN');
    }
  });

  it('rejects a wrong service key', async () => {
    const res = await h.app.inject({ method: 'POST', url: '/v1/admin/auth/login', headers: { 'x-admin-service-key': TEST_SECRETS.ADMIN_SERVICE_KEY + 'x' }, payload: {} });
    expect(res.statusCode).toBe(403);
  });

  it('rejects every admin route with the service key but no/invalid session (401)', async () => {
    for (const [method, url] of protectedRoutes) {
      for (const authorization of [undefined, 'Bearer ' + 'x'.repeat(43)]) {
        const res = await h.app.inject({ method, url, headers: { ...serviceHeaders(), ...(authorization ? { authorization } : {}) }, payload: method === 'POST' ? {} : undefined });
        expect(res.statusCode, url).toBe(401);
        expect(res.json().error.code).toBe('ADMIN_UNAUTHORIZED');
      }
    }
  });

  it('expires admin sessions after 8 hours and supports logout', async () => {
    const auth = await adminHeaders(h);
    expect((await h.app.inject({ method: 'GET', url: '/v1/admin/me', headers: auth })).statusCode).toBe(200);
    h.clock.advance(8 * 3600_000);
    expect((await h.app.inject({ method: 'GET', url: '/v1/admin/me', headers: auth })).statusCode).toBe(401);
    const fresh = await adminHeaders(h);
    expect((await h.app.inject({ method: 'POST', url: '/v1/admin/auth/logout', headers: fresh })).statusCode).toBe(204);
    expect((await h.app.inject({ method: 'GET', url: '/v1/admin/me', headers: fresh })).statusCode).toBe(401);
  });
});

describe('admin login', () => {
  it('rejects a wrong password with a generic error', async () => {
    const res = await login('wrong password!!');
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('ADMIN_UNAUTHORIZED');
  });

  it('locks the account after 5 failures, even for the right password', async () => {
    for (let i = 0; i < 5; i++) await login('wrong password!!', `198.51.100.${i}`);
    const res = await login('correct horse battery staple', '198.51.100.99');
    expect(res.statusCode).toBe(401);
    h.clock.advance(16 * 60_000);
    expect((await login('correct horse battery staple', '198.51.100.98')).statusCode).toBe(200);
  });

  it('rate limits login attempts per client IP', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await login('wrong password!!', '192.0.2.200')).statusCode);
    expect(codes[5]).toBe(429);
  });

  it('stores only an Argon2id password hash', async () => {
    const r = await h.pool.query('SELECT password_hash FROM admin_users');
    expect(r.rows[0].password_hash).toMatch(/^\$argon2id\$/);
  });
});

describe('code generation, listing and revocation', () => {
  it('generates 30-day and 365-day codes; plaintext is returned once and never stored', async () => {
    const auth = await adminHeaders(h);
    const [a] = await generate(h, auth, { plan: '30d' });
    const [b] = await generate(h, auth, { plan: '365d', note: 'reseller batch 1' });
    expect(a).toMatchObject({ plan: '30d', status: 'unused', deviceLimit: 5 }); // DEFAULT_DEVICE_LIMIT
    expect(b).toMatchObject({ plan: '365d', status: 'unused', note: 'reseller batch 1' });

    const dump = await h.pool.query('SELECT row_to_json(c)::text AS j FROM activation_codes c');
    for (const code of [a!.code, b!.code]) {
      const body = code.replace(/^AVX-/, '').replace(/-/g, '');
      for (const row of dump.rows) {
        expect(row.j).not.toContain(code);
        expect(row.j).not.toContain(body);
      }
    }
    // listing never includes plaintext
    const list = await h.app.inject({ method: 'GET', url: '/v1/admin/codes', headers: auth });
    expect(list.body).not.toContain(a!.code);
    expect(list.json().items[0]).not.toHaveProperty('code');
  });

  it('never writes plaintext codes or tokens to logs', async () => {
    const auth = await adminHeaders(h);
    const [c] = await generate(h, auth, { plan: '30d' });
    const r = await redeem(h, c!.code);
    const logs = h.logs.join('\n');
    expect(logs.length).toBeGreaterThan(0);
    expect(logs).not.toContain(c!.code);
    expect(logs).not.toContain(r.body.session.token);
    expect(logs).not.toContain(auth.authorization.slice(7));
    expect(logs).not.toContain(TEST_SECRETS.ADMIN_SERVICE_KEY);
  });

  it('validates generation input', async () => {
    const auth = await adminHeaders(h);
    for (const payload of [{ plan: '7d' }, { plan: '30d', quantity: 21 }, { plan: '30d', deviceLimit: 9 }, { plan: '30d', extra: 1 }]) {
      const res = await h.app.inject({ method: 'POST', url: '/v1/admin/codes', headers: auth, payload });
      expect(res.statusCode).toBe(400);
    }
  });

  it('filters by status, plan, redemption, creation date and hint/id', async () => {
    let auth = await adminHeaders(h);
    const [u30] = await generate(h, auth, { plan: '30d' });
    const [r365] = await generate(h, auth, { plan: '365d' });
    h.clock.advance(2 * DAY);
    auth = await adminHeaders(h); // admin sessions last 8 h
    const later = await generate(h, auth, { plan: '30d', quantity: 2 });
    await redeem(h, r365!.code);
    await h.app.inject({ method: 'POST', url: `/v1/admin/codes/${later[0]!.id}/revoke`, headers: auth, payload: { reason: 'mistake' } });

    const q = async (qs: string) => (await h.app.inject({ method: 'GET', url: `/v1/admin/codes?${qs}`, headers: auth })).json();
    expect((await q('')).total).toBe(4);
    expect((await q('status=active')).items.map((i: { id: string }) => i.id)).toEqual([r365!.id]);
    expect((await q('status=revoked')).items.map((i: { id: string }) => i.id)).toEqual([later[0]!.id]);
    expect((await q('status=unused')).total).toBe(2);
    expect((await q('plan=365d')).total).toBe(1);
    expect((await q('redeemed=true')).total).toBe(1);
    expect((await q('redeemed=false')).total).toBe(3);
    expect((await q(`createdTo=${encodeURIComponent('2026-01-01T12:00:00.000Z')}`)).total).toBe(2);
    expect((await q(`createdFrom=${encodeURIComponent('2026-01-02T00:00:00.000Z')}`)).total).toBe(2);
    expect((await q(`q=${u30!.code.slice(-4)}`)).items.some((i: { id: string }) => i.id === u30!.id)).toBe(true);
    expect((await q(`q=${u30!.id.slice(0, 8)}`)).items[0].id).toBe(u30!.id);
    // a full code typed into search finds nothing (full codes are never looked up via URLs)
    expect((await q(`q=${encodeURIComponent(u30!.code)}`)).total).toBe(0);

    const detail = (await q('status=active')).items[0];
    expect(detail.redeemedAt).toBe('2026-01-03T00:00:00.000Z');
    expect(detail.expiresAt).toBe('2027-01-03T00:00:00.000Z');

    const stats = (await h.app.inject({ method: 'GET', url: '/v1/admin/codes/stats', headers: auth })).json();
    expect(stats).toEqual({ total: 4, byStatus: { unused: 2, active: 1, expired: 0, revoked: 1 }, byPlan: { '30d': 3, '365d': 1 } });
  });

  it('revocation requires a reason, is idempotent and audited', async () => {
    const auth = await adminHeaders(h);
    const [c] = await generate(h, auth, { plan: '30d' });
    const noReason = await h.app.inject({ method: 'POST', url: `/v1/admin/codes/${c!.id}/revoke`, headers: auth, payload: {} });
    expect(noReason.statusCode).toBe(400);
    const first = await h.app.inject({ method: 'POST', url: `/v1/admin/codes/${c!.id}/revoke`, headers: auth, payload: { reason: 'sold in error' } });
    expect(first.json().code).toMatchObject({ status: 'revoked', revokeReason: 'sold in error' });
    const second = await h.app.inject({ method: 'POST', url: `/v1/admin/codes/${c!.id}/revoke`, headers: auth, payload: { reason: 'again' } });
    expect(second.json().code.revokeReason).toBe('sold in error');
    const events = await h.pool.query("SELECT count(*)::int AS n FROM security_events WHERE event_type = 'admin.code_revoked'");
    expect(events.rows[0].n).toBe(1);
    const missing = await h.app.inject({ method: 'POST', url: '/v1/admin/codes/ac_ZZZZZZZZZZZZZZZZ/revoke', headers: auth, payload: { reason: 'x y z' } });
    expect(missing.statusCode).toBe(404);
  });

  it('marks never-redeemed codes past their redeem-by date as expired', async () => {
    const auth = await adminHeaders(h);
    await generate(h, auth, { plan: '30d', redeemWithinDays: 1 });
    h.clock.advance(2 * DAY);
    const list = await h.app.inject({ method: 'GET', url: '/v1/admin/codes', headers: await adminHeaders(h) });
    expect(list.json().items[0].status).toBe('expired');
  });
});
