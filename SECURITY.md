# Security

GenInvestor is local-first software that reads public data and writes files on your machine. It has no server component you have to trust, holds no credentials, and cannot place orders.

## What it guards

- **No custody, no orders.** The autonomy gate caps the whole system at simulation. The MCP server has no tool that approves, trades, transfers or signs, and a test fails if one is added.
- **No secrets.** API keys, seed phrases, private keys and raw account exports are hard-blocked verbs. Do not put them in the ledger, in briefs, or in issues.
- **Tamper evidence.** The evidence ledger is append-only (enforced by database triggers), and `geninvestor verify` re-hashes every stored source.
- **Licence-aware display.** Data marked `sim_only`, `user_licensed` or `restricted` is refused in hosted and public contexts.

## Reporting a vulnerability

Open a private security advisory on the GitHub repository, or email the maintainer listed there. Please include a reproduction and the version. Do not open a public issue for anything that could let a caller bypass the gate or forge evidence.

Reports about the following are in scope and treated as high priority: a way to obtain `allow` for an action the shared gate table forbids, a way to publish a brief with an unbacked number, a way to alter the ledger without `verify` noticing, or a path that reaches real funds.

## Supply chain

The core packages have zero runtime dependencies on purpose. Adding one needs a written reason in the pull request.

## Regulatory note for people who deploy this

If you run GenInvestor as a service for other people, you may be a "manufacturer" or "open-source steward" under the EU Cyber Resilience Act and the software may be a "product" under the revised Product Liability Directive. Get advice for your situation; this project does not give legal advice.
