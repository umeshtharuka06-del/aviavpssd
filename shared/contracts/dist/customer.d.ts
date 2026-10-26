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
    metrics: z.ZodOptional<z.ZodObject<{
        scope: z.ZodLiteral<"device">;
        quality: z.ZodEnum<{
            ok: "ok";
            insufficient_data: "insufficient_data";
            stale: "stale";
        }>;
        totalRounds: z.ZodNumber;
        latestRoundAt: z.ZodNullable<z.ZodISODateTime>;
        freshnessSeconds: z.ZodNullable<z.ZodNumber>;
        stale: z.ZodBoolean;
        windows: z.ZodArray<z.ZodObject<{
            window: z.ZodUnion<readonly [z.ZodLiteral<50>, z.ZodLiteral<100>, z.ZodLiteral<250>, z.ZodLiteral<500>, z.ZodLiteral<"all">]>;
            requestedSize: z.ZodNullable<z.ZodNumber>;
            sampleSize: z.ZodNumber;
            complete: z.ZodBoolean;
            mean: z.ZodNullable<z.ZodNumber>;
            median: z.ZodNullable<z.ZodNumber>;
            min: z.ZodNullable<z.ZodNumber>;
            max: z.ZodNullable<z.ZodNumber>;
            thresholds: z.ZodArray<z.ZodObject<{
                threshold: z.ZodNumber;
                direction: z.ZodEnum<{
                    at_least: "at_least";
                    below: "below";
                }>;
                count: z.ZodNumber;
                total: z.ZodNumber;
                proportion: z.ZodNumber;
                ciLow: z.ZodNumber;
                ciHigh: z.ZodNumber;
            }, z.core.$strip>>;
        }, z.core.$strip>>;
    }, z.core.$strip>>;
    patterns: z.ZodOptional<z.ZodObject<{
        recentWindow: z.ZodUnion<readonly [z.ZodLiteral<50>, z.ZodLiteral<100>, z.ZodLiteral<250>, z.ZodLiteral<500>, z.ZodLiteral<"all">]>;
        baselineWindow: z.ZodUnion<readonly [z.ZodLiteral<50>, z.ZodLiteral<100>, z.ZodLiteral<250>, z.ZodLiteral<500>, z.ZodLiteral<"all">]>;
        comparisons: z.ZodArray<z.ZodObject<{
            threshold: z.ZodNumber;
            direction: z.ZodEnum<{
                at_least: "at_least";
                below: "below";
            }>;
            recent: z.ZodObject<{
                window: z.ZodUnion<readonly [z.ZodLiteral<50>, z.ZodLiteral<100>, z.ZodLiteral<250>, z.ZodLiteral<500>, z.ZodLiteral<"all">]>;
                count: z.ZodNumber;
                total: z.ZodNumber;
                proportion: z.ZodNumber;
                ciLow: z.ZodNumber;
                ciHigh: z.ZodNumber;
            }, z.core.$strip>;
            baseline: z.ZodObject<{
                window: z.ZodUnion<readonly [z.ZodLiteral<50>, z.ZodLiteral<100>, z.ZodLiteral<250>, z.ZodLiteral<500>, z.ZodLiteral<"all">]>;
                count: z.ZodNumber;
                total: z.ZodNumber;
                proportion: z.ZodNumber;
                ciLow: z.ZodNumber;
                ciHigh: z.ZodNumber;
            }, z.core.$strip>;
            delta: z.ZodNumber;
            ciOverlap: z.ZodBoolean;
        }, z.core.$strip>>;
        lowStreak: z.ZodObject<{
            threshold: z.ZodNumber;
            window: z.ZodUnion<readonly [z.ZodLiteral<50>, z.ZodLiteral<100>, z.ZodLiteral<250>, z.ZodLiteral<500>, z.ZodLiteral<"all">]>;
            sampleSize: z.ZodNumber;
            lowCount: z.ZodNumber;
            longestStreak: z.ZodNumber;
            currentStreak: z.ZodNumber;
            distribution: z.ZodArray<z.ZodObject<{
                length: z.ZodNumber;
                occurrences: z.ZodNumber;
            }, z.core.$strip>>;
        }, z.core.$strip>;
        highMultipliers: z.ZodObject<{
            threshold: z.ZodNumber;
            window: z.ZodUnion<readonly [z.ZodLiteral<50>, z.ZodLiteral<100>, z.ZodLiteral<250>, z.ZodLiteral<500>, z.ZodLiteral<"all">]>;
            count: z.ZodNumber;
            total: z.ZodNumber;
            buckets: z.ZodArray<z.ZodObject<{
                floor: z.ZodNumber;
                ceil: z.ZodNullable<z.ZodNumber>;
                count: z.ZodNumber;
                proportion: z.ZodNumber;
            }, z.core.$strip>>;
        }, z.core.$strip>;
        warnings: z.ZodArray<z.ZodString>;
    }, z.core.$strip>>;
    signal: z.ZodOptional<z.ZodObject<{
        status: z.ZodEnum<{
            ok: "ok";
            insufficient_data: "insufficient_data";
            stale: "stale";
        }>;
        scope: z.ZodObject<{
            kind: z.ZodLiteral<"device">;
            siteId: z.ZodString;
        }, z.core.$strip>;
        roundsAnalyzed: z.ZodNumber;
        windowSizes: z.ZodArray<z.ZodUnion<readonly [z.ZodLiteral<50>, z.ZodLiteral<100>, z.ZodLiteral<250>, z.ZodLiteral<500>, z.ZodLiteral<"all">]>>;
        classifications: z.ZodArray<z.ZodObject<{
            threshold: z.ZodNumber;
            direction: z.ZodEnum<{
                at_least: "at_least";
                below: "below";
            }>;
            classification: z.ZodEnum<{
                insufficient_data: "insufficient_data";
                elevated_vs_baseline: "elevated_vs_baseline";
                near_baseline: "near_baseline";
                reduced_vs_baseline: "reduced_vs_baseline";
                stale_or_unreliable: "stale_or_unreliable";
            }>;
            delta: z.ZodNumber;
            ciOverlap: z.ZodBoolean;
        }, z.core.$strip>>;
        freshnessSeconds: z.ZodNullable<z.ZodNumber>;
        limitations: z.ZodArray<z.ZodString>;
        isHistoricalOnly: z.ZodLiteral<true>;
    }, z.core.$strip>>;
    notice: z.ZodString;
}, z.core.$strip>;
export type AnalysisResponse = z.infer<typeof AnalysisResponseSchema>;
