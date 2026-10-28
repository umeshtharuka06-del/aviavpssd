import { RANGE_COUNT, rangeIndex, type SignalModel } from '@aviator/contracts';

/**
 * Online forecasting models for the next round's multiplier RANGE (see MULTIPLIER_RANGES).
 *
 * Every model sees rounds one at a time, oldest first, through `observe`, and `predict` returns a
 * probability vector over the four ranges for the round that has NOT been observed yet. A model
 * can therefore never read the round it forecasts. Predictions depend only on the sequence
 * observed so far, never on how it was fed: building a model from scratch over n rounds gives the
 * same prediction as feeding those rounds one by one (tested). Live issuance and backtests use the
 * same code.
 *
 * All candidates shrink toward the baseline, so with little or no evidence of structure they
 * forecast (nearly) the baseline. That is the correct forecast for independent rounds.
 */

export interface RoundInput {
  multiplier: number;
  /** A collection break (or the first round) precedes this round: recent-round features restart. */
  breakBefore: boolean;
}

export interface OnlineModel {
  readonly id: Exclude<SignalModel, 'ensemble'>;
  observe(r: RoundInput): void;
  predict(): number[];
}

/**
 * Reference distribution implied by a 97% RTP at every cash-out target, P(M ≥ m) = 0.97 ÷ m
 * (an UNVERIFIED assumption, see docs/RESEARCH.md). Used only as the centre of the baseline prior.
 */
export const RTP_REFERENCE_RTP = 0.97;
export const RTP_REFERENCE: readonly number[] = (() => {
  const s = (m: number) => Math.min(1, RTP_REFERENCE_RTP / m);
  return [1 - s(2), s(2) - s(5), s(5) - s(10), s(10)];
})();

/** Prior strength of the baseline (pseudo-rounds at the RTP reference). */
export const BASELINE_PRIOR_ROUNDS = 10;
/** Strength of each candidate's shrinkage toward the baseline (pseudo-rounds). */
const SHRINK = 20;
const EPS = 1e-6;

const zeros = () => new Array<number>(RANGE_COUNT).fill(0);

function normalise(p: number[]): number[] {
  const c = p.map((v) => Math.max(EPS, v));
  const s = c.reduce((a, v) => a + v, 0);
  return c.map((v) => v / s);
}

/* ---------------------------------------------------------------- baseline */

/**
 * Bayesian Dirichlet–categorical estimate of a CONSTANT range distribution (rounds independent and
 * identically distributed). Prior Dirichlet(10 × RTP reference). Posterior predictive
 * (count_k + 10 × ref_k) ÷ (n + 10). Ignores the order of rounds.
 */
export class BaselineModel implements OnlineModel {
  readonly id = 'baseline' as const;
  readonly counts = zeros();
  n = 0;
  observe(r: RoundInput): void {
    this.counts[rangeIndex(r.multiplier)]!++;
    this.n++;
  }
  predict(): number[] {
    return normalise(this.counts.map((c, k) => (c + BASELINE_PRIOR_ROUNDS * RTP_REFERENCE[k]!) / (this.n + BASELINE_PRIOR_ROUNDS)));
  }
}

const shrinkToward = (counts: readonly number[], n: number, base: readonly number[], strength = SHRINK) =>
  normalise(counts.map((c, k) => (c + strength * base[k]!) / (n + strength)));

/* ---------------------------------------------------------------- EWMA (drift) */

/** Exponentially weighted range frequencies (half-life 50 rounds), shrunk toward the baseline. Tests slow drift. */
export class EwmaModel implements OnlineModel {
  readonly id = 'ewma' as const;
  static readonly HALF_LIFE = 50;
  private readonly decay = 2 ** (-1 / EwmaModel.HALF_LIFE);
  private readonly w = zeros();
  private total = 0;
  constructor(private readonly base: BaselineModel) {}
  observe(r: RoundInput): void {
    for (let k = 0; k < RANGE_COUNT; k++) this.w[k]! *= this.decay;
    this.total = this.total * this.decay + 1;
    this.w[rangeIndex(r.multiplier)]! += 1;
  }
  predict(): number[] {
    return shrinkToward(this.w, this.total, this.base.predict());
  }
}

/* ---------------------------------------------------------------- Markov (previous range) */

/** P(range | previous round's range): 4×4 transition counts, shrunk toward the baseline. */
export class MarkovModel implements OnlineModel {
  readonly id = 'markov' as const;
  private readonly t = Array.from({ length: RANGE_COUNT }, zeros);
  private readonly rowN = zeros();
  private prev: number | null = null;
  constructor(private readonly base: BaselineModel) {}
  observe(r: RoundInput): void {
    const k = rangeIndex(r.multiplier);
    if (this.prev != null && !r.breakBefore) {
      this.t[this.prev]![k]!++;
      this.rowN[this.prev]!++;
    }
    this.prev = k;
  }
  predict(): number[] {
    // A break after the last observed round is not known yet; the state is the last observed round.
    if (this.prev == null) return this.base.predict();
    return shrinkToward(this.t[this.prev]!, this.rowN[this.prev]!, this.base.predict());
  }
}

/* ---------------------------------------------------------------- streak below 2× */

const STREAK_BUCKETS = [0, 1, 2, 3, 5, 8] as const; // 0 | 1 | 2 | 3–4 | 5–7 | 8+
const bucketOf = (g: number) => {
  let b = 0;
  while (b + 1 < STREAK_BUCKETS.length && g >= STREAK_BUCKETS[b + 1]!) b++;
  return b;
};

/**
 * P(range | number of rounds in a row below 2× just before), shrunk toward the baseline. This is
 * the model that would capture a real "due" effect, if one existed; it must earn its weight out of
 * sample like every other candidate.
 */
export class StreakModel implements OnlineModel {
  readonly id = 'streak' as const;
  private readonly c = Array.from({ length: STREAK_BUCKETS.length }, zeros);
  private readonly bn = new Array<number>(STREAK_BUCKETS.length).fill(0);
  private run = 0;
  private started = false;
  constructor(private readonly base: BaselineModel) {}
  observe(r: RoundInput): void {
    if (r.breakBefore) this.run = 0;
    const k = rangeIndex(r.multiplier);
    if (this.started && !r.breakBefore) {
      const b = bucketOf(this.run);
      this.c[b]![k]!++;
      this.bn[b]!++;
    }
    this.started = true;
    this.run = k === 0 ? this.run + 1 : 0;
  }
  predict(): number[] {
    if (!this.started) return this.base.predict();
    const b = bucketOf(this.run);
    return shrinkToward(this.c[b]!, this.bn[b]!, this.base.predict());
  }
}

/* ---------------------------------------------------------------- multinomial logistic */

const N_FEAT = 5;
const N_PAR = N_FEAT + 1;
const N_CLASS_FREE = RANGE_COUNT - 1; // class 0 is the reference

function solve(a: number[][], b: number[]): number[] {
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
      if (f === 0) continue;
      for (let k = c; k <= n; k++) m[r]![k]! -= f * m[c]![k]!;
    }
  }
  return m.map((row, r) => row[n]! / row[r]!);
}

function softmax(z: number[]): number[] {
  const mx = Math.max(...z);
  const e = z.map((v) => Math.exp(v - mx));
  const s = e.reduce((a, v) => a + v, 0);
  return e.map((v) => v / s);
}

/**
 * Ridge-regularised multinomial logistic regression of the range on recent-round features (all
 * from rounds before the forecast round, within the current run of unbroken collection):
 *   previous log multiplier, mean log multiplier of the last 5 and last 20, median log multiplier of
 *   the last 10 (robust to the heavy tail), log(1 + rounds in a row below 2×).
 * Fitted by Newton's method on the most recent WINDOW training rounds before the latest multiple of
 * REFIT rounds, so the fit is the same however the rounds were fed. Features are standardised with
 * training data only. With fewer than MIN_TRAIN training rounds it forecasts the baseline.
 */
export class LogitModel implements OnlineModel {
  readonly id = 'logit' as const;
  static readonly REFIT = 50;
  static readonly WINDOW = 500;
  static readonly MIN_TRAIN = 50;
  static readonly RIDGE = 2;
  private readonly logs: number[] = [];
  private readonly breaks: boolean[] = [];
  private readonly ys: number[] = [];
  private readonly feats: Array<number[] | null> = [];
  private fit: { w: number[][]; mean: number[]; sd: number[]; at: number } | null = null;
  constructor(private readonly base: BaselineModel) {}

  /** Features for a round at index i (rounds 0…i−1 are known). null when no earlier round in the run. */
  private features(i: number): number[] | null {
    const recent: number[] = [];
    let streak = 0;
    let streakOpen = true;
    for (let j = i - 1; j >= 0 && recent.length < 20; j--) {
      recent.push(this.logs[j]!);
      if (streakOpen) {
        if (this.ys[j] === 0) streak++;
        else streakOpen = false;
      }
      if (this.breaks[j]) break;
    }
    if (!recent.length) return null;
    const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
    const last10 = recent.slice(0, 10).sort((a, b) => a - b);
    const med = last10.length % 2 ? last10[(last10.length - 1) / 2]! : (last10[last10.length / 2 - 1]! + last10[last10.length / 2]!) / 2;
    return [recent[0]!, mean(recent.slice(0, 5)), mean(recent), med, Math.log1p(streak)];
  }

  observe(r: RoundInput): void {
    const i = this.logs.length;
    this.breaks.push(r.breakBefore);
    this.feats.push(r.breakBefore ? null : this.features(i));
    this.logs.push(Math.log(r.multiplier));
    this.ys.push(rangeIndex(r.multiplier));
  }

  private refit(at: number): void {
    const rows: number[][] = [];
    const ys: number[] = [];
    for (let i = Math.max(0, at - LogitModel.WINDOW); i < at; i++) {
      const f = this.feats[i];
      if (!f) continue;
      rows.push(f);
      ys.push(this.ys[i]!);
    }
    if (rows.length < LogitModel.MIN_TRAIN) {
      this.fit = { w: [], mean: [], sd: [], at };
      return;
    }
    const mean = new Array<number>(N_FEAT).fill(0);
    const sd = new Array<number>(N_FEAT).fill(1);
    for (let f = 0; f < N_FEAT; f++) {
      const mu = rows.reduce((a, r) => a + r[f]!, 0) / rows.length;
      const v = rows.reduce((a, r) => a + (r[f]! - mu) ** 2, 0) / rows.length;
      mean[f] = mu;
      sd[f] = v > 1e-12 ? Math.sqrt(v) : 1;
    }
    const X = rows.map((r) => [1, ...r.map((v, f) => (v - mean[f]!) / sd[f]!)]);
    const D = N_CLASS_FREE * N_PAR;
    let w = Array.from({ length: N_CLASS_FREE }, () => new Array<number>(N_PAR).fill(0));
    // Start the intercepts at the training class shares (log-odds against class 0).
    const share = zeros();
    for (const y of ys) share[y]!++;
    for (let c = 1; c < RANGE_COUNT; c++) w[c - 1]![0] = Math.log((share[c]! + 0.5) / (share[0]! + 0.5));
    for (let iter = 0; iter < 20; iter++) {
      const g = new Array<number>(D).fill(0);
      const H = Array.from({ length: D }, () => new Array<number>(D).fill(0));
      for (let r = 0; r < X.length; r++) {
        const x = X[r]!;
        const z = [0, ...w.map((wc) => wc.reduce((a, v, k) => a + v * x[k]!, 0))];
        const p = softmax(z);
        for (let a = 0; a < N_CLASS_FREE; a++) {
          const e = (ys[r] === a + 1 ? 1 : 0) - p[a + 1]!;
          for (let k = 0; k < N_PAR; k++) g[a * N_PAR + k]! += e * x[k]!;
          for (let b = a; b < N_CLASS_FREE; b++) {
            const q = (a === b ? p[a + 1]! : 0) - p[a + 1]! * p[b + 1]!;
            for (let k = 0; k < N_PAR; k++) {
              const qk = q * x[k]!;
              for (let l = 0; l < N_PAR; l++) H[a * N_PAR + k]![b * N_PAR + l]! += qk * x[l]!;
            }
          }
        }
      }
      for (let i = 0; i < D; i++) {
        for (let j = 0; j < i; j++) H[i]![j] = H[j]![i]!;
        if (i % N_PAR !== 0) {
          // ridge on slopes only
          H[i]![i]! += LogitModel.RIDGE;
          g[i]! -= LogitModel.RIDGE * w[Math.floor(i / N_PAR)]![i % N_PAR]!;
        }
        H[i]![i]! += 1e-9;
      }
      let step: number[];
      try {
        step = solve(H, g);
      } catch {
        break;
      }
      w = w.map((wc, a) => wc.map((v, k) => v + step[a * N_PAR + k]!));
      if (Math.max(...step.map(Math.abs)) < 1e-8) break;
    }
    this.fit = w.every((wc) => wc.every(Number.isFinite)) ? { w, mean, sd, at } : { w: [], mean: [], sd: [], at };
  }

  predict(): number[] {
    const n = this.logs.length;
    const at = Math.floor(n / LogitModel.REFIT) * LogitModel.REFIT;
    if (!this.fit || this.fit.at !== at) this.refit(at);
    const fit = this.fit!;
    const f = this.features(n);
    if (!fit.w.length || !f) return this.base.predict();
    const x = [1, ...f.map((v, k) => (v - fit.mean[k]!) / fit.sd[k]!)];
    const p = softmax([0, ...fit.w.map((wc) => wc.reduce((a, v, k) => a + v * x[k]!, 0))]);
    return normalise(p);
  }
}

/* ---------------------------------------------------------------- Bayesian online change-point */

/**
 * Adams & MacKay (2007) Bayesian online change-point detection with a Dirichlet–categorical model
 * of the range in each segment (prior Dirichlet(10 × RTP reference), as the baseline) and a
 * constant hazard of 1/250 per round. The forecast averages the segment predictives over the
 * run-length posterior. Run lengths beyond MAX_RUN are merged (keeps cost O(MAX_RUN) per round).
 */
export class ChangepointModel implements OnlineModel {
  readonly id = 'changepoint' as const;
  static readonly HAZARD = 1 / 250;
  static readonly MAX_RUN = 400;
  /** P(run length = r) for r < len, the range counts of each run length (flat, 4 per r) and their totals. */
  private rl = new Float64Array(ChangepointModel.MAX_RUN);
  private cnt = new Float64Array(ChangepointModel.MAX_RUN * RANGE_COUNT);
  private tot = new Float64Array(ChangepointModel.MAX_RUN);
  private len = 1;

  constructor() {
    this.rl[0] = 1;
  }

  /** Segment predictive P(range k | run length r). */
  private pred(r: number, k: number): number {
    return (this.cnt[r * RANGE_COUNT + k]! + BASELINE_PRIOR_ROUNDS * RTP_REFERENCE[k]!) / (this.tot[r]! + BASELINE_PRIOR_ROUNDS);
  }

  observe(r: RoundInput): void {
    const y = rangeIndex(r.multiplier);
    const H = ChangepointModel.HAZARD;
    const K = RANGE_COUNT;
    const MAX = ChangepointModel.MAX_RUN;
    let cp = 0;
    // Growth: run length i → i + 1, updated from the end so nothing is overwritten before it is read.
    const grown = Math.min(this.len + 1, MAX);
    if (this.len === MAX) {
      // Merge the two longest run lengths (their counts differ by at most one round of history).
      const a = MAX - 2;
      const pa = this.rl[a]! * this.pred(a, y);
      const pb = this.rl[a + 1]! * this.pred(a + 1, y);
      cp += (pa + pb) * H;
      const w = pa + pb;
      for (let k = 0; k < K; k++) {
        const ca = this.cnt[a * K + k]! + (k === y ? 1 : 0);
        const cb = this.cnt[(a + 1) * K + k]! + (k === y ? 1 : 0);
        this.cnt[(a + 1) * K + k] = w > 0 ? (ca * pa + cb * pb) / w : ca;
      }
      this.tot[a + 1] = w > 0 ? ((this.tot[a]! + 1) * pa + (this.tot[a + 1]! + 1) * pb) / w : this.tot[a]! + 1;
      this.rl[a + 1] = w * (1 - H);
    }
    const top = this.len === MAX ? MAX - 2 : this.len - 1;
    for (let i = top; i >= 0; i--) {
      const lik = this.rl[i]! * this.pred(i, y);
      cp += lik * H;
      this.rl[i + 1] = lik * (1 - H);
      for (let k = 0; k < K; k++) this.cnt[(i + 1) * K + k] = this.cnt[i * K + k]! + (k === y ? 1 : 0);
      this.tot[i + 1] = this.tot[i]! + 1;
    }
    this.rl[0] = cp;
    for (let k = 0; k < K; k++) this.cnt[k] = 0;
    this.tot[0] = 0;
    this.len = grown;
    let s = 0;
    for (let i = 0; i < this.len; i++) s += this.rl[i]!;
    if (s > 0) for (let i = 0; i < this.len; i++) this.rl[i]! /= s;
    else {
      this.rl.fill(0);
      this.rl[0] = 1;
    }
  }

  predict(): number[] {
    const p = zeros();
    for (let i = 0; i < this.len; i++) {
      const w = this.rl[i]!;
      if (w === 0) continue;
      for (let k = 0; k < RANGE_COUNT; k++) p[k]! += w * this.pred(i, k);
    }
    return normalise(p);
  }

  /** Posterior probability that the current segment is shorter than `rounds` (a recent change). */
  recentChangeProbability(rounds = 30): number {
    let s = 0;
    for (let i = 0; i < Math.min(rounds, this.len); i++) s += this.rl[i]!;
    return Math.min(1, Math.max(0, s));
  }
}

/* ---------------------------------------------------------------- the model set */

export interface ModelSet {
  baseline: BaselineModel;
  changepoint: ChangepointModel;
  all: OnlineModel[];
  observe(r: RoundInput): void;
  /** Range distribution of every model (ensemble excluded) for the next, unobserved round. */
  predictAll(): Record<Exclude<SignalModel, 'ensemble'>, number[]>;
}

export function createModelSet(): ModelSet {
  const baseline = new BaselineModel();
  const changepoint = new ChangepointModel();
  // The baseline is observed FIRST so candidates shrink toward the baseline including the same rounds.
  const all: OnlineModel[] = [baseline, new EwmaModel(baseline), new MarkovModel(baseline), new StreakModel(baseline), new LogitModel(baseline), changepoint];
  return {
    baseline,
    changepoint,
    all,
    observe: (r) => all.forEach((m) => m.observe(r)),
    predictAll: () => Object.fromEntries(all.map((m) => [m.id, m.predict()])) as ReturnType<ModelSet['predictAll']>,
  };
}
