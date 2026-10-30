import { NextRoundSignalSchema, RANGE_STRATEGY_CONFIG, RangeStrategyForecastSchema } from '@aviator/contracts';
import { describe, expect, it } from 'vitest';
import { buildSignal, issueForecast, recordOf, replay, strategyScoresOf, type LedgerEntry, type LedgerRound } from '../src/engine/sequential/engine.js';
import { asRounds, fairSequence, plantedRunSequence } from '../src/engine/sequential/simulate.js';
import { bucketOf, RangeStrategyTracker, strategyHits, strategyPerformanceOf } from '../src/engine/sequential/strategy.js';

const BASE = [0.515, 0.291, 0.097, 0.097];
const feed = (t: RangeStrategyTracker, ms: number[], breakAt = -1) => ms.forEach((m, i) => t.observe({ multiplier: m, breakBefore: i === breakAt }));
/** 20 warm-up rounds ending with a round ≥ 2×, so the low count starts at 0. */
const WARM = [...fairSequence(19, 7), 3.1];
const forecastAfter = (entries: LedgerEntry[], inputRounds: number) => entries.find((e) => e.forecast.inputRounds === inputRounds)!;

describe('range state machine: states', () => {
  it('four low rounds keep LOW-RANGE TRACKING; the fifth enters ELEVATED-RANGE WATCH', () => {
    const t = new RangeStrategyTracker();
    feed(t, [3, 1.2, 1.5, 1.01, 1.99]);
    let f = t.forecast(BASE);
    expect(f).toMatchObject({ state: 'low_range_tracking', consecutiveLow: 4, watchForecast: 0, predictedRange: 0, basis: 'baseline', label: 'baseline', targetThreshold: 2 });
    expect(f.probabilities).toEqual(BASE);
    t.observe({ multiplier: 1.3, breakBefore: false });
    f = t.forecast(BASE);
    expect(f).toMatchObject({ state: 'elevated_range_watch', consecutiveLow: 5, watchForecast: 1, predictedRange: 1, targetThreshold: 2 });
    expect(() => RangeStrategyForecastSchema.parse(f)).not.toThrow();
  });

  it('six, seven, … low rounds stay in the watch with the same target and range (persistence after misses)', () => {
    const t = new RangeStrategyTracker();
    feed(t, [1.1, 1.2, 1.3, 1.4, 1.5]);
    for (let k = 1; k <= 6; k++) {
      const f = t.forecast(BASE);
      expect(f).toMatchObject({ state: 'elevated_range_watch', consecutiveLow: 4 + k, watchForecast: k, predictedRange: 1, targetThreshold: 2 });
      t.observe({ multiplier: 1.6, breakBefore: false }); // a miss: below 2×
    }
  });

  it('a target hit resets the count and returns to tracking; a later run of five re-enters the watch', () => {
    const t = new RangeStrategyTracker();
    feed(t, [1.1, 1.2, 1.3, 1.4, 1.5, 1.7]);
    expect(t.forecast(BASE).state).toBe('elevated_range_watch');
    t.observe({ multiplier: 2.0, breakBefore: false });
    expect(t.forecast(BASE)).toMatchObject({ state: 'low_range_tracking', consecutiveLow: 0, watchForecast: 0 });
    feed(t, [1.9, 1.9, 1.9, 1.9]);
    expect(t.forecast(BASE).state).toBe('low_range_tracking');
    t.observe({ multiplier: 1.9, breakBefore: false });
    expect(t.forecast(BASE)).toMatchObject({ state: 'elevated_range_watch', consecutiveLow: 5, watchForecast: 1 });
  });

  it('a collection break restarts the count (rounds may be missing)', () => {
    const t = new RangeStrategyTracker();
    feed(t, [1.1, 1.2, 1.3, 1.4, 1.5, 1.6], 4);
    expect(t.forecast(BASE)).toMatchObject({ state: 'low_range_tracking', consecutiveLow: 2 });
  });

  it('the persistence rule is configurable: with maxWatchForecasts = 2 the watch lapses after two forecasts', () => {
    const t = new RangeStrategyTracker({ ...RANGE_STRATEGY_CONFIG, maxWatchForecasts: 2 });
    feed(t, [1.1, 1.1, 1.1, 1.1, 1.1]);
    expect(t.forecast(BASE)).toMatchObject({ state: 'elevated_range_watch', watchForecast: 1, watchLapsed: false });
    t.observe({ multiplier: 1.1, breakBefore: false });
    expect(t.forecast(BASE)).toMatchObject({ state: 'elevated_range_watch', watchForecast: 2 });
    t.observe({ multiplier: 1.1, breakBefore: false });
    expect(t.forecast(BASE)).toMatchObject({ state: 'low_range_tracking', watchForecast: 0, watchLapsed: true, consecutiveLow: 7, predictedRange: 0 });
    t.observe({ multiplier: 4, breakBefore: false });
    expect(t.forecast(BASE)).toMatchObject({ state: 'low_range_tracking', watchLapsed: false, consecutiveLow: 0 });
  });

  it('uses the baseline until enough earlier watch outcomes exist, then a labelled experimental conditional estimate', () => {
    const t = new RangeStrategyTracker({ ...RANGE_STRATEGY_CONFIG, minConditionalSample: 3 });
    feed(t, [1.1, 1.1, 1.1, 1.1, 1.1, 1.1, 2.5]); // watch outcomes: 1.1 (miss), 2.5 (hit)
    feed(t, [1.1, 1.1, 1.1, 1.1, 1.1]);
    let f = t.forecast(BASE);
    expect(f).toMatchObject({ basis: 'baseline', label: 'baseline', conditionalSample: 2, conditionalTargetHits: 1 });
    t.observe({ multiplier: 7, breakBefore: false }); // third watch outcome
    feed(t, [1.1, 1.1, 1.1, 1.1, 1.1]);
    f = t.forecast(BASE);
    expect(f).toMatchObject({ basis: 'conditional', label: 'experimental', conditionalSample: 3, conditionalTargetHits: 2 });
    // (counts + 20 × baseline) ÷ (3 + 20): counts are [1, 1, 1, 0]
    expect(f.probabilities[0]).toBeCloseTo((1 + 20 * BASE[0]!) / 23, 12);
    expect(f.probabilities.reduce((a, v) => a + v, 0)).toBeCloseTo(1, 12);
    expect(f.targetProbability).toBeCloseTo(f.probabilities[1]! + f.probabilities[2]! + f.probabilities[3]!, 12);
    expect(f.differenceZ).not.toBeNull();
  });

  it('never proposes an exact multiplier: the model has no distribution inside a range', () => {
    const t = new RangeStrategyTracker();
    expect(t.forecast(BASE)).toMatchObject({ multiplierEstimate: null });
  });
});

describe('TARGET HIT and RANGE HIT are separate (numeric comparisons)', () => {
  const t = new RangeStrategyTracker();
  feed(t, [1.1, 1.2, 1.3, 1.4, 1.5]);
  const watch = t.forecast(BASE); // target 2.00×, predicted range 2.00×–4.99×
  const cases: Array<[number, boolean, boolean]> = [
    // actual, target hit, range hit
    [1.99, false, false],
    [2.0, true, true],
    [2.4, true, true],
    [4.0, true, true],
    [4.99, true, true],
    [5.0, true, false], // above the predicted range: RANGE MISS but TARGET HIT
    [12.5, true, false],
  ];
  it.each(cases)('actual %s× → target hit %s, range hit %s', (m, target, range) => {
    expect(strategyHits(watch, m)).toEqual({ targetHit: target, strategyRangeHit: range });
  });
  it('float noise never moves a boundary', () => {
    expect(strategyHits(watch, 1.9999999999)).toEqual({ targetHit: true, strategyRangeHit: true });
    expect(strategyHits(watch, 4.9999999999)).toEqual({ targetHit: true, strategyRangeHit: false });
  });
});

describe('range state machine in the live process (replay = ledger)', () => {
  const rounds = asRounds([...WARM, 1.1, 1.2, 1.3, 1.4, 1.5, 1.8, 1.99, 5.0, 1.4, 2.4]);
  const { entries } = replay(rounds);

  it('every forecast records its state, low count, target, predicted range and probabilities; scored separately once', () => {
    const at = (n: number) => forecastAfter(entries, n);
    expect(at(24).forecast.strategy).toMatchObject({ state: 'low_range_tracking', consecutiveLow: 4 });
    expect(at(25).forecast.strategy).toMatchObject({ state: 'elevated_range_watch', consecutiveLow: 5, predictedRange: 1, targetThreshold: 2 });
    // 1.80×: miss → same target and range for the next forecast
    expect(recordOf(at(25)).outcome).toMatchObject({ status: 'scored', multiplier: 1.8, targetHit: false, strategyRangeHit: false });
    expect(at(26).forecast.strategy).toMatchObject({ state: 'elevated_range_watch', consecutiveLow: 6, watchForecast: 2, predictedRange: 1 });
    expect(recordOf(at(26)).outcome).toMatchObject({ multiplier: 1.99, targetHit: false, strategyRangeHit: false });
    // 5.00× after a 2.00×–4.99× forecast: TARGET HIT, RANGE MISS
    expect(at(27).forecast.strategy).toMatchObject({ state: 'elevated_range_watch', consecutiveLow: 7 });
    expect(recordOf(at(27)).outcome).toMatchObject({ multiplier: 5, targetHit: true, strategyRangeHit: false, topRangeHit: false });
    // reset after the hit
    expect(at(28).forecast.strategy).toMatchObject({ state: 'low_range_tracking', consecutiveLow: 0 });
    expect(at(29).forecast.strategy).toMatchObject({ state: 'low_range_tracking', consecutiveLow: 1 });
    // the last one is still open
    expect(at(30).outcome).toBeNull();
  });

  it('a service restart (forecast rebuilt from the stored rounds alone) gives the same state as the running process', () => {
    for (let n = 20; n <= rounds.length; n++) {
      const stored = rounds.slice(0, n);
      const rebuilt = issueForecast(stored, replay(stored).evidence, { engineVersion: 'x', issuedAt: new Date(0), id: 'fc_0000000000000000' }).forecast!;
      expect(rebuilt.strategy).toEqual(forecastAfter(entries, n).forecast.strategy);
    }
  });

  it('no look-ahead: changing later rounds never changes an earlier strategy forecast', () => {
    const fair = asRounds(fairSequence(400, 31));
    const t = 200;
    const changed: LedgerRound[] = fair.map((x, i) => (i >= t ? { ...x, multiplier: x.multiplier < 2 ? 50 : 1.01 } : x));
    const a = replay(fair).entries.filter((e) => e.forecast.inputRounds <= t);
    const b = replay(changed).entries.filter((e) => e.forecast.inputRounds <= t);
    expect(b.map((e) => e.forecast.strategy)).toEqual(a.map((e) => e.forecast.strategy));
  });

  it('the response matches the contract, with the walk-forward strategy record over scored forecasts', () => {
    const s = buildSignal(rounds, entries, null);
    expect(() => NextRoundSignalSchema.parse(s)).not.toThrow();
    const p = s.strategyPerformance!;
    expect(p.eligible).toBe(s.performance.scored);
    expect(p.byRunLength.reduce((a, b) => a + b.target.n, 0)).toBe(p.eligible);
    expect(s.current!.strategy).toMatchObject({ state: 'low_range_tracking', consecutiveLow: 0 });
  });
});

describe('walk-forward evaluation (SIMULATED rounds)', () => {
  it('scores the strategy and the baseline on the same forecasts, bucketed by the low count at issue', () => {
    const { entries } = replay(asRounds(fairSequence(1500, 41)));
    const xs = strategyScoresOf(entries);
    const p = strategyPerformanceOf(xs);
    expect(p.eligible).toBe(entries.filter((e) => e.outcome?.status === 'scored').length);
    for (const b of p.byRunLength) expect(b.target.n).toBe(xs.filter((x) => bucketOf(x.strategy.consecutiveLow) === b.bucket).length);
    // tracking forecasts are the baseline itself, so only buckets 5–7 and 8+ can differ
    const early = xs.filter((x) => x.strategy.consecutiveLow < 5);
    expect(early.every((x) => x.strategy.probabilities.every((v, k) => v === x.baseline[k]))).toBe(true);
    expect(p.target.low! <= p.target.rate! && p.target.rate! <= p.target.high!).toBe(true);
  });

  it('independent rounds: the watch shows no improvement in target log loss (interval contains 0) on 10 histories', () => {
    let containsZero = 0;
    for (let seed = 100; seed < 110; seed++) {
      const p = strategyPerformanceOf(strategyScoresOf(replay(asRounds(fairSequence(1200, seed))).entries));
      if (p.targetLogLossDiffLow! <= 0 && p.targetLogLossDiffHigh! >= 0) containsZero++;
    }
    expect(containsZero).toBeGreaterThanOrEqual(8);
  });

  it('a planted low-run effect is picked up by the conditional estimate (positive control)', () => {
    const { entries } = replay(asRounds(plantedRunSequence(4000, 5, 0.25)));
    const p = strategyPerformanceOf(strategyScoresOf(entries));
    const watch = p.byRunLength.find((b) => b.bucket === '5-7')!;
    expect(watch.target.n).toBeGreaterThan(50);
    expect(watch.target.low!).toBeGreaterThan(0.6);
    expect(watch.meanTargetProbability!).toBeGreaterThan(watch.meanBaselineTargetProbability!);
    expect(p.targetLogLossDiffHigh!).toBeLessThan(0);
  });
});
