# Round-by-round next-round signal (engine `stat-5.1`, method `sequential_v1`)

After 20 consecutive verified rounds the side panel shows an estimate for **every** next round. Each estimate is recorded before its round happens, scored when the round arrives, and never changed afterwards. Each estimate is clearly labelled as experimental, baseline-only or validated.

> **On a provably-fair game, expect BASELINE ONLY.** Spribe's documentation says each round comes from fresh server and player seeds (see [RESEARCH.md](RESEARCH.md)). In every real dataset I could test, no model beat the baseline (see [BACKTEST_RESULTS.md](BACKTEST_RESULTS.md)). The engine is built to say so honestly, and to detect a pattern only if one really exists.
>
> Estimates are chances, not guarantees. Not betting advice.

Related: [ENGINE_AUDIT.md](ENGINE_AUDIT.md) (root causes, two audits), [DATA_QUALITY.md](DATA_QUALITY.md) (collection, continuity, which data exists), [EVALUATION_RESULTS.md](EVALUATION_RESULTS.md) (dependence tests and every baseline compared), [RESEARCH.md](RESEARCH.md) (sources), [BACKTEST_RESULTS.md](BACKTEST_RESULTS.md).

**What changed in stat-5.1 / extension 0.2.1:** collector continuity (rounds are verified consecutive, not guessed from times), warm-up on 20 *consecutive verified* rounds, `currentRun` / `longestRun` in the response, and a panel that compares every range with the baseline, shows the last result and rolling performance, and never calls an unvalidated lead "better".

## What is forecast

The forecast is the probability of each of four mutually exclusive ranges for the next round's crash multiplier *m*:

| Range | Rule | Note |
|---|---|---|
| 1.00×–1.99× | 1 ≤ m < 2 | |
| 2.00×–4.99× | 2 ≤ m < 5 | 2.00× belongs here |
| 5.00×–9.99× | 5 ≤ m < 10 | 5.00× belongs here |
| 10.00× and above | m ≥ 10 | 10.00× belongs here |

Multipliers are stored with two decimals. The four probabilities always sum to 1 (checked server-side, by the contract and again by the panel). The threshold chances come from the same numbers, so they are always consistent: **P(≥2×) = r2 + r5 + r10**, **P(≥5×) = r5 + r10**, **P(≥10×) = r10**.

## The live process (every round)

When a round is stored (`POST /v1/history`, or the one-off backfill), inside one per-device database lock:

1. **Match.** Each open forecast is matched to the next stored round after its input boundary.
2. **Score.** That outcome is written to `forecast_outcomes`, exactly once (primary key = forecast). If the next stored round is not a **verified successor** of the input round, the forecast is **void**, not scored, because the stored round may not be the very next round played. Verified = same collector chain and the next position, or a value-aligned backfill (see Data). Rounds from extension versions before 0.2.1 carry no continuity; for them a gap of more than 120 s is the break, as before.
3. **Update.** Performance figures and ensemble weights are recomputed from the ledger, using scored outcomes only.
4. **Refit.** Every model is rebuilt from the stored rounds, which were all known before the next round.
5. **Issue.** ONE forecast is recorded for the round after the latest stored round (`round_forecasts`, unique per input boundary). Both ledger tables reject `UPDATE` with a database trigger.

`POST /v1/analysis` runs the same sync before answering, so the panel always gets the forecast for the next round. Repeated requests, browser refreshes, retries, a backend restart, or two requests at once cannot create, lose or re-score a forecast (tested). When several rounds arrive in one upload, the open forecast is scored with the **first** of them. The rounds in between get no forecast, because none existed before they happened. Nothing is ever back-dated.

The panel refreshes within 4 s of the background's "rounds uploaded" notice, plus a 30 s fallback poll. After a failed refresh, the last forecast stays visible with a **STALE — last successful update hh:mm:ss** label.

## Models

All models see only rounds before the forecast round (enforced by construction, and tested by changing every later round: forecasts up to that point are identical). The candidates shrink toward the baseline, so with no evidence they forecast (almost) the baseline.

| Model | What it is | Why it is included |
|---|---|---|
| **Baseline** | Bayesian Dirichlet–categorical estimate of a *constant* range distribution. Prior Dirichlet(10 × RTP reference), posterior predictive (countₖ + 10·refₖ) ÷ (n + 10) | The correct forecast if rounds are independent and identically distributed (what provably-fair implies). The RTP reference P(M ≥ m) = 0.97 ÷ m is an **unverified assumption** and is used only as a weak prior centre, worth 10 rounds |
| EWMA drift | Exponentially weighted range frequencies, half-life 50 rounds, shrunk toward the baseline (20 pseudo-rounds) | Detects slow drift in the distribution |
| Previous-round transition (Markov) | P(range ∣ previous round's range), 4×4 counts, shrunk (20) | Simplest dependence. Only *used* if it earns weight out of sample |
| Rounds since last 2× (streak) | P(range ∣ rounds in a row below 2×: 0, 1, 2, 3–4, 5–7, 8+), shrunk (20) | Tests the gambler's-fallacy hypothesis directly. It cannot push "a high is due" unless the data support it |
| Recent-round regression | Ridge multinomial logistic regression (λ = 2) on previous log multiplier, mean log of the last 5 and 20, median log of the last 10 (robust to the heavy tail), log(1 + streak below 2×). Refit every 50 rounds on the latest 500 | Combines several recent-round features with regularisation |
| Change-point detector | Bayesian online change-point detection (Adams & MacKay 2007) with a Dirichlet–categorical segment model, hazard 1/250 | Detects abrupt distribution changes without treating a short streak as a change. Also gives the "Distribution change" figure in Details |
| **Model average** (the experimental estimate) | Bayesian model average of the six: weight ∝ prior × Π p(actual range) over scored forecasts. Priors: baseline ½, each candidate 1/10 | The documented rule for learning from mistakes: weight moves only by recorded log score, never by "reversing" after a miss |

Rejected after review: a plain "after N lows, a high is due" rule. It has no support (Croson & Sundali 2005) and is a special case of the streak model anyway.

## States and the decision rule

| State (panel label) | When | Forecast shown |
|---|---|---|
| WARMING UP | no run of 20 consecutive verified rounds yet | none, plus progress "n of 20 consecutive verified rounds" |
| EXPERIMENTAL ESTIMATE | 20+ rounds, not validated, and either fewer than 100 scored forecasts or the model average is ahead of the baseline | model average, banner **EXPERIMENTAL — NOT VALIDATED** |
| BASELINE ONLY | 100+ scored forecasts and the model average's total log loss is not below the baseline's | baseline, banner **BASELINE — NOT A PREDICTIVE SIGNAL** |
| VALIDATED SIGNAL | a candidate has ≥ 50 scored forecasts, a total log loss below the baseline's, **and** an e-value ≥ 100 (below) | that candidate |
| INSUFFICIENT EVIDENCE (per target) | fewer than 10 scored rounds reached, or fewer than 10 missed, 2× / 5× / 10× | the chance is still shown, tagged |
| SERVER UPDATE NEEDED | the server's response has no `nextRound` (engine before stat-5) | none |
| ANALYSIS UNAVAILABLE | request failed with no earlier result, test-data server, or the response failed validation or a consistency check | none |

**Validation test (anytime-valid).** For candidate *k*, after *N* scored forecasts:

  e_k = Π_t p_k(y_t) ÷ max_θ Π_t θ(y_t)

The denominator is the best *constant* range distribution fitted to those same outcomes (maximum likelihood). It is the universal-inference statistic of Wasserman, Ramdas & Balakrishnan (2020). Each forecast was recorded before its outcome, so under "rounds are i.i.d. with any constant distribution" e_k is bounded by a test martingale. By Ville's inequality, P(e_k ever ≥ 1/α) ≤ α, **however often it is checked**. With 5 candidates and Bonferroni, the threshold is 5 ÷ 0.05 = **100**. That is what allows re-checking after every round without inflating false positives. The price is conservativeness: weak effects take many rounds to validate (see the controls).

Every forecast also stores the evidence that stood when it was issued (`atIssue`: scored count, the shown model's log-loss difference to the baseline, best candidate and its e-value). The panel checks each claim against it: a "validated" label without the required e-value, too few scored forecasts, probabilities that do not sum to 1, or a mis-scored hit/miss → ANALYSIS UNAVAILABLE.

## Scores shown and their exact definitions

All scores use **scored forecasts only**. Each was issued before its round was known; void and pending forecasts are excluded.

| Score | Definition |
|---|---|
| Unseen forecasts scored | Number of forecasts whose round arrived without a collection break |
| Top-range hit / "Hit" | The actual multiplier fell in the range the forecast gave the highest probability. **Hit rate** = hits ÷ scored. Shown next to the baseline's hit rate on the same rounds. For independent rounds the top range is always 1.00×–1.99× (~51.5%), so this is not "accuracy" |
| Log loss | Mean of −ln p(actual range); lower is better. Probabilities are clipped to [10⁻⁹, 1 − 10⁻⁹] so it is always finite |
| Brier (ranges) | Mean of Σₖ (pₖ − 1[k = actual])², in [0, 2] |
| Brier / log loss (threshold T) | Mean of (P(≥T) − 1[m ≥ T])², and the binary log loss of P(≥T) |
| Vs baseline | Mean of (shown log loss − baseline log loss) with a 95% normal interval. "Better than baseline" only if the whole interval is below 0. "Too few to judge" below 100 scored |
| Score (per history row) | `atIssue.logLossDiff`: the shown model's mean log loss minus the baseline's over the forecasts scored before that row was issued (negative = better) |
| Calibration Z | Spiegelhalter's Z for P(≥T); \|Z\| < 1.96 is consistent with calibrated probabilities. Reliability bins (0–0.1–0.2–0.35–0.5–0.65–1) give n, mean forecast and observed rate |
| Rolling | The same figures over the last 50 scored forecasts |
| e-value (log10) | As defined above; ≥ 2.00 (i.e. ≥ 100) is required for validation |
| Distribution change | Change-point model's posterior probability that the current segment started within the last 30 rounds |

There is **no "confidence %"**: no single number in the panel claims how sure a forecast is.

## Data

- **Live rounds**: as before, only rounds completed while the page was observed. They are stored with `source = 'live'`.
- **Backfill**: the results strip already on screen when collection starts (typically 25–60 rounds in Spribe's UI) is sent **once per page view**, oldest first, as soon as the list's order is known (after the first new round). It goes to `POST /v1/history/backfill`. The server aligns it with the device's stored rounds by value matching, since there are no round ids: it needs exactly one alignment of at least 4 consecutive values, or of all stored rounds. It stores only rounds it did not have, with `source = 'backfill'`. If the alignment is ambiguous, or the list cannot be placed relative to rounds stored in the last 120 s, it stores **nothing** (`rejected`). No round is ever interpolated or invented. With backfill, the 20-round warm-up is usually reached as soon as the first new round completes.
- The panel shows rounds used, split into live and backfill, and the verified consecutive run (current and longest), in the card and in Details.
- **Continuity (stat-5.1, extension 0.2.1).** Every upload carries the collector's read chain and the position of its first round. The chain changes whenever rounds may have been missed: page load, re-sync, list unavailable, ambiguous change. The server stores `chain_id`, `chain_index` and `break_before` per round (migration `0005`). A dropped upload shows up as a jump in the position, so it is a break too. Details and tests: [DATA_QUALITY.md](DATA_QUALITY.md) §3.
- Breaks: continuity evidence decides. For rounds without it (older clients), a gap of more than 120 s is a break. At a break, recent-round features restart, and a forecast resolved across it is void.
- Retention is unchanged: rounds, forecasts and outcomes are deleted 12 h after receipt/issue.

## Backtesting

`npm run backtest:signal -w @aviator/backend -- <file.csv> [--limit N] [--controls] [--out report.md]` replays exactly the live process (`replay()` = the same issue/score code) over a round file and reports everything in the panel, plus results by quarter. `--controls` adds simulated negative controls (independent rounds) and positive controls (planted dependence). Results: [BACKTEST_RESULTS.md](BACKTEST_RESULTS.md).

## Compatibility and deployment

| Server ↓ / extension → | 0.1.5 | 0.2.0 | 0.2.1 |
|---|---|---|---|
| stat-4 or older | works (old card) | SERVER UPDATE NEEDED | SERVER UPDATE NEEDED |
| stat-5 (likely live now) | works | full signal | full signal; continuity is rejected once, then omitted (time rule) |
| stat-5.1 (this repo) | works | full signal (time rule) | full signal with verified continuity |

- **Additive API.** `nextRound` is a new optional field, and `POST /v1/history/backfill` is a new route. `forecast` (stat-4) is still returned, so extension 0.1.5 keeps working against the stat-5 server. Extension 0.2.0 against a stat-4 or older server shows SERVER UPDATE NEEDED and skips the backfill (404). Collection and history keep working.
- **Database.** Migration `0004_round_forecast_ledger.sql` is additive: one column with a default (`game_observations.source`), two new tables, two triggers. Migration `0005_round_continuity.sql` adds three **nullable** columns without a default to `game_observations` (a catalogue-only change in PostgreSQL; no row is rewritten). No existing row is changed by either.
- **Cost.** One forecast costs ~40 ms at 1,000 stored rounds and ~190 ms at 5,000 (measured locally), once per stored round and per analysis request.
- See [the deployment plan](#deployment-plan-not-done-needs-your-approval).

### Deployment plan (not done; needs your approval)

1. Back up the VPS database (`deploy/scripts/backup.sh`) and keep the dump off the server until the new version has run for a day.
2. Put this code where Portainer pulls from (the repository currently has **no commits**, so it must be committed and pushed first, with your approval).
3. Portainer → Stacks → `aviator` → Pull and redeploy. The API container runs pending migrations at start (`0004` if it has not run yet, then `0005`).
4. Check: `POST /v1/analysis` returns `engine.version: "stat-5.1"` and a `nextRound` object with `method: "sequential_v1"`, `currentRun` and `longestRun`. `POST /v1/history/backfill` answers 401 without a token (not 404). After a few rounds, `SELECT count(*) FILTER (WHERE chain_id IS NOT NULL) FROM game_observations` is above 0 (read-only check).
5. Install extension 0.2.1 (`extension/release/aviator-extension-0.2.1.zip`, built for `https://api.shoptrack.site`) as an in-place update.
6. **Rollback:** redeploy the previous image. The new tables and columns are unused by older code and can stay. Extensions 0.1.5, 0.2.0 and 0.2.1 work with either server.

## What the panel shows (0.2.1)

- **Status** (WARMING UP · EXPERIMENTAL ESTIMATE · BASELINE ONLY · VALIDATED SIGNAL, plus SERVER UPDATE NEEDED / ANALYSIS UNAVAILABLE), with the forecast id and issue time.
- **Range chances** for 1.00–1.99× / 2.00–4.99× / 5.00–9.99× / 10.00×+ (they sum to 100% before rounding). Each bar has a tick at the baseline chance, and a **Δ pp** column gives the difference from the baseline. A sentence says whether the estimate is practically the same as the baseline (under 1 pp) or how far it differs, "not validated and may be chance".
- **Most likely range**, and the baseline chances with the number of rounds behind them.
- **2× / 5× / 10× or more**, derived from the same four numbers, with INSUFFICIENT EVIDENCE tags.
- **Last forecast** → actual multiplier and range, ✓ hit / ✗ miss, its log loss vs the baseline's (or "not scored" when rounds may be missing).
- **Scores**: unseen forecasts scored and void; vs baseline ("Too few to judge" below 100, "Not better", "Ahead — not validated", or "Better than baseline" only in the VALIDATED state); top-range hits vs the baseline's; last 50 scored.
- **Sample**: rounds used (live / from the page), verified consecutive run (current, longest), best candidate e-value vs the threshold.
- **Meaning**: for EXPERIMENTAL, "A probability estimate, not a predictive advantage". Only VALIDATED SIGNAL claims an advantage, and it says it is a measured difference in chances, not a guarantee.

## Local preview (simulated rounds)

```bash
npm run preview:panel -w @aviator/extension
```

Open <http://localhost:5174/> (gallery at 360 px; `?width=320` or `?width=420`), or one state at an exact width: `http://localhost:5174/shot?state=validated&width=360`. The states are `warming-up`, `experimental`, `baseline-only`, `validated`, `stale`, `server-update`, `unavailable` and `live`. The preview runs the real panel code, the real engine and ledger steps, and the real client validation in the page, on **simulated** rounds. Nothing is sent anywhere. The live simulation has buttons for +1 round (score + new forecast), Auto, a planted pattern, Fail next refresh, Re-deliver last round and Reload panel. Screenshots: `extension/release/screenshots-0.2.1/`.

## Verifying in Chrome

The Chrome side panel itself could not be screenshotted from my environment, because it needs a real installed extension and a logged-in game page. To check it yourself:

1. Deploy the stat-5 backend (plan above). Against the current server the panel will show **SERVER UPDATE NEEDED**, which is also a valid check of the compatibility path.
2. Update **in place**, so the activation is kept. Unzip `extension/release/aviator-extension-0.2.0.zip` over the same folder you loaded 0.1.5 from, then on `chrome://extensions` press the extension's reload ↻ button. The version should read 0.2.0. Do **not** remove the old one first: removing an extension deletes its stored device id, and a fresh install would use a new device slot.
3. Open the game, allow the site and game frame as before, and open the side panel.
4. After the first new round: **Rounds for the model** in Details should show the backfilled count ("read from the page when collection started"). Once it reaches 20, an EXPERIMENTAL ESTIMATE appears with a forecast id.
5. Watch two rounds. Each time, the top row of **Forecast history** should turn from "…" into ✓/✗ with the actual multiplier, and a new pending row should appear, without pressing Refresh.
6. Reload the game page: the current forecast id stays the same until the next round arrives (no duplicate). Switch the network off for a moment: the card keeps the last estimate with a **STALE** label.

## Limitations

- **No predictive advantage found on any real data I could access** (see EVALUATION_RESULTS.md and BACKTEST_RESULTS.md). No serial dependence is detectable once collection artifacts are removed. The validated state has only been shown on simulated data with a planted pattern.
- Before validation, the experimental estimate can sit several percentage points from the baseline by chance (median of the largest range difference 0.7–3.7 pp on real data). The panel shows that difference next to every range.
- I have no access to your 1xBet rounds. The real-data backtests used other operators' Aviator data of undocumented provenance, plus a non-Aviator crash sequence.
- Detection power is limited: a ±0.10 change in P(≥2×) is validated within 1,000 rounds about half the time; ±0.05 is rarely validated in 3,000.
- Per-round times are server arrival times, and the strip has no round ids. Backfill alignment is value-based. Bursty uploads share a time.
- The 12 h retention limits the evidence any device can accumulate. Validation evidence resets as old forecasts expire.
- The RTP reference (0.97 ÷ m) is an assumption, used only as a weak prior.
