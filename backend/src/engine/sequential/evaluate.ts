// Read-only evaluation of a round file: data quality, a walk-forward comparison of every forecaster
// against the baselines, and direct tests for temporal dependence and distribution change.
//
//   npm run evaluate:signal -w @aviator/backend -- <file.csv> [--limit N] [--compare N] [--reverse] [--controls] [--out report.md]
//   --limit N keeps the first N rounds of each sequence; --compare N runs the (slower) forecaster
//   replay on the first N of those only. Data quality and dependence tests always use all kept rounds.
//
// Same file formats as backtest.ts. Forecasts come from replay() (the live process: issued before
// each round, scored after it); the extra baselines below are computed walk-forward from the rounds
// before each scored round, on exactly the same scored rounds, so every comparison is paired.
// --controls adds SIMULATED negative controls (independent rounds) and positive controls (planted
// dependence) for the dependence tests and the model comparison. Nothing is written to a database.
import { writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { RANGE_COUNT, rangeIndex, SIGNAL_CANDIDATES } from '@aviator/contracts';
import { normalCdf } from '../forecast.js';
import { loadFile } from './backtest.js';
import { breaksOf, brier, logLoss, MODEL_NAME, replay, topRange, type LedgerEntry, type LedgerRound } from './engine.js';
import { RTP_REFERENCE } from './models.js';
import { asRounds, fairSequence, plantedSequence } from './simulate.js';

/* ---------------------------------------------------------------- distributions */

function lnGamma(z: number): number {
  const c = [676.5203681218851, -1259.1392167224028, 771.3234287776531, -176.6150291621406, 12.507343278686905, -0.13857109526572012, 9.984369578019572e-6, 1.5056327351493116e-7];
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - lnGamma(1 - z);
  z -= 1;
  let x = 0.9999999999998099;
  for (let i = 0; i < c.length; i++) x += c[i]! / (z + i + 1);
  const t = z + c.length - 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

/** Regularized upper incomplete gamma Q(a, x) (Numerical Recipes 6.2). */
export function gammaQ(a: number, x: number): number {
  if (x <= 0) return 1;
  const lead = -x + a * Math.log(x) - lnGamma(a);
  if (x < a + 1) {
    let ap = a;
    let del = 1 / a;
    let sum = del;
    for (let n = 0; n < 1000; n++) {
      ap++;
      del *= x / ap;
      sum += del;
      if (Math.abs(del) < Math.abs(sum) * 1e-15) break;
    }
    return Math.max(0, 1 - sum * Math.exp(lead));
  }
  const tiny = 1e-300;
  let b = x + 1 - a;
  let c = 1 / tiny;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i < 1000; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < tiny) d = tiny;
    c = b + an / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-15) break;
  }
  return Math.exp(lead) * h;
}

export const chi2Sf = (x: number, df: number) => gammaQ(df / 2, x / 2);
const twoSided = (z: number) => 2 * (1 - normalCdf(Math.abs(z)));

/** Pearson chi-square test of independence for a contingency table (rows/cols with zero total dropped). */
export function chi2Independence(table: number[][]): { stat: number; df: number; p: number; cramersV: number } {
  const rows = table.filter((r) => r.reduce((a, v) => a + v, 0) > 0);
  const colTot = rows[0] ? rows[0].map((_, j) => rows.reduce((a, r) => a + r[j]!, 0)) : [];
  const cols = colTot.map((t, j) => (t > 0 ? j : -1)).filter((j) => j >= 0);
  const n = rows.reduce((a, r) => a + r.reduce((x, v) => x + v, 0), 0);
  let stat = 0;
  for (const r of rows) {
    const rt = r.reduce((a, v) => a + v, 0);
    for (const j of cols) {
      const e = (rt * colTot[j]!) / n;
      stat += (r[j]! - e) ** 2 / e;
    }
  }
  const df = (rows.length - 1) * (cols.length - 1);
  const k = Math.min(rows.length, cols.length) - 1;
  return { stat, df, p: df > 0 ? chi2Sf(stat, df) : 1, cramersV: k > 0 && n > 0 ? Math.sqrt(stat / (n * k)) : 0 };
}

/** Benjamini–Hochberg adjusted p-values (same order as the input). */
export function bhAdjust(ps: readonly number[]): number[] {
  const order = ps.map((p, i) => [p, i] as const).sort((a, b) => a[0] - b[0]);
  const out = new Array<number>(ps.length);
  let min = 1;
  for (let r = order.length - 1; r >= 0; r--) {
    min = Math.min(min, (order[r]![0] * ps.length) / (r + 1));
    out[order[r]![1]] = min;
  }
  return out;
}

/** Holm step-down adjusted p-values (family-wise error control). */
export function holmAdjust(ps: readonly number[]): number[] {
  const order = ps.map((p, i) => [p, i] as const).sort((a, b) => a[0] - b[0]);
  const out = new Array<number>(ps.length);
  let max = 0;
  order.forEach(([p, i], r) => {
    max = Math.max(max, Math.min(1, p * (ps.length - r)));
    out[i] = max;
  });
  return out;
}

/* ---------------------------------------------------------------- data quality */

export interface Quality {
  rounds: number;
  runs: number;
  longestRun: number;
  roundsInRunsOf20: number;
  medianIntervalS: number | null;
  p95IntervalS: number | null;
  longIntervals: number;
  sameTimestamp: number;
  /** Adjacent equal multipliers within runs, and the count expected for independent rounds. */
  repeats: number;
  repeatsExpected: number;
  backfill: number;
}

/** Consecutive runs (split at breaks), interval statistics and timing anomalies. */
export function qualityOf(rounds: readonly LedgerRound[]): Quality {
  const breaks = breaksOf(rounds);
  const lengths: number[] = [];
  breaks.forEach((b, i) => (b || i === 0 ? lengths.push(1) : lengths[lengths.length - 1]!++));
  const iv: number[] = [];
  let same = 0;
  for (let i = 1; i < rounds.length; i++) {
    const d = (rounds[i]!.receivedAt.getTime() - rounds[i - 1]!.receivedAt.getTime()) / 1000;
    if (d === 0) same++;
    if (!breaks[i]) iv.push(d);
  }
  iv.sort((a, b) => a - b);
  const freq = new Map<number, number>();
  rounds.forEach((r) => freq.set(r.multiplier, (freq.get(r.multiplier) ?? 0) + 1));
  const pSame = [...freq.values()].reduce((a, c) => a + (c / rounds.length) ** 2, 0);
  let repeats = 0;
  let pairs = 0;
  for (let i = 1; i < rounds.length; i++) if (!breaks[i]) (pairs++, rounds[i]!.multiplier === rounds[i - 1]!.multiplier && repeats++);
  const q = (f: number) => (iv.length ? iv[Math.min(iv.length - 1, Math.floor(f * iv.length))]! : null);
  const med = q(0.5);
  return {
    rounds: rounds.length,
    runs: lengths.length,
    longestRun: Math.max(0, ...lengths),
    roundsInRunsOf20: lengths.filter((l) => l >= 20).reduce((a, v) => a + v, 0),
    medianIntervalS: med,
    p95IntervalS: q(0.95),
    longIntervals: med ? iv.filter((d) => d > 3 * med).length : 0,
    sameTimestamp: same,
    repeats,
    repeatsExpected: pairs * pSame,
    backfill: rounds.filter((r) => r.source === 'backfill').length,
  };
}

/* ---------------------------------------------------------------- dependence tests */

export interface TestResult {
  name: string;
  question: string;
  stat: string;
  p: number;
  effect: string;
}

/** Splits a round list into consecutive runs of multipliers (no pair is formed across a break). */
export function runsOf(rounds: readonly LedgerRound[]): number[][] {
  const out: number[][] = [];
  breaksOf(rounds).forEach((b, i) => (b ? out.push([rounds[i]!.multiplier]) : out[out.length - 1]!.push(rounds[i]!.multiplier)));
  return out;
}

/**
 * Portmanteau Q = Σ_k pairs_k · r_k² over lags 1…L (Box–Pierce; ≈ Ljung–Box for long runs), with
 * autocorrelations pooled over runs: pairs are formed only within a run. χ²(L) under independence.
 */
function ljungBox(runs: number[][], f: (m: number, i: number, run: number) => number, L = 10): { q: number; maxAbs: number; r1: number } {
  const ys = runs.map((r, ri) => r.map((m, i) => f(m, i, ri)));
  const all = ys.flat();
  const n = all.length;
  const mu = all.reduce((a, v) => a + v, 0) / n;
  const c0 = all.reduce((a, v) => a + (v - mu) ** 2, 0) / n;
  let q = 0;
  let maxAbs = 0;
  let r1 = 0;
  for (let k = 1; k <= L; k++) {
    let ck = 0;
    let pairs = 0;
    for (const y of ys) for (let i = k; i < y.length; i++) (ck += (y[i]! - mu) * (y[i - k]! - mu)), pairs++;
    if (pairs === 0) continue;
    const rk = ck / pairs / c0;
    if (k === 1) r1 = rk;
    maxAbs = Math.max(maxAbs, Math.abs(rk));
    q += rk * rk * pairs;
  }
  return { q, maxAbs, r1 };
}

export function dependenceTests(rounds: readonly LedgerRound[]): TestResult[] {
  const runs = runsOf(rounds);
  const flat = runs.flat();
  const n = flat.length;
  const high = (m: number) => (m >= 2 ? 1 : 0);
  const out: TestResult[] = [];

  // 1–2. Serial correlation of "≥ 2×" and of the multiplier's rank (heavy-tail robust).
  const lbH = ljungBox(runs, high);
  out.push({ name: 'Serial correlation of ≥ 2× (lags 1–10)', question: 'Does whether a round reached 2× depend on the previous 10 rounds?', stat: `Q = ${lbH.q.toFixed(1)}, df 10`, p: chi2Sf(lbH.q, 10), effect: `lag-1 r = ${lbH.r1.toFixed(4)}; max |r| = ${lbH.maxAbs.toFixed(4)}` });
  const sorted = [...flat].sort((a, b) => a - b);
  const rankOf = new Map<number, number>();
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j < sorted.length && sorted[j] === sorted[i]) j++;
    rankOf.set(sorted[i]!, (i + j + 1) / 2 / (n + 1)); // mid-rank, in (0, 1)
    i = j;
  }
  const lbR = ljungBox(runs, (m) => rankOf.get(m)!);
  out.push({ name: 'Serial correlation of multiplier rank (lags 1–10)', question: 'Do big/small multipliers cluster in time?', stat: `Q = ${lbR.q.toFixed(1)}, df 10`, p: chi2Sf(lbR.q, 10), effect: `lag-1 r = ${lbR.r1.toFixed(4)}; max |r| = ${lbR.maxAbs.toFixed(4)}` });

  // 3. Wald–Wolfowitz runs test of below/above 2×, summed over runs.
  let R = 0;
  let ER = 0;
  let VR = 0;
  for (const r of runs) {
    if (r.length < 2) continue;
    const n1 = r.filter((m) => m >= 2).length;
    const n2 = r.length - n1;
    const N = r.length;
    for (let i = 0; i < N; i++) if (i === 0 || high(r[i]!) !== high(r[i - 1]!)) R++;
    ER += 1 + (2 * n1 * n2) / N;
    VR += (2 * n1 * n2 * (2 * n1 * n2 - N)) / (N * N * (N - 1));
  }
  const zR = VR > 0 ? (R - ER) / Math.sqrt(VR) : 0;
  out.push({ name: 'Runs test (below / at or above 2×)', question: 'Are there more or fewer streaks than chance?', stat: `runs ${R.toLocaleString('en-US')} vs expected ${ER.toFixed(0)}, z = ${zR.toFixed(2)}`, p: twoSided(zR), effect: `${(((R - ER) / ER) * 100).toFixed(2)}% vs expected` });

  // 4. Previous range → next range (4 × 4).
  const trans = Array.from({ length: RANGE_COUNT }, () => new Array<number>(RANGE_COUNT).fill(0));
  for (const r of runs) for (let i = 1; i < r.length; i++) trans[rangeIndex(r[i - 1]!)]![rangeIndex(r[i]!)]!++;
  const tm = chi2Independence(trans);
  const pHighAfter = trans.map((row) => {
    const t = row.reduce((a, v) => a + v, 0);
    return t ? (row[1]! + row[2]! + row[3]!) / t : NaN;
  });
  out.push({ name: 'Previous range → next range', question: 'Does the next range depend on the previous range?', stat: `χ² = ${tm.stat.toFixed(1)}, df ${tm.df}`, p: tm.p, effect: `Cramér's V ${tm.cramersV.toFixed(4)}; P(≥2×) after each range: ${pHighAfter.map((v) => (v * 100).toFixed(1) + '%').join(' / ')}` });

  // 5. Rounds since the last 2× (0, 1, 2, 3, 4, 5+) → next round ≥ 2×.
  const streakTab = Array.from({ length: 6 }, () => [0, 0]);
  for (const r of runs) {
    let s: number | null = null; // lows in a row since the last 2×; unknown until a 2× is seen in this run
    for (const m of r) {
      if (s !== null) streakTab[Math.min(5, s)]![high(m)]!++;
      if (m >= 2) s = 0;
      else if (s !== null) s++;
    }
  }
  const st = chi2Independence(streakTab);
  out.push({
    name: 'Rounds below 2× in a row → next round ≥ 2×',
    question: 'Is a high round "due" (or less likely) after a losing streak?',
    stat: `χ² = ${st.stat.toFixed(1)}, df ${st.df}`,
    p: st.p,
    effect: `P(≥2×) after 0/1/2/3/4/5+ lows: ${streakTab.map(([lo, hi]) => (lo! + hi! ? ((hi! / (lo! + hi!)) * 100).toFixed(1) + '%' : '—')).join(' / ')}`,
  });

  // 6. Distribution change: 10 chronological blocks × 4 ranges.
  const blocks = Array.from({ length: 10 }, () => new Array<number>(RANGE_COUNT).fill(0));
  flat.forEach((m, i) => blocks[Math.min(9, Math.floor((i * 10) / n))]![rangeIndex(m)]!++);
  const bt = chi2Independence(blocks);
  const bHigh = blocks.map((b) => (b[1]! + b[2]! + b[3]!) / b.reduce((a, v) => a + v, 0));
  out.push({ name: 'Distribution change over time (10 blocks)', question: 'Did the range frequencies shift during the period?', stat: `χ² = ${bt.stat.toFixed(1)}, df ${bt.df}`, p: bt.p, effect: `P(≥2×) by block ${(Math.min(...bHigh) * 100).toFixed(1)}%–${(Math.max(...bHigh) * 100).toFixed(1)}%` });

  // 7. Fit to the RTP reference P(M ≥ m) = 0.97 ÷ m.
  const counts = new Array<number>(RANGE_COUNT).fill(0);
  flat.forEach((m) => counts[rangeIndex(m)]!++);
  const gof = counts.reduce((a, c, k) => a + (c - n * RTP_REFERENCE[k]!) ** 2 / (n * RTP_REFERENCE[k]!), 0);
  out.push({ name: 'Fit to the RTP reference 0.97 ÷ m', question: 'Do the range frequencies match a 97%-RTP crash distribution?', stat: `χ² = ${gof.toFixed(1)}, df 3`, p: chi2Sf(gof, 3), effect: `observed ${counts.map((c) => ((c / n) * 100).toFixed(1) + '%').join(' / ')} vs reference ${RTP_REFERENCE.map((r) => (r * 100).toFixed(1) + '%').join(' / ')}` });
  return out;
}

/** The first six tests are about dependence/change; the RTP fit is a calibration check of the prior. */
const DEPENDENCE_TESTS = 6;

/* ---------------------------------------------------------------- forecaster comparison */

export const ARMS = ['shown', 'baseline', 'empirical', 'rtp', 'mostFrequent', ...SIGNAL_CANDIDATES, 'ensemble'] as const;
export type Arm = (typeof ARMS)[number];
export const ARM_NAME: Record<Arm, string> = {
  shown: 'Shown forecast (what the panel displayed)',
  baseline: 'Bayesian baseline (live engine)',
  empirical: 'Empirical range frequency (add-½, no prior)',
  rtp: 'Fixed RTP reference 0.97 ÷ m',
  mostFrequent: 'Most-frequent range so far (all-or-nothing)',
  ewma: MODEL_NAME.ewma,
  markov: `${MODEL_NAME.markov} (control)`,
  streak: `${MODEL_NAME.streak} (control)`,
  logit: MODEL_NAME.logit,
  changepoint: MODEL_NAME.changepoint,
  ensemble: MODEL_NAME.ensemble,
};
/** Arms tested against the Bayesian baseline (Holm-corrected as one family). */
const TESTED: Arm[] = ['empirical', 'rtp', ...SIGNAL_CANDIDATES, 'ensemble'];

export interface ScoredRow {
  y: number;
  p: Record<Arm, number[]>;
}

/** Every scored forecast with the distribution of every arm, each built only from earlier rounds. */
export function scoredRows(rounds: readonly LedgerRound[], entries: readonly LedgerEntry[]): ScoredRow[] {
  const pos = new Map(rounds.map((r, i) => [r.id, i]));
  const prefix: number[][] = [new Array<number>(RANGE_COUNT).fill(0)];
  rounds.forEach((r) => {
    const c = [...prefix[prefix.length - 1]!];
    c[rangeIndex(r.multiplier)]!++;
    prefix.push(c);
  });
  const rows: ScoredRow[] = [];
  for (const e of entries) {
    if (e.outcome?.status !== 'scored') continue;
    const known = pos.get(e.forecast.inputLastRoundId)! + 1; // rounds the forecast could see
    if (pos.get(e.outcome.roundId)! < known) throw new Error('look-ahead: outcome round is not after the input boundary');
    const c = prefix[known]!;
    const tot = c.reduce((a, v) => a + v, 0);
    const mf = topRange(c);
    const v = e.forecast.vectors;
    rows.push({
      y: e.outcome.range,
      p: {
        shown: e.forecast.probabilities,
        baseline: v.baseline,
        empirical: c.map((x) => (x + 0.5) / (tot + RANGE_COUNT * 0.5)),
        rtp: [...RTP_REFERENCE],
        mostFrequent: c.map((_, k) => (k === mf ? 1 : 0)),
        ewma: v.ewma,
        markov: v.markov,
        streak: v.streak,
        logit: v.logit,
        changepoint: v.changepoint,
        ensemble: v.ensemble,
      },
    });
  }
  return rows;
}

export interface ArmScore {
  arm: Arm;
  n: number;
  hit: number;
  brier: number;
  logLoss: number;
  diff: number;
  lo: number;
  hi: number;
  /** One-sided p of "lower log loss than the Bayesian baseline". */
  p: number;
  calZ2: number;
  rollingBest: number;
  rollingWorst: number;
  rollingWinShare: number;
}

export const ROLLING = 1000;

export function scoreArms(rows: readonly ScoredRow[]): ArmScore[] {
  return ARMS.map((arm) => {
    const ll = rows.map((r) => logLoss(r.p[arm], r.y));
    const d = rows.map((r, i) => ll[i]! - logLoss(r.p.baseline, r.y));
    const n = rows.length;
    const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / Math.max(1, a.length);
    const dm = mean(d);
    const sd = Math.sqrt(d.reduce((a, v) => a + (v - dm) ** 2, 0) / Math.max(1, n - 1));
    const se = sd / Math.sqrt(Math.max(1, n));
    const p2 = rows.map((r) => r.p[arm][1]! + r.p[arm][2]! + r.p[arm][3]!);
    const y2 = rows.map((r) => (r.y >= 1 ? 1 : 0));
    const num = p2.reduce((a, p, i) => a + (y2[i]! - p), 0);
    const den = Math.sqrt(p2.reduce((a, p) => a + p * (1 - p), 0));
    const windows: number[] = [];
    for (let s = 0; s + ROLLING <= n; s += ROLLING / 2) windows.push(mean(d.slice(s, s + ROLLING)));
    return {
      arm,
      n,
      hit: rows.filter((r) => topRange(r.p[arm]) === r.y).length / Math.max(1, n),
      brier: mean(rows.map((r) => brier(r.p[arm], r.y))),
      logLoss: mean(ll),
      diff: dm,
      lo: dm - 1.96 * se,
      hi: dm + 1.96 * se,
      p: se > 0 ? normalCdf(dm / se) : 1,
      calZ2: den > 0 ? num / den : 0,
      rollingBest: windows.length ? Math.min(...windows) : NaN,
      rollingWorst: windows.length ? Math.max(...windows) : NaN,
      rollingWinShare: windows.length ? windows.filter((w) => w < 0).length / windows.length : NaN,
    };
  });
}

/* ---------------------------------------------------------------- report */

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
const f5 = (v: number) => (Number.isFinite(v) ? (v >= 0 ? '+' : '') + v.toFixed(5) : '—');
const pv = (p: number) => (p < 1e-4 ? p.toExponential(1) : p.toFixed(4));

export interface SeriesEvaluation {
  quality: Quality;
  tests: TestResult[];
  adjusted: number[];
  arms: ArmScore[];
  holm: Map<Arm, number>;
  scored: number;
  voided: number;
}

/** Dependence tests and data quality use every round; the forecaster comparison the first `compareLimit`. */
export function evaluateRounds(rounds: readonly LedgerRound[], compareLimit = Infinity): SeriesEvaluation {
  const tests = dependenceTests(rounds);
  const compared = rounds.slice(0, compareLimit);
  const r = replay(compared);
  const rows = scoredRows(compared, r.entries);
  const arms = scoreArms(rows);
  const tested = arms.filter((a) => TESTED.includes(a.arm));
  const holm = holmAdjust(tested.map((a) => a.p));
  return {
    quality: qualityOf(rounds),
    tests,
    adjusted: bhAdjust(tests.slice(0, DEPENDENCE_TESTS).map((t) => t.p)),
    arms,
    holm: new Map(tested.map((a, i) => [a.arm, holm[i]!])),
    scored: rows.length,
    voided: r.entries.filter((e) => e.outcome?.status === 'void').length,
  };
}

export function reportEvaluation(name: string, note: string, ev: SeriesEvaluation): string {
  const q = ev.quality;
  const out: string[] = [`### ${name}`, '', `${note}.`, ''];
  out.push('**Data quality**', '', '| Rounds | Consecutive runs | Longest run | Rounds in runs ≥ 20 | Median / p95 interval | Intervals > 3× median (likely missed rounds) | Identical timestamps (ms) | Adjacent repeats observed / expected |', '|---|---|---|---|---|---|---|---|');
  out.push(
    `| ${q.rounds.toLocaleString('en-US')} | ${q.runs.toLocaleString('en-US')} | ${q.longestRun.toLocaleString('en-US')} | ${q.roundsInRunsOf20.toLocaleString('en-US')} | ${q.medianIntervalS ?? '—'} s / ${q.p95IntervalS ?? '—'} s | ${q.longIntervals.toLocaleString('en-US')} | ${q.sameTimestamp.toLocaleString('en-US')} | ${q.repeats.toLocaleString('en-US')} / ${q.repeatsExpected.toFixed(0)} |`,
    '',
  );
  out.push('**Temporal dependence and distribution change** (pairs only within consecutive runs; Benjamini–Hochberg over the six dependence tests)', '');
  out.push('| Test | Statistic | p | BH-adjusted p | Effect size |', '|---|---|---|---|---|');
  ev.tests.forEach((t, i) => out.push(`| ${t.name} | ${t.stat} | ${pv(t.p)} | ${i < DEPENDENCE_TESTS ? pv(ev.adjusted[i]!) : '— (prior check)'} | ${t.effect} |`));
  out.push('');
  out.push(
    `**Walk-forward forecaster comparison** — ${ev.scored.toLocaleString('en-US')} scored forecasts (${ev.voided.toLocaleString('en-US')} void). Log-loss difference is vs the Bayesian baseline on the same rounds (negative = better), 95% CI. Holm-corrected one-sided p over the ${TESTED.length} tested forecasters. Rolling = ${ROLLING}-round windows (half-overlapping).`,
    '',
  );
  out.push('| Forecaster | Top-range hit | Brier | Log loss | Δ log loss vs baseline [95% CI] | Holm p (better) | Calibration Z (≥2×) | Rolling Δ best / worst | Windows ahead |', '|---|---|---|---|---|---|---|---|---|');
  for (const a of ev.arms) {
    const deterministic = a.arm === 'mostFrequent';
    out.push(
      `| ${ARM_NAME[a.arm]} | ${pct(a.hit)} | ${a.brier.toFixed(4)} | ${deterministic ? '∞ (gives 0% to every other range)' : a.logLoss.toFixed(5)} | ${a.arm === 'baseline' || deterministic ? '—' : `${f5(a.diff)} [${f5(a.lo)}, ${f5(a.hi)}]`} | ${ev.holm.has(a.arm) ? pv(ev.holm.get(a.arm)!) : '—'} | ${deterministic ? '—' : a.calZ2.toFixed(2)} | ${a.arm === 'baseline' || deterministic ? '—' : `${f5(a.rollingBest)} / ${f5(a.rollingWorst)}`} | ${a.arm === 'baseline' || deterministic || Number.isNaN(a.rollingWinShare) ? '—' : pct(a.rollingWinShare)} |`,
    );
  }
  out.push('');
  return out.join('\n');
}

/** Simulated controls: false-positive rate and power of the dependence tests and the comparison. */
export function evaluationControls(histories = 60, n = 5000): string {
  const out: string[] = ['## Controls (SIMULATED rounds — not real game data)', ''];
  const run = (label: string, make: (seed: number) => number[], k: number) => {
    const rejectTest = new Array<number>(DEPENDENCE_TESTS).fill(0);
    let anyBH = 0;
    let anyModel = 0;
    let rtpBetter = 0;
    let rollingFake = 0;
    let names: string[] = [];
    for (let s = 0; s < k; s++) {
      const ev = evaluateRounds(asRounds(make(s)));
      names = ev.tests.slice(0, DEPENDENCE_TESTS).map((t) => t.name);
      ev.tests.slice(0, DEPENDENCE_TESTS).forEach((t, i) => t.p < 0.05 && rejectTest[i]!++);
      if (ev.adjusted.some((p) => p < 0.05)) anyBH++;
      if ([...ev.holm].some(([arm, p]) => arm !== 'rtp' && p < 0.05)) anyModel++;
      if ((ev.holm.get('rtp') ?? 1) < 0.05) rtpBetter++;
      if (ev.arms.some((a) => TESTED.includes(a.arm) && a.rollingBest < -0.003)) rollingFake++;
    }
    out.push(`**${label}** — ${k} histories × ${n.toLocaleString('en-US')} rounds`, '');
    out.push('| Test | Histories with p < 0.05 |', '|---|---|');
    names.forEach((nm, i) => out.push(`| ${nm} | ${rejectTest[i]} (${pct(rejectTest[i]! / k)}) |`));
    out.push(`| Any dependence test after BH (FDR 5%) | ${anyBH} (${pct(anyBH / k)}) |`);
    out.push(`| Any learning forecaster better than baseline (Holm, 5%) | ${anyModel} (${pct(anyModel / k)}) |`);
    out.push(`| Fixed RTP reference better than baseline (Holm, 5%; it is the true distribution here) | ${rtpBetter} (${pct(rtpBetter / k)}) |`);
    out.push(`| Some forecaster ahead by > 0.003 in its best ${ROLLING}-round window | ${rollingFake} (${pct(rollingFake / k)}) |`, '');
  };
  run('Negative control: independent rounds, P(M ≥ m) = 0.97 ÷ m', (s) => fairSequence(n, 50_000 + s), histories);
  run('Positive control: planted previous-round effect ±0.05 on P(≥ 2×)', (s) => plantedSequence(n, 60_000 + s, 0.05), Math.max(10, Math.floor(histories / 3)));
  out.push('Expected under the negative control: each single test rejects in about 5% of histories, and the corrected families in at most about 5%. Short-window "wins" on independent rounds show why a model that looks ahead over the last few hundred rounds is not evidence of an edge.', '');
  return out.join('\n');
}

const isMain = process.argv[1] && /evaluate\.(ts|js)$/.test(process.argv[1]);
if (isMain) {
  const args = process.argv.slice(2);
  const valueOf = (flag: string) => (args.indexOf(flag) >= 0 ? args[args.indexOf(flag) + 1] : undefined);
  const outFile = valueOf('--out');
  const limit = Number(valueOf('--limit') ?? Infinity);
  const compare = Number(valueOf('--compare') ?? Infinity);
  const skip = new Set(['--out', '--limit', '--compare'].map((f) => args.indexOf(f) + 1).filter((i) => i > 0));
  const files = args.filter((a, i) => !a.startsWith('--') && !skip.has(i));
  const parts: string[] = ['# Evaluation report — data quality, dependence tests, forecaster comparison', '', `Generated ${new Date().toISOString()} by \`npm run evaluate:signal\`. Read-only.`, ''];
  for (const f of files) {
    const { series, invalid, duplicates } = loadFile(f, args.includes('--reverse'));
    parts.push(`## ${basename(f)}`, '', `Invalid values skipped: ${invalid}. Exact duplicate rows removed: ${duplicates}.`, '');
    for (const s of series) {
      if (s.rounds.length > limit) {
        s.note += `; first ${limit.toLocaleString('en-US')} of ${s.rounds.length.toLocaleString('en-US')} rounds used`;
        s.rounds = s.rounds.slice(0, limit);
      }
      if (s.rounds.length > compare) s.note += `; forecaster comparison on the first ${compare.toLocaleString('en-US')}`;
      parts.push(reportEvaluation(s.name, s.note, evaluateRounds(s.rounds, compare)));
      console.error(`done: ${s.name}`);
    }
  }
  if (args.includes('--controls')) parts.push(evaluationControls());
  const report = parts.join('\n');
  if (outFile) writeFileSync(outFile, report);
  else console.log(report);
}
