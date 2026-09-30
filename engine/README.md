# GenInvestor simulation engine

Research, backtest and paper-trade engine in Python. It tests allocation rules under stated assumptions and reports what survived out of sample. It is the quantitative half of GenInvestor; the evidence layer lives in `../packages`.

**Autonomy ceiling: `L2_SIMULATION`.** This engine cannot place an order, move funds or touch a wallet. There is no brokerage client and no exchange key handling anywhere in it. See [../docs/PRINCIPLES.md](../docs/PRINCIPLES.md).

Not investment advice. Simulation output for research and education only.

## Quickstart

```bash
uv run --extra dev pytest -q          # 90 tests, network-free
uv run investor configs               # list and validate allocation configs
uv run investor study operator-barbell --start 2016-01-01 --end 2026-08-01
uv run investor gauntlet              # guardrail cases + regime stress simulations
```

Every study runs an in-sample leaderboard **with bootstrap confidence intervals**, then a **walk-forward validation**: theories are chosen on training windows and scored on the untouched windows after them. It ends in a verdict: `SURVIVED`, `WEAK`, `UNSTABLE`, `REJECT` or `DEGENERATE`. A leaderboard without that second half is not evidence, so `--skip-validation` says so in its own help text.

Everything runs offline against a deterministic synthetic price generator. No API key, no network, identical results on any machine, so a failing test is a real regression and not a market move.

## Real prices

Opt-in, never a side effect:

```bash
uv sync --extra market && uv run investor study core-index --source yahoo
```

Yahoo's terms restrict commercial redistribution, so treat that source as personal research only. A `tradingview` source replays snapshot files fetched through the official read-only TradingView MCP server; its live response format is not yet verified.

## Layout

```
src/investor_engine/   policy gate, backtest, metrics, theories, validation, stress, guardrails, data adapters
configs/sleeves/       allocation configs (core-index, risk-balanced, operator-barbell)
tests/                 the suite
```

The education layer is attached to the thing it explains. Every sleeve carries a `rationale` and every theory carries a `claim` and a `known_failure_mode`; a test fails if either is missing or thin, so the explanation cannot rot away from the code.

## Allocation configs

| Config | Horizon | Backtestable | Premise |
|---|---|---|---|
| `core-index` | 20y | 100% | The low-cost control group every other config must beat after costs. |
| `risk-balanced` | 15y | 100% | Diversify across risk drivers, not across tickers that share one. |
| `operator-barbell` | 10y | 55% | Your business is already the concentrated bet; the liquid book offsets it. |

`backtestable` is the share a price-based test can honestly speak to. The rest is book- or appraisal-valued and excluded, and that is stated on every study run rather than quietly averaged in.

## Theories

`investor theories` lists them with claim and known failure mode: buy-and-hold, equal weight, inverse volatility, damped risk parity, minimum variance, cross-sectional momentum. Adding one is a registry entry plus a weight function. A theory without a stated failure mode fails the test suite.

### The first thing this engine found

On real 2014–2026 prices, minimum variance topped the leaderboard at Sharpe 2.18. It got there by holding 98.2% T-bills: 1.9% CAGR against the passive baseline's 6.3%. Switching to Calmar does not fix it, and removing the cash instrument does not either, because bonds simply take the job. Long-only risk-adjusted selection over a mixed-risk universe tilts to the lowest-risk asset, since without leverage you cannot scale a low-volatility portfolio up to a comparable return.

So `is_degenerate` blocks any result that wins the metric while compounding less than the baseline, and the structural answer is the sleeve model: test theories inside one risk-comparable sleeve; the cross-sleeve mix is a policy decision, not an optimiser output.

## Stress and guardrails

`investor gauntlet` runs 35 adversarial cases against the autonomy gate and five seeded regime scenarios (calm, crash, inflation shock, lost decade, whipsaw) across every theory. Scenarios are synthetic; they show how allocation mechanics behave under a stated shock and say nothing about real assets.

`investor policy-export` writes the gate table and every guardrail case to `../packages/contracts/policy/policy.json`. The TypeScript gate must pass the same cases, and CI compares the file with what this engine exports.

## Known gaps

- No tax modelling. Rules such as the Dutch Box 3 regime materially change which allocation wins for a resident, and that is a question for a qualified person.
- Theories run across the whole portfolio rather than inside a sleeve, which is what the principles say they should do.
- Walk-forward scores each test fold from a cold start, which may penalise dynamic theories (measured on real prices only).
- Weights are chosen from the close they trade at (`execution_lag` measures the effect; the default is 0).
- Single price path per study; regime and Monte Carlo testing exist as stress tools but are not wired into every study.
