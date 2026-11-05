"""Regime stress simulations and Monte Carlo ruin estimates.

Walk-forward validation asks "did the winner survive out of sample". This module
asks the question a cautious owner asks first: "what does each theory do in the
worst weeks I can imagine, and how often does it end below where it started".

Scenarios are seeded, synthetic and explicit about their shape. They measure how
allocation *mechanics* behave under a stated shock. They are not forecasts and
say nothing about real assets.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

from . import backtest, policy, theories

# symbol -> (annual drift, annual vol). Deliberately generic asset roles.
BASELINE_ASSETS: dict[str, tuple[float, float]] = {
    "EQUITY": (0.08, 0.16),
    "INTL": (0.07, 0.18),
    "BOND": (0.03, 0.05),
    "CASH": (0.02, 0.002),
    "GOLD": (0.04, 0.14),
}

_DAYS = 252


@dataclass(frozen=True)
class Scenario:
    id: str
    description: str
    # per-asset (shock_start_frac, shock_len_days, total_shock_return) applied on top of the base path
    shocks: dict[str, tuple[float, int, float]]
    vol_multiplier: float = 1.0
    drift_override: dict[str, float] | None = None


SCENARIOS: dict[str, Scenario] = {
    "calm": Scenario("calm", "Baseline drift and volatility, no shock.", {}),
    "crash": Scenario(
        "crash",
        "Equities lose 35% in 30 days, bonds and gold rise as havens.",
        {"EQUITY": (0.4, 30, -0.35), "INTL": (0.4, 30, -0.38), "BOND": (0.4, 30, 0.05), "GOLD": (0.4, 30, 0.08)},
        vol_multiplier=1.6,
    ),
    "inflation_shock": Scenario(
        "inflation_shock",
        "Stocks and bonds fall together, the diversification most portfolios lean on fails.",
        {"EQUITY": (0.3, 120, -0.22), "INTL": (0.3, 120, -0.24), "BOND": (0.3, 120, -0.15), "GOLD": (0.3, 120, 0.12)},
        vol_multiplier=1.3,
    ),
    "lost_decade": Scenario(
        "lost_decade",
        "Ten years of near-zero equity drift with elevated volatility.",
        {},
        vol_multiplier=1.4,
        drift_override={"EQUITY": 0.0, "INTL": -0.005, "BOND": 0.02, "CASH": 0.02, "GOLD": 0.03},
    ),
    "whipsaw": Scenario(
        "whipsaw",
        "Repeated sharp reversals that punish trend and momentum rules.",
        {},
        vol_multiplier=2.0,
        drift_override={"EQUITY": 0.0, "INTL": 0.0, "BOND": 0.02, "CASH": 0.02, "GOLD": 0.0},
    ),
}


def scenario_prices(scenario: Scenario, years: int = 10, seed: int = 7) -> pd.DataFrame:
    n = years * _DAYS
    rng = np.random.default_rng(seed)
    index = pd.bdate_range("2016-01-04", periods=n)
    cols: dict[str, np.ndarray] = {}
    for symbol, (drift, vol) in BASELINE_ASSETS.items():
        drift = (scenario.drift_override or {}).get(symbol, drift)
        sigma = vol * scenario.vol_multiplier if symbol != "CASH" else vol
        daily = rng.normal(drift / _DAYS, sigma / np.sqrt(_DAYS), n)
        if scenario.id == "whipsaw" and symbol in ("EQUITY", "INTL", "GOLD"):
            daily = daily * np.where((np.arange(n) // 20) % 2 == 0, 1.0, -1.0)
        if symbol in scenario.shocks:
            start_frac, length, total = scenario.shocks[symbol]
            start = int(n * start_frac)
            daily[start : start + length] = (1 + total) ** (1 / length) - 1
        cols[symbol] = 100 * np.cumprod(1 + daily)
    return pd.DataFrame(cols, index=index)


@dataclass(frozen=True)
class StressRow:
    scenario: str
    theory: str
    total_return: float
    max_drawdown: float
    worst_day: float
    recovered: bool


def run_stress(theory_ids: list[str] | None = None, *, seed: int = 7, cost_bps: float = 10.0) -> list[StressRow]:
    policy.require("backtest")
    rows: list[StressRow] = []
    for scenario in SCENARIOS.values():
        prices = scenario_prices(scenario, seed=seed)
        for tid in theory_ids or theories.all_ids():
            theory = theories.get(tid)
            result = backtest.run(
                prices,
                theory.weight_fn,
                name=tid,
                rebalance=theory.rebalance,
                cost_bps=cost_bps,
                data_source=f"stress:{scenario.id}",
            )
            equity = result.equity
            recovered = bool(equity.iloc[-1] >= equity.cummax().iloc[-1] * 0.999)
            rows.append(
                StressRow(
                    scenario.id,
                    tid,
                    result.performance.total_return,
                    result.performance.max_drawdown,
                    result.performance.worst_day,
                    recovered,
                )
            )
    return rows


@dataclass(frozen=True)
class RuinEstimate:
    theory: str
    paths: int
    p_loss: float
    p_drawdown_over_30: float
    p_drawdown_over_50: float
    median_terminal: float
    p05_terminal: float


def monte_carlo(
    returns: pd.Series,
    *,
    theory: str,
    paths: int = 2000,
    horizon_days: int = 5 * _DAYS,
    block: int = 21,
    seed: int = 11,
) -> RuinEstimate:
    """Stationary-style block bootstrap of a strategy's own daily returns.

    Blocks preserve short-run clustering; resampling is with replacement, so the
    estimate reflects the sample's distribution, not a prediction. A short sample
    understates tails and this output should be read with that in mind.
    """
    policy.require("theory_test")
    r = returns.to_numpy()
    if len(r) < block * 2:
        raise ValueError("Need at least two blocks of returns to bootstrap.")
    rng = np.random.default_rng(seed)
    n_blocks = -(-horizon_days // block)
    starts = rng.integers(0, len(r) - block, size=(paths, n_blocks))
    offsets = np.arange(block)
    sampled = r[(starts[:, :, None] + offsets).reshape(paths, -1)][:, :horizon_days]
    equity = np.cumprod(1 + sampled, axis=1)
    drawdown = 1 - equity / np.maximum.accumulate(equity, axis=1)
    max_dd = drawdown.max(axis=1)
    terminal = equity[:, -1]
    return RuinEstimate(
        theory=theory,
        paths=paths,
        p_loss=float((terminal < 1).mean()),
        p_drawdown_over_30=float((max_dd > 0.30).mean()),
        p_drawdown_over_50=float((max_dd > 0.50).mean()),
        median_terminal=float(np.median(terminal)),
        p05_terminal=float(np.percentile(terminal, 5)),
    )


def summarize_stress(rows: list[StressRow]) -> pd.DataFrame:
    frame = pd.DataFrame([r.__dict__ for r in rows])
    return frame.pivot(index="theory", columns="scenario", values="max_drawdown").round(4)


__all__ = [
    "SCENARIOS",
    "RuinEstimate",
    "Scenario",
    "StressRow",
    "monte_carlo",
    "run_stress",
    "scenario_prices",
    "summarize_stress",
]
