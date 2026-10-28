-- 0004_round_forecast_ledger.sql
-- Additive and non-destructive: no existing row is changed or deleted, no table is dropped.
--
--  1. game_observations.source: 'live' (default; every existing row) or 'backfill' (results that
--     were already visible on the game page when collection started, stored once and aligned
--     with the stored rounds; see POST /v1/history/backfill).
--  2. round_forecasts: ONE immutable forecast per (device, site, input boundary). The input boundary
--     is the id of the last stored round the forecast was allowed to use. UPDATE is forbidden.
--  3. forecast_outcomes: the outcome of a forecast, written exactly once (primary key = forecast).
--     UPDATE is forbidden.
-- Both new tables are temporary like the history they derive from: the retention worker deletes
-- forecasts issued more than HISTORY_RETENTION_HOURS (12 h) ago; outcomes cascade.

-- 1. data source of each round
ALTER TABLE game_observations ADD COLUMN source text NOT NULL DEFAULT 'live'
  CHECK (source IN ('live', 'backfill'));

-- 2. forecasts
CREATE TABLE round_forecasts (
  id                        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_id                 text        NOT NULL UNIQUE CHECK (public_id ~ '^fc_[0-9A-Z]{16}$'),
  device_activation_id      bigint      NOT NULL REFERENCES device_activations(id) ON DELETE CASCADE,
  site_id                   text        NOT NULL CHECK (site_id ~ '^[a-z0-9_-]{1,32}$'),
  -- No foreign key: the input round expires after 12 h like all history.
  input_last_observation_id bigint      NOT NULL,
  input_last_received_at    timestamptz NOT NULL,
  input_round_count         integer     NOT NULL CHECK (input_round_count > 0),
  engine_version            text        NOT NULL CHECK (length(engine_version) <= 32),
  state                     text        NOT NULL CHECK (state IN ('experimental', 'validated', 'baseline_only')),
  displayed_model           text        NOT NULL CHECK (displayed_model ~ '^[a-z_]{1,24}$'),
  probabilities             double precision[] NOT NULL CHECK (array_length(probabilities, 1) = 4),
  -- {"baseline":[4 numbers], "ewma":[…], …, "ensemble":[…]} at issue time
  model_vectors             jsonb       NOT NULL,
  -- evidence at issue time: {"scored":…, "logLossDiff":…, "bestCandidate":…, "bestLog10EValue":…}
  issue_evidence            jsonb       NOT NULL,
  issued_at                 timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT round_forecasts_once UNIQUE (device_activation_id, site_id, input_last_observation_id)
);
CREATE INDEX round_forecasts_device_site_idx ON round_forecasts (device_activation_id, site_id, id);
CREATE INDEX round_forecasts_issued_idx ON round_forecasts (issued_at);

-- 3. outcomes (scored or void), one per forecast
CREATE TABLE forecast_outcomes (
  forecast_id           bigint      PRIMARY KEY REFERENCES round_forecasts(id) ON DELETE CASCADE,
  status                text        NOT NULL CHECK (status IN ('scored', 'void')),
  void_reason           text        CHECK (void_reason IN ('gap', 'late')),
  target_observation_id bigint,
  actual_multiplier     numeric(12,2),
  actual_range          smallint    CHECK (actual_range BETWEEN 0 AND 3),
  log_loss              double precision,
  baseline_log_loss     double precision,
  brier                 double precision,
  top_range_hit         boolean,
  scored_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT forecast_outcomes_consistency CHECK (
    (status = 'scored' AND void_reason IS NULL AND target_observation_id IS NOT NULL AND actual_multiplier IS NOT NULL
       AND actual_range IS NOT NULL AND log_loss IS NOT NULL AND baseline_log_loss IS NOT NULL AND brier IS NOT NULL AND top_range_hit IS NOT NULL)
    OR (status = 'void' AND void_reason IS NOT NULL)
  )
);

-- Recorded forecasts and outcomes can be inserted or (by retention) deleted, never changed.
CREATE FUNCTION forbid_ledger_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'forecast ledger rows are immutable' USING ERRCODE = 'integrity_constraint_violation';
END;
$$;
CREATE TRIGGER round_forecasts_immutable BEFORE UPDATE ON round_forecasts
  FOR EACH ROW EXECUTE FUNCTION forbid_ledger_update();
CREATE TRIGGER forecast_outcomes_immutable BEFORE UPDATE ON forecast_outcomes
  FOR EACH ROW EXECUTE FUNCTION forbid_ledger_update();
