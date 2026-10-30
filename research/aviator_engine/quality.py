"""Data-quality audit, produced before any model is fitted."""

from __future__ import annotations

from itertools import combinations
from pathlib import Path

import numpy as np
import pandas as pd
from scipy import stats

from .loaders import LoadResult, to_cents
from .ranges import DISPLAY_RANGES, RTP, frequencies, range_index, reference_probabilities


def series_quality(name: str, lr: LoadResult) -> dict:
    f = lr.frame
    m = f["multiplier"].to_numpy()
    c = to_cents(m)
    n = int(m.size)
    ts = f["timestamp"]
    has_time = bool(ts.notna().any())
    runs = f["run_id"].to_numpy()
    run_len = np.bincount(runs - runs.min()) if n else np.array([0])
    # adjacent equal values: observed vs expected under independence with the empirical value distribution
    vals, cnt = np.unique(c, return_counts=True)
    same_run = runs[1:] == runs[:-1]
    adj_obs = int(((c[1:] == c[:-1]) & same_run).sum())
    adj_exp = float(same_run.sum() * ((cnt / n) ** 2).sum()) if n else 0.0
    adj_p = float(stats.poisson.sf(adj_obs - 1, adj_exp)) if adj_exp > 0 else None
    ref = reference_probabilities(DISPLAY_RANGES)
    obs_k = np.bincount(range_index(m, DISPLAY_RANGES), minlength=4)
    chi2_ref = float(((obs_k - n * ref) ** 2 / (n * ref)).sum()) if n else None
    q: dict = {
        "series": name,
        "raw_rows": lr.raw_rows,
        "valid_rounds": n,
        "invalid_removed": lr.invalid,
        "exact_duplicates_removed": lr.exact_duplicates,
        "timestamp_disorder_in_file": lr.timestamp_disorder,
        "has_timestamps": has_time,
        "first": ts.min().isoformat() if has_time else None,
        "last": ts.max().isoformat() if has_time else None,
        "runs": int(runs.max() + 1) if n else 0,
        "longest_run": int(run_len.max()) if n else 0,
        "rounds_in_runs_ge_100": int(run_len[run_len >= 100].sum()) if n else 0,
        "two_decimals": bool((np.abs(m * 100 - c) < 1e-6).all()),
        "min": float(m.min()) if n else None,
        "max": float(m.max()) if n else None,
        "share_exactly_1_00": float((c == 100).mean()) if n else None,
        "adjacent_repeats": {"observed": adj_obs, "expected": adj_exp, "p_excess": adj_p},
        "fit_to_rtp_reference": {"chi2": chi2_ref, "df": 3, "p": float(stats.chi2.sf(chi2_ref, 3)) if n else None,
                                 "observed": (obs_k / max(n, 1)).tolist(), "reference": ref.tolist()},
        "synthetic_fingerprint": synthetic_fingerprint(m),
        "notes": list(lr.notes),
    }
    if has_time:
        dt = ts.diff().dt.total_seconds().to_numpy()[1:]
        dt = dt[np.isfinite(dt)]
        q["interval_seconds"] = {"median": float(np.median(dt)), "p95": float(np.quantile(dt, 0.95)), "duplicate_times": int((dt == 0).sum())}
    q["display_ranges"] = frequencies(m, DISPLAY_RANGES)
    return q


def synthetic_fingerprint(m: np.ndarray) -> dict:
    """Shape of the distribution inside [1, 2). A crash game with P(M >= m) = r/m has P(M < 1.5 | M < 2) =
    (1 - r/1.5) / (1 - r/2) ~ 0.686 for r = 0.97; a uniform generator gives 0.5. Far from the 1/m law = suspect."""
    c = to_cents(m)
    low = c < 200
    n = int(low.sum())
    if n == 0:
        return {"n": 0}
    share = float((c[low] < 150).sum() / n)
    expected = (1 - RTP / 1.5) / (1 - RTP / 2)
    se = np.sqrt(expected * (1 - expected) / n)
    z = (share - expected) / se
    return {"n_below_2": n, "share_below_1_5_given_below_2": share, "expected_1_over_m": expected, "uniform_would_give": 0.5,
            "z": float(z), "consistent_with_1_over_m_law": bool(abs(share - expected) < 0.05)}


def _grams(c: np.ndarray, k: int) -> set[bytes]:
    if c.size < k:
        return set()
    w = np.lib.stride_tricks.sliding_window_view(c.astype(np.int64), k)
    return {row.tobytes() for row in w}


def overlap(series: dict[str, np.ndarray], k: int = 8) -> list[dict]:
    """Shared k-grams of whole-cent values between series: shared sequences mean copied or overlapping data.

    Under independence the chance that a given 8-round sequence recurs is tiny (well below 1e-9 per pair of
    positions for typical values), so a handful of shared grams already indicates overlap.
    """
    grams = {k_: _grams(to_cents(v), k) for k_, v in series.items()}
    out = []
    for a, b in combinations(series, 2):
        shared = len(grams[a] & grams[b])
        out.append({"a": a, "b": b, "k": k, "shared_kgrams": shared, "share_of_a": shared / max(1, len(grams[a])), "share_of_b": shared / max(1, len(grams[b]))})
    return out


def files_identical(paths: list[Path]) -> bool:
    import hashlib

    hs = {hashlib.sha256(p.read_bytes()).hexdigest() for p in paths}
    return len(hs) == 1


def derived_leakage(derived_csv: Path, base: np.ndarray) -> dict:
    """B2 audit: does a feature already contain the label? (Its published 99.7% accuracy says something does.)"""
    d = pd.read_csv(derived_csv)
    label = (d["target"] > 2.0).astype(int)
    agree = float((d["color"] == label).mean())
    aligned = bool(len(d) <= base.size and np.allclose(d["target"].to_numpy()[:1000], base[:1000]))
    return {
        "rows": int(len(d)),
        "columns": list(d.columns),
        "color_equals_label_share": agree,
        "label_rate": float(label.mean()),
        "target_is_base_series_in_file_order": aligned,
        "conclusion": ("`color` equals the label (target > 2) in {:.2%} of rows: the feature is computed from the target itself, "
                       "so the published accuracy is target leakage, not prediction.").format(agree) if agree > 0.95 else "no single-feature leakage found",
    }
