import { z } from 'zod';
import { IsoDateTimeSchema } from './common.js';

/**
 * Historical summary of ONE device's observed, completed rounds on ONE site.
 *
 * Everything here describes PAST observed rounds only. Nothing is a prediction of the next
 * round. A round "reaches" a threshold when its recorded crash multiplier was at or above the
 * threshold — a property of the completed round, not a forecast.
 *
 * Formulas (n = valid observed rounds; a round is valid when its multiplier is a finite number
 * within [MIN_MULTIPLIER, MAX_MULTIPLIER]):
 *   Historical frequency (≥T)       = count(multiplier ≥ T) / n
 *   Historical rounds below 2×      = count(multiplier < 2) / n   (= 1 − frequency(≥2×))
 *   Historical average multiplier   = (sum of multipliers) / n
 * Every ratio is null when n = 0 — a missing value is never reported as zero.
 */

/** Multiplier thresholds reported everywhere ("reached ≥T×"). */
export const ANALYSIS_THRESHOLDS = [2, 5, 10] as const;

/** The combined historical indicator is the share of rounds that ended below this multiplier. */
export const COMBINED_INDICATOR_THRESHOLD = 2;

/**
 * Default minimum number of valid rounds before the figures are presented as sufficiently
 * supported. The server may be configured differently; clients use `minSampleSize` from the
 * response, never this constant.
 */
export const DEFAULT_MIN_SAMPLE_SIZE = 100;

export const ThresholdFrequencySchema = z.object({
  threshold: z.number().positive(),
  /** Valid rounds meeting the condition (≥ threshold, or < threshold for the combined indicator). */
  count: z.number().int().nonnegative(),
  /** count / sampleSize, in [0, 1]; null when sampleSize is 0. */
  frequency: z.number().min(0).max(1).nullable(),
});
export type ThresholdFrequency = z.infer<typeof ThresholdFrequencySchema>;

/**
 * no_data     — no valid rounds observed yet
 * collecting  — some rounds, fewer than `minSampleSize`
 * sufficient  — at least `minSampleSize` rounds (a larger sample describes the PAST more
 *               precisely; it does not make the next round predictable)
 */
export const DataSufficiencySchema = z.enum(['no_data', 'collecting', 'sufficient']);
export type DataSufficiency = z.infer<typeof DataSufficiencySchema>;

export const HistoricalSummarySchema = z.object({
  /** Always this device's own observations (never pooled across devices or users). */
  scope: z.literal('device'),
  sampleSize: z.number().int().nonnegative(),
  minSampleSize: z.number().int().positive(),
  sufficiency: DataSufficiencySchema,
  /** Historical frequency of reaching each of ANALYSIS_THRESHOLDS (≥2×, ≥5×, ≥10×). */
  thresholds: z.array(ThresholdFrequencySchema),
  /** Combined historical indicator: share of rounds that ended BELOW 2.00×. */
  below2x: ThresholdFrequencySchema,
  /** Arithmetic mean of the valid multipliers; null when sampleSize is 0. */
  averageMultiplier: z.number().positive().nullable(),
  /** Stored values that failed validation and were left out of every figure. */
  invalidExcluded: z.number().int().nonnegative(),
  latestRoundAt: IsoDateTimeSchema.nullable(),
  /** Seconds between the latest observed round and now (server clock); null when no rounds. */
  freshnessSeconds: z.number().int().nonnegative().nullable(),
  /** Always true: descriptive history, not a next-round prediction. */
  isHistoricalOnly: z.literal(true),
});
export type HistoricalSummary = z.infer<typeof HistoricalSummarySchema>;

/* ---------- Next-round forecast experiment (engine "stat-3") ---------- */

/**
 * Walk-forward forecast experiment over ONE device's observed rounds on ONE site.
 *
 * For every threshold T (2×, 5×, 10×) the event is "the round's multiplier ≥ T". Each model gives
 * a probability for round t using ONLY rounds before t (chronological walk-forward; parameters are
 * refitted every `refitEvery` rounds on everything before the block). Rounds after the first
 * `trainInitial` are the held-out test rounds on which every model is scored.
 *
 *  - base_rate (no-predictability baseline): share of all earlier rounds reaching T (Jeffreys
 *    smoothing). Treats rounds as independent and identically distributed.
 *  - rtp_reference (fixed reference, uses no data): 0.97 ÷ T, i.e. Spribe's published RTP 97%
 *    under the UNVERIFIED assumption that it applies at every cash-out target.
 *  - candidates that use recent rounds: rolling_50, after_previous, since_last_hit,
 *    logistic_recent (see backend/src/engine/forecast.ts).
 *
 * A candidate is "validated" only if, on the test rounds, its log loss is lower than the base
 * rate's by a Diebold–Mariano test (Newey–West variance) at one-sided p < 0.05 ÷ (number of
 * candidate × threshold comparisons), AND its forecasts pass a calibration check (Spiegelhalter
 * |Z| < 1.96). Otherwise the next-round estimate is the base rate, and only if the base rate itself
 * passes its calibration check (parametric bootstrap, see ModelScore.calibrationP). Probabilities are estimates with a 95% interval, never guarantees.
 */
export const FORECAST_MODELS = ['base_rate', 'rtp_reference', 'rolling_50', 'after_previous', 'since_last_hit', 'logistic_recent'] as const;
export const ForecastModelSchema = z.enum(FORECAST_MODELS);
export type ForecastModel = z.infer<typeof ForecastModelSchema>;

export const ModelScoreSchema = z.object({
  model: ForecastModelSchema,
  /** true for models whose forecast depends on the most recent rounds. */
  usesRecentRounds: z.boolean(),
  /** Mean negative log-likelihood on the test rounds (natural log; lower is better). */
  logLoss: z.number().nonnegative(),
  /** Mean squared error of the probability on the test rounds (lower is better). */
  brier: z.number().min(0).max(1),
  /** Mean forecast probability and observed event rate on the test rounds. */
  meanForecast: z.number().min(0).max(1),
  observedRate: z.number().min(0).max(1),
  /** Spiegelhalter calibration statistic; |Z| < 1.96 is consistent with calibrated forecasts. */
  calibrationZ: z.number(),
  /**
   * base_rate only: parametric-bootstrap p-value for that Z under "independent rounds, constant
   * chance" (accounts for the base rate being estimated); calibrated = p ≥ 0.05 ÷ thresholds.
   * Other models: null, calibrated = |Z| < 1.96.
   */
  calibrationP: z.number().min(0).max(1).nullable(),
  calibrated: z.boolean(),
  /** 1 − logLoss ÷ baseRate.logLoss (positive = better than the base rate); null for base_rate. */
  skillVsBaseRate: z.number().nullable(),
  /** One-sided Diebold–Mariano p-value for "lower log loss than the base rate"; null for base_rate. */
  pValue: z.number().min(0).max(1).nullable(),
  /** Passed both the multiple-testing-corrected improvement test and the calibration check. */
  validated: z.boolean(),
});
export type ModelScore = z.infer<typeof ModelScoreSchema>;

export const ThresholdForecastSchema = z.object({
  threshold: z.number().positive(),
  /**
   * validated_model      — a recent-round model beat the base rate out of sample (see above)
   * no_predictive_value  — no model beat the base rate; the estimate is the base rate
   * not_calibrated       — not even the base rate passed the calibration check; no estimate
   * validated_model_not_current — a recent-round model was validated, but the latest stored
   *                        round is older than `gapSeconds`, so the rounds just before the next
   *                        one are unknown; the estimate shown is the base rate
   */
  status: z.enum(['validated_model', 'no_predictive_value', 'not_calibrated', 'validated_model_not_current']),
  /** The model behind `probability`; null when there is no estimate. */
  selectedModel: ForecastModelSchema.nullable(),
  /** Estimated probability that the NEXT round reaches the threshold; null when not supported. */
  probability: z.number().min(0).max(1).nullable(),
  /** 95% interval for that probability estimate (parameter uncertainty only). */
  low: z.number().min(0).max(1).nullable(),
  high: z.number().min(0).max(1).nullable(),
  models: z.array(ModelScoreSchema),
});
export type ThresholdForecast = z.infer<typeof ThresholdForecastSchema>;

export const ForecastSchema = z.object({
  method: z.literal('walk_forward_v1'),
  /** insufficient_data: fewer than `minSampleSize` valid rounds, nothing was evaluated. */
  status: z.enum(['insufficient_data', 'evaluated']),
  sampleSize: z.number().int().nonnegative(),
  /** trainInitial + minimum test rounds. */
  minSampleSize: z.number().int().positive(),
  trainInitial: z.number().int().positive(),
  /** Held-out rounds every model was scored on (0 when insufficient). */
  testRounds: z.number().int().nonnegative(),
  refitEvery: z.number().int().positive(),
  /** Runs of consecutive rounds (a gap of more than `gapSeconds` between stored rounds starts a new run). */
  segments: z.number().int().nonnegative(),
  gapSeconds: z.number().int().positive(),
  /** Candidate × threshold comparisons used for the multiple-testing correction. */
  comparisons: z.number().int().nonnegative(),
  thresholds: z.array(ThresholdForecastSchema),
});
export type Forecast = z.infer<typeof ForecastSchema>;
