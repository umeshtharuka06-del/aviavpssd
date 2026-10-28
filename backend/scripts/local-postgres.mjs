// Local development PostgreSQL (no Docker / no system install needed).
// Data lives in backend/.local-pg (gitignored). Listens on 127.0.0.1 only.
//   npm run local-db            start (foreground; Ctrl+C stops cleanly)
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '.local-pg');
const dataDir = join(root, 'data');
const credFile = join(root, 'credentials.json');
const PORT = Number(process.env.LOCAL_PG_PORT ?? 55433);

mkdirSync(root, { recursive: true });
const firstRun = !existsSync(credFile);
const creds = firstRun ? { password: randomBytes(18).toString('base64url') } : JSON.parse(readFileSync(credFile, 'utf8'));
if (firstRun) writeFileSync(credFile, JSON.stringify(creds), { mode: 0o600 });

const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: 'postgres',
  password: creds.password,
  port: PORT,
  persistent: true,
  postgresFlags: ['-c', 'listen_addresses=127.0.0.1', '-c', 'io_method=sync', '-c', 'TimeZone=UTC'],
  onLog: () => {},
});

if (!existsSync(join(dataDir, 'PG_VERSION'))) await pg.initialise();
await pg.start();
if (firstRun) {
  await pg.createDatabase('aviator_dev');
}
console.log('Local PostgreSQL running on 127.0.0.1:' + PORT);
console.log('Put this in backend/.env (do not commit):');
console.log(`DATABASE_URL=postgres://postgres:${creds.password}@127.0.0.1:${PORT}/aviator_dev`);

const pkg = `@embedded-postgres/${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch}`;
const { pg_ctl: pgCtl } = await import(pkg);
const stop = () =>
  execFile(pgCtl, ['stop', '-D', dataDir, '-m', 'fast', '-w'], () => {
    console.log('stopped');
    process.exit(0);
  });
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
setInterval(() => {}, 1 << 30);
