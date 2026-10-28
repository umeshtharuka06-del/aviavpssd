import {
  MULTIPLIER_RANGES,
  RANGE_COUNT,
  RANGE_STRATEGY_CONFIG,
  rangeHit,
  rangeIndex,
  targetHit,
  type RangeStrategyConfig,
  type RangeStrategyForecast,
  type StrategyPerformance,
} from '@aviator/contracts';
import type { RoundInput } from './models.js';

/**
 * Range state machine (contract RangeStrategyForecastSchema). An EXPERIMENTAL heuristic requested for
 * evaluation: it does not assume that low rounds make a high round due.
 *
 *   consecutiveLow   rounds below targetThreshold in a row, ending at the input boundary. A collection
 *                    break restarts it (rounds may be missing, so the true count is unknown).
 *   tracking         consecutiveLow < lowEntryCount (or the watch lapsed): the baseline distribution,
 *                    predicted range = its most likely range.
 *   watch            lowEntryCount ≤ consecutiveLow and the persistence rule holds
 *                    (maxWatchForecasts null, or fewer than that many watch forecasts so far):
 *                    predicted range = watchRange. A miss keeps the watch (the count grows by one);
 *                    a round ≥ targetThreshold resets the count, so the next forecast is tracking.
 *   probabilities    in the watch: the range frequencies of EARLIER rounds that were themselves played
 *                    during a watch, mixed with priorStrength pseudo-rounds of the baseline, once at
 *                    least minConditionalSample of them exist (basis "conditional", label
 *                    "experimental"); before that, the baseline as is (basis/label "baseline").
 *
 * Everything is a function of the rounds observed so far (oldest first), so the state needs no store
 * of its own: it is rebuilt from the stored rounds after a reload or restart, and recorded with every
 * forecast in the immutable ledger. Every round is observed exactly once per rebuild.
 */

export const STRATEGY_METHOD = 'range_state_machine_v1' as const;
export const NO_MULTIPLIER_REASON = 'The model estimates range probabilities only; it has no distribution inside a range, so no exact multiplier is defined.';

/** Ranges counted as reaching the threshold (their lower bound is at or above it). */
export const targetRanges = (threshold: number) => MULTIPLIER_RANGES.map((r, k) => (r.min >= threshold ? k : -1)).filter((k) => k >= 0);
export const targetProbabilityOf = (p: readonly number[], threshold: number) => targetRanges(threshold).reduce((a, k) => a + p[k]!, 0);
const argmax = (p: readonly number[]) => p.reduce((best, v, k) => (v > p[best]! ? k : best), 0);

export class RangeStrategyTracker {
  consecutiveLow = 0;
  /** Range counts of observed rounds that were played during a watch. */
  readonly conditionalCounts = new Array<number>(RANGE_COUNT).fill(0);
  conditionalN = 0;

  constructor(readonly config: RangeStrategyConfig = RANGE_STRATEGY_CONFIG) {
    if (targetRanges(config.targetThreshold).length === 0 || MULTIPLIER_RANGES[targetRanges(config.targetThreshold)[0]!]!.min !== config.targetThreshold) {
      throw new Error('targetThreshold must be the lower bound of a range');
    }
  }

  /** Whether a forecast issued after `low` consecutive low rounds is a watch forecast. */
  inWatch(low: number): boolean {
    const c = this.config;
    return low >= c.lowEntryCount && (c.maxWatchForecasts == null || low - c.lowEntryCount < c.maxWatchForecasts);
  }

  observe(r: RoundInput): void {
    if (r.breakBefore) this.consecutiveLow = 0;
    else if (this.inWatch(this.consecutiveLow)) {
      this.conditionalCounts[rangeIndex(r.multiplier)]!++;
      this.conditionalN++;
    }
    this.consecutiveLow = targetHit(r.multiplier, this.config.targetThreshold) ? 0 : this.consecutiveLow + 1;
  }

  /** The strategy's forecast for the next, unobserved round. `baseline` is the baseline model's vector. */
  forecast(baseline: readonly number[]): RangeStrategyForecast {
    const c = this.config;
    const low = this.consecutiveLow;
    const watch = this.inWatch(low);
    const p0 = targetProbabilityOf(baseline, c.targetThreshold);
    const n = this.conditionalN;
    const hits = targetRanges(c.targetThreshold).reduce((a, k) => a + this.conditionalCounts[k]!, 0);
    const conditional = watch && n >= c.minConditionalSample;
    const probabilities = conditional
      ? this.conditionalCounts.map((cnt, k) => (cnt + c.priorStrength * baseline[k]!) / (n + c.priorStrength))
      : [...baseline];
    return {
      method: STRATEGY_METHOD,
      config: { ...c },
      state: watch ? 'elevated_range_watch' : 'low_range_tracking',
      consecutiveLow: low,
      watchForecast: watch ? low - c.lowEntryCount + 1 : 0,
      watchLapsed: low >= c.lowEntryCount && !watch,
      targetThreshold: c.targetThreshold,
      predictedRange: watch ? c.watchRange : argmax(probabilities),
      probabilities,
      targetProbability: targetProbabilityOf(probabilities, c.targetThreshold),
      basis: conditional ? 'conditional' : 'baseline',
      label: conditional ? 'experimental' : 'baseline',
      conditionalSample: n,
      conditionalTargetHits: hits,
      differenceZ: n > 0 && p0 > 0 && p0 < 1 ? (hits / n - p0) / Math.sqrt((p0 * (1 - p0)) / n) : null,
      multiplierEstimate: null,
      multiplierEstimateReason: NO_MULTIPLIER_REASON,
    };
  }
}

/** Separate TARGET and RANGE results of a strategy forecast for an actual multiplier (numeric comparisons). */
export function strategyHits(s: RangeStrategyForecast, multiplier: number): { targetHit: boolean; strategyRangeHit: boolean } {
  return { targetHit: targetHit(multiplier, s.targetThreshold), strategyRangeHit: rangeHit(multiplier, s.predictedRange) };
}

/* ---------------------------------------------------------------- walk-forward scoring */

/** One scored forecast: the strategy record, the baseline vector issued with it, and the actual multiplier. */
export interface StrategyScore {
  strategy: RangeStrategyForecast;
  baseline: readonly number[];
  multiplier: number;
}

const Z95 = 1.959963984540054;
const clip = (p: number) => Math.min(1 - 1e-9, Math.max(1e-9, p));
const mean = (a: readonly number[]) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);

/** 95% Wilson score interval. */
export function wilson(hits: number, n: number): { n: number; hits: number; rate: number | null; low: number | null; high: number | null } {
  if (!n) return { n, hits, rate: null, low: null, high: null };
  const p = hits / n;
  const d = 1 + (Z95 * Z95) / n;
  const centre = (p + (Z95 * Z95) / (2 * n)) / d;
  const half = (Z95 * Math.sqrt((p * (1 - p)) / n + (Z95 * Z95) / (4 * n * n))) / d;
  return { n, hits, rate: p, low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}

export const RUN_BUCKETS = ['0-1', '2-4', '5-7', '8+'] as const;
export const bucketOf = (low: number): (typeof RUN_BUCKETS)[number] => (low <= 1 ? '0-1' : low <= 4 ? '2-4' : low <= 7 ? '5-7' : '8+');

function scoresOf(xs: readonly StrategyScore[]) {
  const ys = xs.map((x) => (targetHit(x.multiplier, x.strategy.targetThreshold) ? 1 : 0));
  const ps = xs.map((x) => x.strategy.targetProbability);
  const bs = xs.map((x) => targetProbabilityOf(x.baseline, x.strategy.targetThreshold));
  const hits = ys.reduce<number>((a, v) => a + v, 0);
  const bll = (p: readonly number[]) => p.map((v, i) => -(ys[i] ? Math.log(clip(v)) : Math.log(clip(1 - v))));
  return {
    ys,
    ps,
    bs,
    target: wilson(hits, xs.length),
    rangeHits: xs.filter((x) => rangeHit(x.multiplier, x.strategy.predictedRange)).length,
    baselineRangeHits: xs.filter((x) => rangeHit(x.multiplier, argmax(x.baseline))).length,
    targetBrier: mean(ps.map((v, i) => (v - ys[i]!) ** 2)),
    baselineTargetBrier: mean(bs.map((v, i) => (v - ys[i]!) ** 2)),
    targetLL: bll(ps),
    baselineTargetLL: bll(bs),
  };
}

/**
 * Strategy vs baseline on the SAME scored forecasts. Every probability was recorded before its round,
 * so these are walk-forward (out-of-sample) figures.
 */
export function strategyPerformanceOf(xs: readonly StrategyScore[]): StrategyPerformance {
  const s = scoresOf(xs);
  const diffs = s.targetLL.map((v, i) => v - s.baselineTargetLL[i]!);
  const dm = mean(diffs);
  let lo: number | null = null;
  let hi: number | null = null;
  if (dm != null && diffs.length >= 2) {
    const sd = Math.sqrt(diffs.reduce((a, v) => a + (v - dm) ** 2, 0) / (diffs.length - 1));
    lo = dm - (Z95 * sd) / Math.sqrt(diffs.length);
    hi = dm + (Z95 * sd) / Math.sqrt(diffs.length);
  }
  const range = xs.map((x) => rangeIndex(x.multiplier));
  const rll = (key: 'strategy' | 'baseline') => mean(xs.map((x, i) => -Math.log(clip((key === 'strategy' ? x.strategy.probabilities : x.baseline)[range[i]!]!))));
  const rbr = (key: 'strategy' | 'baseline') =>
    mean(xs.map((x, i) => (key === 'strategy' ? x.strategy.probabilities : x.baseline).reduce((a, v, k) => a + (v - (k === range[i] ? 1 : 0)) ** 2, 0)));
  return {
    eligible: xs.length,
    target: s.target,
    rangeHits: s.rangeHits,
    baselineRangeHits: s.baselineRangeHits,
    targetBrier: s.targetBrier,
    baselineTargetBrier: s.baselineTargetBrier,
    targetLogLoss: mean(s.targetLL),
    baselineTargetLogLoss: mean(s.baselineTargetLL),
    targetLogLossDiff: dm,
    targetLogLossDiffLow: lo,
    targetLogLossDiffHigh: hi,
    rangeLogLoss: rll('strategy'),
    baselineRangeLogLoss: rll('baseline'),
    rangeBrier: rbr('strategy') == null ? null : Math.min(2, rbr('strategy')!),
    baselineRangeBrier: rbr('baseline') == null ? null : Math.min(2, rbr('baseline')!),
    byRunLength: RUN_BUCKETS.map((bucket) => {
      const b = scoresOf(xs.filter((x) => bucketOf(x.strategy.consecutiveLow) === bucket));
      return {
        bucket,
        target: b.target,
        rangeHits: b.rangeHits,
        baselineRangeHits: b.baselineRangeHits,
        meanTargetProbability: mean(b.ps),
        meanBaselineTargetProbability: mean(b.bs),
        targetBrier: b.targetBrier,
        baselineTargetBrier: b.baselineTargetBrier,
      };
    }),
  };
}
