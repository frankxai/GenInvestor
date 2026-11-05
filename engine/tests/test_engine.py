from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from investor_engine import backtest, metrics, policy, theories, universe
from investor_engine.data import get_adapter

CONFIG_DIR = Path(__file__).resolve().parents[1] / "configs" / "sleeves"


# --- policy: the gate must fail closed -------------------------------------

@pytest.mark.parametrize("action", ["live_trade", "transfer", "wallet_sign", "draft_order"])
def test_capital_moving_actions_are_never_allowed(action):
    assert not policy.evaluate(policy.Action(action_type=action)).allowed


@pytest.mark.parametrize("action", ["real_autonomous_execution", "store_private_key", "store_seed_phrase"])
def test_hard_blocked_actions_are_blocked_not_gated(action):
    assert policy.evaluate(policy.Action(action_type=action)).verdict is policy.Verdict.BLOCKED


def test_research_actions_are_allowed_at_ceiling():
    for action in ("backtest", "paper_trade", "theory_test", "artifact_write"):
        assert policy.evaluate(policy.Action(action_type=action)).allowed


def test_real_funds_flag_gates_even_an_allowed_action_type():
    decision = policy.evaluate(policy.Action(action_type="backtest", uses_real_funds=True))
    assert decision.verdict is policy.Verdict.HUMAN_GATE


def test_require_raises_on_violation():
    with pytest.raises(policy.PolicyViolation):
        policy.require("live_trade")


def test_amount_over_cap_fails_closed():
    decision = policy.evaluate(policy.Action(action_type="backtest", amount=100, cap=10))
    assert decision.verdict is policy.Verdict.HUMAN_GATE


# --- metrics: check against hand-computable cases ---------------------------

def test_zero_returns_produce_zero_metrics():
    r = pd.Series([0.0] * 100, index=pd.bdate_range("2024-01-01", periods=100))
    perf = metrics.summarize(r)
    assert perf.total_return == pytest.approx(0.0)
    assert perf.volatility == pytest.approx(0.0)
    assert perf.max_drawdown == pytest.approx(0.0)


def test_cagr_recovers_a_known_doubling():
    # exactly 252 periods of constant growth that doubles the series
    daily = 2 ** (1 / 252) - 1
    r = pd.Series([daily] * 252, index=pd.bdate_range("2024-01-01", periods=252))
    assert metrics.cagr(r) == pytest.approx(1.0, rel=1e-6)


def test_max_drawdown_matches_manual_calculation():
    r = pd.Series([0.5, -0.5, 0.0], index=pd.bdate_range("2024-01-01", periods=3))
    # curve: 1.5, 0.75 -> peak 1.5, trough 0.75 => -50%
    assert metrics.max_drawdown(r) == pytest.approx(-0.5)


def test_sortino_ignores_upside_volatility():
    up = pd.Series([0.01, 0.02, 0.01, 0.03] * 20, index=pd.bdate_range("2024-01-01", periods=80))
    assert metrics.sortino(up) == 0.0  # no downside deviation at all


# --- data: determinism is the whole point of the synthetic adapter ----------

def test_synthetic_adapter_is_deterministic():
    a = get_adapter("synthetic").prices(["VTI", "AGG"], "2020-01-01", "2021-01-01")
    b = get_adapter("synthetic").prices(["VTI", "AGG"], "2020-01-01", "2021-01-01")
    pd.testing.assert_frame_equal(a, b)


def test_synthetic_crypto_is_more_volatile_than_bonds():
    px = get_adapter("synthetic").prices(["BTC-USD", "AGG"], "2018-01-01", "2026-01-01")
    rets = px.pct_change().dropna()
    assert rets["BTC-USD"].std() > rets["AGG"].std() * 5


# --- backtest ---------------------------------------------------------------

@pytest.fixture
def prices():
    return get_adapter("synthetic").prices(["VTI", "VXUS", "AGG", "BIL"], "2016-01-01", "2026-01-01")


def test_single_asset_backtest_tracks_that_asset(prices):
    res = backtest.run(prices[["VTI"]], {"VTI": 1.0}, rebalance="none", cost_bps=0.0)
    expected = prices["VTI"].iloc[-1] / prices["VTI"].iloc[0] - 1.0
    assert res.performance.total_return == pytest.approx(expected, rel=1e-6)


def test_costs_reduce_return(prices):
    free = backtest.run(prices, {"VTI": 0.5, "AGG": 0.5}, rebalance="M", cost_bps=0.0)
    pricey = backtest.run(prices, {"VTI": 0.5, "AGG": 0.5}, rebalance="M", cost_bps=100.0)
    assert pricey.performance.total_return < free.performance.total_return


def test_buy_and_hold_has_lower_turnover_than_monthly_rebalance(prices):
    hold = backtest.run(prices, theories.get("equal_weight").weight_fn, rebalance="none")
    monthly = backtest.run(prices, theories.get("equal_weight").weight_fn, rebalance="M")
    assert hold.turnover < monthly.turnover


def test_weights_stay_normalised(prices):
    res = backtest.run(prices, theories.get("risk_parity").weight_fn, rebalance="Q")
    sums = res.weights.sum(axis=1)
    assert np.allclose(sums, 1.0, atol=1e-8)


def test_no_negative_weights_from_min_variance(prices):
    res = backtest.run(prices, theories.get("min_variance").weight_fn, rebalance="Q")
    assert (res.weights.to_numpy() >= -1e-9).all()


def test_result_carries_its_assumptions(prices):
    res = backtest.run(prices, {"VTI": 1.0}, data_source="synthetic")
    assert res.assumptions
    assert any("synthetic" in a for a in res.assumptions)


@pytest.mark.parametrize("theory_id", theories.all_ids())
def test_every_registered_theory_runs(prices, theory_id):
    t = theories.get(theory_id)
    res = backtest.run(prices, t.weight_fn, name=t.name, rebalance=t.rebalance)
    assert res.performance.periods == len(prices)
    assert t.known_failure_mode, "a theory without a stated failure mode is marketing"


# --- configs ----------------------------------------------------------------

@pytest.mark.parametrize("path", sorted(CONFIG_DIR.glob("*.json")), ids=lambda p: p.stem)
def test_shipped_configs_are_valid(path):
    assert universe.load_config(path).validate() == []


def test_illiquid_sleeves_are_excluded_from_backtest_weights():
    cfg = universe.load_config(CONFIG_DIR / "operator-barbell.json")
    assert cfg.backtestable_weight < 1.0
    symbols = cfg.weights_by_symbol()
    assert symbols and abs(sum(symbols.values()) - 1.0) < 1e-9


def test_every_sleeve_states_a_rationale():
    for path in CONFIG_DIR.glob("*.json"):
        for sleeve in universe.load_config(path).sleeves:
            assert len(sleeve.rationale) > 40, f"{path.stem}/{sleeve.id} rationale is too thin"
