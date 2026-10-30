import {
  CODE_BODY_LENGTH,
  formatActivationCode,
  normalizeActivationCode,
  PLAN_DURATION_DAYS,
  type AdminCodeView,
  type CodeStatus,
  type Plan,
} from '@aviator/contracts';
import type { Queryable } from '../database/pool.js';
import { hmacSha256, randomBase32 } from '../security/crypto.js';

/** Hash stored in activation_codes.code_hash. Input must already be normalized. */
export function hashCode(pepper: string, normalizedBody: string): Buffer {
  return hmacSha256(pepper, `activation-code:v1:${normalizedBody}`);
}

/** Normalizes user input and hashes it, or returns null if it cannot be a valid code. */
export function hashCodeInput(pepper: string, input: string): Buffer | null {
  const body = normalizeActivationCode(input);
  return body ? hashCode(pepper, body) : null;
}

export interface NewCode {
  /** Plaintext, formatted. Shown once to the admin; never stored or logged. */
  plaintext: string;
  hash: Buffer;
  hint: string;
  publicId: string;
}

/** Generates a code with 100 bits of CSPRNG entropy. */
export function generateCode(pepper: string): NewCode {
  const body = randomBase32(CODE_BODY_LENGTH);
  return {
    plaintext: formatActivationCode(body),
    hash: hashCode(pepper, body),
    hint: body.slice(-4),
    publicId: `ac_${randomBase32(16)}`,
  };
}

export function durationDays(plan: Plan): number {
  return PLAN_DURATION_DAYS[plan];
}

/* ---------- admin view ---------- */

export interface CodeRow {
  public_id: string;
  code_hint: string;
  plan: Plan;
  device_limit: number;
  devices_in_use: number;
  note: string | null;
  created_at: Date;
  redeem_by: Date | null;
  redeemed_at: Date | null;
  expires_at: Date | null;
  revoked_at: Date | null;
  revoke_reason: string | null;
  status: CodeStatus;
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

export function toAdminCodeView(r: CodeRow): AdminCodeView {
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

export async function getCodeView(db: Queryable, publicId: string, now: Date): Promise<AdminCodeView | null> {
  const { rows } = await db.query<CodeRow>(`${CODE_VIEW_SQL} WHERE c.public_id = $2`, [now, publicId]);
  return rows[0] ? toAdminCodeView(rows[0]) : null;
}
