"""Offline tests for the desk. Run: python -m unittest discover -s desk/tests -v"""
import glob
import io
import json
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from datetime import datetime

DESK = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, DESK)

import cycle  # noqa: E402
from engine import agents, arena, book, clef, data, hindsight, intraday, layers, quant  # noqa: E402

CFG = {"account": 10000, "max_loss_per_trade": 100, "max_position_pct": 20, "max_positions": 5,
       "min_reward_r": 1.5, "min_ev_r": 0.1, "block_longs_risk_off": True}


class Quant(unittest.TestCase):
    def test_rsi_is_100_when_only_gains_and_none_when_short(self):
        self.assertEqual(quant.rsi(list(range(1, 30))), 100.0)
        self.assertIsNone(quant.rsi([1, 2, 3]))

    def test_rsi_is_50_for_alternating_equal_moves(self):
        self.assertAlmostEqual(quant.rsi([10, 11] * 20), 50.0, delta=4)

    def test_atr_on_constant_range(self):
        n = 30
        self.assertAlmostEqual(quant.atr([11.0] * n, [9.0] * n, [10.0] * n), 2.0)

    def test_size_takes_the_tightest_of_risk_cap_and_cash(self):
        self.assertEqual(quant.size(10000, 10000, 100, 20, 50, 48), 40)   # cap: 2000/50
        self.assertEqual(quant.size(10000, 10000, 100, 100, 50, 45), 20)  # risk: 100/5
        self.assertEqual(quant.size(10000, 300, 100, 100, 50, 49), 6)     # cash
        self.assertEqual(quant.size(10000, 10000, 100, 20, 50, 51), 0)    # stop above entry

    def test_walk_reports_first_touch(self):
        self.assertEqual(quant.walk([101, 99, 111], 100, 95, 110), ("target", 111))
        self.assertEqual(quant.walk([101, 94, 111], 100, 95, 110), ("stop", 94))
        self.assertEqual(quant.walk([101, 102], 100, 95, 110), ("open", 102))

    def test_time_machine_is_seeded_and_sums_to_one(self):
        c = data.synthetic_bars("X")["close"]
        a = quant.time_machine(c, c[-1], c[-1] * 0.95, c[-1] * 1.1, paths=2000)
        b = quant.time_machine(c, c[-1], c[-1] * 0.95, c[-1] * 1.1, paths=2000)
        self.assertEqual(a, b)
        self.assertAlmostEqual(a["p_target"] + a["p_stop"] + a["p_open"], 1.0, places=3)

    def test_time_machine_favours_a_rising_series(self):
        up = data.synthetic_bars("U", drift=0.004, vol=0.01)["close"]
        down = data.synthetic_bars("U", drift=-0.004, vol=0.01)["close"]
        p_up = quant.time_machine(up, up[-1], up[-1] * 0.95, up[-1] * 1.1, paths=2000)
        p_dn = quant.time_machine(down, down[-1], down[-1] * 0.95, down[-1] * 1.1, paths=2000)
        self.assertGreater(p_up["ev_r"], 0)
        self.assertLess(p_dn["ev_r"], 0)

    def test_time_machine_refuses_short_history(self):
        self.assertIsNone(quant.time_machine([10.0] * 10, 10, 9, 12))

    def test_breakout_rule_matches_scanner(self):
        c = [100.0] * 40 + [105.0]
        self.assertIn("breakout_20d", quant.setups(c))

    def test_brier(self):
        self.assertEqual(quant.brier([(0.5, 1), (0.5, 0)]), 0.25)
        self.assertEqual(quant.brier([(1.0, 1)]), 0.0)
        self.assertIsNone(quant.brier([]))


class Agents(unittest.TestCase):
    def plan(self, **kw):
        p = {"entry": 100, "stop": 95, "target": 110, "reward_r": 2.0, "rsi": 50, "above200": True,
             "above50": True, "rel_volume": 1.0}
        p.update(kw)
        return p

    def test_risk_passes_a_clean_ticket(self):
        r = agents.risk_check(self.plan(), 10, {"ev_r": 0.3}, CFG, 0, {"label": "neutral"})
        self.assertEqual(r, {"verdict": "PASS", "reasons": []})

    def test_risk_lists_every_reason(self):
        r = agents.risk_check(self.plan(reward_r=1.0), 0, {"ev_r": -0.2}, CFG, 5, {"label": "risk_off"})
        self.assertEqual(r["verdict"], "BLOCK")
        self.assertEqual(len(r["reasons"]), 5)

    def test_risk_blocks_without_odds(self):
        self.assertEqual(agents.risk_check(self.plan(), 10, None, CFG, 0, {"label": "neutral"})["verdict"], "BLOCK")

    def test_debate_only_counts_event_tags_on_the_names_own_headlines(self):
        news = [{"ticker": "AMD", "tags": ["earnings", "macro"]}, {"ticker": "NVDA", "tags": ["legal"]}]
        d = agents.debate("AMD", self.plan(), None, None, news, {"label": "neutral", "why": ""})
        self.assertIn("Event risk in AMD's own headlines: earnings", d["bear"])

    def test_regime_reads_risk_off_from_a_falling_market(self):
        bars = {s: data.synthetic_bars(s, drift=-0.003, vol=0.01) for s in agents.REGIME_SYMBOLS}
        self.assertEqual(agents.regime(bars)["label"], "risk_off")


class Book(unittest.TestCase):
    def ticket(self, verdict="PASS"):
        return {"id": "D001-ABC", "symbol": "ABC", "setup": "breakout_20d", "shares": 10, "as_of": "D001",
                "plan": {"entry": 100.0, "stop": 95.0, "target": 110.0},
                "odds": {"p_target": 0.4, "horizon": 5}, "risk": {"verdict": verdict, "reasons": ["x"]}}

    def test_blocked_ticket_cannot_be_approved(self):
        with self.assertRaises(ValueError):
            book.approve(book.load("/nonexistent", 10000), self.ticket("BLOCK"), "D001")

    def test_approve_moves_paper_cash_and_leaves_input_untouched(self):
        b0 = book.load("/nonexistent", 10000)
        b1 = book.approve(b0, self.ticket(), "D001")
        self.assertEqual(b1["cash"], 9000.0)
        self.assertEqual(b0["cash"], 10000)
        self.assertEqual(b0["positions"], [])

    def test_mark_closes_at_target_and_scores_it(self):
        b = book.approve(book.load("/nonexistent", 10000), self.ticket(), "D001")
        bars = {"ABC": {"dates": ["D001", "D002", "D003"], "open": [99.0, 100.0, 104.0], "close": [100.0, 104.0, 112.0]}}
        b = book.mark(b, bars, "D003")
        self.assertEqual(b["positions"], [])
        self.assertEqual(b["closed"][0]["outcome"], "target")
        self.assertEqual(b["closed"][0]["pnl"], 100.0)
        self.assertEqual(b["cash"], 10100.0)
        cal = book.calibration(b)
        self.assertEqual(cal["brier"], 0.36)

    def test_gap_through_stop_books_the_real_close(self):
        b = book.approve(book.load("/nonexistent", 10000), self.ticket(), "D001")
        b = book.mark(b, {"ABC": {"dates": ["D001", "D002"], "open": [99.0, 100.0], "close": [100.0, 90.0]}}, "D002")
        self.assertEqual(b["closed"][0]["exit"], 90.0)
        self.assertEqual(b["closed"][0]["r"], -2.0)

    def test_order_fills_at_next_open_never_at_the_signal_close(self):
        b = book.approve(book.load("/nonexistent", 10000), self.ticket(), "D001")
        self.assertTrue(b["positions"][0]["pending"])
        b = book.mark(b, {"ABC": {"dates": ["D001"], "open": [99.0], "close": [100.0]}}, "D001")
        self.assertTrue(b["positions"][0]["pending"])  # no later session yet
        b = book.mark(b, {"ABC": {"dates": ["D001", "D002"], "open": [99.0, 102.0], "close": [100.0, 103.0]}}, "D002")
        self.assertEqual(b["positions"][0]["entry"], 102.0)
        self.assertEqual(b["cash"], 10000 - 1020.0)

    def test_open_below_stop_cancels_the_order(self):
        b = book.approve(book.load("/nonexistent", 10000), self.ticket(), "D001")
        b = book.mark(b, {"ABC": {"dates": ["D001", "D002"], "open": [99.0, 93.0], "close": [100.0, 92.0]}}, "D002")
        self.assertEqual(b["closed"][0]["outcome"], "cancelled")
        self.assertEqual(b["cash"], 10000)

    def test_positions_cap_holds_at_approval(self):
        b = book.approve(book.load("/nonexistent", 10000), self.ticket(), "D001", max_positions=1)
        other = dict(self.ticket(), id="D001-XYZ", symbol="XYZ")
        with self.assertRaises(ValueError):
            book.approve(b, other, "D001", max_positions=1)

    def test_approve_rejects_broken_tickets(self):
        bad_stop = dict(self.ticket(), plan={"entry": 100.0, "stop": 100.0, "target": 110.0})
        no_shares = dict(self.ticket(), shares=0)
        for t in (bad_stop, no_shares):
            with self.assertRaises(ValueError):
                book.approve(book.load("/nonexistent", 10000), t, "D001")

    def test_mark_keeps_an_open_position_inside_its_horizon(self):
        b = book.approve(book.load("/nonexistent", 10000), self.ticket(), "D001")
        b = book.mark(b, {"ABC": {"dates": ["D001", "D002"], "open": [99.0, 100.0], "close": [100.0, 101.0]}}, "D002")
        self.assertEqual(len(b["positions"]), 1)
        self.assertEqual(b["equity"][-1]["equity"], 10010.0)


class Data(unittest.TestCase):
    def test_unfinished_session_is_dropped(self):
        bars = {"dates": ["2026-11-12", "2026-11-13"], "close": [1.0, 2.0]}
        midday = datetime(2026, 11, 13, 12, 0)
        after = datetime(2026, 11, 13, 16, 30)
        self.assertEqual(data.drop_unfinished(bars, midday)["dates"], ["2026-11-12"])
        self.assertEqual(data.drop_unfinished(bars, after)["dates"], ["2026-11-12", "2026-11-13"])


class Cycle(unittest.TestCase):
    def test_demo_cycle_end_to_end_then_approve(self):
        with tempfile.TemporaryDirectory() as tmp:
            with redirect_stdout(io.StringIO()):
                cycle.main(["--state", tmp, "run", "--demo"])
            desk = json.load(open(os.path.join(tmp, "desk.json"), encoding="utf-8"))
            self.assertTrue(desk["meta"]["synthetic"])
            self.assertEqual(desk["meta"]["ceiling"], "L2_SIMULATION")
            self.assertEqual({s["agent"] for s in desk["log"]} - {"data"},
                             {a["id"] for a in desk["team"]["agents"]})
            ready = [c for c in desk["candidates"] if c["risk"]["verdict"] == "PASS"]
            self.assertTrue(ready, "the seeded demo should produce at least one PASS")
            with redirect_stdout(io.StringIO()):
                cycle.main(["--state", tmp, "approve", ready[0]["id"]])
            b = json.load(open(os.path.join(tmp, "book.json"), encoding="utf-8"))
            self.assertEqual(len(b["positions"]), 1)
            self.assertLess(b["cash"], 10000)
            with redirect_stdout(io.StringIO()):
                cycle.main(["--state", tmp, "bet", ready[0]["id"], "--why", "test"])
            mb = json.load(open(os.path.join(tmp, "model_book.json"), encoding="utf-8"))
            self.assertEqual(mb["positions"][0]["why"], "test")


class Judge(unittest.TestCase):
    ANSWERS = {"result": {"answers": {"event_risk": {"type": "noul", "noul": 0.81},
               "direction": {"type": "choice", "choice": "bearish", "probabilities": {"bearish": 0.7}},
               "materiality": {"type": "score", "score": 2.4}}}}

    def opener(self, req, timeout=None):
        self.sent = json.loads(req.data)
        body = io.BytesIO(json.dumps(self.ANSWERS).encode())
        body.__enter__ = lambda: body
        body.__exit__ = lambda *a: None
        return body

    def test_skips_cleanly_without_credentials(self):
        old = {k: os.environ.pop(k, None) for k in ("CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN")}
        try:
            out, status, _ = clef.judge(["NVDA"], [{"ticker": "NVDA", "title": "x"}])
            self.assertEqual((out, status), ({}, "skipped"))
        finally:
            os.environ.update({k: v for k, v in old.items() if v})

    def test_parses_system_one_answers_and_asks_typed_questions(self):
        old = {k: os.environ.get(k) for k in ("CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN")}
        os.environ.update({"CLOUDFLARE_ACCOUNT_ID": "acct", "CLOUDFLARE_API_TOKEN": "t"})
        try:
            out, status, _ = clef.judge(["NVDA", "AMD"], [{"ticker": "NVDA", "title": "CEO resigns"}], self.opener)
        finally:
            for k, v in old.items():
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v
        self.assertEqual(status, "ok")
        self.assertEqual(out, {"NVDA": {"event_risk": 0.81, "direction": "bearish",
                                        "direction_p": {"bearish": 0.7}, "materiality": 2.4}})
        self.assertEqual(self.sent["questions"]["event_risk"]["type"], "noul")
        self.assertIn("CEO resigns", self.sent["state"])

    def test_event_risk_hysteresis_holds_a_block_until_release_level(self):
        p = {"entry": 100, "stop": 95, "target": 110, "reward_r": 2.0}
        cfg = dict(CFG, max_event_risk=0.7, release_event_risk=0.65)
        judge = {"event_risk": 0.68}
        fresh = agents.risk_check(p, 10, {"ev_r": 0.3}, cfg, 0, {"label": "neutral"}, judge)
        held = agents.risk_check(p, 10, {"ev_r": 0.3}, cfg, 0, {"label": "neutral"}, judge, None, True)
        self.assertEqual((fresh["verdict"], held["verdict"]), ("PASS", "BLOCK"))
        released = agents.risk_check(p, 10, {"ev_r": 0.3}, cfg, 0, {"label": "neutral"}, {"event_risk": 0.6}, None, True)
        self.assertEqual(released["verdict"], "PASS")

    def test_high_event_risk_blocks(self):
        p = {"entry": 100, "stop": 95, "target": 110, "reward_r": 2.0}
        cfg = dict(CFG, max_event_risk=0.7)
        r = agents.risk_check(p, 10, {"ev_r": 0.3}, cfg, 0, {"label": "neutral"}, {"event_risk": 0.8})
        self.assertIn("event risk at 80%", r["reasons"][0])


class Hindsight(unittest.TestCase):
    def test_pairs_rank_by_average_not_by_name(self):
        rows = ([{"symbol": "ZZZ", "setup": "s", "r": 2.0, "outcome": "target"}] * 8
                + [{"symbol": "AAA", "setup": "s", "r": -1.0, "outcome": "stop"}] * 8
                + [{"symbol": "MID", "setup": "s", "r": 2.0, "outcome": "target"}] * 3)
        pairs = hindsight.by_pair(rows)
        self.assertEqual([p["symbol"] for p in pairs], ["ZZZ", "AAA"])  # MID: under 8 firings
        self.assertEqual(pairs[0]["avg_r"], 2.0)

    def test_losing_record_blocks(self):
        p = {"entry": 100, "stop": 95, "target": 110, "reward_r": 2.0}
        r = agents.risk_check(p, 10, {"ev_r": 0.3}, CFG, 0, {"label": "neutral"}, None, {"n": 20, "avg_r": -0.5})
        self.assertEqual(r["verdict"], "BLOCK")

    def test_run_on_synthetic_bars_grades_firings(self):
        bars = {s: data.synthetic_bars(s, n=320) for s in ("SPY", "ABC", "XYZ")}
        h = hindsight.run(bars, ["ABC", "XYZ"], 1.5, 2.0, 10)
        self.assertGreater(h["n"], 0)
        self.assertTrue(all(r["all"]["n"] > 0 for r in h["table"]))


class Arena(unittest.TestCase):
    def bars(self, drift):
        syms = arena.STOCKS + arena.CRYPTO + arena.DEFENSIVE
        return {s: data.synthetic_bars(s, n=520, drift=drift) for s in syms}

    def test_every_agent_reports_and_benchmark_is_spy(self):
        r = arena.run(self.bars(0.0006))
        self.assertEqual(len(r["agents"]), len(arena.AGENTS))
        bench = next(a for a in r["agents"] if a["id"] == "benchmark")
        self.assertEqual(bench["holds"], {"SPY": 1.0})

    def test_no_lookahead_weights_use_only_past_closes(self):
        series = {"SPY": [100.0] * 250 + [200.0]}
        seen = []
        def spy(hist, day):
            seen.append(len(hist["SPY"]))
            return {"SPY": 1.0}
        arena.backtest(spy, series, list(range(251)), 240)
        self.assertEqual(max(seen), 250)  # the last close is never used to decide

    def test_meta_weights_cap_and_ignore_losers(self):
        up = [1.0 * (1.001 + 0.0005 * ((i % 3) - 1)) ** i for i in range(80)]
        down = [1.0 * 0.999 ** i for i in range(80)]
        w = arena.meta_weights({"a": up, "b": down, "benchmark": up})
        self.assertNotIn("b", w)
        self.assertLessEqual(max(w.values()), 0.4)

    def test_forward_scores_yesterday_on_today_net_of_entry_cost(self):
        res = {"agents": [{"id": "benchmark", "holds": {"SPY": 1.0}}]}
        led = arena.forward(None, res, {"SPY": {"D1": 100.0}}, "D1")
        led = arena.forward(led, res, {"SPY": {"D1": 100.0, "D2": 101.0}}, "D2")
        self.assertEqual(led["summary"]["benchmark"]["days"], 1)
        self.assertAlmostEqual(led["summary"]["benchmark"]["total_pct"], 1.0 - arena.COST_BPS / 100, places=2)

    def test_forward_does_not_overlap_after_missed_cycles(self):
        res = {"agents": [{"id": "benchmark", "holds": {"SPY": 1.0}}]}
        closes = {"SPY": {"D1": 100.0}}
        led = arena.forward(None, res, closes, "D1")
        closes = {"SPY": {"D1": 100.0, "D2": 110.0, "D3": 121.0, "D4": 133.1}}
        led = arena.forward(led, res, closes, "D4")  # three cycles missed: only D1->D2 is scored
        self.assertEqual(led["summary"]["benchmark"]["days"], 1)
        self.assertLess(led["summary"]["benchmark"]["total_pct"], 10.0)

    def test_forward_totals_survive_trimming(self):
        res = {"agents": [{"id": "benchmark", "holds": {"SPY": 1.0}}]}
        led = {"records": [], "scored": [], "totals": {"benchmark": {"days": 500, "growth": 1.5}}}
        led = arena.forward(led, res, {"SPY": {"D1": 100.0}}, "D1")
        self.assertEqual(led["summary"]["benchmark"]["days"], 500)


class DayLab(unittest.TestCase):
    def test_rules_trade_flat_by_close_with_costs(self):
        day = [{"o": 100, "h": 101, "l": 99, "c": 100.5}, {"o": 100.5, "h": 102, "l": 100, "c": 101.5},
               {"o": 101.5, "h": 103, "l": 101, "c": 102}, {"o": 102, "h": 103, "l": 101, "c": 102.5},
               {"o": 102.5, "h": 103, "l": 102, "c": 103}]
        t = intraday.first_hour_breakout(100, day)
        self.assertAlmostEqual(t, (103 / 101.5 - 1) - 2 * intraday.COST_BPS / 1e4)

    def test_run_survives_a_failing_symbol(self):
        def fetch(sym):
            raise IOError("down")
        r = intraday.run(("SPY",), fetch)
        self.assertIn("error", r["symbols"][0])


class CrossMarket(unittest.TestCase):
    def test_layers_read_trend_and_state(self):
        bars = {s: data.synthetic_bars(s, n=300, drift=-0.004, vol=0.01) for s in layers.SYMBOLS}
        r = layers.run(bars)
        btc = next(a for L in r["layers"] for a in L["assets"] if a["symbol"] == "BTC-USD")
        self.assertEqual(btc["trend"], "down")
        self.assertTrue(r["links"])


class Arbitrage(unittest.TestCase):
    def test_route_buys_cheapest_ask_sells_richest_bid_net_of_fees(self):
        from engine import arbitrage
        r = arbitrage.best_route({"kraken": (101.0, 101.1), "bitstamp": (99.9, 100.0)})
        self.assertEqual((r["buy"], r["sell"]), ("bitstamp", "kraken"))
        self.assertAlmostEqual(r["gross_bps"], 100.0)
        self.assertAlmostEqual(r["net_bps"], 100.0 - 80)

    def test_a_down_venue_is_reported_not_fatal(self):
        from engine import arbitrage
        def down(a):
            raise IOError("timeout")
        out = arbitrage.run(("BTC",), {"a": lambda x: (1.0, 1.1), "b": down})
        self.assertEqual(out["routes"][0]["venues"], 1)
        self.assertTrue(out["routes"][0]["errors"])


class Funds(unittest.TestCase):
    def test_weight_changes_become_priced_trades(self):
        from engine import funds
        series = {"A": [10.0, 11.0, 12.0], "B": [5.0, 5.0, 5.0]}
        dec = [(0, {"A": 0.5}), (1, {"A": 0.5, "B": 0.3}), (2, {"B": 0.3})]
        t = funds.trades(dec, series, ["D0", "D1", "D2"])
        self.assertEqual([(x["date"], x["symbol"], x["side"]) for x in t], [("D1", "B", "open"), ("D2", "A", "close")])
        self.assertEqual(t[1]["price"], 12.0)

    def test_coach_names_the_number_behind_each_note(self):
        from engine import funds
        st = {"turnover_days": 240, "sharpe": -0.3, "max_dd_pct": -18.0, "total_pct": -2.0}
        notes = funds.coach(st, 10.0, {}, 0.0)
        self.assertTrue(any("240 of 252" in n for n in notes))
        self.assertTrue(any("-18.0%" in n for n in notes))

    def test_every_arena_agent_has_a_fund_profile(self):
        from engine import funds
        self.assertEqual({k for k, *_ in arena.AGENTS}, set(funds.PROFILES))


class Ceiling(unittest.TestCase):
    def test_no_order_or_broker_path_exists_in_desk_code(self):
        banned = ("alpaca", "place_order", "submit_order", "requests.post", "method=\"POST\"", "api_key")
        for path in glob.glob(os.path.join(DESK, "**", "*.py"), recursive=True):
            if os.sep + "tests" + os.sep in path:
                continue
            text = open(path, encoding="utf-8").read().lower()
            for word in banned:
                self.assertNotIn(word.lower(), text, "%s mentions %s" % (path, word))

    def test_config_is_paper(self):
        self.assertTrue(json.load(open(os.path.join(DESK, "config.json")))["paper"])


if __name__ == "__main__":
    unittest.main()
