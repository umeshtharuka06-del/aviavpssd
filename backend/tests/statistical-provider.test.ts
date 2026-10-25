import { beforeAll, describe, expect, it } from 'vitest';
import { StatisticalAnalysisProvider } from '../src/engine/statistical-provider.js';
import type { AnalysisInput } from '../src/engine/provider.js';

const provider = new StatisticalAnalysisProvider();

function makeInput(multipliers: number[], spanMs = 3_600_000): AnalysisInput {
  const now = new Date('2026-01-01T12:00:00Z');
  const n = multipliers.length;
  return {
    siteId: 'devfixture',
    windowHours: 12,
    observations: multipliers.map((m, i) => ({
      multiplier: m,
      receivedAt: new Date(now.getTime() - (n > 1 ? (i * spanMs) / (n - 1) : 0)),
    })),
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
    expect(provider.version).toBe('stat-1');
    expect(provider.isTestData).toBe(false);
    expect(provider.version.length).toBeLessThanOrEqual(32);
  });

  it('returns insufficient_data for empty observations', async () => {
    const result = await provider.analyze(makeInput([]));
    expect(result.status).toBe('insufficient_data');
    expect(result.items).toHaveLength(1);
    expect(item(result.items, 'Observations in window')).toBe('0');
  });

  it('returns insufficient_data below threshold (5 obs)', async () => {
    const result = await provider.analyze(makeInput([1, 2, 3, 4, 5]));
    expect(result.status).toBe('insufficient_data');
    expect(item(result.items, 'Observations in window')).toBe('5');
  });

  it('returns insufficient_data just below threshold (9 obs)', async () => {
    const result = await provider.analyze(makeInput([1, 2, 3, 4, 5, 6, 7, 8, 9]));
    expect(result.status).toBe('insufficient_data');
    expect(item(result.items, 'Observations in window')).toBe('9');
  });

  it('returns ok at exactly the threshold (10 obs)', async () => {
    const result = await provider.analyze(makeInput([1, 1.5, 2, 2.5, 3, 5, 7.5, 10, 15, 50]));
    expect(result.status).toBe('ok');
    expect(result.items.length).toBe(14);
  });

  describe('known dataset: [1, 1.5, 2, 2.5, 3, 5, 7.5, 10, 15, 50]', () => {
    // n=10, sum=97.5, mean=9.75
    // sorted: [1, 1.5, 2, 2.5, 3, 5, 7.5, 10, 15, 50]
    // median (even n=10): (sorted[4]+sorted[5])/2 = (3+5)/2 = 4.00
    // variance = 1978.125/10 = 197.8125, std dev = sqrt(197.8125) ≈ 14.0646
    // q25: idx=2.25 → 2 + 0.5*0.25 = 2.125
    // q75: idx=6.75 → 7.5 + 2.5*0.75 = 9.375
    // under2: {1,1.5}=2, under5: {1,1.5,2,2.5,3}=5, under10: +{5,7.5}=7, >=10: {10,15,50}=3
    // mode bins: {1:2, 2:2, 3:1, 5:1, 7:1, 10:1, 15:1, 50:1} → tie → smallest → 1

    let items: Array<{ label: string; value: string }>;

    beforeAll(async () => {
      const result = await provider.analyze(makeInput([1, 1.5, 2, 2.5, 3, 5, 7.5, 10, 15, 50]));
      items = result.items;
    });

    it('sample size', () => expect(item(items, 'Rounds in window')).toBe('10'));
    it('time span', () => expect(item(items, 'Time span')).toBe('1 h 0 min'));
    it('mean', () => expect(item(items, 'Mean multiplier')).toBe('9.75×'));
    it('median', () => expect(item(items, 'Median multiplier')).toBe('4.00×'));
    it('minimum', () => expect(item(items, 'Minimum')).toBe('1.00×'));
    it('maximum', () => expect(item(items, 'Maximum')).toBe('50.00×'));

    it('std deviation', () => {
      const val = item(items, 'Std deviation');
      expect(val).toMatch(/^14\.0[6-7]×$/);
    });

    it('25th percentile', () => {
      const val = item(items, '25th percentile');
      expect(val).toMatch(/^2\.1[23]×$/);
    });

    it('75th percentile', () => {
      const val = item(items, '75th percentile');
      expect(val).toMatch(/^9\.3[78]×$/);
    });

    it('distribution: under 2×', () => expect(item(items, 'Rounds < 2×')).toBe('20.0% (2)'));
    it('distribution: under 5×', () => expect(item(items, 'Rounds < 5×')).toBe('50.0% (5)'));
    it('distribution: under 10×', () => expect(item(items, 'Rounds < 10×')).toBe('70.0% (7)'));
    it('distribution: 10× or above', () => expect(item(items, 'Rounds ≥ 10×')).toBe('30.0% (3)'));
    it('mode range', () => expect(item(items, 'Most common range')).toBe('1.00× – 1.99×'));
  });

  it('handles all identical multipliers', async () => {
    const result = await provider.analyze(makeInput(Array.from({ length: 100 }, () => 1)));
    expect(result.status).toBe('ok');
    expect(item(result.items, 'Mean multiplier')).toBe('1.00×');
    expect(item(result.items, 'Median multiplier')).toBe('1.00×');
    expect(item(result.items, 'Std deviation')).toBe('0.00×');
    expect(item(result.items, 'Minimum')).toBe('1.00×');
    expect(item(result.items, 'Maximum')).toBe('1.00×');
    expect(item(result.items, 'Rounds < 2×')).toBe('100.0% (100)');
    expect(item(result.items, 'Rounds ≥ 10×')).toBe('0.0% (0)');
  });

  it('handles single high outlier', async () => {
    const data = [...Array.from({ length: 99 }, () => 1), 1000];
    const result = await provider.analyze(makeInput(data));
    expect(result.status).toBe('ok');
    expect(item(result.items, 'Rounds in window')).toBe('100');
    expect(item(result.items, 'Mean multiplier')).toBe('10.99×');
    expect(item(result.items, 'Median multiplier')).toBe('1.00×');
    expect(item(result.items, 'Minimum')).toBe('1.00×');
    expect(item(result.items, 'Maximum')).toBe('1000.00×');
    expect(item(result.items, 'Rounds < 2×')).toBe('99.0% (99)');
    expect(item(result.items, 'Rounds ≥ 10×')).toBe('1.0% (1)');
  });

  it('handles large dataset (5000 observations) within timeout', async () => {
    const data = Array.from({ length: 5000 }, (_, i) => 1 + (i % 100) * 0.5);
    const start = Date.now();
    const result = await provider.analyze(makeInput(data));
    expect(Date.now() - start).toBeLessThan(1000);
    expect(result.status).toBe('ok');
    expect(item(result.items, 'Rounds in window')).toBe('5,000');
  });

  it('filters NaN and Infinity, falls back to insufficient_data if too few remain', async () => {
    const data = [NaN, Infinity, -Infinity, 1, 2, 3, 4, 5, 6, 7, 8, 9];
    const result = await provider.analyze(makeInput(data));
    // 3 filtered → 9 valid → below threshold
    expect(result.status).toBe('insufficient_data');
    expect(item(result.items, 'Observations in window')).toBe('9');
  });

  it('filters invalid values but analyzes if enough remain', async () => {
    const data = [NaN, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const result = await provider.analyze(makeInput(data));
    // 1 NaN filtered → 10 valid → at threshold
    expect(result.status).toBe('ok');
    expect(item(result.items, 'Rounds in window')).toBe('10');
  });

  it('filters values below 1 as invalid', async () => {
    const data = [0.5, 0.99, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const result = await provider.analyze(makeInput(data));
    // 2 below 1 filtered → 10 valid
    expect(result.status).toBe('ok');
    expect(item(result.items, 'Rounds in window')).toBe('10');
    expect(item(result.items, 'Minimum')).toBe('1.00×');
  });

  it('even-count median averages the two middle values', async () => {
    const data = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
    const result = await provider.analyze(makeInput(data));
    // n=12, sorted, median = (sorted[5]+sorted[6])/2 = (6+7)/2 = 6.5
    expect(item(result.items, 'Median multiplier')).toBe('6.50×');
  });

  it('odd-count median picks the middle value', async () => {
    const data = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
    const result = await provider.analyze(makeInput(data));
    // n=11, sorted, median = sorted[5] = 6
    expect(item(result.items, 'Median multiplier')).toBe('6.00×');
  });

  describe('time span formatting', () => {
    it('formats hours and minutes', async () => {
      const result = await provider.analyze(makeInput(
        Array.from({ length: 10 }, (_, i) => 1 + i),
        7 * 3_600_000 + 30 * 60_000, // 7h 30min
      ));
      expect(item(result.items, 'Time span')).toBe('7 h 30 min');
    });

    it('formats minutes only when under 1 hour', async () => {
      const result = await provider.analyze(makeInput(
        Array.from({ length: 10 }, (_, i) => 1 + i),
        45 * 60_000, // 45 min
      ));
      expect(item(result.items, 'Time span')).toBe('45 min');
    });

    it('shows < 1 min for very short spans', async () => {
      const result = await provider.analyze(makeInput(
        Array.from({ length: 10 }, (_, i) => 1 + i),
        30_000, // 30 seconds
      ));
      expect(item(result.items, 'Time span')).toBe('< 1 min');
    });
  });

  describe('contract constraints', () => {
    it('all items fit within schema limits', async () => {
      const result = await provider.analyze(makeInput(
        Array.from({ length: 5000 }, () => 1 + Math.random() * 999),
      ));
      expect(result.items.length).toBeLessThanOrEqual(20);
      for (const { label, value } of result.items) {
        expect(label.length).toBeLessThanOrEqual(80);
        expect(value.length).toBeLessThanOrEqual(80);
      }
      expect(result.notice.length).toBeLessThanOrEqual(400);
    });

    it('insufficient_data response also fits constraints', async () => {
      const result = await provider.analyze(makeInput([]));
      expect(result.items.length).toBeLessThanOrEqual(20);
      for (const { label, value } of result.items) {
        expect(label.length).toBeLessThanOrEqual(80);
        expect(value.length).toBeLessThanOrEqual(80);
      }
      expect(result.notice.length).toBeLessThanOrEqual(400);
    });
  });

  describe('no predictive language', () => {
    it('notice does not claim predictive power', async () => {
      const ok = await provider.analyze(makeInput(Array.from({ length: 20 }, (_, i) => 1 + i)));
      const insuf = await provider.analyze(makeInput([]));
      for (const result of [ok, insuf]) {
        expect(result.notice).not.toMatch(/guarantee/i);
        expect(result.notice).not.toMatch(/win rate/i);
        expect(result.notice).not.toMatch(/next round/i);
        expect(result.notice).not.toMatch(/confidence/i);
        expect(result.notice).not.toMatch(/probability/i);
        expect(result.notice).not.toMatch(/betting/i);
      }
    });

    it('items contain no predictive language', async () => {
      const result = await provider.analyze(makeInput(Array.from({ length: 20 }, (_, i) => 1 + i)));
      const json = JSON.stringify(result.items);
      expect(json).not.toMatch(/predict(ed|ion)?\s*[:=]/i);
      expect(json).not.toMatch(/accuracy|win rate|next round|guarantee|confidence score|betting/i);
    });
  });

  it('handles extreme multiplier (1,000,000)', async () => {
    const data = [...Array.from({ length: 9 }, () => 1), 1_000_000];
    const result = await provider.analyze(makeInput(data));
    expect(result.status).toBe('ok');
    expect(item(result.items, 'Maximum')).toBe('1,000,000×');
  });

  it('mode bucket clamps at 50 for large multipliers', async () => {
    const data = Array.from({ length: 10 }, () => 100);
    const result = await provider.analyze(makeInput(data));
    expect(item(result.items, 'Most common range')).toBe('50.00×+');
  });
});
