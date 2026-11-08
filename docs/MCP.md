# GenInvestor MCP server

`@geninvestor/mcp` v0.1.0 exposes GenInvestor to an MCP client over **stdio**. It is private to this repository, has zero dependencies, and ships as `packages/mcp/bin/geninvestor-mcp.ts`. It is the second surface of the same product as the CLI, not a separate service.

The server reads the local evidence ledger and briefs, answers questions about them, and can run the same local brief the CLI runs. It never holds custody, places orders, or moves money.

## Start the server

From the repository root:

```bash
npm install
npm run mcp
```

Both scripts resolve to:

```bash
node --disable-warning=ExperimentalWarning packages/mcp/bin/geninvestor-mcp.ts
```

The process speaks JSON-RPC 2.0 over stdin/stdout and writes diagnostics to stderr only. A ready line goes to stderr, for example `geninvestor-mcp ready (home: .../.geninvestor)`.

### State directory

All local state lives under one home directory:

| Source | Value |
|---|---|
| `--home DIR` flag | takes precedence |
| `GENINVESTOR_HOME` environment variable | used when no flag is given |
| Default | `./.geninvestor` relative to the working directory |

Under it: `ledger.db` (evidence ledger), `runs.db` (workflow runs), `calibration.db` (registered forecasts), `briefs/` (published briefs), `opportunities/` (scout output).

### Register it with a client

Claude Code, using the command documented in `README.md`:

```bash
claude mcp add geninvestor -- node --disable-warning=ExperimentalWarning /absolute/path/to/GenInvestor/packages/mcp/bin/geninvestor-mcp.ts
```

For any other client, configure a stdio server whose command is `node` and whose arguments are `--disable-warning=ExperimentalWarning`, the absolute path to `packages/mcp/bin/geninvestor-mcp.ts`, and optionally `--home` plus a directory. Pass `GENINVESTOR_HOME` through the client's environment block if you prefer.

### Protocol

- Transport: newline-delimited JSON-RPC 2.0 on stdio. Batches and non-object messages are rejected.
- Supported protocol versions: `2025-06-18`, `2025-03-26`, `2024-11-05`. The client's requested version is echoed when supported, otherwise the newest is offered.
- Methods: `initialize`, `ping`, `tools/list`, `tools/call`. Anything else returns `-32601`.
- `tools/list` and `tools/call` return `-32002` until `initialize` has been sent. Send `notifications/initialized` as usual; notifications need no reply.
- `stdout` carries protocol messages only.

## Tools

Seven tools, defined in `packages/mcp/src/tools.ts`. Every call passes the same autonomy gate the engine uses, with the `research` verb; if the policy table ever disallowed research, the server would stop answering rather than carry on.

| Tool | Job | Annotations | Arguments |
|---|---|---|---|
| `check_action` | Ask whether an action would be allowed, needs a human, or is blocked. Answers only; never performs the action. | `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: false` | `action_type` (string, required); optional `mode`, `uses_real_funds`, `touches_wallet`, `touches_banking`, `requires_secret`, `amount`, `cap` |
| `explain_claim` | Show a claim, each link, and the source with its as-of date, retrieval time, sha256 and licence class. | `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: false` | `claim_id` (string, required) |
| `verify_ledger` | Re-hash every stored source and report any whose bytes no longer match. | `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: false` | none |
| `get_latest_brief` | Return the last brief published locally, as markdown and structured data. Runs nothing. | `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: false` | none |
| `list_opportunities` | Return the last set of research candidates found against the owner's mandate, with evidence, the case against, and what would prove each wrong. Candidates, not recommendations; runs nothing. | `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: false` | none |
| `get_calibration` | Return forecast counts, what is due, and Brier score with reliability once at least 30 are resolved. Below that, counts only. Cannot register or resolve a call. | `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: false` | none |
| `run_today` | Fetch public ECB data, compute changes, check theses, verify and audit every claim, and publish the brief locally. | `readOnlyHint: false`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: true` | none |

`readOnlyHint` on six tools reflects what they do: they read local state and return it. They do not write, fetch, or change anything. `run_today` is the one exception and is marked honestly.

The authoritative input schema is whatever the server returns from `tools/list`; inspect `tools/list` for the schema rather than relying on a copy. Result payloads carry a text `content` block, optional `structuredContent`, and `isError`.

## Example calls

Three read-only calls, as they look on the wire (one JSON object per line):

```json
{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"check_action","arguments":{"action_type":"live_trade"}}}
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"explain_claim","arguments":{"claim_id":"<claim id from a brief>"}}}
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"verify_ledger","arguments":{}}}
```

What each returns:

- `check_action` — a verdict and its reason, for example `human_gate: ...`, plus `requiredGate` in `structuredContent`. It does not execute the action it was asked about.
- `explain_claim` — the claim text followed by one line per evidence link, each naming the provider, URL, as-of date, retrieval time, sha256 and licence class. An unknown id returns `isError: true` with `No claim <id> in the ledger.`
- `verify_ledger` — `Ledger ok: every stored source matches its hash.` or the list of sources whose bytes no longer match, with `isError: true`.

The same three jobs exist on the command line as `geninvestor policy <verb>`, `geninvestor explain <claim id>` and `geninvestor verify`.

### The one tool that runs anything

```json
{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"run_today","arguments":{}}}
```

`run_today` is **local-only**. It fetches public ECB series, computes changes, checks theses, audits each claim, and writes `brief.md` and `brief.json` under `<home>/briefs/`. It reaches the public ECB API and nothing else. It is not a market action: no order is drafted, placed, routed or signed, and no money moves. If a thesis is marked broken by rule, the run stops and waits for a human decision that cannot be made through this server.

## What the server will not do

- It does not approve, trade, transfer, sign, or draft an order, and it does not touch a wallet, a bank, or a broker account.
- It does not hold custody, keys, or seed phrases, and it never asks for them.
- It does not register, edit, or resolve a forecast. Probabilities are the owner's own, entered through the CLI before the outcome.
- It does not produce a recommendation, a price target, a position size, or a probability for a security. The opportunity contract has no field for any of them.
- It does not write to the ledger except through the audited `run_today` workflow, and it does not rewrite stored evidence.
- It does not serve HTTP, listen on a port, or run as a hosted service.
- It does not give advice. See [../DISCLAIMER.md](../DISCLAIMER.md).

A test in `packages/mcp/test/mcp.test.ts` fails if a tool is added that would break these limits.

## Troubleshooting

- `Server not initialized` (`-32002`): send `initialize` before `tools/list` or `tools/call`.
- `Unknown tool`: the name is not one of the seven above.
- `No brief has been published yet. Run run_today first.`: `<home>/briefs/` is empty for this home directory. Check `--home` and `GENINVESTOR_HOME`.
- `No scan has been run yet.`: the opportunity scan is started from the CLI with `geninvestor scout --mandate FILE`, not from this server.
- Nothing on stdout in a terminal: the server is waiting for JSON-RPC lines. `Ctrl+C` to exit.

## See also

- [../README.md](../README.md) — quick start, guarantees, known limits.
- [../llms.txt](../llms.txt) — one-screen agent entry point.
- [../packages/mcp](../packages/mcp) — the package itself.
