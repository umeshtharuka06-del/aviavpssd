"""Per-series analysis: distribution, sequential tests, and the WATCH rule evaluated walk-forward."""

from __future__ import annotations

import numpy as np
from scipy import stats

from . import sequential as sq
from .ranges import ANALYSIS_RANGES, DISPLAY_RANGES, Range, frequencies, range_index, target_hit, wilson
from .strategy import DEFAULT_CONFIG, StrategyConfig, replay


def distribution(m: np.ndarray, extra: tuple[Range, ...] | None = None) -> dict:
    out = {"n": int(m.size), "analysis_ranges": frequencies(m, ANALYSIS_RANGES), "display_ranges": frequencies(m, DISPLAY_RANGES),
           "median": float(np.median(m)), "mean": float(m.mean()), "p_ge": {}}
    for t in (1.5, 2, 3, 5, 10, 100):
        h = int(target_hit(m, t).sum())
        p, lo, hi = wilson(h, m.size)
        out["p_ge"][f"{t:g}x"] = {"share": p, "ci_low": lo, "ci_high": hi, "reference_0.97/m": min(1.0, 0.97 / t)}
    if extra:
        out["custom_ranges"] = frequencies(m, extra)
    return out


def plausibility(m: np.ndarray) -> dict:
    """Can these be rounds of a house-edge crash game? Under P(M >= x) = r / x, r = 2 P(M >= 2) = 10 P(M >= 10) < 1.

    Fails when an implied RTP is above 1 with its whole 95% interval (impossible for a game with a house edge), or
    when the shape inside [1, 2) is far from the 1/x law (P(<1.5 | <2) off by more than 0.05; 0.5 = uniform generator).
    Models on data that fail are reported but never promoted.
    """
    out, reasons = {}, []
    for x in (2, 10):
        h = int(target_hit(m, x).sum())
        p, lo, hi = wilson(h, m.size)
        out[f"implied_rtp_from_ge{x}x"] = {"value": x * p, "ci": [x * lo, x * hi]}
        if x * lo > 1.0:
            reasons.append(f"P(>= {x}x) = {p:.1%}: a cash-out at {x}x would return {x * p:.2f} per unit staked (95% CI from {x * lo:.2f}), "
                           "impossible for a house-edge game; more likely low rounds are missing from the file or it is not real play")
    from .quality import synthetic_fingerprint

    fp = synthetic_fingerprint(m)
    if fp.get("n_below_2") and not fp["consistent_with_1_over_m_law"]:
        reasons.append(f"P(<1.5x | <2x) = {fp['share_below_1_5_given_below_2']:.3f} vs {fp['expected_1_over_m']:.3f} for a 1/x crash law (0.5 = uniform generator)")
    out["passes"] = not reasons
    out["reasons"] = reasons
    return out


def sequential_tests(m: np.ndarray, run_id: np.ndarray) -> dict:
    hit = target_hit(m, 2.0)
    p = float(hit.mean())
    streaks = sq.low_streaks(m, run_id, 2.0)
    res = {
        "streak_distribution": sq.streak_distribution(streaks, p),
        "conditional_on_lows": sq.conditional_on_lows(m, run_id, 2.0),
        "acf_ge2": sq.acf_within_runs(hit.astype(float), run_id),
        "acf_log_multiplier": sq.acf_within_runs(np.log(np.minimum(m, 1000.0)), run_id),
        "runs_test": sq.runs_test(m, run_id),
        "transitions": sq.transition_test(m, run_id),
        "rolling_200": sq.rolling_frequencies(m, 200),
        "block_homogeneity": sq.block_homogeneity(m),
        "change_points": sq.change_points(m),
    }
    dep = {"conditional_on_lows": res["conditional_on_lows"]["p"],
           "acf_ge2": res["acf_ge2"]["p"], "acf_log_multiplier": res["acf_log_multiplier"]["p"],
           "runs_test": res["runs_test"]["p"], "transitions": res["transitions"]["p"]}
    dep = {k: (1.0 if v is None else v) for k, v in dep.items()}
    adj = sq.benjamini_hochberg(dep)
    res["dependence_summary"] = {"p": dep, "p_bh": adj, "any_significant_bh": any(v < 0.05 for v in adj.values()),
                                 "note": "BH over five dependence tests; the streak-length table is descriptive (length-biased with run breaks) and distribution change over time is reported separately"}
    return res


def strategy_evaluation(m: np.ndarray, run_id: np.ndarray, config: StrategyConfig = DEFAULT_CONFIG) -> dict:
    """The WATCH rule replayed walk-forward with the cumulative empirical distribution as its baseline.

    Answers: is P(>= 2x) during ELEVATED-RANGE WATCH different from P(>= 2x) while tracking? (It must not be
    if rounds are independent; a low streak does not make a high round due.)
    """
    starts = sq.run_starts(run_id)
    r = range_index(m, DISPLAY_RANGES)
    recs = []
    cnt = np.zeros(4)
    # replay forecasts in chunks of the baseline: cumulative add-1/2 empirical up to the round (no look-ahead)
    from .strategy import RangeStrategyTracker

    t = RangeStrategyTracker(config)
    for i, (mi, b) in enumerate(zip(m, starts)):
        base = ((cnt + 0.5) / (i + 2.0)).tolist()
        f = t.forecast(base)
        if not (b and i > 0):
            recs.append((f["state"] == "elevated_range_watch", target_hit(np.array([mi]), config.target_threshold)[0],
                         r[i] == f["predictedRange"], f["targetProbability"]))
        t.observe(float(mi), bool(b and i > 0))
        cnt[r[i]] += 1
    a = np.array(recs, dtype=float)
    watch, thit, rhit, pt = a[:, 0] > 0, a[:, 1], a[:, 2], a[:, 3]
    out = {"config": config.__dict__, "scored": int(a.shape[0])}
    for name, sel in (("watch", watch), ("tracking", ~watch)):
        n = int(sel.sum())
        p, lo, hi = wilson(int(thit[sel].sum()), n)
        rp, rlo, rhi = wilson(int(rhit[sel].sum()), n)
        out[name] = {"forecasts": n, "target_hit_rate": p, "target_ci": [lo, hi], "range_hit_rate": rp, "range_ci": [rlo, rhi],
                     "mean_estimated_target_probability": float(pt[sel].mean()) if n else None}
    n1, n2 = out["watch"]["forecasts"], out["tracking"]["forecasts"]
    if n1 and n2:
        tab = [[thit[watch].sum(), n1 - thit[watch].sum()], [thit[~watch].sum(), n2 - thit[~watch].sum()]]
        out["watch_vs_tracking_target"] = {"fisher_p": float(stats.fisher_exact(tab)[1]),
                                           "difference": out["watch"]["target_hit_rate"] - out["tracking"]["target_hit_rate"]}
    out["share_of_forecasts_in_watch"] = n1 / max(1, n1 + n2)
    return out


def sanity_replay(m: np.ndarray, run_id: np.ndarray) -> list[dict]:
    """Thin wrapper kept for symmetry with the TS engine's replay (used in tests)."""
    starts = sq.run_starts(run_id)
    starts[0] = False
    return replay(m, starts, [0.515, 0.291, 0.097, 0.097])
