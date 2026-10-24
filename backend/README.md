# Backend (VPS API + retention worker)

Fastify 5 · TypeScript · `pg` · zod (`@aviator/contracts`) · Argon2id.

| Folder | Contents |
|---|---|
| `src/api` | app factory, error handling, routes (`health`, `customer`, `admin`) |
| `src/auth` | customer sessions, admin login/sessions, service-key check |
| `src/activation` | code generation/hashing, the redemption transaction, admin code operations |
| `src/subscriptions` | expiry and status computation |
| `src/ingestion` | history ingestion (idempotent, server timestamps) |
| `src/engine` | the `AnalysisProvider` interface, the **mock** provider, the analysis service |
| `src/retention` | 12-hour purge, housekeeping, health, single-pass runner |
| `src/workers` | retention worker process |
| `src/database` | pool, migration runner, operator CLI |
| `tests` | Vitest against a real PostgreSQL (started automatically) |

```bash
npm run dev            # API on 127.0.0.1:8080 (reads .env)
npm run dev:worker     # retention worker
npm run db -- migrate  # also: create-admin --email x | retention-status
npm test
npm run build && npm start   # production build
```

Configuration is described in `.env.example`. Every variable is validated at start-up, and placeholder secrets are refused. Docs: [API contracts](../docs/API_CONTRACTS.md) · [Security](../docs/SECURITY.md) · [Retention](../docs/DATA_RETENTION.md).
