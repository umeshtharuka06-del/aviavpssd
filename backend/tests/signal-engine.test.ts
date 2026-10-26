import { describe, expect, it } from 'vitest';
import { computeMetrics, DEFAULT_STALE_SECONDS, type MetricObservation } from '../src/engine/metrics.js';
import { computePatterns } from '../src/engine/trends.js';
import { buildSignalReport, CLASSIFY_MIN_RECENT } from '../src/engine/signal-engine.js';

const NOW = new Date('2026-01-01T12:00:00.000Z');

/** Observations NEWEST FIRST from a chronological list; the newest round is `latestAgeSec` old. */
function obs(chrono: number[], latestAgeSec = 0): MetricObservation[] {
  const n = chrono.length;
  return chrono.map((multiplier, i) => ({ multiplier, receivedAt: new Date(NOW.getTime() - (latestAgeSec + (n - 1 - i)) * 1000) })).reverse();
}

function report(chrono: number[], latestAgeSec = 0, siteId = 'devfixture') {
  const o = obs(chrono, latestAgeSec);
  return buildSignalReport(computeMetrics(o, NOW), computePatterns(o), siteId);
}

const cls = (r: ReturnType<typeof report>, threshold: number) => r.classifications.find((c) => c.threshold === threshold)!.classification;

describe('buildSignalReport', () => {
  it('reports scope, window sizes and a standing historical-only caveat', () => {
    const r = report(Array(60).fill(3));
    expect(r.scope).toEqual({ kind: 'device', siteId: 'devfixture' });
    expect(r.roundsAnalyzed).toBe(60);
    expect(r.windowSizes).toEqual([50, 100, 250, 500, 'all']);
    expect(r.isHistoricalOnly).toBe(true);
    expect(r.classifications.map((c) => c.threshold)).toEqual([2, 5, 10]);
    expect(r.limitations[0]).toMatch(/historical frequencies for this device only/i);
  });

  it('classifies insufficient_data when there are too few rounds overall', () => {
    const r = report([1, 2, 3, 4, 5]); // < 10
    expect(r.status).toBe('insufficient_data');
    for (const c of r.classifications) expect(c.classification).toBe('insufficient_data');
  });

  it('classifies insufficient_data per threshold when the recent window is below the minimum', () => {
    const r = report(Array(CLASSIFY_MIN_RECENT - 1).fill(3)); // 29 rounds: ok overall, but recent < 30
    expect(r.status).toBe('ok');
    for (const c of r.classifications) expect(c.classification).toBe('insufficient_data');
  });

  it('classifies elevated_vs_baseline when the recent interval sits entirely above baseline', () => {
    // oldest 150 below 2x, newest 50 at 3x → recent ≥2 rate is far above the overall rate
    const r = report([...Array(150).fill(1), ...Array(50).fill(3)]);
    expect(r.status).toBe('ok');
    expect(cls(r, 2)).toBe('elevated_vs_baseline');
    expect(cls(r, 5)).toBe('near_baseline'); // no 5x rounds anywhere → overlap at ~0
  });

  it('classifies reduced_vs_baseline when the recent interval sits entirely below baseline', () => {
    const r = report([...Array(150).fill(3), ...Array(50).fill(1)]);
    expect(cls(r, 2)).toBe('reduced_vs_baseline');
  });

  it('classifies near_baseline when recent and baseline intervals overlap', () => {
    // uniform mix, recent window statistically indistinguishable from the whole
    const unit = [1, 3, 1, 3, 1, 3, 1, 3, 1, 3];
    const r = report(Array.from({ length: 20 }, () => unit).flat()); // 200 rounds, alternating
    expect(cls(r, 2)).toBe('near_baseline');
  });

  it('classifies stale_or_unreliable when the latest round is old', () => {
    const r = report(Array(60).fill(3), DEFAULT_STALE_SECONDS + 60);
    expect(r.status).toBe('stale');
    for (const c of r.classifications) expect(c.classification).toBe('stale_or_unreliable');
  });

  it('carries recent-pattern warnings into limitations', () => {
    const r = report([1, 2, 3]); // small sample → warnings present
    expect(r.limitations.some((l) => /highly uncertain/i.test(l))).toBe(true);
  });
});
