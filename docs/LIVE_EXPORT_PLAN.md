# Phase 1 — read-only live round export: plan (2026-10-31)

**Status: plan only, awaiting approval.** Nothing has been implemented, deployed, migrated or changed. Purpose: get our own live Aviator rounds into the offline engine (`research/`) so that the stat-6 acceptance rules can be applied to the operator we actually collect from.

## 1. Audit findings that shape the design

| Finding | Source | Consequence |
|---|---|---|
| Game history lives in `game_observations` (`id` identity, `site_id`, `multiplier numeric(12,2)`, `round_ref`, `device_activation_id`, `received_at`, `source`, `chain_id uuid`, `chain_index`, `break_before`) | migrations 0001, 0004, 0005 | All the fields needed exist. **No schema change.** |
| **`round_ref` is always NULL**: the extension never sends `roundRef`, so no game round IDs exist | `extension/src` (no use), `customer.ts:71` | The "round reference" must be the server's observation `id`. It is stable and never reused, but it is **not** a game round ID, and the export must say so |
| Rows are stored **per device**. Several devices on one site record the same game rounds as separate rows | unique index `(device_activation_id, site_id, round_ref)` (0003) | Cross-device duplicates cannot be removed by ID. The export keeps one **stream** per device, under a pseudonym; merging streams is an offline step (§5) |
| Continuity: `break_before` per row (0005), chain links (0007), and the engine's rule `isBreak` (break_before when present, otherwise the 120 s time rule for older clients) | `engine.ts` `isBreak`/`breaksOf` | The export carries the raw fields **and** the engine's own verdict (`verified_successor`), computed by the same function, so the offline analysis uses exactly the live continuity rule |
| **Retention: 12 h** for `game_observations`, `ingest_batches` and `chain_links` | `limits.ts`, DATA_RETENTION.md | One export holds at most the last 12 h (about 1,500 rounds per active device and site). Long windows need **repeated exports kept outside the database**, which is a data-handling decision (§3, decision 3) |
| Admin API: every route requires the server-to-server service key (`x-admin-service-key`) plus an admin session. Customer tokens are never accepted. Rate limits are set per route | `api/routes/admin.ts`, `auth/admin-auth.ts` | An HTTP export (if chosen) inherits both factors |
| Audit: `security_events(event_type ~ '^[a-z_.]{1,64}$', actor, ip_hash, detail jsonb)`. The detail must never contain game history | `security/events.ts`, 0001 | `admin.rounds_exported` fits the existing check. **No migration.** The detail holds counts and site only |
| Ops CLI exists (`migrate`, `create-admin`, `raise-device-limits`, `retention-status`), run with `npm run db:prod` inside the backend container | `database/cli.ts` | A CLI export needs no new network surface |
| Peppers: `CODE_PEPPER`, `DEVICE_PEPPER`, `IP_HASH_PEPPER` and `ADMIN_SERVICE_KEY` are required to differ from each other | `config/env.ts` | The pseudonyms can be derived without a new secret (§4) |

## 2. Export format (schema v1)

One CSV per export (UTF-8, `\n`, header row, RFC 4180 quoting, which is never actually needed because every field is numeric, a fixed enum, or hex), plus a manifest JSON.

| Column | Example | Meaning |
|---|---|---|
| `schema_version` | `1` | format version; the offline loader refuses unknown versions |
| `site_id` | `onexbet` | the canonical operator key (already public: `KNOWN_SITES`) |
| `stream` | `s_3f9a1c07b2e4d815` | **pseudonym** of the collecting device: HMAC-SHA256 (see §4), 16 hex characters. It is stable across exports so overlaps can be merged and continuity followed, and it cannot be reversed without the server secret |
| `obs_id` | `48213377` | server observation ID. A **stable record reference, not a game round ID** (none exists) |
| `received_at` | `2026-10-31T08:12:44.381Z` | server receipt time (UTC, ms), not the round's start time. A batch shares one time |
| `multiplier` | `2.47` | exactly as stored (`numeric(12,2)` → text, no floating-point step) |
| `source` | `live` / `backfill` | how the round arrived |
| `chain` | `c_91d0e6a4f2b37c58` | pseudonym of the read chain (HMAC of `chain_id`); empty for older clients |
| `chain_index` | `57` | position in the chain; empty for older clients |
| `break_before` | `false` / `true` / empty | the collector's stored verdict |
| `verified_successor` | `true` / `false` | the **engine's** verdict (`!isBreak(prev, row)` within the stream), as used live |
| `run_id` | `12` | within the stream, it increases at every non-verified successor |

Ordering is deterministic: `site_id`, then `stream`, then `obs_id`. The same database state with the same parameters gives a **byte-identical** file.

The manifest (`.manifest.json`) records:
- schema version, engine version and export tool version;
- `generated_at`, the window (`since` and `until`), the site filter and the retention cut-off;
- counts: rows, streams, runs, rows without continuity metadata, duplicates removed and why;
- the CSV's SHA-256;
- a fixed list of limitations (§7).

**Excluded, always:**
- `device_activation_id`, device `public_id` and device labels;
- activation codes and code IDs, subscriptions, sessions, tokens, IPs, user agents;
- raw `chain_id` UUIDs, `round_ref` (always NULL anyway), batch IDs;
- forecasts and outcomes (a separate export can come later if wanted).

## 3. Decisions needed from you before implementation

1. **Delivery channel.**
   - **(A) VPS CLI only (recommended first):** `npm run db:prod -- export-rounds --site onexbet --out /exports/` inside the backend container. It adds no new HTTP endpoint and needs no admin-web or Vercel deploy. It needs a backend image deploy, because the CLI is new code.
   - **(B) A and also** an admin API route plus a download button in the admin site. More convenient, but more attack surface and two deploys.
2. **Stream pseudonyms (recommended: yes).**
   - Without them, overlapping exports cannot be merged and continuity cannot be followed. Each per-device stream would be indistinguishable, so rounds from different devices would interleave and look like dependence.
   - The alternative is to export one stream per site and export (the device with the most rounds) with no identifier. That is simpler, but the chosen device can change between exports.
3. **Keeping exports beyond 12 h is a retention change in practice.**
   - Each export holds at most 12 h. The data-sufficiency result (≈ 8,000–11,000 scored rounds to test a 0.001 effect; ≈ 60,000 for a 2-point effect) means exporting **every ≤ 6 h for days or weeks** and keeping the files.
   - That moves game history outside the 12 h policy, even though it has no personal data.
   - Recommended: keep the files **off the VPS**, on your machine, encrypted at rest, and add one paragraph to DATA_RETENTION.md stating it.
   - **The retention policy in the database stays unchanged**, as you required. Please confirm, or choose single on-demand exports only (short-window analysis only).

## 4. Security design

- **Read-only database access.**
  - The export runs in `BEGIN TRANSACTION READ ONLY ISOLATION LEVEL REPEATABLE READ` (one consistent snapshot), with `SET LOCAL statement_timeout = '30s'`.
  - The only write is the audit row, made in a separate statement after the snapshot.
  - The game tables are never written.
- **Pseudonyms without a new secret.**
  - `stream = 's_' + hex(HMAC-SHA256(DEVICE_PEPPER, 'export.stream.v1:' + device_activation_id))[0:16]`.
  - `chain` is the same, with the label `'export.chain.v1:'` and the `chain_id`.
  - The labels separate these from every existing use of the pepper, so a pseudonym never equals any stored hash.
  - **Residual risk:** someone holding both the database and `DEVICE_PEPPER` can link a stream back to a device activation. That person can already read the activations directly.
- **No identifiers or secrets in the output.** Tests assert that the CSV header is exactly the allow-list and that no cell matches a stored device `public_id`, activation ID, code ID, token hash or UUID pattern.
- **Authorisation.**
  - CLI: possible only with shell access to the VPS container (`DATABASE_URL` in its environment).
  - HTTP (option B): the existing two factors (service key and admin session), plus a dedicated rate limit (3 a minute per admin), `Cache-Control: no-store`, `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff`.
  - Query parameters use a `strictObject` schema: `site` must match the `site_id` regex, `since` and `until` are ISO times inside the retention window, and anything else is rejected.
- **CSV injection.** No cell can start with `=`, `+`, `-` or `@`: numbers are positive and the other fields are enums or hex with fixed prefixes. A formatter test asserts this.
- **Audit.** Each export records `admin.rounds_exported`, with `detail = { site, since, until, rows, streams }` and no game data. The actor is the admin email (HTTP) or `cli`.
- **Resource limits.** Rows are streamed in batches of 5,000 (bounded memory). The 12 h retention already caps the size, at about 2,500 rows per device and site.

## 5. Duplicate handling

| Case | Detection | Handling |
|---|---|---|
| Same batch sent twice | `ingest_batches (device, batch_id)`, already in place | never stored twice |
| Same round twice in one stream (same chain and chain index) | export query | keep the lowest `obs_id`; count it in the manifest (expected 0) |
| Older clients with no continuity metadata | `chain_id IS NULL` | kept; counted; `verified_successor` uses the 120 s rule, as live |
| **The same game round seen by several devices** | no round ID exists | **not removed in the export** (each stream stays intact). The offline loader offers (a) one stream at a time (default) or (b) a merged site stream by value alignment of at least 8 consecutive rounds within ±60 s, refusing ambiguous alignments (the same principle as the backfill) |
| Overlapping exports (every ≤ 6 h) | `(stream, obs_id)` stable | the offline loader takes the union and drops repeats by `(stream, obs_id)`; a conflicting value for the same key is an error |

## 6. Affected files

| File | Change | Option |
|---|---|---|
| `backend/src/export/rounds-export.ts` (new) | read-only snapshot query; continuity via `breaksOf`/`isBreak` from `engine.ts` (imported, not copied); pseudonyms; pure CSV and manifest formatter | A, B |
| `backend/src/database/cli.ts` | new `export-rounds` command (`--site`, `--since`, `--until`, `--out`) | A, B |
| `backend/src/security/events.ts` | add `'admin.rounds_exported'` to the type union (no database change) | A, B |
| `shared/contracts/src/admin.ts` | `ExportRoundsQuerySchema` (`strictObject`) | B |
| `backend/src/api/routes/admin.ts` | `GET /v1/admin/export/rounds.csv`, streaming | B |
| `admin-web/src/server/vps.ts`, a new route handler and one button | server-side proxy (the service key stays on the server) | B |
| `backend/tests/export.test.ts` (new) | §8 | A, B |
| `research/aviator_engine/loaders.py`, `cli.py`, `tests/test_live_export.py` | `load_live_export()` (schema check, overlap merge, stream selection or merge, runs from `verified_successor`); `analyze-export` command running the full stat-6 pipeline per site | A, B |
| `docs/LIVE_EXPORT.md` (new), `docs/DATA_RETENTION.md` (one paragraph, only under decision 3) | usage, format, limitations | A, B |

**Unchanged:** prediction logic, strategy rules, schema and migrations, the retention worker and its policy, the extension, all API contracts used by the extension.

## 7. Limitations (written into every manifest and LIVE_EXPORT.md)

1. **At most the last 12 h per export.** Longer analysis depends on repeated exports (decision 3).
2. **No game round IDs.** `obs_id` identifies a stored record, not a round. Cross-device merging is by value alignment and can refuse ambiguous stretches.
3. **`received_at` is the arrival time.** It is batched and not the round's start time, so it is not suitable for timing analysis.
4. Gaps are marked, never filled. Missed rounds are invisible except as breaks.
5. Coverage is limited to times when a device had the game page open with collection enabled.
6. Older clients (before 0.2.1) have no chain data. Their continuity uses the 120 s time rule and is weaker.
7. The site key identifies the operator domain, not the game provider's configuration. A configuration change by the operator can't be seen except as a distribution change.

## 8. Test plan (`backend/tests/export.test.ts`, real local PostgreSQL as in the existing suites)

**Authorisation (option B):**
- no service key → 401;
- service key without a session → `ADMIN_UNAUTHORIZED`;
- a customer session token → rejected;
- an expired or revoked admin session → rejected;
- the rate limit applies;
- invalid or extra query parameters → `VALIDATION_FAILED`;
- the audit row is written, with no game data in `detail`.

**Privacy:**
- the header equals the allow-list exactly;
- no cell equals any device `public_id`, `device_activation_id`, code ID or token hash;
- no UUID pattern appears;
- `stream` is stable across two exports and differs between devices;
- `stream` differs from the HMAC under any other label (domain separation).

**Data integrity:**
- the row count equals the snapshot's rows for the site and window;
- multipliers are byte-identical to the database text (for example `1.00`, `10.50`, `1000000.00`);
- times are ISO UTC;
- the `site`, `since` and `until` filters work;
- rows already purged by retention are absent;
- an empty window gives the header only.

**Deduplication:**
- a repeated `(stream, chain, chain_index)` is exported once and counted in the manifest;
- a re-sent batch stores nothing;
- two overlapping exports merge offline to the union with no repeats;
- a conflicting value for the same `(stream, obs_id)` is flagged.

**Continuity correctness:**
- `verified_successor` equals `breaksOf(...)` from `engine.ts` for the same rounds. This covers a verified chain, a new chain, a chain link after a reload (0007), a dropped batch (index jump), and older clients under the 120 s rule;
- `run_id` increases exactly at breaks.

**Reproducibility:**
- two exports of the same snapshot are byte-identical;
- the manifest SHA-256 matches the file.

**Read-only:**
- the export transaction is `READ ONLY` (asserted by an attempted write inside it, which must fail);
- row counts of all game and ledger tables are unchanged afterwards.

**CSV safety:** no cell starts with `= + - @`.

**Size:** 100,000 seeded rows export with bounded memory (streaming) in under 10 s locally.

**Offline loader** (`research/tests/test_live_export.py`):
- rejects an unknown schema version;
- builds runs from `verified_successor`;
- merges by stream and overlap;
- alignment merge accepts a clean overlap and refuses ambiguous ones;
- the end-to-end `analyze-export` on a SIMULATED export file produces the stat-6 report with the plausibility gate and pre-registered rules.

## 9. Implementation sequence, after approval

1. Backend export module, CLI, audit type and tests. Run locally against the local embedded PostgreSQL with seeded rounds (never production data).
2. Offline loader and `analyze-export`, with tests.
3. LIVE_EXPORT.md (and DATA_RETENTION.md if decision 3 is "keep").
4. Run the full backend, admin and extension test suites and the secrets check, then report the results.
5. **Deployment approval gate:**
   - build the backend image;
   - deploy (no migration);
   - run one export on the VPS and verify the manifest;
   - you copy the files off the server.
6. After enough exports: `analyze-export` per site under the same pre-registered stat-6 rules, and report.
