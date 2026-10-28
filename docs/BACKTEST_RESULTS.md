# Backtest results — engine stat-5.1 (`sequential_v1`)

Regenerated 2026-10-28 with `npm run backtest:signal -w @aviator/backend`. Every forecast below was issued **before** its round and scored after it, by the same code the server runs (`replay()`). Nothing was tuned on these results: the models, priors, thresholds and rules were fixed before the real-data runs, and nothing was changed afterwards. **No actual 1xBet data was available** ([DATA_QUALITY.md](DATA_QUALITY.md)).

> **Correction (2026-10-28).** The first version of this file (stat-5) ordered the PHIMAS rows by millisecond timestamps. About 16% of rows were written microseconds apart in catch-up bursts, so those pairs kept the file's newest-first order, i.e. they were reversed. The loader now sorts by the full microsecond timestamp and starts a new run at every burst, because order and continuity inside a burst are not verified. The PHIMAS tables below are regenerated. The conclusion is unchanged: nothing validated. The MindingTheData series and the simulated controls were not affected (no timestamps; nothing changed for them).

For the comparison with all requested baselines (empirical frequency, most-frequent range, fixed RTP reference), each model individually, the previous-round and streak controls, Holm correction, rolling windows and the direct dependence tests, see **[EVALUATION_RESULTS.md](EVALUATION_RESULTS.md)**.

## Summary

| Data | Kind | Rounds used | Scored forecasts (void) | Ever validated | Final state | Best candidate log10 e-value (needs ≥ 2) | Shown vs baseline log loss (95% CI) |
|---|---|---|---|---|---|---|---|
| BETGR8 (PHIMAS dataset) | real, third-party, provenance undocumented | 30,000 | 29,646 (334) | **no** | baseline_only | −15.33 | +0.00002 [−0.00000, +0.00005] |
| BETIKA (PHIMAS) | same | 30,000 | 29,307 (673) | **no** | baseline_only | −13.32 | +0.00006 [−0.00003, +0.00015] |
| ODIBETS (PHIMAS) | same; 45% of forecasts void (gaps and bursts) | 30,000 | 16,577 (13,403) | **no** | experimental | −13.72 | −0.00414 [−0.00578, −0.00249] |
| WINPESA (PHIMAS) | same | 28,315 | 24,768 (3,527) | **no** | experimental | −13.72 | −0.00000 [−0.00008, +0.00008] |
| MindingTheData `multipliers.csv` | real hash-chain crash game, **not Aviator** | 30,000 | 29,980 (0) | **no** | baseline_only | — | +0.00001 [−0.00002, +0.00004] |
| Independent simulated rounds | negative control | 340 histories (300–3,000 rounds) | — | **0 of 340** | — | — | — |
| Planted dependence ±0.05 / ±0.10 / ±0.15 | positive control | 500–3,000 | — | 5% (±0.05, 3,000) · 50–100% (±0.10, 1,000–3,000) · 75–100% (±0.15, 500–1,500) | validated when detected | — | — |

**Answer to "does any model predict real rounds better than the baseline?" — No validated advantage.** On ~148,000 real rounds no candidate came near validation: best log10 e-values −13 to −15 against a threshold of +2. The top-range hit rate equals the baseline's on every series (48.7–52.0%), as it must when every model's best guess is "1.00×–1.99×".

ODIBETS is the one series where the shown forecast (the model average, then weighted almost entirely on the previous-round model) ended ahead of the running baseline, with an interval below 0. The direct tests explain why. No serial dependence is detectable in ODIBETS (smallest BH-adjusted p 0.90), but its share of 2×+ rounds moved between 47.5% and 57.0% across the period, and the cumulative baseline lagged that level shift. A fixed 0.97 ÷ m forecast was even further ahead of the baseline (−0.0059). That is not round-to-round predictability, and the e-value test, which compares against the best constant distribution, did not validate it. The panel now labels such a lead **"Ahead — not validated"**, never "better".

Datasets, provenance checks and why they are not your 1xBet data: [RESEARCH.md](RESEARCH.md) §2. The files are not committed (third-party data). To reproduce:

```bash
curl -L -o aviator_payouts.csv https://raw.githubusercontent.com/PHIMAS/aviator/main/aviator_payouts.csv
curl -L -o multipliers.csv https://raw.githubusercontent.com/MindingTheData/Crash-Analysis/master/multipliers.csv
npm run backtest:signal -w @aviator/backend -- aviator_payouts.csv --limit 30000 --controls
npm run backtest:signal -w @aviator/backend -- multipliers.csv --reverse --limit 30000
```

On your own rounds (read-only export, see NEXT_ROUND_FORECAST.md for the `\copy` command): `npm run backtest:signal -w @aviator/backend -- rounds.csv`.

---

## aviator_payouts.csv

Invalid values skipped: 1. Exact duplicate rows removed: 5.

### aviator_payouts.csv · BETGR8

30,000 rounds (timestamps from the file (collection times); exact duplicate rows removed; rows written < 2 s after the previous one (catch-up bursts) start a new run, because their order and continuity are not verified; first 30,000 of 97,407 rounds used); 29,981 forecasts issued; 29,646 scored on unseen rounds, 334 voided (collection breaks). Run time 6.5 s.

Final state: **baseline_only**. Forecast states over time: experimental 101, baseline_only 29,880. Ever validated: **no**.

| Metric (shown forecast vs baseline, scored forecasts) | Shown | Baseline |
|---|---|---|
| Top-range hit rate | 51.5% | 51.5% |
| Log loss (4 ranges) | 1.1512 | 1.1512 |
| Multi-class Brier | 0.6305 | 0.6305 |
| Log-loss difference, 95% CI (negative = better) | 0.00002 [-0.00000, 0.00005] | |

| Threshold | Events / non-events | Brier shown / baseline | Mean forecast | Observed rate | Calibration Z | Status |
|---|---|---|---|---|---|---|
| ≥ 2× | 14380 / 15266 | 0.2498 / 0.2498 | 48.5% | 48.5% | 0.94 | ok |
| ≥ 5× | 5677 / 23969 | 0.1549 / 0.1549 | 19.2% | 19.1% | -0.21 | ok |
| ≥ 10× | 2777 / 26869 | 0.0849 / 0.0849 | 9.4% | 9.4% | -0.38 | ok |

| Model | Mean log loss | log10 e-value vs i.i.d. (needs ≥ 2.00) | Final weight | Validated |
|---|---|---|---|---|
| Baseline (all rounds, Bayesian) | 1.15121 | — | 1.000 | no |
| Recent drift (EWMA) | 1.15716 | -82.13 | 0.000 | no |
| Previous-round transition | 1.15197 | -15.33 | 0.000 | no |
| Rounds since last 2× | 1.15213 | -17.35 | 0.000 | no |
| Recent-round regression | 1.16990 | -246.15 | 0.000 | no |
| Change-point detector | 1.15989 | -117.27 | 0.000 | no |
| Model average | 1.15123 | — | — | no |

| Period (quarter of scored forecasts) | n | Log-loss diff (shown − baseline) | Top-range hit shown / baseline |
|---|---|---|---|
| Q1 | 7411 | 0.00009 [-0.00001, 0.00019] | 51.1% / 51.1% |
| Q2 | 7412 | 0.00000 [0.00000, 0.00000] | 51.2% / 51.2% |
| Q3 | 7411 | 0.00000 [0.00000, 0.00000] | 52.2% / 52.2% |
| Q4 | 7412 | 0.00000 [0.00000, 0.00000] | 51.5% / 51.5% |

### aviator_payouts.csv · BETIKA

30,000 rounds (timestamps from the file (collection times); exact duplicate rows removed; rows written < 2 s after the previous one (catch-up bursts) start a new run, because their order and continuity are not verified; first 30,000 of 107,449 rounds used); 29,981 forecasts issued; 29,307 scored on unseen rounds, 673 voided (collection breaks). Run time 7.3 s.

Final state: **baseline_only**. Forecast states over time: experimental 225, baseline_only 29,756. Ever validated: **no**.

| Metric (shown forecast vs baseline, scored forecasts) | Shown | Baseline |
|---|---|---|
| Top-range hit rate | 52.0% | 52.0% |
| Log loss (4 ranges) | 1.1453 | 1.1452 |
| Multi-class Brier | 0.6272 | 0.6272 |
| Log-loss difference, 95% CI (negative = better) | 0.00006 [-0.00003, 0.00015] | |

| Threshold | Events / non-events | Brier shown / baseline | Mean forecast | Observed rate | Calibration Z | Status |
|---|---|---|---|---|---|---|
| ≥ 2× | 14078 / 15229 | 0.2497 / 0.2497 | 48.2% | 48.0% | 0.50 | ok |
| ≥ 5× | 5528 / 23779 | 0.1531 / 0.1531 | 18.8% | 18.9% | 0.50 | ok |
| ≥ 10× | 2841 / 26466 | 0.0876 / 0.0876 | 9.6% | 9.7% | 0.68 | ok |

| Model | Mean log loss | log10 e-value vs i.i.d. (needs ≥ 2.00) | Final weight | Validated |
|---|---|---|---|---|
| Baseline (all rounds, Bayesian) | 1.14522 | — | 1.000 | no |
| Recent drift (EWMA) | 1.15124 | -81.28 | 0.000 | no |
| Previous-round transition | 1.14590 | -13.32 | 0.000 | no |
| Rounds since last 2× | 1.14613 | -16.19 | 0.000 | no |
| Recent-round regression | 1.16578 | -266.33 | 0.000 | no |
| Change-point detector | 1.15345 | -109.37 | 0.000 | no |
| Model average | 1.14524 | — | — | no |

| Period (quarter of scored forecasts) | n | Log-loss diff (shown − baseline) | Top-range hit shown / baseline |
|---|---|---|---|
| Q1 | 7326 | 0.00023 [-0.00014, 0.00059] | 51.8% / 51.8% |
| Q2 | 7327 | 0.00000 [0.00000, 0.00000] | 52.4% / 52.4% |
| Q3 | 7327 | 0.00000 [0.00000, 0.00000] | 51.8% / 51.8% |
| Q4 | 7327 | 0.00000 [0.00000, 0.00000] | 51.8% / 51.8% |

### aviator_payouts.csv · ODIBETS

30,000 rounds (timestamps from the file (collection times); exact duplicate rows removed; rows written < 2 s after the previous one (catch-up bursts) start a new run, because their order and continuity are not verified; first 30,000 of 66,823 rounds used); 29,981 forecasts issued; 16,577 scored on unseen rounds, 13403 voided (collection breaks). Run time 5.2 s.

Final state: **experimental**. Forecast states over time: experimental 20,900, baseline_only 9,081. Ever validated: **no**.

| Metric (shown forecast vs baseline, scored forecasts) | Shown | Baseline |
|---|---|---|
| Top-range hit rate | 50.2% | 50.2% |
| Log loss (4 ranges) | 1.1724 | 1.1765 |
| Multi-class Brier | 0.6413 | 0.6438 |
| Log-loss difference, 95% CI (negative = better) | -0.00414 [-0.00578, -0.00249] | |

| Threshold | Events / non-events | Brier shown / baseline | Mean forecast | Observed rate | Calibration Z | Status |
|---|---|---|---|---|---|---|
| ≥ 2× | 8252 / 8325 | 0.2505 / 0.2524 | 50.4% | 49.8% | 5.80 | ok |
| ≥ 5× | 3363 / 13214 | 0.1620 / 0.1627 | 20.6% | 20.3% | -0.90 | ok |
| ≥ 10× | 1708 / 14869 | 0.0925 / 0.0932 | 10.6% | 10.3% | -0.99 | ok |

| Model | Mean log loss | log10 e-value vs i.i.d. (needs ≥ 2.00) | Final weight | Validated |
|---|---|---|---|---|
| Baseline (all rounds, Bayesian) | 1.17655 | — | 0.000 | no |
| Recent drift (EWMA) | 1.17771 | -53.90 | 0.000 | no |
| Previous-round transition | 1.17212 | -13.72 | 0.995 | no |
| Rounds since last 2× | 1.17245 | -16.06 | 0.005 | no |
| Recent-round regression | 1.19294 | -163.57 | 0.000 | no |
| Change-point detector | 1.18089 | -76.80 | 0.000 | no |
| Model average | 1.17226 | — | — | no |

| Period (quarter of scored forecasts) | n | Log-loss diff (shown − baseline) | Top-range hit shown / baseline |
|---|---|---|---|
| Q1 | 4144 | -0.00476 [-0.00936, -0.00016] | 49.5% / 49.5% |
| Q2 | 4144 | -0.00627 [-0.00951, -0.00303] | 50.2% / 50.2% |
| Q3 | 4144 | -0.00350 [-0.00615, -0.00086] | 50.7% / 50.7% |
| Q4 | 4145 | -0.00201 [-0.00414, 0.00013] | 50.5% / 50.5% |

### aviator_payouts.csv · WINPESA

28,315 rounds (timestamps from the file (collection times); exact duplicate rows removed; rows written < 2 s after the previous one (catch-up bursts) start a new run, because their order and continuity are not verified); 28,296 forecasts issued; 24,768 scored on unseen rounds, 3527 voided (collection breaks). Run time 7.3 s.

Final state: **experimental**. Forecast states over time: experimental 1,187, baseline_only 27,109. Ever validated: **no**.

| Metric (shown forecast vs baseline, scored forecasts) | Shown | Baseline |
|---|---|---|
| Top-range hit rate | 48.7% | 48.7% |
| Log loss (4 ranges) | 1.1853 | 1.1853 |
| Multi-class Brier | 0.6491 | 0.6492 |
| Log-loss difference, 95% CI (negative = better) | -0.00000 [-0.00008, 0.00008] | |

| Threshold | Events / non-events | Brier shown / baseline | Mean forecast | Observed rate | Calibration Z | Status |
|---|---|---|---|---|---|---|
| ≥ 2× | 12701 / 12067 | 0.2504 / 0.2504 | 49.2% | 51.3% | 7.29 | ok |
| ≥ 5× | 5166 / 19602 | 0.1653 / 0.1653 | 19.7% | 20.9% | 4.69 | ok |
| ≥ 10× | 2590 / 22178 | 0.0937 / 0.0937 | 9.9% | 10.5% | 2.95 | ok |

| Model | Mean log loss | log10 e-value vs i.i.d. (needs ≥ 2.00) | Final weight | Validated |
|---|---|---|---|---|
| Baseline (all rounds, Bayesian) | 1.18525 | — | 0.212 | no |
| Recent drift (EWMA) | 1.19269 | -94.93 | 0.000 | no |
| Previous-round transition | 1.18514 | -13.72 | 0.729 | no |
| Rounds since last 2× | 1.18524 | -14.81 | 0.059 | no |
| Recent-round regression | 1.20277 | -203.36 | 0.000 | no |
| Change-point detector | 1.19557 | -125.96 | 0.000 | no |
| Model average | 1.18522 | — | — | no |

| Period (quarter of scored forecasts) | n | Log-loss diff (shown − baseline) | Top-range hit shown / baseline |
|---|---|---|---|
| Q1 | 6192 | 0.00008 [-0.00007, 0.00023] | 48.9% / 48.9% |
| Q2 | 6192 | 0.00000 [0.00000, 0.00000] | 48.5% / 48.5% |
| Q3 | 6192 | 0.00000 [0.00000, 0.00000] | 49.5% / 49.5% |
| Q4 | 6192 | -0.00008 [-0.00036, 0.00020] | 48.0% / 48.0% |

## Controls (SIMULATED rounds — not real game data)

**Negative control** — independent rounds, P(M ≥ m) = 0.97 ÷ m. Any validation is a false positive.

| Rounds per history | Histories | Ever validated (at any round) | Validated at the end |
|---|---|---|---|
| 300 | 200 | 0 (0.0%) | 0 |
| 1000 | 100 | 0 (0.0%) | 0 |
| 3000 | 40 | 0 (0.0%) | 0 |

Bound guaranteed by the method (Ville's inequality, Bonferroni over 5 candidates): at most α = 5% of histories ever validated.

**Positive control** — planted dependence: P(≥ 2×) = 0.485 ± effect after a round below / at or above 2×.

| Effect | Rounds | Histories | Validated at the end | Validated model(s) |
|---|---|---|---|---|
| ±0.05 | 3000 | 20 | 1 (5%) | markov 1 |
| ±0.1 | 1000 | 20 | 10 (50%) | markov 8, streak 2 |
| ±0.1 | 3000 | 20 | 20 (100%) | markov 18, streak 2 |
| ±0.15 | 500 | 20 | 15 (75%) | streak 7, markov 8 |
| ±0.15 | 1500 | 20 | 20 (100%) | markov 14, streak 6 |

---

## multipliers.csv

Invalid values skipped: 0. Exact duplicate rows removed: 0.

### multipliers.csv

30,000 rounds (no timestamps: synthetic 20 s spacing, no breaks; first 30,000 of 732,367 rounds used); 29,981 forecasts issued; 29,980 scored on unseen rounds, 0 voided (collection breaks). Run time 10.7 s.

Final state: **baseline_only**. Forecast states over time: experimental 101, baseline_only 29,880. Ever validated: **no**.

| Metric (shown forecast vs baseline, scored forecasts) | Shown | Baseline |
|---|---|---|
| Top-range hit rate | 51.9% | 51.9% |
| Log loss (4 ranges) | 1.1491 | 1.1491 |
| Multi-class Brier | 0.6288 | 0.6288 |
| Log-loss difference, 95% CI (negative = better) | 0.00001 [-0.00002, 0.00004] | |

| Threshold | Events / non-events | Brier shown / baseline | Mean forecast | Observed rate | Calibration Z | Status |
|---|---|---|---|---|---|---|
| ≥ 2× | 14422 / 15558 | 0.2497 / 0.2497 | 47.7% | 48.1% | 2.76 | ok |
| ≥ 5× | 5746 / 24234 | 0.1550 / 0.1550 | 19.0% | 19.2% | 0.82 | ok |
| ≥ 10× | 2842 / 27138 | 0.0858 / 0.0858 | 9.2% | 9.5% | 1.91 | ok |

| Model | Mean log loss | log10 e-value vs i.i.d. (needs ≥ 2.00) | Final weight | Validated |
|---|---|---|---|---|
| Baseline (all rounds, Bayesian) | 1.14913 | — | 1.000 | no |
| Recent drift (EWMA) | 1.15561 | -89.81 | 0.000 | no |
| Previous-round transition | 1.14991 | -15.60 | 0.000 | no |
| Rounds since last 2× | 1.15004 | -17.32 | 0.000 | no |
| Recent-round regression | 1.16788 | -249.58 | 0.000 | no |
| Change-point detector | 1.15306 | -56.68 | 0.000 | no |
| Model average | 1.14915 | — | — | no |

| Period (quarter of scored forecasts) | n | Log-loss diff (shown − baseline) | Top-range hit shown / baseline |
|---|---|---|---|
| Q1 | 7495 | 0.00004 [-0.00009, 0.00017] | 52.0% / 52.0% |
| Q2 | 7495 | 0.00000 [0.00000, 0.00000] | 52.0% / 52.0% |
| Q3 | 7495 | 0.00000 [0.00000, 0.00000] | 51.8% / 51.8% |
| Q4 | 7495 | 0.00000 [0.00000, 0.00000] | 51.9% / 51.9% |
