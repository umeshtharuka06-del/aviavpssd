import { z } from 'zod';
/** Coarse, user-recognisable device label ("Chrome · Windows"). Never a fingerprint. */
export declare const DeviceLabelSchema: z.ZodString;
export declare const RedeemRequestSchema: z.ZodObject<{
    code: z.ZodString;
    deviceId: z.ZodUUID;
    clientVersion: z.ZodOptional<z.ZodString>;
    deviceLabel: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
export type RedeemRequest = z.infer<typeof RedeemRequestSchema>;
export declare const SessionViewSchema: z.ZodObject<{
    token: z.ZodString;
    expiresAt: z.ZodISODateTime;
}, z.core.$strip>;
export type SessionView = z.infer<typeof SessionViewSchema>;
export declare const RedeemResponseSchema: z.ZodObject<{
    result: z.ZodEnum<{
        activated: "activated";
        device_added: "device_added";
        device_restored: "device_restored";
    }>;
    session: z.ZodObject<{
        token: z.ZodString;
        expiresAt: z.ZodISODateTime;
    }, z.core.$strip>;
    subscription: z.ZodObject<{
        plan: z.ZodEnum<{
            "30d": "30d";
            "365d": "365d";
        }>;
        status: z.ZodEnum<{
            active: "active";
            expired: "expired";
            revoked: "revoked";
        }>;
        activatedAt: z.ZodISODateTime;
        expiresAt: z.ZodISODateTime;
        deviceLimit: z.ZodNumber;
        devicesInUse: z.ZodNumber;
    }, z.core.$strip>;
}, z.core.$strip>;
export type RedeemResponse = z.infer<typeof RedeemResponseSchema>;
export declare const SubscriptionResponseSchema: z.ZodObject<{
    subscription: z.ZodObject<{
        plan: z.ZodEnum<{
            "30d": "30d";
            "365d": "365d";
        }>;
        status: z.ZodEnum<{
            active: "active";
            expired: "expired";
            revoked: "revoked";
        }>;
        activatedAt: z.ZodISODateTime;
        expiresAt: z.ZodISODateTime;
        deviceLimit: z.ZodNumber;
        devicesInUse: z.ZodNumber;
    }, z.core.$strip>;
    session: z.ZodObject<{
        expiresAt: z.ZodISODateTime;
    }, z.core.$strip>;
}, z.core.$strip>;
export type SubscriptionResponse = z.infer<typeof SubscriptionResponseSchema>;
export declare const RefreshRequestSchema: z.ZodObject<{
    deviceId: z.ZodUUID;
}, z.core.$strict>;
export type RefreshRequest = z.infer<typeof RefreshRequestSchema>;
export declare const RefreshResponseSchema: z.ZodObject<{
    session: z.ZodObject<{
        token: z.ZodString;
        expiresAt: z.ZodISODateTime;
    }, z.core.$strip>;
    subscription: z.ZodObject<{
        plan: z.ZodEnum<{
            "30d": "30d";
            "365d": "365d";
        }>;
        status: z.ZodEnum<{
            active: "active";
            expired: "expired";
            revoked: "revoked";
        }>;
        activatedAt: z.ZodISODateTime;
        expiresAt: z.ZodISODateTime;
        deviceLimit: z.ZodNumber;
        devicesInUse: z.ZodNumber;
    }, z.core.$strip>;
}, z.core.$strip>;
export type RefreshResponse = z.infer<typeof RefreshResponseSchema>;
export declare const ObservationSchema: z.ZodObject<{
    multiplier: z.ZodNumber;
    roundRef: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
export type Observation = z.infer<typeof ObservationSchema>;
export declare const HistoryIngestRequestSchema: z.ZodObject<{
    batchId: z.ZodUUID;
    siteId: z.ZodString;
    adapterVersion: z.ZodString;
    observations: z.ZodArray<z.ZodObject<{
        multiplier: z.ZodNumber;
        roundRef: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>>;
}, z.core.$strict>;
export type HistoryIngestRequest = z.infer<typeof HistoryIngestRequestSchema>;
export declare const HistoryIngestResponseSchema: z.ZodObject<{
    result: z.ZodEnum<{
        accepted: "accepted";
        duplicate_batch: "duplicate_batch";
    }>;
    accepted: z.ZodNumber;
    duplicates: z.ZodNumber;
}, z.core.$strip>;
export type HistoryIngestResponse = z.infer<typeof HistoryIngestResponseSchema>;
export declare const AnalysisRequestSchema: z.ZodObject<{
    siteId: z.ZodString;
}, z.core.$strict>;
export type AnalysisRequest = z.infer<typeof AnalysisRequestSchema>;
export declare const AnalysisItemSchema: z.ZodObject<{
    label: z.ZodString;
    value: z.ZodString;
}, z.core.$strip>;
export declare const AnalysisResponseSchema: z.ZodObject<{
    engine: z.ZodObject<{
        kind: z.ZodEnum<{
            mock: "mock";
            live: "live";
        }>;
        version: z.ZodString;
    }, z.core.$strip>;
    isTestData: z.ZodBoolean;
    status: z.ZodEnum<{
        ok: "ok";
        insufficient_data: "insufficient_data";
    }>;
    siteId: z.ZodString;
    generatedAt: z.ZodISODateTime;
    windowHours: z.ZodNumber;
    observationsConsidered: z.ZodNumber;
    items: z.ZodArray<z.ZodObject<{
        label: z.ZodString;
        value: z.ZodString;
    }, z.core.$strip>>;
    summary: z.ZodOptional<z.ZodObject<{
        scope: z.ZodLiteral<"device">;
        sampleSize: z.ZodNumber;
        minSampleSize: z.ZodNumber;
        sufficiency: z.ZodEnum<{
            no_data: "no_data";
            collecting: "collecting";
            sufficient: "sufficient";
        }>;
        thresholds: z.ZodArray<z.ZodObject<{
            threshold: z.ZodNumber;
            count: z.ZodNumber;
            frequency: z.ZodNullable<z.ZodNumber>;
        }, z.core.$strip>>;
        below2x: z.ZodObject<{
            threshold: z.ZodNumber;
            count: z.ZodNumber;
            frequency: z.ZodNullable<z.ZodNumber>;
        }, z.core.$strip>;
        averageMultiplier: z.ZodNullable<z.ZodNumber>;
        invalidExcluded: z.ZodNumber;
        latestRoundAt: z.ZodNullable<z.ZodISODateTime>;
        freshnessSeconds: z.ZodNullable<z.ZodNumber>;
        isHistoricalOnly: z.ZodLiteral<true>;
    }, z.core.$strip>>;
    notice: z.ZodString;
}, z.core.$strip>;
export type AnalysisResponse = z.infer<typeof AnalysisResponseSchema>;
