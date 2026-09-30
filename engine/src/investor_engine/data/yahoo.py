"""Real adjusted-close prices via yfinance.

Opt-in: `uv pip install -e ".[market]"`. Results are cached to disk because the
upstream is rate-limited and unversioned — a study you cannot re-run is not a
study. Cache files are keyed by symbol+range and are gitignored.
"""

from __future__ import annotations

import contextlib
import hashlib
from collections.abc import Sequence
from pathlib import Path

import pandas as pd

CACHE_DIR = Path(__file__).resolve().parents[3] / ".cache" / "prices"


class YahooAdapter:
    name = "yahoo"

    def __init__(self, cache: bool = True, cache_dir: Path | None = None) -> None:
        self.cache = cache
        self.cache_dir = cache_dir or CACHE_DIR

    def _cache_path(self, symbols: Sequence[str], start: str, end: str) -> Path:
        key = hashlib.sha256("|".join([*sorted(symbols), start, end]).encode()).hexdigest()[:16]
        return self.cache_dir / f"{key}.parquet"

    def prices(self, symbols: Sequence[str], start: str, end: str) -> pd.DataFrame:
        symbols = list(symbols)
        path = self._cache_path(symbols, start, end)

        if self.cache and path.exists():
            return pd.read_parquet(path)

        try:
            import yfinance
        except ImportError as exc:  # pragma: no cover - depends on optional extra
            raise ImportError(
                "The yahoo adapter needs yfinance. Install with: uv pip install -e \".[market]\""
            ) from exc

        raw = yfinance.download(
            tickers=symbols,
            start=start,
            end=end,
            auto_adjust=True,
            progress=False,
            group_by="column",
        )
        if raw is None or raw.empty:
            raise RuntimeError(f"No price data returned for {symbols} over {start}..{end}.")

        close = raw["Close"] if isinstance(raw.columns, pd.MultiIndex) else raw[["Close"]]
        if isinstance(close, pd.Series):
            close = close.to_frame(symbols[0])
        close.columns = [str(c) for c in close.columns]

        missing = [s for s in symbols if s not in close.columns]
        if missing:
            raise RuntimeError(f"Symbols returned no data: {missing}")

        frame = close[symbols].dropna(how="all").ffill().dropna()
        if frame.empty:
            raise RuntimeError("All rows dropped after alignment — check symbols and date range.")

        if self.cache:
            self.cache_dir.mkdir(parents=True, exist_ok=True)
            # parquet engine absent is fine; fetching still works, just uncached
            with contextlib.suppress(ImportError, ValueError):
                frame.to_parquet(path)

        return frame
