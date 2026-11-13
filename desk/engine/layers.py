"""Cross-Market Analyst: the same questions asked of every market at once.

For each asset: trend (vs 50 and 200 sessions), stretch (20-session move in
units of its own volatility), and its own base rate after a fresh oversold
reading. Then the links between markets that decide regimes: crypto against
the Nasdaq, gold against real yields, the dollar against everything.

Crypto trades seven days a week, so its "sessions" are calendar days. Readings
describe the loaded history only.
"""
import math

from . import quant

LAYERS = [
    ("Equities", [("SPY", "S&P 500"), ("QQQ", "Nasdaq 100"), ("IWM", "Small caps")]),
    ("Crypto", [("BTC-USD", "Bitcoin"), ("ETH-USD", "Ether"), ("SOL-USD", "Solana")]),
    ("Crypto equities", [("IBIT", "Bitcoin ETF"), ("COIN", "Coinbase"), ("MSTR", "Strategy")]),
    ("Rates and credit", [("^TNX", "10-year yield"), ("TLT", "Long Treasuries"), ("HYG", "High-yield credit")]),
    ("Dollar and commodities", [("DX-Y.NYB", "Dollar index"), ("CL=F", "WTI oil"), ("GC=F", "Gold")]),
]
SYMBOLS = [s for _, xs in LAYERS for s, _ in xs]
FORWARD = 20


def stretch(c, n=20):
    """20-session move divided by the volatility you would expect over 20 sessions."""
    if len(c) < n + 21:
        return None
    rets = [math.log(c[i] / c[i - 1]) for i in range(len(c) - 60, len(c)) if c[i - 1] > 0]
    vol = (sum(r * r for r in rets) / len(rets)) ** 0.5 * math.sqrt(n)
    return round(math.log(c[-1] / c[-1 - n]) / vol, 2) if vol else None


def oversold_base_rate(c):
    """After each fresh RSI-below-30 reading: how did the next 20 sessions go?"""
    outs = []
    for i in range(30, len(c) - FORWARD):
        r, prev = quant.rsi(c[: i + 1]), quant.rsi(c[:i])
        if r is not None and r < 30 and (prev is None or prev >= 30):
            outs.append(c[i + FORWARD] / c[i] - 1)
    if not outs:
        return None
    outs.sort()
    return {"n": len(outs), "median_pct": round(outs[len(outs) // 2] * 100, 1),
            "win": round(sum(1 for x in outs if x > 0) / len(outs), 2), "worst_pct": round(outs[0] * 100, 1)}


def read(sym, b):
    c = b["close"]
    s50, s200 = quant.sma(c, 50), quant.sma(c, 200)
    z = stretch(c)
    trend = "up" if s200 and c[-1] > s200 and c[-1] > s50 else ("down" if s200 and c[-1] < s200 and c[-1] < s50 else "mixed")
    if z is not None and z <= -1.5 and trend == "up":
        state = "pullback in an uptrend"
    elif z is not None and z <= -1.5:
        state = "washed out in a downtrend"
    elif z is not None and z >= 1.5:
        state = "stretched up"
    else:
        state = {"up": "trending up", "down": "trending down", "mixed": "no trend"}[trend]
    return {"symbol": sym, "last": round(c[-1], 2), "d20": round(quant.pct(c[-1], c[-21]), 1),
            "rsi": round(quant.rsi(c) or 0), "trend": trend, "stretch": z, "state": state,
            "base_rate": oversold_base_rate(c), "spark": [round(x, 2) for x in c[-60:]]}


def correlation(a, b, n=60):
    """Correlation of daily returns over the last n shared dates."""
    da, db = dict(zip(a["dates"], a["close"])), dict(zip(b["dates"], b["close"]))
    dates = sorted(set(da) & set(db))[-(n + 1):]
    if len(dates) < 30:
        return None
    ra = [da[dates[i]] / da[dates[i - 1]] - 1 for i in range(1, len(dates))]
    rb = [db[dates[i]] / db[dates[i - 1]] - 1 for i in range(1, len(dates))]
    ma, mb = sum(ra) / len(ra), sum(rb) / len(rb)
    cov = sum((x - ma) * (y - mb) for x, y in zip(ra, rb))
    va, vb = sum((x - ma) ** 2 for x in ra), sum((y - mb) ** 2 for y in rb)
    return round(cov / math.sqrt(va * vb), 2) if va and vb else None


LINKS = [("BTC-USD", "QQQ", "Bitcoin and the Nasdaq"), ("GC=F", "^TNX", "Gold and the 10-year yield"),
         ("DX-Y.NYB", "SPY", "The dollar and the S&P 500"), ("HYG", "SPY", "Credit and stocks")]


def run(bars):
    layers = []
    for name, items in LAYERS:
        rows = []
        for sym, label in items:
            if sym in bars and len(bars[sym]["close"]) > 80:
                rows.append(dict(read(sym, bars[sym]), label=label))
        if rows:
            layers.append({"layer": name, "assets": rows})
    links = []
    for a, b, label in LINKS:
        if a in bars and b in bars:
            links.append({"pair": label, "a": a, "b": b, "corr60": correlation(bars[a], bars[b])})
    return {"layers": layers, "links": links}
