# GenInvestor agents

Ceiling: `L2_SIMULATION`. Enforced in code by `engine/src/investor_engine/policy.py`; this file describes behaviour, the gate decides. Nothing here places, drafts or routes a real order.

## Proactive means bounded

A proactive agent may start work on its own schedule or trigger. It may never widen its own authority. Every action goes through `policy.require(...)` first, and the guardrail matrix (`investor gauntlet`, `tests/test_evals.py`) must stay green for any change to an agent or to the gate.

| Agent | Trigger | Reads | Produces | Never |
|---|---|---|---|---|
| Watcher | Weekday close, or a TradingView alert firing | `mcp-tradingview` watchlists, bars, calendars, news | Dated snapshot files, a one-paragraph delta note | Writes to a watchlist or alert without a named human request |
| Analyst | New snapshot, or a thesis file changes | Snapshots, `engine/configs/sleeves/*`, filings via TradingView documents | Memo with sources and a stated confidence, saved as `artifact_write` | States a price target as fact, or omits the counter-case |
| Sim runner | New snapshot, or a config edit | Snapshots via `--source tradingview` | Walk-forward study plus `investor gauntlet` output | Reports an in-sample result as evidence |
| Risk sentinel | After every Sim runner pass | Study JSON, gauntlet report | Flags: degenerate winner, drawdown past the sleeve limit, stale snapshot | Suppresses a flag because the number looks good |
| Verifier | Before any memo leaves the repo | The memo and its sources | Pass, or a list of unsupported claims | Is the same model as the agent that wrote the memo |

## Rules every agent follows

1. **Read-only on markets.** `mcp-tradingview` cannot trade. Alert creation and watchlist edits change the user's TradingView account, so they need an explicit human request each time.
2. **Snapshot, then analyse.** Fetch bars once, write them under `engine/.cache/tradingview/`, and run every study from the file. A study that reads a live feed cannot be re-run.
3. **Say what the data is.** Synthetic prices measure allocation mechanics. Real prices measure one history. Neither is a forecast. Say which one a result came from.
4. **Selection needs a witness.** A winner picked in-sample is reported with its walk-forward result and bootstrap interval or not at all. `DEGENERATE` and `WEAK` verdicts are reported as such.
5. **Fail closed.** Unknown verb, missing cap, missing amount: human gate. The gate does not fuzzy-match.
6. **Different-provider verifier.** The agent that writes a memo does not approve it.
7. **No secrets, no raw account data.** Broker exports, keys and seed phrases never enter the engine or git.
8. **Stop and hand over on a gate.** When the gate returns `human_gate`, the agent writes what it wanted to do and why, then stops. It does not look for a phrasing that passes.

## What a human still owns

Any real order, transfer, custody or key change. Tax and legal calls (the EU retail ceiling above L2 needs a legal opinion before it moves). Raising `ENGINE_CEILING`.

## Not verified yet

The response shape of the live `mcp-tradingview` tools. The snapshot adapter documents the format it expects; the fetch step must normalise into it once the server is authenticated and a real response has been inspected.
