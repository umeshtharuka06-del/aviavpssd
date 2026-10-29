# Architecture

```
 Customer's Chrome                         VPS (private)                               Vercel
┌──────────────────────┐   HTTPS   ┌──────────────────────────────────────┐   HTTPS   ┌─────────────────────┐
│ Extension (MV3)       │──────────▶│ Caddy :443 ──▶ api (Fastify) :8080   │◀──────────│ admin-web (Next.js) │
│ popup · background ·  │  bearer   │                 │                    │ service   │ Server Actions only │
│ content (per-site     │  token    │                 ▼                    │ key +     └─────────▲───────────┘
│ adapters)             │           │  postgres :5432 (internal network,   │ admin            │ HttpOnly cookie
└──────────────────────┘           │  no published port)                  │ session     Owner's browser
                                   │  retention-worker (every 5 min)       │
                                   └──────────────────────────────────────┘
```

| Component | Where | Holds secrets? | Talks to |
|---|---|---|---|
| `extension/` | Customer browsers | **No.** Only the public API URL. Session token is issued at runtime and kept in `chrome.storage.local` | VPS customer API (`/v1/activation`, `/v1/subscription`, `/v1/session`, `/v1/history`, `/v1/analysis`) |
| `admin-web/` | Vercel | `VPS_ADMIN_SERVICE_KEY` (server-only env var) | VPS admin API (`/v1/admin/*`), server-side only |
| `backend/` api | VPS container | Peppers, service key, DB URL | PostgreSQL |
| `backend/` retention-worker | VPS container | DB URL | PostgreSQL |
| PostgreSQL | VPS container | — | nothing (internal network) |
| `shared/contracts/` | Compiled into all three | **No.** Public schemas only | — |

## Data flow

1. **Activation.** The owner generates a code on the admin site. The Server Action calls `POST /v1/admin/codes` with the service key and the admin session. The VPS stores an HMAC of the code and returns the plaintext once. The customer types it into the extension, which calls `POST /v1/activation/redeem` with a random per-install device id. The server starts the subscription and returns an opaque session token (7-day TTL, rotated by `/v1/session/refresh`).
2. **Collection.** On any website the customer allows (per-site optional permission), the content script detects an Aviator game by page structure, selects an adapter by structure (a verified site adapter if one matches, otherwise the generic DOM adapter), and reads only the visible "recent results" list. Each frame reports its status to the background, so the popup can show detection, adapter, collection state and last result separately (see [SITE_SUPPORT.md](SITE_SUPPORT.md)). It emits only rounds that complete while the page is open. The background worker batches them (≤ 50, idempotent `batchId`) to `POST /v1/history`. The server stamps `received_at` itself.
3. **Analysis.** `POST /v1/analysis` reads the site's unexpired observations (`received_at ≥ now() − 12 h`) and passes them to the configured `AnalysisProvider`. Right now that is `MockAnalysisProvider`: test data only, no predictions.
4. **Retention.** `retention-worker` deletes observations older than 12 h every 5 minutes, independently of analysis.

## Key design decisions

* **The server is the only authority.** Plan, expiry, status and device limits are always computed from the database. Nothing the client sends (or caches) grants access.
* **No secrets in the extension.** It can be fully inspected. Its only "credential" is the per-device session token the server issues after activation.
* **Admin API: two factors.** A server-to-server service key that exists only in Vercel's server runtime, plus a per-admin session from an Argon2id password login. CORS is not enabled and not relied on.
* **Temporary history is isolated.** `game_observations` and `ingest_batches` are separate from durable tables. They are excluded from backups and never used as a deletion trigger for anything else.
* **The engine sits behind an interface.** `backend/src/engine/provider.ts` is the seam for the future engine. It runs only on the VPS and gets a read-only snapshot.

## Repository layout

```
shared/contracts/   zod request/response schemas, error codes, limits (public)
backend/            Fastify API, activation, subscriptions, ingestion, engine interface, retention, CLI, tests
database/           SQL migrations (source of truth), schema + retention notes
admin-web/          Next.js admin site (Vercel)
extension/          Chrome MV3 extension, site adapters, dev test page, tests
deploy/             VPS docker-compose, Caddy reverse proxy, backup/restore/secret scripts
scripts/            dev-setup (local env), check-secret-separation
docs/               this documentation
```
