# Security

## Trust boundaries

| Boundary | Rule | Where enforced |
|---|---|---|
| Extension ↔ world | The extension is public code. It contains no secrets, credentials, private endpoints or engine logic | `extension/tests/manifest.test.ts`, `scripts/check-secret-separation.mjs` |
| Extension → API | Only server-computed state grants access. Client-sent plan, expiry, status or timestamps are rejected (strict schemas) | `backend/src/auth/customer-session.ts`, `shared/contracts` |
| Browser → admin site | The browser holds only an HttpOnly, Secure, SameSite=Strict `__Host-` cookie. It never sees the VPS URL, the service key or the database | `admin-web/src/server/*` (`server-only`), `admin-web/tests/boundaries.test.ts` |
| Admin site → API | Service key (server-to-server) **and** admin session. CORS is disabled and is not an auth mechanism | `backend/src/api/routes/admin.ts` |
| API → PostgreSQL | Private Docker network (`internal: true`), no published port | `deploy/vps/docker-compose.yml` |

## Secrets

| Secret | Lives in | Purpose | If leaked |
|---|---|---|---|
| `CODE_PEPPER` | VPS `.env` | HMAC of activation codes | With a DB copy, enables offline code guessing (still 100-bit). Rotating it invalidates **unredeemed** codes |
| `DEVICE_PEPPER` | VPS `.env` | HMAC of device ids | Device ids become linkable across DB copies. Rotating it forces all customers to re-enter codes |
| `IP_HASH_PEPPER` | VPS `.env` | HMAC of IPs in `security_events` | Low impact |
| `ADMIN_SERVICE_KEY` | VPS `.env` + Vercel env `VPS_ADMIN_SERVICE_KEY` | First admin factor | Attacker still needs an admin password. Rotate on both sides |
| `POSTGRES_PASSWORD` / `DATABASE_URL` | VPS `.env` | DB access | DB is not network-reachable; rotate anyway |
| Admin passwords | Argon2id hash in `admin_users` | Second admin factor | Lockout + rate limits slow guessing |

`.env` files are gitignored. Every `.env.example` contains `change-me` placeholders only, and the API refuses to start while any secret is a placeholder, shorter than 32 characters, or equal to another secret.

## Activation codes

* 20 Crockford-base32 characters from `crypto.randomBytes`: 100 bits of entropy.
* Stored as `HMAC-SHA256(CODE_PEPPER, "activation-code:v1:" + normalized)`, with a 4-character hint and a random public id. The plaintext exists only in the generation response.
* Never written to logs. The API logger records method + route pattern only (no URLs, query strings, bodies or auth headers), Caddy drops request headers and the `q` query value, and Next.js logs Server Action arguments as `{}`. A test asserts that generated codes, session tokens and the service key never appear in API logs.
* The admin search never accepts a full code in a URL.

## Customer sessions & devices

* Opaque 256-bit tokens, stored as SHA-256. 7-day TTL, never beyond the subscription end. One live session per device.
* Device id = random UUID created at install (no fingerprinting). Stored as `HMAC(DEVICE_PEPPER, id)`.
* Device limit (default 5, max 5) enforced server-side by a row lock, a partial unique index (one active slot per device) and a database trigger that refuses any slot beyond the limit.
* **Device replacement:** the admin removes ONE device (or resets all), with a reason, audited as `admin.device_revoked` / `admin.devices_reset`. The customer re-enters the code on the new device. The period is never extended. Details: [DEVICES_AND_UPDATES.md](DEVICES_AND_UPDATES.md).
* Extension updates keep the device id and session; the extension re-validates with the server on startup and update. Local storage never authorizes access by itself.

## Abuse controls

Rate limits per IP / session / admin client IP (see API_CONTRACTS.md). 8 KB body limit (64 KB at Caddy). Strict schemas: unknown fields are rejected. Idempotent ingestion. Max 50 observations per batch. `siteId` allow-list. Analysis has a 5 s provider timeout.

Limiter state is in memory: correct for the single-instance API, but per-process if you scale out. Move it to PostgreSQL or Redis before running several API replicas.

## Extension permissions

`storage`, `scripting`, `alarms`, `activeTab`, plus host access to the API origin only. No website is granted at install. `optional_host_permissions: ["https://*/*"]` only makes it *possible* to ask: when the user clicks "Allow access" in the popup, Chrome shows its own prompt for that one site (and, if the game runs in a frame from another site, that frame's site). The content script is registered only for the granted sites. When the popup opens, `activeTab` allows a single detection probe in the current tab, with no standing access. The extension never reads frames whose origin the user did not grant (browser same-origin policy). Users can revoke access in `chrome://extensions`. No `tabs`, `history`, `cookies`, `webRequest` or `<all_urls>`. Extension pages have CSP `script-src 'self'; connect-src <api>`. Popup rendering never uses `innerHTML`.

## What the extension collects

Only completed-round multipliers that are visibly rendered as page text, from sites the user granted, while the page is open, plus the site key (the top page's registrable domain) so results are grouped per website. Values are validated client-side (strict `1.23x` format, 1.00–1,000,000, max 2 decimals) and again by the server. No account data, balances, bets, cookies, URLs or browsing history. Queued data lives in `chrome.storage.session` (memory) and is dropped after 10 minutes or when the subscription is not valid.

## Known limitations / follow-ups

* Admin login has no second factor (TOTP or WebAuthn) yet. Recommended before production.
* Vercel Hobby has no static egress IPs, so the admin API cannot be IP-allowlisted at the VPS. The service key is the network-level control. With Vercel Secure Compute or Pro static IPs, add an allowlist for `/v1/admin/*` in Caddy.
* In-memory rate limits reset on restart.
* The package-signing key and Chrome Web Store account are outside this repository. Protect them like production credentials.
