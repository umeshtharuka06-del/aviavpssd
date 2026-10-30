# Python analysis engine — results (2026-10-30)

Produced by `python -m aviator_engine.cli all` (full run; full tables in `research/out/report.md`, regenerated locally, not committed). Plan: [ANALYSIS_ENGINE_PLAN.md](ANALYSIS_ENGINE_PLAN.md). Code: [research/](../research/README.md).

**No 1xBet data was available.** Everything below is third-party data from other operators, a different crash game, or generated data. Each series is analysed on its own. Nothing is pooled.

## 1. Data sources and quality

| Id | Source | Licence | Role | Valid rounds | Dates | Quality findings |
|---|---|---|---|---|---|---|
| A1 | hddvision/research-data `multipliers.csv` | MIT | excluded | 732,367 | none | byte-identical to B1, so a **mirror** and not new data |
| A2 | hddvision/research-data `aviator_dataset-1.csv` | MIT | excluded | 33,230 | 2026-01-27 → 02-23 | same rows as C1, so a **mirror** |
| B1 | Waqas56jb/… `multipliers.csv` | MIT | negative control | 732,367 | none | same bytes as MindingTheData/Crash-Analysis (2020), a bustabit-style crash game and **not Aviator**. No timestamps or ids, so the order can't be verified |
| B2 | Waqas56jb/… `aviator_dataset_clean.csv` | MIT | excluded | 662,083 | none | features derived from B1. `color` equals the label (target > 2) in **99.73%** of rows, so the repository's 99.7% accuracy comes from **target leakage** |
| C1 | HananAIBuilds/aviator-ml-analysis | **none** | real candidate | 33,230 (32 exact duplicates removed) | 2026-01-27 → 02-23 | **fails plausibility**: P(≥2×) = 68.3% and P(≥10×) = 17.0%, which imply RTP 1.37 and 1.70. That is impossible for a house-edge game. The shape inside [1, 2) is 0.594 against 0.686 for a crash law. Lag-1 r = +0.13, 10 change points, 541 runs. `num_bets` mixes "507" and "1967/4016" formats, and `total_bet_amount` is 0 in 97% of rows |
| P1 | PHIMAS/aviator (the data behind kakarla07, which holds none itself) | none | real candidate, per operator | BETGR8 97,407 · BETIKA 107,449 · ODIBETS 66,823 · WINPESA 28,315 | 2024-01-01 → 02-03 | catch-up bursts (< 2 s) split runs. **ODIBETS fails plausibility**: P(≥10×) = 10.7%, so a 10× cash-out would return 1.07. Low rounds are most likely missing from that file |
| S1 | hddvision/stochastic-crash-pipeline | none | synthetic | 1,000,000 | generated | piecewise-uniform generator (shape 0.498 = uniform), **not a game** |

Overlap check (shared 8-round sequences): A1↔B1 100%, A2↔C1 100%, no other overlap between series.

**Player behaviour:** I found no public, licensed, documented dataset of aggregated bets or cash-outs. The only candidates are C1's two bet columns, and they fail validation (undocumented, mixed formats, mostly zero). They are not used. The engine is multiplier-only.

## 2. Historical range frequencies (panel ranges, 95% Wilson CI)

| Series | 1.00–1.99× | 2.00–4.99× | 5.00–9.99× | 10.00×+ |
|---|---|---|---|---|
| P1:BETGR8 | 51.3% [51.0, 51.6] | 28.5% [28.2, 28.7] | 10.1% [9.9, 10.3] | 10.1% [9.9, 10.3] |
| P1:BETIKA | 52.1% [51.8, 52.4] | 28.7% [28.4, 28.9] | 9.5% [9.3, 9.6] | 9.8% [9.6, 10.0] |
| P1:WINPESA | 51.0% [50.4, 51.6] | 29.4% [28.9, 30.0] | 9.8% [9.5, 10.2] | 9.7% [9.4, 10.1] |
| P1:ODIBETS (failed gate) | 49.7% | 29.7% | 9.8% | 10.7% |
| B1 (not Aviator) | 51.7% | 29.0% | 9.6% | 9.6% |
| 0.97/m reference | 51.5% | 29.1% | 9.7% | 9.7% |

The five analysis ranges (1.00–1.49, 1.50–1.99, …), P(≥ 1.5/2/3/5/10/100×) and configurable ranges for every series are in the report.

## 3. Sequential patterns (pairs only inside verified runs, BH over 5 tests)

| Series | Any dependence after BH | Lag-1 r(≥2×) | P(≥2× \| k lows) range, k = 0…8+ | Distribution change over time |
|---|---|---|---|---|
| P1:BETGR8 | **no** (min BH p 0.12) | −0.002 | 48.6%–51.7% | yes (block χ² p 1e-61; 2 change points) |
| P1:BETIKA | **no** (0.51) | +0.000 | 47.8%–51.0% | yes (p 2e-8) |
| P1:ODIBETS | **no** (0.47) | −0.001 | 46.3%–52.0% | yes (p 1e-52; 5 change points) |
| P1:WINPESA | **no** (0.16) | +0.008 | 46.8%–64.2% (n 53 at 8+) | no |
| B1 | **no** (0.71) | −0.001 | 47.9%–49.9% | no |
| C1 (failed gate) | yes (p ≈ 0) | +0.132 | 48.6%–72.3% | yes |
| S1 (synthetic) | no | +0.001 | 34.9%–36.1% | no |

The first quick pass showed "dependence" on all four PHIMAS operators. The cause was **censoring**: a run break was counted as "0 lows" when the count was actually unknown, and short runs under-sample long streaks. Once only exact counts are used, all four are null. That matches the earlier TypeScript audit. The streak-length table is kept as a descriptive table only.

## 4. The WATCH rule, walk-forward (live rules: 5 lows below 2.00× → WATCH, target ≥ 2.00×, range 2.00–4.99×)

| Series | WATCH forecasts (share) | TARGET hit in WATCH [95% CI] | TARGET hit while tracking | Fisher p | RANGE 2.00–4.99× hit in WATCH |
|---|---|---|---|---|---|
| P1:BETGR8 | 2,469 (3.1%) | 50.2% [48.2, 52.2] | 49.5% | 0.49 | 32.4% |
| P1:BETIKA | 2,985 (3.3%) | 49.1% [47.4, 50.9] | 49.2% | 0.94 | 30.0% |
| P1:WINPESA | 624 (2.5%) | 50.2% [46.2, 54.1] | 51.4% | 0.57 | 31.7% |
| B1 | 27,010 (3.7%) | 48.7% [48.1, 49.3] | 48.3% | 0.16 | 29.2% |

After five lows, the next round reaches 2× **no more often** than at any other time. The WATCH state works as specified (parity-tested), but it carries no predictive information. A long low streak does not make a high multiplier due.

## 5. Model evaluation (walk-forward, first 60,000 rounds per series)

Baselines: cumulative empirical (add-½), recent 2,000-round empirical, fixed 0.97/m reference. Candidates: previous-range Markov, low-streak, logistic regression (lags, masks, rolling stats), gradient boosting. Δ = mean log-loss difference vs the cumulative baseline (negative = better), with block-bootstrap 95% CI.

| Series | Markov Δ | Streak Δ | Logistic Δ | Gradient boosting Δ | Verdict |
|---|---|---|---|---|---|
| P1:BETGR8 | +0.00013 [−0.00010, +0.00038] | +0.00062 | +0.0044 | +0.0118 | **no validated model** |
| P1:BETIKA | +0.00034 [+0.00008, +0.00060] | +0.00074 | +0.0071 | +0.0125 | **no validated model** |
| P1:WINPESA | −0.00058 [−0.00134, +0.00017] | +0.00126 | +0.0049 | +0.0195 | **no validated model** (Holm p 0.27) |
| B1 | +0.00025 | +0.00054 | +0.0025 | +0.0108 | **no validated model** |
| S1 (synthetic) | +0.00027 | +0.00074 | +0.0033 | +0.0110 | **no validated model** |
| P1:ODIBETS | −0.00180 [−0.00254, −0.00109] | +0.00020 | +0.0086 | +0.0181 | Markov passes the statistics, but it is **not promoted**: the file fails plausibility and every dependence test is null, so the gain tracks level drift and collection gaps, not round-to-round memory |
| C1 | −0.0106 | −0.0088 | −0.0439 | −0.0375 | logistic and gradient boosting pass, but they are **not promoted**: the file is not plausible game data |

Every model picks 1.00–1.99× as the most likely range, the same as the baseline, so no model improves the top-range hit rate on any plausible series. The ML models are worse than the baselines and badly calibrated (Spiegelhalter Z +7 to +24).

**SIMULATED controls** (6 × 20,000 rounds each): on independent rounds, dependence was flagged in 1 of 6 and a model was validated in 0 of 6. With a planted ±5 pp previous-round effect, dependence was detected in 6 of 6 and a model was validated in 6 of 6. The pipeline does find real dependence when it exists.

**Decision:** no model is validated on any plausible data. The panel's numbers should stay historical frequencies plus the baseline, labelled as such.

## 6. Integration done (local only)

| File | Change |
|---|---|
| `research/` (new) | engine, CLI, fixtures, 37 pytest tests; `data/` and `out/` gitignored |
| `backend/tests/strategy-parity.test.ts` (new) | the live `strategy.ts` against the shared fixture `research/fixtures/watch_parity.json` |
| `extension/src/sidepanel/dashboard.ts` | caption "Estimated chance · next round" over the four bars (labels, bars, order and values unchanged); new line "Historical share, N rounds: …" under *Your past rounds*, derived exactly from the existing summary counts and hidden if those counts are inconsistent |
| `extension/tests/dashboard.test.ts` | tests for both additions and for the unchanged four labels/bars |
| docs | this file, ANALYSIS_ENGINE_PLAN.md |

No change to the API, contracts, database, migrations, live engine, WATCH rules or forecast history.

## 7. Findings to decide on (not changed)

1. **The bars showed unvalidated estimates in the "experimental" state.** The panel drew `strategy.probabilities` (or the ensemble average), even though nothing was validated. In WATCH, after 30 watch rounds, it drew the conditional mix. **Approved and prepared 2026-10-30 in extension 0.2.8** (not installed): the bars now draw `baselineProbabilities` unless the forecast is VALIDATED, and the headline and Details keep the strategy figures. See [extension/release/RELEASE-0.2.8.md](../extension/release/RELEASE-0.2.8.md).
2. `rangeIndex` in the contracts compares raw values (`m < 2`), while `rangeHit`/`targetHit` compare whole cents. They disagree only on values like 1.9999999. Ingestion accepts at most 2 decimals, so this cannot happen in production. Noted, not changed.
