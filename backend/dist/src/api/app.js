import { randomUUID } from 'node:crypto';
import { errorFacts, FAILURE_MESSAGE, failureCause } from '../diagnostics.js';
import rateLimit from '@fastify/rate-limit';
import { MAX_CUSTOMER_BODY_BYTES } from '@aviator/contracts';
import Fastify, {} from 'fastify';
import { parseTrustProxy } from '../config/env.js';
import { AppError } from './errors.js';
import { adminRoutes } from './routes/admin.js';
import { customerRoutes } from './routes/customer.js';
import { healthRoutes } from './routes/health.js';
export const API_VERSION_STRING = '0.1.0';
export async function buildApp(ctx, opts = {}) {
    const app = Fastify({
        // Fastify accepts a hop count at runtime; its overloaded typings do not.
        trustProxy: parseTrustProxy(ctx.env.TRUST_PROXY),
        bodyLimit: MAX_CUSTOMER_BODY_BYTES,
        genReqId: () => randomUUID(),
        requestIdHeader: false, // never trust a client-supplied request id
        logger: opts.logger === false
            ? false
            : {
                level: ctx.env.LOG_LEVEL,
                ...(opts.logStream ? { stream: opts.logStream } : {}),
                // Log method + route pattern only: never query strings, bodies, tokens or codes.
                serializers: {
                    req: (req) => ({ id: req.id, method: req.method, route: req.routeOptions?.url ?? 'unmatched' }),
                    res: (res) => ({ statusCode: res.statusCode }),
                },
                redact: ['req.headers.authorization', 'req.headers["x-admin-service-key"]'],
            },
    });
    // JSON only. Removing text/plain makes any other content type a 415.
    app.removeContentTypeParser('text/plain');
    app.addHook('onSend', async (request, reply) => {
        reply.header('x-request-id', request.id);
        reply.header('cache-control', 'no-store');
        reply.header('x-content-type-options', 'nosniff');
        reply.header('referrer-policy', 'no-referrer');
    });
    await app.register(rateLimit, {
        global: true,
        // preHandler: runs after the admin service-key/session hooks, so unauthenticated callers
        // cannot consume (or spoof the key of) the admin login budget.
        hook: 'preHandler',
        max: 120,
        timeWindow: '1 minute',
        // Respond through the standard error shape.
        errorResponseBuilder: (_req, context) => {
            const err = new AppError('RATE_LIMITED', 'Too many requests. Please slow down.', { retryAfterSeconds: Math.ceil(context.ttl / 1000) });
            err.statusCode = 429;
            return err;
        },
    });
    app.setErrorHandler((caught, request, reply) => {
        const error = caught;
        const send = (status, code, message, details) => reply.status(status).send({ error: { code, message, requestId: request.id, ...(details ? { details } : {}) } });
        const where = { method: request.method, route: request.routeOptions?.url ?? 'unknown' };
        if (error instanceof AppError) {
            if (error.code === 'RATE_LIMITED')
                return send(429, error.code, error.message, error.details);
            if (error.status >= 500 && error.cause !== undefined)
                request.log.error({ ...where, appCode: error.code, cause: errorFacts(error.cause) }, 'request failed');
            return send(error.status, error.code, error.message, error.details);
        }
        const e = error;
        switch (e.code) {
            case 'FST_ERR_CTP_BODY_TOO_LARGE':
                return send(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large.');
            case 'FST_ERR_CTP_INVALID_MEDIA_TYPE':
                return send(415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json.');
            case 'FST_ERR_CTP_EMPTY_JSON_BODY':
            case 'FST_ERR_CTP_INVALID_JSON_BODY':
                return send(400, 'VALIDATION_FAILED', 'Request body is not valid JSON.');
        }
        if (error instanceof SyntaxError || e.statusCode === 400)
            return send(400, 'VALIDATION_FAILED', 'Malformed request.');
        request.log.error({ ...where, err: errorFacts(error) }, 'unhandled error');
        // A missing migration or an unreachable database is an outage, not a bug in the request: say
        // so (503, fixed wording, no schema names) so clients retry and the panel can show the cause.
        const cause = failureCause(error);
        if (cause === 'database_schema_outdated' || cause === 'database_unavailable')
            return send(503, 'SERVICE_UNAVAILABLE', FAILURE_MESSAGE[cause], { cause });
        return send(500, 'INTERNAL_ERROR', 'An internal error occurred.');
    });
    app.setNotFoundHandler((request, reply) => {
        reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Not found.', requestId: request.id } });
    });
    await app.register(healthRoutes(ctx), { prefix: '/v1' });
    await app.register(customerRoutes(ctx), { prefix: '/v1' });
    await app.register(adminRoutes(ctx), { prefix: '/v1/admin' });
    return app;
}
