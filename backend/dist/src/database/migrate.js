import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
/**
 * Locates `database/migrations`: MIGRATIONS_DIR if set (Docker image), otherwise the nearest
 * ancestor of this file that contains database/migrations (works from src/ and dist/).
 */
export function defaultMigrationsDir() {
    if (process.env.MIGRATIONS_DIR)
        return resolve(process.env.MIGRATIONS_DIR);
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 6; i++) {
        const candidate = join(dir, 'database', 'migrations');
        if (existsSync(candidate))
            return candidate;
        dir = dirname(dir);
    }
    throw new Error('database/migrations not found; set MIGRATIONS_DIR');
}
export async function listMigrations(dir) {
    const files = (await readdir(dir)).filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f)).sort();
    return Promise.all(files.map(async (name) => {
        const sql = await readFile(join(dir, name), 'utf8');
        return { name, sql, checksum: createHash('sha256').update(sql).digest('hex') };
    }));
}
/**
 * Applies pending migrations in order, each in its own transaction, under an advisory lock
 * so concurrent deploys cannot race. Refuses to continue if an applied file was edited.
 */
export async function migrate(pool, dir = defaultMigrationsDir()) {
    const migrations = await listMigrations(dir);
    const client = await pool.connect();
    const applied = [];
    try {
        await client.query("SELECT pg_advisory_lock(hashtext('aviator.migrations'))");
        await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
        const { rows } = await client.query('SELECT name, checksum FROM schema_migrations');
        const done = new Map(rows.map((r) => [r.name, r.checksum]));
        for (const m of migrations) {
            const prev = done.get(m.name);
            if (prev) {
                if (prev !== m.checksum)
                    throw new Error(`Migration ${m.name} was modified after being applied`);
                continue;
            }
            await client.query('BEGIN');
            try {
                await client.query(m.sql);
                await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [m.name, m.checksum]);
                await client.query('COMMIT');
                applied.push(m.name);
            }
            catch (err) {
                await client.query('ROLLBACK');
                throw new Error(`Migration ${m.name} failed: ${err.message}`);
            }
        }
    }
    finally {
        await client.query("SELECT pg_advisory_unlock(hashtext('aviator.migrations'))").catch(() => undefined);
        client.release();
    }
    return applied;
}
/**
 * Read-only: compares the migration files shipped with this build with schema_migrations. A
 * non-empty `pending` means the code may use tables or columns the database does not have yet,
 * so requests that touch them fail with SQLSTATE 42P01 / 42703 until `migrate` runs.
 */
export async function schemaStatus(pool, dir = defaultMigrationsDir()) {
    const files = await listMigrations(dir);
    const { rows: exists } = await pool.query("SELECT to_regclass('public.schema_migrations')::text AS t");
    const applied = new Map();
    if (exists[0]?.t) {
        const { rows } = await pool.query('SELECT name, checksum FROM schema_migrations');
        for (const r of rows)
            applied.set(r.name, r.checksum);
    }
    return {
        pending: files.filter((f) => !applied.has(f.name)).map((f) => f.name),
        modified: files.filter((f) => applied.has(f.name) && applied.get(f.name) !== f.checksum).map((f) => f.name),
    };
}
