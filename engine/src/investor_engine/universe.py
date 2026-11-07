"""Asset-class taxonomy and sleeve definitions.

A *sleeve* is one bucket of capital with its own mandate, liquidity profile, and
data source. The portfolio is a set of sleeves, not a flat list of tickers —
that is what lets crypto, an angel position, and a house coexist in one model
without pretending they share a risk language.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from enum import StrEnum
from pathlib import Path


class AssetClass(StrEnum):
    EQUITY = "equity"           # stocks, ETFs, index funds
    CRYPTO = "crypto"
    PRIVATE = "private"         # angel, startup equity, SAFEs, fund LP
    REAL_ASSET = "real_asset"   # real estate, physical
    CASH = "cash"               # cash, money market, short bonds
    BUSINESS = "business"       # equity in your own operating businesses


class Liquidity(StrEnum):
    T0 = "t0"           # same day
    T2 = "t2"           # settles in days
    MONTHS = "months"
    ILLIQUID = "illiquid"   # years, or only on an exit event


class Markable(StrEnum):
    """How honestly can this sleeve be priced?"""
    MARKET = "market"       # continuous public price
    APPRAISAL = "appraisal"  # periodic estimate — real estate, private rounds
    BOOK = "book"            # carried at cost until an event


@dataclass(frozen=True)
class Sleeve:
    id: str
    name: str
    asset_class: AssetClass
    target_weight: float
    liquidity: Liquidity
    markable: Markable
    rationale: str
    holdings: dict[str, float] = field(default_factory=dict)
    benchmark: str | None = None

    @property
    def is_backtestable(self) -> bool:
        """Only market-priced sleeves can be honestly backtested."""
        return self.markable is Markable.MARKET


@dataclass(frozen=True)
class AllocationConfig:
    id: str
    name: str
    description: str
    horizon_years: int
    sleeves: list[Sleeve]

    def validate(self) -> list[str]:
        problems: list[str] = []
        total = sum(s.target_weight for s in self.sleeves)
        if abs(total - 1.0) > 1e-6:
            problems.append(f"target weights sum to {total:.4f}, expected 1.0")
        ids = [s.id for s in self.sleeves]
        if len(ids) != len(set(ids)):
            problems.append("duplicate sleeve ids")
        for s in self.sleeves:
            if s.target_weight < 0:
                problems.append(f"sleeve {s.id} has negative weight")
            if s.holdings and abs(sum(s.holdings.values()) - 1.0) > 1e-6:
                problems.append(f"sleeve {s.id} holdings do not sum to 1.0")
        return problems

    @property
    def backtestable_weight(self) -> float:
        """Share of the portfolio a price-based backtest can actually speak to."""
        return sum(s.target_weight for s in self.sleeves if s.is_backtestable)

    def weights_by_symbol(self) -> dict[str, float]:
        """Flatten backtestable sleeves into portfolio-level symbol weights."""
        out: dict[str, float] = {}
        for sleeve in self.sleeves:
            if not sleeve.is_backtestable or not sleeve.holdings:
                continue
            for symbol, share in sleeve.holdings.items():
                out[symbol] = out.get(symbol, 0.0) + sleeve.target_weight * share
        total = sum(out.values())
        if total > 0:
            out = {k: v / total for k, v in out.items()}
        return out


def load_config(path: str | Path) -> AllocationConfig:
    raw = json.loads(Path(path).read_text(encoding="utf-8"))
    sleeves = [
        Sleeve(
            id=s["id"],
            name=s["name"],
            asset_class=AssetClass(s["asset_class"]),
            target_weight=float(s["target_weight"]),
            liquidity=Liquidity(s["liquidity"]),
            markable=Markable(s["markable"]),
            rationale=s["rationale"],
            holdings=s.get("holdings", {}),
            benchmark=s.get("benchmark"),
        )
        for s in raw["sleeves"]
    ]
    return AllocationConfig(
        id=raw["id"],
        name=raw["name"],
        description=raw["description"],
        horizon_years=int(raw["horizon_years"]),
        sleeves=sleeves,
    )


def load_all(directory: str | Path) -> dict[str, AllocationConfig]:
    return {p.stem: load_config(p) for p in sorted(Path(directory).glob("*.json"))}
