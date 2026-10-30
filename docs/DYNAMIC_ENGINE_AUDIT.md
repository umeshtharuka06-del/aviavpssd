# Dynamic statistical engine — audit and proposal (2026-10-30)

Status: **audit only, awaiting approval.** No code, production, migration, deployment or extension change was made for this document. The one new measurement script lives in my scratchpad, outside the repository.

Sources read: `backend/src/engine/sequential/{engine,models,strategy,ledger-service}.ts`, `backend/src/ingestion/{history,backfill}.ts`, `shared/contracts/src/{signal,limits}.ts`, `extension/src/sidepanel/{controller,dashboard}.ts`, `research/aviator_engine/*`, and the earlier reports (EVALUATION_RESULTS, DATA_QUALITY, ANALYSIS_ENGINE_RESULTS).

## 1. Root cause of the static-looking estimates

I replayed the **live engine itself** (`replay()` from `engine.ts`, stat-5.4) over 1,500 consecutive rounds. That is about what one device collects in its 12-hour window.

| Series | Forecasts whose most-likely range is 1.00–1.99× | Engine state | Per-round change of the bars (median / p95 / max) | P(1.00–1.99×) over the second half |
|---|---|---|---|---|
| BETIKA (real, third-party) | **100%** | baseline_only 90%, experimental 10% | 0.09 / 0.85 / 8.6 pp | 48.1–59.0% |
| BETGR8 (real, third-party) | **100%** | baseline_only 92% | 0.08 / 0.81 / 4.5 pp | 49.3–53.9% |
| SIMULATED independent rounds | **100%** | baseline_only 85% | 0.09 / 0.86 / 5.0 pp | 47.4–53.4% |

The analysis **is** recalculated after every round. Each stored round triggers `syncLedgerSafely`, which:
- rebuilds every model from up to 5,000 rounds;
- scores the open forecast;
- issues exactly one new forecast.

The panel then refreshes on the new-round notice. The numbers barely move for three reasons, and none of them is a bug.

1. **The question "most likely range" has the same answer for any real crash game.** The four ranges have very unequal probability mass. With a 97% RTP, P(< 2×) = 1 − 0.97/2 = 51.5%, while the next range, 2.00–4.99×, is 29.1%. For 2.00–4.99× to become the top range, P(< 2×) would have to fall below about 40%. That means an RTP near 1.2, which no house-edge game has. The observed P(< 2×) is 49–52% on every plausible operator. So the top range is 1.00–1.99× in 100% of forecasts, on real data and on simulated independent rounds alike.
2. **The engine correctly falls back to the baseline, and a baseline over n rounds moves by about 1/n per round.** After 100 scored forecasts, `decide()` switches to `baseline_only` because the model average did not beat the baseline. That is 85–92% of the time. With about 1,500 rounds, one new round moves each share by at most 1/1,500 ≈ 0.07 pp: the measured median per-round change is 0.08 pp.
3. **The only parts that moved were noise.** In the experimental state, the model average moved up to 12 pp in a single round. In WATCH, the conditional mix moved the bars up to 8.6 pp. None of that movement was validated, which is why 0.2.8 draws the baseline in the bars.

**Conclusion:** any honest forecast of an independent game is nearly constant. "Dynamic" therefore cannot mean that the forecast moves. It has to mean showing the quantities that legitimately change every round: short-window frequencies and how unusual they are, the current streak and its rarity, drift alarms, and the evidence status. Each one needs its uncertainty and a null-model test, and each must be clearly labelled as descriptive, not predictive.

## 2. Component audit

Legend: ✅ exists and sound · 🟡 exists but incomplete or not exposed · ❌ missing.

| # | Area | Live engine (TypeScript, per device and site) | Offline engine (`research/`, Python) | Status / gap |
|---|---|---|---|---|
| 1 | Historical data use and quality | Only one device's own rounds, 12 h retention, at most 5,000 rounds. Continuity chain and breaks are handled. Two-decimal validation and idempotent batches are in place. | Full quality audit, provenance, deduplication, plausibility gate. | 🟡 **Data volume is the binding limit.** About 1,500 rounds per device. Devices on the same site record the same game stream separately and are never pooled. There is no export route, so live rounds can't reach the offline engine. No 1xBet data has been available for any analysis. |
| 2 | Rolling-window analysis | EWMA model (half-life 50) inside the ensemble. `performance.rolling` covers 50 forecast *scores* only. The historical summary covers the full 12 h only. | Rolling 200-round frequencies against a binomial band. | ❌ No short- vs long-window **distribution** in the API or panel. |
| 3 | Short- vs long-term distributions | Baseline (all rounds) vs EWMA, inside the ensemble only. | Per-series totals only. | ❌ Not compared, not tested, not shown. |
| 4 | Conditional probabilities and transition matrix | Markov 4×4 model inside the ensemble. Strategy conditional mix in WATCH. | 4×4 χ² test, P(≥2× \| previous range). | 🟡 Computed but not exposed. No intervals, no independence test in the live path. |
| 5 | Streaks and clustering | Strategy `consecutiveLow` (parity-tested). Streak model (6 buckets). | Hazard table P(≥2× \| k lows) on uncensored counts, streak-length table, runs test. | 🟡 Live has no hazard table, no streak percentile and no clustering test. **Live streak counts restart at breaks without marking the count as censored.** That is the bias the Python engine had to fix. |
| 6 | Drift and regime detection | Bayesian online change-point model. `changeProbability` (last 30 rounds) is in the API. | Block homogeneity χ², CUSUM binary segmentation with BH. | 🟡 `changeProbability` is not calibrated against a null and is not shown as an alarm. There is no frequentist drift test in the live path. |
| 7 | Pattern discovery with null testing | E-values against i.i.d. for 5 fixed candidates; threshold K/α = 100 (anytime-valid). | BH over 5 dependence tests; Holm over candidates; SIMULATED controls (false alarms 0/6, power 6/6). | 🟡 Sound for the fixed set. No pre-registered registry exists for adding patterns, so adding patterns ad hoc would inflate false discoveries. |
| 8 | Features and leakage | Features use rounds < t inside the run; `observe`/`predict` ordering is enforced; tested. | Perturb-the-future test, run-break masks, de-duplication before any split. | ✅ |
| 9 | Walk-forward backtest vs historical baseline | The live ledger is itself a walk-forward (immutable forecasts, scored once). `replay()` reproduces it. | Expanding-window walk-forward with periodic refit, two empirical baselines plus a fixed reference, block bootstrap. | ✅ No model validated on plausible data. |
| 10 | Calibration, Brier, log loss, significance | Per-threshold Brier and log loss, Spiegelhalter Z, reliability bins, log-loss-difference CI, e-values. | The same, plus ECE, Holm and chronological fold consistency. | ✅ |
| 11 | Recalculated after every round | **Yes.** Each ingest or backfill triggers `syncLedger`, a full rebuild and one new forecast. The panel refreshes on the new-round notice. | Batch or manual. | ✅ Live. The offline engine is not connected to live data (see 1). |
| 12 | Why the most-likely range never changes | — | — | Structural (section 1), not a defect. |

Other findings:
- **Statistical power at the live data volume** (about 1,500 rounds):
  - The SE of P(≥2×) is about 1.3 pp, so the smallest reliably detectable change is about 3.6 pp.
  - WATCH covers about 3.5% of rounds, about 52 per window. The SE there is about 7 pp, so only a 20 pp or larger WATCH effect could be detected.
  - No such effect exists in any plausible dataset tested: WATCH 49–50% vs tracking 49–51%.
- Each round costs one full rebuild (5,000 rounds × 6 models, with a logistic refit every 50). This is acceptable now. A dynamic layer must stay incremental or bounded.

## 3. Proposed architecture: "stat-6 dynamic analysis layer"

Principles:
- Descriptive statistics are recomputed every round.
- Forecasts change only through the existing validated-model path.
- Every number carries n, a 95% interval and a null-model verdict.
- Nothing synthetic reaches live output.
- The WATCH state machine and the baseline fallback are unchanged.

```
ingest / backfill ──► syncLedgerLocked (existing; same transaction and advisory lock)
                         ├─ forecast ledger (existing, unchanged)
                         └─ NEW computeDynamicAnalysis(rounds, breaks) ──► NextRoundSignal.analysis (optional field)
                                ├─ windows      last 20 / 50 / 200 / all retained: 4-range shares + Wilson CI,
                                │               z vs long-run, BH across windows → "within normal variation" | "unusual"
                                ├─ streak       current low count (exact | censored), percentile under geometric(p̂),
                                │               hazard table P(≥2× | k) on exact counts, homogeneity p
                                ├─ transitions  4×4 counts, P(next range | previous range) + CI, χ² independence p
                                ├─ drift        CUSUM on ≥2× + block homogeneity (BH); BOCPD changeProbability
                                │               calibrated against SIMULATED null quantiles → alarm only when significant
                                └─ evidence     existing validation state + pre-registered pattern registry (e-values)
offline (never in production):
  admin CSV export (NEW, read-only) ──► research/aviator_engine analyze-csv ──► verdict JSON
  Python remains the reference: parity fixtures pin every live formula (as watch_parity.json does now)
```

**Data utilisation** (each option needs your decision, because it touches retention and privacy):
- **A.** Site-level pooled stream. Several devices on one site record the same game rounds. Align them by value (the existing backfill alignment) and de-duplicate to get a longer, more complete history. No retention change.
- **B.** A multipliers-only aggregate table with longer retention (for example 7–30 days), keyed by site and with no device id. Needs a migration and an update to DATA_RETENTION.md. This is the only option that raises statistical power materially.
- **C.** A read-only admin CSV export, so live data can be run through the offline engine.

**The most-likely-range question:** keep the four ranges and labels exactly as they are. Do not re-bin to make the argmax move. That would manufacture variation. The movement worth showing is the deviation of the short window from the long run, with its interval and test, together with P(≥ target).

## 4. Required code changes (when approved)

| Phase | Files | Change |
|---|---|---|
| 1 | `backend/src/engine/dynamic/{windows,streak,transitions,drift}.ts` (new) | Pure functions over (multipliers, breaks); bounded O(n) per round |
| 1 | `backend/src/engine/sequential/strategy.ts` | **No rule change.** Optional: add a `consecutiveLowExact` flag to the analysis output; the strategy itself stays the same |
| 1 | `research/aviator_engine/` | Python reference for every new statistic, plus `fixtures/dynamic_parity.json` |
| 2 | `shared/contracts/src/signal.ts` | Optional `analysis: DynamicAnalysisSchema` on `NextRoundSignal`. Older extensions are unaffected because zod strips unknown keys (verified by a back-compat test) |
| 2 | `backend/src/engine/sequential/ledger-service.ts` | Call `computeDynamicAnalysis` inside `syncLedgerLocked`; no new table |
| 3 | `backend/src/api/routes/admin.ts` | Read-only CSV export (option C), admin-only and rate-limited |
| 4 (optional) | migration `0008_site_round_stream.sql` + retention worker | Options A or B, only after your decision on retention |
| 5 | `extension/src/sidepanel/dashboard.ts` | New "Live statistics" section in Details. Existing bars, WATCH heading and layout unchanged. Separate approval and release |

## 5. Testing and validation plan

1. **Exact values:** each statistic is tested against hand-computed fixtures (Wilson bounds, hazard counts with censoring, transition counts and χ²), and the same fixtures run in TypeScript and Python.
2. **Null model (SIMULATED, labelled):** 1,000 independent 1,500-round histories. The share flagged "unusual" by each family must be at most 5% (BH controlled), and the drift alarm's false-alarm rate must be at most 5%. The synthetic piecewise-uniform file is used only as a further null control.
3. **Power (SIMULATED):** planted level shifts (±3, ±5, ±10 pp) and dependence (±5 pp). Report detection rate against effect size, so the panel can state what it is able to detect.
4. **Per-round recalculation:** ingest round t+1, assert the analysis changes exactly as `replay()` predicts, and assert live equals replay.
5. **Leakage and immutability:** changing future rounds never alters earlier snapshots or forecasts. The ledger stays immutable.
6. **Compatibility:**
   - stat-5.4 responses still validate;
   - 0.2.7 and 0.2.8 clients parse stat-6 responses;
   - the WATCH parity fixture still passes;
   - the baseline-bar tests still pass.
7. **Performance:** `syncLedgerLocked` with 5,000 rounds stays under a fixed budget (proposed: p95 < 50 ms added).
8. **Real-data rerun:** run the Python engine on the PHIMAS operators and, once an export exists, on your own rounds. Report false-alarm rates as observed.

## 6. Implementation sequence (with approval gates)

1. **Gate 0 — approve this plan**, and choose the data options (A, B or C, or none).
2. Python reference and parity fixtures for windows, streak hazard, transitions and drift. Null and power simulations run offline. *Deliverable: report and tests. No live change.*
3. TypeScript `dynamic/` module, wired into `syncLedgerLocked` behind an optional contract field. Backend tests, back-compat and performance. *Local only.*
4. **Gate 1 — review the simulated false-alarm and power results**, plus the stat-6 diff.
5. Admin CSV export (if C). Migration 0008 (if A or B), with a database backup plan.
6. **Gate 2 — deployment approval:**
   - back up the database;
   - run migrations 0006, 0007 (and 0008 if chosen);
   - deploy stat-5.4 or stat-6;
   - verify with LIVE_DIAGNOSTICS.
7. Extension "Live statistics" section: built, tested and packaged as 0.2.9. **Gate 3 — install approval.**

What this will not do: produce a forecast that moves without validation, predict exact multipliers, or treat a long low streak as making a high round due. If a candidate ever passes the existing e-value rule on live data, the existing `validated` path already shows it, and 0.2.8 already draws its bars.
