import { ANALYSIS_THRESHOLDS, } from '@aviator/contracts';
/**
 * 50 rounds to learn from + at least 50 scored test rounds = the 100-round minimum. That minimum only
 * starts the test; whether a target can be judged is decided separately by MIN_EVENTS.
 */
export const FORECAST_DEFAULTS = Object.freeze({ trainInitial: 50, minTestRounds: 50, refitEvery: 50, gapSeconds: 120 });
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
/** Below this many rounds a candidate must also pass the permutation test (see permutationP). */
export const PERMUTATION_MAX_ROUNDS = 1000;
/**
 * Shuffles per test. The smallest attainable p-value is 1 ÷ (249 + 1) = 0.004, just below 0.05 ÷ 12,
 * so a candidate passes only if NO shuffle does as well as the real order. More shuffles would not
 * change that decision rule's exactness, only its run time.
 */
export const PERMUTATIONS = 249;
/* ---------------------------------------------------------------- past-only view */
/** Read-only view of the rounds strictly before index `length`. Reading any later round throws. */
export class Past {
    m;
    seg;
    length;
    constructor(m, seg, length) {
        this.m = m;
        this.seg = seg;
        this.length = length;
    }
    check(i) {
        if (!Number.isInteger(i) || i < 0 || i >= this.length)
            throw new RangeError(`round ${i} is not in the past (length ${this.length})`);
    }
    multiplier(i) {
        this.check(i);
        return this.m[i];
    }
    hit(i, threshold) {
        return this.multiplier(i) >= threshold;
    }
    segment(i) {
        this.check(i);
        return this.seg[i];
    }
    /** The first `len` rounds (never more than this view holds). */
    prefix(len) {
        return new Past(this.m, this.seg, Math.max(0, Math.min(len, this.length)));
    }
    /** Identity of the underlying round series (for caches of values that depend only on earlier rounds). */
    get series() {
        return this.m;
    }
    /** Same run of consecutive stored rounds as the previous round (i ≥ 1). */
    contiguous(i) {
        return i > 0 && this.segment(i) === this.segment(i - 1);
    }
}
const clip = (p) => Math.min(1 - EPS, Math.max(EPS, p));
function countHits(past, threshold, from = 0) {
    let k = 0;
    for (let i = from; i < past.length; i++)
        if (past.hit(i, threshold))
            k++;
    return k;
}
/** Wilson 95% interval for k successes in n trials. */
export function wilson(k, n) {
    if (n <= 0)
        return [0, 1];
    const p = k / n;
    const z2 = Z95 * Z95;
    const den = 1 + z2 / n;
    const centre = (p + z2 / (2 * n)) / den;
    const half = (Z95 * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / den;
    return [Math.max(0, centre - half), Math.min(1, centre + half)];
}
const jeffreys = (k, n) => (k + 0.5) / (n + 1);
const constant = (p, iv) => ({ p: () => clip(p), interval: () => iv });
const baseRate = {
    id: 'base_rate',
    usesRecentRounds: false,
    selectable: true,
    fit(train, t) {
        const k = countHits(train, t);
        return constant(jeffreys(k, train.length), wilson(k, train.length));
    },
};
const rtpReference = {
    id: 'rtp_reference',
    usesRecentRounds: false,
    selectable: false,
    fit(_train, t) {
        const p = Math.min(1, RTP_REFERENCE / t);
        return constant(p, [p, p]);
    },
};
const ROLLING_WINDOW = 50;
const rolling50 = {
    id: 'rolling_50',
    usesRecentRounds: true,
    selectable: true,
    fit(_train, t) {
        const cell = (past) => {
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
function conditional(id, buckets, state) {
    return {
        id,
        usesRecentRounds: true,
        selectable: true,
        fit(train, t) {
            const k = new Float64Array(buckets);
            const n = new Float64Array(buckets);
            for (let i = 1; i < train.length; i++) {
                if (!train.contiguous(i))
                    continue;
                const b = state(train, i, t);
                n[b]++;
                if (train.hit(i, t))
                    k[b]++;
            }
            const base = jeffreys(countHits(train, t), train.length);
            const cell = (past) => (past.length > 0 ? state(past, past.length, t) : -1);
            return {
                p: (past) => {
                    const b = cell(past);
                    return clip(b < 0 ? base : (k[b] + SHRINK * base) / (n[b] + SHRINK));
                },
                interval: (past) => {
                    const b = cell(past);
                    return b < 0 ? wilson(0, 0) : wilson(k[b], n[b]);
                },
            };
        },
    };
}
/** State 0/1: whether the previous round reached the threshold. */
const afterPrevious = conditional('after_previous', 2, (past, i, t) => (past.hit(i - 1, t) ? 1 : 0));
/** Rounds in a row before i (within the run) that did NOT reach the threshold, capped at `cap`. */
function missesBefore(past, i, t, cap) {
    let g = 0;
    for (let j = i - 1; j >= 0 && g < cap; j--) {
        if (past.hit(j, t))
            break;
        g++;
        if (j === 0 || !past.contiguous(j))
            break;
    }
    return g;
}
const SINCE_BUCKETS = [0, 1, 2, 3, 6, 11]; // 0 | 1 | 2 | 3–5 | 6–10 | 11+
const sinceLastHit = conditional('since_last_hit', SINCE_BUCKETS.length, (past, i, t) => {
    const g = missesBefore(past, i, t, 11);
    let b = 0;
    while (b + 1 < SINCE_BUCKETS.length && g >= SINCE_BUCKETS[b + 1])
        b++;
    return b;
});
/* ---- ridge logistic regression on recent-round features ---- */
const N_FEATURES = 5;
/** Features of round i, from rounds < i in the same run only. NaN where no earlier round exists. */
function features(past, i, t) {
    const window = (w) => {
        let s = 0;
        let c = 0;
        let hits = 0;
        for (let j = i - 1; j >= 0 && c < w; j--) {
            const m = past.multiplier(j);
            s += Math.log(m);
            if (m >= t)
                hits++;
            c++;
            if (j === 0 || !past.contiguous(j))
                break;
        }
        return { mean: c ? s / c : Number.NaN, share: c ? hits / c : Number.NaN };
    };
    const w1 = window(1);
    return [w1.mean, window(5).mean, window(20).mean, window(10).share, i > 0 ? Math.log1p(missesBefore(past, i, t, 50)) : Number.NaN];
}
function solve(a, b) {
    // Gaussian elimination with partial pivoting on a small dense system.
    const n = b.length;
    const m = a.map((row, r) => [...row, b[r]]);
    for (let c = 0; c < n; c++) {
        let piv = c;
        for (let r = c + 1; r < n; r++)
            if (Math.abs(m[r][c]) > Math.abs(m[piv][c]))
                piv = r;
        [m[c], m[piv]] = [m[piv], m[c]];
        const d = m[c][c];
        if (Math.abs(d) < 1e-12)
            throw new Error('singular');
        for (let r = 0; r < n; r++) {
            if (r === c)
                continue;
            const f = m[r][c] / d;
            for (let k = c; k <= n; k++)
                m[r][k] -= f * m[c][k];
        }
    }
    return m.map((row, r) => row[n] / row[r]);
}
const sigmoid = (z) => 1 / (1 + Math.exp(-z));
/**
 * Per-series cache. features(i) reads only rounds < i (computed from a prefix view of length i), so
 * a cached row is the same whichever later view asks for it. `lastW` warm-starts the next refit:
 * the ridge objective is strictly convex, so the starting point changes the iterations, not the result.
 */
const logisticCache = new WeakMap();
function cacheFor(past, t) {
    let byT = logisticCache.get(past.series);
    if (!byT)
        logisticCache.set(past.series, (byT = new Map()));
    let c = byT.get(t);
    if (!c)
        byT.set(t, (c = { rows: [], lastW: null }));
    return c;
}
function featureRow(past, i, t) {
    const c = cacheFor(past, t);
    return (c.rows[i] ??= features(past.prefix(i), i, t));
}
const logisticRecent = {
    id: 'logistic_recent',
    usesRecentRounds: true,
    selectable: true,
    fit(train, t) {
        const rows = [];
        const ys = [];
        for (let i = 1; i < train.length; i++) {
            if (!train.contiguous(i))
                continue;
            rows.push(featureRow(train, i, t));
            ys.push(train.hit(i, t) ? 1 : 0);
        }
        // Standardise with training statistics only; a missing feature becomes the training mean (0).
        const mean = new Array(N_FEATURES).fill(0);
        const sd = new Array(N_FEATURES).fill(1);
        for (let f = 0; f < N_FEATURES; f++) {
            const vals = rows.map((r) => r[f]).filter((v) => Number.isFinite(v));
            if (!vals.length)
                continue;
            const mu = vals.reduce((a, v) => a + v, 0) / vals.length;
            const v = vals.reduce((a, x) => a + (x - mu) ** 2, 0) / vals.length;
            mean[f] = mu;
            sd[f] = v > 1e-12 ? Math.sqrt(v) : 1;
        }
        const design = (raw) => [1, ...raw.map((v, f) => (Number.isFinite(v) ? (v - mean[f]) / sd[f] : 0))];
        const X = rows.map(design);
        const d = N_FEATURES + 1;
        const cache = cacheFor(train, t);
        let w = new Array(d).fill(0);
        const base = jeffreys(ys.reduce((a, y) => a + y, 0), ys.length);
        w[0] = Math.log(base / (1 - base));
        if (cache.lastW)
            w = [...cache.lastW];
        let H = [];
        for (let iter = 0; iter < 25; iter++) {
            const g = new Array(d).fill(0);
            H = Array.from({ length: d }, () => new Array(d).fill(0));
            for (let r = 0; r < X.length; r++) {
                const x = X[r];
                let z = 0;
                for (let k = 0; k < d; k++)
                    z += w[k] * x[k];
                const p = sigmoid(z);
                const q = p * (1 - p);
                const e = ys[r] - p;
                for (let a = 0; a < d; a++) {
                    g[a] += e * x[a];
                    for (let b = a; b < d; b++)
                        H[a][b] += q * x[a] * x[b];
                }
            }
            for (let a = 0; a < d; a++) {
                for (let b = 0; b < a; b++)
                    H[a][b] = H[b][a];
                if (a > 0) {
                    H[a][a] += RIDGE; // ridge penalty on the slopes, not the intercept
                    g[a] -= RIDGE * w[a];
                }
            }
            let step;
            try {
                step = solve(H, g);
            }
            catch {
                break;
            }
            w = w.map((v, k) => v + step[k]);
            if (Math.max(...step.map(Math.abs)) < 1e-7)
                break;
        }
        if (w.every(Number.isFinite))
            cache.lastW = w;
        const Hfinal = H;
        const eta = (past) => {
            const x = design(featureRow(past, past.length, t));
            return { x, z: x.reduce((a, v, k) => a + v * w[k], 0) };
        };
        return {
            p: (past) => clip(sigmoid(eta(past).z)),
            interval: (past) => {
                const { x, z } = eta(past);
                let half = Number.POSITIVE_INFINITY;
                try {
                    const v = solve(Hfinal, x).reduce((a, s, k) => a + s * x[k], 0); // xᵀ H⁻¹ x (delta method)
                    if (v >= 0)
                        half = Z95 * Math.sqrt(v);
                }
                catch {
                    // keep the widest interval
                }
                return [sigmoid(z - half), sigmoid(z + half)];
            },
        };
    },
};
export const FORECAST_MODEL_SPECS = [baseRate, rtpReference, rolling50, afterPrevious, sinceLastHit, logisticRecent];
/* ---------------------------------------------------------------- statistics */
/** Standard normal CDF (Abramowitz–Stegun 7.1.26, |error| < 1.5e-7). */
export function normalCdf(x) {
    const z = Math.abs(x) / Math.SQRT2;
    const t = 1 / (1 + 0.3275911 * z);
    const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
    return x >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}
const logLoss = (p, y) => -(y ? Math.log(p) : Math.log(1 - p));
/**
 * One-sided Diebold–Mariano test that series `a` has a lower mean loss than `b`, with a
 * Newey–West (Bartlett) long-run variance. Returns the p-value of "mean(a − b) < 0".
 */
export function dieboldMariano(a, b) {
    return normalCdf(dieboldMarianoZ(a, b));
}
/** The Diebold–Mariano statistic itself (negative: `a` has the lower mean loss). */
export function dieboldMarianoZ(a, b) {
    const n = a.length;
    if (n < 2)
        return Number.POSITIVE_INFINITY;
    const d = Array.from({ length: n }, (_, i) => a[i] - b[i]);
    const mean = d.reduce((s, v) => s + v, 0) / n;
    const lag = Math.floor(Math.cbrt(n));
    let v = 0;
    for (let k = 0; k <= lag; k++) {
        let c = 0;
        for (let i = k; i < n; i++)
            c += (d[i] - mean) * (d[i - k] - mean);
        c /= n;
        v += (k === 0 ? 1 : 2 * (1 - k / (lag + 1))) * c;
    }
    if (!(v > 1e-18))
        return mean < 0 ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
    return mean / Math.sqrt(v / n);
}
/**
 * Spiegelhalter's Z for calibration of probability forecasts. For a constant forecast it reduces
 * to the calibration-in-the-large test (observed − expected events).
 */
export function spiegelhalterZ(p, y) {
    let num = 0;
    let den = 0;
    let inLarge = 0;
    let varLarge = 0;
    for (let i = 0; i < p.length; i++) {
        const pi = p[i];
        const v = pi * (1 - pi);
        num += (y[i] - pi) * (1 - 2 * pi);
        den += (1 - 2 * pi) ** 2 * v;
        inLarge += y[i] - pi;
        varLarge += v;
    }
    if (den > 1e-9)
        return num / Math.sqrt(den);
    return varLarge > 0 ? inLarge / Math.sqrt(varLarge) : 0;
}
/** Deterministic PRNG (mulberry32) so a result is reproducible from its input. */
function prng(seed) {
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
export function baseRateCalibrationP(hits, scored, observedZ, opts, seed) {
    const n = hits.length;
    const rate = jeffreys(hits.reduce((a, v) => a + v, 0), n);
    const rand = prng(seed);
    const sim = new Uint8Array(n);
    const p = [];
    const y = [];
    let exceed = 0;
    for (let b = 0; b < BOOTSTRAP_REPLICATES; b++) {
        for (let i = 0; i < n; i++)
            sim[i] = rand() < rate ? 1 : 0;
        p.length = 0;
        y.length = 0;
        let k = 0; // hits before the current block start
        let counted = 0;
        let si = 0;
        for (let start = opts.trainInitial; start < n; start += opts.refitEvery) {
            for (; counted < start; counted++)
                k += sim[counted];
            const f = clip(jeffreys(k, start));
            const end = Math.min(n, start + opts.refitEvery);
            for (; si < scored.length && scored[si] < end; si++) {
                p.push(f);
                y.push(sim[scored[si]]);
            }
        }
        if (Math.abs(spiegelhalterZ(p, y)) >= Math.abs(observedZ))
            exceed++;
    }
    return (exceed + 1) / (BOOTSTRAP_REPLICATES + 1);
}
/* ---------------------------------------------------------------- experiment */
/** Run ids: a new run starts when stored rounds are more than `gapSeconds` apart. */
export function segmentsOf(rounds, gapSeconds) {
    const seg = new Int32Array(rounds.length);
    for (let i = 1; i < rounds.length; i++) {
        const gap = (rounds[i].receivedAt.getTime() - rounds[i - 1].receivedAt.getTime()) / 1000;
        seg[i] = seg[i - 1] + (gap > gapSeconds || gap < 0 ? 1 : 0);
    }
    return seg;
}
/** Chronological walk-forward forecasts for one threshold. `rounds` are OLDEST FIRST. */
export function walkForward(m, seg, threshold, specs, opts) {
    const n = m.length;
    const forecasts = new Map(specs.map((s) => [s.id, []]));
    const scored = [];
    const y = [];
    for (let start = opts.trainInitial; start < n; start += opts.refitEvery) {
        const train = new Past(m, seg, start);
        const predictors = specs.map((s) => s.fit(train, threshold));
        for (let t = start; t < Math.min(n, start + opts.refitEvery); t++) {
            if (seg[t] !== seg[t - 1])
                continue; // only rounds that directly follow the previous stored round
            const past = new Past(m, seg, t);
            specs.forEach((s, k) => forecasts.get(s.id).push(predictors[k].p(past)));
            scored.push(t);
            y.push(m[t] >= threshold ? 1 : 0);
        }
    }
    return { scored, y, forecasts };
}
const meanOf = (a) => a.reduce((s, v) => s + v, 0) / a.length;
const lossesOf = (forecasts, y) => forecasts.map((p, k) => logLoss(p, y[k]));
/**
 * Exact permutation test of "the recent rounds carry no information" for ONE candidate model.
 * Under that null (independent rounds), every reordering of the multipliers is equally likely, so
 * the candidate's Diebold–Mariano statistic on the real order is compared with the same statistic
 * after shuffling the multipliers (run boundaries stay in place) and repeating the whole
 * walk-forward. p = (1 + shuffles at least as favourable to the candidate) ÷ (shuffles + 1).
 * Deterministic for a given seed. Stops as soon as p can no longer fall below `alpha`.
 */
export function permutationP(spec, m, seg, threshold, opts, observedZ, alpha, seed) {
    const rand = prng(seed);
    const specs = [baseRate, spec];
    let atLeast = 0;
    for (let b = 0; b < PERMUTATIONS; b++) {
        // A fresh array each time: per-series caches are keyed by array identity.
        const perm = Float64Array.from(m);
        for (let i = perm.length - 1; i > 0; i--) {
            const j = Math.floor(rand() * (i + 1));
            [perm[i], perm[j]] = [perm[j], perm[i]];
        }
        const wf = walkForward(perm, seg, threshold, specs, opts);
        const z = dieboldMarianoZ(lossesOf(wf.forecasts.get(spec.id), wf.y), lossesOf(wf.forecasts.get('base_rate'), wf.y));
        if (z <= observedZ)
            atLeast++;
        if ((atLeast + 1) / (PERMUTATIONS + 1) >= alpha)
            return (atLeast + 1) / (b + 2);
    }
    return (atLeast + 1) / (PERMUTATIONS + 1);
}
export function computeForecast(roundsOldestFirst, opts = {}) {
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
    const alpha = ALPHA / comparisons;
    const m = Float64Array.from(roundsOldestFirst, (r) => r.multiplier);
    const seg = segmentsOf(roundsOldestFirst, gapSeconds);
    const segments = n ? seg[n - 1] + 1 : 0;
    const head = {
        method: 'walk_forward_v2',
        sampleSize: n,
        minSampleSize: trainInitial + minTestRounds,
        trainInitial,
        minTestRounds,
        refitEvery,
        segments,
        gapSeconds,
        comparisons,
        alpha,
        minEvents: MIN_EVENTS,
        permutationMaxRounds: PERMUTATION_MAX_ROUNDS,
    };
    const insufficient = (testRounds) => ({ ...head, status: 'insufficient_data', testRounds, thresholds: [] });
    if (n < trainInitial + minTestRounds)
        return insufficient(0);
    const latest = roundsOldestFirst[n - 1].receivedAt.getTime();
    const current = !opts.now || (opts.now.getTime() - latest) / 1000 <= gapSeconds;
    const all = new Past(m, seg, n);
    const results = [];
    let testRounds = 0;
    for (const t of thresholds) {
        const wf = walkForward(m, seg, t, specs, { trainInitial, refitEvery });
        testRounds = wf.scored.length;
        if (testRounds < minTestRounds)
            return insufficient(testRounds);
        const loss = new Map();
        for (const s of specs)
            loss.set(s.id, lossesOf(wf.forecasts.get(s.id), wf.y));
        const baseLoss = loss.get('base_rate');
        const baseLL = meanOf(baseLoss);
        const events = wf.y.reduce((a, v) => a + v, 0);
        const testable = events >= MIN_EVENTS && testRounds - events >= MIN_EVENTS;
        const hits = Uint8Array.from(m, (v) => (v >= t ? 1 : 0));
        const dmZ = new Map();
        const models = specs.map((s) => {
            const p = wf.forecasts.get(s.id);
            const ll = meanOf(loss.get(s.id));
            const z = spiegelhalterZ(p, wf.y);
            const isBase = s.id === 'base_rate';
            if (!isBase)
                dmZ.set(s.id, dieboldMarianoZ(loss.get(s.id), baseLoss));
            const pValue = isBase ? null : normalCdf(dmZ.get(s.id));
            // Base rate: bootstrap test, Bonferroni over thresholds (withholding the estimate needs clear
            // evidence). Other models: plain test, which ignores their estimation noise and so only makes
            // validation stricter.
            const calibrationP = isBase ? baseRateCalibrationP(hits, wf.scored, z, { trainInitial, refitEvery }, n * 31 + t * 1009) : null;
            const calibrated = calibrationP != null ? calibrationP >= ALPHA / thresholds.length : Math.abs(z) < Z95;
            const passes = testable && s.usesRecentRounds && pValue != null && pValue < alpha && calibrated && ll < baseLL;
            return {
                model: s.id,
                usesRecentRounds: s.usesRecentRounds,
                logLoss: ll,
                brier: meanOf(p.map((pi, k) => (pi - wf.y[k]) ** 2)),
                meanForecast: meanOf(p),
                observedRate: meanOf(wf.y),
                calibrationZ: z,
                calibrationP,
                calibrated,
                skillVsBaseRate: isBase || baseLL === 0 ? null : 1 - ll / baseLL,
                pValue,
                permutationP: null,
                validated: passes,
            };
        });
        if (n < PERMUTATION_MAX_ROUNDS) {
            // Short histories: confirm with the exact test, best candidate first, until one passes. The
            // rest stay unconfirmed (validated false, permutationP null) — the estimate needs only one.
            let confirmed = false;
            for (const s of models.filter((x) => x.validated).sort((a, b) => a.logLoss - b.logLoss)) {
                if (confirmed) {
                    s.validated = false;
                    continue;
                }
                const si = specs.findIndex((x) => x.id === s.model);
                s.permutationP = permutationP(specs[si], m, seg, t, { trainInitial, refitEvery }, dmZ.get(s.model), alpha, n * 31 + t * 1009 + si * 7);
                s.validated = confirmed = s.permutationP < alpha;
            }
        }
        const best = models.filter((s) => s.validated).sort((a, b) => a.logLoss - b.logLoss)[0];
        const baseScore = models.find((s) => s.model === 'base_rate');
        const estimate = (id) => {
            const pred = specs.find((s) => s.id === id).fit(all, t);
            const [low, high] = pred.interval(all);
            return { selectedModel: id, probability: pred.p(all), low, high };
        };
        const none = { selectedModel: null, probability: null, low: null, high: null };
        const row = { threshold: t, testEvents: events, models };
        // Too few events (or non-events) among the test rounds: this target cannot be judged yet.
        if (!testable)
            results.push({ ...row, status: 'insufficient_events', ...none });
        else if (best && current)
            results.push({ ...row, status: 'validated_model', ...estimate(best.model) });
        else if (!baseScore.calibrated)
            results.push({ ...row, status: 'not_calibrated', ...none });
        else
            results.push({ ...row, status: best ? 'validated_model_not_current' : 'no_predictive_value', ...estimate('base_rate') });
    }
    return { ...head, status: 'evaluated', testRounds, thresholds: results };
}
