"""Consecutive-low counting, censoring, streaks and dependence tests (with SIMULATED controls)."""

import numpy as np

from aviator_engine import sequential as sq
from aviator_engine.analysis import sequential_tests
from aviator_engine.simulate import fair, planted


def test_consecutive_low_before_resets_on_hit_and_on_break():
    m = np.array([3.0, 1.2, 1.5, 1.99, 2.0, 1.1, 1.1, 1.1])
    run = np.array([0, 0, 0, 0, 0, 0, 1, 1])
    assert sq.consecutive_low_before(m, run).tolist() == [0, 0, 1, 2, 3, 0, 0, 1]
    # the count is exact only once a hit precedes the streak inside the run
    assert sq.low_count_exact(m, run).tolist() == [False, True, True, True, True, True, False, False]


def test_low_streaks_only_complete_ones():
    m = np.array([1.1, 1.1, 3.0, 1.1, 1.1, 1.1, 2.0, 1.5, 4.0, 1.2, 1.2])
    run = np.zeros(m.size, dtype=int)
    # the leading streak (2) is censored on the left, the trailing one (2) on the right
    assert sq.low_streaks(m, run).tolist() == [3, 1]
    run2 = np.array([0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1])  # a break inside the 3-streak censors it
    assert sq.low_streaks(m, run2).tolist() == [1]


def test_independent_rounds_raise_no_dependence_alarm():
    m = fair(20000, 1)
    s = sequential_tests(m, np.zeros(m.size, dtype=int))
    assert not s["dependence_summary"]["any_significant_bh"]
    assert s["change_points"]["significant"] == []


def test_censoring_does_not_create_dependence_with_many_breaks():
    m = fair(20000, 12)
    run = np.cumsum(np.random.default_rng(12).random(m.size) < 0.15)  # a break every ~7 rounds, as in burst-heavy files
    s = sequential_tests(m, run)
    assert s["conditional_on_lows"]["p"] > 0.01


def test_planted_dependence_is_detected():
    m = planted(20000, 2, 0.05)
    s = sequential_tests(m, np.zeros(m.size, dtype=int))
    assert s["dependence_summary"]["p_bh"]["acf_ge2"] < 1e-6
    assert s["conditional_on_lows"]["p"] < 1e-6


def test_change_point_found_only_when_there_is_one():
    a, b = fair(6000, 3), fair(6000, 4)
    assert sq.change_points(np.concatenate([a, b]))["significant"] == []
    shifted = np.where(np.random.default_rng(5).random(6000) < 0.15, 1.0, fair(6000, 6))  # 15% extra 1.00x rounds
    cps = sq.change_points(np.concatenate([a, shifted]))["significant"]
    assert cps and abs(cps[0]["index"] - 6000) < 400


def test_runs_test_uses_within_run_pairs_only():
    m = np.array([1.1, 3.0] * 50)
    one = sq.runs_test(m, np.zeros(m.size, dtype=int))
    split = sq.runs_test(m, np.repeat(np.arange(50), 2))
    assert one["pairs"] == 99 and split["pairs"] == 50
