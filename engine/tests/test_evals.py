import json

import numpy as np
import pandas as pd
import pytest

from investor_engine import guardrails, policy, stress, theories
from investor_engine.data import get_adapter
from investor_engine.data.tradingview import TradingViewSnapshotAdapter

# --- guardrails: the gate must hold, and the eval must be able to fail -------

def test_guardrail_matrix_passes_on_the_real_gate():
    report = guardrails.run()
    assert report.passed, [f"{f.case}: want {f.expected} got {f.got}" for f in report.failures]
    assert report.total >= 30


def test_guardrail_matrix_covers_all_three_verdicts():
    seen = {c.expect for c in guardrails.CASES}
    assert seen == {policy.Verdict.ALLOW, policy.Verdict.HUMAN_GATE, policy.Verdict.BLOCKED}


def test_eval_catches_a_gate_that_allows_everything(monkeypatch):
    allow_all = policy.Decision(policy.Verdict.ALLOW, "sabotaged")
    monkeypatch.setattr(guardrails, "evaluate", lambda _action: allow_all)
    report = guardrails.run()
    assert not report.passed
    assert report.dangerous_allowed > 0


def test_eval_catches_a_gate_that_refuses_everything(monkeypatch):
    block_all = policy.Decision(policy.Verdict.BLOCKED, "sabotaged")
    monkeypatch.setattr(guardrails, "evaluate", lambda _action: block_all)
    report = guardrails.run()
    assert not report.passed
    assert report.safe_refused > 0


@pytest.mark.parametrize("mode", [policy.Mode.L3_HUMAN_APPROVED_DRAFT, policy.Mode.L4_SANDBOX_WALLET_FUTURE])
def test_require_refuses_modes_above_the_engine_ceiling(mode):
    with pytest.raises(policy.PolicyViolation, match="above the engine ceiling"):
        policy.require("research", mode=mode)


def test_require_still_allows_modes_at_or_below_the_ceiling():
    policy.require("research", mode=policy.Mode.L0_RESEARCH)
    policy.require("backtest", mode=policy.Mode.L2_SIMULATION)


# --- backtest execution timing ------------------------------------------------

def test_execution_lag_withholds_history_from_the_weight_decision():
    from investor_engine import backtest

    seen: list[pd.Timestamp] = []
    prices = stress.scenario_prices(stress.SCENARIOS["calm"], years=2)

    def spy(window):
        seen.append(window.index[-1])
        return {"EQUITY": 1.0}

    backtest.run(prices, spy, lookback=60, execution_lag=0)
    lag0 = list(seen)
    seen.clear()
    backtest.run(prices, spy, lookback=60, execution_lag=1)
    assert lag0 and len(lag0) == len(seen)
    positions = {d: i for i, d in enumerate(prices.index)}
    steps = [positions[a] - positions[b] for a, b in zip(lag0, seen, strict=True)]
    assert all(s in (0, 1) for s in steps), "a lag of one may only withhold one bar"
    assert sum(steps) >= len(steps) - 1, "every rebalance after the first bar must lose exactly one bar"


def test_execution_lag_rejects_negative_values():
    from investor_engine import backtest

    with pytest.raises(ValueError):
        backtest.run(stress.scenario_prices(stress.SCENARIOS["calm"], years=1), {"EQUITY": 1.0}, execution_lag=-1)


def test_committed_policy_contract_matches_the_engine():
    from investor_engine.cli import POLICY_CONTRACT

    committed = json.loads(POLICY_CONTRACT.read_text(encoding="utf-8"))
    assert committed == json.loads(json.dumps(guardrails.export_contract())), (
        "packages/contracts/policy/policy.json is stale: run `investor policy-export`"
    )


# --- stress scenarios ---------------------------------------------------------

def test_scenarios_are_deterministic_for_a_seed():
    a = stress.scenario_prices(stress.SCENARIOS["crash"], seed=3)
    b = stress.scenario_prices(stress.SCENARIOS["crash"], seed=3)
    pd.testing.assert_frame_equal(a, b)


def test_crash_scenario_produces_a_deep_equity_drawdown():
    prices = stress.scenario_prices(stress.SCENARIOS["crash"])
    assert (prices["EQUITY"] / prices["EQUITY"].cummax() - 1).min() < -0.30


def test_inflation_shock_breaks_stock_bond_diversification():
    calm = stress.scenario_prices(stress.SCENARIOS["calm"])
    shock = stress.scenario_prices(stress.SCENARIOS["inflation_shock"])
    bond_dd = lambda p: (p["BOND"] / p["BOND"].cummax() - 1).min()  # noqa: E731
    assert bond_dd(shock) < bond_dd(calm) - 0.10


def test_stress_covers_every_theory_in_every_scenario():
    rows = stress.run_stress()
    assert {r.scenario for r in rows} == set(stress.SCENARIOS)
    assert {r.theory for r in rows} == set(theories.all_ids())


def test_cash_heavy_theory_draws_down_less_than_equity_in_a_crash():
    rows = {(r.scenario, r.theory): r for r in stress.run_stress()}
    dds = {tid: rows[("crash", tid)].max_drawdown for tid in theories.all_ids()}
    equity_only = stress.backtest.run(
        stress.scenario_prices(stress.SCENARIOS["crash"]), {"EQUITY": 1.0}, name="all-equity"
    ).performance.max_drawdown
    assert min(dds.values()) > equity_only, "no theory should be worse-protected than 100% equity"


# --- monte carlo --------------------------------------------------------------

def _daily(mean=0.0004, sd=0.01, n=1500, seed=1):
    return pd.Series(np.random.default_rng(seed).normal(mean, sd, n))


def test_monte_carlo_is_deterministic():
    r = _daily()
    assert stress.monte_carlo(r, theory="t", paths=300) == stress.monte_carlo(r, theory="t", paths=300)


def test_monte_carlo_probabilities_are_ordered_and_bounded():
    est = stress.monte_carlo(_daily(), theory="t", paths=500)
    assert 0 <= est.p_drawdown_over_50 <= est.p_drawdown_over_30 <= 1
    assert est.p05_terminal <= est.median_terminal


def test_riskier_returns_show_higher_ruin_than_calmer_ones():
    calm = stress.monte_carlo(_daily(sd=0.005), theory="calm", paths=500)
    wild = stress.monte_carlo(_daily(sd=0.02), theory="wild", paths=500)
    assert wild.p_drawdown_over_30 > calm.p_drawdown_over_30


def test_monte_carlo_rejects_a_sample_too_short_to_bootstrap():
    with pytest.raises(ValueError):
        stress.monte_carlo(_daily(n=20), theory="t")


# --- tradingview snapshot adapter --------------------------------------------

def _write(dir_, symbol, bars):
    (dir_ / f"{symbol.replace(':', '_')}.json").write_text(
        json.dumps({"symbol": symbol, "bars": bars}), encoding="utf-8"
    )


def test_adapter_replays_snapshots_into_a_wide_frame(tmp_path):
    _write(tmp_path, "AMEX:SPY", [{"time": "2024-01-02", "close": 100}, {"time": "2024-01-03", "close": 101}])
    _write(tmp_path, "AMEX:GLD", [{"time": "2024-01-02", "close": 50}, {"time": "2024-01-03", "close": 49}])
    frame = get_adapter("tradingview", snapshot_dir=tmp_path).prices(
        ["AMEX:SPY", "AMEX:GLD"], "2024-01-01", "2024-12-31"
    )
    assert list(frame.columns) == ["AMEX:SPY", "AMEX:GLD"]
    assert frame.loc["2024-01-03", "AMEX:SPY"] == 101


def test_adapter_accepts_unix_second_timestamps(tmp_path):
    _write(tmp_path, "X", [{"time": 1704153600, "close": 10}, {"time": 1704240000, "close": 11}])
    frame = TradingViewSnapshotAdapter(tmp_path).prices(["X"], "2024-01-01", "2024-01-31")
    assert len(frame) == 2


@pytest.mark.parametrize(
    "bars",
    [
        [],
        [{"time": "2024-01-02", "close": 1}, {"time": "2024-01-02", "close": 2}],
        [{"time": "2024-01-02", "close": 0}],
        [{"time": "2024-01-02", "close": -3}],
    ],
)
def test_adapter_rejects_bad_snapshots(tmp_path, bars):
    _write(tmp_path, "BAD", bars)
    with pytest.raises(ValueError):
        TradingViewSnapshotAdapter(tmp_path).prices(["BAD"], "2024-01-01", "2024-12-31")


def test_adapter_fails_loudly_on_a_missing_snapshot(tmp_path):
    with pytest.raises(FileNotFoundError):
        TradingViewSnapshotAdapter(tmp_path).prices(["NOPE"], "2024-01-01", "2024-12-31")
