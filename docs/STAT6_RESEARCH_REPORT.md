# stat-6 Dual Prediction Engine — research report and implementation plan (2026-10-30)

**Status: research and plan only. Waiting for approval.** Nothing in production, the database, the deployment, the extension, the strategy rules or git was changed. The only new code is offline research (`research/aviator_engine/stat6.py`). Outputs are in `research/out/stat6.json`, which is regenerated locally and not committed.

Labels used throughout:
- **[V] verified**: measured in this work, with a sample size.
- **[E] experimental**: measured, but on limited or third-party data.
- **[H] hypothesis**: not tested.
- **[R] recommendation**.

## Summary and verdict

**Verdict: there is not enough evidence to implement a *predictive* stat-6.** [V]
- On every plausible Aviator series, **no exact-multiplier model and no range-probability model beat the baselines** under the pre-registered rules. That covers 16 exact candidates and 21 range candidates, including gradient boosting, random forests, quantile regression, conditional distributions, Bayesian windows and model averaging, scored on 23,402–47,751 rounds per operator.
- The same framework **detected a planted 5-point dependence in 3 of 3 simulated histories, for both tasks**, and raised **no false alarm in 3 of 3** independent ones. The null result is therefore a measured absence of signal, not a blind test.

**What can honestly be built** [R]:
- an exact estimate that is the **baseline median** (≈ 1.92–1.95×, 80% interval ≈ 1.07×–9.8×), labelled baseline and not prediction;
- the existing baseline range bars;
- the descriptive statistics layer;
- a read-only export, so the analysis can be repeated on your own operator's rounds. That export is the only remaining data that could change this verdict.

Run facts:
- **When:** full run finished 2026-10-31.
- **What was run:** 16 parts — 6 series (up to 60,000 rounds each), 9 simulated controls (30,000 rounds each) and 40-repetition power curves. All parts exited 0, with no retries.
- **Settings:** 1,000-sample block bootstrap; tree models refit every 5,000 rounds on at most the previous 40,000.
- **Leakage checks:** `research/tests/test_stat6.py` passes 5 of 5. Every candidate's forecasts up to round t₀ stay identical when every round after t₀ is replaced. A round never feeds its own estimate. Quantiles match a naive recomputation.

## 1. Existing architecture audit (builds on [DYNAMIC_ENGINE_AUDIT.md](DYNAMIC_ENGINE_AUDIT.md))

| Step | Where | How it works today [V] |
|---|---|---|
| Collection | `extension/src/content/controller.ts`, `adapters/*` | Reads the visible results strip and diffs each read against the previous one. A new chain starts after a re-sync, an ambiguous change or a page reload. Every new chain re-sends the visible list as backfill (0.2.6+). |
| Upload | `extension/src/background/queue.ts` | FIFO, at most 50 rounds per batch. A retry keeps its `batchId`. Each batch carries `continuity {chain, index}`. After an upload is `sent`, the service worker broadcasts `dataMaybeUpdated`. |
| Normalisation and duplicates | `backend/src/ingestion/history.ts`, `backfill.ts` | The contract rejects multipliers with more than 2 decimals. A repeated `(device, batchId)` stores nothing (idempotent). A unique index on `(device, site, round_ref)`. Backfill stores only rounds after a unique value alignment of at least 4. |
| Gaps | `game_observations.break_before`, `chain_id`, `chain_index` (0005), chain links (0007) | A round is a verified successor only within the same chain and the next index (or via a chain link). Otherwise it is a break. Older clients fall back to a 120-second time rule. |
| Per-round processing | `ledger-service.ts` `syncLedgerLocked` (advisory lock per device and site) | 1. Load up to 5,000 rounds (12 h). 2. Score or void every open forecast once (immutable `forecast_outcomes`). 3. Rebuild all models from scratch (`issueForecast`). 4. Record exactly one forecast for the next round (unique per input boundary). |
| Baseline | `models.ts` `BaselineModel` | Dirichlet–categorical: (count_k + 10·ref_k)/(n + 10), with ref = the 0.97/m reference. |
| Experimental models | `models.ts` | EWMA (half-life 50), Markov 4×4, low-streak (6 buckets), logistic regression (5 features, refit every 50 rounds on the last 500), Bayesian online change-point. All shrink toward the baseline. Their average is weighted by out-of-sample likelihood. |
| Validation | `engine.ts` `decide` | A model is validated when it has at least 50 scored forecasts, beats the baseline's likelihood, and has an e-value against i.i.d. of at least 100. The state is baseline_only after 100 scored forecasts if the model average is not ahead. Otherwise it is experimental. |
| WATCH | `strategy.ts` (parity-tested against the Python reference) | 5 rounds in a row below 2.00× enter WATCH. The target range is 2.00–4.99×. WATCH is kept after misses and reset by a round of 2.00× or more, or by a break. TARGET and RANGE hits are scored separately. |
| Panel refresh | `extension/src/sidepanel/controller.ts` | Refreshes on `dataMaybeUpdated`, on tab events and on polling. One refresh at a time. The analysis endpoint allows 30 requests a minute. |
| Retention | worker every 5 minutes | `game_observations` and `ingest_batches` are kept 12 h; forecasts are purged with them. |
| API fields | `NextRoundSignalSchema` | state, reason, rounds, current/longest run, `current` (probabilities, baseline, strategy, atIssue), performance (scored, voided, rolling, thresholds with reliability bins), models (weights, e-values), history (30), rules, strategyPerformance. `strategy.multiplierEstimate` is fixed to `null`. |

## 2. Current engine limitations

1. **[V]** One device, one site, 12 h. That is about 1,500 rounds per device, and devices on the same site never share the rounds they all observe.
2. **[V]** The most likely of the four ranges is 1.00–1.99× in 100% of forecasts on any plausible data, because P(<2×) ≈ 51.5% while the next range is ≈ 29%. This is structural, not a defect (see DYNAMIC_ENGINE_AUDIT §1).
3. **[V]** No exact-estimate output exists. It is `null` by contract, which was a deliberate stat-5.4 decision.
4. **[V]** No short-window or long-window statistics are exposed. The live streak count does not flag censoring after a break.
5. **[V]** Every round triggers a full rebuild from scratch, with no incremental state cache (cost in §13).
6. **[V]** No way exists to export live rounds for offline research, so the offline engine has never seen your operator's data.

### Datasets in this research (never pooled)

| Series | What it is | Rounds evaluated (first, chronological) | Scored | Plausibility gate | Role here |
|---|---|---|---|---|---|
| P1:BETIKA | Aviator, third-party (PHIMAS, Kenyan operator, 2024) | 60,000 | 47,751 | pass | **genuine Aviator, primary** |
| P1:WINPESA | Aviator, third-party (PHIMAS) | 28,315 (all of it) | 23,402 | pass | **genuine Aviator, primary** |
| P1:BETGR8 | Aviator, third-party (PHIMAS) | 60,000 | 46,296 | **borderline fail**: P(≥10×) 10.3% gives an implied RTP of 1.03, 95% CI from 1.003. It passes over all 97,407 rounds | Aviator, reported; no candidate passed anyway |
| P1:ODIBETS | Aviator, third-party (PHIMAS) | 60,000 | 41,961 | **fail**: P(≥10×) 10.8%, implied RTP 1.08 (CI from 1.06); low rounds likely missing | reported, never promoted |
| B1 | **not Aviator**: bustabit-style hash-chain crash game | 60,000 | 58,000 | pass | different-game comparison |
| S1 | **synthetic** piecewise-uniform generator | 60,000 | 58,000 | fail (uniform shape) | null control only |
| SIMULATED | 0.97/m law; planted effects | 9 × 30,000 | — | — | controls only |

"Scored" excludes the 2,000 warm-up rounds and every round that starts a run after a collection break. Every candidate is scored on exactly the same rounds. C1 (HananAI) is excluded because it failed plausibility in every earlier run.

## 3. Exact multiplier research findings

**Loss and estimator choice** [V]:
- The panel needs one number per round. The error that matters is relative ("2.47× when it was 1.30×"), so the primary loss is the **absolute log error** |ln m − ln m̂|. The estimator that minimises it is the **conditional median**.
- The **mean** (expectation) is the wrong target for this heavy-tailed variable. Its estimate is 11–17× and its log error is 2.3–2.8 times larger.
- The **geometric mean** and squared-error models on ln m (GBM-L2, random forest) target the mean of ln m. That lands at ≈ 2.6×, which is also worse.

**Baseline**: the median of all past rounds; second baseline, the median of the last 1,500 rounds.

| Series | Scored | Estimate (median over scored rounds) | 80% interval | Coverage | Mean abs log error | Median abs error | MAE | Rounds within ±10% of the estimate |
|---|---|---|---|---|---|---|---|---|
| BETIKA | 47,751 | 1.92× | 1.07–9.82× | 80.3% | 0.6927 | 0.80 | 9.87 | 10.3% |
| WINPESA | 23,402 | 1.95× | 1.07–9.84× | 80.8% | 0.7177 | 0.83 | 9.85 | 10.1% |
| BETGR8 | 46,296 | 1.94× | 1.07–9.44× | 80.4% | 0.6936 | 0.81 | 9.95 | 10.1% |
| ODIBETS (failed gate) | 41,961 | 2.04× | 1.09–11.92× | 81.1% | 0.7151 | 0.90 | 14.21 | 9.4% |
| B1 (not Aviator) | 58,000 | 1.92× | 1.07–9.47× | 80.2% | 0.6944 | 0.79 | 14.92 | 10.3% |

**What these numbers mean** [V]:
- The best available estimate is ≈ 1.93×, almost the same every round.
- The typical miss is a factor of e^0.69 ≈ 2 (median absolute error ≈ 0.8×; mean absolute error ≈ 10× because of the tail).
- About **1 round in 10** lands within ±10% of the estimate.
- The 80% interval is honest: coverage is 80.2–81.1% on every series.

**Candidates** (Δ = mean abs log error minus the all-rounds median; negative = better; block-bootstrap 95% CI):

| Candidate | BETGR8 Δ | BETIKA Δ | WINPESA Δ | Verdict |
|---|---|---|---|---|
| median of last 20 rounds | +0.0228 [+0.0213, +0.0244] | +0.0233 [+0.0219, +0.0247] | +0.0256 [+0.0233, +0.0277] | worse; interval coverage 77% |
| last 50 | +0.0099 | +0.0096 | +0.0106 | worse |
| last 100 | +0.0050 | +0.0047 | +0.0057 | worse |
| last 200 | +0.0025 | +0.0023 | +0.0028 | worse |
| last 500 | +0.0008 [+0.0001, +0.0016] | +0.0011 [+0.0006, +0.0015] | +0.0017 [+0.0010, +0.0024] | worse |
| last 1,500 (baseline 2) | +0.0006 [+0.0001, +0.0011] | +0.0005 [+0.0002, +0.0007] | +0.0008 [+0.0004, +0.0012] | worse than all rounds |
| fixed 1.94× (0.97/m law) | −0.0000 [−0.0001, +0.0000] | −0.0000 [−0.0001, +0.0001] | +0.0002 [+0.0001, +0.0004] | equal |
| mean of past rounds | +0.92 | +0.93 | +0.70 | far worse (estimate ≈ 11×) |
| geometric mean | +0.042 | +0.042 | +0.027 | worse (estimate ≈ 2.6×) |
| median given previous range | +0.0001 [−0.0000, +0.0002] | +0.0002 [+0.0000, +0.0004] | **−0.0010 [−0.0016, −0.0003]** | see below |
| median given low streak | +0.0001 [+0.0000, +0.0003] | +0.0003 [+0.0001, +0.0005] | **−0.0011 [−0.0019, −0.0004]** | see below |
| GBM quantile (q10/q50/q90) | +0.0025 [+0.0017, +0.0034] | +0.0024 [+0.0017, +0.0030] | +0.0017 [+0.0002, +0.0032] | worse; coverage 78% |
| GBM on ln m (squared error) | +0.046 | +0.046 | +0.040 | worse (estimate ≈ 2.6×) |
| random forest on ln m | +0.043 | +0.044 | +0.037 | worse |
| linear quantile regression | +0.0036 [+0.0028, +0.0046] | +0.0033 [+0.0024, +0.0043] | +0.0007 [−0.0009, +0.0022] | worse or equal |

**The one near-miss** [E]:
- On WINPESA, the two conditional medians are better than both baselines (CI below 0), in 5 of 5 folds, with correct coverage. **Holm-adjusted p = 0.056**, which misses the pre-registered 0.05. They are therefore not validated.
- The effect is a 0.1% smaller log error. In practice the estimate moves by a few cents around 1.93×.
- It does **not replicate**: the same candidates are worse on BETIKA (+0.0002, +0.0003) and BETGR8 (+0.0001), with CIs at or above 0.
- On ODIBETS (failed gate) they are ahead (Holm p = 0.014) but in only 2–3 of 5 folds.

**Reading** [H]: either chance, or an operator-specific collection artefact. It is a pre-registered hypothesis to re-test on your own operator's export, not a finding.

**Answer to 7** [V]: **no measurable out-of-sample advantage** exists for exact-multiplier prediction over the historical median on any plausible Aviator series. The honest exact output is the baseline median with its 80% interval, labelled as a baseline.

## 4. Range prediction research findings

Baseline: cumulative empirical shares (add-½). Second baseline: the last 2,000 rounds. Loss: four-range log loss. Brier and calibration are reported alongside.

| Series | Scored | Baseline log loss | Brier | Top-range hit | Calibration Z (≥2×) | ECE |
|---|---|---|---|---|---|---|
| BETIKA | 47,751 | 1.14933 | 0.62933 | 51.7% | +1.51 | 0.0070 |
| WINPESA | 23,402 | 1.18684 | 0.64996 | 48.6% | +7.78 | 0.0240 |
| BETGR8 | 46,296 | 1.15269 | 0.63095 | 51.5% | +0.13 | 0.0088 |
| ODIBETS (failed gate) | 41,961 | 1.18037 | 0.64597 | 49.5% | +12.61 | 0.0272 |
| B1 (not Aviator) | 58,000 | 1.15247 | 0.63020 | 51.8% | +1.22 | 0.0057 |

Reliability of P(≥2×), BETIKA baseline (10 quantile bins of 4,775 rounds): forecasts sit at 47.6–48.6% and observed shares at 47.4–49.8%. The baseline forecast barely moves, and the outcomes scatter around it as independent rounds would. WINPESA's Z of +7.8 reflects a level shift inside that file, which a cumulative estimate follows slowly.

Candidates (Δ log loss vs the cumulative baseline; negative = better; 95% CI):

| Candidate | BETGR8 Δ | BETIKA Δ | WINPESA Δ | Calibration Z (BETIKA) |
|---|---|---|---|---|
| recent 2,000 (baseline 2) | +0.00093 [+0.00032, +0.00154] | +0.00136 [+0.00091, +0.00186] | +0.00105 [+0.00055, +0.00153] | +4.1 |
| fixed 0.97/m reference | −0.00027 [−0.00047, −0.00008] | −0.00005 [−0.00027, +0.00015] | +0.00031 [+0.00011, +0.00051] | −0.9 |
| Markov (previous range) | +0.00013 [−0.00011, +0.00036] | +0.00034 [+0.00010, +0.00061] | −0.00058 [−0.00138, +0.00024] | +2.9 |
| low streak | +0.00062 | +0.00074 | +0.00126 | +4.2 |
| window 20 / 50 / 100 | +0.067 / +0.030 / +0.015 | +0.066 / +0.030 / +0.015 | +0.069 / +0.031 / +0.016 | +48 / +30 / +20 |
| window 200 / 500 / 1,500 | +0.0073 / +0.0031 / +0.0013 | +0.0079 / +0.0038 / +0.0017 | +0.0080 / +0.0041 / +0.0014 | +13 / +8 / +4 |
| Bayesian window 20 / 50 / 100 | +0.018 / +0.0072 / +0.0033 | +0.019 / +0.0074 / +0.0037 | +0.021 / +0.0086 / +0.0046 | +24 / +14 / +9 |
| Bayesian window 200 / 500 / 1,500 | +0.0015 / +0.0006 / +0.0003 | +0.0020 / +0.0010 / +0.0005 | +0.0023 / +0.0014 / +0.0005 | +5.5 / +3.4 / +2.2 |
| logistic regression | +0.0045 | +0.0071 | +0.0049 | +15 |
| gradient boosting | +0.0117 | +0.0125 | +0.0195 | +22 |
| random forest | +0.00055 [−0.00077, +0.00177] | +0.00125 [+0.00076, +0.00173] | −0.00111 [−0.00240, +0.00014] | +6.7 |
| model average (all of the above, BMA) | +0.00056 [−0.00075, +0.00184] | +0.00127 [+0.00080, +0.00178] | −0.00106 [−0.00227, +0.00018] | +6.8 |

**Answer to 8** [V]: **there is no measurable out-of-sample advantage** for range prediction on any plausible Aviator series.

What the table shows:
- **Short windows:** the shorter the window, the worse and the more over-confident the forecast. A 20-round window has calibration Z ≈ +48.
- **Most likely range:** under every candidate the top range is 1.00–1.99× in 98–100% of forecasts, so no candidate improves the top-range hit rate.
- **Tree models:** they are the worst calibrated.
- **ODIBETS:** Markov passes the statistics there (Δ −0.0018, Holm 0.018, 4 of 5 folds), as it did in every earlier run. It is rejected by the plausibility gate, and all ODIBETS dependence tests are null, so the gain follows level drift and missing rounds rather than round-to-round memory.

## 5. Candidate comparison and controls

**SIMULATED controls** (30,000 rounds each, pre-registered rules, Holm over all candidates of each task):

| Control | Exact candidates passing | Range candidates passing | What it shows |
|---|---|---|---|
| independent rounds, 3 histories | none (0 of 3) | none (0 of 3) | no false acceptance |
| planted ±5 pp previous-round effect, 3 histories | conditional median (previous range) and conditional median (low streak) in 3 of 3; linear quantile in 2 of 3 | Markov, streak, random forest and model average in 3 of 3 | the framework detects real dependence **for both tasks** |
| regime switch, RTP 0.90 ↔ 1.00 every 3,000 rounds, 3 histories | none | none | a regime is **already tracked by the recent-window baseline**, so no candidate adds anything beyond it. This tests "adds beyond drift tracking", not "can see a regime" |

Earlier runs, which these results reproduce and do not replace:
- the full-series evaluation in [ANALYSIS_ENGINE_RESULTS.md](ANALYSIS_ENGINE_RESULTS.md);
- the TypeScript live-engine models (EWMA, Bayesian change-point, logistic regression) in [EVALUATION_RESULTS.md](EVALUATION_RESULTS.md). The change-point and EWMA models lost to the baseline on every operator.

## 6. Backtesting method (verified)

- **Validation design:**
  - chronological walk-forward on an expanding window;
  - batch models refit every 5,000 rounds, only on rounds before the block;
  - online estimators use only earlier rounds (shifted windows; grouped estimators use only earlier rounds of the same group).
- **Leakage controls:**
  - run-break-aware features;
  - duplicates removed in the loaders before any split;
  - **no target-derived features** (the B2 dataset, whose `color` column equals the label 99.7% of the time, is excluded).
- **Statistics and acceptance:**
  - block bootstrap (blocks of 100) for confidence intervals;
  - Holm correction across candidates within each task and series;
  - 5 chronological folds for stability across time periods;
  - acceptance rules fixed in the `stat6.py` docstring before the full run.
- **Operators:** each operator is evaluated separately. A model counts as validated for an operator only on that operator's own data. A result on one operator is never transferred to another.

## 7. Data sufficiency

**Per-round loss-difference variability** (candidate minus baseline, plausible series):
- range (Markov vs empirical): SD 0.027–0.057 log-loss units; median of the plausible series 0.042;
- exact (conditional vs all-rounds median): SD 0.019–0.051; median 0.035.

Rounds needed to detect a true mean improvement Δ (one-sided α = 0.05, power 80%, independent rounds):

| Task | Δ = 0.0005 | 0.001 | 0.002 | 0.005 |
|---|---|---|---|---|
| range (log loss) | 43,764 | 10,941 | 2,736 | 438 |
| exact (abs log error) | ≈ 30,700 | ≈ 7,700 | 1,918 | 307 |

**SIMULATED power curve** (40 histories per cell; planted previous-round effect; test = Markov vs empirical, 95% CI < 0):

| Effect on P(≥2×) | 1,500 rounds | 5,000 | 20,000 | 60,000 |
|---|---|---|---|---|
| ±1 pp | 0 of 40 | 0 of 40 | 0 of 40 | 0 of 40 |
| ±2 pp | 0 of 40 | 0 of 40 | 0 of 40 | 27 of 40 |
| ±5 pp | 0 of 40 | 13 of 40 | 40 of 40 | 40 of 40 |

**Implications:**
- **[V] One device's 12 h window (≈ 1,500 rounds) cannot detect even a 5-point effect** (0 of 40). Any "pattern" seen in one device's live history is indistinguishable from noise.
- **[V] The best observed improvements** are WINPESA's near-misses (Δ ≈ 0.001), and those did not replicate. To test such an effect on your operator would take ≈ 8,000–11,000 scored rounds; to test a 2-pp dependence, about 60,000 rounds.
- **[R] That volume needs option B** (multipliers-only, site-level, 7–30 days; migration 0008) or repeated exports (option C). Pooling devices on one site (option A) adds completeness, not length: devices watching the same game see the same rounds.

## 8. Proposed stat-6 architecture

```
ingest/backfill ─► syncLedgerLocked (existing lock + transaction, unchanged order)
   1 store round(s)                          (existing)
   2 resolve open forecast: range scores     (existing) + exact errors (NEW, same outcome row)
   3 update state incrementally              (NEW cache keyed by device/site/last round id; full rebuild on miss/restart)
   4 candidates:
        A Exact estimator      baseline = predictive median of the baseline distribution + 80% interval
                               candidates = conditional medians (offline-accepted only)
        B Range estimator      baseline Dirichlet (existing) + existing candidates (unchanged)
   5 validation layer          per TASK and per model: unavailable | under_evaluation | validated | rejected
                               (range: existing e-value rule; exact: e-process on clipped loss differences, §12)
   6 select                    validated model per task, else the baseline (both tasks independently)
   7 C Intelligence layer      windows 20/50/100/200/500/1500, long-run, conditional tables, streak (exact/censored),
                               drift (CUSUM + block test, calibrated on SIMULATED nulls), data quality — DESCRIPTIVE only
   8 store ONE forecast        existing row + `exact` jsonb (migration 0009)
   9 respond                   NextRoundSignal + optional `dual` block
extension: existing `dataMaybeUpdated` → refresh (unchanged)
offline (never in production): read-only CSV export → research/ (Python) → candidate acceptance report
```

Design rules:
- The two tasks are validated **separately**. A model can be validated for ranges and rejected for the exact estimate, or the reverse.
- GBM, random forest and quantile-regression models stay **offline**. A model enters the live candidate set only after it passes the pre-registered offline rule on real data from your operator. It then has to earn live validation as well.
- The WATCH state machine and the baseline bars (0.2.8) are unchanged.

## 9. Database changes (proposals; nothing has been run)

| Migration | Purpose | Data impact | Retention | Rollback |
|---|---|---|---|---|
| **0008_site_round_stream** (optional, needs your decision) | A site-level stream of multipliers only, de-duplicated across devices by chain alignment, for more data per site | New table `site_rounds(site_id, seq, multiplier, observed_minute, devices_seen smallint)`. **No device id, no account, no IP.** About 2,500 rows per site per day (≈ 5 MB per site at 30 days) | 7 days (recommended) or 30 days, enforced by the existing worker; DATA_RETENTION.md updated | `DROP TABLE site_rounds;`. Existing tables are untouched, and stat-5.4 code ignores the table |
| **0009_forecast_exact** | Store the exact estimate issued with each forecast, and its error once scored | `round_forecasts.exact jsonb NULL` (estimate, interval, model, status) and `forecast_outcomes.exact_error jsonb NULL`. Additive and nullable. The tables' existing UPDATE-reject triggers are unaffected because the values are written at insert time | Same as forecasts (12 h) | `ALTER TABLE … DROP COLUMN …`. stat-5.4 code never reads these columns |

Both migrations need a database backup before they run, and a staging run of the existing `schema-drift.test.ts` plus the full backend suite.

## 10. API response schema proposal (additive and optional, so 0.2.7 and 0.2.8 clients ignore it)

```ts
NextRoundSignal.dual?: {
  exact: {
    status: 'unavailable' | 'baseline' | 'under_evaluation' | 'validated' | 'rejected';
    model: string;                         // 'baseline_median' unless a model is validated
    estimate: number | null;               // e.g. 1.94 (two decimals)
    interval80: [number, number] | null;   // e.g. [1.07, 9.45]
    basis: string;                         // "median of the baseline distribution over N rounds"
    liveErrors: { scored: number; medianAbsLogError: number | null; coverage80: number | null };
    reason: string;
  };
  range: { status: 'baseline' | 'under_evaluation' | 'validated' | 'rejected'; model: string; probabilities: number[4] }; // = existing current.*
  intelligence: {
    windows: Array<{ rounds: 20|50|100|200|500|1500|'all'; n: number; shares: number[4]; ci: [number, number][]; unusual: boolean }>;
    streak: { below2: number; exact: boolean; percentile: number | null };
    conditional: { afterLows: Array<{ k: string; n: number; rateGe2: number | null; ci: [number, number] | null }>; independenceP: number | null };
    drift: { status: 'stable' | 'possible_change' | 'insufficient_data'; p: number | null; changeProbability: number | null };
    dataQuality: { currentRun: number; longestRun: number; breaks12h: number; plausibility: 'pass' | 'fail' | 'insufficient' };
  };
  validation: Array<{ task: 'exact' | 'range'; model: string; status: string; scored: number; log10EValue: number | null }>;
}
```

The bars keep using `barProbabilities()` from 0.2.8. `dual.range.probabilities` is the same vector, exposed for clarity.

## 11. Extension UI proposal (for later approval; no change now)

The current layout, the WATCH headline, the target range and the streak counter are kept as they are. Additions, top to bottom:

1. **Exact estimate block** (replaces "Multiplier estimate unavailable" only when `dual.exact` is present):
   - "Baseline estimate **1.94×** · 80% of rounds 1.07×–9.45× · not a prediction (no validated model)";
   - a muted line underneath: "about 1 in 10 rounds lands within ±10% of this value" (the live-measured figure);
   - in WATCH, the block sits below the ACTIVE TARGET RANGE heading and never replaces it.
2. **Range bars**: unchanged (baseline unless validated, with the 0.2.8 caption).
3. **Statistical intelligence** (in Details):
   - last 50 / 200 / 1,500 rounds against the long run (shares with intervals and an "unusual" flag);
   - current streak, with "exact" or "count may be incomplete";
   - P(≥2× after k lows) with sample sizes;
   - drift status and data quality.
4. **Forecast history**: adds exact estimate → actual, the log error, and whether the actual fell inside the interval, beside the existing TARGET and RANGE results.

Wording rules: never "will", "due" or "likely to win". WATCH keeps "may not occur".

## 12. Testing strategy

1. **Pre-registered acceptance rules** (in `stat6.py`'s docstring, fixed before results). Exact: absolute log error against two median baselines, 95% CI < 0, Holm p < 0.05, at least 4 of 5 folds, 80% interval covering 80% ± 3 pp, plausibility gate. Range: the same structure on log loss.
2. **Null histories (SIMULATED, labelled)**: no candidate may pass, for either task.
3. **Planted effects (SIMULATED)**: a previous-round dependence and a regime switch must be detected (§5).
4. **Live validation**:
   - range keeps the existing e-value rule (K/α = 100);
   - exact uses a mixture e-process on clipped loss differences, which is anytime-valid, so checking after every round does not inflate errors.
   - Thresholds are tested on simulated nulls: false validation at most 5%.
5. **Parity**: TypeScript and Python fixtures for the baseline median and intervals (whole-cent quantiles, "lower" interpolation), window shares, the hazard table and the drift test (like `watch_parity.json`).
6. **Leakage**: perturb-the-future tests for every new output. The incremental cache must equal a full rebuild after every round, over 10,000 simulated rounds with breaks.
7. **Compatibility**: stat-5.4 fixtures still validate, 0.2.7 and 0.2.8 parse stat-6 responses, the WATCH parity fixture still passes, the 0.2.8 bar tests still pass, and the migrations pass schema-drift.
8. **Performance**: added time per round must stay under 10 ms at 5,000 rounds (p95), on top of the cached path.

## 13. Performance and VPS resources

- **[V] Today's live rebuild** (`issueForecast`, stat-5.4, Node on an i5-6500, measured while other work was using the CPU, so an upper bound): **62 ms at 1,500 rounds and 205 ms at 5,000**, per round, per device and site. Heap is about 40 MB.
- **[R] Incremental cache.** Keep the model set in memory per (device, site), keyed by the last round id. Each new round then costs O(1) model updates; the logistic refit every 50 rounds stays. Expected [H]: under 5 ms per round. Restart or eviction falls back to the full rebuild, so the result is identical.
- **[R] New live work** (median and interval from a histogram over whole cents, 6 windows, 4×4 table, CUSUM): O(window) or O(1) per round, roughly 1 ms [H].
- **[V] Offline only**: GBM, random forest and quantile regression took seconds per refit in this research. They never run on the VPS.

## 14. Security implications

- **The CSV export** reveals round history. It should be admin-only, read-only, rate-limited and audited in `security_events`. Rows are multipliers and minute times only: no device, code or IP.
- **Site stream (0008)**: no device identifiers. Minute-level times avoid fingerprinting individual sessions. Retention is enforced by the existing worker.
- **No new secrets.** No new dependencies on the VPS (Python is never deployed). The extension keeps `host_permissions` to the API only.
- **Abuse**: a single device cannot pollute the site stream on its own. Rows enter only when they are value-aligned with stored rounds or confirmed by two or more devices [R].

## 15. Rollback plan

| Change | Rollback |
|---|---|
| stat-6 backend | Redeploy the stat-5.4 image (the previous tag is kept). `dual` disappears and clients fall back to current behaviour |
| 0009 | Columns are nullable and unused by stat-5.4, so they can stay. If needed: `ALTER TABLE round_forecasts DROP COLUMN exact; ALTER TABLE forecast_outcomes DROP COLUMN exact_error;` |
| 0008 | `DROP TABLE site_rounds;` and revert DATA_RETENTION.md |
| Extension 0.2.9 | Reinstall the 0.2.8 ZIP (SHA-256 `00fa65e3…fd8e`) |
| Always | Back up the database before each migration (`pg_dump`). Restore drill on a local copy before production |

## 16. Phased implementation roadmap (each gate needs your approval)

| Phase | Work | Output | Gate |
|---|---|---|---|
| 0 | This report | decision on the exact-estimate display, data options and migrations | **approve plan** |
| 1 | Read-only admin CSV export (no migration) | backend route + tests | approve deploy |
| 2 | Run `research/` on **your operator's** export | real-operator acceptance report (the only data that can change §3–6) | review |
| 3 | stat-6 backend, local, **non-predictive parts only** unless phase 2 finds a validated candidate: incremental cache, exact **baseline** estimator with interval, intelligence layer, validation layer per task (so a future candidate can be promoted by the rule), `dual` schema, 0009 (and 0008 if chosen); Python parity fixtures | tests and performance numbers | **approve deploy** (backup → migrate → deploy → LIVE_DIAGNOSTICS) |
| 4 | Extension 0.2.9 panel (§11) | ZIP + release notes + screenshots | **approve install** |
| 5 | Live monitoring: exact errors, interval coverage and e-values per task | weekly report; a model is promoted only by the rule | — |
