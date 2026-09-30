"""GenInvestor Engine — research, backtest, and paper-trade substrate.

Ceiling is L2_SIMULATION. Nothing in this package can place an order, move
funds, or touch a wallet; those paths are blocked in `policy.py` and there is no
brokerage client to blocked-import in the first place.
"""

from . import artifacts, backtest, metrics, policy, theories, universe, validation
from .policy import ENGINE_CEILING, Mode, PolicyViolation, Verdict

__version__ = "0.2.0"

__all__ = [
    "ENGINE_CEILING",
    "Mode",
    "PolicyViolation",
    "Verdict",
    "__version__",
    "artifacts",
    "backtest",
    "metrics",
    "policy",
    "theories",
    "universe",
    "validation",
]
