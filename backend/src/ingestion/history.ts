import type { HistoryIngestRequest, HistoryIngestResponse } from '@aviator/contracts';
import { AppError } from '../api/errors.js';
import { isSiteAccepted } from '../config/env.js';
import type { CustomerAuth } from '../auth/customer-session.js';
import type { AppContext } from '../context.js';
import { withTransaction } from '../database/pool.js';

/**
 * Stores completed-round observations as TEMPORARY history.
 *
 *  - received_at is set by the database (DEFAULT now()); nothing from the client affects it.
 *  - batchId makes retries idempotent: a repeated (device, batchId) stores nothing again.
 *  - Rows with a roundRef are de-duplicated PER DEVICE (so each device keeps its own isolated
 *    history; a single device still cannot store the same round twice on retries/overlap).
 *  - Raw observations are never written to logs or to any permanent table.
 */
export async function ingestHistory(ctx: AppContext, auth: CustomerAuth, input: HistoryIngestRequest): Promise<HistoryIngestResponse> {
  if (!isSiteAccepted(ctx.env, input.siteId)) {
    throw new AppError('VALIDATION_FAILED', 'This site is not supported.', { issues: [{ path: 'siteId', message: 'unsupported site' }] });
  }
  const refs = input.observations.map((o) => o.roundRef).filter((r): r is string => !!r);
  if (new Set(refs).size !== refs.length) {
    throw new AppError('VALIDATION_FAILED', 'Duplicate roundRef values in one batch.', { issues: [{ path: 'observations', message: 'duplicate roundRef' }] });
  }

  return withTransaction(ctx.pool, async (db) => {
    const claim = await db.query(
      `INSERT INTO ingest_batches (device_activation_id, batch_id, accepted_count, duplicate_count)
       VALUES ($1, $2, 0, 0) ON CONFLICT DO NOTHING RETURNING batch_id`,
      [auth.deviceActivationId, input.batchId],
    );
    if (claim.rowCount === 0) {
      return { result: 'duplicate_batch', accepted: 0, duplicates: input.observations.length };
    }
    const inserted = await db.query(
      `INSERT INTO game_observations (site_id, multiplier, round_ref, device_activation_id)
       SELECT $1, m, r, $4
         FROM unnest($2::numeric[], $3::text[]) WITH ORDINALITY AS t(m, r, ord)
        ORDER BY ord
       ON CONFLICT (device_activation_id, site_id, round_ref) WHERE round_ref IS NOT NULL DO NOTHING`,
      [
        input.siteId,
        input.observations.map((o) => o.multiplier.toFixed(2)),
        input.observations.map((o) => o.roundRef ?? null),
        auth.deviceActivationId,
      ],
    );
    const accepted = inserted.rowCount ?? 0;
    const duplicates = input.observations.length - accepted;
    await db.query(
      'UPDATE ingest_batches SET accepted_count = $3, duplicate_count = $4 WHERE device_activation_id = $1 AND batch_id = $2',
      [auth.deviceActivationId, input.batchId, accepted, duplicates],
    );
    return { result: 'accepted', accepted, duplicates };
  });
}
