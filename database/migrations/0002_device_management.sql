-- 0002_device_management.sql
-- Additive and non-destructive: no rows are deleted, no activation, subscription period or
-- device limit of an existing code is changed.
--
--  1. Device slots get a public id (for per-device admin revocation) and an optional coarse
--     label sent by the extension (e.g. "Chrome · Windows"). Existing slots are backfilled.
--  2. New deactivation reason 'admin_revoked' (one device removed by an admin).
--  3. Database-level guard: an active device slot can never be added beyond the code's
--     device_limit, even under concurrent requests or a future application bug.

-- 1. public id + label
ALTER TABLE device_activations ADD COLUMN public_id text;
UPDATE device_activations
   SET public_id = 'dv_' || upper(substr(md5(random()::text || clock_timestamp()::text || id::text), 1, 16))
 WHERE public_id IS NULL;
ALTER TABLE device_activations ALTER COLUMN public_id SET NOT NULL;
ALTER TABLE device_activations ADD CONSTRAINT device_activations_public_id_key UNIQUE (public_id);
ALTER TABLE device_activations ADD CONSTRAINT device_activations_public_id_format CHECK (public_id ~ '^dv_[0-9A-Z]{16}$');

ALTER TABLE device_activations ADD COLUMN device_label text
  CHECK (device_label IS NULL OR (length(device_label) <= 60 AND device_label ~ '^[A-Za-z0-9 ·._()/-]*$'));

-- 2. deactivation reasons
ALTER TABLE device_activations DROP CONSTRAINT device_activations_deactivated_reason_check;
ALTER TABLE device_activations ADD CONSTRAINT device_activations_deactivated_reason_check
  CHECK (deactivated_reason IN ('admin_reset', 'code_revoked', 'admin_revoked'));

-- 3. device-limit guard
CREATE FUNCTION enforce_device_limit() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  lim  integer;
  used integer;
BEGIN
  -- Lock the subscription row: concurrent inserts for the same subscription are serialized.
  SELECT c.device_limit INTO lim
    FROM subscriptions s
    JOIN activation_codes c ON c.id = s.activation_code_id
   WHERE s.id = NEW.subscription_id
     FOR UPDATE OF s;
  SELECT count(*) INTO used
    FROM device_activations
   WHERE subscription_id = NEW.subscription_id
     AND deactivated_at IS NULL
     AND id <> NEW.id;
  IF used >= lim THEN
    RAISE EXCEPTION 'device_limit_exceeded' USING ERRCODE = 'check_violation',
      DETAIL = format('subscription %s already has %s of %s active devices', NEW.subscription_id, used, lim);
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER device_activations_enforce_limit
  BEFORE INSERT OR UPDATE OF deactivated_at, subscription_id ON device_activations
  FOR EACH ROW WHEN (NEW.deactivated_at IS NULL)
  EXECUTE FUNCTION enforce_device_limit();
