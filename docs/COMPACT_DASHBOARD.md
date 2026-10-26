# Compact statistics dashboard

The side panel shows a short, descriptive summary of the rounds **this device** has observed on the
current site. It reports past results only. It does not predict the next round.

> Past results do not predict future outcomes. This is not a signal, prediction, or betting recommendation.

## What the panel shows

Main view, top to bottom:

| Item | Source |
|---|---|
| Connection status (Connected / Offline / Checking) | result of the latest background → API call |
| Site + one-line collection status (recording / waiting / paused / unreadable / game not on this page) plus any error | the active tab's frame reports, upload status, last refresh error |
| **Valid rounds scanned** + sufficiency chip (*No data yet* / *Collecting data · n of min* / *Sufficient sample*) | `summary.sampleSize`, `summary.sufficiency`, `summary.minSampleSize` |
| **≥ 2× / ≥ 5× / ≥ 10×**, each labelled "Historical frequency", with "count of n" | `summary.thresholds` |
| **Historical rounds below 2×** (the combined indicator), with count and a one-line explanation | `summary.below2x` |
| Last-updated time + Refresh | client clock at the last successful update |
| **Details** (collapsed): sample size, invalid values excluded, threshold counts, historical average multiplier, data source, last successful update, latest round age, errors, formulas | same `summary` |

Removed from the user-facing dashboard **and** from the API: "Recent vs your baseline", the last-50 /
100 / 250 / 500 rolling windows and their table, Wilson confidence intervals, low-multiplier streaks,
the high-multiplier distribution, the signal classifications, the 14-row statistics list, and the
popup's duplicate analysis summary. The popup now only handles activation/site setup and opens the
panel.

## Formulas

`n` = valid observed rounds: completed rounds whose multiplier is a finite number within
1.00–1,000,000 (NaN, ±Infinity and out-of-range values are excluded and counted separately).

| Metric | Formula |
|---|---|
| Historical frequency ≥ T (T = 2, 5, 10) | count(multiplier ≥ T) ÷ n × 100 |
| Historical rounds below 2× (combined indicator) | count(multiplier < 2) ÷ n × 100 = 100 − frequency(≥ 2×) |
| Historical average multiplier (Details only) | sum(multiplier) ÷ n |
| Sufficiency | `no_data` if n = 0; `collecting` if n < minimum; otherwise `sufficient` |

- A value exactly equal to a threshold counts as reaching it.
- The three threshold frequencies overlap (every ≥10× round is also ≥5× and ≥2×). They are **never**
  averaged or added, and nothing is labelled "probability of crashing next round".
- The combined indicator is purely descriptive. It is the complement of the ≥2× frequency, so it adds
  no information beyond it and does not improve any kind of prediction.
- The average is skewed by rare very high rounds. It is not an "expected" next multiplier.
- With n = 0 every ratio is `null` and the panel shows "No data yet", never 0%.
- Below the minimum sample size the tiles show **Collecting data** instead of a percentage. The real
  counts ("20 of 37") stay visible. The minimum is the server setting `ANALYSIS_MIN_SAMPLE_SIZE`
  (default **100**, allowed 10–5000) and is sent to the client in `summary.minSampleSize`.
- A larger sample describes past rounds more precisely. It does not make the next result predictable.

Implementation: `backend/src/engine/summary.ts` (calculation) and `shared/contracts/src/analysis.ts`
(contract). The extension only formats what the server returns.

## Data model: whose rounds, where stored

- **This device only.** Rounds are read in this browser and stored on the private server under this
  device's activation (`device_activation_id`) and the site key of the top page, for 12 hours. Another
  device on the same subscription has its own separate history. No data is pooled across users, and
  the server does not assume that two users on the same domain see the same game server.
- **No local copy of the history.** The device identifier is the random per-installation UUID that
  already exists (`chrome.storage.local`). No fingerprinting is added. The server is the only place
  history is kept, so it survives navigation, panel close/reopen and browser restarts, and it is still
  deleted on the 12-hour schedule. The upload queue lives in `chrome.storage.session` for at most 10
  minutes. Rounds that are still unsent when the browser closes are lost, so the count is lower, never
  inflated.
- **Separation:** history is per (device, site key). The site key is derived from the registrable
  domain of the top page. Separate games or tables on the same domain cannot be told apart, because
  the result list carries no game/table identity.

## Round collection

- Only the **completed-results list** is read. The running multiplier is a single changing element,
  not a list, so it is never read as a result (tested: `controller.test.ts`, "only completed rounds").
- The first list seen after a page load or SPA navigation is a **baseline** and is never uploaded.
  After that, only rounds that newly appear at the head of the list are sent, so a reload never
  re-sends rounds (tested).
- De-duplication: batch retries reuse their `batchId` (the server stores a batch once). Rows with a
  `roundRef` are unique per device. One content script runs per frame (guarded against double
  injection) with one throttled MutationObserver.

## Side panel lifecycle

**Why it "disappeared":** the statistics were partly shown in the toolbar **popup**. Chrome always
closes a popup as soon as the user clicks the page. No API keeps a popup open. In addition, the side
panel replaced its dashboard with a loading or "no game" state on every page load, because the
reloaded page had not reported its frames yet.

**What changed:**

- Statistics are shown only in the **side panel**. Chrome keeps it open while the user clicks,
  scrolls and navigates. The popup's **Open statistics panel** button opens it with
  `chrome.sidePanel.open({ windowId })` inside the click (a user gesture), and the user can also open it
  from Chrome's side-panel menu. The panel is window-wide (manifest `side_panel.default_path`, no
  per-tab `setOptions`), so switching tabs does not close it.
- The extension never force-opens, re-opens or closes the panel. No `setPanelBehavior` and no
  `open()` outside a click (tested in `manifest.test.ts`).
- Navigation keeps the dashboard. The last game site detected in a tab stays on screen, marked "Game
  not on the current page — showing saved history", until a **different** site is detected in that
  tab. A page that finishes loading is re-checked after 3 s.
- Refresh: one refresh at a time, with overlapping triggers coalesced. Statistics are requested at most
  once per 8 s. Triggers are the background's `dataMaybeUpdated` message after an upload with new
  rounds, a 30 s fallback poll that only runs while the panel is visible (backing off to 120 s on
  errors), tab switch, page load, and Refresh. Responses for a site the user has already left are
  discarded. Listeners are registered once per panel page and tab events from other windows are
  ignored.

**Not guaranteed (Chrome limitations):**

- The user can close the side panel at any time, and Chrome may unload it in some situations, for
  example when the window closes. Reopening it shows the stored history at once.
- A panel open in one window does not follow the user into another window. Each window has its own
  panel.
- The popup cannot be made persistent.
- While the panel is hidden or closed, its page does not run. Collection and upload continue in the
  content script and service worker, and the panel catches up when shown again.

## Deployment

Not deployed. Every step below needs your approval.

1. **Backup** (same as before):
   `docker exec aviator-postgres-1 sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc --exclude-table-data=game_observations --exclude-table-data=ingest_batches' > aviator-$(date -u +%Y%m%dT%H%M%SZ).dump`
2. **Backend.** No database migration. Push to `main`, then in Portainer → Stacks → `aviator` →
   **Pull and redeploy**. `ANALYSIS_PROVIDER` must stay `statistical`.
   Optional: to change the minimum sample size from 100, add
   `ANALYSIS_MIN_SAMPLE_SIZE: ${ANALYSIS_MIN_SAMPLE_SIZE:-100}` to `x-backend-env` in
   `deploy/vps/docker-compose.yml` and set the variable in the stack. That production configuration
   change was intentionally **not** made.
3. **Verify:** `POST /v1/analysis` returns `engine.version: "stat-2"` and a `summary` object, with no
   `metrics`, `patterns` or `signal`.
4. **Extension:** bump `extension/package.json` `version`, then
   `EXTENSION_API_BASE_URL=https://api.yourdomain.com npm run package -w @aviator/extension` and upload
   `extension/release/aviator-extension-<version>.zip`.
5. **Order and compatibility:** either order works. Older extensions talking to the new server show
   the short legacy `items` list in their popup and a "no structured metrics" fallback in their panel.
   The new extension talking to an old server shows "The server did not return statistics…" until the
   backend is redeployed.
6. **Admin site:** unchanged.

**Rollback:** redeploy the previous commit. There are no schema changes, so no SQL is needed.
