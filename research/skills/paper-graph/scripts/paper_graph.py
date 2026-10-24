#!/usr/bin/env python3
"""Second-brain paper graph: SQLite store with typed edges. One JSON object per line."""
import argparse
import json
import os
import sqlite3
import sys
import urllib.error
import urllib.parse
from collections import deque
from datetime import datetime, timezone

sys.path.insert(
    0,
    os.path.join(
        os.path.dirname(os.path.abspath(__file__)),
        "..", "..", "literature-search", "scripts",
    ),
)
import _http

UA = "research-harness/0.2 (personal research tool)"
EDGE_TYPES = ("cites", "related", "same-topic")

SCHEMA = """
CREATE TABLE IF NOT EXISTS papers (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT '',
    authors TEXT,
    year INTEGER,
    venue TEXT,
    doi TEXT,
    url TEXT,
    abstract TEXT,
    openalex_id TEXT,
    path TEXT,
    added_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS edges (
    src TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
    dst TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
    type TEXT NOT NULL CHECK(type IN ('cites','related','same-topic')),
    weight REAL,
    note TEXT,
    PRIMARY KEY (src, dst, type)
);
"""


def db_path():
    return os.environ.get(
        "PAPER_GRAPH_DB", os.path.expanduser("~/.research-harness/papers.db")
    )


def connect():
    path = db_path()
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.executescript(SCHEMA)
    # Migrate DBs created before openalex_id/path existed.
    cols = {r["name"] for r in conn.execute("PRAGMA table_info(papers)")}
    if "openalex_id" not in cols:
        conn.execute("ALTER TABLE papers ADD COLUMN openalex_id TEXT")
    if "path" not in cols:
        conn.execute("ALTER TABLE papers ADD COLUMN path TEXT")
    conn.commit()
    return conn


def emit(obj):
    print(json.dumps(obj, ensure_ascii=False))


def die(msg):
    print(f"paper_graph: {msg}", file=sys.stderr)
    sys.exit(1)


def now():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def paper_dict(row):
    return {k: row[k] for k in row.keys()}


def get_paper(conn, pid):
    return conn.execute("SELECT * FROM papers WHERE id = ?", (pid,)).fetchone()


def ensure_stub(conn, pid):
    conn.execute(
        "INSERT OR IGNORE INTO papers (id, title, added_at) VALUES (?, '', ?)",
        (pid, now()),
    )


def norm_doi(doi):
    if not doi:
        return None
    d = doi.strip().lower()
    for prefix in ("https://doi.org/", "http://doi.org/", "doi:"):
        if d.startswith(prefix):
            d = d[len(prefix):]
    return d or None


# ---------- subcommands ----------


def cmd_add(conn, args):
    conn.execute(
        """INSERT INTO papers (id, title, authors, year, venue, doi, url, abstract, path, added_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             title = excluded.title,
             authors = COALESCE(excluded.authors, authors),
             year = COALESCE(excluded.year, year),
             venue = COALESCE(excluded.venue, venue),
             doi = COALESCE(excluded.doi, doi),
             url = COALESCE(excluded.url, url),
             abstract = COALESCE(excluded.abstract, abstract),
             path = COALESCE(excluded.path, path)""",
        (
            args.id,
            args.title,
            args.authors,
            args.year,
            args.venue,
            args.doi,
            args.url,
            args.abstract,
            args.path,
            now(),
        ),
    )
    conn.commit()
    emit(paper_dict(get_paper(conn, args.id)))


def cmd_link(conn, args):
    ensure_stub(conn, args.src)
    ensure_stub(conn, args.dst)
    conn.execute(
        """INSERT INTO edges (src, dst, type, weight, note) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(src, dst, type) DO UPDATE SET
             weight = excluded.weight, note = excluded.note""",
        (args.src, args.dst, args.type, args.weight, args.note),
    )
    conn.commit()
    emit(
        {
            "linked": True,
            "src": args.src,
            "dst": args.dst,
            "type": args.type,
            "weight": args.weight,
            "note": args.note,
        }
    )


def cmd_remove(conn, args):
    if not get_paper(conn, args.id):
        die(f"no such paper: {args.id}")
    edges = conn.execute(
        "SELECT COUNT(*) AS n FROM edges WHERE src = ? OR dst = ?", (args.id, args.id)
    ).fetchone()["n"]
    conn.execute("DELETE FROM papers WHERE id = ?", (args.id,))
    conn.commit()
    emit({"removed": args.id, "edges_removed": edges})


def cmd_unlink(conn, args):
    if args.type:
        cur = conn.execute(
            "DELETE FROM edges WHERE src = ? AND dst = ? AND type = ?",
            (args.src, args.dst, args.type),
        )
    else:
        cur = conn.execute(
            "DELETE FROM edges WHERE src = ? AND dst = ?", (args.src, args.dst)
        )
    conn.commit()
    emit({"unlinked": cur.rowcount, "src": args.src, "dst": args.dst})


def cmd_get(conn, args):
    row = get_paper(conn, args.id)
    if not row:
        die(f"no such paper: {args.id}")
    emit(paper_dict(row))


def cmd_search(conn, args):
    like = f"%{args.query}%"
    rows = conn.execute(
        """SELECT * FROM papers
           WHERE title LIKE ? OR abstract LIKE ? OR authors LIKE ?
           ORDER BY added_at""",
        (like, like, like),
    ).fetchall()
    for row in rows:
        emit(paper_dict(row))


def cmd_neighbors(conn, args):
    if not get_paper(conn, args.id):
        die(f"no such paper: {args.id}")
    if args.type:
        rows = conn.execute("SELECT * FROM edges WHERE type = ?", (args.type,))
    else:
        rows = conn.execute("SELECT * FROM edges")
    adj = {}
    for e in rows:
        adj.setdefault(e["src"], []).append((e["dst"], e))
        adj.setdefault(e["dst"], []).append((e["src"], e))
    seen = {args.id}
    queue = deque([(args.id, 0)])
    while queue:
        node, depth = queue.popleft()
        if depth >= args.depth:
            continue
        for other, e in adj.get(node, []):
            if other in seen:
                continue
            seen.add(other)
            row = get_paper(conn, other)
            out = paper_dict(row) if row else {"id": other}
            out["_depth"] = depth + 1
            out["_via"] = {"src": e["src"], "dst": e["dst"], "type": e["type"]}
            emit(out)
            queue.append((other, depth + 1))


def cmd_stats(conn, args):
    papers = conn.execute("SELECT COUNT(*) AS n FROM papers").fetchone()["n"]
    by_type = {t: 0 for t in EDGE_TYPES}
    total = 0
    for row in conn.execute("SELECT type, COUNT(*) AS n FROM edges GROUP BY type"):
        by_type[row["type"]] = row["n"]
        total += row["n"]
    emit({"papers": papers, "edges": by_type, "total_edges": total})


# ---------- terminal view ----------


def _trunc(text, n):
    text = " ".join((text or "").split())
    return text if len(text) <= n else text[: n - 3] + "..."


def _load_graph(conn):
    papers = {r["id"]: r for r in conn.execute("SELECT * FROM papers")}
    edges = [dict(r) for r in conn.execute("SELECT * FROM edges ORDER BY type, src, dst")]
    adj = {}
    for e in edges:
        adj.setdefault(e["src"], []).append(e)
        adj.setdefault(e["dst"], []).append(e)
    return papers, edges, adj


def _node_line(pid, papers, adj):
    p = papers.get(pid)
    title = _trunc(p["title"], 58) if p is not None and p["title"] else "(no title)"
    year = f" ({p['year']})" if p is not None and p["year"] else ""
    return f"{pid}  {title}{year}  [deg {len(adj.get(pid, []))}]"


def _edge_tag(edge, node):
    """Edge label seen from `node`; cites is directional."""
    if edge["type"] == "cites":
        return "cites ->" if edge["src"] == node else "cited by"
    return edge["type"]


def _render_tree(node, papers, adj, seen, depth_left, prefix, lines):
    kids = []
    if depth_left > 0:
        for e in adj.get(node, []):
            other = e["dst"] if e["src"] == node else e["src"]
            if other in seen:
                continue
            seen.add(other)
            kids.append((other, e))
    for i, (other, e) in enumerate(kids):
        last = i == len(kids) - 1
        branch = "`-- " if last else "|-- "
        lines.append(f"{prefix}{branch}[{_edge_tag(e, node)}] {_node_line(other, papers, adj)}")
        _render_tree(other, papers, adj, seen, depth_left - 1,
                     prefix + ("    " if last else "|   "), lines)


def _view_text(papers, edges, adj, root=None, depth=None):
    lines = []
    by_type = {}
    for e in edges:
        by_type[e["type"]] = by_type.get(e["type"], 0) + 1
    counts = ", ".join(f"{n} {t}" for t, n in sorted(by_type.items())) or "no edges"
    lines.append(f"paper graph: {len(papers)} papers, {len(edges)} edges ({counts})")
    lines.append("")
    if root:
        depth = 2 if depth is None else depth
        seen = {root}
        lines.append(_node_line(root, papers, adj))
        _render_tree(root, papers, adj, seen, depth, "", lines)
        return lines, seen
    # Overview: one tree per component, highest-degree node first.
    depth = 1 if depth is None else depth
    order = sorted(papers, key=lambda pid: (-len(adj.get(pid, [])), pid))
    seen = set()
    isolated = []
    for pid in order:
        if pid in seen:
            continue
        if not adj.get(pid):
            isolated.append(pid)
            continue
        seen.add(pid)
        lines.append(_node_line(pid, papers, adj))
        _render_tree(pid, papers, adj, seen, depth, "", lines)
        lines.append("")
    if isolated:
        lines.append("isolated: " + ", ".join(isolated))
    while lines and not lines[-1]:
        lines.pop()
    return lines, seen | set(isolated)


def cmd_view(conn, args):
    papers, edges, adj = _load_graph(conn)
    if not papers:
        print("paper graph: empty (add papers first)")
        return
    if args.id and args.id not in papers:
        die(f"no such paper: {args.id}")
    lines, shown = _view_text(papers, edges, adj, root=args.id, depth=args.depth)
    if args.image:
        try:
            sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
            import graph_png

            if graph_png.kitty_available() and sys.stdout.isatty():
                sub_papers = {pid: papers[pid] for pid in shown if pid in papers}
                sub_edges = [e for e in edges if e["src"] in shown and e["dst"] in shown]
                idx = graph_png.emit_kitty(graph_png.render_png(sub_papers, sub_edges, adj))
                for i, pid in idx:
                    print(f"  {i:>3}  {_node_line(pid, papers, adj)}")
                return
        except Exception:
            pass  # any image failure falls back to the text view
    print("\n".join(lines))


# ---------- OpenAlex ----------


def openalex_get(path_or_url):
    url = path_or_url
    if not url.startswith("http"):
        url = "https://api.openalex.org" + url
    return json.loads(_http.fetch(url, UA, timeout=30))


def resolve_openalex(paper):
    """Resolve a local paper to an OpenAlex work: DOI first, else title search."""
    doi = norm_doi(paper["doi"])
    if doi:
        try:
            return openalex_get("/works/doi:" + urllib.parse.quote(doi))
        except urllib.error.HTTPError as e:
            if e.code != 404:
                raise
    title = paper["title"]
    if not title:
        return None
    data = openalex_get(
        "/works?" + urllib.parse.urlencode({"search": title, "per-page": 1})
    )
    results = data.get("results", [])
    return results[0] if results else None


def cmd_auto_edges(conn, args):
    paper = get_paper(conn, args.id)
    if not paper:
        die(f"no such paper: {args.id}")
    try:
        work = resolve_openalex(paper)
    except (urllib.error.URLError, OSError, ValueError) as e:
        die(f"OpenAlex request failed: {e}")
    if not work:
        die(f"could not resolve {args.id} on OpenAlex")
    work_id = work.get("id")
    if work_id and not paper["openalex_id"]:
        conn.execute(
            "UPDATE papers SET openalex_id = ? WHERE id = ?", (work_id, args.id)
        )
    refs = set(work.get("referenced_works") or [])

    # Map local papers to OpenAlex ids: stored id first, then batch DOI lookup.
    others = conn.execute(
        "SELECT * FROM papers WHERE id != ?", (args.id,)
    ).fetchall()
    oa_to_local = {}
    unresolved = []
    for p in others:
        if p["openalex_id"]:
            oa_to_local[p["openalex_id"]] = p["id"]
        elif norm_doi(p["doi"]):
            unresolved.append(p)
    for i in range(0, len(unresolved), 50):
        chunk = unresolved[i : i + 50]
        flt = "doi:" + "|".join(norm_doi(p["doi"]) for p in chunk)
        try:
            data = openalex_get(
                "/works?" + urllib.parse.urlencode({"filter": flt, "per-page": 50})
            )
        except (urllib.error.URLError, OSError, ValueError):
            continue
        by_doi = {
            norm_doi(w.get("doi")): w.get("id")
            for w in data.get("results", [])
            if w.get("doi") and w.get("id")
        }
        for p in chunk:
            oa_id = by_doi.get(norm_doi(p["doi"]))
            if oa_id:
                oa_to_local[oa_id] = p["id"]
                conn.execute(
                    "UPDATE papers SET openalex_id = ? WHERE id = ?", (oa_id, p["id"])
                )

    added = 0
    for oa_id, local_id in oa_to_local.items():
        if oa_id in refs:
            cur = conn.execute(
                """INSERT OR IGNORE INTO edges (src, dst, type, note)
                   VALUES (?, ?, 'cites', 'auto: openalex referenced_works')""",
                (args.id, local_id),
            )
            added += cur.rowcount
    conn.commit()
    emit(
        {
            "paper": args.id,
            "openalex_id": work_id,
            "references": len(refs),
            "local_matches": sum(1 for k in oa_to_local if k in refs),
            "edges_added": added,
        }
    )


def cmd_export(conn, args):
    if args.format == "html":
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        import graph_viz

        out = args.out or "paper-graph.html"
        graph_viz.render(db_path(), out)
        emit({"exported": out, "format": "html"})
        return
    data = {
        "papers": [paper_dict(r) for r in conn.execute("SELECT * FROM papers")],
        "edges": [paper_dict(r) for r in conn.execute("SELECT * FROM edges")],
    }
    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=1)
        emit({"exported": args.out, "format": "json"})
    else:
        emit(data)


def main():
    ap = argparse.ArgumentParser(
        description="Paper knowledge graph (SQLite). All output is JSON lines."
    )
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("add", help="upsert a paper")
    p.add_argument("--id", required=True)
    p.add_argument("--title", required=True)
    p.add_argument("--authors")
    p.add_argument("--year", type=int)
    p.add_argument("--venue")
    p.add_argument("--doi")
    p.add_argument("--url")
    p.add_argument("--abstract")
    p.add_argument("--path", help="local file path (local-corpus papers)")
    p.set_defaults(fn=cmd_add)

    p = sub.add_parser("link", help="add a typed edge (auto-creates stub nodes)")
    p.add_argument("src")
    p.add_argument("dst")
    p.add_argument("--type", required=True, choices=EDGE_TYPES)
    p.add_argument("--weight", type=float)
    p.add_argument("--note")
    p.set_defaults(fn=cmd_link)

    p = sub.add_parser("remove", help="delete a paper and its edges")
    p.add_argument("id")
    p.set_defaults(fn=cmd_remove)

    p = sub.add_parser("unlink", help="delete edge(s) between two papers")
    p.add_argument("src")
    p.add_argument("dst")
    p.add_argument("--type", choices=EDGE_TYPES)
    p.set_defaults(fn=cmd_unlink)

    p = sub.add_parser("get", help="print one paper")
    p.add_argument("id")
    p.set_defaults(fn=cmd_get)

    p = sub.add_parser("search", help="LIKE search over title/abstract/authors")
    p.add_argument("query")
    p.set_defaults(fn=cmd_search)

    p = sub.add_parser("neighbors", help="BFS neighbors")
    p.add_argument("id")
    p.add_argument("--type", choices=EDGE_TYPES)
    p.add_argument("--depth", type=int, default=1)
    p.set_defaults(fn=cmd_neighbors)

    p = sub.add_parser("stats", help="node/edge counts")
    p.set_defaults(fn=cmd_stats)

    p = sub.add_parser(
        "view", help="render the graph in the terminal (text; --image on Kitty-graphics terminals)"
    )
    p.add_argument("--id", help="center the view on this paper's neighborhood")
    p.add_argument("--depth", type=int, help="hops to show (default: 2 with --id, 1 overview)")
    p.add_argument("--image", action="store_true",
                   help="inline PNG when the terminal supports Kitty graphics; silent text fallback")
    p.set_defaults(fn=cmd_view)

    p = sub.add_parser(
        "auto-edges", help="add cites edges from OpenAlex referenced_works"
    )
    p.add_argument("id")
    p.set_defaults(fn=cmd_auto_edges)

    p = sub.add_parser("export", help="dump the graph")
    p.add_argument("--format", choices=("json", "html"), default="json")
    p.add_argument("--out")
    p.set_defaults(fn=cmd_export)

    args = ap.parse_args()
    conn = connect()
    try:
        args.fn(conn, args)
    finally:
        conn.close()


if __name__ == "__main__":
    main()
