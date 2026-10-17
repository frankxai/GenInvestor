# GenInvestor

Local-first research tooling with an evidence chain behind every displayed figure. Apache-2.0. No hosted service, custody, orders or advice.

**Alpha.** This draft adds evidence-integrity fixes, recorded Form 4/13F parsing, rights-aware recorded prices, an annual earnings-multiple filter, three-provider model adapters, an owner-reviewed daily scan and a local dashboard. Offline tests cover these paths. Live SEC ownership retrieval and live model requests have not been verified. The project is not a predictive track record.

## Run locally

The core and MCP server need Node 22.18 or newer. They have no runtime dependencies. The dashboard is a separate Next.js application with a locked dependency tree.

```sh
git clone https://github.com/frankxai/GenInvestor
cd GenInvestor
npm test
node packages/core/bin/geninvestor.ts mandate example > mandate.json
node packages/core/bin/geninvestor.ts mandate check mandate.json
node packages/core/bin/geninvestor.ts scout --mandate mandate.json --facts-dir recorded-facts --as-of YYYY-MM-DD
node packages/core/bin/geninvestor.ts explain CLAIM_ID
node packages/core/bin/geninvestor.ts verify
```

Until this draft is merged, check out the draft branch before running these commands. Recorded company-facts files are named `<TICKER>.json`; the screen uses only filings available by the cutoff. Live fundamentals need the owner's `GENINVESTOR_SEC_IDENTITY`, set outside git. The contact is never invented. Recorded prices need an explicit source URL, licence URL, licence class, currency, unadjusted basis, compatible EPS basis and availability timestamp. Add `--prices-dir DIR` and an owner-defined `maxAnnualEarningsMultiple` to enable the value filter. It is a historical annual ratio, not a valuation conclusion.

Ownership parser usage and limits: [packages/edgar-sidecar/README.md](packages/edgar-sidecar/README.md). Missing prices stay unknown. Amendments remain separate evidence; delayed holdings never become inferred trades.

## Daily scan and human review

Create `daily.json` using paths relative to that file:

```json
{
  "mandate": "mandate.json",
  "factsDir": "recorded-facts",
  "pricesDir": "recorded-prices",
  "ownershipFiles": [],
  "asOf": "YYYY-MM-DD"
}
```

```sh
npm run daily -- --config daily.json
# Inspect the returned reviewPath. Then the owner explicitly promotes the reviewed run:
npm run daily -- --review DAILY_RUN_ID
```

A run prepares audited local artifacts and stops at human review. No scheduler is activated. A cron job in the owner's environment can invoke the preparation command; never schedule the review command. Missing data can produce an honest empty result. Changed inputs are freshly read on each preparation. A changed staged artifact fails review.

Optional `models` config contains `analyst`, `skeptic` and `verifier`, each with explicit `provider` and `model`. The providers must be distinct: `openai`, `anthropic`, `google`. Live requests need `--live-models` plus environment credentials. They receive audited text and opaque claim IDs, not raw source payloads or URLs. They can write qualitative notes only. A rejecting verifier stops the run. Masked/unmasked replay comparisons remain local; they are not evidence of investment performance or a causal test of memorisation. Live trials must be repeated and order-balanced. Entity masking cannot prevent semantic re-identification.

## Dashboard

```sh
cd apps/dashboard
npm ci --ignore-scripts
GENINVESTOR_HOME=/absolute/path/to/.geninvestor npm run dev
```

A keyboard command palette, candidate panels and source desk read the local ledger. Click any marked research figure to open its claim, exact field, source URL, date, retrieval time, hash, rights and audit status. An empty workspace contains no invented research numbers. Invalid contracts, tampered evidence or unsupported figures block display. Keep the server on localhost; it has no remote authentication. [Dashboard details](apps/dashboard/README.md).

## MCP and boundaries

```sh
node packages/mcp/bin/geninvestor-mcp.ts
```

Tools: `run_today`, `get_latest_brief`, `list_opportunities`, `get_calibration`, `explain_claim`, `verify_ledger`, `check_action`. Stored artifacts and explained claims are re-audited before serving. Calibration exposes audited counts only; scoring bands and free-form forecast text are withheld. No tool approves a human gate, registers a forecast, trades, transfers or signs.

The shared autonomy contract is enforced in TypeScript and Python with parity tests. The Python engine remains a simulation tool: [engine/README.md](engine/README.md). Read [DISCLAIMER.md](DISCLAIMER.md), [SECURITY.md](SECURITY.md), [CONTRIBUTING.md](CONTRIBUTING.md) and [docs/AGENTS.md](docs/AGENTS.md).

## Verification and remaining work

```sh
npm test
python3 -m unittest discover -s packages/edgar-sidecar/test -v
uv run --directory engine --extra dev pytest -q
npm run typecheck --prefix apps/dashboard
npm run build --prefix apps/dashboard
```

The audit checks numeric support, source hashes, exact fields, literal quotes, deterministic recomputation and display rights. It does not prove semantic truth or detect every misleading paraphrase. Model-provider contracts are tested with mock transports, not live credentials. The ownership parser currently has synthetic XML tests; real recorded filing fixtures and a source-verified live retrieval trial remain required. Price/EPS basis compatibility is an explicit owner assertion, not independently established corporate-action history. An independently reviewed automatic free-price connector remains to be selected.

npm dry runs are packaging diagnostics only. Core and MCP packages remain private and reference sibling contracts; independent npm installation is not ready. MCP SDK conformance, source cadence metadata, broader planted model-error trials and the independent review of this change are release gates. No npm publish or deployment is performed.

## Related projects

- [geninvestor-skills](https://github.com/frankxai/geninvestor-skills): research skills and a validator.
- [awesome-investor-agent-skills](https://github.com/frankxai/awesome-investor-agent-skills): catalogue, licence flags and a weekly discovery digest for review.

Upstream code is absorbed only after its actual licence is read. AGPL and source-available projects inform ideas only. The dashboard preserves shadcn/ui's MIT notice; the SEC retrieval sidecar uses MIT-licensed edgartools without copying its parser.
