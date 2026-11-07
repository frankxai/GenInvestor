"""Testable allocation theories.

Each entry is a documented, publicly-known approach with a falsifiable claim.
Registering a theory here is what makes it comparable — the point of the engine
is that a theory earns its place by surviving a test, not by sounding smart.

Nothing here is a recommendation. A theory that scores well on one price window
has demonstrated exactly that and nothing more.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass

import numpy as np
import pandas as pd

WeightFn = Callable[[pd.DataFrame], dict[str, float]]


@dataclass(frozen=True)
class Theory:
    id: str
    name: str
    claim: str
    weight_fn: WeightFn
    rebalance: str = "Q"
    known_failure_mode: str = ""


def equal_weight(window: pd.DataFrame) -> dict[str, float]:
    n = len(window.columns)
    return {s: 1.0 / n for s in window.columns}


def buy_and_hold(window: pd.DataFrame) -> dict[str, float]:
    return equal_weight(window)


def inverse_volatility(window: pd.DataFrame) -> dict[str, float]:
    """Size positions by 1/vol so each contributes comparable risk."""
    vol = window.pct_change().std()
    inv = 1.0 / vol.replace(0, np.nan)
    inv = inv.fillna(0.0)
    total = inv.sum()
    if total == 0:
        return equal_weight(window)
    return (inv / total).to_dict()


def risk_parity(window: pd.DataFrame) -> dict[str, float]:
    """Naive risk parity — inverse-vol, then damped toward equal weight to avoid
    the concentration in low-vol assets that pure 1/vol produces."""
    inv = pd.Series(inverse_volatility(window))
    eq = pd.Series(equal_weight(window))
    blend = 0.7 * inv + 0.3 * eq
    return (blend / blend.sum()).to_dict()


def momentum_tilt(window: pd.DataFrame, top_fraction: float = 0.5) -> dict[str, float]:
    """Hold the better-performing half of the window, equally weighted."""
    if len(window) < 20:
        return equal_weight(window)
    trailing = window.iloc[-1] / window.iloc[0] - 1.0
    keep = max(1, round(len(window.columns) * top_fraction))
    winners = trailing.sort_values(ascending=False).head(keep).index
    return {s: 1.0 / len(winners) for s in winners}


def min_variance(window: pd.DataFrame) -> dict[str, float]:
    """Long-only minimum-variance via projected gradient. No optimiser dependency."""
    rets = window.pct_change().dropna()
    if len(rets) < 10:
        return equal_weight(window)
    cov = rets.cov().to_numpy()
    n = cov.shape[0]
    w = np.full(n, 1.0 / n)
    step = 1.0 / (np.trace(cov) + 1e-12)
    for _ in range(500):
        w = w - step * (cov @ w)
        w = np.clip(w, 0.0, None)
        total = w.sum()
        w = w / total if total > 0 else np.full(n, 1.0 / n)
    return dict(zip(window.columns, w, strict=True))


def fixed(weights: dict[str, float]) -> WeightFn:
    def _fn(window: pd.DataFrame) -> dict[str, float]:
        return {s: weights.get(s, 0.0) for s in window.columns}

    return _fn


REGISTRY: dict[str, Theory] = {
    t.id: t
    for t in [
        Theory(
            id="buy_and_hold",
            name="Buy and hold, equal weight",
            claim="Doing nothing after the initial purchase beats most active rebalancing after costs.",
            weight_fn=buy_and_hold,
            rebalance="none",
            known_failure_mode="Weights drift toward whatever ran up most, silently concentrating risk.",
        ),
        Theory(
            id="equal_weight",
            name="Equal weight, rebalanced",
            claim="Periodic rebalancing to equal weight harvests a diversification premium.",
            weight_fn=equal_weight,
            known_failure_mode="Repeatedly sells the strongest asset; badly hurt by a single sustained trend.",
        ),
        Theory(
            id="inverse_vol",
            name="Inverse volatility",
            claim="Weighting by 1/vol produces a smoother ride than weighting by capital.",
            weight_fn=inverse_volatility,
            known_failure_mode="Piles into low-vol assets right before low-vol regimes break.",
        ),
        Theory(
            id="risk_parity",
            name="Risk parity (damped)",
            claim="Equalising risk contribution beats equalising capital on risk-adjusted return.",
            weight_fn=risk_parity,
            known_failure_mode="Assumes past vol predicts future vol; fails in correlation shocks where everything moves together.",
        ),
        Theory(
            id="min_variance",
            name="Minimum variance",
            claim="The lowest-variance long-only portfolio delivers better risk-adjusted return than the market.",
            weight_fn=min_variance,
            known_failure_mode="Covariance is estimated from a short window and is unstable; concentrates hard.",
        ),
        Theory(
            id="momentum",
            name="Cross-sectional momentum",
            claim="Recent relative winners keep outperforming over the next quarter.",
            weight_fn=momentum_tilt,
            known_failure_mode="Momentum crashes at sharp reversals; high turnover makes costs and taxes bite.",
        ),
    ]
}


def get(theory_id: str) -> Theory:
    if theory_id not in REGISTRY:
        raise KeyError(f"Unknown theory {theory_id!r}. Known: {', '.join(sorted(REGISTRY))}")
    return REGISTRY[theory_id]


def all_ids() -> list[str]:
    return sorted(REGISTRY)
