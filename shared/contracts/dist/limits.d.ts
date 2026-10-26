/** Shared, public limits. Changing these is an API contract change. */
/** API version prefix for every route. */
export declare const API_VERSION: "v1";
/** Temporary game-history observations expire this long after the server receives them. */
export declare const HISTORY_RETENTION_HOURS: 12;
/** Maximum observations in one ingestion request. */
export declare const MAX_OBSERVATIONS_PER_BATCH = 50;
/** Maximum JSON body size (bytes) the API accepts on customer endpoints. */
export declare const MAX_CUSTOMER_BODY_BYTES: number;
/** Multiplier bounds accepted at ingestion (inclusive). */
export declare const MIN_MULTIPLIER = 1;
export declare const MAX_MULTIPLIER = 1000000;
/** Plans and their durations in days. Duration starts at first successful activation. */
export declare const PLAN_DURATION_DAYS: {
    readonly '30d': 30;
    readonly '365d': 365;
};
/** Admin generation limits. */
export declare const MAX_CODES_PER_GENERATION = 20;
/** Hard ceiling of active devices per subscription (also enforced by the database). */
export declare const MAX_DEVICE_LIMIT = 5;
/** Default device limit for NEW codes (the server's DEFAULT_DEVICE_LIMIT may lower it). */
export declare const DEFAULT_DEVICE_LIMIT = 5;
