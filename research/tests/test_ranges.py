"""Range-frequency calculations: the panel's four ranges, the five analysis ranges and configurable edges."""

import numpy as np
import pytest

from aviator_engine.ranges import ANALYSIS_RANGES, DISPLAY_RANGES, frequencies, range_index, ranges_from_edges, reference_probabilities, target_hit, wilson


def test_display_ranges_match_the_panel_labels_and_bounds():
    assert [(r.min, r.max) for r in DISPLAY_RANGES] == [(1, 2), (2, 5), (5, 10), (10, None)]
    assert [r.label for r in DISPLAY_RANGES] == ["1.00x-1.99x", "2.00x-4.99x", "5.00x-9.99x", "10.00x+"]


def test_boundaries_belong_to_the_higher_range_in_whole_cents():
    m = np.array([1.0, 1.99, 2.0, 4.99, 5.0, 9.99, 10.0, 1.9999999, 4.9999999])
    assert range_index(m).tolist() == [0, 0, 1, 1, 2, 2, 3, 1, 2]
    assert target_hit(m, 2.0).tolist() == [False, False, True, True, True, True, True, True, True]


def test_frequencies_counts_shares_and_intervals():
    m = np.array([1.0, 1.2, 1.49, 1.5, 1.99, 2.0, 3.0, 5.0, 12.0, 100.0])
    f = frequencies(m, ANALYSIS_RANGES)
    assert [x["count"] for x in f] == [3, 2, 2, 1, 2]
    assert sum(x["count"] for x in f) == 10 and all(x["n"] == 10 for x in f)
    assert f[0]["share"] == pytest.approx(0.3)
    assert f[0]["ci_low"] < 0.3 < f[0]["ci_high"]
    d = frequencies(m, DISPLAY_RANGES)
    assert [x["count"] for x in d] == [5, 2, 1, 2]


def test_empty_input_gives_null_shares_never_zero():
    f = frequencies(np.array([]), DISPLAY_RANGES)
    assert all(x["share"] is None and x["ci_low"] is None for x in f)


def test_configurable_edges():
    r = ranges_from_edges([1, 3, 20])
    assert [(x.min, x.max) for x in r] == [(1, 3), (3, 20), (20, None)]
    assert range_index(np.array([2.99, 3.0, 19.99, 20.0]), r).tolist() == [0, 1, 1, 2]
    with pytest.raises(ValueError):
        ranges_from_edges([2, 5])


def test_wilson_known_value():
    p, lo, hi = wilson(50, 100)
    assert p == 0.5 and lo == pytest.approx(0.4038, abs=1e-4) and hi == pytest.approx(0.5962, abs=1e-4)


def test_reference_distribution_sums_to_one_and_matches_the_live_baseline_prior():
    ref = reference_probabilities()
    assert ref.sum() == pytest.approx(1.0)
    assert ref.tolist() == pytest.approx([0.515, 0.291, 0.097, 0.097])
