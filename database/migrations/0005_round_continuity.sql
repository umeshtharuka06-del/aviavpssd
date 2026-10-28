-- 0005_round_continuity.sql
-- Additive and non-destructive: three NULLABLE columns, no default, so no existing row is rewritten
-- or changed (existing rows keep NULL and are judged by the 120 s time rule exactly as before).
--
-- Collector continuity evidence (see ContinuitySchema in shared/contracts/src/customer.ts):
--   chain_id      the collector's unbroken read chain the round came from
--   chain_index   the round's position in that chain
--   break_before  computed when the round is stored:
--                   false -> verified to be the round right after the previously stored round
--                   true  -> rounds may be missing before it (new chain, or a jump in the index)
--                   NULL  -> unknown (older client): use the time rule
ALTER TABLE game_observations
  ADD COLUMN chain_id uuid,
  ADD COLUMN chain_index integer CHECK (chain_index >= 0),
  ADD COLUMN break_before boolean;
