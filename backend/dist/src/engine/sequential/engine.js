import { MULTIPLIER_RANGES, RANGE_COUNT, rangeIndex, SIGNAL_CANDIDATES, SIGNAL_MODELS, SIGNAL_THRESHOLDS, SIGNAL_WARMUP_ROUNDS, } from '@aviator/contracts';
import { createModelSet } from './models.js';
/**
 * Round-by-round forecasting with an immutable ledger (contract: NextRoundSignalSchema).
 *
 *   after round t is stored     → the open forecast (for round t) is scored against it, once
 *                               → every model is updated with round t
 *                               → ONE forecast for round t+1 is issued from rounds ≤ t only
 *
 * The ledger is the only memory of performance. Ensemble weights, validation evidence and every
 * displayed score are computed from forecasts that were recorded BEFORE their round was known.
 * Nothing in a recorded forecast changes after its outcome arrives.
 *
 * Decision rule (documented in docs/ROUND_SIGNAL.md):
 *   fewer than 20 rounds                                        → warming_up (no forecast)
 *   a candidate has ≥ 50 scored forecasts, log loss below the baseline's, and an e-value against
 *   "rounds are i.i.d." of at least K ÷ α = 5 ÷ 0.05 = 100       → validated (that candidate's forecast)
 *   ≥ 100 scored forecasts and the ensemble's log loss is not below the baseline's
 *                                                               → baseline_only (baseline forecast)
 *   otherwise                                                   → experimental (ensemble forecast)
 */
/** Engine version recorded with every forecast (stat-5.1: continuity, verified-run warm-up; stat-5.2: rolling Brier, failure causes). */
export const ENGINE_VERSION = 'stat-5.2';
export const SIGNAL_RULES = Object.freeze({
    warmupRounds: SIGNAL_WARMUP_ROUNDS,
    minScoredForVerdict: 100,
    minScoredForValidation: 50,
    alpha: 0.05,
    candidates: SIGNAL_CANDIDATES.length,
    eValueThreshold: SIGNAL_CANDIDATES.length / 0.05,
    minEvents: 10,
    gapSeconds: 120,
});
/** Prior model weights of the ensemble: half on the baseline, the rest split over the candidates. */
const PRIOR_WEIGHT = {
    baseline: 0.5,
    ewma: 0.1,
    markov: 0.1,
    streak: 0.1,
    logit: 0.1,
    changepoint: 0.1,
};
const BASE_MODELS = ['baseline', ...SIGNAL_CANDIDATES];
export const ROLLING_WINDOW = 50;
export const HISTORY_LENGTH = 30;
/** Whether rounds may be missing between `prev` and `r`: continuity evidence first, else the time rule. */
export function isBreak(prev, r, gapSeconds = SIGNAL_RULES.gapSeconds) {
    if (!prev || r.receivedAt < prev.receivedAt)
        return true;
    if (r.breakBefore != null)
        return r.breakBefore;
    return (r.receivedAt.getTime() - prev.receivedAt.getTime()) / 1000 > gapSeconds;
}
const LN = Math.log;
const clipP = (p) => Math.min(1 - 1e-9, Math.max(1e-9, p));
export const logLoss = (p, y) => -LN(clipP(p[y]));
export const brier = (p, y) => p.reduce((a, v, k) => a + (v - (k === y ? 1 : 0)) ** 2, 0);
export const topRange = (p) => p.reduce((best, v, k) => (v > p[best] ? k : best), 0);
/* ---------------------------------------------------------------- scoring */
/**
 * Resolves a forecast with the next stored round. Void (not scored) when the next stored round came
 * after a collection break (it may not be the round right after the input), or when the forecast was
 * recorded after that round was stored (`checkLate`; the live service guarantees the order with a
 * lock instead, because database timestamps are transaction start times).
 */
export function resolve(f, next, scoredAt, opts = {}) {
    const gapSeconds = opts.gapSeconds ?? SIGNAL_RULES.gapSeconds;
    const gap = next.breakBefore != null ? next.breakBefore : (next.receivedAt.getTime() - f.inputLastRoundAt.getTime()) / 1000 > gapSeconds;
    if (gap)
        return { forecastId: f.id, status: 'void', reason: 'gap', scoredAt };
    if (opts.checkLate !== false && f.issuedAt.getTime() > next.receivedAt.getTime())
        return { forecastId: f.id, status: 'void', reason: 'late', scoredAt };
    return { forecastId: f.id, status: 'scored', roundId: next.id, multiplier: next.multiplier, range: rangeIndex(next.multiplier), scoredAt };
}
/* ---------------------------------------------------------------- evidence */
/** Running totals over SCORED forecasts. Built the same way live (from stored rows) and in backtests. */
export class Evidence {
    scored = 0;
    voided = 0;
    logLik = Object.fromEntries(SIGNAL_MODELS.map((m) => [m, 0]));
    rangeCounts = new Array(RANGE_COUNT).fill(0);
    add(f, o) {
        if (o.status !== 'scored') {
            this.voided++;
            return;
        }
        this.scored++;
        this.rangeCounts[o.range]++;
        for (const m of SIGNAL_MODELS)
            this.logLik[m] += LN(clipP(f.vectors[m][o.range]));
    }
    /** ln of the maximised i.i.d. likelihood of the scored outcomes (universal-inference denominator). */
    get iidMaxLogLik() {
        const n = this.scored;
        return this.rangeCounts.reduce((a, c) => a + (c > 0 ? c * LN(c / n) : 0), 0);
    }
    /** ln e-value of a model against "rounds are i.i.d. with some constant range distribution". */
    logEValue(m) {
        return this.logLik[m] - this.iidMaxLogLik;
    }
    /** Posterior model probabilities (Bayesian model averaging over the scored forecasts). */
    weights() {
        const lw = BASE_MODELS.map((m) => LN(PRIOR_WEIGHT[m]) + this.logLik[m]);
        const mx = Math.max(...lw);
        const e = lw.map((v) => Math.exp(v - mx));
        const s = e.reduce((a, v) => a + v, 0);
        return Object.fromEntries(BASE_MODELS.map((m, i) => [m, e[i] / s]));
    }
    validated(m, rules = SIGNAL_RULES) {
        return (SIGNAL_CANDIDATES.includes(m) &&
            this.scored >= rules.minScoredForValidation &&
            this.logLik[m] > this.logLik.baseline &&
            this.logEValue(m) >= LN(rules.eValueThreshold));
    }
}
export function decide(ev, rules = SIGNAL_RULES) {
    const valid = SIGNAL_CANDIDATES.filter((m) => ev.validated(m, rules)).sort((a, b) => ev.logEValue(b) - ev.logEValue(a));
    if (valid.length) {
        const m = valid[0];
        return {
            state: 'validated',
            model: m,
            reason: `${MODEL_NAME[m]} beat the i.i.d. hypothesis with e-value ${fmtE(ev.logEValue(m))} (needs ${rules.eValueThreshold}) over ${ev.scored} scored forecasts.`,
        };
    }
    if (ev.scored >= rules.minScoredForVerdict && ev.logLik.ensemble <= ev.logLik.baseline) {
        return {
            state: 'baseline_only',
            model: 'baseline',
            reason: `After ${ev.scored} scored forecasts the recent-round models did not beat the baseline, so the baseline is shown. It is not a predictive signal.`,
        };
    }
    const why = ev.scored < rules.minScoredForVerdict
        ? `${ev.scored} of ${rules.minScoredForVerdict} forecasts scored, too few to judge it against the baseline yet`
        : `ahead of the baseline over ${ev.scored} scored forecasts but not validated`;
    return { state: 'experimental', model: 'ensemble', reason: `Experimental estimate (model average): ${why}.` };
}
const fmtE = (lnE) => {
    const e = Math.exp(lnE);
    return e >= 1000 ? e.toExponential(1) : e.toFixed(e < 10 ? 2 : 0);
};
export const MODEL_NAME = {
    baseline: 'Baseline (all rounds, Bayesian)',
    ewma: 'Recent drift (EWMA)',
    markov: 'Previous-round transition',
    streak: 'Rounds since last 2×',
    logit: 'Recent-round regression',
    changepoint: 'Change-point detector',
    ensemble: 'Model average',
};
/** Break flags for a chronological round list (the first round and every break start a new run; see isBreak). */
export function breaksOf(rounds, gapSeconds = SIGNAL_RULES.gapSeconds) {
    return rounds.map((r, i) => isBreak(rounds[i - 1], r, gapSeconds));
}
/** Length of the run that ends at the latest round, and of the longest run (runs are split at breaks). */
export function runLengths(breaks) {
    let current = 0;
    let longest = 0;
    for (const b of breaks) {
        current = b ? 1 : current + 1;
        longest = Math.max(longest, current);
    }
    return { current, longest };
}
/**
 * Builds the forecast for the round after the last observed one, from a model set that saw `count`
 * rounds. Nothing is issued until some run of verified consecutive rounds reached the warm-up
 * length (`longestRun`); after that, every round gets a forecast.
 */
export function issueWith(models, ev, last, count, longestRun, ctx) {
    if (!last || longestRun < SIGNAL_RULES.warmupRounds)
        return null;
    const base = models.predictAll();
    const w = ev.weights();
    const ensemble = new Array(RANGE_COUNT).fill(0);
    for (const m of BASE_MODELS)
        base[m].forEach((v, k) => (ensemble[k] += w[m] * v));
    const vectors = { ...base, ensemble };
    const d = decide(ev);
    const best = [...SIGNAL_CANDIDATES].sort((a, b) => ev.logEValue(b) - ev.logEValue(a))[0];
    const atIssue = {
        scored: ev.scored,
        logLossDiff: ev.scored ? (ev.logLik.baseline - ev.logLik[d.model]) / ev.scored : null,
        bestCandidate: ev.scored ? best : null,
        bestLog10EValue: ev.scored ? ev.logEValue(best) / Math.LN10 : null,
    };
    return {
        id: ctx.id,
        issuedAt: ctx.issuedAt,
        inputLastRoundId: last.id,
        inputLastRoundAt: last.receivedAt,
        inputRounds: count,
        engineVersion: ctx.engineVersion,
        state: d.state,
        model: d.model,
        probabilities: [...vectors[d.model]],
        vectors,
        atIssue,
    };
}
/** Rebuilds the models from the stored rounds (oldest first) and issues the next forecast. */
export function issueForecast(rounds, ev, ctx) {
    const models = createModelSet();
    const br = breaksOf(rounds);
    rounds.forEach((r, i) => models.observe({ multiplier: r.multiplier, breakBefore: br[i] }));
    return { forecast: issueWith(models, ev, rounds[rounds.length - 1], rounds.length, runLengths(br).longest, ctx), models };
}
export function evidenceOf(entries) {
    const ev = new Evidence();
    for (const e of entries)
        if (e.outcome)
            ev.add(e.forecast, e.outcome);
    return ev;
}
/**
 * Runs the live process over a chronological round list: before each round is revealed, the open
 * forecast for it already exists; the round then resolves it, updates the models, and the next
 * forecast is issued. Forecasts are issued 1 ms after their input round (simulated clock).
 */
export function replay(rounds, engineVersion = ENGINE_VERSION) {
    const models = createModelSet();
    const ev = new Evidence();
    const entries = [];
    const br = breaksOf(rounds);
    let open = null;
    let run = 0;
    let longest = 0;
    for (let i = 0; i < rounds.length; i++) {
        const r = rounds[i];
        run = br[i] ? 1 : run + 1;
        longest = Math.max(longest, run);
        if (open) {
            open.outcome = resolve(open.forecast, r, r.receivedAt);
            ev.add(open.forecast, open.outcome);
        }
        models.observe({ multiplier: r.multiplier, breakBefore: br[i] });
        const f = issueWith(models, ev, r, i + 1, longest, {
            engineVersion,
            issuedAt: new Date(r.receivedAt.getTime() + 1),
            id: replayId(entries.length),
        });
        open = f ? { forecast: f, outcome: null } : null;
        if (open)
            entries.push(open);
    }
    return { entries, evidence: ev, models };
}
export const replayId = (i) => `fc_${i.toString(36).toUpperCase().padStart(16, '0')}`;
/* ---------------------------------------------------------------- reporting */
function spiegelhalterZ(p, y) {
    let num = 0;
    let den = 0;
    for (let i = 0; i < p.length; i++) {
        const pi = p[i];
        num += (y[i] - pi) * (1 - 2 * pi);
        den += (1 - 2 * pi) ** 2 * pi * (1 - pi);
    }
    return den > 1e-12 ? num / Math.sqrt(den) : null;
}
const BINS = [0, 0.1, 0.2, 0.35, 0.5, 0.65, 1];
const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
export function performanceOf(entries, rules = SIGNAL_RULES) {
    const scored = [];
    let voided = 0;
    let pending = 0;
    for (const e of entries) {
        if (!e.outcome)
            pending++;
        else if (e.outcome.status === 'void')
            voided++;
        else
            scored.push({ p: e.forecast.probabilities, b: e.forecast.vectors.baseline, y: e.outcome.range });
    }
    const hit = (s, key) => (s.length ? s.filter((x) => topRange(x[key]) === x.y).length / s.length : null);
    const ll = (s, key) => mean(s.map((x) => logLoss(x[key], x.y)));
    const diffs = scored.map((x) => logLoss(x.p, x.y) - logLoss(x.b, x.y));
    const dm = mean(diffs);
    let lo = null;
    let hi = null;
    if (dm != null && diffs.length >= 2) {
        const sd = Math.sqrt(diffs.reduce((a, v) => a + (v - dm) ** 2, 0) / (diffs.length - 1));
        const half = (1.959963984540054 * sd) / Math.sqrt(diffs.length);
        lo = dm - half;
        hi = dm + half;
    }
    const recent = scored.slice(-ROLLING_WINDOW);
    const thresholds = SIGNAL_THRESHOLDS.map((t, ti) => {
        const from = ti + 1; // ranges at or above the threshold
        const pt = (v) => v.slice(from).reduce((a, x) => a + x, 0);
        const ps = scored.map((x) => pt(x.p));
        const bs = scored.map((x) => pt(x.b));
        const ys = scored.map((x) => (x.y >= from ? 1 : 0));
        const events = ys.reduce((a, v) => a + v, 0);
        const nonEvents = ys.length - events;
        const bl = (p) => mean(p.map((v, i) => -(ys[i] ? LN(clipP(v)) : LN(clipP(1 - v)))));
        const br = (p) => mean(p.map((v, i) => (v - ys[i]) ** 2));
        const reliability = BINS.slice(0, -1).map((low, b) => {
            const high = BINS[b + 1];
            const idx = ps.map((v, i) => (v >= low && (v < high || (b === BINS.length - 2 && v <= high)) ? i : -1)).filter((i) => i >= 0);
            return { low, high, n: idx.length, meanForecast: mean(idx.map((i) => ps[i])), observedRate: mean(idx.map((i) => ys[i])) };
        });
        return {
            threshold: t,
            events,
            nonEvents,
            status: events >= rules.minEvents && nonEvents >= rules.minEvents ? 'ok' : 'insufficient_evidence',
            brier: br(ps),
            baselineBrier: br(bs),
            logLoss: bl(ps),
            baselineLogLoss: bl(bs),
            meanForecast: mean(ps),
            observedRate: mean(ys),
            calibrationZ: spiegelhalterZ(ps, ys),
            reliability,
        };
    });
    return {
        scored: scored.length,
        voided,
        pending,
        topRangeHitRate: hit(scored, 'p'),
        baselineTopRangeHitRate: hit(scored, 'b'),
        logLoss: ll(scored, 'p'),
        baselineLogLoss: ll(scored, 'b'),
        logLossDiff: dm,
        logLossDiffLow: lo,
        logLossDiffHigh: hi,
        brier: mean(scored.map((x) => brier(x.p, x.y))),
        baselineBrier: mean(scored.map((x) => brier(x.b, x.y))),
        rolling: {
            window: ROLLING_WINDOW,
            n: recent.length,
            topRangeHitRate: hit(recent, 'p'),
            baselineTopRangeHitRate: hit(recent, 'b'),
            logLoss: ll(recent, 'p'),
            baselineLogLoss: ll(recent, 'b'),
            brier: mean(recent.map((x) => brier(x.p, x.y))),
            baselineBrier: mean(recent.map((x) => brier(x.b, x.y))),
        },
        thresholds,
    };
}
export function recordOf(e) {
    const f = e.forecast;
    const o = e.outcome;
    return {
        id: f.id,
        issuedAt: f.issuedAt.toISOString(),
        inputLastRoundId: f.inputLastRoundId,
        inputRounds: f.inputRounds,
        engineVersion: f.engineVersion,
        state: f.state,
        model: f.model,
        probabilities: f.probabilities,
        baselineProbabilities: f.vectors.baseline,
        atIssue: f.atIssue,
        outcome: !o
            ? { status: 'pending' }
            : o.status === 'void'
                ? { status: 'void', reason: o.reason, scoredAt: o.scoredAt.toISOString() }
                : {
                    status: 'scored',
                    roundId: o.roundId,
                    multiplier: o.multiplier,
                    range: o.range,
                    scoredAt: o.scoredAt.toISOString(),
                    topRangeHit: topRange(f.probabilities) === o.range,
                    logLoss: logLoss(f.probabilities, o.range),
                    baselineLogLoss: logLoss(f.vectors.baseline, o.range),
                    brier: Math.min(2, brier(f.probabilities, o.range)),
                },
    };
}
/**
 * The response object. `entries` are this device's recorded forecasts, oldest first; the current
 * forecast is the one whose input boundary is the latest stored round.
 */
export function buildSignal(rounds, entries, changeProbability) {
    const ev = evidenceOf(entries);
    const last = rounds[rounds.length - 1];
    const currentEntry = last ? [...entries].reverse().find((e) => e.forecast.inputLastRoundId === last.id) : undefined;
    const backfill = rounds.filter((r) => r.source === 'backfill').length;
    const weights = ev.weights();
    const models = SIGNAL_MODELS.map((m) => ({
        model: m,
        weight: m === 'ensemble' ? null : weights[m],
        logLoss: ev.scored ? -ev.logLik[m] / ev.scored : null,
        log10EValue: SIGNAL_CANDIDATES.includes(m) && ev.scored ? ev.logEValue(m) / Math.LN10 : null,
        validated: ev.validated(m),
    }));
    const runs = runLengths(breaksOf(rounds));
    let state;
    let reason;
    if (runs.longest < SIGNAL_RULES.warmupRounds) {
        state = 'warming_up';
        reason = `Collecting rounds: ${runs.current} of ${SIGNAL_RULES.warmupRounds} consecutive verified rounds needed before the first experimental estimate${rounds.length > runs.current ? ` (${rounds.length} stored; a collection break restarts the count)` : ''}.`;
    }
    else if (currentEntry) {
        state = currentEntry.forecast.state;
        reason = decide(ev).reason;
    }
    else {
        state = 'experimental';
        reason = 'No forecast is recorded for the latest round yet.';
    }
    return {
        method: 'sequential_v1',
        state,
        reason: reason.slice(0, 300),
        rounds: rounds.length,
        currentRun: runs.current,
        longestRun: runs.longest,
        liveRounds: rounds.length - backfill,
        backfillRounds: backfill,
        latestRoundAt: last ? last.receivedAt.toISOString() : null,
        current: currentEntry ? recordOf(currentEntry) : null,
        changeProbability,
        performance: performanceOf(entries),
        models,
        history: entries.slice(-HISTORY_LENGTH).reverse().map(recordOf),
        rules: { ...SIGNAL_RULES },
    };
}
export const RANGE_LABELS = MULTIPLIER_RANGES.map((r) => r.label);
