import { randomBytes } from 'node:crypto';
import { HISTORY_RETENTION_HOURS, SIGNAL_MODELS, type IssueEvidence, type NextRoundSignal, type RangeStrategyForecast, type SignalModel } from '@aviator/contracts';
import { withTransaction, type Client as PoolClient, type Pool } from '../../database/pool.js';
import { isValidMultiplier } from '../summary.js';
import {
  brier,
  buildSignal,
  evidenceOf,
  ENGINE_VERSION,
  issueForecast,
  logLoss,
  resolve,
  SIGNAL_RULES,
  topRange,
  type ForecastState,
  type LedgerEntry,
  type LedgerForecast,
  type LedgerOutcome,
  type LedgerRound,
} from './engine.js';
import { strategyHits } from './strategy.js';

/**
 * PostgreSQL side of the forecast ledger (tables round_forecasts / forecast_outcomes, migration 0004).
 *
 * Exactly-once guarantees:
 *  - Every ingest, backfill and ledger sync for one (device, site) takes the same transaction-level
 *    advisory lock, so a forecast is always recorded while its input round is the LATEST stored
 *    round, and the next round can only be stored after that forecast is committed.
 *  - One forecast per input boundary: UNIQUE (device, site, input_last_observation_id).
 *  - One outcome per forecast: forecast_outcomes primary key. Both tables reject UPDATE (trigger).
 * A restart, a browser refresh, a repeated request or two requests at once therefore cannot create,
 * lose or re-score a forecast.
 */

export { ENGINE_VERSION };
/** Rounds read for the models (newest kept); same cap as the stat-4 analysis. */
const MAX_ROUNDS = 5_000;
/** Ledger rows read for evidence and history (newest kept). */
const MAX_FORECASTS = 5_000;

export async function lockLedger(db: PoolClient, deviceActivationId: number, siteId: string): Promise<void> {
  await db.query("SELECT pg_advisory_xact_lock(hashtext('ledger:' || $1::text || ':' || $2))", [deviceActivationId, siteId]);
}

const publicId = () => {
  const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  return `fc_${[...randomBytes(16)].map((b) => alphabet[b % 36]).join('')}`;
};

async function loadRounds(db: PoolClient, device: number, site: string): Promise<LedgerRound[]> {
  const { rows } = await db.query<{ id: string; multiplier: string; received_at: Date; source: 'live' | 'backfill'; break_before: boolean | null }>(
    `SELECT o.id::text AS id, o.multiplier, o.received_at, o.source, o.break_before FROM game_observations o
      WHERE o.device_activation_id = $1 AND o.site_id = $2 AND o.received_at >= now() - make_interval(hours => $3)
      ORDER BY o.id DESC LIMIT $4`,
    [device, site, HISTORY_RETENTION_HOURS, MAX_ROUNDS],
  );
  return rows
    .reverse()
    .map((r) => ({ id: r.id, multiplier: Number(r.multiplier), receivedAt: r.received_at, source: r.source, breakBefore: r.break_before }))
    .filter((r) => isValidMultiplier(r.multiplier));
}

interface ForecastRow {
  id: string;
  public_id: string;
  input_last_observation_id: string;
  input_last_received_at: Date;
  input_round_count: number;
  engine_version: string;
  state: ForecastState;
  displayed_model: SignalModel;
  probabilities: number[];
  model_vectors: Record<SignalModel, number[]>;
  issue_evidence: IssueEvidence;
  strategy: RangeStrategyForecast | null;
  issued_at: Date;
  o_status: 'scored' | 'void' | null;
  void_reason: 'gap' | 'late' | null;
  target_observation_id: string | null;
  actual_multiplier: string | null;
  actual_range: number | null;
  scored_at: Date | null;
}

async function loadLedger(db: PoolClient, device: number, site: string): Promise<Array<LedgerEntry & { rowId: string }>> {
  const { rows } = await db.query<ForecastRow>(
    `SELECT f.id::text, f.public_id, f.input_last_observation_id::text, f.input_last_received_at, f.input_round_count, f.engine_version,
            f.state, f.displayed_model, f.probabilities, f.model_vectors, f.issue_evidence, f.strategy, f.issued_at,
            o.status AS o_status, o.void_reason, o.target_observation_id::text, o.actual_multiplier, o.actual_range, o.scored_at
       FROM round_forecasts f LEFT JOIN forecast_outcomes o ON o.forecast_id = f.id
      WHERE f.device_activation_id = $1 AND f.site_id = $2
      ORDER BY f.id DESC LIMIT $3`,
    [device, site, MAX_FORECASTS],
  );
  return rows.reverse().map((r) => {
    const forecast: LedgerForecast = {
      id: r.public_id,
      issuedAt: r.issued_at,
      inputLastRoundId: r.input_last_observation_id,
      inputLastRoundAt: r.input_last_received_at,
      inputRounds: r.input_round_count,
      engineVersion: r.engine_version,
      state: r.state,
      model: r.displayed_model,
      probabilities: r.probabilities.map(Number),
      vectors: r.model_vectors,
      atIssue: r.issue_evidence,
      strategy: r.strategy,
    };
    let outcome: LedgerOutcome | null = null;
    if (r.o_status === 'void') outcome = { forecastId: r.public_id, status: 'void', reason: r.void_reason!, scoredAt: r.scored_at! };
    else if (r.o_status === 'scored') {
      outcome = {
        forecastId: r.public_id,
        status: 'scored',
        roundId: r.target_observation_id!,
        multiplier: Number(r.actual_multiplier),
        range: r.actual_range!,
        scoredAt: r.scored_at!,
      };
    }
    return { rowId: r.id, forecast, outcome };
  });
}

async function insertOutcome(db: PoolClient, rowId: string, f: LedgerForecast, o: LedgerOutcome): Promise<LedgerOutcome> {
  const scored = o.status === 'scored';
  const hits = scored && f.strategy ? strategyHits(f.strategy, o.multiplier) : null;
  const { rows } = await db.query<{ scored_at: Date }>(
    `INSERT INTO forecast_outcomes (forecast_id, status, void_reason, target_observation_id, actual_multiplier, actual_range,
                                    log_loss, baseline_log_loss, brier, top_range_hit, target_hit, strategy_range_hit)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (forecast_id) DO NOTHING RETURNING scored_at`,
    [
      rowId,
      o.status,
      scored ? null : o.reason,
      scored ? o.roundId : null,
      scored ? o.multiplier.toFixed(2) : null,
      scored ? o.range : null,
      scored ? logLoss(f.probabilities, o.range) : null,
      scored ? logLoss(f.vectors.baseline, o.range) : null,
      scored ? brier(f.probabilities, o.range) : null,
      scored ? topRange(f.probabilities) === o.range : null,
      hits ? hits.targetHit : null,
      hits ? hits.strategyRangeHit : null,
    ],
  );
  return rows[0] ? { ...o, scoredAt: rows[0].scored_at } : o;
}

export interface LedgerSnapshot {
  rounds: LedgerRound[];
  entries: LedgerEntry[];
  changeProbability: number | null;
  /** Forecasts newly scored / issued by this call (for tests and logs). */
  scoredNow: number;
  issuedNow: number;
}

/**
 * Brings this device's ledger up to date inside the caller's transaction (which must hold the
 * ledger lock): scores every open forecast whose next round is stored, then records the forecast
 * for the round after the latest stored round, if it does not exist yet.
 */
export async function syncLedgerLocked(db: PoolClient, device: number, site: string): Promise<LedgerSnapshot> {
  const rounds = await loadRounds(db, device, site);
  const ledger = await loadLedger(db, device, site);
  const pos = new Map(rounds.map((r, i) => [r.id, i]));
  let scoredNow = 0;
  for (const e of ledger) {
    if (e.outcome) continue;
    // The next stored round after the input boundary (ids increase in storage order).
    const at = pos.get(e.forecast.inputLastRoundId);
    const boundary = BigInt(e.forecast.inputLastRoundId);
    const next = at != null ? rounds[at + 1] : rounds.find((r) => BigInt(r.id) > boundary);
    if (!next) continue;
    // Live ordering is guaranteed by the lock (a forecast is committed before any later round is
    // stored), so only the collection-gap rule applies; the timestamp "late" check is for replays.
    const o = resolve(e.forecast, next, new Date(), { gapSeconds: SIGNAL_RULES.gapSeconds, checkLate: false });
    e.outcome = await insertOutcome(db, e.rowId, e.forecast, o);
    scoredNow++;
  }

  const last = rounds[rounds.length - 1];
  const ev = evidenceOf(ledger);
  const { forecast, models } = issueForecast(rounds, ev, { engineVersion: ENGINE_VERSION, issuedAt: new Date(), id: publicId() });
  let issuedNow = 0;
  if (forecast && last && !ledger.some((e) => e.forecast.inputLastRoundId === last.id)) {
    const { rows } = await db.query<{ id: string; issued_at: Date }>(
      `INSERT INTO round_forecasts (public_id, device_activation_id, site_id, input_last_observation_id, input_last_received_at,
                                    input_round_count, engine_version, state, displayed_model, probabilities, model_vectors, issue_evidence, strategy)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT ON CONSTRAINT round_forecasts_once DO NOTHING RETURNING id::text, issued_at`,
      [
        forecast.id,
        device,
        site,
        forecast.inputLastRoundId,
        forecast.inputLastRoundAt,
        forecast.inputRounds,
        forecast.engineVersion,
        forecast.state,
        forecast.model,
        forecast.probabilities,
        JSON.stringify(Object.fromEntries(SIGNAL_MODELS.map((m) => [m, forecast.vectors[m]]))),
        JSON.stringify(forecast.atIssue),
        forecast.strategy ? JSON.stringify(forecast.strategy) : null,
      ],
    );
    if (rows[0]) {
      ledger.push({ rowId: rows[0].id, forecast: { ...forecast, issuedAt: rows[0].issued_at }, outcome: null });
      issuedNow = 1;
    }
  }
  return {
    rounds,
    entries: ledger.map(({ forecast: f, outcome }) => ({ forecast: f, outcome })),
    changeProbability: rounds.length ? models.changepoint.recentChangeProbability() : null,
    scoredNow,
    issuedNow,
  };
}

/** Own transaction + lock. Used after an upload and before every analysis response. */
export async function syncLedger(pool: Pool, device: number, site: string): Promise<LedgerSnapshot> {
  return withTransaction(pool, async (db) => {
    await lockLedger(db, device, site);
    return syncLedgerLocked(db, device, site);
  });
}

export async function currentSignal(pool: Pool, device: number, site: string): Promise<NextRoundSignal> {
  const s = await syncLedger(pool, device, site);
  return buildSignal(s.rounds, s.entries, s.changeProbability);
}

/** Retention: forecasts (and, by cascade, outcomes) issued more than HISTORY_RETENTION_HOURS ago. */
export async function purgeExpiredForecasts(pool: Pool, batchSize = 5_000): Promise<number> {
  let deleted = 0;
  for (;;) {
    const r = await pool.query(
      `DELETE FROM round_forecasts WHERE id IN (
         SELECT id FROM round_forecasts WHERE issued_at < now() - make_interval(hours => $1) ORDER BY issued_at LIMIT $2)`,
      [HISTORY_RETENTION_HOURS, batchSize],
    );
    deleted += r.rowCount ?? 0;
    if ((r.rowCount ?? 0) < batchSize) break;
  }
  return deleted;
}
