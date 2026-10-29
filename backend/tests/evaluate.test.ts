import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadFile, parseMicros } from '../src/engine/sequential/backtest.js';
import { breaksOf, isBreak, replay, runLengths, SIGNAL_RULES, type LedgerRound } from '../src/engine/sequential/engine.js';
import { bhAdjust, chi2Independence, chi2Sf, dependenceTests, holmAdjust, qualityOf, scoredRows } from '../src/engine/sequential/evaluate.js';
import { asRounds, fairSequence, plantedSequence } from '../src/engine/sequential/simulate.js';

describe('distribution helpers', () => {
  it('chi-square tail matches reference critical values', () => {
    expect(chi2Sf(3.841, 1)).toBeCloseTo(0.05, 3);
    expect(chi2Sf(18.307, 10)).toBeCloseTo(0.05, 4);
    expect(chi2Sf(40.113, 27)).toBeCloseTo(0.05, 4);
    expect(chi2Sf(0, 5)).toBe(1);
  });
  it('Holm and Benjamini–Hochberg adjustments', () => {
    expect(holmAdjust([0.01, 0.04, 0.03])).toEqual([0.03, 0.06, 0.06]);
    const bh = bhAdjust([0.01, 0.04, 0.03]);
    expect(bh.map((v) => +v.toFixed(4))).toEqual([0.03, 0.04, 0.04]);
  });
  it('independence test of a table with no association is not significant', () => {
    expect(chi2Independence([[50, 50], [50, 50]]).p).toBeCloseTo(1, 9);
    expect(chi2Independence([[90, 10], [10, 90]]).p).toBeLessThan(1e-10);
  });
});

describe('dependence tests', () => {
  it('find nothing on independent rounds and find a planted previous-round effect', () => {
    const fair = dependenceTests(asRounds(fairSequence(6000, 11)));
    expect(Math.min(...bhAdjust(fair.slice(0, 6).map((t) => t.p)))).toBeGreaterThan(0.05);
    const planted = dependenceTests(asRounds(plantedSequence(6000, 11, 0.08)));
    expect(planted[3]!.p).toBeLessThan(1e-4); // previous range → next range
  });
  it('form pairs only inside consecutive runs', () => {
    // alternating low/high inside runs of 2 would look perfectly dependent if pairs crossed breaks
    const rounds: LedgerRound[] = Array.from({ length: 400 }, (_, i) => ({
      id: String(i + 1),
      multiplier: i % 2 ? 3 : 1.5,
      receivedAt: new Date(i * 20_000),
      source: 'live',
      breakBefore: i % 2 === 0,
    }));
    expect(qualityOf(rounds)).toMatchObject({ runs: 200, longestRun: 2 });
    const markov = dependenceTests(rounds)[3]!;
    expect(markov.stat).toMatch(/df 0/); // every pair is (low → high): no variation to test
  });
});

describe('walk-forward comparison rows', () => {
  it('build every baseline only from rounds before the scored round', () => {
    const rounds = asRounds(fairSequence(300, 3));
    const r = replay(rounds);
    const rows = scoredRows(rounds, r.entries);
    expect(rows).toHaveLength(r.entries.filter((e) => e.outcome?.status === 'scored').length);
    // changing the last round changes no earlier row
    const changed = rounds.map((x, i) => (i === rounds.length - 1 ? { ...x, multiplier: 999 } : x));
    const rows2 = scoredRows(changed, replay(changed).entries);
    expect(rows2.slice(0, -1)).toEqual(rows.slice(0, -1));
    for (const row of rows) for (const p of Object.values(row.p)) expect(p.reduce((a, v) => a + v, 0)).toBeCloseTo(1, 9);
  });
});

describe('breaks and verified runs', () => {
  const at = (s: number, breakBefore?: boolean | null): LedgerRound => ({ id: String(s), multiplier: 2, receivedAt: new Date(s * 1000), source: 'live', breakBefore });
  it('continuity evidence overrides the time rule; without it the 120 s rule applies', () => {
    expect(isBreak(at(0), at(500, false))).toBe(false); // verified successor, delayed upload
    expect(isBreak(at(0), at(5, true))).toBe(true); // lost rounds without a time gap
    expect(isBreak(at(0), at(SIGNAL_RULES.gapSeconds + 1))).toBe(true);
    expect(isBreak(at(0), at(30, null))).toBe(false);
    expect(isBreak(at(10), at(5, false))).toBe(true); // out of order is always a break
  });
  it('run lengths and the verified-run warm-up', () => {
    expect(runLengths([true, false, false, true, false])).toEqual({ current: 2, longest: 3 });
    const rounds = asRounds(fairSequence(40, 5)).map((r, i) => ({ ...r, breakBefore: i === 0 || i === 15 }));
    const r = replay(rounds);
    expect(breaksOf(rounds).filter(Boolean)).toHaveLength(2);
    // the second run reaches 20 at round 35 (index 34): the first forecast is issued there
    expect(r.entries[0]!.forecast.inputRounds).toBe(35);
  });
});

describe('third-party file loader', () => {
  it('keeps microsecond order and starts a new run at catch-up bursts', () => {
    expect(parseMicros('2024-01-01 19:16:31.683961+00') - parseMicros('2024-01-01 19:16:31.683923+00')).toBe(38);
    const dir = mkdtempSync(join(tmpdir(), 'aviator-eval-'));
    const f = join(dir, 'p.csv');
    writeFileSync(
      f,
      ['created_at,app,payout', '"2024-01-01 10:00:40.000100+00","X","3.00"', '"2024-01-01 10:00:40.000050+00","X","1.50"', '"2024-01-01 10:00:20.000000+00","X","2.00"', '"2024-01-01 10:00:00.000000+00","X","1.20"'].join('\n'),
    );
    const s = loadFile(f, false).series[0]!;
    expect(s.rounds.map((r) => r.multiplier)).toEqual([1.2, 2, 1.5, 3]);
    expect(s.rounds.map((r) => r.breakBefore)).toEqual([true, false, false, true]);
  });
});
