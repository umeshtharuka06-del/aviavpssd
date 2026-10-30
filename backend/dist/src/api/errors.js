const STATUS = {
    VALIDATION_FAILED: 400,
    PAYLOAD_TOO_LARGE: 413,
    UNSUPPORTED_MEDIA_TYPE: 415,
    NOT_FOUND: 404,
    RATE_LIMITED: 429,
    INTERNAL_ERROR: 500,
    SERVICE_UNAVAILABLE: 503,
    CODE_INVALID: 404,
    CODE_EXPIRED: 410,
    CODE_REVOKED: 410,
    CODE_ALREADY_USED: 409,
    DEVICE_LIMIT_REACHED: 409,
    SESSION_INVALID: 401,
    SESSION_EXPIRED: 401,
    DEVICE_MISMATCH: 401,
    SUBSCRIPTION_EXPIRED: 403,
    SUBSCRIPTION_REVOKED: 403,
    ADMIN_UNAUTHORIZED: 401,
    ADMIN_FORBIDDEN: 403,
    ANALYSIS_UNAVAILABLE: 503,
};
/** An expected, client-facing error. Its message is safe to return to the caller. */
export class AppError extends Error {
    code;
    details;
    cause;
    status;
    constructor(code, message, details, 
    /** Internal cause of a 5xx; written to the server log (errorFacts), never to the response. */
    cause) {
        super(message);
        this.code = code;
        this.details = details;
        this.cause = cause;
        this.status = STATUS[code];
    }
}
/**
 * Validates untrusted input. On failure, reports field paths and rules only;
 * submitted values are never echoed back or logged.
 */
export function parseOrThrow(schema, data) {
    const result = schema.safeParse(data);
    if (!result.success) {
        throw new AppError('VALIDATION_FAILED', 'Request validation failed.', {
            issues: result.error.issues.slice(0, 20).map((i) => ({ path: i.path.join('.'), message: i.message })),
        });
    }
    return result.data;
}
