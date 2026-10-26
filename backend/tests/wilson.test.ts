import { describe, expect, it } from 'vitest';
import { wilsonInterval, Z_95 } from '../src/engine/wilson.js';

describe('wilsonInterval (95%)', () => {
  it('returns the full [0,1] range when there are no trials', () => {
    expect(wilsonInterval(0, 0)).toEqual({ low: 0, high: 1 });
  });

  it('pins the far bound exactly at 0 or 1 for all-fail / all-success', () => {
    expect(wilsonInterval(0, 10).low).toBe(0);
    expect(wilsonInterval(10, 10).high).toBe(1);
  });

  it('matches known Wilson values', () => {
    const zero = wilsonInterval(0, 10);
    expect(zero.high).toBeCloseTo(0.2775, 3);

    const all = wilsonInterval(10, 10);
    expect(all.low).toBeCloseTo(0.7225, 3);

    const half = wilsonInterval(5, 10);
    expect(half.low).toBeCloseTo(0.2366, 3);
    expect(half.high).toBeCloseTo(0.7634, 3);
  });

  it('is symmetric around 0.5 for count and total-count', () => {
    const a = wilsonInterval(3, 10);
    const b = wilsonInterval(7, 10);
    expect(a.low).toBeCloseTo(1 - b.high, 10);
    expect(a.high).toBeCloseTo(1 - b.low, 10);
  });

  it('stays within [0,1] and narrows as the sample grows', () => {
    const small = wilsonInterval(50, 100);
    const large = wilsonInterval(500, 1000);
    for (const iv of [small, large]) {
      expect(iv.low).toBeGreaterThanOrEqual(0);
      expect(iv.high).toBeLessThanOrEqual(1);
    }
    expect(large.high - large.low).toBeLessThan(small.high - small.low);
  });

  it('clamps out-of-range counts', () => {
    expect(wilsonInterval(-5, 10).low).toBe(0);
    expect(wilsonInterval(20, 10).high).toBe(1);
  });

  it('exposes the 95% z value', () => {
    expect(Z_95).toBeCloseTo(1.96, 2);
  });
});
