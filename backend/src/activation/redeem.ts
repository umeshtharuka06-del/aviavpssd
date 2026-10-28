import type { RedeemResponse } from '@aviator/contracts';
import { AppError } from '../api/errors.js';
import { issueCustomerSession } from '../auth/customer-session.js';
import type { AppContext } from '../context.js';
import { withTransaction, type Queryable } from '../database/pool.js';
import { hmacSha256, randomBase32 } from '../security/crypto.js';
import { recordSecurityEvent } from '../security/events.js';
import { computeExpiry, SUBSCRIPTION_COLUMNS, toSubscriptionView, type SubscriptionRow } from '../subscriptions/subscription.js';
import { hashCodeInput } from './codes.js';

export function hashDeviceId(pepper: string, deviceId: string): Buffer {
  return hmacSha256(pepper, `device:v1:${deviceId.toLowerCase()}`);
}

interface LockedCode {
  id: number;
  plan: '30d' | '365d';
  device_limit: number;
  redeem_by: Date | null;
  redeemed_at: Date | null;
  revoked_at: Date | null;
}

/**
 * Redeems an activation code for a device.
 *
 * Concurrency (three layers):
 *  - the code row is locked with SELECT … FOR UPDATE, so attempts on one code are serialized;
 *  - subscriptions.activation_code_id is UNIQUE (one subscription per code) and a partial UNIQUE
 *    index allows one ACTIVE slot per (subscription, device) — no duplicate device records;
 *  - a database trigger (migration 0002) refuses any active slot beyond device_limit.
 *
 * Rules:
 *  - First redemption starts the subscription now (server clock) for the plan's duration.
 *  - A redeemed code can never start a second subscription period or change its expiry.
 *  - Re-entering a redeemed code on the SAME device restores access (new session, same slot).
 *  - Re-entering it on ANOTHER device succeeds only while active devices < device_limit;
 *    otherwise DEVICE_LIMIT_REACHED. Freeing slots requires an audited admin action.
 */
export async function redeemCode(
  ctx: AppContext,
  input: { code: string; deviceId: string; deviceLabel?: string },
  ip: string | undefined,
): Promise<RedeemResponse> {
  const now = ctx.now();
  const codeHash = hashCodeInput(ctx.env.CODE_PEPPER, input.code);
  const deviceHash = hashDeviceId(ctx.env.DEVICE_PEPPER, input.deviceId);

  try {
    return await withTransaction(ctx.pool, async (db) => {
      if (!codeHash) throw new AppError('CODE_INVALID', 'This activation code is not valid.');
      const { rows } = await db.query<LockedCode>(
        `SELECT id, plan, device_limit, redeem_by, redeemed_at, revoked_at
           FROM activation_codes WHERE code_hash = $1 FOR UPDATE`,
        [codeHash],
      );
      const code = rows[0];
      if (!code) throw new AppError('CODE_INVALID', 'This activation code is not valid.');
      if (code.revoked_at) throw new AppError('CODE_REVOKED', 'This activation code has been revoked.');

      let result: RedeemResponse['result'];
      let subscriptionId: number;
      let deviceActivationId: number;

      if (!code.redeemed_at) {
        if (code.redeem_by && now.getTime() >= code.redeem_by.getTime()) {
          throw new AppError('CODE_EXPIRED', 'This activation code expired before it was used.', { reason: 'not_redeemed_in_time' });
        }
        const expiresAt = computeExpiry(code.plan, now);
        await db.query('UPDATE activation_codes SET redeemed_at = $2 WHERE id = $1', [code.id, now]);
        const sub = await db.query<{ id: number }>(
          `INSERT INTO subscriptions (activation_code_id, plan, activated_at, expires_at)
           VALUES ($1, $2, $3, $4) RETURNING id`,
          [code.id, code.plan, now, expiresAt],
        );
        subscriptionId = sub.rows[0]!.id;
        deviceActivationId = await insertDevice(db, subscriptionId, deviceHash, now, input.deviceLabel);
        result = 'activated';
      } else {
        const sub = await db.query<{ id: number; expires_at: Date; revoked_at: Date | null }>(
          'SELECT id, expires_at, revoked_at FROM subscriptions WHERE activation_code_id = $1 FOR UPDATE',
          [code.id],
        );
        const s = sub.rows[0];
        if (!s) throw new Error('redeemed code without subscription');
        if (s.revoked_at) throw new AppError('CODE_REVOKED', 'This activation code has been revoked.');
        if (now.getTime() >= s.expires_at.getTime()) {
          throw new AppError('CODE_EXPIRED', 'The subscription for this code has ended.', { reason: 'subscription_ended' });
        }
        subscriptionId = s.id;
        const existing = await db.query<{ id: number }>(
          `SELECT id FROM device_activations
            WHERE subscription_id = $1 AND device_hash = $2 AND deactivated_at IS NULL`,
          [s.id, deviceHash],
        );
        if (existing.rows[0]) {
          deviceActivationId = existing.rows[0].id;
          await db.query('UPDATE device_activations SET last_seen_at = $2, device_label = COALESCE($3, device_label) WHERE id = $1', [
            deviceActivationId,
            now,
            input.deviceLabel || null,
          ]);
          result = 'device_restored';
        } else {
          const active = await db.query<{ n: number }>(
            'SELECT count(*)::int AS n FROM device_activations WHERE subscription_id = $1 AND deactivated_at IS NULL',
            [s.id],
          );
          if (active.rows[0]!.n >= code.device_limit) throw deviceLimitError(code.device_limit, active.rows[0]!.n);
          deviceActivationId = await insertDevice(db, s.id, deviceHash, now, input.deviceLabel);
          result = 'device_added';
        }
      }

      const session = await issueCustomerSession(db, ctx, deviceActivationId, now);
      const view = await db.query<SubscriptionRow>(
        `SELECT ${SUBSCRIPTION_COLUMNS} FROM subscriptions sub
           JOIN activation_codes c ON c.id = sub.activation_code_id WHERE sub.id = $1`,
        [subscriptionId],
      );
      await recordSecurityEvent(db, ctx.env.IP_HASH_PEPPER, {
        type: 'customer.redeem_succeeded',
        ip,
        detail: { result, plan: code.plan },
      });
      return { result, session, subscription: toSubscriptionView(view.rows[0]!, now) };
    });
  } catch (caught) {
    // The database guard (trigger) is the last line of defence; report it like the app check.
    const err = (caught as { message?: string }).message === 'device_limit_exceeded' ? deviceLimitError() : caught;
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

function deviceLimitError(limit?: number, inUse?: number): AppError {
  const n = limit ?? 'all';
  return new AppError(
    'DEVICE_LIMIT_REACHED',
    `This subscription is already active on the maximum number of devices (${n}). Remove a device you no longer use (ask the administrator) and try again.`,
    { reason: 'device_limit_reached', ...(limit !== undefined ? { deviceLimit: limit, devicesInUse: inUse ?? limit } : {}) },
  );
}

async function insertDevice(db: Queryable, subscriptionId: number, deviceHash: Buffer, now: Date, label?: string) {
  const { rows } = await db.query<{ id: number }>(
    `INSERT INTO device_activations (subscription_id, device_hash, activated_at, last_seen_at, public_id, device_label)
     VALUES ($1, $2, $3, $3, $4, $5) RETURNING id`,
    [subscriptionId, deviceHash, now, `dv_${randomBase32(16)}`, label || null],
  );
  return rows[0]!.id;
}
