# Next-round forecast experiment (engine `stat-4`)

> **Superseded in the panel** by the round-by-round signal (engine `stat-5`): [ROUND_SIGNAL.md](ROUND_SIGNAL.md). The `stat-5` server still returns this `forecast` field, so extension 0.1.5 keeps working.

The side panel's **Next round signal** shows the result of an experiment the server runs on
**this device's** stored rounds: can anything in the recent rounds forecast whether the next round
reaches 2×, 5× or 10× better than the plain share of earlier rounds? The panel shows one status
(SIGNAL DETECTED / NO RELIABLE SIGNAL / COLLECTING DATA / SERVER UPDATE NEEDED / ANALYSIS UNAVAILABLE,
see [COMPACT_DASHBOARD.md](COMPACT_DASHBOARD.md)) and a status per target. An estimated chance with
its 95% range appears only for a validated signal. It never forecasts a multiplier value and never
shows an invented score.

**A validated signal is not a prediction of the next round.** It means that, on past rounds the
model had not seen, its probabilities were measurably better than the base rate. The next round can
still go either way.

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
| Walk-forward | The first 50 rounds only train. After that, in blocks of `refitEvery` rounds (50; larger for long histories so there are at most ~20 refits), every model is refitted on **all rounds before the block** and then forecasts each round t of the block from rounds **< t**. |
| Leakage guard | Models only receive a `Past` view that throws on any read of round t or later. Tested: changing every round after t leaves all forecasts up to t identical. |
| Minimum | **100** valid rounds (50 training + 50 test), and at least 50 scored test rounds, or the status is `insufficient_data` and nothing is shown but progress. The minimum only starts the test. |
| Per target | A target is judged only if its test rounds hold at least 10 rounds reaching it **and** at least 10 not reaching it; otherwise `insufficient_events`, no estimate. |

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

0. Too few events or non-events in the test rounds: `insufficient_events`, no estimate, and no model
   can be validated.
1. A recent-round model is **validated** only if: skill > 0, Diebold–Mariano p < 0.05 ÷ 12 (4 models
   × 3 thresholds, Bonferroni), calibration passed, the test rounds contain ≥ 10 events and
   ≥ 10 non-events, and, **below 1,000 rounds**, an exact permutation test also gives p < 0.05 ÷ 12
   (see below). The best validated model gives the estimate (`validated_model`), with a
   delta-method / Wilson 95% interval.
2. If a model is validated but the latest stored round is more than 120 s old, its inputs are not
   the rounds just before the next one: the base rate is shown (`validated_model_not_current`).
3. Otherwise the estimate is the base rate over all rounds with a Wilson 95% interval
   (`no_predictive_value`) — but only if the base rate passed its calibration check (bootstrap
   p ≥ 0.05 ÷ 3). If not, the chance changed over time and **no estimate** is shown (`not_calibrated`).

The panel shows these measured results, not a score: the number of held-out rounds, and per target
whether it beat the base rate (skill, p-value against the required level). Details lists, per target,
the events in the test rounds, the best recent-round model with its skill, p-value and exact-test
p-value, the base-rate calibration p-value, and the RTP reference's skill. The extension re-checks
every claimed signal against these rules (`verifyTarget` in `extension/src/sidepanel/outlook.ts`) and
shows ANALYSIS UNAVAILABLE instead of a signal if any rule is not met.

### Why the minimum could drop from 400 to 100, and what had to be added

Lowering only the number was not safe. Measured on fair simulated rounds (300 histories each), with
the old rules but 50 + 50 rounds:

| Rounds | 100 | 150 | 200 | 300 | 400 | 700 | 1,000 |
|---|---|---|---|---|---|---|---|
| Histories with a false "validated" model | 2.3% | 2.7% | 1.7% | 1.0% | 0.7% | 0.3% | 0% |

The Diebold–Mariano p-value uses a normal approximation that is too optimistic on short, skewed
samples: one fair 100-round history gave p = 0.000015 for a model with no real skill. So, below
1,000 rounds, a candidate that passes every other check must also pass an **exact permutation
test**: the multipliers are shuffled 249 times (run breaks stay in place), the whole walk-forward is
repeated, and the candidate passes only if no shuffle does as well as the real order
(p = 1 ÷ 250 = 0.004 < 0.0042). If rounds are independent, every order is equally likely, so this
passes at most 0.4% of the time per comparison, whatever the sample size. It runs only for the best
candidate per target, and only when that candidate already passed everything else.

With it (300 fair histories each): false validations 1.3% at 100 and 150 rounds and 0–0.3% at 200+,
all below the nominal 5% family-wise level. The other requirements (significance level, calibration,
minimum events) are unchanged.

**What 100 rounds can and cannot judge.** With 50 test rounds, 2× (about 24 events) is judged; 5×
(about 9–10 events) in roughly half of histories; 10× (about 5 events) almost never: more than 90% of
fair 100-round histories show it as *Collecting*. About 150 rounds are typically needed for 10×.
Detection power is low at this size: a strong planted dependence (±20 points on the 2× chance) was
found in 4 of 40 histories at 100 rounds, 24 of 40 at 200, and 37 of 40 at 400.

## Results on simulated data

Measured with this code (deterministic seeds; see `backend/tests/forecast.test.ts`):

| Scenario | Result |
|---|---|
| Independent rounds from P(M ≥ m) = 0.97 ÷ m, 300 histories × 1,000 rounds | 0 histories with any validated model |
| Same, 300 histories × 100 / 150 / 200 rounds (with the permutation test) | 1.3% / 1.3% / 0.3% with a (false) validated model |
| Same, 30 histories × 800 rounds (test suite) | ≤ 2 allowed, passes |
| Base-rate calibration on independent rounds, 600 tests | bootstrap p < 0.05 in 5.7%; estimate withheld for some target in 6% of histories |
| Planted dependence: P(≥ 2×) = 0.485 ± e after a hit / miss, 1,500 rounds | detected (validated) in 0/20 at e = 0.03, 3/20 at 0.05, 11/20 at 0.08, 15/20 at 0.10 |
| Same, e = 0.20, 40 histories × 100 / 200 / 400 rounds | detected in 4 / 24 / 37 |
| Planted drift: RTP 0.97 → 0.80 halfway, 1,500 rounds | base rate flagged in only 2/20 — weak |

So with the ~1,000–3,000 rounds a device collects in 12 h, the test can find a strong dependence
(about ±10 points on the 2× chance) and will rarely claim one that does not exist. Smaller effects
would usually go undetected. **On a fair provably-random game the expected and honest outcome is
"Tested · no pattern found", and the estimate shown is the base rate** — which is the best available
forecast for independent rounds and is the same before every round.

Speed: about 100 ms for 1,500 rounds and 300 ms for 5,000 (warm); below 1,000 rounds usually under
100 ms, worst case about 0.4 s when the permutation test runs on a strong pattern. The result is
cached per input until a new round arrives.

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

It prints, per threshold, the status, the events in the test rounds, the estimate and range, and
every model's log loss, skill, p-value, exact-test p-value and calibration, with the required level.

## Compatibility and deployment

- **API:** additive. `forecast` is an optional field of the analysis response. Older extensions strip
  it (their schema is not strict). This extension (0.1.5) shows SERVER UPDATE NEEDED against a server
  without a forecast it can read (`stat-2`, or the never-deployed `stat-3` / `walk_forward_v1`): the
  client drops an unreadable forecast instead of failing the whole response, so the round history
  keeps working. No database migration, no new environment variable.
- The 100-round forecast minimum is a code constant (`FORECAST_DEFAULTS`), sent to the client as
  `forecast.minSampleSize`. It is separate from the history-summary minimum `ANALYSIS_MIN_SAMPLE_SIZE`
  (also 100 by default; it only controls the past-shares line).
- **Plan (not done; each step needs your approval):** back up as in `COMPACT_DASHBOARD.md` → push
  to `main` → Portainer → Stacks → `aviator` → Pull and redeploy → check that `POST /v1/analysis` returns
  `engine.version: "stat-4"` and a `forecast` object with `method: "walk_forward_v2"` and `minSampleSize: 100` → install the new extension. **Rollback:** redeploy the
  previous commit (no schema change).

## Limitations

- No per-round timestamps: runs are split on upload gaps, so a short outage can hide missed rounds
  (features would then treat non-adjacent rounds as adjacent). Rounds reported by the page in a burst
  share one time.
- 12 h retention and 5,000 rows cap the sample; small effects cannot be detected (see power above),
  and drift detection is weak. Near 100 rounds only very strong patterns could be detected at all,
  and 10× usually cannot be judged yet.
- The permutation test assumes that, with no pattern, every ordering of the stored rounds is equally
  likely; a slow drift in the chance also breaks that assumption, which the calibration check targets.
- Each device is tested only on its own rounds; nothing is pooled.
- The intervals cover parameter uncertainty only, assuming the model's form; the ridge-logistic
  interval is a delta-method approximation.
- The RTP-implied chances (0.97 ÷ T) are an unverified assumption and are only scored, never shown as
  the estimate.
- Not verified against live production data: I have no access to it.
