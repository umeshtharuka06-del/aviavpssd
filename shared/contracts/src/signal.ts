import { z } from 'zod';
import { IsoDateTimeSchema } from './common.js';

/* ---------- Round-by-round next-round signal (engine "stat-5", method "sequential_v1") ---------- */

/**
 * Multiplier ranges. Mutually exclusive and exhaustive over [1, ∞). A round with multiplier m is in
 * the range whose `min ≤ m < max` (the last range has no upper bound). Boundary values belong to
 * the HIGHER range: 2.00× is in "2.00×–4.99×", 5.00× in "5.00×–9.99×", 10.00× in "10.00× and above".
 * Multipliers are recorded with two decimals, so "1.99×" is the largest value of the first range.
 */
export const MULTIPLIER_RANGES = [
  { id: 'r1', label: '1.00×–1.99×', min: 1, max: 2 },
  { id: 'r2', label: '2.00×–4.99×', min: 2, max: 5 },
  { id: 'r5', label: '5.00×–9.99×', min: 5, max: 10 },
  { id: 'r10', label: '10.00× and above', min: 10, max: null },
] as const;
export const RANGE_COUNT = MULTIPLIER_RANGES.length;

/** Index into MULTIPLIER_RANGES for a valid multiplier (≥ 1). */
export function rangeIndex(m: number): number {
  if (m < 2) return 0;
  if (m < 5) return 1;
  if (m < 10) return 2;
  return 3;
}

/**
 * Two separate scores for a resolved round, never combined:
 *   range hit   the actual multiplier fell INSIDE a given range (e.g. the forecast's most likely range);
 *   target hit  the actual multiplier REACHED OR EXCEEDED a target (4.00× hits a 2× target, misses 5×).
 * Both compare whole cents, so float noise (1.9999999) never moves a boundary.
 */
const cents = (x: number) => Math.round(x * 100);
export function rangeHit(multiplier: number, range: number): boolean {
  const r = MULTIPLIER_RANGES[range];
  if (!r) return false;
  return cents(multiplier) >= cents(r.min) && (r.max == null || cents(multiplier) < cents(r.max));
}
export function targetHit(multiplier: number, target: number): boolean {
  return cents(multiplier) >= cents(target);
}

/** Threshold events derived from a range distribution: P(≥2×) = r2+r5+r10, P(≥5×) = r5+r10, P(≥10×) = r10. */
export const SIGNAL_THRESHOLDS = [2, 5, 10] as const;
export function thresholdProbabilities(p: readonly number[]): { p2: number; p5: number; p10: number } {
  return { p2: p[1]! + p[2]! + p[3]!, p5: p[2]! + p[3]!, p10: p[3]! };
}

/** Rounds needed before the first (experimental) estimate is issued. */
export const SIGNAL_WARMUP_ROUNDS = 20;

/**
 * Models that produce a range distribution. `baseline` is the no-predictability reference;
 * the five candidates use recent rounds; `ensemble` is the Bayesian model average of all six.
 */
export const SIGNAL_MODELS = ['baseline', 'ewma', 'markov', 'streak', 'logit', 'changepoint', 'ensemble'] as const;
export const SignalModelSchema = z.enum(SIGNAL_MODELS);
export type SignalModel = z.infer<typeof SignalModelSchema>;
export const SIGNAL_CANDIDATES = ['ewma', 'markov', 'streak', 'logit', 'changepoint'] as const satisfies readonly SignalModel[];

/**
 * warming_up     fewer than SIGNAL_WARMUP_ROUNDS valid rounds: no forecast
 * experimental   a forecast is issued, but no candidate is validated (the ensemble estimate is shown)
 * validated      a candidate met every rule in `rules` (its estimate is shown)
 * baseline_only  enough forecasts were scored and the ensemble did NOT beat the baseline: the
 *                baseline distribution is shown, labelled as not a predictive signal
 */
export const SignalStateSchema = z.enum(['warming_up', 'experimental', 'validated', 'baseline_only']);
export type SignalState = z.infer<typeof SignalStateSchema>;

const Prob = z.number().min(0).max(1);
export const RangeProbabilitiesSchema = z.array(Prob).length(RANGE_COUNT);

/* ---------- Range state machine (stat-5.4+): an EXPERIMENTAL heuristic, not a validated signal ---------- */

/**
 * low_range_tracking     fewer than `lowEntryCount` consecutive rounds below the target: the baseline
 *                        distribution, its most likely range as the predicted range
 * elevated_range_watch   at least `lowEntryCount` consecutive rounds below the target (in one verified
 *                        run): the predicted range is `watchRange` and stays so after every miss, until
 *                        a round reaches the target, a collection break, or `maxWatchForecasts` forecasts
 * A run of low rounds does NOT make a high round due; the watch only selects which estimate is shown.
 */
export const STRATEGY_STATES = ['low_range_tracking', 'elevated_range_watch'] as const;
export const StrategyStateSchema = z.enum(STRATEGY_STATES);
export type StrategyState = z.infer<typeof StrategyStateSchema>;

export const RangeStrategyConfigSchema = z.object({
  /** Target threshold: a round with multiplier ≥ this (whole cents) is a TARGET HIT; below it is "low". */
  targetThreshold: z.number().positive(),
  /** Consecutive low rounds that enter the watch. */
  lowEntryCount: z.number().int().positive(),
  /** Range index the watch predicts. */
  watchRange: z.number().int().min(0).max(RANGE_COUNT - 1),
  /** Persistence rule: forecasts per watch before it lapses back to tracking; null = until a hit or a break. */
  maxWatchForecasts: z.number().int().positive().nullable(),
  /** Past watch outcomes needed before the watch uses its own (conditional) estimate instead of the baseline. */
  minConditionalSample: z.number().int().positive(),
  /** Pseudo-rounds of the baseline mixed into the conditional estimate. */
  priorStrength: z.number().positive(),
});
export type RangeStrategyConfig = z.infer<typeof RangeStrategyConfigSchema>;

/** Fixed before any evaluation (the user's specification); not tuned on data. */
export const RANGE_STRATEGY_CONFIG: RangeStrategyConfig = Object.freeze({
  targetThreshold: 2,
  lowEntryCount: 5,
  watchRange: 1,
  maxWatchForecasts: null,
  minConditionalSample: 30,
  priorStrength: 20,
});

export const RangeStrategyForecastSchema = z.object({
  method: z.literal('range_state_machine_v1'),
  config: RangeStrategyConfigSchema,
  state: StrategyStateSchema,
  /** Consecutive rounds below the target ending at the input boundary (counted within one verified run). */
  consecutiveLow: z.number().int().nonnegative(),
  /** 1-based position of this forecast within the current watch; 0 while tracking. */
  watchForecast: z.number().int().nonnegative(),
  /** The low run is long enough for the watch, but the persistence rule (maxWatchForecasts) has lapsed. */
  watchLapsed: z.boolean(),
  targetThreshold: z.number().positive(),
  /** Range this forecast is scored against for RANGE HIT/MISS. */
  predictedRange: z.number().int().min(0).max(RANGE_COUNT - 1),
  probabilities: RangeProbabilitiesSchema,
  /** P(multiplier ≥ targetThreshold) under `probabilities`. */
  targetProbability: Prob,
  /** baseline: the baseline distribution is shown as is; conditional: past watch outcomes mixed with the baseline. */
  basis: z.enum(['baseline', 'conditional']),
  label: z.enum(['baseline', 'experimental']),
  /** Earlier rounds (input rounds only) that were played during a watch, and how many reached the target. */
  conditionalSample: z.number().int().nonnegative(),
  conditionalTargetHits: z.number().int().nonnegative(),
  /** z of the conditional target rate against the baseline's P(≥ target); one uncorrected look, not a validation. */
  differenceZ: z.number().nullable(),
  /** No model forecasts a position inside a range, so no exact multiplier is defined: always null here. */
  multiplierEstimate: z.null(),
  multiplierEstimateReason: z.string().max(200),
});
export type RangeStrategyForecast = z.infer<typeof RangeStrategyForecastSchema>;

const RateSchema = z.object({ n: z.number().int().nonnegative(), hits: z.number().int().nonnegative(), rate: Prob.nullable(), low: Prob.nullable(), high: Prob.nullable() });
export const StrategyBucketSchema = z.object({
  /** Consecutive low rounds before the forecast round: "0-1", "2-4", "5-7", "8+". */
  bucket: z.enum(['0-1', '2-4', '5-7', '8+']),
  target: RateSchema,
  rangeHits: z.number().int().nonnegative(),
  baselineRangeHits: z.number().int().nonnegative(),
  meanTargetProbability: Prob.nullable(),
  meanBaselineTargetProbability: Prob.nullable(),
  targetBrier: z.number().min(0).max(1).nullable(),
  baselineTargetBrier: z.number().min(0).max(1).nullable(),
});
export const StrategyPerformanceSchema = z.object({
  /** Scored forecasts that carry a strategy record. */
  eligible: z.number().int().nonnegative(),
  /** TARGET HIT rate (actual ≥ threshold) with a 95% Wilson interval. Same rounds for the baseline. */
  target: RateSchema,
  /** RANGE HIT: actual inside the strategy's predicted range; baseline = inside the baseline's most likely range. */
  rangeHits: z.number().int().nonnegative(),
  baselineRangeHits: z.number().int().nonnegative(),
  /** Target event (≥ threshold): strategy probability vs the baseline's, lower is better. */
  targetBrier: z.number().min(0).max(1).nullable(),
  baselineTargetBrier: z.number().min(0).max(1).nullable(),
  targetLogLoss: z.number().nonnegative().nullable(),
  baselineTargetLogLoss: z.number().nonnegative().nullable(),
  /** Mean paired (strategy − baseline) target log loss with a 95% interval; negative = better. */
  targetLogLossDiff: z.number().nullable(),
  targetLogLossDiffLow: z.number().nullable(),
  targetLogLossDiffHigh: z.number().nullable(),
  /** Four-range scores of the strategy probabilities vs the baseline vector. */
  rangeLogLoss: z.number().nonnegative().nullable(),
  baselineRangeLogLoss: z.number().nonnegative().nullable(),
  rangeBrier: z.number().min(0).max(2).nullable(),
  baselineRangeBrier: z.number().min(0).max(2).nullable(),
  byRunLength: z.array(StrategyBucketSchema),
});
export type StrategyPerformance = z.infer<typeof StrategyPerformanceSchema>;

export const ForecastOutcomeSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('pending') }),
  z.object({
    status: z.literal('scored'),
    /** Server id of the round that resolved this forecast (the next stored round). */
    roundId: z.string().max(24),
    multiplier: z.number().min(1),
    range: z.number().int().min(0).max(RANGE_COUNT - 1),
    scoredAt: IsoDateTimeSchema,
    /** The actual multiplier fell in the range with the highest forecast probability. */
    topRangeHit: z.boolean(),
    /** −ln p(actual range) of the shown forecast and of the baseline. */
    logLoss: z.number().nonnegative(),
    baselineLogLoss: z.number().nonnegative(),
    /** Σ_k (p_k − 1[k = actual])², in [0, 2]. */
    brier: z.number().min(0).max(2),
    /** stat-5.4+, forecasts with a strategy record: actual ≥ strategy.targetThreshold (numeric, whole cents). */
    targetHit: z.boolean().optional(),
    /** stat-5.4+: actual inside strategy.predictedRange. Separate from targetHit (5.00× after 2.00×–4.99×: range miss, target hit). */
    strategyRangeHit: z.boolean().optional(),
  }),
  z.object({
    status: z.literal('void'),
    /** gap: the next stored round came after a collection break, so it may not be the next round played. */
    reason: z.enum(['gap', 'late']),
    scoredAt: IsoDateTimeSchema,
  }),
]);
export type ForecastOutcome = z.infer<typeof ForecastOutcomeSchema>;

/** Evidence that stood when a forecast was issued (recorded with it, never changed). */
export const IssueEvidenceSchema = z.object({
  /** Forecasts scored before this one was issued. */
  scored: z.number().int().nonnegative(),
  /** Mean log loss of the shown model minus the baseline's over those (negative = better); null when none scored. */
  logLossDiff: z.number().nullable(),
  /** Candidate with the highest e-value at that time, and log10 of that e-value. */
  bestCandidate: SignalModelSchema.nullable(),
  bestLog10EValue: z.number().nullable(),
});
export type IssueEvidence = z.infer<typeof IssueEvidenceSchema>;

/** One immutable forecast for the round after `inputLastRoundId`. */
export const ForecastRecordSchema = z.object({
  id: z.string().regex(/^fc_[0-9A-Z]{16}$/),
  issuedAt: IsoDateTimeSchema,
  /** Server id of the last round the forecast was allowed to use (input boundary). */
  inputLastRoundId: z.string().max(24),
  inputRounds: z.number().int().nonnegative(),
  engineVersion: z.string().max(32),
  state: z.enum(['experimental', 'validated', 'baseline_only']),
  /** Model whose distribution is the forecast shown (baseline for baseline_only). */
  model: SignalModelSchema,
  probabilities: RangeProbabilitiesSchema,
  baselineProbabilities: RangeProbabilitiesSchema,
  atIssue: IssueEvidenceSchema,
  /** Range state machine at issue time (stat-5.4+; absent or null for older forecasts). */
  strategy: RangeStrategyForecastSchema.nullable().optional(),
  outcome: ForecastOutcomeSchema,
});
export type ForecastRecord = z.infer<typeof ForecastRecordSchema>;

export const ReliabilityBinSchema = z.object({ low: Prob, high: Prob, n: z.number().int().nonnegative(), meanForecast: Prob.nullable(), observedRate: Prob.nullable() });

export const ThresholdPerformanceSchema = z.object({
  threshold: z.number().positive(),
  /** Scored forecasts whose round reached / did not reach the threshold. */
  events: z.number().int().nonnegative(),
  nonEvents: z.number().int().nonnegative(),
  /** insufficient_evidence: fewer than `rules.minEvents` events or non-events among scored forecasts. */
  status: z.enum(['ok', 'insufficient_evidence']),
  brier: z.number().min(0).max(1).nullable(),
  baselineBrier: z.number().min(0).max(1).nullable(),
  logLoss: z.number().nonnegative().nullable(),
  baselineLogLoss: z.number().nonnegative().nullable(),
  meanForecast: Prob.nullable(),
  observedRate: Prob.nullable(),
  /** Spiegelhalter calibration Z of the shown forecasts (|Z| < 1.96: consistent with calibrated). */
  calibrationZ: z.number().nullable(),
  reliability: z.array(ReliabilityBinSchema),
});
export type ThresholdPerformance = z.infer<typeof ThresholdPerformanceSchema>;

export const PerformanceSchema = z.object({
  /** Forecasts whose round arrived and was scored (genuinely unseen when issued). */
  scored: z.number().int().nonnegative(),
  /** Forecasts that could not be scored fairly (collection break). */
  voided: z.number().int().nonnegative(),
  pending: z.number().int().nonnegative(),
  /** Share of scored forecasts whose actual range was the forecast's top range; null when none scored. */
  topRangeHitRate: Prob.nullable(),
  baselineTopRangeHitRate: Prob.nullable(),
  logLoss: z.number().nonnegative().nullable(),
  baselineLogLoss: z.number().nonnegative().nullable(),
  /** Mean (shown − baseline) log loss with a 95% interval; negative = better than the baseline. */
  logLossDiff: z.number().nullable(),
  logLossDiffLow: z.number().nullable(),
  logLossDiffHigh: z.number().nullable(),
  brier: z.number().min(0).max(2).nullable(),
  baselineBrier: z.number().min(0).max(2).nullable(),
  /** Same figures over the most recent `rolling.window` scored forecasts. */
  rolling: z.object({
    window: z.number().int().positive(),
    n: z.number().int().nonnegative(),
    topRangeHitRate: Prob.nullable(),
    logLoss: z.number().nonnegative().nullable(),
    baselineLogLoss: z.number().nonnegative().nullable(),
    /** stat-5.2+ (absent from older servers): baseline hit rate and Brier over the same window. */
    baselineTopRangeHitRate: Prob.nullable().optional(),
    brier: z.number().min(0).max(2).nullable().optional(),
    baselineBrier: z.number().min(0).max(2).nullable().optional(),
  }),
  thresholds: z.array(ThresholdPerformanceSchema),
});
export type Performance = z.infer<typeof PerformanceSchema>;

export const ModelStandingSchema = z.object({
  model: SignalModelSchema,
  /** Current ensemble weight (posterior model probability); null for the ensemble itself. */
  weight: Prob.nullable(),
  /** Mean log loss over scored forecasts; null when none scored. */
  logLoss: z.number().nonnegative().nullable(),
  /** log10 of the e-value against "rounds are independent with a constant range distribution"; candidates only. */
  log10EValue: z.number().nullable(),
  validated: z.boolean(),
});
export type ModelStanding = z.infer<typeof ModelStandingSchema>;

export const SignalRulesSchema = z.object({
  warmupRounds: z.number().int().positive(),
  /** Scored forecasts before the ensemble can be judged against the baseline (baseline_only). */
  minScoredForVerdict: z.number().int().positive(),
  /** Scored forecasts before any candidate can be validated. */
  minScoredForValidation: z.number().int().positive(),
  alpha: z.number().positive().max(1),
  candidates: z.number().int().positive(),
  /** A candidate is validated when its e-value reaches candidates ÷ alpha. */
  eValueThreshold: z.number().positive(),
  minEvents: z.number().int().positive(),
  gapSeconds: z.number().int().positive(),
});
export type SignalRules = z.infer<typeof SignalRulesSchema>;

/**
 * Representative multiplier for the current forecast (stat-5.3+). The models forecast RANGES only;
 * none of them forecasts where inside a range the multiplier will land. So this is NOT a predicted
 * exact multiplier. It is the median of the recorded multipliers that fell in the forecast's most
 * likely range, over the rounds the forecast was built from (rounds up to its input boundary only).
 * It is the same kind of value before every round with the same top range, and it is not scored.
 * Unavailable (multiplier null) when fewer than REPRESENTATIVE_MIN_SAMPLE such rounds exist.
 */
export const REPRESENTATIVE_MIN_SAMPLE = 10;
export const RepresentativeEstimateSchema = z.object({
  method: z.literal('top_range_conditional_median'),
  /** The forecast it belongs to (signal.current.id). */
  forecastId: z.string().regex(/^fc_[0-9A-Z]{16}$/),
  /** Index of the forecast's most likely range. */
  range: z.number().int().min(0).max(RANGE_COUNT - 1),
  /** Median, rounded to two decimals; null when unavailable. */
  multiplier: z.number().min(1).nullable(),
  /** 25th and 75th percentiles of the same rounds (nearest rank); null when unavailable. */
  low: z.number().min(1).nullable(),
  high: z.number().min(1).nullable(),
  /** Rounds in that range among `inputRounds` (the rounds read, all at or before the input boundary). */
  sample: z.number().int().nonnegative(),
  inputRounds: z.number().int().nonnegative(),
  minSample: z.number().int().positive(),
  /** Why it is unavailable; null when available. */
  unavailableReason: z.string().max(200).nullable(),
});
export type RepresentativeEstimate = z.infer<typeof RepresentativeEstimateSchema>;

export const NextRoundSignalSchema = z.object({
  method: z.literal('sequential_v1'),
  state: SignalStateSchema,
  /** One plain sentence explaining the state. */
  reason: z.string().max(300),
  /** Valid rounds available to the model (this device, this site, retention window). */
  rounds: z.number().int().nonnegative(),
  /**
   * Verified consecutive rounds ending at the latest round, and the longest such run (stat-5.1+;
   * absent from stat-5). Runs are split where rounds may be missing (collector continuity, or a
   * gap of more than rules.gapSeconds for older clients). Warm-up needs longestRun ≥ warmupRounds.
   */
  currentRun: z.number().int().nonnegative().optional(),
  longestRun: z.number().int().nonnegative().optional(),
  liveRounds: z.number().int().nonnegative(),
  backfillRounds: z.number().int().nonnegative(),
  latestRoundAt: IsoDateTimeSchema.nullable(),
  /** The forecast for the round after the latest stored round; null while warming up. */
  current: ForecastRecordSchema.nullable(),
  /** Representative multiplier inside the current forecast's most likely range (stat-5.3+; absent from older servers). */
  representative: RepresentativeEstimateSchema.nullable().optional(),
  /** Posterior probability that the range distribution changed within the last 30 rounds (change-point model). */
  changeProbability: Prob.nullable(),
  performance: PerformanceSchema,
  models: z.array(ModelStandingSchema),
  /** Most recent forecasts, newest first (at most 30). */
  history: z.array(ForecastRecordSchema).max(30),
  rules: SignalRulesSchema,
  /** Walk-forward record of the range state machine over this device's scored forecasts (stat-5.4+). */
  strategyPerformance: StrategyPerformanceSchema.optional(),
});
export type NextRoundSignal = z.infer<typeof NextRoundSignalSchema>;

/* ---------- POST /v1/history/backfill ---------- */

/** At most this many visible results are accepted as one backfill. */
export const MAX_BACKFILL_ROUNDS = 100;
