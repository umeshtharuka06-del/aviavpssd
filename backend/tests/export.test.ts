import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from '../src/database/pool.js';
import { breaksOf, type LedgerRound } from '../src/engine/sequential/engine.js';
import {
  chainPseudonym,
  csvCell,
  EXPORT_COLUMNS,
  exportRounds,
  exportRoundsToFiles,
  parseExportOptions,
  streamPseudonym,
} from '../src/export/rounds-export.js';
import { hmacSha256 } from '../src/security/crypto.js';
import { adminHeaders, bearer, createAdmin, createHarness, generate, redeem, resetDb, serviceHeaders, TEST_SECRETS, type Harness } from './helpers.js';

let h: Harness;
const PEPPER = TEST_SECRETS.DEVICE_PEPPER;

interface Device {
  activationId: number;
  publicId: string;
  clientDeviceId: string;
  token: string;
}
let devices: Device[];
let codes: string[];

beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => h.close());
beforeEach(async () => {
  await resetDb(h.pool);
  await h.pool.query('TRUNCATE round_forecasts, forecast_outcomes, chain_links CASCADE');
  await createAdmin(h.pool);
  const [c] = await generate(h, await adminHeaders(h), { plan: '30d', deviceLimit: 3 });
  codes = [c!.code];
  devices = [];
  for (let i = 0; i < 2; i++) {
    const clientDeviceId = randomUUID();
    const token = (await redeem(h, c!.code, clientDeviceId)).body.session.token;
    devices.push({ activationId: 0, publicId: '', clientDeviceId, token });
  }
  const { rows } = await h.pool.query<{ id: number; public_id: string }>('SELECT id, public_id FROM device_activations ORDER BY id');
  rows.forEach((r, i) => Object.assign(devices[i]!, { activationId: r.id, publicId: r.public_id }));
});

/** Direct insert with full control over continuity and age (seconds before the database's now()). */
async function insert(
  device: Device | null,
  multiplier: string,
  o: { site?: string; ago?: number; chain?: string | null; index?: number | null; breakBefore?: boolean | null; source?: 'live' | 'backfill' } = {},
): Promise<number> {
  const { rows } = await h.pool.query<{ id: number }>(
    `INSERT INTO game_observations (site_id, multiplier, device_activation_id, received_at, source, chain_id, chain_index, break_before)
     VALUES ($1, $2::numeric, $3, now() - make_interval(secs => $4), $5, $6, $7, $8) RETURNING id`,
    [o.site ?? 'devfixture', multiplier, device?.activationId ?? null, o.ago ?? 60, o.source ?? 'live', o.chain ?? null, o.index ?? null, o.breakBefore ?? null],
  );
  return rows[0]!.id;
}

async function exportText(opts: Partial<Parameters<typeof exportRounds>[1]> = {}, pool: Pool = h.pool) {
  let csv = '';
  const manifest = await exportRounds(pool, { pepper: PEPPER, ...opts }, (s) => {
    csv += s;
  });
  return { csv, manifest, rows: parse(csv) };
}

function parse(csv: string): Record<string, string>[] {
  const [head, ...lines] = csv.trimEnd().split('\n');
  const cols = head!.split(',');
  return lines.filter(Boolean).map((l) => Object.fromEntries(l.split(',').map((v, i) => [cols[i]!, v])));
}

const seq = (n: number, start = 1.1) => Array.from({ length: n }, (_, i) => (start + i * 0.37).toFixed(2));

async function ingest(d: Device, multipliers: string[], continuity?: { chain: string; index: number }) {
  const res = await h.app.inject({
    method: 'POST',
    url: '/v1/history',
    headers: bearer(d.token),
    payload: { batchId: randomUUID(), siteId: 'devfixture', adapterVersion: '1.0.0', observations: multipliers.map((m) => ({ multiplier: Number(m) })), ...(continuity ? { continuity } : {}) },
  });
  expect(res.statusCode).toBe(200);
}

describe('live round export: privacy', () => {
  it('has exactly the allow-listed columns and leaks no device, account, code or token value', async () => {
    const chain = randomUUID();
    await ingest(devices[0]!, seq(6), { chain, index: 0 });
    await ingest(devices[1]!, seq(4, 2.0));
    const { csv, rows } = await exportText();
    expect(csv.split('\n')[0]).toBe(EXPORT_COLUMNS.join(','));
    expect(rows).toHaveLength(10);
    const forbidden = [
      ...devices.flatMap((d) => [d.publicId, d.clientDeviceId, d.token]),
      ...codes,
      chain,
      hmacSha256(TEST_SECRETS.DEVICE_PEPPER, devices[0]!.clientDeviceId).toString('hex'),
    ];
    for (const f of forbidden) expect(csv).not.toContain(f);
    expect(csv).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i); // no raw UUIDs at all
    for (const r of rows) {
      expect(r.stream).toMatch(/^s_[0-9a-f]{16}$/);
      expect(r.chain === '' || /^c_[0-9a-f]{16}$/.test(r.chain!)).toBe(true);
    }
  });

  it('stream pseudonyms are stable across exports, differ per device and are domain-separated', async () => {
    await insert(devices[0]!, '1.50');
    await insert(devices[1]!, '2.50');
    const a = await exportText();
    const b = await exportText();
    const streamsA = a.rows.map((r) => r.stream);
    expect(streamsA).toEqual(b.rows.map((r) => r.stream));
    expect(new Set(streamsA).size).toBe(2);
    const s0 = streamPseudonym(PEPPER, devices[0]!.activationId);
    expect(streamsA).toContain(s0);
    // not the plain keyed hash of the id, not the chain label, not under another secret
    expect(s0.slice(2)).not.toBe(hmacSha256(PEPPER, String(devices[0]!.activationId)).toString('hex').slice(0, 16));
    expect(s0.slice(2)).not.toBe(chainPseudonym(PEPPER, String(devices[0]!.activationId)).slice(2));
    expect(streamPseudonym(TEST_SECRETS.IP_HASH_PEPPER, devices[0]!.activationId)).not.toBe(s0);
  });
});

describe('live round export: data integrity', () => {
  it('multipliers are the stored text, times are ISO UTC with microseconds, rows are ordered by site, stream, obs_id', async () => {
    for (const m of ['1.00', '10.50', '1000000.00', '2.07']) await insert(devices[0]!, m);
    await insert(devices[1]!, '3.33', { site: 'onexbet' });
    await insert(devices[0]!, '4.44', { site: 'onexbet' });
    const { rows, manifest } = await exportText();
    expect(rows.filter((r) => r.site_id === 'devfixture').map((r) => r.multiplier)).toEqual(['1.00', '10.50', '1000000.00', '2.07']);
    for (const r of rows) expect(r.received_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
    const keys = rows.map((r) => [r.site_id!, r.stream!, Number(r.obs_id)] as const);
    const sorted = [...keys].sort((x, y) => (x[0] !== y[0] ? (x[0] < y[0] ? -1 : 1) : x[1] !== y[1] ? (x[1] < y[1] ? -1 : 1) : x[2] - y[2]));
    expect(keys).toEqual(sorted);
    expect(manifest.counts).toMatchObject({ rows: 6, streams: 3 });
  });

  it('respects the retention window, the site filter and since/until', async () => {
    await insert(devices[0]!, '9.99', { ago: 13 * 3600 }); // older than 12 h, not yet purged
    const keep = await insert(devices[0]!, '1.10', { ago: 3600 });
    await insert(devices[0]!, '1.20', { ago: 600 });
    await insert(devices[0]!, '5.55', { site: 'onexbet', ago: 600 });
    const all = await exportText();
    expect(all.rows.map((r) => r.multiplier)).not.toContain('9.99');
    expect(all.rows).toHaveLength(3);
    expect((await exportText({ site: 'onexbet' })).rows.map((r) => r.multiplier)).toEqual(['5.55']);
    const t = (await h.pool.query<{ t: Date }>('SELECT now() - interval \'30 minutes\' AS t')).rows[0]!.t;
    const until = await exportText({ site: 'devfixture', until: t });
    expect(until.rows.map((r) => r.obs_id)).toEqual([String(keep)]);
    const since = await exportText({ site: 'devfixture', since: t });
    expect(since.rows.map((r) => r.multiplier)).toEqual(['1.20']);
  });

  it('an empty window exports the header only', async () => {
    const { csv, manifest } = await exportText();
    expect(csv).toBe(`${EXPORT_COLUMNS.join(',')}\n`);
    expect(manifest.counts.rows).toBe(0);
  });

  it('rows whose device was deleted are excluded and counted, never merged into a stream', async () => {
    await insert(null, '1.50');
    await insert(devices[0]!, '2.50');
    const { rows, manifest } = await exportText();
    expect(rows).toHaveLength(1);
    expect(manifest.counts.unattributedRowsExcluded).toBe(1);
  });
});

describe('live round export: duplicates', () => {
  it('the same position of the same read chain stored twice is exported once and counted', async () => {
    const chain = randomUUID();
    await insert(devices[0]!, '1.50', { chain, index: 0, breakBefore: true });
    await insert(devices[0]!, '2.50', { chain, index: 1, breakBefore: false });
    await insert(devices[0]!, '2.50', { chain, index: 1, breakBefore: false }); // duplicate
    await insert(devices[0]!, '3.50', { chain, index: 2, breakBefore: false });
    const { rows, manifest } = await exportText();
    expect(rows.map((r) => r.multiplier)).toEqual(['1.50', '2.50', '3.50']);
    expect(rows.map((r) => r.verified_successor)).toEqual(['false', 'true', 'true']);
    expect(manifest.counts.duplicatesRemoved).toBe(1);
  });

  it('a re-sent batch is stored once, so it is exported once', async () => {
    const payload = { batchId: randomUUID(), siteId: 'devfixture', adapterVersion: '1.0.0', observations: [{ multiplier: 1.23 }, { multiplier: 4.56 }] };
    for (let i = 0; i < 2; i++) await h.app.inject({ method: 'POST', url: '/v1/history', headers: bearer(devices[0]!.token), payload });
    expect((await exportText()).rows.map((r) => r.multiplier)).toEqual(['1.23', '4.56']);
  });

  it('the same game round seen by two devices stays one row per stream (not merged in the export)', async () => {
    await insert(devices[0]!, '7.77');
    await insert(devices[1]!, '7.77');
    const { rows } = await exportText();
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.stream)).size).toBe(2);
  });
});

describe('live round export: continuity equals the live engine', () => {
  async function expectedFor(device: Device) {
    const { rows } = await h.pool.query<{ id: string; multiplier: string; received_at: Date; source: 'live' | 'backfill'; break_before: boolean | null }>(
      // ORDER BY the bigint column (g.id), not the text output alias, exactly as the ledger loads rounds
      `SELECT g.id::text AS id, g.multiplier::text AS multiplier, g.received_at, g.source, g.break_before FROM game_observations g
        WHERE g.device_activation_id = $1 AND g.site_id = 'devfixture' AND g.received_at >= now() - interval '12 hours' ORDER BY g.id`,
      [device.activationId],
    );
    const rounds: LedgerRound[] = rows.map((r) => ({ id: r.id, multiplier: Number(r.multiplier), receivedAt: r.received_at, source: r.source, breakBefore: r.break_before }));
    const br = breaksOf(rounds);
    let run = -1;
    return rounds.map((r, i) => {
      if (br[i]) run++;
      return { obs_id: r.id, verified_successor: br[i] ? 'false' : 'true', run_id: String(run) };
    });
  }

  it('direct rows: verified chain, new chain, index jump, and older clients under the 120 s rule', async () => {
    const a = randomUUID();
    const b = randomUUID();
    await insert(devices[0]!, '1.10', { chain: a, index: 0, breakBefore: true, ago: 900 });
    await insert(devices[0]!, '1.20', { chain: a, index: 1, breakBefore: false, ago: 880 });
    await insert(devices[0]!, '1.30', { chain: a, index: 4, breakBefore: true, ago: 860 }); // dropped batch
    await insert(devices[0]!, '1.40', { chain: b, index: 0, breakBefore: true, ago: 840 }); // new chain
    await insert(devices[0]!, '1.50', { chain: b, index: 1, breakBefore: false, ago: 820 });
    await insert(devices[0]!, '2.10', { ago: 800 }); // older client, 20 s later: verified by time
    await insert(devices[0]!, '2.20', { ago: 500 }); // 300 s later: break by time
    await insert(devices[0]!, '2.30', { ago: 490 });
    const { rows } = await exportText({ site: 'devfixture' });
    expect(rows.map((r) => ({ obs_id: r.obs_id, verified_successor: r.verified_successor, run_id: r.run_id }))).toEqual(await expectedFor(devices[0]!));
    expect(rows.map((r) => r.verified_successor)).toEqual(['false', 'true', 'false', 'false', 'true', 'true', 'false', 'true']);
    expect(rows.map((r) => r.break_before)).toEqual(['true', 'false', 'true', 'true', 'false', '', '', '']);
  });

  it('rounds ingested through the real API with continuity match breaksOf as well', async () => {
    const c1 = randomUUID();
    await ingest(devices[0]!, seq(5), { chain: c1, index: 0 });
    await ingest(devices[0]!, seq(3, 3.0), { chain: c1, index: 5 }); // verified successor
    await ingest(devices[0]!, seq(2, 6.0), { chain: c1, index: 12 }); // index jump: break
    await ingest(devices[0]!, seq(2, 8.0), { chain: randomUUID(), index: 0 }); // new chain: break
    const { rows, manifest } = await exportText();
    expect(rows.map((r) => ({ obs_id: r.obs_id, verified_successor: r.verified_successor, run_id: r.run_id }))).toEqual(await expectedFor(devices[0]!));
    expect(manifest.counts.runs).toBe(3);
  });

  it('since/until filter after continuity: the first exported row keeps its true predecessor', async () => {
    const c = randomUUID();
    await insert(devices[0]!, '1.10', { chain: c, index: 0, breakBefore: true, ago: 1200 });
    await insert(devices[0]!, '1.20', { chain: c, index: 1, breakBefore: false, ago: 600 });
    const t = (await h.pool.query<{ t: Date }>("SELECT now() - interval '15 minutes' AS t")).rows[0]!.t;
    const { rows } = await exportText({ since: t });
    expect(rows).toEqual([expect.objectContaining({ multiplier: '1.20', verified_successor: 'true', run_id: '0' })]);
  });
});

describe('live round export: reproducibility, read-only, safety', () => {
  it('the same snapshot exports byte-identical CSV, and the manifest hash matches the bytes', async () => {
    for (const m of seq(30)) await insert(devices[0]!, m);
    for (const m of seq(12, 1.5)) await insert(devices[1]!, m);
    const a = await exportText();
    const b = await exportText({ batchSize: 7 }); // pagination does not change the output
    expect(b.csv).toBe(a.csv);
    expect(a.manifest.csvSha256).toBe(createHash('sha256').update(a.csv, 'utf8').digest('hex'));
    expect(a.manifest.csvBytes).toBe(Buffer.byteLength(a.csv));
  });

  it('runs in a READ ONLY transaction: a write on the export connection fails and nothing changes', async () => {
    await insert(devices[0]!, '1.50');
    const counts = async () =>
      (
        await h.pool.query(`SELECT (SELECT count(*) FROM game_observations) g, (SELECT count(*) FROM round_forecasts) f,
                                   (SELECT count(*) FROM security_events) s, (SELECT count(*) FROM chain_links) l`)
      ).rows[0];
    const before = await counts();
    let exportClient: { query: (sql: string) => Promise<unknown> } | undefined;
    const spy = {
      connect: async () => {
        const c = await h.pool.connect();
        exportClient = c;
        return c;
      },
    } as unknown as Pool;
    await expect(
      exportRounds(spy, { pepper: PEPPER }, async () => {
        await exportClient!.query("INSERT INTO security_events (event_type) VALUES ('test.write')");
      }),
    ).rejects.toThrow(/read-only transaction/);
    expect(await counts()).toEqual(before);
    await expect(exportText()).resolves.toBeTruthy(); // a normal export changes nothing either
    expect(await counts()).toEqual(before);
  });

  it('no cell can start a spreadsheet formula, even a site key beginning with "-" (allowed by the database)', async () => {
    const c = randomUUID();
    await insert(devices[0]!, '1.00', { chain: c, index: 0, breakBefore: true });
    await insert(devices[0]!, '12.34', { chain: c, index: 1, breakBefore: false, source: 'backfill' });
    await insert(devices[1]!, '2.50', { site: '-a1-a2' }); // possible only with ACCEPTED_SITE_IDS="*"
    await insert(devices[1]!, '3.50', { site: '_x' });
    const { csv, rows } = await exportText();
    for (const cell of csv.trimEnd().split('\n').flatMap((l) => l.split(','))) expect(cell).not.toMatch(/^[=+\-@\t\r]/);
    expect(rows.map((r) => r.site_id).sort()).toEqual(["'-a1-a2", '_x', 'devfixture', 'devfixture']);
    expect((await exportText({ site: '-a1-a2' })).rows.map((r) => r.multiplier)).toEqual(['2.50']); // the filter uses the real key
  });

  it('the formula guard prefixes only risky cells and leaves every normal value unchanged', () => {
    for (const v of ['=1+1', '+1', '-a1', '@x', '\tx', '\rx']) expect(csvCell(v)).toBe(`'${v}`);
    for (const v of ['onexbet', '_x', '1.00', 's_0123456789abcdef', '2026-10-31T00:00:00.000000Z', 0, 12, 'true', '']) expect(csvCell(v)).toBe(String(v));
  });

  it('exports 100,000 rounds through keyset pagination', async () => {
    await h.pool.query(
      `INSERT INTO game_observations (site_id, multiplier, device_activation_id, received_at, source)
       SELECT 'devfixture', round((1 + random() * 20)::numeric, 2), $1, now() - make_interval(secs => 40000 - g * 0.3), 'live'
         FROM generate_series(1, 100000) g`,
      [devices[0]!.activationId],
    );
    const t0 = Date.now();
    let lines = 0;
    const m = await exportRounds(h.pool, { pepper: PEPPER }, (s) => {
      lines += s.split('\n').length - 1;
    });
    const ms = Date.now() - t0;
    expect(m.counts.rows).toBe(100_000);
    expect(lines).toBe(100_001);
    expect(ms).toBeLessThan(10_000);
  }, 60_000);
});

describe('live round export: CLI files, audit, options and surface', () => {
  it('writes owner-only CSV + manifest, never overwrites, and audits counts only', async () => {
    for (const m of ['1.11', '2.22', '3.33']) await insert(devices[0]!, m);
    const dir = await mkdtemp(join(tmpdir(), 'aviator-export-'));
    const now = new Date('2026-10-31T06:00:00.000Z');
    const r = await exportRoundsToFiles(h.pool, { devicePepper: PEPPER, ipPepper: TEST_SECRETS.IP_HASH_PEPPER }, {}, dir, 'cli', now);
    expect(r.csvPath).toMatch(/rounds-all-20261031T060000Z\.csv$/);
    const csv = await readFile(r.csvPath, 'utf8');
    const manifest = JSON.parse(await readFile(r.manifestPath, 'utf8'));
    expect(manifest.csvSha256).toBe(createHash('sha256').update(csv).digest('hex'));
    expect(manifest.counts.rows).toBe(3);
    expect(manifest.limitations.length).toBeGreaterThan(5);
    if (process.platform !== 'win32') expect((await stat(r.csvPath)).mode & 0o777).toBe(0o600);
    await expect(exportRoundsToFiles(h.pool, { devicePepper: PEPPER, ipPepper: TEST_SECRETS.IP_HASH_PEPPER }, {}, dir, 'cli', now)).rejects.toThrow(/EEXIST/);
    expect(await readFile(r.csvPath, 'utf8')).toBe(csv);
    expect((await readdir(dir)).sort()).toEqual([`rounds-all-20261031T060000Z.csv`, `rounds-all-20261031T060000Z.manifest.json`]);
    const { rows } = await h.pool.query<{ actor: string; detail: Record<string, unknown> }>("SELECT actor, detail FROM security_events WHERE event_type = 'admin.rounds_exported'");
    expect(rows).toEqual([{ actor: 'cli', detail: { site: null, since: null, until: null, rows: 3, streams: 1 } }]);
    expect(JSON.stringify(rows)).not.toMatch(/1\.11|2\.22|3\.33|s_[0-9a-f]{16}/);
  });

  it('validates options strictly', () => {
    expect(parseExportOptions({ site: 'onexbet', since: '2026-10-31T00:00:00Z', until: '2026-10-31T06:00:00.5+05:30' })).toMatchObject({ site: 'onexbet' });
    expect(() => parseExportOptions({ site: 'ONE XBET' })).toThrow(/--site/);
    expect(() => parseExportOptions({ since: '2026-10-31' })).toThrow(/ISO-8601/);
    expect(() => parseExportOptions({ since: '2026-10-31T06:00:00Z', until: '2026-10-31T05:00:00Z' })).toThrow(/after/);
  });

  it('has no HTTP surface: no admin or customer route serves an export', async () => {
    const admin = await adminHeaders(h);
    for (const url of ['/v1/admin/export/rounds.csv', '/v1/admin/export/rounds', '/v1/export/rounds.csv']) {
      const res = await h.app.inject({ method: 'GET', url, headers: { ...serviceHeaders(), ...admin } });
      expect(res.statusCode).toBe(404);
    }
  });
});
