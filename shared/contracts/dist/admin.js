import { z } from 'zod';
import { IsoDateTimeSchema, PlanSchema } from './common.js';
import { MAX_CODES_PER_GENERATION, MAX_DEVICE_LIMIT } from './limits.js';
/*
 * Admin endpoints (/v1/admin/*) require BOTH:
 *   X-Admin-Service-Key: <shared secret held only by the admin site's server runtime>
 *   Authorization: Bearer <admin session token>          (except /auth/login)
 * They are never called from browser JavaScript.
 */
/* ---------- POST /v1/admin/auth/login ---------- */
export const AdminLoginRequestSchema = z.strictObject({
    email: z.email().max(254),
    password: z.string().min(1).max(256),
});
export const AdminLoginResponseSchema = z.object({
    token: z.string(),
    expiresAt: IsoDateTimeSchema,
    admin: z.object({ email: z.string() }),
});
export const AdminMeResponseSchema = z.object({
    admin: z.object({ email: z.string() }),
    session: z.object({ expiresAt: IsoDateTimeSchema }),
});
/* ---------- Codes ---------- */
/**
 * unused            — never redeemed, still redeemable
 * active            — redeemed, subscription running
 * expired           — subscription ended, or never redeemed before its redeem-by date
 * revoked           — revoked by an admin
 */
export const CodeStatusSchema = z.enum(['unused', 'active', 'expired', 'revoked']);
export const AdminCodeViewSchema = z.object({
    id: z.string(), // public id, e.g. "ac_8F3K..."; not the database key
    hint: z.string(), // last 4 characters only, e.g. "…7QK2"
    plan: PlanSchema,
    status: CodeStatusSchema,
    deviceLimit: z.number().int(),
    devicesInUse: z.number().int(),
    note: z.string().nullable(),
    createdAt: IsoDateTimeSchema,
    redeemBy: IsoDateTimeSchema.nullable(),
    redeemedAt: IsoDateTimeSchema.nullable(),
    expiresAt: IsoDateTimeSchema.nullable(),
    revokedAt: IsoDateTimeSchema.nullable(),
    revokeReason: z.string().nullable(),
});
/* POST /v1/admin/codes */
export const GenerateCodesRequestSchema = z.strictObject({
    plan: PlanSchema,
    quantity: z.number().int().min(1).max(MAX_CODES_PER_GENERATION).default(1),
    /** Omitted → the server's DEFAULT_DEVICE_LIMIT (5 unless configured lower). */
    deviceLimit: z.number().int().min(1).max(MAX_DEVICE_LIMIT).optional(),
    /** Days the code stays redeemable if never used; null = no redeem-by date. */
    redeemWithinDays: z.number().int().min(1).max(730).nullable().default(90),
    note: z.string().trim().max(200).optional(),
});
export const GeneratedCodeSchema = AdminCodeViewSchema.extend({
    /** Plaintext code. Returned ONLY in this response; the server stores a hash. */
    code: z.string(),
});
export const GenerateCodesResponseSchema = z.object({ codes: z.array(GeneratedCodeSchema) });
/* GET /v1/admin/codes */
export const ListCodesQuerySchema = z.strictObject({
    status: CodeStatusSchema.optional(),
    plan: PlanSchema.optional(),
    redeemed: z.enum(['true', 'false']).optional(),
    createdFrom: IsoDateTimeSchema.optional(),
    createdTo: IsoDateTimeSchema.optional(),
    /** Matches the public id prefix or the 4-char hint. Never a full code. */
    q: z.string().trim().max(40).optional(),
    page: z.coerce.number().int().min(1).max(10_000).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
export const ListCodesResponseSchema = z.object({
    items: z.array(AdminCodeViewSchema),
    total: z.number().int(),
    page: z.number().int(),
    pageSize: z.number().int(),
});
/* GET /v1/admin/codes/stats */
export const CodeStatsResponseSchema = z.object({
    total: z.number().int(),
    byStatus: z.record(CodeStatusSchema, z.number().int()),
    byPlan: z.record(PlanSchema, z.number().int()),
});
/* POST /v1/admin/codes/:id/revoke */
export const RevokeCodeRequestSchema = z.strictObject({
    reason: z.string().trim().min(3).max(200),
});
/* POST /v1/admin/codes/:id/reset-devices */
export const ResetDevicesRequestSchema = z.strictObject({
    reason: z.string().trim().min(3).max(200),
});
export const CodeResponseSchema = z.object({ code: AdminCodeViewSchema });
export const CodeIdSchema = z.string().regex(/^ac_[0-9A-Z]{16}$/);
/* GET /v1/admin/system/retention — monitoring of the 12-hour history deletion worker */
export const RetentionStatusResponseSchema = z.object({
    retentionHours: z.number().int(),
    worker: z.object({
        lastStartedAt: IsoDateTimeSchema.nullable(),
        lastSuccessAt: IsoDateTimeSchema.nullable(),
        lastError: z.string().nullable(),
        lastDeletedCount: z.number().int(),
        totalRuns: z.number().int(),
    }),
    observations: z.object({
        count: z.number().int(),
        oldestAgeSeconds: z.number().int().nullable(),
    }),
    /** true when the worker succeeded recently AND nothing older than retention + grace exists. */
    healthy: z.boolean(),
});
/* ---------- Devices of a code ---------- */
export const AdminDeviceViewSchema = z.object({
    id: z.string(), // public id "dv_…"; not the database key, not the device's own id
    label: z.string().nullable(),
    status: z.enum(['active', 'removed']),
    /** Why the slot was freed: admin_revoked (one device), admin_reset (all), code_revoked. */
    removedReason: z.enum(['admin_revoked', 'admin_reset', 'code_revoked']).nullable(),
    activatedAt: IsoDateTimeSchema,
    lastSeenAt: IsoDateTimeSchema,
    removedAt: IsoDateTimeSchema.nullable(),
});
/* GET /v1/admin/codes/:id/devices  and responses of device mutations */
export const CodeDevicesResponseSchema = z.object({
    code: AdminCodeViewSchema,
    devices: z.array(AdminDeviceViewSchema),
});
export const DeviceIdParamSchema = z.string().regex(/^dv_[0-9A-Z]{16}$/);
/* POST /v1/admin/codes/:id/devices/:deviceId/revoke */
export const RevokeDeviceRequestSchema = z.strictObject({
    reason: z.string().trim().min(3).max(200),
});
/* POST /v1/admin/codes/:id/device-limit  (never below the devices currently in use) */
export const SetDeviceLimitRequestSchema = z.strictObject({
    deviceLimit: z.number().int().min(1).max(MAX_DEVICE_LIMIT),
    reason: z.string().trim().min(3).max(200),
});
/* GET /v1/admin/settings */
export const AdminSettingsResponseSchema = z.object({
    defaultDeviceLimit: z.number().int(),
    maxDeviceLimit: z.number().int(),
});
