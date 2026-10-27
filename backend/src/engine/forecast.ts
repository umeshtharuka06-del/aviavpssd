import {
  ANALYSIS_THRESHOLDS,
  type Forecast,
  type ForecastModel,
  type ModelScore,
  type ThresholdForecast,
} from '@aviator/contracts';

/**
 * Walk-forward next-round forecast experiment (contract: ForecastSchema in @aviator/contracts).
 *
 * The question it answers, separately for each threshold T: "does any model that looks at the
 * most recent rounds forecast whether the next round reaches T better than simply using the share
 * of earlier rounds that reached T?" It is answered only with held-out rounds, in time order:
 *
 *   rounds 0 … trainInitial−1          training only, never scored
 *   then blocks of `refitEvery` rounds  every model is refitted on ALL rounds before the block,
 *                                       then forecasts each round t of the block from rounds < t
 *
 * Leakage guard: models only ever receive a `Past` view, which throws if they read round t or
 * later. Scoring uses only rounds that directly follow the previous stored round (no timing gap),
 * and every model is scored on exactly the same rounds, so comparisons are paired.
 *
 * Nothing here assumes that past rounds predict future rounds: the base rate is the
 * no-predictability baseline, and a recent-round model is reported as validated only if it beats
 * it by a multiple-testing-corrected test AND is calibrated. With a fair random number generator
 * the expected result is "no predictive value", and the estimate shown is then the base rate.
 */

export interface ForecastRound {
  multiplier: number;
  receivedAt: Date;
}

export interface ForecastOptions {
  trainInitial?: number;
  minTestRounds?: number;
  refitEvery?: number;
  gapSeconds?: number;
  thresholds?: readonly number[];
  /** Server time; used to tell whether the latest stored round is recent enough for recent-round models. */
  now?: Date;
}

export const FORECAST_DEFAULTS = Object.freeze({ trainInitial: 200, minTestRounds: 200, refitEvery: 100, gapSeconds: 120 });

/** Published RTP used only by the fixed reference model (an unverified per-target assumption). */
export const RTP_REFERENCE = 0.97;
const ALPHA = 0.05;
const Z95 = 1.959963984540054;
/** Forecasts are kept inside [EPS, 1 − EPS] so a log loss is always finite. */
const EPS = 1e-4;
/** Prior strength (in rounds) pulling sparse conditional cells toward the base rate. */
const SHRINK = 10;
const RIDGE = 1;
/** A model can be validated only if the test rounds contain at least this many events AND non-events. */
export const MIN_EVENTS = 10;
const MAX_REFITS = 20;

/* ---------------------------------------------------------------- past-only view */

/** Read-only view of the rounds strictly before index `length`. Reading any later round throws. */
export class Past {
  constructor(
    private readonly m: Float64Array,
    private readonly seg: Int32Array,
    readonly length: number,
  ) {}

  private check(i: number): void {
    if (!Number.isInteger(i) || i < 0 || i >= this.length) throw new RangeError(`round ${i} is not in the past (length ${this.length})`);
  }
  multiplier(i: number): number {
    this.check(i);
    return this.m[i]!;
  }
  hit(i: number, threshold: number): boolean {
    return this.multiplier(i) >= threshold;
  }
  segment(i: number): number {
    this.check(i);
    return this.seg[i]!;
  }
  /** The first `len` rounds (never more than this view holds). */
  prefix(len: number): Past {
    return new Past(this.m, this.seg, Math.max(0, Math.min(len, this.length)));
  }
  /** Identity of the underlying round series (for caches of values that depend only on earlier rounds). */
  get series(): Float64Array {
    return this.m;
  }
  /** Same run of consecutive stored rounds as the previous round (i ≥ 1). */
  contiguous(i: number): boolean {
    return i > 0 && this.segment(i) === this.segment(i - 1);
  }
}

/* ---------------------------------------------------------------- models */

export interface Predictor {
  /** Probability that round `past.length` reaches the threshold, from `past` and fitted parameters only. */
  p(past: Past): number;
  /** 95% interval for that probability (parameter uncertainty). */
  interval(past: Past): [number, number];
}

export interface ModelSpec {
  id: ForecastModel;
  usesRecentRounds: boolean;
  /** Eligible to supply the displayed estimate (the fixed reference is for comparison only). */
  selectable: boolean;
  fit(train: Past, threshold: number): Predictor;
}

const clip = (p: number) => Math.min(1 - EPS, Math.max(EPS, p));

function countHits(past: Past, threshold: number, from = 0): number {
  let k = 0;
  for (let i = from; i < past.length; i++) if (past.hit(i, threshold)) k++;
  return k;
}

/** Wilson 95% interval for k successes in n trials. */
export function wilson(k: number, n: number): [number, number] {
  if (n <= 0) return [0, 1];
  const p = k / n;
  const z2 = Z95 * Z95;
  const den = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / den;
  const half = (Z95 * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / den;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

const jeffreys = (k: number, n: number) => (k + 0.5) / (n + 1);

const constant = (p: number, iv: [number, number]): Predictor => ({ p: () => clip(p), interval: () => iv });

const baseRate: ModelSpec = {
  id: 'base_rate',
  usesRecentRounds: false,
  selectable: true,
  fit(train, t) {
    const k = countHits(train, t);
    return constant(jeffreys(k, train.length), wilson(k, train.length));
  },
};

const rtpReference: ModelSpec = {
  id: 'rtp_reference',
  usesRecentRounds: false,
  selectable: false,
  fit(_train, t) {
    const p = Math.min(1, RTP_REFERENCE / t);
    return constant(p, [p, p]);
  },
};

const ROLLING_WINDOW = 50;
const rolling50: ModelSpec = {
  id: 'rolling_50',
  usesRecentRounds: true,
  selectable: true,
  fit(_train, t) {
    const cell = (past: Past) => {
      const from = Math.max(0, past.length - ROLLING_WINDOW);
      return { k: countHits(past, t, from), n: past.length - from };
    };
    return {
      p: (past) => {
        const { k, n } = cell(past);
        return clip(jeffreys(k, n));
      },
      interval: (past) => {
        const { k, n } = cell(past);
        return wilson(k, n);
      },
    };
  },
};

/** Conditional-frequency model: P(hit | state of the rounds just before), shrunk toward the base rate. */
function conditional(id: ForecastModel, buckets: number, state: (past: Past, i: number, t: number) => number): ModelSpec {
  return {
    id,
    usesRecentRounds: true,
    selectable: true,
    fit(train, t) {
      const k = new Float64Array(buckets);
      const n = new Float64Array(buckets);
      for (let i = 1; i < train.length; i++) {
        if (!train.contiguous(i)) continue;
        const b = state(train, i, t);
        n[b]!++;
        if (train.hit(i, t)) k[b]!++;
      }
      const base = jeffreys(countHits(train, t), train.length);
      const cell = (past: Past) => (past.length > 0 ? state(past, past.length, t) : -1);
      return {
        p: (past) => {
          const b = cell(past);
          return clip(b < 0 ? base : (k[b]! + SHRINK * base) / (n[b]! + SHRINK));
        },
        interval: (past) => {
          const b = cell(past);
          return b < 0 ? wilson(0, 0) : wilson(k[b]!, n[b]!);
        },
      };
    },
  };
}

/** State 0/1: whether the previous round reached the threshold. */
const afterPrevious = conditional('after_previous', 2, (past, i, t) => (past.hit(i - 1, t) ? 1 : 0));

/** Rounds in a row before i (within the run) that did NOT reach the threshold, capped at `cap`. */
function missesBefore(past: Past, i: number, t: number, cap: number): number {
  let g = 0;
  for (let j = i - 1; j >= 0 && g < cap; j--) {
    if (past.hit(j, t)) break;
    g++;
    if (j === 0 || !past.contiguous(j)) break;
  }
  return g;
}

const SINCE_BUCKETS = [0, 1, 2, 3, 6, 11] as const; // 0 | 1 | 2 | 3–5 | 6–10 | 11+
const sinceLastHit = conditional('since_last_hit', SINCE_BUCKETS.length, (past, i, t) => {
  const g = missesBefore(past, i, t, 11);
  let b = 0;
  while (b + 1 < SINCE_BUCKETS.length && g >= SINCE_BUCKETS[b + 1]!) b++;
  return b;
});

/* ---- ridge logistic regression on recent-round features ---- */

const N_FEATURES = 5;

/** Features of round i, from rounds < i in the same run only. NaN where no earlier round exists. */
function features(past: Past, i: number, t: number): number[] {
  const window = (w: number) => {
    let s = 0;
    let c = 0;
    let hits = 0;
    for (let j = i - 1; j >= 0 && c < w; j--) {
      const m = past.multiplier(j);
      s += Math.log(m);
      if (m >= t) hits++;
      c++;
      if (j === 0 || !past.contiguous(j)) break;
    }
    return { mean: c ? s / c : Number.NaN, share: c ? hits / c : Number.NaN };
  };
  const w1 = window(1);
  return [w1.mean, window(5).mean, window(20).mean, window(10).share, i > 0 ? Math.log1p(missesBefore(past, i, t, 50)) : Number.NaN];
}

function solve(a: number[][], b: number[]): number[] {
  // Gaussian elimination with partial pivoting on a small dense system.
  const n = b.length;
  const m = a.map((row, r) => [...row, b[r]!]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(m[r]![c]!) > Math.abs(m[piv]![c]!)) piv = r;
    [m[c], m[piv]] = [m[piv]!, m[c]!];
    const d = m[c]![c]!;
    if (Math.abs(d) < 1e-12) throw new Error('singular');
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = m[r]![c]! / d;
      for (let k = c; k <= n; k++) m[r]![k]! -= f * m[c]![k]!;
    }
  }
  return m.map((row, r) => row[n]! / row[r]!);
}

const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));

/**
 * Per-series cache. features(i) reads only rounds < i (computed from a prefix view of length i), so
 * a cached row is the same whichever later view asks for it. `lastW` warm-starts the next refit:
 * the ridge objective is strictly convex, so the starting point changes the iterations, not the result.
 */
const logisticCache = new WeakMap<Float64Array, Map<number, { rows: number[][]; lastW: number[] | null }>>();

function cacheFor(past: Past, t: number) {
  let byT = logisticCache.get(past.series);
  if (!byT) logisticCache.set(past.series, (byT = new Map()));
  let c = byT.get(t);
  if (!c) byT.set(t, (c = { rows: [], lastW: null }));
  return c;
}

function featureRow(past: Past, i: number, t: number): number[] {
  const c = cacheFor(past, t);
  return (c.rows[i] ??= features(past.prefix(i), i, t));
}

const logisticRecent: ModelSpec = {
  id: 'logistic_recent',
  usesRecentRounds: true,
  selectable: true,
  fit(train, t) {
    const rows: number[][] = [];
    const ys: number[] = [];
    for (let i = 1; i < train.length; i++) {
      if (!train.contiguous(i)) continue;
      rows.push(featureRow(train, i, t));
      ys.push(train.hit(i, t) ? 1 : 0);
    }
    // Standardise with training statistics only; a missing feature becomes the training mean (0).
    const mean = new Array<number>(N_FEATURES).fill(0);
    const sd = new Array<number>(N_FEATURES).fill(1);
    for (let f = 0; f < N_FEATURES; f++) {
      const vals = rows.map((r) => r[f]!).filter((v) => Number.isFinite(v));
      if (!vals.length) continue;
      const mu = vals.reduce((a, v) => a + v, 0) / vals.length;
      const v = vals.reduce((a, x) => a + (x - mu) ** 2, 0) / vals.length;
      mean[f] = mu;
      sd[f] = v > 1e-12 ? Math.sqrt(v) : 1;
    }
    const design = (raw: number[]) => [1, ...raw.map((v, f) => (Number.isFinite(v) ? (v - mean[f]!) / sd[f]! : 0))];
    const X = rows.map(design);
    const d = N_FEATURES + 1;
    const cache = cacheFor(train, t);
    let w = new Array<number>(d).fill(0);
    const base = jeffreys(ys.reduce((a, y) => a + y, 0), ys.length);
    w[0] = Math.log(base / (1 - base));
    if (cache.lastW) w = [...cache.lastW];
    let H: number[][] = [];
    for (let iter = 0; iter < 25; iter++) {
      const g = new Array<number>(d).fill(0);
      H = Array.from({ length: d }, () => new Array<number>(d).fill(0));
      for (let r = 0; r < X.length; r++) {
        const x = X[r]!;
        let z = 0;
        for (let k = 0; k < d; k++) z += w[k]! * x[k]!;
        const p = sigmoid(z);
        const q = p * (1 - p);
        const e = ys[r]! - p;
        for (let a = 0; a < d; a++) {
          g[a]! += e * x[a]!;
          for (let b = a; b < d; b++) H[a]![b]! += q * x[a]! * x[b]!;
        }
      }
      for (let a = 0; a < d; a++) {
        for (let b = 0; b < a; b++) H[a]![b] = H[b]![a]!;
        if (a > 0) {
          H[a]![a]! += RIDGE; // ridge penalty on the slopes, not the intercept
          g[a]! -= RIDGE * w[a]!;
        }
      }
      let step: number[];
      try {
        step = solve(H, g);
      } catch {
        break;
      }
      w = w.map((v, k) => v + step[k]!);
      if (Math.max(...step.map(Math.abs)) < 1e-7) break;
    }
    if (w.every(Number.isFinite)) cache.lastW = w;
    const Hfinal = H;
    const eta = (past: Past) => {
      const x = design(featureRow(past, past.length, t));
      return { x, z: x.reduce((a, v, k) => a + v * w[k]!, 0) };
    };
    return {
      p: (past) => clip(sigmoid(eta(past).z)),
      interval: (past) => {
        const { x, z } = eta(past);
        let half = Number.POSITIVE_INFINITY;
        try {
          const v = solve(Hfinal, x).reduce((a, s, k) => a + s * x[k]!, 0); // xᵀ H⁻¹ x (delta method)
          if (v >= 0) half = Z95 * Math.sqrt(v);
        } catch {
          // keep the widest interval
        }
        return [sigmoid(z - half), sigmoid(z + half)];
      },
    };
  },
};

export const FORECAST_MODEL_SPECS: readonly ModelSpec[] = [baseRate, rtpReference, rolling50, afterPrevious, sinceLastHit, logisticRecent];

/* ---------------------------------------------------------------- statistics */

/** Standard normal CDF (Abramowitz–Stegun 7.1.26, |error| < 1.5e-7). */
export function normalCdf(x: number): number {
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
  return x >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}

const logLoss = (p: number, y: number) => -(y ? Math.log(p) : Math.log(1 - p));

/**
 * One-sided Diebold–Mariano test that series `a` has a lower mean loss than `b`, with a
 * Newey–West (Bartlett) long-run variance. Returns the p-value of "mean(a − b) < 0".
 */
export function dieboldMariano(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = a.length;
  if (n < 2) return 1;
  const d = Array.from({ length: n }, (_, i) => a[i]! - b[i]!);
  const mean = d.reduce((s, v) => s + v, 0) / n;
  const lag = Math.floor(Math.cbrt(n));
  let v = 0;
  for (let k = 0; k <= lag; k++) {
    let c = 0;
    for (let i = k; i < n; i++) c += (d[i]! - mean) * (d[i - k]! - mean);
    c /= n;
    v += (k === 0 ? 1 : 2 * (1 - k / (lag + 1))) * c;
  }
  if (!(v > 1e-18)) return mean < 0 ? 0 : 1;
  return normalCdf(mean / Math.sqrt(v / n));
}

/**
 * Spiegelhalter's Z for calibration of probability forecasts. For a constant forecast it reduces
 * to the calibration-in-the-large test (observed − expected events).
 */
export function spiegelhalterZ(p: ArrayLike<number>, y: ArrayLike<number>): number {
  let num = 0;
  let den = 0;
  let inLarge = 0;
  let varLarge = 0;
  for (let i = 0; i < p.length; i++) {
    const pi = p[i]!;
    const v = pi * (1 - pi);
    num += (y[i]! - pi) * (1 - 2 * pi);
    den += (1 - 2 * pi) ** 2 * v;
    inLarge += y[i]! - pi;
    varLarge += v;
  }
  if (den > 1e-9) return num / Math.sqrt(den);
  return varLarge > 0 ? inLarge / Math.sqrt(varLarge) : 0;
}

/** Deterministic PRNG (mulberry32) so a result is reproducible from its input. */
function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const BOOTSTRAP_REPLICATES = 199;

/**
 * Calibration p-value for the BASE RATE, by parametric bootstrap under "rounds are independent
 * with a constant chance". The plain Spiegelhalter test treats each forecast as known, but the base
 * rate is itself estimated from earlier rounds, which makes that test reject far too often (≈12%
 * instead of 5% on simulated independent rounds). Here the whole walk-forward is replayed on
 * simulated hit sequences with the same rounds, scoring positions and refit blocks, and the
 * observed |Z| is compared with the simulated ones. A small p-value is evidence that the chance
 * changed over time (the base rate does not carry forward), not of predictability.
 */
export function baseRateCalibrationP(
  hits: Uint8Array,
  scored: readonly number[],
  observedZ: number,
  opts: { trainInitial: number; refitEvery: number },
  seed: number,
): number {
  const n = hits.length;
  const rate = jeffreys(hits.reduce((a, v) => a + v, 0), n);
  const rand = prng(seed);
  const sim = new Uint8Array(n);
  const p: number[] = [];
  const y: number[] = [];
  let exceed = 0;
  for (let b = 0; b < BOOTSTRAP_REPLICATES; b++) {
    for (let i = 0; i < n; i++) sim[i] = rand() < rate ? 1 : 0;
    p.length = 0;
    y.length = 0;
    let k = 0; // hits before the current block start
    let counted = 0;
    let si = 0;
    for (let start = opts.trainInitial; start < n; start += opts.refitEvery) {
      for (; counted < start; counted++) k += sim[counted]!;
      const f = clip(jeffreys(k, start));
      const end = Math.min(n, start + opts.refitEvery);
      for (; si < scored.length && scored[si]! < end; si++) {
        p.push(f);
        y.push(sim[scored[si]!]!);
      }
    }
    if (Math.abs(spiegelhalterZ(p, y)) >= Math.abs(observedZ)) exceed++;
  }
  return (exceed + 1) / (BOOTSTRAP_REPLICATES + 1);
}

/* ---------------------------------------------------------------- experiment */

/** Run ids: a new run starts when stored rounds are more than `gapSeconds` apart. */
export function segmentsOf(rounds: ReadonlyArray<ForecastRound>, gapSeconds: number): Int32Array {
  const seg = new Int32Array(rounds.length);
  for (let i = 1; i < rounds.length; i++) {
    const gap = (rounds[i]!.receivedAt.getTime() - rounds[i - 1]!.receivedAt.getTime()) / 1000;
    seg[i] = seg[i - 1]! + (gap > gapSeconds || gap < 0 ? 1 : 0);
  }
  return seg;
}

export interface WalkForwardResult {
  /** Indices of the scored test rounds. */
  scored: number[];
  y: number[];
  /** forecasts[model][k] for scored round k. */
  forecasts: Map<ForecastModel, number[]>;
}

/** Chronological walk-forward forecasts for one threshold. `rounds` are OLDEST FIRST. */
export function walkForward(
  m: Float64Array,
  seg: Int32Array,
  threshold: number,
  specs: readonly ModelSpec[],
  opts: { trainInitial: number; refitEvery: number },
): WalkForwardResult {
  const n = m.length;
  const forecasts = new Map<ForecastModel, number[]>(specs.map((s) => [s.id, []]));
  const scored: number[] = [];
  const y: number[] = [];
  for (let start = opts.trainInitial; start < n; start += opts.refitEvery) {
    const train = new Past(m, seg, start);
    const predictors = specs.map((s) => s.fit(train, threshold));
    for (let t = start; t < Math.min(n, start + opts.refitEvery); t++) {
      if (seg[t] !== seg[t - 1]) continue; // only rounds that directly follow the previous stored round
      const past = new Past(m, seg, t);
      specs.forEach((s, k) => forecasts.get(s.id)!.push(predictors[k]!.p(past)));
      scored.push(t);
      y.push(m[t]! >= threshold ? 1 : 0);
    }
  }
  return { scored, y, forecasts };
}

export function computeForecast(roundsOldestFirst: ReadonlyArray<ForecastRound>, opts: ForecastOptions = {}): Forecast {
  const trainInitial = opts.trainInitial ?? FORECAST_DEFAULTS.trainInitial;
  const minTestRounds = opts.minTestRounds ?? FORECAST_DEFAULTS.minTestRounds;
  const n = roundsOldestFirst.length;
  // At most ~MAX_REFITS refits per threshold keeps a 5,000-round run fast; never more often than the default.
  const refitEvery = opts.refitEvery ?? Math.max(FORECAST_DEFAULTS.refitEvery, Math.ceil((n - trainInitial) / MAX_REFITS / 50) * 50);
  const gapSeconds = opts.gapSeconds ?? FORECAST_DEFAULTS.gapSeconds;
  const thresholds = opts.thresholds ?? ANALYSIS_THRESHOLDS;
  const specs = FORECAST_MODEL_SPECS;
  const candidates = specs.filter((s) => s.usesRecentRounds);
  const comparisons = candidates.length * thresholds.length;

  const m = Float64Array.from(roundsOldestFirst, (r) => r.multiplier);
  const seg = segmentsOf(roundsOldestFirst, gapSeconds);
  const segments = n ? seg[n - 1]! + 1 : 0;
  const head = { method: 'walk_forward_v1' as const, sampleSize: n, minSampleSize: trainInitial + minTestRounds, trainInitial, refitEvery, segments, gapSeconds, comparisons };
  const insufficient = (testRounds: number): Forecast => ({ ...head, status: 'insufficient_data', testRounds, thresholds: [] });
  if (n < trainInitial + minTestRounds) return insufficient(0);

  const latest = roundsOldestFirst[n - 1]!.receivedAt.getTime();
  const current = !opts.now || (opts.now.getTime() - latest) / 1000 <= gapSeconds;
  const all = new Past(m, seg, n);
  const results: ThresholdForecast[] = [];
  let testRounds = 0;

  for (const t of thresholds) {
    const wf = walkForward(m, seg, t, specs, { trainInitial, refitEvery });
    testRounds = wf.scored.length;
    if (testRounds < minTestRounds) return insufficient(testRounds);

    const loss = new Map<ForecastModel, number[]>();
    for (const s of specs) loss.set(s.id, wf.forecasts.get(s.id)!.map((p, k) => logLoss(p, wf.y[k]!)));
    const baseLoss = loss.get('base_rate')!;
    const meanOf = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
    const baseLL = meanOf(baseLoss);
    const events = wf.y.reduce((a, v) => a + v, 0);
    const testable = events >= MIN_EVENTS && testRounds - events >= MIN_EVENTS;

    const hits = Uint8Array.from(m, (v) => (v >= t ? 1 : 0));
    const models: ModelScore[] = specs.map((s) => {
      const p = wf.forecasts.get(s.id)!;
      const ll = meanOf(loss.get(s.id)!);
      const z = spiegelhalterZ(p, wf.y);
      const isBase = s.id === 'base_rate';
      const pValue = isBase ? null : dieboldMariano(loss.get(s.id)!, baseLoss);
      // Base rate: bootstrap test, Bonferroni over thresholds (withholding the estimate needs clear
      // evidence). Other models: plain test, which ignores their estimation noise and so only makes
      // validation stricter.
      const calibrationP = isBase ? baseRateCalibrationP(hits, wf.scored, z, { trainInitial, refitEvery }, n * 31 + t * 1009) : null;
      const calibrated = calibrationP != null ? calibrationP >= ALPHA / thresholds.length : Math.abs(z) < Z95;
      return {
        model: s.id,
        usesRecentRounds: s.usesRecentRounds,
        logLoss: ll,
        brier: meanOf(p.map((pi, k) => (pi - wf.y[k]!) ** 2)),
        meanForecast: meanOf(p),
        observedRate: meanOf(wf.y),
        calibrationZ: z,
        calibrationP,
        calibrated,
        skillVsBaseRate: isBase || baseLL === 0 ? null : 1 - ll / baseLL,
        pValue,
        validated: testable && s.usesRecentRounds && pValue != null && pValue < ALPHA / comparisons && calibrated && ll < baseLL,
      };
    });

    const best = models.filter((s) => s.validated).sort((a, b) => a.logLoss - b.logLoss)[0];
    const baseScore = models.find((s) => s.model === 'base_rate')!;
    const estimate = (id: ForecastModel) => {
      const pred = specs.find((s) => s.id === id)!.fit(all, t);
      const [low, high] = pred.interval(all);
      return { selectedModel: id, probability: pred.p(all), low, high };
    };
    if (best && current) results.push({ threshold: t, status: 'validated_model', ...estimate(best.model), models });
    else if (!baseScore.calibrated) results.push({ threshold: t, status: 'not_calibrated', selectedModel: null, probability: null, low: null, high: null, models });
    else results.push({ threshold: t, status: best ? 'validated_model_not_current' : 'no_predictive_value', ...estimate('base_rate'), models });
  }
  return { ...head, status: 'evaluated', testRounds, thresholds: results };
}
