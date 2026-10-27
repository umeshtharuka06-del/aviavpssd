import { MAX_DEVICE_LIMIT } from '@aviator/contracts';
import { AppError } from '../api/errors.js';
import { withTransaction } from '../database/pool.js';
import { recordSecurityEvent } from '../security/events.js';
import { getCodeView } from './codes.js';
function toDeviceView(r) {
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
async function codeDevices(db, publicId, now) {
    const code = await getCodeView(db, publicId, now);
    if (!code)
        throw new AppError('NOT_FOUND', 'Code not found.');
    const { rows } = await db.query(`SELECT d.public_id, d.device_label, d.activated_at, d.last_seen_at, d.deactivated_at, d.deactivated_reason
       FROM device_activations d
       JOIN subscriptions sub ON sub.id = d.subscription_id
       JOIN activation_codes c ON c.id = sub.activation_code_id
      WHERE c.public_id = $1
      ORDER BY (d.deactivated_at IS NULL) DESC, d.activated_at DESC
      LIMIT 50`, [publicId]);
    return { code, devices: rows.map(toDeviceView) };
}
export function listDevices(ctx, publicId) {
    return codeDevices(ctx.pool, publicId, ctx.now());
}
/**
 * Removes ONE device (lost or replaced): its slot is freed and its sessions are revoked
 * immediately. The device can only come back by re-entering the code while a slot is free.
 */
export async function revokeDevice(ctx, admin, codeId, deviceId, reason, ip) {
    const now = ctx.now();
    return withTransaction(ctx.pool, async (db) => {
        const { rows } = await db.query(`SELECT d.id, d.deactivated_at
         FROM device_activations d
         JOIN subscriptions sub ON sub.id = d.subscription_id
         JOIN activation_codes c ON c.id = sub.activation_code_id
        WHERE c.public_id = $1 AND d.public_id = $2
        FOR UPDATE OF d`, [codeId, deviceId]);
        const device = rows[0];
        if (!device)
            throw new AppError('NOT_FOUND', 'Device not found for this code.');
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
export async function setDeviceLimit(ctx, admin, codeId, deviceLimit, reason, ip) {
    const now = ctx.now();
    return withTransaction(ctx.pool, async (db) => {
        const { rows } = await db.query('SELECT id, device_limit, revoked_at FROM activation_codes WHERE public_id = $1 FOR UPDATE', [codeId]);
        const code = rows[0];
        if (!code)
            throw new AppError('NOT_FOUND', 'Code not found.');
        if (code.revoked_at)
            throw new AppError('CODE_REVOKED', 'Revoked codes cannot be changed.');
        const used = await db.query(`SELECT count(*)::int AS n FROM device_activations d JOIN subscriptions sub ON sub.id = d.subscription_id
        WHERE sub.activation_code_id = $1 AND d.deactivated_at IS NULL`, [code.id]);
        const inUse = used.rows[0].n;
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
export async function raiseDeviceLimits(pool, ipPepper, to, apply) {
    if (!Number.isInteger(to) || to < 1 || to > MAX_DEVICE_LIMIT)
        throw new Error(`--to must be 1..${MAX_DEVICE_LIMIT}`);
    return withTransaction(pool, async (db) => {
        const { rows } = await db.query('SELECT public_id FROM activation_codes WHERE revoked_at IS NULL AND device_limit < $1 ORDER BY created_at FOR UPDATE', [to]);
        if (apply && rows.length) {
            await db.query('UPDATE activation_codes SET device_limit = $1 WHERE revoked_at IS NULL AND device_limit < $1', [to]);
            await recordSecurityEvent(db, ipPepper, { type: 'admin.device_limits_raised', actor: 'operator:cli', detail: { to, codes: rows.length } });
        }
        return { codes: rows.length, apply };
    });
}
