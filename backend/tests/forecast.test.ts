import { ForecastSchema } from '@aviator/contracts';
import { describe, expect, it } from 'vitest';
import {
  computeForecast,
  dieboldMariano,
  FORECAST_MODEL_SPECS,
  normalCdf,
  Past,
  segmentsOf,
  spiegelhalterZ,
  walkForward,
  wilson,
  type ForecastRound,
} from '../src/engine/forecast.js';
import { StatisticalAnalysisProvider } from '../src/engine/statistical-provider.js';

/** Deterministic PRNG (mulberry32). */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const T0 = Date.UTC(2026, 0, 1);
const at = (i: number) => new Date(T0 + i * 15_000);

/** Independent rounds from the crash distribution P(M ≥ m) = 0.97 ÷ m (two decimals). */
function iid(n: number, seed: number): ForecastRound[] {
  const r = rng(seed);
  return Array.from({ length: n }, (_, i) => ({ multiplier: Math.max(1, Math.floor(97 / (1 - r())) / 100), receivedAt: at(i) }));
}

/** Rounds with a PLANTED dependence: P(≥2×) is 0.485 ± effect depending on the previous round. */
function planted(n: number, seed: number, effect: number): ForecastRound[] {
  const r = rng(seed);
  let prev = false;
  return Array.from({ length: n }, (_, i) => {
    const hit = r() < 0.485 + (prev ? effect : -effect);
    prev = hit;
    return { multiplier: hit ? Math.floor(200 / (1 - r() * 0.999)) / 100 : 1 + Math.floor(r() * 99) / 100, receivedAt: at(i) };
  });
}

const series = (rounds: ForecastRound[]) => ({ m: Float64Array.from(rounds, (r) => r.multiplier), seg: segmentsOf(rounds, 120) });

describe('forecast: leakage guard and chronology', () => {
  it('a Past view throws when a model reads the round being forecast or any later round', () => {
    const { m, seg } = series(iid(10, 1));
    const past = new Past(m, seg, 5);
    expect(past.multiplier(4)).toBe(m[4]);
    expect(() => past.multiplier(5)).toThrow(RangeError);
    expect(() => past.hit(9, 2)).toThrow(RangeError);
    expect(past.prefix(50).length).toBe(5); // a prefix can never extend a view
  });

  it('forecasts for round t do not change when rounds after t are changed (no look-ahead)', () => {
    const a = iid(700, 2);
    const cut = 480;
    const other = iid(700, 99);
    const b = a.map((r, i) => (i <= cut ? r : { ...r, multiplier: other[i]!.multiplier }));
    for (const t of [2, 5, 10]) {
      const sa = series(a);
      const sb = series(b);
      const fa = walkForward(sa.m, sa.seg, t, FORECAST_MODEL_SPECS, { trainInitial: 200, refitEvery: 100 });
      const fb = walkForward(sb.m, sb.seg, t, FORECAST_MODEL_SPECS, { trainInitial: 200, refitEvery: 100 });
      const k = fa.scored.filter((i) => i <= cut).length;
      expect(k).toBe(281);
      for (const s of FORECAST_MODEL_SPECS) expect(fb.forecasts.get(s.id)!.slice(0, k)).toEqual(fa.forecasts.get(s.id)!.slice(0, k));
      // ...and the later forecasts do differ, so the comparison is not vacuous.
      expect(fb.forecasts.get('base_rate')!.slice(k)).not.toEqual(fa.forecasts.get('base_rate')!.slice(k));
    }
  });

  it('scores only held-out rounds, in time order, after the initial training rounds', () => {
    const { m, seg } = series(iid(650, 3));
    const wf = walkForward(m, seg, 2, FORECAST_MODEL_SPECS, { trainInitial: 200, refitEvery: 100 });
    expect(wf.scored[0]).toBe(200);
    expect(wf.scored).toEqual([...wf.scored].sort((x, y) => x - y));
    expect(wf.scored).toHaveLength(450);
    for (const s of FORECAST_MODEL_SPECS) expect(wf.forecasts.get(s.id)).toHaveLength(450);
  });

  it('a timing gap starts a new run; the first round after a gap is not scored', () => {
    const rounds = iid(500, 4).map((r, i) => ({ ...r, receivedAt: new Date(T0 + i * 15_000 + (i >= 300 ? 3_600_000 : 0)) }));
    const { m, seg } = series(rounds);
    expect(seg[299]).toBe(0);
    expect(seg[300]).toBe(1);
    const wf = walkForward(m, seg, 2, FORECAST_MODEL_SPECS, { trainInitial: 200, refitEvery: 100 });
    expect(wf.scored).not.toContain(300);
    expect(wf.scored).toHaveLength(299);
  });
});

describe('forecast: insufficient data', () => {
  it('below trainInitial + minTestRounds nothing is evaluated and no estimate is produced', () => {
    const f = computeForecast(iid(399, 5));
    expect(f).toMatchObject({ status: 'insufficient_data', sampleSize: 399, minSampleSize: 400, testRounds: 0, thresholds: [] });
    expect(ForecastSchema.parse(f)).toEqual(f);
  });

  it('too few scorable rounds (many gaps) is also insufficient', () => {
    const rounds = iid(600, 6).map((r, i) => ({ ...r, receivedAt: new Date(T0 + i * 200_000) })); // every round after a gap
    const f = computeForecast(rounds);
    expect(f.status).toBe('insufficient_data');
    expect(f.segments).toBe(600);
  });

  it('empty input', () => {
    expect(computeForecast([])).toMatchObject({ status: 'insufficient_data', sampleSize: 0, segments: 0 });
  });
});

describe('forecast: independent rounds (no predictability)', () => {
  it('validates no recent-round model and estimates the base rate, whose interval covers the true chance', () => {
    for (const seed of [11, 13, 14]) {
      const f = computeForecast(iid(1500, seed));
      expect(ForecastSchema.parse(f)).toEqual(f);
      expect(f.status).toBe('evaluated');
      expect(f.comparisons).toBe(12);
      for (const th of f.thresholds) {
        expect(th.status).toBe('no_predictive_value');
        expect(th.selectedModel).toBe('base_rate');
        expect(th.models.filter((s) => s.validated)).toEqual([]);
        const truth = 0.97 / th.threshold;
        expect(th.low!).toBeLessThanOrEqual(truth);
        expect(th.high!).toBeGreaterThanOrEqual(truth);
        expect(th.low!).toBeLessThanOrEqual(th.probability!);
        expect(th.probability!).toBeLessThanOrEqual(th.high!);
      }
    }
  });

  it('the base-rate calibration check (bootstrap) rejects at about the nominal 5% on independent rounds', () => {
    let rejected = 0;
    let tests = 0;
    for (let seed = 200; seed < 260; seed++) {
      for (const th of computeForecast(iid(600, seed)).thresholds) {
        const base = th.models.find((s) => s.model === 'base_rate')!;
        expect(base.calibrationP).not.toBeNull();
        tests++;
        if (base.calibrationP! < 0.05) rejected++;
      }
    }
    expect(rejected / tests).toBeLessThan(0.1); // the plain test rejected ≈ 12%
  });

  it('a base rate that fails its calibration check (the chance changed over time) gives no estimate', () => {
    const r = rng(61);
    const rounds = Array.from({ length: 1200 }, (_, i) => {
      const rtp = i < 500 ? 0.97 : 0.5; // P(≥2×) falls from 0.485 to 0.25
      return { multiplier: Math.max(1, Math.floor((100 * rtp) / (1 - r())) / 100), receivedAt: at(i) };
    });
    const two = computeForecast(rounds).thresholds.find((t) => t.threshold === 2)!;
    const base = two.models.find((s) => s.model === 'base_rate')!;
    expect(base.calibrated).toBe(false);
    expect(base.calibrationP!).toBeLessThan(0.05 / 3);
    expect(two).toMatchObject({ status: 'not_calibrated', probability: null, low: null, high: null, selectedModel: null });
  });

  it('false-positive rate stays at or below the nominal level across many histories', () => {
    let any = 0;
    for (let seed = 100; seed < 130; seed++) if (computeForecast(iid(800, seed)).thresholds.some((t) => t.status === 'validated_model')) any++;
    expect(any).toBeLessThanOrEqual(2); // nominal family-wise 5% of 30 ≈ 1.5
  });
});

describe('forecast: planted dependence (the method can detect real structure)', () => {
  it('validates a previous-round model and its estimate follows the previous round', () => {
    const rounds = planted(1500, 21, 0.12);
    const f = computeForecast(rounds, { now: rounds[rounds.length - 1]!.receivedAt });
    const two = f.thresholds.find((t) => t.threshold === 2)!;
    expect(two.status).toBe('validated_model');
    expect(['after_previous', 'since_last_hit', 'logistic_recent']).toContain(two.selectedModel);
    const best = two.models.find((s) => s.model === two.selectedModel)!;
    expect(best).toMatchObject({ validated: true, calibrated: true });
    expect(best.skillVsBaseRate!).toBeGreaterThan(0);
    expect(best.pValue!).toBeLessThan(0.05 / f.comparisons);
    const prevHit = rounds[rounds.length - 1]!.multiplier >= 2;
    expect(two.probability! > 0.485).toBe(prevHit);
  });

  it('a validated model whose inputs are stale falls back to the base rate and says why', () => {
    const rounds = planted(1500, 21, 0.12);
    const later = new Date(rounds[rounds.length - 1]!.receivedAt.getTime() + 3_600_000);
    const two = computeForecast(rounds, { now: later }).thresholds.find((t) => t.threshold === 2)!;
    expect(two.status).toBe('validated_model_not_current');
    expect(two.selectedModel).toBe('base_rate');
  });

  it('an event that never occurs can never validate a model', () => {
    const rounds = iid(1000, 31).map((r) => ({ ...r, multiplier: Math.min(r.multiplier, 9.99) }));
    const ten = computeForecast(rounds).thresholds.find((t) => t.threshold === 10)!;
    expect(ten.models.some((s) => s.validated)).toBe(false);
    expect(ten.status).not.toBe('validated_model');
  });
});

describe('forecast: statistics', () => {
  it('normal CDF', () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 7);
    expect(normalCdf(1.959964)).toBeCloseTo(0.975, 6);
    expect(normalCdf(-1.644854)).toBeCloseTo(0.05, 6);
  });

  it('Wilson interval', () => {
    const [lo, hi] = wilson(50, 100);
    expect(lo).toBeCloseTo(0.4038, 3);
    expect(hi).toBeCloseTo(0.5962, 3);
    expect(wilson(0, 0)).toEqual([0, 1]);
  });

  it('Diebold–Mariano: equal losses give no evidence; clearly lower losses give a small p-value', () => {
    const a = Array.from({ length: 300 }, (_, i) => 0.6 + 0.1 * Math.sin(i));
    const r = rng(3);
    const noise = a.map(() => (r() - 0.5) * 0.02);
    expect(dieboldMariano(a, a)).toBe(1);
    expect(dieboldMariano(a.map((v, i) => v - 0.05 + noise[i]!), a)).toBeLessThan(1e-6);
    expect(dieboldMariano(a.map((v, i) => v + 0.05 + noise[i]!), a)).toBeGreaterThan(0.999);
  });

  it('Spiegelhalter Z: near 0 for calibrated forecasts, large for biased ones', () => {
    const r = rng(7);
    const p = Array.from({ length: 4000 }, () => 0.1 + 0.8 * r());
    const y = p.map((pi) => (r() < pi ? 1 : 0));
    expect(Math.abs(spiegelhalterZ(p, y))).toBeLessThan(3);
    expect(Math.abs(spiegelhalterZ(p.map((pi) => Math.min(0.99, pi + 0.15)), y))).toBeGreaterThan(5);
  });

  it('the fixed RTP reference is never selected as the estimate and uses no recent rounds', () => {
    const f = computeForecast(iid(1000, 41));
    for (const th of f.thresholds) {
      const ref = th.models.find((s) => s.model === 'rtp_reference')!;
      expect(ref.usesRecentRounds).toBe(false);
      expect(ref.validated).toBe(false);
      expect(ref.meanForecast).toBeCloseTo(0.97 / th.threshold, 10);
      expect(th.selectedModel).not.toBe('rtp_reference');
    }
  });
});

describe('statistical provider: forecast', () => {
  const input = (rounds: ForecastRound[], now: Date) => ({
    siteId: 'devfixture',
    windowHours: 12,
    observations: [...rounds].reverse(), // the API passes newest first
    now,
  });

  it('returns the forecast with the summary and reuses it while the rounds are unchanged', async () => {
    const p = new StatisticalAnalysisProvider({ minSampleSize: 10 });
    const rounds = iid(600, 51);
    const now = rounds[rounds.length - 1]!.receivedAt;
    const a = await p.analyze(input(rounds, now));
    const b = await p.analyze(input(rounds, now));
    expect(a.forecast!.status).toBe('evaluated');
    expect(b.forecast).toBe(a.forecast);
    const c = await p.analyze(input([...rounds, { multiplier: 2, receivedAt: at(600) }], at(600)));
    expect(c.forecast).not.toBe(a.forecast);
    expect(c.forecast!.sampleSize).toBe(601);
  });

  it('invalid stored values are excluded from the forecast', async () => {
    const p = new StatisticalAnalysisProvider();
    const rounds = [...iid(450, 52), { multiplier: Number.NaN, receivedAt: at(450) }];
    const r = await p.analyze(input(rounds, at(450)));
    expect(r.forecast!.sampleSize).toBe(450);
  });

  it('runs a full 5,000-round history within the provider time budget', async () => {
    const p = new StatisticalAnalysisProvider();
    const rounds = iid(5000, 53);
    const t = performance.now();
    await p.analyze(input(rounds, rounds[4999]!.receivedAt));
    expect(performance.now() - t).toBeLessThan(3000);
  });
});
