"""Autonomy gate. Its data is exported to packages/contracts/policy/policy.json and checked against the TypeScript gate.

The ceiling is L2_SIMULATION: research, strategy, backtest, paper trade.
Anything that could move real capital fails closed. This module is imported by
every entry point in the engine so there is no code path that skips it.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum


class Mode(StrEnum):
    L0_RESEARCH = "L0_RESEARCH"
    L1_STRATEGY = "L1_STRATEGY"
    L2_SIMULATION = "L2_SIMULATION"
    L3_HUMAN_APPROVED_DRAFT = "L3_HUMAN_APPROVED_DRAFT"
    L4_SANDBOX_WALLET_FUTURE = "L4_SANDBOX_WALLET_FUTURE"
    L5_REAL_AUTONOMY_EXCLUDED = "L5_REAL_AUTONOMY_EXCLUDED"


class Verdict(StrEnum):
    ALLOW = "allow"
    HUMAN_GATE = "human_gate"
    BLOCKED = "blocked"


# The ceiling this engine is built to. Raising it is a deliberate, reviewed act,
# not a config toggle — L3 additionally requires a broker linkage that does not exist.
ENGINE_CEILING = Mode.L2_SIMULATION

_ALLOWED_BY_MODE: dict[Mode, frozenset[str]] = {
    Mode.L0_RESEARCH: frozenset({"research"}),
    Mode.L1_STRATEGY: frozenset({
        "research",
        "strategy_memo",
        "risk_register",
        "allocation_review",
        "education_brief",
    }),
    Mode.L2_SIMULATION: frozenset({
        "research",
        "strategy_memo",
        "risk_register",
        "allocation_review",
        "education_brief",
        "backtest",
        "paper_trade",
        "theory_test",
        "rebalance_simulation",
        "artifact_write",
    }),
    Mode.L3_HUMAN_APPROVED_DRAFT: frozenset({"draft_order", "draft_transfer"}),
}

_HARD_BLOCKED = frozenset({
    "real_autonomous_execution",
    "store_secret",
    "store_seed_phrase",
    "store_private_key",
    "bypass_human_approval",
    "raw_account_export_git",
})

_HUMAN_GATE = frozenset({
    "live_trade",
    "transfer",
    "wallet_sign",
    "custody_change",
    "brokerage_key_change",
    "exchange_key_change",
    "legal_tax_compliance",
    "draft_order",
    "draft_transfer",
    "publish_private",
})


@dataclass(frozen=True)
class Decision:
    verdict: Verdict
    reason: str
    required_gate: str | None = None

    @property
    def allowed(self) -> bool:
        return self.verdict is Verdict.ALLOW


@dataclass(frozen=True)
class Action:
    action_type: str
    mode: Mode = ENGINE_CEILING
    uses_real_funds: bool = False
    touches_wallet: bool = False
    touches_banking: bool = False
    requires_secret: bool = False
    amount: float | None = None
    cap: float | None = None


def evaluate(action: Action) -> Decision:
    if action.mode is Mode.L5_REAL_AUTONOMY_EXCLUDED:
        return Decision(Verdict.BLOCKED, "Real autonomous capital movement is excluded.", "stop")

    if action.mode is Mode.L4_SANDBOX_WALLET_FUTURE:
        return Decision(Verdict.BLOCKED, "Sandbox wallet mode is reserved for future gated work.", "stop")

    if action.action_type in _HARD_BLOCKED:
        return Decision(Verdict.BLOCKED, f"Action is hard-blocked: {action.action_type}", "stop")

    if action.requires_secret:
        return Decision(Verdict.BLOCKED, "Secrets and wallet recovery material cannot enter the engine.", "stop")

    if (
        action.uses_real_funds
        or action.touches_wallet
        or action.touches_banking
        or action.action_type in _HUMAN_GATE
    ):
        return Decision(
            Verdict.HUMAN_GATE,
            "Live-money, wallet, banking, or custody-adjacent action requires human control.",
            "human",
        )

    if _cap_invalid(action):
        return Decision(Verdict.HUMAN_GATE, "Missing or invalid cap fails closed.", "human")

    if action.action_type in _ALLOWED_BY_MODE.get(action.mode, frozenset()):
        return Decision(Verdict.ALLOW, "Action is inside the current autonomy mode.")

    return Decision(
        Verdict.HUMAN_GATE,
        f"Action is outside current autonomy mode: {action.action_type}",
        "human",
    )


def _cap_invalid(action: Action) -> bool:
    if action.amount is None and action.cap is None:
        return False
    if action.amount is None or action.cap is None:
        return True
    return action.amount > action.cap


def table() -> dict:
    """The gate's data, for the shared contract file that other languages load."""
    return {
        "ceiling": ENGINE_CEILING.value,
        "modes": [m.value for m in Mode],
        "allowedByMode": {m.value: sorted(v) for m, v in _ALLOWED_BY_MODE.items()},
        "hardBlocked": sorted(_HARD_BLOCKED),
        "humanGate": sorted(_HUMAN_GATE),
    }


class PolicyViolation(RuntimeError):
    pass


def require(action_type: str, **kwargs) -> Decision:
    """Assert an action is permitted, or raise. Every engine entry point calls this.

    `evaluate` is a pure verdict for any mode. This entry point additionally
    refuses any mode above ENGINE_CEILING, so raising the ceiling stays a code
    change rather than something a caller can pass in.
    """
    action = Action(action_type=action_type, **kwargs)
    modes = list(Mode)
    if modes.index(action.mode) > modes.index(ENGINE_CEILING):
        raise PolicyViolation(
            f"[blocked] {action_type}: mode {action.mode.value} is above the engine ceiling "
            f"{ENGINE_CEILING.value}"
        )
    decision = evaluate(action)
    if not decision.allowed:
        raise PolicyViolation(f"[{decision.verdict.value}] {action_type}: {decision.reason}")
    return decision
