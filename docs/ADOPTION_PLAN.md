# GenInvestor adoption roadmap

Date: 2026-10-08. Status: proposed work; the integrations and experiments below have not been implemented by this document.

## The useful research session

Run locally with your own permitted data. Apply a written mandate to real filings and prices. Read up to five research candidates or an explicit zero-result response. Open every figure to its source, observation date, retrieval receipt, hash and permitted-use status. Inspect a counter-case, save reviewed research and reproduce it from stored evidence without another network request.

Outputs remain research information. The product gives no buy/sell advice, targets, probabilities or position sizes. It places no orders, holds no custody and cannot approve human gates.

## OpenBB first

[OpenBB's Open Data Platform](https://docs.openbb.co/odp) integrates data for Python, REST and MCP consumers. Evaluate it as an optional backend behind GenInvestor's provider interface. Retain direct SEC/ECB adapters where they preserve better source evidence. GenInvestor owns the evidence ledger, claims audit, mandate, review and user experience.

The first experiment uses one pinned backend, one provider, a small watchlist and recorded windows. Compare it with direct access to the same provider under the same entitlements. Preserve original receipts, historical availability, units, currency, adjustment/share basis and data rights. A normalized response without independently inspectable source evidence is insufficient for an audited figure.

Keep the core dependency-free. Optional Python/backend dependencies belong in a separate environment with scoped authentication, bounded retrieval and secret-safe logs. Service separation helps maintenance; it does not prove security or license compliance.

[OpenBB's checked revision](https://github.com/openbq-org/OpenBB/blob/ae0268771f761b036996d81bd21522ce79d95415/LICENSE) declares Apache-2.0. Older versions and dependencies need separate checks. Market-data rights and enterprise Workspace access are separate from the source-code license.

## QuantDinger as an optional paper lab

[QuantDinger](https://github.com/OpenByteInc/QuantDinger) documents strategy development, backtesting, paper/live execution and a trading interface. Its [checked license](https://github.com/OpenByteInc/QuantDinger/blob/ba8cd667acca3e934bbc1cb354922eff413393dc/LICENSE) declares Apache-2.0. Its runtime has not been independently tested for GenInvestor.

Evaluate it separately if a concrete paper-strategy job remains. Compare one deterministic strategy with the existing Python engine using identical recorded bars, timing, costs, warmup and holdout windows. Measure reconciliation, usable authoring capability, repair effort, footprint and recovery. Supply no live broker credentials and demonstrate live order paths are inaccessible; a paper label alone is insufficient.

If useful, exchange versioned study artifacts through a narrow file/API boundary. Audit imported figures. The lab cannot change GenInvestor's simulation ceiling or evidence/human-review gates. An external AI filter cannot replace those gates.

## Fork decision

| Choice | Proposed disposition |
|---|---|
| Direct SEC/ECB and price provider | Retain baseline and source-specific adapters |
| OpenBB backend | First integration experiment |
| OpenBB fork | Defer until a reproducible extension/API limitation exists |
| QuantDinger paper lab | Optional separate experiment |
| QuantDinger fork | Defer until useful capability and maintenance ownership are demonstrated |
| Live trading | Outside this roadmap |

A fork needs a named maintainer, pinned upstream, small patch inventory, license notices, upgrade checks, tests and rollback. Maintaining both full applications is not the first research deliverable.

## Delivery order

1. Obtain exact-revision different-provider review of the current alpha/foundations. Resolve integrity findings before release; passing tests do not establish live verification.
2. Verify real SEC ownership retrieval, reporting units and amendments. Choose a price source after checking actual terms and corporate actions; retain genuine receipts privately where required.
3. Compare OpenBB/direct access on correctness, evidence fidelity, historical boundaries, rights, repair time, latency, cost and resource footprint. Exercise denial, rate limit, timeout, malformed data, stale/missing coverage, tampering and offline replay.
4. Complete the daily session, with audited counter-case, saved review and interruption recovery. Live models need explicit IDs, three distinct providers and owner-configured request/cost limits.
5. Verify populated dashboard, evidence drawer, zero-result, restricted/stale and damaged-ledger states on desktop/mobile and keyboard. Finish clean installation, official MCP SDK conformance and public-export privacy checks.
6. Build a durable local book with versioned transactions, import preview/deduplication, reversible corrections, dated valuations, missing-coverage reporting, restart recovery and portable export. A temporary CSV position view is not this ledger.
7. Run the paper-lab comparison only if a specific strategy-research need remains; adopt the demonstrated capability with a tested removal path.

Unknown rights block disallowed output. Unavailable data is never silently replaced with synthetic data. A failed verifier or changed staged artifact prevents publication. Preserve prior valid research and show its age.

## Adoption evidence

Adopt when a matched-task comparison demonstrates useful coverage or reduced integration/repair work while preserving evidence, rights, recovery and bounded resource use. Record exact versions, inputs, results, sample counts, missing metrics and independent review findings. If a gain is unmeasured or an integrity requirement fails, defer and retain the working direct path.

No integration win, predictive performance, investment return or production readiness is claimed. This roadmap activates no broker connection, schedule, hosted private ledger or paid product. Documentation and executable enforcement require separate verification.
