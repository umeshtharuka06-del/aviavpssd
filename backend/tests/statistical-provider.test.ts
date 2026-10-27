import { DEFAULT_MIN_SAMPLE_SIZE } from '@aviator/contracts';
import { describe, expect, it } from 'vitest';
import { StatisticalAnalysisProvider } from '../src/engine/statistical-provider.js';
import type { AnalysisInput } from '../src/engine/provider.js';

const provider = new StatisticalAnalysisProvider({ minSampleSize: 10 });

function makeInput(multipliers: number[]): AnalysisInput {
  const now = new Date('2026-01-01T12:00:00Z');
  return {
    siteId: 'devfixture',
    windowHours: 12,
    observations: multipliers.map((m, i) => ({ multiplier: m, receivedAt: new Date(now.getTime() - i * 10_000) })),
    now,
  };
}

function item(items: Array<{ label: string; value: string }>, label: string): string {
  const found = items.find((i) => i.label === label);
  if (!found) throw new Error(`Item "${label}" not found in: ${items.map((i) => i.label).join(', ')}`);
  return found.value;
}

describe('StatisticalAnalysisProvider', () => {
  it('has correct metadata', () => {
    expect(provider.kind).toBe('live');
    expect(provider.version).toBe('stat-2');
    expect(provider.isTestData).toBe(false);
  });

  it('defaults to the shared minimum sample size', async () => {
    const r = await new StatisticalAnalysisProvider().analyze(makeInput([2]));
    expect(r.summary?.minSampleSize).toBe(DEFAULT_MIN_SAMPLE_SIZE);
  });

  it('empty: insufficient_data with a no_data summary', async () => {
    const r = await provider.analyze(makeInput([]));
    expect(r.status).toBe('insufficient_data');
    expect(r.summary?.sufficiency).toBe('no_data');
    expect(item(r.items, 'Valid rounds observed')).toBe('0');
  });

  it('below the minimum: insufficient_data, collecting, no percentages in the legacy items', async () => {
    const r = await provider.analyze(makeInput([1, 2, 3, 4, 5, 6, 7, 8, 9]));
    expect(r.status).toBe('insufficient_data');
    expect(r.summary?.sufficiency).toBe('collecting');
    expect(item(r.items, 'Status')).toBe('Collecting data (9 of 10 rounds)');
    expect(JSON.stringify(r.items)).not.toMatch(/%/);
  });

  it('at the minimum: ok, with the short legacy item list mirroring the summary', async () => {
    const r = await provider.analyze(makeInput([1, 1.5, 2, 2.5, 3, 5, 7.5, 10, 15, 50]));
    expect(r.status).toBe('ok');
    expect(r.summary?.sufficiency).toBe('sufficient');
    expect(r.items.map((i) => i.label)).toEqual([
      'Valid rounds observed',
      'Historical frequency ≥ 2×',
      'Historical frequency ≥ 5×',
      'Historical frequency ≥ 10×',
      'Historical rounds below 2×',
      'Historical average multiplier',
    ]);
    expect(item(r.items, 'Historical frequency ≥ 2×')).toBe('80.0% (8 of 10)');
    expect(item(r.items, 'Historical frequency ≥ 5×')).toBe('50.0% (5 of 10)');
    expect(item(r.items, 'Historical frequency ≥ 10×')).toBe('30.0% (3 of 10)');
    expect(item(r.items, 'Historical rounds below 2×')).toBe('20.0% (2 of 10)');
    expect(item(r.items, 'Historical average multiplier')).toBe('9.75×');
  });

  it('invalid values are excluded before the minimum is checked', async () => {
    const r = await provider.analyze(makeInput([NaN, Infinity, -Infinity, 1, 2, 3, 4, 5, 6, 7, 8, 9]));
    expect(r.status).toBe('insufficient_data');
    expect(r.summary?.sampleSize).toBe(9);
    expect(r.summary?.invalidExcluded).toBe(3);
  });

  it('handles 5000 observations quickly and within the contract limits', async () => {
    const data = Array.from({ length: 5000 }, (_, i) => 1 + (i % 100) * 0.5);
    const start = Date.now();
    const r = await provider.analyze(makeInput(data));
    expect(Date.now() - start).toBeLessThan(1000);
    expect(item(r.items, 'Valid rounds observed')).toBe('5,000');
    expect(r.items.length).toBeLessThanOrEqual(20);
    for (const { label, value } of r.items) {
      expect(label.length).toBeLessThanOrEqual(80);
      expect(value.length).toBeLessThanOrEqual(80);
    }
    expect(r.notice.length).toBeLessThanOrEqual(400);
  });

  it('never claims predictive power', async () => {
    for (const r of [await provider.analyze(makeInput(Array.from({ length: 20 }, (_, i) => 1 + i))), await provider.analyze(makeInput([]))]) {
      expect(r.notice).toMatch(/Past results do not predict future outcomes/);
      expect(r.notice).not.toMatch(/guarantee|win rate|next round|probability|accuracy/i);
      expect(JSON.stringify(r.items)).not.toMatch(/predict|accuracy|win rate|next round|guarantee|probability|betting/i);
    }
  });
});
