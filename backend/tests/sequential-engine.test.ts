import { NextRoundSignalSchema, rangeIndex, SIGNAL_WARMUP_ROUNDS, thresholdProbabilities } from '@aviator/contracts';
import { describe, expect, it } from 'vitest';
import {
  breaksOf,
  buildSignal,
  decide,
  Evidence,
  evidenceOf,
  issueForecast,
  replay,
  resolve,
  SIGNAL_RULES,
  topRange,
  type LedgerRound,
} from '../src/engine/sequential/engine.js';
import { createModelSet, RTP_REFERENCE } from '../src/engine/sequential/models.js';
import { asRounds, fairSequence, plantedSequence, prng } from '../src/engine/sequential/simulate.js';
import { alignBackfill } from '../src/ingestion/backfill.js';

const sum = (a: readonly number[]) => a.reduce((s, v) => s + v, 0);

describe('multiplier ranges', () => {
  it('puts boundary values in the higher range', () => {
    expect([1, 1.99, 2, 4.99, 5, 9.99, 10, 12345].map(rangeIndex)).toEqual([0, 0, 1, 1, 2, 2, 3, 3]);
  });
  it('derives threshold chances from the range distribution', () => {
    expect(thresholdProbabilities([0.5, 0.3, 0.1, 0.1])).toEqual({ p2: 0.5, p5: 0.2, p10: 0.1 });
  });
  it('RTP reference sums to 1 and matches 0.97 ÷ m', () => {
    expect(sum(RTP_REFERENCE)).toBeCloseTo(1, 12);
    expect(thresholdProbabilities(RTP_REFERENCE).p2).toBeCloseTo(0.485, 12);
    expect(thresholdProbabilities(RTP_REFERENCE).p10).toBeCloseTo(0.097, 12);
  });
});

describe('round-by-round replay (the live process)', () => {
  const rounds = asRounds(fairSequence(400, 11));
  const r = replay(rounds);

  it(`issues the first forecast after ${SIGNAL_WARMUP_ROUNDS} rounds, then exactly one per round`, () => {
    expect(r.entries.length).toBe(rounds.length - SIGNAL_WARMUP_ROUNDS + 1);
    expect(r.entries[0]!.forecast.inputRounds).toBe(SIGNAL_WARMUP_ROUNDS);
    expect(r.entries[0]!.forecast.inputLastRoundId).toBe(rounds[SIGNAL_WARMUP_ROUNDS - 1]!.id);
    expect(new Set(r.entries.map((e) => e.forecast.inputLastRoundId)).size).toBe(r.entries.length);
  });

  it('scores every forecast with the round right after its input, except the open one', () => {
    r.entries.slice(0, -1).forEach((e, i) => {
      expect(e.outcome?.status).toBe('scored');
      const next = rounds[SIGNAL_WARMUP_ROUNDS + i]!;
      expect(e.outcome).toMatchObject({ roundId: next.id, multiplier: next.multiplier, range: rangeIndex(next.multiplier) });
    });
    expect(r.entries.at(-1)!.outcome).toBeNull();
  });

  it('every distribution is a valid probability vector, and the shown one is a recorded model vector', () => {
    for (const e of r.entries) {
      for (const v of Object.values(e.forecast.vectors)) {
        expect(v).toHaveLength(4);
        expect(sum(v)).toBeCloseTo(1, 9);
        expect(Math.min(...v)).toBeGreaterThan(0);
      }
      expect(e.forecast.probabilities).toEqual(e.forecast.vectors[e.forecast.model]);
    }
  });

  it('a forecast never depends on its own round or any later round (no look-ahead)', () => {
    const t = 150;
    const changed = rounds.map((x, i) => (i >= t ? { ...x, multiplier: x.multiplier < 2 ? 50 : 1.01 } : x));
    const a = replay(rounds).entries.find((e) => e.forecast.inputRounds === t)!.forecast;
    const b = replay(changed).entries.find((e) => e.forecast.inputRounds === t)!.forecast;
    expect(b.vectors).toEqual(a.vectors);
    expect(b.state).toBe(a.state);
  });

  it('a forecast rebuilt from scratch (live) equals the replayed one (backtest)', () => {
    for (const t of [20, 21, 99, 100, 101, 250, 400]) {
      const prior = r.entries.filter((e) => e.forecast.inputRounds < t);
      const ev = evidenceOf(prior);
      const live = issueForecast(rounds.slice(0, t), ev, { engineVersion: 'stat-5', issuedAt: new Date(0), id: 'x' }).forecast!;
      const replayed = r.entries.find((e) => e.forecast.inputRounds === t)!.forecast;
      for (const [m, v] of Object.entries(replayed.vectors)) {
        v.forEach((p, k) => expect(live.vectors[m as keyof typeof live.vectors][k]).toBeCloseTo(p, 12));
      }
      expect(live.state).toBe(replayed.state);
    }
  });

  it('recorded forecasts are not changed by scoring', () => {
    const snapshot = JSON.stringify(replay(rounds.slice(0, 300)).entries.slice(0, 250).map((e) => e.forecast));
    const later = JSON.stringify(replay(rounds).entries.slice(0, 250).map((e) => e.forecast));
    expect(later).toBe(snapshot);
  });

  it('builds a response that satisfies the contract, with consistent performance figures', () => {
    const s = buildSignal(rounds, r.entries, r.models.changepoint.recentChangeProbability());
    expect(() => NextRoundSignalSchema.parse(s)).not.toThrow();
    expect(s.current?.inputLastRoundId).toBe(rounds.at(-1)!.id);
    expect(s.performance.scored).toBe(r.entries.length - 1);
    expect(s.performance.pending).toBe(1);
    expect(s.history).toHaveLength(30);
    expect(s.history[0]!.id).toBe(s.current!.id);
    const t2 = s.performance.thresholds[0]!;
    expect(t2.events + t2.nonEvents).toBe(s.performance.scored);
    // rolling window: the last 50 scored, model and baseline Brier and hit rate on the same rounds
    const scored = r.entries.filter((e) => e.outcome?.status === 'scored').slice(-50);
    const y = (e: (typeof scored)[number]) => (e.outcome as { range: number }).range;
    const br = (p: readonly number[], k: number) => p.reduce((a, v, j) => a + (v - (j === k ? 1 : 0)) ** 2, 0);
    const mean = (v: number[]) => v.reduce((a, x) => a + x, 0) / v.length;
    expect(s.performance.rolling.n).toBe(scored.length);
    expect(s.performance.rolling.brier).toBeCloseTo(mean(scored.map((e) => br(e.forecast.probabilities, y(e)))), 12);
    expect(s.performance.rolling.baselineBrier).toBeCloseTo(mean(scored.map((e) => br(e.forecast.vectors.baseline, y(e)))), 12);
    expect(s.performance.rolling.baselineTopRangeHitRate).toBeCloseTo(mean(scored.map((e) => (topRange(e.forecast.vectors.baseline) === y(e) ? 1 : 0))), 12);
  });

  it('warming up below 20 rounds: no forecast', () => {
    const few = asRounds(fairSequence(19, 3));
    const w = replay(few);
    expect(w.entries).toHaveLength(0);
    const s = buildSignal(few, w.entries, null);
    expect(s.state).toBe('warming_up');
    expect(s.current).toBeNull();
  });
});

describe('scoring rules', () => {
  it('voids a forecast whose next stored round came after a collection break', () => {
    const rounds = asRounds(fairSequence(25, 5));
    const f = replay(rounds).entries.at(-1)!.forecast;
    const after: LedgerRound = { id: '999', multiplier: 3, receivedAt: new Date(rounds.at(-1)!.receivedAt.getTime() + (SIGNAL_RULES.gapSeconds + 1) * 1000), source: 'live' };
    expect(resolve(f, after, new Date())).toMatchObject({ status: 'void', reason: 'gap' });
  });

  it('voids a forecast recorded after its round was stored (replay check)', () => {
    const rounds = asRounds(fairSequence(25, 5));
    const f = { ...replay(rounds).entries.at(-1)!.forecast, issuedAt: new Date(rounds.at(-1)!.receivedAt.getTime() + 60_000) };
    const next: LedgerRound = { id: '999', multiplier: 3, receivedAt: new Date(rounds.at(-1)!.receivedAt.getTime() + 20_000), source: 'live' };
    expect(resolve(f, next, new Date())).toMatchObject({ status: 'void', reason: 'late' });
    expect(resolve(f, next, new Date(), { checkLate: false }).status).toBe('scored');
  });

  it('a break restarts recent-round features', () => {
    const rounds = asRounds([1.1, 1.2, 1.3]);
    rounds[2]!.receivedAt = new Date(rounds[1]!.receivedAt.getTime() + 600_000);
    expect(breaksOf(rounds)).toEqual([true, false, true]);
  });
});

describe('decision rule', () => {
  it('stays experimental until 100 forecasts are scored, then falls back to the baseline on fair rounds', () => {
    const r = replay(asRounds(fairSequence(600, 21)));
    const states = r.entries.map((e) => e.forecast.state);
    expect(states.slice(0, SIGNAL_RULES.minScoredForVerdict).every((s) => s === 'experimental')).toBe(true);
    expect(decide(r.evidence).state).toBe('baseline_only');
    expect(r.entries.at(-1)!.forecast.probabilities).toEqual(r.entries.at(-1)!.forecast.vectors.baseline);
  });

  it('does not chase a streak: after many low rounds the 2× chance stays near the baseline on fair data', () => {
    const seq = fairSequence(800, 7);
    for (let i = 0; i < 12; i++) seq.push(1.05 + i / 100); // a long run below 2×
    const r = replay(asRounds(seq));
    const f = r.entries.at(-1)!.forecast;
    const shown = thresholdProbabilities(f.probabilities).p2;
    const base = thresholdProbabilities(f.vectors.baseline).p2;
    expect(Math.abs(shown - base)).toBeLessThan(0.03);
  });

  it('ensemble weights are posterior model probabilities that sum to 1', () => {
    const ev = new Evidence();
    const w = ev.weights();
    expect(sum(Object.values(w))).toBeCloseTo(1, 12);
    expect(w.baseline).toBeCloseTo(0.5, 12);
  });
});

describe('negative and positive controls (SIMULATED rounds)', () => {
  it('independent rounds: no history is ever validated at any point (40 histories × 800 rounds)', () => {
    let everValidated = 0;
    for (let s = 0; s < 40; s++) {
      const r = replay(asRounds(fairSequence(800, 1000 + s)));
      if (r.entries.some((e) => e.forecast.state === 'validated')) everValidated++;
    }
    // Ville's inequality bounds the chance per history by α = 5% at any stopping time; with the
    // universal-inference denominator the real rate is far lower.
    expect(everValidated).toBeLessThanOrEqual(2);
  }, 120_000);

  it('the independent bustabit-style hash-chain shape (1/33 instant crash) is not validated either', () => {
    const rand = prng(77);
    const seq = Array.from({ length: 1500 }, () => (rand() < 1 / 33 ? 1 : Math.max(1, Math.floor((99 / (1 - rand())) / 1) / 100)));
    const r = replay(asRounds(seq));
    expect(r.entries.some((e) => e.forecast.state === 'validated')).toBe(false);
  }, 60_000);

  it('a planted dependence on the previous round is detected and validated (10 histories × 1,500 rounds)', () => {
    let detected = 0;
    for (let s = 0; s < 10; s++) {
      const r = replay(asRounds(plantedSequence(1500, 500 + s, 0.15)));
      const d = decide(r.evidence);
      if (d.state === 'validated') {
        detected++;
        expect(['markov', 'streak', 'logit']).toContain(d.model);
      }
    }
    expect(detected).toBeGreaterThanOrEqual(9);
  }, 120_000);

  it('a validated model shows its own distribution and it moves with the planted state', () => {
    const r = replay(asRounds(plantedSequence(1500, 9, 0.15)));
    const validated = r.entries.filter((e) => e.forecast.state === 'validated');
    expect(validated.length).toBeGreaterThan(500);
    const p2 = validated.map((e) => thresholdProbabilities(e.forecast.probabilities).p2);
    expect(Math.max(...p2) - Math.min(...p2)).toBeGreaterThan(0.15);
  }, 60_000);
});

describe('model set', () => {
  it('prediction does not depend on how the rounds were fed (fresh vs incremental)', () => {
    const seq = fairSequence(260, 4);
    const inc = createModelSet();
    const preds: number[][][] = [];
    seq.forEach((m, i) => {
      inc.observe({ multiplier: m, breakBefore: i === 0 });
      if (i % 37 === 0) preds.push(Object.values(inc.predictAll()));
    });
    let p = 0;
    seq.forEach((_, i) => {
      if (i % 37 !== 0) return;
      const fresh = createModelSet();
      seq.slice(0, i + 1).forEach((m, j) => fresh.observe({ multiplier: m, breakBefore: j === 0 }));
      expect(Object.values(fresh.predictAll())).toEqual(preds[p++]);
    });
  });
});

describe('backfill alignment', () => {
  const stored = [1.5, 2.3, 7.1, 1.02, 3.4, 1.88];
  it('stores only the rounds after the stored tail', () => {
    expect(alignBackfill(stored, [7.1, 1.02, 3.4, 1.88, 2.5, 11.2], true)).toEqual({ kind: 'append', from: 4 });
  });
  it('stores nothing new when the list ends with the stored tail', () => {
    expect(alignBackfill(stored, [2.3, 7.1, 1.02, 3.4, 1.88], true)).toEqual({ kind: 'append', from: 5 });
  });
  it('stores everything when nothing is stored', () => {
    expect(alignBackfill([], [1.1, 2.2], false)).toEqual({ kind: 'append', from: 0 });
  });
  it('rejects a list that cannot be aligned with recently stored rounds', () => {
    expect(alignBackfill(stored, [5.5, 6.6, 7.7], true).kind).toBe('reject');
  });
  it('rejects ambiguous repeats', () => {
    expect(alignBackfill([1.1, 1.1, 1.1, 1.1], [1.1, 1.1, 1.1, 1.1, 1.1, 2], true).kind).toBe('reject');
  });
  it('rejects a short partial overlap with older stored rounds (possible duplicate)', () => {
    expect(alignBackfill(stored, [3.4, 1.88, 9.9, 4.4], false).kind).toBe('reject');
  });
  it('stores an unrelated list after an old break as a new run', () => {
    expect(alignBackfill(stored, [9.9, 4.4, 1.3], false)).toEqual({ kind: 'append', from: 0 });
  });
});
