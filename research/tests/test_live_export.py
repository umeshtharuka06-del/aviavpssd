"""Offline side of the live export: schema checks, overlap merge, continuity across files, stream merge, end to end.

Every export file here is SIMULATED (written by `_export`), never real data.
"""

import json

import numpy as np
import pandas as pd
import pytest

from aviator_engine import cli
from aviator_engine.loaders import LIVE_EXPORT_COLUMNS, load_live_exports, merge_streams, read_live_export
from aviator_engine.simulate import fair

T0 = pd.Timestamp("2026-10-31T00:00:00Z")


def _rows(stream: str, obs_ids, multipliers, verified, *, site="onexbet", t0=T0, step=30, chain="c_00000000000000aa"):
    out = []
    for k, (o, m, v) in enumerate(zip(obs_ids, multipliers, verified)):
        out.append({
            "schema_version": "1", "site_id": site, "stream": stream, "obs_id": str(o),
            "received_at": (t0 + pd.Timedelta(seconds=step * k)).strftime("%Y-%m-%dT%H:%M:%S.%fZ"),
            "multiplier": f"{m:.2f}", "source": "live", "chain": chain, "chain_index": str(k),
            "break_before": "true" if not v else "false", "verified_successor": "true" if v else "false", "run_id": "0",
        })
    return out


def _export(tmp_path, name, rows):
    p = tmp_path / name
    pd.DataFrame(rows, columns=LIVE_EXPORT_COLUMNS).to_csv(p, index=False)
    return p


def test_refuses_other_formats(tmp_path):
    bad = tmp_path / "bad.csv"
    pd.DataFrame({"multiplier": [1.5]}).to_csv(bad, index=False)
    with pytest.raises(ValueError, match="schema-1"):
        read_live_export(bad)
    rows = _rows("s_a", [1], [1.5], [False])
    rows[0]["schema_version"] = "2"
    with pytest.raises(ValueError, match="schema_version"):
        read_live_export(_export(tmp_path, "v2.csv", rows))


def test_formula_guard_is_removed_on_load(tmp_path):
    rows = _rows("s_a", [1, 2], [1.5, 2.5], [False, True], site="'-a1")
    s = load_live_exports([_export(tmp_path, "g.csv", rows)])
    assert set(s) == {"-a1/s_a"}  # the real site key, not the guarded cell
    assert load_live_exports([_export(tmp_path, "g2.csv", rows)], site="-a1")
    plain = _rows("s_b", [3], [3.5], [False], site="it's")  # an apostrophe not followed by = + - @ stays
    assert read_live_export(_export(tmp_path, "g3.csv", plain))["site_id"].tolist() == ["it's"]


def test_runs_follow_verified_successor_and_streams_stay_separate(tmp_path):
    m = [1.1, 2.2, 3.3, 4.4, 5.5]
    rows = _rows("s_a", [1, 3, 5, 7, 9], m, [False, True, False, True, True]) + _rows("s_b", [2, 4], [6.6, 7.7], [False, True])
    s = load_live_exports([_export(tmp_path, "e.csv", rows)])
    assert set(s) == {"onexbet/s_a", "onexbet/s_b"}
    a = s["onexbet/s_a"].frame
    assert a["multiplier"].tolist() == m and a["run_id"].tolist() == [0, 0, 1, 1, 1]
    assert a["row_in_file"].tolist() == [1, 3, 5, 7, 9]  # provenance: server obs_id
    assert load_live_exports([_export(tmp_path, "e2.csv", rows)], site="melbet") == {}


def test_overlapping_exports_union_once_and_conflicts_are_errors(tmp_path):
    m = fair(30, 1)
    rows = _rows("s_a", range(1, 31), m, [False] + [True] * 29)
    f1 = _export(tmp_path, "1.csv", rows[:20])
    second = [dict(r) for r in rows[10:]]
    second[0]["verified_successor"] = "false"  # its predecessor was purged before the 2nd export
    f2 = _export(tmp_path, "2.csv", second)
    s = load_live_exports([f1, f2])["onexbet/s_a"]
    assert s.frame["multiplier"].tolist() == [round(x, 2) for x in m]
    assert s.exact_duplicates == 10
    assert s.frame["run_id"].nunique() == 1  # verified in the 1st file, adjacency proven there
    second[5]["multiplier"] = "99.99"
    with pytest.raises(ValueError, match="differ between files"):
        load_live_exports([f1, _export(tmp_path, "3.csv", second)])


def test_a_round_lost_between_exports_never_joins_two_runs(tmp_path):
    m = fair(25, 2)
    rows = _rows("s_a", range(1, 26), m, [False] + [True] * 24)
    f1 = _export(tmp_path, "1.csv", rows[:10])  # obs 1-10
    f2 = _export(tmp_path, "2.csv", rows[14:])  # obs 15-25; obs 11-14 were purged before any export saw them
    fr = load_live_exports([f1, f2])["onexbet/s_a"].frame
    assert len(fr) == 21
    assert fr["run_id"].tolist() == [0] * 10 + [1] * 11  # obs 15 says "verified" but its predecessor is not in its file


def test_merge_removes_rounds_seen_twice_and_never_joins_runs(tmp_path):
    m = fair(60, 3)
    a = _rows("s_a", range(1, 61, 1), m, [False] + [True] * 59)
    # device b saw rounds 21-40 of the same game (same values, ~2 s later), plus 10 rounds nobody else saw
    extra = fair(10, 4)
    b = _rows("s_b", range(1001, 1021), m[20:40], [False] + [True] * 19, t0=T0 + pd.Timedelta(seconds=30 * 20 + 2)) + \
        _rows("s_b", range(1021, 1031), extra, [False] + [True] * 9, t0=T0 + pd.Timedelta(hours=1))
    streams = load_live_exports([_export(tmp_path, "m.csv", a + b)])
    merged = merge_streams(streams).frame
    assert len(merged) == 70  # 60 + 10 unique; the 20 rounds seen twice are kept once
    assert merged["run_id"].nunique() == 2  # stream a's run and b's unique run, never joined
    # an ambiguous pattern (the same 8 values twice in the base within the tolerance) is kept, not guessed
    rep = [1.11] * 8
    c = _rows("s_c", range(1, 17), rep + rep, [False] + [True] * 15, step=1)
    d = _rows("s_d", range(101, 109), rep, [False] + [True] * 7, step=1)
    m2 = merge_streams(load_live_exports([_export(tmp_path, "amb.csv", c + d)])).frame
    assert len(m2) == 24


def test_analyze_export_end_to_end_on_a_simulated_export(tmp_path, monkeypatch):
    n = 2400
    m = fair(n, 9)
    verified = np.ones(n, dtype=bool)
    verified[[0, 700, 1500]] = False
    rows = _rows("s_a", range(1, n + 1), m, verified.tolist())
    f = _export(tmp_path, "sim.csv", rows)
    monkeypatch.setattr(cli, "OUT", tmp_path / "out")
    assert cli.main(["analyze-export", str(f), "--quick"]) == 0
    rep = json.loads((tmp_path / "out" / "live_export_report.json").read_text(encoding="utf-8"))
    s6 = rep["stat6"]["onexbet/s_a"]
    assert s6["exact_passes_statistics"] == [] and s6["range_passes_statistics"] == []
    assert rep["analysis"]["onexbet/s_a"]["role"] == "live"
    md = (tmp_path / "out" / "live_export_report.md").read_text(encoding="utf-8")
    assert "stat-6 pre-registered rules" in md
