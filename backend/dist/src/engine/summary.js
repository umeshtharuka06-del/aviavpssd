import { ANALYSIS_THRESHOLDS, COMBINED_INDICATOR_THRESHOLD, DEFAULT_MIN_SAMPLE_SIZE, MAX_MULTIPLIER, MIN_MULTIPLIER, } from '@aviator/contracts';
/** A completed-round multiplier that may be counted: a finite number within the accepted bounds. */
export function isValidMultiplier(m) {
    return typeof m === 'number' && Number.isFinite(m) && m >= MIN_MULTIPLIER && m <= MAX_MULTIPLIER;
}
export function sufficiencyOf(sampleSize, minSampleSize) {
    if (sampleSize === 0)
        return 'no_data';
    return sampleSize < minSampleSize ? 'collecting' : 'sufficient';
}
/**
 * Descriptive summary of one device's observed rounds on one site (see the formulas in
 * @aviator/contracts analysis.ts). `observations` are ordered NEWEST FIRST. Invalid values
 * (NaN, ±Infinity, out of bounds) are excluded from every figure and counted separately. Every
 * ratio is null when no valid round exists — never a substituted zero.
 *
 * Nothing here is a prediction: thresholds overlap (every ≥10× round is also ≥5× and ≥2×), so the
 * three frequencies must not be averaged or combined into a "next round" probability.
 */
export function computeHistoricalSummary(observations, now, opts = {}) {
    const minSampleSize = opts.minSampleSize ?? DEFAULT_MIN_SAMPLE_SIZE;
    const valid = observations.filter((o) => isValidMultiplier(o.multiplier));
    const n = valid.length;
    const freq = (threshold, count) => ({ threshold, count, frequency: n > 0 ? count / n : null });
    const countWhere = (pred) => valid.reduce((acc, o) => acc + (pred(o.multiplier) ? 1 : 0), 0);
    const latest = valid[0]?.receivedAt ?? null;
    return {
        scope: 'device',
        sampleSize: n,
        minSampleSize,
        sufficiency: sufficiencyOf(n, minSampleSize),
        thresholds: ANALYSIS_THRESHOLDS.map((t) => freq(t, countWhere((m) => m >= t))),
        below2x: freq(COMBINED_INDICATOR_THRESHOLD, countWhere((m) => m < COMBINED_INDICATOR_THRESHOLD)),
        averageMultiplier: n > 0 ? valid.reduce((acc, o) => acc + o.multiplier, 0) / n : null,
        invalidExcluded: observations.length - n,
        latestRoundAt: latest ? latest.toISOString() : null,
        freshnessSeconds: latest ? Math.max(0, Math.floor((now.getTime() - latest.getTime()) / 1000)) : null,
        isHistoricalOnly: true,
    };
}
