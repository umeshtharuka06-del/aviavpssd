import { z } from 'zod';
import { IsoDateTimeSchema, SiteIdSchema } from './common.js';

/**
 * Structured empirical metrics for ONE device's observed history on ONE site.
 *
 * Everything here describes PAST observed rounds only. Nothing is a prediction of the next
 * round. A "threshold reached" means the round's recorded crash multiplier was at or above the
 * threshold — it is a property of the completed round, not a forecast.
 */

/** Multiplier thresholds analysed everywhere. */
export const ANALYSIS_THRESHOLDS = [2, 5, 10] as const;

/** Rolling window sizes (most-recent N rounds), plus the full retention window ("all"). */
export const ANALYSIS_WINDOW_SIZES = [50, 100, 250, 500] as const;

export const ThresholdDirectionSchema = z.enum(['at_least', 'below']);
export type ThresholdDirection = z.infer<typeof ThresholdDirectionSchema>;

/**
 * One empirical threshold frequency with its uncertainty.
 *
 *  - `proportion` = count / total within this window (same denominator for every threshold, so
 *    the figures are nested-consistent: below2 ≤ below5 ≤ below10, and atLeast + below = total).
 *  - `ciLow`/`ciHigh` are a 95% Wilson score interval: the uncertainty of the HISTORICAL rate
 *    under its own assumptions. It does not state the probability of any future round.
 */
export const ThresholdStatSchema = z.object({
  threshold: z.number().positive(),
  direction: ThresholdDirectionSchema,
  count: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  proportion: z.number().min(0).max(1),
  ciLow: z.number().min(0).max(1),
  ciHigh: z.number().min(0).max(1),
});
export type ThresholdStat = z.infer<typeof ThresholdStatSchema>;

export const AnalysisWindowSchema = z.union([z.literal(50), z.literal(100), z.literal(250), z.literal(500), z.literal('all')]);
export type AnalysisWindow = z.infer<typeof AnalysisWindowSchema>;

/** Metrics computed independently over one window. `sampleSize` is the rounds actually available. */
export const WindowMetricsSchema = z.object({
  window: AnalysisWindowSchema,
  /** Requested size for a rolling window; null for the full-history ("all") window. */
  requestedSize: z.number().int().positive().nullable(),
  sampleSize: z.number().int().nonnegative(),
  /** false when fewer rounds are available than requested (never claim a window is full). */
  complete: z.boolean(),
  mean: z.number().nullable(),
  median: z.number().nullable(),
  min: z.number().nullable(),
  max: z.number().nullable(),
  thresholds: z.array(ThresholdStatSchema),
});
export type WindowMetrics = z.infer<typeof WindowMetricsSchema>;

export const DataQualitySchema = z.enum(['ok', 'insufficient_data', 'stale']);
export type DataQuality = z.infer<typeof DataQualitySchema>;

/* ---------- Recent-pattern analysis (Phase 4) ---------- */

/** "Low" rounds are those below this multiplier; "high" rounds are those at or above HIGH. */
export const LOW_MULTIPLIER_THRESHOLD = 2;
export const HIGH_MULTIPLIER_THRESHOLD = 10;
/** The short-term window compared against the full-history baseline. */
export const RECENT_WINDOW = 50;
/** Lower edges of the high-multiplier distribution buckets (last edge is open-ended). */
export const HIGH_DISTRIBUTION_FLOORS = [10, 20, 50, 100] as const;

/** One threshold's empirical rate within a specific window, with its Wilson interval. */
export const WindowRateSchema = z.object({
  window: AnalysisWindowSchema,
  count: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  proportion: z.number().min(0).max(1),
  ciLow: z.number().min(0).max(1),
  ciHigh: z.number().min(0).max(1),
});
export type WindowRate = z.infer<typeof WindowRateSchema>;

/**
 * Comparison of a threshold's rate in the recent window vs the full-history baseline.
 * `delta` is recent − baseline (the baseline includes the recent rounds, so it is a conservative
 * "recent vs your overall history" change, not a disjoint split). `ciOverlap` is true when the
 * two 95% intervals overlap — a cautious flag that the apparent change may be noise. This
 * describes how observed frequencies differ between periods; it is not a prediction.
 */
export const TrendComparisonSchema = z.object({
  threshold: z.number().positive(),
  direction: ThresholdDirectionSchema,
  recent: WindowRateSchema,
  baseline: WindowRateSchema,
  delta: z.number().min(-1).max(1),
  ciOverlap: z.boolean(),
});
export type TrendComparison = z.infer<typeof TrendComparisonSchema>;

export const StreakLengthSchema = z.object({
  length: z.number().int().positive(),
  occurrences: z.number().int().positive(),
});

/**
 * Consecutive runs of low rounds (multiplier < `threshold`) in chronological order.
 * `currentStreak` is the run ending at the most recent round. These counts describe the past
 * only; a run of low rounds does NOT make a high round more or less likely next.
 */
export const StreakStatsSchema = z.object({
  threshold: z.number().positive(),
  window: AnalysisWindowSchema,
  sampleSize: z.number().int().nonnegative(),
  lowCount: z.number().int().nonnegative(),
  longestStreak: z.number().int().nonnegative(),
  currentStreak: z.number().int().nonnegative(),
  distribution: z.array(StreakLengthSchema),
});
export type StreakStats = z.infer<typeof StreakStatsSchema>;

export const DistributionBucketSchema = z.object({
  floor: z.number().nonnegative(),
  ceil: z.number().positive().nullable(),
  count: z.number().int().nonnegative(),
  proportion: z.number().min(0).max(1),
});

/** How observed high multipliers are distributed across buckets (full-history window). */
export const HighMultiplierDistributionSchema = z.object({
  threshold: z.number().positive(),
  window: AnalysisWindowSchema,
  count: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  buckets: z.array(DistributionBucketSchema),
});
export type HighMultiplierDistribution = z.infer<typeof HighMultiplierDistributionSchema>;

/** Recent-pattern view: trend comparisons, low streaks and high-multiplier distribution. */
export const RecentPatternsSchema = z.object({
  recentWindow: AnalysisWindowSchema,
  baselineWindow: AnalysisWindowSchema,
  comparisons: z.array(TrendComparisonSchema),
  lowStreak: StreakStatsSchema,
  highMultipliers: HighMultiplierDistributionSchema,
  warnings: z.array(z.string().max(200)).max(10),
});
export type RecentPatterns = z.infer<typeof RecentPatternsSchema>;

/** The full structured result. Device-scoped; purely historical. */
export const AnalysisMetricsSchema = z.object({
  scope: z.literal('device'),
  quality: DataQualitySchema,
  /** Total valid rounds for this device/site inside the retention window. */
  totalRounds: z.number().int().nonnegative(),
  latestRoundAt: IsoDateTimeSchema.nullable(),
  /** Seconds between the latest observed round and now (server clock); null when no rounds. */
  freshnessSeconds: z.number().int().nonnegative().nullable(),
  /** true when the latest round is older than the freshness threshold. */
  stale: z.boolean(),
  windows: z.array(WindowMetricsSchema),
});
export type AnalysisMetrics = z.infer<typeof AnalysisMetricsSchema>;

/* ---------- Signal engine (Phase 5) ---------- */

/**
 * Descriptive classification of a threshold's recent rate vs the device's baseline. These are
 * DESCRIPTIONS OF OBSERVED HISTORICAL DATA under pre-defined rules, never predictions of the
 * next round and never instructions to bet.
 *
 * Classification rule (fixed before any evaluation):
 *  - insufficient_data   — fewer than the minimum rounds to classify (overall or recent window).
 *  - stale_or_unreliable — latest round older than the freshness threshold.
 *  - elevated_vs_baseline — recent 95% Wilson interval lies entirely ABOVE the baseline interval.
 *  - reduced_vs_baseline  — recent 95% Wilson interval lies entirely BELOW the baseline interval.
 *  - near_baseline        — the intervals overlap (any apparent change is within noise).
 */
export const SignalClassificationSchema = z.enum([
  'insufficient_data',
  'elevated_vs_baseline',
  'near_baseline',
  'reduced_vs_baseline',
  'stale_or_unreliable',
]);
export type SignalClassification = z.infer<typeof SignalClassificationSchema>;

export const ThresholdClassificationSchema = z.object({
  threshold: z.number().positive(),
  direction: ThresholdDirectionSchema,
  classification: SignalClassificationSchema,
  /** recent.proportion − baseline.proportion (see patterns.comparisons for the full figures). */
  delta: z.number().min(-1).max(1),
  ciOverlap: z.boolean(),
});
export type ThresholdClassification = z.infer<typeof ThresholdClassificationSchema>;

/**
 * Unified signal-engine report. It names the scope, how much data was analysed, which windows
 * were used, and a per-threshold descriptive classification. The underlying empirical
 * probabilities, confidence intervals and trend comparisons live in `metrics` and `patterns`
 * on the response; this report references them rather than duplicating the numbers.
 */
export const SignalReportSchema = z.object({
  status: DataQualitySchema,
  scope: z.object({ kind: z.literal('device'), siteId: SiteIdSchema }),
  roundsAnalyzed: z.number().int().nonnegative(),
  windowSizes: z.array(AnalysisWindowSchema),
  classifications: z.array(ThresholdClassificationSchema),
  freshnessSeconds: z.number().int().nonnegative().nullable(),
  limitations: z.array(z.string().max(200)).max(12),
  /** Always true: this report describes past rounds; it is not a next-round prediction. */
  isHistoricalOnly: z.literal(true),
});
export type SignalReport = z.infer<typeof SignalReportSchema>;
