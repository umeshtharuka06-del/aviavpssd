# Schema overview (migrations 0001–0002)

| Table | Kind | Key columns | Notes |
|---|---|---|---|
| `admin_users` | durable | `email` (unique, lower-case), `password_hash` (Argon2id) | lockout: `failed_login_count`, `locked_until` |
| `admin_sessions` | bounded | `token_hash` (SHA-256), `expires_at`, `revoked_at` | 8 h TTL |
| `activation_codes` | durable | `public_id` (`ac_…`), `code_hash` (HMAC, unique), `code_hint` (last 4), `plan`, `duration_days`, `device_limit`, `redeem_by`, `redeemed_at`, `revoked_*` | the plaintext is never stored |
| `subscriptions` | durable | `activation_code_id` **UNIQUE** (one per code), `activated_at`, `expires_at`, `revoked_at` | never deleted by retention |
| `device_activations` | durable | `subscription_id`, `device_hash` (HMAC), `public_id` (`dv_…`, 0002), `device_label` (0002), `deactivated_at/_reason` | partial unique index: one active slot per (subscription, device); trigger `enforce_device_limit` (0002) refuses slots beyond `device_limit` |
| `customer_sessions` | bounded | `token_hash`, `expires_at`, `revoked_at` | one live session per device |
| `game_observations` | **temporary (12 h)** | `site_id`, `multiplier numeric(12,2)`, `round_ref`, `received_at DEFAULT now()` | indexes on `received_at` and `(site_id, received_at)`; unique `(site_id, round_ref)` when present |
| `ingest_batches` | **temporary (12 h)** | PK `(device_activation_id, batch_id)` | idempotency keys |
| `security_events` | bounded (90 d) | `event_type`, `actor`, `ip_hash`, `detail jsonb` | never holds codes, tokens or history |
| `worker_heartbeats` | operational | `worker_name`, `last_success_at`, `last_error`, `last_deleted_count` | retention monitoring |
| `schema_migrations` | operational | `name`, `checksum` | created by the migration runner |

Internal `bigint` ids never leave the API. Clients see only `public_id`, hints and ISO timestamps.
