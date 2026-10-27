import { DEFAULT_MIN_SAMPLE_SIZE, type HistoricalSummary } from '@aviator/contracts';
import { computeHistoricalSummary } from './summary.js';
import type { AnalysisInput, AnalysisOutput, AnalysisProvider } from './provider.js';

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
  readonly version = 'stat-2';
  readonly isTestData = false;
  private readonly minSampleSize: number;

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
      notice: sufficient ? NOTICE : COLLECTING_NOTICE,
    };
  }
}

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
