/**
 * Operator CLI (run on the VPS / locally, never exposed over HTTP).
 *
 *   migrate                         apply pending SQL migrations
 *   create-admin --email <email>    create an admin (password read from stdin, or ADMIN_PASSWORD)
 *   retention-status                print retention worker health; exit 1 if unhealthy
 */
import { createInterface } from 'node:readline';
import { loadEnv } from '../config/env.js';
import { hashPassword } from '../auth/admin-auth.js';
import { retentionHealth } from '../retention/purge.js';
import { migrate } from './migrate.js';
import { createPool } from './pool.js';
async function readPassword() {
    if (process.env.ADMIN_PASSWORD)
        return process.env.ADMIN_PASSWORD;
    process.stderr.write('Admin password (min 12 chars): ');
    const rl = createInterface({ input: process.stdin, terminal: false });
    for await (const line of rl) {
        rl.close();
        return line.trim();
    }
    throw new Error('No password provided on stdin');
}
async function main() {
    const [command, ...args] = process.argv.slice(2);
    // migrate only needs DATABASE_URL; other commands need the full config.
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl)
        throw new Error('DATABASE_URL is required');
    const pool = createPool(databaseUrl, 2);
    try {
        switch (command) {
            case 'migrate': {
                const applied = await migrate(pool);
                console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Database is up to date.');
                break;
            }
            case 'create-admin': {
                const i = args.indexOf('--email');
                const email = i >= 0 ? args[i + 1]?.trim().toLowerCase() : undefined;
                if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
                    throw new Error('Usage: create-admin --email you@example.com');
                const hash = await hashPassword(await readPassword());
                await pool.query(`INSERT INTO admin_users (email, password_hash) VALUES ($1, $2)
           ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, failed_login_count = 0, locked_until = NULL`, [email, hash]);
                console.log(`Admin ${email} created/updated.`);
                break;
            }
            case 'retention-status': {
                const env = loadEnv();
                const h = await retentionHealth(pool, env.RETENTION_INTERVAL_SECONDS);
                console.log(JSON.stringify(h));
                if (!h.healthy)
                    process.exitCode = 1;
                break;
            }
            default:
                console.error('Commands: migrate | create-admin --email <email> | retention-status');
                process.exitCode = 2;
        }
    }
    finally {
        await pool.end();
    }
}
main().catch((err) => {
    console.error(err.message);
    process.exit(1);
});
