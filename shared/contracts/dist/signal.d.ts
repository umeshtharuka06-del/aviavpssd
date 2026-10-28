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
        }, z.core.$strip>, z.ZodObject<{
            status: z.ZodLiteral<"void">;
            reason: z.ZodEnum<{
                gap: "gap";
                late: "late";
            }>;
            scoredAt: z.ZodISODateTime;
        }, z.core.$strip>], "status">;
    }, z.core.$strip>>;
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
}, z.core.$strip>;
export type NextRoundSignal = z.infer<typeof NextRoundSignalSchema>;
/** At most this many visible results are accepted as one backfill. */
export declare const MAX_BACKFILL_ROUNDS = 100;
