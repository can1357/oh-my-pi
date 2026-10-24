#!/usr/bin/env python3
"""Per-project PRISMA-ScR review store (SQLite, stdlib only).

One row per candidate record in `<project>/review.db`, with an explicit
PRISMA-ScR state machine:

    identified -> duplicate
               -> screened_excluded (reason)
               -> screened_included -> fulltext_sought -> fulltext_retrieved -> included
                                                       -> fulltext_not_retrieved (reason)
                                                       -> fulltext_excluded (reason)

Every transition is timestamped in a `history` table, so PRISMA counts are
DERIVED from record states, never hand-typed. Mutating subcommands print one
JSON line per affected record on stdout; human notes go to stderr.
"""
import argparse
import datetime
import json
import os
import re
import sqlite3
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import refs_io

PROJECTS_ROOT = os.path.expanduser("~/.research-harness/projects")
ACTIVE_FILE = os.path.expanduser("~/.research-harness/active-project")

STATES = (
    "identified",
    "duplicate",
    "screened_excluded",
    "screened_included",
    "fulltext_sought",
    "fulltext_retrieved",
    "fulltext_not_retrieved",
    "fulltext_excluded",
    "included",
)

# Sibling edges (excluded<->included, not_retrieved->retrieved) let a human
# overturn a verdict or record a copy found later; duplicate and included are
# otherwise terminal.
ALLOWED = {
    "identified": {"duplicate", "screened_excluded", "screened_included"},
    "duplicate": set(),
    "screened_excluded": {"screened_included"},
    "screened_included": {"screened_excluded", "fulltext_sought"},
    "fulltext_sought": {"fulltext_retrieved", "fulltext_not_retrieved", "fulltext_excluded"},
    "fulltext_not_retrieved": {"fulltext_retrieved"},
    "fulltext_retrieved": {"included", "fulltext_excluded"},
    "fulltext_excluded": {"included"},
    "included": set(),
}

SCHEMA = """
CREATE TABLE IF NOT EXISTS records (
  id TEXT PRIMARY KEY,
  import_key TEXT NOT NULL,
  source_db TEXT NOT NULL,
  title TEXT NOT NULL,
  authors TEXT,
  year INTEGER,
  venue TEXT,
  doi TEXT,
  url TEXT,
  abstract TEXT,
  state TEXT NOT NULL DEFAULT 'identified',
  ta_verdict TEXT,
  ta_rationale TEXT,
  ta_confidence TEXT,
  ft_verdict TEXT,
  ft_rationale TEXT,
  exclusion_reason TEXT,
  duplicate_of TEXT,
  pdf_path TEXT,
  oa_status TEXT,
  oa_source TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(source_db, import_key)
);
CREATE TABLE IF NOT EXISTS history (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  record_id TEXT NOT NULL,
  from_state TEXT,
  to_state TEXT NOT NULL,
  note TEXT,
  at TEXT NOT NULL
);
"""


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")


def norm_title(title):
    return re.sub(r"[^a-z0-9]", "", (title or "").lower())


def parse_confidence(value):
    """Confidence label per SCREENING.md: HIGH | MEDIUM | LOW (case-insensitive).
    A 0.0-1.0 float is accepted for backward compatibility and mapped to a label
    (>=0.8 HIGH, >=0.5 MEDIUM, else LOW); the label is the canonical form."""
    v = value.strip().upper()
    if v in ("HIGH", "MEDIUM", "LOW"):
        return v
    try:
        f = float(v)
    except ValueError:
        raise argparse.ArgumentTypeError(
            f"invalid confidence {value!r}: expected HIGH, MEDIUM or LOW"
            " (case-insensitive), or a 0.0-1.0 float"
        )
    if not 0.0 <= f <= 1.0:
        raise argparse.ArgumentTypeError(
            f"invalid confidence {value!r}: float form must be between 0.0 and 1.0"
        )
    return "HIGH" if f >= 0.8 else "MEDIUM" if f >= 0.5 else "LOW"


def project_dir(arg):
    """Resolve a project: explicit dir/slug, else RESEARCH_PROJECT_DIR, else active-project."""
    if arg:
        p = os.path.expanduser(arg)
        if os.path.isdir(p) or os.sep in arg:
            return p
        return os.path.join(PROJECTS_ROOT, arg)
    env = os.environ.get("RESEARCH_PROJECT_DIR")
    if env:
        return os.path.expanduser(env)
    try:
        with open(ACTIVE_FILE, encoding="utf-8") as fh:
            slug = fh.read().strip()
        if slug:
            return os.path.join(PROJECTS_ROOT, slug)
    except OSError:
        pass
    print("review: no project (pass --project, set RESEARCH_PROJECT_DIR, or write "
          "~/.research-harness/active-project)", file=sys.stderr)
    sys.exit(2)


def connect(pdir):
    os.makedirs(pdir, exist_ok=True)
    con = sqlite3.connect(os.path.join(pdir, "review.db"))
    con.row_factory = sqlite3.Row
    con.executescript(SCHEMA)
    return con


def get_record(con, rec_id):
    row = con.execute("SELECT * FROM records WHERE id = ?", (rec_id,)).fetchone()
    if not row:
        print(f"review: no record with id {rec_id!r}", file=sys.stderr)
        sys.exit(1)
    return row


def row_json(row):
    return json.dumps({k: row[k] for k in row.keys()}, ensure_ascii=False)


def transition(con, row, to_state, note=None, **fields):
    """Move a record to to_state (validating the edge) and set extra columns.
    A same-state call updates only the extra columns, without a history row."""
    from_state = row["state"]
    if to_state != from_state:
        if to_state not in ALLOWED[from_state]:
            print(f"review: illegal transition {from_state} -> {to_state} for {row['id']}",
                  file=sys.stderr)
            sys.exit(1)
        con.execute(
            "INSERT INTO history (record_id, from_state, to_state, note, at) VALUES (?,?,?,?,?)",
            (row["id"], from_state, to_state, note, now()),
        )
    sets, vals = ["state = ?", "updated_at = ?"], [to_state, now()]
    for col, val in fields.items():
        if val is not None:
            sets.append(f"{col} = ?")
            vals.append(val)
    vals.append(row["id"])
    con.execute(f"UPDATE records SET {', '.join(sets)} WHERE id = ?", vals)
    con.commit()
    return get_record(con, row["id"])


def hop(con, row, path, note=None, **fields):
    """Walk through intermediate states so a direct verdict still leaves an
    honest history trail (e.g. screened_included -> ... -> included)."""
    for i, state in enumerate(path):
        last = i == len(path) - 1
        row = transition(con, row, state, note=note, **(fields if last else {}))
    return row


# ---------------- subcommands ----------------


def iter_jsonl(path):
    """Yield records from a JSON-lines file in the shared record shape
    (e.g. /find output), same (record, error, label) contract as refs_io."""
    with open(path, encoding="utf-8") as fh:
        for i, line in enumerate(fh, 1):
            line = line.strip()
            if not line:
                continue
            label = f"JSONL line {i}"
            try:
                rec = json.loads(line)
            except ValueError as e:
                yield None, str(e), label
                continue
            if not rec.get("title"):
                yield None, "no title", label
                continue
            yield refs_io.make_record(
                title=rec.get("title"),
                # str or list; refs_io.norm_authors canonicalizes either.
                authors=rec.get("authors"),
                year=rec.get("year"),
                venue=rec.get("venue") or "",
                doi=rec.get("doi") or "",
                abstract=rec.get("abstract") or "",
                url=rec.get("url") or rec.get("pdf_url") or rec.get("oa_pdf_url") or "",
            ), None, label


def cmd_import(con, args):
    source_db = args.database or os.path.splitext(os.path.basename(args.path))[0]
    added = existing = skipped = 0
    reader = iter_jsonl if args.path.lower().endswith(".jsonl") else refs_io.iter_import
    try:
        for rec, err, label in reader(args.path):
            if err:
                skipped += 1
                print(f"review: skipped {label}: {err}", file=sys.stderr)
                continue
            key = rec["doi"] or "title:" + norm_title(rec["title"])
            if con.execute(
                "SELECT 1 FROM records WHERE source_db = ? AND import_key = ?",
                (source_db, key),
            ).fetchone():
                existing += 1
                continue
            rec_id = rec["doi"] or refs_io.slug(rec["title"])
            base, n = rec_id, 2
            while con.execute("SELECT 1 FROM records WHERE id = ?", (rec_id,)).fetchone():
                rec_id = f"{base}-{n}"
                n += 1
            ts = now()
            con.execute(
                "INSERT INTO records (id, import_key, source_db, title, authors, year, venue,"
                " doi, url, abstract, state, created_at, updated_at)"
                " VALUES (?,?,?,?,?,?,?,?,?,?, 'identified', ?, ?)",
                (rec_id, key, source_db, rec["title"], "; ".join(rec["authors"]),
                 rec["year"], rec["venue"], rec["doi"], rec["url"], rec["abstract"], ts, ts),
            )
            con.execute(
                "INSERT INTO history (record_id, from_state, to_state, note, at)"
                " VALUES (?, NULL, 'identified', ?, ?)",
                (rec_id, f"imported from {os.path.basename(args.path)}", ts),
            )
            added += 1
    except OSError as e:
        print(f"review: cannot read {args.path}: {e}", file=sys.stderr)
        sys.exit(1)
    con.commit()
    print(json.dumps({"source_db": source_db, "added": added,
                      "already_present": existing, "skipped": skipped}))


def cmd_dedupe(con, args):
    rows = con.execute(
        "SELECT rowid, * FROM records WHERE state != 'duplicate' ORDER BY rowid"
    ).fetchall()

    def rank(r):
        # Survivor preference: already progressed past identified, has a DOI,
        # has an abstract, earliest import.
        return (r["state"] == "identified", not r["doi"], not r["abstract"], r["rowid"])

    merges = []
    losers = set()

    def merge_groups(keyfn, via):
        groups = {}
        for r in rows:
            if r["id"] in losers:
                continue
            k = keyfn(r)
            if k:
                groups.setdefault(k, []).append(r)
        for group in groups.values():
            if len(group) < 2:
                continue
            group.sort(key=rank)
            survivor = group[0]
            for loser in group[1:]:
                if loser["state"] != "identified":
                    continue  # already screened elsewhere; never demote silently
                losers.add(loser["id"])
                merges.append((survivor, loser, via))

    merge_groups(lambda r: (r["doi"] or "").lower() or None, "doi")
    merge_groups(lambda r: norm_title(r["title"]) or None, "title")

    for survivor, loser, via in merges:
        transition(con, loser, "duplicate", note=f"duplicate of {survivor['id']} (by {via})",
                   duplicate_of=survivor["id"])
        # Carry missing fields onto the survivor so no metadata is lost.
        fills = {}
        for col in ("doi", "url", "abstract", "pdf_path"):
            if not survivor[col] and loser[col]:
                fills[col] = loser[col]
        if fills:
            transition(con, survivor, survivor["state"], **fills)
        print(json.dumps({"duplicate": loser["id"], "survivor": survivor["id"], "via": via}))
    print(f"review: {len(merges)} duplicate(s) marked", file=sys.stderr)


def cmd_verdict(con, args):
    row = get_record(con, args.id)
    v = args.verdict
    fields = {}
    if args.stage == "ta":
        if row["state"] not in ("identified", "screened_excluded", "screened_included"):
            print(f"review: record {row['id']} is past title/abstract stage "
                  f"(state {row['state']})", file=sys.stderr)
            sys.exit(1)
        fields = {"ta_verdict": v, "ta_rationale": args.rationale,
                  "ta_confidence": args.confidence}
        if v == "maybe":
            # Undecided: verdict recorded, state unchanged; resolve by re-running.
            row = transition(con, row, row["state"], **fields)
        elif v == "include":
            row = transition(con, row, "screened_included", note=args.rationale, **fields)
        else:
            fields["exclusion_reason"] = args.reason or args.rationale
            row = transition(con, row, "screened_excluded", note=args.rationale, **fields)
    else:  # ft
        if v == "maybe":
            print("review: 'maybe' is banned at the full-text stage (SCREENING.md)",
                  file=sys.stderr)
            sys.exit(1)
        fields = {"ft_verdict": v, "ft_rationale": args.rationale}
        target = "included" if v == "include" else "fulltext_excluded"
        if row["state"] == target and row["ft_verdict"] == v:
            pass  # idempotent re-apply
        elif row["state"] in ("fulltext_retrieved", "fulltext_excluded"):
            row = transition(con, row, target, note=args.rationale, **fields)
        elif row["state"] in ("screened_included", "fulltext_sought"):
            # Full text reviewed without an explicit retrieval step (e.g. local
            # PDF): record the implied hops so history stays honest.
            path = {"screened_included": ["fulltext_sought", "fulltext_retrieved", target],
                    "fulltext_sought": ["fulltext_retrieved", target]}[row["state"]]
            row = hop(con, row, path, note=args.rationale, **fields)
        else:
            print(f"review: record {row['id']} not at full-text stage (state {row['state']})",
                  file=sys.stderr)
            sys.exit(1)
        if v == "exclude":
            row = transition(con, row, row["state"],
                             exclusion_reason=args.reason or args.rationale)
    print(row_json(row))


def cmd_next(con, args):
    if args.stage == "ta":
        q = ("SELECT * FROM records WHERE state = 'identified' AND ta_verdict IS NULL"
             " ORDER BY rowid LIMIT ?")
    else:
        q = ("SELECT * FROM records WHERE state IN ('screened_included', 'fulltext_retrieved')"
             " AND ft_verdict IS NULL ORDER BY rowid LIMIT ?")
    for row in con.execute(q, (args.n,)):
        print(row_json(row))


def cmd_set_state(con, args):
    row = get_record(con, args.id)
    row = transition(
        con, row, args.state, note=args.note,
        exclusion_reason=args.reason, pdf_path=args.pdf_path,
        oa_status=args.oa_status, oa_source=args.oa_source,
    )
    print(row_json(row))


def cmd_get(con, args):
    print(row_json(get_record(con, args.id)))


def cmd_list(con, args):
    q, params = "SELECT * FROM records", ()
    if args.state:
        q += " WHERE state = ?"
        params = (args.state,)
    for row in con.execute(q + " ORDER BY rowid", params):
        print(row_json(row))


def counts(con):
    """State/source/verdict counts. The single source of truth for prisma_scr.py."""
    by_state = {s: 0 for s in STATES}
    for state, n in con.execute("SELECT state, COUNT(*) FROM records GROUP BY state"):
        by_state[state] = n
    by_source = dict(con.execute(
        "SELECT source_db, COUNT(*) FROM records GROUP BY source_db ORDER BY source_db"))

    def reasons(state):
        return dict(con.execute(
            "SELECT COALESCE(exclusion_reason, 'unspecified'), COUNT(*) FROM records"
            " WHERE state = ? GROUP BY 1 ORDER BY 2 DESC", (state,)))

    ta_maybe = con.execute(
        "SELECT COUNT(*) FROM records WHERE state = 'identified' AND ta_verdict = 'maybe'"
    ).fetchone()[0]
    return {
        "total": sum(by_state.values()),
        "by_state": by_state,
        "by_source": by_source,
        "ta_exclusion_reasons": reasons("screened_excluded"),
        "ft_exclusion_reasons": reasons("fulltext_excluded"),
        "not_retrieved_reasons": reasons("fulltext_not_retrieved"),
        "ta_maybe": ta_maybe,
    }


def cmd_stats(con, args):
    print(json.dumps(counts(con), ensure_ascii=False))


def main():
    ap = argparse.ArgumentParser(description="PRISMA-ScR review store (review.db).")
    ap.add_argument("--project", help="project slug under ~/.research-harness/projects/, or a directory")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("import", help="import a RIS/BibTeX/CSV file as identified records")
    p.add_argument("--path", required=True)
    p.add_argument("--database", help="source database name (default: file basename)")
    p.set_defaults(func=cmd_import)

    p = sub.add_parser("dedupe", help="mark duplicates by DOI, then normalized title")
    p.set_defaults(func=cmd_dedupe)

    p = sub.add_parser("verdict", help="record a screening verdict")
    p.add_argument("--id", required=True)
    p.add_argument("--stage", required=True, choices=["ta", "ft"])
    p.add_argument("--verdict", required=True, choices=["include", "exclude", "maybe"])
    p.add_argument("--rationale", required=True)
    p.add_argument("--confidence", type=parse_confidence,
                   help="HIGH | MEDIUM | LOW (case-insensitive); a 0.0-1.0 float is"
                        " accepted and mapped to a label")
    p.add_argument("--reason", help="primary exclusion reason (default: the rationale)")
    p.set_defaults(func=cmd_verdict)

    p = sub.add_parser("next", help="next unscreened records as JSON lines")
    p.add_argument("--stage", required=True, choices=["ta", "ft"])
    p.add_argument("--n", type=int, default=10)
    p.set_defaults(func=cmd_next)

    p = sub.add_parser("set-state", help="direct state transition (retrieval bookkeeping)")
    p.add_argument("--id", required=True)
    p.add_argument("--state", required=True, choices=list(STATES))
    p.add_argument("--note")
    p.add_argument("--reason")
    p.add_argument("--pdf-path")
    p.add_argument("--oa-status")
    p.add_argument("--oa-source")
    p.set_defaults(func=cmd_set_state)

    p = sub.add_parser("get", help="print one record as JSON")
    p.add_argument("--id", required=True)
    p.set_defaults(func=cmd_get)

    p = sub.add_parser("list", help="print records as JSON lines")
    p.add_argument("--state", choices=list(STATES))
    p.set_defaults(func=cmd_list)

    p = sub.add_parser("stats", help="state/source/verdict counts as one JSON object")
    p.set_defaults(func=cmd_stats)

    args = ap.parse_args()
    con = connect(project_dir(args.project))
    try:
        args.func(con, args)
    finally:
        con.close()


if __name__ == "__main__":
    main()
