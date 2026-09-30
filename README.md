# GenInvestor

**Open-source, local-first investor tooling where every number shows its source.**

GenInvestor builds a daily brief from public data, audits every line against stored evidence, and refuses to publish a number it cannot back. It runs on your machine and inside your AI assistant over MCP. It holds no custody, places no orders, and gives no advice.

> **Status: alpha (0.1).** The evidence layer, the audit, the CLI, the MCP server, the simulation engine, your mandate, the opportunity scout (SEC filings) and the calibration ledger work and are tested. Model-written analysis, insider-trade data, price-based screens and the dashboard are planned, not built. See [Roadmap](#roadmap).

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

### Find candidates for research against your own rules

Write your mandate (markets, horizon, risk, exclusions, thresholds, a watchlist), then run the scout. It reads each company's annual reports from SEC EDGAR, screens them, and returns at most five **candidates for research**: each with the evidence, what would prove it wrong, and the case against it from a separate skeptic.

```bash
node packages/core/bin/geninvestor.ts mandate example > mandate.json   # edit it: it is your rules
node packages/core/bin/geninvestor.ts mandate check mandate.json
export GENINVESTOR_SEC_IDENTITY="Your Name your@email"                 # the SEC requires a contact on every request
node packages/core/bin/geninvestor.ts scout --mandate mandate.json
```

- **Candidates, never recommendations.** The card schema has no field for a buy, a price target, a position size or a probability, and a test enforces it.
- **Zero is a valid result.** A screen that finds nothing says so.
- **Your holdings and exclusions stay private.** They are counted ("2 skipped"), never named, and never written to the ledger.
- **Styles today:** `quality` and `growth`, from annual filings. `value` needs price data and `special-situation` is not built; the screen record says so instead of pretending.

Then keep score of your own judgement. A forecast is registered before the outcome, cannot be edited or back-dated, and is resolved on its date:

```bash
node packages/core/bin/geninvestor.ts calls register --claim "X keeps operating margin at or above 20% in its FY2026 report" \
  --p 0.7 --resolves 2027-08-01 --source "Form 10-K FY2026 on SEC EDGAR"
node packages/core/bin/geninvestor.ts calls due        # what is ready to resolve
node packages/core/bin/geninvestor.ts calls resolve <id> --outcome 1
node packages/core/bin/geninvestor.ts calls score      # counts only, until 30 calls are resolved
```

The probability is always yours. Nothing here suggests one, and the MCP server cannot register or resolve a call.

### Use it from your AI assistant

GenInvestor ships an MCP server (stdio, no dependencies) with read-only evidence tools and a local brief run:

```bash
claude mcp add geninvestor -- node --disable-warning=ExperimentalWarning /path/to/GenInvestor/packages/mcp/bin/geninvestor-mcp.ts
```

Tools: `run_today`, `get_latest_brief`, `list_opportunities`, `get_calibration`, `explain_claim`, `verify_ledger`, `check_action`. There is no tool that approves, trades, transfers, signs, or registers a forecast, and a test fails if one is added.

## What it guarantees, and how that is tested

| Guarantee | How it is enforced |
|---|---|
| No unbacked number is published | A claims audit blocks lines whose numbers are not in a linked claim, whose stored field disagrees, whose quote is not a byte match, whose computed value does not recompute, or whose source no longer matches its hash |
| Evidence cannot be rewritten | The ledger is append-only, enforced by database triggers; `verify` re-hashes every source and exposes tampering that bypasses them |
| Rates are never shown as a percent of a percent | Series carry a kind (level, rate, event); rates and events are described in percentage points |
| Old data is flagged, not trusted | Each series has an expected cadence; stale data is marked in the line and in a data-quality section, and a thesis that rests on it goes on watch instead of being judged |
| Nothing moves money | One autonomy gate, capped at simulation. Its table and 35 adversarial cases live in `packages/contracts/policy/policy.json`; the Python and TypeScript gates must pass every case, and CI compares the file with what the engine exports |
| A claim states the value it cites | The audit also blocks a claim that links a field or a computed value its own text does not state, so text and evidence cannot drift apart |
| Humans decide the hard calls | A thesis marked broken by rule stops the run until a person approves it outside the tool |
| No card can become advice | The opportunity contract has no field for a recommendation, price target, position size or probability; the writer, the skeptic and the verifier must be three different providers; a skeptic that invents a number is stopped by the audit |
| Your forecasts cannot be flattered | Registered before the outcome with the ledger's own clock, append-only, resolvable only on their date, and no accuracy figure is shown below 30 resolved calls |
| Your rules stay yours | Holdings, exclusions and the watchlist are never written to the ledger or any output; only a fingerprint of the screen rules is |
| Data is displayed only where its licence allows | Each datum has a licence class; simulation-only and restricted data are refused in hosted and public contexts |
| The safety tests can fail | The suite sabotages the gate in both directions and requires the shared cases to catch it |

Tested: 113 TypeScript tests and 90 Python tests, plus opt-in live tests against the ECB and SEC APIs. CI runs on Linux with Node 24. The SEC parser is tested against real SEC data (Snowflake's filings) and hand-checked figures.

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

- `packages/contracts`: the gate table and JSON Schemas (datum, claim, brief, mandate, opportunities) with a small validator that rejects keywords it does not enforce.
- `packages/core`: ledger, claims audit, workflow graph, providers (ECB, SEC), the daily brief, the mandate, the scout, the calibration ledger, the CLI.
- `packages/mcp`: the MCP server.
- `engine`: the simulation engine. See [engine/README.md](engine/README.md).

## What it is not

- **Not investment advice.** It never says to buy or sell. Read [DISCLAIMER.md](DISCLAIMER.md).
- **Not a broker or a wallet.** No custody, no orders, no keys. Secrets and raw account exports are hard-blocked verbs.
- **Not a prediction engine.** The brief is written by a template today, so it reads plainly by design. When a model is added, it cannot introduce a number: the audit still blocks it.

## Known limits

- The euro-area inflation series on the ECB API ends at 2025-12 and is flagged stale.
- **The SEC path has not yet been run end to end against the live API.** The provider is tested against real recorded SEC data and a fake transport; the one live attempt from a development machine was refused (HTTP 403, "Request Rate Threshold Exceeded") on its first request, and the cause is not established (the contact identity used was a placeholder, and the SEC also filters automated traffic). Set `GENINVESTOR_SEC_IDENTITY` to your own real contact and run `npm run test:live`, then tell us what happens.
- The scout reads annual filings only: no prices, so no valuation; no quarterly data, so nothing since the last annual report.
- The skeptic and verifier are rule-based. The cards are written by a template, so they read plainly by design.
- Insider transactions and fund holdings are not built yet. ECB macro data is the only other source.
- The TradingView connector expects snapshot files; the live response format of TradingView's MCP server is unverified.
- No dashboard yet.

## Roadmap

Built: your mandate, opportunity cards from SEC annual filings (quality and growth styles), a rule-based skeptic, the calibration ledger. Planned, in this order:

1. **Insider transactions and fund holdings** from SEC filings, as sourced claims.
2. **Price data** so the value style can run, with point-in-time filtering.
3. **Leakage controls:** masking so agent backtests cannot use knowledge of the future.
4. **A model-written analyst and skeptic** from different AI providers behind the existing interfaces, with replay logs. They cannot introduce a number: the audit still blocks it.
5. **A dashboard** with an evidence drawer on every figure.

## The GenInvestor network

- **[geninvestor-skills](https://github.com/frankxai/geninvestor-skills):** four installable agent skills (thesis tracking, source checks, opportunity screens, calibration logs) for any assistant. `npx skills add frankxai/geninvestor-skills`.
- **[awesome-investor-agent-skills](https://github.com/frankxai/awesome-investor-agent-skills):** a catalogue of investing agent tools and standards, with a weekly research loop that flags licence traps.
- **Learning materials:** planned. Open curriculum first; nothing to join yet.

Read the [MANIFESTO](MANIFESTO.md) for what we are trying to build, and [BRAND.md](BRAND.md) for how to refer to the project.

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md). The ground rules are few and enforced by tests: every number needs evidence, no advice, the gate exists once, rates are percentage points, and no new runtime dependency without a written reason.

## Licence

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE). Data from the ECB is used under its reuse policy with attribution.

GenInvestor is an independent open-source project and is not affiliated with any company of a similar name. See [BRAND.md](BRAND.md).
