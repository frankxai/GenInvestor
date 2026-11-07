from __future__ import annotations

from collections.abc import Sequence
from typing import Protocol

import pandas as pd


class PriceAdapter(Protocol):
    """Returns a wide DataFrame: DatetimeIndex rows, one column per symbol, adjusted close."""

    name: str

    def prices(self, symbols: Sequence[str], start: str, end: str) -> pd.DataFrame: ...
