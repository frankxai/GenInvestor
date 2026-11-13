"""Run the desk.

    python desk/cycle.py run                 one cycle on live public data -> desk/state/desk.json
    python desk/cycle.py run --demo          the same on seeded synthetic data
    python desk/cycle.py approve <ticket>    your yes: the order fills at the next session's open (paper)
    python desk/cycle.py reject <ticket>     your no
    python desk/cycle.py status              the queue and the book, in plain text

Ceiling L2_SIMULATION: there is no broker and no order path. Approve moves paper cash.
"""
import argparse
import json
import os
import sys
import time
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from engine import agents, arbitrage, arena, book, clef, data, editorial, hindsight, intraday, layers, quant  # noqa: E402

STATE = os.path.join(HERE, "state")
OHLC_BARS = 120
DISCLAIMER = ("Simulation and research only. Not investment advice. Odds are replays of the past, "
              "not forecasts. No order can leave this desk.")


def read_json(path, default):
    if not os.path.exists(path):
        return default
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def write_json(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, indent=2)
    os.replace(tmp, path)


class Log:
    """One line per agent step, with timing, shown on the dashboard."""

    def __init__(self):
        self.steps = []

    def step(self, agent, status, summary, started):
        self.steps.append({"agent": agent, "status": status, "summary": summary,
                           "ms": int((time.time() - started) * 1000)})


def gather(cfg, demo):
    symbols = sorted(set(cfg["watchlist"]) | set(cfg.get("focus", [])) | set(agents.REGIME_SYMBOLS) | set(layers.SYMBOLS)
                     | set(arena.STOCKS + arena.CRYPTO + arena.DEFENSIVE))
    if demo:
        return {s: data.synthetic_bars(s) for s in symbols}, {}
    return data.fetch_many(symbols)


def scan(cfg, bars, demo, log):
    t = time.time()
    if not demo:
        out, err = data.run_tool("trader-scanner/scan.py",
                                 ["daily", "--symbols", ",".join(cfg["watchlist"]), "--no-write", "--quiet"])
        if out is not None:
            log.step("scanner", "ok", "trader-scanner: %d of %d charts matched a setup" % (
                len(out["hits"]), out["counts"]["scanned"]), t)
            return out["hits"], "day-trader-skill:trader-scanner"
        log.step("scanner", "degraded", "trader-scanner unavailable (%s); same rules run locally" % err, t)
    hits = agents.scanner_from_bars(bars, cfg["watchlist"])
    if demo:
        log.step("scanner", "ok", "%d of %d synthetic charts matched a setup" % (len(hits), len(cfg["watchlist"])), t)
    return hits, "desk local rules"


def news(symbols, demo, log):
    t = time.time()
    if demo or not symbols:
        log.step("news", "skipped", "no live news in a demo run" if demo else "no candidates to read about", t)
        return {"items": [], "moves": []}
    out, err = data.run_tool("trader-news/news.py",
                             ["--tickers"] + symbols + ["--hours", "36", "--no-sec", "--dry-run"])
    if out is None:
        log.step("news", "degraded", "trader-news unavailable: %s" % err, t)
        return {"items": [], "moves": []}
    log.step("news", "ok", "%d headlines across %d names" % (len(out.get("items", [])), len(symbols)), t)
    return {"items": out.get("items", [])[:60], "moves": out.get("moves", [])}


def evaluate(hit, b, cfg, reg, news_items, debates, cash, open_n, judged=None, pairs=None, event_blocked=()):
    """One candidate through planner, Time Machine, debate and risk."""
    sym = hit["symbol"]
    setup = hit["setups"][0]
    real_setup = setup != "watch"
    p = agents.plan(b, cfg["stop_atr"], cfg["reward_r"])
    odds = quant.time_machine(b["close"], p["entry"], p["stop"], p["target"], horizon=cfg["horizon_sessions"])
    hist = quant.history_replay(b["high"], b["low"], b["close"], setup, cfg["stop_atr"], cfg["reward_r"],
                                horizon=cfg["horizon_sessions"]) if real_setup else None
    mine = [n for n in news_items if sym in (n.get("touches") or [n.get("ticker")])]
    tid = "%s-%s" % (b["dates"][-1], sym)
    deb = debates.get(tid) or agents.debate(sym, p, odds, hist, mine, reg)
    shares = quant.size(cfg["account"], cash, cfg["max_loss_per_trade"], cfg["max_position_pct"], p["entry"], p["stop"])
    verdict = (judged or {}).get(sym)
    record = (pairs or {}).get("%s|%s" % (sym, setup))
    risk = agents.risk_check(p, shares, odds, cfg, open_n, reg, verdict, record, sym in event_blocked)
    return {"judge": verdict, "record": record, "id": tid, "symbol": sym, "setup": setup, "setups": hit["setups"],
            "as_of": b["dates"][-1], "plan": p, "odds": odds, "history": hist, "debate": deb, "shares": shares,
            "max_loss": round(shares * (p["entry"] - p["stop"]), 2), "cost": round(shares * p["entry"], 2),
            "risk": risk, "news": mine[:5], "status": "awaiting" if risk["verdict"] == "PASS" else "blocked",
            "spark": [round(c, 2) for c in b["close"][-60:]], "ohlc": ohlc(b, OHLC_BARS)}


def ohlc(b, n):
    """Last n daily bars for the candlestick chart."""
    keys = ("dates", "open", "high", "low", "close", "volume")
    return [{"t": d, "o": round(o, 2), "h": round(h, 2), "l": round(lo, 2), "c": round(c, 2), "v": v}
            for d, o, h, lo, c, v in zip(*(b[k][-n:] for k in keys))]


def run(args):
    cfg = read_json(os.path.join(HERE, "config.json"), None)
    if not cfg["paper"]:
        sys.exit("config.paper must stay true: this desk has no live path")
    log, started = Log(), time.time()
    t = time.time()
    bars, errors = gather(cfg, args.demo)
    bars = {s: b for s, b in bars.items() if b.get("dates")}
    if "SPY" not in bars:
        sys.exit("no market data (SPY missing): nothing marked, nothing written. Failed: %s" % ", ".join(sorted(errors)))
    log.step("data", "ok" if not errors else "degraded", "%d series loaded%s" % (
        len(bars), "; failed: " + ", ".join(sorted(errors)) if errors else ""), t)

    t = time.time()
    reg = agents.regime(bars)
    log.step("regime", "ok", "%s (%s)" % (reg["label"].replace("_", " "), reg["why"]), t)

    t = time.time()
    cross = layers.run(bars)
    washed = [a["symbol"] for L in cross["layers"] for a in L["assets"] if a["state"].startswith("washed")]
    log.step("crossmarket", "ok", "%d markets read across %d layers; washed out: %s" % (
        sum(len(L["assets"]) for L in cross["layers"]), len(cross["layers"]), ", ".join(washed) or "none"), t)

    t = time.time()
    arena_res = arena.run(bars)
    fwd = None
    if arena_res:
        closes = {s: dict(zip(b["dates"], b["close"])) for s, b in bars.items()}
        latest = bars["SPY"]["dates"][-1]
        fwd = arena.forward(read_json(os.path.join(args.state, "arena_ledger.json"), None), arena_res, closes, latest)
        write_json(os.path.join(args.state, "arena_ledger.json"), fwd)
        best = max((a for a in arena_res["agents"] if a["stats"]), key=lambda a: a["stats"]["sharpe"] or -9)
        log.step("arena", "ok", "%d strategy agents backtested on a year with costs; best: %s (Sharpe %s); forward days scored: %d" % (
            len(arena_res["agents"]), best["name"], best["stats"]["sharpe"], len(fwd["scored"])), t)
    else:
        log.step("arena", "skipped", "not enough shared history", t)
    t = time.time()
    lab = None if args.demo else intraday.run()
    log.step("daylab", "ok" if lab else "skipped", "hourly rules tested on %d symbols over 60 sessions" % (
        len(lab["symbols"]) if lab else 0) if lab else "no hourly data in a demo run", t)

    t = time.time()
    arb = None if args.demo else arbitrage.run()
    if arb:
        best = max((r for r in arb["routes"] if "net_bps" in r), key=lambda r: r["net_bps"], default=None)
        log.step("arbitrage", "ok", "best route %s %s to %s: %+.1f bps gross, %+.1f bps after fees" % (
            best["asset"], best["buy"], best["sell"], best["gross_bps"], best["net_bps"]) if best else "no venue pair answered", t)
    else:
        log.step("arbitrage", "skipped", "no live quotes in a demo run", t)

    hits, scan_source = scan(cfg, bars, args.demo, log)
    hits = [h for h in hits if h["symbol"] in bars]
    hits += [{"symbol": s, "setups": ["watch"]} for s in cfg.get("focus", [])
             if s in bars and s not in {h["symbol"] for h in hits}]
    nws = news(sorted({h["symbol"] for h in hits}), args.demo, log)
    t = time.time()
    if args.demo:
        judged, jstatus, jsummary = {}, "skipped", "no Clef calls in a demo run"
    else:
        judged, jstatus, jsummary = clef.judge([h["symbol"] for h in hits], nws["items"])
    log.step("judge", jstatus, jsummary, t)

    state_dir = args.state
    pbook = book.load(os.path.join(state_dir, "book.json"), cfg["account"])
    decisions = read_json(os.path.join(state_dir, "decisions.json"), {})
    debates = read_json(os.path.join(state_dir, "debate.json"), {})
    today = max(b["dates"][-1] for b in bars.values())

    t = time.time()
    hind = hindsight.run(bars, sorted(set(cfg["watchlist"]) | set(cfg.get("focus", []))),
                         cfg["stop_atr"], cfg["reward_r"], cfg["horizon_sessions"])
    log.step("hindsight", "ok", "%d past firings graded across %d setups; %d stock-rule records" % (
        hind["n"], len(hind["table"]), len(hind.get("pairs", {}))), t)
    t = time.time()
    prior = read_json(os.path.join(state_dir, "tickets.json"), {})
    event_blocked = {tk["symbol"] for tk in prior.values()
                     if any(r.startswith("News Judge") for r in tk.get("risk", {}).get("reasons", []))}
    held = {p["symbol"] for p in pbook["positions"]}
    cands = [evaluate(h, bars[h["symbol"]], cfg, reg, nws["items"], debates, pbook["cash"], len(pbook["positions"]),
                      judged, hind.get("pairs"), event_blocked)
             for h in hits if h["symbol"] not in held]
    for c in cands:
        if c["id"] in decisions:
            c["status"] = decisions[c["id"]]["status"]
    passed = sum(1 for c in cands if c["risk"]["verdict"] == "PASS")
    log.step("trader", "ok", "%d plans: stop %.1f ATR under entry, target %.1fR" % (
        len(cands), cfg["stop_atr"], cfg["reward_r"]), t)
    log.step("timemachine", "ok", "%d candidates replayed 10,000 times each" % len(cands), t)
    log.step("bull", "ok", "%d bull cases (%s)" % (len(cands), "Claude" if debates else "rules"), t)
    log.step("bear", "ok", "%d bear cases (%s)" % (len(cands), "Claude" if debates else "rules"), t)
    log.step("risk", "ok", "%d PASS, %d BLOCK" % (passed, len(cands) - passed), t)
    waiting = sum(1 for c in cands if c["status"] == "awaiting")
    log.step("pm", "waiting" if waiting else "idle", "%d tickets wait for your yes" % waiting, t)

    t = time.time()
    pbook = book.mark(pbook, bars, today)
    book.save(os.path.join(state_dir, "book.json"), pbook)
    cal = book.calibration(pbook)
    mbook = model_book(state_dir, cfg, bars, today)
    log.step("strategist", "ok" if mbook["positions"] or mbook["closed"] else "idle",
             "Claude's paper book: %d open, %d closed" % (len(mbook["positions"]), len(mbook["closed"])), t)
    log.step("journal", "ok", "%d open, %d closed, Brier %s" % (
        len(pbook["positions"]), cal["n"], cal["brier"] if cal["brier"] is not None else "n/a"), t)

    t = time.time()
    strat = read_json(os.path.join(state_dir, "strategy.json"), None)
    intel = read_json(os.path.join(state_dir, "intel.json"), None)
    edit = editorial.review(intel=intel, strategy=strat, debate=debates)
    log.step("editor", "ok" if not edit["findings"] else "degraded", "%d passages checked against the humanizer rules, %d findings" % (
        edit["checked"], len(edit["findings"])), t)
    log.step("designer", "waiting", "Feel contract applied (Emil); Impeccable finish waits for a visual look at 375, 768 and 1440 px", t)
    desk = {"meta": {"generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "as_of": today,
                     "synthetic": bool(args.demo), "ceiling": "L2_SIMULATION", "paper": True,
                     "sources": ["Yahoo Finance daily bars (unofficial)", scan_source,
                                 "day-trader-skill:trader-news" if not args.demo else "none"]
                     if not args.demo else ["seeded synthetic random walk"],
                     "seconds": round(time.time() - started, 1), "disclaimer": DISCLAIMER, "config": cfg},
            "team": read_json(os.path.join(HERE, "team.json"), {}), "regime": reg, "log": log.steps,
            "candidates": sorted(cands, key=lambda c: (c["risk"]["verdict"] != "PASS", -(c["odds"] or {}).get("ev_r", -9))),
            "moves": nws["moves"], "book": pbook, "calibration": cal, "model_book": mbook, "hindsight": hind,
            "benchmark": benchmark(bars, mbook),
            "strategy": strat, "intel": intel, "editorial": edit, "cross": cross, "absorb": read_json(os.path.join(HERE, "absorb.json"), None), "arena": arena_res, "arena_forward": fwd, "daylab": lab, "arbitrage": arb,
            "cost": cycle_cost(judged, read_json(os.path.join(HERE, "team.json"), {}))}
    write_json(args.out or os.path.join(state_dir, "desk.json"), desk)
    write_json(os.path.join(state_dir, "tickets.json"), {c["id"]: c for c in cands})
    print("desk: %s, %d candidates, %d PASS, %d awaiting your yes -> %s" % (
        reg["label"], len(cands), passed, waiting, args.out or os.path.join(state_dir, "desk.json")))


CLEF_USD_PER_M_INPUT = 0.038  # Workers AI price for clef-flash, read 2026-11-13; Clef bills no output tokens


def cycle_cost(judged, team):
    """What one cycle spends on model calls. Every other agent is arithmetic and costs nothing."""
    calls = sum(1 for v in (judged or {}).values() if "error" not in v)
    tokens = calls * 900  # about 8 headlines plus the three typed questions per call
    return {"model_calls": calls, "est_input_tokens": tokens,
            "est_usd": round(tokens / 1e6 * CLEF_USD_PER_M_INPUT, 6),
            "deterministic_agents": sum(1 for a in team.get("agents", []) if a.get("runs_on") == "deterministic"), "note": "Claude's debate and strategy run in your session, on your plan"}


def model_book(state_dir, cfg, bars, today):
    """Claude's own paper book: the bets the Strategist would make, marked like yours."""
    path = os.path.join(state_dir, "model_book.json")
    mb = book.mark(book.load(path, cfg["account"]), bars, today)
    book.save(path, mb)
    return mb


def benchmark(bars, mb):
    """SPY over the same window as the model book, so a bet is judged against doing nothing."""
    spy = bars.get("SPY")
    if not spy or not mb["equity"]:
        return None
    start = mb["equity"][0]["date"]
    base = next((c for d, c in zip(spy["dates"], spy["close"]) if d >= start), None)
    if not base:
        return None
    return {"symbol": "SPY", "since": start, "return_pct": round((spy["close"][-1] / base - 1) * 100, 2)}


def bet(args):
    """The Strategist places a paper bet in its own book. Same risk rules as yours."""
    tickets = read_json(os.path.join(args.state, "tickets.json"), {})
    tk = tickets.get(args.ticket)
    if not tk:
        sys.exit("no ticket %s in the last cycle" % args.ticket)
    cfg = read_json(os.path.join(HERE, "config.json"), None)
    path = os.path.join(args.state, "model_book.json")
    try:
        mb = book.approve(book.load(path, cfg["account"]), tk, tk["as_of"], cfg["max_positions"])
    except ValueError as e:
        sys.exit(str(e))
    mb["positions"][-1]["why"] = args.why
    book.save(path, mb)
    print("Strategist bet %s: %d %s at %.2f (paper, model book)" % (tk["id"], tk["shares"], tk["symbol"], tk["plan"]["entry"]))


def decide(args, status):
    tickets = read_json(os.path.join(args.state, "tickets.json"), {})
    tk = tickets.get(args.ticket)
    if not tk:
        sys.exit("no ticket %s in the last cycle. Run `status` to see the queue." % args.ticket)
    decisions = read_json(os.path.join(args.state, "decisions.json"), {})
    if status == "approved":
        cfg = read_json(os.path.join(HERE, "config.json"), None)
        path = os.path.join(args.state, "book.json")
        try:
            book.save(path, book.approve(book.load(path, cfg["account"]), tk, tk["as_of"], cfg["max_positions"]))
        except ValueError as e:
            sys.exit(str(e))
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    write_json(os.path.join(args.state, "decisions.json"),
               dict(decisions, **{args.ticket: {"status": status, "at": stamp, "why": args.why}}))
    print("%s %s: %d %s, fills at the next session's open; stop %.2f, target %.2f (paper)" % (
        status, tk["id"], tk["shares"], tk["symbol"], tk["plan"]["stop"], tk["plan"]["target"]))


def status(args):
    desk = read_json(os.path.join(args.state, "desk.json"), None)
    if not desk:
        sys.exit("no desk run yet: python desk/cycle.py run")
    print("as of %s, regime %s" % (desk["meta"]["as_of"], desk["regime"]["label"]))
    for c in desk["candidates"]:
        o = c["odds"] or {}
        print("  %-22s %-8s %-9s target-first %4s  EV %+5.2fR  %s" % (
            c["id"], c["risk"]["verdict"], c["status"], "%d%%" % round(o.get("p_target", 0) * 100),
            o.get("ev_r", 0), "; ".join(c["risk"]["reasons"])[:70]))
    b = desk["book"]
    print("paper cash %.2f, %d open, %d closed" % (b["cash"], len(b["positions"]), len(b["closed"])))


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--state", default=None, help="state folder (default desk/state; demo runs use desk/state/demo)")
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run")
    r.add_argument("--demo", action="store_true", help="seeded synthetic data, no network")
    r.add_argument("--out", help="write desk.json here instead of the state folder")
    for name in ("approve", "reject"):
        p = sub.add_parser(name)
        p.add_argument("ticket")
        p.add_argument("--why", default="")
    sub.add_parser("status")
    bp = sub.add_parser("bet", help="Strategist's own paper bet (model book, not yours)")
    bp.add_argument("ticket")
    bp.add_argument("--why", required=True)
    args = ap.parse_args(argv)
    if args.state is None:
        # A demo must never touch the real paper book, ledger or queue.
        args.state = os.path.join(STATE, "demo") if getattr(args, "demo", False) else STATE
    if args.cmd == "run":
        run(args)
    elif args.cmd == "status":
        status(args)
    elif args.cmd == "bet":
        bet(args)
    else:
        decide(args, "approved" if args.cmd == "approve" else "rejected")


if __name__ == "__main__":
    main()
