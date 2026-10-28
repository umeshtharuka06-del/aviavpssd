import { z } from 'zod';
/**
 * Multiplier ranges. Mutually exclusive and exhaustive over [1, ∞). A round with multiplier m is in
 * the range whose `min ≤ m < max` (the last range has no upper bound). Boundary values belong to
 * the HIGHER range: 2.00× is in "2.00×–4.99×", 5.00× in "5.00×–9.99×", 10.00× in "10.00× and above".
 * Multipliers are recorded with two decimals, so "1.99×" is the largest value of the first range.
 */
export declare const MULTIPLIER_RANGES: readonly [{
    readonly id: "r1";
    readonly label: "1.00×–1.99×";
    readonly min: 1;
    readonly max: 2;
}, {
    readonly id: "r2";
    readonly label: "2.00×–4.99×";
    readonly min: 2;
    readonly max: 5;
}, {
    readonly id: "r5";
    readonly label: "5.00×–9.99×";
    readonly min: 5;
    readonly max: 10;
}, {
    readonly id: "r10";
    readonly label: "10.00× and above";
    readonly min: 10;
    readonly max: null;
}];
export declare const RANGE_COUNT: 4;
/** Index into MULTIPLIER_RANGES for a valid multiplier (≥ 1). */
export declare function rangeIndex(m: number): number;
export declare function rangeHit(multiplier: number, range: number): boolean;
export declare function targetHit(multiplier: number, target: number): boolean;
/** Threshold events derived from a range distribution: P(≥2×) = r2+r5+r10, P(≥5×) = r5+r10, P(≥10×) = r10. */
export declare const SIGNAL_THRESHOLDS: readonly [2, 5, 10];
export declare function thresholdProbabilities(p: readonly number[]): {
    p2: number;
    p5: number;
    p10: number;
};
/** Rounds needed before the first (experimental) estimate is issued. */
export declare const SIGNAL_WARMUP_ROUNDS = 20;
/**
 * Models that produce a range distribution. `baseline` is the no-predictability reference;
 * the five candidates use recent rounds; `ensemble` is the Bayesian model average of all six.
 */
export declare const SIGNAL_MODELS: readonly ["baseline", "ewma", "markov", "streak", "logit", "changepoint", "ensemble"];
export declare const SignalModelSchema: z.ZodEnum<{
    baseline: "baseline";
    ewma: "ewma";
    markov: "markov";
    streak: "streak";
    logit: "logit";
    changepoint: "changepoint";
    ensemble: "ensemble";
}>;
export type SignalModel = z.infer<typeof SignalModelSchema>;
export declare const SIGNAL_CANDIDATES: readonly ["ewma", "markov", "streak", "logit", "changepoint"];
/**
 * warming_up     fewer than SIGNAL_WARMUP_ROUNDS valid rounds: no forecast
 * experimental   a forecast is issued, but no candidate is validated (the ensemble estimate is shown)
 * validated      a candidate met every rule in `rules` (its estimate is shown)
 * baseline_only  enough forecasts were scored and the ensemble did NOT beat the baseline: the
 *                baseline distribution is shown, labelled as not a predictive signal
 */
export declare const SignalStateSchema: z.ZodEnum<{
    validated: "validated";
    warming_up: "warming_up";
    experimental: "experimental";
    baseline_only: "baseline_only";
}>;
export type SignalState = z.infer<typeof SignalStateSchema>;
export declare const RangeProbabilitiesSchema: z.ZodArray<z.ZodNumber>;
/**
 * low_range_tracking     fewer than `lowEntryCount` consecutive rounds below the target: the baseline
 *                        distribution, its most likely range as the predicted range
 * elevated_range_watch   at least `lowEntryCount` consecutive rounds below the target (in one verified
 *                        run): the predicted range is `watchRange` and stays so after every miss, until
 *                        a round reaches the target, a collection break, or `maxWatchForecasts` forecasts
 * A run of low rounds does NOT make a high round due; the watch only selects which estimate is shown.
 */
export declare const STRATEGY_STATES: readonly ["low_range_tracking", "elevated_range_watch"];
export declare const StrategyStateSchema: z.ZodEnum<{
    low_range_tracking: "low_range_tracking";
    elevated_range_watch: "elevated_range_watch";
}>;
export type StrategyState = z.infer<typeof StrategyStateSchema>;
export declare const RangeStrategyConfigSchema: z.ZodObject<{
    targetThreshold: z.ZodNumber;
    lowEntryCount: z.ZodNumber;
    watchRange: z.ZodNumber;
    maxWatchForecasts: z.ZodNullable<z.ZodNumber>;
    minConditionalSample: z.ZodNumber;
    priorStrength: z.ZodNumber;
}, z.core.$strip>;
export type RangeStrategyConfig = z.infer<typeof RangeStrategyConfigSchema>;
/** Fixed before any evaluation (the user's specification); not tuned on data. */
export declare const RANGE_STRATEGY_CONFIG: RangeStrategyConfig;
export declare const RangeStrategyForecastSchema: z.ZodObject<{
    method: z.ZodLiteral<"range_state_machine_v1">;
    config: z.ZodObject<{
        targetThreshold: z.ZodNumber;
        lowEntryCount: z.ZodNumber;
        watchRange: z.ZodNumber;
        maxWatchForecasts: z.ZodNullable<z.ZodNumber>;
        minConditionalSample: z.ZodNumber;
        priorStrength: z.ZodNumber;
    }, z.core.$strip>;
    state: z.ZodEnum<{
        low_range_tracking: "low_range_tracking";
        elevated_range_watch: "elevated_range_watch";
    }>;
    consecutiveLow: z.ZodNumber;
    watchForecast: z.ZodNumber;
    watchLapsed: z.ZodBoolean;
    targetThreshold: z.ZodNumber;
    predictedRange: z.ZodNumber;
    probabilities: z.ZodArray<z.ZodNumber>;
    targetProbability: z.ZodNumber;
    basis: z.ZodEnum<{
        baseline: "baseline";
        conditional: "conditional";
    }>;
    label: z.ZodEnum<{
        baseline: "baseline";
        experimental: "experimental";
    }>;
    conditionalSample: z.ZodNumber;
    conditionalTargetHits: z.ZodNumber;
    differenceZ: z.ZodNullable<z.ZodNumber>;
    multiplierEstimate: z.ZodNull;
    multiplierEstimateReason: z.ZodString;
}, z.core.$strip>;
export type RangeStrategyForecast = z.infer<typeof RangeStrategyForecastSchema>;
export declare const StrategyBucketSchema: z.ZodObject<{
    bucket: z.ZodEnum<{
        "0-1": "0-1";
        "2-4": "2-4";
        "5-7": "5-7";
        "8+": "8+";
    }>;
    target: z.ZodObject<{
        n: z.ZodNumber;
        hits: z.ZodNumber;
        rate: z.ZodNullable<z.ZodNumber>;
        low: z.ZodNullable<z.ZodNumber>;
        high: z.ZodNullable<z.ZodNumber>;
    }, z.core.$strip>;
    rangeHits: z.ZodNumber;
    baselineRangeHits: z.ZodNumber;
    meanTargetProbability: z.ZodNullable<z.ZodNumber>;
    meanBaselineTargetProbability: z.ZodNullable<z.ZodNumber>;
    targetBrier: z.ZodNullable<z.ZodNumber>;
    baselineTargetBrier: z.ZodNullable<z.ZodNumber>;
}, z.core.$strip>;
export declare const StrategyPerformanceSchema: z.ZodObject<{
    eligible: z.ZodNumber;
    target: z.ZodObject<{
        n: z.ZodNumber;
        hits: z.ZodNumber;
        rate: z.ZodNullable<z.ZodNumber>;
        low: z.ZodNullable<z.ZodNumber>;
        high: z.ZodNullable<z.ZodNumber>;
    }, z.core.$strip>;
    rangeHits: z.ZodNumber;
    baselineRangeHits: z.ZodNumber;
    targetBrier: z.ZodNullable<z.ZodNumber>;
    baselineTargetBrier: z.ZodNullable<z.ZodNumber>;
    targetLogLoss: z.ZodNullable<z.ZodNumber>;
    baselineTargetLogLoss: z.ZodNullable<z.ZodNumber>;
    targetLogLossDiff: z.ZodNullable<z.ZodNumber>;
    targetLogLossDiffLow: z.ZodNullable<z.ZodNumber>;
    targetLogLossDiffHigh: z.ZodNullable<z.ZodNumber>;
    rangeLogLoss: z.ZodNullable<z.ZodNumber>;
    baselineRangeLogLoss: z.ZodNullable<z.ZodNumber>;
    rangeBrier: z.ZodNullable<z.ZodNumber>;
    baselineRangeBrier: z.ZodNullable<z.ZodNumber>;
    byRunLength: z.ZodArray<z.ZodObject<{
        bucket: z.ZodEnum<{
            "0-1": "0-1";
            "2-4": "2-4";
            "5-7": "5-7";
            "8+": "8+";
        }>;
        target: z.ZodObject<{
            n: z.ZodNumber;
            hits: z.ZodNumber;
            rate: z.ZodNullable<z.ZodNumber>;
            low: z.ZodNullable<z.ZodNumber>;
            high: z.ZodNullable<z.ZodNumber>;
        }, z.core.$strip>;
        rangeHits: z.ZodNumber;
        baselineRangeHits: z.ZodNumber;
        meanTargetProbability: z.ZodNullable<z.ZodNumber>;
        meanBaselineTargetProbability: z.ZodNullable<z.ZodNumber>;
        targetBrier: z.ZodNullable<z.ZodNumber>;
        baselineTargetBrier: z.ZodNullable<z.ZodNumber>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export type StrategyPerformance = z.infer<typeof StrategyPerformanceSchema>;
export declare const ForecastOutcomeSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    status: z.ZodLiteral<"pending">;
}, z.core.$strip>, z.ZodObject<{
    status: z.ZodLiteral<"scored">;
    roundId: z.ZodString;
    multiplier: z.ZodNumber;
    range: z.ZodNumber;
    scoredAt: z.ZodISODateTime;
    topRangeHit: z.ZodBoolean;
    logLoss: z.ZodNumber;
    baselineLogLoss: z.ZodNumber;
    brier: z.ZodNumber;
    targetHit: z.ZodOptional<z.ZodBoolean>;
    strategyRangeHit: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strip>, z.ZodObject<{
    status: z.ZodLiteral<"void">;
    reason: z.ZodEnum<{
        gap: "gap";
        late: "late";
    }>;
    scoredAt: z.ZodISODateTime;
}, z.core.$strip>], "status">;
export type ForecastOutcome = z.infer<typeof ForecastOutcomeSchema>;
/** Evidence that stood when a forecast was issued (recorded with it, never changed). */
export declare const IssueEvidenceSchema: z.ZodObject<{
    scored: z.ZodNumber;
    logLossDiff: z.ZodNullable<z.ZodNumber>;
    bestCandidate: z.ZodNullable<z.ZodEnum<{
        baseline: "baseline";
        ewma: "ewma";
        markov: "markov";
        streak: "streak";
        logit: "logit";
        changepoint: "changepoint";
        ensemble: "ensemble";
    }>>;
    bestLog10EValue: z.ZodNullable<z.ZodNumber>;
}, z.core.$strip>;
export type IssueEvidence = z.infer<typeof IssueEvidenceSchema>;
/** One immutable forecast for the round after `inputLastRoundId`. */
export declare const ForecastRecordSchema: z.ZodObject<{
    id: z.ZodString;
    issuedAt: z.ZodISODateTime;
    inputLastRoundId: z.ZodString;
    inputRounds: z.ZodNumber;
    engineVersion: z.ZodString;
    state: z.ZodEnum<{
        validated: "validated";
        experimental: "experimental";
        baseline_only: "baseline_only";
    }>;
    model: z.ZodEnum<{
        baseline: "baseline";
        ewma: "ewma";
        markov: "markov";
        streak: "streak";
        logit: "logit";
        changepoint: "changepoint";
        ensemble: "ensemble";
    }>;
    probabilities: z.ZodArray<z.ZodNumber>;
    baselineProbabilities: z.ZodArray<z.ZodNumber>;
    atIssue: z.ZodObject<{
        scored: z.ZodNumber;
        logLossDiff: z.ZodNullable<z.ZodNumber>;
        bestCandidate: z.ZodNullable<z.ZodEnum<{
            baseline: "baseline";
            ewma: "ewma";
            markov: "markov";
            streak: "streak";
            logit: "logit";
            changepoint: "changepoint";
            ensemble: "ensemble";
        }>>;
        bestLog10EValue: z.ZodNullable<z.ZodNumber>;
    }, z.core.$strip>;
    strategy: z.ZodOptional<z.ZodNullable<z.ZodObject<{
        method: z.ZodLiteral<"range_state_machine_v1">;
        config: z.ZodObject<{
            targetThreshold: z.ZodNumber;
            lowEntryCount: z.ZodNumber;
            watchRange: z.ZodNumber;
            maxWatchForecasts: z.ZodNullable<z.ZodNumber>;
            minConditionalSample: z.ZodNumber;
            priorStrength: z.ZodNumber;
        }, z.core.$strip>;
        state: z.ZodEnum<{
            low_range_tracking: "low_range_tracking";
            elevated_range_watch: "elevated_range_watch";
        }>;
        consecutiveLow: z.ZodNumber;
        watchForecast: z.ZodNumber;
        watchLapsed: z.ZodBoolean;
        targetThreshold: z.ZodNumber;
        predictedRange: z.ZodNumber;
        probabilities: z.ZodArray<z.ZodNumber>;
        targetProbability: z.ZodNumber;
        basis: z.ZodEnum<{
            baseline: "baseline";
            conditional: "conditional";
        }>;
        label: z.ZodEnum<{
            baseline: "baseline";
            experimental: "experimental";
        }>;
        conditionalSample: z.ZodNumber;
        conditionalTargetHits: z.ZodNumber;
        differenceZ: z.ZodNullable<z.ZodNumber>;
        multiplierEstimate: z.ZodNull;
        multiplierEstimateReason: z.ZodString;
    }, z.core.$strip>>>;
    outcome: z.ZodDiscriminatedUnion<[z.ZodObject<{
        status: z.ZodLiteral<"pending">;
    }, z.core.$strip>, z.ZodObject<{
        status: z.ZodLiteral<"scored">;
        roundId: z.ZodString;
        multiplier: z.ZodNumber;
        range: z.ZodNumber;
        scoredAt: z.ZodISODateTime;
        topRangeHit: z.ZodBoolean;
        logLoss: z.ZodNumber;
        baselineLogLoss: z.ZodNumber;
        brier: z.ZodNumber;
        targetHit: z.ZodOptional<z.ZodBoolean>;
        strategyRangeHit: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>, z.ZodObject<{
        status: z.ZodLiteral<"void">;
        reason: z.ZodEnum<{
            gap: "gap";
            late: "late";
        }>;
        scoredAt: z.ZodISODateTime;
    }, z.core.$strip>], "status">;
}, z.core.$strip>;
export type ForecastRecord = z.infer<typeof ForecastRecordSchema>;
export declare const ReliabilityBinSchema: z.ZodObject<{
    low: z.ZodNumber;
    high: z.ZodNumber;
    n: z.ZodNumber;
    meanForecast: z.ZodNullable<z.ZodNumber>;
    observedRate: z.ZodNullable<z.ZodNumber>;
}, z.core.$strip>;
export declare const ThresholdPerformanceSchema: z.ZodObject<{
    threshold: z.ZodNumber;
    events: z.ZodNumber;
    nonEvents: z.ZodNumber;
    status: z.ZodEnum<{
        ok: "ok";
        insufficient_evidence: "insufficient_evidence";
    }>;
    brier: z.ZodNullable<z.ZodNumber>;
    baselineBrier: z.ZodNullable<z.ZodNumber>;
    logLoss: z.ZodNullable<z.ZodNumber>;
    baselineLogLoss: z.ZodNullable<z.ZodNumber>;
    meanForecast: z.ZodNullable<z.ZodNumber>;
    observedRate: z.ZodNullable<z.ZodNumber>;
    calibrationZ: z.ZodNullable<z.ZodNumber>;
    reliability: z.ZodArray<z.ZodObject<{
        low: z.ZodNumber;
        high: z.ZodNumber;
        n: z.ZodNumber;
        meanForecast: z.ZodNullable<z.ZodNumber>;
        observedRate: z.ZodNullable<z.ZodNumber>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export type ThresholdPerformance = z.infer<typeof ThresholdPerformanceSchema>;
export declare const PerformanceSchema: z.ZodObject<{
    scored: z.ZodNumber;
    voided: z.ZodNumber;
    pending: z.ZodNumber;
    topRangeHitRate: z.ZodNullable<z.ZodNumber>;
    baselineTopRangeHitRate: z.ZodNullable<z.ZodNumber>;
    logLoss: z.ZodNullable<z.ZodNumber>;
    baselineLogLoss: z.ZodNullable<z.ZodNumber>;
    logLossDiff: z.ZodNullable<z.ZodNumber>;
    logLossDiffLow: z.ZodNullable<z.ZodNumber>;
    logLossDiffHigh: z.ZodNullable<z.ZodNumber>;
    brier: z.ZodNullable<z.ZodNumber>;
    baselineBrier: z.ZodNullable<z.ZodNumber>;
    rolling: z.ZodObject<{
        window: z.ZodNumber;
        n: z.ZodNumber;
        topRangeHitRate: z.ZodNullable<z.ZodNumber>;
        logLoss: z.ZodNullable<z.ZodNumber>;
        baselineLogLoss: z.ZodNullable<z.ZodNumber>;
        baselineTopRangeHitRate: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
        brier: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
        baselineBrier: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    }, z.core.$strip>;
    thresholds: z.ZodArray<z.ZodObject<{
        threshold: z.ZodNumber;
        events: z.ZodNumber;
        nonEvents: z.ZodNumber;
        status: z.ZodEnum<{
            ok: "ok";
            insufficient_evidence: "insufficient_evidence";
        }>;
        brier: z.ZodNullable<z.ZodNumber>;
        baselineBrier: z.ZodNullable<z.ZodNumber>;
        logLoss: z.ZodNullable<z.ZodNumber>;
        baselineLogLoss: z.ZodNullable<z.ZodNumber>;
        meanForecast: z.ZodNullable<z.ZodNumber>;
        observedRate: z.ZodNullable<z.ZodNumber>;
        calibrationZ: z.ZodNullable<z.ZodNumber>;
        reliability: z.ZodArray<z.ZodObject<{
            low: z.ZodNumber;
            high: z.ZodNumber;
            n: z.ZodNumber;
            meanForecast: z.ZodNullable<z.ZodNumber>;
            observedRate: z.ZodNullable<z.ZodNumber>;
        }, z.core.$strip>>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export type Performance = z.infer<typeof PerformanceSchema>;
export declare const ModelStandingSchema: z.ZodObject<{
    model: z.ZodEnum<{
        baseline: "baseline";
        ewma: "ewma";
        markov: "markov";
        streak: "streak";
        logit: "logit";
        changepoint: "changepoint";
        ensemble: "ensemble";
    }>;
    weight: z.ZodNullable<z.ZodNumber>;
    logLoss: z.ZodNullable<z.ZodNumber>;
    log10EValue: z.ZodNullable<z.ZodNumber>;
    validated: z.ZodBoolean;
}, z.core.$strip>;
export type ModelStanding = z.infer<typeof ModelStandingSchema>;
export declare const SignalRulesSchema: z.ZodObject<{
    warmupRounds: z.ZodNumber;
    minScoredForVerdict: z.ZodNumber;
    minScoredForValidation: z.ZodNumber;
    alpha: z.ZodNumber;
    candidates: z.ZodNumber;
    eValueThreshold: z.ZodNumber;
    minEvents: z.ZodNumber;
    gapSeconds: z.ZodNumber;
}, z.core.$strip>;
export type SignalRules = z.infer<typeof SignalRulesSchema>;
/**
 * Representative multiplier for the current forecast (stat-5.3+). The models forecast RANGES only;
 * none of them forecasts where inside a range the multiplier will land. So this is NOT a predicted
 * exact multiplier. It is the median of the recorded multipliers that fell in the forecast's most
 * likely range, over the rounds the forecast was built from (rounds up to its input boundary only).
 * It is the same kind of value before every round with the same top range, and it is not scored.
 * Unavailable (multiplier null) when fewer than REPRESENTATIVE_MIN_SAMPLE such rounds exist.
 */
export declare const REPRESENTATIVE_MIN_SAMPLE = 10;
export declare const RepresentativeEstimateSchema: z.ZodObject<{
    method: z.ZodLiteral<"top_range_conditional_median">;
    forecastId: z.ZodString;
    range: z.ZodNumber;
    multiplier: z.ZodNullable<z.ZodNumber>;
    low: z.ZodNullable<z.ZodNumber>;
    high: z.ZodNullable<z.ZodNumber>;
    sample: z.ZodNumber;
    inputRounds: z.ZodNumber;
    minSample: z.ZodNumber;
    unavailableReason: z.ZodNullable<z.ZodString>;
}, z.core.$strip>;
export type RepresentativeEstimate = z.infer<typeof RepresentativeEstimateSchema>;
export declare const NextRoundSignalSchema: z.ZodObject<{
    method: z.ZodLiteral<"sequential_v1">;
    state: z.ZodEnum<{
        validated: "validated";
        warming_up: "warming_up";
        experimental: "experimental";
        baseline_only: "baseline_only";
    }>;
    reason: z.ZodString;
    rounds: z.ZodNumber;
    currentRun: z.ZodOptional<z.ZodNumber>;
    longestRun: z.ZodOptional<z.ZodNumber>;
    liveRounds: z.ZodNumber;
    backfillRounds: z.ZodNumber;
    latestRoundAt: z.ZodNullable<z.ZodISODateTime>;
    current: z.ZodNullable<z.ZodObject<{
        id: z.ZodString;
        issuedAt: z.ZodISODateTime;
        inputLastRoundId: z.ZodString;
        inputRounds: z.ZodNumber;
        engineVersion: z.ZodString;
        state: z.ZodEnum<{
            validated: "validated";
            experimental: "experimental";
            baseline_only: "baseline_only";
        }>;
        model: z.ZodEnum<{
            baseline: "baseline";
            ewma: "ewma";
            markov: "markov";
            streak: "streak";
            logit: "logit";
            changepoint: "changepoint";
            ensemble: "ensemble";
        }>;
        probabilities: z.ZodArray<z.ZodNumber>;
        baselineProbabilities: z.ZodArray<z.ZodNumber>;
        atIssue: z.ZodObject<{
            scored: z.ZodNumber;
            logLossDiff: z.ZodNullable<z.ZodNumber>;
            bestCandidate: z.ZodNullable<z.ZodEnum<{
                baseline: "baseline";
                ewma: "ewma";
                markov: "markov";
                streak: "streak";
                logit: "logit";
                changepoint: "changepoint";
                ensemble: "ensemble";
            }>>;
            bestLog10EValue: z.ZodNullable<z.ZodNumber>;
        }, z.core.$strip>;
        strategy: z.ZodOptional<z.ZodNullable<z.ZodObject<{
            method: z.ZodLiteral<"range_state_machine_v1">;
            config: z.ZodObject<{
                targetThreshold: z.ZodNumber;
                lowEntryCount: z.ZodNumber;
                watchRange: z.ZodNumber;
                maxWatchForecasts: z.ZodNullable<z.ZodNumber>;
                minConditionalSample: z.ZodNumber;
                priorStrength: z.ZodNumber;
            }, z.core.$strip>;
            state: z.ZodEnum<{
                low_range_tracking: "low_range_tracking";
                elevated_range_watch: "elevated_range_watch";
            }>;
            consecutiveLow: z.ZodNumber;
            watchForecast: z.ZodNumber;
            watchLapsed: z.ZodBoolean;
            targetThreshold: z.ZodNumber;
            predictedRange: z.ZodNumber;
            probabilities: z.ZodArray<z.ZodNumber>;
            targetProbability: z.ZodNumber;
            basis: z.ZodEnum<{
                baseline: "baseline";
                conditional: "conditional";
            }>;
            label: z.ZodEnum<{
                baseline: "baseline";
                experimental: "experimental";
            }>;
            conditionalSample: z.ZodNumber;
            conditionalTargetHits: z.ZodNumber;
            differenceZ: z.ZodNullable<z.ZodNumber>;
            multiplierEstimate: z.ZodNull;
            multiplierEstimateReason: z.ZodString;
        }, z.core.$strip>>>;
        outcome: z.ZodDiscriminatedUnion<[z.ZodObject<{
            status: z.ZodLiteral<"pending">;
        }, z.core.$strip>, z.ZodObject<{
            status: z.ZodLiteral<"scored">;
            roundId: z.ZodString;
            multiplier: z.ZodNumber;
            range: z.ZodNumber;
            scoredAt: z.ZodISODateTime;
            topRangeHit: z.ZodBoolean;
            logLoss: z.ZodNumber;
            baselineLogLoss: z.ZodNumber;
            brier: z.ZodNumber;
            targetHit: z.ZodOptional<z.ZodBoolean>;
            strategyRangeHit: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$strip>, z.ZodObject<{
            status: z.ZodLiteral<"void">;
            reason: z.ZodEnum<{
                gap: "gap";
                late: "late";
            }>;
            scoredAt: z.ZodISODateTime;
        }, z.core.$strip>], "status">;
    }, z.core.$strip>>;
    representative: z.ZodOptional<z.ZodNullable<z.ZodObject<{
        method: z.ZodLiteral<"top_range_conditional_median">;
        forecastId: z.ZodString;
        range: z.ZodNumber;
        multiplier: z.ZodNullable<z.ZodNumber>;
        low: z.ZodNullable<z.ZodNumber>;
        high: z.ZodNullable<z.ZodNumber>;
        sample: z.ZodNumber;
        inputRounds: z.ZodNumber;
        minSample: z.ZodNumber;
        unavailableReason: z.ZodNullable<z.ZodString>;
    }, z.core.$strip>>>;
    changeProbability: z.ZodNullable<z.ZodNumber>;
    performance: z.ZodObject<{
        scored: z.ZodNumber;
        voided: z.ZodNumber;
        pending: z.ZodNumber;
        topRangeHitRate: z.ZodNullable<z.ZodNumber>;
        baselineTopRangeHitRate: z.ZodNullable<z.ZodNumber>;
        logLoss: z.ZodNullable<z.ZodNumber>;
        baselineLogLoss: z.ZodNullable<z.ZodNumber>;
        logLossDiff: z.ZodNullable<z.ZodNumber>;
        logLossDiffLow: z.ZodNullable<z.ZodNumber>;
        logLossDiffHigh: z.ZodNullable<z.ZodNumber>;
        brier: z.ZodNullable<z.ZodNumber>;
        baselineBrier: z.ZodNullable<z.ZodNumber>;
        rolling: z.ZodObject<{
            window: z.ZodNumber;
            n: z.ZodNumber;
            topRangeHitRate: z.ZodNullable<z.ZodNumber>;
            logLoss: z.ZodNullable<z.ZodNumber>;
            baselineLogLoss: z.ZodNullable<z.ZodNumber>;
            baselineTopRangeHitRate: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
            brier: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
            baselineBrier: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
        }, z.core.$strip>;
        thresholds: z.ZodArray<z.ZodObject<{
            threshold: z.ZodNumber;
            events: z.ZodNumber;
            nonEvents: z.ZodNumber;
            status: z.ZodEnum<{
                ok: "ok";
                insufficient_evidence: "insufficient_evidence";
            }>;
            brier: z.ZodNullable<z.ZodNumber>;
            baselineBrier: z.ZodNullable<z.ZodNumber>;
            logLoss: z.ZodNullable<z.ZodNumber>;
            baselineLogLoss: z.ZodNullable<z.ZodNumber>;
            meanForecast: z.ZodNullable<z.ZodNumber>;
            observedRate: z.ZodNullable<z.ZodNumber>;
            calibrationZ: z.ZodNullable<z.ZodNumber>;
            reliability: z.ZodArray<z.ZodObject<{
                low: z.ZodNumber;
                high: z.ZodNumber;
                n: z.ZodNumber;
                meanForecast: z.ZodNullable<z.ZodNumber>;
                observedRate: z.ZodNullable<z.ZodNumber>;
            }, z.core.$strip>>;
        }, z.core.$strip>>;
    }, z.core.$strip>;
    models: z.ZodArray<z.ZodObject<{
        model: z.ZodEnum<{
            baseline: "baseline";
            ewma: "ewma";
            markov: "markov";
            streak: "streak";
            logit: "logit";
            changepoint: "changepoint";
            ensemble: "ensemble";
        }>;
        weight: z.ZodNullable<z.ZodNumber>;
        logLoss: z.ZodNullable<z.ZodNumber>;
        log10EValue: z.ZodNullable<z.ZodNumber>;
        validated: z.ZodBoolean;
    }, z.core.$strip>>;
    history: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        issuedAt: z.ZodISODateTime;
        inputLastRoundId: z.ZodString;
        inputRounds: z.ZodNumber;
        engineVersion: z.ZodString;
        state: z.ZodEnum<{
            validated: "validated";
            experimental: "experimental";
            baseline_only: "baseline_only";
        }>;
        model: z.ZodEnum<{
            baseline: "baseline";
            ewma: "ewma";
            markov: "markov";
            streak: "streak";
            logit: "logit";
            changepoint: "changepoint";
            ensemble: "ensemble";
        }>;
        probabilities: z.ZodArray<z.ZodNumber>;
        baselineProbabilities: z.ZodArray<z.ZodNumber>;
        atIssue: z.ZodObject<{
            scored: z.ZodNumber;
            logLossDiff: z.ZodNullable<z.ZodNumber>;
            bestCandidate: z.ZodNullable<z.ZodEnum<{
                baseline: "baseline";
                ewma: "ewma";
                markov: "markov";
                streak: "streak";
                logit: "logit";
                changepoint: "changepoint";
                ensemble: "ensemble";
            }>>;
            bestLog10EValue: z.ZodNullable<z.ZodNumber>;
        }, z.core.$strip>;
        strategy: z.ZodOptional<z.ZodNullable<z.ZodObject<{
            method: z.ZodLiteral<"range_state_machine_v1">;
            config: z.ZodObject<{
                targetThreshold: z.ZodNumber;
                lowEntryCount: z.ZodNumber;
                watchRange: z.ZodNumber;
                maxWatchForecasts: z.ZodNullable<z.ZodNumber>;
                minConditionalSample: z.ZodNumber;
                priorStrength: z.ZodNumber;
            }, z.core.$strip>;
            state: z.ZodEnum<{
                low_range_tracking: "low_range_tracking";
                elevated_range_watch: "elevated_range_watch";
            }>;
            consecutiveLow: z.ZodNumber;
            watchForecast: z.ZodNumber;
            watchLapsed: z.ZodBoolean;
            targetThreshold: z.ZodNumber;
            predictedRange: z.ZodNumber;
            probabilities: z.ZodArray<z.ZodNumber>;
            targetProbability: z.ZodNumber;
            basis: z.ZodEnum<{
                baseline: "baseline";
                conditional: "conditional";
            }>;
            label: z.ZodEnum<{
                baseline: "baseline";
                experimental: "experimental";
            }>;
            conditionalSample: z.ZodNumber;
            conditionalTargetHits: z.ZodNumber;
            differenceZ: z.ZodNullable<z.ZodNumber>;
            multiplierEstimate: z.ZodNull;
            multiplierEstimateReason: z.ZodString;
        }, z.core.$strip>>>;
        outcome: z.ZodDiscriminatedUnion<[z.ZodObject<{
            status: z.ZodLiteral<"pending">;
        }, z.core.$strip>, z.ZodObject<{
            status: z.ZodLiteral<"scored">;
            roundId: z.ZodString;
            multiplier: z.ZodNumber;
            range: z.ZodNumber;
            scoredAt: z.ZodISODateTime;
            topRangeHit: z.ZodBoolean;
            logLoss: z.ZodNumber;
            baselineLogLoss: z.ZodNumber;
            brier: z.ZodNumber;
            targetHit: z.ZodOptional<z.ZodBoolean>;
            strategyRangeHit: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$strip>, z.ZodObject<{
            status: z.ZodLiteral<"void">;
            reason: z.ZodEnum<{
                gap: "gap";
                late: "late";
            }>;
            scoredAt: z.ZodISODateTime;
        }, z.core.$strip>], "status">;
    }, z.core.$strip>>;
    rules: z.ZodObject<{
        warmupRounds: z.ZodNumber;
        minScoredForVerdict: z.ZodNumber;
        minScoredForValidation: z.ZodNumber;
        alpha: z.ZodNumber;
        candidates: z.ZodNumber;
        eValueThreshold: z.ZodNumber;
        minEvents: z.ZodNumber;
        gapSeconds: z.ZodNumber;
    }, z.core.$strip>;
    strategyPerformance: z.ZodOptional<z.ZodObject<{
        eligible: z.ZodNumber;
        target: z.ZodObject<{
            n: z.ZodNumber;
            hits: z.ZodNumber;
            rate: z.ZodNullable<z.ZodNumber>;
            low: z.ZodNullable<z.ZodNumber>;
            high: z.ZodNullable<z.ZodNumber>;
        }, z.core.$strip>;
        rangeHits: z.ZodNumber;
        baselineRangeHits: z.ZodNumber;
        targetBrier: z.ZodNullable<z.ZodNumber>;
        baselineTargetBrier: z.ZodNullable<z.ZodNumber>;
        targetLogLoss: z.ZodNullable<z.ZodNumber>;
        baselineTargetLogLoss: z.ZodNullable<z.ZodNumber>;
        targetLogLossDiff: z.ZodNullable<z.ZodNumber>;
        targetLogLossDiffLow: z.ZodNullable<z.ZodNumber>;
        targetLogLossDiffHigh: z.ZodNullable<z.ZodNumber>;
        rangeLogLoss: z.ZodNullable<z.ZodNumber>;
        baselineRangeLogLoss: z.ZodNullable<z.ZodNumber>;
        rangeBrier: z.ZodNullable<z.ZodNumber>;
        baselineRangeBrier: z.ZodNullable<z.ZodNumber>;
        byRunLength: z.ZodArray<z.ZodObject<{
            bucket: z.ZodEnum<{
                "0-1": "0-1";
                "2-4": "2-4";
                "5-7": "5-7";
                "8+": "8+";
            }>;
            target: z.ZodObject<{
                n: z.ZodNumber;
                hits: z.ZodNumber;
                rate: z.ZodNullable<z.ZodNumber>;
                low: z.ZodNullable<z.ZodNumber>;
                high: z.ZodNullable<z.ZodNumber>;
            }, z.core.$strip>;
            rangeHits: z.ZodNumber;
            baselineRangeHits: z.ZodNumber;
            meanTargetProbability: z.ZodNullable<z.ZodNumber>;
            meanBaselineTargetProbability: z.ZodNullable<z.ZodNumber>;
            targetBrier: z.ZodNullable<z.ZodNumber>;
            baselineTargetBrier: z.ZodNullable<z.ZodNumber>;
        }, z.core.$strip>>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export type NextRoundSignal = z.infer<typeof NextRoundSignalSchema>;
/** At most this many visible results are accepted as one backfill. */
export declare const MAX_BACKFILL_ROUNDS = 100;
