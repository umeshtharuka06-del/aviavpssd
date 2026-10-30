"""Quality audit: overlap/duplicate detection between sources, synthetic fingerprints, the plausibility gate."""

import numpy as np

from aviator_engine.analysis import plausibility
from aviator_engine.quality import overlap, synthetic_fingerprint
from aviator_engine.simulate import fair


def test_overlap_finds_copied_sequences_and_not_independent_ones():
    a, b = fair(5000, 1), fair(5000, 2)
    c = np.concatenate([fair(1000, 3), a[2000:3000]])  # contains a copy of part of a
    o = {(x["a"], x["b"]): x["shared_kgrams"] for x in overlap({"a": a, "b": b, "c": c})}
    assert o[("a", "b")] == 0
    assert o[("a", "c")] >= 990


def test_synthetic_uniform_generator_is_flagged_and_the_1_over_m_law_is_not():
    rng = np.random.default_rng(0)
    uniform = np.round(rng.uniform(1, 2, 20000), 2)
    assert not synthetic_fingerprint(uniform)["consistent_with_1_over_m_law"]
    assert synthetic_fingerprint(fair(20000, 1))["consistent_with_1_over_m_law"]


def test_plausibility_gate():
    assert plausibility(fair(20000, 7))["passes"]
    inflated = np.where(fair(20000, 8) < 2, 3.0, fair(20000, 9))  # P(>= 2x) far above 1/2: impossible
    p = plausibility(inflated)
    assert not p["passes"] and any("2x" in r for r in p["reasons"])
