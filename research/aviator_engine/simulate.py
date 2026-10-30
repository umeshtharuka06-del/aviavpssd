"""SIMULATED rounds for controls. Never mixed with observed data; every result built from them is labelled SIMULATED."""

from __future__ import annotations

import numpy as np

from .ranges import RTP


def _draw(u: np.ndarray, rtp: float = RTP) -> np.ndarray:
    """Inverse transform of P(M >= m) = rtp / m, floored to whole cents, minimum 1.00."""
    return np.maximum(1.0, np.floor(rtp / np.maximum(u, 1e-12) * 100) / 100)


def fair(n: int, seed: int) -> np.ndarray:
    """Independent rounds with the 97%-RTP reference distribution."""
    return _draw(np.random.default_rng(seed).random(n))


def planted(n: int, seed: int, effect: float = 0.05) -> np.ndarray:
    """Dependent rounds: P(>= 2x) is raised by `effect` after a round below 2x and lowered by it after one at or above."""
    rng = np.random.default_rng(seed)
    p_hi = RTP / 2  # P(M >= 2) under the reference
    out = np.empty(n)
    prev_hi = True
    for t in range(n):
        p = p_hi - effect if prev_hi else p_hi + effect
        if rng.random() < p:  # draw from the >= 2 part: u in (0, p_hi]
            out[t] = _draw(rng.random(1) * p_hi)[0]
        else:  # the < 2 part: u in (p_hi, 1)
            out[t] = min(1.99, _draw(p_hi + rng.random(1) * (1 - p_hi))[0])
        prev_hi = out[t] >= 2
    return out
