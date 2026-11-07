#!/usr/bin/env python3
"""Compare a benchmark run against a saved baseline and fail on regression.

Both files are JSON objects {"benchmark name": number}. By default lower is better
(time, instructions, bytes). Use --higher-is-better for throughput (ops/s, tokens/s).

  bench_compare.py benches/baselines/hot.json target/bench/hot.json --max-regression 5
  bench_compare.py base.json cur.json --higher-is-better --max-regression 3

Prefer deterministic metrics (instruction counts from gungraun / CodSpeed simulation).
Wall-clock numbers from shared CI runners are noisy; use a larger threshold for them.
Exit 0 = within budget, 1 = regression or missing benchmark, 2 = bad input.
"""
import argparse
import json
import math
import sys


def load(path: str) -> dict[str, float]:
    try:
        with open(path, encoding="utf-8") as source:
            data = json.load(source)
    except (OSError, json.JSONDecodeError) as e:
        print(f"bench_compare: cannot read {path}: {e}", file=sys.stderr)
        sys.exit(2)
    if not isinstance(data, dict) or not all(type(v) in (int, float) for v in data.values()):
        print(f"bench_compare: {path} must be a JSON object of name -> finite number", file=sys.stderr)
        sys.exit(2)
    try:
        values = {k: float(v) for k, v in data.items()}
    except OverflowError:
        values = None
    if values is None or not all(math.isfinite(v) for v in values.values()):
        print(f"bench_compare: {path} contains a non-finite metric", file=sys.stderr)
        sys.exit(2)
    return values


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("baseline")
    ap.add_argument("current")
    ap.add_argument("--max-regression", type=float, default=5.0, help="allowed worsening in percent (default 5)")
    ap.add_argument("--higher-is-better", action="store_true")
    ap.add_argument("--allow-missing", action="store_true", help="a benchmark absent from the current run is not a failure")
    a = ap.parse_args()
    if not math.isfinite(a.max_regression) or a.max_regression < 0:
        ap.error("--max-regression must be a finite non-negative percentage")
    base, cur = load(a.baseline), load(a.current)
    worst, failed = 0.0, False
    rows = []
    for name in sorted(base):
        if name not in cur:
            rows.append((name, base[name], None, None, "MISSING"))
            failed |= not a.allow_missing
            continue
        b, c = base[name], cur[name]
        if b == 0:
            change = 0.0 if c == 0 else float("inf")
        else:
            change = (c - b) / abs(b) * 100
        worse = -change if a.higher_is_better else change
        status = "REGRESSED" if worse > a.max_regression else ("improved" if worse < -a.max_regression else "ok")
        failed |= status == "REGRESSED"
        worst = max(worst, worse)
        rows.append((name, b, c, change, status))
    for name in sorted(set(cur) - set(base)):
        rows.append((name, None, cur[name], None, "new (no baseline)"))
    w = max([len(r[0]) for r in rows] + [9])
    print(f"{'benchmark':<{w}}  {'baseline':>14}  {'current':>14}  {'change':>8}  status")
    for name, b, c, ch, st in rows:
        fb = f"{b:,.2f}" if b is not None else "-"
        fc = f"{c:,.2f}" if c is not None else "-"
        fch = f"{ch:+.2f}%" if ch is not None else "-"
        print(f"{name:<{w}}  {fb:>14}  {fc:>14}  {fch:>8}  {st}")
    direction = "higher is better" if a.higher_is_better else "lower is better"
    print(f"\nbudget {a.max_regression}% ({direction}); worst worsening {worst:+.2f}% -> {'FAIL' if failed else 'OK'}")
    if failed:
        print("To accept a new baseline, a human copies the current file over the baseline and commits it.")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
