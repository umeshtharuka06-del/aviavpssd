-- 0006_range_strategy.sql
-- Additive and non-destructive: three NULLABLE columns, no default, so no existing row is rewritten
-- or changed. Rows recorded before this migration keep NULL (no strategy record, no target scoring).
--
-- Range state machine (engine stat-5.4, contract RangeStrategyForecastSchema):
--   round_forecasts.strategy             the state machine at issue time: state, consecutive-low count,
--                                        target threshold, predicted range, probabilities, rule config
--   forecast_outcomes.target_hit         actual multiplier >= the strategy's target threshold
--   forecast_outcomes.strategy_range_hit actual multiplier inside the strategy's predicted range
-- Both outcome columns are written once with the outcome row; the immutability triggers of 0004 apply.
ALTER TABLE round_forecasts ADD COLUMN strategy jsonb;
ALTER TABLE forecast_outcomes
  ADD COLUMN target_hit boolean,
  ADD COLUMN strategy_range_hit boolean;
