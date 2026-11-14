---
name: trading-desk
description: Run the GenInvestor paper trading desk in this repo. Use when the owner says "run the desk", "desk cycle", "what's on the desk", "debate the tickets", or asks for today's setups. Runs one cycle on live public data, writes Claude's bull and bear debate for each ticket, and refreshes the dashboard. Never approves a ticket.
---

# Trading desk

The desk lives in `desk/`. Ceiling `L2_SIMULATION`: there is no broker, no order
type, and no path from this skill to money. Paper only.

## Roles

You play the two Research agents (Bull and Bear) and you operate the cycle.
The owner is the Portfolio Manager. You never run `approve` or `reject` for him,
even when asked to "just take the good ones": show the ticket and the command,
and let him run it.

## One cycle

1. `python desk/cycle.py run` (live, about 15 seconds). Read the printed line.
2. `python desk/cycle.py status` for the queue.
3. For each ticket with verdict PASS, build the debate from evidence, not mood:
   - `/day-trader-skill:trader-analyst <SYM>`: what changed in the last quarters.
   - `/day-trader-skill:trader-news`: the name's own headlines. Earnings inside the
     plan's horizon is a bear point by default.
   - `/trader-skill:trader-pelosi` if a disclosure exists for the name.
   - The ticket's own numbers in `desk/state/tickets.json`: Time Machine odds,
     history replay count, RSI, relative volume, regime.
   Every point is one checkable fact with its number. If a side has nothing real,
   leave it short. Do not invent a catalyst.
4. Write `desk/state/debate.json`, keyed by ticket id:

   ```json
   {"2026-11-12-AMD": {"bull": ["..."], "bear": ["..."], "lean": "bull|bear|split",
                       "author": "Claude (model name) + trader-analyst, trader-news"}}
   ```

5. `python desk/cycle.py run` again so the debate lands on the tickets.
6. Optional skeptic: ask a different provider to attack the strongest PASS
   ticket (any other vendor's model, read-only). Add its strongest point to the
   bear list with its name as source.
7. Refresh the private page: `python desk/snapshot.py <scratch>/geninvestor-desk.html`
   and republish the same artifact path.

## The Strategist's loop (after the cycle)

1. **Intelligence.** Refresh `desk/state/intel.json`: four sections (macro and
   the Fed, what the market says, the AI cycle, social dynamics). Each signal has
   signal, reading, implication, source URL and confidence. Live search only;
   anything unconfirmed goes in `unverified`, never into a signal.
2. **Read hindsight first.** `desk.json` → `hindsight`: per-rule results by
   regime and the best and worst stock-rule records. A losing record (8+
   firings, negative average) blocks automatically. Check for artifacts before
   writing a lesson: single trades tie at +2R or -1R, so rank averages, never trades.
3. **Strategy.** Update `desk/state/strategy.json`: stance, one line, principles,
   playbook, and a call per candidate (bet, wait, pass, hold) with thesis,
   against, invalidation and review date. Every number must come from the cycle
   or a cited source.
4. **Bets.** Only PASS tickets, in the Strategist's own book:
   `python desk/cycle.py bet <ticket> --why "<thesis in one line>"`. Never
   `approve` or `reject`: that is the owner's book.
5. **News Judge.** Clef runs inside the cycle when `CLOUDFLARE_ACCOUNT_ID` and
   `CLOUDFLARE_API_TOKEN` are set, capped at 12 calls, through the
   optional AI Gateway in `CF_AIG_GATEWAY`. Event risk at or above `max_event_risk` blocks.

## Reporting to the owner

Lead with the regime and the number of tickets waiting. For each waiting ticket:
symbol, setup, entry/stop/target, shares and max loss, Time Machine target-first
odds and expectancy, history replay, the one strongest bull and bear point, and
the approve command. Say plainly when nothing passed. Odds are replays of the
past; never call them predictions or recommendations.

## Changing the desk

Rules live in `desk/config.json` (paper must stay `true`). Agents and their skill
bindings live in `desk/team.json`. Run `python -m unittest discover -s desk/tests`
after any change.
