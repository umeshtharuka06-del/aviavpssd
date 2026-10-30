# Phase 1 — Inspection, backup and migration plan

Date: 2026-10-14 (UTC+05:30 local)

## 1. What was found

`C:\Users\user\Downloads\aviator` was **already empty** when this rebuild started. The previous
project ("CrashLens") had been moved to the Windows Recycle Bin on 2026-10-14 at 00:51 local
time — before this session began, and not by this rebuild. Thirteen top-level items were
found in the Recycle Bin with original location `C:\Users\user\Downloads\aviator`:

| Item | Size | Notes |
|---|---|---|
| `frontend/` | 904 MB | Next.js 16 app (API + TS stats engine), incl. `node_modules`, `.next`, `.env.local` |
| `backend/` | 381 MB | FastAPI reference backend, Python stats engine, Alembic, incl. `.venv`, `.env` |
| `docs/` | 159 KB | Architecture/security/deploy docs |
| `deploy/` | 26 KB | Nginx, Postgres init, backup/restore scripts |
| `.git/` | 27 KB | Repository with **no commits**, no remote |
| `.github/`, `.claude/`, `README.md`, `VERCEL_DEPLOYMENT.md`, `docker-compose.yml`, `.env.example`, `.gitignore`, `.gitattributes` | small | |

Existing functionality (from the backed-up README and source): user accounts with roles,
CSV import of historical rounds, a descriptive-statistics engine (distribution, Wilson
intervals, streaks, independence tests, backtests vs a frequency baseline), admin pages, a
Postgres-backed job queue, Vercel + VPS deployment docs. Its own README states that previous
multipliers of a provably-fair crash game cannot predict the next one.

None of that code is carried into the new system. The new requirements (Chrome
extension, activation codes, 12-hour temporary history, mock analysis provider) differ
in data model, auth model and retention model. The old project is a full web application,
and the new admin site is explicitly *not* a customer dashboard.

## 2. Backup

* Location: `C:\Users\user\Downloads\aviator-backups\crashlens-2026-10-14\` — outside the
  new source tree.
* Method: `robocopy /E /COPY:DAT` of each Recycle Bin item back to its original name. The
  Recycle Bin itself was **not** modified or restored.
* Mapping of Recycle Bin storage names → original names:
  `C:\Users\user\Downloads\aviator-backups\crashlens-2026-10-14.recyclebin-map.json`.
* Verification: per-file SHA-256 comparison of every file in the source vs the copy. The
  result is in the final report.
* ⚠ The backup contains `backend/.env` and `frontend/.env.local` (local development
  credentials). Keep the backup folder private; do not upload it anywhere.

## 3. Files to replace / remove

Nothing in the working directory needs to be removed: it was empty. **No destructive
operation is required or planned.** The Recycle Bin copy is left untouched, so you decide
whether to empty it. The verified backup above lets you do that safely.

A fresh local git repository was initialised in `aviator/` (`git init`, no commits, no
remote). Without it, git commands here resolved to a repository rooted at
`C:\Users\user`.

## 4. Technology decisions

| Concern | Choice | Why |
|---|---|---|
| Language | TypeScript everywhere | One set of request/response schemas shared by extension, admin site and backend |
| Shared contracts | `shared/contracts` (zod) | Public schemas only, no server logic; safe to bundle into the extension |
| VPS API | Node 24 + Fastify 5 + `pg` | Small, fast, built-in body limits; `pg` pool gives real concurrent transactions |
| Migrations | Plain SQL in `database/migrations`, tiny runner | Reviewable, no ORM magic |
| Passwords | Argon2id (`@node-rs/argon2`, prebuilt) | Proven on this machine in the previous project |
| Admin site | Next.js 16 App Router on Vercel, Server Actions | Minimal; Server Actions give origin-checked mutations (CSRF) |
| Extension | Manifest V3, TypeScript, esbuild, no UI framework | Small bundle, minimal attack surface |
| Tests | Vitest; backend tests against a real local PostgreSQL (`embedded-postgres`) | Concurrency and retention need a real database |
| VPS deploy | Docker Compose: postgres (private network, no port), api, retention-worker, Caddy (HTTPS) | Simplest secure setup |

## 5. Phase order (as requested)

2 skeleton + env + contracts → 3 schema, activation, subscriptions, admin auth →
4 retention worker + tests → 5 admin site → 6 extension → 7 extension ↔ backend with mock
provider → 8 tests, security review, docs.
