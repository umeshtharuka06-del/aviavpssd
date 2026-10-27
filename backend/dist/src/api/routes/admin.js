import { AdminLoginRequestSchema, CodeIdSchema, DeviceIdParamSchema, MAX_DEVICE_LIMIT, RevokeDeviceRequestSchema, SetDeviceLimitRequestSchema, GenerateCodesRequestSchema, ListCodesQuerySchema, ResetDevicesRequestSchema, RevokeCodeRequestSchema, HISTORY_RETENTION_HOURS, } from '@aviator/contracts';
import { codeStats, generateCodes, listCodes, resetDevices, revokeCode } from '../../activation/admin-codes.js';
import { listDevices, revokeDevice, setDeviceLimit } from '../../activation/devices.js';
import { ADMIN_CLIENT_IP_HEADER, ADMIN_SERVICE_KEY_HEADER, adminClientIp, adminLogin, adminLogout, authenticateAdmin, verifyServiceKey, } from '../../auth/admin-auth.js';
import { retentionHealth } from '../../retention/purge.js';
import { AppError, parseOrThrow } from '../errors.js';
/**
 * Admin API. Every request must carry the server-to-server service key (held only by the
 * admin site's server runtime); every route except login additionally requires an admin
 * session. Customer tokens are never accepted here. CORS is not enabled anywhere — and CORS
 * is not relied on for authorization.
 */
export const adminRoutes = (ctx) => async (app) => {
    app.addHook('onRequest', async (req) => {
        verifyServiceKey(ctx, req.headers[ADMIN_SERVICE_KEY_HEADER]);
        req.adminIp = adminClientIp(req.headers[ADMIN_CLIENT_IP_HEADER], req.ip);
        if (req.routeOptions.url !== '/v1/admin/auth/login') {
            req.admin = await authenticateAdmin(ctx, req.headers.authorization);
        }
    });
    const adminKey = (req) => `admin:${req.adminIp ?? req.ip}`;
    const admin = (req) => req.admin;
    const ip = (req) => req.adminIp ?? req.ip;
    app.post('/auth/login', 
    // Keyed by the end user's IP (forwarded by the admin site after service-key check).
    { config: { rateLimit: { max: 5, timeWindow: '1 minute', keyGenerator: (req) => `login:${adminClientIp(req.headers[ADMIN_CLIENT_IP_HEADER], req.ip)}` } } }, async (req) => {
        const body = parseOrThrow(AdminLoginRequestSchema, req.body);
        return adminLogin(ctx, body, ip(req));
    });
    app.post('/auth/logout', async (req, reply) => {
        await adminLogout(ctx, admin(req), ip(req));
        return reply.status(204).send();
    });
    app.get('/me', async (req) => ({
        admin: { email: admin(req).email },
        session: { expiresAt: admin(req).sessionExpiresAt.toISOString() },
    }));
    app.post('/codes', { config: { rateLimit: { max: 20, timeWindow: '1 minute', keyGenerator: adminKey } } }, async (req) => {
        const body = parseOrThrow(GenerateCodesRequestSchema, req.body);
        return generateCodes(ctx, admin(req), body, ip(req));
    });
    app.get('/codes', async (req) => listCodes(ctx, parseOrThrow(ListCodesQuerySchema, req.query)));
    app.get('/codes/stats', async () => codeStats(ctx));
    app.post('/codes/:id/revoke', async (req) => {
        const id = parseId(req.params.id);
        const body = parseOrThrow(RevokeCodeRequestSchema, req.body);
        return { code: await revokeCode(ctx, admin(req), id, body.reason, ip(req)) };
    });
    app.post('/codes/:id/reset-devices', async (req) => {
        const id = parseId(req.params.id);
        const body = parseOrThrow(ResetDevicesRequestSchema, req.body);
        return { code: await resetDevices(ctx, admin(req), id, body.reason, ip(req)) };
    });
    app.get('/settings', async () => ({
        defaultDeviceLimit: ctx.env.DEFAULT_DEVICE_LIMIT,
        maxDeviceLimit: MAX_DEVICE_LIMIT,
    }));
    app.get('/codes/:id/devices', async (req) => listDevices(ctx, parseId(req.params.id)));
    app.post('/codes/:id/devices/:deviceId/revoke', async (req) => {
        const id = parseId(req.params.id);
        const device = DeviceIdParamSchema.safeParse(req.params.deviceId);
        if (!device.success)
            throw new AppError('NOT_FOUND', 'Device not found for this code.');
        const body = parseOrThrow(RevokeDeviceRequestSchema, req.body);
        return revokeDevice(ctx, admin(req), id, device.data, body.reason, ip(req));
    });
    app.post('/codes/:id/device-limit', async (req) => {
        const id = parseId(req.params.id);
        const body = parseOrThrow(SetDeviceLimitRequestSchema, req.body);
        return setDeviceLimit(ctx, admin(req), id, body.deviceLimit, body.reason, ip(req));
    });
    app.get('/system/retention', async () => {
        const h = await retentionHealth(ctx.pool, ctx.env.RETENTION_INTERVAL_SECONDS);
        return {
            retentionHours: HISTORY_RETENTION_HOURS,
            worker: {
                lastStartedAt: h.lastStartedAt?.toISOString() ?? null,
                lastSuccessAt: h.lastSuccessAt?.toISOString() ?? null,
                lastError: h.lastError,
                lastDeletedCount: h.lastDeletedCount,
                totalRuns: h.totalRuns,
            },
            observations: { count: h.observationCount, oldestAgeSeconds: h.oldestAgeSeconds },
            healthy: h.healthy,
        };
    });
};
function parseId(id) {
    const r = CodeIdSchema.safeParse(id);
    if (!r.success)
        throw new AppError('NOT_FOUND', 'Code not found.');
    return r.data;
}
