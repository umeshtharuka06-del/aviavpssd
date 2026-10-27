import type { HealthResponse } from '@aviator/contracts';
import type { FastifyPluginAsync } from 'fastify';
import type { AppContext } from '../../context.js';
import { API_VERSION_STRING } from '../app.js';
import { AppError } from '../errors.js';

/** Public health endpoints reveal nothing about infrastructure, versions of dependencies or data. */
export const healthRoutes =
  (ctx: AppContext): FastifyPluginAsync =>
  async (app) => {
    app.get('/health', async (): Promise<HealthResponse> => ({ status: 'ok', version: API_VERSION_STRING, time: ctx.now().toISOString() }));

    app.get('/health/ready', async (): Promise<HealthResponse> => {
      try {
        await ctx.pool.query('SELECT 1');
      } catch {
        throw new AppError('SERVICE_UNAVAILABLE', 'Service is not ready.');
      }
      return { status: 'ok', version: API_VERSION_STRING, time: ctx.now().toISOString() };
    });
  };
