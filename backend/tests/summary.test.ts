import { DEFAULT_MIN_SAMPLE_SIZE, HistoricalSummarySchema } from '@aviator/contracts';
import { describe, expect, it } from 'vitest';
import { computeHistoricalSummary, isValidMultiplier, sufficiencyOf } from '../src/engine/summary.js';

const NOW = new Date('2026-01-01T12:00:00Z');

/** Newest first, one round every 10 s ending 30 s before NOW. */
const obs = (multipliers: number[]) => multipliers.map((m, i) => ({ multiplier: m, receivedAt: new Date(NOW.getTime() - 30_000 - i * 10_000) }));
const summary = (multipliers: number[], minSampleSize = 10) => computeHistoricalSummary(obs(multipliers), NOW, { minSampleSize });
const at = (s: ReturnType<typeof summary>, t: number) => s.thresholds.find((x) => x.threshold === t)!;

describe('computeHistoricalSummary — threshold frequencies', () => {
  // 12 rounds: 3 below 2×, 9 at or above 2×, 6 at or above 5×, 3 at or above 10×.
  const data = [1, 1.5, 1.99, 2, 3, 4.99, 5, 7, 9.99, 10, 20, 50];

  it('counts rounds at or above 2×, 5× and 10× over all valid rounds', () => {
    const s = summary(data);
    expect(s.sampleSize).toBe(12);
    expect(s.thresholds.map((t) => t.threshold)).toEqual([2, 5, 10]);
    expect(at(s, 2)).toEqual({ threshold: 2, count: 9, frequency: 9 / 12 });
    expect(at(s, 5)).toEqual({ threshold: 5, count: 6, frequency: 6 / 12 });
    expect(at(s, 10)).toEqual({ threshold: 10, count: 3, frequency: 3 / 12 });
  });

  it('treats a value exactly equal to the threshold as reaching it', () => {
    const s = summary([2, 5, 10]);
    expect(at(s, 2).count).toBe(3);
    expect(at(s, 5).count).toBe(2);
    expect(at(s, 10).count).toBe(1);
    expect(s.below2x.count).toBe(0);
  });

  it('frequencies are nested (≥10× ≤ ≥5× ≤ ≥2×) because the thresholds overlap', () => {
    const s = summary(data);
    expect(at(s, 10).count).toBeLessThanOrEqual(at(s, 5).count);
    expect(at(s, 5).count).toBeLessThanOrEqual(at(s, 2).count);
  });
});

describe('computeHistoricalSummary — combined indicator and average', () => {
  it('combined indicator = rounds below 2× / valid rounds, the exact complement of ≥2×', () => {
    const s = summary([1, 1.5, 1.99, 2, 3, 4.99, 5, 7, 9.99, 10, 20, 50]);
    expect(s.below2x).toEqual({ threshold: 2, count: 3, frequency: 3 / 12 });
    expect(s.below2x.count + at(s, 2).count).toBe(s.sampleSize);
    expect(s.below2x.frequency! + at(s, 2).frequency!).toBeCloseTo(1, 12);
  });

  it('is NOT the average of the three threshold frequencies', () => {
    const s = summary([1, 1.5, 1.99, 2, 3, 4.99, 5, 7, 9.99, 10, 20, 50]);
    const naiveAverage = (at(s, 2).frequency! + at(s, 5).frequency! + at(s, 10).frequency!) / 3;
    expect(s.below2x.frequency).not.toBeCloseTo(naiveAverage, 6);
  });

  it('historical average multiplier is the arithmetic mean of valid multipliers', () => {
    const s = summary([1, 2, 3, 4, 10]);
    expect(s.averageMultiplier).toBeCloseTo(4, 12);
  });
});

describe('computeHistoricalSummary — empty and insufficient data', () => {
  it('empty dataset: no_data, every ratio null (never zero)', () => {
    const s = summary([]);
    expect(s.sampleSize).toBe(0);
    expect(s.sufficiency).toBe('no_data');
    for (const t of s.thresholds) expect(t).toEqual({ threshold: t.threshold, count: 0, frequency: null });
    expect(s.below2x.frequency).toBeNull();
    expect(s.averageMultiplier).toBeNull();
    expect(s.latestRoundAt).toBeNull();
    expect(s.freshnessSeconds).toBeNull();
    expect(HistoricalSummarySchema.safeParse(s).success).toBe(true);
  });

  it('below the minimum sample size: collecting, with real counts and sample size', () => {
    const s = summary([1.2, 3, 12], 100);
    expect(s.sufficiency).toBe('collecting');
    expect(s.sampleSize).toBe(3);
    expect(s.minSampleSize).toBe(100);
    expect(at(s, 2).count).toBe(2);
  });

  it('at exactly the minimum sample size: sufficient', () => {
    expect(summary(Array(10).fill(2)).sufficiency).toBe('sufficient');
    expect(summary(Array(9).fill(2)).sufficiency).toBe('collecting');
  });

  it('uses the shared default minimum when none is configured', () => {
    expect(computeHistoricalSummary([], NOW).minSampleSize).toBe(DEFAULT_MIN_SAMPLE_SIZE);
    expect(sufficiencyOf(DEFAULT_MIN_SAMPLE_SIZE - 1, DEFAULT_MIN_SAMPLE_SIZE)).toBe('collecting');
    expect(sufficiencyOf(DEFAULT_MIN_SAMPLE_SIZE, DEFAULT_MIN_SAMPLE_SIZE)).toBe('sufficient');
  });
});

describe('computeHistoricalSummary — invalid values', () => {
  it('excludes NaN, ±Infinity and out-of-range values from every figure and counts them', () => {
    const s = summary([2, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0.5, 0, -3, 2_000_000, 1.5]);
    expect(s.sampleSize).toBe(2);
    expect(s.invalidExcluded).toBe(7);
    expect(at(s, 2)).toEqual({ threshold: 2, count: 1, frequency: 0.5 });
    expect(s.below2x).toEqual({ threshold: 2, count: 1, frequency: 0.5 });
    expect(s.averageMultiplier).toBeCloseTo(1.75, 12);
    expect(HistoricalSummarySchema.safeParse(s).success).toBe(true);
  });

  it('only invalid values → treated as no data', () => {
    const s = summary([Number.NaN, Number.POSITIVE_INFINITY]);
    expect(s.sampleSize).toBe(0);
    expect(s.sufficiency).toBe('no_data');
    expect(s.averageMultiplier).toBeNull();
  });

  it('isValidMultiplier bounds', () => {
    expect(isValidMultiplier(1)).toBe(true);
    expect(isValidMultiplier(1_000_000)).toBe(true);
    for (const v of [0.99, 1_000_001, Number.NaN, Infinity, -Infinity, '2', null, undefined]) expect(isValidMultiplier(v)).toBe(false);
  });

  it('identical multipliers from distinct rounds are all counted (rounds have no identity here)', () => {
    // De-duplication of re-sent rounds happens at ingestion (batchId / roundRef), not here.
    expect(summary([2, 2, 2]).sampleSize).toBe(3);
  });
});

describe('computeHistoricalSummary — freshness and shape', () => {
  it('latestRoundAt / freshness come from the newest valid round', () => {
    const s = summary([3, 4]);
    expect(s.latestRoundAt).toBe(new Date(NOW.getTime() - 30_000).toISOString());
    expect(s.freshnessSeconds).toBe(30);
  });

  it('always validates against the shared contract and is device-scoped/historical', () => {
    const s = summary([1, 2, 3, 40, 1_000_000]);
    expect(HistoricalSummarySchema.parse(s)).toEqual(s);
    expect(s.scope).toBe('device');
    expect(s.isHistoricalOnly).toBe(true);
  });
});
