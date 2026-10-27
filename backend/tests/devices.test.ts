import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { raiseDeviceLimits } from '../src/activation/devices.js';
import { defaultMigrationsDir, migrate } from '../src/database/migrate.js';
import { createPool } from '../src/database/pool.js';
import {
  adminHeaders,
  bearer,
  createAdmin,
  createHarness,
  DAY,
  generate,
  newDeviceId,
  nextIp,
  redeem,
  resetDb,
  serviceHeaders,
  TEST_SECRETS,
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

const activeSlots = async () => (await h.pool.query('SELECT count(*)::int AS n FROM device_activations WHERE deactivated_at IS NULL')).rows[0].n as number;
const allSlots = async () => (await h.pool.query('SELECT count(*)::int AS n FROM device_activations')).rows[0].n as number;
const devices = async (codeId: string) => h.app.inject({ method: 'GET', url: `/v1/admin/codes/${codeId}/devices`, headers: admin });

describe('five devices per subscription', () => {
  it('new codes default to 5 devices; the 6th distinct device is rejected with a clear message', async () => {
    const [c] = await generate(h, admin, { plan: '30d' });
    expect(c).toMatchObject({ deviceLimit: 5 });
    const results = [];
    for (let i = 0; i < 5; i++) results.push((await redeem(h, c!.code)).body.result);
    expect(results).toEqual(['activated', 'device_added', 'device_added', 'device_added', 'device_added']);
    const sixth = await redeem(h, c!.code);
    expect(sixth.res.statusCode).toBe(409);
    expect(sixth.body.error).toMatchObject({ code: 'DEVICE_LIMIT_REACHED', details: { deviceLimit: 5, devicesInUse: 5 } });
    expect(sixth.body.error.message).toMatch(/maximum number of devices \(5\)/);
    expect(await activeSlots()).toBe(5);
  });

  it('the same device revalidates (restart, reload, repeated redemption, refresh) without using another slot', async () => {
    const [c] = await generate(h, admin, { plan: '365d' });
    const first = await redeem(h, c!.code);
    const deviceId = first.deviceId;
    // browser restart / extension reload: same stored token
    expect((await h.app.inject({ method: 'GET', url: '/v1/subscription', headers: bearer(first.body.session.token) })).statusCode).toBe(200);
    // repeated redemption from the same device (e.g. storage kept, user re-entered the code)
    for (let i = 0; i < 3; i++) {
      const again = await redeem(h, c!.code, deviceId);
      expect(again.body.result).toBe('device_restored');
      expect(again.body.subscription).toMatchObject({ devicesInUse: 1, expiresAt: first.body.subscription.expiresAt });
    }
    // session rotation
    const latest = (await redeem(h, c!.code, deviceId)).body.session.token;
    const refreshed = await h.app.inject({ method: 'POST', url: '/v1/session/refresh', headers: bearer(latest), payload: { deviceId } });
    expect(refreshed.json().subscription.devicesInUse).toBe(1);
    expect(await allSlots()).toBe(1); // no duplicate device records at all
  });

  it('concurrent duplicate requests from one device create one slot', async () => {
    const [c] = await generate(h, admin, { plan: '30d' });
    const deviceId = newDeviceId();
    const results = await Promise.all(Array.from({ length: 8 }, () => redeem(h, c!.code, deviceId)));
    expect(results.every((r) => r.res.statusCode === 200)).toBe(true);
    expect(results.filter((r) => r.body.result === 'activated')).toHaveLength(1);
    expect(await allSlots()).toBe(1);
  });

  it('concurrent requests from 12 different devices never exceed 5 slots', async () => {
    const [c] = await generate(h, admin, { plan: '30d' });
    const results = await Promise.all(Array.from({ length: 12 }, () => redeem(h, c!.code)));
    expect(results.filter((r) => r.res.statusCode === 200)).toHaveLength(5);
    expect(results.filter((r) => r.body.error?.code === 'DEVICE_LIMIT_REACHED')).toHaveLength(7);
    const db = await h.pool.query(`SELECT (SELECT count(*)::int FROM subscriptions) AS subs, (SELECT count(*)::int FROM device_activations WHERE deactivated_at IS NULL) AS active`);
    expect(db.rows[0]).toEqual({ subs: 1, active: 5 });
  });

  it('the database itself refuses a 6th active slot (guard against bugs or manual SQL)', async () => {
    const [c] = await generate(h, admin, { plan: '30d' });
    for (let i = 0; i < 5; i++) await redeem(h, c!.code);
    const sub = (await h.pool.query('SELECT id FROM subscriptions')).rows[0].id;
    await expect(
      h.pool.query(`INSERT INTO device_activations (subscription_id, device_hash, public_id) VALUES ($1, decode(repeat('ab', 32), 'hex'), 'dv_AAAAAAAAAAAAAAAA')`, [sub]),
    ).rejects.toThrow(/device_limit_exceeded/);
  });

  it('stores an optional coarse device label and rejects anything else', async () => {
    const [c] = await generate(h, admin, { plan: '30d' });
    const ok = await h.app.inject({ method: 'POST', url: '/v1/activation/redeem', payload: { code: c!.code, deviceId: newDeviceId(), deviceLabel: 'Chrome · Windows' }, remoteAddress: nextIp() });
    expect(ok.statusCode).toBe(200);
    const bad = await h.app.inject({ method: 'POST', url: '/v1/activation/redeem', payload: { code: c!.code, deviceId: newDeviceId(), deviceLabel: '<script>' }, remoteAddress: nextIp() });
    expect(bad.statusCode).toBe(400);
    expect((await devices(c!.id)).json().devices[0]).toMatchObject({ label: 'Chrome · Windows', status: 'active' });
  });
});

describe('admin device management', () => {
  it('lists devices as "used / limit" with public ids only', async () => {
    const [c] = await generate(h, admin, { plan: '30d' });
    for (let i = 0; i < 3; i++) await redeem(h, c!.code);
    const res = (await devices(c!.id)).json();
    expect(res.code).toMatchObject({ deviceLimit: 5, devicesInUse: 3 });
    expect(res.devices).toHaveLength(3);
    for (const d of res.devices) {
      expect(d.id).toMatch(/^dv_[0-9A-Z]{16}$/);
      expect(Object.keys(d).sort()).toEqual(['activatedAt', 'id', 'label', 'lastSeenAt', 'removedAt', 'removedReason', 'status']);
    }
  });

  it('revoking one lost device frees its slot, kills its session, and never changes the expiry', async () => {
    const [c] = await generate(h, admin, { plan: '30d' });
    const devs: Awaited<ReturnType<typeof redeem>>[] = [];
    for (let i = 0; i < 5; i++) devs.push(await redeem(h, c!.code));
    const expiresAt = devs[0]!.body.subscription.expiresAt;
    h.clock.advance(3 * DAY);
    admin = await adminHeaders(h);
    expect((await redeem(h, c!.code)).body.error.code).toBe('DEVICE_LIMIT_REACHED');

    const list = (await devices(c!.id)).json().devices as Array<{ id: string; activatedAt: string }>;
    const target = list.find((d) => d.activatedAt === devs[2]!.body.subscription.activatedAt) ?? list[0]!;
    const res = await h.app.inject({ method: 'POST', url: `/v1/admin/codes/${c!.id}/devices/${target.id}/revoke`, headers: admin, payload: { reason: 'laptop stolen' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().code).toMatchObject({ devicesInUse: 4, expiresAt });
    expect(res.json().devices.find((d: { id: string }) => d.id === target.id)).toMatchObject({ status: 'removed', removedReason: 'admin_revoked' });

    // a replacement device can now join; the period is unchanged
    const replacement = await redeem(h, c!.code);
    expect(replacement.body).toMatchObject({ result: 'device_added', subscription: { devicesInUse: 5, expiresAt } });
    expect((await redeem(h, c!.code)).body.error.code).toBe('DEVICE_LIMIT_REACHED');
    const sub = await h.pool.query('SELECT expires_at FROM subscriptions');
    expect(new Date(sub.rows[0].expires_at).toISOString()).toBe(expiresAt);
    const ev = await h.pool.query("SELECT detail FROM security_events WHERE event_type = 'admin.device_revoked'");
    expect(ev.rows[0].detail).toMatchObject({ id: c!.id, device: target.id, reason: 'laptop stolen' });
  });

  it('the revoked device loses access immediately', async () => {
    const [c] = await generate(h, admin, { plan: '30d' });
    const d = await redeem(h, c!.code);
    const [dev] = (await devices(c!.id)).json().devices;
    await h.app.inject({ method: 'POST', url: `/v1/admin/codes/${c!.id}/devices/${dev.id}/revoke`, headers: admin, payload: { reason: 'replaced' } });
    const res = await h.app.inject({ method: 'GET', url: '/v1/subscription', headers: bearer(d.body.session.token) });
    expect(res.statusCode).toBe(401);
  });

  it('device operations require the service key AND an admin session; customers cannot call them', async () => {
    const [c] = await generate(h, admin, { plan: '30d' });
    const d = await redeem(h, c!.code);
    const [dev] = (await devices(c!.id)).json().devices;
    const url = `/v1/admin/codes/${c!.id}/devices/${dev.id}/revoke`;
    const payload = { reason: 'test reason' };
    expect((await h.app.inject({ method: 'POST', url, payload, headers: { authorization: admin.authorization! } })).statusCode).toBe(403);
    expect((await h.app.inject({ method: 'POST', url, payload, headers: serviceHeaders() })).statusCode).toBe(401);
    expect((await h.app.inject({ method: 'POST', url, payload, headers: { ...serviceHeaders(), ...bearer(d.body.session.token) } })).statusCode).toBe(401);
    expect((await h.app.inject({ method: 'POST', url, payload, headers: bearer(d.body.session.token) })).statusCode).toBe(403);
    expect((await h.app.inject({ method: 'GET', url: `/v1/admin/codes/${c!.id}/devices`, headers: serviceHeaders() })).statusCode).toBe(401);
    expect((await h.app.inject({ method: 'POST', url: `/v1/admin/codes/${c!.id}/devices/dv_ZZZZZZZZZZZZZZZZ/revoke`, headers: admin, payload })).statusCode).toBe(404);
    expect((await h.app.inject({ method: 'POST', url, headers: admin, payload: {} })).statusCode).toBe(400); // reason required
    expect(await activeSlots()).toBe(1);
  });

  it('changing one code\'s limit never goes below devices in use and never changes expiry', async () => {
    const [c] = await generate(h, admin, { plan: '365d', deviceLimit: 2 });
    const first = await redeem(h, c!.code);
    await redeem(h, c!.code);
    const lower = await h.app.inject({ method: 'POST', url: `/v1/admin/codes/${c!.id}/device-limit`, headers: admin, payload: { deviceLimit: 1, reason: 'too many' } });
    expect(lower.statusCode).toBe(400);
    const raise = await h.app.inject({ method: 'POST', url: `/v1/admin/codes/${c!.id}/device-limit`, headers: admin, payload: { deviceLimit: 5, reason: 'customer upgrade' } });
    expect(raise.json().code).toMatchObject({ deviceLimit: 5, devicesInUse: 2, expiresAt: first.body.subscription.expiresAt });
    expect((await h.app.inject({ method: 'POST', url: `/v1/admin/codes/${c!.id}/device-limit`, headers: admin, payload: { deviceLimit: 6, reason: 'x y z' } })).statusCode).toBe(400);
  });

  it('settings endpoint exposes the configured default', async () => {
    expect((await h.app.inject({ method: 'GET', url: '/v1/admin/settings', headers: admin })).json()).toEqual({ defaultDeviceLimit: 5, maxDeviceLimit: 5 });
  });

  it('DEFAULT_DEVICE_LIMIT is configurable for new codes', async () => {
    const h3 = await createHarness({ env: { DEFAULT_DEVICE_LIMIT: '3' } });
    try {
      const a3 = await adminHeaders(h3);
      const [c] = await generate(h3, a3, { plan: '30d' });
      expect(c!.deviceLimit).toBe(3);
    } finally {
      await h3.close();
    }
  });
});

describe('existing codes: explicit raise-device-limits policy', () => {
  it('dry run changes nothing; apply raises only lower, non-revoked codes; nothing else changes', async () => {
    const [one] = await generate(h, admin, { plan: '30d', deviceLimit: 1 });
    const [two] = await generate(h, admin, { plan: '365d', deviceLimit: 2 });
    const [five] = await generate(h, admin, { plan: '30d', deviceLimit: 5 });
    const [revoked] = await generate(h, admin, { plan: '30d', deviceLimit: 1 });
    const act = await redeem(h, one!.code);
    await h.app.inject({ method: 'POST', url: `/v1/admin/codes/${revoked!.id}/revoke`, headers: admin, payload: { reason: 'void' } });
    const before = (await h.pool.query('SELECT activated_at, expires_at FROM subscriptions')).rows;

    expect(await raiseDeviceLimits(h.pool, TEST_SECRETS.IP_HASH_PEPPER, 5, false)).toEqual({ codes: 2, apply: false });
    expect((await h.pool.query('SELECT count(*)::int AS n FROM activation_codes WHERE device_limit = 5')).rows[0].n).toBe(1);

    expect(await raiseDeviceLimits(h.pool, TEST_SECRETS.IP_HASH_PEPPER, 5, true)).toEqual({ codes: 2, apply: true });
    const limits = Object.fromEntries((await h.pool.query('SELECT public_id, device_limit FROM activation_codes')).rows.map((r) => [r.public_id, r.device_limit]));
    expect(limits).toEqual({ [one!.id]: 5, [two!.id]: 5, [five!.id]: 5, [revoked!.id]: 1 });
    expect((await h.pool.query('SELECT activated_at, expires_at FROM subscriptions')).rows).toEqual(before);
    // the already-activated device keeps working and more devices may now join
    expect((await h.app.inject({ method: 'GET', url: '/v1/subscription', headers: bearer(act.body.session.token) })).json().subscription).toMatchObject({ deviceLimit: 5, devicesInUse: 1 });
    expect((await redeem(h, one!.code)).body.result).toBe('device_added');
    expect(await raiseDeviceLimits(h.pool, TEST_SECRETS.IP_HASH_PEPPER, 3, true)).toEqual({ codes: 0, apply: true }); // never lowers
  });
});

describe('migration 0002 on an existing database', () => {
  it('backfills existing device slots and changes no limits, activations or expiry dates', async () => {
    const url = new URL(inject('databaseUrl'));
    const admin = createPool(url.toString(), 1);
    const dbName = 'aviator_migration_test';
    await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin.query(`CREATE DATABASE ${dbName}`);
    url.pathname = `/${dbName}`;
    const pool = createPool(url.toString(), 2);
    const onlyFirst = mkdtempSync(join(tmpdir(), 'mig-0001-'));
    try {
      copyFileSync(join(defaultMigrationsDir(), '0001_initial_schema.sql'), join(onlyFirst, '0001_initial_schema.sql'));
      await migrate(pool, onlyFirst);
      // legacy data written by the old schema (one active device on a 1-device code)
      await pool.query(`INSERT INTO activation_codes (public_id, code_hash, code_hint, plan, duration_days, device_limit, redeemed_at)
                        VALUES ('ac_LEGACY0000000001', decode(repeat('11', 32), 'hex'), 'ABCD', '30d', 30, 1, '2026-01-01T00:00:00Z')`);
      await pool.query(`INSERT INTO subscriptions (activation_code_id, plan, activated_at, expires_at)
                        VALUES (1, '30d', '2026-01-01T00:00:00Z', '2026-01-31T00:00:00Z')`);
      await pool.query(`INSERT INTO device_activations (subscription_id, device_hash) VALUES (1, decode(repeat('22', 32), 'hex'))`);

      expect(await migrate(pool)).toEqual(['0002_device_management.sql', '0003_device_scoped_analysis.sql', '0004_round_forecast_ledger.sql']);
      const r = await pool.query(`SELECT c.device_limit, s.activated_at, s.expires_at, d.public_id, d.deactivated_at
                                    FROM activation_codes c JOIN subscriptions s ON s.activation_code_id = c.id
                                    JOIN device_activations d ON d.subscription_id = s.id`);
      expect(r.rows[0].device_limit).toBe(1);
      expect(new Date(r.rows[0].activated_at).toISOString()).toBe('2026-01-01T00:00:00.000Z');
      expect(new Date(r.rows[0].expires_at).toISOString()).toBe('2026-01-31T00:00:00.000Z');
      expect(r.rows[0].public_id).toMatch(/^dv_[0-9A-Z]{16}$/);
      expect(r.rows[0].deactivated_at).toBeNull();
      expect(await migrate(pool)).toEqual([]); // idempotent
    } finally {
      await pool.end();
      rmSync(onlyFirst, { recursive: true, force: true });
      await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
      await admin.end();
    }
  });
});
