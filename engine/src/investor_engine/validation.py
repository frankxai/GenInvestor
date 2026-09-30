"""Out-of-sample validation and statistical honesty.

Two failures kill backtest-driven investing, and a leaderboard sorted by Sharpe
commits both:

1. **Selection bias.** Compare six theories on one window, pick the winner, and
   you have measured the winner's luck on that window, not its skill.
2. **No error bar.** A point estimate of Sharpe with no confidence interval
   invites you to treat noise as a ranking.

`walk_forward` answers the first: choose on data the strategy has seen, score on
data it has not. `block_bootstrap_sharpe` answers the second: resample in blocks
(preserving autocorrelation) to get an interval, so two strategies whose
intervals overlap can be called what they are — indistinguishable.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from . import backtest, metrics, policy, theories


@dataclass(frozen=True)
class Fold:
    index: int
    train_start: str
    train_end: str
    test_start: str
    test_end: str
    selected: str
    train_score: float
    test_score: float
    hindsight_best: str
    hindsight_test_score: float

    def to_dict(self) -> dict:
        return {
            "index": self.index,
            "train": [self.train_start, self.train_end],
            "test": [self.test_start, self.test_end],
            "selected": self.selected,
            "train_score": self.train_score,
            "test_score": self.test_score,
            "hindsight_best": self.hindsight_best,
            "hindsight_test_score": self.hindsight_test_score,
        }


@dataclass
class WalkForwardResult:
    folds: list[Fold]
    oos_returns: pd.Series
    oos_performance: metrics.Performance
    baseline_performance: metrics.Performance
    baseline_id: str
    selection_metric: str = "sharpe"
    selection_counts: dict[str, int] = field(default_factory=dict)

    @property
    def mean_train_score(self) -> float:
        return float(np.mean([f.train_score for f in self.folds])) if self.folds else 0.0

    @property
    def overfitting_gap(self) -> float:
        """In-sample Sharpe minus realised out-of-sample Sharpe.

        Large and positive means the selection rule is fitting noise. This is the
        number that should govern whether any of this gets trusted.
        """
        return self.mean_train_score - self.oos_performance.sharpe

    @property
    def selection_stability(self) -> float:
        """Share of folds won by the most-selected theory. Low means the ranking is noise."""
        if not self.selection_counts:
            return 0.0
        return max(self.selection_counts.values()) / sum(self.selection_counts.values())

    @property
    def beats_baseline(self) -> bool:
        return self.oos_performance.sharpe > self.baseline_performance.sharpe

    def to_dict(self) -> dict:
        return {
            "folds": [f.to_dict() for f in self.folds],
            "out_of_sample": self.oos_performance.to_dict(),
            "baseline": {"id": self.baseline_id, **self.baseline_performance.to_dict()},
            "mean_train_score": self.mean_train_score,
            "overfitting_gap": self.overfitting_gap,
            "selection_stability": self.selection_stability,
            "selection_counts": self.selection_counts,
            "beats_baseline": self.beats_baseline,
            "is_degenerate": self.is_degenerate,
            "selection_metric": self.selection_metric,
            "verdict": self.verdict(),
        }

    @property
    def is_degenerate(self) -> bool:
        """True when the winner won the risk-adjusted metric by declining to invest.

        Long-only risk-adjusted selection over a mixed-risk universe has a trivial
        solution: hold the lowest-risk asset. Sharpe picks cash; drop cash and it
        picks bonds; Calmar does the same, because near-zero drawdown inflates it
        too. This is not a bug in any one metric — without leverage you cannot
        scale a low-volatility portfolio up to a comparable return, so the
        risk-adjusted winner and the wealth-maximising winner are different
        portfolios and the ratio always favours the timid one.

        Measured, not assumed: verified on real 2014-2026 data for sharpe and
        calmar, with and without a cash instrument in the universe.
        """
        return self.oos_performance.cagr < self.baseline_performance.cagr - 0.005

    def verdict(self) -> str:
        if self.is_degenerate:
            return (
                "DEGENERATE — the selection won on risk-adjusted score while compounding "
                f"less than the baseline ({self.oos_performance.cagr:.2%} vs "
                f"{self.baseline_performance.cagr:.2%} CAGR). It optimised the metric, not the goal. "
                "Changing the metric does not fix this and neither does removing cash — the "
                "lowest-risk asset in whatever universe remains simply takes over. The fix is "
                "structural: test theories inside one risk-comparable sleeve, and treat the "
                "cross-sleeve mix as a policy decision rather than an optimiser output."
            )
        if not self.beats_baseline:
            return (
                "REJECT — theory selection did not beat the passive baseline out of sample. "
                "The complexity is not paying for itself."
            )
        if self.overfitting_gap > 0.5:
            return (
                "WEAK — selection beat the baseline but lost most of its in-sample edge "
                f"(gap {self.overfitting_gap:.2f}). Treat the in-sample numbers as fiction."
            )
        if self.selection_stability < 0.5:
            return (
                "UNSTABLE — no theory wins consistently across folds "
                f"(stability {self.selection_stability:.0%}). The ranking is mostly noise."
            )
        return "SURVIVED — beat the baseline out of sample with a stable selection and modest decay."


def _split_indices(n: int, n_folds: int, min_train: int) -> list[tuple[int, int, int]]:
    """Expanding-window splits: (train_end, test_start, test_end) as positional indices."""
    if n_folds < 1:
        raise ValueError("n_folds must be >= 1")
    usable = n - min_train
    if usable < n_folds * 2:
        raise ValueError(
            f"Not enough observations for {n_folds} folds: need >= {min_train + n_folds * 2}, got {n}."
        )
    size = usable // n_folds
    splits = []
    for i in range(n_folds):
        train_end = min_train + i * size
        test_end = train_end + size if i < n_folds - 1 else n
        splits.append((train_end, train_end, test_end))
    return splits


SELECTION_METRICS = ("sharpe", "calmar", "sortino", "cagr")


def _score(perf: metrics.Performance, metric: str) -> float:
    if metric not in SELECTION_METRICS:
        raise ValueError(f"Unknown selection metric {metric!r}. Known: {', '.join(SELECTION_METRICS)}")
    return float(getattr(perf, metric))


def walk_forward(
    prices: pd.DataFrame,
    theory_ids: list[str] | None = None,
    *,
    n_folds: int = 5,
    min_train_frac: float = 0.3,
    cost_bps: float = 10.0,
    baseline_id: str = "equal_weight",
    rebalance: str = "Q",
    selection_metric: str = "sharpe",
) -> WalkForwardResult:
    """Select a theory on each training window, score it on the untouched window after it.

    `selection_metric` is the criterion used to pick the winner on training data.
    It is a real choice with real consequences: `sharpe` over a universe containing
    a cash instrument reliably selects cash. `calmar` (return per unit of drawdown)
    keeps return in the numerator and resists that failure.
    """
    policy.require("theory_test")
    _score(metrics.summarize(pd.Series(dtype=float)), selection_metric)  # validate early

    theory_ids = theory_ids or theories.all_ids()
    prices = prices.dropna(how="all").ffill().dropna()
    n = len(prices)
    min_train = max(60, int(n * min_train_frac))

    folds: list[Fold] = []
    oos_chunks: list[pd.Series] = []
    baseline_chunks: list[pd.Series] = []
    counts: dict[str, int] = {}

    for i, (train_end, test_start, test_end) in enumerate(_split_indices(n, n_folds, min_train)):
        train = prices.iloc[:train_end]
        test = prices.iloc[test_start:test_end]
        if len(test) < 5:
            continue

        scored: dict[str, float] = {}
        for tid in theory_ids:
            t = theories.get(tid)
            res = backtest.run(train, t.weight_fn, name=tid, rebalance=rebalance, cost_bps=cost_bps)
            scored[tid] = _score(res.performance, selection_metric)

        selected = max(scored, key=lambda k: scored[k])
        counts[selected] = counts.get(selected, 0) + 1

        test_scores: dict[str, float] = {}
        for tid in theory_ids:
            t = theories.get(tid)
            res = backtest.run(test, t.weight_fn, name=tid, rebalance=rebalance, cost_bps=cost_bps)
            test_scores[tid] = _score(res.performance, selection_metric)
            if tid == selected:
                oos_chunks.append(res.returns)
            if tid == baseline_id:
                baseline_chunks.append(res.returns)

        hindsight = max(test_scores, key=lambda k: test_scores[k])
        folds.append(
            Fold(
                index=i,
                train_start=str(train.index[0].date()),
                train_end=str(train.index[-1].date()),
                test_start=str(test.index[0].date()),
                test_end=str(test.index[-1].date()),
                selected=selected,
                train_score=scored[selected],
                test_score=test_scores[selected],
                hindsight_best=hindsight,
                hindsight_test_score=test_scores[hindsight],
            )
        )

    oos = pd.concat(oos_chunks) if oos_chunks else pd.Series(dtype=float)
    base = pd.concat(baseline_chunks) if baseline_chunks else pd.Series(dtype=float)

    return WalkForwardResult(
        folds=folds,
        oos_returns=oos,
        oos_performance=metrics.summarize(oos),
        baseline_performance=metrics.summarize(base),
        baseline_id=baseline_id,
        selection_metric=selection_metric,
        selection_counts=counts,
    )


def block_bootstrap_sharpe(
    returns: pd.Series,
    *,
    n_samples: int = 1000,
    block: int = 21,
    seed: int = 20260805,
    ci: float = 0.90,
) -> tuple[float, float, float]:
    """(low, point, high) Sharpe. Blocks preserve autocorrelation that an iid
    bootstrap would destroy — an iid resample flatters every strategy."""
    values = returns.dropna().to_numpy()
    n = len(values)
    if n < block * 2:
        point = metrics.sharpe(returns)
        return point, point, point

    rng = np.random.default_rng(seed)
    n_blocks = int(np.ceil(n / block))
    starts = rng.integers(0, n - block, size=(n_samples, n_blocks))

    sharpes = np.empty(n_samples)
    for i in range(n_samples):
        sample = np.concatenate([values[s : s + block] for s in starts[i]])[:n]
        sd = sample.std(ddof=1)
        sharpes[i] = sample.mean() / sd * np.sqrt(metrics.TRADING_DAYS) if sd > 0 else 0.0

    tail = (1.0 - ci) / 2.0
    return (
        float(np.quantile(sharpes, tail)),
        float(metrics.sharpe(returns)),
        float(np.quantile(sharpes, 1.0 - tail)),
    )


def compare_with_intervals(
    results: list[backtest.BacktestResult], *, n_samples: int = 500
) -> pd.DataFrame:
    """Leaderboard with confidence intervals. Overlapping intervals mean the
    ordering is not evidence of anything."""
    rows = []
    for r in results:
        lo, mid, hi = block_bootstrap_sharpe(r.returns, n_samples=n_samples)
        rows.append({
            "strategy": r.name,
            "sharpe": mid,
            "sharpe_lo": lo,
            "sharpe_hi": hi,
            "cagr": r.performance.cagr,
            "max_drawdown": r.performance.max_drawdown,
            "turnover": r.turnover,
        })
    frame = pd.DataFrame(rows).set_index("strategy").sort_values("sharpe", ascending=False)

    if len(frame) > 1:
        best_lo = frame["sharpe_lo"].iloc[0]
        frame["distinguishable"] = frame["sharpe_hi"] < best_lo
        frame.iloc[0, frame.columns.get_loc("distinguishable")] = False
    return frame
