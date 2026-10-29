import { z } from 'zod';

/**
 * Every error response has this shape:
 *   { "error": { "code": "...", "message": "...", "requestId": "...", "details"?: {...} } }
 * `code` is stable and machine-readable; `message` is human-readable and may change.
 */
export const ERROR_CODES = [
  // generic
  'VALIDATION_FAILED',
  'PAYLOAD_TOO_LARGE',
  'UNSUPPORTED_MEDIA_TYPE',
  'NOT_FOUND',
  'RATE_LIMITED',
  'INTERNAL_ERROR',
  'SERVICE_UNAVAILABLE',
  // activation codes
  'CODE_INVALID',
  'CODE_EXPIRED',
  'CODE_REVOKED',
  'CODE_ALREADY_USED',
  'DEVICE_LIMIT_REACHED',
  // customer session / subscription
  'SESSION_INVALID',
  'SESSION_EXPIRED',
  'DEVICE_MISMATCH',
  'SUBSCRIPTION_EXPIRED',
  'SUBSCRIPTION_REVOKED',
  // admin
  'ADMIN_UNAUTHORIZED',
  'ADMIN_FORBIDDEN',
  // analysis
  'ANALYSIS_UNAVAILABLE',
] as const;

export const ErrorCodeSchema = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export const ErrorBodySchema = z.object({
  error: z.object({
    code: ErrorCodeSchema,
    message: z.string(),
    requestId: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
});
export type ErrorBody = z.infer<typeof ErrorBodySchema>;
