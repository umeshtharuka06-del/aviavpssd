"""Python reference of the live range state machine `range_state_machine_v1` (backend/src/engine/sequential/strategy.ts).

Used for analysis only; the live system keeps running the TypeScript version. research/fixtures/watch_parity.json is
checked against BOTH implementations (tests/test_strategy.py and backend/tests/strategy-parity.test.ts), so any
drift between them fails a test.

Rules (unchanged from the live system):
  * consecutiveLow counts rounds below targetThreshold in a row; a round >= targetThreshold resets it to 0;
    a collection break resets it to 0 before the round is counted.
  * lowEntryCount (5) or more lows -> ELEVATED-RANGE WATCH, predicted range = watchRange (2.00x-4.99x).
  * The watch persists after misses (maxWatchForecasts None) until a hit or a break.
  * TARGET hit (actual >= threshold) and RANGE hit (actual inside the predicted range) are scored separately.
"""

from __future__ import annotations

from dataclasses import dataclass, field, replace

import numpy as np

from .ranges import DISPLAY_RANGES

RANGE_COUNT = len(DISPLAY_RANGES)


def _cents(x: float) -> int:
    return int(round(x * 100))


def range_index_one(m: float) -> int:
    c = _cents(m)
    if c < 200:
        return 0
    if c < 500:
        return 1
    if c < 1000:
        return 2
    return 3


def range_hit(m: float, k: int) -> bool:
    r = DISPLAY_RANGES[k]
    return _cents(m) >= _cents(r.min) and (r.max is None or _cents(m) < _cents(r.max))


def target_hit(m: float, target: float) -> bool:
    return _cents(m) >= _cents(target)


@dataclass(frozen=True)
class StrategyConfig:
    target_threshold: float = 2.0
    low_entry_count: int = 5
    watch_range: int = 1
    max_watch_forecasts: int | None = None
    min_conditional_sample: int = 30
    prior_strength: float = 20.0


DEFAULT_CONFIG = StrategyConfig()


def target_ranges(threshold: float) -> list[int]:
    return [k for k, r in enumerate(DISPLAY_RANGES) if r.min >= threshold]


@dataclass
class RangeStrategyTracker:
    config: StrategyConfig = DEFAULT_CONFIG
    consecutive_low: int = 0
    conditional_counts: list[int] = field(default_factory=lambda: [0] * RANGE_COUNT)
    conditional_n: int = 0

    def __post_init__(self) -> None:
        tr = target_ranges(self.config.target_threshold)
        if not tr or DISPLAY_RANGES[tr[0]].min != self.config.target_threshold:
            raise ValueError("target_threshold must be the lower bound of a range")

    def in_watch(self, low: int) -> bool:
        c = self.config
        return low >= c.low_entry_count and (c.max_watch_forecasts is None or low - c.low_entry_count < c.max_watch_forecasts)

    def observe(self, multiplier: float, break_before: bool = False) -> None:
        if break_before:
            self.consecutive_low = 0
        elif self.in_watch(self.consecutive_low):
            self.conditional_counts[range_index_one(multiplier)] += 1
            self.conditional_n += 1
        self.consecutive_low = 0 if target_hit(multiplier, self.config.target_threshold) else self.consecutive_low + 1

    def forecast(self, baseline: list[float]) -> dict:
        c = self.config
        low = self.consecutive_low
        watch = self.in_watch(low)
        n = self.conditional_n
        conditional = watch and n >= c.min_conditional_sample
        probs = [(cnt + c.prior_strength * baseline[k]) / (n + c.prior_strength) for k, cnt in enumerate(self.conditional_counts)] if conditional else list(baseline)
        tr = target_ranges(c.target_threshold)
        argmax = max(range(RANGE_COUNT), key=lambda k: (probs[k], -k))
        return {
            "state": "elevated_range_watch" if watch else "low_range_tracking",
            "consecutiveLow": low,
            "watchForecast": low - c.low_entry_count + 1 if watch else 0,
            "watchLapsed": low >= c.low_entry_count and not watch,
            "targetThreshold": c.target_threshold,
            "predictedRange": c.watch_range if watch else argmax,
            "probabilities": probs,
            "targetProbability": sum(probs[k] for k in tr),
            "basis": "conditional" if conditional else "baseline",
            "conditionalSample": n,
        }


def strategy_hits(forecast: dict, multiplier: float) -> dict:
    return {"targetHit": target_hit(multiplier, forecast["targetThreshold"]), "strategyRangeHit": range_hit(multiplier, forecast["predictedRange"])}


def replay(multipliers: np.ndarray, break_before: np.ndarray, baseline: list[float], config: StrategyConfig = DEFAULT_CONFIG) -> list[dict]:
    """Forecast every round from the rounds before it, then observe it: one record per round (walk-forward).

    As in the live ledger, a forecast whose round comes after a collection break is void (`void` True): rounds may
    be missing in between, so it is not scored.
    """
    t = RangeStrategyTracker(replace(config))
    out = []
    for m, b in zip(multipliers, break_before):
        f = t.forecast(baseline)
        f.update(strategy_hits(f, float(m)), multiplier=float(m), void=bool(b))
        out.append(f)
        t.observe(float(m), bool(b))
    return out
