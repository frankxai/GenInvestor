# Contributing

Thanks for helping. The rules are few and they are enforced by tests.

## The ground rules

1. **Every number needs evidence.** Anything shown to a user is a claim with a link to a stored source. The claims audit blocks the rest.
2. **Information, not advice.** No output says "you should buy or sell". Thesis status, risk, evidence and scenarios only.
3. **The gate exists once.** The autonomy table and its guardrail cases live in `packages/contracts/policy/policy.json`. Change the Python engine, run `investor policy-export`, and commit the new file. CI compares them. A pull request must not change the gate and the CI ceiling check together.
4. **Rates are percentage points.** Never show a percent change of a percent.
5. **Say what the data is.** Synthetic prices measure mechanics; real history is one path; neither is a forecast.
6. **No new runtime dependencies** in `packages/*` without a written reason.

## Setup

- Node 22.18 or newer (24 recommended). No install step.
- Python with [uv](https://docs.astral.sh/uv/) for the simulation engine.

```
npm test                 # contracts, core, MCP
npm run test:engine      # Python engine (pytest)
npm run test:live        # also hits the live ECB API
```

## Adding a data provider

Implement `Provider.fetchSeries(id) -> Datum`. Set `licenceClass` honestly (`public`, `user_licensed`, `sim_only`, `restricted`); the display rules depend on it. Record a real response as a fixture under `packages/core/test/fixtures/` and test the parser against it. Add an opt-in live smoke test guarded by `GENINVESTOR_LIVE`.

## Adding a workflow node or tool

Nodes are checkpointed and idempotent: same inputs, same output, no hidden state. MCP tools must be read-only unless they only write local files, must declare accurate annotations, and must not be named or shaped like an action that moves money.

## Review

Work that ships needs a review by a different tool or person than the one that wrote it.
