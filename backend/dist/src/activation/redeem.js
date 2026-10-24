import { AppError } from '../api/errors.js';
import { issueCustomerSession } from '../auth/customer-session.js';
import { withTransaction } from '../database/pool.js';
import { hmacSha256 } from '../security/crypto.js';
import { recordSecurityEvent } from '../security/events.js';
import { computeExpiry, SUBSCRIPTION_COLUMNS, toSubscriptionView } from '../subscriptions/subscription.js';
import { hashCodeInput } from './codes.js';
export function hashDeviceId(pepper, deviceId) {
    return hmacSha256(pepper, `device:v1:${deviceId.toLowerCase()}`);
}
/**
 * Redeems an activation code for a device.
 *
 * Concurrency: the code row is locked with SELECT … FOR UPDATE, so concurrent attempts on the
 * same code are serialized. subscriptions.activation_code_id is UNIQUE (one subscription per
 * code) and device_activations has a partial UNIQUE index on (subscription, device) for
 * active slots, so even a logic error cannot create a second subscription or duplicate slot.
 *
 * Rules:
 *  - First redemption starts the subscription now (server clock) for the plan's duration.
 *  - A redeemed code can never start a second subscription period.
 *  - Re-entering a redeemed code on the SAME device restores access (new session).
 *  - Re-entering it on ANOTHER device succeeds only while active devices < device_limit;
 *    otherwise CODE_ALREADY_USED. Freeing slots requires an audited admin device reset.
 */
export async function redeemCode(ctx, input, ip) {
    const now = ctx.now();
    const codeHash = hashCodeInput(ctx.env.CODE_PEPPER, input.code);
    const deviceHash = hashDeviceId(ctx.env.DEVICE_PEPPER, input.deviceId);
    try {
        return await withTransaction(ctx.pool, async (db) => {
            if (!codeHash)
                throw new AppError('CODE_INVALID', 'This activation code is not valid.');
            const { rows } = await db.query(`SELECT id, plan, device_limit, redeem_by, redeemed_at, revoked_at
           FROM activation_codes WHERE code_hash = $1 FOR UPDATE`, [codeHash]);
            const code = rows[0];
            if (!code)
                throw new AppError('CODE_INVALID', 'This activation code is not valid.');
            if (code.revoked_at)
                throw new AppError('CODE_REVOKED', 'This activation code has been revoked.');
            let result;
            let subscriptionId;
            let deviceActivationId;
            if (!code.redeemed_at) {
                if (code.redeem_by && now.getTime() >= code.redeem_by.getTime()) {
                    throw new AppError('CODE_EXPIRED', 'This activation code expired before it was used.', { reason: 'not_redeemed_in_time' });
                }
                const expiresAt = computeExpiry(code.plan, now);
                await db.query('UPDATE activation_codes SET redeemed_at = $2 WHERE id = $1', [code.id, now]);
                const sub = await db.query(`INSERT INTO subscriptions (activation_code_id, plan, activated_at, expires_at)
           VALUES ($1, $2, $3, $4) RETURNING id`, [code.id, code.plan, now, expiresAt]);
                subscriptionId = sub.rows[0].id;
                deviceActivationId = await insertDevice(db, subscriptionId, deviceHash, now);
                result = 'activated';
            }
            else {
                const sub = await db.query('SELECT id, expires_at, revoked_at FROM subscriptions WHERE activation_code_id = $1 FOR UPDATE', [code.id]);
                const s = sub.rows[0];
                if (!s)
                    throw new Error('redeemed code without subscription');
                if (s.revoked_at)
                    throw new AppError('CODE_REVOKED', 'This activation code has been revoked.');
                if (now.getTime() >= s.expires_at.getTime()) {
                    throw new AppError('CODE_EXPIRED', 'The subscription for this code has ended.', { reason: 'subscription_ended' });
                }
                subscriptionId = s.id;
                const existing = await db.query(`SELECT id FROM device_activations
            WHERE subscription_id = $1 AND device_hash = $2 AND deactivated_at IS NULL`, [s.id, deviceHash]);
                if (existing.rows[0]) {
                    deviceActivationId = existing.rows[0].id;
                    await db.query('UPDATE device_activations SET last_seen_at = $2 WHERE id = $1', [deviceActivationId, now]);
                    result = 'device_restored';
                }
                else {
                    const active = await db.query('SELECT count(*)::int AS n FROM device_activations WHERE subscription_id = $1 AND deactivated_at IS NULL', [s.id]);
                    if (active.rows[0].n >= code.device_limit) {
                        throw new AppError('CODE_ALREADY_USED', 'This activation code is already in use on another device.', {
                            reason: 'device_limit_reached',
                            deviceLimit: code.device_limit,
                        });
                    }
                    deviceActivationId = await insertDevice(db, s.id, deviceHash, now);
                    result = 'device_added';
                }
            }
            const session = await issueCustomerSession(db, ctx, deviceActivationId, now);
            const view = await db.query(`SELECT ${SUBSCRIPTION_COLUMNS} FROM subscriptions sub
           JOIN activation_codes c ON c.id = sub.activation_code_id WHERE sub.id = $1`, [subscriptionId]);
            await recordSecurityEvent(db, ctx.env.IP_HASH_PEPPER, {
                type: 'customer.redeem_succeeded',
                ip,
                detail: { result, plan: code.plan },
            });
            return { result, session, subscription: toSubscriptionView(view.rows[0], now) };
        });
    }
    catch (err) {
        if (err instanceof AppError) {
            await recordSecurityEvent(ctx.pool, ctx.env.IP_HASH_PEPPER, {
                type: 'customer.redeem_failed',
                ip,
                detail: { code: err.code },
            }).catch(() => undefined);
        }
        throw err;
    }
}
async function insertDevice(db, subscriptionId, deviceHash, now) {
    const { rows } = await db.query(`INSERT INTO device_activations (subscription_id, device_hash, activated_at, last_seen_at)
     VALUES ($1, $2, $3, $3) RETURNING id`, [subscriptionId, deviceHash, now]);
    return rows[0].id;
}
