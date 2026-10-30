"""Command line.

  python -m aviator_engine.cli fetch                 download the registered public files (SHA-256 checked)
  python -m aviator_engine.cli all [--quick]         audit -> analysis -> walk-forward evaluation -> report
  python -m aviator_engine.cli analyze-csv FILE      the same analysis on your own export (multiplier[,received_at][,break_before])
  python -m aviator_engine.cli analyze-export FILE... [--site S] [--merge] [--quick]
                                                     our own live rounds (backend `export-rounds`, schema 1): quality,
                                                     analysis and the stat-6 pre-registered rules, per stream (default)
                                                     or per site with streams merged by value alignment (--merge)

Outputs go to research/out/ (report.json, report.md). Nothing touches a database or the network except `fetch`.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import time
import urllib.request
from dataclasses import replace
from pathlib import Path

import numpy as np

from . import analysis, quality, simulate
from .evaluate import EvalConfig, evaluate
from .loaders import load_multipliers, load_payouts, load_rounds_csv, load_synthetic, load_timestamped
from .report import render_markdown
from .sources import BY_ID, NO_DATA_REPOS, SOURCES

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "raw"
OUT = ROOT / "out"


def sha256(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def fetch(raw: Path = RAW) -> list[dict]:
    raw.mkdir(parents=True, exist_ok=True)
    log = []
    for s in SOURCES:
        dest = raw / s.local_name
        if not dest.exists():
            print(f"downloading {s.url}", file=sys.stderr)
            urllib.request.urlretrieve(s.url, dest)  # noqa: S310 (fixed https URLs from the registry)
        h = sha256(dest)
        log.append({"file_id": s.file_id, "path": str(dest.name), "sha256": h, "expected": s.sha256, "matches": h == s.sha256})
    return log


def load_all(raw: Path = RAW, synthetic_limit: int | None = None) -> dict[str, tuple[str, object]]:
    """series_id -> (role, LoadResult)."""
    out: dict[str, tuple[str, object]] = {}
    for s in SOURCES:
        p = raw / s.local_name
        if not p.exists():
            raise FileNotFoundError(f"{p} missing: run `python -m aviator_engine.cli fetch` first")
        if s.kind == "multipliers":
            out[s.file_id] = (s.role, load_multipliers(p, s.file_id))
        elif s.kind == "timestamped":
            out[s.file_id] = (s.role, load_timestamped(p, s.file_id))
        elif s.kind == "payouts":
            for sid, lr in load_payouts(p, s.file_id).items():
                out[sid] = (s.role, lr)
        elif s.kind == "synthetic":
            out[s.file_id] = (s.role, load_synthetic(p, s.file_id, synthetic_limit))
    return out


def analyse_series(lr, cfg: EvalConfig, eval_limit: int) -> dict:
    f = lr.frame
    m = f["multiplier"].to_numpy()
    run = f["run_id"].to_numpy()
    e_m, e_r = m[:eval_limit], run[:eval_limit]
    t0 = time.time()
    res = {
        "plausibility": analysis.plausibility(m),
        "distribution": analysis.distribution(m),
        "sequential": analysis.sequential_tests(m, run),
        "strategy": analysis.strategy_evaluation(m, run),
        "evaluation": evaluate(e_m, e_r, cfg) | {"evaluated_rounds": int(e_m.size), "of_rounds": int(m.size)},
    }
    if not res["plausibility"]["passes"] and res["evaluation"]["validated"]:
        res["evaluation"]["promoted"] = []
        res["evaluation"]["verdict"] = ("NOT PROMOTED: " + ", ".join(res["evaluation"]["validated"]) + " beat the baselines here, but the data failed "
                                        "the plausibility gate, so the result describes this file, not the game")
    else:
        res["evaluation"]["promoted"] = list(res["evaluation"]["validated"])
    res["seconds"] = round(time.time() - t0, 1)
    return res


def controls(cfg: EvalConfig, n: int, reps: int) -> dict:
    """SIMULATED controls: false-alarm rate on independent rounds, detection on a planted dependence."""
    out = {"label": "SIMULATED", "n": n, "reps": reps, "fair": [], "planted": []}
    for i in range(reps):
        for key, gen in (("fair", lambda s: simulate.fair(n, s)), ("planted", lambda s: simulate.planted(n, s, 0.05))):
            m = gen(1000 + i)
            run = np.zeros(m.size, dtype=np.int64)
            seq = analysis.sequential_tests(m, run)
            ev = evaluate(m, run, replace(cfg, seed=cfg.seed + i))
            out[key].append({"seed": 1000 + i, "dependence_any_bh": seq["dependence_summary"]["any_significant_bh"],
                             "min_p_bh": min(seq["dependence_summary"]["p_bh"].values()), "validated": ev["validated"],
                             "markov_vs_empirical": ev["models"]["markov"]["vs_empirical"]["mean_diff"]})
    for key in ("fair", "planted"):
        rows = out[key]
        out[f"{key}_summary"] = {"dependence_detected": sum(r["dependence_any_bh"] for r in rows), "any_model_validated": sum(bool(r["validated"]) for r in rows), "of": len(rows)}
    return out


def run_all(quick: bool = False) -> dict:
    cfg = EvalConfig(use_gboost=not quick, bootstrap=500 if quick else 2000)
    eval_limit = 20000 if quick else 60000
    fetched = fetch()
    data = load_all(synthetic_limit=200000 if quick else None)
    report: dict = {"generated": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "fetch": fetched, "no_data_repos": NO_DATA_REPOS,
                    "sources": {s.file_id: {"repo": s.repo, "path": s.path, "url": s.url, "licence": s.licence, "role": s.role, "notes": list(s.notes)} for s in SOURCES}}
    # 1. data quality, before any model
    report["quality"] = {sid: quality.series_quality(sid, lr) | {"role": role} for sid, (role, lr) in data.items()}
    report["overlap"] = quality.overlap({sid: lr.frame["multiplier"].to_numpy() for sid, (role, lr) in data.items()})
    report["mirrors"] = {
        "A1_identical_to_B1": quality.files_identical([RAW / BY_ID["A1"].local_name, RAW / BY_ID["B1"].local_name]),
        "A2_same_rows_as_C1": bool(data["A2"][1].frame["multiplier"].equals(data["C1"][1].frame["multiplier"])),
    }
    report["derived_leakage_B2"] = quality.derived_leakage(RAW / BY_ID["B2"].local_name, data["B1"][1].frame["multiplier"].to_numpy()[::-1])
    # 2. analysis: real candidates, negative control, synthetic control — never pooled
    report["analysis"] = {}
    for sid, (role, lr) in data.items():
        if role == "excluded":
            continue
        print(f"analysing {sid} ({role}, {len(lr.frame)} rounds)", file=sys.stderr)
        report["analysis"][sid] = {"role": role} | analyse_series(lr, cfg, eval_limit)
    print("simulated controls", file=sys.stderr)
    report["controls"] = controls(cfg, 10000 if quick else 20000, 3 if quick else 6)
    return report


def analyze_export(paths: list[Path], site: str | None, merge: bool, min_rounds: int, quick: bool) -> dict:
    """Our own live rounds through the same audit, analysis and stat-6 rules as the public data (role "live")."""
    from .loaders import load_live_exports, merge_streams
    from .stat6 import Stat6Config, run_series

    streams = load_live_exports(paths, site=site)
    series: dict[str, object] = {}
    if merge:
        by_site: dict[str, dict] = {}
        for key, lr in streams.items():
            by_site.setdefault(key.split("/")[0], {})[key] = lr
        for s, group in by_site.items():
            series[f"{s}/merged"] = merge_streams(group)
    else:
        series = dict(streams)
    rep: dict = {"generated": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "inputs": [str(p) for p in paths], "mode": "merged" if merge else "per_stream",
                 "quality": {}, "analysis": {}, "stat6": {}, "skipped": {}}
    for sid, lr in series.items():
        n = len(lr.frame)
        if n < min_rounds:
            rep["skipped"][sid] = f"{n} rounds < --min-rounds {min_rounds}"
            continue
        print(f"analysing {sid} ({n} rounds)", file=sys.stderr)
        warm = min(2000, max(200, n // 3))
        cfg = EvalConfig(use_gboost=not quick, min_train=warm, refit_every=1000 if n < 20000 else 5000, bootstrap=500 if quick else 2000)
        rep["quality"][sid] = quality.series_quality(sid, lr) | {"role": "live"}
        rep["analysis"][sid] = {"role": "live"} | analyse_series(lr, cfg, 10**9)
        s6 = run_series(lr.frame["multiplier"].to_numpy(), lr.frame["run_id"].to_numpy(),
                        Stat6Config(min_train=warm, refit_every=1000 if n < 20000 else 5000, heavy=not quick, bootstrap=400 if quick else 1000))
        rep["stat6"][sid] = {"exact_status": s6["exact"]["status"], "range_status": s6["range"]["status"],
                             "exact_passes_statistics": s6["exact"]["passes_statistics"], "range_passes_statistics": s6["range"]["passes_statistics"],
                             "plausibility": s6["plausibility"], "exact": s6["exact"], "range": s6["range"], "scored": s6["exact"]["scored"]}
    return rep


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="aviator_engine")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("fetch")
    a = sub.add_parser("all")
    a.add_argument("--quick", action="store_true")
    c = sub.add_parser("analyze-csv")
    c.add_argument("path", type=Path)
    c.add_argument("--quick", action="store_true")
    x = sub.add_parser("analyze-export")
    x.add_argument("paths", type=Path, nargs="+")
    x.add_argument("--site")
    x.add_argument("--merge", action="store_true", help="one series per site: streams merged by value alignment")
    x.add_argument("--min-rounds", type=int, default=300)
    x.add_argument("--quick", action="store_true")
    args = ap.parse_args(argv)
    OUT.mkdir(parents=True, exist_ok=True)
    if args.cmd == "fetch":
        print(json.dumps(fetch(), indent=2))
        return 0
    if args.cmd == "all":
        rep = run_all(args.quick)
        name = "report"
    elif args.cmd == "analyze-export":
        rep = analyze_export(args.paths, args.site, args.merge, args.min_rounds, args.quick)
        name = "live_export_report"
    else:
        lr = load_rounds_csv(args.path)
        cfg = EvalConfig(use_gboost=not args.quick, min_train=min(2000, max(200, len(lr.frame) // 3)), refit_every=1000)
        rep = {"generated": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "quality": {"user": quality.series_quality("user", lr) | {"role": "user_export"}},
               "analysis": {"user": {"role": "user_export"} | analyse_series(lr, cfg, 10**9)}}
        name = "user_report"
    (OUT / f"{name}.json").write_text(json.dumps(rep, indent=1, default=float), encoding="utf-8")
    (OUT / f"{name}.md").write_text(render_markdown(rep), encoding="utf-8")
    print(f"wrote {OUT / (name + '.json')} and .md", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
