"""The paper book: tickets you approve become paper positions, the desk marks
them on daily closes, and every closed one scores the odds it was opened on.

There is no broker here and no order type. "Approve" moves paper cash.
"""
import json
import os

from . import quant


def load(path, start_cash):
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            try:
                return json.load(f)
            except ValueError:
                # Never start a fresh book over a damaged one: that would erase the paper record.
                raise SystemExit("paper book %s is not valid JSON; fix or move it before the next cycle" % path)
    return {"start_cash": start_cash, "cash": start_cash, "positions": [], "closed": [], "equity": []}


def save(path, book):
    if os.path.dirname(path):
        os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(book, f, indent=2)
    os.replace(tmp, path)


def approve(book, ticket, signal_date, max_positions=None):
    """A yes. The order waits for the next session and fills at its open (mark does
    that), so no return earned before the decision is ever booked."""
    if ticket["risk"]["verdict"] != "PASS":
        raise ValueError("ticket %s was blocked by risk: %s" % (ticket["id"], "; ".join(ticket["risk"]["reasons"])))
    if max_positions is not None and len(book["positions"]) >= max_positions:
        raise ValueError("already holding %d of %d positions" % (len(book["positions"]), max_positions))
    if any(p["id"] == ticket["id"] for p in book["positions"]):
        raise ValueError("ticket %s is already open" % ticket["id"])
    p = ticket["plan"]
    if not (isinstance(ticket["shares"], int) and ticket["shares"] > 0):
        raise ValueError("ticket %s has no shares to buy" % ticket["id"])
    if not (p["stop"] < p["entry"] < p["target"]):
        raise ValueError("ticket %s needs stop < entry < target" % ticket["id"])
    cost = ticket["shares"] * p["entry"]
    if cost > book["cash"]:
        raise ValueError("paper cash %.2f does not cover %.2f" % (book["cash"], cost))
    pos = {"id": ticket["id"], "symbol": ticket["symbol"], "setup": ticket["setup"], "shares": ticket["shares"],
           "entry": p["entry"], "stop": p["stop"], "target": p["target"], "opened": signal_date, "pending": True,
           "p_target": ticket["odds"]["p_target"], "horizon": ticket["odds"]["horizon"]}
    return dict(book, cash=round(book["cash"] - cost, 2), positions=book["positions"] + [pos])


def mark(book, bars, today):
    """Close any position whose stop or target was crossed on a close since it
    opened, or that ran out its horizon. Returns the new book."""
    still, closed, cash = [], list(book["closed"]), book["cash"]
    for pos in book["positions"]:
        b = bars.get(pos["symbol"])
        if not b:
            still.append(pos)
            continue
        if pos.get("pending"):
            pos, cash, gapped = fill_at_open(pos, b, cash)
            if pos.get("pending"):
                still.append(pos)
                continue
            if gapped:
                # The open was already below the stop: a bracket order would not fill. Cancel and refund.
                cash += pos["entry"] * pos["shares"]
                closed.append(dict(pos, exit=None, outcome="cancelled", closed=today, pnl=0.0, r=None))
                continue
        after = [c for d, c in zip(b["dates"], b["close"]) if d >= pos["opened"]] if pos.get("filled_open") else \
                [c for d, c in zip(b["dates"], b["close"]) if d > pos["opened"]]
        how, px = quant.walk(after, pos["entry"], pos["stop"], pos["target"])
        if how == "open" and len(after) < pos["horizon"]:
            still.append(dict(pos, last=round(b["close"][-1], 2)))
            continue
        # A close through the stop exits at that close, not at the stop: gaps are real losses.
        exit_px = min(pos["stop"], px) if how == "stop" else (pos["target"] if how == "target" else px)
        cash += exit_px * pos["shares"]
        closed.append(close_out(pos, exit_px, how if how != "open" else "time", today))
    value = sum(p["shares"] * p.get("last", p["entry"]) for p in still)
    equity = [e for e in book["equity"] if e["date"] != today] + [{"date": today, "equity": round(cash + value, 2)}]
    return dict(book, cash=round(cash, 2), positions=still, closed=closed, equity=equity)


def fill_at_open(pos, b, cash):
    """Fill a pending order at the first open after its signal date. Cash was reserved
    at the planned entry; the difference is settled here. Returns (pos, cash, gapped)."""
    opens = b.get("open") or b["close"]
    nxt = next(((d, o) for d, o in zip(b["dates"], opens) if d > pos["opened"]), None)
    if not nxt:
        return pos, cash, False
    day, px = nxt
    cash += (pos["entry"] - px) * pos["shares"]
    filled = {k: v for k, v in pos.items() if k != "pending"}
    filled.update(entry=round(px, 2), opened=day, filled_open=True, planned_entry=pos["entry"])
    return filled, round(cash, 2), px <= pos["stop"]


def close_out(pos, exit_px, outcome, today):
    risk = pos.get("planned_entry", pos["entry"]) - pos["stop"]
    return dict(pos, exit=round(exit_px, 2), outcome=outcome, closed=today,
                pnl=round((exit_px - pos["entry"]) * pos["shares"], 2),
                r=round((exit_px - pos["entry"]) / risk, 2) if risk > 0 else None)


def calibration(book):
    """How good were the odds? Brier score of p_target against target-hit, by bucket."""
    pairs = [(c["p_target"], 1 if c["outcome"] == "target" else 0) for c in book["closed"] if c["outcome"] != "cancelled"]
    buckets = {}
    for p, o in pairs:
        k = min(int(p * 10), 9) / 10.0
        n, hit = buckets.get(k, (0, 0))
        buckets[k] = (n + 1, hit + o)
    return {"n": len(pairs), "brier": quant.brier(pairs),
            "buckets": [{"from": k, "n": n, "hit_rate": round(h / float(n), 3)} for k, (n, h) in sorted(buckets.items())],
            "realized_pnl": round(sum(c["pnl"] for c in book["closed"]), 2)}
