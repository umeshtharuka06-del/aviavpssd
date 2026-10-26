/** Shared, public limits. Changing these is an API contract change. */

/** API version prefix for every route. */
export const API_VERSION = 'v1' as const;

/** Temporary game-history observations expire this long after the server receives them. */
export const HISTORY_RETENTION_HOURS = 12 as const;

/** Maximum observations in one ingestion request. */
export const MAX_OBSERVATIONS_PER_BATCH = 50;

/** Maximum JSON body size (bytes) the API accepts on customer endpoints. */
export const MAX_CUSTOMER_BODY_BYTES = 8 * 1024;

/** Multiplier bounds accepted at ingestion (inclusive). */
export const MIN_MULTIPLIER = 1;
export const MAX_MULTIPLIER = 1_000_000;

/** Plans and their durations in days. Duration starts at first successful activation. */
export const PLAN_DURATION_DAYS = { '30d': 30, '365d': 365 } as const;

/** Admin generation limits. */
export const MAX_CODES_PER_GENERATION = 20;
/** Hard ceiling of active devices per subscription (also enforced by the database). */
export const MAX_DEVICE_LIMIT = 5;
/** Default device limit for NEW codes (the server's DEFAULT_DEVICE_LIMIT may lower it). */
export const DEFAULT_DEVICE_LIMIT = 5;
