import {
  ANALYSIS_THRESHOLDS,
  HIGH_DISTRIBUTION_FLOORS,
  HIGH_MULTIPLIER_THRESHOLD,
  LOW_MULTIPLIER_THRESHOLD,
  RECENT_WINDOW,
  type HighMultiplierDistribution,
  type RecentPatterns,
  type StreakStats,
  type TrendComparison,
  type WindowRate,
} from '@aviator/contracts';
import { MIN_ROUNDS_FOR_OK, type MetricObservation } from './metrics.js';
import { wilsonInterval } from './wilson.js';

/**
 * Recent-pattern analysis: how a device's recent rounds compare with its longer baseline, how
 * often low rounds occur consecutively, and how high multipliers are distributed.
 *
 * `observations` must be NEWEST FIRST. Everything here is descriptive of past rounds. In
 * particular, streak counts never imply that a high (or low) round is "due" next.
 */
export function computePatterns(observations: ReadonlyArray<MetricObservation>): RecentPatterns {
  const values = observations.map((o) => o.multiplier);
  const total = values.length;
  const recent = values.slice(0, RECENT_WINDOW);

  const comparisons = ANALYSIS_THRESHOLDS.map((t) => comparison(t, recent, values));
  const lowStreak = computeStreaks(values, LOW_MULTIPLIER_THRESHOLD);
  const highMultipliers = highDistribution(values, HIGH_MULTIPLIER_THRESHOLD);

  const warnings: string[] = [];
  if (total === 0) {
    warnings.push('No rounds observed yet.');
  } else {
    if (total <= RECENT_WINDOW) warnings.push('Not enough history beyond the recent window; recent and baseline cover the same rounds.');
    if (total < MIN_ROUNDS_FOR_OK) warnings.push('Small sample: these figures are highly uncertain.');
    if (lowStreak.currentStreak > 0) warnings.push('Consecutive low rounds describe the past only and do not make any outcome more or less likely next.');
  }

  return { recentWindow: RECENT_WINDOW, baselineWindow: 'all', comparisons, lowStreak, highMultipliers, warnings };
}

function rate(window: WindowRate['window'], threshold: number, values: readonly number[]): WindowRate {
  const total = values.length;
  const count = values.reduce((acc, v) => acc + (v >= threshold ? 1 : 0), 0);
  const ci = wilsonInterval(count, total);
  return { window, count, total, proportion: total > 0 ? count / total : 0, ciLow: ci.low, ciHigh: ci.high };
}

function comparison(threshold: number, recent: readonly number[], all: readonly number[]): TrendComparison {
  const r = rate(RECENT_WINDOW, threshold, recent);
  const b = rate('all', threshold, all);
  // CIs overlap unless one lies entirely above the other.
  const ciOverlap = !(r.ciHigh < b.ciLow || b.ciHigh < r.ciLow);
  return { threshold, direction: 'at_least', recent: r, baseline: b, delta: r.proportion - b.proportion, ciOverlap };
}

/**
 * Counts maximal runs of consecutive low rounds in chronological order. Observations are passed
 * newest-first, so we reverse to walk oldest→newest; the run still open at the end is the run
 * ending at the most recent round (`currentStreak`).
 */
export function computeStreaks(valuesNewestFirst: readonly number[], threshold: number): StreakStats {
  const chrono = valuesNewestFirst.slice().reverse();
  const dist = new Map<number, number>();
  let run = 0;
  let longest = 0;
  let lowCount = 0;
  const finalize = (r: number) => {
    if (r > 0) {
      dist.set(r, (dist.get(r) ?? 0) + 1);
      if (r > longest) longest = r;
    }
  };
  for (const v of chrono) {
    if (v < threshold) {
      run++;
      lowCount++;
    } else {
      finalize(run);
      run = 0;
    }
  }
  finalize(run);
  const currentStreak = run; // trailing open run ends at the most recent round
  const distribution = [...dist.entries()].sort((a, b) => a[0] - b[0]).map(([length, occurrences]) => ({ length, occurrences }));
  return { threshold, window: 'all', sampleSize: valuesNewestFirst.length, lowCount, longestStreak: longest, currentStreak, distribution };
}

function highDistribution(values: readonly number[], threshold: number): HighMultiplierDistribution {
  const total = values.length;
  const count = values.reduce((acc, v) => acc + (v >= threshold ? 1 : 0), 0);
  const buckets = HIGH_DISTRIBUTION_FLOORS.map((floor, i) => {
    const ceil = i + 1 < HIGH_DISTRIBUTION_FLOORS.length ? HIGH_DISTRIBUTION_FLOORS[i + 1]! : null;
    const c = values.reduce((acc, v) => acc + (v >= floor && (ceil === null || v < ceil) ? 1 : 0), 0);
    return { floor, ceil, count: c, proportion: total > 0 ? c / total : 0 };
  });
  return { threshold, window: 'all', count, total, buckets };
}
