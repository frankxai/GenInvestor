"""Price adapters.

`synthetic` is the default: deterministic, offline, zero dependencies beyond
numpy/pandas. It exists so the whole engine — backtests, theory comparisons,
tests, CI — runs identically on any machine with no network and no API key.

`yahoo` is opt-in and requires `yfinance`. Real prices are only ever pulled
deliberately, never as a side effect of running a backtest.
"""

from .base import PriceAdapter
from .synthetic import SyntheticAdapter

__all__ = ["PriceAdapter", "SyntheticAdapter", "get_adapter"]


def get_adapter(name: str = "synthetic", **kwargs) -> PriceAdapter:
    if name == "synthetic":
        return SyntheticAdapter(**kwargs)
    if name == "yahoo":
        from .yahoo import YahooAdapter  # imported lazily; optional dependency

        return YahooAdapter(**kwargs)
    if name == "tradingview":
        from .tradingview import TradingViewSnapshotAdapter

        return TradingViewSnapshotAdapter(**kwargs)
    raise ValueError(f"Unknown price adapter: {name!r}")
