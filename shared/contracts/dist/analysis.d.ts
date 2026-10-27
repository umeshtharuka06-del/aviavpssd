import { z } from 'zod';
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
export declare const ANALYSIS_THRESHOLDS: readonly [2, 5, 10];
/** The combined historical indicator is the share of rounds that ended below this multiplier. */
export declare const COMBINED_INDICATOR_THRESHOLD = 2;
/**
 * Default minimum number of valid rounds before the figures are presented as sufficiently
 * supported. The server may be configured differently; clients use `minSampleSize` from the
 * response, never this constant.
 */
export declare const DEFAULT_MIN_SAMPLE_SIZE = 100;
export declare const ThresholdFrequencySchema: z.ZodObject<{
    threshold: z.ZodNumber;
    count: z.ZodNumber;
    frequency: z.ZodNullable<z.ZodNumber>;
}, z.core.$strip>;
export type ThresholdFrequency = z.infer<typeof ThresholdFrequencySchema>;
/**
 * no_data     — no valid rounds observed yet
 * collecting  — some rounds, fewer than `minSampleSize`
 * sufficient  — at least `minSampleSize` rounds (a larger sample describes the PAST more
 *               precisely; it does not make the next round predictable)
 */
export declare const DataSufficiencySchema: z.ZodEnum<{
    no_data: "no_data";
    collecting: "collecting";
    sufficient: "sufficient";
}>;
export type DataSufficiency = z.infer<typeof DataSufficiencySchema>;
export declare const HistoricalSummarySchema: z.ZodObject<{
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
}, z.core.$strip>;
export type HistoricalSummary = z.infer<typeof HistoricalSummarySchema>;
