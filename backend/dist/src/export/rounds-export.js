import { HISTORY_RETENTION_HOURS, SiteIdSchema } from '@aviator/contracts';
import { createHash } from 'node:crypto';
import { link, mkdir, open, rm, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ENGINE_VERSION, isBreak } from '../engine/sequential/engine.js';
import { isValidMultiplier } from '../engine/summary.js';
import { hmacSha256 } from '../security/crypto.js';
import { recordSecurityEvent } from '../security/events.js';
/**
 * Read-only export of recorded rounds for OFFLINE research (docs/LIVE_EXPORT.md, plan docs/LIVE_EXPORT_PLAN.md).
 *
 *  - One consistent snapshot: READ ONLY, REPEATABLE READ, statement timeout. Nothing in the game or ledger tables
 *    is written; the caller records the audit event afterwards.
 *  - Allow-listed columns only. The collecting device appears as a keyed pseudonym (`stream`), the read chain as
 *    another (`chain`); no device, activation, code, session, token or IP value is ever read into the output.
 *  - Continuity is the live engine's own rule (`isBreak` from engine.ts), computed per stream over the whole
 *    retention window and only then filtered by since/until, so the first exported row is not a false break.
 *  - Deterministic: rows ordered by site, stream, obs_id; the same database state and options give the same bytes.
 */
export const EXPORT_SCHEMA_VERSION = 1;
export const EXPORT_TOOL = 'export-rounds/1';
export const EXPORT_COLUMNS = [
    'schema_version',
    'site_id',
    'stream',
    'obs_id',
    'received_at',
    'multiplier',
    'source',
    'chain',
    'chain_index',
    'break_before',
    'verified_successor',
    'run_id',
];
/** Keyed pseudonyms, domain-separated from every other use of the pepper. */
export const streamPseudonym = (pepper, deviceActivationId) => `s_${hmacSha256(pepper, `export.stream.v1:${deviceActivationId}`).toString('hex').slice(0, 16)}`;
export const chainPseudonym = (pepper, chainId) => `c_${hmacSha256(pepper, `export.chain.v1:${chainId.toLowerCase()}`).toString('hex').slice(0, 16)}`;
export const EXPORT_LIMITATIONS = [
    `At most the last ${HISTORY_RETENTION_HOURS} h per export (database retention). Longer analysis needs repeated exports merged offline by (stream, obs_id).`,
    'obs_id is the server record id, NOT a game round id: the collector reads no round ids. Rounds seen by several devices appear once per stream.',
    'received_at is server arrival time (batched), not the round start time.',
    'Missed rounds are not filled in; they show only as verified_successor = false.',
    'Coverage is limited to periods when a device had the game page open with collection enabled.',
    'Rows from clients without continuity metadata (chain empty) use the 120 s time rule, as the live engine does.',
    'site_id is the operator domain key, not the game provider configuration.',
    'Rows whose device record was deleted have no stream and are excluded (counted in the manifest).',
];
const bool = (b) => (b == null ? '' : b ? 'true' : 'false');
/** Validates options; throws with a usage message. */
export function parseExportOptions(o) {
    const out = {};
    if (o.site != null) {
        if (!SiteIdSchema.safeParse(o.site).success)
            throw new Error(`invalid --site ${JSON.stringify(o.site)}`);
        out.site = o.site;
    }
    for (const k of ['since', 'until']) {
        const v = o[k];
        if (v == null)
            continue;
        if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/.test(v))
            throw new Error(`--${k} must be an ISO-8601 time with a zone, e.g. 2026-10-31T06:00:00Z`);
        const d = new Date(v);
        if (Number.isNaN(d.getTime()))
            throw new Error(`invalid --${k}`);
        out[k] = d;
    }
    if (out.since && out.until && out.until <= out.since)
        throw new Error('--until must be after --since');
    return out;
}
/**
 * Streams the CSV to `write` and returns the manifest. The caller owns the audit event (written after this
 * returns, outside the read-only snapshot).
 */
export async function exportRounds(pool, opts, write) {
    const batchSize = opts.batchSize ?? 5_000;
    const hash = createHash('sha256');
    let bytes = 0;
    const emit = async (s) => {
        hash.update(s, 'utf8');
        bytes += Buffer.byteLength(s, 'utf8');
        await write(s);
    };
    const counts = { rows: 0, streams: 0, runs: 0, rowsWithoutContinuity: 0, duplicatesRemoved: 0, unattributedRowsExcluded: 0, invalidExcluded: 0 };
    const client = await pool.connect();
    try {
        await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
        await client.query("SET LOCAL statement_timeout = '30s'");
        const { rows: [clock] } = await client.query('SELECT now() AS now, now() - make_interval(hours => $1) AS cutoff', [HISTORY_RETENTION_HOURS]);
        const cutoff = clock.cutoff;
        const siteFilter = opts.site ?? null;
        const { rows: [unattributed] } = await client.query(`SELECT count(*)::int AS n FROM game_observations
        WHERE device_activation_id IS NULL AND received_at >= $1 AND ($2::text IS NULL OR site_id = $2)`, [cutoff, siteFilter]);
        counts.unattributedRowsExcluded = unattributed.n;
        const { rows: streams } = await client.query(`SELECT DISTINCT site_id, device_activation_id FROM game_observations
        WHERE device_activation_id IS NOT NULL AND received_at >= $1 AND ($2::text IS NULL OR site_id = $2)`, [cutoff, siteFilter]);
        // Order by (site, pseudonym): deterministic, and independent of activation order.
        const ordered = streams
            .map((s) => ({ ...s, stream: streamPseudonym(opts.pepper, s.device_activation_id) }))
            .sort((a, b) => (a.site_id < b.site_id ? -1 : a.site_id > b.site_id ? 1 : a.stream < b.stream ? -1 : a.stream > b.stream ? 1 : 0));
        await emit(`${EXPORT_COLUMNS.join(',')}\n`);
        for (const s of ordered) {
            let prev;
            let run = -1;
            let emittedInStream = 0;
            let lastRunEmitted = -1;
            const seen = new Set();
            let after = 0;
            for (;;) {
                const { rows } = await client.query(`SELECT id, site_id, multiplier::text AS multiplier, received_at,
                  to_char(received_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS received_iso,
                  source, chain_id::text AS chain_id, chain_index, break_before
             FROM game_observations
            WHERE site_id = $1 AND device_activation_id = $2 AND received_at >= $3 AND id > $4
            ORDER BY id LIMIT $5`, [s.site_id, s.device_activation_id, cutoff, after, batchSize]);
                if (!rows.length)
                    break;
                let out = '';
                for (const r of rows) {
                    after = r.id;
                    const m = Number(r.multiplier);
                    if (!isValidMultiplier(m)) {
                        counts.invalidExcluded++;
                        continue;
                    }
                    if (r.chain_id != null && r.chain_index != null) {
                        const key = `${r.chain_id}|${r.chain_index}`;
                        if (seen.has(key)) {
                            counts.duplicatesRemoved++; // same position of the same read chain stored twice: keep the first
                            continue;
                        }
                        seen.add(key);
                    }
                    const cur = { id: String(r.id), multiplier: m, receivedAt: r.received_at, source: r.source, breakBefore: r.break_before };
                    const brk = isBreak(prev, cur);
                    prev = cur;
                    if (brk)
                        run++;
                    const inWindow = (!opts.since || r.received_at >= opts.since) && (!opts.until || r.received_at < opts.until);
                    if (!inWindow)
                        continue;
                    if (r.chain_id == null)
                        counts.rowsWithoutContinuity++;
                    counts.rows++;
                    emittedInStream++;
                    if (run !== lastRunEmitted) {
                        counts.runs++;
                        lastRunEmitted = run;
                    }
                    out +=
                        [
                            EXPORT_SCHEMA_VERSION,
                            r.site_id,
                            s.stream,
                            r.id,
                            r.received_iso,
                            r.multiplier,
                            r.source,
                            r.chain_id == null ? '' : chainPseudonym(opts.pepper, r.chain_id),
                            r.chain_index ?? '',
                            bool(r.break_before),
                            brk ? 'false' : 'true',
                            run,
                        ].join(',') + '\n';
                }
                if (out)
                    await emit(out);
                if (rows.length < batchSize)
                    break;
            }
            if (emittedInStream)
                counts.streams++;
        }
        await client.query('COMMIT');
        return {
            schemaVersion: EXPORT_SCHEMA_VERSION,
            tool: EXPORT_TOOL,
            engineVersion: ENGINE_VERSION,
            generatedAt: clock.now.toISOString(),
            retentionHours: HISTORY_RETENTION_HOURS,
            window: { retentionCutoff: cutoff.toISOString(), since: opts.since?.toISOString() ?? null, until: opts.until?.toISOString() ?? null },
            site: siteFilter,
            columns: EXPORT_COLUMNS,
            counts,
            csvSha256: hash.digest('hex'),
            csvBytes: bytes,
            limitations: EXPORT_LIMITATIONS,
        };
    }
    catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
    }
    finally {
        client.release();
    }
}
/**
 * Writes `<base>.csv` and `<base>.manifest.json` into `outDir` (owner-only, never overwriting an existing export)
 * and records the audit event `admin.rounds_exported` with counts only — no game data.
 */
export async function exportRoundsToFiles(pool, keys, opts, outDir, actor = 'cli', 
/** Names the files (UTC, second resolution); injectable for tests. */
now = new Date()) {
    await mkdir(outDir, { recursive: true, mode: 0o700 });
    const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    const base = `rounds-${opts.site ?? 'all'}-${stamp}`;
    const csvPath = join(outDir, `${base}.csv`);
    const manifestPath = join(outDir, `${base}.manifest.json`);
    const partial = `${csvPath}.partial`;
    const fh = await open(partial, 'wx', 0o600);
    let manifest;
    try {
        manifest = await exportRounds(pool, { pepper: keys.devicePepper, ...opts }, async (s) => {
            await fh.write(s);
        });
    }
    catch (err) {
        await fh.close();
        await rm(partial, { force: true });
        throw err;
    }
    await fh.close();
    // link() fails if the target exists, so a finished export is never overwritten; then drop the temporary name.
    try {
        await link(partial, csvPath);
    }
    finally {
        await unlink(partial);
    }
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await recordSecurityEvent(pool, keys.ipPepper, {
        type: 'admin.rounds_exported',
        actor,
        detail: { site: manifest.site, since: manifest.window.since, until: manifest.window.until, rows: manifest.counts.rows, streams: manifest.counts.streams },
    });
    return { csvPath, manifestPath, manifest };
}
