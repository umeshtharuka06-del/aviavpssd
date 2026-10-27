import { AppError } from '../api/errors.js';
import { newToken, sha256 } from '../security/crypto.js';
import { SUBSCRIPTION_COLUMNS, subscriptionStatus } from '../subscriptions/subscription.js';
/**
 * Issues a new opaque customer session for a device slot and revokes the device's previous
 * sessions (one live session per device). Expiry = min(now + TTL, subscription end).
 * Only the SHA-256 of the token is stored.
 */
export async function issueCustomerSession(db, ctx, deviceActivationId, now) {
    const token = newToken();
    const ttlEnd = new Date(now.getTime() + ctx.env.CUSTOMER_SESSION_TTL_HOURS * 3600_000);
    await db.query('UPDATE customer_sessions SET revoked_at = $2 WHERE device_activation_id = $1 AND revoked_at IS NULL', [deviceActivationId, now]);
    const { rows } = await db.query(`INSERT INTO customer_sessions (device_activation_id, token_hash, created_at, expires_at)
     SELECT d.id, $2, $3, LEAST($4::timestamptz, sub.expires_at)
       FROM device_activations d JOIN subscriptions sub ON sub.id = d.subscription_id
      WHERE d.id = $1
     RETURNING expires_at`, [deviceActivationId, sha256(token), now, ttlEnd]);
    return { token, expiresAt: rows[0].expires_at.toISOString() };
}
const BEARER_RE = /^Bearer ([A-Za-z0-9_-]{43})$/;
/**
 * Validates a customer bearer token entirely server-side. Subscription status and expiry
 * always come from the database — never from anything the client sends.
 *
 * Order matters for clear client states: an invalid/unknown token → SESSION_INVALID;
 * a revoked or ended subscription → SUBSCRIPTION_REVOKED / SUBSCRIPTION_EXPIRED (so the
 * extension can show the "expired" screen); otherwise an old session → SESSION_EXPIRED.
 */
export async function authenticateCustomer(ctx, authorization, opts = {}) {
    const m = authorization ? BEARER_RE.exec(authorization) : null;
    if (!m)
        throw new AppError('SESSION_INVALID', 'Missing or malformed session token.');
    const now = ctx.now();
    const { rows } = await ctx.pool.query(`SELECT s.id AS session_id, s.expires_at AS session_expires_at, s.revoked_at AS session_revoked_at,
            d.id AS device_activation_id, d.device_hash, d.deactivated_at, sub.id AS subscription_id,
            ${SUBSCRIPTION_COLUMNS}
       FROM customer_sessions s
       JOIN device_activations d ON d.id = s.device_activation_id
       JOIN subscriptions sub ON sub.id = d.subscription_id
       JOIN activation_codes c ON c.id = sub.activation_code_id
      WHERE s.token_hash = $1`, [sha256(m[1])]);
    const row = rows[0];
    if (!row || row.session_revoked_at || row.deactivated_at) {
        throw new AppError('SESSION_INVALID', 'This session is no longer valid. Please activate again.');
    }
    const status = subscriptionStatus(row, now);
    if (status === 'revoked')
        throw new AppError('SUBSCRIPTION_REVOKED', 'This subscription has been revoked.');
    if (status === 'expired') {
        throw new AppError('SUBSCRIPTION_EXPIRED', 'This subscription has expired.', { expiresAt: row.expires_at.toISOString() });
    }
    if (!opts.allowExpiredSession && now.getTime() >= row.session_expires_at.getTime()) {
        throw new AppError('SESSION_EXPIRED', 'Session expired. Please re-activate this device.');
    }
    // Touch last_seen_at at most every 5 minutes to avoid a write per request.
    await ctx.pool.query(`UPDATE device_activations SET last_seen_at = $2
      WHERE id = $1 AND last_seen_at < $2::timestamptz - interval '5 minutes'`, [row.device_activation_id, now]);
    return {
        sessionId: row.session_id,
        deviceActivationId: row.device_activation_id,
        deviceHash: row.device_hash,
        subscriptionId: row.subscription_id,
        sessionExpiresAt: row.session_expires_at,
        subscription: row,
    };
}
