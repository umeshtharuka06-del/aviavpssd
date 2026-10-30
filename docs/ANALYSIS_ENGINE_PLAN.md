# Python analysis engine — technical plan (2026-10-30)

Scope: an offline, reproducible multiplier analysis engine in `research/` (Python, NumPy, pandas, SciPy, scikit-learn), plus non-breaking integration points with the existing TypeScript system. Nothing here changes production, migrations, API contracts or the live engine.

## 1. Datasets: what each repository actually contains

| Id | Repository | Licence | What the files are | Decision |
|---|---|---|---|---|
| A | `hddvision/research-data` | MIT (README: "respect original data source terms") | **A mirror, not new data.** `multipliers.csv` is byte-identical (SHA-256 `d7f495ef…`) to B's and to `MindingTheData/Crash-Analysis` (2020); `aviator_dataset-1.csv` has the same rows as C (line endings differ). Its "D2 Validated" label has no documented validation | **excluded as a source**; recorded as a duplicate of B/C |
| B | `Waqas56jb/aviator-multiplier-prediction-ml` | MIT | `multipliers.csv` (732,367 values, no timestamps, no round ids, no operator) = MindingTheData file, which earlier audits identified as a bustabit-style hash chain, **not Aviator**. `aviator_dataset_clean.csv` (662,083 rows) is **derived features** of that file (`color`, `mean`, `var`, `next_approximate`, `target`). Its 99.7% "accuracy" is target leakage (to be quantified by the audit) | `multipliers.csv`: **negative control only** (non-Aviator crash game). `aviator_dataset_clean.csv`: **excluded** (derived, leaky) |
| C | `HananAIBuilds/aviator-ml-analysis` | **none** (all rights reserved by default) | 33,262 rows, `timestamp, crash_multiplier, num_bets, total_bet_amount`, 2026-01-27 → 2026-02-23. Operator unknown. Timestamps out of order in places, 85 duplicated times, 32 exact duplicate rows, 71 gaps > 10 min. `num_bets` is a mixed text field ("507" or "1967/4016"), `total_bet_amount` is 0 in 97% of rows | **usable for analysis, local only** (no licence: not redistributed, not committed). Multipliers only; the two bet columns are undocumented and inconsistent and are **not** used as player-behaviour data |
| D | `kakarla07/aviator-crash-analysis` | none | **No data in the repo.** Code reads Kaggle `waruingugi/aviator` = `PHIMAS/aviator` `aviator_payouts.csv` (300,000 rounds, four Kenyan operators, 2024) | that file is **usable per operator**, as in the earlier audits; D's own claims are not used |
| S | `hddvision/stochastic-crash-pipeline` | none in repo | **Synthetic**: 1,000,000 i.i.d. draws from a piecewise-uniform generator (`simulator.py`), not an Aviator distribution (P(<2×) = 65%) | **null-model control only**, always labelled SYNTHETIC, never pooled |

Player behaviour (item 5): no public, licensed, documented dataset of aggregated bets or cash-outs was found. C's two bet columns are the only candidates and fail validation. The engine is multiplier-only.

## 2. Engine architecture (`research/aviator_engine/`)

| Module | Responsibility |
|---|---|
| `sources.py` | registry: URL, licence, role (`real_candidate`, `negative_control`, `synthetic`, `excluded`), expected SHA-256 |
| `loaders.py` | parse each file into one normalised frame: `source_id, series_id, seq, round_key, multiplier, timestamp, run_id`; invalid values flagged, never imputed |
| `quality.py` | data-quality audit: counts, date range, invalid, exact and adjacent duplicates, timestamp disorder, gaps and bursts, 2-decimal check, cross-source overlap (8-gram fingerprints), synthetic fingerprints, leakage check for derived files |
| `ranges.py` | configurable ranges; frequencies with Wilson 95% intervals and n |
| `sequential.py` | low streaks, streak-length distribution vs geometric, rolling frequencies, ACF + Ljung–Box, runs test, P(≥2× \| k lows), block homogeneity and binary-segmentation change points (permutation-calibrated, reported only when significant after BH) |
| `strategy.py` | Python reference of the WATCH state machine (`range_state_machine_v1`), parity-tested against `strategy.ts` |
| `evaluate.py` | walk-forward, expanding window, periodic refit; baselines (empirical, fixed 0.97/m reference) vs candidates (Markov, streak, logistic regression on lag features); Brier, log loss, calibration; block-bootstrap CI; Holm; acceptance rule |
| `report.py`, `cli.py` | JSON + Markdown reports; `python -m aviator_engine.cli all` and `analyze-csv` for your own exported rounds |

Leakage controls: features use only rounds before the forecast round and never cross a run break; dedupe happens before any split; models are fitted only on rounds before each test block; a test perturbs future rounds and asserts no earlier forecast changes.

Acceptance rule: a candidate is "validated" only if its mean log-loss improvement over BOTH the cumulative and the recent-window empirical baselines has a block-bootstrap 95% CI entirely below 0, Holm-adjusted p < 0.05, and it is ahead in at least 4 of 5 chronological folds. It is "promoted" only if the series also passes the plausibility gate (implied RTP ≤ 1, crash-law shape). Otherwise the output is historical frequencies + baseline, labelled as such. (Added during implementation: the gate, after C1 turned out implausible.)

## 3. Integration points (no production change)

| Existing module | Change |
|---|---|
| `backend/src/engine/sequential/strategy.ts` | none. New `backend/tests/strategy-parity.test.ts` runs the shared fixture `research/fixtures/watch_parity.json`; pytest runs the same fixture against the Python reference |
| `shared/contracts` (`rangeIndex`, `targetHit`) | none. Boundary cases are in the same fixture |
| `extension/src/sidepanel/dashboard.ts` | additive only: a caption over the four bars ("Estimated chance for the next round, not a historical share") and, in "Your past rounds", historical shares of the same four ranges, derived from the existing `HistoricalSummary` (no server or contract change). Range labels, bars and layout unchanged |
| API, DB, migrations, live engine | none |

## 4. Expected limitations

- No 1xBet data is available to me; your VPS rounds are reachable only with credentials I don't have. `analyze-csv` lets you run the same engine on an export.
- C has no licence, no operator and unreliable timestamps; results from it are indicative only.
- Different operators may use different configurations; series are never pooled.
- With independent rounds, no model can beat the baseline; the expected outcome is "no validated model", and the engine will say so.
