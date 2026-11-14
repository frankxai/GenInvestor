# Agents working in GenInvestor

Guidance for any coding agent (Claude Code, Codex, Cursor, Gemini, others) changing this repository.

## Hard limits

- No brokerage client, exchange key, wallet or order code anywhere. Everything here is research and paper simulation.
- No live market data, headlines or personal holdings in git. The desk keeps them in `desk/state/`, which is ignored.
- Every number shown to a user names its source; simulated results are labeled as simulated.

## Layout and checks

| Path | What | Check |
| --- | --- | --- |
| `engine/`, `packages/` | Research engine and packages | see `CONTRIBUTING.md` |
| `desk/` | Paper investing desk: agent cycle, strategy funds, dashboard | `python -m unittest discover -s desk/tests` and `node --check desk/desk.js` |
| `.claude/skills/trading-desk/` | How an agent runs the desk | read before running a cycle |

## Working here

One branch per change, a draft pull request, and a review by someone other than the author before merge.
On the desk, an agent never approves or rejects a ticket for a person: the human is the portfolio manager.
