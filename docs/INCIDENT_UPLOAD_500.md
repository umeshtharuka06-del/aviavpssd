# Incident: "The server rejected the upload: An internal error occurred." + ANALYSIS UNAVAILABLE

Reported 2026-10-28 with extension 0.2.0 against the live API (`https://api.shoptrack.site`). Panel: Connected · Recording completed rounds · upload error · ANALYSIS UNAVAILABLE.

## What is certain (from the code, reproduced locally)

| Item | Value |
|---|---|
| Panel text source | `extension/src/background/queue.ts` `describeFailure`: any HTTP status other than 401/403/400/413/429 → `The server rejected the upload: <server message>`. Only uploads write this text: `POST /v1/history` or `POST /v1/history/backfill` |
| Response that produces exactly this text | **HTTP 500** `{"error":{"code":"INTERNAL_ERROR","message":"An internal error occurred.","requestId":"…"}}` from the generic error handler (`backend/src/api/app.ts`): an exception that is not an AppError, e.g. a PostgreSQL error |
| Request shapes sent by 0.2.0 | live: `{batchId, siteId, adapterVersion, observations:[{multiplier}]}`; backfill (once per page view, at the first new round, **queued before** the live rounds): `{batchId, siteId, adapterVersion, multipliers:[…≤100]}` |
| ANALYSIS UNAVAILABLE with the upload error in the status line | the analysis request failed and no earlier result existed (`sidepanel/controller.ts` → `analysis.state = 'error'`, card shows the server message). The server answers **503 ANALYSIS_UNAVAILABLE "Analysis is temporarily unavailable."** when the provider or the forecast ledger throws; **the live code discards that exception without logging it** |
| Live server code | stat-5 or newer: `POST /v1/history/backfill` answers 401 (route exists), unknown routes 404 |

## Diagnosis (to be confirmed with the logs below)

**The API runs code that needs migration `0004_round_forecast_ledger.sql`, but the production database does not have it.** In that state, reproduced exactly by `backend/tests/schema-drift.test.ts`:

- `POST /v1/history/backfill` → **500 INTERNAL_ERROR**, PostgreSQL `42703 column "source" of relation "game_observations" does not exist`. The transaction rolls back: nothing is stored.
- `POST /v1/analysis` → **503 ANALYSIS_UNAVAILABLE** (`42703`/`42P01`: `source` column / `round_forecasts` table missing). No forecast can ever be issued.
- `POST /v1/history` (stat-5 code) does not touch the new columns, so live rounds themselves would be accepted, **but** extension 0.2.0 queues the failed backfill first and stops the queue at the first 5xx. Every flush retries the backfill, fails, and the live rounds behind it wait. After 10 minutes the queue drops the backfill **and the live batches that waited with it**. The next page view sends a new backfill and it repeats. So most rounds observed shortly after each page load are lost, and no forecast is issued at all.

How the schema can lag the code: the compose stack runs migrations in a separate one-shot `migrate` service that `api` waits for. Updating only the `api` container (Portainer "recreate", `docker compose up -d --no-deps api`, or an old exited `migrate` container counted as completed) skips it. A migration that fails (e.g. "Migration … was modified after being applied") also leaves it behind.

**Not yet confirmed**: I have no access to the VPS. If the logs show another error, this diagnosis is wrong and the logs decide.

## Read-only commands to confirm (run on the VPS; nothing is changed)

Container names follow the compose project `aviator`. In Portainer, the same logs are under Containers → *name* → Logs.

```bash
# 1. which containers/images run, and when the migrate job last ran (exit code)
docker ps -a --filter name=aviator --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.CreatedAt}}'
docker inspect aviator-migrate-1 --format 'image={{.Image}} exit={{.State.ExitCode}} finished={{.State.FinishedAt}}'
docker inspect aviator-api-1 --format 'image={{.Image}} started={{.State.StartedAt}}'

# 2. the migrate job's own output
docker logs aviator-migrate-1 2>&1 | tail -n 50

# 3. the exceptions behind the 500s (message + SQLSTATE are already logged by the live code)
docker logs --since 24h aviator-api-1 2>&1 | grep -E 'unhandled error|forecast ledger sync failed' | tail -n 20

# 4. migration files shipped in the running API image
docker exec aviator-api-1 ls /app/database/migrations

# 5. what the database has applied, and whether the 0004 objects exist (SELECT only)
docker exec -i aviator-postgres-1 sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"' <<'SQL'
SELECT name, applied_at FROM schema_migrations ORDER BY name;
SELECT to_regclass('public.round_forecasts') AS round_forecasts, to_regclass('public.forecast_outcomes') AS forecast_outcomes;
SELECT column_name FROM information_schema.columns WHERE table_name = 'game_observations' ORDER BY ordinal_position;
SELECT count(*) AS rounds, max(received_at) AS latest FROM game_observations;
SQL
```

Confirmed if: (3) shows `column "source" of relation "game_observations" does not exist` (code 42703) on `/v1/history/backfill`, (4) lists `0004_round_forecast_ledger.sql`, and (5) has no `0004` row, `round_forecasts` is NULL and `game_observations` has no `source` column.

## Safest fix (needs your approval; nothing done on the VPS)

1. **Back up** the database (`deploy/scripts/backup.sh`) and copy the dump off the server.
2. **Run only the pending migration(s)** with the image that is already running, from the folder that holds the stack's `docker-compose.yml` and `.env` (for a Portainer stack, use the stack's *migrate* container → Start instead): `docker compose run --rm migrate`. `0004` is additive: one column with a default, two new tables, two triggers. Existing rows keep their values (verified in the regression test: every stored round unchanged).
3. Check `curl -s https://api.shoptrack.site/v1/health/ready` → 200 (only with the new readiness check), make one analysis request from the panel, and confirm in (3) that no new `unhandled error` appears.
4. If (2) fails with "was modified after being applied", stop and send me the message. It means the image's `0004` differs from the applied one, and it must not be forced.

Rollback: not needed for an additive migration. The previous API image ignores the new tables and column.

## Code changes made locally (not deployed)

- `backend/src/diagnostics.ts` `errorFacts`: logs the error class, SQLSTATE, table/column/constraint and a short message. Never SQL parameters, row values, bodies, headers or tokens; URLs masked.
- Error handler: `unhandled error` now includes method + route. 5xx AppErrors with a cause (analysis, readiness) log `request failed` with the cause. Previously the analysis cause was thrown away.
- `schemaStatus()` (`database/migrate.ts`): pending / modified migrations. Logged at API startup. `/v1/health/ready` returns 503 (generic public message, details in the log) when the schema does not match the build.
- Ledger-sync failures log the same safe facts (previously only the code).
- Extension queue: a backfill that fails with 5xx is dropped instead of blocking the live rounds behind it. A failed live upload is still kept and retried with the same batch id. Upload errors from the backfill are prefixed "Page history (backfill):".
- Tests: `backend/tests/schema-drift.test.ts` (reproduces the exact 500 body, the 503, the log lines, no token in logs, and recovery after migrating with history preserved); two queue tests in `extension/tests/background.test.ts`.
