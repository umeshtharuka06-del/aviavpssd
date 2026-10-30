-- 0001_initial_schema.sql
-- All timestamps are timestamptz and written in UTC by the server/database clock.
-- Durable records (admins, codes, subscriptions, devices, security events) are kept
-- separate from TEMPORARY game history (game_observations, ingest_batches), which is
-- deleted 12 hours after receipt by the retention worker.

-- ===================== Administrators =====================

CREATE TABLE admin_users (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email               text        NOT NULL UNIQUE CHECK (email = lower(email) AND length(email) <= 254),
  password_hash       text        NOT NULL,              -- Argon2id PHC string
  is_active           boolean     NOT NULL DEFAULT true,
  failed_login_count  integer     NOT NULL DEFAULT 0,
  locked_until        timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  last_login_at       timestamptz
);

CREATE TABLE admin_sessions (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  admin_user_id   bigint      NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  token_hash      bytea       NOT NULL UNIQUE,             -- SHA-256 of the opaque token
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  revoked_at      timestamptz,
  last_seen_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX admin_sessions_expires_idx ON admin_sessions (expires_at);

-- ===================== Activation codes =====================
-- The redeemable plaintext is NEVER stored. code_hash = HMAC-SHA256(CODE_PEPPER, normalized code).

CREATE TABLE activation_codes (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_id       text        NOT NULL UNIQUE CHECK (public_id ~ '^ac_[0-9A-Z]{16}$'),
  code_hash       bytea       NOT NULL UNIQUE CHECK (octet_length(code_hash) = 32),
  code_hint       text        NOT NULL CHECK (code_hint ~ '^[0-9A-Z]{4}$'),
  plan            text        NOT NULL CHECK (plan IN ('30d', '365d')),
  duration_days   integer     NOT NULL,
  device_limit    integer     NOT NULL CHECK (device_limit BETWEEN 1 AND 5),
  redeem_by       timestamptz,
  note            text        CHECK (length(note) <= 200),
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      bigint      REFERENCES admin_users(id) ON DELETE SET NULL,
  redeemed_at     timestamptz,
  revoked_at      timestamptz,
  revoked_by      bigint      REFERENCES admin_users(id) ON DELETE SET NULL,
  revoke_reason   text        CHECK (length(revoke_reason) <= 200),
  CONSTRAINT activation_codes_plan_duration CHECK (
    (plan = '30d' AND duration_days = 30) OR (plan = '365d' AND duration_days = 365)
  ),
  CONSTRAINT activation_codes_revoke_consistency CHECK ((revoked_at IS NULL) = (revoke_reason IS NULL))
);
CREATE INDEX activation_codes_created_idx ON activation_codes (created_at DESC);
CREATE INDEX activation_codes_hint_idx ON activation_codes (code_hint);

-- ===================== Subscriptions =====================
-- One subscription per code (UNIQUE activation_code_id): a code can only be redeemed once.
-- Never deleted by history retention.

CREATE TABLE subscriptions (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  activation_code_id  bigint      NOT NULL UNIQUE REFERENCES activation_codes(id) ON DELETE RESTRICT,
  plan                text        NOT NULL CHECK (plan IN ('30d', '365d')),
  activated_at        timestamptz NOT NULL,
  expires_at          timestamptz NOT NULL,
  revoked_at          timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT subscriptions_period CHECK (expires_at > activated_at)
);

-- ===================== Devices =====================
-- device_hash = HMAC-SHA256(DEVICE_PEPPER, extension-generated random UUID).
-- No hardware identifiers, IPs or browser fingerprints are stored.

CREATE TABLE device_activations (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  subscription_id     bigint      NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  device_hash         bytea       NOT NULL CHECK (octet_length(device_hash) = 32),
  activated_at        timestamptz NOT NULL DEFAULT now(),
  last_seen_at        timestamptz NOT NULL DEFAULT now(),
  deactivated_at      timestamptz,
  deactivated_reason  text        CHECK (deactivated_reason IN ('admin_reset', 'code_revoked')),
  CONSTRAINT device_activations_deactivation CHECK ((deactivated_at IS NULL) = (deactivated_reason IS NULL))
);
-- At most one ACTIVE slot per (subscription, device).
CREATE UNIQUE INDEX device_activations_active_uq
  ON device_activations (subscription_id, device_hash) WHERE deactivated_at IS NULL;

CREATE TABLE customer_sessions (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  device_activation_id  bigint      NOT NULL REFERENCES device_activations(id) ON DELETE CASCADE,
  token_hash            bytea       NOT NULL UNIQUE,      -- SHA-256 of the opaque token
  created_at            timestamptz NOT NULL DEFAULT now(),
  expires_at            timestamptz NOT NULL,
  revoked_at            timestamptz
);
CREATE INDEX customer_sessions_device_idx ON customer_sessions (device_activation_id);
CREATE INDEX customer_sessions_expires_idx ON customer_sessions (expires_at);

-- ===================== TEMPORARY game history (12 h) =====================
-- received_at is ALWAYS set by the database (DEFAULT now()); the API never accepts it from
-- clients. Rows are deleted when received_at < now() - 12 hours, independent of analysis.

CREATE TABLE game_observations (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  site_id               text          NOT NULL CHECK (site_id ~ '^[a-z0-9_-]{1,32}$'),
  multiplier            numeric(12,2) NOT NULL CHECK (multiplier >= 1 AND multiplier <= 1000000),
  round_ref             text          CHECK (round_ref ~ '^[A-Za-z0-9._:-]{1,64}$'),
  device_activation_id  bigint        REFERENCES device_activations(id) ON DELETE SET NULL,
  received_at           timestamptz   NOT NULL DEFAULT now()
);
-- Retention scans and deletes by received_at.
CREATE INDEX game_observations_received_idx ON game_observations (received_at);
-- Analysis reads one site's recent window.
CREATE INDEX game_observations_site_received_idx ON game_observations (site_id, received_at DESC);
-- Same round reported by several devices is stored once (only when the adapter reads a round id).
CREATE UNIQUE INDEX game_observations_round_uq
  ON game_observations (site_id, round_ref) WHERE round_ref IS NOT NULL;

-- Idempotency keys for ingestion batches. Also temporary (12 h).
CREATE TABLE ingest_batches (
  device_activation_id  bigint      NOT NULL REFERENCES device_activations(id) ON DELETE CASCADE,
  batch_id              uuid        NOT NULL,
  accepted_count        integer     NOT NULL,
  duplicate_count       integer     NOT NULL,
  received_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (device_activation_id, batch_id)
);
CREATE INDEX ingest_batches_received_idx ON ingest_batches (received_at);

-- ===================== Operations / security =====================

-- Security & audit events. Never contains plaintext codes, tokens, passwords or game history.
CREATE TABLE security_events (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  event_type    text        NOT NULL CHECK (event_type ~ '^[a-z_.]{1,64}$'),
  actor         text        CHECK (length(actor) <= 80),
  ip_hash       bytea,      -- HMAC of client IP (privacy), for abuse correlation only
  detail        jsonb       NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX security_events_occurred_idx ON security_events (occurred_at);
CREATE INDEX security_events_type_idx ON security_events (event_type, occurred_at DESC);

-- Heartbeats of background workers, used for monitoring retention.
CREATE TABLE worker_heartbeats (
  worker_name         text        PRIMARY KEY,
  last_started_at     timestamptz,
  last_finished_at    timestamptz,
  last_success_at     timestamptz,
  last_error          text,
  last_deleted_count  bigint      NOT NULL DEFAULT 0,
  total_runs          bigint      NOT NULL DEFAULT 0
);
