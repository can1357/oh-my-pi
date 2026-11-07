#!/usr/bin/env python3
"""Measure rows of the generated fatal-site matrix, one column per live source.

Every column comes from its own live source: each bash binary named with
`--bash LABEL=PATH` is run as `bash -c <script>` (which is what `Shell::run`
is), and each tree named with `--tree LABEL=PATH` is run through that tree's
own built addon by `run-fatal-sites-batch.ts`. A column is never inferred from
another: a missing tree, a missing addon or a failed batch ends the run
non-zero, and a batch that returns fewer rows than it was given is an error
rather than a silently short column.

    gen-fatal-sites.py <tree> sites.json
    emit-fatal-site-fixture.py --ids sites.json > ids.txt
    measure-fatal-sites.py sites.json measured.json --ids ids.txt \\
        --bash 5.2=/usr/bin/bash --bash 5.3=/path/to/bash-5.3.0 \\
        --tree main=/path/to/main-worktree
    emit-fatal-site-fixture.py sites.json measured.json \\
        crates/pi-shell/tests/fatal-site-matrix.json

usage: measure-fatal-sites.py <sites.json> <out.json> [--ids FILE]
                              [--bash LABEL=PATH]... [--tree LABEL=PATH]...
                              [--runner PATH] [--bun PATH] [--tmp DIR]
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile

ADDON = "packages/natives/native/pi_natives.linux-x64-modern.node"
HERE = os.path.dirname(os.path.abspath(__file__))


def pairs(values: list[str], what: str) -> dict[str, str]:
	out = {}
	for v in values:
		if "=" not in v:
			sys.exit(f"measure-fatal-sites: --{what} wants LABEL=PATH, got {v!r}")
		label, path = v.split("=", 1)
		out[label] = path
	return out


def bash_column(label: str, binary: str, rows: list[dict], cwd: str) -> dict:
	if not os.path.isfile(binary):
		sys.exit(f"measure-fatal-sites: the {label} bash binary is missing: {binary}")
	out = {}
	for r in rows:
		p = subprocess.run(
			[binary, "-c", r["script"]],
			cwd=cwd,
			stdin=subprocess.DEVNULL,
			stdout=subprocess.PIPE,
			stderr=subprocess.DEVNULL,
			timeout=30,
		)
		out[r["id"]] = {"out": p.stdout.decode("utf-8", "replace"), "rc": p.returncode}
	return out


def engine_column(label: str, tree: str, rows: list[dict], cwd: str, args) -> dict:
	addon = os.path.join(tree, ADDON)
	if not os.path.isdir(tree):
		sys.exit(f"measure-fatal-sites: the {label} tree is missing: {tree}")
	if not os.path.isfile(addon):
		sys.exit(
			f"measure-fatal-sites: the {label} tree has no built addon at {addon}; "
			"build it with `bun run build` in its packages/natives"
		)
	cf = os.path.join(args.tmp, f"{label}.cases.json")
	rf = os.path.join(args.tmp, f"{label}.results.jsonl")
	with open(cf, "w") as fh:
		json.dump([{"id": r["id"], "script": r["script"]} for r in rows], fh)
	if os.path.exists(rf):
		os.remove(rf)
	env = dict(os.environ)
	env.pop("PI_CONFIG_FILES", None)
	env.pop("PI_SHELL_PREFIX", None)
	env.update({"CASE_FILE": cf, "RESULT_FILE": rf, "CASE_CWD": cwd, "TMPDIR": args.tmp})
	p = subprocess.run(
		[args.bun, args.runner, os.path.abspath(tree)], env=env, cwd=cwd, stdin=subprocess.DEVNULL
	)
	if p.returncode != 0 or not os.path.exists(rf):
		sys.exit(f"measure-fatal-sites: the {label} batch failed (rc={p.returncode})")
	got = {}
	with open(rf) as fh:
		for line in fh:
			if line.strip():
				d = json.loads(line)
				got[d["id"]] = {"out": d.get("out", ""), "rc": d.get("rc"), **d}
	missing = [r["id"] for r in rows if r["id"] not in got]
	if missing:
		sys.exit(f"measure-fatal-sites: the {label} batch returned {len(missing)} fewer rows")
	return got


def main() -> None:
	ap = argparse.ArgumentParser()
	ap.add_argument("sites")
	ap.add_argument("out")
	ap.add_argument("--ids", help="file of row ids to measure, one per line (default: all)")
	ap.add_argument("--bash", action="append", default=[], metavar="LABEL=PATH")
	ap.add_argument("--tree", action="append", default=[], metavar="LABEL=PATH")
	ap.add_argument("--bun", default=shutil.which("bun") or "bun")
	ap.add_argument("--runner", default=os.path.join(HERE, "run-fatal-sites-batch.ts"))
	ap.add_argument("--tmp", default=None)
	args = ap.parse_args()

	bashes = pairs(args.bash, "bash")
	trees = pairs(args.tree, "tree")
	if not bashes and not trees:
		sys.exit("measure-fatal-sites: nothing to measure; give at least one --bash or --tree")

	fixture = json.load(open(args.sites))
	rows = fixture["rows"]
	if args.ids:
		wanted = {line.strip() for line in open(args.ids) if line.strip()}
		rows = [r for r in rows if r["id"] in wanted]
		absent = wanted - {r["id"] for r in rows}
		if absent:
			sys.exit(f"measure-fatal-sites: the matrix has no row {sorted(absent)[:5]}")

	owned_tmp = args.tmp is None
	args.tmp = args.tmp or tempfile.mkdtemp(prefix="fatal-sites-")
	os.makedirs(args.tmp, exist_ok=True)
	# Rows write and source script files; each pass gets its own directory so
	# one column's files never answer another's.
	try:
		columns = {}
		for label, binary in bashes.items():
			cwd = os.path.join(args.tmp, f"cwd-{label}")
			os.makedirs(cwd, exist_ok=True)
			columns[label] = bash_column(label, binary, rows, cwd)
		for label, tree in trees.items():
			cwd = os.path.join(args.tmp, f"cwd-{label}")
			os.makedirs(cwd, exist_ok=True)
			columns[label] = engine_column(label, tree, rows, cwd, args)
	finally:
		if owned_tmp:
			shutil.rmtree(args.tmp, ignore_errors=True)

	measured = [
		{
			"id": r["id"],
			"axes": r["axes"],
			"script": r["script"],
			**{label: columns[label][r["id"]] for label in columns},
		}
		for r in rows
	]
	with open(args.out, "w") as fh:
		json.dump(measured, fh, indent="\t")
	print(f"{len(measured)} rows x {len(columns)} columns: " + ", ".join(columns))


main()
