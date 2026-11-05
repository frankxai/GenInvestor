"""Artifact writer — the seam between the Python engine and the Next.js portal.

The portal never imports Python and never computes a metric. It reads versioned
JSON written here. Every artifact carries its data source and its assumptions so
a synthetic-data result cannot be rendered as if it were real.
"""

from __future__ import annotations

import json
import platform
from datetime import UTC, datetime
from pathlib import Path

from . import policy
from .backtest import BacktestResult

SCHEMA_VERSION = "1.0.0"


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def write_study(
    out_dir: str | Path,
    study_id: str,
    results: list[BacktestResult],
    *,
    universe: list[str],
    start: str,
    end: str,
    config_id: str | None = None,
    backtestable_weight: float | None = None,
    validation: dict | None = None,
) -> Path:
    policy.require("artifact_write")

    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)

    sources = sorted({r.data_source for r in results})
    payload = {
        "schema_version": SCHEMA_VERSION,
        "study_id": study_id,
        "generated_at": _now(),
        "generated_on": platform.node(),
        "autonomy_mode": policy.ENGINE_CEILING.value,
        "data_sources": sources,
        "is_synthetic": all(s == "synthetic" for s in sources),
        "config_id": config_id,
        "coverage": {
            "universe": universe,
            "start": start,
            "end": end,
            "backtestable_weight": backtestable_weight,
        },
        "disclaimer": (
            "Simulation output for research and education. Not investment advice, "
            "not a recommendation, and not a prediction. Past or simulated performance "
            "does not indicate future results."
        ),
        "validation": validation,
        "results": [r.to_dict() for r in results],
        "leaderboard": [
            {
                "name": r.name,
                "cagr": r.performance.cagr,
                "volatility": r.performance.volatility,
                "sharpe": r.performance.sharpe,
                "sortino": r.performance.sortino,
                "max_drawdown": r.performance.max_drawdown,
                "calmar": r.performance.calmar,
                "turnover": r.turnover,
            }
            for r in sorted(results, key=lambda x: x.performance.sharpe, reverse=True)
        ],
    }

    path = out / f"{study_id}.json"
    path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    _update_index(out)
    return path


def _update_index(out: Path) -> None:
    studies = []
    for p in sorted(out.glob("*.json")):
        if p.name == "index.json":
            continue
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            continue
        validation = data.get("validation") or {}
        studies.append({
            "study_id": data.get("study_id", p.stem),
            "generated_at": data.get("generated_at"),
            "is_synthetic": data.get("is_synthetic", True),
            "config_id": data.get("config_id"),
            "validated": bool(validation),
            "verdict": validation.get("verdict"),
            "file": p.name,
        })
    (out / "index.json").write_text(
        json.dumps(
            {
                "schema_version": SCHEMA_VERSION,
                "updated_at": _now(),
                "studies": sorted(studies, key=lambda s: s["generated_at"] or "", reverse=True),
            },
            indent=2,
        ),
        encoding="utf-8",
    )
