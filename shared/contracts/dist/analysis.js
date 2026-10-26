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
export const ANALYSIS_THRESHOLDS = [2, 5, 10];
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
/**
 * no_data     — no valid rounds observed yet
 * collecting  — some rounds, fewer than `minSampleSize`
 * sufficient  — at least `minSampleSize` rounds (a larger sample describes the PAST more
 *               precisely; it does not make the next round predictable)
 */
export const DataSufficiencySchema = z.enum(['no_data', 'collecting', 'sufficient']);
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
