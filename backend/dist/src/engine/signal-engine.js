/**
 * Signal engine — composes the empirical metrics (Phase 3) and recent-pattern comparisons
 * (Phase 4) into a single report with a DESCRIPTIVE, pre-defined classification.
 *
 * It introduces no new probability and no combined/weighted indicator. A classification states
 * only how a device's recent historical rate compares with its own baseline, using fixed rules
 * decided in advance (below). It is never a prediction of the next round and never advice to bet.
 */
/** A threshold is only classified once the recent window holds at least this many rounds. */
export const CLASSIFY_MIN_RECENT = 30;
const HISTORICAL_ONLY_CAVEAT = 'Figures are historical frequencies for this device only; they describe past rounds and are not forecasts of future rounds.';
export function buildSignalReport(metrics, patterns, siteId) {
    const classifications = patterns.comparisons.map((c) => classifyThreshold(c, metrics.quality));
    const limitations = [HISTORICAL_ONLY_CAVEAT, ...patterns.warnings].slice(0, 12);
    return {
        status: metrics.quality,
        scope: { kind: 'device', siteId },
        roundsAnalyzed: metrics.totalRounds,
        windowSizes: metrics.windows.map((w) => w.window),
        classifications,
        freshnessSeconds: metrics.freshnessSeconds,
        limitations,
        isHistoricalOnly: true,
    };
}
/**
 * Classifies one threshold's recent-vs-baseline comparison. Order of the fixed rules matters:
 * overall insufficiency and staleness are reported before any elevated/reduced/near label.
 */
export function classifyThreshold(c, quality) {
    let classification;
    if (quality === 'insufficient_data' || c.recent.total < CLASSIFY_MIN_RECENT) {
        classification = 'insufficient_data';
    }
    else if (quality === 'stale') {
        classification = 'stale_or_unreliable';
    }
    else if (c.recent.ciLow > c.baseline.ciHigh) {
        classification = 'elevated_vs_baseline'; // recent interval entirely above baseline
    }
    else if (c.recent.ciHigh < c.baseline.ciLow) {
        classification = 'reduced_vs_baseline'; // recent interval entirely below baseline
    }
    else {
        classification = 'near_baseline'; // intervals overlap → change not distinguishable from noise
    }
    return { threshold: c.threshold, direction: c.direction, classification, delta: c.delta, ciOverlap: c.ciOverlap };
}
