-- 0007_chain_links.sql
-- Additive and non-destructive: one new table, no existing row or column is changed.
--
-- After a game-page reload the collector starts a new read chain and sends the visible results as a
-- backfill. When every visible result is already stored, nothing is inserted, so no stored row carries
-- the new chain, and the first live round on it was judged a break (break_before = true): the forecast
-- for it was voided and the consecutive-low count restarted although no round was missed.
-- A chain link records what the value alignment proved: position chain_index of chain chain_id is the
-- stored round observation_id. continuityBreak accepts the next position of that chain as verified.
-- Temporary like the history it refers to: the retention worker deletes links after 12 h.
CREATE TABLE chain_links (
  device_activation_id bigint      NOT NULL REFERENCES device_activations(id) ON DELETE CASCADE,
  site_id              text        NOT NULL CHECK (site_id ~ '^[a-z0-9_-]{1,32}$'),
  chain_id             uuid        NOT NULL,
  chain_index          integer     NOT NULL CHECK (chain_index >= 0),
  -- No foreign key: the round expires after 12 h like all history.
  observation_id       bigint      NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (device_activation_id, site_id, chain_id, chain_index)
);
CREATE INDEX chain_links_created_idx ON chain_links (created_at);
