import { GenerateCodesRequestSchema, ListCodesQuerySchema, } from '@aviator/contracts';
import { AppError } from '../api/errors.js';
import { withTransaction } from '../database/pool.js';
import { recordSecurityEvent } from '../security/events.js';
import { CODE_VIEW_SQL, durationDays, generateCode, getCodeView, toAdminCodeView } from './codes.js';
/**
 * Generates codes. The plaintext appears ONLY in the returned object; the database receives
 * the HMAC hash, a 4-char hint and a random public id. Callers must not log the result.
 */
export async function generateCodes(ctx, admin, input, ip) {
    const now = ctx.now();
    const redeemBy = input.redeemWithinDays ? new Date(now.getTime() + input.redeemWithinDays * 86_400_000) : null;
    return withTransaction(ctx.pool, async (db) => {
        const codes = [];
        for (let i = 0; i < input.quantity; i++) {
            const c = generateCode(ctx.env.CODE_PEPPER);
            await db.query(`INSERT INTO activation_codes
           (public_id, code_hash, code_hint, plan, duration_days, device_limit, redeem_by, note, created_at, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`, [c.publicId, c.hash, c.hint, input.plan, durationDays(input.plan), input.deviceLimit, redeemBy, input.note || null, now, admin.adminId]);
            const view = (await getCodeView(db, c.publicId, now));
            codes.push({ ...view, code: c.plaintext });
        }
        await recordSecurityEvent(db, ctx.env.IP_HASH_PEPPER, {
            type: 'admin.code_generated',
            actor: `admin:${admin.adminId}`,
            ip,
            detail: { plan: input.plan, quantity: input.quantity, ids: codes.map((c) => c.id) },
        });
        return { codes };
    });
}
export async function listCodes(ctx, q) {
    const params = [ctx.now()];
    const where = [];
    const add = (sql, value) => {
        params.push(value);
        where.push(sql.replace('?', `$${params.length}`));
    };
    if (q.status)
        add('v.status = ?', q.status);
    if (q.plan)
        add('v.plan = ?', q.plan);
    if (q.redeemed === 'true')
        where.push('v.redeemed_at IS NOT NULL');
    if (q.redeemed === 'false')
        where.push('v.redeemed_at IS NULL');
    if (q.createdFrom)
        add('v.created_at >= ?', new Date(q.createdFrom));
    if (q.createdTo)
        add('v.created_at <= ?', new Date(q.createdTo));
    if (q.q) {
        const term = q.q.toUpperCase();
        if (/^AC_[0-9A-Z]{1,16}$/.test(term))
            add('v.public_id LIKE ?', `ac_${term.slice(3)}%`);
        else if (/^[0-9A-Z]{4}$/.test(term))
            add('v.code_hint = ?', term);
        else
            where.push('false'); // never search by anything resembling a full code via a URL
    }
    const filter = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const base = `WITH v AS (${CODE_VIEW_SQL}) SELECT * FROM v ${filter}`;
    const total = await ctx.pool.query(`SELECT count(*)::int AS n FROM (${base}) t`, params);
    const offset = (q.page - 1) * q.pageSize;
    const page = await ctx.pool.query(`${base} ORDER BY v.created_at DESC, v.public_id LIMIT ${q.pageSize} OFFSET ${offset}`, params);
    return { items: page.rows.map(toAdminCodeView), total: total.rows[0].n, page: q.page, pageSize: q.pageSize };
}
export async function codeStats(ctx) {
    const { rows } = await ctx.pool.query(`WITH v AS (${CODE_VIEW_SQL}) SELECT status, plan, count(*)::int AS n FROM v GROUP BY status, plan`, [ctx.now()]);
    const byStatus = { unused: 0, active: 0, expired: 0, revoked: 0 };
    const byPlan = { '30d': 0, '365d': 0 };
    let total = 0;
    for (const r of rows) {
        byStatus[r.status] += r.n;
        byPlan[r.plan] += r.n;
        total += r.n;
    }
    return { total, byStatus, byPlan };
}
/**
 * Revokes a code. If it was redeemed, the subscription is revoked too, every device slot is
 * deactivated and every customer session is revoked. Idempotent.
 */
export async function revokeCode(ctx, admin, publicId, reason, ip) {
    const now = ctx.now();
    return withTransaction(ctx.pool, async (db) => {
        const { rows } = await db.query('SELECT id, revoked_at FROM activation_codes WHERE public_id = $1 FOR UPDATE', [publicId]);
        const code = rows[0];
        if (!code)
            throw new AppError('NOT_FOUND', 'Code not found.');
        if (!code.revoked_at) {
            await db.query('UPDATE activation_codes SET revoked_at = $2, revoked_by = $3, revoke_reason = $4 WHERE id = $1', [code.id, now, admin.adminId, reason]);
            await db.query('UPDATE subscriptions SET revoked_at = $2 WHERE activation_code_id = $1 AND revoked_at IS NULL', [code.id, now]);
            await deactivateDevices(db, code.id, now, 'code_revoked');
            await recordSecurityEvent(db, ctx.env.IP_HASH_PEPPER, {
                type: 'admin.code_revoked',
                actor: `admin:${admin.adminId}`,
                ip,
                detail: { id: publicId },
            });
        }
        return (await getCodeView(db, publicId, now));
    });
}
/**
 * Device reset: frees every device slot of a redeemed code (e.g. the customer replaced their
 * computer). The subscription period is NOT extended or restarted. The customer re-enters the
 * code on the new device. Every reset is recorded as a security event with the admin and reason,
 * so repeated resets (code sharing) are visible.
 */
export async function resetDevices(ctx, admin, publicId, reason, ip) {
    const now = ctx.now();
    return withTransaction(ctx.pool, async (db) => {
        const { rows } = await db.query('SELECT id, redeemed_at, revoked_at FROM activation_codes WHERE public_id = $1 FOR UPDATE', [publicId]);
        const code = rows[0];
        if (!code)
            throw new AppError('NOT_FOUND', 'Code not found.');
        if (code.revoked_at)
            throw new AppError('CODE_REVOKED', 'Revoked codes cannot be reset.');
        if (!code.redeemed_at)
            throw new AppError('VALIDATION_FAILED', 'This code has not been redeemed; there are no devices to reset.');
        const count = await deactivateDevices(db, code.id, now, 'admin_reset');
        await recordSecurityEvent(db, ctx.env.IP_HASH_PEPPER, {
            type: 'admin.devices_reset',
            actor: `admin:${admin.adminId}`,
            ip,
            detail: { id: publicId, devicesReset: count, reason },
        });
        return (await getCodeView(db, publicId, now));
    });
}
async function deactivateDevices(db, codeId, now, reason) {
    const devices = await db.query(`UPDATE device_activations d SET deactivated_at = $2, deactivated_reason = $3
       FROM subscriptions sub
      WHERE sub.id = d.subscription_id AND sub.activation_code_id = $1 AND d.deactivated_at IS NULL
      RETURNING d.id`, [codeId, now, reason]);
    const ids = devices.rows.map((r) => r.id);
    if (ids.length) {
        await db.query('UPDATE customer_sessions SET revoked_at = $2 WHERE device_activation_id = ANY($1) AND revoked_at IS NULL', [ids, now]);
    }
    return ids.length;
}
