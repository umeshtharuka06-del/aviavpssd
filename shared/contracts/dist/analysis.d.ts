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
 * candidate × threshold comparisons) = `alpha`, AND its forecasts pass a calibration check
 * (Spiegelhalter |Z| < 1.96), AND the test rounds hold at least `minEvents` events and non-events,
 * AND — for histories under 1,000 rounds — an exact permutation test gives p < `alpha` too.
 * Otherwise the next-round estimate is the base rate, and only if the base rate itself
 * passes its calibration check (parametric bootstrap, see ModelScore.calibrationP). Probabilities are estimates with a 95% interval, never guarantees.
 */
export declare const FORECAST_MODELS: readonly ["base_rate", "rtp_reference", "rolling_50", "after_previous", "since_last_hit", "logistic_recent"];
export declare const ForecastModelSchema: z.ZodEnum<{
    base_rate: "base_rate";
    rtp_reference: "rtp_reference";
    rolling_50: "rolling_50";
    after_previous: "after_previous";
    since_last_hit: "since_last_hit";
    logistic_recent: "logistic_recent";
}>;
export type ForecastModel = z.infer<typeof ForecastModelSchema>;
export declare const ModelScoreSchema: z.ZodObject<{
    model: z.ZodEnum<{
        base_rate: "base_rate";
        rtp_reference: "rtp_reference";
        rolling_50: "rolling_50";
        after_previous: "after_previous";
        since_last_hit: "since_last_hit";
        logistic_recent: "logistic_recent";
    }>;
    usesRecentRounds: z.ZodBoolean;
    logLoss: z.ZodNumber;
    brier: z.ZodNumber;
    meanForecast: z.ZodNumber;
    observedRate: z.ZodNumber;
    calibrationZ: z.ZodNumber;
    calibrationP: z.ZodNullable<z.ZodNumber>;
    calibrated: z.ZodBoolean;
    skillVsBaseRate: z.ZodNullable<z.ZodNumber>;
    pValue: z.ZodNullable<z.ZodNumber>;
    permutationP: z.ZodNullable<z.ZodNumber>;
    validated: z.ZodBoolean;
}, z.core.$strip>;
export type ModelScore = z.infer<typeof ModelScoreSchema>;
export declare const ThresholdForecastSchema: z.ZodObject<{
    threshold: z.ZodNumber;
    status: z.ZodEnum<{
        validated_model: "validated_model";
        no_predictive_value: "no_predictive_value";
        not_calibrated: "not_calibrated";
        validated_model_not_current: "validated_model_not_current";
        insufficient_events: "insufficient_events";
    }>;
    testEvents: z.ZodNumber;
    selectedModel: z.ZodNullable<z.ZodEnum<{
        base_rate: "base_rate";
        rtp_reference: "rtp_reference";
        rolling_50: "rolling_50";
        after_previous: "after_previous";
        since_last_hit: "since_last_hit";
        logistic_recent: "logistic_recent";
    }>>;
    probability: z.ZodNullable<z.ZodNumber>;
    low: z.ZodNullable<z.ZodNumber>;
    high: z.ZodNullable<z.ZodNumber>;
    models: z.ZodArray<z.ZodObject<{
        model: z.ZodEnum<{
            base_rate: "base_rate";
            rtp_reference: "rtp_reference";
            rolling_50: "rolling_50";
            after_previous: "after_previous";
            since_last_hit: "since_last_hit";
            logistic_recent: "logistic_recent";
        }>;
        usesRecentRounds: z.ZodBoolean;
        logLoss: z.ZodNumber;
        brier: z.ZodNumber;
        meanForecast: z.ZodNumber;
        observedRate: z.ZodNumber;
        calibrationZ: z.ZodNumber;
        calibrationP: z.ZodNullable<z.ZodNumber>;
        calibrated: z.ZodBoolean;
        skillVsBaseRate: z.ZodNullable<z.ZodNumber>;
        pValue: z.ZodNullable<z.ZodNumber>;
        permutationP: z.ZodNullable<z.ZodNumber>;
        validated: z.ZodBoolean;
    }, z.core.$strip>>;
}, z.core.$strip>;
export type ThresholdForecast = z.infer<typeof ThresholdForecastSchema>;
export declare const ForecastSchema: z.ZodObject<{
    method: z.ZodLiteral<"walk_forward_v2">;
    status: z.ZodEnum<{
        insufficient_data: "insufficient_data";
        evaluated: "evaluated";
    }>;
    sampleSize: z.ZodNumber;
    minSampleSize: z.ZodNumber;
    trainInitial: z.ZodNumber;
    minTestRounds: z.ZodNumber;
    testRounds: z.ZodNumber;
    refitEvery: z.ZodNumber;
    segments: z.ZodNumber;
    gapSeconds: z.ZodNumber;
    comparisons: z.ZodNumber;
    alpha: z.ZodNumber;
    minEvents: z.ZodNumber;
    permutationMaxRounds: z.ZodNumber;
    thresholds: z.ZodArray<z.ZodObject<{
        threshold: z.ZodNumber;
        status: z.ZodEnum<{
            validated_model: "validated_model";
            no_predictive_value: "no_predictive_value";
            not_calibrated: "not_calibrated";
            validated_model_not_current: "validated_model_not_current";
            insufficient_events: "insufficient_events";
        }>;
        testEvents: z.ZodNumber;
        selectedModel: z.ZodNullable<z.ZodEnum<{
            base_rate: "base_rate";
            rtp_reference: "rtp_reference";
            rolling_50: "rolling_50";
            after_previous: "after_previous";
            since_last_hit: "since_last_hit";
            logistic_recent: "logistic_recent";
        }>>;
        probability: z.ZodNullable<z.ZodNumber>;
        low: z.ZodNullable<z.ZodNumber>;
        high: z.ZodNullable<z.ZodNumber>;
        models: z.ZodArray<z.ZodObject<{
            model: z.ZodEnum<{
                base_rate: "base_rate";
                rtp_reference: "rtp_reference";
                rolling_50: "rolling_50";
                after_previous: "after_previous";
                since_last_hit: "since_last_hit";
                logistic_recent: "logistic_recent";
            }>;
            usesRecentRounds: z.ZodBoolean;
            logLoss: z.ZodNumber;
            brier: z.ZodNumber;
            meanForecast: z.ZodNumber;
            observedRate: z.ZodNumber;
            calibrationZ: z.ZodNumber;
            calibrationP: z.ZodNullable<z.ZodNumber>;
            calibrated: z.ZodBoolean;
            skillVsBaseRate: z.ZodNullable<z.ZodNumber>;
            pValue: z.ZodNullable<z.ZodNumber>;
            permutationP: z.ZodNullable<z.ZodNumber>;
            validated: z.ZodBoolean;
        }, z.core.$strip>>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export type Forecast = z.infer<typeof ForecastSchema>;
