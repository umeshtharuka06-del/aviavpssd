import { PLAN_DURATION_DAYS } from '@aviator/contracts';
const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * Subscription end = activation instant + N × 24 h, in UTC. 30-day plans end exactly 30×24 h
 * after first activation, 365-day plans 365×24 h after (no calendar/DST arithmetic).
 */
export function computeExpiry(plan, activatedAt) {
    return new Date(activatedAt.getTime() + PLAN_DURATION_DAYS[plan] * DAY_MS);
}
export function subscriptionStatus(row, now) {
    if (row.revoked_at || row.code_revoked_at)
        return 'revoked';
    return now.getTime() < row.expires_at.getTime() ? 'active' : 'expired';
}
export function toSubscriptionView(row, now) {
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
