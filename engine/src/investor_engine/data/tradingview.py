"""Prices from TradingView MCP OHLCV snapshots.

The engine never calls the MCP itself: an agent fetches bars through the
read-only `mcp-tradingview` server and writes one snapshot file per symbol, and
this adapter replays those files. That keeps every study re-runnable, which a
live feed is not.

Snapshot format (one JSON file per symbol, `<dir>/<SYMBOL>.json`, ':' -> '_'):
    {"symbol": "AMEX:SPY", "fetched_at": "2026-09-29T12:00:00Z",
     "bars": [{"time": "2024-01-02", "close": 471.2}, ...]}
`time` may be an ISO date or a unix timestamp (seconds). Field names on the live
server response are unverified until it is authenticated; normalise into this
shape at the fetch step rather than loosening the parser here.
"""

from __future__ import annotations

import json
from collections.abc import Sequence
from pathlib import Path

import pandas as pd

SNAPSHOT_DIR = Path(__file__).resolve().parents[3] / ".cache" / "tradingview"


class TradingViewSnapshotAdapter:
    name = "tradingview"

    def __init__(self, snapshot_dir: Path | None = None) -> None:
        self.snapshot_dir = Path(snapshot_dir) if snapshot_dir else SNAPSHOT_DIR

    def _load(self, symbol: str) -> pd.Series:
        path = self.snapshot_dir / f"{symbol.replace(':', '_')}.json"
        if not path.exists():
            raise FileNotFoundError(f"No TradingView snapshot for {symbol!r} at {path}")
        payload = json.loads(path.read_text(encoding="utf-8"))
        bars = payload.get("bars")
        if not bars:
            raise ValueError(f"Snapshot for {symbol!r} has no bars")
        times = [b["time"] for b in bars]
        unit = "s" if isinstance(times[0], int | float) else None
        index = pd.to_datetime(times, unit=unit).normalize()
        series = pd.Series([float(b["close"]) for b in bars], index=index, name=symbol)
        if series.index.has_duplicates:
            raise ValueError(f"Snapshot for {symbol!r} has duplicate timestamps")
        if (series <= 0).any():
            raise ValueError(f"Snapshot for {symbol!r} has non-positive closes")
        return series.sort_index()

    def prices(self, symbols: Sequence[str], start: str, end: str) -> pd.DataFrame:
        frame = pd.concat([self._load(s) for s in symbols], axis=1)
        return frame.loc[start:end].dropna(how="all")
