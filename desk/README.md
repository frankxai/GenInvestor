# GenInvestor desk

A paper trading desk run by a ten-agent team. It scans a watchlist on public
data, argues both sides of every setup, sizes it, checks it against risk limits
and puts the survivors in a queue. You are the portfolio manager: a ticket
becomes a paper position only when he runs its approve command.

Ceiling `L2_SIMULATION`. No broker, no order type, no keys. `config.json` must
keep `"paper": true` or the cycle refuses to run, and a test fails if any desk
module mentions a broker or an order call.

## The team

| Crew | Agent | Works with |
| --- | --- | --- |
| Analysts | Regime Analyst | SPY, QQQ, IWM, VIX, TLT, GLD against 50 and 200-day averages |
| Analysts | Chart Scanner | `day-trader-skill:trader-scanner` (`scan.py daily`) |
| Analysts | News Monitor | `day-trader-skill:trader-news` |
| Research | Bull and Bear Researchers | Rules by default; Claude in session via the `trading-desk` skill |
| Trading | Trade Planner | Stop 1.5 ATR under entry, target 2R, set before entry |
| Trading | Time Machine | 10,000 seeded replays of the stock's own daily returns, plus every past firing of the setup |
| Risk | Risk Manager | Size to max loss, cap by position and cash, PASS or BLOCK with every reason |
| Decision | Portfolio Manager | You |
| Learning | Journal | Marks the paper book on daily closes, Brier score of the odds |

The shape comes from [TradingAgents](https://github.com/TauricResearch/TradingAgents),
the tools from [day-trader-skill](https://github.com/Jakeschincariol/day-trader-skill),
the regime-first habit from [claude-trading-skills](https://github.com/tradermonty/claude-trading-skills),
and the calibration ledger from GenInvestor. `team.json` is the roster.

## Run

```bash
python desk/cycle.py run              # live cycle, about 15 seconds -> desk/state/desk.json
python desk/cycle.py status           # the queue in plain text
python desk/cycle.py approve <ticket> # your yes: paper-fill that exact ticket
python desk/cycle.py reject <ticket>
python -m http.server 8010 -d desk    # then open http://localhost:8010
```

Python 3.8+, standard library only. The scanner and news agents call the
installed `day-trader-skill` plugin; without it the scanner runs the same rules
locally and the news agent reports itself degraded.

In Claude Code, `/trading-desk` runs a cycle, writes the bull and bear debate
from the trader skills' evidence, and refreshes the private page.

## Where data lives

`desk/state/` is git-ignored: live prices, headlines, the paper book and your
decisions stay on this machine. `desk/sample/desk.json` is a seeded synthetic
run for tests and demos. `snapshot.py` freezes a cycle into one HTML file you
can open locally or share privately; it refuses to write live data inside the
repository, and `--standalone` builds accept synthetic data only.

## Check

```bash
python -m unittest discover -s desk/tests -v
node --check desk/desk.js
```

## Limits

The Time Machine replays daily closes, so a stop that would fill intraday counts
at the close, and gaps through a stop are not modeled. Yahoo's chart endpoint is
unofficial and can lag. Odds describe the past and are not forecasts. Nothing
here is investment advice.

## Beyond single tickets

| Agent | What it adds |
| --- | --- |
| Cross-Market Analyst | 15 markets in five layers (equities, crypto, crypto equities, rates and credit, dollar and commodities): trend, stretch in units of own volatility, oversold base rates, 60-day correlations |
| Arena Referee | Seven strategy agents (trend, RSI(2) mean reversion, dual momentum, Donchian breakout, crypto trend, all weather, buy and hold) backtested walk-forward over a year with 5 bps costs; every day's holdings scored forward in `state/arena_ledger.json`; a meta-allocator weights agents by trailing 60-day Sharpe, capped at 40% |
| Day-Trading Lab | First-hour breakout, gap fade and trend-day rules on 60 sessions of hourly bars, flat by the close, 2 bps per side, with a t-statistic per rule and symbol |
| News Judge | Cloudflare Clef-flash event-risk gate (Jev-compatible API) |
| Hindsight Analyst | Grades every rule on the watchlist by regime; losing stock-rule records block |
| Editor and Design Critic | Copy check against the humanizer rules; feel contract and a final Impeccable pass after a visual look |

Model spend per cycle is shown on the page (`cost`): a few Clef calls, well under one cent. Every other agent is arithmetic.

**Before real money**, a strategy passes five checks in order: 20+ forward sessions, beats SPY after costs, drawdown inside your limit, a different model reviews rule and code, and you place the first order yourself. The desk never places one.

## Deploy a public demo

The desk is static, so no bundler is needed (Vite+ or Next.js would add a build step for nothing):

```bash
python desk/snapshot.py desk/deploy/dist/index.html --data desk/sample/desk.json --standalone
npx wrangler deploy --dry-run --config desk/deploy/wrangler.jsonc   # check only
```

`--standalone` refuses anything but synthetic data. The same `dist/` folder deploys to Vercel as a static site. Publish it once you have checked the dry run.

## Build on it

The desk is Apache-2.0. You may use it, change it, sell products built on it and run it for clients, commercially, as long as you keep the license and notices. The license covers the code, not the GenInvestor name: ship your product under your own brand.

Three places to extend, each a single file:

| You want to | Edit | What to add |
| --- | --- | --- |
| Add a strategy fund | `desk/engine/arena.py` and `desk/engine/funds.py` | A function `(hist, day) -> {symbol: weight}` in `AGENTS`, and a profile in `PROFILES` (expertise, workflow, edge, risk rules, when it fails). The arena backtests it, the funds page shows its trades and coaching, and the forward ledger scores it daily. |
| Add a data source | `desk/engine/data.py` | A fetcher that returns `{dates, open, high, low, close, volume}`, oldest first. Keep it read-only. |
| Swap the decision model | `desk/engine/clef.py` | Any System One API model (Cloudflare Clef, TypeSafe Jev) works by changing `MODEL` and the endpoint. |

White-label the look in `desk/desk.css`: every color, font and radius is a token on `:root`, with light and dark sets.

Ideas people build on this: a research newsletter written from the daily brief, a client dashboard for an advisory practice, a strategy marketplace where each fund is a published rule, a classroom for teaching risk and position sizing. Anything that touches real money needs your own compliance review in your jurisdiction.

**Not investment advice.** Software that reads public data and does arithmetic. Backtests flatter the past; the forward ledger is the honest record. No warranty, as the license says.
