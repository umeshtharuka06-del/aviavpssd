# Research notes for the stat-5 round-by-round engine

Collected 2026-10-28. "Accessed" means I opened the page or file in this session. I don't cite anything I could not open as if I had verified it.

## 1. Official game facts (primary sources)

| Fact | Source | Status |
|---|---|---|
| Aviator RTP is **97%** | Spribe game page, <https://spribe.co/games/aviator> (accessed 2026-10-28; "Return to Player (RTP) 97%") | Verified as published by Spribe |
| Round result = SHA-512 of the server seed (16 random symbols, its SHA-256 published before the round) merged with the **client seeds of the first 3 bettors** | In-game "What is provably fair?" dialog, official demo `https://demo.spribe.io/launch/aviator` → `aviator-demo.spribegaming.com` (accessed 2026-10-28) | Verified as Spribe's own description |
| "Before the start of each round, our provably fair random number generator generates the multiplier" | In-game Game Rules, same demo (accessed 2026-10-28) | Verified |
| Exact mapping from the SHA-512 hash to the multiplier | Not published in either place | **Not available**, so the exact distribution is unverified |
| Distribution P(M ≥ m) = 0.97 ÷ m | Follows from a 97% RTP if it holds at **every** cash-out target, e.g. M = 0.97 ÷ (1 − U) for uniform U ([derivation and simulation, philippdubach.com](https://philippdubach.com/posts/against-all-odds-the-mathematics-of-provably-fair-casino-games/)) | **Assumption.** Used only as the labelled "RTP reference" and as the prior centre of the baseline. Never presented as the official distribution |

Consequence for the engine: if the provably-fair process works as described, each round's multiplier is fixed by fresh seeds and is independent of earlier rounds. **The expected and honest result is that no model beats the base rate.** The engine must be able to say so.

### What the game interface exposes

The official demo shows a results strip with the most recent multipliers (I counted 27 to 52 values in the DOM). It has **no round ids and no times**. Per-round verification details (seeds, hash) are shown only when you click a round, so they are not read. The extension now stores the strip once, as **backfill**, when collection starts (see section 4). It reads only what is already visible to the logged-in user: no authentication, access control or security mechanism is bypassed. The demo ("FUN MODE") is a separate environment from 1xBet's real-money game, and its rounds are **not** used as 1xBet data.

## 2. Public datasets found and checked

| Dataset | What I verified | Verdict |
|---|---|---|
| Kaggle "Aviator game dataset" (<https://www.kaggle.com/datasets/kaggleaccount7537/aviator-game-dataset>) / GitHub `emomo81/Aviator-predictor` `multipliers.csv` / original `MindingTheData/Crash-Analysis` `multipliers.csv` (<https://github.com/MindingTheData/Crash-Analysis>) | Downloaded (3,644,178 bytes, 732,367 values; the emomo81 copy has the identical MD5 `4b0cdad5…`). The notebook `Crash.ipynb` shows the values were **computed** from a SHA-256 hash chain with a Bitcoin-block salt and a 1/33 instant crash. That is a bustabit-style "Crash" game, not Spribe Aviator, and the values are recomputed rather than observed. No timestamps, no round ids. | **Not Aviator. Mislabelled on Kaggle.** Used only as a negative control: a real, published, independent crash sequence |
| GitHub `PHIMAS/aviator` `aviator_payouts.csv` (<https://github.com/PHIMAS/aviator>) | Downloaded (14,795,300 bytes, 300,000 rows: `created_at`, `app`, `payout`). Four Kenyan operators: BETIKA 107,451; BETGR8 97,409; ODIBETS 66,825; WINPESA 28,315. Dates 2024-01-01 to 2024-02-03. 0–2 duplicate rows per operator, no invalid values, 2 decimals. Median spacing 20–29 s, matching Aviator's round rhythm, with 57–124 gaps over 120 s per operator. Frequencies: P(≥2×) 0.479–0.503, P(≥5×) 0.193–0.206, P(≥10×) 0.097–0.107, P(< 1.01×) 0.035–0.040, close to the 0.97 ÷ m reference (0.485 / 0.194 / 0.097 / 0.040). | **Plausibly real observed Aviator rounds, but provenance is undocumented**: no README, no collection method, no round ids, so completeness cannot be proven. The operators are not 1xBet. Used **only** as an external backtest set, per operator, **never** as input to your live forecasts. **Collection artifacts found later (2026-10-28):** 12–28% of rows per operator were written microseconds apart in catch-up bursts, whose internal order is unverified and which hold about twice the normal share of repeated values (likely duplicates). Bursts now start a new run in the loader; see DATA_QUALITY.md §5 |
| `whoiskay404/aviator-predictor` | 334 rounds read by eye from screenshots (per its own description) | Too small and manual. Not used |
| `vicboy123/aviator-analytics`, `herbbossng-tech/aviator-intelligence` | Dashboards. They ship no data | Not used |

Your own data: see `ENGINE_AUDIT.md`. I have **no access to your real 1xBet rounds**. They exist only on your VPS (12 h retention).

## 3. Statistical literature behind the method

| Topic | Reference | How it is used |
|---|---|---|
| Gambler's fallacy / hot hand | Tversky & Kahneman (1971), "Belief in the law of small numbers", *Psychological Bulletin* 76(2). Croson & Sundali (2005), *J. Risk & Uncertainty* 30(3):195–209 (<https://ideas.repec.org/a/kap/jrisku/v30y2005i3p195-209.html>) | No rule of the form "after N lows, a high is due". Streak models must earn their weight out of sample |
| Proper scoring rules | Gneiting & Raftery (2007), "Strictly proper scoring rules, prediction, and estimation", *JASA* 102:359–378, doi:10.1198/016214506000001437. Brier (1950), *Monthly Weather Review* 78:1–3. Good (1952), log score | Log loss and Brier score per forecast. Accuracy alone is never used for rare events |
| Calibration | Spiegelhalter (1986), *Statistics in Medicine* 5:421–433. Reliability diagrams (Murphy & Winkler 1977) | Spiegelhalter Z and binned reliability per threshold |
| Anytime-valid sequential testing | Ramdas, Grünwald, Vovk & Shafer (2023), "Game-theoretic statistics and safe anytime-valid inference", *Statistical Science* (arXiv:2210.01948). Ville's inequality | Validation is re-checked after every round without inflating false positives |
| Composite null without regularity conditions | Wasserman, Ramdas & Balakrishnan (2020), "Universal inference", *PNAS* 117:16880–16890, doi:10.1073/pnas.1922664117 (<https://arxiv.org/abs/1912.11436>) | Denominator of the e-value = best i.i.d. fit to the outcomes (maximum likelihood), so the test is valid for **any** constant range distribution |
| Change-point detection | Adams & MacKay (2007), "Bayesian online changepoint detection", arXiv:0710.3742 (<https://arxiv.org/abs/0710.3742>) | `changepoint` candidate and the distribution-shift indicator |
| Forecast comparison | Diebold & Mariano (1995), *JBES* 13:253–263 | Kept in the existing `stat-4` experiment |
| Multiple testing | Bonferroni. Holm (1979), *Scand. J. Statistics* 6:65–70. Benjamini & Hochberg (1995), *JRSS B* 57:289–300 | Candidates × α correction on the validation threshold; Holm over forecaster comparisons and BH over dependence tests in `evaluate:signal` |
| Serial dependence tests | Box & Pierce (1970), *JASA* 65:1509–1526; Ljung & Box (1978), *Biometrika* 65:297–303; Wald & Wolfowitz (1940) runs test, *Ann. Math. Statist.* 11:147–162 | Portmanteau Q over lags 1–10 and the runs test in `evaluate:signal`, pairs only within verified runs |
| Bayesian model averaging / exponential weights | Hoeting, Madigan, Raftery & Volinsky (1999), *Statistical Science* 14:382–417. Cesa-Bianchi & Lugosi (2006), *Prediction, Learning, and Games* | The documented, tested rule that moves weight between models |

## 4. Decisions taken from this research

1. **Baseline**: a Bayesian Dirichlet–categorical estimate over the four ranges. Its prior is centred on the RTP reference with a strength of 10 pseudo-rounds, so 20 rounds already outweigh it 2:1. It is labelled "empirical baseline", not "official distribution".
2. **Candidates** (each shrunk toward the baseline): EWMA drift, previous-range transition (Markov), below-2× streak length, regularised multinomial logistic regression on log-multiplier features, and Bayesian online change-point detection. Five candidates in total, so the multiple-testing factor is K = 5.
3. **Experimental estimate** = Bayesian model average of baseline and candidates. Its weights come only from each model's recorded log score on already-scored forecasts, and the baseline has prior weight ½. This is the rule that "learns from mistakes" without reversing on a single miss.
4. **Validated signal** only when a candidate's universal-inference e-value against "rounds are i.i.d." reaches **K ÷ α = 100**, after at least 50 scored forecasts, *and* its cumulative log loss is below the baseline's. This holds at any stopping time (Ville), so checking after every round is legitimate.
5. **Backfill** of the visible strip happens once per page load, aligned server-side against already stored rounds. It is refused if it cannot be aligned unambiguously, and stored with `source = 'backfill'`.
