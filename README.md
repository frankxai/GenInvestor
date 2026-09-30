# GenInvestor

**Open-source, local-first investor tooling where every number shows its source.**

GenInvestor builds a daily brief from public data, audits every line against stored evidence, and refuses to publish a number it cannot back. It runs on your machine and inside your AI assistant over MCP. It holds no custody, places no orders, and gives no advice.

> **Status: alpha (0.1).** The evidence layer, the audit, the CLI, the MCP server and the simulation engine work and are tested. The proactive research team and the dashboard are planned, not built. See [Roadmap](#roadmap).

## Try it

Needs Node 22.18 or newer (24 recommended). No install step, no dependencies.

```bash
git clone https://github.com/frankxai/GenInvestor && cd GenInvestor
node packages/core/bin/geninvestor.ts today
```

That fetches live data from the ECB and writes a brief. Real output:

```
# Today, 2026-09-29

- EUR/USD reference rate was 1.1355 USD on 2026-09-29, down 0.2% on the prior observation
  (ecb, as of 2026-09-29, retrieved 2026-09-30T03:40Z)
- Euro short-term rate (€STR) was 2.44% on 2026-09-28, unchanged on the prior observation
- Euro area HICP inflation, annual rate was 1.9% on 2025-12, down 0.2 percentage points on the prior
  observation (as of 2025-12, ⚠ stale, 273 days old)
- ECB deposit facility rate was set to 2.5% on 2026-09-16, from 2.25%

## Data quality
- Euro area HICP inflation, annual rate: latest observation is 273 days old, past its expected cadence.
```

Every line links to a stored source. Ask why:

```bash
node packages/core/bin/geninvestor.ts explain <claim id>   # source, as-of, retrieved, sha256, licence
node packages/core/bin/geninvestor.ts verify               # re-hash everything, report tampering
node packages/core/bin/geninvestor.ts policy live_trade    # ask the autonomy gate: human_gate
```

### Use it from your AI assistant

GenInvestor ships an MCP server (stdio, no dependencies) with read-only evidence tools and a local brief run:

```bash
claude mcp add geninvestor -- node --disable-warning=ExperimentalWarning /path/to/GenInvestor/packages/mcp/bin/geninvestor-mcp.ts
```

Tools: `run_today`, `get_latest_brief`, `explain_claim`, `verify_ledger`, `check_action`. There is no tool that approves, trades, transfers or signs, and a test fails if one is added.

## What it guarantees, and how that is tested

| Guarantee | How it is enforced |
|---|---|
| No unbacked number is published | A claims audit blocks lines whose numbers are not in a linked claim, whose stored field disagrees, whose quote is not a byte match, whose computed value does not recompute, or whose source no longer matches its hash |
| Evidence cannot be rewritten | The ledger is append-only, enforced by database triggers; `verify` re-hashes every source and exposes tampering that bypasses them |
| Rates are never shown as a percent of a percent | Series carry a kind (level, rate, event); rates and events are described in percentage points |
| Old data is flagged, not trusted | Each series has an expected cadence; stale data is marked in the line and in a data-quality section, and a thesis that rests on it goes on watch instead of being judged |
| Nothing moves money | One autonomy gate, capped at simulation. Its table and 35 adversarial cases live in `packages/contracts/policy/policy.json`; the Python and TypeScript gates must pass every case, and CI compares the file with what the engine exports |
| Humans decide the hard calls | A thesis marked broken by rule stops the run until a person approves it outside the tool |
| Data is displayed only where its licence allows | Each datum has a licence class; simulation-only and restricted data are refused in hosted and public contexts |
| The safety tests can fail | The suite sabotages the gate in both directions and requires the shared cases to catch it |

Tested: 64 TypeScript tests and 90 Python tests, plus an opt-in live test against the ECB API. CI runs on Linux with Node 24.

## How it works

```
sources ──► providers ──► evidence ledger ──► workflow graph ──► surfaces
ECB (live)  datum with     append-only        fetch, compute,     CLI
            as-of, hash,   SQLite: sources,   thesis, analyse,    MCP server
            licence        claims, links      verify, audit,
                                              human, gate, publish
                        autonomy gate: one contract file, checked in two languages

simulation engine (Python): prices ─► backtest ─► walk-forward ─► stress ─► study JSON
```

- `packages/contracts`: the gate table and JSON Schemas (datum, claim, brief) with a small validator that rejects keywords it does not enforce.
- `packages/core`: ledger, claims audit, workflow graph, providers, the daily brief, the CLI.
- `packages/mcp`: the MCP server.
- `engine`: the simulation engine. See [engine/README.md](engine/README.md).

## What it is not

- **Not investment advice.** It never says to buy or sell. Read [DISCLAIMER.md](DISCLAIMER.md).
- **Not a broker or a wallet.** No custody, no orders, no keys. Secrets and raw account exports are hard-blocked verbs.
- **Not a prediction engine.** The brief is written by a template today, so it reads plainly by design. When a model is added, it cannot introduce a number: the audit still blocks it.

## Known limits

- The euro-area inflation series on the ECB API ends at 2025-12 and is flagged stale.
- Only ECB macro data is wired. Filings, screeners and market data are on the roadmap.
- The TradingView connector expects snapshot files; the live response format of TradingView's MCP server is unverified.
- No dashboard yet.

## Roadmap

Planned, in this order. None of it is built.

1. **SEC filings** through the [edgartools](https://github.com/dgunning/edgartools) MCP server: insider transactions and fund holdings as sourced claims.
2. **Your mandate:** a file of your own rules (markets, horizon, risk, exclusions) that everything searches against.
3. **Opportunity cards:** at most five a day, each with evidence, what would prove it wrong, a skeptic's case from a different AI provider, and a paper position. Candidates that match your rules, never "buy this".
4. **Calibration ledger:** timestamped paper calls scored against outcomes, with a minimum sample before any hit rate is shown.
5. **Leakage controls:** point-in-time filtering and masking so agent backtests cannot use knowledge of the future.
6. **A model-written analyst** behind the existing interface, with a cross-provider verifier and replay logs.
7. **A dashboard** with an evidence drawer on every figure.

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md). The ground rules are few and enforced by tests: every number needs evidence, no advice, the gate exists once, rates are percentage points, and no new runtime dependency without a written reason.

## Licence

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE). Data from the ECB is used under its reuse policy with attribution.
