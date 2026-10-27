import { HISTORY_RETENTION_HOURS } from '@aviator/contracts';
import type { Pool } from '../database/pool.js';
import { purgeExpiredForecasts } from '../engine/sequential/ledger-service.js';

/**
 * Deletes temporary history whose server-side received_at is older than 12 hours.
 *
 *  - Uses the DATABASE clock (now()) and the DB-assigned received_at — no client time involved.
 *  - Independent of analysis: there is no "analyzed" flag; rows are deleted whether or not any
 *    analysis ever ran or failed.
 *  - Deletes in bounded batches so a large backlog (e.g. after downtime) cannot hold long locks.
 *  - Idempotent: running it again simply finds nothing to delete.
 */
export async function purgeExpiredHistory(pool: Pool, batchSize = 5_000): Promise<{ observations: number; batches: number; forecasts: number }> {
  let observations = 0;
  for (;;) {
    const r = await pool.query(
      `DELETE FROM game_observations WHERE id IN (
         SELECT id FROM game_observations
          WHERE received_at < now() - make_interval(hours => $1)
          ORDER BY received_at LIMIT $2)`,
      [HISTORY_RETENTION_HOURS, batchSize],
    );
    observations += r.rowCount ?? 0;
    if ((r.rowCount ?? 0) < batchSize) break;
  }
  const b = await pool.query('DELETE FROM ingest_batches WHERE received_at < now() - make_interval(hours => $1)', [HISTORY_RETENTION_HOURS]);
  // Forecasts and their outcomes derive from the same rounds and expire on the same schedule.
  const forecasts = await purgeExpiredForecasts(pool, batchSize);
  return { observations, batches: b.rowCount ?? 0, forecasts };
}

/**
 * Housekeeping for durable-but-bounded operational data. Never touches subscriptions,
 * codes or active device slots.
 */
export async function purgeOperationalData(pool: Pool, securityEventRetentionDays: number): Promise<void> {
  await pool.query("DELETE FROM customer_sessions WHERE expires_at < now() - interval '30 days'");
  await pool.query("DELETE FROM admin_sessions WHERE expires_at < now() - interval '30 days'");
  await pool.query('DELETE FROM security_events WHERE occurred_at < now() - make_interval(days => $1)', [securityEventRetentionDays]);
}

export interface RetentionHealth {
  lastStartedAt: Date | null;
  lastSuccessAt: Date | null;
  lastError: string | null;
  lastDeletedCount: number;
  totalRuns: number;
  observationCount: number;
  oldestAgeSeconds: number | null;
  healthy: boolean;
}

export const RETENTION_WORKER_NAME = 'history-retention';

/**
 * Health = the worker succeeded within 3 intervals AND no observation is older than
 * 12 h + 2 intervals (grace for the scheduling period).
 */
export async function retentionHealth(pool: Pool, intervalSeconds: number): Promise<RetentionHealth> {
  const hb = await pool.query<{
    last_started_at: Date | null;
    last_success_at: Date | null;
    last_error: string | null;
    last_deleted_count: number;
    total_runs: number;
    success_age: number | null;
  }>(
    `SELECT last_started_at, last_success_at, last_error, last_deleted_count, total_runs,
            extract(epoch FROM now() - last_success_at)::int AS success_age
       FROM worker_heartbeats WHERE worker_name = $1`,
    [RETENTION_WORKER_NAME],
  );
  const obs = await pool.query<{ n: number; oldest_age: number | null }>(
    `SELECT count(*)::int AS n, extract(epoch FROM now() - min(received_at))::int AS oldest_age FROM game_observations`,
  );
  const h = hb.rows[0];
  const o = obs.rows[0]!;
  const workerFresh = h?.success_age != null && h.success_age <= intervalSeconds * 3;
  const nothingStale = o.oldest_age == null || o.oldest_age <= HISTORY_RETENTION_HOURS * 3600 + intervalSeconds * 2;
  return {
    lastStartedAt: h?.last_started_at ?? null,
    lastSuccessAt: h?.last_success_at ?? null,
    lastError: h?.last_error ?? null,
    lastDeletedCount: h?.last_deleted_count ?? 0,
    totalRuns: h?.total_runs ?? 0,
    observationCount: o.n,
    oldestAgeSeconds: o.oldest_age,
    healthy: workerFresh && nothingStale,
  };
}
