"""stat-6 research candidates: no look-ahead, correct past-only quantiles, honest acceptance on nulls."""

import numpy as np

from aviator_engine.simulate import fair
from aviator_engine.stat6 import Stat6Config, exact_candidates, range_candidates, run_series

CFG = Stat6Config(min_train=600, refit_every=600, max_train_rows=3000, bootstrap=200, heavy=True)


def test_no_look_ahead_for_any_exact_or_range_candidate():
    m = fair(2400, 41)
    run = np.repeat(np.arange(24), 100)
    t0 = 1500
    m2 = m.copy()
    m2[t0:] = fair(m.size - t0, 977)  # every round from t0 on replaced
    E1, E2 = exact_candidates(m, run, CFG), exact_candidates(m2, run, CFG)
    for k in E1:
        for part in ("point", "lo", "hi"):
            np.testing.assert_allclose(E1[k][part][: t0 + 1], E2[k][part][: t0 + 1], err_msg=f"{k}.{part}")
    P1, P2 = range_candidates(m, run, CFG), range_candidates(m2, run, CFG)
    for k in P1:
        np.testing.assert_allclose(P1[k][: t0 + 1], P2[k][: t0 + 1], err_msg=k)


def test_the_round_itself_never_enters_its_own_estimate():
    m = fair(800, 5)
    run = np.zeros(800, dtype=int)
    m2 = m.copy()
    m2[700] = 999.0
    E1, E2 = exact_candidates(m, run, CFG), exact_candidates(m2, run, CFG)
    for k in E1:
        assert E1[k]["point"][700] == E2[k]["point"][700] or (np.isnan(E1[k]["point"][700]) and np.isnan(E2[k]["point"][700])), k


def test_past_quantiles_match_a_naive_computation():
    m = fair(500, 9)
    E = exact_candidates(m, np.zeros(500, dtype=int), Stat6Config(heavy=False))
    for t in (1, 10, 137, 499):
        past = np.sort(np.log(m[:t]))
        lower = lambda q: past[int(np.floor(q * (t - 1)))]  # noqa: E731  (pandas "lower" interpolation)
        assert np.isclose(E["median_all"]["point"][t], np.exp(lower(0.5)))
        w = np.sort(np.log(m[max(0, t - 50):t]))
        assert np.isclose(E["median_last_50"]["point"][t], np.exp(w[int(np.floor(0.5 * (w.size - 1)))]))


def test_range_candidates_are_proper_distributions():
    m = fair(3000, 13)
    P = range_candidates(m, np.zeros(3000, dtype=int), CFG)
    for k, v in P.items():
        ok = ~np.isnan(v).any(1)
        assert ok[600:].all(), k
        np.testing.assert_allclose(v[ok].sum(1), 1.0, atol=1e-9, err_msg=k)
        assert (v[ok] > 0).all(), k


def test_independent_rounds_validate_nothing_for_either_task():
    r = run_series(fair(6000, 77), np.zeros(6000, dtype=int), CFG)
    assert r["exact"]["passes_statistics"] == [] and r["range"]["passes_statistics"] == []
