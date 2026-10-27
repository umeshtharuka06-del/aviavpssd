import { evidenceOf, issueForecast, resolve } from './engine.js';
/**
 * In-memory forecast ledger with the same steps as the server's syncLedgerLocked (score every open
 * forecast whose next round is stored, then record ONE forecast for the round after the latest
 * stored round), without a database. Used by the local panel preview and end-to-end tests.
 * Rounds whose id is already stored are ignored, as the server's de-duplication does.
 */
export class MemoryLedger {
    idPrefix;
    rounds = [];
    entries = [];
    issued = 0;
    constructor(idPrefix = 'SIM') {
        this.idPrefix = idPrefix;
    }
    /** Stores new rounds (oldest first), then syncs. Returns how many were new. */
    add(rounds) {
        const known = new Set(this.rounds.map((r) => r.id));
        const fresh = rounds.filter((r) => !known.has(r.id));
        if (!fresh.length)
            return 0;
        this.rounds.push(...fresh);
        this.sync();
        return fresh.length;
    }
    sync() {
        const pos = new Map(this.rounds.map((r, i) => [r.id, i]));
        for (const e of this.entries) {
            if (e.outcome)
                continue;
            const at = pos.get(e.forecast.inputLastRoundId);
            const next = at == null ? undefined : this.rounds[at + 1];
            if (next)
                e.outcome = resolve(e.forecast, next, next.receivedAt, { checkLate: false });
        }
        const last = this.rounds[this.rounds.length - 1];
        if (!last || this.entries.some((e) => e.forecast.inputLastRoundId === last.id))
            return;
        const id = `fc_${this.idPrefix}${String(this.issued + 1).padStart(16 - this.idPrefix.length, '0')}`;
        const { forecast } = issueForecast(this.rounds, evidenceOf(this.entries), {
            engineVersion: 'stat-5',
            issuedAt: new Date(last.receivedAt.getTime() + 500),
            id,
        });
        if (forecast) {
            this.issued++;
            this.entries.push({ forecast, outcome: null });
        }
    }
}
