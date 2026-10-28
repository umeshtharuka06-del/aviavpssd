# Retention rules

Implemented in `backend/src/retention/purge.ts` and run by `backend/src/workers/retention-worker.ts`. The full policy, monitoring and backup notes are in [docs/DATA_RETENTION.md](../../docs/DATA_RETENTION.md).

```sql
-- history (every pass, batched, database clock)
DELETE FROM game_observations WHERE id IN (
  SELECT id FROM game_observations WHERE received_at < now() - interval '12 hours'
  ORDER BY received_at LIMIT 5000);
DELETE FROM ingest_batches WHERE received_at < now() - interval '12 hours';

-- housekeeping (never touches codes, subscriptions or device slots)
DELETE FROM customer_sessions WHERE expires_at < now() - interval '30 days';
DELETE FROM admin_sessions    WHERE expires_at < now() - interval '30 days';
DELETE FROM security_events   WHERE occurred_at < now() - make_interval(days => <SECURITY_EVENT_RETENTION_DAYS>);
```
