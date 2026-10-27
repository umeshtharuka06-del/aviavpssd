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
