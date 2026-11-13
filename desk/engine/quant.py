"""Pure arithmetic for the desk. No network, no clock, no state.

Every function takes plain lists (oldest first) and returns plain values, so the
tests can pin each number without fixtures from the internet.
"""
import math
import random

RSI_PERIOD = 14
ATR_PERIOD = 14


def sma(values, n):
    if len(values) < n:
        return None
    return sum(values[-n:]) / float(n)


def rsi(closes, n=RSI_PERIOD):
    """Wilder RSI on closes. None until there are n+1 closes."""
    if len(closes) <= n:
        return None
    gains, losses = 0.0, 0.0
    for i in range(1, n + 1):
        d = closes[i] - closes[i - 1]
        gains += max(d, 0.0)
        losses += max(-d, 0.0)
    avg_g, avg_l = gains / n, losses / n
    for i in range(n + 1, len(closes)):
        d = closes[i] - closes[i - 1]
        avg_g = (avg_g * (n - 1) + max(d, 0.0)) / n
        avg_l = (avg_l * (n - 1) + max(-d, 0.0)) / n
    if avg_l == 0:
        return 100.0
    return 100.0 - 100.0 / (1.0 + avg_g / avg_l)


def atr(highs, lows, closes, n=ATR_PERIOD):
    """Average true range over the last n bars."""
    if len(closes) <= n:
        return None
    trs = []
    for i in range(len(closes) - n, len(closes)):
        prev = closes[i - 1]
        trs.append(max(highs[i] - lows[i], abs(highs[i] - prev), abs(lows[i] - prev)))
    return sum(trs) / float(n)


def pct(a, b):
    """Percent change from b to a."""
    if not b:
        return None
    return (a / b - 1.0) * 100.0


def setups(closes):
    """The same daily rules as /trader-scanner's find_setups, so a history replay
    tests the rule the scanner actually fired on."""
    if len(closes) < 30:
        return []
    c = closes
    last = c[-1]
    tags = []
    if last > max(c[-21:-1]):
        tags.append("breakout_20d")
    if c[-6] / c[-16] - 1 > 0.10 and (max(c[-5:]) - min(c[-5:])) / last < 0.05:
        tags.append("bull_flag")
    if c[-2] < sum(c[-21:-1]) / 20.0 and last > sum(c[-20:]) / 20.0:
        tags.append("reclaim_ma20")
    r, r_prev = rsi(c), rsi(c[:-1])
    if r is not None and r < 30:
        tags.append("oversold")
    if r_prev is not None and r_prev < 30 and last > c[-2]:
        tags.append("oversold_bounce")
    return tags


def walk(path, entry, stop, target):
    """First touch on closes: 'target', 'stop' or 'open', plus the last close."""
    for px in path:
        if px <= stop:
            return "stop", px
        if px >= target:
            return "target", px
    return "open", path[-1] if path else entry


def time_machine(closes, entry, stop, target, horizon=10, paths=10000, seed=19, lookback=250):
    """Bootstrap: replay `horizon` sessions `paths` times from this stock's own daily
    log returns. Close-based, so a stop that would fill intraday counts at the close.
    A simulation of the past, never a forecast."""
    window = closes[-(lookback + 1):]
    rets = [math.log(window[i] / window[i - 1]) for i in range(1, len(window)) if window[i - 1] > 0]
    if len(rets) < 30 or entry <= stop:
        return None
    rng = random.Random(seed)
    risk = entry - stop
    hits = {"target": 0, "stop": 0, "open": 0}
    open_r = 0.0
    for _ in range(paths):
        px, path = entry, []
        for _ in range(horizon):
            px *= math.exp(rets[rng.randrange(len(rets))])
            path.append(px)
        how, last = walk(path, entry, stop, target)
        hits[how] += 1
        if how == "open":
            open_r += (last - entry) / risk
    reward_r = (target - entry) / risk
    p = {k: v / float(paths) for k, v in hits.items()}
    ev = p["target"] * reward_r - p["stop"] + (open_r / paths)
    return {"paths": paths, "horizon": horizon, "seed": seed, "sample": len(rets),
            "p_target": round(p["target"], 4), "p_stop": round(p["stop"], 4),
            "p_open": round(p["open"], 4), "ev_r": round(ev, 3)}


def history_replay(highs, lows, closes, setup, stop_atr, reward_r, horizon=10):
    """Every past session in this series where `setup` fired: did the same plan
    (stop = stop_atr x ATR, target = reward_r x risk) hit target or stop first?"""
    out = {"fired": 0, "target": 0, "stop": 0, "open": 0}
    for i in range(40, len(closes) - horizon):
        if setup not in setups(closes[: i + 1]):
            continue
        a = atr(highs[: i + 1], lows[: i + 1], closes[: i + 1])
        if not a:
            continue
        entry = closes[i]
        stop = entry - stop_atr * a
        how, _ = walk(closes[i + 1: i + 1 + horizon], entry, stop, entry + reward_r * (entry - stop))
        out["fired"] += 1
        out[how] += 1
    return out


def size(account, cash, max_loss, max_position_pct, entry, stop):
    """Shares so a stop-out loses at most max_loss, capped by position size and cash."""
    risk = entry - stop
    if risk <= 0 or entry <= 0:
        return 0
    by_risk = int(max_loss // risk)
    by_cap = int((account * max_position_pct / 100.0) // entry)
    by_cash = int(cash // entry)
    return max(0, min(by_risk, by_cap, by_cash))


def brier(pairs):
    """Mean squared error of (predicted probability, outcome 0/1). Lower is better;
    0.25 is what always saying 50% scores."""
    if not pairs:
        return None
    return round(sum((p - o) ** 2 for p, o in pairs) / len(pairs), 4)
