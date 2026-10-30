/**
 * Operator CLI (run on the VPS / locally, never exposed over HTTP).
 *
 *   migrate                         apply pending SQL migrations
 *   create-admin --email <email>    create an admin (password read from stdin, or ADMIN_PASSWORD)
 *   retention-status                print retention worker health; exit 1 if unhealthy
 *   raise-device-limits --to 5 [--apply]
 *                                   raise the device limit of existing, non-revoked codes whose
 *                                   limit is lower (dry run without --apply; never lowers limits,
 *                                   never changes activations or expiry dates)
 *   export-rounds --out <dir> [--site <siteId>] [--since <ISO>] [--until <ISO>]
 *                                   read-only CSV + manifest of recorded rounds for offline research
 *                                   (docs/LIVE_EXPORT.md); pseudonymous streams, no device or account data
 */
import { createInterface } from 'node:readline';
import { loadEnv } from '../config/env.js';
import { hashPassword } from '../auth/admin-auth.js';
import { raiseDeviceLimits } from '../activation/devices.js';
import { exportRoundsToFiles, parseExportOptions } from '../export/rounds-export.js';
import { retentionHealth } from '../retention/purge.js';
import { migrate } from './migrate.js';
import { createPool } from './pool.js';

async function readPassword(): Promise<string> {
  if (process.env.ADMIN_PASSWORD) return process.env.ADMIN_PASSWORD;
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
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
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
        if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('Usage: create-admin --email you@example.com');
        const hash = await hashPassword(await readPassword());
        await pool.query(
          `INSERT INTO admin_users (email, password_hash) VALUES ($1, $2)
           ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, failed_login_count = 0, locked_until = NULL`,
          [email, hash],
        );
        console.log(`Admin ${email} created/updated.`);
        break;
      }
      case 'raise-device-limits': {
        const i = args.indexOf('--to');
        const to = Number(i >= 0 ? args[i + 1] : NaN);
        const apply = args.includes('--apply');
        const env = loadEnv();
        const r = await raiseDeviceLimits(pool, env.IP_HASH_PEPPER, to, apply);
        console.log(
          r.apply
            ? `Raised the device limit to ${to} for ${r.codes} existing code(s). Expiry dates and activations unchanged.`
            : `DRY RUN: ${r.codes} existing code(s) have a device limit below ${to}. Re-run with --apply to raise them.`,
        );
        break;
      }
      case 'retention-status': {
        const env = loadEnv();
        const h = await retentionHealth(pool, env.RETENTION_INTERVAL_SECONDS);
        console.log(JSON.stringify(h));
        if (!h.healthy) process.exitCode = 1;
        break;
      }
      case 'export-rounds': {
        const flag = (name: string) => {
          const i = args.indexOf(`--${name}`);
          return i >= 0 ? args[i + 1] : undefined;
        };
        const out = flag('out');
        if (!out) throw new Error('Usage: export-rounds --out <dir> [--site <siteId>] [--since <ISO>] [--until <ISO>]');
        const opts = parseExportOptions({ site: flag('site'), since: flag('since'), until: flag('until') });
        const env = loadEnv();
        const r = await exportRoundsToFiles(pool, { devicePepper: env.DEVICE_PEPPER, ipPepper: env.IP_HASH_PEPPER }, opts, out);
        const c = r.manifest.counts;
        console.log(`Exported ${c.rows} rounds in ${c.streams} stream(s), ${c.runs} run(s) → ${r.csvPath}`);
        console.log(`Manifest ${r.manifestPath} (sha256 ${r.manifest.csvSha256})`);
        if (c.duplicatesRemoved || c.unattributedRowsExcluded || c.invalidExcluded) {
          console.log(`Excluded: ${c.duplicatesRemoved} duplicate(s), ${c.unattributedRowsExcluded} without a device, ${c.invalidExcluded} invalid.`);
        }
        break;
      }
      default:
        console.error('Commands: migrate | create-admin --email <email> | retention-status | raise-device-limits --to <n> [--apply] | export-rounds --out <dir> [--site <id>] [--since <ISO>] [--until <ISO>]');
        process.exitCode = 2;
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});
