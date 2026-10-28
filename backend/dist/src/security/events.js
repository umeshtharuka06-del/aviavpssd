import { hmacSha256 } from './crypto.js';
/**
 * Records a security/audit event. `detail` must never contain plaintext codes, tokens,
 * passwords, device ids or game history — only public ids, plans, counts and error codes.
 */
export async function recordSecurityEvent(db, ipPepper, event) {
    await db.query('INSERT INTO security_events (event_type, actor, ip_hash, detail) VALUES ($1, $2, $3, $4)', [
        event.type,
        event.actor ?? null,
        event.ip ? hmacSha256(ipPepper, event.ip) : null,
        JSON.stringify(event.detail ?? {}),
    ]);
}
