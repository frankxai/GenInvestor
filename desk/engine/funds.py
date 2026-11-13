"""Funds: each arena agent run as its own fund, with a manager profile, a written
workflow, the trades it would have made, today's and tomorrow's decisions, and
coaching drawn from its own record.

Profiles describe a style and its lineage; they are not claims about any real
manager's views or results.
"""
PROFILES = {
    "trend": {
        "fund": "Long Trend Capital", "style": "Systematic trend following",
        "expertise": "Futures-style trend following applied to large-cap stocks and ETFs",
        "workflow": ["Screen every asset against its 50 and 200-day averages",
                     "Hold only what is above both", "Size by inverse volatility so each position risks about the same",
                     "Exit the day an asset loses either average"],
        "edge": "Big trends last longer than most people expect; cutting losers early keeps the losses small.",
        "risk": "No position above 25%. Cash when nothing trends.",
        "fails_when": "Markets chop sideways: it buys late and sells early, again and again."},
    "reversion": {
        "fund": "Snapback Partners", "style": "Short-term mean reversion",
        "expertise": "Buying two-day selloffs in stocks that are still in long-term uptrends",
        "workflow": ["Keep only stocks above their 200-day average", "Buy when the 2-day RSI drops below 10",
                     "Hold until the 2-day RSI recovers above 70", "Never more than 20% in one name"],
        "edge": "Sharp dips in strong stocks are usually overreactions that partly reverse within days.",
        "risk": "Long-term trend filter first; small positions; no averaging down.",
        "fails_when": "A dip is the start of a real decline: news, earnings or a regime change."},
    "momentum": {
        "fund": "Relative Strength Fund", "style": "Dual momentum rotation",
        "expertise": "Ranking assets by six-month return and holding only leaders that beat cash",
        "workflow": ["Rank the universe by six-month return", "Keep the top three",
                     "Require each to beat the cash yield over the same period", "Hold cash if none qualifies"],
        "edge": "Winners keep winning for months; the cash test sidesteps long bear markets.",
        "risk": "Equal weight across three names; absolute momentum check against cash.",
        "fails_when": "Leadership flips fast, as in sharp rotations: it holds last quarter's winners into the turn."},
    "breakout": {
        "fund": "Channel Breakout LP", "style": "Donchian channel breakouts",
        "expertise": "Entering new 20-day highs and riding them until a 10-day low",
        "workflow": ["Buy a new 20-day high", "Stay in while price holds above the 10-day low",
                     "Spread risk across up to five names", "Exit on the 10-day low"],
        "edge": "Breakouts catch the start of new trends early.",
        "risk": "20% per name; the 10-day low is the stop.",
        "fails_when": "Breakouts fail in a range-bound market, which this year's record shows clearly."},
    "crypto": {
        "fund": "Digital Trend Fund", "style": "Crypto trend filter",
        "expertise": "Bitcoin and Ether, held only in uptrends",
        "workflow": ["Check Bitcoin and Ether against their 50-day averages", "Hold whichever is above",
                     "Split equally", "Cash otherwise"],
        "edge": "Crypto trends are strong and long; staying out of downtrends avoids the worst drawdowns.",
        "risk": "Never more than two assets; cash when both are below trend.",
        "fails_when": "Sharp whipsaws around the 50-day average, common after big drops."},
    "allweather": {
        "fund": "Balanced Seasons", "style": "Fixed all-weather mix",
        "expertise": "A Dalio-style mix meant to survive growth and inflation surprises",
        "workflow": ["Hold 30% stocks, 40% long Treasuries, 15% gold, 15% cash", "Rebalance to the mix"],
        "edge": "No forecasts: different assets win in different regimes.",
        "risk": "Fixed weights; no single bet dominates.",
        "fails_when": "Rising real rates, when stocks, bonds and gold fall together. That is today's regime."},
    "benchmark": {
        "fund": "Index Fund", "style": "Buy and hold the S&P 500",
        "expertise": "Owning the market at the lowest cost", "workflow": ["Buy SPY", "Hold"],
        "edge": "Low cost and no decisions to get wrong.", "risk": "None beyond the market itself.",
        "fails_when": "Bear markets, which it rides all the way down."},
}

TRADE_DAYS = 20


def history(fn, series, dates, days=TRADE_DAYS):
    """Replay the last `days` decisions: what each day's close told the fund to hold."""
    out = []
    for t in range(len(dates) - days - 1, len(dates)):
        w = fn({s: c[: t + 1] for s, c in series.items()}, dates[t])
        out.append((t, w))
    return out


def trades(decisions, series, dates):
    """Turn day-to-day weight changes into trades priced at that day's close."""
    rows, prev = [], None
    for t, w in decisions:
        if prev is not None:
            for s in sorted(set(w) | set(prev)):
                change = w.get(s, 0) - prev.get(s, 0)
                if abs(change) >= 0.02:
                    side = "buy" if change > 0 else "sell"
                    if prev.get(s, 0) == 0:
                        side = "open"
                    elif w.get(s, 0) == 0:
                        side = "close"
                    rows.append({"date": dates[t], "symbol": s, "side": side, "weight_change": round(change, 3),
                                 "weight": round(w.get(s, 0), 3), "price": round(series[s][t], 2)})
        prev = w
    return rows


def daily_returns(decisions, series, cash_yield, days_per_year=252):
    """Each decision's next-day return, so the trades page can show how the call paid."""
    out = []
    for (t, w), (t2, _) in zip(decisions, decisions[1:]):
        r = sum(wt * (series[s][t2] / series[s][t] - 1) for s, wt in w.items())
        r += max(0.0, 1 - sum(w.values())) * cash_yield / days_per_year
        out.append(round(r * 100, 3))
    return out


def coach(st, bench_total, holds, cash):
    """Refinement notes from the fund's own record. Each note names the number behind it."""
    notes = []
    if not st:
        return ["Not enough history to judge."]
    if st["turnover_days"] > 150 and (st["sharpe"] or 0) < 0.5:
        notes.append("Traded on %d of 252 days with a Sharpe of %s: costs eat the edge. Rebalance weekly, or only when a weight drifts more than 5 points." % (
            st["turnover_days"], st["sharpe"]))
    if st["max_dd_pct"] < -15:
        notes.append("Worst drop %s%%: add a regime filter (cash when SPY is below its 200-day average) or a portfolio stop." % st["max_dd_pct"])
    if 0 < (st["sharpe"] or 0) and st["total_pct"] < bench_total:
        notes.append("Positive, but %s%% trails SPY's %s%%: the rule has not yet earned its complexity." % (st["total_pct"], bench_total))
    if (st["sharpe"] or 0) >= 1:
        notes.append("Best risk-adjusted record (Sharpe %s): first in line for the 20-session forward test." % st["sharpe"])
    if (st["sharpe"] or 0) < 0:
        notes.append("Lost to cash after costs (Sharpe %s). Keep it in the arena as a control, with no capital." % st["sharpe"])
    if cash >= 0.99:
        notes.append("Holding all cash for tomorrow: no setup qualified. Waiting is part of this rule.")
    return notes or ["Record is in line with its style; nothing to change before more forward days."]


def build(agents, series, dates, results, cash_yield):
    """One fund record per arena agent."""
    bench = next((r["stats"]["total_pct"] for r in results if r["id"] == "benchmark" and r["stats"]), 0)
    funds = []
    for (key, name, lineage, fn), res in zip(agents, results):
        dec = history(fn, series, dates)
        today, prev = dec[-1][1], dec[-2][1]
        orders = [{"symbol": s, "from": round(prev.get(s, 0), 3), "to": round(today.get(s, 0), 3)}
                  for s in sorted(set(today) | set(prev)) if abs(today.get(s, 0) - prev.get(s, 0)) >= 0.02]
        funds.append(dict(PROFILES.get(key, {}), id=key, agent=name, lineage=lineage,
                          trades=trades(dec, series, dates)[-40:], daily=daily_returns(dec, series, cash_yield),
                          days=[dates[t] for t, _ in dec[:-1]], tomorrow=orders,
                          coaching=coach(res["stats"], bench, res["holds"], res["cash"])))
    return funds
