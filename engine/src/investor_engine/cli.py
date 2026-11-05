from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from . import artifacts, backtest, guardrails, policy, stress, theories, universe, validation
from .data import get_adapter

ENGINE_ROOT = Path(__file__).resolve().parents[2]
CONFIG_DIR = ENGINE_ROOT / "configs" / "sleeves"
ARTIFACT_DIR = ENGINE_ROOT.parent / "web" / "public" / "data" / "studies"
POLICY_CONTRACT = ENGINE_ROOT.parent / "packages" / "contracts" / "policy" / "policy.json"


def cmd_configs(args: argparse.Namespace) -> int:
    configs = universe.load_all(args.config_dir)
    for cid, cfg in configs.items():
        problems = cfg.validate()
        flag = "OK " if not problems else "BAD"
        print(f"[{flag}] {cid:<18} {cfg.name}  horizon={cfg.horizon_years}y  "
              f"backtestable={cfg.backtestable_weight:.0%}")
        for s in cfg.sleeves:
            print(f"        {s.target_weight:>5.0%}  {s.name:<28} "
                  f"{s.asset_class.value:<10} {s.liquidity.value:<9} {s.markable.value}")
        for p in problems:
            print(f"        !! {p}")
        print()
    return 0


def cmd_theories(_: argparse.Namespace) -> int:
    for tid in theories.all_ids():
        t = theories.get(tid)
        print(f"{tid:<16} {t.name}")
        print(f"                 claim:   {t.claim}")
        print(f"                 breaks:  {t.known_failure_mode}\n")
    return 0


def cmd_study(args: argparse.Namespace) -> int:
    cfg = universe.load_config(Path(args.config_dir) / f"{args.config}.json")
    problems = cfg.validate()
    if problems:
        print(f"Config {args.config} is invalid:", file=sys.stderr)
        for p in problems:
            print(f"  - {p}", file=sys.stderr)
        return 1

    weights = cfg.weights_by_symbol()
    if not weights:
        print(f"Config {args.config} has no market-priced holdings to backtest.", file=sys.stderr)
        return 1

    symbols = sorted(weights)
    adapter = get_adapter(args.source)
    prices = adapter.prices(symbols, args.start, args.end)

    results = [
        backtest.run(
            prices,
            weights,
            name="config-target",
            rebalance=args.rebalance,
            cost_bps=args.cost_bps,
            data_source=adapter.name,
        )
    ]
    for tid in (args.theories or theories.all_ids()):
        t = theories.get(tid)
        results.append(
            backtest.run(
                prices,
                t.weight_fn,
                name=t.name,
                rebalance=t.rebalance,
                cost_bps=args.cost_bps,
                data_source=adapter.name,
            )
        )

    print(f"\nStudy: {args.config}  |  {args.start} -> {args.end}  |  source={adapter.name}")
    excluded = max(0.0, 1.0 - cfg.backtestable_weight)
    print(f"Backtest covers {cfg.backtestable_weight:.0%} of the portfolio "
          f"({excluded:.0%} is book/appraisal-valued and excluded).\n")

    print("IN-SAMPLE — every strategy scored on the same window it was compared on.")
    print("This ranking is not evidence. Overlapping intervals mean indistinguishable.\n")
    print(validation.compare_with_intervals(results, n_samples=args.bootstrap)
          .to_string(float_format=lambda v: f"{v:,.3f}"))

    wf = None
    if not args.skip_validation:
        wf = validation.walk_forward(
            prices, n_folds=args.folds, cost_bps=args.cost_bps, rebalance=args.rebalance,
            selection_metric=args.selection_metric,
        )
        print(f"\nOUT-OF-SAMPLE — {args.folds} expanding folds; chosen on train, scored on test.")
        for f in wf.folds:
            print(f"  fold {f.index}  test {f.test_start}..{f.test_end}  picked {f.selected:<14}"
                  f" train={f.train_score:6.3f}  test={f.test_score:6.3f}"
                  f"  (hindsight: {f.hindsight_best})")
        print(f"\n  selected on         : {wf.selection_metric}")
        print(f"  selection OOS       : sharpe {wf.oos_performance.sharpe:.3f}"
              f"   cagr {wf.oos_performance.cagr:.2%}")
        print(f"  baseline  OOS       : sharpe {wf.baseline_performance.sharpe:.3f}"
              f"   cagr {wf.baseline_performance.cagr:.2%}   ({wf.baseline_id})")
        print(f"  in-sample mean score: {wf.mean_train_score:.3f}")
        print(f"  overfitting gap                : {wf.overfitting_gap:.3f}")
        print(f"  selection stability            : {wf.selection_stability:.0%}")
        print(f"\n  VERDICT: {wf.verdict()}")

    path = artifacts.write_study(
        args.out,
        study_id=f"{args.config}-{args.start}-{args.end}",
        results=results,
        universe=symbols,
        start=args.start,
        end=args.end,
        config_id=cfg.id,
        backtestable_weight=cfg.backtestable_weight,
        validation=wf.to_dict() if wf else None,
    )
    print(f"\nArtifact: {path}")
    if adapter.name == "synthetic":
        print("NOTE: synthetic prices. This measures strategy mechanics, not asset performance.")
    return 0


def cmd_policy(args: argparse.Namespace) -> int:
    decision = policy.evaluate(policy.Action(action_type=args.action))
    print(f"{args.action}: {decision.verdict.value} — {decision.reason}")
    return 0 if decision.allowed else 2


def cmd_policy_export(args: argparse.Namespace) -> int:
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(guardrails.export_contract(), indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(f"wrote {out}")
    return 0


def cmd_gauntlet(args: argparse.Namespace) -> int:
    report = guardrails.run()
    print(f"guardrails: {report.total - len(report.failures)}/{report.total} cases held")
    for f in report.failures:
        print(f"  FAIL {f.case}: expected {f.expected.value}, got {f.got.value} ({f.why})")

    rows = stress.run_stress(seed=args.seed)
    print("\nmax drawdown by theory and scenario (synthetic regimes, not forecasts):")
    print(stress.summarize_stress(rows).to_string())

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    payload = {
        "guardrails": {
            "total": report.total,
            "failures": [f.case for f in report.failures],
            "dangerous_allowed": report.dangerous_allowed,
            "safe_refused": report.safe_refused,
        },
        "stress": [r.__dict__ for r in rows],
        "seed": args.seed,
        "ceiling": policy.ENGINE_CEILING.value,
    }
    (out / "gauntlet-report.json").write_text(json.dumps(payload, indent=2), encoding="utf-8")
    return 0 if report.passed else 1


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="investor",
        description=f"GenInvestor simulation engine (ceiling: {policy.ENGINE_CEILING.value}).",
    )
    parser.add_argument("--config-dir", default=str(CONFIG_DIR))
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("configs", help="List and validate allocation configs.").set_defaults(func=cmd_configs)
    sub.add_parser("theories", help="List testable theories and their failure modes.").set_defaults(func=cmd_theories)

    p = sub.add_parser("policy", help="Check whether an action is permitted.")
    p.add_argument("action")
    p.set_defaults(func=cmd_policy)

    s = sub.add_parser("study", help="Backtest a config against the theory registry.")
    s.add_argument("config")
    s.add_argument("--start", default="2015-01-01")
    s.add_argument("--end", default="2026-08-01")
    s.add_argument("--source", default="synthetic", choices=["synthetic", "yahoo", "tradingview"])
    s.add_argument("--rebalance", default="Q", choices=["none", "M", "Q", "A"])
    s.add_argument("--cost-bps", type=float, default=10.0)
    s.add_argument("--theories", nargs="*")
    s.add_argument("--out", default=str(ARTIFACT_DIR))
    s.add_argument("--folds", type=int, default=5, help="Walk-forward folds.")
    s.add_argument("--bootstrap", type=int, default=500, help="Bootstrap resamples for the interval.")
    s.add_argument("--selection-metric", default="sharpe", choices=list(validation.SELECTION_METRICS),
                   help="Criterion for picking the winner on training data. "
                        "'sharpe' degenerates to cash when the universe holds a cash instrument.")
    s.add_argument("--skip-validation", action="store_true",
                   help="Skip walk-forward. The result is then in-sample only and not evidence.")
    s.set_defaults(func=cmd_study)

    x = sub.add_parser("policy-export", help="Write the gate table and guardrail cases as the shared contract file.")
    x.add_argument("--out", default=str(POLICY_CONTRACT))
    x.set_defaults(func=cmd_policy_export)

    e = sub.add_parser("gauntlet", help="Run guardrail checks and regime stress simulations.")
    e.add_argument("--seed", type=int, default=7)
    e.add_argument("--out", default=str(ENGINE_ROOT / ".cache" / "evals"))
    e.set_defaults(func=cmd_gauntlet)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
