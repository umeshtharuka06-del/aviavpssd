import { PLAN_DURATION_DAYS, type Plan, type SubscriptionStatus, type SubscriptionView } from '@aviator/contracts';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Subscription end = activation instant + N × 24 h, in UTC. 30-day plans end exactly 30×24 h
 * after first activation, 365-day plans 365×24 h after (no calendar/DST arithmetic).
 */
export function computeExpiry(plan: Plan, activatedAt: Date): Date {
  return new Date(activatedAt.getTime() + PLAN_DURATION_DAYS[plan] * DAY_MS);
}

export interface SubscriptionRow {
  plan: Plan;
  activated_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
  code_revoked_at: Date | null;
  device_limit: number;
  devices_in_use: number;
}

export function subscriptionStatus(row: Pick<SubscriptionRow, 'expires_at' | 'revoked_at' | 'code_revoked_at'>, now: Date): SubscriptionStatus {
  if (row.revoked_at || row.code_revoked_at) return 'revoked';
  return now.getTime() < row.expires_at.getTime() ? 'active' : 'expired';
}

export function toSubscriptionView(row: SubscriptionRow, now: Date): SubscriptionView {
  return {
    plan: row.plan,
    status: subscriptionStatus(row, now),
    activatedAt: row.activated_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    deviceLimit: row.device_limit,
    devicesInUse: row.devices_in_use,
  };
}

/** SQL fragment returning SubscriptionRow columns for alias `sub` joined to code alias `c`. */
export const SUBSCRIPTION_COLUMNS = `
  sub.plan, sub.activated_at, sub.expires_at, sub.revoked_at,
  c.revoked_at AS code_revoked_at, c.device_limit,
  (SELECT count(*)::int FROM device_activations d2
     WHERE d2.subscription_id = sub.id AND d2.deactivated_at IS NULL) AS devices_in_use`;
