# Aviator system

A Chrome extension (the customer product), a private VPS backend (activation, subscriptions, temporary game history, analysis interface, retention) and a minimal owner-only admin site on Vercel for managing activation codes.

> **Status:** the analysis engine `stat-5` issues a recorded, labelled estimate for every round after 20 rounds and scores each one when its round arrives ([round-by-round signal](docs/ROUND_SIGNAL.md)). On every real dataset tested, no model beat the baseline ([backtests](docs/BACKTEST_RESULTS.md)). Extension 0.2.0 shows it. **Not deployed:** the VPS needs the stat-5 backend (migration `0004`) — see the deployment plan in ROUND_SIGNAL.md.

| Part | Folder | Runs on | Docs |
|---|---|---|---|
| Chrome extension (MV3) | `extension/` | customer browsers | [README](extension/README.md) · [packaging](docs/EXTENSION_PACKAGING.md) |
| API + retention worker | `backend/` | VPS (Docker) | [README](backend/README.md) · [VPS deployment](docs/VPS_DEPLOYMENT.md) |
| PostgreSQL schema | `database/` | VPS (private network) | [README](database/README.md) · [retention](docs/DATA_RETENTION.md) |
| Admin site | `admin-web/` | Vercel | [README](admin-web/README.md) · [Vercel deployment](docs/VERCEL_DEPLOYMENT.md) |
| Shared API contracts | `shared/contracts/` | compiled into all three | [API contracts](docs/API_CONTRACTS.md) |
| Deployment files | `deploy/` | VPS | [README](deploy/README.md) |

Start here: [Round-by-round signal](docs/ROUND_SIGNAL.md) · [Engine audit](docs/ENGINE_AUDIT.md) · [Research](docs/RESEARCH.md) · [Architecture](docs/ARCHITECTURE.md) · [Site support (verified vs not)](docs/SITE_SUPPORT.md) · [Devices & updates](docs/DEVICES_AND_UPDATES.md) · [Statistics dashboard](docs/COMPACT_DASHBOARD.md) · [Security](docs/SECURITY.md) · [Local development](docs/LOCAL_DEVELOPMENT.md).

## Quick start (local)

```bash
npm install && npm run build:contracts
npm run local-db -w @aviator/backend           # terminal 1
node scripts/dev-setup.mjs                     # random local secrets (gitignored)
npm run db -w @aviator/backend -- migrate
npm run db -w @aviator/backend -- create-admin --email admin@localhost.test
npm run dev -w @aviator/backend                # terminal 2 — API :8080
npm run dev:worker -w @aviator/backend         # terminal 3 — retention worker
npm run dev -w @aviator/admin-web              # terminal 4 — admin :3000
npm run build:dev -w @aviator/extension        # then Chrome → Load unpacked → extension/build
```

## Tests

```bash
npm test               # backend (real PostgreSQL, auto-started) + admin-web + extension
npm run test:secrets   # production builds of extension & admin site, scanned for secrets
```
