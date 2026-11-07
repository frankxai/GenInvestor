"""Rebalancing backtest.

Deliberately simple and readable: weights drift with prices between rebalance
dates, then snap back to target, paying a cost on the turnover. No leverage, no
shorting, no intraday. Every assumption that could flatter a result is listed on
the BacktestResult so it travels with the number.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from . import metrics, policy

Rebalance = str  # "none" | "M" | "Q" | "A"

_FREQ = {"M": "ME", "Q": "QE", "A": "YE"}


@dataclass
class BacktestResult:
    name: str
    returns: pd.Series
    weights: pd.DataFrame
    performance: metrics.Performance
    turnover: float
    cost_drag: float
    assumptions: list[str] = field(default_factory=list)
    data_source: str = "unknown"

    @property
    def equity(self) -> pd.Series:
        return metrics.equity_curve(self.returns)

    def to_dict(self, max_points: int = 520) -> dict:
        """Serialise for the portal. The curve is thinned to `max_points` — a chart
        cannot render 2,700 daily points distinguishably, and shipping them makes
        every study a 58k-line diff in git forever. Metrics are always computed on
        the full series; only the drawn line is thinned."""
        equity = self.equity
        drawdown = metrics.drawdown_series(self.returns)
        # ceiling division: floor would leave up to max_points + stride samples
        stride = max(1, -(-len(equity) // max_points))
        if stride > 1:
            # keep the final point so the curve ends where the metrics say it does
            keep = [*range(0, len(equity) - 1, stride), len(equity) - 1]
            equity = equity.iloc[keep]
            drawdown = drawdown.iloc[keep]

        return {
            "name": self.name,
            "data_source": self.data_source,
            "performance": self.performance.to_dict(),
            "turnover": self.turnover,
            "cost_drag": self.cost_drag,
            "assumptions": self.assumptions,
            "curve_stride_days": stride,
            "equity_curve": {
                "dates": [d.strftime("%Y-%m-%d") for d in equity.index],
                "values": [round(float(v), 6) for v in equity.values],
            },
            "drawdown": [round(float(v), 6) for v in drawdown.values],
        }


def _rebalance_dates(index: pd.DatetimeIndex, freq: Rebalance) -> set[pd.Timestamp]:
    if freq == "none":
        return {index[0]}
    alias = _FREQ.get(freq)
    if alias is None:
        raise ValueError(f"Unknown rebalance frequency: {freq!r}")
    marks = pd.Series(index=index, data=1).resample(alias).last().index
    dates = {index[0]}
    for mark in marks:
        candidates = index[index <= mark]
        if len(candidates):
            dates.add(candidates[-1])
    return dates


def run(
    prices: pd.DataFrame,
    target_weights: dict[str, float] | Callable[[pd.DataFrame], dict[str, float]],
    *,
    name: str = "strategy",
    rebalance: Rebalance = "Q",
    cost_bps: float = 10.0,
    lookback: int = 126,
    data_source: str = "unknown",
    execution_lag: int = 0,
) -> BacktestResult:
    """Run a long-only, fully-invested backtest.

    `target_weights` may be a fixed mapping or a callable receiving the trailing
    price window — that callable form is what makes a theory dynamic.

    `execution_lag` bars of history are withheld from the weight decision. At 0
    the weights are chosen from the close they are then traded at, an optimistic
    convention; 1 is the conservative one. Use it to measure how much a result
    depends on that assumption, on real prices: random-walk data cannot show it.
    """
    if execution_lag < 0:
        raise ValueError("execution_lag cannot be negative.")
    policy.require("backtest")

    prices = prices.dropna(how="all").ffill().dropna()
    if len(prices) < 2:
        raise ValueError("Need at least two price observations.")

    asset_returns = prices.pct_change().fillna(0.0)
    symbols = list(prices.columns)
    rebal = _rebalance_dates(prices.index, rebalance)

    weights = np.zeros(len(symbols))
    weight_history = np.zeros((len(prices), len(symbols)))
    port_returns = np.zeros(len(prices))
    total_turnover = 0.0
    total_cost = 0.0

    for i, date in enumerate(prices.index):
        if i > 0:
            step = asset_returns.iloc[i].to_numpy()
            grown = weights * (1.0 + step)
            gross = grown.sum()
            port_returns[i] = gross - 1.0 if weights.sum() > 0 else 0.0
            weights = grown / gross if gross > 0 else grown

        if date in rebal:
            if callable(target_weights):
                end = i + 1 - execution_lag
                window = prices.iloc[max(0, end - lookback) : max(end, 1)]
                target = target_weights(window)
            else:
                target = target_weights
            new = np.array([float(target.get(s, 0.0)) for s in symbols])
            total = new.sum()
            new = new / total if total > 0 else new

            turnover = float(np.abs(new - weights).sum()) / 2.0
            cost = turnover * cost_bps / 10_000.0
            port_returns[i] -= cost
            total_turnover += turnover
            total_cost += cost
            weights = new

        weight_history[i] = weights

    returns = pd.Series(port_returns, index=prices.index, name=name)
    returns.iloc[0] = -total_cost if len(rebal) == 1 else returns.iloc[0]

    return BacktestResult(
        name=name,
        returns=returns,
        weights=pd.DataFrame(weight_history, index=prices.index, columns=symbols),
        performance=metrics.summarize(returns),
        turnover=total_turnover,
        cost_drag=total_cost,
        data_source=data_source,
        assumptions=[
            f"Rebalanced {rebalance}, {cost_bps:.0f} bps cost on turnover.",
            "Long-only, fully invested, no leverage or shorting.",
            "No taxes, dividends assumed reinvested in the price series.",
            "No slippage, no liquidity limits, no bid-ask spread beyond the flat cost.",
            "Survivorship: the symbol list is fixed for the whole window.",
            f"Prices from the '{data_source}' adapter.",
        ],
    )


def compare(results: list[BacktestResult]) -> pd.DataFrame:
    rows = {r.name: r.performance.to_dict() for r in results}
    return pd.DataFrame(rows).T.sort_values("sharpe", ascending=False)
