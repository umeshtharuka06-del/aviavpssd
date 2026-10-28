# Repository audit — `umeshtharuka06-del/aviavpssd`

Audited 2026-10-28. Subject: GitHub `main` at `8afd888` (2026-10-28 13:44 IST, 59 commits, all "Add files via upload" / "Delete … directory"), compared file by file with the local working tree `C:\Users\user\Downloads\project\aviator\aviator` (which has **no commits and no remote**).

Labels:
- **CONFIRMED** — reproduced or read directly.
- **LIKELY** — strong evidence, not reproduced end to end.
- **UNVERIFIED** — production state that I cannot see.

I have **no access to the VPS, Portainer, the production database or its logs**. Nothing was changed on GitHub, the VPS or any database. No secret values were printed.

---

## A. Executive summary

**Overall health: the code in the local tree is in good shape. The repository that production deploys from is not.**

1. **GitHub `main` is internally inconsistent and breaks uploads when deployed** (CONFIRMED in the repository). It contains the stat-5.1 backend, which writes and reads three columns created by migration `0005`, but **`0005_round_continuity.sql` was never uploaded**. Running GitHub's own test suite on GitHub's own files gives **41 of 252 backend tests failing**. A plain live upload (`POST /v1/history`, the exact shape extension 0.2.0 sends) returns **HTTP 500 INTERNAL_ERROR**, and analysis returns **503 ANALYSIS_UNAVAILABLE**. Those are exactly the two messages in your panel.
2. **The production deployment builds GitHub `main`** (Portainer Git stack, `pull_policy: build`, docs/VPS_DEPLOYMENT.md). So a "Pull and redeploy" after 13:40 IST today runs that broken combination. **Whether production was redeployed after that is UNVERIFIED.** It is the most specific explanation available, but it is not confirmed.
3. **Two data-loss bugs in the extension's upload queue** (CONFIRMED by test):
   - a round queued while an upload is in flight is silently erased;
   - in 0.2.0, a backfill that fails with 5xx blocks all live uploads behind it until they age out.
4. **The standard backup excludes the round history** (CONFIRMED). The documented pre-migration backup would not protect the data you asked to preserve.
5. **Critical dependency advisory** in the admin site: Next.js 16.4.0, an unauthenticated RCE advisory, fixed in 16.4.3 (CONFIRMED by `npm audit`; exposure on Vercel UNVERIFIED).
6. **Forecasting**: the ledger, scoring and no-look-ahead guarantees hold, and the panel does not claim an edge. No validated predictive advantage exists on any data available. No actual 1xBet data was available to me.

## B. Critical issues

| # | Status | Issue | Evidence | Impact | Fix |
|---|---|---|---|---|---|
| B1 | **CONFIRMED** (repo) / **UNVERIFIED** (prod) | GitHub `main` code requires migration 0005, which is missing from `database/migrations` | `backend/src/ingestion/history.ts:46` inserts `chain_id, chain_index, break_before`. `backend/src/engine/sequential/ledger-service.ts:51-52` selects `o.break_before`. `database/migrations/` on GitHub has only 0001–0004. GitHub's own suite: `Tests 41 failed / 252`, incl. `history.test.ts › accepts valid observations… expected 500 to be 200`, `column o.break_before does not exist`, analysis `expected 503 to be 200` | After any redeploy from `main`: `migrate` succeeds (nothing new to apply), the API starts, **every** upload → 500, **every** analysis → 503. Nothing is stored and no forecast is issued. Existing rows are untouched | Make `main` consistent **before** any redeploy: add `0005` (and the rest of the local tree), or roll `main` back to the stat-5 code of commit `8c8601a`. Deploy only a commit whose own tests pass |
| B2 | **CONFIRMED** | Extension upload queue loses rounds when a new batch is enqueued during an in-flight flush | Temporary probe test (removed): enqueue 1.11 → flush in flight → enqueue 2.22 → after flush: sent `[1.11]`, queue `[]`. Cause: `extension/src/background/queue.ts` `flush()` reads the queue, awaits the network, then `setQueue(remaining)` overwrites anything appended meanwhile. `service-worker.ts` runs flushes from a throttle timer **and** a 1-min alarm with no mutual exclusion | Silent loss of rounds; with 0.2.0 (no continuity data) the gap is invisible to the server, so a forecast can be scored against the wrong round | Serialize queue access (one in-flight flush; enqueue and flush under one async lock), and remove only the batches actually sent instead of overwriting the queue |
| B3 | **CONFIRMED** | Extension 0.2.0: a backfill that fails with 5xx blocks every live batch behind it | `queue.ts` (0.2.0): backfill error → `retry_later` → `break`; batches older than 10 min are then dropped together | Rounds lost for ~10 min after every page load while the backfill fails | Fixed in the local tree (backfill dropped on 5xx; tests). **Not in any released ZIP**: `aviator-extension-0.2.1.zip` was built before this fix |
| B4 | **CONFIRMED** | `deploy/scripts/backup.sh` excludes round history and is not verified | `--exclude-table-data=game_observations --exclude-table-data=ingest_batches`; no `pg_restore --list` check; it `cd`s to `deploy/vps` and runs `docker compose exec`, which needs the compose file on the host (a Portainer Git stack keeps it inside Portainer: **LIKELY** fails there) | The pre-migration backup in my earlier INCIDENT_UPLOAD_500.md and ROUND_SIGNAL.md would **not** preserve round history | Before any migration take a **full** dump (section I, step 2) and verify it. Fix the two docs |
| B5 | **CONFIRMED** (advisory) / **UNVERIFIED** (exposure) | Next.js 16.4.0 in `admin-web`: critical "Unauthenticated RCE in Image Optimization API" (GHSA-2464-fhr4-w9xw), plus a Server Actions DoS | `npm audit`: `next critical, range >=16.0.0 <=16.4.0, fix 16.4.3 (not semver-major)`. `admin-web/src/server/actions.ts` uses Server Actions. Two production builds aborted with `SecurityFatalError` (a retry passed) | Admin site compromise or outage; Vercel builds may refuse to build | Upgrade `next` to 16.4.3 in `admin-web`, rebuild, run its tests |

## C. High, medium and low issues

### High

| # | Status | Issue | Location / evidence | Impact | Fix |
|---|---|---|---|---|---|
| C1 | CONFIRMED | Deployment source maintained by web-UI uploads with whole-directory deletes | 59 commits, all "Add files via upload" / "Delete X directory". `backend/src` absent 13:37–13:40 IST (`88f522d`→`782efc4`); `backend/`+`database/` absent 02:24–02:28 IST. Dotfiles never uploaded: `.gitignore`, `.gitattributes`, `.nvmrc`, `backend/.env.example`, `deploy/vps/.env.example` | Any redeploy in those windows builds a broken tree. Missing `.env.example` makes 2 tests fail. No reviewable history, so it is impossible to tell what production runs | Use `git` from the local tree (init, commit, push) so each commit is complete and reviewable. Deploy a tagged commit |
| C2 | CONFIRMED | Local tree and GitHub diverge; neither is a complete source of truth | GitHub lacks `extension/`, `admin-web/`, `scripts/`, `DEPLOY.md`, `0005`, `backend/src/diagnostics.ts`, `tests/schema-drift.test.ts`. GitHub `backend/tests/statistical-provider.test.ts:27` expects `stat-5`, code says `stat-5.1` (test fails). Local has no commits | Fixes made locally are not deployed; what is deployed is untested | Same as C1 |
| C3 | CONFIRMED (repo) | Schema/code mismatch is invisible in the deployed code | GitHub `health.ts`: readiness = `SELECT 1` only. `analysis-service.ts`: `catch {}` discards the cause of every 503. `history.ts` 500s are logged only as message+code with no route | The current incident cannot be diagnosed from production logs alone for analysis failures | Local tree already has: `schemaStatus()` at startup and in `/v1/health/ready`, cause logging (`backend/src/diagnostics.ts`), route in error logs; tested. Deploy it with B1's fix |
| C4 | CONFIRMED | No CI | No `.github/workflows` in either tree | B1 reached `main` with a red test suite | Add a workflow: `npm ci`, typecheck, all tests, `test:secrets` on every push; deploy only green commits |
| C5 | LIKELY | Per-request CPU and connection cost of the forecast ledger | `ledger-service.ts` `syncLedgerLocked`: rebuilds all models from up to 5,000 rounds and loads up to 5,000 forecasts **inside a transaction holding a pooled connection and an advisory lock**, after every upload and every analysis. Measured locally: ~40 ms at 1,000 rounds, ~190 ms at 5,000. Analysis also runs the stat-4 experiment (permutation test). The panel requests analysis within 4 s of each upload | With several devices and `DATABASE_POOL_MAX=10`, latency and pool contention grow linearly. Not measured under load | Cache model state per device or issue asynchronously; drop the stat-4 `forecast` computation once 0.1.5 is retired; load test |

### Medium

| # | Status | Issue | Evidence | Fix |
|---|---|---|---|---|
| C6 | CONFIRMED | `fast-uri` 4.2.2 (moderate, URI scheme spoofing) in the backend runtime via Fastify | `npm ls fast-uri`: `fastify → @fastify/ajv-compiler / fast-json-stringify → fast-uri@4.2.2`; fix ≥ 4.2.3 | `npm update fast-uri` (lockfile), re-run tests |
| C7 | CONFIRMED | Root `package.json` on GitHub lists workspaces and scripts that do not exist there | `workspaces` includes `admin-web`, `extension`; `test:secrets` runs `scripts/check-secret-separation.mjs` (absent) | Resolved by C1/C2 |
| C8 | CONFIRMED | Test database ≠ production database | Tests: `embedded-postgres` **18.4.0-beta.17**; production `postgres:17-alpine` | Pin the test server to 17.x (or run CI against `postgres:17`) |
| C9 | CONFIRMED | Released ZIP 0.2.1 predates the local queue fix and the diagnostics | ZIP built 03:40; queue fix made later | Rebuild only after B2 is fixed |
| C10 | CONFIRMED | Earlier incident and deployment docs give unsafe or outdated steps | `docs/INCIDENT_UPLOAD_500.md` and `docs/ROUND_SIGNAL.md` say back up with `backup.sh` (B4). The incident doc names "0004 not applied" as the leading hypothesis; B1 is now a second, more specific candidate | Update both docs (after your OK) |
| C11 | CONFIRMED | Retention worker logs only the error message | `backend/src/workers/retention-worker.ts:25` | Use `errorFacts` there too |

### Low

| # | Status | Issue | Evidence |
|---|---|---|---|
| C12 | CONFIRMED | `backend/dist/` (39 compiled files) committed on GitHub; obsolete and ignored by the Docker build (`.dockerignore` `**/dist`) | `git ls-files backend/dist` |
| C13 | CONFIRMED | No linter configured (no ESLint/Biome in any workspace), so "lint" could not be run | package.json files |
| C14 | CONFIRMED | `undici` high advisory, but only via `jsdom` (extension **tests**), not shipped | `npm ls undici` |
| C15 | CONFIRMED | The public repo contains the production API host name in docs (`docs/ROUND_SIGNAL.md`, `ENGINE_AUDIT.md`, `DATA_QUALITY.md`). Not a secret, but it advertises the endpoint | `git grep shoptrack` |
| C16 | CONFIRMED | The database does not enforce that forecast probabilities sum to 1 (only `array_length = 4`); the engine, contract and panel do enforce it | `0004` CHECK; `round-signal.ts` `recordProblems` |

## D. Database and migration audit

| Check | Result |
|---|---|
| Files on GitHub | 0001–0004. **0005 missing** while the code needs it (B1). CONFIRMED |
| Files locally | 0001–0005; `0005` adds three nullable columns, no default, no rewrite; applied cleanly in the test DB. CONFIRMED |
| Checksums | 0001–0004 are byte-identical on GitHub and locally, and each has a single checksum across all 59 GitHub commits, so the runner's "modified after being applied" guard cannot trigger from these files. CONFIRMED |
| Ordering | Lexicographic `NNNN_name.sql`; no gaps or duplicates. CONFIRMED |
| Runner | One transaction per file, advisory lock, refuses edited files. A failure aborts `migrate`, and compose then does not (re)start `api`. CONFIRMED by reading `backend/src/database/migrate.ts` and `deploy/vps/docker-compose.yml` |
| Encoding | 0005 was made ASCII (the WIN1252 test server rejected `→`). 0004 contains `…`, which works on UTF-8 servers (`postgres:17-alpine` default). LIKELY fine in production |
| Production state | **UNVERIFIED**. Which migrations are applied, and whether `source`, `chain_id`, `round_forecasts` exist, needs the read-only commands in section I step 1 |
| Recovery safety | 0004/0005 are additive. Recovery (`tests/schema-drift.test.ts`) keeps every stored round unchanged. But the documented backup does **not** include round history (B4) |

## E. Security audit

| Area | Status | Finding |
|---|---|---|
| Secrets in GitHub (all 59 commits) | CONFIRMED clean | Only placeholders (`change-me…`, `$PG…`, `USER:PASSWORD`). No private keys or tokens. Real `backend/.env` and `admin-web/.env.local` exist only locally and were never uploaded |
| Admin service key | CONFIRMED good | Constant-time compare of SHA-256 digests (`backend/src/security/crypto.ts:32`); header redacted in logs (`app.ts:36`); the four peppers/keys must differ (`env.ts:70`) |
| Customer sessions | CONFIRMED good | Only the SHA-256 of tokens stored; server-side subscription checks; tokens redacted from logs; new tests assert no token or values in logs |
| Rate limiting | CONFIRMED | Global 120/min plus per-route limits; client IP trusted only from the Caddy subnet (`TRUST_PROXY 10.200.0.0/24`), Caddy overwrites `X-Forwarded-For` |
| Network | CONFIRMED | Postgres on an `internal` network, not published; only Caddy publishes 80/443; containers read-only, `cap_drop: ALL`, `no-new-privileges` |
| Logs | CONFIRMED | Postgres `log_statement=none`; Caddy drops headers and masks IPs; new `errorFacts` never logs SQL parameters or row values and masks URLs |
| Dependencies | CONFIRMED | Critical: Next 16.4.0 (B5). Moderate: fast-uri (C6). High, test-only: undici (C14) |
| Public repository | CONFIRMED | Source and docs are public; acceptable without secrets, but the production host name is published (C15) |

## F. Build, testing and deployment readiness

| Check | GitHub `main` | Local tree |
|---|---|---|
| `npm ci` | ✓ (115 packages; install scripts of `embedded-postgres` and `esbuild` not auto-approved) | ✓ (earlier) |
| Contracts build / backend typecheck / backend build | ✓ / ✓ / ✓ | ✓ / ✓ / ✓ |
| Backend tests | **✗ 41 failed / 252** | ✓ 257 / 257 |
| Admin tests | n/a (absent) | ✓ 13 / 13 |
| Extension tests | n/a (absent) | ✓ 250 passed, 6 skipped |
| Full typecheck (all workspaces) | n/a | ✓ |
| Secret-separation scan | n/a (script absent) | ✓ on retry; the first run aborted on the Next.js security error |
| Extension production build + validation | n/a | ✓ (0.2.1, before B2/B3 fixes) |
| Lint | **not available** (none configured) | same |
| Docker image build, `docker compose config` | **not run**: Docker is not installed on this machine | same |
| CI | none | none |

**Not tested anywhere:** the real Docker images, the Caddy config, Portainer behaviour, production data volumes, load and concurrency at scale, and the Chrome side panel against the live server. Passing local tests say nothing about production health.

## G. Aviator data collection and forecasting reliability

| Requirement | Status | Evidence |
|---|---|---|
| Actual, simulated and third-party data never mixed | CONFIRMED | The server stores only device uploads, scoped per device and site. Simulated rounds exist only in tests and the local preview (labelled SIMULATED). Third-party files are used only by the read-only `backtest:signal` / `evaluate:signal` CLIs. The mock provider is flagged `isTestData`, and the panel shows no forecast for it. `devfixture` is not in the production default `ACCEPTED_SITE_IDS` |
| Forecast recorded once, scored once against the next round | CONFIRMED | Advisory lock + `UNIQUE (device, site, input_last_observation_id)` + outcome PK + UPDATE-forbidding triggers; DB tests for retries, duplicates, concurrency and gaps |
| No look-ahead | CONFIRMED | `sequential-engine.test.ts` (changing later rounds leaves earlier forecasts identical); `evaluate.test.ts` (baselines built only from earlier rounds) |
| Probabilities sum to ~100% | CONFIRMED in engine, contract and panel; not enforced by the DB (C16) |
| Metrics correct | CONFIRMED by tests | Log loss clipped to [1e-9, 1−1e-9]; multiclass Brier; Spiegelhalter Z; paired difference CIs; Holm and BH adjustments tested against reference values; the e-value threshold (K/α = 100) is checked again by the panel |
| No unearned "validated" claim | CONFIRMED | VALIDATED only with an e-value ≥ 100 after ≥ 50 scored forecasts; the panel re-verifies against the evidence stored at issue time; an unvalidated lead shows as "Ahead — not validated" (local tree) |
| Failures cannot produce misleading estimates | CONFIRMED | A failed analysis → ANALYSIS UNAVAILABLE (no numbers); a failed refresh keeps the last estimate marked STALE; an invalid server forecast is rejected by the panel |
| Collection gaps | CONFIRMED weakness in 0.2.0 | Lost rounds are invisible to the server (fixed by continuity in stat-5.1 / 0.2.1, which is not deployed) and B2 can create such gaps |
| Predictive edge | CONFIRMED absent on available data | Third-party Aviator data shows no serial dependence once collection artifacts are removed; no model validated (docs/EVALUATION_RESULTS.md). **No actual 1xBet data was available** |

## H. Missing, obsolete and misconfigured files

- **Missing on GitHub:**
  - `database/migrations/0005_round_continuity.sql` (critical);
  - `backend/src/diagnostics.ts`, `backend/tests/schema-drift.test.ts`;
  - `backend/.env.example`, `deploy/vps/.env.example`, `.gitignore`, `.gitattributes`, `.nvmrc`;
  - `extension/`, `admin-web/`, `scripts/`, `DEPLOY.md`, `docs/INCIDENT_UPLOAD_500.md`.
- **Obsolete on GitHub:** `backend/dist/` (C12).
- **Stale test on GitHub:** `backend/tests/statistical-provider.test.ts` expects `stat-5`.
- **Locally:** `docs/NEXT_ROUND_FORECAST.md` is marked superseded (kept on purpose), and `extension/src/sidepanel/outlook.ts` is no longer used by the dashboard (dead code; removal needs your OK). The `extension/release/screenshots-0.2.0/` folder referenced in RELEASE-0.2.0.md is missing (cause unknown).
- **Config:** `backup.sh` scope and Portainer compatibility (B4); test Postgres version (C8); no linter (C13).

## I. Remediation plan (ordered by risk and dependency; nothing done yet)

1. **Confirm production state, read-only (you run these).** Container status and migrate exit code, `docker logs aviator-migrate-1`, `docker logs --since 24h aviator-api-1 | grep -E 'unhandled error|ledger sync'`, `docker exec aviator-api-1 ls /app/database/migrations`, and the `schema_migrations` / column `SELECT`s in docs/INCIDENT_UPLOAD_500.md. They tell which case applies:
   - (a) the image lists 0001–0004 and the code errors on `chain_id` / `break_before`: B1, a redeploy from the broken `main`;
   - (b) the errors are about `source` / `round_forecasts`: 0004 not applied;
   - (c) something else.
2. **Full, verified backup (with your approval), including round history:**
   `docker exec aviator-postgres-1 sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > /var/backups/aviator/pre-fix-$(date -u +%Y%m%dT%H%M%SZ).dump`, then `pg_restore --list` on the file (must list `TABLE DATA public game_observations`), then copy it off the server. Note that round history older than 12 h is deleted by design.
3. **Make the repository consistent.** Create a real git history from the local tree (review the diff first), add CI, and get all tests green. Then publish to GitHub `main`, and only with your approval.
4. **Restore service (with your approval).**
   - In case (a): redeploy the consistent commit. `migrate` applies 0005 (additive) before the API starts.
   - In case (b): redeploy the same way (applies 0004 and 0005).
   - Then check `/v1/health/ready` = 200, an upload is accepted, and the analysis answers.
5. **Fix the queue race (B2)** in the extension, plus a regression test. Rebuild and release 0.2.2 (it includes B3's fix), and install it as an in-place update.
6. **Upgrade Next.js to 16.4.3 (B5)** and `fast-uri` (C6); re-run all tests; redeploy the admin site.
7. **Fix the docs (B4, C10)** and the backup script (a full-dump option with verification, and Portainer-compatible `docker exec`).
8. Later: pin the test Postgres to 17 (C8), add a linter (C13), remove `backend/dist` from git (C12), reduce ledger cost (C5).

## J. Final verification checklist

- [ ] Production evidence collected (step 1) and the root cause stated as confirmed or not
- [ ] Full dump taken, `pg_restore --list` shows `game_observations` data, copy stored off-server
- [ ] GitHub `main` = one reviewed commit; CI green (typecheck, backend/admin/extension tests, secret scan)
- [ ] `database/migrations` on `main` contains every migration the code uses (0001–0005)
- [ ] After redeploy: `docker logs aviator-migrate-1` shows success, `/v1/health/ready` 200, no new `unhandled error` lines
- [ ] Round count before vs after recovery: no rows lost (`SELECT count(*) FROM game_observations` before and after)
- [ ] A live upload → 200, and the panel leaves ANALYSIS UNAVAILABLE (a WARMING UP or estimate state appears)
- [ ] Extension 0.2.2 with the queue fix installed in place; activation kept
- [ ] `npm audit`: no critical/high in shipped code (Next ≥ 16.4.3, fast-uri ≥ 4.2.3)
- [ ] Docs no longer recommend `backup.sh` as a pre-migration backup
