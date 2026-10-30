"""WATCH-state transitions against the shared fixture (the same file is checked by backend/tests/strategy-parity.test.ts)."""

import json
from pathlib import Path

import numpy as np
import pytest

from aviator_engine.strategy import RangeStrategyTracker, StrategyConfig, range_index_one, replay, strategy_hits, target_hit

FIXTURE = json.loads((Path(__file__).resolve().parents[1] / "fixtures" / "watch_parity.json").read_text(encoding="utf-8"))
BASE = FIXTURE["baseline"]
STATE = {"T": "low_range_tracking", "W": "elevated_range_watch"}


def test_boundaries():
    for b in FIXTURE["boundaries"]:
        assert range_index_one(b["m"]) == b["range"]
        assert target_hit(b["m"], 2.0) == b["ge2"]


@pytest.mark.parametrize("case", FIXTURE["cases"], ids=lambda c: c["name"][:40])
def test_transitions(case):
    t = RangeStrategyTracker()
    f = t.forecast(BASE)
    s0, low0, wf0, pr0 = FIXTURE["initial"]
    assert (f["state"], f["consecutiveLow"], f["watchForecast"], f["predictedRange"]) == (STATE[s0], low0, wf0, pr0)
    for m, brk, th, rh, s, low, wf, pr in case["rows"]:
        assert strategy_hits(f, m) == {"targetHit": th, "strategyRangeHit": rh}, (m, f)
        t.observe(m, brk)
        f = t.forecast(BASE)
        assert (f["state"], f["consecutiveLow"], f["watchForecast"], f["predictedRange"]) == (STATE[s], low, wf, pr), m
        assert f["targetThreshold"] == 2.0


def test_conditional_estimate_after_thirty_watch_rounds():
    c = FIXTURE["conditional"]
    t = RangeStrategyTracker()
    for _ in range(c["lows"]):
        t.observe(c["multiplier"])
    f = t.forecast(BASE)
    e = c["expected"]
    for k in ("state", "consecutiveLow", "watchForecast", "predictedRange", "basis", "conditionalSample"):
        assert f[k] == e[k], k
    assert f["probabilities"] == pytest.approx(e["probabilities"], abs=1e-12)
    assert f["targetProbability"] == pytest.approx(e["targetProbability"], abs=1e-12)


def test_watch_does_not_lapse_by_default_and_lapses_when_configured():
    t = RangeStrategyTracker()
    for _ in range(50):
        t.observe(1.5)
    assert t.forecast(BASE)["state"] == "elevated_range_watch"
    t2 = RangeStrategyTracker(StrategyConfig(max_watch_forecasts=2))
    for _ in range(7):
        t2.observe(1.5)
    f = t2.forecast(BASE)
    assert f["state"] == "low_range_tracking" and f["watchLapsed"]


def test_target_threshold_must_be_a_range_bound():
    with pytest.raises(ValueError):
        RangeStrategyTracker(StrategyConfig(target_threshold=3.0))


def test_replay_voids_forecasts_after_a_break_and_keeps_hits_separate():
    m = np.array([1.1, 1.1, 1.1, 1.1, 1.1, 5.0, 1.1])
    b = np.array([False] * 6 + [True])
    r = replay(m, b, BASE)
    assert r[5]["state"] == "elevated_range_watch" and r[5]["targetHit"] and not r[5]["strategyRangeHit"]
    assert r[6]["void"] and not r[5]["void"]
