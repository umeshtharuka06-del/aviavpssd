import {
  ANALYSIS_THRESHOLDS,
  ANALYSIS_WINDOW_SIZES,
  type AnalysisMetrics,
  type DataQuality,
  type ThresholdStat,
  type WindowMetrics,
} from '@aviator/contracts';
import { wilsonInterval } from './wilson.js';

/** Fewer than this many rounds (in total) → the device's data is reported as insufficient. */
export const MIN_ROUNDS_FOR_OK = 10;

/** Latest round older than this → the data is flagged stale (collection likely stopped). */
export const DEFAULT_STALE_SECONDS = 600;

export interface MetricObservation {
  multiplier: number;
  receivedAt: Date;
}

export interface MetricsOptions {
  staleSeconds?: number;
}

/**
 * Computes device-scoped empirical metrics from observed rounds.
 *
 * `observations` must be ordered NEWEST FIRST (as the analysis query returns them). "Last N"
 * windows take the most recent N rounds. Every figure is a description of past observed rounds;
 * none is a prediction. A round "reaches" a threshold when its recorded multiplier is >= the
 * threshold (so a value exactly equal to the threshold counts as reaching it).
 */
export function computeMetrics(observations: ReadonlyArray<MetricObservation>, now: Date, opts: MetricsOptions = {}): AnalysisMetrics {
  const staleSeconds = opts.staleSeconds ?? DEFAULT_STALE_SECONDS;
  const total = observations.length;
  const multipliers = observations.map((o) => o.multiplier);

  const latest = total > 0 ? observations[0]!.receivedAt : null;
  const freshnessSeconds = latest ? Math.max(0, Math.floor((now.getTime() - latest.getTime()) / 1000)) : null;
  const stale = freshnessSeconds != null && freshnessSeconds > staleSeconds;

  const quality: DataQuality = total < MIN_ROUNDS_FOR_OK ? 'insufficient_data' : stale ? 'stale' : 'ok';

  const windows: WindowMetrics[] = [
    ...ANALYSIS_WINDOW_SIZES.map((size) => windowMetrics(size, size, multipliers.slice(0, size))),
    windowMetrics('all', null, multipliers),
  ];

  return {
    scope: 'device',
    quality,
    totalRounds: total,
    latestRoundAt: latest ? latest.toISOString() : null,
    freshnessSeconds,
    stale,
    windows,
  };
}

function windowMetrics(
  window: WindowMetrics['window'],
  requestedSize: number | null,
  values: readonly number[],
): WindowMetrics {
  const n = values.length;
  const complete = requestedSize === null ? true : n >= requestedSize;
  if (n === 0) {
    return { window, requestedSize, sampleSize: 0, complete, mean: null, median: null, min: null, max: null, thresholds: [] };
  }
  const sorted = values.slice().sort((a, b) => a - b);
  const sum = values.reduce((acc, v) => acc + v, 0);
  const mean = sum / n;
  const median = n % 2 === 1 ? sorted[(n - 1) / 2]! : (sorted[n / 2 - 1]! + sorted[n / 2]!) / 2;

  const thresholds: ThresholdStat[] = [];
  for (const threshold of ANALYSIS_THRESHOLDS) {
    const atLeastCount = values.reduce((acc, v) => acc + (v >= threshold ? 1 : 0), 0);
    const belowCount = n - atLeastCount;
    thresholds.push(stat(threshold, 'at_least', atLeastCount, n));
    thresholds.push(stat(threshold, 'below', belowCount, n));
  }

  return { window, requestedSize, sampleSize: n, complete, mean, median, min: sorted[0]!, max: sorted[n - 1]!, thresholds };
}

function stat(threshold: number, direction: ThresholdStat['direction'], count: number, total: number): ThresholdStat {
  const ci = wilsonInterval(count, total);
  return { threshold, direction, count, total, proportion: total > 0 ? count / total : 0, ciLow: ci.low, ciHigh: ci.high };
}
