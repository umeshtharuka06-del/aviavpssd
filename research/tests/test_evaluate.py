"""Leakage-free chronological evaluation."""

import numpy as np
import pytest

from aviator_engine.evaluate import EvalConfig, evaluate, features, holm, walk_forward
from aviator_engine.simulate import fair, planted

FAST = EvalConfig(min_train=1000, refit_every=1000, bootstrap=300, use_gboost=True)


def test_no_look_ahead_changing_the_future_never_changes_an_earlier_forecast():
    m = fair(4000, 11)
    run = np.repeat(np.arange(40), 100)
    P1, s1 = walk_forward(m, run, FAST)
    t0 = 2500
    m2 = m.copy()
    m2[t0:] = fair(m.size - t0, 99)  # every round from t0 on replaced
    P2, s2 = walk_forward(m2, run, FAST)
    for k in P1:
        # round t0 itself is forecast from rounds < t0, so it must not change either
        np.testing.assert_allclose(P1[k][: t0 + 1], P2[k][: t0 + 1], err_msg=k)
    assert (s1 == s2).all()


def test_features_of_round_t_do_not_depend_on_round_t():
    m = fair(300, 3)
    run = np.zeros(300, dtype=int)
    m2 = m.copy()
    m2[150] = 777.0
    X1, X2 = features(m, run), features(m2, run)
    np.testing.assert_array_equal(X1[:151], X2[:151])
    assert not np.array_equal(X1[151], X2[151])


def test_features_never_cross_a_run_break():
    m = fair(40, 4)
    run = np.array([0] * 20 + [1] * 20)
    X = features(m, run)
    assert X[20, 1] == 0  # lag-1 availability mask at a run start
    assert X[20, -1] == 0  # no in-run history at all


def test_scoring_excludes_warmup_and_run_starts_and_is_the_same_for_every_model():
    m = fair(3000, 5)
    run = np.repeat(np.arange(30), 100)
    P, scored = walk_forward(m, run, FAST)
    assert not scored[:1000].any() and not scored[1000] and scored[1001]
    assert scored.sum() == 2000 - 20
    assert all(np.isfinite(v[scored]).all() for v in P.values())


def test_independent_rounds_give_no_validated_model():
    r = evaluate(fair(12000, 21), np.zeros(12000, dtype=int), FAST)
    assert r["validated"] == [] and r["verdict"].startswith("NO VALIDATED MODEL")
    assert r["models"]["empirical"]["role"] == "baseline"


def test_a_real_dependence_is_validated():
    r = evaluate(planted(12000, 22, 0.08), np.zeros(12000, dtype=int), FAST)
    assert "markov" in r["validated"] or "logistic" in r["validated"]


def test_holm_step_down():
    adj = holm({"a": 0.01, "b": 0.04, "c": 0.03})
    assert adj == pytest.approx({"a": 0.03, "c": 0.06, "b": 0.06})
