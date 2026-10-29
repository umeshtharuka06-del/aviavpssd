import { DEFAULT_MIN_SAMPLE_SIZE, type Forecast, type HistoricalSummary } from '@aviator/contracts';
import { computeForecast, FORECAST_DEFAULTS } from './forecast.js';
import { computeHistoricalSummary, isValidMultiplier } from './summary.js';
import type { AnalysisInput, AnalysisOutput, AnalysisProvider } from './provider.js';
import { ENGINE_VERSION } from './sequential/engine.js';

const NOTICE =
  'Historical frequencies of this device\'s observed rounds within the retention window. ' +
  'Past results do not predict future outcomes. This is not a signal, prediction, or betting recommendation.';

const COLLECTING_NOTICE =
  'Collecting data — too few rounds observed yet for the figures to be well supported. ' +
  'Past results do not predict future outcomes.';

export interface StatisticalProviderOptions {
  /** Minimum valid rounds before the status is "ok" (server setting ANALYSIS_MIN_SAMPLE_SIZE). */
  minSampleSize?: number;
}

export class StatisticalAnalysisProvider implements AnalysisProvider {
  readonly kind = 'live' as const;
  /** Same label as the one recorded with every forecast, so the response and the ledger never disagree. */
  readonly version = ENGINE_VERSION;
  readonly isTestData = false;
  readonly supportsSignal = true;
  private readonly minSampleSize: number;
  /** Recent forecast results keyed by a fingerprint of the input rounds (identical input → identical result). */
  private readonly cache = new Map<string, Forecast>();

  constructor(opts: StatisticalProviderOptions = {}) {
    this.minSampleSize = opts.minSampleSize ?? DEFAULT_MIN_SAMPLE_SIZE;
  }

  async analyze(input: AnalysisInput): Promise<AnalysisOutput> {
    const summary = computeHistoricalSummary(input.observations, input.now, { minSampleSize: this.minSampleSize });
    const sufficient = summary.sufficiency === 'sufficient';
    return {
      status: sufficient ? 'ok' : 'insufficient_data',
      items: items(summary),
      summary,
      forecast: this.forecast(input.observations, input.now),
      notice: sufficient ? NOTICE : COLLECTING_NOTICE,
    };
  }

  /**
   * Forecast over the valid rounds, oldest first. The walk-forward run costs up to a few hundred
   * milliseconds at 5,000 rounds, so a result is reused while the input rounds are unchanged. Whether
   * the latest round is recent enough (see ForecastSchema) depends on `now`, so that is part of the key
   * as a stale/fresh flag.
   */
  forecast(observations: AnalysisInput['observations'], now: Date): Forecast {
    const rounds = observations.filter((o) => isValidMultiplier(o.multiplier)).reverse();
    const last = rounds[rounds.length - 1]?.receivedAt.getTime() ?? 0;
    const stale = last > 0 && now.getTime() - last > FORECAST_DEFAULTS.gapSeconds * 1000;
    let sum = 0;
    rounds.forEach((r, i) => (sum += r.multiplier * ((i % 97) + 1))); // order-sensitive checksum
    const key = `${rounds.length}:${rounds[0]?.receivedAt.getTime() ?? 0}:${last}:${sum.toFixed(2)}:${stale}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const result = computeForecast(rounds, { now });
    if (this.cache.size >= CACHE_ENTRIES) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(key, result);
    return result;
  }
}

const CACHE_ENTRIES = 256;

/**
 * Flat label/value list for older extension builds that do not read `summary`. Kept short and
 * mirrors the summary exactly; no figure is shown without its sample size.
 */
function items(s: HistoricalSummary): Array<{ label: string; value: string }> {
  const n = s.sampleSize;
  const list = [{ label: 'Valid rounds observed', value: n.toLocaleString('en-US') }];
  if (s.sufficiency !== 'sufficient') {
    list.push({ label: 'Status', value: `Collecting data (${n} of ${s.minSampleSize} rounds)` });
    return list;
  }
  for (const t of s.thresholds) list.push({ label: `Historical frequency ≥ ${t.threshold}×`, value: fmtFreq(t.count, n) });
  list.push({ label: 'Historical rounds below 2×', value: fmtFreq(s.below2x.count, n) });
  if (s.averageMultiplier != null) list.push({ label: 'Historical average multiplier', value: `${s.averageMultiplier.toFixed(2)}×` });
  return list;
}

function fmtFreq(count: number, n: number): string {
  return `${((count / n) * 100).toFixed(1)}% (${count.toLocaleString('en-US')} of ${n.toLocaleString('en-US')})`;
}
