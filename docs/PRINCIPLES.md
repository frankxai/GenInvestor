# Operating Principles

These are the rules the system enforces. Where a principle can be enforced in code it is,
and the enforcement point is named. A principle nobody can violate is worth more than a
principle everybody agrees with.

## 1. The engine cannot move money

The ceiling is `L2_SIMULATION`. Research, strategy, backtest, paper trade, artifact. That is all.

There is no brokerage client, no exchange key handling, no wallet code — not disabled, *absent*.
`policy.require()` is called at the top of every entry point, and `live_trade`, `transfer`,
`wallet_sign`, and `draft_order` are unreachable from any code path.

Raising the ceiling is a reviewed change to `policy.py` plus a broker integration that does not
exist, not a config flag.

> Enforced: `engine/src/investor_engine/policy.py`, tests in `test_engine.py::test_capital_moving_actions_are_never_allowed`

## 2. Every number states where it came from

Each artifact carries `data_sources`, `is_synthetic`, and the full `assumptions` list of the
backtest that produced it. The portal renders the synthetic flag prominently. A simulated result
must never be able to dress as a real one on its way to a decision.

> Enforced: `artifacts.py` (`is_synthetic`), `BacktestResult.assumptions`

## 3. A theory ships with its failure mode

`theories.REGISTRY` requires `claim` and `known_failure_mode` on every entry. A test fails if a
theory has no stated way to break. Anything that only lists when it works is marketing.

> Enforced: `test_every_registered_theory_runs`

## 4. Index is the control group

`core-index` exists so every more complex config has something to beat *after costs and taxes*.
Complexity is a cost, paid in attention and in error surface. It has to be earned against the
boring baseline, not against zero.

## 5. Backtests are measured on what they cover

An allocation containing illiquid, book-valued sleeves cannot be backtested end to end. The engine
computes `backtestable_weight` and prints it before any result. For `operator-barbell` that is 55% —
so the study is silent about the 45% that actually dominates the outcome. Say so, every time.

> Enforced: `AllocationConfig.backtestable_weight`, printed by `cli.cmd_study`

## 6. Position size is the risk control, not conviction

Every speculative sleeve is capped at a weight where total loss is survivable and changes nothing
about the plan. Conviction is not a risk parameter. If a sleeve needs to be right, it is too big.

## 7. The visible risk is not the real risk

The crypto sleeve is marked every second and gets watched constantly. The concentrated,
illiquid, income-correlated business equity is marked at book and gets watched never. Attention
follows price updates, not exposure. The sleeve model exists to make that asymmetry visible.

## 8. Don't buy more of what you already are

If your income, your sector, and your operating equity are the same bet, the liquid book's job is
to be uncorrelated to it — not to add leverage to it. This is the premise of `operator-barbell`.

## 9. Simulated performance is not evidence about the future

Backtests measure how a *mechanism* behaves on a *given price history*. They do not forecast.
Overfitting to one window is the default outcome, not the edge case. Every artifact carries this
as a machine-readable `disclaimer` field, not as small print.

## 10. Secrets never enter the system

Seed phrases, private keys, brokerage credentials, and raw account exports are hard-blocked at the
policy layer and excluded from git. Keep real holdings in your own private store, never in this repo.

> Enforced: `policy._HARD_BLOCKED`

## 11. Human review is a feature, not friction

Anything regulated — tax, legal, securities, accounting — routes to a qualified human. The system
organises evidence for that decision and stops there. It does not conclude.

## 12. A risk-adjusted metric will pick the timid portfolio every time

Rank long-only strategies by Sharpe over a universe containing cash and the winner
is cash — 98% in T-bills, Sharpe 2.18, CAGR 1.9%, against a passive baseline's 6.3%.
Switch to Calmar and it still wins, because near-zero drawdown inflates that too.
Remove the cash instrument and bonds take the job.

This is not a flaw in any one metric. Without leverage you cannot scale a low-volatility
portfolio up to a comparable return, so the risk-adjusted winner and the wealth-maximising
winner are simply different portfolios, and the ratio always prefers the timid one.

The fix is structural, and it is the reason the sleeve model exists: **test theories inside
one risk-comparable sleeve, and treat the cross-sleeve mix as a policy decision, not an
optimiser output.** How much sits in cash is a question about your obligations and your
horizon. It is not a question a Sharpe ratio is entitled to answer.

> Enforced: `WalkForwardResult.is_degenerate` blocks the SURVIVED verdict; measured on real
> 2014–2026 data in `test_min_variance_hides_in_the_lowest_vol_asset` and
> `test_removing_cash_just_promotes_the_next_lowest_vol_asset`

## 13. Boring wins are still wins

The highest-value sleeve in `operator-barbell` is the liquidity reserve, which earns almost nothing
and does almost nothing, right up until it is the only thing that matters. Optimise the plan for
surviving the bad case, not for maximising the good one.
