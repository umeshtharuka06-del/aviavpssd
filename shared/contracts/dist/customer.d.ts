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
    forecast: z.ZodOptional<z.ZodObject<{
        method: z.ZodLiteral<"walk_forward_v2">;
        status: z.ZodEnum<{
            insufficient_data: "insufficient_data";
            evaluated: "evaluated";
        }>;
        sampleSize: z.ZodNumber;
        minSampleSize: z.ZodNumber;
        trainInitial: z.ZodNumber;
        minTestRounds: z.ZodNumber;
        testRounds: z.ZodNumber;
        refitEvery: z.ZodNumber;
        segments: z.ZodNumber;
        gapSeconds: z.ZodNumber;
        comparisons: z.ZodNumber;
        alpha: z.ZodNumber;
        minEvents: z.ZodNumber;
        permutationMaxRounds: z.ZodNumber;
        thresholds: z.ZodArray<z.ZodObject<{
            threshold: z.ZodNumber;
            status: z.ZodEnum<{
                validated_model: "validated_model";
                no_predictive_value: "no_predictive_value";
                not_calibrated: "not_calibrated";
                validated_model_not_current: "validated_model_not_current";
                insufficient_events: "insufficient_events";
            }>;
            testEvents: z.ZodNumber;
            selectedModel: z.ZodNullable<z.ZodEnum<{
                base_rate: "base_rate";
                rtp_reference: "rtp_reference";
                rolling_50: "rolling_50";
                after_previous: "after_previous";
                since_last_hit: "since_last_hit";
                logistic_recent: "logistic_recent";
            }>>;
            probability: z.ZodNullable<z.ZodNumber>;
            low: z.ZodNullable<z.ZodNumber>;
            high: z.ZodNullable<z.ZodNumber>;
            models: z.ZodArray<z.ZodObject<{
                model: z.ZodEnum<{
                    base_rate: "base_rate";
                    rtp_reference: "rtp_reference";
                    rolling_50: "rolling_50";
                    after_previous: "after_previous";
                    since_last_hit: "since_last_hit";
                    logistic_recent: "logistic_recent";
                }>;
                usesRecentRounds: z.ZodBoolean;
                logLoss: z.ZodNumber;
                brier: z.ZodNumber;
                meanForecast: z.ZodNumber;
                observedRate: z.ZodNumber;
                calibrationZ: z.ZodNumber;
                calibrationP: z.ZodNullable<z.ZodNumber>;
                calibrated: z.ZodBoolean;
                skillVsBaseRate: z.ZodNullable<z.ZodNumber>;
                pValue: z.ZodNullable<z.ZodNumber>;
                permutationP: z.ZodNullable<z.ZodNumber>;
                validated: z.ZodBoolean;
            }, z.core.$strip>>;
        }, z.core.$strip>>;
    }, z.core.$strip>>;
    notice: z.ZodString;
}, z.core.$strip>;
export type AnalysisResponse = z.infer<typeof AnalysisResponseSchema>;
