#!/usr/bin/env python3
"""
Analyses over the session-stats sqlite tables (`ss_*`) populated by sync.py.

Subcommands:
  tools       — per-tool token totals (port of cmd_tools.rs)
  edits       — edit-tool reliability audit (port of cmd_edits.rs)
  followups   — five hashline-edit detectors (port of cmd_followups.rs)

Each subcommand reads from ~/.omp/stats.db. Run sync.py first.
"""

from __future__ import annotations

import argparse
import json
import re
import shlex
import sqlite3
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path

DB_PATH = Path.home() / ".omp" / "stats.db"


# --------------------------------------------------------------------------- #
# Shared helpers


def open_ro() -> sqlite3.Connection:
    if not DB_PATH.exists():
        sys.exit(f"db not found: {DB_PATH}. Run sync.py first.")
    conn = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def commas(n: int) -> str:
    return f"{n:,}"


def pct(part: int, total: int) -> float:
    return 0.0 if total == 0 else (100.0 * part / total)


def truncate_line(s: str, n: int) -> str:
    s = s.replace("\n", " | ")
    if len(s) <= n:
        return s
    return s[: n - 1] + "…"


def parse_bucket(spec: str) -> int:
    """`h`,`d`,`w`,`m`,`<N>h`,`<N>d`,`<N>w` -> seconds."""
    units = {"h": 3600, "d": 86400, "w": 604800, "m": 2592000}
    if spec in units:
        return units[spec]
    if spec[-1] in units and spec[:-1].isdigit():
        return int(spec[:-1]) * units[spec[-1]]
    if spec == "hour":
        return 3600
    if spec == "day":
        return 86400
    if spec == "week":
        return 604800
    raise ValueError(f"bad --by spec: {spec}")


def since_cutoff_ms(args: argparse.Namespace) -> int | None:
    """Resolve --since spec (h/d/w/m/<N>{h,d,w}) to an epoch-ms cutoff, or None."""
    spec = getattr(args, "since", None)
    if not spec:
        return None
    return int(time.time() * 1000) - parse_bucket(spec) * 1000


def percentile(values: list[int], p: float) -> float:
    if not values:
        return 0.0
    s = sorted(values)
    k = (len(s) - 1) * (p / 100.0)
    lo, hi = int(k), min(int(k) + 1, len(s) - 1)
    if lo == hi:
        return float(s[lo])
    return s[lo] + (s[hi] - s[lo]) * (k - lo)


# --------------------------------------------------------------------------- #
# `tools` — per-tool token totals (cmd_tools.rs port)

TOOLS_AGGREGATE_SQL = """
WITH per_tool AS (
    SELECT
        c.tool_name,
        COUNT(*)                       AS calls,
        IFNULL(SUM(c.arg_tokens), 0)   AS arg_tok
    FROM ss_tool_calls c
    GROUP BY c.tool_name
),
per_tool_res AS (
    SELECT
        r.tool_name,
        COUNT(*)                       AS results,
        IFNULL(SUM(r.result_tokens),0) AS res_tok
    FROM ss_tool_results r
    GROUP BY r.tool_name
)
SELECT
    COALESCE(p.tool_name, q.tool_name) AS tool_name,
    IFNULL(p.calls, 0)                 AS calls,
    IFNULL(q.results, 0)               AS results,
    IFNULL(p.arg_tok, 0)               AS arg_tok,
    IFNULL(q.res_tok, 0)               AS res_tok
FROM per_tool p FULL OUTER JOIN per_tool_res q USING (tool_name)
ORDER BY (IFNULL(p.arg_tok, 0) + IFNULL(q.res_tok, 0)) DESC
"""

_SEPARATORS_RE = re.compile(r"(\|\||&&|\||;|`|\$\()")
_EXCLUDE_SET = {
    # Shell control and builtins that aren't typical external utilities
    "do",
    "done",
    "for",
    "if",
    "then",
    "else",
    "fi",
    "while",
    "break",
    "continue",
    "exit",
    "case",
    "esac",
    "select",
    "in",
    "elif",
    "function",
    "return",
    "local",
    "export",
    "readonly",
    "unset",
    "shift",
    "eval",
    "exec",
    "trap",
    "source",
    "alias",
    "unalias",
    # JS/TS/programming keywords that show up from inline scripts or eval
    "const",
    "let",
    "var",
    "import",
    "from",
    "await",
    "async",
    "class",
    "try",
    "catch",
    "throw",
    "new",
    "typeof",
    "instanceof",
    "null",
    "true",
    "false",
    "undefined",
    "console",
    "log",
    "require",
    "module",
    "exports",
    "def",
    # Punctuation/operators
    "+",
    "-",
    "*",
    "/",
    "=",
    "==",
    "===",
    "!=",
    "!==",
    "<",
    ">",
    "<=",
    ">=",
    "!",
    "&&",
    "||",
    ";",
    "&",
    "(",
    ")",
    "{",
    "}",
    "[",
    "]",
}


def _get_utils_optimized(cmd: str) -> list[str]:
    cmd = cmd.replace("\n", " ")
    parts = _SEPARATORS_RE.split(cmd)
    utils = []
    for part in parts:
        part = part.strip()
        if not part or part in ("||", "&&", "|", ";", "`", "$("):
            continue

        # Optimize: only use shlex if quotes are present
        if "'" in part or '"' in part:
            try:
                tokens = shlex.split(part)
            except Exception:
                tokens = part.split()
        else:
            tokens = part.split()

        for t in tokens:
            if "=" in t and not t.startswith("-"):
                continue
            if t in ("sudo", "nohup", "time", "exec", "env", "xargs", "set"):
                continue
            val = t.split("/")[-1]
            if val:
                val = val.strip("'\"()[]{}")
                if val.lower() in _EXCLUDE_SET:
                    continue
                if re.match(r"^[a-zA-Z0-9_\-\.\+]+$", val):
                    if val.isdigit() or val == ".":
                        continue
                    utils.append(val)
                break
    return utils


def cmd_tools(args: argparse.Namespace) -> int:
    conn = open_ro()
    where_session, where_args = _session_filter_clause(conn, args)

    cutoff = since_cutoff_ms(args)

    def with_session(table_alias: str) -> tuple[str, tuple]:
        """Combined session-file + since-timestamp scope for an alias, or ('', ())."""
        parts: list[str] = []
        params: list = []
        if where_args:
            ph = ",".join("?" * len(where_args))
            parts.append(f"AND {table_alias}.session_file IN ({ph})")
            params.extend(where_args)
        if cutoff is not None:
            parts.append(f"AND {table_alias}.timestamp >= ?")
            params.append(cutoff)
        return " ".join(parts), tuple(params)

    sf_clause_c, sf_params_c = with_session("c")
    sf_clause_r, sf_params_r = with_session("r")
    sf_clause_a, sf_params_a = with_session("a")
    sf_clause_u, sf_params_u = with_session("u")

    # Grand totals (each subquery applies its own session filter).
    grand = conn.execute(
        f"""
        SELECT
          (SELECT IFNULL(SUM(c.arg_tokens),0)      FROM ss_tool_calls     c WHERE 1=1 {sf_clause_c}) AS tool_args,
          (SELECT IFNULL(SUM(r.result_tokens),0)   FROM ss_tool_results   r WHERE 1=1 {sf_clause_r}) AS tool_res,
          (SELECT IFNULL(SUM(a.thinking_tokens),0) FROM ss_assistant_msgs a WHERE 1=1 {sf_clause_a}) AS thinking,
          (SELECT IFNULL(SUM(a.text_tokens),0)     FROM ss_assistant_msgs a WHERE 1=1 {sf_clause_a}) AS asst_text,
          (SELECT IFNULL(SUM(u.text_tokens),0)     FROM ss_user_msgs      u WHERE 1=1 {sf_clause_u}) AS user_text,
          (SELECT COUNT(*)                         FROM ss_tool_calls     c WHERE 1=1 {sf_clause_c}) AS n_calls,
          (SELECT COUNT(*)                         FROM ss_tool_results   r WHERE 1=1 {sf_clause_r}) AS n_results
        """,
        sf_params_c
        + sf_params_r
        + sf_params_a
        + sf_params_a
        + sf_params_u
        + sf_params_c
        + sf_params_r,
    ).fetchone()
    if cutoff is None:
        n_sessions = conn.execute(
            f"SELECT COUNT(*) FROM ss_sessions {where_session}", where_args
        ).fetchone()[0]
    else:
        sc, sp = with_session("c")
        n_sessions = conn.execute(
            f"SELECT COUNT(DISTINCT c.session_file) FROM ss_tool_calls c WHERE 1=1 {sc}",
            sp,
        ).fetchone()[0]
    g = grand

    grand_total = (
        g["tool_args"] + g["tool_res"] + g["thinking"] + g["asst_text"] + g["user_text"]
    )
    print("=== grand totals ===")
    print(f"sessions:               {commas(n_sessions)}")
    print(f"tool calls / results:   {commas(g['n_calls'])} / {commas(g['n_results'])}")
    print(
        f"tool ARGS tokens:       {commas(g['tool_args']):>14}  ({pct(g['tool_args'], grand_total):5.1f}%)"
    )
    print(
        f"tool RESULTS tokens:    {commas(g['tool_res']):>14}  ({pct(g['tool_res'], grand_total):5.1f}%)"
    )
    print(
        f"assistant THINKING:     {commas(g['thinking']):>14}  ({pct(g['thinking'], grand_total):5.1f}%)"
    )
    print(
        f"assistant TEXT:         {commas(g['asst_text']):>14}  ({pct(g['asst_text'], grand_total):5.1f}%)"
    )
    print(
        f"user TEXT:              {commas(g['user_text']):>14}  ({pct(g['user_text'], grand_total):5.1f}%)"
    )
    print(f"total:                  {commas(grand_total):>14}")

    # Per-tool table.
    rows = conn.execute(
        f"""
        WITH per_tool AS (
          SELECT c.tool_name, COUNT(*) AS calls, IFNULL(SUM(c.arg_tokens),0) AS arg_tok
          FROM ss_tool_calls c WHERE 1=1 {sf_clause_c}
          GROUP BY c.tool_name
        ),
        per_tool_res AS (
          SELECT r.tool_name, COUNT(*) AS results, IFNULL(SUM(r.result_tokens),0) AS res_tok
          FROM ss_tool_results r WHERE 1=1 {sf_clause_r}
          GROUP BY r.tool_name
        )
        SELECT
          COALESCE(p.tool_name, q.tool_name) AS tool_name,
          IFNULL(p.calls,0) AS calls, IFNULL(q.results,0) AS results,
          IFNULL(p.arg_tok,0) AS arg_tok, IFNULL(q.res_tok,0) AS res_tok
        FROM per_tool p FULL OUTER JOIN per_tool_res q USING (tool_name)
        ORDER BY (IFNULL(p.arg_tok,0) + IFNULL(q.res_tok,0)) DESC
        """,
        sf_params_c + sf_params_r,
    ).fetchall()

    print("\n=== per-tool tokens ===")
    print(f"{'tool':<24} {'calls':>7} {'args':>14} {'results':>14} {'total':>14}")
    print("-" * 78)
    for r in rows:
        total = r["arg_tok"] + r["res_tok"]
        print(
            f"{r['tool_name']:<24} {r['calls']:>7} "
            f"{commas(r['arg_tok']):>14} {commas(r['res_tok']):>14} {commas(total):>14}"
        )

    # Print most common bash commands
    bash_tools = (
        "bash",
        "uu_run",
        "gnu_run",
        "zshell_PLZ_DONT_PIPE",
        "zshell",
        "shell",
        "run_command",
    )
    bash_placeholders = ",".join("?" * len(bash_tools))
    bash_calls = conn.execute(
        f"""
        SELECT c.arg_json
        FROM ss_tool_calls c
        WHERE c.tool_name IN ({bash_placeholders}) {sf_clause_c}
        """,
        bash_tools + sf_params_c,
    ).fetchall()

    if bash_calls:
        bash_counter = Counter()
        for r in bash_calls:
            arg_json = r["arg_json"]
            if not arg_json:
                continue
            try:
                obj = json.loads(arg_json)
                cmd = obj.get("command") or obj.get("cmd")
                if cmd:
                    for u in _get_utils_optimized(cmd):
                        bash_counter[u] += 1
            except Exception:
                pass

        if bash_counter:
            print("\n=== common bash commands ===")
            print(f"{'command':<24} {'calls':>10}")
            print("-" * 35)
            for u, count in bash_counter.most_common(20):
                print(f"{u:<24} {commas(count):>10}")

    if args.by:
        bucket = parse_bucket(args.by)
        _print_buckets(conn, bucket, args.top, args.tool, cutoff)

    return 0


def _session_filter_clause(conn, args) -> tuple[str, tuple]:
    """Builds an optional WHERE clause for session_file filtering by --limit / --folder."""
    clauses, params = [], []
    if args.folder:
        clauses.append("folder LIKE ?")
        params.append(f"%{args.folder}%")
    if args.limit > 0:
        # Resolve to a concrete session_file IN (...) so other tables can reuse it.
        rows = conn.execute(
            f"""
            SELECT session_file FROM ss_sessions
            {("WHERE " + " AND ".join(clauses)) if clauses else ""}
            ORDER BY mtime DESC LIMIT ?
            """,
            (*params, args.limit),
        ).fetchall()
        files = [r[0] for r in rows]
        if not files:
            return ("WHERE 0", ())
        placeholders = ",".join("?" * len(files))
        return (f"WHERE session_file IN ({placeholders})", tuple(files))
    if clauses:
        return ("WHERE " + " AND ".join(clauses), tuple(params))
    return ("", ())


def _print_buckets(
    conn, bucket_secs: int, top: int, tool_filter: str | None, cutoff: int | None = None
) -> None:
    conds: list[str] = []
    params: list = []
    if tool_filter:
        conds.append("c.tool_name = ?")
        params.append(tool_filter)
    if cutoff is not None:
        conds.append("c.timestamp >= ?")
        params.append(cutoff)
    where = ("WHERE " + " AND ".join(conds)) if conds else ""
    rows = conn.execute(
        f"""
        SELECT
          (c.timestamp / 1000 / ?) * ? AS bucket,
          c.tool_name,
          COUNT(*)                                 AS calls,
          IFNULL(SUM(c.arg_tokens), 0)             AS arg_tok,
          IFNULL(SUM(r.result_tokens), 0)          AS res_tok
        FROM ss_tool_calls c
        LEFT JOIN ss_tool_results r
          ON r.session_file = c.session_file AND r.call_id = c.call_id
        {where}
        GROUP BY bucket, c.tool_name
        ORDER BY bucket DESC
        """,
        (bucket_secs, bucket_secs, *params),
    ).fetchall()

    by_bucket: dict[int, list[sqlite3.Row]] = defaultdict(list)
    for r in rows:
        by_bucket[r["bucket"]].append(r)

    print(
        f"\n=== per-tool tokens, bucketed by {bucket_secs}s "
        f"({'all tools' if not tool_filter else tool_filter}) ==="
    )
    for bucket in sorted(by_bucket.keys(), reverse=True)[:20]:
        from datetime import datetime, timezone

        label = datetime.fromtimestamp(bucket, tz=timezone.utc).strftime(
            "%Y-%m-%d %H:%MZ"
        )
        print(f"\n[{label}]")
        ranked = sorted(by_bucket[bucket], key=lambda r: -(r["arg_tok"] + r["res_tok"]))
        for r in ranked[:top]:
            tot = r["arg_tok"] + r["res_tok"]
            print(
                f"  {r['tool_name']:<22} {r['calls']:>5}c "
                f"args={commas(r['arg_tok']):>12} res={commas(r['res_tok']):>12} "
                f"tot={commas(tot):>12}"
            )


# --------------------------------------------------------------------------- #
# `edits` — edit-tool reliability audit (cmd_edits.rs port)

_RE_TRUNCATED = re.compile(r"\[Output truncated", re.I)
_RE_ABORTED = re.compile(
    r"Tool execution was aborted|Request was aborted|cancelled|canceled by user", re.I
)
_RE_SUCCESS = re.compile(
    r"^(Updated|Successfully (wrote|replaced|edited|deleted|inserted)|Replaced|"
    r"Applied|Deleted|Created|Wrote|edit applied|Edited|Inserted|OK\b)",
    re.I,
)
_RE_ANCHOR_STALE = re.compile(
    r"(Edit rejected:.*anchor[s]? do(es)? not match the current file|"
    r"Edit rejected:.*line[s]? .* changed since the last read|"
    r"line[s]? ha(s|ve) changed since last read|"
    r"hash #[0-9a-fA-F]+ is not from this session|is not from this session|"
    r"stale (hash|tag|snapshot))",
    re.I,
)
_RE_ANCHOR_MISSING = re.compile(
    r"anchor .* (not found|unknown|missing)|loc requires the full anchor", re.I
)
_RE_NO_ENCLOSING = re.compile(
    r"No enclosing .* block|could not resolve a syntactic block", re.I
)
_RE_PARSE_ERROR = re.compile(r"parse|syntax error|unbalanced|unexpected token", re.I)
_RE_SSR_NO_MATCH = re.compile(
    r"0 matches|no replacements|no match found|No replacements made|Failed to find expected lines",
    re.I,
)
_RE_FILE_NOT_READ = re.compile(
    r"must be read first|has not been read|not yet read", re.I
)
_RE_FILE_CHANGED = re.compile(
    r"file has been (modified|changed) externally|file changed between read and edit",
    re.I,
)
_RE_PERM_DENIED = re.compile(r"permission denied|not allowed", re.I)
_RE_GENERIC_REJECTED = re.compile(r"\b(rejected|failed|error|invalid)\b", re.I)
_RE_TAG_MISSING = re.compile(
    r"Missing hashline snapshot tag|from your latest read/search", re.I
)


def classify_edit_result(text: str, is_error: int | None = None) -> str:
    t = (text or "").strip()
    if not t:
        return "empty"
    first = t.split("\n", 1)[0]
    if _RE_TRUNCATED.search(first):
        return "truncated"
    if _RE_ABORTED.search(t):
        return "aborted"
    # The harness `is_error` flag is authoritative. The current edit format emits
    # a `¶PATH#TAG` / `[PATH#TAG]` diff header on success whose body can contain
    # words like "parser"/"error" that the text heuristics would otherwise misread.
    if is_error == 0:
        return "success"
    if is_error is None and (t[0] in "¶[" or _RE_SUCCESS.match(first)):
        return "success"
    if is_error == 1 and t[0] in "¶[":
        return "fail:other"
    if _RE_ANCHOR_STALE.search(t):
        return "fail:anchor-stale"
    if _RE_NO_ENCLOSING.search(t):
        return "fail:no-enclosing-block"
    if _RE_ANCHOR_MISSING.search(t):
        return "fail:anchor-missing"
    if _RE_TAG_MISSING.search(t):
        return "fail:missing-tag"
    if _RE_PARSE_ERROR.search(t):
        return "fail:parse"
    if _RE_SSR_NO_MATCH.search(t):
        return "fail:no-match"
    if _RE_FILE_NOT_READ.search(t):
        return "fail:file-not-read"
    if _RE_FILE_CHANGED.search(t):
        return "fail:file-changed"
    if _RE_PERM_DENIED.search(t):
        return "fail:perm"
    if is_error == 1 or _RE_GENERIC_REJECTED.search(first):
        return "fail:other"
    return "unknown"


_ANCHOR_BARE = re.compile(r"^[a-zA-Z]?[0-9]+[a-z]{2}$")


_LINE_LOCATOR = r"[1-9]\d*"
_RANGE_SEPARATOR = r"(?:\.=|-|\.|…|\s+)"
_RANGE_LOCATOR = rf"{_LINE_LOCATOR}(?:{_RANGE_SEPARATOR}{_LINE_LOCATOR})?"
_REGISTER = r"@[A-Za-z0-9_-]{1,64}"

# Current S3 headers. Match the whole row: prefix-only matching used to count
# recovered body text such as `replace this value` as an edit operation.
_HASHLINE_OP = re.compile(
    rf"""
    ^\s*(?:
        (?P<put>PUT)\s+
            (?:
                {_RANGE_LOCATOR}
                |{_LINE_LOCATOR}\*
                |[<>]\s*{_LINE_LOCATOR}\*?
                |>\s*\$
            )
            (?:\s+{_REGISTER})?\s*:?
        |(?P<cut>CUT)\s+(?:{_RANGE_LOCATOR}|{_LINE_LOCATOR}\*)(?:\s+{_REGISTER})?\s*:?
        |(?P<mv>MV)\s+\S(?:.*\S)?\s*
        |(?P<rem>REM)\s*
    )$
    """,
    re.I | re.X,
)

# Retain syntactically shaped pre-S3 rows so stored sessions remain useful for
# historical reporting. These labels intentionally remain historical rather
# than being folded into PUT/CUT.
_HISTORICAL_HASHLINE_OP = re.compile(
    rf"""
    ^\s*(?P<op>
        SWAP\.BLK|SWAP|XCHG\.BLK|XCHG|DEL\.BLK|DEL|CUT\.BLK
        |PASTE\.BLK\.POST|PASTE\.PRE|PASTE\.POST|PASTE\.HEAD|PASTE\.TAIL
        |INS\.BLK\.POST|INS\.PRE|INS\.POST|INS\.HEAD|INS\.TAIL
        |replace_block|replace\ block|replace
        |delete_block|delete\ block|delete
        |insert_after_block|insert\ after\ block|insert\ before|insert\ after
        |insert\ head|insert\ tail
    )
    (?:
        \s+(?:{_RANGE_LOCATOR}|{_LINE_LOCATOR}\.={_LINE_LOCATOR}|{_LINE_LOCATOR})
        \s*:?
    )?
    \s*$
    """,
    re.I | re.X,
)


_HASHLINE_OP_ALIASES = {
    "REPLACE BLOCK": "SWAP.BLK",
    "REPLACE_BLOCK": "SWAP.BLK",
    "REPLACE": "SWAP",
    "XCHG.BLK": "SWAP.BLK",
    "XCHG": "SWAP",
    "DELETE BLOCK": "DEL.BLK",
    "DELETE_BLOCK": "DEL.BLK",
    "DELETE": "DEL",
    "INSERT BEFORE": "INS.PRE",
    "INSERT AFTER": "INS.POST",
    "INSERT HEAD": "INS.HEAD",
    "INSERT TAIL": "INS.TAIL",
    "INSERT AFTER BLOCK": "INS.BLK.POST",
    "INSERT_AFTER_BLOCK": "INS.BLK.POST",
}


def _hashline_ops(inp: str) -> list[str]:
    """Op kinds in a hashline edit `input`, excluding body/recovery rows."""
    ops: list[str] = []
    for line in inp.splitlines():
        stripped = line.lstrip()
        if not stripped or stripped.startswith("+"):
            continue
        match = _HASHLINE_OP.fullmatch(line)
        if match:
            ops.append(next(name.upper() for name, value in match.groupdict().items() if value))
            continue
        match = _HISTORICAL_HASHLINE_OP.fullmatch(line)
        if match:
            op = match.group("op").upper()
            ops.append(_HASHLINE_OP_ALIASES.get(op, op))
    return ops


def _detect_edit_format(tool_name: str, args_obj: dict | None) -> str:
    if tool_name == "write":
        return "write"
    if tool_name == "ast_edit":
        return "ast_edit"
    if not isinstance(args_obj, dict):
        return "unknown"
    has = lambda k: k in args_obj  # noqa: E731
    if has("oldText") and has("newText"):
        return "oldText/newText"
    if has("old_text") and has("new_text"):
        return "old_text/new_text"
    if has("diff") and has("op"):
        return "diff+op"
    if has("diff") and has("operation"):
        return "diff+operation"
    if has("diff"):
        return "diff"
    if has("replace") or has("insert"):
        return "replace/insert"
    if has("input") and isinstance(args_obj.get("input"), str):
        return "hashline"
    edits = args_obj.get("edits")
    if isinstance(edits, list) and edits and isinstance(edits[0], dict):
        first = edits[0]
        fh = lambda k: k in first  # noqa: E731
        if fh("loc") and (fh("splice") or fh("pre") or fh("post") or fh("sed")):
            return "loc+splice/pre/post/sed"
        if fh("loc") and fh("content"):
            return "loc+content"
        if fh("set_line"):
            return "set_line"
        if fh("insert_after"):
            return "insert_after"
        if fh("op") and fh("pos") and fh("end") and fh("lines"):
            return "op+pos+end+lines"
        if fh("op") and fh("pos") and fh("lines"):
            return "op+pos+lines"
        if fh("op") and fh("sel") and fh("content"):
            return "op+sel+content"
        if fh("all") and (fh("new_text") or fh("old_text")):
            return "per-edit:old_text/new_text"
        return "edits[" + ",".join(sorted(first.keys())) + "]"
    return ",".join(sorted(args_obj.keys()))


def _loc_shape(loc: str) -> str:
    if not loc:
        return "empty"
    if loc == "$":
        return "$file"
    if ":" in loc and not loc.startswith("$"):
        rest = loc.rsplit(":", 1)[1]
    else:
        rest = loc
    if rest.startswith("(") and rest.endswith(")"):
        return "bracket-(body)"
    if rest.startswith("[") and rest.endswith("]"):
        return "bracket-[block]"
    if rest.startswith("(") or rest.startswith("["):
        return "bracket-tail"
    if rest.endswith(")") or rest.endswith("]"):
        return "bracket-head"
    if _ANCHOR_BARE.match(rest):
        return "bare-anchor"
    return "other"


def _classify_edit_args(
    tool_name: str, args_obj: dict | None
) -> tuple[str, list[str], list[str]]:
    """Returns (format, verbs, loc_shapes)."""
    fmt = _detect_edit_format(tool_name, args_obj)
    verbs: list[str] = []
    loc_shapes: list[str] = []
    if tool_name == "write":
        verbs.append("write")
    elif tool_name == "edit" and isinstance(args_obj, dict):
        inp = args_obj.get("input")
        if isinstance(inp, str):
            verbs.extend(_hashline_ops(inp))
        else:
            edits = args_obj.get("edits")
            if isinstance(edits, list):
                for op in edits:
                    if not isinstance(op, dict):
                        continue
                    loc_val = op.get("loc")
                    loc_shapes.append(
                        _loc_shape(loc_val if isinstance(loc_val, str) else "")
                    )
                    v: list[str] = []
                    if op.get("splice"):
                        v.append("splice")
                    if op.get("pre"):
                        v.append("pre")
                    if op.get("post"):
                        v.append("post")
                    if op.get("sed"):
                        v.append("sed")
                    if not v:
                        v.append("none")
                    verbs.append("+".join(v))
    return fmt, verbs, loc_shapes


def cmd_edits(args: argparse.Namespace) -> int:
    conn = open_ro()
    where_session, where_args = _session_filter_clause(conn, args)
    sf_clause = (
        "AND c.session_file IN (" + ",".join("?" * len(where_args)) + ")"
        if where_args
        else ""
    )
    cutoff = since_cutoff_ms(args)
    since_clause = "AND c.timestamp >= ?" if cutoff is not None else ""
    since_params = (cutoff,) if cutoff is not None else ()

    rows = conn.execute(
        f"""
        SELECT
          c.session_file, c.call_id, c.tool_name, c.arg_json, c.timestamp,
          r.result_text, r.is_error
        FROM ss_tool_calls c
        LEFT JOIN ss_tool_results r
          ON r.session_file = c.session_file AND r.call_id = c.call_id
        WHERE c.tool_name IN ('edit','ast_edit','write') {sf_clause} {since_clause}
        ORDER BY c.timestamp
        """,
        where_args + since_params,
    ).fetchall()

    if not rows:
        print("no edit-family tool calls found")
        return 0

    by_tool: Counter = Counter()
    by_format: Counter = Counter()
    status_by_tool: dict[str, Counter] = defaultdict(Counter)
    status_by_format: dict[str, Counter] = defaultdict(Counter)
    verb_count: Counter = Counter()
    loc_count: Counter = Counter()
    fails_by_verb: dict[str, Counter] = defaultdict(Counter)
    fails_by_loc: dict[str, Counter] = defaultdict(Counter)
    sessions = set()
    failed_samples: list[tuple[str, str, list[str], list[str], str]] = []

    for r in rows:
        sessions.add(r["session_file"])
        tool = r["tool_name"]
        try:
            args_obj = json.loads(r["arg_json"]) if r["arg_json"] else None
        except Exception:
            args_obj = None
        fmt, verbs, locs = _classify_edit_args(tool, args_obj)
        status = classify_edit_result(r["result_text"] or "", r["is_error"])

        by_tool[tool] += 1
        by_format[fmt] += 1
        status_by_tool[tool][status] += 1
        status_by_format[fmt][status] += 1
        for v in verbs:
            verb_count[v] += 1
            fails_by_verb[v][status] += 1
        for l in locs:
            loc_count[l] += 1
            fails_by_loc[l][status] += 1

        if status.startswith("fail") and len(failed_samples) < 8:
            text = r["result_text"] or ""
            first = text.split("\n\n", 1)[0]
            failed_samples.append(
                (tool, status, verbs, locs, truncate_line(first, 220))
            )

    print("# Edit-tool usage")
    print(f"\nTotal tool calls: {len(rows)} (across {len(sessions)} sessions)")

    _print_counter("\n## By tool", by_tool)
    print("\n## Outcome by tool")
    for tool in sorted(by_tool):
        print(f"\n  {tool} ({by_tool[tool]} calls):")
        for st, n in sorted(status_by_tool[tool].items(), key=lambda kv: -kv[1]):
            print(f"    {st:<28} {n}")

    _print_counter("\n## edit verb distribution (per sub-edit)", verb_count)
    _print_counter("\n## edit locator shape distribution", loc_count)

    print("\n## Failure rate per verb shape")
    for v, _ in verb_count.most_common():
        total, failed = _fail_totals(fails_by_verb[v])
        print(f"  {v:<20} {failed}/{total} failed ({pct(failed, total):.0f}%)")

    print("\n## Failure rate per locator shape")
    for l, _ in loc_count.most_common():
        total, failed = _fail_totals(fails_by_loc[l])
        print(f"  {l:<20} {failed}/{total} failed ({pct(failed, total):.0f}%)")

    _print_counter("\n## edit-tool argument-format usage", by_format)

    print("\n## Failure rate per argument format")
    for f, _ in by_format.most_common():
        total, failed = _fail_totals(status_by_format[f])
        print(f"  {f:<32} {failed:>6}/{total:<6} failed ({pct(failed, total):.0f}%)")

    print("\n## Failure breakdown per top format")
    for f, _ in by_format.most_common(8):
        print(f"\n  {f} ({by_format[f]} total)")
        for st, n in sorted(status_by_format[f].items(), key=lambda kv: -kv[1]):
            print(f"    {st:<28} {n}")

    print("\n## Sample failed edits")
    for tool, status, verbs, locs, snippet in failed_samples:
        print(f"\n— {tool} [{status}] verbs={verbs} loc={locs}\n  result: {snippet}")

    return 0


def _print_counter(header: str, c: Counter) -> None:
    print(header)
    for k, v in c.most_common():
        print(f"  {k:<32} {v}")


def _fail_totals(c: Counter) -> tuple[int, int]:
    total = sum(c.values())
    failed = sum(v for k, v in c.items() if k.startswith("fail"))
    return total, failed


# --------------------------------------------------------------------------- #
# `followups` — five hashline-edit detectors (cmd_followups.rs port)

_CLOSER_LINE_RE = re.compile(r"^\s*[\])}]+[;,]?\s*$")

_FIX_PATTERNS = [
    "remove-single-closer",
    "add-single-closer",
    "one-line-modify",
    "pure-delete-1",
    "pure-insert-1",
    "small-other",
]
_FIX_PRIORITY = {p: i for i, p in enumerate(_FIX_PATTERNS)}


def _classify_fix(deleted: int, payload_lines: list[str]) -> str:
    closer = len(payload_lines) == 1 and bool(_CLOSER_LINE_RE.match(payload_lines[0]))
    if deleted == 0 and closer:
        return "add-single-closer"
    if deleted == 1 and not payload_lines:
        return "remove-single-closer"
    if deleted == 0 and len(payload_lines) == 1:
        return "pure-insert-1"
    if deleted == 1 and len(payload_lines) == 1:
        return "one-line-modify"
    if deleted >= 1 and not payload_lines:
        return "pure-delete-1"
    return "small-other"


def cmd_followups(args: argparse.Namespace) -> int:
    conn = open_ro()
    where_session, where_args = _session_filter_clause(conn, args)
    sf_clause = (
        "AND c.session_file IN (" + ",".join("?" * len(where_args)) + ")"
        if where_args
        else ""
    )
    cutoff = since_cutoff_ms(args)
    since_clause = "AND c.timestamp >= ?" if cutoff is not None else ""
    since_params = (cutoff,) if cutoff is not None else ()

    # All edit calls + their sections, ordered per session.
    call_rows = conn.execute(
        f"""
        SELECT c.session_file, c.call_id, c.seq, c.timestamp, c.raw_input_len,
               c.success, c.warnings
        FROM ss_edit_calls c
        WHERE 1=1 {sf_clause} {since_clause}
        ORDER BY c.session_file, c.seq
        """,
        where_args + since_params,
    ).fetchall()

    section_rows = conn.execute(
        f"""
        SELECT s.session_file, s.call_id, s.seq, s.section_idx, s.target_file,
               s.op_count, s.deleted_lines, s.payload_count, s.change_size,
               s.min_line, s.max_line, s.payload_blocks,
               s.longest_repeat_len, s.longest_repeat_block_idx,
               s.longest_repeat_sample, s.dup_anchors
        FROM ss_edit_sections s
        JOIN ss_edit_calls c USING (session_file, call_id)
        WHERE 1=1 {sf_clause.replace("c.session_file", "s.session_file")} {since_clause}
        ORDER BY s.session_file, s.seq, s.section_idx
        """,
        where_args + since_params,
    ).fetchall()

    # Index sections by (session_file, call_id).
    sec_by_call: dict[tuple[str, str], list[sqlite3.Row]] = defaultdict(list)
    for s in section_rows:
        sec_by_call[(s["session_file"], s["call_id"])].append(s)

    # Build per-(session, target_file) ordered list of (call_meta, section).
    by_session_file: dict[tuple[str, str], list[tuple[sqlite3.Row, sqlite3.Row]]] = (
        defaultdict(list)
    )
    total_successful_edits = 0
    warning_hits: list[dict] = []
    payload_dups: list[dict] = []
    anchor_dups: list[dict] = []

    for c in call_rows:
        if c["success"] == 1:
            total_successful_edits += 1
            warns = json.loads(c["warnings"] or "[]")
            seen: list[str] = []
            for w in warns:
                if w not in seen:
                    seen.append(w)
            if seen:
                files_csv = ",".join(
                    s["target_file"]
                    for s in sec_by_call.get((c["session_file"], c["call_id"]), [])
                )
                for kind in seen:
                    warning_hits.append(
                        {
                            "session": c["session_file"],
                            "call_id": c["call_id"],
                            "kind": kind,
                            "files": files_csv,
                            "input_len": c["raw_input_len"],
                        }
                    )
        if c["success"] != 1:
            continue
        for s in sec_by_call.get((c["session_file"], c["call_id"]), []):
            by_session_file[(c["session_file"], s["target_file"])].append((c, s))
            # Payload self-dup
            if s["longest_repeat_len"] >= 4:
                payload_dups.append(
                    {
                        "session": c["session_file"],
                        "call_id": c["call_id"],
                        "file": s["target_file"],
                        "block_len": _block_len(s, s["longest_repeat_block_idx"]),
                        "repeat_len": s["longest_repeat_len"],
                        "sample": s["longest_repeat_sample"] or "",
                    }
                )
            # Anchor reuse
            try:
                dups = json.loads(s["dup_anchors"] or "[]")
            except Exception:
                dups = []
            for d in dups:
                anchor_dups.append(
                    {
                        "session": c["session_file"],
                        "call_id": c["call_id"],
                        "files": d[2] if len(d) > 2 else s["target_file"],
                        "anchor": d[0],
                        "count": d[1],
                    }
                )

    # (1) small-fix follow-ups + (3) same-locus re-edits.
    fix_hits: list[dict] = []
    locus_hits: list[dict] = []
    for (session, target), entries in by_session_file.items():
        for i in range(len(entries) - 1):
            ac, asec = entries[i]
            bc, bsec = entries[i + 1]
            if ac["call_id"] == bc["call_id"]:
                continue
            first_size = asec["change_size"]
            second_size = bsec["change_size"]
            gap = max(0, (bc["timestamp"] - ac["timestamp"]) // 1000)

            # (1) small fix on big edit
            if 0 < second_size <= args.max_fix and first_size > 2:
                pl = _flatten_payload(bsec)
                pattern = _classify_fix(bsec["deleted_lines"], pl)
                summary = _render_section_summary(bsec, pl)
                fix_hits.append(
                    {
                        "session": session,
                        "file": target,
                        "first_call_id": ac["call_id"],
                        "second_call_id": bc["call_id"],
                        "first_size": first_size,
                        "first_input_len": ac["raw_input_len"],
                        "second_size": second_size,
                        "pattern": pattern,
                        "second_summary": summary,
                        "gap_secs": gap,
                    }
                )

            # (3) same-locus re-edit (both > max-fix)
            if (
                first_size > 2
                and second_size > args.max_fix
                and asec["min_line"] is not None
                and asec["max_line"] is not None
                and bsec["min_line"] is not None
                and bsec["max_line"] is not None
            ):
                a_lo, a_hi = asec["min_line"], asec["max_line"]
                b_lo, b_hi = bsec["min_line"], bsec["max_line"]
                if max(a_lo, b_lo) <= min(a_hi, b_hi):
                    locus_hits.append(
                        {
                            "session": session,
                            "file": target,
                            "first_call_id": ac["call_id"],
                            "second_call_id": bc["call_id"],
                            "first_range": (a_lo, a_hi),
                            "second_range": (b_lo, b_hi),
                            "first_size": first_size,
                            "second_size": second_size,
                            "gap_secs": gap,
                        }
                    )

    if args.max_gap > 0:
        fix_hits = [h for h in fix_hits if h["gap_secs"] <= args.max_gap]
        locus_hits = [h for h in locus_hits if h["gap_secs"] <= args.max_gap]
    if args.pattern:
        fix_hits = [h for h in fix_hits if h["pattern"] == args.pattern]

    fix_hits.sort(
        key=lambda h: (_FIX_PRIORITY.get(h["pattern"], 99), -h["first_input_len"])
    )
    locus_hits.sort(key=lambda h: -h["first_size"])
    payload_dups = [p for p in payload_dups if p["repeat_len"] >= args.min_dup]
    payload_dups.sort(key=lambda p: -p["repeat_len"])
    anchor_dups.sort(key=lambda a: -a["count"])

    # ---- print ----
    by_pattern = Counter(h["pattern"] for h in fix_hits)

    print("=== heuristic followup hits ===")
    print(f"total hits: {commas(len(fix_hits))}")
    print("\nby pattern:")
    for label, n in by_pattern.most_common():
        print(f"  {label:<22} {n:>6}")

    shown = min(args.show, len(fix_hits))
    print(f"\n=== top {shown} hits (by first-edit input size) ===")
    for h in fix_hits[:shown]:
        print(
            f"[{h['pattern']}] {h['file']}  first={h['first_size']}L "
            f"({h['first_input_len']}B) → second={h['second_size']}L  gap={h['gap_secs']}s"
        )
        print(f"        session={h['session']}")
        print(
            f"        first_call={h['first_call_id']} second_call={h['second_call_id']}"
        )
        print(f"        fix: {h['second_summary']}")

    print("\n=== tool self-corrections ===")
    print(
        "(emitted as warnings on otherwise-successful edits — the tool caught what the model wrote)"
    )
    by_kind = Counter(w["kind"] for w in warning_hits)
    for kind, n in by_kind.most_common():
        suffix = (
            (
                f" ({pct(n, total_successful_edits):.2f}% of "
                f"{commas(total_successful_edits)} successful edits)"
            )
            if total_successful_edits
            else ""
        )
        print(f"  {kind:<16} {n:>6}{suffix}")

    warn_show = min(args.show, len(warning_hits))
    if warn_show:
        print(f"\n--- top {warn_show} self-correction examples (by input size) ---")
        sorted_warns = sorted(warning_hits, key=lambda w: -w["input_len"])
        for w in sorted_warns[:warn_show]:
            print(f"[{w['kind']}] {truncate_line(w['files'], 80)}  ({w['input_len']}B)")
            print(f"        session={w['session']} call={w['call_id']}")

    print("\n=== same-locus re-edits (overlapping anchor ranges, both > max-fix) ===")
    print(f"hits: {commas(len(locus_hits))}")
    locus_show = min(args.show, len(locus_hits))
    for h in locus_hits[:locus_show]:
        print(
            f"{h['file']}  first={h['first_range'][0]}..{h['first_range'][1]} "
            f"({h['first_size']}L) → second={h['second_range'][0]}..{h['second_range'][1]} "
            f"({h['second_size']}L)  gap={h['gap_secs']}s"
        )
        print(f"        session={h['session']}")
        print(
            f"        first_call={h['first_call_id']} second_call={h['second_call_id']}"
        )

    print(
        "\n=== payload self-duplication (model pasted same N-line chunk twice in one payload) ==="
    )
    print(
        f"hits with repeat_len >= {args.min_dup}: {commas(len(payload_dups))} "
        f"({pct(len(payload_dups), total_successful_edits):.2f}% of "
        f"{commas(total_successful_edits)} successful edits)"
    )
    for p in payload_dups[: args.show]:
        print(f"k={p['repeat_len']} block={p['block_len']}L  {p['file']}")
        print(f"        session={p['session']} call={p['call_id']}")
        print(f"        sample: {p['sample']}")

    print("\n=== same-anchor reused by multiple ops in one input ===")
    print(f"hits: {commas(len(anchor_dups))}")
    for a in anchor_dups[: args.show]:
        print(
            f"anchor {a['anchor']} referenced {a['count']}x  "
            f"files={truncate_line(a['files'], 80)}"
        )
        print(f"        session={a['session']} call={a['call_id']}")

    return 0


def _flatten_payload(section_row: sqlite3.Row) -> list[str]:
    try:
        blocks = json.loads(section_row["payload_blocks"] or "[]")
    except Exception:
        return []
    out: list[str] = []
    for b in blocks:
        out.extend(b)
    return out


def _block_len(section_row: sqlite3.Row, idx: int | None) -> int:
    if idx is None:
        return 0
    try:
        blocks = json.loads(section_row["payload_blocks"] or "[]")
    except Exception:
        return 0
    if 0 <= idx < len(blocks):
        return len(blocks[idx])
    return 0


def _render_section_summary(section_row: sqlite3.Row, payload_lines: list[str]) -> str:
    bits: list[str] = []
    deleted = section_row["deleted_lines"]
    if deleted > 0:
        bits.append(f"-{deleted}")
    if payload_lines:
        bits.append(f"+{len(payload_lines)}")
    out = " / ".join(bits)
    if payload_lines:
        out += f"  | {truncate_line(payload_lines[0], 80)}"
    return out


# --------------------------------------------------------------------------- #
# Entry point


def main() -> int:
    ap = argparse.ArgumentParser(description="session-stats analyses (sqlite-backed)")
    sub = ap.add_subparsers(dest="cmd", required=True)

    common = argparse.ArgumentParser(add_help=False)
    common.add_argument(
        "-n",
        "--limit",
        type=int,
        default=0,
        help="restrict to N most-recent sessions (0 = all)",
    )
    common.add_argument(
        "--folder",
        default=None,
        help="filter sessions whose folder contains this substring",
    )
    common.add_argument(
        "--since",
        default=None,
        help="only include calls newer than this window: h, d, w, m, or <N>{h,d,w}",
    )

    ap_tools = sub.add_parser("tools", parents=[common], help="per-tool token totals")
    ap_tools.add_argument(
        "--by", default=None, help="bucket per-call data: h, d, w, m, or <N>{h,d,w}"
    )
    ap_tools.add_argument("--top", type=int, default=10, help="top tools per bucket")
    ap_tools.add_argument(
        "--tool", default=None, help="restrict bucket view to one tool"
    )
    ap_tools.set_defaults(func=cmd_tools)

    ap_edits = sub.add_parser("edits", parents=[common], help="edit reliability audit")
    ap_edits.set_defaults(func=cmd_edits)

    ap_fu = sub.add_parser(
        "followups", parents=[common], help="hashline edit followup detectors"
    )
    ap_fu.add_argument("--max-fix", type=int, default=2)
    ap_fu.add_argument(
        "--max-gap", type=int, default=0, help="cap seconds between paired edits"
    )
    ap_fu.add_argument(
        "--min-dup", type=int, default=8, help="min payload-dup repeat length"
    )
    ap_fu.add_argument(
        "--pattern", default=None, help="filter (1) to a single FixPattern"
    )
    ap_fu.add_argument("--show", type=int, default=60)
    ap_fu.set_defaults(func=cmd_followups)

    args = ap.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
