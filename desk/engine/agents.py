"""The desk's agents. Each one reads what the previous ones wrote and adds one
thing. The shape follows TradingAgents (analysts, a bull/bear debate, a trader,
risk, a portfolio manager) with two changes: the portfolio manager is the human who runs it, and
every proposal carries odds that the journal later scores.

The rule-based debate here is the floor. When Claude runs the desk in a session
(see .claude/skills/trading-desk), it writes a model-written debate into
state/debate.json and the dashboard shows that instead.
"""
from . import quant

REGIME_SYMBOLS = ["SPY", "QQQ", "IWM", "^VIX", "TLT", "GLD"]
# trader-news tags that can gap a stock through a stop; analyst, capital and macro do not count
EVENT_TAGS = {"earnings", "legal", "deal", "risk", "halt", "regulatory", "people"}


def regime(bars):
    """Trend of the broad market: price vs 50/200-day averages, plus VIX."""
    rows, score = [], 0
    for sym in REGIME_SYMBOLS:
        b = bars.get(sym)
        if not b or len(b["close"]) < 200:
            continue
        c = b["close"]
        s50, s200 = quant.sma(c, 50), quant.sma(c, 200)
        row = {"symbol": sym, "last": round(c[-1], 2), "d1": round(quant.pct(c[-1], c[-2]), 2),
               "d20": round(quant.pct(c[-1], c[-21]), 2), "above50": c[-1] > s50, "above200": c[-1] > s200,
               "spark": [round(x, 2) for x in c[-60:]]}
        rows.append(row)
        if sym in ("SPY", "QQQ", "IWM"):
            score += (1 if row["above50"] else -1) + (1 if row["above200"] else -1)
    vix = next((r for r in rows if r["symbol"] == "^VIX"), None)
    if vix:
        score += 1 if vix["last"] < 18 else (-2 if vix["last"] > 25 else 0)
    label = "risk_on" if score >= 3 else ("risk_off" if score <= -3 else "neutral")
    why = "%d of 3 indexes above their 200-day average" % sum(
        1 for r in rows if r["symbol"] in ("SPY", "QQQ", "IWM") and r["above200"])
    if vix:
        why += ", VIX %.1f" % vix["last"]
    return {"label": label, "score": score, "why": why, "rows": rows}


def scanner_from_bars(bars, symbols):
    """Fallback when the /trader-scanner tool is unavailable: the same rules, locally."""
    hits = []
    for s in symbols:
        b = bars.get(s)
        if not b:
            continue
        tags = quant.setups(b["close"])
        if tags:
            hits.append({"symbol": s, "setups": tags, "price": round(b["close"][-1], 2),
                         "rsi": round(quant.rsi(b["close"]) or 0, 1)})
    return hits


def plan(b, stop_atr, reward_r):
    """The trade plan before any entry: stop under ATR, target as a multiple of risk."""
    c = b["close"]
    a = quant.atr(b["high"], b["low"], c)
    entry = c[-1]
    stop = entry - stop_atr * a
    vol20 = sum(b["volume"][-21:-1]) / 20.0
    return {"entry": round(entry, 2), "stop": round(stop, 2),
            "target": round(entry + reward_r * (entry - stop), 2), "atr": round(a, 2),
            "reward_r": reward_r, "rsi": round(quant.rsi(c) or 0, 1),
            "above200": c[-1] > (quant.sma(c, 200) or float("inf")),
            "above50": c[-1] > (quant.sma(c, 50) or float("inf")),
            "rel_volume": round(b["volume"][-1] / vol20, 2) if vol20 else None,
            "d1": round(quant.pct(c[-1], c[-2]), 2), "d20": round(quant.pct(c[-1], c[-21]), 2)}


def debate(sym, p, odds, history, news_items, reg):
    """Rule-based bull and bear cases. Each point is a fact the reader can check."""
    bull, bear = [], []
    (bull if p["above200"] else bear).append(
        "%s the 200-day average" % ("Above" if p["above200"] else "Below"))
    if p["rsi"] < 30:
        bull.append("RSI %.0f: stretched to the downside, bounces are common" % p["rsi"])
    elif p["rsi"] > 70:
        bear.append("RSI %.0f: stretched to the upside" % p["rsi"])
    if p["rel_volume"] and p["rel_volume"] >= 1.5:
        bull.append("Volume %.1fx its 20-day average" % p["rel_volume"])
    if odds:
        (bull if odds["ev_r"] > 0 else bear).append(
            "Time Machine expectancy %+.2fR over %d sessions" % (odds["ev_r"], odds["horizon"]))
    if history and history["fired"] >= 5:
        rate = history["target"] / float(history["fired"])
        (bull if rate >= 0.4 else bear).append("This setup fired %d times in its own history; target first %d%%" % (
            history["fired"], round(rate * 100)))
    elif history is not None:
        bear.append("Setup fired %d times in its history: too few to trust" % history["fired"])
    if reg["label"] == "risk_off":
        bear.append("Market regime is risk-off (%s)" % reg["why"])
    elif reg["label"] == "risk_on":
        bull.append("Market regime is risk-on")
    events = sorted({t for n in news_items if n.get("ticker") == sym for t in n.get("tags") or []} & EVENT_TAGS)
    if events:
        bear.append("Event risk in %s's own headlines: %s" % (sym, ", ".join(events)))
    lean = "bull" if len(bull) > len(bear) else ("bear" if len(bear) > len(bull) else "split")
    return {"bull": bull, "bear": bear, "lean": lean, "author": "rules"}


def event_limit(cfg, was_blocked):
    """Hysteresis: a name blocked for event risk stays blocked until the judge reads it
    below the lower release level, so a few points of headline noise cannot flip it daily."""
    limit = cfg.get("max_event_risk", 0.7)  # a missing key must not switch the gate off
    return min(limit, cfg.get("release_event_risk", limit)) if was_blocked else limit


def risk_check(p, shares, odds, cfg, open_positions, reg, judge=None, record=None, event_blocked_before=False):
    """PASS or BLOCK with every reason. Any one reason blocks."""
    reasons = []
    if record and record["avg_r"] < 0:
        reasons.append("Hindsight: this rule on this stock lost money over %d past firings (%+.2fR average)" % (
            record["n"], record["avg_r"]))
    er = (judge or {}).get("event_risk")
    limit = event_limit(cfg, event_blocked_before)
    if er is not None and er >= limit:
        reasons.append("News Judge (Clef) puts event risk at %d%%, over the %d%% limit%s" % (
            round(er * 100), round(limit * 100), " (stays blocked until below this)" if event_blocked_before else ""))
    if shares <= 0:
        reasons.append("Size rounds to zero shares at this stop")
    if p["reward_r"] < cfg["min_reward_r"]:
        reasons.append("Reward %.1fR is under the %.1fR minimum" % (p["reward_r"], cfg["min_reward_r"]))
    if odds is None:
        reasons.append("No Time Machine odds: not enough history")
    elif odds["ev_r"] <= cfg["min_ev_r"]:
        reasons.append("Expectancy %+.2fR is not above %+.2fR" % (odds["ev_r"], cfg["min_ev_r"]))
    if open_positions >= cfg["max_positions"]:
        reasons.append("Already holding %d of %d positions" % (open_positions, cfg["max_positions"]))
    if reg["label"] == "risk_off" and cfg.get("block_longs_risk_off", True):
        reasons.append("Regime is risk-off and the desk does not open longs then")
    return {"verdict": "BLOCK" if reasons else "PASS", "reasons": reasons}
