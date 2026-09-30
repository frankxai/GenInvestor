"""Deterministic synthetic price generator.

Each symbol gets a drift/vol profile derived from a hash of its ticker, so the
same symbol always produces the same series on every machine. Crypto-style
tickers get fatter tails and higher vol; cash-like tickers barely move.

This is a test fixture and a teaching tool, not a market simulator. Results from
it say something about how a *strategy behaves*, never about how an asset will
perform. `artifacts.py` stamps every output with the adapter name so a synthetic
result can never be mistaken for a real one downstream.
"""

from __future__ import annotations

import hashlib
from collections.abc import Sequence

import numpy as np
import pandas as pd

TRADING_DAYS = 252


def _profile(symbol: str) -> tuple[float, float, float]:
    """(annual drift, annual vol, student-t df) derived deterministically from the ticker."""
    digest = hashlib.sha256(symbol.upper().encode()).digest()
    a, b, c = digest[0] / 255, digest[1] / 255, digest[2] / 255

    upper = symbol.upper()
    if any(k in upper for k in ("BTC", "ETH", "SOL", "-USD", "CRYPTO")):
        return 0.10 + a * 0.45, 0.55 + b * 0.45, 3.0 + c * 2.0
    if any(k in upper for k in ("CASH", "BIL", "SHV", "MMF")):
        return 0.015 + a * 0.02, 0.004 + b * 0.006, 30.0
    if any(k in upper for k in ("AGG", "BND", "IEF", "TLT", "BOND")):
        return 0.02 + a * 0.03, 0.05 + b * 0.06, 8.0
    if any(k in upper for k in ("GLD", "GOLD", "IAU")):
        return 0.03 + a * 0.05, 0.14 + b * 0.06, 6.0
    return 0.04 + a * 0.09, 0.13 + b * 0.14, 5.0 + c * 3.0


class SyntheticAdapter:
    name = "synthetic"

    def __init__(self, seed: int = 20260803, market_beta: float = 0.55) -> None:
        self.seed = seed
        self.market_beta = market_beta

    def prices(self, symbols: Sequence[str], start: str, end: str) -> pd.DataFrame:
        index = pd.bdate_range(start=start, end=end)
        n = len(index)
        if n == 0:
            raise ValueError(f"Empty date range: {start}..{end}")

        rng = np.random.default_rng(self.seed)
        # A shared market factor gives the symbols realistic positive correlation;
        # without it every diversification test looks far better than reality.
        market = rng.standard_t(df=5, size=n) / np.sqrt(5 / 3) * (0.11 / np.sqrt(TRADING_DAYS))

        data: dict[str, np.ndarray] = {}
        for symbol in symbols:
            drift, vol, df = _profile(symbol)
            sym_rng = np.random.default_rng(
                self.seed + int(hashlib.sha256(symbol.upper().encode()).hexdigest()[:8], 16)
            )
            idio = sym_rng.standard_t(df=df, size=n) / np.sqrt(df / (df - 2))
            daily_vol = vol / np.sqrt(TRADING_DAYS)
            beta = self.market_beta if vol < 0.5 else self.market_beta * 0.6
            shocks = beta * market + np.sqrt(max(1e-9, 1 - beta**2)) * idio * daily_vol
            mu = drift / TRADING_DAYS - 0.5 * daily_vol**2
            data[symbol] = 100.0 * np.exp(np.cumsum(mu + shocks))

        return pd.DataFrame(data, index=index)
