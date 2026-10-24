import { buildApp } from './api/app.js';
import { loadEnv } from './config/env.js';
import { createPool } from './database/pool.js';
import { MockAnalysisProvider } from './engine/mock-provider.js';

const env = loadEnv();
const pool = createPool(env.DATABASE_URL, env.DATABASE_POOL_MAX);
const app = await buildApp({ env, pool, now: () => new Date(), analysisProvider: new MockAnalysisProvider() });

const shutdown = async () => {
  await app.close();
  await pool.end();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

await app.listen({ host: env.HOST, port: env.PORT });
