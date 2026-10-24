#!/usr/bin/env python3
"""Import RIS/BibTeX/CSV references to JSON lines; export JSON-line records to RIS/BibTeX.

import: one JSON object per line on stdout in the shared record shape
(source "import"). Malformed entries are skipped with a stderr note, never a crash.
export: reads JSON-line records (--records file, stdin, or --from-graph SQLite)
and writes a .ris or .bib file.
"""
import argparse
import csv
import json
import os
import re
import sqlite3
import sys


def norm_ws(s):
    return re.sub(r"\s+", " ", s or "").strip()


def norm_doi(doi):
    """Normalize a DOI: lowercase, strip https://doi.org/ and doi: prefixes."""
    if not doi:
        return None
    d = norm_ws(doi).lower()
    d = re.sub(r"^https?://(dx\.)?doi\.org/", "", d)
    d = re.sub(r"^doi:\s*", "", d)
    return d or None


def slug(title, max_len=60):
    s = re.sub(r"[^a-z0-9]+", "-", (title or "").lower()).strip("-")
    return s[:max_len].rstrip("-") or "untitled"


def norm_authors(value):
    """Canonical author list from either a str or a list of str.

    A semicolon separates authors; a comma is part of "Surname, Given" and
    never a separator, so a semicolon-free string is ONE author. Never
    iterate a bare string as authors — that yields single characters.
    """
    if value is None:
        return []
    if isinstance(value, str):
        value = value.split(";")
    return [norm_ws(a) for a in value if norm_ws(a)]


def make_record(title, authors, year, venue, doi, abstract, url):
    doi = norm_doi(doi)
    return {
        "source": "import",
        "id": doi if doi else slug(title),
        "doi": doi,
        "title": norm_ws(title),
        "authors": norm_authors(authors),
        "year": year,
        "venue": norm_ws(venue) or None,
        "abstract": norm_ws(abstract),
        "url": norm_ws(url) or None,
    }


def parse_year(s):
    m = re.match(r"\s*(\d{4})", s or "")
    return int(m.group(1)) if m else None


# ---------------- RIS ----------------

RIS_TAG = re.compile(r"^([A-Z][A-Z0-9])  - ?(.*)$")


def parse_ris(text):
    """Yield (entry_dict, None) or (None, error_str) per RIS record."""
    fields, in_entry = {}, False
    for line in text.splitlines():
        m = RIS_TAG.match(line)
        if not m:
            continue
        tag, val = m.group(1), m.group(2).strip()
        if tag == "TY":
            if in_entry and fields:
                yield None, "RIS record missing ER terminator"
            fields, in_entry = {"TY": [val]}, True
        elif tag == "ER":
            if in_entry:
                yield fields, None
            fields, in_entry = {}, False
        elif in_entry:
            fields.setdefault(tag, []).append(val)
    if in_entry and fields:
        yield None, "RIS record missing ER terminator"


def ris_to_record(f):
    def first(*tags):
        for t in tags:
            if f.get(t):
                return f[t][0]
        return ""

    title = first("TI", "T1")
    if not title:
        raise ValueError("no title")
    return make_record(
        title=title,
        authors=f.get("AU", []) + f.get("A1", []),
        year=parse_year(first("PY", "Y1")),
        venue=first("JO", "JF", "T2"),
        doi=first("DO"),
        abstract=first("AB", "N2"),
        url=first("UR"),
    )


def export_ris(records, out):
    ris_type = {"article": "JOUR", "inproceedings": "CONF"}
    with open(out, "w", encoding="utf-8") as fh:
        for r in records:
            fh.write(f"TY  - {ris_type.get(r.get('type', ''), 'JOUR')}\n")
            fh.write(f"TI  - {r.get('title', '')}\n")
            for a in norm_authors(r.get("authors")):
                fh.write(f"AU  - {a}\n")
            if r.get("year"):
                fh.write(f"PY  - {r['year']}\n")
            if r.get("venue"):
                fh.write(f"JO  - {r['venue']}\n")
            if r.get("doi"):
                fh.write(f"DO  - {r['doi']}\n")
            if r.get("abstract"):
                fh.write(f"AB  - {r['abstract']}\n")
            if r.get("url"):
                fh.write(f"UR  - {r['url']}\n")
            fh.write("ER  - \n\n")


# ---------------- BibTeX ----------------

def _bib_entries(text):
    """Yield (entry_type, body) for each @type{...} block, brace-balanced."""
    for m in re.finditer(r"@(\w+)\s*\{", text):
        etype = m.group(1).lower()
        if etype in ("comment", "string", "preamble"):
            continue
        depth, i = 1, m.end()
        while i < len(text) and depth:
            if text[i] == "{":
                depth += 1
            elif text[i] == "}":
                depth -= 1
            i += 1
        yield etype, text[m.end():i - 1], depth != 0


def _bib_fields(body):
    """Parse 'key, field = value, ...' tolerantly. Returns dict of lowercased fields."""
    fields = {}
    # Drop the citation key (up to the first comma).
    i = body.find(",")
    i = 0 if i < 0 else i + 1
    n = len(body)
    while i < n:
        m = re.compile(r"\s*([\w.-]+)\s*=\s*").match(body, i)
        if not m:
            break
        name = m.group(1).lower()
        i = m.end()
        if i < n and body[i] == "{":
            depth, j = 1, i + 1
            while j < n and depth:
                if body[j] == "{":
                    depth += 1
                elif body[j] == "}":
                    depth -= 1
                j += 1
            val, i = body[i + 1:j - 1], j
        elif i < n and body[i] == '"':
            j = body.find('"', i + 1)
            j = n if j < 0 else j
            val, i = body[i + 1:j], j + 1
        else:
            m2 = re.compile(r"[^,]*").match(body, i)
            val, i = m2.group(0).strip(), m2.end()
        fields[name] = norm_ws(re.sub(r"[{}]", "", val))
        comma = body.find(",", i)
        if comma < 0:
            break
        i = comma + 1
    return fields


def bib_to_record(etype, fields):
    title = fields.get("title", "")
    if not title:
        raise ValueError("no title")
    if etype == "inproceedings":
        venue = fields.get("booktitle", "")
    else:
        venue = fields.get("journal", "")
    authors = re.split(r"\s+and\s+", fields.get("author", "")) if fields.get("author") else []
    return make_record(
        title=title,
        authors=authors,
        year=parse_year(fields.get("year", "")),
        venue=venue,
        doi=fields.get("doi", ""),
        abstract=fields.get("abstract", ""),
        url=fields.get("url", ""),
    )


def export_bib(records, out):
    with open(out, "w", encoding="utf-8") as fh:
        for r in records:
            rtype = r.get("type") or "article"
            if rtype not in ("article", "inproceedings", "misc"):
                rtype = "article"
            key = r.get("id") or slug(r.get("title", ""))
            key = re.sub(r"[^\w.-]", "-", str(key))
            fh.write(f"@{rtype}{{{key},\n")

            def field(name, val):
                if val:
                    fh.write(f"  {name} = {{{val}}},\n")

            field("title", r.get("title"))
            field("author", " and ".join(norm_authors(r.get("authors"))))
            field("year", r.get("year"))
            venue_field = "booktitle" if rtype == "inproceedings" else "journal"
            field(venue_field, r.get("venue"))
            field("doi", r.get("doi"))
            field("url", r.get("url"))
            field("abstract", r.get("abstract"))
            fh.write("}\n\n")


# ---------------- CSV ----------------

CSV_ALIASES = {
    "title": ("title", "article title", "document title"),
    "authors": ("authors", "author", "author full names"),
    "year": ("year", "publication year", "date"),
    "venue": ("venue", "journal", "source title", "publication"),
    "doi": ("doi",),
    "abstract": ("abstract",),
    "url": ("url", "link"),
}


def csv_rows_to_records(reader):
    """Yield (record, None) or (None, error) per CSV row. A bad row must not
    end the generator — raising from inside would drop every row after it."""
    header = {norm_ws(h).lower(): h for h in (reader.fieldnames or [])}

    def col(key):
        for alias in CSV_ALIASES[key]:
            if alias in header:
                return header[alias]
        return None

    cols = {k: col(k) for k in CSV_ALIASES}
    for row in reader:
        def get(k):
            c = cols[k]
            return (row.get(c) or "") if c else ""

        title = get("title")
        if not title:
            yield None, "no title"
            continue
        authors = re.split(r"\s*;\s*", get("authors")) if get("authors") else []
        if len(authors) == 1 and "," in authors[0] and authors[0].count(",") > 1:
            authors = re.split(r"\s*,\s*", authors[0])
        yield make_record(
            title=title,
            authors=authors,
            year=parse_year(get("year")),
            venue=get("venue"),
            doi=get("doi"),
            abstract=get("abstract"),
            url=get("url"),
        ), None


# ---------------- import driver ----------------

def sniff_format(path, text):
    ext = os.path.splitext(path)[1].lower()
    if ext == ".ris":
        return "ris"
    if ext in (".bib", ".bibtex"):
        return "bib"
    if ext == ".csv":
        return "csv"
    if re.search(r"^TY  -", text, re.MULTILINE):
        return "ris"
    if re.search(r"@\w+\{", text):
        return "bib"
    return "csv"


def iter_import(path):
    """Yield (record, None, label) or (None, error, label) per entry in a
    RIS/BibTeX/CSV file. Raises OSError when the file cannot be read."""
    with open(path, encoding="utf-8", errors="replace") as fh:
        text = fh.read()
    fmt = sniff_format(path, text)
    if fmt == "ris":
        for i, (fields, err) in enumerate(parse_ris(text), 1):
            label = f"RIS entry {i}"
            if err:
                yield None, err, label
                continue
            try:
                yield ris_to_record(fields), None, label
            except ValueError as e:
                yield None, str(e), label
    elif fmt == "bib":
        for i, (etype, body, unbalanced) in enumerate(_bib_entries(text), 1):
            label = f"BibTeX entry {i}"
            if unbalanced:
                yield None, "unbalanced braces", label
                continue
            try:
                yield bib_to_record(etype, _bib_fields(body)), None, label
            except ValueError as e:
                yield None, str(e), label
    else:
        reader = csv.DictReader(text.splitlines())
        for i, (rec, err) in enumerate(csv_rows_to_records(reader), 1):
            yield rec, err, f"CSV row {i}"


def cmd_import(args):
    imported = skipped = 0
    try:
        for rec, err, label in iter_import(args.path):
            if err:
                skipped += 1
                print(f"refs_io: skipped {label}: {err}", file=sys.stderr)
                continue
            print(json.dumps(rec, ensure_ascii=False))
            imported += 1
    except OSError as e:
        print(f"refs_io: cannot read {args.path}: {e}", file=sys.stderr)
        sys.exit(1)

    print(f"refs_io: imported {imported}, skipped {skipped}", file=sys.stderr)
    sys.exit(0)


# ---------------- export driver ----------------

def read_graph_records(db_path):
    con = sqlite3.connect(db_path)
    con.row_factory = sqlite3.Row
    try:
        rows = con.execute(
            "SELECT id, title, authors, year, venue, doi, url, abstract FROM papers"
        ).fetchall()
    finally:
        con.close()
    for row in rows:
        authors = norm_authors(row["authors"])
        yield {
            "source": "import",
            "id": row["id"],
            "doi": norm_doi(row["doi"]),
            "title": row["title"] or "",
            "authors": authors,
            "year": row["year"],
            "venue": row["venue"],
            "abstract": row["abstract"] or "",
            "url": row["url"],
        }


def cmd_export(args):
    if args.from_graph:
        db = args.db or os.environ.get("PAPER_GRAPH_DB") or os.path.expanduser(
            "~/.research-harness/papers.db"
        )
        try:
            records = list(read_graph_records(db))
        except sqlite3.Error as e:
            print(f"refs_io: cannot read paper-graph DB {db}: {e}", file=sys.stderr)
            sys.exit(1)
    else:
        if args.records:
            try:
                fh = open(args.records, encoding="utf-8")
            except OSError as e:
                print(f"refs_io: cannot read {args.records}: {e}", file=sys.stderr)
                sys.exit(1)
        else:
            fh = sys.stdin
        records = []
        with fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    records.append(json.loads(line))
                except ValueError as e:
                    print(f"refs_io: skipped bad JSON line: {e}", file=sys.stderr)

    if args.format == "ris":
        export_ris(records, args.out)
    else:
        export_bib(records, args.out)
    print(json.dumps({"exported": args.out, "format": args.format, "records": len(records)}))


def main():
    ap = argparse.ArgumentParser(description="Import/export reference files.")
    sub = ap.add_subparsers(dest="cmd", required=True)

    imp = sub.add_parser("import", help="RIS/BibTeX/CSV file to JSON lines on stdout")
    imp.add_argument("--path", required=True)
    imp.set_defaults(func=cmd_import)

    exp = sub.add_parser("export", help="JSON-line records to a .ris or .bib file")
    exp.add_argument("--format", required=True, choices=["ris", "bib"])
    exp.add_argument("--out", required=True)
    exp.add_argument("--records", help="JSONL file (default: stdin)")
    exp.add_argument("--from-graph", action="store_true", help="read paper-graph SQLite DB")
    exp.add_argument("--db", help="paper-graph DB path (else PAPER_GRAPH_DB env, else ~/.research-harness/papers.db)")
    exp.set_defaults(func=cmd_export)

    args = ap.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
