import type { Env } from './config/env.js';
import type { Pool } from './database/pool.js';
import type { AnalysisProvider } from './engine/provider.js';

/** Dependencies shared by routes and services. Tests inject their own clock/provider. */
export interface AppContext {
  env: Env;
  pool: Pool;
  /** Trusted server clock (UTC). Never derived from client input. */
  now: () => Date;
  analysisProvider: AnalysisProvider;
}
