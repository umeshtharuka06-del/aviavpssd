import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { TestProject } from 'vitest/node';
import { migrate } from '../src/database/migrate.js';
import { createPool } from '../src/database/pool.js';

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}

/** Clean shutdown via pg_ctl (the platform binary package exports its path). */
async function pgCtlStop(dataDir: string) {
  const pkg = `@embedded-postgres/${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch}`;
  const { pg_ctl } = (await import(pkg)) as { pg_ctl: string };
  await promisify(execFile)(pg_ctl, ['stop', '-D', dataDir, '-m', 'fast', '-w']);
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Uses TEST_DATABASE_URL if provided (database name must end in "_test" because the schema is
 * dropped and recreated). Otherwise starts a throwaway local PostgreSQL (embedded-postgres)
 * bound to 127.0.0.1 in a temp directory, and removes it afterwards.
 */
export default async function setup(project: TestProject) {
  let url = process.env.TEST_DATABASE_URL;
  let teardown: (() => Promise<void>) | undefined;

  if (url) {
    if (!new URL(url).pathname.endsWith('_test')) throw new Error('TEST_DATABASE_URL database name must end in _test');
  } else {
    const { default: EmbeddedPostgres } = await import('embedded-postgres');
    const dir = await mkdtemp(join(tmpdir(), 'aviator-test-pg-'));
    const port = await freePort();
    const password = randomBytes(16).toString('hex');
    const pg = new EmbeddedPostgres({
      databaseDir: dir,
      user: 'postgres',
      password,
      port,
      persistent: false,
      // io_method=sync: no PG18 io_worker children that can outlive a forced stop on Windows.
      postgresFlags: ['-c', 'listen_addresses=127.0.0.1', '-c', 'io_method=sync'],
      onLog: () => undefined,
      onError: () => undefined,
    });
    await pg.initialise();
    await pg.start();
    await pg.createDatabase('aviator_test');
    url = `postgres://postgres:${password}@127.0.0.1:${port}/aviator_test`;
    teardown = async () => {
      // Clean shutdown first (postmaster stops its children), then the library's stop.
      await pgCtlStop(dir).catch((e) => console.warn('pg_ctl stop failed, falling back:', (e as Error).message));
      await pg.stop();
      await rm(dir, { recursive: true, force: true });
    };
  }

  const pool = createPool(url, 1);
  await pool.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
  await migrate(pool);
  await pool.end();

  project.provide('databaseUrl', url);
  return async () => {
    await teardown?.();
  };
}
