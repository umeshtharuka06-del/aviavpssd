import { z } from 'zod';
import { ForecastSchema, HistoricalSummarySchema } from './analysis.js';
import { MAX_BACKFILL_ROUNDS, NextRoundSignalSchema } from './signal.js';
import { ActivationCodeInputSchema, DeviceIdSchema, IsoDateTimeSchema, MultiplierSchema, SiteIdSchema, SubscriptionViewSchema, } from './common.js';
import { MAX_OBSERVATIONS_PER_BATCH } from './limits.js';
/* ---------- POST /v1/activation/redeem (no auth) ---------- */
/** Coarse, user-recognisable device label ("Chrome · Windows"). Never a fingerprint. */
export const DeviceLabelSchema = z.string().trim().max(60).regex(/^[A-Za-z0-9 ·._()/-]*$/);
export const RedeemRequestSchema = z.strictObject({
    code: ActivationCodeInputSchema,
    deviceId: DeviceIdSchema,
    clientVersion: z.string().max(32).optional(),
    deviceLabel: DeviceLabelSchema.optional(),
});
export const SessionViewSchema = z.object({
    /** Opaque bearer token. Store in chrome.storage.local only; never log it. */
    token: z.string().min(32).max(128),
    expiresAt: IsoDateTimeSchema,
});
export const RedeemResponseSchema = z.object({
    /**
     * activated       — first redemption; subscription period started now.
     * device_added    — code was already redeemed; this device took a free device slot.
     * device_restored — this device already held a slot; a new session was issued
     *                   (no extra slot used, subscription period unchanged).
     */
    result: z.enum(['activated', 'device_added', 'device_restored']),
    session: SessionViewSchema,
    subscription: SubscriptionViewSchema,
});
/* ---------- GET /v1/subscription (customer bearer) ---------- */
export const SubscriptionResponseSchema = z.object({
    subscription: SubscriptionViewSchema,
    session: z.object({ expiresAt: IsoDateTimeSchema }),
});
/* ---------- POST /v1/session/refresh (customer bearer) ---------- */
export const RefreshRequestSchema = z.strictObject({ deviceId: DeviceIdSchema });
export const RefreshResponseSchema = z.object({
    session: SessionViewSchema,
    subscription: SubscriptionViewSchema,
});
/* ---------- POST /v1/history (customer bearer) ---------- */
export const ObservationSchema = z.strictObject({
    multiplier: MultiplierSchema,
    /** Round reference shown by the game UI, if the adapter can read one reliably. */
    roundRef: z.string().regex(/^[A-Za-z0-9._:-]{1,64}$/).optional(),
});
/**
 * Collector continuity (extension 0.2.1+, server stat-5.1+). `chain` identifies one unbroken run of
 * reads of the results list in one page view: it changes whenever the collector loses track (page
 * load, re-sync, list unavailable, collection paused). `index` is the chain position of the batch's
 * FIRST round; the rounds of a batch are consecutive. A round is a verified successor of the
 * previously stored round only if that round has the same chain and index − 1. Without this field
 * (older clients) the server falls back to the 120 s time rule.
 */
export const ContinuitySchema = z.strictObject({
    chain: z.uuid(),
    index: z.number().int().nonnegative().max(1_000_000),
});
export const HistoryIngestRequestSchema = z.strictObject({
    /** Client-generated idempotency key; retries of the same batch must reuse it. */
    batchId: z.uuid(),
    siteId: SiteIdSchema,
    adapterVersion: z.string().regex(/^[0-9A-Za-z.+-]{1,16}$/),
    /** Ordered oldest → newest. Client timestamps are intentionally not accepted. */
    observations: z.array(ObservationSchema).min(1).max(MAX_OBSERVATIONS_PER_BATCH),
    continuity: ContinuitySchema.optional(),
});
export const HistoryIngestResponseSchema = z.object({
    /** "duplicate_batch": this batchId was already processed; nothing was stored again. */
    result: z.enum(['accepted', 'duplicate_batch']),
    accepted: z.number().int().nonnegative(),
    duplicates: z.number().int().nonnegative(),
});
/* ---------- POST /v1/history/backfill (customer bearer, engine stat-5 and later) ---------- */
/**
 * The completed results the game showed when collection started (its results strip), oldest →
 * newest. The server aligns them with this device's stored rounds and stores only the rounds it
 * does not have yet, marked as backfill. Nothing is stored when the alignment is ambiguous.
 */
export const BackfillRequestSchema = z.strictObject({
    batchId: z.uuid(),
    siteId: SiteIdSchema,
    adapterVersion: z.string().regex(/^[0-9A-Za-z.+-]{1,16}$/),
    multipliers: z.array(MultiplierSchema).min(1).max(MAX_BACKFILL_ROUNDS),
    /** Chain position of multipliers[0]; the first live batch of the same chain follows the last one. */
    continuity: ContinuitySchema.optional(),
});
export const BackfillResponseSchema = z.object({
    /**
     * stored          rounds not stored yet were added (`accepted` may be 0 when all were known)
     * duplicate_batch this batchId was already processed
     * rejected        could not be aligned with the stored rounds without risking duplicates; nothing stored
     */
    result: z.enum(['stored', 'duplicate_batch', 'rejected']),
    accepted: z.number().int().nonnegative(),
    alreadyStored: z.number().int().nonnegative(),
    reason: z.string().max(200).optional(),
});
/* ---------- POST /v1/analysis (customer bearer) ---------- */
export const AnalysisRequestSchema = z.strictObject({ siteId: SiteIdSchema });
export const AnalysisItemSchema = z.object({
    label: z.string().max(80),
    value: z.string().max(80),
});
export const AnalysisResponseSchema = z.object({
    /** Public engine descriptor. Never contains implementation details. */
    engine: z.object({
        kind: z.enum(['mock', 'live']),
        version: z.string().max(32),
    }),
    /** true for mock/placeholder output. Clients MUST display a "test data" label. */
    isTestData: z.boolean(),
    status: z.enum(['ok', 'insufficient_data']),
    siteId: SiteIdSchema,
    generatedAt: IsoDateTimeSchema,
    windowHours: z.number().int().positive(),
    observationsConsidered: z.number().int().nonnegative(),
    items: z.array(AnalysisItemSchema).max(20),
    /**
     * Device-scoped historical summary (threshold frequencies, below-2× indicator, average).
     * Optional for backward compatibility: the mock provider omits it. Earlier server versions
     * sent `metrics` / `patterns` / `signal` instead; those fields were removed and are ignored
     * (stripped) by this schema, so mixed client/server versions keep validating.
     */
    summary: HistoricalSummarySchema.optional(),
    /**
     * Walk-forward next-round forecast experiment (engine stat-4 and later). Optional: older servers
     * and the mock provider omit it, and older extensions strip it.
     */
    forecast: ForecastSchema.optional(),
    /**
     * Round-by-round next-round signal with its forecast ledger (engine stat-5 and later). Optional:
     * older servers omit it (the panel then shows SERVER UPDATE NEEDED) and older extensions strip it.
     * (Named `nextRound` because servers before stat-2 sent an unrelated `signal` field, still stripped.)
     */
    nextRound: NextRoundSignalSchema.optional(),
    notice: z.string().max(400),
});
