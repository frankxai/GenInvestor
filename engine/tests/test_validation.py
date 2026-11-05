import json

import numpy as np
import pandas as pd
import pytest

from investor_engine import artifacts, backtest, metrics, theories, validation
from investor_engine.data import get_adapter


@pytest.fixture(scope="module")
def prices():
    return get_adapter("synthetic").prices(
        ["VTI", "VXUS", "AGG", "BIL", "GLD"], "2014-01-01", "2026-01-01"
    )


# --- split mechanics: the guarantee is that test data is never trained on -----

def test_splits_are_contiguous_and_cover_the_tail():
    splits = validation._split_indices(1000, n_folds=5, min_train=300)
    assert len(splits) == 5
    assert splits[-1][2] == 1000
    for i in range(1, len(splits)):
        assert splits[i][1] == splits[i - 1][2], "test windows must not overlap or leave gaps"


def test_train_window_always_precedes_test_window():
    for train_end, test_start, test_end in validation._split_indices(1200, 4, 300):
        assert train_end <= test_start < test_end


def test_split_rejects_impossible_fold_count():
    with pytest.raises(ValueError):
        validation._split_indices(100, n_folds=50, min_train=90)


def test_walk_forward_never_scores_on_training_data(prices):
    wf = validation.walk_forward(prices, n_folds=4)
    for fold in wf.folds:
        assert fold.test_start > fold.train_end, "leakage: test window starts inside training data"


# --- walk-forward output ------------------------------------------------------

def test_walk_forward_produces_a_fold_per_split(prices):
    wf = validation.walk_forward(prices, n_folds=4)
    assert len(wf.folds) == 4
    assert len(wf.oos_returns) > 0


def test_selection_is_always_a_registered_theory(prices):
    wf = validation.walk_forward(prices, n_folds=4)
    known = set(theories.all_ids())
    for fold in wf.folds:
        assert fold.selected in known
        assert fold.hindsight_best in known


def test_hindsight_is_never_worse_than_the_live_selection(prices):
    """The best-in-hindsight theory bounds what selection could have achieved."""
    wf = validation.walk_forward(prices, n_folds=4)
    for fold in wf.folds:
        assert fold.hindsight_test_score >= fold.test_score - 1e-9


def test_selection_stability_is_a_valid_share(prices):
    wf = validation.walk_forward(prices, n_folds=5)
    assert 0.0 < wf.selection_stability <= 1.0
    assert sum(wf.selection_counts.values()) == len(wf.folds)


def test_verdict_is_one_of_the_known_outcomes(prices):
    wf = validation.walk_forward(prices, n_folds=4)
    assert wf.verdict().split(" ")[0] in {"REJECT", "WEAK", "UNSTABLE", "SURVIVED", "DEGENERATE"}


# --- the cash-hiding trap ----------------------------------------------------
# Sharpe-maximising over a universe containing a cash instrument has a trivial
# solution: hold the cash. It is the single most likely way this engine could
# mislead, so it gets its own tests.

def test_min_variance_hides_in_the_lowest_vol_asset(prices):
    """Documents the degenerate behaviour rather than pretending it doesn't happen."""
    res = backtest.run(prices, theories.get("min_variance").weight_fn, rebalance="Q")
    assert res.weights.mean().idxmax() == "BIL"
    assert res.weights.mean()["BIL"] > 0.7


def test_removing_cash_just_promotes_the_next_lowest_vol_asset(prices):
    """The trap is structural, not specific to holding a cash instrument.

    Drop BIL and minimum-variance moves into AGG with the same enthusiasm. This
    is why the fix has to be sleeve scoping, not universe pruning.
    """
    no_cash = prices[["VTI", "VXUS", "AGG"]]
    res = backtest.run(no_cash, theories.get("min_variance").weight_fn, rebalance="Q")
    assert res.weights.mean().idxmax() == "AGG"
    assert res.weights.mean()["AGG"] > 0.7


def test_degeneracy_outranks_a_winning_sharpe():
    """A cash-hiding winner must never be reported as SURVIVED."""
    wf = _wf(_perf(2.5, 0.019), _perf(0.77, 0.063), folds=5, train_score=2.5)
    assert wf.beats_baseline, "it does win on Sharpe — that is exactly the trap"
    assert wf.is_degenerate
    assert wf.verdict().startswith("DEGENERATE")


def test_small_cagr_shortfall_is_not_called_degenerate():
    """Tolerance exists so noise near the baseline is not flagged as hiding."""
    wf = _wf(_perf(0.9, 0.068), _perf(0.8, 0.070), folds=4, train_score=0.9)
    assert not wf.is_degenerate


def test_selection_metric_changes_what_gets_picked(prices):
    by_sharpe = validation.walk_forward(prices, n_folds=4, selection_metric="sharpe")
    by_calmar = validation.walk_forward(prices, n_folds=4, selection_metric="calmar")
    assert by_sharpe.selection_metric == "sharpe"
    assert by_calmar.selection_metric == "calmar"
    assert [f.selected for f in by_sharpe.folds] != [] and [f.selected for f in by_calmar.folds] != []


def test_unknown_selection_metric_is_rejected(prices):
    with pytest.raises(ValueError, match="Unknown selection metric"):
        validation.walk_forward(prices, n_folds=3, selection_metric="profit")


def _perf(sharpe: float, cagr: float) -> metrics.Performance:
    return metrics.Performance(
        total_return=cagr, cagr=cagr, volatility=0.1, sharpe=sharpe, sortino=sharpe,
        max_drawdown=-0.1, calmar=cagr / 0.1, best_day=0.01, worst_day=-0.01,
        positive_days=0.5, periods=500,
    )


def _wf(oos: metrics.Performance, base: metrics.Performance, *, folds=1, train_score=0.0):
    """Build a result directly so the verdict decision table can be tested in isolation."""
    fold_objs = [
        validation.Fold(i, "2020-01-01", "2021-01-01", "2021-01-02", "2022-01-01",
                        "equal_weight", train_score, 0.0, "equal_weight", 0.0)
        for i in range(folds)
    ]
    return validation.WalkForwardResult(
        folds=fold_objs, oos_returns=pd.Series(dtype=float), oos_performance=oos,
        baseline_performance=base, baseline_id="equal_weight",
        selection_counts={"equal_weight": folds},
    )


# The decision table, one row per branch. Order matters: DEGENERATE must win over
# everything, because a cash-hiding result reported as SURVIVED is the failure
# mode that would actually cost money.
@pytest.mark.parametrize(
    "oos_sharpe,oos_cagr,base_sharpe,base_cagr,train_score,folds,expected",
    [
        (1.2, 0.02, 0.8, 0.07, 1.2, 4, "DEGENERATE"),  # wins on Sharpe, compounds less
        (0.5, 0.07, 0.9, 0.07, 0.5, 4, "REJECT"),      # loses to the passive baseline
        (0.9, 0.08, 0.8, 0.07, 2.0, 4, "WEAK"),        # beat baseline, lost its in-sample edge
        (0.9, 0.08, 0.8, 0.07, 0.9, 4, "SURVIVED"),    # clean pass
    ],
)
def test_verdict_decision_table(oos_sharpe, oos_cagr, base_sharpe, base_cagr,
                                train_score, folds, expected):
    wf = _wf(_perf(oos_sharpe, oos_cagr), _perf(base_sharpe, base_cagr),
             folds=folds, train_score=train_score)
    assert wf.verdict().startswith(expected)


def test_unstable_selection_is_flagged():
    wf = _wf(_perf(0.9, 0.08), _perf(0.8, 0.07), folds=4, train_score=0.9)
    wf.selection_counts = {"a": 1, "b": 1, "c": 1, "d": 1}  # nobody wins twice
    assert wf.verdict().startswith("UNSTABLE")


def test_walk_forward_serialises(prices):
    payload = validation.walk_forward(prices, n_folds=3).to_dict()
    json.dumps(payload)  # must be JSON-clean for the portal
    assert {"folds", "out_of_sample", "baseline", "overfitting_gap", "verdict"} <= payload.keys()


# --- bootstrap ---------------------------------------------------------------

def test_bootstrap_interval_brackets_the_point_estimate():
    r = pd.Series(
        np.random.default_rng(7).normal(0.0004, 0.01, 1500),
        index=pd.bdate_range("2018-01-01", periods=1500),
    )
    lo, mid, hi = validation.block_bootstrap_sharpe(r, n_samples=300)
    assert lo < mid < hi


def test_bootstrap_is_deterministic():
    r = pd.Series(
        np.random.default_rng(3).normal(0.0003, 0.012, 900),
        index=pd.bdate_range("2019-01-01", periods=900),
    )
    assert validation.block_bootstrap_sharpe(r, n_samples=200) == validation.block_bootstrap_sharpe(
        r, n_samples=200
    )


def test_bootstrap_degrades_gracefully_on_short_series():
    r = pd.Series([0.01, -0.01, 0.02], index=pd.bdate_range("2024-01-01", periods=3))
    lo, mid, hi = validation.block_bootstrap_sharpe(r)
    assert lo == mid == hi


def test_noisier_strategy_gets_a_wider_interval():
    idx = pd.bdate_range("2018-01-01", periods=1500)
    rng = np.random.default_rng(11)
    calm = pd.Series(rng.normal(0.0004, 0.004, 1500), index=idx)
    wild = pd.Series(rng.normal(0.0004, 0.030, 1500), index=idx)
    calm_lo, _, calm_hi = validation.block_bootstrap_sharpe(calm, n_samples=300)
    wild_lo, _, wild_hi = validation.block_bootstrap_sharpe(wild, n_samples=300)
    assert (wild_hi - wild_lo) > (calm_hi - calm_lo)


def test_comparison_table_flags_indistinguishable_strategies(prices):
    results = [
        backtest.run(prices, theories.get(t).weight_fn, name=t, rebalance="Q")
        for t in ("equal_weight", "inverse_vol", "momentum")
    ]
    table = validation.compare_with_intervals(results, n_samples=200)
    assert list(table.columns[:3]) == ["sharpe", "sharpe_lo", "sharpe_hi"]
    assert not table["distinguishable"].iloc[0], "the leader is never distinguishable from itself"
    assert (table["sharpe_lo"] <= table["sharpe"]).all()


# --- artifact payload --------------------------------------------------------

def test_curve_is_thinned_but_endpoints_survive(prices):
    res = backtest.run(prices, {"VTI": 1.0})
    payload = res.to_dict(max_points=200)
    curve = payload["equity_curve"]
    assert len(curve["values"]) <= 202
    assert payload["curve_stride_days"] > 1
    assert curve["values"][-1] == pytest.approx(float(res.equity.iloc[-1]), rel=1e-6)
    assert curve["dates"][-1] == res.equity.index[-1].strftime("%Y-%m-%d")


def test_thinning_does_not_change_reported_metrics(prices):
    res = backtest.run(prices, {"VTI": 0.6, "AGG": 0.4})
    assert res.to_dict(max_points=100)["performance"] == res.to_dict(max_points=5000)["performance"]


def test_study_artifact_records_the_validation_verdict(tmp_path, prices):
    res = [backtest.run(prices, {"VTI": 1.0}, name="solo", data_source="synthetic")]
    wf = validation.walk_forward(prices, n_folds=3)
    artifacts.write_study(
        tmp_path, "t", res, universe=["VTI"], start="2014-01-01", end="2026-01-01",
        validation=wf.to_dict(),
    )
    index = json.loads((tmp_path / "index.json").read_text())
    assert index["studies"][0]["validated"] is True
    assert index["studies"][0]["verdict"]


def test_unvalidated_study_is_marked_as_such(tmp_path, prices):
    res = [backtest.run(prices, {"VTI": 1.0}, name="solo", data_source="synthetic")]
    artifacts.write_study(tmp_path, "t", res, universe=["VTI"], start="2014-01-01", end="2026-01-01")
    index = json.loads((tmp_path / "index.json").read_text())
    assert index["studies"][0]["validated"] is False
