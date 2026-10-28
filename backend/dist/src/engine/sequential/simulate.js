/**
 * SIMULATED rounds for tests, backtests and the local preview. Never real game data.
 */
export function prng(seed) {
    let s = seed >>> 0;
    return () => {
        s = (s + 0x6d2b79f5) >>> 0;
        let t = s;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
/** Independent rounds with P(M ≥ m) = rtp ÷ m (two decimals, floored), as a 97%-RTP crash game would give. */
export function fairMultiplier(rand, rtp = 0.97) {
    return Math.max(1, Math.floor((rtp * 100) / (1 - rand())) / 100);
}
/**
 * Rounds with a PLANTED dependence on the previous round: after a round below 2×, the next round
 * reaches 2× with probability 0.485 + effect; after a round at or above 2×, with 0.485 − effect.
 * Within each side the multiplier keeps the fair conditional shape.
 */
export function plantedSequence(n, seed, effect) {
    const rand = prng(seed);
    const out = [];
    let prevLow = true;
    for (let i = 0; i < n; i++) {
        const pHigh = 0.485 + (prevLow ? effect : -effect);
        let m;
        if (rand() < pHigh)
            m = Math.max(2, Math.floor(200 / (1 - rand())) / 100); // P(M≥m | M≥2) = 2/m
        else
            m = Math.min(1.99, 1 + Math.floor(rand() * 100) / 100);
        out.push(m);
        prevLow = m < 2;
    }
    return out;
}
export function fairSequence(n, seed, rtp = 0.97) {
    const rand = prng(seed);
    return Array.from({ length: n }, () => fairMultiplier(rand, rtp));
}
/** Rounds every `spacing` ms from `start`, with ids 1…n. Marks nothing as backfill. */
export function asRounds(multipliers, start = Date.UTC(2026, 9, 28, 9, 0, 0), spacingMs = 20_000) {
    return multipliers.map((m, i) => ({ id: String(i + 1), multiplier: m, receivedAt: new Date(start + i * spacingMs), source: 'live' }));
}
