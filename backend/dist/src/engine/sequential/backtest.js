// Chronological walk-forward backtest of the round-by-round engine (stat-5). It runs EXACTLY the
// live process (replay(): forecast issued before each round, scored when it arrives, models
// updated, next forecast issued) over a round file, and prints a Markdown report.
//
//   npm run backtest:signal -w @aviator/backend -- <file.csv> [more files…] [--limit N] [--controls] [--out report.md]
//   --limit N keeps the FIRST N rounds of each sequence (chronological), to bound run time and memory.
//
// Accepted files (read-only; nothing is written to the database):
//   - columns created_at, app, payout  → one sequence per `app`, ordered by created_at (e.g. PHIMAS/aviator)
//   - a single column of multipliers   → one sequence; --reverse if the file is newest first;
//                                         no timestamps, so rounds are spaced 20 s apart (no breaks)
//   - columns multiplier, received_at  → the export described in docs/NEXT_ROUND_FORECAST.md
// --controls adds SIMULATED negative controls (independent rounds) and positive controls (planted
// dependence). Simulated results are labelled as simulated and say nothing about the real game.
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { SIGNAL_CANDIDATES } from '@aviator/contracts';
import { isValidMultiplier } from '../summary.js';
import { decide, MODEL_NAME, performanceOf, replay, SIGNAL_RULES } from './engine.js';
import { asRounds, fairSequence, plantedSequence } from './simulate.js';
function parseCsvLine(line) {
    const out = [];
    let cur = '';
    let q = false;
    for (const ch of line) {
        if (ch === '"')
            q = !q;
        else if (ch === ',' && !q) {
            out.push(cur);
            cur = '';
        }
        else
            cur += ch;
    }
    out.push(cur);
    return out.map((s) => s.trim());
}
export function loadFile(path, reverse) {
    const lines = readFileSync(path, 'utf8').split(/\r?\n/).filter((l) => l.trim());
    const header = parseCsvLine(lines[0]).map((h) => h.toLowerCase());
    const body = lines.slice(1).map(parseCsvLine);
    let invalid = 0;
    let duplicates = 0;
    const file = basename(path);
    if (header.includes('app') && header.includes('payout') && header.includes('created_at')) {
        const [ti, ai, pi] = ['created_at', 'app', 'payout'].map((c) => header.indexOf(c));
        const by = new Map();
        for (const r of body) {
            const m = Number(r[pi]);
            const us = parseMicros(r[ti]);
            if (!isValidMultiplier(m) || !Number.isFinite(us)) {
                invalid++;
                continue;
            }
            const key = r[ai];
            if (!by.has(key))
                by.set(key, []);
            by.get(key).push({ t: Math.floor(us / 1000), us, m, raw: r.join(',') });
        }
        const series = [];
        for (const [app, rows] of [...by].sort()) {
            rows.sort((a, b) => a.us - b.us); // full microsecond precision: rows written in one burst keep their insertion order
            const seen = new Set();
            const kept = rows.filter((x) => (seen.has(x.raw) ? (duplicates++, false) : (seen.add(x.raw), true)));
            series.push({
                name: `${file} · ${app}`,
                note: `timestamps from the file (collection times); exact duplicate rows removed; rows written < ${BURST_SECONDS} s after the previous one (catch-up bursts) start a new run, because their order and continuity are not verified`,
                rounds: kept.map((x, i) => ({
                    id: String(i + 1),
                    multiplier: x.m,
                    receivedAt: new Date(x.t),
                    source: 'live',
                    breakBefore: i === 0 || x.us - kept[i - 1].us < BURST_SECONDS * 1e6 || x.us - kept[i - 1].us > SIGNAL_RULES.gapSeconds * 1e6,
                })),
            });
        }
        return { series, invalid, duplicates };
    }
    const mi = header.indexOf('multiplier');
    const ri = header.indexOf('received_at');
    const vals = [];
    for (const r of body) {
        const m = Number(r[mi >= 0 ? mi : 0]);
        if (!isValidMultiplier(m)) {
            invalid++;
            continue;
        }
        vals.push({ m, t: ri >= 0 ? Date.parse(r[ri]) : null });
    }
    if (reverse)
        vals.reverse();
    const timed = vals.every((v) => v.t != null && Number.isFinite(v.t));
    const rounds = timed
        ? vals.map((v, i) => ({ id: String(i + 1), multiplier: v.m, receivedAt: new Date(v.t), source: 'live' }))
        : asRounds(vals.map((v) => v.m));
    return { series: [{ name: file, note: timed ? 'timestamps from the file' : 'no timestamps: synthetic 20 s spacing, no breaks', rounds }], invalid, duplicates };
}
/**
 * A real round takes several seconds (betting phase plus flight), so rows stored less than this apart
 * were written together by the collector (a catch-up burst), not as the rounds happened.
 */
export const BURST_SECONDS = 2;
/** "2024-02-03 10:41:29.066595+00" → microseconds since the epoch (Date.parse keeps only milliseconds). */
export function parseMicros(s) {
    const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}(?::?\d{2})?)?$/.exec(s.trim());
    if (!m)
        return NaN;
    const tz = !m[4] || m[4] === 'Z' ? 'Z' : m[4].length === 3 ? `${m[4]}:00` : m[4].includes(':') ? m[4] : `${m[4].slice(0, 3)}:${m[4].slice(3)}`;
    const sec = Date.parse(`${m[1]}T${m[2]}${tz}`);
    return sec * 1000 + Number((m[3] ?? '').padEnd(6, '0'));
}
const pct = (v) => (v == null ? '—' : `${(v * 100).toFixed(1)}%`);
const num = (v, d = 4) => (v == null ? '—' : v.toFixed(d));
export function reportSeries(s) {
    const t0 = performance.now();
    const r = replay(s.rounds);
    const ms = performance.now() - t0;
    const perf = performanceOf(r.entries);
    const states = {};
    for (const e of r.entries)
        states[e.forecast.state] = (states[e.forecast.state] ?? 0) + 1;
    const ev = r.evidence;
    const out = [];
    out.push(`### ${s.name}`, '');
    out.push(`${s.rounds.length.toLocaleString('en-US')} rounds (${s.note}); ${r.entries.length.toLocaleString('en-US')} forecasts issued; ${perf.scored.toLocaleString('en-US')} scored on unseen rounds, ${perf.voided} voided (collection breaks). Run time ${(ms / 1000).toFixed(1)} s.`, '');
    out.push(`Final state: **${decide(ev).state}**. Forecast states over time: ${Object.entries(states)
        .map(([k, v]) => `${k} ${v.toLocaleString('en-US')}`)
        .join(', ')}. Ever validated: **${states.validated ? 'yes' : 'no'}**.`, '');
    out.push('| Metric (shown forecast vs baseline, scored forecasts) | Shown | Baseline |', '|---|---|---|');
    out.push(`| Top-range hit rate | ${pct(perf.topRangeHitRate)} | ${pct(perf.baselineTopRangeHitRate)} |`);
    out.push(`| Log loss (4 ranges) | ${num(perf.logLoss)} | ${num(perf.baselineLogLoss)} |`);
    out.push(`| Multi-class Brier | ${num(perf.brier)} | ${num(perf.baselineBrier)} |`);
    out.push(`| Log-loss difference, 95% CI (negative = better) | ${num(perf.logLossDiff, 5)} [${num(perf.logLossDiffLow, 5)}, ${num(perf.logLossDiffHigh, 5)}] | |`);
    out.push('');
    out.push('| Threshold | Events / non-events | Brier shown / baseline | Mean forecast | Observed rate | Calibration Z | Status |', '|---|---|---|---|---|---|---|');
    for (const t of perf.thresholds) {
        out.push(`| ≥ ${t.threshold}× | ${t.events} / ${t.nonEvents} | ${num(t.brier)} / ${num(t.baselineBrier)} | ${pct(t.meanForecast)} | ${pct(t.observedRate)} | ${num(t.calibrationZ, 2)} | ${t.status} |`);
    }
    out.push('');
    out.push('| Model | Mean log loss | log10 e-value vs i.i.d. (needs ≥ 2.00) | Final weight | Validated |', '|---|---|---|---|---|');
    const w = ev.weights();
    for (const m of ['baseline', ...SIGNAL_CANDIDATES, 'ensemble']) {
        const cand = SIGNAL_CANDIDATES.includes(m);
        out.push(`| ${MODEL_NAME[m]} | ${ev.scored ? (-ev.logLik[m] / ev.scored).toFixed(5) : '—'} | ${cand && ev.scored ? (ev.logEValue(m) / Math.LN10).toFixed(2) : '—'} | ${m === 'ensemble' ? '—' : w[m].toFixed(3)} | ${ev.validated(m) ? 'yes' : 'no'} |`);
    }
    // By time period: quarters of the scored forecasts.
    const scored = r.entries.filter((e) => e.outcome?.status === 'scored');
    if (scored.length >= 400) {
        out.push('', '| Period (quarter of scored forecasts) | n | Log-loss diff (shown − baseline) | Top-range hit shown / baseline |', '|---|---|---|---|');
        for (let q = 0; q < 4; q++) {
            const part = scored.slice(Math.floor((q * scored.length) / 4), Math.floor(((q + 1) * scored.length) / 4));
            const p = performanceOf(part);
            out.push(`| Q${q + 1} | ${p.scored} | ${num(p.logLossDiff, 5)} [${num(p.logLossDiffLow, 5)}, ${num(p.logLossDiffHigh, 5)}] | ${pct(p.topRangeHitRate)} / ${pct(p.baselineTopRangeHitRate)} |`);
        }
    }
    out.push('');
    return out.join('\n');
}
export function controls() {
    const out = ['## Controls (SIMULATED rounds — not real game data)', ''];
    const neg = (n, histories) => {
        let ever = 0;
        let final = 0;
        for (let s = 0; s < histories; s++) {
            const r = replay(asRounds(fairSequence(n, 90_000 + s)));
            if (r.entries.some((e) => e.forecast.state === 'validated'))
                ever++;
            if (decide(r.evidence).state === 'validated')
                final++;
        }
        return { ever, final };
    };
    out.push('**Negative control** — independent rounds, P(M ≥ m) = 0.97 ÷ m. Any validation is a false positive.', '');
    out.push('| Rounds per history | Histories | Ever validated (at any round) | Validated at the end |', '|---|---|---|---|');
    for (const [n, k] of [
        [300, 200],
        [1000, 100],
        [3000, 40],
    ]) {
        const r = neg(n, k);
        out.push(`| ${n} | ${k} | ${r.ever} (${((100 * r.ever) / k).toFixed(1)}%) | ${r.final} |`);
    }
    out.push('', `Bound guaranteed by the method (Ville's inequality, Bonferroni over ${SIGNAL_RULES.candidates} candidates): at most α = 5% of histories ever validated.`, '');
    out.push('**Positive control** — planted dependence: P(≥ 2×) = 0.485 ± effect after a round below / at or above 2×.', '');
    out.push('| Effect | Rounds | Histories | Validated at the end | Validated model(s) |', '|---|---|---|---|---|');
    for (const [effect, n, k] of [
        [0.05, 3000, 20],
        [0.1, 1000, 20],
        [0.1, 3000, 20],
        [0.15, 500, 20],
        [0.15, 1500, 20],
    ]) {
        let hits = 0;
        const models = new Map();
        for (let s = 0; s < k; s++) {
            const r = replay(asRounds(plantedSequence(n, 70_000 + s, effect)));
            const d = decide(r.evidence);
            if (d.state === 'validated') {
                hits++;
                models.set(d.model, (models.get(d.model) ?? 0) + 1);
            }
        }
        out.push(`| ±${effect} | ${n} | ${k} | ${hits} (${((100 * hits) / k).toFixed(0)}%) | ${[...models].map(([m, c]) => `${m} ${c}`).join(', ') || '—'} |`);
    }
    out.push('');
    return out.join('\n');
}
const isMain = process.argv[1] && /backtest\.(ts|js)$/.test(process.argv[1]);
if (isMain) {
    const args = process.argv.slice(2);
    const valueOf = (flag) => (args.indexOf(flag) >= 0 ? args[args.indexOf(flag) + 1] : undefined);
    const outFile = valueOf('--out');
    const limit = Number(valueOf('--limit') ?? Infinity);
    const skip = new Set(['--out', '--limit'].map((f) => args.indexOf(f) + 1).filter((i) => i > 0));
    const files = args.filter((a, i) => !a.startsWith('--') && !skip.has(i));
    const parts = [`# Backtest report — engine stat-5 (sequential_v1)`, '', `Generated ${new Date().toISOString()}. Every forecast was issued before its round and scored after it (replay of the live process).`, ''];
    for (const f of files) {
        const { series, invalid, duplicates } = loadFile(f, args.includes('--reverse'));
        parts.push(`## ${basename(f)}`, '', `Invalid values skipped: ${invalid}. Exact duplicate rows removed: ${duplicates}.`, '');
        for (const s of series) {
            if (s.rounds.length > limit) {
                s.note += `; first ${limit.toLocaleString('en-US')} of ${s.rounds.length.toLocaleString('en-US')} rounds used`;
                s.rounds = s.rounds.slice(0, limit);
            }
            parts.push(reportSeries(s));
            console.error(`done: ${s.name}`);
        }
    }
    if (args.includes('--controls'))
        parts.push(controls());
    const report = parts.join('\n');
    if (outFile)
        writeFileSync(outFile, report);
    else
        console.log(report);
}
