// Walk-forward evaluation of the range state machine against the baseline (and the forecast the engine
// already showed), on exactly the same scored rounds. Read-only: nothing is written to a database.
//
//   npm run evaluate:strategy -w @aviator/backend -- [<file.csv> ...] [--reverse] [--limit N] [--out report.md]
//
// Without files it runs the SIMULATED controls only (fixed seeds, chosen before the first run):
//   negative control  independent rounds, P(M ≥ m) = 0.97 ÷ m        3 histories × 10,000 rounds
//   positive control  after ≥ 5 rounds below 2×, P(≥ 2×) is 0.585     1 history × 10,000 rounds
// Forecasts come from replay(), the live process: each one is issued from earlier rounds only and
// scored once by the next round. The rule's thresholds are the user's specification
// (RANGE_STRATEGY_CONFIG) and are not tuned on any of these rounds.
import { writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { RANGE_STRATEGY_CONFIG, rangeHit, thresholdProbabilities } from '@aviator/contracts';
import { loadFile } from './backtest.js';
import { replay, strategyScoresOf, topRange } from './engine.js';
import { asRounds, fairSequence, plantedRunSequence } from './simulate.js';
import { strategyPerformanceOf } from './strategy.js';
const pct = (v) => (v == null ? '—' : `${(v * 100).toFixed(1)}%`);
const n3 = (v) => (v == null ? '—' : v.toFixed(4));
const ci = (r) => (r.rate == null ? '—' : `${pct(r.rate)} [${pct(r.low)}, ${pct(r.high)}]`);
const signed = (v) => (v == null ? '—' : `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(4)}`);
const int = (n) => n.toLocaleString('en-US');
export function evaluateStrategy(name, rounds) {
    const { entries } = replay(rounds);
    const scored = entries.filter((e) => e.forecast.strategy && e.outcome?.status === 'scored');
    const xs = strategyScoresOf(entries);
    const all = strategyPerformanceOf(xs);
    const watch = strategyPerformanceOf(xs.filter((x) => x.strategy.state === 'elevated_range_watch'));
    const shown = scored.map((e) => ({ p: e.forecast.probabilities, m: e.outcome.status === 'scored' ? e.outcome.multiplier : 0 }));
    const t = RANGE_STRATEGY_CONFIG.targetThreshold;
    const shownTargetBrier = shown.length ? shown.reduce((a, x) => a + (thresholdProbabilities(x.p).p2 - (x.m >= t ? 1 : 0)) ** 2, 0) / shown.length : null;
    return {
        name,
        rounds: rounds.length,
        voided: entries.filter((e) => e.outcome?.status === 'void').length,
        all,
        watch,
        shownRangeHits: shown.filter((x) => rangeHit(x.m, topRange(x.p))).length,
        shownTargetBrier,
        // Pre-registered criterion: the whole 95% interval of the paired target log-loss difference below 0.
        supportsImprovement: all.targetLogLossDiffHigh != null && all.targetLogLossDiffHigh < 0,
    };
}
export function reportEvaluation(e) {
    const a = e.all;
    const w = e.watch;
    const out = [
        `### ${e.name}`,
        '',
        `${int(e.rounds)} rounds · ${int(a.eligible)} eligible (scored) forecasts · ${int(e.voided)} void (collection break) · ${int(w.eligible)} issued in ELEVATED-RANGE WATCH.`,
        '',
        '| | Strategy | Baseline | Shown engine forecast |',
        '|---|---|---|---|',
        `| Target hit rate (actual ≥ 2.00×) [95% CI] | ${ci(a.target)} | same rounds, same event | same |`,
        `| Range hit rate (actual inside predicted range) | ${pct(a.eligible ? a.rangeHits / a.eligible : null)} | ${pct(a.eligible ? a.baselineRangeHits / a.eligible : null)} | ${pct(a.eligible ? e.shownRangeHits / a.eligible : null)} |`,
        `| Target Brier ↓ | ${n3(a.targetBrier)} | ${n3(a.baselineTargetBrier)} | ${n3(e.shownTargetBrier)} |`,
        `| Target log loss ↓ | ${n3(a.targetLogLoss)} | ${n3(a.baselineTargetLogLoss)} | |`,
        `| 4-range log loss ↓ | ${n3(a.rangeLogLoss)} | ${n3(a.baselineRangeLogLoss)} | |`,
        `| 4-range Brier ↓ | ${n3(a.rangeBrier)} | ${n3(a.baselineRangeBrier)} | |`,
        '',
        `Paired target log-loss difference (strategy − baseline): ${signed(a.targetLogLossDiff)} [${signed(a.targetLogLossDiffLow)}, ${signed(a.targetLogLossDiffHigh)}]. ` +
            `**${e.supportsImprovement ? 'Interval entirely below 0: the strategy improved on the baseline on these rounds.' : 'Interval not entirely below 0: no predictive improvement shown.'}**`,
        '',
        'By consecutive rounds below 2.00× before the forecast round:',
        '',
        '| Low run | n | Target hits [95% CI] | Mean P(≥2×) strategy | Mean P(≥2×) baseline | Range hits strategy / baseline | Target Brier strategy / baseline |',
        '|---|---|---|---|---|---|---|',
        ...a.byRunLength.map((b) => `| ${b.bucket} | ${int(b.target.n)} | ${ci(b.target)} | ${pct(b.meanTargetProbability)} | ${pct(b.meanBaselineTargetProbability)} | ${pct(b.target.n ? b.rangeHits / b.target.n : null)} / ${pct(b.target.n ? b.baselineRangeHits / b.target.n : null)} | ${n3(b.targetBrier)} / ${n3(b.baselineTargetBrier)} |`),
        '',
        `Watch forecasts only: target hits ${ci(w.target)}, range hits (2.00×–4.99×) ${pct(w.eligible ? w.rangeHits / w.eligible : null)} vs baseline's most likely range ${pct(w.eligible ? w.baselineRangeHits / w.eligible : null)}; ` +
            `target log-loss difference ${signed(w.targetLogLossDiff)} [${signed(w.targetLogLossDiffLow)}, ${signed(w.targetLogLossDiffHigh)}].`,
        '',
    ];
    return out.join('\n');
}
export function simulatedControls() {
    return [
        ...[1001, 1002, 1003].map((seed) => evaluateStrategy(`SIMULATED negative control: independent rounds (seed ${seed})`, asRounds(fairSequence(10_000, seed)))),
        evaluateStrategy('SIMULATED positive control: P(≥2×) = 0.585 after ≥ 5 lows (seed 2001)', asRounds(plantedRunSequence(10_000, 2001, 0.1))),
    ];
}
const isMain = process.argv[1] && /evaluate-strategy\.(ts|js)$/.test(process.argv[1]);
if (isMain) {
    const args = process.argv.slice(2);
    const valueOf = (flag) => (args.indexOf(flag) >= 0 ? args[args.indexOf(flag) + 1] : undefined);
    const outFile = valueOf('--out');
    const limit = Number(valueOf('--limit') ?? Infinity);
    const skip = new Set(['--out', '--limit'].map((f) => args.indexOf(f) + 1).filter((i) => i > 0));
    const files = args.filter((a, i) => !a.startsWith('--') && !skip.has(i));
    const c = RANGE_STRATEGY_CONFIG;
    const parts = [
        '# Range state machine — walk-forward evaluation',
        '',
        `Generated ${new Date().toISOString()} by \`npm run evaluate:strategy\`. Rule (fixed before evaluation): ${c.lowEntryCount} consecutive rounds below ${c.targetThreshold.toFixed(2)}× enter ELEVATED-RANGE WATCH, ` +
            `which predicts range ${c.watchRange} (2.00×–4.99×) until a round reaches ${c.targetThreshold.toFixed(2)}× or collection breaks; its own estimate needs ${c.minConditionalSample} earlier watch rounds, mixed with ${c.priorStrength} baseline pseudo-rounds.`,
        '',
    ];
    for (const f of files) {
        const { series } = loadFile(f, args.includes('--reverse'));
        for (const s of series) {
            parts.push(reportEvaluation(evaluateStrategy(`${basename(f)} — ${s.name}`, s.rounds.slice(0, limit))));
            console.error(`done: ${s.name}`);
        }
    }
    if (!files.length)
        for (const e of simulatedControls())
            parts.push(reportEvaluation(e));
    const report = parts.join('\n');
    if (outFile)
        writeFileSync(outFile, report);
    else
        console.log(report);
}
