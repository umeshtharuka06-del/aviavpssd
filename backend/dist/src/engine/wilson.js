/**
 * Wilson score interval for a binomial proportion.
 *
 * Given `count` successes out of `total` trials, returns a two-sided confidence interval for the
 * underlying rate. The default z corresponds to 95% confidence. The Wilson interval is used
 * (rather than the normal approximation) because it stays inside [0, 1] and behaves well for
 * small samples and proportions near 0 or 1 — common here (e.g. P(≥10×)).
 *
 * This quantifies uncertainty about the HISTORICAL rate under i.i.d. assumptions. It is NOT a
 * statement about the outcome of any future round.
 */
/** z for a 95% two-sided interval (standard normal 0.975 quantile). */
export const Z_95 = 1.959963984540054;
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
export function wilsonInterval(count, total, z = Z_95) {
    if (!Number.isFinite(total) || total <= 0)
        return { low: 0, high: 1 };
    if (count < 0)
        count = 0;
    if (count > total)
        count = total;
    const p = count / total;
    const z2 = z * z;
    const denom = 1 + z2 / total;
    const center = (p + z2 / (2 * total)) / denom;
    const margin = (z / denom) * Math.sqrt((p * (1 - p)) / total + z2 / (4 * total * total));
    // The bounds are mathematically exact at the degenerate ends; snap them past FP rounding.
    const low = count <= 0 ? 0 : clamp01(center - margin);
    const high = count >= total ? 1 : clamp01(center + margin);
    return { low, high };
}
