import { z } from 'zod';
export declare const AdminLoginRequestSchema: z.ZodObject<{
    email: z.ZodEmail;
    password: z.ZodString;
}, z.core.$strict>;
export type AdminLoginRequest = z.infer<typeof AdminLoginRequestSchema>;
export declare const AdminLoginResponseSchema: z.ZodObject<{
    token: z.ZodString;
    expiresAt: z.ZodISODateTime;
    admin: z.ZodObject<{
        email: z.ZodString;
    }, z.core.$strip>;
}, z.core.$strip>;
export type AdminLoginResponse = z.infer<typeof AdminLoginResponseSchema>;
export declare const AdminMeResponseSchema: z.ZodObject<{
    admin: z.ZodObject<{
        email: z.ZodString;
    }, z.core.$strip>;
    session: z.ZodObject<{
        expiresAt: z.ZodISODateTime;
    }, z.core.$strip>;
}, z.core.$strip>;
export type AdminMeResponse = z.infer<typeof AdminMeResponseSchema>;
/**
 * unused            — never redeemed, still redeemable
 * active            — redeemed, subscription running
 * expired           — subscription ended, or never redeemed before its redeem-by date
 * revoked           — revoked by an admin
 */
export declare const CodeStatusSchema: z.ZodEnum<{
    active: "active";
    expired: "expired";
    revoked: "revoked";
    unused: "unused";
}>;
export type CodeStatus = z.infer<typeof CodeStatusSchema>;
export declare const AdminCodeViewSchema: z.ZodObject<{
    id: z.ZodString;
    hint: z.ZodString;
    plan: z.ZodEnum<{
        "30d": "30d";
        "365d": "365d";
    }>;
    status: z.ZodEnum<{
        active: "active";
        expired: "expired";
        revoked: "revoked";
        unused: "unused";
    }>;
    deviceLimit: z.ZodNumber;
    devicesInUse: z.ZodNumber;
    note: z.ZodNullable<z.ZodString>;
    createdAt: z.ZodISODateTime;
    redeemBy: z.ZodNullable<z.ZodISODateTime>;
    redeemedAt: z.ZodNullable<z.ZodISODateTime>;
    expiresAt: z.ZodNullable<z.ZodISODateTime>;
    revokedAt: z.ZodNullable<z.ZodISODateTime>;
    revokeReason: z.ZodNullable<z.ZodString>;
}, z.core.$strip>;
export type AdminCodeView = z.infer<typeof AdminCodeViewSchema>;
export declare const GenerateCodesRequestSchema: z.ZodObject<{
    plan: z.ZodEnum<{
        "30d": "30d";
        "365d": "365d";
    }>;
    quantity: z.ZodDefault<z.ZodNumber>;
    deviceLimit: z.ZodOptional<z.ZodNumber>;
    redeemWithinDays: z.ZodDefault<z.ZodNullable<z.ZodNumber>>;
    note: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
export type GenerateCodesRequest = z.input<typeof GenerateCodesRequestSchema>;
export declare const GeneratedCodeSchema: z.ZodObject<{
    id: z.ZodString;
    hint: z.ZodString;
    plan: z.ZodEnum<{
        "30d": "30d";
        "365d": "365d";
    }>;
    status: z.ZodEnum<{
        active: "active";
        expired: "expired";
        revoked: "revoked";
        unused: "unused";
    }>;
    deviceLimit: z.ZodNumber;
    devicesInUse: z.ZodNumber;
    note: z.ZodNullable<z.ZodString>;
    createdAt: z.ZodISODateTime;
    redeemBy: z.ZodNullable<z.ZodISODateTime>;
    redeemedAt: z.ZodNullable<z.ZodISODateTime>;
    expiresAt: z.ZodNullable<z.ZodISODateTime>;
    revokedAt: z.ZodNullable<z.ZodISODateTime>;
    revokeReason: z.ZodNullable<z.ZodString>;
    code: z.ZodString;
}, z.core.$strip>;
export type GeneratedCode = z.infer<typeof GeneratedCodeSchema>;
export declare const GenerateCodesResponseSchema: z.ZodObject<{
    codes: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        hint: z.ZodString;
        plan: z.ZodEnum<{
            "30d": "30d";
            "365d": "365d";
        }>;
        status: z.ZodEnum<{
            active: "active";
            expired: "expired";
            revoked: "revoked";
            unused: "unused";
        }>;
        deviceLimit: z.ZodNumber;
        devicesInUse: z.ZodNumber;
        note: z.ZodNullable<z.ZodString>;
        createdAt: z.ZodISODateTime;
        redeemBy: z.ZodNullable<z.ZodISODateTime>;
        redeemedAt: z.ZodNullable<z.ZodISODateTime>;
        expiresAt: z.ZodNullable<z.ZodISODateTime>;
        revokedAt: z.ZodNullable<z.ZodISODateTime>;
        revokeReason: z.ZodNullable<z.ZodString>;
        code: z.ZodString;
    }, z.core.$strip>>;
}, z.core.$strip>;
export type GenerateCodesResponse = z.infer<typeof GenerateCodesResponseSchema>;
export declare const ListCodesQuerySchema: z.ZodObject<{
    status: z.ZodOptional<z.ZodEnum<{
        active: "active";
        expired: "expired";
        revoked: "revoked";
        unused: "unused";
    }>>;
    plan: z.ZodOptional<z.ZodEnum<{
        "30d": "30d";
        "365d": "365d";
    }>>;
    redeemed: z.ZodOptional<z.ZodEnum<{
        true: "true";
        false: "false";
    }>>;
    createdFrom: z.ZodOptional<z.ZodISODateTime>;
    createdTo: z.ZodOptional<z.ZodISODateTime>;
    q: z.ZodOptional<z.ZodString>;
    page: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
    pageSize: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
}, z.core.$strict>;
export type ListCodesQuery = z.input<typeof ListCodesQuerySchema>;
export declare const ListCodesResponseSchema: z.ZodObject<{
    items: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        hint: z.ZodString;
        plan: z.ZodEnum<{
            "30d": "30d";
            "365d": "365d";
        }>;
        status: z.ZodEnum<{
            active: "active";
            expired: "expired";
            revoked: "revoked";
            unused: "unused";
        }>;
        deviceLimit: z.ZodNumber;
        devicesInUse: z.ZodNumber;
        note: z.ZodNullable<z.ZodString>;
        createdAt: z.ZodISODateTime;
        redeemBy: z.ZodNullable<z.ZodISODateTime>;
        redeemedAt: z.ZodNullable<z.ZodISODateTime>;
        expiresAt: z.ZodNullable<z.ZodISODateTime>;
        revokedAt: z.ZodNullable<z.ZodISODateTime>;
        revokeReason: z.ZodNullable<z.ZodString>;
    }, z.core.$strip>>;
    total: z.ZodNumber;
    page: z.ZodNumber;
    pageSize: z.ZodNumber;
}, z.core.$strip>;
export type ListCodesResponse = z.infer<typeof ListCodesResponseSchema>;
export declare const CodeStatsResponseSchema: z.ZodObject<{
    total: z.ZodNumber;
    byStatus: z.ZodRecord<z.ZodEnum<{
        active: "active";
        expired: "expired";
        revoked: "revoked";
        unused: "unused";
    }>, z.ZodNumber>;
    byPlan: z.ZodRecord<z.ZodEnum<{
        "30d": "30d";
        "365d": "365d";
    }>, z.ZodNumber>;
}, z.core.$strip>;
export type CodeStatsResponse = z.infer<typeof CodeStatsResponseSchema>;
export declare const RevokeCodeRequestSchema: z.ZodObject<{
    reason: z.ZodString;
}, z.core.$strict>;
export type RevokeCodeRequest = z.infer<typeof RevokeCodeRequestSchema>;
export declare const ResetDevicesRequestSchema: z.ZodObject<{
    reason: z.ZodString;
}, z.core.$strict>;
export type ResetDevicesRequest = z.infer<typeof ResetDevicesRequestSchema>;
export declare const CodeResponseSchema: z.ZodObject<{
    code: z.ZodObject<{
        id: z.ZodString;
        hint: z.ZodString;
        plan: z.ZodEnum<{
            "30d": "30d";
            "365d": "365d";
        }>;
        status: z.ZodEnum<{
            active: "active";
            expired: "expired";
            revoked: "revoked";
            unused: "unused";
        }>;
        deviceLimit: z.ZodNumber;
        devicesInUse: z.ZodNumber;
        note: z.ZodNullable<z.ZodString>;
        createdAt: z.ZodISODateTime;
        redeemBy: z.ZodNullable<z.ZodISODateTime>;
        redeemedAt: z.ZodNullable<z.ZodISODateTime>;
        expiresAt: z.ZodNullable<z.ZodISODateTime>;
        revokedAt: z.ZodNullable<z.ZodISODateTime>;
        revokeReason: z.ZodNullable<z.ZodString>;
    }, z.core.$strip>;
}, z.core.$strip>;
export type CodeResponse = z.infer<typeof CodeResponseSchema>;
export declare const CodeIdSchema: z.ZodString;
export declare const RetentionStatusResponseSchema: z.ZodObject<{
    retentionHours: z.ZodNumber;
    worker: z.ZodObject<{
        lastStartedAt: z.ZodNullable<z.ZodISODateTime>;
        lastSuccessAt: z.ZodNullable<z.ZodISODateTime>;
        lastError: z.ZodNullable<z.ZodString>;
        lastDeletedCount: z.ZodNumber;
        totalRuns: z.ZodNumber;
    }, z.core.$strip>;
    observations: z.ZodObject<{
        count: z.ZodNumber;
        oldestAgeSeconds: z.ZodNullable<z.ZodNumber>;
    }, z.core.$strip>;
    healthy: z.ZodBoolean;
}, z.core.$strip>;
export type RetentionStatusResponse = z.infer<typeof RetentionStatusResponseSchema>;
export declare const AdminDeviceViewSchema: z.ZodObject<{
    id: z.ZodString;
    label: z.ZodNullable<z.ZodString>;
    status: z.ZodEnum<{
        active: "active";
        removed: "removed";
    }>;
    removedReason: z.ZodNullable<z.ZodEnum<{
        admin_revoked: "admin_revoked";
        admin_reset: "admin_reset";
        code_revoked: "code_revoked";
    }>>;
    activatedAt: z.ZodISODateTime;
    lastSeenAt: z.ZodISODateTime;
    removedAt: z.ZodNullable<z.ZodISODateTime>;
}, z.core.$strip>;
export type AdminDeviceView = z.infer<typeof AdminDeviceViewSchema>;
export declare const CodeDevicesResponseSchema: z.ZodObject<{
    code: z.ZodObject<{
        id: z.ZodString;
        hint: z.ZodString;
        plan: z.ZodEnum<{
            "30d": "30d";
            "365d": "365d";
        }>;
        status: z.ZodEnum<{
            active: "active";
            expired: "expired";
            revoked: "revoked";
            unused: "unused";
        }>;
        deviceLimit: z.ZodNumber;
        devicesInUse: z.ZodNumber;
        note: z.ZodNullable<z.ZodString>;
        createdAt: z.ZodISODateTime;
        redeemBy: z.ZodNullable<z.ZodISODateTime>;
        redeemedAt: z.ZodNullable<z.ZodISODateTime>;
        expiresAt: z.ZodNullable<z.ZodISODateTime>;
        revokedAt: z.ZodNullable<z.ZodISODateTime>;
        revokeReason: z.ZodNullable<z.ZodString>;
    }, z.core.$strip>;
    devices: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        label: z.ZodNullable<z.ZodString>;
        status: z.ZodEnum<{
            active: "active";
            removed: "removed";
        }>;
        removedReason: z.ZodNullable<z.ZodEnum<{
            admin_revoked: "admin_revoked";
            admin_reset: "admin_reset";
            code_revoked: "code_revoked";
        }>>;
        activatedAt: z.ZodISODateTime;
        lastSeenAt: z.ZodISODateTime;
        removedAt: z.ZodNullable<z.ZodISODateTime>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export type CodeDevicesResponse = z.infer<typeof CodeDevicesResponseSchema>;
export declare const DeviceIdParamSchema: z.ZodString;
export declare const RevokeDeviceRequestSchema: z.ZodObject<{
    reason: z.ZodString;
}, z.core.$strict>;
export type RevokeDeviceRequest = z.infer<typeof RevokeDeviceRequestSchema>;
export declare const SetDeviceLimitRequestSchema: z.ZodObject<{
    deviceLimit: z.ZodNumber;
    reason: z.ZodString;
}, z.core.$strict>;
export type SetDeviceLimitRequest = z.infer<typeof SetDeviceLimitRequestSchema>;
export declare const AdminSettingsResponseSchema: z.ZodObject<{
    defaultDeviceLimit: z.ZodNumber;
    maxDeviceLimit: z.ZodNumber;
}, z.core.$strip>;
export type AdminSettingsResponse = z.infer<typeof AdminSettingsResponseSchema>;
