import { purgeExpiredHistory, purgeOperationalData, RETENTION_WORKER_NAME } from './purge.js';
const LOCK_SQL = "SELECT pg_try_advisory_lock(hashtext('aviator.retention')) AS locked";
const UNLOCK_SQL = "SELECT pg_advisory_unlock(hashtext('aviator.retention'))";
/**
 * One retention pass. Safe to run repeatedly and from several processes: a session-level
 * advisory lock lets only one pass run at a time; others skip. Heartbeats record each run so
 * monitoring can detect a stalled or failing worker.
 */
export async function runRetentionOnce(pool, securityEventRetentionDays) {
    const client = await pool.connect();
    try {
        const { rows } = await client.query(LOCK_SQL);
        if (!rows[0]?.locked)
            return { skipped: true, deleted: 0 };
        try {
            await pool.query(`INSERT INTO worker_heartbeats (worker_name, last_started_at, total_runs) VALUES ($1, now(), 1)
         ON CONFLICT (worker_name) DO UPDATE SET last_started_at = now(), total_runs = worker_heartbeats.total_runs + 1`, [RETENTION_WORKER_NAME]);
            // History first: housekeeping failures must never block the 12-hour deletion.
            const history = await purgeExpiredHistory(pool);
            let opsError = null;
            try {
                await purgeOperationalData(pool, securityEventRetentionDays);
            }
            catch (err) {
                opsError = `operational purge failed: ${err.message}`.slice(0, 500);
            }
            await pool.query(`UPDATE worker_heartbeats SET last_finished_at = now(), last_success_at = now(),
                last_error = $2, last_deleted_count = $3 WHERE worker_name = $1`, [RETENTION_WORKER_NAME, opsError, history.observations]);
            return { skipped: false, deleted: history.observations };
        }
        catch (err) {
            await pool
                .query('UPDATE worker_heartbeats SET last_finished_at = now(), last_error = $2 WHERE worker_name = $1', [
                RETENTION_WORKER_NAME,
                err.message.slice(0, 500),
            ])
                .catch(() => undefined);
            throw err;
        }
        finally {
            await client.query(UNLOCK_SQL).catch(() => undefined);
        }
    }
    finally {
        client.release();
    }
}
