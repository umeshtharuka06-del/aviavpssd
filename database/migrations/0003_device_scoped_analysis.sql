-- 0003_device_scoped_analysis.sql
-- Additive and non-destructive: no row is deleted, no table is dropped, no volume is reset.
-- Only indexes on the TEMPORARY game_observations table change.
--
-- Phase 2 makes each device's analysis independent. Two changes support that:
--
--  1. A read index for the device-scoped analysis query (one device's recent rounds on one site).
--  2. Round de-duplication becomes PER-DEVICE instead of per-site. Previously the same round
--     reported by two devices was stored once (site-wide), which silently merged one device's
--     history into another's. For isolated per-device history, each device keeps its own copy of
--     a round; a single device still cannot store the same round_ref twice (retries/overlap).
--     The partial unique index is rebuilt with device_activation_id as its leading column.

-- 1. Device-scoped analysis read path: WHERE device_activation_id = $d AND site_id = $s ORDER BY received_at DESC.
CREATE INDEX IF NOT EXISTS game_observations_device_site_received_idx
  ON game_observations (device_activation_id, site_id, received_at DESC);

-- 2. Per-device round de-duplication (replaces the site-wide unique index).
DROP INDEX IF EXISTS game_observations_round_uq;
CREATE UNIQUE INDEX game_observations_round_uq
  ON game_observations (device_activation_id, site_id, round_ref)
  WHERE round_ref IS NOT NULL;
