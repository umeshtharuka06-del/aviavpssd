const MIN_OBSERVATIONS = 10;
const NOTICE = 'Descriptive statistics of observed multipliers within the retention window. ' +
    'Past results do not predict future outcomes. This is not a signal, prediction, or strategy recommendation.';
const INSUFFICIENT_NOTICE = 'Not enough data yet — at least 10 rounds are needed for meaningful statistics. ' +
    'Past results do not predict future outcomes.';
export class StatisticalAnalysisProvider {
    kind = 'live';
    version = 'stat-1';
    isTestData = false;
    async analyze(input) {
        const multipliers = input.observations
            .map((o) => o.multiplier)
            .filter((m) => Number.isFinite(m) && m >= 1);
        const n = multipliers.length;
        if (n < MIN_OBSERVATIONS) {
            return {
                status: 'insufficient_data',
                items: [{ label: 'Observations in window', value: String(n) }],
                notice: INSUFFICIENT_NOTICE,
            };
        }
        const sorted = multipliers.slice().sort((a, b) => a - b);
        const sum = multipliers.reduce((acc, v) => acc + v, 0);
        const mean = sum / n;
        const median = n % 2 === 1
            ? sorted[Math.floor(n / 2)]
            : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
        const variance = multipliers.reduce((acc, v) => acc + (v - mean) ** 2, 0) / n;
        const stdDev = Math.sqrt(variance);
        const q25 = percentile(sorted, 0.25);
        const q75 = percentile(sorted, 0.75);
        let under2 = 0;
        let under5 = 0;
        let under10 = 0;
        for (const m of multipliers) {
            if (m < 2)
                under2++;
            if (m < 5)
                under5++;
            if (m < 10)
                under10++;
        }
        const modeBinFloor = modeBucket(multipliers);
        const modeLabel = modeBinFloor >= 50
            ? '50.00×+'
            : `${modeBinFloor}.00× – ${modeBinFloor}.99×`;
        const timestamps = input.observations.map((o) => o.receivedAt.getTime());
        const oldest = Math.min(...timestamps);
        const newest = Math.max(...timestamps);
        const spanMs = newest - oldest;
        return {
            status: 'ok',
            items: [
                { label: 'Rounds in window', value: fmtCount(n) },
                { label: 'Time span', value: fmtTimeSpan(spanMs) },
                { label: 'Mean multiplier', value: fmtMult(mean) },
                { label: 'Median multiplier', value: fmtMult(median) },
                { label: 'Std deviation', value: fmtMult(stdDev) },
                { label: '25th percentile', value: fmtMult(q25) },
                { label: '75th percentile', value: fmtMult(q75) },
                { label: 'Minimum', value: fmtMult(sorted[0]) },
                { label: 'Maximum', value: fmtMult(sorted[n - 1]) },
                { label: 'Rounds < 2×', value: fmtPct(under2, n) },
                { label: 'Rounds < 5×', value: fmtPct(under5, n) },
                { label: 'Rounds < 10×', value: fmtPct(under10, n) },
                { label: 'Rounds ≥ 10×', value: fmtPct(n - under10, n) },
                { label: 'Most common range', value: modeLabel },
            ],
            notice: NOTICE,
        };
    }
}
function percentile(sorted, p) {
    const idx = p * (sorted.length - 1);
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    if (lo === hi)
        return sorted[lo];
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}
function modeBucket(multipliers) {
    const bins = new Map();
    for (const m of multipliers) {
        const bin = Math.min(Math.floor(m), 50);
        bins.set(bin, (bins.get(bin) ?? 0) + 1);
    }
    let best = 1;
    let bestCount = 0;
    for (const [bin, count] of bins) {
        if (count > bestCount || (count === bestCount && bin < best)) {
            best = bin;
            bestCount = count;
        }
    }
    return best;
}
function fmtMult(v) {
    if (v >= 10_000)
        return `${Math.round(v).toLocaleString('en-US')}×`;
    return `${v.toFixed(2)}×`;
}
function fmtCount(n) {
    return n.toLocaleString('en-US');
}
function fmtPct(count, total) {
    const pct = ((count / total) * 100).toFixed(1);
    return `${pct}% (${fmtCount(count)})`;
}
function fmtTimeSpan(ms) {
    if (ms < 60_000)
        return '< 1 min';
    const hours = Math.floor(ms / 3_600_000);
    const minutes = Math.floor((ms % 3_600_000) / 60_000);
    if (hours === 0)
        return `${minutes} min`;
    return `${hours} h ${minutes} min`;
}
