import { z } from 'zod';
import { ForecastSchema, HistoricalSummarySchema } from './analysis.js';
import {
  ActivationCodeInputSchema,
  DeviceIdSchema,
  IsoDateTimeSchema,
  MultiplierSchema,
  SiteIdSchema,
  SubscriptionViewSchema,
} from './common.js';
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
export type RedeemRequest = z.infer<typeof RedeemRequestSchema>;

export const SessionViewSchema = z.object({
  /** Opaque bearer token. Store in chrome.storage.local only; never log it. */
  token: z.string().min(32).max(128),
  expiresAt: IsoDateTimeSchema,
});
export type SessionView = z.infer<typeof SessionViewSchema>;

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
export type RedeemResponse = z.infer<typeof RedeemResponseSchema>;

/* ---------- GET /v1/subscription (customer bearer) ---------- */

export const SubscriptionResponseSchema = z.object({
  subscription: SubscriptionViewSchema,
  session: z.object({ expiresAt: IsoDateTimeSchema }),
});
export type SubscriptionResponse = z.infer<typeof SubscriptionResponseSchema>;

/* ---------- POST /v1/session/refresh (customer bearer) ---------- */

export const RefreshRequestSchema = z.strictObject({ deviceId: DeviceIdSchema });
export type RefreshRequest = z.infer<typeof RefreshRequestSchema>;

export const RefreshResponseSchema = z.object({
  session: SessionViewSchema,
  subscription: SubscriptionViewSchema,
});
export type RefreshResponse = z.infer<typeof RefreshResponseSchema>;

/* ---------- POST /v1/history (customer bearer) ---------- */

export const ObservationSchema = z.strictObject({
  multiplier: MultiplierSchema,
  /** Round reference shown by the game UI, if the adapter can read one reliably. */
  roundRef: z.string().regex(/^[A-Za-z0-9._:-]{1,64}$/).optional(),
});
export type Observation = z.infer<typeof ObservationSchema>;

export const HistoryIngestRequestSchema = z.strictObject({
  /** Client-generated idempotency key; retries of the same batch must reuse it. */
  batchId: z.uuid(),
  siteId: SiteIdSchema,
  adapterVersion: z.string().regex(/^[0-9A-Za-z.+-]{1,16}$/),
  /** Ordered oldest → newest. Client timestamps are intentionally not accepted. */
  observations: z.array(ObservationSchema).min(1).max(MAX_OBSERVATIONS_PER_BATCH),
});
export type HistoryIngestRequest = z.infer<typeof HistoryIngestRequestSchema>;

export const HistoryIngestResponseSchema = z.object({
  /** "duplicate_batch": this batchId was already processed; nothing was stored again. */
  result: z.enum(['accepted', 'duplicate_batch']),
  accepted: z.number().int().nonnegative(),
  duplicates: z.number().int().nonnegative(),
});
export type HistoryIngestResponse = z.infer<typeof HistoryIngestResponseSchema>;

/* ---------- POST /v1/analysis (customer bearer) ---------- */

export const AnalysisRequestSchema = z.strictObject({ siteId: SiteIdSchema });
export type AnalysisRequest = z.infer<typeof AnalysisRequestSchema>;

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
  notice: z.string().max(400),
});
export type AnalysisResponse = z.infer<typeof AnalysisResponseSchema>;
