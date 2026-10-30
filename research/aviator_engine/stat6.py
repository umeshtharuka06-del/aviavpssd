"""stat-6 research: exact-multiplier estimation and extended range-probability candidates (OFFLINE ONLY).

Pre-registered acceptance rules (fixed before any result was seen; see docs/STAT6_RESEARCH_REPORT.md):

EXACT ESTIMATE (task "exact")
  loss            absolute log error |ln m - ln m_hat| (scale-free; its optimum is the conditional MEDIAN).
  baselines       expanding median of all past rounds; rolling median of the last 1,500.
  accepted if     paired mean loss difference vs BOTH baselines has a block-bootstrap 95% CI entirely < 0,
                  Holm-adjusted one-sided p < 0.05 over all exact candidates, ahead in >= 4 of 5 chronological
                  folds, its 80% interval covers 80% +/- 3 pp, and the series passes the plausibility gate.
RANGE PROBABILITIES (task "range")
  loss            multiclass log loss over the four panel ranges.
  baselines       cumulative empirical (add-1/2); recent 2,000-round empirical.
  accepted if     the same four conditions as evaluate.py, with Holm over all range candidates here.

Every forecast for round t uses rounds < t only (pandas windows are shifted by one; grouped estimators use only
earlier rounds of the same group). Runs (collection breaks) reset sequence features.
"""

from __future__ import annotations

import json
import sys
import time
from dataclasses import dataclass, replace
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingClassifier, HistGradientBoostingRegressor, RandomForestClassifier, RandomForestRegressor
from sklearn.linear_model import LogisticRegression, QuantileRegressor
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

from . import simulate
from .analysis import plausibility
from .evaluate import EvalConfig, _block_bootstrap, _full_proba, _ll, _online, calibration, features, holm
from .ranges import DISPLAY_RANGES, RTP, range_index
from .sequential import consecutive_low_before, run_starts

K = len(DISPLAY_RANGES)
WINDOWS = (20, 50, 100, 200, 500, 1500)
Q_LO, Q_HI = 0.10, 0.90  # 80% prediction interval


@dataclass(frozen=True)
class Stat6Config:
    min_train: int = 2000
    refit_every: int = 5000
    max_train_rows: int = 40000
    bootstrap: int = 1000
    block: int = 100
    folds: int = 5
    min_folds_ahead: int = 4
    alpha: float = 0.05
    coverage_tolerance: float = 0.03
    seed: int = 20261030
    heavy: bool = True  # tree models and linear quantile regression


# ----------------------------------------------------------------------------------------------- exact estimates


def _past_quantile(x: pd.Series, q: float, window: int | None) -> np.ndarray:
    s = x.shift(1)
    r = s.expanding(min_periods=1) if window is None else s.rolling(window, min_periods=1)
    return r.quantile(q, interpolation="lower").to_numpy()


def _group_past_quantile(x: pd.Series, groups: np.ndarray, q: float, fallback: np.ndarray, min_n: int = 30) -> np.ndarray:
    """Quantile of earlier rounds with the same group label as round t (group known before t)."""
    out = fallback.copy()
    df = pd.DataFrame({"x": x.to_numpy(), "g": groups})
    for g, idx in df.groupby("g").groups.items():
        idx = np.asarray(idx)
        v = pd.Series(df["x"].to_numpy()[idx]).shift(1)
        qv = v.expanding(min_periods=min_n).quantile(q, interpolation="lower").to_numpy()
        ok = ~np.isnan(qv)
        out[idx[ok]] = qv[ok]
    return out


def exact_candidates(m: np.ndarray, run_id: np.ndarray, cfg: Stat6Config) -> dict[str, dict[str, np.ndarray]]:
    """name -> {"point": median estimate, "lo": 10th pct, "hi": 90th pct} in multiplier units (NaN = no estimate)."""
    lx = pd.Series(np.log(m))
    exp = lambda a: np.exp(a)  # noqa: E731
    out: dict[str, dict[str, np.ndarray]] = {}
    all_p = {q: exp(_past_quantile(lx, q, None)) for q in (Q_LO, 0.5, Q_HI)}
    out["median_all"] = {"point": all_p[0.5], "lo": all_p[Q_LO], "hi": all_p[Q_HI]}
    for w in WINDOWS:
        qs = {q: exp(_past_quantile(lx, q, w)) for q in (Q_LO, 0.5, Q_HI)}
        out[f"median_last_{w}"] = {"point": qs[0.5], "lo": qs[Q_LO], "hi": qs[Q_HI]}
    ref_med = RTP / 0.5  # P(M >= m) = 0.97/m = 0.5
    n = m.size
    out["fixed_reference_1.94"] = {"point": np.full(n, ref_med), "lo": np.full(n, max(1.0, RTP / 0.9)), "hi": np.full(n, RTP / 0.1)}
    past_mean = pd.Series(m).shift(1).expanding().mean().to_numpy()
    out["mean_all (expectation)"] = {"point": past_mean, "lo": all_p[Q_LO], "hi": all_p[Q_HI]}
    out["geometric_mean_all"] = {"point": exp(lx.shift(1).expanding().mean().to_numpy()), "lo": all_p[Q_LO], "hi": all_p[Q_HI]}
    # conditional medians: previous range (within run), low-streak bucket
    starts = run_starts(run_id)
    r = range_index(m, DISPLAY_RANGES)
    prev = np.where(starts, -1, np.concatenate([[-1], r[:-1]]))
    low = consecutive_low_before(m, run_id)
    bucket = np.select([low == 0, low == 1, low == 2, low <= 4, low <= 7], [0, 1, 2, 3, 4], 5)
    bucket = np.where(starts, -1, bucket)
    for name, g in (("cond_median_prev_range", prev), ("cond_median_low_streak", bucket)):
        qs = {q: exp(_group_past_quantile(lx, g, q, np.log(all_p[q]))) for q in (Q_LO, 0.5, Q_HI)}
        out[name] = {"point": qs[0.5], "lo": qs[Q_LO], "hi": qs[Q_HI]}
    if cfg.heavy:
        out.update(_batch_exact(m, run_id, cfg))
    return out


def _batch_exact(m: np.ndarray, run_id: np.ndarray, cfg: Stat6Config) -> dict[str, dict[str, np.ndarray]]:
    n = m.size
    X = features(m, run_id)
    y = np.log(m)
    names = ("gbm_quantile", "gbm_l2_log", "random_forest_log", "linear_quantile")
    out = {k: {"point": np.full(n, np.nan), "lo": np.full(n, np.nan), "hi": np.full(n, np.nan)} for k in names}
    rng = np.random.default_rng(cfg.seed)
    for b0 in range(cfg.min_train, n, cfg.refit_every):
        b1 = min(n, b0 + cfg.refit_every)
        lo = max(0, b0 - cfg.max_train_rows)
        Xtr, ytr, Xte = X[lo:b0], y[lo:b0], X[b0:b1]
        for q, key in ((0.5, "point"), (Q_LO, "lo"), (Q_HI, "hi")):
            g = HistGradientBoostingRegressor(loss="quantile", quantile=q, max_iter=100, learning_rate=0.05, max_leaf_nodes=15,
                                              min_samples_leaf=100, early_stopping=False, random_state=cfg.seed)
            out["gbm_quantile"][key][b0:b1] = np.exp(g.fit(Xtr, ytr).predict(Xte))
        g2 = HistGradientBoostingRegressor(max_iter=100, learning_rate=0.05, max_leaf_nodes=15, min_samples_leaf=100,
                                           early_stopping=False, random_state=cfg.seed).fit(Xtr, ytr)
        resid = ytr - g2.predict(Xtr)
        out["gbm_l2_log"]["point"][b0:b1] = np.exp(g2.predict(Xte))
        out["gbm_l2_log"]["lo"][b0:b1] = np.exp(g2.predict(Xte) + np.quantile(resid, Q_LO))
        out["gbm_l2_log"]["hi"][b0:b1] = np.exp(g2.predict(Xte) + np.quantile(resid, Q_HI))
        rf = RandomForestRegressor(n_estimators=60, max_depth=8, min_samples_leaf=100, n_jobs=1, random_state=cfg.seed).fit(Xtr, ytr)
        p = rf.predict(Xte)
        rr = ytr - rf.predict(Xtr)
        out["random_forest_log"]["point"][b0:b1] = np.exp(p)
        out["random_forest_log"]["lo"][b0:b1] = np.exp(p + np.quantile(rr, Q_LO))
        out["random_forest_log"]["hi"][b0:b1] = np.exp(p + np.quantile(rr, Q_HI))
        sub = rng.choice(Xtr.shape[0], size=min(8000, Xtr.shape[0]), replace=False)
        for q, key in ((0.5, "point"), (Q_LO, "lo"), (Q_HI, "hi")):
            qr = make_pipeline(StandardScaler(), QuantileRegressor(quantile=q, alpha=1e-4, solver="highs"))
            out["linear_quantile"][key][b0:b1] = np.exp(qr.fit(Xtr[sub], ytr[sub]).predict(Xte))
    return out


EXACT_BASELINES = ("median_all", "median_last_1500")


def score_exact(est: dict[str, dict[str, np.ndarray]], m: np.ndarray, scored: np.ndarray, cfg: Stat6Config, gate: bool) -> dict:
    rng = np.random.default_rng(cfg.seed + 1)
    y = m[scored]
    ly = np.log(y)
    loss = {}
    res: dict = {"scored": int(scored.sum()), "models": {}}
    for k, e in est.items():
        p = e["point"][scored]
        if np.isnan(p).any():
            continue
        lo, hi = e["lo"][scored], e["hi"][scored]
        ale = np.abs(ly - np.log(p))
        loss[k] = ale
        cover = (y >= lo) & (y <= hi)
        width = np.log(hi) - np.log(lo)
        # interval score (Gneiting & Raftery) for a central 80% interval, log scale
        a = Q_LO * 2
        iscore = width + (2 / a) * np.maximum(0, np.log(lo) - ly) + (2 / a) * np.maximum(0, ly - np.log(hi))
        pin = lambda q, pred: np.mean(np.maximum(q * (ly - np.log(pred)), (q - 1) * (ly - np.log(pred))))  # noqa: E731
        res["models"][k] = {
            "role": "baseline" if k in EXACT_BASELINES else "candidate",
            "median_estimate": float(np.median(p)), "estimate_p5_p95": [float(np.quantile(p, 0.05)), float(np.quantile(p, 0.95))],
            "mae": float(np.mean(np.abs(y - p))), "median_ae": float(np.median(np.abs(y - p))),
            "log_mae": float(ale.mean()), "within_10pct": float(np.mean(np.abs(y / p - 1) <= 0.10)),
            "pinball_q10": float(pin(Q_LO, lo)), "pinball_q50": float(pin(0.5, p)), "pinball_q90": float(pin(Q_HI, hi)),
            "coverage_80": float(cover.mean()), "mean_log_width": float(width.mean()), "interval_score": float(iscore.mean()),
            "median_interval": [float(np.median(lo)), float(np.median(hi))],
        }
    return _compare(res, loss, EXACT_BASELINES, cfg, rng, gate, coverage=True)


def _compare(res: dict, loss: dict[str, np.ndarray], baselines: tuple[str, str], cfg: Stat6Config, rng, gate: bool, coverage: bool) -> dict:
    raw = {}
    for k, row in res["models"].items():
        if k not in loss:
            continue
        for b in baselines:
            if k == b or b not in loss:
                continue
            d = loss[k] - loss[b]
            lo, hi, p = _block_bootstrap(d, EvalConfig(bootstrap=cfg.bootstrap, block=cfg.block), rng)
            row[f"vs_{b}"] = {"mean_diff": float(d.mean()), "ci_low": lo, "ci_high": hi, "p_one_sided": p}
        row["folds_ahead"] = int(sum(f.mean() < 0 for f in np.array_split(loss[k] - loss[baselines[0]], cfg.folds)))
        if row["role"] == "candidate":
            raw[k] = max(row[f"vs_{b}"]["p_one_sided"] for b in baselines)
    adj = holm(raw)
    validated = []
    for k, p in adj.items():
        row = res["models"][k]
        row["holm_p"] = p
        ok = all(row[f"vs_{b}"]["ci_high"] < 0 for b in baselines) and p < cfg.alpha and row["folds_ahead"] >= cfg.min_folds_ahead
        if coverage:
            ok = ok and abs(row["coverage_80"] - 0.80) <= cfg.coverage_tolerance
        row["passes_statistics"] = bool(ok)
        if ok:
            validated.append(k)
    res["passes_statistics"] = validated
    res["validated"] = validated if gate else []
    res["status"] = ("validated: " + ", ".join(validated)) if res["validated"] else (
        "rejected by the plausibility gate (passed statistics: " + ", ".join(validated) + ")" if validated else "no validated model: keep the baseline")
    return res


# ----------------------------------------------------------------------------------------------- range probabilities


def range_candidates(m: np.ndarray, run_id: np.ndarray, cfg: Stat6Config) -> dict[str, np.ndarray]:
    ecfg = EvalConfig(min_train=cfg.min_train, refit_every=cfg.refit_every, max_train_rows=cfg.max_train_rows)
    P = _online(m, run_id, ecfg)  # empirical, recent_empirical, fixed_reference, markov, streak
    n = m.size
    r = range_index(m, DISPLAY_RANGES)
    onehot = np.eye(K)[r]
    before = np.vstack([np.zeros(K), np.cumsum(onehot, 0)[:-1]])
    for w in WINDOWS:
        lag = np.vstack([np.zeros((min(w, n), K)), before[: max(0, n - w)]]) if n > w else np.zeros((n, K))
        win = before - lag
        P[f"window_{w}"] = (win + 0.5) / (win.sum(1, keepdims=True) + 0.5 * K)
        # partial pooling: the window's counts plus `w` pseudo-rounds of the long-run distribution
        P[f"bayes_window_{w}"] = (win + w * P["empirical"]) / (win.sum(1, keepdims=True) + w)
    if cfg.heavy:
        X = features(m, run_id)
        for k in ("logistic", "gboost", "random_forest"):
            P[k] = np.full((n, K), np.nan)
        for b0 in range(cfg.min_train, n, cfg.refit_every):
            b1 = min(n, b0 + cfg.refit_every)
            lo = max(0, b0 - cfg.max_train_rows)
            Xtr, ytr = X[lo:b0], r[lo:b0]
            cls = np.unique(ytr)
            models = {
                "logistic": make_pipeline(StandardScaler(), LogisticRegression(C=0.1, max_iter=500)),
                "gboost": HistGradientBoostingClassifier(max_iter=80, learning_rate=0.05, max_leaf_nodes=15, l2_regularization=1.0,
                                                         early_stopping=False, random_state=cfg.seed),
                "random_forest": RandomForestClassifier(n_estimators=60, max_depth=8, min_samples_leaf=100, n_jobs=1, random_state=cfg.seed),
            }
            for k, mdl in models.items():
                P[k][b0:b1] = _full_proba(mdl.fit(Xtr, ytr).predict_proba(X[b0:b1]), cls)
    # online Bayesian model average of every model so far (weights from past log-likelihood only, prior 1/2 on empirical)
    names = [k for k in P if k not in ("fixed_reference",)]
    ll_cum = np.zeros(len(names))
    prior = np.array([np.log(0.5) if k == "empirical" else np.log(0.5 / (len(names) - 1)) for k in names])
    ens = np.empty((n, K))
    for t in range(n):
        vs = np.array([P[k][t] for k in names])
        ok = ~np.isnan(vs).any(1)
        lw = np.where(ok, prior + ll_cum, -np.inf)
        w = np.exp(lw - lw.max())
        w /= w.sum()
        ens[t] = (w[ok, None] * vs[ok]).sum(0)
        ll_cum += np.where(ok, np.log(np.clip(np.where(ok[:, None], vs, 1.0)[:, r[t]], 1e-9, 1)), 0.0)
    P["model_average"] = ens
    return P


RANGE_BASELINES = ("empirical", "recent_empirical")


def score_range(P: dict[str, np.ndarray], m: np.ndarray, scored: np.ndarray, cfg: Stat6Config, gate: bool) -> dict:
    rng = np.random.default_rng(cfg.seed + 2)
    y = range_index(m, DISPLAY_RANGES)[scored]
    onehot = np.eye(K)[y]
    y2 = (y >= 1).astype(float)
    loss, res = {}, {"scored": int(scored.sum()), "models": {}}
    for k, v in P.items():
        Q = v[scored]
        if np.isnan(Q).any():
            continue
        loss[k] = _ll(Q, y)
        p2 = Q[:, 1:].sum(1)
        res["models"][k] = {
            "role": "baseline" if k in RANGE_BASELINES or k == "fixed_reference" else "candidate",
            "log_loss": float(loss[k].mean()), "brier": float(((Q - onehot) ** 2).sum(1).mean()),
            "top_range_hit": float((Q.argmax(1) == y).mean()), "share_top_is_1_00_1_99": float((Q.argmax(1) == 0).mean()),
            "sum_check_max_abs": float(np.abs(Q.sum(1) - 1).max()),
            "calibration_ge2": calibration(p2, y2),
        }
    res = _compare(res, loss, RANGE_BASELINES, cfg, rng, gate, coverage=False)
    return res


# ----------------------------------------------------------------------------------------------- one series


def run_series(m: np.ndarray, run_id: np.ndarray, cfg: Stat6Config) -> dict:
    t0 = time.time()
    m = np.asarray(m, dtype=float)
    run_id = np.asarray(run_id)
    scored = np.zeros(m.size, dtype=bool)
    scored[min(cfg.min_train, m.size):] = True
    scored &= ~run_starts(run_id)
    gate = plausibility(m)
    est = exact_candidates(m, run_id, cfg)
    P = range_candidates(m, run_id, cfg)
    out = {"rounds": int(m.size), "plausibility": gate,
           "exact": score_exact(est, m, scored, cfg, gate["passes"]),
           "range": score_range(P, m, scored, cfg, gate["passes"])}
    # per-round loss differences for the power analysis (Markov vs empirical; conditional vs overall median)
    y = range_index(m, DISPLAY_RANGES)[scored]
    d_range = _ll(P["markov"][scored], y) - _ll(P["empirical"][scored], y)
    ly = np.log(m[scored])
    d_exact = np.abs(ly - np.log(est["cond_median_prev_range"]["point"][scored])) - np.abs(ly - np.log(est["median_all"]["point"][scored]))
    out["loss_diff_sd"] = {"range_markov_vs_empirical": float(d_range.std(ddof=1)), "exact_cond_vs_median": float(d_exact.std(ddof=1))}
    out["seconds"] = round(time.time() - t0, 1)
    return out


# ----------------------------------------------------------------------------------------------- controls and power


def planted_regime(n: int, seed: int, block: int = 3000, low: float = 0.90, high: float = 1.00) -> np.ndarray:
    """SIMULATED regime switching: the RTP alternates between `low` and `high` every `block` rounds."""
    rng = np.random.default_rng(seed)
    rtp = np.where((np.arange(n) // block) % 2 == 0, low, high)
    u = rng.random(n)
    return np.maximum(1.0, np.floor(rtp / np.maximum(u, 1e-12) * 100) / 100)


def power_curve(effects=(0.01, 0.02, 0.05), ns=(1500, 5000, 20000, 60000), reps: int = 40, seed: int = 7) -> list[dict]:
    """SIMULATED: detection rate of a planted previous-round effect by the cheap online test (Markov vs empirical,
    block-bootstrap CI < 0) at different history lengths. Answers "how much data is needed"."""
    rows = []
    ecfg = EvalConfig(min_train=200, bootstrap=400)
    for eff in effects:
        for n in ns:
            hits = 0
            for i in range(reps):
                m = simulate.planted(n, seed + 1000 * i + n, eff)
                run = np.zeros(n, dtype=int)
                P = _online(m, run, replace(ecfg, min_train=min(200, n // 5)))
                sc = np.arange(n) >= min(200, n // 5)
                y = range_index(m, DISPLAY_RANGES)[sc]
                d = _ll(P["markov"][sc], y) - _ll(P["empirical"][sc], y)
                _, hi, _ = _block_bootstrap(d, ecfg, np.random.default_rng(i))
                hits += bool(hi < 0)
            rows.append({"effect_pp": 100 * eff, "rounds": n, "detected": hits, "of": reps})
            print(f"power effect {eff} n {n}: {hits}/{reps}", file=sys.stderr)
    return rows


def required_rounds(sd: float, delta: float) -> int:
    """Rounds needed to detect a mean per-round loss improvement `delta` (alpha 0.05 one-sided, power 0.8)."""
    return int(np.ceil(((1.645 + 0.842) * sd / delta) ** 2))


# ----------------------------------------------------------------------------------------------- CLI


def main(argv: list[str] | None = None) -> int:
    import argparse

    from .cli import OUT, RAW, load_all

    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=60000, help="rounds per series (chronological prefix)")
    ap.add_argument("--quick", action="store_true")
    ap.add_argument("--part", help="compute only this part (e.g. series:P1:BETIKA, control:fair:0, power); omit to assemble")
    ap.add_argument("--list", action="store_true", help="print every part name")
    args = ap.parse_args(argv)
    cfg = Stat6Config(heavy=not args.quick, bootstrap=400 if args.quick else 1000)
    limit = 15000 if args.quick else args.limit
    n_ctrl = 15000 if args.quick else 30000
    reps_ctrl = 2 if args.quick else 3
    parts_dir = OUT / ("stat6_parts_quick" if args.quick else "stat6_parts")
    parts_dir.mkdir(parents=True, exist_ok=True)
    gens = {"fair": lambda s: simulate.fair(n_ctrl, s), "planted_prev_round_5pp": lambda s: simulate.planted(n_ctrl, s, 0.05),
            "planted_regime_rtp_0.90_1.00": lambda s: planted_regime(n_ctrl, s)}
    # C1 failed plausibility in every earlier run and is excluded from model research
    series_ids = ["B1", "P1:BETGR8", "P1:BETIKA", "P1:ODIBETS", "P1:WINPESA", "S1"]
    names = [f"series:{s}" for s in series_ids] + [f"control:{g}:{i}" for g in gens for i in range(reps_ctrl)] + ["power"]
    if args.list:
        print("\n".join(names))
        return 0
    path = lambda name: parts_dir / (name.replace(":", "__") + ".json")  # noqa: E731

    if args.part:
        args.part = args.part.strip()  # names piped from `--list` on Windows carry a trailing "\r"
        # One part per process: a crash or kill loses only that part; finished parts are skipped on rerun.
        if path(args.part).exists():
            print(f"skip {args.part} (done)", file=sys.stderr)
            return 0
        kind, _, rest = args.part.partition(":")
        t0 = time.time()
        if kind == "series":
            role, lr = load_all(RAW, synthetic_limit=limit)[rest]
            f = lr.frame.iloc[:limit]
            print(f"stat6 {rest} ({role}, {len(f)} rounds)", file=sys.stderr)
            res = {"role": role} | run_series(f["multiplier"].to_numpy(), f["run_id"].to_numpy(), cfg)
        elif kind == "control":
            g, _, i = rest.rpartition(":")
            print(f"stat6 control {g} {i}", file=sys.stderr)
            r = run_series(gens[g](500 + int(i)), np.zeros(n_ctrl, dtype=int), cfg)
            res = {"label": "SIMULATED", "rounds": n_ctrl, "exact_passes": r["exact"]["passes_statistics"],
                   "range_passes": r["range"]["passes_statistics"], "gate": r["plausibility"]["passes"],
                   "exact_models": r["exact"]["models"], "range_models": r["range"]["models"]}
        elif kind == "power":
            res = {"rows": power_curve(reps=10 if args.quick else 40)}
        else:
            raise SystemExit(f"unknown part {args.part}")
        res["part_seconds"] = round(time.time() - t0, 1)
        tmp = path(args.part).with_suffix(".tmp")
        tmp.write_text(json.dumps(res, indent=1, default=float), encoding="utf-8")
        tmp.replace(path(args.part))  # atomic: a half-written part never counts as done
        print(f"done {args.part} in {res['part_seconds']} s", file=sys.stderr)
        return 0

    missing = [p for p in names if not path(p).exists()]
    if missing:
        raise SystemExit("missing parts: " + ", ".join(missing))
    load = lambda name: json.loads(path(name).read_text(encoding="utf-8"))  # noqa: E731
    report: dict = {"config": cfg.__dict__, "limit": limit, "series": {s: load(f"series:{s}") for s in series_ids}, "controls": {}}
    for g in gens:
        report["controls"][g] = {"label": "SIMULATED", "rounds": n_ctrl, "reps": [load(f"control:{g}:{i}") for i in range(reps_ctrl)]}
    report["power"] = load("power")["rows"]
    sds = [s["loss_diff_sd"] for s in report["series"].values() if s["role"] == "real_candidate" and s["plausibility"]["passes"]]
    sd_r = float(np.median([s["range_markov_vs_empirical"] for s in sds])) if sds else 0.05
    sd_e = float(np.median([s["exact_cond_vs_median"] for s in sds])) if sds else 0.2
    report["data_sufficiency"] = {
        "sd_range_diff": sd_r, "sd_exact_diff": sd_e,
        "rounds_needed_range": {str(d): required_rounds(sd_r, d) for d in (0.0005, 0.001, 0.002, 0.005)},
        "rounds_needed_exact": {str(d): required_rounds(sd_e, d) for d in (0.002, 0.005, 0.01, 0.02)},
    }
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "stat6.json").write_text(json.dumps(report, indent=1, default=float), encoding="utf-8")
    print(f"wrote {OUT / 'stat6.json'}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
