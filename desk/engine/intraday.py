"""Hourly day-trading simulation on Yahoo 60-minute bars (New York session).

Three day-trading rules, each flat by the close, tested per symbol:
- First-hour breakout: after the 9:30-10:30 bar, go long above its high or short
  below its low on a later hourly close; exit at the close.
- Gap fade: if the day opens more than GAP_PCT away from yesterday's close,
  trade back toward it from the first hourly close; exit at the close.
- Trend day: if the first hour closes in its top (bottom) quarter, follow it
  long (short) to the close.
Costs: COST_BPS per side. Hourly closes stand in for fills, which flatters
breakouts a little; the numbers are a ranking, not a promise.
"""
import json
import time
import urllib.request
from datetime import datetime, timedelta, timezone

COST_BPS = 2
GAP_PCT = 0.6
URL = "https://query1.finance.yahoo.com/v8/finance/chart/%s?range=%s&interval=60m"
UA = "Mozilla/5.0 (compatible; geninvestor-desk/0.1)"
EST = timezone(timedelta(hours=-5))


def fetch_hourly(sym, rng="60d"):
    req = urllib.request.Request(URL % (sym, rng), headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=20) as r:
        res = json.load(r)["chart"]["result"][0]
    q = res["indicators"]["quote"][0]
    days = {}
    for i, ts in enumerate(res.get("timestamp") or []):
        if q["close"][i] is None:
            continue
        d = datetime.fromtimestamp(ts, EST).strftime("%Y-%m-%d")
        days.setdefault(d, []).append({"o": q["open"][i], "h": q["high"][i], "l": q["low"][i], "c": q["close"][i]})
    time.sleep(0.25)
    return [(d, bars) for d, bars in sorted(days.items()) if len(bars) >= 5]


def _trade(side, entry, exit_):
    gross = (exit_ / entry - 1) * (1 if side == "long" else -1)
    return gross - 2 * COST_BPS / 1e4


def first_hour_breakout(prev_close, bars):
    hi, lo = bars[0]["h"], bars[0]["l"]
    for b in bars[1:-1]:
        if b["c"] > hi:
            return _trade("long", b["c"], bars[-1]["c"])
        if b["c"] < lo:
            return _trade("short", b["c"], bars[-1]["c"])
    return None


def gap_fade(prev_close, bars):
    if not prev_close:
        return None
    gap = (bars[0]["o"] / prev_close - 1) * 100
    if abs(gap) < GAP_PCT:
        return None
    return _trade("short" if gap > 0 else "long", bars[0]["c"], bars[-1]["c"])


def trend_day(prev_close, bars):
    b = bars[0]
    rng = b["h"] - b["l"]
    if rng <= 0:
        return None
    pos = (b["c"] - b["l"]) / rng
    if pos >= 0.75:
        return _trade("long", b["c"], bars[-1]["c"])
    if pos <= 0.25:
        return _trade("short", b["c"], bars[-1]["c"])
    return None


RULES = [("orb", "First-hour breakout", first_hour_breakout), ("gapfade", "Gap fade", gap_fade),
         ("trendday", "Trend day", trend_day)]


def score(trades):
    if not trades:
        return {"n": 0}
    wins = [t for t in trades if t > 0]
    mean = sum(trades) / len(trades)
    sd = (sum((t - mean) ** 2 for t in trades) / len(trades)) ** 0.5
    return {"n": len(trades), "win": round(len(wins) / len(trades), 2), "avg_bps": round(mean * 1e4, 1),
            "total_pct": round(sum(trades) * 100, 1), "t_stat": round(mean / sd * len(trades) ** 0.5, 2) if sd else None}


def run(symbols=("SPY", "QQQ", "NVDA", "AMD", "TSLA"), fetch=fetch_hourly):
    out, last_day = [], None
    for sym in symbols:
        try:
            days = fetch(sym)
        except Exception as e:  # one symbol failing must not sink the run
            out.append({"symbol": sym, "error": str(e)[:120]})
            continue
        row = {"symbol": sym, "days": len(days)}
        for key, _, fn in RULES:
            trades = []
            for i in range(1, len(days)):
                t = fn(days[i - 1][1][-1]["c"], days[i][1])
                if t is not None:
                    trades.append(t)
            row[key] = score(trades)
        if days:
            last_day = days[-1][0]
        out.append(row)
    return {"rules": [{"id": k, "name": n} for k, n, _ in RULES], "symbols": out, "through": last_day,
            "cost_bps": COST_BPS, "note": "Hourly closes as fills, flat by the close; t above 2 is the bar for a real edge"}
