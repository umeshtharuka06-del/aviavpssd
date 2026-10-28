import { buildApp } from './api/app.js';
import { loadEnv } from './config/env.js';
import { schemaStatus } from './database/migrate.js';
import { createPool } from './database/pool.js';
import { errorFacts } from './diagnostics.js';
import { MockAnalysisProvider } from './engine/mock-provider.js';
import { StatisticalAnalysisProvider } from './engine/statistical-provider.js';

const env = loadEnv();
const pool = createPool(env.DATABASE_URL, env.DATABASE_POOL_MAX);
const analysisProvider = env.ANALYSIS_PROVIDER === 'statistical'
  ? new StatisticalAnalysisProvider({ minSampleSize: env.ANALYSIS_MIN_SAMPLE_SIZE })
  : new MockAnalysisProvider();
const app = await buildApp({ env, pool, now: () => new Date(), analysisProvider });

const shutdown = async () => {
  await app.close();
  await pool.end();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// The schema must match this build. Requests that touch a missing table or column would fail one
// by one with 500/503; this states the cause once, at startup, in the container log.
try {
  const schema = await schemaStatus(pool);
  if (schema.pending.length || schema.modified.length) {
    app.log.error({ pendingMigrations: schema.pending, modifiedMigrations: schema.modified }, 'database schema does not match this build: run the migrate service');
  } else {
    app.log.info('database schema matches this build');
  }
} catch (err) {
  app.log.error({ err: errorFacts(err) }, 'database schema check failed');
}

await app.listen({ host: env.HOST, port: env.PORT });
