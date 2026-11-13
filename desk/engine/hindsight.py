"""What would have been good decisions? Replay every setup the scanner rules
would have fired on the watchlist over the loaded history, with the desk's own
plan, and split the results by the market regime on that day.

This is the desk grading its own rules in hindsight. It describes the past
window only; a rule that worked here can stop working.
"""
from . import quant

WARMUP = 210  # SPY needs 200 sessions for its regime flag; rules need 30


def regime_by_date(spy):
    """{date: 'above200' | 'below200'} for SPY."""
    out, c = {}, spy["close"]
    for i in range(200, len(c)):
        out[spy["dates"][i]] = "above200" if c[i] > sum(c[i - 200:i]) / 200.0 else "below200"
    return out


def firings(sym, b, stop_atr, reward_r, horizon, regimes):
    """Every past firing for one symbol with its outcome in R."""
    out, c = [], b["close"]
    for i in range(WARMUP, len(c) - horizon):
        tags = quant.setups(c[: i + 1])
        if not tags:
            continue
        a = quant.atr(b["high"][: i + 1], b["low"][: i + 1], c[: i + 1])
        if not a:
            continue
        entry = c[i]
        stop = entry - stop_atr * a
        target = entry + reward_r * (entry - stop)
        how, last = quant.walk(c[i + 1: i + 1 + horizon], entry, stop, target)
        r = reward_r if how == "target" else (-1.0 if how == "stop" else (last - entry) / (entry - stop))
        for tag in tags:
            out.append({"symbol": sym, "date": b["dates"][i], "setup": tag, "outcome": how, "r": round(r, 2),
                        "regime": regimes.get(b["dates"][i], "unknown"), "entry": round(entry, 2)})
    return out


def summarize(rows):
    def agg(xs):
        n = len(xs)
        if not n:
            return None
        return {"n": n, "target": round(sum(1 for x in xs if x["outcome"] == "target") / n, 3),
                "stop": round(sum(1 for x in xs if x["outcome"] == "stop") / n, 3),
                "avg_r": round(sum(x["r"] for x in xs) / n, 3)}
    table = []
    for setup in sorted({r["setup"] for r in rows}):
        mine = [r for r in rows if r["setup"] == setup]
        table.append({"setup": setup, "all": agg(mine),
                      "above200": agg([r for r in mine if r["regime"] == "above200"]),
                      "below200": agg([r for r in mine if r["regime"] == "below200"])})
    pairs = by_pair(rows)
    return {"table": table, "best": pairs[:5], "worst": pairs[::-1][:5], "n": len(rows),
            "pairs": {"%s|%s" % (p["symbol"], p["setup"]): p for p in pairs}}


MIN_PAIR = 8  # fewer firings than this is an anecdote, not a record


def by_pair(rows):
    """Average result per (symbol, setup), best first. Single trades tie at +2R or
    -1R by construction, so ranking trades would only sort them alphabetically."""
    groups = {}
    for r in rows:
        groups.setdefault((r["symbol"], r["setup"]), []).append(r)
    out = []
    for (sym, setup), xs in groups.items():
        if len(xs) < MIN_PAIR:
            continue
        out.append({"symbol": sym, "setup": setup, "n": len(xs), "avg_r": round(sum(x["r"] for x in xs) / len(xs), 2),
                    "target": round(sum(1 for x in xs if x["outcome"] == "target") / len(xs), 2)})
    return sorted(out, key=lambda p: (-p["avg_r"], -p["n"]))


def run(bars, symbols, stop_atr, reward_r, horizon):
    spy = bars.get("SPY")
    regimes = regime_by_date(spy) if spy else {}
    rows = []
    for s in symbols:
        if s in bars and len(bars[s]["close"]) > WARMUP + horizon:
            rows.extend(firings(s, bars[s], stop_atr, reward_r, horizon, regimes))
    out = summarize(rows)
    if rows:
        dates = sorted(r["date"] for r in rows)
        out["window"] = [dates[0], dates[-1]]
    return out
