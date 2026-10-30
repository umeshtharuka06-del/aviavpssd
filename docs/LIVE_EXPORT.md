# Live round export (read-only, CLI)

This exports our own recorded rounds so the offline engine (`research/`) can test them under the same pre-registered rules as the public data ([STAT6_RESEARCH_REPORT.md](STAT6_RESEARCH_REPORT.md)). Plan and design decisions: [LIVE_EXPORT_PLAN.md](LIVE_EXPORT_PLAN.md).

**Not deployed.** The command exists in the backend source only. It needs a backend image deploy, with no migration and no configuration change. That deploy needs your approval.

## Run it (on the VPS, in a one-off container)

The backend containers run with a **read-only filesystem** (`read_only: true`; only `/tmp` is writable, as tmpfs) and as the non-root user `app`. The export therefore writes to a **host directory mounted into a one-off container**. The running `api`, `retention-worker` and `postgres` containers are not touched. Deployment, verification and rollback steps are in [LIVE_EXPORT_READINESS.md](LIVE_EXPORT_READINESS.md) §7–§9.

```bash
cd /opt/aviator/deploy/vps

# once: an output directory owned by the container user (read uid/gid from the image)
docker compose run --rm --no-deps --entrypoint id migrate          # e.g. uid=100(app) gid=101(app)
sudo install -d -m 700 -o <uid> -g <gid> /var/lib/aviator-exports

# each export
docker compose run --rm --no-deps -v /var/lib/aviator-exports:/exports migrate \
  node dist/src/database/cli.js export-rounds --out /exports --site onexbet
```

Do **not** run it with `--out` pointing anywhere other than the mounted directory. Every other path in the container is read-only, and `/tmp` is discarded when the one-off container exits.

Options:
- `--site <siteId>`: optional; all sites when omitted.
- `--since <ISO>` and `--until <ISO>`: optional; ISO-8601 with a time zone, for example `2026-10-31T06:00:00Z`.

Output:
- `rounds-<site|all>-<UTC time>.csv` and `….manifest.json`, owner-only (0600).
- An existing file is never overwritten.
- One audit row, `admin.rounds_exported`, holding counts only (site, window, rows, streams).

Copy both files off the server and delete them there (`sudo rm /var/lib/aviator-exports/rounds-*`), then on your machine:

```bash
cd research
python -m aviator_engine.cli analyze-export /path/to/rounds-onexbet-*.csv
```

The analysis runs per device stream by default. Add `--merge` for one series per site, with devices merged by value alignment. Add `--quick` for a fast pass. The output goes to `research/out/live_export_report.{json,md}`.

## What the export guarantees

- **Read-only.**
  - One consistent snapshot: `REPEATABLE READ READ ONLY`, with a 30-second statement timeout.
  - No game, ledger or retention table is written. A test proves that a write on the export connection fails.
  - The audit row is written afterwards, separately.
- **No personal or device data.**
  - Columns are allow-listed (below).
  - The collecting device appears as `stream`, a keyed pseudonym (HMAC with `DEVICE_PEPPER`, label `export.stream.v1`). The read chain appears as `chain` (label `export.chain.v1`).
  - Device IDs, activation IDs, codes, sessions, tokens, IPs and raw chain UUIDs are never written. A test scans the whole file for them.
- **Live continuity.** `verified_successor` comes from the live engine's own `isBreak` (engine.ts). It is computed over the whole retention window and only then filtered by `--since`/`--until`.
- **Deterministic.** Rows are ordered by site, stream and `obs_id`. The same database state gives the same bytes, and the manifest carries the SHA-256.
- **Duplicates.**
  - A re-sent batch is never stored twice (batch idempotency).
  - The same chain position stored twice is exported once and counted in the manifest.
  - Rounds seen by several devices stay one row per stream; the offline loader can merge them.

## Columns (schema 1)

`schema_version, site_id, stream, obs_id, received_at, multiplier, source, chain, chain_index, break_before, verified_successor, run_id`

- `obs_id`: the server record ID. **Not a game round ID**; the collector reads none.
- `received_at`: server arrival time (UTC, microseconds). Rounds in one batch share it.
- `multiplier`: exactly as stored, two decimals.
- `run_id`: within the stream, increases whenever `verified_successor` is false.
- **Formula guard:** a cell that would start with `=`, `+`, `-`, `@`, tab or carriage return is written with a leading apostrophe (for example `'-a1`), so spreadsheets show it as text. Only a `site_id` can start that way, and only if the server accepts any site key. `analyze-export` removes the apostrophe; `--site` always takes the real key.

## Collecting more than 12 hours (your decision; not set up)

The database keeps game history for 12 h, and that policy is unchanged. One export therefore covers at most about 1,500 rounds per active device and site.

Testing small effects needs about 8,000–60,000 rounds (STAT6 report §7). That means exporting **every ≤ 6 h** and keeping the files. The loader merges overlapping files:
- the same `(stream, obs_id)` is kept once;
- conflicting values are an error;
- a run continues across files only where both rows appear in the same file, so a round lost between exports never joins two runs.

Keeping files beyond 12 h stores game history outside the 12 h policy, although it holds no personal data. Recommended: keep them off the VPS, encrypted at rest. If you choose to do this, DATA_RETENTION.md should say so. It is **not** edited yet.

## Limitations (also in every manifest)

1. At most the last 12 h per export.
2. No game round IDs. Cross-device merging is by value alignment and refuses ambiguous stretches.
3. `received_at` is the arrival time, not the round time.
4. Missed rounds are not filled in. They appear only as breaks.
5. Coverage is limited to times when a device had the game page open with collection enabled.
6. Clients without continuity data use the 120 s time rule, as the live engine does.
7. `site_id` is the operator domain, not the provider's game configuration.
8. Rows whose device record was deleted are excluded and counted.

## Tests

- **`backend/tests/export.test.ts`** (real local PostgreSQL):
  - privacy and allow-list;
  - pseudonym stability and domain separation;
  - stored-text multipliers and ISO times;
  - retention, site, since and until filters;
  - empty export;
  - device-less rows;
  - duplicates and re-sent batches;
  - continuity equal to `breaksOf`, both for direct rows and through the real ingest API;
  - since/until keeping the true predecessor;
  - byte-identical output under pagination, and the hash;
  - the READ ONLY guard;
  - CSV formula safety;
  - 100,000 rows;
  - files, never-overwrite and the audit row;
  - option validation;
  - no HTTP route.
- **`research/tests/test_live_export.py`:**
  - schema refusal;
  - runs;
  - overlap union and conflicts;
  - a gap between exports;
  - stream merge, including the ambiguous case;
  - end-to-end `analyze-export` on a SIMULATED export.
