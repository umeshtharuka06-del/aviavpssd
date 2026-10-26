import { z } from 'zod';
/**
 * Structured empirical metrics for ONE device's observed history on ONE site.
 *
 * Everything here describes PAST observed rounds only. Nothing is a prediction of the next
 * round. A "threshold reached" means the round's recorded crash multiplier was at or above the
 * threshold — it is a property of the completed round, not a forecast.
 */
/** Multiplier thresholds analysed everywhere. */
export declare const ANALYSIS_THRESHOLDS: readonly [2, 5, 10];
/** Rolling window sizes (most-recent N rounds), plus the full retention window ("all"). */
export declare const ANALYSIS_WINDOW_SIZES: readonly [50, 100, 250, 500];
export declare const ThresholdDirectionSchema: z.ZodEnum<{
    at_least: "at_least";
    below: "below";
}>;
export type ThresholdDirection = z.infer<typeof ThresholdDirectionSchema>;
/**
 * One empirical threshold frequency with its uncertainty.
 *
 *  - `proportion` = count / total within this window (same denominator for every threshold, so
 *    the figures are nested-consistent: below2 ≤ below5 ≤ below10, and atLeast + below = total).
 *  - `ciLow`/`ciHigh` are a 95% Wilson score interval: the uncertainty of the HISTORICAL rate
 *    under its own assumptions. It does not state the probability of any future round.
 */
export declare const ThresholdStatSchema: z.ZodObject<{
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
}, z.core.$strip>;
export type ThresholdStat = z.infer<typeof ThresholdStatSchema>;
export declare const AnalysisWindowSchema: z.ZodUnion<readonly [z.ZodLiteral<50>, z.ZodLiteral<100>, z.ZodLiteral<250>, z.ZodLiteral<500>, z.ZodLiteral<"all">]>;
export type AnalysisWindow = z.infer<typeof AnalysisWindowSchema>;
/** Metrics computed independently over one window. `sampleSize` is the rounds actually available. */
export declare const WindowMetricsSchema: z.ZodObject<{
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
}, z.core.$strip>;
export type WindowMetrics = z.infer<typeof WindowMetricsSchema>;
export declare const DataQualitySchema: z.ZodEnum<{
    ok: "ok";
    insufficient_data: "insufficient_data";
    stale: "stale";
}>;
export type DataQuality = z.infer<typeof DataQualitySchema>;
/** "Low" rounds are those below this multiplier; "high" rounds are those at or above HIGH. */
export declare const LOW_MULTIPLIER_THRESHOLD = 2;
export declare const HIGH_MULTIPLIER_THRESHOLD = 10;
/** The short-term window compared against the full-history baseline. */
export declare const RECENT_WINDOW = 50;
/** Lower edges of the high-multiplier distribution buckets (last edge is open-ended). */
export declare const HIGH_DISTRIBUTION_FLOORS: readonly [10, 20, 50, 100];
/** One threshold's empirical rate within a specific window, with its Wilson interval. */
export declare const WindowRateSchema: z.ZodObject<{
    window: z.ZodUnion<readonly [z.ZodLiteral<50>, z.ZodLiteral<100>, z.ZodLiteral<250>, z.ZodLiteral<500>, z.ZodLiteral<"all">]>;
    count: z.ZodNumber;
    total: z.ZodNumber;
    proportion: z.ZodNumber;
    ciLow: z.ZodNumber;
    ciHigh: z.ZodNumber;
}, z.core.$strip>;
export type WindowRate = z.infer<typeof WindowRateSchema>;
/**
 * Comparison of a threshold's rate in the recent window vs the full-history baseline.
 * `delta` is recent − baseline (the baseline includes the recent rounds, so it is a conservative
 * "recent vs your overall history" change, not a disjoint split). `ciOverlap` is true when the
 * two 95% intervals overlap — a cautious flag that the apparent change may be noise. This
 * describes how observed frequencies differ between periods; it is not a prediction.
 */
export declare const TrendComparisonSchema: z.ZodObject<{
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
}, z.core.$strip>;
export type TrendComparison = z.infer<typeof TrendComparisonSchema>;
export declare const StreakLengthSchema: z.ZodObject<{
    length: z.ZodNumber;
    occurrences: z.ZodNumber;
}, z.core.$strip>;
/**
 * Consecutive runs of low rounds (multiplier < `threshold`) in chronological order.
 * `currentStreak` is the run ending at the most recent round. These counts describe the past
 * only; a run of low rounds does NOT make a high round more or less likely next.
 */
export declare const StreakStatsSchema: z.ZodObject<{
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
export type StreakStats = z.infer<typeof StreakStatsSchema>;
export declare const DistributionBucketSchema: z.ZodObject<{
    floor: z.ZodNumber;
    ceil: z.ZodNullable<z.ZodNumber>;
    count: z.ZodNumber;
    proportion: z.ZodNumber;
}, z.core.$strip>;
/** How observed high multipliers are distributed across buckets (full-history window). */
export declare const HighMultiplierDistributionSchema: z.ZodObject<{
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
export type HighMultiplierDistribution = z.infer<typeof HighMultiplierDistributionSchema>;
/** Recent-pattern view: trend comparisons, low streaks and high-multiplier distribution. */
export declare const RecentPatternsSchema: z.ZodObject<{
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
}, z.core.$strip>;
export type RecentPatterns = z.infer<typeof RecentPatternsSchema>;
/** The full structured result. Device-scoped; purely historical. */
export declare const AnalysisMetricsSchema: z.ZodObject<{
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
}, z.core.$strip>;
export type AnalysisMetrics = z.infer<typeof AnalysisMetricsSchema>;
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
export declare const SignalClassificationSchema: z.ZodEnum<{
    insufficient_data: "insufficient_data";
    elevated_vs_baseline: "elevated_vs_baseline";
    near_baseline: "near_baseline";
    reduced_vs_baseline: "reduced_vs_baseline";
    stale_or_unreliable: "stale_or_unreliable";
}>;
export type SignalClassification = z.infer<typeof SignalClassificationSchema>;
export declare const ThresholdClassificationSchema: z.ZodObject<{
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
}, z.core.$strip>;
export type ThresholdClassification = z.infer<typeof ThresholdClassificationSchema>;
/**
 * Unified signal-engine report. It names the scope, how much data was analysed, which windows
 * were used, and a per-threshold descriptive classification. The underlying empirical
 * probabilities, confidence intervals and trend comparisons live in `metrics` and `patterns`
 * on the response; this report references them rather than duplicating the numbers.
 */
export declare const SignalReportSchema: z.ZodObject<{
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
}, z.core.$strip>;
export type SignalReport = z.infer<typeof SignalReportSchema>;
