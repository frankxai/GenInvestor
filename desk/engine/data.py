"""Where the desk's numbers come from: Yahoo daily bars, the installed trader
skills' own tools, and a seeded synthetic generator for demos and tests.

Read-only. Nothing here sends anything anywhere except GET requests for public
market data.
"""
import glob
import json
import math
import os
import random
import subprocess
import sys
import time
import urllib.request
from datetime import date, datetime, timedelta, timezone

UA = "Mozilla/5.0 (compatible; geninvestor-desk/0.1)"
CHART = "https://query1.finance.yahoo.com/v8/finance/chart/%s?range=%s&interval=1d"
PAUSE = 0.25
TOOL_TIMEOUT = 120


def fetch_daily(symbol, rng="2y"):
    """{dates, open, high, low, close, volume} oldest first, rows with gaps dropped."""
    req = urllib.request.Request(CHART % (urllib.request.quote(symbol), rng), headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=20) as r:
        body = json.load(r)
    res = (body.get("chart") or {}).get("result") or []
    if not res:
        raise ValueError("no chart data for %s" % symbol)
    q = res[0]["indicators"]["quote"][0]
    out = {k: [] for k in ("dates", "open", "high", "low", "close", "volume")}
    for i, ts in enumerate(res[0].get("timestamp") or []):
        row = [q[k][i] for k in ("open", "high", "low", "close")]
        if any(v is None for v in row):
            continue
        out["dates"].append(datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m-%d"))
        for k, v in zip(("open", "high", "low", "close"), row):
            out[k].append(float(v))
        out["volume"].append(int(q["volume"][i] or 0))
    time.sleep(PAUSE)
    return drop_unfinished(out)


def new_york_now():
    try:
        from zoneinfo import ZoneInfo
        return datetime.now(ZoneInfo("America/New_York"))
    except Exception:  # Windows without tzdata: EST is close enough to decide "is the session over"
        return datetime.now(timezone(timedelta(hours=-5)))


def drop_unfinished(bars, now=None):
    """Yahoo returns today's bar while the session is still trading. A daily rule
    must only see closed sessions, the same as /trader-scanner."""
    now = now or new_york_now()
    if bars["dates"] and bars["dates"][-1] == now.strftime("%Y-%m-%d") and (now.hour, now.minute) < (16, 15):
        return {k: v[:-1] for k, v in bars.items()}
    return bars


def fetch_many(symbols, rng="2y"):
    """{symbol: bars}, plus {symbol: error} for the ones that failed."""
    bars, errors = {}, {}
    for s in symbols:
        try:
            bars[s] = fetch_daily(s, rng)
        except Exception as e:  # one bad symbol must not sink the cycle
            errors[s] = str(e)[:160]
    return bars, errors


def plugin_root(name="day-trader-skill"):
    """Newest installed version of a Claude Code plugin, or None."""
    base = os.path.expanduser(os.path.join("~", ".claude", "plugins", "cache", name, name))
    found = sorted(glob.glob(os.path.join(base, "*")))
    return found[-1] if found else None


def run_tool(script, args):
    """Run one of the trader skills' Python tools with --json. Returns (data, error)."""
    root = plugin_root()
    if not root:
        return None, "day-trader-skill plugin is not installed"
    path = os.path.join(root, script)
    if not os.path.exists(path):
        return None, "missing tool %s" % script
    try:
        p = subprocess.run([sys.executable, path] + args + ["--json"], capture_output=True,
                           text=True, timeout=TOOL_TIMEOUT, encoding="utf-8")
    except (OSError, subprocess.SubprocessError) as e:
        return None, str(e)[:160]
    if p.returncode != 0:
        return None, (p.stderr or "exit %d" % p.returncode).strip()[-200:]
    try:
        return json.loads(p.stdout), None
    except ValueError:
        return None, "tool printed no JSON"


def synthetic_bars(symbol, n=500, seed=None, drift=0.0004, vol=0.018, start=100.0):
    """A seeded random walk with OHLC around each close. Labeled synthetic wherever used."""
    rng = random.Random(seed if seed is not None else sum(map(ord, symbol)))
    out = {k: [] for k in ("dates", "open", "high", "low", "close", "volume")}
    px = start
    day = date(2026, 11, 13) - timedelta(days=int(n * 7 / 5) + 7)
    for i in range(n):
        day += timedelta(days=1)
        while day.weekday() > 4:
            day += timedelta(days=1)
        prev = px
        px = prev * math.exp(rng.gauss(drift, vol))
        spread = abs(rng.gauss(0, vol / 2)) * px
        out["dates"].append(day.isoformat())
        out["open"].append(prev)
        out["high"].append(max(prev, px) + spread)
        out["low"].append(min(prev, px) - spread)
        out["close"].append(px)
        out["volume"].append(int(rng.uniform(2e6, 9e6)))
    return out
