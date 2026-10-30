# Range state machine (engine stat-5.4) — diagnosis, design, evaluation

**Status: experimental heuristic, built and tested locally only.** Nothing is committed, deployed or migrated.
No real 1xBet rounds were available; every figure below comes from **SIMULATED** rounds.

## 1. Diagnosis of the stat-5.3 engine

| Question | Finding |
|---|---|
| Why did the headline multiplier sit near 1.3×? | `representativeOf()` returned the **median of all past rounds in the forecast's most likely range**. The most likely range is almost always 1.00×–1.99× (≈ 51% vs ≈ 30% for 2.00×–4.99×), and the median of past rounds in that range is ≈ 1.3× for a crash game. It changes only as history accumulates, never with the next round. It was a historical summary, not a next-round forecast. |
| Are range forecasts scored correctly? | Yes. `resolve()` scores a forecast once against the next stored round; `rangeIndex()` / `rangeHit()` compare whole cents, boundaries go to the higher range. |
| Is a result above the predicted range counted as a miss? | As a **range** miss, correctly. But stat-5.3 issued no explicit target, so a 5.00× after a 1.00–1.99× (or 2.00–4.99×) forecast showed only "MISS" with a ✓ under "reached 2×". There was no TARGET HIT/MISS to separate from the range result. |
| Does forecast state persist across rounds and reloads? | Yes for the existing models: the ledger (`round_forecasts` / `forecast_outcomes`) is immutable, one forecast per input round (unique constraint), one outcome per forecast (primary key), all under a per-device advisory lock. The models are rebuilt from the stored rounds on every request, so a reload or restart cannot change them. There was no low-run state to persist. |
| Generated and scored exactly once per round? | Yes (covered by the existing ledger tests: retried batch, concurrent requests, immutability triggers). |

## 2. What changed

* **`backend/src/engine/sequential/strategy.ts`** — `RangeStrategyTracker`, the state machine, fed every stored round in order by the model set:
  * `consecutiveLow` counts rounds below the target (2.00×) in a row, within one verified run; a collection break restarts it.
  * **LOW-RANGE TRACKING** (fewer than 5 lows): the baseline distribution as is; predicted range = its most likely range.
  * **ELEVATED-RANGE WATCH** (5+ lows): predicted range = 2.00×–4.99×, target ≥ 2.00×. **A miss keeps the watch** (the count grows); **a round ≥ 2.00× resets the count**, so the next forecast is tracking again. A later run of five re-enters the watch.
  * Persistence rule: `maxWatchForecasts` (default `null` = until a target hit or a break; configurable, tested with 2).
  * Watch probabilities: the baseline as is (label **Baseline**) until at least 30 earlier rounds were played in a watch; then their range frequencies mixed with 20 baseline pseudo-rounds (label **Experimental**). A z statistic against the baseline is shown in Details; it is one uncorrected look, never called a validation.
  * `multiplierEstimate` is always `null`: the model has four range chances and no distribution inside a range, so no exact multiplier is defined.
* **Contract** (`shared/contracts/src/signal.ts`): `RangeStrategyForecastSchema`, `RANGE_STRATEGY_CONFIG`, `StrategyPerformanceSchema`; `ForecastRecord.strategy`, `outcome.targetHit`, `outcome.strategyRangeHit`, `NextRoundSignal.strategyPerformance`. All optional, so older servers and clients still parse.
* **Engine** (`engine.ts`): every forecast records its strategy (state, low count, target, predicted range, probabilities, rule config) at issue time; scored records carry TARGET and RANGE results separately; `representative` is now always `null` (the median is withdrawn). `ENGINE_VERSION = 'stat-5.4'`.
* **Migration `0006_range_strategy.sql`** (additive, nullable, no default, no rewrite): `round_forecasts.strategy jsonb`, `forecast_outcomes.target_hit`, `forecast_outcomes.strategy_range_hit`. Not run anywhere except the local test database.
* **Ledger** (`ledger-service.ts`): stores and loads the strategy and both hit flags inside the same locked transaction as before.
* **Panel**: headline shows "Multiplier estimate unavailable", the most likely range and its chance, the state chip, the consecutive-low count, the target and its chance, the watch range (and "kept after N misses"), and a small Baseline/Experimental tag. History rows show **TARGET HIT/MISS** and **RANGE HIT/MISS** separately with the actual multiplier, newest first. The state machine's rule and walk-forward record (by low-run length) are in the collapsed Details. The panel re-checks every strategy record against its own rule and refuses to display one that does not follow it; the stat-5.3 median is never shown.
* **`npm run evaluate:strategy -w @aviator/backend`** — walk-forward report (below); accepts the same CSV exports as `evaluate:signal`.

### Why persistence needs no new state store
The state is a pure function of the stored rounds in order. It is rebuilt from `game_observations` inside the ledger lock on every upload and analysis request, and recorded with every forecast in the immutable ledger. A browser reload, a service restart, a repeated upload (same `batchId`) or a failed upload therefore cannot advance, reset or double-count it: a failed upload stores nothing (the whole transaction rolls back) and the extension keeps the batch and retries it with the same `batchId`. Tested against PostgreSQL in `backend/tests/strategy-ledger.test.ts`.

## 3. Tests added

| Requirement | Test |
|---|---|
| 4 lows vs 5 lows; 6+ lows | `strategy.test.ts` "four low rounds keep LOW-RANGE TRACKING…", "six, seven, …" |
| Target persistence after misses; reset after a hit; re-entry | `strategy.test.ts`, `strategy-ledger.test.ts`, `engine-to-panel.test.ts` |
| 1.99×, 2.00×, 2.40×, 4.00×, 5.00× (and 4.99×, 12.5×, float noise) | `strategy.test.ts` "TARGET HIT and RANGE HIT are separate" |
| 5.00× = TARGET HIT, RANGE MISS, recorded separately (response and DB columns) | `strategy.test.ts`, `strategy-ledger.test.ts`, `dashboard.test.ts` |
| Page reload and service restart | `strategy-ledger.test.ts` (new pool + app on the same database) |
| Duplicate rounds / duplicate scoring | `strategy-ledger.test.ts` (same batch ×3) |
| Failed upload and retry | `strategy-ledger.test.ts` (insert forced to fail, then retried with the same `batchId`) |
| Walk-forward, no look-ahead | `strategy.test.ts` (later rounds changed → earlier strategy forecasts identical; rebuild-from-scratch = replay) |
| Negative / positive controls | `strategy.test.ts` (10 fair histories; planted low-run effect detected) |
| Panel rejects inconsistent records | `dashboard.test.ts` (5 tampered fields, a wrong range flag) |

## 4. Walk-forward evaluation (SIMULATED rounds)

Rule fixed before any run (the specification's thresholds, `RANGE_STRATEGY_CONFIG`); seeds fixed in the script; nothing tuned on these rounds.
Pre-registered criterion for "improvement": the whole 95% interval of the paired (strategy − baseline) target log-loss difference is below 0.

#### SIMULATED negative control: independent rounds (seed 1001)

10,000 rounds · 9,980 eligible (scored) forecasts · 0 void (collection break) · 372 issued in ELEVATED-RANGE WATCH.

| | Strategy | Baseline | Shown engine forecast |
|---|---|---|---|
| Target hit rate (actual ≥ 2.00×) [95% CI] | 48.7% [47.7%, 49.7%] | same rounds, same event | same |
| Range hit rate (actual inside predicted range) | 50.2% | 51.3% | 51.3% |
| Target Brier ↓ | 0.2500 | 0.2500 | 0.2500 |
| Target log loss ↓ | 0.6931 | 0.6931 | |
| 4-range log loss ↓ | 1.1537 | 1.1535 | |
| 4-range Brier ↓ | 0.6319 | 0.6319 | |

Paired target log-loss difference (strategy − baseline): −0.0000 [−0.0004, +0.0003]. **Interval not entirely below 0: no predictive improvement shown.**

By consecutive rounds below 2.00× before the forecast round:

| Low run | n | Target hits [95% CI] | Mean P(≥2×) strategy | Mean P(≥2×) baseline | Range hits strategy / baseline | Target Brier strategy / baseline |
|---|---|---|---|---|---|---|
| 0-1 | 7,328 | 48.6% [47.4%, 49.7%] | 49.2% | 49.2% | 51.4% / 51.4% | 0.2501 / 0.2501 |
| 2-4 | 2,280 | 49.9% [47.8%, 51.9%] | 49.1% | 49.1% | 50.1% / 50.1% | 0.2499 / 0.2499 |
| 5-7 | 294 | 46.6% [41.0%, 52.3%] | 46.1% | 48.9% | 26.9% / 53.4% | 0.2503 / 0.2493 |
| 8+ | 78 | 37.2% [27.3%, 48.3%] | 45.5% | 48.7% | 23.1% / 62.8% | 0.2410 / 0.2465 |

Watch forecasts only: target hits 44.6% [39.7%, 49.7%], range hits (2.00×–4.99×) 26.1% vs baseline's most likely range 55.4%; target log-loss difference −0.0007 [−0.0096, +0.0082].

#### SIMULATED negative control: independent rounds (seed 1002)

10,000 rounds · 9,980 eligible (scored) forecasts · 0 void (collection break) · 357 issued in ELEVATED-RANGE WATCH.

| | Strategy | Baseline | Shown engine forecast |
|---|---|---|---|
| Target hit rate (actual ≥ 2.00×) [95% CI] | 48.8% [47.9%, 49.8%] | same rounds, same event | same |
| Range hit rate (actual inside predicted range) | 50.2% | 51.2% | 51.2% |
| Target Brier ↓ | 0.2501 | 0.2501 | 0.2501 |
| Target log loss ↓ | 0.6934 | 0.6933 | |
| 4-range log loss ↓ | 1.1632 | 1.1629 | |
| 4-range Brier ↓ | 0.6356 | 0.6355 | |

Paired target log-loss difference (strategy − baseline): +0.0000 [−0.0001, +0.0002]. **Interval not entirely below 0: no predictive improvement shown.**

By consecutive rounds below 2.00× before the forecast round:

| Low run | n | Target hits [95% CI] | Mean P(≥2×) strategy | Mean P(≥2×) baseline | Range hits strategy / baseline | Target Brier strategy / baseline |
|---|---|---|---|---|---|---|
| 0-1 | 7,349 | 49.1% [47.9%, 50.2%] | 48.7% | 48.7% | 50.9% / 50.9% | 0.2501 / 0.2501 |
| 2-4 | 2,274 | 48.6% [46.5%, 50.6%] | 48.6% | 48.6% | 51.4% / 51.4% | 0.2499 / 0.2499 |
| 5-7 | 310 | 45.8% [40.3%, 51.4%] | 47.1% | 48.4% | 27.4% / 54.2% | 0.2505 / 0.2500 |
| 8+ | 47 | 46.8% [33.3%, 60.8%] | 46.8% | 48.7% | 27.7% / 53.2% | 0.2487 / 0.2486 |

Watch forecasts only: target hits 45.9% [40.8%, 51.1%], range hits (2.00×–4.99×) 27.5% vs baseline's most likely range 54.1%; target log-loss difference +0.0009 [−0.0028, +0.0046].

#### SIMULATED negative control: independent rounds (seed 1003)

10,000 rounds · 9,980 eligible (scored) forecasts · 0 void (collection break) · 381 issued in ELEVATED-RANGE WATCH.

| | Strategy | Baseline | Shown engine forecast |
|---|---|---|---|
| Target hit rate (actual ≥ 2.00×) [95% CI] | 48.2% [47.2%, 49.2%] | same rounds, same event | same |
| Range hit rate (actual inside predicted range) | 50.9% | 51.8% | 51.8% |
| Target Brier ↓ | 0.2499 | 0.2498 | 0.2498 |
| Target log loss ↓ | 0.6929 | 0.6928 | |
| 4-range log loss ↓ | 1.1535 | 1.1532 | |
| 4-range Brier ↓ | 0.6306 | 0.6305 | |

Paired target log-loss difference (strategy − baseline): +0.0001 [−0.0002, +0.0004]. **Interval not entirely below 0: no predictive improvement shown.**

By consecutive rounds below 2.00× before the forecast round:

| Low run | n | Target hits [95% CI] | Mean P(≥2×) strategy | Mean P(≥2×) baseline | Range hits strategy / baseline | Target Brier strategy / baseline |
|---|---|---|---|---|---|---|
| 0-1 | 7,307 | 48.3% [47.2%, 49.5%] | 47.8% | 47.8% | 51.7% / 51.7% | 0.2498 / 0.2498 |
| 2-4 | 2,292 | 48.1% [46.1%, 50.2%] | 47.7% | 47.7% | 51.9% / 51.9% | 0.2501 / 0.2501 |
| 5-7 | 327 | 45.9% [40.5%, 51.3%] | 44.3% | 47.8% | 29.1% / 54.1% | 0.2506 / 0.2488 |
| 8+ | 54 | 46.3% [33.7%, 59.4%] | 44.1% | 47.8% | 33.3% / 53.7% | 0.2495 / 0.2498 |

Watch forecasts only: target hits 45.9% [41.0%, 51.0%], range hits (2.00×–4.99×) 29.7% vs baseline's most likely range 54.1%; target log-loss difference +0.0031 [−0.0046, +0.0108].

#### SIMULATED positive control: P(≥2×) = 0.585 after ≥ 5 lows (seed 2001)

10,000 rounds · 9,980 eligible (scored) forecasts · 0 void (collection break) · 247 issued in ELEVATED-RANGE WATCH.

| | Strategy | Baseline | Shown engine forecast |
|---|---|---|---|
| Target hit rate (actual ≥ 2.00×) [95% CI] | 49.8% [48.8%, 50.8%] | same rounds, same event | same |
| Range hit rate (actual inside predicted range) | 50.2% | 50.2% | 50.1% |
| Target Brier ↓ | 0.2498 | 0.2502 | 0.2502 |
| Target log loss ↓ | 0.6927 | 0.6935 | |
| 4-range log loss ↓ | 1.1659 | 1.1665 | |
| 4-range Brier ↓ | 0.6386 | 0.6390 | |

Paired target log-loss difference (strategy − baseline): −0.0008 [−0.0015, −0.0002]. **Interval entirely below 0: the strategy improved on the baseline on these rounds.**

By consecutive rounds below 2.00× before the forecast round:

| Low run | n | Target hits [95% CI] | Mean P(≥2×) strategy | Mean P(≥2×) baseline | Range hits strategy / baseline | Target Brier strategy / baseline |
|---|---|---|---|---|---|---|
| 0-1 | 7,488 | 49.4% [48.2%, 50.5%] | 50.3% | 50.3% | 50.6% / 50.6% | 0.2503 / 0.2503 |
| 2-4 | 2,245 | 49.8% [47.7%, 51.9%] | 50.2% | 50.2% | 50.2% / 50.2% | 0.2498 / 0.2498 |
| 5-7 | 235 | 63.4% [57.1%, 69.3%] | 60.2% | 50.1% | 38.3% / 36.6% | 0.2347 / 0.2498 |
| 8+ | 12 | 75.0% [46.8%, 91.1%] | 57.0% | 50.3% | 25.0% / 25.0% | 0.2093 / 0.2499 |

Watch forecasts only: target hits 64.0% [57.8%, 69.7%], range hits (2.00×–4.99×) 37.7% vs baseline's most likely range 36.0%; target log-loss difference −0.0330 [−0.0595, −0.0064].

## 5. What the results say

* **Independent rounds (negative controls): no improvement.** Target log loss and Brier equal the baseline's to the 4th decimal; every interval contains 0. After five or more lows the 2× hit rate stays at the base rate (≈ 45–47% in each 10,000-round history, within its interval; 48.0–48.2% on 1,000,000-round checks, the same as after no lows).
* **Range hits get worse in the watch**, as they must: 2.00×–4.99× is a less likely range (≈ 30%) than 1.00×–1.99× (≈ 51%). Predicting it hits ≈ 26–30% of the time vs ≈ 54% for the baseline's most likely range. This is the cost of the heuristic's range choice, not a scoring error.
* **Planted dependence (positive control): detected.** When the generator really raises P(≥ 2×) after five lows (to 0.585), the conditional estimate learns it and the target log-loss interval falls entirely below 0. So the method can find such an effect if it exists.
* **Conclusion: on independent data the five-low rule gives no predictive improvement.** Real rounds have not been tested; the same command runs on an export (§6). Low-run buckets 5–7 and 8+ are small (hundreds of rounds per 10,000), so a real-data verdict needs tens of thousands of rounds.

## 6. Limitations and next steps

* No real 1xBet rounds were available. Run on a read-only export: `npm run evaluate:strategy -w @aviator/backend -- rounds.csv --out report.md` (formats as in `docs/NEXT_ROUND_FORECAST.md`).
* The low count is computed from rounds still in the 12 h retention window (at most 5,000); a run longer than that window is truncated. Not relevant in practice.
* The live record in the panel is per device and resets with retention (12 h), so it stays small.
* The extension's release ZIPs are unchanged (no `--package` run). A new ZIP and a version bump are needed to ship the panel.
* **Deployment order** (needs approval): back up the database → apply migrations 0006 and 0007 → deploy backend stat-5.4 → ship the extension. Until they are applied, stat-5.4 code fails with `database_schema_outdated` (as the schema-drift test shows for earlier migrations). Old extensions keep working with the new server (new fields are optional); they will show "Exact multiplier unavailable" because `representative` is now null.

## 7. Data-path diagnosis (2026-10-29)

Traced from the page to the panel. The content script diffs the visible results list and sends new
rounds **oldest → newest** with its read chain and position (`src/content/controller.ts`). The upload
queue keeps the `batchId` across retries. The server inserts in that order (`WITH ORDINALITY … ORDER BY
ord`), so ids rise in round order, and a repeated `batchId` stores nothing. `break_before` comes from the
chain position (`continuityBreak`). The ledger rebuilds the state machine from the rounds in id order
inside the ledger lock and records it with the forecast. The panel draws the forecast for the latest
stored round.

| Case | Behaviour | Correct? |
|---|---|---|
| Rounds out of order | Not possible: client order kept, ids rise in insertion order | yes |
| Duplicate upload (same batch) | Stored once, counted once, scored once | yes |
| Rounds lost between uploads (chain jump) | Break → count restarts at the next round | yes, by design: the true run length is unknown |
| **Game-page reload, nothing lost** | **Was a break**: count restarted and the open forecast was voided | **bug, fixed** (migration 0007) |
| Reload, then a lost round, or the old tab still storing | Still a break | yes |

The bug: after a reload the new chain's backfill aligned with the stored rounds but added nothing, so
no stored row carried the new chain and the next live round failed the continuity check. Fix: the
backfill records a chain link (position ↔ stored round) and the continuity check honours it, for the
exact next position only. Tests: `backend/tests/strategy-path.test.ts`, including the specified
sequence (4 lows, 5 lows, misses, then hits at 2.00×, 4.00× and 5.00×) through the real API.
