# Engine audit and root cause (before the stat-5 redesign)

Audited 2026-10-28, before any code was changed.

## Repository state

- Branch `main`, **no commits yet**: every file is untracked. Nothing was committed, pushed or deployed during this work.
- Workspaces: `shared/contracts` (zod API contracts), `backend` (Fastify + PostgreSQL), `admin-web` (Next.js), `extension` (MV3, version 0.1.5).
- Baseline tests before changes: backend 196 passed, admin-web 13 passed, extension 238 passed (6 skipped). All green.

## How data flows today

1. **Collection** (`extension/src/content/controller.ts`, `diff.ts`). The content script reads the game's visible results strip. The first read after a page load is a *baseline* and is **never uploaded**. After that, only rounds that appear in front of the baseline are emitted (diff with ≥ 3 overlapping values, ≤ 10 new per read). There are no round ids or per-round times in the strip, so `roundRef` is never sent.
2. **Upload** (`background/queue.ts`). Batches go to `POST /v1/history`, which is idempotent per `batchId`. Batches older than 10 min are dropped.
3. **Storage** (`database/migrations/0001…0003`). `game_observations(id, site_id, multiplier numeric(12,2), round_ref, device_activation_id, received_at DEFAULT now())`. Order = `received_at`, then `id`. Deleted after **12 h** by the retention worker. There is no "source" column and no forecast table.
4. **Analysis** (`POST /v1/analysis` → `engine/analysis-service.ts` → `StatisticalAnalysisProvider` `stat-4`). It reads this device's unexpired rows (max 5,000) and returns a historical `summary` and a walk-forward `forecast` experiment. **Nothing is stored**: no forecast is ever recorded or scored.
5. **Panel** (`extension/src/sidepanel/*`). It refreshes on a 30 s poll, plus a `dataMaybeUpdated` message after each upload (throttled to 8 s). `outlook.ts` turns the forecast into SIGNAL DETECTED / NO RELIABLE SIGNAL / COLLECTING DATA / SERVER UPDATE NEEDED / ANALYSIS UNAVAILABLE.

## Where the limits are enforced

| Rule | Location |
|---|---|
| 100-round minimum (50 train + 50 test) | `backend/src/engine/forecast.ts` `FORECAST_DEFAULTS = { trainInitial: 50, minTestRounds: 50 }`; `computeForecast` returns `insufficient_data` below it |
| History-summary minimum 100 | `shared/contracts/src/analysis.ts` `DEFAULT_MIN_SAMPLE_SIZE`, server env `ANALYSIS_MIN_SAMPLE_SIZE` |
| Permutation test (249 shuffles, below 1,000 rounds) | `forecast.ts` `permutationP`, `PERMUTATION_MAX_ROUNDS` |
| Significance α = 0.05 ÷ 12 (Bonferroni) | `forecast.ts` `computeForecast` (`alpha = ALPHA / comparisons`) |
| ≥ 10 events and ≥ 10 non-events per target | `forecast.ts` `MIN_EVENTS` |
| 120 s gap splits runs | `FORECAST_DEFAULTS.gapSeconds` |
| Client re-check of every claim | `extension/src/sidepanel/outlook.ts` `verifyTarget` |

## Why the current engine gives no usable estimate for each round

1. **The design only shows a number for a validated signal.** In `stat-4` a probability appears only for `validated_model`. On a provably-fair game the expected outcome is "no model beats the base rate", so the honest result is almost always **NO RELIABLE SIGNAL** with nothing for the next round. That is correct statistics, but it does not meet your requirement for a labelled estimate every round.
2. **Nothing is shown before 100 rounds.** Below 100 valid rounds, everything is `insufficient_data` (COLLECTING DATA). With 12 h retention and no backfill, a new device or site waits a long time.
3. **No forecast ledger.** Each request recomputes a batch experiment over the stored window. No individual next-round forecast is issued, stored, matched to its outcome or scored, so per-round accuracy cannot be shown or audited.
4. **No multiplier-range distribution.** Only three overlapping binary targets (≥ 2×, ≥ 5×, ≥ 10×) are modelled. There is no mutually exclusive range forecast that sums to 100%.
5. **The page's existing history is thrown away.** The results strip visible on load (usually 20–60 recent rounds) is used only as a diff baseline and never stored, so warm-up always starts from zero.
6. **Server/extension version mismatch (likely).** The only VPS package in the repo (`dist/aviator-vps-0.1.0.tar.gz`, 2026-10-27 15:08) contains engine **`stat-2`** (no `forecast` field). Extension 0.1.5 needs `stat-4`. `/health` does not report the engine version (checked: `https://api.shoptrack.site/health` returns only `{"status":"ok","version":"0.1.0"}`), and `/v1/analysis` needs a device session I do not have. **I could not confirm which engine is live.** If you have seen NO RELIABLE SIGNAL, `stat-4` was deployed some other way. If you have seen SERVER UPDATE NEEDED, the VPS still runs `stat-2`.

## Historical data actually available to me

| Source | What exists | Usable? |
|---|---|---|
| Local extension storage | Only an upload queue in `chrome.storage.session` (cleared when the browser closes). No local round history is kept. | No |
| Local dev database (`backend/.local-pg`) | 32 rows, site `devfixture` (the simulated local test page, 2026-10-14) | No: simulated, not Aviator |
| Production VPS database | This device's rounds from the last 12 h | Not accessible from here: no credentials, and you did not authorise it |
| The game's own interface | The results strip (about 25–60 most recent multipliers, no round id or time) | Yes, going forward, through the new backfill (see `RESEARCH.md`) |

**I have no real historical Aviator rounds.** All backtests in this work use simulated rounds and are labelled as simulated.

## What is preserved

Activation, sessions, device limits, site permissions, collection, upload and the 12 h retention are unchanged. The database changes are additive (migration `0004`), and no existing row is modified or deleted. `stat-4`'s `forecast` field is still returned, so extension 0.1.5 keeps working against the new server.

---

# Second audit: why 0.2.0's output is still not useful (stat-5 → stat-5.1)

Audited 2026-10-28, before any change, after reading ROUND_SIGNAL.md, RESEARCH.md, BACKTEST_RESULTS.md and RELEASE-0.2.0.md and re-reading the models, scoring, ledger, collector, contracts and panel. Data quality: [DATA_QUALITY.md](DATA_QUALITY.md). Direct tests and baseline comparison: [EVALUATION_RESULTS.md](EVALUATION_RESULTS.md).

## Live compatibility (checked without credentials)

`POST https://api.shoptrack.site/v1/history/backfill` answers **401**, not 404, and an unknown route answers 404. So the VPS serves the stat-5 backfill route: stat-5 is most likely deployed, from outside this repository (still no commits; the only VPS package in `dist/` is stat-2). I could not confirm the engine version, whether migration 0004 ran, or which extension version you have installed. Extension 0.2.0 is compatible with stat-5. 0.2.1 works with both stat-5 and stat-5.1 (section "Compatibility" in ROUND_SIGNAL.md).

## Root causes

| # | Cause | Kind | Evidence | What changed |
|---|---|---|---|---|
| 1 | **There is nothing to predict.** On every real series, once the data are cleaned, no serial dependence is detectable, and no learning model beats the baseline after multiple-testing correction except under a level shift that a fixed forecast exploits equally well | property of the game (provably fair) | EVALUATION_RESULTS.md summary; positive and negative controls behave as designed | Nothing can make the estimate *more predictive*. The baseline stays; no model was added. The panel now says what the estimate is (below) |
| 2 | **"EXPERIMENTAL ESTIMATE" looked like a prediction.** The panel showed the model average with no comparison. On real data it moves away from the baseline without any validated reason: the largest range difference per forecast has a median of 0.7–3.7 percentage points per operator, a 90th percentile of 1.4–5.9 pp, and reaches 13–29 pp at times. Its overall log loss is the same as the baseline's, so these swings are noise that *looks* like a signal | presentation | replay of the four PHIMAS series (experimental-state forecasts); backtests: shown − baseline log loss ≈ 0.00002 except ODIBETS | Each range now shows the baseline as a tick and a "Δ pp" column, with a sentence "Practically the same as the baseline (largest difference x pp)" or "differs by up to x pp; not validated". The meaning text starts "A probability estimate, not a predictive advantage" |
| 3 | **A lead over the running baseline was called "Better than baseline"** even when it came from a level shift, not dependence (ODIBETS: −0.0041, interval below 0, while the dependence tests were null and a fixed RTP forecast did better) | presentation / interpretation | EVALUATION_RESULTS.md, ODIBETS | Unless the state is VALIDATED SIGNAL, such a lead is shown as **"Ahead — not validated"** |
| 4 | **Rounds could be lost without a trace.** A diff re-sync, a vanished list, an ambiguous change or a dropped queue batch left a hole. If the next upload arrived within 120 s, the server treated the rounds as consecutive, so forecasts could be scored against a round that was not the next one played. Conversely, a delayed upload (> 120 s) voided forecasts whose next round was verified | data quality | code audit (controller.ts, queue.ts, engine.ts `resolve`) | Collector continuity (`chain`, `index`), migration `0005` (3 nullable columns), break = continuity evidence first, time rule only for old clients |
| 5 | **Warm-up counted any 20 stored rounds,** not 20 consecutive verified ones | rule | `issueWith` | The first estimate now needs a verified run of 20 (`longestRun`). `currentRun` / `longestRun` are in the response and in the panel |
| 6 | **The last result and rolling performance were hidden** in the history list and Details | presentation | panel audit | "Last forecast … → actual … ✓/✗" and the last-50 hit rate / log loss vs baseline are on the main card |
| 7 | **My own earlier analysis had an ordering bug** in the third-party loader (milliseconds instead of microseconds). That created spurious dependence and slightly wrong backtest figures | analysis error | DATA_QUALITY.md §5 | Fixed, with a test. BACKTEST_RESULTS.md regenerated, with a correction note |
| 8 | **12 h retention** caps evidence at roughly 1,500–2,000 rounds per device per day. A real but small effect could never be validated within it | configuration (privacy decision) | positive controls: ±0.05 needs ≫ 3,000 rounds | Not changed: retention is your decision. Listed as the main remaining limit |

## What was deliberately not done

- **No new models.** The comparison shows the existing candidates already lose to the baseline out of sample. The streak and previous-round controls show no "due" effect. More models would only raise the multiple-testing bar and the chance of over-fitting.
- **The baseline prior was not strengthened to the RTP reference**, although the fixed 0.97 ÷ m forecast scored slightly better on three series. The gain is ≤ 0.0006 log loss outside ODIBETS. It depends on the operator's RTP setting and Spribe's unpublished hash-to-multiplier mapping. Choosing it from these third-party files would be selecting on a sample that is not your game.
- **Nothing was deployed, committed, migrated or installed.** Migration 0005 exists in the repository only.
