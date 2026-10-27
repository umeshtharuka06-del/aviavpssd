# Next-round forecast experiment (engine `stat-3`)

The side panel's **Next Round: What to Expect** shows the result of an experiment the server runs on
**this device's** stored rounds: can anything in the recent rounds forecast whether the next round
reaches 2×, 5× or 10× better than the plain share of earlier rounds? The panel shows an estimated
chance with its 95% range, and how that estimate performed on rounds it had not seen. It never
forecasts a multiplier value and never shows an invented score.

> Estimates are chances, not guarantees. Not betting advice.

## Audit: what existed before (`stat-2`)

- **Collection.** The content script reads only the completed-results list. The first list after a
  page load is a baseline, then only newly added rounds are uploaded (`POST /v1/history`, oldest →
  newest, de-duplicated by `batchId` and `roundRef`).
- **Storage.** `game_observations(multiplier numeric(12,2), received_at DEFAULT now(), device_activation_id, site_id)`.
  There is no per-round time: every round of one upload batch gets the same `received_at`, and the
  order inside a batch is the insert order (`id`). History is kept 12 h.
- **Analysis.** `POST /v1/analysis` reads this device's unexpired rows for the site, newest first,
  at most 5,000, and `stat-2` returned counts, shares ≥ 2×/5×/10×, below 2×, average, sample size and
  freshness. It made **no** forecast, had no model, no validation and no uncertainty.

## Method

Per threshold T, the event is "multiplier ≥ T". Code: `backend/src/engine/forecast.ts`; contract:
`ForecastSchema` in `shared/contracts/src/analysis.ts`.

| Step | Rule |
|---|---|
| Order | Rounds are put oldest → newest (`received_at`, then `id`). |
| Runs | A gap of more than 120 s between stored rounds starts a new run. Recent-round features never cross a run boundary, and the first round of a run is never scored. |
| Walk-forward | The first 200 rounds only train. After that, in blocks of `refitEvery` rounds (100; larger for long histories so there are at most ~20 refits), every model is refitted on **all rounds before the block** and then forecasts each round t of the block from rounds **< t**. |
| Leakage guard | Models only receive a `Past` view that throws on any read of round t or later. Tested: changing every round after t leaves all forecasts up to t identical. |
| Minimum | 400 valid rounds, and at least 200 scored test rounds, or the status is `insufficient_data` and nothing is shown but progress. |

### Models

| Model | Uses recent rounds | Forecast |
|---|---|---|
| `base_rate` — **no-predictability baseline** | no | (hits + ½) ÷ (rounds + 1) over all earlier rounds |
| `rtp_reference` — fixed reference | no | 0.97 ÷ T (Spribe's published RTP 97%, *if* it held at every cash-out target — unverified). Scored for comparison, never used as the estimate. |
| `rolling_50` | yes | share in the last 50 rounds (tests drift) |
| `after_previous` | yes | share after a hit / after a miss, shrunk toward the base rate (10-round prior) |
| `since_last_hit` | yes | share by misses in a row (0, 1, 2, 3–5, 6–10, 11+), shrunk the same way |
| `logistic_recent` | yes | ridge logistic regression (λ = 1, standardised with training data only) on: previous log multiplier, mean log multiplier of the last 5 and 20, share of hits in the last 10, log(1 + misses in a row) |

### Scores (test rounds only)

- **Log loss** (mean −log p of what happened) and **Brier score**. **Skill** = 1 − model log loss ÷
  base-rate log loss.
- **Improvement test:** one-sided Diebold–Mariano test on per-round log-loss differences with a
  Newey–West variance (lag ⌊n^⅓⌋).
- **Calibration:** Spiegelhalter Z (|Z| < 1.96). For the base rate this plain test is wrong — the
  base rate is itself estimated from earlier rounds, and on simulated independent rounds the plain
  test failed 11.8% of the time instead of 5%. The base rate therefore uses a **parametric bootstrap**
  (199 replays of the whole walk-forward on simulated independent rounds at the observed rate);
  measured false-fail rate 5.7%.

### Decision per threshold

1. A recent-round model is **validated** only if: skill > 0, Diebold–Mariano p < 0.05 ÷ 12 (4 models
   × 3 thresholds, Bonferroni), calibration passed, and the test rounds contain ≥ 10 events and
   ≥ 10 non-events. The best validated model gives the estimate (`validated_model`), with a
   delta-method / Wilson 95% interval.
2. If a model is validated but the latest stored round is more than 120 s old, its inputs are not
   the rounds just before the next one: the base rate is shown (`validated_model_not_current`).
3. Otherwise the estimate is the base rate over all rounds with a Wilson 95% interval
   (`no_predictive_value`) — but only if the base rate passed its calibration check (bootstrap
   p ≥ 0.05 ÷ 3). If not, the chance changed over time and **no estimate** is shown (`not_calibrated`).

The **reliability** line is these measured results, not a score: the number of held-out rounds and
how many targets passed calibration. Details lists, per target, the best recent-round model with its
skill and p-value against the required level, the base-rate calibration p-value, and the RTP
reference's skill.

## Results on simulated data

Measured with this code (deterministic seeds; see `backend/tests/forecast.test.ts`):

| Scenario | Result |
|---|---|
| Independent rounds from P(M ≥ m) = 0.97 ÷ m, 40 histories × 1,500 rounds | 0 histories with any validated model; estimates within their 95% range of the true 0.97 ÷ T |
| Same, 30 histories × 800 rounds (test suite) | ≤ 2 allowed, passes |
| Base-rate calibration on independent rounds, 600 tests | bootstrap p < 0.05 in 5.7%; estimate withheld for some target in 6% of histories |
| Planted dependence: P(≥ 2×) = 0.485 ± e after a hit / miss, 1,500 rounds | detected (validated) in 1/20 at e = 0.03, 3/20 at 0.05, 9/20 at 0.08, 18/20 at 0.10 |
| Planted drift: RTP 0.97 → 0.80 halfway, 1,500 rounds | base rate flagged in only 2/20 — weak |

So with the ~1,000–3,000 rounds a device collects in 12 h, the test can find a strong dependence
(about ±10 points on the 2× chance) and will rarely claim one that does not exist. Smaller effects
would usually go undetected. **On a fair provably-random game the expected and honest outcome is
"Tested · no pattern found", and the estimate shown is the base rate** — which is the best available
forecast for independent rounds and is the same before every round.

Speed: about 60 ms for 1,500 rounds and 300 ms for 5,000 (warm), and the result is cached per input
until a new round arrives.

## Running it on your real rounds (read-only)

The test can be repeated offline on exported data. Nothing below writes to the database. Run it only
if you choose to; it reads one device's unexpired rounds.

```sql
-- on the VPS, inside the postgres container (psql): one device, one site, oldest first
\copy (SELECT multiplier, received_at FROM game_observations WHERE device_activation_id = <id> AND site_id = '<site>' AND received_at >= now() - interval '12 hours' ORDER BY received_at, id) TO '/tmp/rounds.csv' CSV HEADER
```

```
npm run backtest -w @aviator/backend -- rounds.csv
```

It prints, per threshold, the status, the estimate and range, and every model's log loss, skill,
p-value and calibration.

## Compatibility and deployment

- **API:** additive. `forecast` is an optional field of the analysis response. Older extensions strip
  it (their schema is not strict), and this extension shows "Server update needed" against a `stat-2`
  server. No database migration, no new environment variable.
- **Plan (not done; each step needs your approval):** back up as in `COMPACT_DASHBOARD.md` → push
  to `main` → Portainer → Stacks → `aviator` → Pull and redeploy → check that `POST /v1/analysis` returns
  `engine.version: "stat-3"` and a `forecast` object → install the new extension. **Rollback:** redeploy the
  previous commit (no schema change).

## Limitations

- No per-round timestamps: runs are split on upload gaps, so a short outage can hide missed rounds
  (features would then treat non-adjacent rounds as adjacent). Rounds reported by the page in a burst
  share one time.
- 12 h retention and 5,000 rows cap the sample; small effects cannot be detected (see power above),
  and drift detection is weak.
- Each device is tested only on its own rounds; nothing is pooled.
- The intervals cover parameter uncertainty only, assuming the model's form; the ridge-logistic
  interval is a delta-method approximation.
- The RTP-implied chances (0.97 ÷ T) are an unverified assumption and are only scored, never shown as
  the estimate.
- Not verified against live production data: I have no access to it.
