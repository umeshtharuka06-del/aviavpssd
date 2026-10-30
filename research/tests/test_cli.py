"""End to end on a small export: the report has the documented sections and labels."""

import json

import pandas as pd

from aviator_engine import cli
from aviator_engine.simulate import fair


def test_analyze_csv_end_to_end(tmp_path, monkeypatch):
    m = fair(3000, 31)
    t = pd.date_range("2026-01-01", periods=m.size, freq="30s", tz="UTC")
    p = tmp_path / "rounds.csv"
    pd.DataFrame({"multiplier": m, "received_at": t.strftime("%Y-%m-%dT%H:%M:%SZ")}).to_csv(p, index=False)
    monkeypatch.setattr(cli, "OUT", tmp_path / "out")
    assert cli.main(["analyze-csv", str(p), "--quick"]) == 0
    rep = json.loads((tmp_path / "out" / "user_report.json").read_text(encoding="utf-8"))
    a = rep["analysis"]["user"]
    assert set(a) >= {"plausibility", "distribution", "sequential", "strategy", "evaluation"}
    assert [x["range"] for x in a["distribution"]["display_ranges"]] == ["1.00x-1.99x", "2.00x-4.99x", "5.00x-9.99x", "10.00x+"]
    assert a["evaluation"]["promoted"] == [] and "NO VALIDATED MODEL" in a["evaluation"]["verdict"]
    md = (tmp_path / "out" / "user_report.md").read_text(encoding="utf-8")
    assert "WATCH rule" in md and "Verdict" in md
