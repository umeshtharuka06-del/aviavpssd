# Live round export — production-readiness review (2026-10-31)

**Overall: PASS** (updated 2026-10-31 after the two approved fixes).

- The first review was a conditional pass: the run command assumed a writable container filesystem, and a `site_id` could begin with `-`.
- **Both are fixed.** LIVE_EXPORT.md now uses a bind-mounted output directory in a one-off container (§7). The exporter now writes formula-leading cells with a leading apostrophe, which the offline loader removes.

Nothing was committed, pushed, deployed, migrated or restarted. All checks ran locally.

| # | Check | Result | Evidence |
|---|---|---|---|
| 1 | Changed files and diff | **PASS** | §1. Three backend source files; no route, schema or contract change |
| 2 | Cannot modify game observations, forecasts or existing records | **PASS** | `READ ONLY REPEATABLE READ` snapshot. A test proves that a write on the export connection fails. Compiled-CLI run: the game_observations, round_forecasts, forecast_outcomes, chain_links and device_activations counts were identical before and after. The only write is one new `security_events` row |
| 3a | Privacy and pseudonymisation | **PASS** | Allow-listed columns. Compiled CLI: no device public ID, no raw chain UUID, **no UUID of any kind**, no peppers or keys in the CSV. Pseudonyms are keyed, domain-separated and stable (tests) |
| 3b | CSV injection | **PASS** | Every cell goes through `csvCell`: a value starting with `= + - @`, tab or CR gets a leading `'`. Only `site_id` can (alphabet `[a-z0-9_-]`, possible with `ACCEPTED_SITE_IDS=*`). Tested with a site key `-a1-a2`. The `--site` filter still takes the real key. `analyze-export` strips the guard (tested) |
| 3c | File permissions | **PASS in code; not verified on Linux** | Files are opened with mode 0600 and the directory with 0700. Windows ignores POSIX modes, so the test skips this check here. Verify after deployment (§8) |
| 3d | Checksum integrity | **PASS** | Manifest SHA-256 equals the bytes on disk (test and compiled CLI) |
| 3e | Never overwrite | **PASS** | Compiled CLI: a rerun in the same second is refused (`EEXIST`), the first CSV is unchanged and no `.partial` is left (that leftover was fixed during implementation) |
| 4a | Production schema | **PASS** | A fresh database migrated with exactly 0001–0007 by the compiled `cli.js migrate`, then the compiled `export-rounds`. All 18 checks passed |
| 4b | Production environment | **PASS** (docs corrected) | The `api`, `migrate` and `retention-worker` containers run `read_only: true` (only `/tmp` is writable, as tmpfs) and as the non-root user `app`, so `--out /exports` cannot be created. The command does load the full production config validation (`NODE_ENV=production` in the image). It rejected a development config that accepted `devfixture`, as it should |
| 5 | No existing API, extension, strategy or prediction change | **PASS** | No route registered. `cli.ts` only adds a `case`. `events.ts` only adds a type. The backend suite passes 335 of 335. The extension and admin site are not in the backend image (Dockerfile copies `backend`, `shared/contracts` and `migrations` only) |
| 6 | Safe alongside live collection | **PASS** | Compiled CLI exported 201,512 rounds (9.0 s) while another connection inserted rounds every 20 ms. 285 inserts: p50 1 ms, p99 3 ms, max 7 ms. No advisory or row locks are taken; MVCC readers block neither ingestion nor retention deletes. Production volume (≈ 2,500 rows per device and site in 12 h) exports in well under 1 s |

## 1. Change inventory (this feature)

The repository has no commits, so there is no git diff. Changed backend source, by modification time since 2026-10-30:

| File | Change |
|---|---|
| `backend/src/export/rounds-export.ts` | **new**: snapshot query, continuity through the engine's `isBreak`, pseudonyms, the CSV formula guard (`csvCell`), CSV and manifest, file writer and audit |
| `backend/src/database/cli.ts` | +1 import, +1 `case 'export-rounds'`, help text |
| `backend/src/security/events.ts` | +1 union member `'admin.rounds_exported'` (the database check `^[a-z_.]{1,64}$` accepts it) |

Not in the image:
- `backend/tests/export.test.ts` (19 tests);
- the `research/` loader and tests;
- docs.

Root `.dockerignore` excludes `research/` (changed earlier, so offline data can never enter the build context).

Code review notes, none blocking:
- **(a) A 5,000-round cap.** The live ledger reads at most the newest 5,000 rounds per device and site. The export reads the whole 12 h. The continuity of the oldest row can differ only if one device stored more than 5,000 rounds in 12 h, which is not reached at normal round rates.
- **(b) Duplicates and continuity.** A duplicated chain position is removed before continuity is computed. The live engine would have counted it as a round (documented; none expected).
- **(c) The audit row is written after the files.** If the database becomes unreachable at that instant, the command exits 1 with files present but no audit row.
- **(d) Timeouts.** `statement_timeout` is 30 s per statement. The whole snapshot lasts about as long as the export (under 1 s at production volume).

## 2. Remaining risks

| Id | Risk | Severity | Mitigation |
|---|---|---|---|
| R1 | ~~LIVE_EXPORT.md showed `--out /exports` without a mount~~ | **resolved** | LIVE_EXPORT.md now gives the one-off container with a bind-mounted, container-owned directory, and warns against any other `--out` |
| R2 | 0600 and 0700 modes not verified on Linux | low | §8 step 3 checks them with `stat` |
| R3 | ~~`site_id` beginning with `-` shown as a formula~~ | **resolved** | Formula guard on every cell (OWASP), stripped by the offline loader. Both sides are tested |
| R4 | **Source parity cannot be proven.** There is no git history, so I can't confirm the VPS source equals this checkout apart from the three files | medium | §7 step 2 compares the trees on the VPS before building; exactly the three files may differ |
| R5 | `docker compose build` re-tags `aviator-backend:latest`. Running containers keep their image, but a later `docker compose up -d` recreates them on the new image | low | The new image differs only by the CLI command. The rollback in §9 restores the previous tag |
| R6 | Export files on the VPS hold game history beyond the 12 h policy | policy | Copy off and delete right after each export (§8 step 5). Whether to keep exports at all is still your decision |
| R7 | The Compose stack itself was never run on this machine (no Docker here); VPS_DEPLOYMENT.md says the same | medium | §8 verifies each step on the server |
| R8 | Portainer deployments: the commands below use plain `docker compose` from `deploy/vps` | info | With Portainer, run the same `docker run` equivalent with the stack's environment. Confirm before use |

## 7. Deployment — zero-restart path (recommended)

This builds the new image and runs the command in a **one-off container**. The running `api`, `retention-worker` and `postgres` containers are **not recreated or restarted**. There is no migration (none is pending).

```bash
# 0. on the VPS
cd /opt/aviator/deploy/vps

# 1. back up the database (existing script) and keep the current image and code for rollback
bash ../scripts/backup.sh
docker image tag aviator-backend:latest aviator-backend:pre-export
sudo cp -a /opt/aviator /opt/aviator.pre-export-$(date -u +%Y%m%dT%H%M%SZ)

# 2. copy the new code to /opt/aviator.new (rsync/scp from your machine), then confirm ONLY the three files differ
diff -rq /opt/aviator/backend/src /opt/aviator.new/backend/src
#    expected exactly:
#      Only in /opt/aviator.new/backend/src: export
#      Files .../database/cli.ts and .../database/cli.ts differ
#      Files .../security/events.ts and .../security/events.ts differ
#    if anything else differs: STOP
sudo rsync -a /opt/aviator.new/backend/src/ /opt/aviator/backend/src/

# 3. validate env, build the image only (no `up`)
bash ../scripts/validate-env.sh
docker compose build migrate

# 4. output directory owned by the container user (read the uid/gid from the image)
docker compose run --rm --no-deps --entrypoint id migrate          # e.g. uid=100(app) gid=101(app)
sudo install -d -m 700 -o <uid> -g <gid> /var/lib/aviator-exports

# 5. export (one-off container; same read-only, cap-drop and no-new-privileges settings as the service)
docker compose run --rm --no-deps -v /var/lib/aviator-exports:/exports migrate \
  node dist/src/database/cli.js export-rounds --out /exports --site onexbet
```

If you prefer the API and worker on the new image too, the standard path is `docker compose up -d` after step 3. That restarts `api` for a few seconds; the extension's upload queue retries with the same batch IDs, so no round is lost.

## 8. Post-deployment verification

```bash
# 1. live services untouched and healthy
docker compose ps                                   # api / retention-worker: same "Created" time as before, healthy
curl -fsS https://api.shoptrack.site/v1/health      # {"status":"ok",...}

# 2. no migration pending or applied
docker compose run --rm --no-deps migrate node dist/src/database/cli.js migrate   # "Database is up to date."

# 3. files, permissions, checksum
sudo ls -l /var/lib/aviator-exports                 # -rw------- for .csv and .manifest.json, drwx------ for the dir
cd /var/lib/aviator-exports
sudo sha256sum rounds-onexbet-*.csv                 # must equal "csvSha256" in the manifest
sudo grep -o '"csvSha256": "[0-9a-f]*"' rounds-onexbet-*.manifest.json
sudo head -3 rounds-onexbet-*.csv                   # header = the 12 schema-1 columns; streams look like s_<16 hex>
sudo grep -Eic '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' rounds-onexbet-*.csv   # must print 0

# 4. audit row (counts only)
docker compose exec postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT occurred_at, actor, detail FROM security_events WHERE event_type = '"'"'admin.rounds_exported'"'"' ORDER BY id DESC LIMIT 1"'

# 5. copy off the server, then remove from the VPS (game history must not accumulate there)
#    from your machine:  scp 'vps:/var/lib/aviator-exports/rounds-onexbet-*' ./exports/
sudo rm /var/lib/aviator-exports/rounds-onexbet-*

# 6. offline, on your machine
cd research && python -m aviator_engine.cli analyze-export ../exports/rounds-onexbet-*.csv
```

## 9. Rollback

The export adds no schema change and no persistent configuration. Rollback is code and image only:

```bash
cd /opt/aviator/deploy/vps
docker image tag aviator-backend:pre-export aviator-backend:latest   # previous image back under the running tag
sudo rsync -a --delete /opt/aviator.pre-export-<stamp>/backend/src/ /opt/aviator/backend/src/
# only if api/worker were recreated on the new image (standard path):
docker compose up -d --no-build api retention-worker
# leftover files
sudo rm -rf /var/lib/aviator-exports
```

`admin.rounds_exported` audit rows can stay. They hold counts only and are purged after `SECURITY_EVENT_RETENTION_DAYS` (90).
