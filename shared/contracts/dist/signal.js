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
];
export const RANGE_COUNT = MULTIPLIER_RANGES.length;
/** Index into MULTIPLIER_RANGES for a valid multiplier (≥ 1). */
export function rangeIndex(m) {
    if (m < 2)
        return 0;
    if (m < 5)
        return 1;
    if (m < 10)
        return 2;
    return 3;
}
/** Threshold events derived from a range distribution: P(≥2×) = r2+r5+r10, P(≥5×) = r5+r10, P(≥10×) = r10. */
export const SIGNAL_THRESHOLDS = [2, 5, 10];
export function thresholdProbabilities(p) {
    return { p2: p[1] + p[2] + p[3], p5: p[2] + p[3], p10: p[3] };
}
/** Rounds needed before the first (experimental) estimate is issued. */
export const SIGNAL_WARMUP_ROUNDS = 20;
/**
 * Models that produce a range distribution. `baseline` is the no-predictability reference;
 * the five candidates use recent rounds; `ensemble` is the Bayesian model average of all six.
 */
export const SIGNAL_MODELS = ['baseline', 'ewma', 'markov', 'streak', 'logit', 'changepoint', 'ensemble'];
export const SignalModelSchema = z.enum(SIGNAL_MODELS);
export const SIGNAL_CANDIDATES = ['ewma', 'markov', 'streak', 'logit', 'changepoint'];
/**
 * warming_up     fewer than SIGNAL_WARMUP_ROUNDS valid rounds: no forecast
 * experimental   a forecast is issued, but no candidate is validated (the ensemble estimate is shown)
 * validated      a candidate met every rule in `rules` (its estimate is shown)
 * baseline_only  enough forecasts were scored and the ensemble did NOT beat the baseline: the
 *                baseline distribution is shown, labelled as not a predictive signal
 */
export const SignalStateSchema = z.enum(['warming_up', 'experimental', 'validated', 'baseline_only']);
const Prob = z.number().min(0).max(1);
export const RangeProbabilitiesSchema = z.array(Prob).length(RANGE_COUNT);
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
    }),
    z.object({
        status: z.literal('void'),
        /** gap: the next stored round came after a collection break, so it may not be the next round played. */
        reason: z.enum(['gap', 'late']),
        scoredAt: IsoDateTimeSchema,
    }),
]);
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
    outcome: ForecastOutcomeSchema,
});
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
    /** Posterior probability that the range distribution changed within the last 30 rounds (change-point model). */
    changeProbability: Prob.nullable(),
    performance: PerformanceSchema,
    models: z.array(ModelStandingSchema),
    /** Most recent forecasts, newest first (at most 30). */
    history: z.array(ForecastRecordSchema).max(30),
    rules: SignalRulesSchema,
});
/* ---------- POST /v1/history/backfill ---------- */
/** At most this many visible results are accepted as one backfill. */
export const MAX_BACKFILL_ROUNDS = 100;
