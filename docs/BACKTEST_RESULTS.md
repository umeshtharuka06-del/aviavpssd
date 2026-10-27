# Backtest results — engine stat-5 (`sequential_v1`)

Generated 2026-10-28 with `npm run backtest:signal -w @aviator/backend`. Every forecast below was issued **before** its round and scored after it, by the same code the server runs (`replay()`). Nothing was tuned on these results: the models, priors, thresholds and rules were fixed before the real-data runs, and nothing was changed afterwards.

## Summary

| Data | Kind | Rounds used | Scored forecasts | Ever validated | Final state | Shown vs baseline log loss (95% CI) |
|---|---|---|---|---|---|---|
| BETGR8 (PHIMAS dataset) | real, external, provenance undocumented | 30,000 | 29,655 | **no** | baseline_only | +0.00002 [−0.00000, +0.00005] |
| BETIKA (PHIMAS) | same | 30,000 | 29,326 | **no** | baseline_only | +0.00006 [−0.00003, +0.00015] |
| ODIBETS (PHIMAS) | same; 44% of forecasts void (collection gaps) | 30,000 | 16,904 | **no** | experimental | −0.00131 [−0.00351, +0.00090] |
| WINPESA (PHIMAS) | same | 28,315 | 24,875 | **no** | baseline_only | +0.00002 [−0.00005, +0.00010] |
| MindingTheData `multipliers.csv` | real hash-chain crash game, **not Aviator** | 30,000 | 29,980 | **no** | baseline_only | +0.00001 [−0.00002, +0.00004] |
| Independent simulated rounds | negative control | 340 histories (300–3,000 rounds) | — | **0 of 340** | — | — |
| Planted dependence ±0.05 / ±0.10 / ±0.15 | positive control | 500–3,000 | — | 5% (±0.05, 3,000) · 50–100% (±0.10, 1,000–3,000) · 75–100% (±0.15, 500–1,500) | validated when detected | — |

**Answer to "does any model predict real rounds better than the baseline?" — No.** On ~148,000 real rounds no candidate came near validation. The best log10 e-values were −13 to −41, and the threshold is +2. After the first 100 scored forecasts, the forecast shown was the baseline 98–99.7% of the time in four of the five series. The top-range hit rate equals the baseline's (50.5–51.9%), as it must when the best guess is always "1.00×–1.99×".

ODIBETS is the one series where the change-point model ended slightly ahead of the baseline. The difference is small and its interval includes 0. The 2× calibration Z of 8.2 says the share of 2×+ rounds shifted over the period. With 13,076 forecasts voided by collection gaps, that more likely reflects how the file was collected than anything about the game. It was **not** validated.

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

30,000 rounds (timestamps from the file (collection times); exact duplicate rows removed; first 30,000 of 97,407 rounds used); 29,981 forecasts issued; 29,655 scored on unseen rounds, 325 voided (collection breaks). Run time 11.1 s.

Final state: **baseline_only**. Forecast states over time: experimental 101, baseline_only 29,880. Ever validated: **no**.

| Metric (shown forecast vs baseline, scored forecasts) | Shown | Baseline |
|---|---|---|
| Top-range hit rate | 51.6% | 51.6% |
| Log loss (4 ranges) | 1.1506 | 1.1506 |
| Multi-class Brier | 0.6301 | 0.6301 |
| Log-loss difference, 95% CI (negative = better) | 0.00002 [-0.00000, 0.00005] | |

| Threshold | Events / non-events | Brier shown / baseline | Mean forecast | Observed rate | Calibration Z | Status |
|---|---|---|---|---|---|---|
| ≥ 2× | 14365 / 15290 | 0.2498 / 0.2498 | 48.5% | 48.4% | 0.74 | ok |
| ≥ 5× | 5673 / 23982 | 0.1547 / 0.1547 | 19.2% | 19.1% | -0.30 | ok |
| ≥ 10× | 2773 / 26882 | 0.0848 / 0.0848 | 9.4% | 9.4% | -0.47 | ok |

| Model | Mean log loss | log10 e-value vs i.i.d. (needs ≥ 2.00) | Final weight | Validated |
|---|---|---|---|---|
| Baseline (all rounds, Bayesian) | 1.15062 | — | 1.000 | no |
| Recent drift (EWMA) | 1.15652 | -81.42 | 0.000 | no |
| Previous-round transition | 1.15136 | -14.92 | 0.000 | no |
| Rounds since last 2× | 1.15153 | -17.19 | 0.000 | no |
| Recent-round regression | 1.16951 | -248.75 | 0.000 | no |
| Change-point detector | 1.15456 | -56.22 | 0.000 | no |
| Model average | 1.15065 | — | — | no |

| Period (quarter of scored forecasts) | n | Log-loss diff (shown − baseline) | Top-range hit shown / baseline |
|---|---|---|---|
| Q1 | 7413 | 0.00009 [-0.00001, 0.00019] | 51.2% / 51.2% |
| Q2 | 7414 | 0.00000 [0.00000, 0.00000] | 51.3% / 51.3% |
| Q3 | 7414 | 0.00000 [0.00000, 0.00000] | 52.2% / 52.2% |
| Q4 | 7414 | 0.00000 [0.00000, 0.00000] | 51.6% / 51.6% |

### aviator_payouts.csv · BETIKA

30,000 rounds (timestamps from the file (collection times); exact duplicate rows removed; first 30,000 of 107,449 rounds used); 29,981 forecasts issued; 29,326 scored on unseen rounds, 654 voided (collection breaks). Run time 10.2 s.

Final state: **baseline_only**. Forecast states over time: experimental 225, baseline_only 29,756. Ever validated: **no**.

| Metric (shown forecast vs baseline, scored forecasts) | Shown | Baseline |
|---|---|---|
| Top-range hit rate | 51.9% | 51.9% |
| Log loss (4 ranges) | 1.1463 | 1.1463 |
| Multi-class Brier | 0.6278 | 0.6278 |
| Log-loss difference, 95% CI (negative = better) | 0.00006 [-0.00003, 0.00015] | |

| Threshold | Events / non-events | Brier shown / baseline | Mean forecast | Observed rate | Calibration Z | Status |
|---|---|---|---|---|---|---|
| ≥ 2× | 14113 / 15213 | 0.2497 / 0.2497 | 48.2% | 48.1% | 0.85 | ok |
| ≥ 5× | 5546 / 23780 | 0.1534 / 0.1534 | 18.8% | 18.9% | 0.72 | ok |
| ≥ 10× | 2856 / 26470 | 0.0879 / 0.0879 | 9.6% | 9.7% | 0.94 | ok |

| Model | Mean log loss | log10 e-value vs i.i.d. (needs ≥ 2.00) | Final weight | Validated |
|---|---|---|---|---|
| Baseline (all rounds, Bayesian) | 1.14628 | — | 1.000 | no |
| Recent drift (EWMA) | 1.15230 | -81.45 | 0.000 | no |
| Previous-round transition | 1.14697 | -13.54 | 0.000 | no |
| Rounds since last 2× | 1.14718 | -16.19 | 0.000 | no |
| Recent-round regression | 1.16763 | -276.69 | 0.000 | no |
| Change-point detector | 1.15048 | -58.21 | 0.000 | no |
| Model average | 1.14631 | — | — | no |

| Period (quarter of scored forecasts) | n | Log-loss diff (shown − baseline) | Top-range hit shown / baseline |
|---|---|---|---|
| Q1 | 7331 | 0.00023 [-0.00014, 0.00059] | 51.9% / 51.9% |
| Q2 | 7332 | 0.00000 [0.00000, 0.00000] | 52.3% / 52.3% |
| Q3 | 7331 | 0.00000 [0.00000, 0.00000] | 51.9% / 51.9% |
| Q4 | 7332 | 0.00000 [0.00000, 0.00000] | 51.4% / 51.4% |

### aviator_payouts.csv · ODIBETS

30,000 rounds (timestamps from the file (collection times); exact duplicate rows removed; first 30,000 of 66,823 rounds used); 29,981 forecasts issued; 16,904 scored on unseen rounds, 13076 voided (collection breaks). Run time 10.1 s.

Final state: **experimental**. Forecast states over time: experimental 26,338, baseline_only 3,643. Ever validated: **no**.

| Metric (shown forecast vs baseline, scored forecasts) | Shown | Baseline |
|---|---|---|
| Top-range hit rate | 50.5% | 50.5% |
| Log loss (4 ranges) | 1.1730 | 1.1743 |
| Multi-class Brier | 0.6410 | 0.6424 |
| Log-loss difference, 95% CI (negative = better) | -0.00131 [-0.00351, 0.00090] | |

| Threshold | Events / non-events | Brier shown / baseline | Mean forecast | Observed rate | Calibration Z | Status |
|---|---|---|---|---|---|---|
| ≥ 2× | 8366 / 8538 | 0.2510 / 0.2526 | 49.9% | 49.5% | 8.21 | ok |
| ≥ 5× | 3406 / 13498 | 0.1614 / 0.1619 | 20.3% | 20.1% | 0.16 | ok |
| ≥ 10× | 1722 / 15182 | 0.0918 / 0.0923 | 10.4% | 10.2% | -0.47 | ok |

| Model | Mean log loss | log10 e-value vs i.i.d. (needs ≥ 2.00) | Final weight | Validated |
|---|---|---|---|---|
| Baseline (all rounds, Bayesian) | 1.17428 | — | 0.000 | no |
| Recent drift (EWMA) | 1.17435 | -52.43 | 0.000 | no |
| Previous-round transition | 1.18088 | -100.38 | 0.000 | no |
| Rounds since last 2× | 1.17579 | -63.04 | 0.000 | no |
| Recent-round regression | 1.19288 | -188.52 | 0.000 | no |
| Change-point detector | 1.17278 | -40.95 | 1.000 | no |
| Model average | 1.17292 | — | — | no |

| Period (quarter of scored forecasts) | n | Log-loss diff (shown − baseline) | Top-range hit shown / baseline |
|---|---|---|---|
| Q1 | 4226 | -0.00611 [-0.01103, -0.00119] | 50.0% / 50.1% |
| Q2 | 4226 | 0.00020 [-0.00456, 0.00496] | 50.1% / 50.2% |
| Q3 | 4226 | -0.00062 [-0.00480, 0.00356] | 50.8% / 50.8% |
| Q4 | 4226 | 0.00130 [-0.00236, 0.00496] | 50.9% / 50.9% |

### aviator_payouts.csv · WINPESA

28,315 rounds (timestamps from the file (collection times); exact duplicate rows removed); 28,296 forecasts issued; 24,875 scored on unseen rounds, 3420 voided (collection breaks). Run time 10.1 s.

Final state: **baseline_only**. Forecast states over time: experimental 564, baseline_only 27,732. Ever validated: **no**.

| Metric (shown forecast vs baseline, scored forecasts) | Shown | Baseline |
|---|---|---|
| Top-range hit rate | 51.1% | 51.1% |
| Log loss (4 ranges) | 1.1551 | 1.1551 |
| Multi-class Brier | 0.6329 | 0.6329 |
| Log-loss difference, 95% CI (negative = better) | 0.00002 [-0.00005, 0.00010] | |

| Threshold | Events / non-events | Brier shown / baseline | Mean forecast | Observed rate | Calibration Z | Status |
|---|---|---|---|---|---|---|
| ≥ 2× | 12171 / 12704 | 0.2500 / 0.2500 | 49.1% | 48.9% | 1.27 | ok |
| ≥ 5× | 4797 / 20078 | 0.1557 / 0.1557 | 19.7% | 19.3% | -1.47 | ok |
| ≥ 10× | 2380 / 22495 | 0.0865 / 0.0865 | 9.9% | 9.6% | -1.68 | ok |

| Model | Mean log loss | log10 e-value vs i.i.d. (needs ≥ 2.00) | Final weight | Validated |
|---|---|---|---|---|
| Baseline (all rounds, Bayesian) | 1.15510 | — | 1.000 | no |
| Recent drift (EWMA) | 1.16146 | -73.29 | 0.000 | no |
| Previous-round transition | 1.15589 | -13.05 | 0.000 | no |
| Rounds since last 2× | 1.15611 | -15.50 | 0.000 | no |
| Recent-round regression | 1.17280 | -195.81 | 0.000 | no |
| Change-point detector | 1.15892 | -45.88 | 0.000 | no |
| Model average | 1.15513 | — | — | no |

| Period (quarter of scored forecasts) | n | Log-loss diff (shown − baseline) | Top-range hit shown / baseline |
|---|---|---|---|
| Q1 | 6218 | 0.00008 [-0.00021, 0.00038] | 51.1% / 51.1% |
| Q2 | 6219 | 0.00000 [0.00000, 0.00000] | 51.2% / 51.2% |
| Q3 | 6219 | 0.00000 [0.00000, 0.00000] | 51.1% / 51.1% |
| Q4 | 6219 | 0.00000 [0.00000, 0.00000] | 50.8% / 50.8% |

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
