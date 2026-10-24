#!/usr/bin/env python3
"""PRISMA count ledger: maintain prisma.json and print a flow summary.

Counts are SET, never added: re-running a subcommand overwrites the value.
Mutating subcommands rewrite prisma.json and print the updated ledger as one
JSON line. `show` prints a plain-text PRISMA flow block with derived
arithmetic, then the same numbers as one JSON line.
"""
import argparse
import datetime
import json
import os
import re
import sys

EMPTY = {
    "identified": {},
    "duplicates_removed": 0,
    "screened": None,
    "excluded": {},
    "included": None,
    "updated_at": None,
}


def ledger_path(project):
    return os.path.join(project, "prisma.json")


def load(project):
    path = ledger_path(project)
    if not os.path.exists(path):
        return dict(EMPTY, identified={}, excluded={})
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError) as e:
        print(f"prisma: cannot read {path}: {e}", file=sys.stderr)
        sys.exit(1)
    merged = dict(EMPTY, identified={}, excluded={})
    merged.update(data)
    return merged


def save(project, data):
    os.makedirs(project, exist_ok=True)
    data["updated_at"] = datetime.datetime.now(datetime.timezone.utc).isoformat(
        timespec="seconds"
    )
    with open(ledger_path(project), "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=2)
        fh.write("\n")
    print(json.dumps(data, ensure_ascii=False))


def norm_doi(doi):
    if not doi:
        return None
    d = re.sub(r"\s+", "", str(doi)).lower()
    d = re.sub(r"^https?://(dx\.)?doi\.org/", "", d)
    d = re.sub(r"^doi:", "", d)
    return d or None


def norm_title(title):
    return re.sub(r"[^a-z0-9]", "", (title or "").lower())


def dedupe_records(path):
    """Read JSONL records, keep first per normalized DOI/title. Returns (kept, dropped)."""
    kept, seen_doi, seen_title, dropped = [], set(), set(), 0
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except ValueError as e:
                print(f"prisma: skipped bad JSON line: {e}", file=sys.stderr)
                continue
            doi = norm_doi(rec.get("doi"))
            title = norm_title(rec.get("title"))
            if doi:
                if doi in seen_doi:
                    dropped += 1
                    continue
                seen_doi.add(doi)
            elif title:
                if title in seen_title:
                    dropped += 1
                    continue
                seen_title.add(title)
            kept.append(rec)
    return kept, dropped


def derive(data):
    total_identified = sum(data["identified"].values())
    screened = data["screened"]
    if screened is None:
        screened = total_identified - data["duplicates_removed"]
    total_excluded = sum(data["excluded"].values())
    return total_identified, screened, total_excluded


def cmd_show(project, _args):
    data = load(project)
    total_identified, screened, total_excluded = derive(data)
    included = data["included"]

    lines = ["PRISMA flow"]
    lines.append(f"  Records identified: {total_identified}")
    for db, n in sorted(data["identified"].items()):
        lines.append(f"    {db}: {n}")
    lines.append(f"  Duplicates removed: {data['duplicates_removed']}")
    lines.append(f"  -> Records screened: {screened}")
    lines.append(f"  Records excluded: {total_excluded}")
    for reason, n in sorted(data["excluded"].items()):
        lines.append(f"    {reason}: {n}")
    lines.append(f"  -> Studies included: {included if included is not None else 'not set'}")
    if included is not None and included + total_excluded != screened:
        lines.append(
            f"  WARNING: included ({included}) + excluded ({total_excluded}) "
            f"= {included + total_excluded}, but screened = {screened}"
        )
    print("\n".join(lines))
    print(json.dumps({
        "identified": total_identified,
        "duplicates_removed": data["duplicates_removed"],
        "screened": screened,
        "excluded": total_excluded,
        "included": included,
    }))


def main():
    ap = argparse.ArgumentParser(description="PRISMA count ledger (prisma.json).")
    ap.add_argument(
        "--project",
        default=os.environ.get("RESEARCH_PROJECT_DIR") or os.getcwd(),
        help="project dir holding prisma.json (default: RESEARCH_PROJECT_DIR env, else cwd)",
    )
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("identify", help="set a database's identified count")
    p.add_argument("--database", required=True)
    p.add_argument("--count", type=int, required=True)

    p = sub.add_parser("dedupe", help="set duplicates_removed, or dedupe a JSONL file")
    g = p.add_mutually_exclusive_group(required=True)
    g.add_argument("--count", "--removed", dest="count", type=int,
                   help="set duplicates_removed directly")
    g.add_argument("--path", "--records", dest="path",
                   help="JSONL file: print kept records, count dropped")

    p = sub.add_parser("exclude", help="set an exclusion reason's count")
    p.add_argument("--reason", required=True)
    p.add_argument("--count", type=int, required=True)

    p = sub.add_parser("include", help="set the included count")
    p.add_argument("--count", type=int, required=True)

    sub.add_parser("show", help="print PRISMA summary block + one JSON line")

    args = ap.parse_args()
    project = args.project

    if args.cmd == "show":
        cmd_show(project, args)
        return

    data = load(project)
    if args.cmd == "identify":
        data["identified"][args.database] = args.count
    elif args.cmd == "dedupe":
        if args.path is not None:
            try:
                kept, dropped = dedupe_records(args.path)
            except OSError as e:
                print(f"prisma: cannot read {args.path}: {e}", file=sys.stderr)
                sys.exit(1)
            for rec in kept:
                print(json.dumps(rec, ensure_ascii=False))
            data["duplicates_removed"] = dropped
        else:
            data["duplicates_removed"] = args.count
    elif args.cmd == "exclude":
        data["excluded"][args.reason] = args.count
    elif args.cmd == "include":
        data["included"] = args.count
    save(project, data)


if __name__ == "__main__":
    main()
