import type { Queryable } from '../database/pool.js';
import { hmacSha256 } from './crypto.js';

export type SecurityEventType =
  | 'admin.login_succeeded'
  | 'admin.login_failed'
  | 'admin.login_locked'
  | 'admin.logout'
  | 'admin.code_generated'
  | 'admin.code_revoked'
  | 'admin.devices_reset'
  | 'admin.device_revoked'
  | 'admin.device_limit_changed'
  | 'admin.device_limits_raised'
  | 'admin.rounds_exported'
  | 'customer.redeem_succeeded'
  | 'customer.redeem_failed'
  | 'customer.device_mismatch';

/**
 * Records a security/audit event. `detail` must never contain plaintext codes, tokens,
 * passwords, device ids or game history — only public ids, plans, counts and error codes.
 */
export async function recordSecurityEvent(
  db: Queryable,
  ipPepper: string,
  event: { type: SecurityEventType; actor?: string; ip?: string; detail?: Record<string, unknown> },
): Promise<void> {
  await db.query('INSERT INTO security_events (event_type, actor, ip_hash, detail) VALUES ($1, $2, $3, $4)', [
    event.type,
    event.actor ?? null,
    event.ip ? hmacSha256(ipPepper, event.ip) : null,
    JSON.stringify(event.detail ?? {}),
  ]);
}
