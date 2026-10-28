# Data retention

| Data | Table | Retention | Mechanism |
|---|---|---|---|
| Game-history observations | `game_observations` | **12 hours after server receipt** | `retention-worker`, every 5 min |
| Ingestion idempotency keys | `ingest_batches` | 12 hours | same worker |
| Activation codes | `activation_codes` | Permanent (business record) | — |
| Subscriptions | `subscriptions` | Permanent. **Never** deleted by history retention | — |
| Device slots | `device_activations` | Permanent (deactivated, not deleted) | — |
| Customer / admin sessions | `customer_sessions`, `admin_sessions` | Until 30 days after expiry | same worker (housekeeping) |
| Security events | `security_events` | `SECURITY_EVENT_RETENTION_DAYS` (default 90) | same worker (housekeeping) |
| Container logs | Docker json-file | 5 × 10 MB per service, rotated | Docker |
| DB backups | `/var/backups/aviator` | 14 days. **History tables excluded** | `deploy/scripts/backup.sh` |

## The 12-hour rule

* `received_at` is set by PostgreSQL (`DEFAULT now()`). The API never accepts a client timestamp: the strict schema rejects any extra field, and that is tested.
* A row is expired once `received_at < now() − 12 hours`, judged by the **database clock**.
* **Reads:** analysis only selects `received_at ≥ now() − 12 h`, so expired rows are never used even if deletion lags.
* **Deletion:** `purgeExpiredHistory()` (`backend/src/retention/purge.ts`) deletes in batches of 5,000 until nothing is left. Physical deletion therefore happens at most about `RETENTION_INTERVAL_SECONDS` (5 min) plus the batch time after expiry.
* **Independent of analysis:** observations have no "analyzed" flag. Deletion does not wait for, depend on, or get triggered by an analysis or signal. A failing or never-run analysis does not block deletion (tested).
* **Restart-safe and repeatable:** the worker runs a pass immediately on start (it catches up any backlog after downtime) and then on an interval. A PostgreSQL advisory lock allows one pass at a time; extra workers skip. Re-running is a no-op.
* **Index:** `game_observations(received_at)`. Partitioning is not used. At the expected volume (thousands to low millions of rows per 12 h), batched deletes on an indexed column are sufficient. If volume grows by orders of magnitude, switch to hourly range partitions on `received_at` and drop partitions older than 12 h.

### Tests (`backend/tests/retention.test.ts`)

* Rows at 13 h and 12 h 1 s are deleted. Rows at 11 h 59 m and 5 min remain.
* Deleted although analysis never ran.
* Deleted although the analysis provider throws (analysis request returns 503).
* Idempotent re-runs; a 12,345-row backlog is purged in 1,000-row batches.
* Subscriptions, codes and devices are untouched.
* Analysis ignores expired-but-not-yet-deleted rows.
* Worker heartbeat recorded; a restart catches up; the advisory lock prevents concurrent passes.
* Health reports unhealthy when the worker never ran or stale rows exist.

## Monitoring

* `worker_heartbeats` records start, success, error and the deleted count of every pass.
* `node dist/src/database/cli.js retention-status` prints the health JSON and **exits 1 when unhealthy** (no success within 3 intervals, or any observation older than 12 h + 2 intervals). It is the Docker healthcheck of `retention-worker`, so `docker compose ps` shows `unhealthy`.
* The admin overview page shows the same health (`GET /v1/admin/system/retention`).
* Recommended: an external cron or uptime check that runs `docker inspect --format '{{.State.Health.Status}}' aviator-retention-worker-1` and alerts if it is not `healthy`.

## Backups, snapshots, replicas, logs

* `backup.sh` uses `pg_dump --exclude-table-data=game_observations --exclude-table-data=ingest_batches`, so **backups contain no history rows**, only the empty table definitions. Dumps older than 14 days are deleted.
* No WAL archiving / PITR is configured. If you enable it later, archived WAL **will** contain history rows for as long as the archive is kept. Keep WAL archive retention as short as practical and document it.
* **VPS provider disk snapshots** (if enabled at your host) copy the whole disk, including up to 12 h of history, and keep it for the provider's snapshot retention. Either disable whole-disk snapshots for this VPS or set their retention to the shortest available period, and record that period here.
* No read replicas are configured. A replica receives the same deletes, but its own backups or snapshots follow the rules above.
* Application logs never contain observation values (counts only), activation codes or tokens. PostgreSQL runs with `log_statement=none`.
* Test fixtures contain no real history. The dev test page generates random values labelled "simulated".
