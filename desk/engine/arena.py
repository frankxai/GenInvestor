"""Strategy arena: dedicated strategy agents, each running its own paper
portfolio by a fixed, published rule. Every agent is tested the same way:

- Backtest: walk forward one day at a time over the loaded history. Weights are
  decided on day t's close and earn day t+1's return, so nothing sees the future.
- Costs: COST_BPS on every unit of turnover.
- Forward test: each cycle records what every agent holds for the next session;
  the next cycle scores it. Only forward results can justify real money.

The meta-allocator is the self-learning part: it weights the agents by their
trailing risk-adjusted return, with a cap so no single rule can take over.
"""
import math

from . import quant

COST_BPS = 5
WARMUP = 201  # the longest rule needs a 200-day average before the test window starts
CASH_YIELD = 0.0390  # effective fed funds 3.88% on 2026-11-12 (Fed H.15); used as the cash return
DAYS = 252
STOCKS = ["SPY", "QQQ", "IWM", "AAPL", "MSFT", "NVDA", "AMD", "META", "AMZN", "GOOGL", "AVGO", "COST", "JPM", "LLY", "XOM", "UNH"]
CRYPTO = ["BTC-USD", "ETH-USD"]
DEFENSIVE = ["TLT", "GLD", "HYG"]


def _rsi_n(c, n):
    return quant.rsi(c, n)


def trend_follower(hist, day):
    """Turtle and Tudor Jones heritage: hold what is above its 50 and 200-day
    averages, equal risk (inverse volatility). Nothing qualifies: cash."""
    picks = {}
    for s, c in hist.items():
        if s in CRYPTO or len(c) < 201:
            continue
        if c[-1] > sum(c[-200:]) / 200 and c[-1] > sum(c[-50:]) / 50:
            vol = _vol(c)
            if vol:
                picks[s] = 1 / vol
    return _norm(picks, cap=0.25)


def mean_reversion(hist, day):
    """Larry Connors' RSI(2): buy a sharp two-day dip in a stock still above its
    200-day average; hold until RSI(2) recovers above 70 (handled by re-deciding daily)."""
    picks = {}
    for s, c in hist.items():
        if s in CRYPTO or s in DEFENSIVE or len(c) < 201:
            continue
        r2 = _rsi_n(c[-30:], 2)
        if c[-1] > sum(c[-200:]) / 200 and r2 is not None and r2 < 10:
            picks[s] = 1.0
    return _norm(picks, cap=0.2)


def dual_momentum(hist, day):
    """Gary Antonacci's dual momentum: the three strongest six-month performers,
    but only if they beat cash; otherwise hold cash."""
    scored = []
    for s, c in hist.items():
        if len(c) < 127:
            continue
        r = c[-1] / c[-127] - 1
        if r > CASH_YIELD / 2:
            scored.append((r, s))
    top = [s for _, s in sorted(scored, reverse=True)[:3]]
    return _norm({s: 1.0 for s in top})


def breakout(hist, day):
    """Richard Donchian's channel: a new 20-day high enters, a new 10-day low exits.
    Re-decided daily as: hold while above the 10-day low after a 20-day breakout."""
    picks = {}
    for s, c in hist.items():
        if s in CRYPTO or s in DEFENSIVE or len(c) < 25:
            continue
        if c[-1] >= max(c[-20:]) or (c[-1] > min(c[-10:]) and max(c[-5:]) >= max(c[-25:-5])):
            picks[s] = 1.0
    return _norm(picks, cap=0.2)


def crypto_trend(hist, day):
    """Bitcoin and Ether only when above their 50-day average, otherwise cash."""
    picks = {s: 1.0 for s in CRYPTO if s in hist and len(hist[s]) > 51 and hist[s][-1] > sum(hist[s][-50:]) / 50}
    return _norm(picks)


def all_weather(hist, day):
    """A Dalio-style fixed mix rebalanced daily: stocks, long bonds, gold, cash."""
    mix = {"SPY": 0.30, "TLT": 0.40, "GLD": 0.15}
    return {s: w for s, w in mix.items() if s in hist}  # the remaining 15% earns cash


def buy_hold(hist, day):
    """The benchmark every agent has to beat: the S&P 500, always."""
    return {"SPY": 1.0} if "SPY" in hist else {}


AGENTS = [
    ("trend", "Trend Follower", "Turtles, Tudor Jones", trend_follower),
    ("reversion", "Mean Reverter", "Larry Connors' RSI(2)", mean_reversion),
    ("momentum", "Momentum Rotator", "Antonacci's dual momentum", dual_momentum),
    ("breakout", "Breakout Trader", "Donchian channels", breakout),
    ("crypto", "Crypto Trend", "50-day trend filter", crypto_trend),
    ("allweather", "All Weather", "Dalio-style fixed mix", all_weather),
    ("benchmark", "Benchmark", "Buy and hold SPY", buy_hold),
]


def _vol(c, n=20):
    rets = [c[i] / c[i - 1] - 1 for i in range(len(c) - n, len(c))]
    return (sum(r * r for r in rets) / n) ** 0.5 or None


def _norm(w, cap=1.0):
    total = sum(w.values())
    if not total:
        return {}
    out = {s: min(cap, v / total) for s, v in w.items()}
    return out  # whatever the cap leaves over stays in cash


def calendar(bars, symbols):
    """Shared trading calendar: dates where SPY traded (crypto is sampled on those dates)."""
    return [d for d in bars["SPY"]["dates"]] if "SPY" in bars else []


def aligned(bars, symbols, dates):
    """{symbol: [close on each calendar date]}, forward-filling gaps."""
    out = {}
    for s in symbols:
        if s not in bars:
            continue
        m = dict(zip(bars[s]["dates"], bars[s]["close"]))
        series, last = [], None
        for d in dates:
            last = m.get(d, last)
            series.append(last)
        if all(v is not None for v in series[-260:]):
            out[s] = series
    return out


def stats(equity, turnover_days, n_days):
    rets = [equity[i] / equity[i - 1] - 1 for i in range(1, len(equity))]
    if not rets:
        return None
    mean = sum(rets) / len(rets)
    sd = (sum((r - mean) ** 2 for r in rets) / len(rets)) ** 0.5
    peak, mdd = equity[0], 0.0
    for e in equity:
        peak = max(peak, e)
        mdd = min(mdd, e / peak - 1)
    total = equity[-1] / equity[0] - 1
    years = n_days / DAYS
    cagr = (equity[-1] / equity[0]) ** (1 / years) - 1 if years > 0 else None
    sharpe = ((mean - CASH_YIELD / DAYS) / sd * math.sqrt(DAYS)) if sd else None
    return {"total_pct": round(total * 100, 1), "cagr_pct": round(cagr * 100, 1) if cagr is not None else None,
            "vol_pct": round(sd * math.sqrt(DAYS) * 100, 1), "sharpe": round(sharpe, 2) if sharpe is not None else None,
            "max_dd_pct": round(mdd * 100, 1), "turnover_days": turnover_days}


def backtest(fn, series, dates, start):
    """Walk forward from index `start`. Returns the equity curve and stats."""
    eq, w_prev, turn_days = [1.0], {}, 0
    for t in range(start, len(dates) - 1):
        hist = {s: c[: t + 1] for s, c in series.items()}
        w = fn(hist, dates[t])
        turnover = sum(abs(w.get(s, 0) - w_prev.get(s, 0)) for s in set(w) | set(w_prev))
        if turnover > 1e-9:
            turn_days += 1
        cash_w = max(0.0, 1 - sum(w.values()))
        r = sum(wt * (series[s][t + 1] / series[s][t] - 1) for s, wt in w.items()) + cash_w * CASH_YIELD / DAYS
        eq.append(eq[-1] * (1 + r - turnover * COST_BPS / 1e4))
        w_prev = w
    return eq, stats(eq, turn_days, len(eq) - 1)


def meta_weights(curves, lookback=60, cap=0.4):
    """Self-learning allocator: weight each agent by its trailing Sharpe (floored at
    zero), capped so no single rule can run the whole book. No agent earns weight
    for a losing stretch; if none earns any, the meta book sits in cash."""
    scores = {}
    for k, eq in curves.items():
        if k == "benchmark" or len(eq) <= lookback:
            continue
        seg = eq[-lookback - 1:]
        rets = [seg[i] / seg[i - 1] - 1 for i in range(1, len(seg))]
        m = sum(rets) / len(rets)
        sd = (sum((r - m) ** 2 for r in rets) / len(rets)) ** 0.5
        s = ((m - CASH_YIELD / DAYS) / sd * math.sqrt(DAYS)) if sd else 0
        scores[k] = max(0.0, s)
    total = sum(scores.values())
    if not total:
        return {}
    raw = {k: v / total for k, v in scores.items()}
    capped = {k: min(cap, v) for k, v in raw.items()}
    return {k: round(v, 3) for k, v in capped.items() if v > 0}


def run(bars):
    symbols = STOCKS + CRYPTO + DEFENSIVE
    dates = calendar(bars, symbols)
    series = aligned(bars, symbols, dates)
    if len(dates) < DAYS + WARMUP or "SPY" not in series:
        return None  # too little history: the 200-day rules would sit in cash and look like a decision
    start = len(dates) - DAYS  # test the last year; the earlier year is warm-up for the 200-day rules
    results, curves = [], {}
    for key, name, lineage, fn in AGENTS:
        eq, st = backtest(fn, series, dates, start)
        curves[key] = eq
        hold = fn({s: c for s, c in series.items()}, dates[-1])
        results.append({"id": key, "name": name, "lineage": lineage, "stats": st,
                        "holds": {s: round(w, 3) for s, w in sorted(hold.items(), key=lambda x: -x[1])},
                        "cash": round(max(0.0, 1 - sum(hold.values())), 3),
                        "curve": [round(x, 4) for x in eq[::5]] + [round(eq[-1], 4)]})
    mw = meta_weights(curves)
    from . import funds
    return {"window": [dates[start], dates[-1]], "cost_bps": COST_BPS, "cash_yield": CASH_YIELD,
            "agents": results, "meta": mw, "funds": funds.build(AGENTS, series, dates, results, CASH_YIELD)}


def forward(ledger, result, series_close, latest):
    """Score each recorded day's holdings from its own date to the next trading date
    (never across a gap of missed cycles), net of the turnover cost against that
    agent's previous holdings. Running totals live in the ledger, so trimming the
    display list never changes the record."""
    ledger = dict(ledger or {})
    records = list(ledger.get("records", []))
    scored = list(ledger.get("scored", []))
    totals = {k: dict(v) for k, v in ledger.get("totals", {}).items()}
    spy_dates = sorted(series_close.get("SPY", {}))
    prev_holds = {}
    for rec in records:
        nxt = next((d for d in spy_dates if d > rec["date"]), None)
        if not rec.get("scored") and nxt and nxt <= latest:
            for agent, holds in rec["holds"].items():
                r, ok = 0.0, True
                for s, w in holds.items():
                    a, b = series_close.get(s, {}).get(rec["date"]), series_close.get(s, {}).get(nxt)
                    if a is None or b is None:
                        ok = False
                        break
                    r += w * (b / a - 1)
                if not ok:
                    continue
                before = prev_holds.get(agent, {})
                turnover = sum(abs(holds.get(s, 0) - before.get(s, 0)) for s in set(holds) | set(before))
                net = r + max(0.0, 1 - sum(holds.values())) * CASH_YIELD / DAYS - turnover * COST_BPS / 1e4
                scored.append({"agent": agent, "from": rec["date"], "to": nxt, "ret_pct": round(net * 100, 3)})
                t = totals.setdefault(agent, {"days": 0, "growth": 1.0})
                t["days"] += 1
                t["growth"] *= 1 + net
            rec = dict(rec, scored=True)
        prev_holds = rec["holds"]
        records[records.index(next(x for x in records if x["date"] == rec["date"]))] = rec
    records = [r for r in records if r["date"] != latest]
    records.append({"date": latest, "holds": {a["id"]: a["holds"] for a in result["agents"]}})
    summary = {k: {"days": v["days"], "total_pct": round((v["growth"] - 1) * 100, 2)} for k, v in totals.items()}
    return {"records": records[-60:], "scored": scored[-2000:], "totals": totals, "summary": summary}
