import { hash, verify } from '@node-rs/argon2';
import { isIP } from 'node:net';
import type { AdminLoginResponse } from '@aviator/contracts';
import { AppError } from '../api/errors.js';
import type { AppContext } from '../context.js';
import { constantTimeEquals, newToken, sha256 } from '../security/crypto.js';
import { recordSecurityEvent } from '../security/events.js';

/** OWASP-recommended Argon2id parameters (19 MiB, t=2, p=1). Algorithm 2 = Argon2id. */
const ARGON2_OPTIONS = { algorithm: 2, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

const MAX_FAILED_LOGINS = 5;
const LOCKOUT_MINUTES = 15;

export async function hashPassword(password: string): Promise<string> {
  if (password.length < 12) throw new Error('Admin passwords must be at least 12 characters.');
  return hash(password, ARGON2_OPTIONS);
}

// Verified against when the email is unknown, so response time does not reveal valid emails.
let dummyHash: Promise<string> | undefined;
const getDummyHash = () => (dummyHash ??= hash('dummy-password-for-timing-only', ARGON2_OPTIONS));

/**
 * Header the admin site uses to send the end user's IP (all admin traffic arrives from
 * Vercel's IPs). Trusted only after the service key has been verified.
 */
export const ADMIN_CLIENT_IP_HEADER = 'x-admin-client-ip';
export const ADMIN_SERVICE_KEY_HEADER = 'x-admin-service-key';

/** First factor for every admin endpoint: the server-to-server key held only by the admin site's server. */
export function verifyServiceKey(ctx: AppContext, provided: string | string[] | undefined): void {
  if (typeof provided !== 'string' || !constantTimeEquals(provided, ctx.env.ADMIN_SERVICE_KEY)) {
    throw new AppError('ADMIN_FORBIDDEN', 'Forbidden.');
  }
}

export function adminClientIp(header: string | string[] | undefined, fallback: string): string {
  return typeof header === 'string' && isIP(header) ? header : fallback;
}

export async function adminLogin(
  ctx: AppContext,
  input: { email: string; password: string },
  ip: string,
): Promise<AdminLoginResponse> {
  const now = ctx.now();
  const email = input.email.trim().toLowerCase();
  const { rows } = await ctx.pool.query<{
    id: number;
    password_hash: string;
    is_active: boolean;
    failed_login_count: number;
    locked_until: Date | null;
  }>('SELECT id, password_hash, is_active, failed_login_count, locked_until FROM admin_users WHERE email = $1', [email]);
  const admin = rows[0];
  const generic = new AppError('ADMIN_UNAUTHORIZED', 'Invalid email or password, or the account is temporarily locked.');

  if (!admin || !admin.is_active) {
    await verify(await getDummyHash(), input.password).catch(() => false);
    await recordSecurityEvent(ctx.pool, ctx.env.IP_HASH_PEPPER, { type: 'admin.login_failed', ip, detail: { reason: 'unknown_or_inactive' } });
    throw generic;
  }
  if (admin.locked_until && admin.locked_until.getTime() > now.getTime()) {
    await recordSecurityEvent(ctx.pool, ctx.env.IP_HASH_PEPPER, { type: 'admin.login_failed', actor: `admin:${admin.id}`, ip, detail: { reason: 'locked' } });
    throw generic;
  }
  const ok = await verify(admin.password_hash, input.password).catch(() => false);
  if (!ok) {
    const failures = admin.failed_login_count + 1;
    const lock = failures >= MAX_FAILED_LOGINS;
    await ctx.pool.query('UPDATE admin_users SET failed_login_count = $2, locked_until = $3 WHERE id = $1', [
      admin.id,
      lock ? 0 : failures,
      lock ? new Date(now.getTime() + LOCKOUT_MINUTES * 60_000) : admin.locked_until,
    ]);
    await recordSecurityEvent(ctx.pool, ctx.env.IP_HASH_PEPPER, {
      type: lock ? 'admin.login_locked' : 'admin.login_failed',
      actor: `admin:${admin.id}`,
      ip,
      detail: { reason: 'bad_password' },
    });
    throw generic;
  }

  const token = newToken();
  const expiresAt = new Date(now.getTime() + ctx.env.ADMIN_SESSION_TTL_HOURS * 3600_000);
  await ctx.pool.query('UPDATE admin_users SET failed_login_count = 0, locked_until = NULL, last_login_at = $2 WHERE id = $1', [admin.id, now]);
  await ctx.pool.query(
    'INSERT INTO admin_sessions (admin_user_id, token_hash, created_at, expires_at, last_seen_at) VALUES ($1, $2, $3, $4, $3)',
    [admin.id, sha256(token), now, expiresAt],
  );
  await recordSecurityEvent(ctx.pool, ctx.env.IP_HASH_PEPPER, { type: 'admin.login_succeeded', actor: `admin:${admin.id}`, ip });
  return { token, expiresAt: expiresAt.toISOString(), admin: { email } };
}

export interface AdminAuth {
  adminId: number;
  email: string;
  sessionId: number;
  sessionExpiresAt: Date;
}

const BEARER_RE = /^Bearer ([A-Za-z0-9_-]{43})$/;

/** Second factor for admin endpoints: a valid, unexpired, unrevoked admin session. */
export async function authenticateAdmin(ctx: AppContext, authorization: string | undefined): Promise<AdminAuth> {
  const m = authorization ? BEARER_RE.exec(authorization) : null;
  if (!m) throw new AppError('ADMIN_UNAUTHORIZED', 'Admin session required.');
  const now = ctx.now();
  const { rows } = await ctx.pool.query<{ session_id: number; expires_at: Date; admin_id: number; email: string }>(
    `SELECT s.id AS session_id, s.expires_at, a.id AS admin_id, a.email
       FROM admin_sessions s JOIN admin_users a ON a.id = s.admin_user_id
      WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > $2 AND a.is_active`,
    [sha256(m[1]!), now],
  );
  const row = rows[0];
  if (!row) throw new AppError('ADMIN_UNAUTHORIZED', 'Admin session is invalid or expired.');
  await ctx.pool.query('UPDATE admin_sessions SET last_seen_at = $2 WHERE id = $1', [row.session_id, now]);
  return { adminId: row.admin_id, email: row.email, sessionId: row.session_id, sessionExpiresAt: row.expires_at };
}

export async function adminLogout(ctx: AppContext, auth: AdminAuth, ip: string): Promise<void> {
  await ctx.pool.query('UPDATE admin_sessions SET revoked_at = $2 WHERE id = $1', [auth.sessionId, ctx.now()]);
  await recordSecurityEvent(ctx.pool, ctx.env.IP_HASH_PEPPER, { type: 'admin.logout', actor: `admin:${auth.adminId}`, ip });
}
