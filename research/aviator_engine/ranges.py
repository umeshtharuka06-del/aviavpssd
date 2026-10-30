"""Configurable multiplier ranges and their empirical frequencies with 95% Wilson intervals.

A range holds min <= m < max in whole cents (max None = unbounded), so 2.00x is in 2.00x-4.99x, exactly as
`rangeIndex` / `rangeHit` in shared/contracts/src/signal.ts.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from scipy import stats

Z95 = float(stats.norm.ppf(0.975))


@dataclass(frozen=True)
class Range:
    label: str
    min: float
    max: float | None


#: The four ranges of the existing panel (contracts MULTIPLIER_RANGES). Order and labels must not change.
DISPLAY_RANGES: tuple[Range, ...] = (
    Range("1.00x-1.99x", 1.0, 2.0),
    Range("2.00x-4.99x", 2.0, 5.0),
    Range("5.00x-9.99x", 5.0, 10.0),
    Range("10.00x+", 10.0, None),
)

#: The finer analysis ranges requested for the distribution report.
ANALYSIS_RANGES: tuple[Range, ...] = (
    Range("1.00x-1.49x", 1.0, 1.5),
    Range("1.50x-1.99x", 1.5, 2.0),
    Range("2.00x-4.99x", 2.0, 5.0),
    Range("5.00x-9.99x", 5.0, 10.0),
    Range("10.00x+", 10.0, None),
)


def ranges_from_edges(edges: list[float]) -> tuple[Range, ...]:
    """Ranges from ascending lower bounds starting at 1, e.g. [1, 2, 5, 10] -> the display ranges."""
    if not edges or edges[0] != 1 or any(b <= a for a, b in zip(edges, edges[1:])):
        raise ValueError("edges must start at 1 and increase strictly")
    out = []
    for i, lo in enumerate(edges):
        hi = edges[i + 1] if i + 1 < len(edges) else None
        out.append(Range(f"{lo:.2f}x+" if hi is None else f"{lo:.2f}x-{hi - 0.01:.2f}x", float(lo), None if hi is None else float(hi)))
    return tuple(out)


def range_index(multipliers: np.ndarray, ranges: tuple[Range, ...] = DISPLAY_RANGES) -> np.ndarray:
    """Index of the range of each multiplier (whole-cent comparison)."""
    c = np.round(np.asarray(multipliers, dtype=float) * 100).astype(np.int64)
    lows = np.array([round(r.min * 100) for r in ranges], dtype=np.int64)
    return np.searchsorted(lows, c, side="right") - 1


def target_hit(multipliers: np.ndarray, target: float) -> np.ndarray:
    return np.round(np.asarray(multipliers, dtype=float) * 100).astype(np.int64) >= round(target * 100)


def wilson(hits: int, n: int, z: float = Z95) -> tuple[float | None, float | None, float | None]:
    if n <= 0:
        return None, None, None
    p = hits / n
    d = 1 + z * z / n
    centre = (p + z * z / (2 * n)) / d
    half = z * np.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return p, max(0.0, centre - half), min(1.0, centre + half)


def frequencies(multipliers: np.ndarray, ranges: tuple[Range, ...] = DISPLAY_RANGES) -> list[dict]:
    """Count, share and 95% Wilson interval of every range. Shares are null (never 0) when n = 0."""
    idx = range_index(multipliers, ranges)
    n = int(idx.size)
    out = []
    for k, r in enumerate(ranges):
        cnt = int((idx == k).sum())
        p, lo, hi = wilson(cnt, n)
        out.append({"range": r.label, "min": r.min, "max": r.max, "count": cnt, "n": n, "share": p, "ci_low": lo, "ci_high": hi})
    return out


#: P(M >= m) = 0.97 / m: the reference distribution of a 97%-RTP crash game (an assumption, not a fact about any operator).
RTP = 0.97


def reference_probabilities(ranges: tuple[Range, ...] = DISPLAY_RANGES, rtp: float = RTP) -> np.ndarray:
    surv = lambda m: 1.0 if m <= 1 else min(1.0, rtp / m)  # noqa: E731
    return np.array([surv(r.min) - (0.0 if r.max is None else surv(r.max)) for r in ranges])
