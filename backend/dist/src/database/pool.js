import pg from 'pg';
// int8 (bigint) → JS number. Counts and ids in this system stay far below 2^53.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number.parseInt(v, 10));
export function createPool(databaseUrl, max = 10) {
    const pool = new pg.Pool({
        connectionString: databaseUrl,
        max,
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: 5_000,
        // Every session runs in UTC so now() and timestamp formatting are unambiguous.
        options: '-c TimeZone=UTC',
    });
    pool.on('error', (err) => {
        // Idle client errors (e.g. DB restart). Logged without connection details.
        console.error(JSON.stringify({ level: 'error', msg: 'postgres pool error', code: err.code }));
    });
    return pool;
}
/** Runs fn inside a transaction; rolls back on any error. */
export async function withTransaction(pool, fn) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
    }
    catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
    }
    finally {
        client.release();
    }
}
