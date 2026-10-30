"""Sequential pattern analysis. Every statistic uses only pairs/streaks INSIDE one run (no unverified joins).

Under the null of independent rounds with a constant distribution:
  low streaks       lengths are geometric with success probability p = P(>= threshold)
  P(hit | k lows)   is the same p for every k
  ACF               is 0 at every lag (Ljung-Box Q ~ chi2(L))
  changes           are Binomial(pairs, 2pq) with the adjacent-pair covariance pq - (2pq)^2
"""

from __future__ import annotations

import numpy as np
from scipy import stats

from .ranges import DISPLAY_RANGES, range_index, target_hit, wilson


def run_starts(run_id: np.ndarray) -> np.ndarray:
    s = np.ones(run_id.size, dtype=bool)
    s[1:] = run_id[1:] != run_id[:-1]
    return s


def consecutive_low_before(multipliers: np.ndarray, run_id: np.ndarray, threshold: float = 2.0) -> np.ndarray:
    """For each round t: consecutive rounds below `threshold` immediately before t in the same run.

    This is the strategy's `consecutiveLow` at the moment round t is forecast: reset to 0 by a round >= threshold
    and by a run break (rounds may be missing there).
    """
    hit = target_hit(multipliers, threshold)
    starts = run_starts(run_id)
    out = np.zeros(multipliers.size, dtype=np.int64)
    c = 0
    for t in range(multipliers.size):
        if starts[t]:
            c = 0
        out[t] = c
        c = 0 if hit[t] else c + 1
    return out


def low_count_exact(multipliers: np.ndarray, run_id: np.ndarray, threshold: float = 2.0) -> np.ndarray:
    """True where `consecutive_low_before` is the exact count: a round >= threshold precedes the low streak inside
    the same run. Where the streak reaches back to the run start, earlier rounds may be missing (censored)."""
    hit = target_hit(multipliers, threshold)
    starts = run_starts(run_id)
    out = np.zeros(multipliers.size, dtype=bool)
    seen = False
    for t in range(multipliers.size):
        if starts[t]:
            seen = False
        out[t] = seen
        seen = seen or bool(hit[t])
    return out


def low_streaks(multipliers: np.ndarray, run_id: np.ndarray, threshold: float = 2.0) -> np.ndarray:
    """Lengths of maximal streaks below `threshold` that are COMPLETE: bounded by a hit on both sides inside one run.

    Streaks touching a run start or end are censored (their true length is unknown) and left out.
    """
    hit = target_hit(multipliers, threshold)
    starts = run_starts(run_id)
    out: list[int] = []
    cur, open_left = 0, False
    for t in range(multipliers.size):
        if starts[t]:
            cur, open_left = 0, False  # a streak in progress at a break is censored
        if hit[t]:
            if cur > 0 and open_left:
                out.append(cur)
            cur, open_left = 0, True
        else:
            cur += 1
    return np.asarray(out, dtype=np.int64)


def streak_distribution(streaks: np.ndarray, p_hit: float, max_len: int = 10) -> dict:
    """Observed streak-length counts vs geometric expectation; chi-square with a pooled tail bin.

    DESCRIPTIVE when the series has many run breaks: a complete streak of length L needs L + 2 rounds in one run,
    so short runs under-sample long streaks (length bias). The unbiased test of the same hypothesis is the hazard
    table in `conditional_on_lows`."""
    n = int(streaks.size)
    q = 1 - p_hit
    ks = np.arange(1, max_len + 1)
    obs = np.array([(streaks == k).sum() for k in ks[:-1]] + [(streaks >= max_len).sum()], dtype=float)
    pk = np.array([q ** (k - 1) * p_hit for k in ks[:-1]] + [q ** (max_len - 1)])
    exp = n * pk
    keep = exp >= 5
    chi2 = float(((obs[keep] - exp[keep]) ** 2 / exp[keep]).sum()) if n else 0.0
    df = max(1, int(keep.sum()) - 2)  # p estimated
    return {
        "complete_streaks": n,
        "longest": int(streaks.max()) if n else 0,
        "mean_length": float(streaks.mean()) if n else None,
        "expected_mean_length": 1 / p_hit if p_hit > 0 else None,
        "table": [{"length": f"{k}" if k < max_len else f"{max_len}+", "observed": int(o), "expected": float(e)} for k, o, e in zip(ks, obs, exp)],
        "chi2": chi2, "df": df, "p": float(stats.chi2.sf(chi2, df)) if n else None,
    }


def conditional_on_lows(multipliers: np.ndarray, run_id: np.ndarray, threshold: float = 2.0, max_k: int = 8) -> dict:
    """P(round >= threshold | k consecutive lows before it), k = 0..max_k (last bin k+), with Wilson CIs and a homogeneity test.

    This is the discrete hazard of the low streak. Only rounds whose count is exact are used (`low_count_exact`):
    counting from a run start would mix "0 lows" with "unknown", which biases the k = 0 row.
    """
    k = np.minimum(consecutive_low_before(multipliers, run_id, threshold), max_k)
    exact = low_count_exact(multipliers, run_id, threshold)
    hit = target_hit(multipliers, threshold)
    rows, table = [], []
    for j in range(max_k + 1):
        sel = (k == j) & exact
        n, h = int(sel.sum()), int(hit[sel].sum())
        p, lo, hi = wilson(h, n)
        rows.append({"lows_before": f"{j}" if j < max_k else f"{max_k}+", "n": n, "hits": h, "rate": p, "ci_low": lo, "ci_high": hi})
        if n:
            table.append([h, n - h])
    t = np.array(table)
    chi2, p, dof, _ = stats.chi2_contingency(t, correction=False) if len(t) > 1 else (0.0, 1.0, 0, None)
    return {"threshold": threshold, "rows": rows, "chi2": float(chi2), "df": int(dof), "p": float(p)}


def _pairs(run_id: np.ndarray, lag: int) -> np.ndarray:
    """Indices t such that t and t+lag are in the same run."""
    if lag >= run_id.size:
        return np.empty(0, dtype=np.int64)
    return np.nonzero(run_id[:-lag] == run_id[lag:])[0]


def acf_within_runs(x: np.ndarray, run_id: np.ndarray, max_lag: int = 10) -> dict:
    """Autocorrelation from within-run pairs and the Ljung-Box Q over lags 1..max_lag."""
    x = np.asarray(x, dtype=float)
    xc = x - x.mean()
    denom = float((xc ** 2).sum())
    n = x.size
    r, npairs = [], []
    for lag in range(1, max_lag + 1):
        i = _pairs(run_id, lag)
        # scale to the full-series normalisation, corrected for the share of pairs available
        rk = float((xc[i] * xc[i + lag]).sum() / denom * ((n - lag) / max(1, i.size))) if denom > 0 and i.size else 0.0
        r.append(rk)
        npairs.append(int(i.size))
    q = float(n * (n + 2) * sum(rk ** 2 / max(1, n - k) for k, rk in enumerate(r, start=1)))
    return {"lags": list(range(1, max_lag + 1)), "r": r, "pairs": npairs, "se_null": 1 / np.sqrt(n) if n else None,
            "ljung_box_q": q, "df": max_lag, "p": float(stats.chi2.sf(q, max_lag))}


def runs_test(multipliers: np.ndarray, run_id: np.ndarray, threshold: float = 2.0) -> dict:
    """Number of changes between below/at-or-above threshold on within-run adjacent pairs vs independence."""
    y = target_hit(multipliers, threshold).astype(int)
    p = y.mean()
    q = 1 - p
    i1 = _pairs(run_id, 1)
    changes = int((y[i1] != y[i1 + 1]).sum())
    n1 = i1.size
    # adjacent pair-pairs (t, t+1, t+2) inside one run
    i2 = _pairs(run_id, 2)
    a = 2 * p * q
    var = n1 * a * (1 - a) + 2 * i2.size * (p * q - a * a)
    z = (changes - n1 * a) / np.sqrt(var) if var > 0 else 0.0
    return {"pairs": int(n1), "changes": changes, "expected": float(n1 * a), "z": float(z), "p": float(2 * stats.norm.sf(abs(z)))}


def transition_test(multipliers: np.ndarray, run_id: np.ndarray) -> dict:
    """Previous display range -> next display range (4 x 4 chi-square, within-run pairs) and Cramer's V."""
    r = range_index(multipliers, DISPLAY_RANGES)
    i = _pairs(run_id, 1)
    t = np.zeros((4, 4))
    np.add.at(t, (r[i], r[i + 1]), 1)
    t = t[t.sum(1) > 0][:, t.sum(0) > 0]
    chi2, p, dof, _ = stats.chi2_contingency(t, correction=False)
    v = float(np.sqrt(chi2 / (t.sum() * (min(t.shape) - 1)))) if t.sum() else 0.0
    return {"chi2": float(chi2), "df": int(dof), "p": float(p), "cramers_v": v,
            "p_ge2_after_range": [float(row[1:].sum() / row.sum()) if row.sum() else None for row in t]}


def rolling_frequencies(multipliers: np.ndarray, window: int = 200, threshold: float = 2.0) -> dict:
    """Rolling share >= threshold over non-overlapping windows vs the binomial 95% band of the overall share."""
    y = target_hit(multipliers, threshold).astype(float)
    m = y.size // window
    if m < 2:
        return {"window": window, "windows": m}
    shares = y[: m * window].reshape(m, window).mean(1)
    p = y.mean()
    lo, hi = stats.binom.ppf([0.025, 0.975], window, p) / window
    outside = float(((shares < lo) | (shares > hi)).mean())
    disp = float(((shares - p) ** 2).sum() / (p * (1 - p) / window))  # ~ chi2(m-1) if homogeneous
    return {"window": window, "windows": int(m), "overall": float(p), "min": float(shares.min()), "max": float(shares.max()),
            "band_low": float(lo), "band_high": float(hi), "share_outside_band": outside, "nominal_outside": 0.05,
            "dispersion_chi2": disp, "df": int(m - 1), "p": float(stats.chi2.sf(disp, m - 1))}


def block_homogeneity(multipliers: np.ndarray, blocks: int = 10) -> dict:
    """Chi-square of display-range counts across chronological blocks (is the distribution stable over time?)."""
    r = range_index(multipliers, DISPLAY_RANGES)
    parts = np.array_split(r, blocks)
    t = np.array([[int((b == k).sum()) for k in range(4)] for b in parts])
    t = t[:, t.sum(0) > 0]
    chi2, p, dof, _ = stats.chi2_contingency(t, correction=False)
    share = [float((b >= 1).mean()) for b in parts]
    return {"blocks": blocks, "chi2": float(chi2), "df": int(dof), "p": float(p), "p_ge2_by_block": share}


def _kolmogorov_sf(d: float) -> float:
    return float(stats.kstwobign.sf(d))


def change_points(multipliers: np.ndarray, threshold: float = 2.0, min_segment: int = 500, max_depth: int = 3, alpha: float = 0.05) -> dict:
    """Binary segmentation of the >= threshold indicator with the CUSUM (Brownian-bridge) statistic.

    Every split candidate is tested; Benjamini-Hochberg is applied over all candidates; only BH-significant
    splits are reported as change points, so with stable data the list is empty.
    """
    y = target_hit(multipliers, threshold).astype(float)
    cands: list[dict] = []

    def seg(lo: int, hi: int, depth: int) -> None:
        n = hi - lo
        if n < 2 * min_segment or depth > max_depth:
            return
        s = y[lo:hi]
        p = s.mean()
        if p <= 0 or p >= 1:
            return
        cs = np.cumsum(s - p)
        k = np.arange(1, n + 1)
        stat = np.abs(cs) / np.sqrt(n * p * (1 - p))
        valid = (k >= min_segment) & (k <= n - min_segment)
        if not valid.any():
            return
        j = int(np.argmax(np.where(valid, stat, -1)))
        d = float(stat[j])
        cands.append({"index": lo + j + 1, "segment": [lo, hi], "stat": d, "p": _kolmogorov_sf(d),
                      "before": float(s[: j + 1].mean()), "after": float(s[j + 1:].mean())})
        seg(lo, lo + j + 1, depth + 1)
        seg(lo + j + 1, hi, depth + 1)

    seg(0, y.size, 0)
    if cands:
        ps = np.array([c["p"] for c in cands])
        adj = stats.false_discovery_control(ps, method="bh")
        for c, a in zip(cands, adj):
            c["p_bh"] = float(a)
    sig = sorted([c for c in cands if c["p_bh"] < alpha], key=lambda c: c["index"])
    return {"method": "binary segmentation, CUSUM, asymptotic Kolmogorov p, BH over candidates", "tested": len(cands), "significant": sig}


def benjamini_hochberg(ps: dict[str, float]) -> dict[str, float]:
    keys = list(ps)
    adj = stats.false_discovery_control(np.array([ps[k] for k in keys]), method="bh")
    return {k: float(a) for k, a in zip(keys, adj)}
