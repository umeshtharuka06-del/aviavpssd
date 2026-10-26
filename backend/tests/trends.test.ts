import { describe, expect, it } from 'vitest';
import { computePatterns, computeStreaks } from '../src/engine/trends.js';
import type { MetricObservation } from '../src/engine/metrics.js';

const NOW = new Date('2026-01-01T12:00:00.000Z');
/** Observations NEWEST FIRST from a chronological (oldest→newest) list. */
const obsFromChrono = (chrono: number[]): MetricObservation[] =>
  chrono
    .map((multiplier, i) => ({ multiplier, receivedAt: new Date(NOW.getTime() - (chrono.length - 1 - i) * 1000) }))
    .reverse();
const newestFirst = (chrono: number[]) => [...chrono].reverse();

describe('computeStreaks (low = multiplier < 2)', () => {
  it('counts maximal low runs and the trailing current streak', () => {
    // chronological: 1 1 H 1 1 1 H 1   (H = 3.0, not low)
    const s = computeStreaks(newestFirst([1, 1, 3, 1, 1, 1, 3, 1]), 2);
    expect(s.sampleSize).toBe(8);
    expect(s.lowCount).toBe(6);
    expect(s.longestStreak).toBe(3);
    expect(s.currentStreak).toBe(1); // most recent round is a single low
    expect(s.distribution).toEqual([
      { length: 1, occurrences: 1 },
      { length: 2, occurrences: 1 },
      { length: 3, occurrences: 1 },
    ]);
  });

  it('reports a zero current streak when the most recent round is not low', () => {
    const s = computeStreaks(newestFirst([1, 1, 3]), 2);
    expect(s.currentStreak).toBe(0);
    expect(s.longestStreak).toBe(2);
    expect(s.distribution).toEqual([{ length: 2, occurrences: 1 }]);
  });

  it('handles empty and all-low inputs', () => {
    expect(computeStreaks([], 2)).toMatchObject({ longestStreak: 0, currentStreak: 0, lowCount: 0, distribution: [] });
    const all = computeStreaks(newestFirst([1, 1.5, 1.9, 1.2]), 2);
    expect(all.longestStreak).toBe(4);
    expect(all.currentStreak).toBe(4);
  });
});

describe('computePatterns', () => {
  it('compares the recent window with the full baseline', () => {
    // 100 rounds: newest 50 are 1.0 (below 2), oldest 50 are 5.0 (>= 2)
    const chrono = [...Array(50).fill(5), ...Array(50).fill(1)];
    const p = computePatterns(obsFromChrono(chrono));
    expect(p.recentWindow).toBe(50);
    expect(p.baselineWindow).toBe('all');
    const at2 = p.comparisons.find((c) => c.threshold === 2)!;
    expect(at2.direction).toBe('at_least');
    expect(at2.recent.total).toBe(50);
    expect(at2.recent.count).toBe(0); // recent 50 are all 1.0
    expect(at2.baseline.total).toBe(100);
    expect(at2.baseline.count).toBe(50);
    expect(at2.delta).toBeCloseTo(-0.5, 10);
    expect(at2.ciOverlap).toBe(false); // clearly different periods
  });

  it('flags CI overlap and same-data when history is short', () => {
    const p = computePatterns(obsFromChrono([1, 2, 3, 4, 5, 6])); // 6 rounds < recent window
    const at2 = p.comparisons.find((c) => c.threshold === 2)!;
    expect(at2.recent.total).toBe(6);
    expect(at2.baseline.total).toBe(6);
    expect(at2.delta).toBe(0); // recent === baseline
    expect(at2.ciOverlap).toBe(true);
    expect(p.warnings.some((w) => /recent and baseline cover the same rounds/i.test(w))).toBe(true);
    expect(p.warnings.some((w) => /highly uncertain/i.test(w))).toBe(true);
  });

  it('bucketizes high multipliers over the full window', () => {
    const p = computePatterns(obsFromChrono([10, 15, 25, 60, 150, 1.5, 3]));
    const h = p.highMultipliers;
    expect(h.threshold).toBe(10);
    expect(h.total).toBe(7);
    expect(h.count).toBe(5); // 10,15,25,60,150
    expect(h.buckets.map((b) => b.count)).toEqual([2, 1, 1, 1]); // [10,20) [20,50) [50,100) [100,+)
    expect(h.buckets[3]!.ceil).toBeNull();
    expect(h.buckets[0]!.proportion).toBeCloseTo(2 / 7, 10);
  });

  it('warns that a current low streak does not change future odds', () => {
    const p = computePatterns(obsFromChrono([5, 6, 7, 8, 9, 10, 11, 12, 1.1, 1.2, 1.3]));
    expect(p.lowStreak.currentStreak).toBe(3);
    expect(p.warnings.some((w) => /do not make any outcome more or less likely next/i.test(w))).toBe(true);
  });
});
