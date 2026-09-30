"""Risk and performance metrics computed directly from a return series.

Every number the portal shows traces back to a function here. No metric is
imported from a library whose assumptions we have not read.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass

import numpy as np
import pandas as pd

TRADING_DAYS = 252


@dataclass(frozen=True)
class Performance:
    total_return: float
    cagr: float
    volatility: float
    sharpe: float
    sortino: float
    max_drawdown: float
    calmar: float
    best_day: float
    worst_day: float
    positive_days: float
    periods: int

    def to_dict(self) -> dict[str, float]:
        return asdict(self)


def equity_curve(returns: pd.Series) -> pd.Series:
    return (1.0 + returns.fillna(0.0)).cumprod()


def drawdown_series(returns: pd.Series) -> pd.Series:
    curve = equity_curve(returns)
    return curve / curve.cummax() - 1.0


def max_drawdown(returns: pd.Series) -> float:
    if returns.empty:
        return 0.0
    return float(drawdown_series(returns).min())


def cagr(returns: pd.Series, periods_per_year: int = TRADING_DAYS) -> float:
    if returns.empty:
        return 0.0
    growth = float(equity_curve(returns).iloc[-1])
    years = len(returns) / periods_per_year
    if years <= 0 or growth <= 0:
        return 0.0
    return growth ** (1.0 / years) - 1.0


def volatility(returns: pd.Series, periods_per_year: int = TRADING_DAYS) -> float:
    if len(returns) < 2:
        return 0.0
    return float(returns.std(ddof=1) * np.sqrt(periods_per_year))


def sharpe(returns: pd.Series, risk_free: float = 0.0, periods_per_year: int = TRADING_DAYS) -> float:
    """Annualised Sharpe. `risk_free` is an annual rate, converted to per-period."""
    if len(returns) < 2:
        return 0.0
    excess = returns - risk_free / periods_per_year
    sd = excess.std(ddof=1)
    if sd == 0:
        return 0.0
    return float(excess.mean() / sd * np.sqrt(periods_per_year))


def sortino(returns: pd.Series, risk_free: float = 0.0, periods_per_year: int = TRADING_DAYS) -> float:
    """Like Sharpe but penalises only downside deviation."""
    if len(returns) < 2:
        return 0.0
    excess = returns - risk_free / periods_per_year
    downside = excess[excess < 0]
    if downside.empty:
        return 0.0
    dd = np.sqrt((downside**2).mean())
    if dd == 0:
        return 0.0
    return float(excess.mean() / dd * np.sqrt(periods_per_year))


def calmar(returns: pd.Series, periods_per_year: int = TRADING_DAYS) -> float:
    mdd = abs(max_drawdown(returns))
    if mdd == 0:
        return 0.0
    return cagr(returns, periods_per_year) / mdd


def summarize(returns: pd.Series, risk_free: float = 0.0, periods_per_year: int = TRADING_DAYS) -> Performance:
    returns = returns.dropna()
    if returns.empty:
        return Performance(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)
    return Performance(
        total_return=float(equity_curve(returns).iloc[-1] - 1.0),
        cagr=cagr(returns, periods_per_year),
        volatility=volatility(returns, periods_per_year),
        sharpe=sharpe(returns, risk_free, periods_per_year),
        sortino=sortino(returns, risk_free, periods_per_year),
        max_drawdown=max_drawdown(returns),
        calmar=calmar(returns, periods_per_year),
        best_day=float(returns.max()),
        worst_day=float(returns.min()),
        positive_days=float((returns > 0).mean()),
        periods=len(returns),
    )


def correlation_matrix(prices: pd.DataFrame) -> pd.DataFrame:
    return prices.pct_change().dropna(how="all").corr()
