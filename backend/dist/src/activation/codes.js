import { CODE_BODY_LENGTH, formatActivationCode, normalizeActivationCode, PLAN_DURATION_DAYS, } from '@aviator/contracts';
import { hmacSha256, randomBase32 } from '../security/crypto.js';
/** Hash stored in activation_codes.code_hash. Input must already be normalized. */
export function hashCode(pepper, normalizedBody) {
    return hmacSha256(pepper, `activation-code:v1:${normalizedBody}`);
}
/** Normalizes user input and hashes it, or returns null if it cannot be a valid code. */
export function hashCodeInput(pepper, input) {
    const body = normalizeActivationCode(input);
    return body ? hashCode(pepper, body) : null;
}
/** Generates a code with 100 bits of CSPRNG entropy. */
export function generateCode(pepper) {
    const body = randomBase32(CODE_BODY_LENGTH);
    return {
        plaintext: formatActivationCode(body),
        hash: hashCode(pepper, body),
        hint: body.slice(-4),
        publicId: `ac_${randomBase32(16)}`,
    };
}
export function durationDays(plan) {
    return PLAN_DURATION_DAYS[plan];
}
/**
 * Columns for an admin code view. `$1` must be the current time (timestamptz).
 * Status precedence: revoked > unused/expired (never redeemed) > active/expired (redeemed).
 */
export const CODE_VIEW_SQL = `
  SELECT c.public_id, c.code_hint, c.plan, c.device_limit, c.note, c.created_at, c.redeem_by,
         c.redeemed_at, sub.expires_at, c.revoked_at, c.revoke_reason,
         COALESCE((SELECT count(*)::int FROM device_activations d
                    WHERE d.subscription_id = sub.id AND d.deactivated_at IS NULL), 0) AS devices_in_use,
         CASE
           WHEN c.revoked_at IS NOT NULL OR sub.revoked_at IS NOT NULL THEN 'revoked'
           WHEN sub.id IS NULL AND (c.redeem_by IS NULL OR c.redeem_by > $1) THEN 'unused'
           WHEN sub.id IS NULL THEN 'expired'
           WHEN sub.expires_at > $1 THEN 'active'
           ELSE 'expired'
         END AS status
    FROM activation_codes c
    LEFT JOIN subscriptions sub ON sub.activation_code_id = c.id`;
export function toAdminCodeView(r) {
    return {
        id: r.public_id,
        hint: r.code_hint,
        plan: r.plan,
        status: r.status,
        deviceLimit: r.device_limit,
        devicesInUse: r.devices_in_use,
        note: r.note,
        createdAt: r.created_at.toISOString(),
        redeemBy: r.redeem_by?.toISOString() ?? null,
        redeemedAt: r.redeemed_at?.toISOString() ?? null,
        expiresAt: r.expires_at?.toISOString() ?? null,
        revokedAt: r.revoked_at?.toISOString() ?? null,
        revokeReason: r.revoke_reason,
    };
}
export async function getCodeView(db, publicId, now) {
    const { rows } = await db.query(`${CODE_VIEW_SQL} WHERE c.public_id = $2`, [now, publicId]);
    return rows[0] ? toAdminCodeView(rows[0]) : null;
}
