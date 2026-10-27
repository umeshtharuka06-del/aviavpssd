import { HISTORY_RETENTION_HOURS } from '@aviator/contracts';
import { AppError } from '../api/errors.js';
import { isSiteAccepted } from '../config/env.js';
import { currentSignal } from './sequential/ledger-service.js';
const MAX_OBSERVATIONS_FOR_ANALYSIS = 5_000;
const PROVIDER_TIMEOUT_MS = 5_000;
/**
 * Runs the configured provider over THIS DEVICE's unexpired history for the site. Each device's
 * analysis is independent: observations are filtered by the device_activation_id of the
 * authenticated session (never a client-supplied id), so one device cannot read another device's
 * history. The time filter means a lagging retention worker can never cause expired rows to be
 * analyzed. Analysis never modifies or deletes observations, so its success or failure has no
 * effect on retention.
 */
export async function runAnalysis(ctx, siteId, deviceActivationId) {
    if (!isSiteAccepted(ctx.env, siteId)) {
        throw new AppError('VALIDATION_FAILED', 'This site is not supported.', { issues: [{ path: 'siteId', message: 'unsupported site' }] });
    }
    const now = ctx.now();
    const { rows } = await ctx.pool.query(`SELECT multiplier, received_at FROM game_observations
      WHERE device_activation_id = $1 AND site_id = $2 AND received_at >= now() - make_interval(hours => $3)
      ORDER BY received_at DESC, id DESC LIMIT $4`, [deviceActivationId, siteId, HISTORY_RETENTION_HOURS, MAX_OBSERVATIONS_FOR_ANALYSIS]);
    const provider = ctx.analysisProvider;
    let output;
    try {
        output = await withTimeout(provider.analyze({
            siteId,
            windowHours: HISTORY_RETENTION_HOURS,
            observations: rows.map((r) => ({ multiplier: Number(r.multiplier), receivedAt: r.received_at })),
            now,
        }), PROVIDER_TIMEOUT_MS);
    }
    catch {
        throw new AppError('ANALYSIS_UNAVAILABLE', 'Analysis is temporarily unavailable.');
    }
    // Round-by-round signal: scores any open forecast and records the next one before answering, so
    // the response always carries the forecast for the round after the latest stored round. Only the
    // live provider runs it; the mock provider (test data) never produces a signal.
    let nextRound;
    if (provider.supportsSignal) {
        try {
            nextRound = await withTimeout(currentSignal(ctx.pool, deviceActivationId, siteId), PROVIDER_TIMEOUT_MS);
        }
        catch {
            throw new AppError('ANALYSIS_UNAVAILABLE', 'Analysis is temporarily unavailable.');
        }
    }
    return {
        engine: { kind: provider.kind, version: provider.version },
        isTestData: provider.isTestData,
        status: output.status,
        siteId,
        generatedAt: now.toISOString(),
        windowHours: HISTORY_RETENTION_HOURS,
        observationsConsidered: rows.length,
        items: output.items.slice(0, 20),
        ...(output.summary ? { summary: output.summary } : {}),
        ...(output.forecast ? { forecast: output.forecast } : {}),
        ...(nextRound ? { nextRound } : {}),
        notice: output.notice,
    };
}
function withTimeout(p, ms) {
    return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('timeout')), ms);
        p.then((v) => (clearTimeout(t), resolve(v)), (e) => (clearTimeout(t), reject(e)));
    });
}
