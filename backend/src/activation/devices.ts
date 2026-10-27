import { MAX_DEVICE_LIMIT, type AdminDeviceView, type CodeDevicesResponse } from '@aviator/contracts';
import { AppError } from '../api/errors.js';
import type { AdminAuth } from '../auth/admin-auth.js';
import type { AppContext } from '../context.js';
import { withTransaction, type Pool, type Queryable } from '../database/pool.js';
import { recordSecurityEvent } from '../security/events.js';
import { getCodeView } from './codes.js';

/*
 * Admin device management. Nothing here changes a subscription's activation or expiry date:
 * it only frees device slots or changes how many slots a code allows.
 */

interface DeviceRow {
  public_id: string;
  device_label: string | null;
  activated_at: Date;
  last_seen_at: Date;
  deactivated_at: Date | null;
  deactivated_reason: AdminDeviceView['removedReason'];
}

function toDeviceView(r: DeviceRow): AdminDeviceView {
  return {
    id: r.public_id,
    label: r.device_label,
    status: r.deactivated_at ? 'removed' : 'active',
    removedReason: r.deactivated_reason,
    activatedAt: r.activated_at.toISOString(),
    lastSeenAt: r.last_seen_at.toISOString(),
    removedAt: r.deactivated_at?.toISOString() ?? null,
  };
}

async function codeDevices(db: Queryable, publicId: string, now: Date): Promise<CodeDevicesResponse> {
  const code = await getCodeView(db, publicId, now);
  if (!code) throw new AppError('NOT_FOUND', 'Code not found.');
  const { rows } = await db.query<DeviceRow>(
    `SELECT d.public_id, d.device_label, d.activated_at, d.last_seen_at, d.deactivated_at, d.deactivated_reason
       FROM device_activations d
       JOIN subscriptions sub ON sub.id = d.subscription_id
       JOIN activation_codes c ON c.id = sub.activation_code_id
      WHERE c.public_id = $1
      ORDER BY (d.deactivated_at IS NULL) DESC, d.activated_at DESC
      LIMIT 50`,
    [publicId],
  );
  return { code, devices: rows.map(toDeviceView) };
}

export function listDevices(ctx: AppContext, publicId: string): Promise<CodeDevicesResponse> {
  return codeDevices(ctx.pool, publicId, ctx.now());
}

/**
 * Removes ONE device (lost or replaced): its slot is freed and its sessions are revoked
 * immediately. The device can only come back by re-entering the code while a slot is free.
 */
export async function revokeDevice(ctx: AppContext, admin: AdminAuth, codeId: string, deviceId: string, reason: string, ip: string): Promise<CodeDevicesResponse> {
  const now = ctx.now();
  return withTransaction(ctx.pool, async (db) => {
    const { rows } = await db.query<{ id: number; deactivated_at: Date | null }>(
      `SELECT d.id, d.deactivated_at
         FROM device_activations d
         JOIN subscriptions sub ON sub.id = d.subscription_id
         JOIN activation_codes c ON c.id = sub.activation_code_id
        WHERE c.public_id = $1 AND d.public_id = $2
        FOR UPDATE OF d`,
      [codeId, deviceId],
    );
    const device = rows[0];
    if (!device) throw new AppError('NOT_FOUND', 'Device not found for this code.');
    if (!device.deactivated_at) {
      await db.query(`UPDATE device_activations SET deactivated_at = $2, deactivated_reason = 'admin_revoked' WHERE id = $1`, [device.id, now]);
      await db.query('UPDATE customer_sessions SET revoked_at = $2 WHERE device_activation_id = $1 AND revoked_at IS NULL', [device.id, now]);
      await recordSecurityEvent(db, ctx.env.IP_HASH_PEPPER, {
        type: 'admin.device_revoked',
        actor: `admin:${admin.adminId}`,
        ip,
        detail: { id: codeId, device: deviceId, reason },
      });
    }
    return codeDevices(db, codeId, now);
  });
}

/** Changes one code's device limit. Never below the devices currently in use. */
export async function setDeviceLimit(ctx: AppContext, admin: AdminAuth, codeId: string, deviceLimit: number, reason: string, ip: string): Promise<CodeDevicesResponse> {
  const now = ctx.now();
  return withTransaction(ctx.pool, async (db) => {
    const { rows } = await db.query<{ id: number; device_limit: number; revoked_at: Date | null }>(
      'SELECT id, device_limit, revoked_at FROM activation_codes WHERE public_id = $1 FOR UPDATE',
      [codeId],
    );
    const code = rows[0];
    if (!code) throw new AppError('NOT_FOUND', 'Code not found.');
    if (code.revoked_at) throw new AppError('CODE_REVOKED', 'Revoked codes cannot be changed.');
    const used = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM device_activations d JOIN subscriptions sub ON sub.id = d.subscription_id
        WHERE sub.activation_code_id = $1 AND d.deactivated_at IS NULL`,
      [code.id],
    );
    const inUse = used.rows[0]!.n;
    if (deviceLimit < inUse) {
      throw new AppError('VALIDATION_FAILED', `${inUse} devices are in use; remove devices before lowering the limit below ${inUse}.`, {
        issues: [{ path: 'deviceLimit', message: 'below devices in use' }],
      });
    }
    if (deviceLimit !== code.device_limit) {
      await db.query('UPDATE activation_codes SET device_limit = $2 WHERE id = $1', [code.id, deviceLimit]);
      await recordSecurityEvent(db, ctx.env.IP_HASH_PEPPER, {
        type: 'admin.device_limit_changed',
        actor: `admin:${admin.adminId}`,
        ip,
        detail: { id: codeId, from: code.device_limit, to: deviceLimit, reason },
      });
    }
    return codeDevices(db, codeId, now);
  });
}

/**
 * Explicit, operator-run policy for EXISTING codes (CLI `raise-device-limits`): raises the
 * device limit of non-revoked codes whose limit is lower than `to`. Never lowers a limit, never
 * touches activations, subscriptions or expiry dates. Dry run unless `apply` is true.
 */
export async function raiseDeviceLimits(pool: Pool, ipPepper: string, to: number, apply: boolean): Promise<{ codes: number; apply: boolean }> {
  if (!Number.isInteger(to) || to < 1 || to > MAX_DEVICE_LIMIT) throw new Error(`--to must be 1..${MAX_DEVICE_LIMIT}`);
  return withTransaction(pool, async (db) => {
    const { rows } = await db.query<{ public_id: string }>(
      'SELECT public_id FROM activation_codes WHERE revoked_at IS NULL AND device_limit < $1 ORDER BY created_at FOR UPDATE',
      [to],
    );
    if (apply && rows.length) {
      await db.query('UPDATE activation_codes SET device_limit = $1 WHERE revoked_at IS NULL AND device_limit < $1', [to]);
      await recordSecurityEvent(db, ipPepper, { type: 'admin.device_limits_raised', actor: 'operator:cli', detail: { to, codes: rows.length } });
    }
    return { codes: rows.length, apply };
  });
}
