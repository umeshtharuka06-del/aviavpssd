import { AnalysisRequestSchema, HistoryIngestRequestSchema, RedeemRequestSchema, RefreshRequestSchema, } from '@aviator/contracts';
import { hashDeviceId, redeemCode } from '../../activation/redeem.js';
import { authenticateCustomer, issueCustomerSession } from '../../auth/customer-session.js';
import { withTransaction } from '../../database/pool.js';
import { runAnalysis } from '../../engine/analysis-service.js';
import { ingestHistory } from '../../ingestion/history.js';
import { constantTimeEquals, sha256 } from '../../security/crypto.js';
import { recordSecurityEvent } from '../../security/events.js';
import { toSubscriptionView } from '../../subscriptions/subscription.js';
import { AppError, parseOrThrow } from '../errors.js';
const REFRESH_GRACE_MS = 30 * 24 * 3600_000;
/** Rate-limit key for authenticated routes: a hash of the bearer token (falls back to IP). */
const sessionKey = (req) => req.headers.authorization ? `s:${sha256(req.headers.authorization).toString('base64url')}` : `ip:${req.ip}`;
export const customerRoutes = (ctx) => async (app) => {
    /* Activation-code redemption. Codes carry 100 bits of entropy; the limit is defence in depth. */
    app.post('/activation/redeem', { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } }, async (req) => {
        const body = parseOrThrow(RedeemRequestSchema, req.body);
        return redeemCode(ctx, body, req.ip);
    });
    app.get('/subscription', { config: { rateLimit: { max: 60, timeWindow: '1 minute', keyGenerator: sessionKey } } }, async (req) => {
        const auth = await authenticateCustomer(ctx, req.headers.authorization);
        return {
            subscription: toSubscriptionView(auth.subscription, ctx.now()),
            session: { expiresAt: auth.sessionExpiresAt.toISOString() },
        };
    });
    /*
     * Session rotation. Requires the device id that the session is bound to. Allowed up to 30
     * days after session expiry (but never after the subscription ends) so a browser that was
     * closed for a week does not need the code again.
     */
    app.post('/session/refresh', { config: { rateLimit: { max: 10, timeWindow: '10 minutes', keyGenerator: sessionKey } } }, async (req) => {
        const body = parseOrThrow(RefreshRequestSchema, req.body);
        const auth = await authenticateCustomer(ctx, req.headers.authorization, { allowExpiredSession: true });
        const now = ctx.now();
        if (now.getTime() > auth.sessionExpiresAt.getTime() + REFRESH_GRACE_MS) {
            throw new AppError('SESSION_EXPIRED', 'Session expired. Please re-activate this device.');
        }
        const presented = hashDeviceId(ctx.env.DEVICE_PEPPER, body.deviceId);
        if (!constantTimeEquals(presented.toString('hex'), auth.deviceHash.toString('hex'))) {
            await recordSecurityEvent(ctx.pool, ctx.env.IP_HASH_PEPPER, { type: 'customer.device_mismatch', ip: req.ip });
            throw new AppError('DEVICE_MISMATCH', 'This session belongs to a different device.');
        }
        const session = await withTransaction(ctx.pool, (db) => issueCustomerSession(db, ctx, auth.deviceActivationId, now));
        return { session, subscription: toSubscriptionView(auth.subscription, now) };
    });
    /* Sign out this device's session. The device slot stays assigned. */
    app.post('/session/logout', { config: { rateLimit: { max: 10, timeWindow: '1 minute', keyGenerator: sessionKey } } }, async (req, reply) => {
        const auth = await authenticateCustomer(ctx, req.headers.authorization, { allowExpiredSession: true });
        await ctx.pool.query('UPDATE customer_sessions SET revoked_at = $2 WHERE id = $1', [auth.sessionId, ctx.now()]);
        return reply.status(204).send();
    });
    app.post('/history', { config: { rateLimit: { max: 60, timeWindow: '1 minute', keyGenerator: sessionKey } } }, async (req) => {
        const auth = await authenticateCustomer(ctx, req.headers.authorization);
        const body = parseOrThrow(HistoryIngestRequestSchema, req.body);
        return ingestHistory(ctx, auth, body);
    });
    app.post('/analysis', { config: { rateLimit: { max: 30, timeWindow: '1 minute', keyGenerator: sessionKey } } }, async (req) => {
        const auth = await authenticateCustomer(ctx, req.headers.authorization);
        const body = parseOrThrow(AnalysisRequestSchema, req.body);
        // Analysis is scoped to the authenticated device, never to a client-supplied id.
        return runAnalysis(ctx, body.siteId, auth.deviceActivationId);
    });
};
