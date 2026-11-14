"""Arbitrage Scout: read-only cross-exchange spreads for Bitcoin and Ether from
public ticker endpoints. Buy at the cheapest ask, sell at the richest bid, then
subtract both venues' taker fees. No keys, no accounts, no orders.

Fees are entry-tier public taker rates; volume tiers are lower, so `net_bps`
is the retail view. Transfer time and withdrawal fees are not modelled, which
makes any positive number an upper bound.
"""
import json
import urllib.request

UA = {"User-Agent": "Mozilla/5.0 (compatible; geninvestor-desk/0.1)"}
TAKER_BPS = {"coinbase": 60, "kraken": 40, "bitstamp": 40, "gemini": 40}  # entry-tier public schedules; verify before use


def _get(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=15) as r:
        return json.load(r)


def _kraken(asset):
    pair = "XBT" if asset == "BTC" else asset
    d = list(_get("https://api.kraken.com/0/public/Ticker?pair=%sUSD" % pair)["result"].values())[0]
    return float(d["b"][0]), float(d["a"][0])


VENUES = {
    "coinbase": lambda a: (lambda d: (float(d["bid"]), float(d["ask"])))(_get("https://api.exchange.coinbase.com/products/%s-USD/ticker" % a)),
    "kraken": _kraken,
    "bitstamp": lambda a: (lambda d: (float(d["bid"]), float(d["ask"])))(_get("https://www.bitstamp.net/api/v2/ticker/%susd/" % a.lower())),
    "gemini": lambda a: (lambda d: (float(d["bid"]), float(d["ask"])))(_get("https://api.gemini.com/v1/pubticker/%susd" % a.lower())),
}


def best_route(quotes):
    """quotes: {venue: (bid, ask)}. The best buy-here, sell-there route and its edge."""
    buy = min(quotes.items(), key=lambda kv: kv[1][1])
    sell = max(quotes.items(), key=lambda kv: kv[1][0])
    gross = (sell[1][0] / buy[1][1] - 1) * 1e4
    fees = TAKER_BPS.get(buy[0], 60) + TAKER_BPS.get(sell[0], 60)
    return {"buy": buy[0], "ask": buy[1][1], "sell": sell[0], "bid": sell[1][0],
            "gross_bps": round(gross, 2), "fees_bps": fees, "net_bps": round(gross - fees, 2)}


def run(assets=("BTC", "ETH"), venues=VENUES):
    out = []
    for a in assets:
        quotes, errors = {}, []
        for name, fn in venues.items():
            try:
                quotes[name] = fn(a)
            except Exception as e:  # a venue being down is normal; report it
                errors.append("%s: %s" % (name, str(e)[:60]))
        row = {"asset": a, "venues": len(quotes), "errors": errors}
        if len(quotes) >= 2:
            row.update(best_route(quotes))
        out.append(row)
    return {"routes": out, "note": "Retail taker fees; transfers and withdrawal fees not modelled, so a positive net is an upper bound"}
