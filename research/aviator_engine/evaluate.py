"""Chronological walk-forward evaluation of next-round range forecasters against honest baselines.

Leakage controls
  * Every forecast for round t uses rounds < t only. Online models update after scoring t; batch models
    (logistic, gradient boosting) are refitted at block starts on rows strictly before the block.
  * Features never cross a run break (rounds may be missing there); masks mark unavailable lags.
  * De-duplication happens in the loaders, before any split. Rounds that open a run are not scored (as the live
    ledger voids a forecast across a break), and every forecaster is scored on exactly the same rounds.
  * `tests/test_evaluate.py` changes every round from t0 on and asserts no forecast before t0 changes.

Acceptance (a candidate is VALIDATED only if all hold)
  * mean log-loss difference to BOTH baselines (cumulative empirical, recent-window empirical) has a block-bootstrap
    95% interval entirely below 0;
  * Holm-adjusted one-sided p < alpha over the candidates;
  * it is ahead of the cumulative baseline in at least `min_folds_ahead` of `folds` chronological folds.
Otherwise the result is "no validated model": report historical frequencies and the baseline only.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

from .ranges import DISPLAY_RANGES, range_index, reference_probabilities, target_hit
from .sequential import consecutive_low_before, run_starts

K = len(DISPLAY_RANGES)
EPS = 1e-9
BASELINES = ("empirical", "recent_empirical", "fixed_reference")
CANDIDATES = ("markov", "streak", "logistic", "gboost")


@dataclass(frozen=True)
class EvalConfig:
    min_train: int = 2000
    refit_every: int = 5000
    max_train_rows: int = 60000
    recent_window: int = 2000
    lags: int = 10
    streak_cap: int = 8
    prior_strength: float = 20.0
    bootstrap: int = 2000
    block: int = 100
    folds: int = 5
    min_folds_ahead: int = 4
    alpha: float = 0.05
    seed: int = 20261030
    use_gboost: bool = True


def features(m: np.ndarray, run_id: np.ndarray, lags: int = 10) -> np.ndarray:
    """Row t: only rounds before t in the same run. Lag log-multipliers + masks, low count, last-20 stats."""
    n = m.size
    logm = np.log(np.asarray(m, dtype=float))
    hit = target_hit(m, 2.0).astype(float)
    cols = []
    for lag in range(1, lags + 1):
        v = np.zeros(n)
        ok = np.zeros(n)
        if lag < n:
            same = run_id[lag:] == run_id[:-lag]
            v[lag:] = np.where(same, logm[:-lag], 0.0)
            ok[lag:] = same
        cols += [np.minimum(v, np.log(100.0)), ok, v * 0 + np.where(ok > 0, np.roll(hit, lag), 0.0)]
    low = np.minimum(consecutive_low_before(m, run_id), 20).astype(float)
    # last-20 within-run share >= 2 and mean log: from lag columns, extended to 20
    s, c, lm = np.zeros(n), np.zeros(n), np.zeros(n)
    for lag in range(1, 21):
        if lag >= n:
            break
        same = np.zeros(n, dtype=bool)
        same[lag:] = run_id[lag:] == run_id[:-lag]
        sh = np.zeros(n)
        sh[lag:] = hit[:-lag]
        sl = np.zeros(n)
        sl[lag:] = np.minimum(logm[:-lag], np.log(100.0))
        s += np.where(same, sh, 0)
        lm += np.where(same, sl, 0)
        c += same
    share20 = np.where(c > 0, s / np.maximum(c, 1), 0.5)
    mean20 = np.where(c > 0, lm / np.maximum(c, 1), 0.0)
    return np.column_stack(cols + [low, share20, mean20, c / 20.0])


def _online(m: np.ndarray, run_id: np.ndarray, cfg: EvalConfig) -> dict[str, np.ndarray]:
    n = m.size
    r = range_index(m, DISPLAY_RANGES)
    onehot = np.eye(K)[r]
    before = np.vstack([np.zeros(K), np.cumsum(onehot, 0)[:-1]])
    emp = (before + 0.5) / (np.arange(n)[:, None] + 0.5 * K)
    w = cfg.recent_window
    lag_w = np.vstack([np.zeros((min(w, n), K)), before[: max(0, n - w)]]) if n > w else np.zeros((n, K))
    win = before - lag_w
    recent = (win + 0.5) / (win.sum(1, keepdims=True) + 0.5 * K)
    starts = run_starts(run_id)
    low = np.minimum(consecutive_low_before(m, run_id), cfg.streak_cap)
    markov = np.empty((n, K))
    streak = np.empty((n, K))
    tc = np.zeros((K, K))
    sc = np.zeros((cfg.streak_cap + 1, K))
    a = cfg.prior_strength
    for t in range(n):
        e = emp[t]
        if starts[t]:
            markov[t] = e
        else:
            row = tc[r[t - 1]]
            markov[t] = (row + a * e) / (row.sum() + a)
        srow = sc[low[t]]
        streak[t] = (srow + a * e) / (srow.sum() + a)
        if not starts[t]:
            tc[r[t - 1], r[t]] += 1
        sc[low[t], r[t]] += 1
    ref = np.tile(reference_probabilities(DISPLAY_RANGES), (n, 1))
    return {"empirical": emp, "recent_empirical": recent, "fixed_reference": ref, "markov": markov, "streak": streak}


def _batch(m: np.ndarray, run_id: np.ndarray, cfg: EvalConfig, start: int) -> dict[str, np.ndarray]:
    n = m.size
    X = features(m, run_id, cfg.lags)
    y = range_index(m, DISPLAY_RANGES)
    out = {"logistic": np.full((n, K), np.nan)}
    if cfg.use_gboost:
        out["gboost"] = np.full((n, K), np.nan)
    for b0 in range(start, n, cfg.refit_every):
        b1 = min(n, b0 + cfg.refit_every)
        lo = max(0, b0 - cfg.max_train_rows)
        Xtr, ytr = X[lo:b0], y[lo:b0]
        present = np.unique(ytr)
        lr = make_pipeline(StandardScaler(), LogisticRegression(C=0.1, max_iter=500))
        lr.fit(Xtr, ytr)
        out["logistic"][b0:b1] = _full_proba(lr.predict_proba(X[b0:b1]), present)
        if cfg.use_gboost:
            gb = HistGradientBoostingClassifier(max_iter=80, learning_rate=0.05, max_leaf_nodes=15, l2_regularization=1.0,
                                                early_stopping=False, random_state=cfg.seed)
            gb.fit(Xtr, ytr)
            out["gboost"][b0:b1] = _full_proba(gb.predict_proba(X[b0:b1]), present)
    return out


def _full_proba(p: np.ndarray, classes: np.ndarray) -> np.ndarray:
    full = np.full((p.shape[0], K), EPS)
    full[:, classes] = p
    return full / full.sum(1, keepdims=True)


def walk_forward(m: np.ndarray, run_id: np.ndarray, cfg: EvalConfig = EvalConfig()) -> tuple[dict[str, np.ndarray], np.ndarray]:
    """Forecast matrices (n x 4) for every forecaster, and the boolean mask of scored rounds."""
    m = np.asarray(m, dtype=float)
    run_id = np.asarray(run_id)
    start = min(cfg.min_train, m.size)
    P = _online(m, run_id, cfg)
    P.update(_batch(m, run_id, cfg, start))
    scored = np.zeros(m.size, dtype=bool)
    scored[start:] = True
    scored &= ~run_starts(run_id)
    return P, scored


def _ll(P: np.ndarray, y: np.ndarray) -> np.ndarray:
    return -np.log(np.clip(P[np.arange(y.size), y], EPS, 1))


def calibration(p: np.ndarray, y: np.ndarray, bins: int = 10) -> dict:
    """Reliability of P(>= 2x): quantile bins, ECE and Spiegelhalter Z (|Z| < 1.96 consistent with calibrated)."""
    edges = np.unique(np.quantile(p, np.linspace(0, 1, bins + 1)))
    idx = np.clip(np.searchsorted(edges, p, side="right") - 1, 0, max(0, edges.size - 2))
    rows, ece = [], 0.0
    for b in range(max(1, edges.size - 1)):
        sel = idx == b
        if sel.any():
            mf, orate = float(p[sel].mean()), float(y[sel].mean())
            rows.append({"n": int(sel.sum()), "mean_forecast": mf, "observed": orate})
            ece += sel.mean() * abs(mf - orate)
    num = ((y - p) * (1 - 2 * p)).sum()
    den = np.sqrt(((1 - 2 * p) ** 2 * p * (1 - p)).sum())
    return {"bins": rows, "ece": float(ece), "spiegelhalter_z": float(num / den) if den > 0 else None}


def _block_bootstrap(d: np.ndarray, cfg: EvalConfig, rng: np.random.Generator) -> tuple[float, float, float]:
    L = cfg.block
    nb = d.size // L
    if nb < 10:
        return float("nan"), float("nan"), float("nan")
    bm = d[: nb * L].reshape(nb, L).mean(1)
    boots = bm[rng.integers(0, nb, size=(cfg.bootstrap, nb))].mean(1)
    mean = float(d.mean())
    lo, hi = np.quantile(boots, [0.025, 0.975])
    p = float((1 + np.sum(boots - boots.mean() <= mean)) / (cfg.bootstrap + 1))  # one-sided: H1 mean < 0
    return float(lo), float(hi), p


def holm(ps: dict[str, float]) -> dict[str, float]:
    keys = sorted(ps, key=lambda k: ps[k])
    m, out, run = len(keys), {}, 0.0
    for i, k in enumerate(keys):
        run = max(run, min(1.0, (m - i) * ps[k]))
        out[k] = run
    return out


def score(P: dict[str, np.ndarray], m: np.ndarray, scored: np.ndarray, cfg: EvalConfig = EvalConfig()) -> dict:
    rng = np.random.default_rng(cfg.seed)
    y = range_index(m, DISPLAY_RANGES)[scored]
    y2 = (y >= 1).astype(float)
    onehot = np.eye(K)[y]
    ll = {k: _ll(v[scored], y) for k, v in P.items()}
    res: dict = {"scored": int(scored.sum()), "models": {}}
    for k, v in P.items():
        Q = v[scored]
        p2 = Q[:, 1:].sum(1)
        res["models"][k] = {
            "role": "baseline" if k in BASELINES else "candidate",
            "log_loss": float(ll[k].mean()),
            "brier": float(((Q - onehot) ** 2).sum(1).mean()),
            "top_range_hit": float((Q.argmax(1) == y).mean()),
            "ge2_log_loss": float(-(y2 * np.log(np.clip(p2, EPS, 1)) + (1 - y2) * np.log(np.clip(1 - p2, EPS, 1))).mean()),
            "ge2_brier": float(((p2 - y2) ** 2).mean()),
            "calibration_ge2": calibration(p2, y2),
        }
    raw_p: dict[str, float] = {}
    for k in P:
        if k == "empirical":
            continue
        row = res["models"][k]
        for base in ("empirical", "recent_empirical"):
            if k == base:
                continue
            d = ll[k] - ll[base]
            lo, hi, p = _block_bootstrap(d, cfg, rng)
            row[f"vs_{base}"] = {"mean_diff": float(d.mean()), "ci_low": lo, "ci_high": hi, "p_one_sided": p}
        folds = np.array_split(ll[k] - ll["empirical"], cfg.folds)
        row["folds_ahead"] = int(sum(f.mean() < 0 for f in folds))
        if k in CANDIDATES:
            raw_p[k] = max(row["vs_empirical"]["p_one_sided"], row["vs_recent_empirical"]["p_one_sided"])
    adj = holm(raw_p) if raw_p else {}
    validated = []
    for k, p in adj.items():
        row = res["models"][k]
        row["holm_p"] = p
        ok = (row["vs_empirical"]["ci_high"] < 0 and row["vs_recent_empirical"]["ci_high"] < 0 and p < cfg.alpha
              and row["folds_ahead"] >= cfg.min_folds_ahead)
        row["validated"] = bool(ok)
        if ok:
            validated.append(k)
    res["validated"] = validated
    res["verdict"] = ("VALIDATED: " + ", ".join(validated)) if validated else "NO VALIDATED MODEL: report historical frequencies and the baseline only"
    return res


def evaluate(m: np.ndarray, run_id: np.ndarray, cfg: EvalConfig = EvalConfig()) -> dict:
    P, scored = walk_forward(m, run_id, cfg)
    out = score(P, np.asarray(m, dtype=float), scored, cfg)
    out["config"] = cfg.__dict__.copy()
    out["rounds"] = int(np.asarray(m).size)
    return out
