import { HISTORY_RETENTION_HOURS, type BackfillRequest, type BackfillResponse, type Continuity } from '@aviator/contracts';
import { AppError } from '../api/errors.js';
import type { CustomerAuth } from '../auth/customer-session.js';
import { isSiteAccepted } from '../config/env.js';
import type { AppContext } from '../context.js';
import { withTransaction, type Client as PoolClient } from '../database/pool.js';
import { SIGNAL_RULES } from '../engine/sequential/engine.js';
import { lockLedger, syncLedger } from '../engine/sequential/ledger-service.js';

/** Stored rounds compared with the visible results. */
const TAIL = 200;
/** An alignment inside the visible list needs at least this many consecutive matching rounds. */
export const MIN_ALIGN = 4;

export type Alignment = { kind: 'append'; from: number } | { kind: 'reject'; reason: string };

/**
 * Where the stored rounds end inside the visible list `shown` (both oldest → newest), so that only
 * rounds after that point are stored. There are no round ids, so this is done by matching values:
 *
 *  - strong match at j: the last L stored rounds equal shown[j−L … j−1], with L = min(j, stored)
 *    and L ≥ MIN_ALIGN (or every stored round matched). Exactly one strong match → store shown[j…].
 *  - more than one strong match → ambiguous → reject.
 *  - no strong match: no stored rounds → store everything. Stored rounds recent (within the gap) →
 *    reject (the list must contain them, yet they cannot be located). Otherwise, a shorter partial
 *    overlap at the start of the list could be a coincidence or a duplicate → reject; none → store
 *    everything as a new collection run.
 * Ambiguity is always resolved by storing NOTHING: a missing round is safer than a duplicated one.
 */
export function alignBackfill(stored: readonly number[], shown: readonly number[], storedIsRecent: boolean): Alignment {
  const strong: number[] = [];
  let weak = false;
  for (let j = 1; j <= shown.length; j++) {
    const L = Math.min(j, stored.length);
    if (L === 0) break;
    let ok = true;
    for (let i = 0; i < L; i++) {
      if (shown[j - L + i] !== stored[stored.length - L + i]) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    if (L >= MIN_ALIGN || L === stored.length) strong.push(j);
    else weak = true;
  }
  if (strong.length === 1) return { kind: 'append', from: strong[0]! };
  if (strong.length > 1) return { kind: 'reject', reason: 'The visible results match the stored rounds in more than one place.' };
  if (stored.length === 0) return { kind: 'append', from: 0 };
  if (storedIsRecent) return { kind: 'reject', reason: 'The visible results could not be aligned with the rounds stored moments ago.' };
  if (weak) return { kind: 'reject', reason: 'The visible results may partly repeat stored rounds; nothing was stored to avoid duplicates.' };
  return { kind: 'append', from: 0 };
}

/**
 * Stores the results that were already visible when collection started, marked source='backfill'.
 * Idempotent per batchId (same table as uploads). Shares the ledger lock, so it is ordered with
 * uploads and forecast issuance. No round is ever interpolated or invented.
 */
export async function backfillHistory(ctx: AppContext, auth: CustomerAuth, input: BackfillRequest): Promise<BackfillResponse> {
  if (!isSiteAccepted(ctx.env, input.siteId)) {
    throw new AppError('VALIDATION_FAILED', 'This site is not supported.', { issues: [{ path: 'siteId', message: 'unsupported site' }] });
  }
  const device = auth.deviceActivationId;
  const result = await withTransaction(ctx.pool, async (db): Promise<BackfillResponse> => {
    await lockLedger(db, device, input.siteId);
    const claim = await db.query(
      `INSERT INTO ingest_batches (device_activation_id, batch_id, accepted_count, duplicate_count)
       VALUES ($1, $2, 0, 0) ON CONFLICT DO NOTHING RETURNING batch_id`,
      [device, input.batchId],
    );
    if (claim.rowCount === 0) return { result: 'duplicate_batch', accepted: 0, alreadyStored: input.multipliers.length };
    const { rows } = await db.query<{ multiplier: string; recent: boolean }>(
      `SELECT multiplier, received_at >= now() - make_interval(secs => $4) AS recent FROM game_observations
        WHERE device_activation_id = $1 AND site_id = $2 AND received_at >= now() - make_interval(hours => $5)
        ORDER BY id DESC LIMIT $3`,
      [device, input.siteId, TAIL, SIGNAL_RULES.gapSeconds, HISTORY_RETENTION_HOURS],
    );
    const stored = rows.reverse().map((r) => Number(r.multiplier));
    const shown = input.multipliers.map((m) => Number(m.toFixed(2)));
    const a = alignBackfill(stored, shown, rows.length > 0 && rows[rows.length - 1]!.recent);
    if (a.kind === 'reject') return { result: 'rejected', accepted: 0, alreadyStored: 0, reason: a.reason };
    const add = shown.slice(a.from);
    if (add.length) {
      // With continuity: a value alignment (from > 0) verifies that add[0] follows the last stored
      // round; storing from the start of the list (from = 0) is a new run, so a break.
      const c = input.continuity;
      await db.query(
        `INSERT INTO game_observations (site_id, multiplier, device_activation_id, source, chain_id, chain_index, break_before)
         SELECT $1, m, $3, 'backfill', $4::uuid, CASE WHEN $4::uuid IS NULL THEN NULL ELSE $5::int + ord::int - 1 END,
                CASE WHEN $4::uuid IS NULL THEN NULL WHEN ord = 1 THEN $6::boolean ELSE false END
           FROM unnest($2::numeric[]) WITH ORDINALITY AS t(m, ord) ORDER BY ord`,
        [input.siteId, add.map((m) => m.toFixed(2)), device, c?.chain ?? null, c ? c.index + a.from : null, a.from === 0],
      );
    }
    await db.query('UPDATE ingest_batches SET accepted_count = $3, duplicate_count = $4 WHERE device_activation_id = $1 AND batch_id = $2', [
      device,
      input.batchId,
      add.length,
      a.from,
    ]);
    return { result: 'stored', accepted: add.length, alreadyStored: a.from };
  });
  if (result.result === 'stored' && result.accepted > 0) await syncLedgerSafely(ctx, device, input.siteId);
  return result;
}

/**
 * break_before for the first round of a batch with continuity: false only when the latest stored
 * round of this device and site comes from the same read chain at the position right before it.
 * Anything else (no stored round, another chain, a jump because a batch was lost) is a break.
 */
export async function continuityBreak(db: PoolClient, device: number, siteId: string, c: Continuity): Promise<boolean> {
  const { rows } = await db.query<{ chain_id: string | null; chain_index: number | null }>(
    `SELECT chain_id, chain_index FROM game_observations
      WHERE device_activation_id = $1 AND site_id = $2 AND received_at >= now() - make_interval(hours => $3)
      ORDER BY id DESC LIMIT 1`,
    [device, siteId, HISTORY_RETENTION_HOURS],
  );
  const prev = rows[0];
  return !(prev && prev.chain_id === c.chain && prev.chain_index === c.index - 1);
}

/** Ledger upkeep after new rounds. A failure here never fails the upload; the next analysis retries it. */
export async function syncLedgerSafely(ctx: AppContext, device: number, siteId: string): Promise<void> {
  try {
    await syncLedger(ctx.pool, device, siteId);
  } catch (err) {
    console.error(JSON.stringify({ level: 'error', msg: 'forecast ledger sync failed', code: (err as { code?: string }).code ?? 'unknown' }));
  }
}
