import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { rangeHit, rangeIndex, targetHit } from '@aviator/contracts';
import { describe, expect, it } from 'vitest';
import { RangeStrategyTracker, strategyHits } from '../src/engine/sequential/strategy.js';

/**
 * The live state machine against research/fixtures/watch_parity.json, the same hand-derived expectations the Python
 * reference (research/aviator_engine/strategy.py) is tested against. A failure here means the two have drifted.
 */
type Row = [number, boolean, boolean, boolean, 'T' | 'W', number, number, number];
interface Fixture {
  baseline: number[];
  boundaries: { m: number; range: number; ge2: boolean }[];
  initial: ['T' | 'W', number, number, number];
  cases: { name: string; rows: Row[] }[];
  conditional: {
    lows: number;
    multiplier: number;
    expected: { state: string; consecutiveLow: number; watchForecast: number; predictedRange: number; basis: string; conditionalSample: number; probabilities: number[]; targetProbability: number };
  };
}

const FIXTURE: Fixture = JSON.parse(readFileSync(fileURLToPath(new URL('../../research/fixtures/watch_parity.json', import.meta.url)), 'utf8'));
const STATE = { T: 'low_range_tracking', W: 'elevated_range_watch' } as const;
const BASE = FIXTURE.baseline;

describe('range state machine: parity with the Python reference fixture', () => {
  it('range boundaries and the 2.00× target', () => {
    for (const b of FIXTURE.boundaries) {
      expect(rangeIndex(b.m)).toBe(b.range);
      expect(rangeHit(b.m, b.range)).toBe(true);
      expect(targetHit(b.m, 2)).toBe(b.ge2);
    }
  });

  for (const c of FIXTURE.cases) {
    it(c.name, () => {
      const t = new RangeStrategyTracker();
      let f = t.forecast(BASE);
      const [s0, low0, wf0, pr0] = FIXTURE.initial;
      expect([f.state, f.consecutiveLow, f.watchForecast, f.predictedRange]).toEqual([STATE[s0], low0, wf0, pr0]);
      for (const [m, brk, th, rh, s, low, wf, pr] of c.rows) {
        expect(strategyHits(f, m), `hits for ${m}`).toEqual({ targetHit: th, strategyRangeHit: rh });
        t.observe({ multiplier: m, breakBefore: brk });
        f = t.forecast(BASE);
        expect([f.state, f.consecutiveLow, f.watchForecast, f.predictedRange], `after ${m}`).toEqual([STATE[s], low, wf, pr]);
        expect(f.targetThreshold).toBe(2);
      }
    });
  }

  it('conditional estimate after 30 rounds observed during WATCH', () => {
    const c = FIXTURE.conditional;
    const t = new RangeStrategyTracker();
    for (let i = 0; i < c.lows; i++) t.observe({ multiplier: c.multiplier, breakBefore: false });
    const f = t.forecast(BASE);
    expect(f).toMatchObject({
      state: c.expected.state,
      consecutiveLow: c.expected.consecutiveLow,
      watchForecast: c.expected.watchForecast,
      predictedRange: c.expected.predictedRange,
      basis: c.expected.basis,
      conditionalSample: c.expected.conditionalSample,
    });
    f.probabilities.forEach((p, k) => expect(p).toBeCloseTo(c.expected.probabilities[k]!, 12));
    expect(f.targetProbability).toBeCloseTo(c.expected.targetProbability, 12);
  });
});
