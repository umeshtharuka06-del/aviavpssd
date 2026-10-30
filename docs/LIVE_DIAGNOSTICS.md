# Live diagnostics — read-only

These commands verify the live backend and database for extension 0.2.6. Every command only reads:
- the SQL runs in a **read-only transaction** (`default_transaction_read_only=on`), so PostgreSQL rejects any write;
- container commands are `docker ps / inspect / logs / exec … grep|ls|sha256sum`;
- nothing restarts, migrates, deploys or changes data.

Run them on the VPS shell (SSH, or Portainer → the container → Console for the `exec` parts). Paste the output back. It contains no codes, tokens or passwords; multipliers and internal ids only.

Names below come from `deploy/vps/docker-compose.yml`:
- compose project `aviator`;
- services `postgres`, `migrate`, `api`, `retention-worker` and `caddy`;
- image `aviator-backend:${IMAGE_TAG:-latest}`.

Table and column names come from `database/migrations/0001`–`0007` and `backend/src/database/migrate.ts`.

## 0. Find the real container names (do this first)
Portainer sets the compose project to the **stack name**, which overrides `name: aviator`. So the names are `<stack>-postgres-1` etc., and `aviator-…` only if the stack is called `aviator`. List them:
```bash
docker ps -a --filter label=com.docker.compose.project --format 'table {{.Names}}\t{{.Label "com.docker.compose.project"}}\t{{.Label "com.docker.compose.service"}}\t{{.Image}}\t{{.Status}}'
```
Then set the two names for the commands below (adjust if the output differs):
```bash
PG=aviator-postgres-1
API=aviator-api-1
```

## 1. Are migrations 0006 and 0007 applied?
```bash
docker exec -i "$PG" sh -c 'PGOPTIONS="-c default_transaction_read_only=on" psql -X -U "$POSTGRES_USER" -d "$POSTGRES_DB"' <<'SQL'
SELECT name, applied_at, left(checksum, 16) AS checksum16 FROM schema_migrations ORDER BY name;
SELECT to_regclass('public.chain_links') AS chain_links_table,
       (SELECT count(*) FROM information_schema.columns WHERE table_name = 'round_forecasts' AND column_name = 'strategy') AS strategy_column,
       (SELECT count(*) FROM information_schema.columns WHERE table_name = 'forecast_outcomes' AND column_name IN ('target_hit', 'strategy_range_hit')) AS target_columns_of_2;
SQL
```
Expected when both are applied:
- rows `0006_range_strategy.sql` and `0007_chain_links.sql`;
- `chain_links_table = chain_links`, `strategy_column = 1`, `target_columns_of_2 = 2`.

Compare the `migrate` container's exit code: `docker ps -a --filter label=com.docker.compose.service=migrate --format '{{.Names}} {{.Status}}'`. "Exited (0)" means it finished. Any other exit code means it failed, and the API then never started on that image.

Checksums: the checksums of the migration files inside the running image are listed in step 2. They must match `checksum16` above (first 16 hex digits); a mismatch means the file was edited after it was applied.

## 2. Which image and engine version are running?
```bash
docker inspect -f 'container={{.Name}} image_ref={{.Config.Image}} image_id={{.Image}} started={{.State.StartedAt}} health={{if .State.Health}}{{.State.Health.Status}}{{end}}' "$API"
docker image inspect -f 'id={{.Id}} created={{.Created}} tags={{.RepoTags}}' "$(docker inspect -f '{{.Image}}' "$API")"
docker exec "$API" grep -n "ENGINE_VERSION =" dist/src/engine/sequential/engine.js
docker exec "$API" ls /app/database/migrations
docker exec "$API" sha256sum /app/database/migrations/0006_range_strategy.sql /app/database/migrations/0007_chain_links.sql
```
- `ENGINE_VERSION = 'stat-5.4'` is the engine in the running code.
- The version the server **actually used** for each recorded forecast is stored in the database; see step 4, query B.
- If `0007_chain_links.sql` is missing from the image's migration folder, this image predates the resync fix.

How the image was built: `pull_policy: build` means Portainer or compose built it on the VPS from the stack's source. In Portainer → Stacks → the stack, the stack's details show its source (Git repository and reference, or web editor/upload). The repository has no commits yet, so a Git-based stack cannot contain the stat-5.4 or 0007 code from this checkout.

## 3. Does the live backend have the resync fix 0.2.6 needs?
The fix is server code (`backend/src/ingestion/backfill.ts`), and the engine version string does **not** change with it: it is `stat-5.4` with or without the fix. Check the code itself:
```bash
docker exec "$API" grep -c "chain_links" dist/src/ingestion/backfill.js
```
- `2` (the local build's count) or more: the fix is in the running code. It writes a chain link when a re-sent list is already stored, and reads it for the next round.
- `0`: no fix. A lossless re-sync or reload still stores the next round as a break.

Is it being used (needs 0007)?
```bash
docker exec -i "$PG" sh -c 'PGOPTIONS="-c default_transaction_read_only=on" psql -X -U "$POSTGRES_USER" -d "$POSTGRES_DB"' <<'SQL'
SELECT count(*) AS links_12h, max(created_at) AS latest_link FROM chain_links;
SQL
```
(If 0007 is not applied this fails with `relation "chain_links" does not exist`; that error is itself the answer.)

Recent backend errors (log lines contain no history values, codes or tokens):
```bash
docker logs --since 6h "$API" 2>&1 | grep -E '"level":"(error|warn)"' | tail -n 30
```
`forecast ledger sync failed` with `42P01`/`42703` means the code expects a table or column the database does not have (a migration is missing).

## 4. The latest rounds: five or more below 2.00×, and do breaks interrupt them?
**A. Which device/site streams exist** (the engine counts per device AND site):
```bash
docker exec -i "$PG" sh -c 'PGOPTIONS="-c default_transaction_read_only=on" psql -X -U "$POSTGRES_USER" -d "$POSTGRES_DB"' <<'SQL'
SELECT device_activation_id, site_id, count(*) AS rounds,
       count(*) FILTER (WHERE source = 'backfill') AS backfill,
       count(*) FILTER (WHERE break_before) AS breaks,
       count(*) FILTER (WHERE break_before IS NULL) AS no_continuity,
       max(received_at) AS latest
  FROM game_observations GROUP BY 1, 2 ORDER BY latest DESC;
SQL
```

**B. The last 20 rounds of the most recently active stream, oldest → newest, with two independent counts.** The query recomputes two counts:
- `low_run_raw`: below-2.00× results in a row, ignoring breaks;
- `low_run_engine`: the same count under the engine's break rule (`isBreak` in `backend/src/engine/sequential/engine.ts`). A round is a break if it is the first round, if its `received_at` is earlier than the previous round's, or if `break_before` says so. When `break_before` is NULL, a gap of more than 120 s counts as a break.

```bash
docker exec -i "$PG" sh -c 'PGOPTIONS="-c default_transaction_read_only=on" psql -X -U "$POSTGRES_USER" -d "$POSTGRES_DB"' <<'SQL'
WITH s AS (SELECT device_activation_id AS d, site_id AS st FROM game_observations ORDER BY id DESC LIMIT 1),
r AS (SELECT o.* FROM game_observations o, s
       WHERE o.device_activation_id = s.d AND o.site_id = s.st AND o.received_at >= now() - interval '12 hours'
       ORDER BY o.id DESC LIMIT 300),
c AS (SELECT r.*, lag(received_at) OVER (ORDER BY id) AS prev_at FROM r),
b AS (SELECT c.*, CASE WHEN prev_at IS NULL OR received_at < prev_at THEN true
                       WHEN break_before IS NOT NULL THEN break_before
                       ELSE extract(epoch FROM received_at - prev_at) > 120 END AS engine_break FROM c),
g AS (SELECT b.*, sum(CASE WHEN engine_break OR multiplier >= 2 THEN 1 ELSE 0 END) OVER (ORDER BY id) AS g_engine,
                  sum(CASE WHEN multiplier >= 2 THEN 1 ELSE 0 END) OVER (ORDER BY id) AS g_raw FROM b),
k AS (SELECT g.*,
        CASE WHEN multiplier >= 2 THEN 0 ELSE sum(CASE WHEN multiplier < 2 THEN 1 ELSE 0 END) OVER (PARTITION BY g_raw ORDER BY id) END AS low_run_raw,
        CASE WHEN multiplier >= 2 THEN 0 ELSE sum(CASE WHEN multiplier < 2 THEN 1 ELSE 0 END) OVER (PARTITION BY g_engine ORDER BY id) END AS low_run_engine
      FROM g)
SELECT * FROM (
  SELECT id, received_at, multiplier, source, break_before, left(chain_id::text, 8) AS chain, chain_index,
         round(extract(epoch FROM received_at - prev_at)) AS gap_s, engine_break, low_run_raw, low_run_engine
    FROM k ORDER BY id DESC LIMIT 20) last20
ORDER BY id;
SQL
```
How to read it:
- a row with `low_run_raw >= 5` means five or more results below 2.00× in a row were actually stored;
- where `low_run_engine` is lower on the same row, an `engine_break = t` above it reset the count; its `break_before`, `gap_s` and `chain` show why;
- `break_before = t` on a `live` row right after a `chain` change, with no `backfill` row between them, is the re-sync case the 0.2.6 fix plus 0007 resolves;
- the same multiplier stored twice in a row on two different chains suggests two collectors (two tabs or frames).

**C. What the server recorded for the same stream** (needs 0006; without it this fails on `strategy` / `target_hit`, which is itself the answer):
```bash
docker exec -i "$PG" sh -c 'PGOPTIONS="-c default_transaction_read_only=on" psql -X -U "$POSTGRES_USER" -d "$POSTGRES_DB"' <<'SQL'
WITH s AS (SELECT device_activation_id AS d, site_id AS st FROM game_observations ORDER BY id DESC LIMIT 1)
SELECT * FROM (
  SELECT f.id, f.issued_at, f.input_last_observation_id AS after_obs, f.engine_version,
         f.strategy->>'state' AS state, f.strategy->>'consecutiveLow' AS low, f.strategy->>'targetThreshold' AS target,
         round((f.strategy->>'targetProbability')::numeric, 3) AS target_p, f.strategy->>'predictedRange' AS pred_range,
         o.status, o.void_reason, o.target_observation_id AS scored_by_obs, o.actual_multiplier, o.target_hit, o.strategy_range_hit
    FROM round_forecasts f LEFT JOIN forecast_outcomes o ON o.forecast_id = f.id, s
   WHERE f.device_activation_id = s.d AND f.site_id = s.st
   ORDER BY f.id DESC LIMIT 20) last20
ORDER BY id;
SQL
```
- `after_obs` is the observation id from B that the forecast was issued after. Its `low` must equal `low_run_engine` on that row of B. If they differ, the server's calculation is wrong.
- `state = elevated_range_watch` must appear exactly where `low >= 5`.
- `status = void, void_reason = gap` marks a forecast cancelled by a break.
- `engine_version` shows which engine issued each forecast.
- `pred_range`: 0 = 1.00–1.99×, 1 = 2.00–4.99×.

## What the results mean
| Finding | Minimum fix |
|---|---|
| 0006 or 0007 missing, `grep -c chain_links` = 0 | Back up, then deploy the current backend. The `migrate` service applies 0006/0007 on start. Needs your approval and a commit/push or the stack source updated. |
| 0006/0007 applied, `grep` ≥ 2, but B shows breaks after chain changes with no backfill row | The extension isn't sending the re-sync backfill. Look at the extension, not the server. |
| B shows `low_run_raw >= 5` but C shows `low < 5` at the same `after_obs` with no break | A server calculation bug. Send me both outputs. |
| B never reaches 5 | No fault: five lows in a row simply did not occur in these rounds. |
| Duplicates on two chains | Two collectors (two tabs or frames). Close the second tab; an extension guard would be the fix. |
