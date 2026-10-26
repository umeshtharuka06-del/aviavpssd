# Device Dashboard Upgrade — Deployment & Delivery

> **Superseded in part by [COMPACT_DASHBOARD.md](COMPACT_DASHBOARD.md):** the rolling windows, Wilson
> intervals, recent-vs-baseline patterns and signal report described below were removed and replaced by a
> single `summary` field. Device isolation, migration `0003` and the side panel remain as described here.

This upgrade turns the per-site statistics into a **device-scoped, empirical analysis dashboard**
(Phases 2–9). It is **code-complete and tested locally** (backend 200 tests, extension 188 + 6
gated-skipped, admin 13; typecheck clean; production builds succeed). **Nothing has been deployed.**
The steps below are the pending deployment actions and require your approval to run.

## What changed (summary)

- **Device isolation** — analysis is now scoped to the authenticated device (never a client id);
  round de-duplication is per-device so histories are never merged across devices.
- **Empirical metrics** — ≥2/5/10× and <2/5/10× frequencies with nested-consistent denominators,
  rolling windows (50/100/250/500 + full), mean/median, freshness, and **95% Wilson CIs**.
- **Recent patterns** — recent-vs-baseline trend deltas, low-multiplier streaks, high-multiplier
  distribution — all descriptive, with explicit "not a prediction" wording.
- **Signal engine** — one report with a descriptive classification (insufficient / elevated / near /
  reduced vs baseline / stale) from rules fixed in advance. No fabricated next-round probability.
- **Chrome Side Panel + compact dashboard** — persistent while the game page is used; the popup is a
  compact summary with an "Open analysis dashboard" button.
- **Automatic refresh** — polling with backoff + event-driven refresh after uploads; loading /
  offline / stale states. The game page is never reloaded.

The new structured response fields (`metrics`, `patterns`, `signal`) are **optional/additive**, so
older extension builds and the mock provider keep working unchanged.

## Modified files

### Shared contracts (`shared/contracts/src`)
- `analysis.ts` **(new)** — `AnalysisMetrics`, `RecentPatterns`, `SignalReport` + helper schemas.
- `index.ts` — export `analysis.js`.
- `customer.ts` — add optional `metrics` / `patterns` / `signal` to `AnalysisResponse`.

### Backend (`backend/src`)
- `engine/metrics.ts` **(new)** — windows, thresholds, freshness, quality.
- `engine/wilson.ts` **(new)** — 95% Wilson score interval.
- `engine/trends.ts` **(new)** — recent-vs-baseline comparisons, streaks, high distribution.
- `engine/signal-engine.ts` **(new)** — descriptive classification report.
- `engine/statistical-provider.ts` — compute + attach `metrics`/`patterns`.
- `engine/provider.ts` — `AnalysisOutput` gains optional `metrics`/`patterns`.
- `engine/analysis-service.ts` — **device-scoped query**; build + include the signal report.
- `ingestion/history.ts` — per-device `ON CONFLICT (device_activation_id, site_id, round_ref)`.
- `api/routes/customer.ts` — pass `auth.deviceActivationId` into analysis.

### Database (`database/migrations`)
- `0003_device_scoped_analysis.sql` **(new)** — see migration note below.

### Extension (`extension`)
- `manifest.template.json` — add `sidePanel` permission + `side_panel.default_path`.
- `build.mjs` — build the side-panel entry and copy its HTML/CSS.
- `scripts/validate-extension.mjs` — validate `side_panel.default_path` and its assets.
- `src/sidepanel/sidepanel.html` · `sidepanel.css` · `sidepanel.ts` · `dashboard.ts` · `site.ts` **(new)**.
- `src/popup/view.ts` — compact analysis summary + "Open analysis dashboard" button.
- `src/popup/popup.ts` — open the side panel from the popup (cached window id).
- `src/background/service-worker.ts` — broadcast `dataMaybeUpdated` after a successful upload.

### Tests
- Backend **(new)**: `device-isolation`, `metrics`, `wilson`, `trends`, `signal-engine`, `backcompat`.
- Backend **(updated)**: `analysis`, `history`, `retention`, `devices`.
- Extension **(new)**: `dashboard`, `sidepanel-site`. **(updated)**: `manifest`.

## Migration note (0003)

`0003_device_scoped_analysis.sql` is **additive and non-destructive** — it touches **indexes only**,
on the temporary `game_observations` table (12 h retention). It:
1. adds a read index `(device_activation_id, site_id, received_at DESC)` for the device-scoped query;
2. **rebuilds** the round-dedup unique index from `(site_id, round_ref)` to
   `(device_activation_id, site_id, round_ref)` so each device keeps its own rounds.

No table is dropped, **no row is deleted**, and the `pgdata` volume is untouched. Migrations are
forward-only (no down-migration). It is applied automatically on deploy by the `migrate` compose
service (`api` and `retention-worker` depend on it completing).

## Deployment

> Back up the database first. **Do not deploy without approval.**

### 1. Backend (VPS — Portainer Git stack)

The required analysis provider must be live: set **`ANALYSIS_PROVIDER=statistical`** in the stack
environment variables. Left at the default `mock`, the API returns test-data placeholders and the
dashboard shows no empirical metrics.

1. Push this branch to GitHub (the Portainer stack tracks `refs/heads/main`).
2. **Back up** (Portainer has no compose dir on the host):
   ```bash
   sudo install -d -m 700 /var/backups/aviator && docker exec aviator-postgres-1 sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc --exclude-table-data=game_observations --exclude-table-data=ingest_batches' | sudo tee /var/backups/aviator/aviator-$(date -u +%Y%m%dT%H%M%SZ).dump >/dev/null
   ```
3. In Portainer → **Stacks → `aviator`**, confirm `ANALYSIS_PROVIDER=statistical` under
   **Environment variables**, then **Pull and redeploy**. Images rebuild (`pull_policy: build`) and
   `migrate` applies `0003` before `api`/`retention-worker` restart.
4. Expected: `postgres` healthy → `migrate` exited (0) → `api` + `retention-worker` healthy → `caddy` running.

Plain `docker compose` equivalent (server with `deploy/vps/.env`):
```bash
cd deploy/vps
bash ../scripts/backup.sh
docker compose up -d --build        # the migrate container applies 0003 before the API starts
```

### 2. Extension (Chrome Web Store)

The side panel ships **inside the extension build** — there is no backend delivery of extension code.
Backend analysis changes are live immediately after redeploy; the new UI reaches users only when they
update the extension.
```bash
EXTENSION_API_BASE_URL=https://api.yourdomain.com npm run package -w @aviator/extension
# upload extension/release/aviator-extension-*.zip to the Chrome Web Store
```

### 3. Admin site (Vercel)

**No change** — admin-web was not modified by this upgrade. No redeploy is required.

## Verification

- **API health**: `curl -s https://api.yourdomain.com/v1/health` → `{"status":"ok",...}`.
- **Migration applied**: `docker logs aviator-migrate-1` shows `Applied: 0003_device_scoped_analysis.sql`
  (or `Database is up to date.` on a later redeploy).
- **Live provider**: an authenticated `POST /v1/analysis` returns `isTestData:false`,
  `engine.kind:"live"`, and a populated `metrics`/`signal` (confirms `ANALYSIS_PROVIDER=statistical`).
- **Live collection**: open a supported game with the device activated; the side panel's
  "Rounds scanned" rises and "Latest round" freshness stays recent.
- **Device isolation**: from a second device (same code, new slot), confirm its dashboard shows only
  its own `totalRounds` — not the first device's. (Covered by `backend/tests/device-isolation.test.ts`.)
- **Side panel**: toolbar icon → popup → **Open analysis dashboard**; it stays open while you click
  game controls and switch tabs.
- **Retention health**: `docker exec aviator-retention-worker-1 node dist/src/database/cli.js retention-status`.

## Rollback

No data loss is at risk: `0003` is index-only on the ephemeral `game_observations` table.

- **Preferred**: in Portainer, **Pull and redeploy** from the previous commit/branch. Any build from
  **Phase 2 onward** matches `0003`, so no SQL is needed. `migrate` is a no-op (0003 already applied).
- **If rolling back to pre-upgrade code** (a build whose ingestion still uses
  `ON CONFLICT (site_id, round_ref)`), first restore that index so inserts don't error — one statement,
  safe because `round_ref` is unused by the shipping extension and the table is ephemeral:
  ```sql
  DROP INDEX IF EXISTS game_observations_round_uq;
  CREATE UNIQUE INDEX game_observations_round_uq
    ON game_observations (site_id, round_ref) WHERE round_ref IS NOT NULL;
  ```
  (Optionally also `DROP INDEX IF EXISTS game_observations_device_site_received_idx;`.)
- **Full restore** (only if needed): stop the stack, restore the pre-deploy dump with
  `deploy/scripts/restore.sh` (or `pg_restore`), then redeploy the matching old code.
- **Extension**: roll back by publishing the previous package; the optional `metrics`/`patterns`/`signal`
  fields mean an older build simply ignores the new response data.

## Status

| Item | State |
|---|---|
| Code (contracts, backend, extension) | **Complete, tested locally** |
| Migration `0003` | **Written**; applies automatically on deploy |
| Backend deploy (Portainer redeploy + `ANALYSIS_PROVIDER=statistical`) | **Pending your approval** |
| Extension rebuild + Web Store upload | **Pending your approval** |
| Admin site (Vercel) | No change needed |
