# API contracts — v1

Schemas live in `shared/contracts/src/*.ts` (zod). The backend validates every request with them, and the extension and admin site validate every response with them. All bodies are JSON (`Content-Type: application/json`; anything else → 415). All timestamps are ISO-8601 UTC.

## Errors

Every error has the same shape:

```json
{ "error": { "code": "CODE_ALREADY_USED", "message": "Human readable.", "requestId": "uuid", "details": { } } }
```

| HTTP | `code` | Meaning |
|---|---|---|
| 400 | `VALIDATION_FAILED` | Schema violation. `details.issues[]` lists `{path, message}` and never echoes the values sent |
| 404 | `NOT_FOUND`, `CODE_INVALID` | Unknown route / code does not exist or is malformed |
| 409 | `DEVICE_LIMIT_REACHED` | All device slots of the subscription are taken (`details: { deviceLimit, devicesInUse }`) |
| 409 | `CODE_ALREADY_USED` | Legacy code, no longer returned (kept so old clients still parse errors) |
| 410 | `CODE_EXPIRED` | `details.reason`: `not_redeemed_in_time` or `subscription_ended` |
| 410 | `CODE_REVOKED` | Revoked by an admin |
| 401 | `SESSION_INVALID`, `SESSION_EXPIRED`, `DEVICE_MISMATCH` | Customer must refresh or re-activate |
| 403 | `SUBSCRIPTION_EXPIRED`, `SUBSCRIPTION_REVOKED` | Valid device, no active subscription |
| 401 / 403 | `ADMIN_UNAUTHORIZED` / `ADMIN_FORBIDDEN` | Missing/invalid admin session / missing/invalid service key |
| 413 | `PAYLOAD_TOO_LARGE` | Body > 8 KB |
| 429 | `RATE_LIMITED` | `details.retryAfterSeconds` |
| 500 / 503 | `INTERNAL_ERROR`, `SERVICE_UNAVAILABLE`, `ANALYSIS_UNAVAILABLE` | Server-side problem (no internals disclosed) |

Every response carries `x-request-id` (server-generated) and `cache-control: no-store`.

## Customer endpoints

Authentication: `Authorization: Bearer <session token>` (43-char base64url), except redeem.

| Method & path | Body | Response | Rate limit |
|---|---|---|---|
| `POST /v1/activation/redeem` | `{ code, deviceId (uuid), clientVersion?, deviceLabel? ("Chrome · Windows") }` | `{ result: activated \| device_added \| device_restored, session: {token, expiresAt}, subscription }` | 10 / 10 min / IP |
| `GET /v1/subscription` | — | `{ subscription, session: {expiresAt} }` | 60 / min / session |
| `POST /v1/session/refresh` | `{ deviceId }` | `{ session, subscription }`. Old token revoked. Allowed up to 30 days after session expiry, never after the subscription ends | 10 / 10 min / session |
| `POST /v1/session/logout` | — | 204. The device slot stays assigned | 10 / min |
| `POST /v1/history` | `{ batchId (uuid), siteId, adapterVersion, observations: [{ multiplier, roundRef? }] (1–50) }` | `{ result: accepted \| duplicate_batch, accepted, duplicates }` | 60 / min / session |
| `POST /v1/analysis` | `{ siteId }` | `AnalysisResponse` (below) | 30 / min / session |

`subscription` = `{ plan: "30d"|"365d", status: "active"|"expired"|"revoked", activatedAt, expiresAt, deviceLimit, devicesInUse }`.

**History rules.** `multiplier` is 1–1,000,000 with at most 2 decimals. `siteId` (the site key of the top page, e.g. `example-casino-com`) must be in the server's `ACCEPTED_SITE_IDS`, be the canonical key of a hostname in `ACCEPTED_SITE_DOMAINS`, or `ACCEPTED_SITE_IDS` must contain `*`. Unknown fields are rejected, so clients **cannot** send timestamps. A repeated `(device, batchId)` stores nothing (`duplicate_batch`). A repeated `(siteId, roundRef)` is stored once.

**AnalysisResponse.**

```json
{ "engine": { "kind": "mock", "version": "mock-1" }, "isTestData": true, "status": "ok",
  "siteId": "onexbet", "generatedAt": "…", "windowHours": 12, "observationsConsidered": 37,
  "items": [{ "label": "…", "value": "…" }], "notice": "TEST DATA — …" }
```

Clients must show a "test data" label whenever `isTestData` is true. `engine` never exposes implementation details.

The live (`statistical`) provider adds an optional **`summary`** — this device's own observed rounds on this site (12 h window). It is descriptive history, never a next-round prediction:

```json
"summary": { "scope": "device", "sampleSize": 1234, "minSampleSize": 100, "sufficiency": "sufficient",
  "thresholds": [ { "threshold": 2, "count": 600, "frequency": 0.4862 },
                  { "threshold": 5, "count": 200, "frequency": 0.1621 },
                  { "threshold": 10, "count": 99, "frequency": 0.0802 } ],
  "below2x": { "threshold": 2, "count": 634, "frequency": 0.5138 },
  "averageMultiplier": 3.46, "invalidExcluded": 0,
  "latestRoundAt": "…", "freshnessSeconds": 14, "isHistoricalOnly": true }
```

| Field | Formula (n = valid rounds: finite multiplier within 1–1,000,000) |
|---|---|
| `thresholds[].frequency` | count(multiplier ≥ T) / n — "historical frequency", shown ×100 as % |
| `below2x.frequency` | count(multiplier < 2) / n (= 1 − frequency(≥2×)) — the combined historical indicator |
| `averageMultiplier` | sum(multiplier) / n — "historical average multiplier" |
| `sufficiency` | `no_data` (n = 0) · `collecting` (n < `minSampleSize`) · `sufficient` |

Every ratio is `null` when n = 0 (never a substituted zero). `minSampleSize` is the server setting `ANALYSIS_MIN_SAMPLE_SIZE` (default 100); `status` is `ok` only when `sufficiency` is `sufficient`. Earlier servers sent `metrics` / `patterns` / `signal` (rolling windows, baseline comparisons); those fields were removed and the schema strips them, so mixed versions keep validating.

`forecast` (optional, engine `stat-4`+, `method: "walk_forward_v2"`): the walk-forward next-round forecast experiment — `status` (`insufficient_data` | `evaluated`), sample and test sizes (`minSampleSize` 100 = `trainInitial` 50 + `minTestRounds` 50), the decision rules (`alpha` = 0.05 ÷ `comparisons`, `minEvents`, `permutationMaxRounds`), and per threshold its test `testEvents`, an estimated `probability` with a 95% `low`/`high` (or null), its `status` (`validated_model` · `no_predictive_value` · `not_calibrated` · `validated_model_not_current` · `insufficient_events`), and every model's out-of-sample log loss, Brier, skill vs the base rate, Diebold–Mariano p-value, exact permutation p-value (when run) and calibration result. Method: [NEXT_ROUND_FORECAST.md](NEXT_ROUND_FORECAST.md). Older servers omit it; older clients strip it.

## Admin endpoints (`/v1/admin/*`)

Every call needs `X-Admin-Service-Key: <ADMIN_SERVICE_KEY>`. Without it the response is 403, even with a valid session. Every call except login also needs `Authorization: Bearer <admin session>` (8 h TTL). The admin site sends the end user's IP as `X-Admin-Client-IP`, which the server trusts only after the service key checks out. These endpoints are called only from the admin site's server runtime.

| Method & path | Body / query | Response |
|---|---|---|
| `POST /auth/login` | `{ email, password }` | `{ token, expiresAt, admin: {email} }`. 5 / min / client IP; lockout after 5 failures (15 min); generic error message |
| `POST /auth/logout` | — | 204 |
| `GET /me` | — | `{ admin, session }` |
| `POST /codes` | `{ plan, quantity 1–20 = 1, deviceLimit 1–5 = DEFAULT_DEVICE_LIMIT (5), redeemWithinDays 1–730 \| null = 90, note? }` | `{ codes: [AdminCodeView + code] }`. **The only response that contains plaintext codes** |
| `GET /codes` | `status, plan, redeemed, createdFrom, createdTo, q (public id prefix or 4-char hint), page, pageSize ≤ 100` | `{ items: AdminCodeView[], total, page, pageSize }` |
| `GET /codes/stats` | — | `{ total, byStatus, byPlan }` |
| `POST /codes/:id/revoke` | `{ reason }` | `{ code }`. Idempotent; revokes the subscription, device slots and sessions |
| `POST /codes/:id/reset-devices` | `{ reason }` | `{ code }`. Frees all device slots; the period is unchanged |
| `GET /codes/:id/devices` | — | `{ code, devices: [{ id: "dv_…", label, status: active\|removed, removedReason, activatedAt, lastSeenAt, removedAt }] }` |
| `POST /codes/:id/devices/:deviceId/revoke` | `{ reason }` | `{ code, devices }`. Frees ONE slot and revokes that device's sessions. Expiry unchanged |
| `POST /codes/:id/device-limit` | `{ deviceLimit 1–5, reason }` | `{ code, devices }`. Refused below the devices in use. Expiry unchanged |
| `GET /settings` | — | `{ defaultDeviceLimit, maxDeviceLimit }` |
| `GET /system/retention` | — | Retention worker health |

`AdminCodeView` = `{ id: "ac_…", hint: "7QK2", plan, status: unused|active|expired|revoked, deviceLimit, devicesInUse, note, createdAt, redeemBy, redeemedAt, expiresAt, revokedAt, revokeReason }`. It contains no database ids and no hashes.

## Health

| `GET /v1/health` | Liveness: `{ status, version, time }`. No dependency details |
|---|---|
| `GET /v1/health/ready` | Also checks the database: 200 or 503 `SERVICE_UNAVAILABLE` |
