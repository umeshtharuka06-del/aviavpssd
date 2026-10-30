# Evaluation results — dependence tests and forecaster comparison

Generated 2026-10-28 with `npm run evaluate:signal -w @aviator/backend` (code: `backend/src/engine/sequential/evaluate.ts`, tests: `backend/tests/evaluate.test.ts`). Read-only: nothing touches a database.

**No actual 1xBet data was available.** The real-data rows below are third-party Aviator rounds from other operators (PHIMAS, provenance undocumented) and a non-Aviator crash game (MindingTheData). Controls are SIMULATED. See [DATA_QUALITY.md](DATA_QUALITY.md).

## What was compared (walk-forward, no look-ahead)

Every forecaster is scored on exactly the same rounds, the ones the live process scored. Each forecast uses only rounds before its round. `backend/tests/evaluate.test.ts` checks this by changing the last round and confirming that no earlier row changes.

| Forecaster | Role |
|---|---|
| Bayesian baseline (live engine) | reference for every comparison |
| Empirical range frequency (add-½, no prior) | baseline 1 requested: plain counts |
| Fixed RTP reference 0.97 ÷ m | what a 97%-RTP crash distribution implies; never updated |
| Most-frequent range so far | all-or-nothing baseline; log loss is infinite (it gives 0% to three ranges), so only hit rate and Brier apply |
| EWMA, change-point, regression | existing candidates, individually |
| Previous-round transition, rounds since last 2× | previous-round and streak **controls** |
| Model average | the experimental estimate |
| Shown forecast | what the panel displayed at the time (model average, baseline or validated model) |

Scores: top-range hit rate; multiclass Brier; log loss; Spiegelhalter calibration Z for P(≥ 2×); mean log-loss difference to the baseline with a 95% interval; Holm-corrected one-sided p over the 8 tested forecasters; rolling 1,000-round windows (best and worst difference, share of windows ahead).

Dependence tests use only pairs inside verified consecutive runs: Box–Pierce Q over lags 1–10 of "≥ 2×" and of the multiplier rank; the runs test; previous range → next range (χ², 4 × 4); losing streak → next ≥ 2× (χ², 6 × 2); distribution change across 10 chronological blocks (χ², 10 × 4); and fit to the RTP reference. Benjamini–Hochberg is applied over the six dependence tests.

## Summary

| Series (rounds) | Any serial dependence after BH? | Distribution change over time? | Any learning forecaster better than the baseline (Holm 5%)? | Ever validated (live rule) |
|---|---|---|---|---|
| BETGR8 (97,407) | **No** (smallest BH p 0.40) | yes: P(≥2×) by block 47.2–50.2% | No. Only the fixed RTP reference (−0.00035, Holm p 0.043) | no |
| BETIKA (107,449) | **No** (0.71) | yes: 45.4–49.0% | No | no |
| ODIBETS (66,823) | **No** (0.90) | yes: 47.5–57.0% | the previous-round, streak and average models are ahead (−0.0041 to −0.0044, Holm p ≤ 2e-6), **but so is the fixed RTP reference (−0.0059, p 9e-8)**, with no dependence detected | no |
| WINPESA (28,315) | **No** (0.31) | no | No | no |
| MindingTheData, not Aviator (732,367) | **No** (0.68) | no | No | no |
| SIMULATED independent rounds, 60 × 5,000 | false alarms 1.7% (any test after BH) | — | 0% (learning forecasters) | — |
| SIMULATED planted ±0.05 previous-round effect, 20 × 5,000 | detected 100% | — | 25% | — |

**Reading it:**

1. **No temporal dependence** was found in any real series once catch-up bursts are treated as unverified. Before that correction, three operators showed "highly significant" dependence (p down to 10⁻¹⁴). It was entirely a collection artifact ([DATA_QUALITY.md](DATA_QUALITY.md) §5).
2. **Distribution change is real in three of the four operator files.** The share of 2×+ rounds moved by up to about 10 percentage points between periods. That can come from operator configuration or from how the file was collected; the data cannot tell which.
3. **That change is the only thing any model "exploited".** On ODIBETS the previous-round and streak models, and therefore the model average, beat the running baseline. A fixed 0.97 ÷ m forecast beat it by more, and the dependence tests are null. So the gain is "the cumulative baseline lagged a level shift", not "the previous round predicts the next". The live e-value test, which compares against the best constant distribution in hindsight, correctly never validated it.
4. **No forecaster improved the top-range hit rate** on any series: every learning model picks 1.00–1.99× as the most likely range, the same as the baseline.
5. **Detection ≠ exploitable edge.** Under a planted ±0.05 effect (10 percentage points of swing in P(≥2×)) the dependence tests detect it in 100% of 5,000-round histories, but only 25% of the learning forecasters beat the baseline after multiple-testing correction. Real effects much smaller than that would be invisible in 12 h of rounds.
6. **Short windows mislead.** On independent rounds, in 93% of histories some forecaster leads the baseline by more than 0.003 log loss in its best 1,000-round window. A model "looking good lately" is not evidence.
7. Empirical frequencies vs the Bayesian baseline: identical to 4–5 decimals on every series. The 10-pseudo-round RTP prior makes no practical difference after a few hundred rounds.

Decision: **keep the honest baseline.** No validated signal exists on any data I could test. No new model is added, because the evidence says there is nothing for it to learn. See [ENGINE_AUDIT.md](ENGINE_AUDIT.md) for the evidence-based changes that were made instead.

## Reproduce

```bash
curl -L -o aviator_payouts.csv https://raw.githubusercontent.com/PHIMAS/aviator/main/aviator_payouts.csv
curl -L -o multipliers.csv https://raw.githubusercontent.com/MindingTheData/Crash-Analysis/master/multipliers.csv
npm run evaluate:signal -w @aviator/backend -- aviator_payouts.csv --compare 30000
npm run evaluate:signal -w @aviator/backend -- multipliers.csv --reverse --compare 30000 --controls
```

`--compare 30000` limits the (slower) forecaster replay to the first 30,000 rounds of each series. Data quality and dependence tests always use every round. On your own export: `npm run evaluate:signal -w @aviator/backend -- rounds.csv` (columns `multiplier,received_at`).

---

## aviator_payouts.csv

Invalid values skipped: 1. Exact duplicate rows removed: 5.

### aviator_payouts.csv · BETGR8

timestamps from the file (collection times); exact duplicate rows removed; rows written < 2 s after the previous one (catch-up bursts) start a new run, because their order and continuity are not verified; forecaster comparison on the first 30,000.

**Data quality**

| Rounds | Consecutive runs | Longest run | Rounds in runs ≥ 20 | Median / p95 interval | Intervals > 3× median (likely missed rounds) | Identical timestamps (ms) | Adjacent repeats observed / expected |
|---|---|---|---|---|---|---|---|
| 97,407 | 16,826 | 5,367 | 70,692 | 29.001 s / 58.856 s | 518 | 16,253 | 356 / 365 |

**Temporal dependence and distribution change** (pairs only within consecutive runs; Benjamini–Hochberg over the six dependence tests)

| Test | Statistic | p | BH-adjusted p | Effect size |
|---|---|---|---|---|
| Serial correlation of ≥ 2× (lags 1–10) | Q = 15.0, df 10 | 0.1319 | 0.3956 | lag-1 r = -0.0019; max |r| = 0.0066 |
| Serial correlation of multiplier rank (lags 1–10) | Q = 10.6, df 10 | 0.3925 | 0.7851 | lag-1 r = -0.0016; max |r| = 0.0064 |
| Runs test (below / at or above 2×) | runs 43,661 vs expected 43637, z = 0.17 | 0.8638 | 0.8638 | 0.05% vs expected |
| Previous range → next range | χ² = 6.2, df 9 | 0.7197 | 0.8638 | Cramér's V 0.0051; P(≥2×) after each range: 49.5% / 49.7% / 48.9% / 48.9% |
| Rounds below 2× in a row → next round ≥ 2× | χ² = 1.9, df 5 | 0.8574 | 0.8638 | P(≥2×) after 0/1/2/3/4/5+ lows: 49.4% / 49.3% / 49.8% / 48.7% / 49.0% / 50.0% |
| Distribution change over time (10 blocks) | χ² = 367.5, df 27 | 2.0e-61 | 1.2e-60 | P(≥2×) by block 47.2%–50.2% |
| Fit to the RTP reference 0.97 ÷ m | χ² = 47.6, df 3 | 2.6e-10 | — (prior check) | observed 51.3% / 28.5% / 10.1% / 10.1% vs reference 51.5% / 29.1% / 9.7% / 9.7% |

**Walk-forward forecaster comparison** — 29,646 scored forecasts (334 void). Log-loss difference is vs the Bayesian baseline on the same rounds (negative = better), 95% CI. Holm-corrected one-sided p over the 8 tested forecasters. Rolling = 1000-round windows (half-overlapping).

| Forecaster | Top-range hit | Brier | Log loss | Δ log loss vs baseline [95% CI] | Holm p (better) | Calibration Z (≥2×) | Rolling Δ best / worst | Windows ahead |
|---|---|---|---|---|---|---|---|---|
| Shown forecast (what the panel displayed) | 51.5% | 0.6305 | 1.15123 | +0.00002 [-0.00000, +0.00005] | — | -0.00 | +0.00000 / +0.00065 | 0.0% |
| Bayesian baseline (live engine) | 51.5% | 0.6305 | 1.15121 | — | — | -0.00 | — | — |
| Empirical range frequency (add-½, no prior) | 51.5% | 0.6305 | 1.15125 | +0.00005 [+0.00001, +0.00008] | 1.0000 | -0.05 | -0.00007 / +0.00126 | 37.9% |
| Fixed RTP reference 0.97 ÷ m | 51.5% | 0.6303 | 1.15086 | -0.00035 [-0.00062, -0.00008] | 0.0431 | 0.02 | -0.00493 / +0.00101 | 58.6% |
| Most-frequent range so far (all-or-nothing) | 51.5% | 0.9702 | ∞ (gives 0% to every other range) | — | — | — | — | — |
| Recent drift (EWMA) | 51.5% | 0.6329 | 1.15716 | +0.00596 [+0.00462, +0.00729] | 1.0000 | 0.27 | -0.00204 / +0.01069 | 3.4% |
| Previous-round transition (control) | 51.5% | 0.6308 | 1.15197 | +0.00077 [+0.00036, +0.00118] | 1.0000 | -0.49 | -0.00079 / +0.00623 | 24.1% |
| Rounds since last 2× (control) | 51.5% | 0.6309 | 1.15213 | +0.00093 [+0.00043, +0.00142] | 1.0000 | -0.44 | -0.00154 / +0.00745 | 37.9% |
| Recent-round regression | 51.0% | 0.6383 | 1.16990 | +0.01870 [+0.01637, +0.02102] | 1.0000 | -0.55 | +0.00788 / +0.02743 | 0.0% |
| Change-point detector | 51.3% | 0.6340 | 1.15989 | +0.00869 [+0.00710, +0.01027] | 1.0000 | 0.40 | +0.00220 / +0.01316 | 0.0% |
| Model average | 51.5% | 0.6305 | 1.15123 | +0.00002 [-0.00002, +0.00007] | 1.0000 | -0.00 | -0.00000 / +0.00066 | 24.1% |

### aviator_payouts.csv · BETIKA

timestamps from the file (collection times); exact duplicate rows removed; rows written < 2 s after the previous one (catch-up bursts) start a new run, because their order and continuity are not verified; forecaster comparison on the first 30,000.

**Data quality**

| Rounds | Consecutive runs | Longest run | Rounds in runs ≥ 20 | Median / p95 interval | Intervals > 3× median (likely missed rounds) | Identical timestamps (ms) | Adjacent repeats observed / expected |
|---|---|---|---|---|---|---|---|
| 107,449 | 16,961 | 6,971 | 79,908 | 27.225 s / 56.691 s | 627 | 16,425 | 448 / 427 |

**Temporal dependence and distribution change** (pairs only within consecutive runs; Benjamini–Hochberg over the six dependence tests)

| Test | Statistic | p | BH-adjusted p | Effect size |
|---|---|---|---|---|
| Serial correlation of ≥ 2× (lags 1–10) | Q = 10.4, df 10 | 0.4055 | 0.7097 | lag-1 r = 0.0003; max |r| = 0.0081 |
| Serial correlation of multiplier rank (lags 1–10) | Q = 9.6, df 10 | 0.4731 | 0.7097 | lag-1 r = -0.0000; max |r| = 0.0062 |
| Runs test (below / at or above 2×) | runs 48,481 vs expected 48528, z = -0.32 | 0.7469 | 0.7849 | -0.10% vs expected |
| Previous range → next range | χ² = 5.5, df 9 | 0.7849 | 0.7849 | Cramér's V 0.0045; P(≥2×) after each range: 49.2% / 49.1% / 49.8% / 48.8% |
| Rounds below 2× in a row → next round ≥ 2× | χ² = 5.6, df 5 | 0.3517 | 0.7097 | P(≥2×) after 0/1/2/3/4/5+ lows: 49.2% / 49.3% / 49.0% / 47.8% / 47.9% / 49.0% |
| Distribution change over time (10 blocks) | χ² = 88.7, df 27 | 1.7e-8 | 1.0e-7 | P(≥2×) by block 45.4%–49.0% |
| Fit to the RTP reference 0.97 ÷ m | χ² = 22.3, df 3 | 5.6e-5 | — (prior check) | observed 52.1% / 28.7% / 9.5% / 9.8% vs reference 51.5% / 29.1% / 9.7% / 9.7% |

**Walk-forward forecaster comparison** — 29,307 scored forecasts (673 void). Log-loss difference is vs the Bayesian baseline on the same rounds (negative = better), 95% CI. Holm-corrected one-sided p over the 8 tested forecasters. Rolling = 1000-round windows (half-overlapping).

| Forecaster | Top-range hit | Brier | Log loss | Δ log loss vs baseline [95% CI] | Holm p (better) | Calibration Z (≥2×) | Rolling Δ best / worst | Windows ahead |
|---|---|---|---|---|---|---|---|---|
| Shown forecast (what the panel displayed) | 52.0% | 0.6272 | 1.14528 | +0.00006 [-0.00003, +0.00015] | — | -0.49 | +0.00000 / +0.00135 | 0.0% |
| Bayesian baseline (live engine) | 52.0% | 0.6272 | 1.14522 | — | — | -0.48 | — | — |
| Empirical range frequency (add-½, no prior) | 52.0% | 0.6272 | 1.14525 | +0.00003 [-0.00001, +0.00006] | 1.0000 | -0.53 | -0.00005 / +0.00077 | 47.4% |
| Fixed RTP reference 0.97 ÷ m | 52.0% | 0.6271 | 1.14503 | -0.00019 [-0.00049, +0.00011] | 0.8129 | -1.59 | -0.00523 / +0.00153 | 49.1% |
| Most-frequent range so far (all-or-nothing) | 52.0% | 0.9609 | ∞ (gives 0% to every other range) | — | — | — | — | — |
| Recent drift (EWMA) | 51.9% | 0.6298 | 1.15124 | +0.00602 [+0.00470, +0.00734] | 1.0000 | -0.29 | -0.00163 / +0.01027 | 3.5% |
| Previous-round transition (control) | 52.0% | 0.6275 | 1.14590 | +0.00068 [+0.00014, +0.00122] | 1.0000 | -0.42 | -0.00180 / +0.00649 | 29.8% |
| Rounds since last 2× (control) | 52.0% | 0.6276 | 1.14613 | +0.00091 [+0.00027, +0.00154] | 1.0000 | -0.53 | -0.00400 / +0.00532 | 31.6% |
| Recent-round regression | 51.6% | 0.6354 | 1.16578 | +0.02056 [+0.01815, +0.02297] | 1.0000 | -0.77 | +0.00686 / +0.04166 | 0.0% |
| Change-point detector | 51.9% | 0.6306 | 1.15345 | +0.00823 [+0.00664, +0.00981] | 1.0000 | -0.33 | +0.00030 / +0.01383 | 0.0% |
| Model average | 52.0% | 0.6272 | 1.14524 | +0.00002 [-0.00010, +0.00015] | 1.0000 | -0.49 | -0.00023 / +0.00037 | 28.1% |

### aviator_payouts.csv · ODIBETS

timestamps from the file (collection times); exact duplicate rows removed; rows written < 2 s after the previous one (catch-up bursts) start a new run, because their order and continuity are not verified; forecaster comparison on the first 30,000.

**Data quality**

| Rounds | Consecutive runs | Longest run | Rounds in runs ≥ 20 | Median / p95 interval | Intervals > 3× median (likely missed rounds) | Identical timestamps (ms) | Adjacent repeats observed / expected |
|---|---|---|---|---|---|---|---|
| 66,823 | 18,933 | 1,597 | 36,395 | 27.672 s / 59.748 s | 419 | 18,347 | 187 / 205 |

**Temporal dependence and distribution change** (pairs only within consecutive runs; Benjamini–Hochberg over the six dependence tests)

| Test | Statistic | p | BH-adjusted p | Effect size |
|---|---|---|---|---|
| Serial correlation of ≥ 2× (lags 1–10) | Q = 9.9, df 10 | 0.4524 | 0.9049 | lag-1 r = -0.0013; max |r| = 0.0113 |
| Serial correlation of multiplier rank (lags 1–10) | Q = 6.8, df 10 | 0.7471 | 0.9247 | lag-1 r = -0.0001; max |r| = 0.0078 |
| Runs test (below / at or above 2×) | runs 27,371 vs expected 27401, z = -0.29 | 0.7706 | 0.9247 | -0.11% vs expected |
| Previous range → next range | χ² = 2.3, df 9 | 0.9864 | 0.9864 | Cramér's V 0.0040; P(≥2×) after each range: 50.9% / 50.8% / 51.1% / 50.2% |
| Rounds below 2× in a row → next round ≥ 2× | χ² = 5.1, df 5 | 0.3990 | 0.9049 | P(≥2×) after 0/1/2/3/4/5+ lows: 50.8% / 50.5% / 49.7% / 51.9% / 50.0% / 48.9% |
| Distribution change over time (10 blocks) | χ² = 323.3, df 27 | 1.6e-52 | 9.7e-52 | P(≥2×) by block 47.5%–57.0% |
| Fit to the RTP reference 0.97 ÷ m | χ² = 124.9, df 3 | 6.7e-27 | — (prior check) | observed 49.7% / 29.7% / 9.8% / 10.7% vs reference 51.5% / 29.1% / 9.7% / 9.7% |

**Walk-forward forecaster comparison** — 16,577 scored forecasts (13,403 void). Log-loss difference is vs the Bayesian baseline on the same rounds (negative = better), 95% CI. Holm-corrected one-sided p over the 8 tested forecasters. Rolling = 1000-round windows (half-overlapping).

| Forecaster | Top-range hit | Brier | Log loss | Δ log loss vs baseline [95% CI] | Holm p (better) | Calibration Z (≥2×) | Rolling Δ best / worst | Windows ahead |
|---|---|---|---|---|---|---|---|---|
| Shown forecast (what the panel displayed) | 50.2% | 0.6413 | 1.17241 | -0.00414 [-0.00578, -0.00249] | — | -1.55 | -0.01737 / +0.00116 | 84.4% |
| Bayesian baseline (live engine) | 50.2% | 0.6438 | 1.17655 | — | — | -11.63 | — | — |
| Empirical range frequency (add-½, no prior) | 50.2% | 0.6438 | 1.17656 | +0.00002 [+0.00000, +0.00003] | 1.0000 | -11.65 | +0.00000 / +0.00005 | 0.0% |
| Fixed RTP reference 0.97 ÷ m | 50.2% | 0.6405 | 1.17063 | -0.00592 [-0.00799, -0.00384] | 9.1e-8 | 3.30 | -0.02336 / +0.00062 | 90.6% |
| Most-frequent range so far (all-or-nothing) | 50.2% | 0.9956 | ∞ (gives 0% to every other range) | — | — | — | — | — |
| Recent drift (EWMA) | 50.2% | 0.6436 | 1.17771 | +0.00116 [-0.00110, +0.00341] | 1.0000 | -1.98 | -0.01748 / +0.00854 | 31.3% |
| Previous-round transition (control) | 50.2% | 0.6411 | 1.17212 | -0.00443 [-0.00604, -0.00282] | 2.5e-7 | -1.58 | -0.01441 / +0.00380 | 87.5% |
| Rounds since last 2× (control) | 50.2% | 0.6412 | 1.17245 | -0.00410 [-0.00572, -0.00248] | 1.6e-6 | -1.66 | -0.01286 / +0.00533 | 90.6% |
| Recent-round regression | 49.5% | 0.6501 | 1.19294 | +0.01639 [+0.01248, +0.02030] | 1.0000 | -0.00 | +0.00084 / +0.03227 | 0.0% |
| Change-point detector | 50.1% | 0.6445 | 1.18089 | +0.00434 [+0.00143, +0.00725] | 1.0000 | 1.38 | -0.01456 / +0.01329 | 21.9% |
| Model average | 50.2% | 0.6412 | 1.17226 | -0.00429 [-0.00594, -0.00264] | 1.1e-6 | -1.53 | -0.01737 / +0.00116 | 87.5% |

### aviator_payouts.csv · WINPESA

timestamps from the file (collection times); exact duplicate rows removed; rows written < 2 s after the previous one (catch-up bursts) start a new run, because their order and continuity are not verified.

**Data quality**

| Rounds | Consecutive runs | Longest run | Rounds in runs ≥ 20 | Median / p95 interval | Intervals > 3× median (likely missed rounds) | Identical timestamps (ms) | Adjacent repeats observed / expected |
|---|---|---|---|---|---|---|---|
| 28,315 | 3,547 | 2,110 | 17,196 | 30.722 s / 65.877 s | 180 | 3,381 | 117 / 115 |

**Temporal dependence and distribution change** (pairs only within consecutive runs; Benjamini–Hochberg over the six dependence tests)

| Test | Statistic | p | BH-adjusted p | Effect size |
|---|---|---|---|---|
| Serial correlation of ≥ 2× (lags 1–10) | Q = 10.5, df 10 | 0.3983 | 0.5975 | lag-1 r = 0.0078; max |r| = 0.0156 |
| Serial correlation of multiplier rank (lags 1–10) | Q = 13.0, df 10 | 0.2242 | 0.5975 | lag-1 r = 0.0036; max |r| = 0.0174 |
| Runs test (below / at or above 2×) | runs 14,403 vs expected 14547, z = -1.95 | 0.0511 | 0.3066 | -0.99% vs expected |
| Previous range → next range | χ² = 6.5, df 9 | 0.6846 | 0.7198 | Cramér's V 0.0094; P(≥2×) after each range: 50.9% / 51.6% / 51.4% / 52.2% |
| Rounds below 2× in a row → next round ≥ 2× | χ² = 6.0, df 5 | 0.3100 | 0.5975 | P(≥2×) after 0/1/2/3/4/5+ lows: 51.7% / 50.7% / 49.5% / 49.8% / 50.5% / 49.7% |
| Distribution change over time (10 blocks) | χ² = 22.3, df 27 | 0.7198 | 0.7198 | P(≥2×) by block 47.4%–49.8% |
| Fit to the RTP reference 0.97 ÷ m | χ² = 3.0, df 3 | 0.3952 | — (prior check) | observed 51.0% / 29.4% / 9.8% / 9.7% vs reference 51.5% / 29.1% / 9.7% / 9.7% |

**Walk-forward forecaster comparison** — 24,768 scored forecasts (3,527 void). Log-loss difference is vs the Bayesian baseline on the same rounds (negative = better), 95% CI. Holm-corrected one-sided p over the 8 tested forecasters. Rolling = 1000-round windows (half-overlapping).

| Forecaster | Top-range hit | Brier | Log loss | Δ log loss vs baseline [95% CI] | Holm p (better) | Calibration Z (≥2×) | Rolling Δ best / worst | Windows ahead |
|---|---|---|---|---|---|---|---|---|
| Shown forecast (what the panel displayed) | 48.7% | 0.6491 | 1.18525 | -0.00000 [-0.00008, +0.00008] | — | 6.64 | -0.00152 / +0.00049 | 2.1% |
| Bayesian baseline (live engine) | 48.7% | 0.6492 | 1.18525 | — | — | 6.75 | — | — |
| Empirical range frequency (add-½, no prior) | 48.7% | 0.6492 | 1.18525 | -0.00000 [-0.00001, +0.00001] | 1.0000 | 6.71 | -0.00005 / +0.00005 | 77.1% |
| Fixed RTP reference 0.97 ÷ m | 48.7% | 0.6494 | 1.18546 | +0.00021 [-0.00010, +0.00051] | 1.0000 | 8.75 | -0.00304 / +0.00136 | 31.3% |
| Most-frequent range so far (all-or-nothing) | 48.7% | 1.0256 | ∞ (gives 0% to every other range) | — | — | — | — | — |
| Recent drift (EWMA) | 48.7% | 0.6521 | 1.19269 | +0.00744 [+0.00599, +0.00888] | 1.0000 | 7.40 | +0.00021 / +0.01715 | 0.0% |
| Previous-round transition (control) | 48.7% | 0.6489 | 1.18514 | -0.00011 [-0.00085, +0.00062] | 1.0000 | 0.79 | -0.00612 / +0.00788 | 54.2% |
| Rounds since last 2× (control) | 48.7% | 0.6489 | 1.18524 | -0.00001 [-0.00078, +0.00076] | 1.0000 | 0.86 | -0.00599 / +0.00795 | 50.0% |
| Recent-round regression | 47.8% | 0.6564 | 1.20277 | +0.01752 [+0.01492, +0.02011] | 1.0000 | -0.46 | -0.00330 / +0.02904 | 2.1% |
| Change-point detector | 48.6% | 0.6532 | 1.19557 | +0.01032 [+0.00862, +0.01202] | 1.0000 | 8.09 | +0.00391 / +0.02256 | 0.0% |
| Model average | 48.7% | 0.6491 | 1.18522 | -0.00003 [-0.00014, +0.00007] | 1.0000 | 6.42 | -0.00205 / +0.00069 | 52.1% |

## multipliers.csv

Invalid values skipped: 0. Exact duplicate rows removed: 0.

### multipliers.csv

no timestamps: synthetic 20 s spacing, no breaks; forecaster comparison on the first 30,000.

**Data quality**

| Rounds | Consecutive runs | Longest run | Rounds in runs ≥ 20 | Median / p95 interval | Intervals > 3× median (likely missed rounds) | Identical timestamps (ms) | Adjacent repeats observed / expected |
|---|---|---|---|---|---|---|---|
| 732,367 | 1 | 732,367 | 732,367 | 20 s / 20 s | 0 | 0 | 3,390 / 3403 |

**Temporal dependence and distribution change** (pairs only within consecutive runs; Benjamini–Hochberg over the six dependence tests)

| Test | Statistic | p | BH-adjusted p | Effect size |
|---|---|---|---|---|
| Serial correlation of ≥ 2× (lags 1–10) | Q = 6.0, df 10 | 0.8189 | 0.8189 | lag-1 r = -0.0008; max |r| = 0.0017 |
| Serial correlation of multiplier rank (lags 1–10) | Q = 9.1, df 10 | 0.5233 | 0.6766 | lag-1 r = -0.0009; max |r| = 0.0024 |
| Runs test (below / at or above 2×) | runs 366,034 vs expected 365751, z = 0.66 | 0.5073 | 0.6766 | 0.08% vs expected |
| Previous range → next range | χ² = 7.7, df 9 | 0.5638 | 0.6766 | Cramér's V 0.0019; P(≥2×) after each range: 48.3% / 48.3% / 48.4% / 48.0% |
| Rounds below 2× in a row → next round ≥ 2× | χ² = 8.2, df 5 | 0.1468 | 0.6766 | P(≥2×) after 0/1/2/3/4/5+ lows: 48.2% / 48.3% / 48.6% / 47.9% / 48.1% / 48.7% |
| Distribution change over time (10 blocks) | χ² = 28.3, df 27 | 0.3969 | 0.6766 | P(≥2×) by block 48.1%–48.5% |
| Fit to the RTP reference 0.97 ÷ m | χ² = 18.9, df 3 | 0.0003 | — (prior check) | observed 51.7% / 29.0% / 9.6% / 9.6% vs reference 51.5% / 29.1% / 9.7% / 9.7% |

**Walk-forward forecaster comparison** — 29,980 scored forecasts (0 void). Log-loss difference is vs the Bayesian baseline on the same rounds (negative = better), 95% CI. Holm-corrected one-sided p over the 8 tested forecasters. Rolling = 1000-round windows (half-overlapping).

| Forecaster | Top-range hit | Brier | Log loss | Δ log loss vs baseline [95% CI] | Holm p (better) | Calibration Z (≥2×) | Rolling Δ best / worst | Windows ahead |
|---|---|---|---|---|---|---|---|---|
| Shown forecast (what the panel displayed) | 51.9% | 0.6288 | 1.14914 | +0.00001 [-0.00002, +0.00004] | — | 1.53 | +0.00000 / +0.00031 | 0.0% |
| Bayesian baseline (live engine) | 51.9% | 0.6288 | 1.14913 | — | — | 1.53 | — | — |
| Empirical range frequency (add-½, no prior) | 51.9% | 0.6288 | 1.14917 | +0.00004 [-0.00001, +0.00008] | 1.0000 | 1.52 | -0.00005 / +0.00118 | 53.4% |
| Fixed RTP reference 0.97 ÷ m | 51.9% | 0.6286 | 1.14876 | -0.00037 [-0.00079, +0.00005] | 0.3214 | -1.37 | -0.00359 / +0.00082 | 63.8% |
| Most-frequent range so far (all-or-nothing) | 51.9% | 0.9621 | ∞ (gives 0% to every other range) | — | — | — | — | — |
| Recent drift (EWMA) | 51.9% | 0.6315 | 1.15561 | +0.00648 [+0.00520, +0.00776] | 1.0000 | 0.40 | -0.00347 / +0.01118 | 1.7% |
| Previous-round transition (control) | 51.9% | 0.6290 | 1.14991 | +0.00078 [+0.00035, +0.00121] | 1.0000 | 1.44 | -0.00110 / +0.00711 | 31.0% |
| Rounds since last 2× (control) | 51.9% | 0.6291 | 1.15004 | +0.00091 [+0.00042, +0.00140] | 1.0000 | 1.46 | -0.00104 / +0.01037 | 31.0% |
| Recent-round regression | 51.5% | 0.6366 | 1.16788 | +0.01875 [+0.01662, +0.02089] | 1.0000 | 0.26 | +0.00904 / +0.02890 | 0.0% |
| Change-point detector | 51.9% | 0.6325 | 1.15794 | +0.00881 [+0.00726, +0.01036] | 1.0000 | 0.43 | +0.00049 / +0.01254 | 0.0% |
| Model average | 51.9% | 0.6288 | 1.14915 | +0.00002 [-0.00002, +0.00007] | 1.0000 | 1.51 | -0.00000 / +0.00069 | 31.0% |

## Controls (SIMULATED rounds — not real game data)

**Negative control: independent rounds, P(M ≥ m) = 0.97 ÷ m** — 60 histories × 5,000 rounds

| Test | Histories with p < 0.05 |
|---|---|
| Serial correlation of ≥ 2× (lags 1–10) | 1 (1.7%) |
| Serial correlation of multiplier rank (lags 1–10) | 2 (3.3%) |
| Runs test (below / at or above 2×) | 3 (5.0%) |
| Previous range → next range | 2 (3.3%) |
| Rounds below 2× in a row → next round ≥ 2× | 2 (3.3%) |
| Distribution change over time (10 blocks) | 3 (5.0%) |
| Any dependence test after BH (FDR 5%) | 1 (1.7%) |
| Any learning forecaster better than baseline (Holm, 5%) | 0 (0.0%) |
| Fixed RTP reference better than baseline (Holm, 5%; it is the true distribution here) | 7 (11.7%) |
| Some forecaster ahead by > 0.003 in its best 1000-round window | 56 (93.3%) |

**Positive control: planted previous-round effect ±0.05 on P(≥ 2×)** — 20 histories × 5,000 rounds

| Test | Histories with p < 0.05 |
|---|---|
| Serial correlation of ≥ 2× (lags 1–10) | 20 (100.0%) |
| Serial correlation of multiplier rank (lags 1–10) | 20 (100.0%) |
| Runs test (below / at or above 2×) | 20 (100.0%) |
| Previous range → next range | 20 (100.0%) |
| Rounds below 2× in a row → next round ≥ 2× | 20 (100.0%) |
| Distribution change over time (10 blocks) | 0 (0.0%) |
| Any dependence test after BH (FDR 5%) | 20 (100.0%) |
| Any learning forecaster better than baseline (Holm, 5%) | 5 (25.0%) |
| Fixed RTP reference better than baseline (Holm, 5%; it is the true distribution here) | 4 (20.0%) |
| Some forecaster ahead by > 0.003 in its best 1000-round window | 20 (100.0%) |

Expected under the negative control: each single test rejects in about 5% of histories, and the corrected families in at most about 5%. Short-window "wins" on independent rounds show why a model that looks ahead over the last few hundred rounds is not evidence of an edge.
