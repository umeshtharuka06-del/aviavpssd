import { describe, expect, it } from 'vitest';
import type { AnalysisMetrics, ThresholdDirection, WindowMetrics } from '@aviator/contracts';
import { computeMetrics, DEFAULT_STALE_SECONDS, type MetricObservation } from '../src/engine/metrics.js';

const NOW = new Date('2026-01-01T12:00:00.000Z');

/** Builds observations NEWEST FIRST, one round every `stepSec` seconds ending `ageSec` ago. */
function obs(multipliers: number[], { ageSec = 0, stepSec = 30 }: { ageSec?: number; stepSec?: number } = {}): MetricObservation[] {
  return multipliers.map((multiplier, i) => ({
    multiplier,
    receivedAt: new Date(NOW.getTime() - (ageSec + i * stepSec) * 1000),
  }));
}

const win = (m: AnalysisMetrics, w: WindowMetrics['window']) => m.windows.find((x) => x.window === w)!;
const thr = (w: WindowMetrics, threshold: number, direction: ThresholdDirection) =>
  w.thresholds.find((t) => t.threshold === threshold && t.direction === direction)!;

describe('computeMetrics', () => {
  it('reports empty history cleanly', () => {
    const m = computeMetrics([], NOW);
    expect(m.scope).toBe('device');
    expect(m.totalRounds).toBe(0);
    expect(m.quality).toBe('insufficient_data');
    expect(m.latestRoundAt).toBeNull();
    expect(m.freshnessSeconds).toBeNull();
    expect(m.stale).toBe(false);
    expect(m.windows).toHaveLength(5); // 50, 100, 250, 500, all
    for (const w of m.windows) {
      expect(w.sampleSize).toBe(0);
      expect(w.thresholds).toHaveLength(0);
      expect(w.mean).toBeNull();
    }
    expect(win(m, 50).complete).toBe(false);
    expect(win(m, 'all').complete).toBe(true);
  });

  it('counts a value exactly equal to the threshold as reaching it', () => {
    const m = computeMetrics(obs([2, 5, 10, 1.99, 4.99, 9.99]), NOW);
    const all = win(m, 'all');
    expect(thr(all, 2, 'at_least').count).toBe(5); // 2, 4.99, 5, 9.99, 10  (only 1.99 is below)
    expect(thr(all, 2, 'below').count).toBe(1); // 1.99
    expect(thr(all, 5, 'at_least').count).toBe(3); // 5, 9.99, 10
    expect(thr(all, 10, 'at_least').count).toBe(1); // 10
  });

  it('keeps thresholds nested-consistent and complementary over one denominator', () => {
    const m = computeMetrics(obs([1, 1.5, 2, 3, 5, 7, 10, 20, 1.2, 4]), NOW);
    const all = win(m, 'all');
    const n = all.sampleSize;
    for (const t of [2, 5, 10]) {
      const atLeast = thr(all, t, 'at_least');
      const below = thr(all, t, 'below');
      expect(atLeast.total).toBe(n);
      expect(below.total).toBe(n);
      expect(atLeast.count + below.count).toBe(n); // complementary
      expect(atLeast.proportion).toBeCloseTo(atLeast.count / n, 10);
    }
    // nesting: below2 <= below5 <= below10 ; atLeast10 <= atLeast5 <= atLeast2
    expect(thr(all, 2, 'below').count).toBeLessThanOrEqual(thr(all, 5, 'below').count);
    expect(thr(all, 5, 'below').count).toBeLessThanOrEqual(thr(all, 10, 'below').count);
    expect(thr(all, 10, 'at_least').count).toBeLessThanOrEqual(thr(all, 5, 'at_least').count);
    expect(thr(all, 5, 'at_least').count).toBeLessThanOrEqual(thr(all, 2, 'at_least').count);
  });

  it('marks a rolling window complete only at or above its exact size', () => {
    const exactly50 = computeMetrics(obs(Array(50).fill(3)), NOW);
    expect(win(exactly50, 50).sampleSize).toBe(50);
    expect(win(exactly50, 50).complete).toBe(true);
    expect(win(exactly50, 100).sampleSize).toBe(50);
    expect(win(exactly50, 100).complete).toBe(false);

    const just49 = computeMetrics(obs(Array(49).fill(3)), NOW);
    expect(win(just49, 50).sampleSize).toBe(49);
    expect(win(just49, 50).complete).toBe(false);

    const just51 = computeMetrics(obs(Array(51).fill(3)), NOW);
    expect(win(just51, 50).sampleSize).toBe(50); // window capped at its size
    expect(win(just51, 'all').sampleSize).toBe(51);
  });

  it('handles a window smaller than 50 rounds without claiming completeness', () => {
    const m = computeMetrics(obs(Array.from({ length: 12 }, (_, i) => 1 + i)), NOW);
    expect(m.totalRounds).toBe(12);
    expect(win(m, 50).sampleSize).toBe(12);
    expect(win(m, 50).complete).toBe(false);
    expect(win(m, 500).sampleSize).toBe(12);
    expect(win(m, 'all').sampleSize).toBe(12);
    expect(win(m, 'all').complete).toBe(true);
  });

  it('rolling windows take the MOST RECENT N rounds', () => {
    // newest 50 are 10x, older 70 are 1x
    const data = [...Array(50).fill(10), ...Array(70).fill(1)];
    const m = computeMetrics(obs(data), NOW);
    expect(m.totalRounds).toBe(120);
    expect(win(m, 50).sampleSize).toBe(50);
    expect(win(m, 50).complete).toBe(true);
    expect(win(m, 50).mean).toBe(10); // only the recent 10x rounds
    expect(win(m, 100).sampleSize).toBe(100);
    expect(win(m, 250).sampleSize).toBe(120);
    expect(win(m, 250).complete).toBe(false);
    expect(win(m, 'all').mean).toBeCloseTo((50 * 10 + 70 * 1) / 120, 10);
    expect(thr(win(m, 50), 10, 'at_least').count).toBe(50);
  });

  it('computes mean, median, min and max', () => {
    const m = computeMetrics(obs([1, 2, 3, 4]), NOW); // even count
    const all = win(m, 'all');
    expect(all.min).toBe(1);
    expect(all.max).toBe(4);
    expect(all.mean).toBeCloseTo(2.5, 10);
    expect(all.median).toBeCloseTo(2.5, 10); // (2+3)/2
    const odd = win(computeMetrics(obs([5, 1, 3]), NOW), 'all');
    expect(odd.median).toBe(3);
  });

  it('flags staleness from the latest round age', () => {
    const fresh = computeMetrics(obs(Array(10).fill(3), { ageSec: 10 }), NOW);
    expect(fresh.freshnessSeconds).toBe(10);
    expect(fresh.stale).toBe(false);
    expect(fresh.quality).toBe('ok');

    const old = computeMetrics(obs(Array(10).fill(3), { ageSec: DEFAULT_STALE_SECONDS + 60 }), NOW);
    expect(old.stale).toBe(true);
    expect(old.quality).toBe('stale');

    const custom = computeMetrics(obs(Array(10).fill(3), { ageSec: 120 }), NOW, { staleSeconds: 60 });
    expect(custom.stale).toBe(true);
  });

  it('latestRoundAt is the newest observation', () => {
    const m = computeMetrics(obs([2, 3, 4], { ageSec: 5, stepSec: 30 }), NOW);
    expect(m.latestRoundAt).toBe(new Date(NOW.getTime() - 5000).toISOString());
  });
});
