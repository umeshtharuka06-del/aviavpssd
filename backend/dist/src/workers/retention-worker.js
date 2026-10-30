/**
 * Retention worker process (runs as its own container on the VPS).
 * Every RETENTION_INTERVAL_SECONDS (default 300 s) it deletes history older than 12 hours.
 */
import { loadEnv } from '../config/env.js';
import { createPool } from '../database/pool.js';
import { RETENTION_WORKER_NAME } from '../retention/purge.js';
import { runRetentionOnce } from '../retention/run-once.js';
const log = (level, msg, extra = {}) => console.log(JSON.stringify({ time: new Date().toISOString(), level, worker: RETENTION_WORKER_NAME, msg, ...extra }));
async function main() {
    const env = loadEnv();
    const pool = createPool(env.DATABASE_URL, 2);
    let stopping = false;
    let timer;
    const tick = async () => {
        try {
            const r = await runRetentionOnce(pool, env.SECURITY_EVENT_RETENTION_DAYS);
            // Counts only — never row contents.
            log('info', r.skipped ? 'skipped (another run holds the lock)' : 'retention pass complete', { deleted: r.deleted });
        }
        catch (err) {
            log('error', 'retention pass failed', { error: err.message });
        }
        if (!stopping)
            timer = setTimeout(tick, env.RETENTION_INTERVAL_SECONDS * 1000);
    };
    const shutdown = async () => {
        stopping = true;
        if (timer)
            clearTimeout(timer);
        await pool.end();
        log('info', 'stopped');
        process.exit(0);
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
    log('info', 'started', { intervalSeconds: env.RETENTION_INTERVAL_SECONDS });
    // Run immediately on start so a restart catches up on any backlog.
    await tick();
}
main().catch((err) => {
    log('fatal', 'worker crashed', { error: err.message });
    process.exit(1);
});
