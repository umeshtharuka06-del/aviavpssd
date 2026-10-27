import { readFileSync } from 'node:fs';
import { computeForecast, type ForecastRound } from './forecast.js';
import { isValidMultiplier } from './summary.js';

/**
 * Offline run of the walk-forward forecast experiment on an exported round history.
 *
 *   npm run backtest -w @aviator/backend -- rounds.csv [--json]
 *
 * One round per line, OLDEST FIRST: `multiplier` or `multiplier,received_at` (ISO time). A header
 * line and invalid values are skipped. Without times, all rounds are treated as one unbroken run.
 * Reads the file only; writes nothing.
 */
function main(argv: string[]): void {
  const file = argv.find((a) => !a.startsWith('--'));
  if (!file) {
    console.error('usage: backtest <rounds.csv> [--json]');
    process.exit(2);
  }
  const rounds: ForecastRound[] = [];
  let skipped = 0;
  let i = 0;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [m, t] = line.split(',').map((s) => s.trim());
    const multiplier = Number(m);
    const receivedAt = t ? new Date(t) : new Date(Date.UTC(2000, 0, 1) + i * 10_000);
    if (!isValidMultiplier(multiplier) || Number.isNaN(receivedAt.getTime())) {
      skipped++;
      continue;
    }
    rounds.push({ multiplier, receivedAt });
    i++;
  }
  const f = computeForecast(rounds);
  if (argv.includes('--json')) {
    console.log(JSON.stringify(f, null, 2));
    return;
  }
  console.log(`rounds ${f.sampleSize} (skipped ${skipped}) · runs ${f.segments} · test rounds ${f.testRounds} · refit every ${f.refitEvery} · ${f.status}`);
  if (f.status === 'insufficient_data') {
    console.log(`needs at least ${f.minSampleSize} rounds (${f.trainInitial} training + scored test rounds)`);
    return;
  }
  const pct = (v: number | null) => (v == null ? '   —  ' : `${(v * 100).toFixed(2).padStart(6)}%`);
  for (const th of f.thresholds) {
    console.log(`\n≥ ${th.threshold}×  ${th.status}  estimate ${pct(th.probability)} [${pct(th.low)} – ${pct(th.high)}]  model ${th.selectedModel ?? '—'}`);
    console.log('  model            log loss  skill     p (DM)   calib Z  calibrated  validated');
    for (const s of th.models) {
      console.log(
        `  ${s.model.padEnd(16)} ${s.logLoss.toFixed(4)}   ${s.skillVsBaseRate == null ? '   —   ' : pct(s.skillVsBaseRate)}  ${s.pValue == null ? '  —   ' : s.pValue.toFixed(4)}   ${s.calibrationZ.toFixed(2).padStart(6)}   ${String(s.calibrated).padEnd(10)}  ${s.validated}`,
      );
    }
  }
}

main(process.argv.slice(2));
