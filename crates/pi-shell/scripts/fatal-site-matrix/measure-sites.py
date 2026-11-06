#!/usr/bin/env python3
"""Measure every generated row against four independent live columns.

Bash 5.2.21 and Bash 5.3.0 run with `-c`, as `Shell::run` does. The main
and head columns each run the selected tree's native addon. Missing inputs,
failed batches and incomplete results end the run non-zero.

usage: measure-sites.py <sites.json> <out.json> --main-tree TREE --bash-53 BASH
See README.md beside this script for all arguments and prerequisites.
"""

import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile


def executable(value: str, label: str) -> str:
    binary = shutil.which(value)
    if binary is None:
        raise SystemExit(f"measure-sites: {label} is not executable or not on PATH: {value}")
    return os.path.abspath(binary)


def bash_version(binary: str, expected: str) -> None:
    result = subprocess.run(
        [binary, "--noprofile", "--norc", "-c",
         'printf \'%s.%s.%s\' "${BASH_VERSINFO[0]}" "${BASH_VERSINFO[1]}" "${BASH_VERSINFO[2]}"'],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=20,
    )
    actual = result.stdout.decode("utf-8", "replace")
    if result.returncode != 0 or actual != expected:
        raise SystemExit(f"measure-sites: {binary} must be Bash {expected}; reported {actual!r} (rc={result.returncode})")


def bash_column(name: str, binary: str, rows: list[dict], cwd: str) -> dict:
    out = {}
    for r in rows:
        p = subprocess.run(
            [binary, "--noprofile", "--norc", "-c", "exec 2>/dev/null\n" + r["script"]],
            cwd=cwd,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=20,
        )
        if p.returncode < 0:
            raise SystemExit(f"measure-sites: Bash {name} was killed on {r['id']} (rc={p.returncode})")
        out[r["id"]] = {"out": p.stdout.decode("utf-8", "replace"), "rc": p.returncode}
    return out


def engine_column(label: str, tree: str, rows: list[dict], cwd: str, bun: str, runner: str, tmp: str) -> dict:
    cf, rf = os.path.join(tmp, f"{label}.cases.json"), os.path.join(tmp, f"{label}.res.jsonl")
    json.dump([{"id": r["id"], "script": r["script"]} for r in rows], open(cf, "w", encoding="utf-8"))
    if os.path.exists(rf):
        os.remove(rf)
    env = dict(os.environ)
    env.pop("PI_CONFIG_FILES", None)
    env.pop("PI_SHELL_PREFIX", None)
    env.update({"CASE_FILE": cf, "RESULT_FILE": rf, "CASE_CWD": cwd, "TMPDIR": tmp})
    p = subprocess.run([bun, runner, tree], env=env, cwd=cwd, stdin=subprocess.DEVNULL)
    if p.returncode != 0 or not os.path.exists(rf):
        raise SystemExit(f"measure-sites: the {label} batch failed (rc={p.returncode}); build that tree's addon with bun run --cwd packages/natives build")
    got = {}
    for line in open(rf, encoding="utf-8"):
        if line.strip():
            d = json.loads(line)
            if d.get("error") or d.get("timedOut") or not isinstance(d.get("out"), str) or type(d.get("rc")) is not int:
                raise SystemExit(f"measure-sites: the {label} batch has no usable result for {d.get('id')}: {d}")
            got[d["id"]] = d
    missing = [r["id"] for r in rows if r["id"] not in got]
    if missing:
        raise SystemExit(f"measure-sites: the {label} batch returned {len(missing)} fewer rows")
    return got


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("sites", help="JSON written by gen-sites.py")
    parser.add_argument("output", help="measured rows JSON")
    parser.add_argument("--main-tree", required=True, help="repository root for the live baseline addon column")
    parser.add_argument("--head-tree", default=str(Path(__file__).resolve().parents[4]), help="repository root for the live head addon column (default: this repository)")
    parser.add_argument("--bash-52", default="bash", help="Bash 5.2.21 executable (default: bash on PATH)")
    parser.add_argument("--bash-53", required=True, help="Bash 5.3.0 executable")
    parser.add_argument("--bun", default="bun", help="Bun executable (default: bun on PATH)")
    parser.add_argument("--runner", default=str(Path(__file__).with_name("run-batch.ts")), help="batch runner (default: run-batch.ts beside this script)")
    parser.add_argument("--tmp", help="scratch parent directory (default: Python's temporary directory, honoring TMPDIR)")
    parser.add_argument(
        "--extra-tree",
        action="append",
        default=[],
        metavar="LABEL=TREE",
        help="another repository root to measure as its own column, e.g. an earlier head; repeatable",
    )
    args = parser.parse_args()
    fixture = json.load(open(args.sites, encoding="utf-8"))
    rows = fixture["rows"]
    if not rows:
        raise SystemExit("measure-sites: the generated matrix has no rows")
    bashes = {"5.2": executable(args.bash_52, "--bash-52"), "5.3": executable(args.bash_53, "--bash-53")}
    for name, version in (("5.2", "5.2.21"), ("5.3", "5.3.0")):
        bash_version(bashes[name], version)
    bun = executable(args.bun, "--bun")
    subprocess.run([bun, "--version"], check=True, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, timeout=20)
    runner = os.path.abspath(args.runner)
    if not os.path.isfile(runner):
        raise SystemExit(f"measure-sites: the batch runner is missing: {runner}")
    trees = {"main": os.path.realpath(args.main_tree), "head": os.path.realpath(args.head_tree)}
    for spec in args.extra_tree:
        label, _, path = spec.partition("=")
        if not label or not path or label in trees:
            raise SystemExit(f"measure-sites: --extra-tree wants a fresh LABEL=TREE, got {spec!r}")
        trees[label] = os.path.realpath(path)
    for label, tree in trees.items():
        for leaf in ("index.js", "loader-state.js"):
            module = os.path.join(tree, "packages/natives/native", leaf)
            if not os.path.isfile(module):
                raise SystemExit(f"measure-sites: the {label} tree's native entry point is missing: {module}")
    if args.tmp:
        os.makedirs(args.tmp, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="fatal-site-matrix-", dir=args.tmp) as scratch:
        tmp = os.path.abspath(scratch)
        cols = {}
        for label, tree in trees.items():
            cwd = os.path.join(tmp, f"cwd-{label}")
            os.makedirs(cwd, exist_ok=True)
            cols[label] = engine_column(label, tree, rows, cwd, bun, runner, tmp)
            print(f"{label}: {len(cols[label])} rows", flush=True)
        for name, binary in bashes.items():
            cwd = os.path.join(tmp, f"cwd-bash{name}")
            os.makedirs(cwd, exist_ok=True)
            cols[name] = bash_column(name, binary, rows, cwd)
            print(f"bash {name}: {len(cols[name])} rows", flush=True)

    merged = []
    for r in rows:
        m = dict(r)
        for label in ("5.2", "5.3", *trees):
            c = cols[label][r["id"]]
            m[label] = {"out": c.get("out"), "rc": c.get("rc")}
        merged.append(m)
    json.dump(merged, open(args.output, "w", encoding="utf-8"))

    def same(a: dict, b: dict) -> bool:
        return a["out"] == b["out"] and a["rc"] == b["rc"]

    bash_split = [m for m in merged if not same(m["5.2"], m["5.3"])]
    print(f"rows {len(merged)}; 5.2 != 5.3: {len(bash_split)}")
    # Both directions against the baseline, which is what a change to the
    # model has to answer for: a regression is a row the baseline gets right
    # and this column gets wrong, a gain is the other way round.
    for label in trees:
        if label == "main":
            continue
        wrong = [m for m in merged if not same(m[label], m["5.3"])]
        regressions = [m for m in merged if same(m["main"], m["5.3"]) and not same(m[label], m["5.3"])]
        gains = [m for m in merged if not same(m["main"], m["5.3"]) and same(m[label], m["5.3"])]
        print(
            f"{label}: != 5.3: {len(wrong)}; regressions over main: {len(regressions)}; "
            f"gains over main: {len(gains)}"
        )
        for m in regressions[:20]:
            print(f"  regression {m['id']}")
    print(f"main: != 5.3: {len([m for m in merged if not same(m['main'], m['5.3'])])}")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as error:
        raise SystemExit(f"measure-sites: {error}") from error
