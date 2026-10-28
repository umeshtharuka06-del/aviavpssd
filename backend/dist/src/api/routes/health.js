import { API_VERSION_STRING } from '../app.js';
import { AppError } from '../errors.js';
import { schemaStatus } from '../../database/migrate.js';
/** Public health endpoints reveal nothing about infrastructure, versions of dependencies or data. */
export const healthRoutes = (ctx) => async (app) => {
    app.get('/health', async () => ({ status: 'ok', version: API_VERSION_STRING, time: ctx.now().toISOString() }));
    app.get('/health/ready', async (req) => {
        let schema;
        try {
            schema = await schemaStatus(ctx.pool);
        }
        catch (err) {
            throw new AppError('SERVICE_UNAVAILABLE', 'Service is not ready.', undefined, err);
        }
        if (schema.pending.length || schema.modified.length) {
            // Details go to the server log only; the public answer stays generic.
            req.log.error({ pendingMigrations: schema.pending, modifiedMigrations: schema.modified }, 'database schema does not match this build');
            throw new AppError('SERVICE_UNAVAILABLE', 'Service is not ready.');
        }
        return { status: 'ok', version: API_VERSION_STRING, time: ctx.now().toISOString() };
    });
};
