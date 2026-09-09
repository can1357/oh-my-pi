#!/usr/bin/env python3
"""
Sync ~/.omp/agent/sessions/**/*.jsonl into ~/.omp/stats.db (ss_* tables).

Incremental: per-file byte offset + mtime is tracked in ss_sessions. Only new
bytes are parsed on re-runs. Tokenization (o200k_base) and the hashline edit
parser/detectors are computed once and persisted, so analyses become pure SQL
plus tiny Python loops.

Schema (all tables prefixed `ss_` to avoid collision with packages/stats):

  ss_sessions         one row per .jsonl, carries sync state + metadata
  ss_tool_calls       one row per toolCall content block
  ss_tool_results     one row per toolResult message
  ss_assistant_msgs   one row per assistant message (text + thinking blobs)
  ss_user_msgs        one row per user message (text blob)
  ss_edit_calls       one row per edit toolCall (success + warnings paired in)
  ss_edit_sections    one row per ¶PATH section inside an edit toolCall, with
                      precomputed detector outputs (longest_repeat_*, dup_anchors)

Run:
  python3 scripts/session-stats/sync.py
  python3 scripts/session-stats/sync.py --workers 16 --full
  python3 scripts/session-stats/sync.py --limit 200       # newest 200 files
"""

from __future__ import annotations

import argparse
import json
import os
import queue
import re
import sqlite3
import sys
import threading
import time
from collections import defaultdict
from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from pathlib import Path

try:
    import tiktoken
except ImportError:
    sys.exit("tiktoken not installed. Run: pip install tiktoken")


# --------------------------------------------------------------------------- #
# Config

SESSIONS_ROOT = Path.home() / ".omp" / "agent" / "sessions"
DB_PATH = Path.home() / ".omp" / "stats.db"
TOKENIZER_NAME = "o200k_base"
SCHEMA_VERSION = 3
# Bump whenever parse_hashline_input / find_longest_repeat / duplicated_anchors
# / looks_successful / extract_warnings semantics change. Bump invalidates
# previously-stored ss_edit_* rows on next sync.
EDIT_PARSER_VERSION = 6

SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS ss_sessions (
    session_file    TEXT PRIMARY KEY,
    folder          TEXT NOT NULL,
    is_subagent     INTEGER NOT NULL DEFAULT 0,
    parent_session  TEXT,
    subagent_label  TEXT,
    started_at      INTEGER,
    title           TEXT,
    cwd             TEXT,
    session_uuid    TEXT,
    version         INTEGER,
    mtime           INTEGER NOT NULL,
    size            INTEGER NOT NULL,
    byte_offset     INTEGER NOT NULL DEFAULT 0,
    line_count      INTEGER NOT NULL DEFAULT 0,
    last_synced     INTEGER NOT NULL,
    tokenizer       TEXT NOT NULL,
    schema_version  INTEGER NOT NULL DEFAULT 1,
    parser_version  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS ss_tool_calls (
    id              INTEGER PRIMARY KEY,
    session_file    TEXT NOT NULL,
    seq             INTEGER NOT NULL,
    entry_id        TEXT,
    call_id         TEXT NOT NULL,
    tool_name       TEXT NOT NULL,
    raw_tool_name   TEXT NOT NULL,
    timestamp       INTEGER NOT NULL,
    model           TEXT,
    provider        TEXT,
    arg_json        TEXT,
    arg_tokens      INTEGER,
    UNIQUE(session_file, call_id, seq)
);
CREATE INDEX IF NOT EXISTS ss_tc_tool_ts   ON ss_tool_calls(tool_name, timestamp);
CREATE INDEX IF NOT EXISTS ss_tc_ts_tool   ON ss_tool_calls(timestamp, tool_name);
CREATE INDEX IF NOT EXISTS ss_tc_sess_seq  ON ss_tool_calls(session_file, seq);

CREATE TABLE IF NOT EXISTS ss_tool_results (
    id              INTEGER PRIMARY KEY,
    session_file    TEXT NOT NULL,
    seq             INTEGER NOT NULL,
    entry_id        TEXT,
    call_id         TEXT NOT NULL,
    tool_name       TEXT NOT NULL,
    raw_tool_name   TEXT NOT NULL,
    timestamp       INTEGER NOT NULL,
    result_text     TEXT,
    result_tokens   INTEGER,
    is_error        INTEGER NOT NULL DEFAULT 0,
    UNIQUE(session_file, call_id, seq)
);
CREATE INDEX IF NOT EXISTS ss_tr_tool_ts   ON ss_tool_results(tool_name, timestamp);
CREATE INDEX IF NOT EXISTS ss_tr_sess_seq  ON ss_tool_results(session_file, seq);
CREATE INDEX IF NOT EXISTS ss_tr_call_id   ON ss_tool_results(session_file, call_id);

CREATE TABLE IF NOT EXISTS ss_assistant_msgs (
    session_file    TEXT NOT NULL,
    seq             INTEGER NOT NULL,
    entry_id        TEXT,
    timestamp       INTEGER NOT NULL,
    model           TEXT,
    provider        TEXT,
    text_blob       TEXT,
    thinking_blob   TEXT,
    text_tokens     INTEGER NOT NULL DEFAULT 0,
    thinking_tokens INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (session_file, seq)
);

CREATE TABLE IF NOT EXISTS ss_user_msgs (
    session_file    TEXT NOT NULL,
    seq             INTEGER NOT NULL,
    entry_id        TEXT,
    timestamp       INTEGER NOT NULL,
    text_blob       TEXT,
    text_tokens     INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (session_file, seq)
);

CREATE TABLE IF NOT EXISTS ss_edit_calls (
    session_file    TEXT NOT NULL,
    call_id         TEXT NOT NULL,
    seq             INTEGER NOT NULL,
    timestamp       INTEGER NOT NULL,
    raw_input_len   INTEGER NOT NULL DEFAULT 0,
    success         INTEGER,                    -- nullable until result paired
    warnings        TEXT NOT NULL DEFAULT '[]', -- JSON list[str]
    parser_version  INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (session_file, call_id)
);
CREATE INDEX IF NOT EXISTS ss_ec_sess_seq ON ss_edit_calls(session_file, seq);
CREATE INDEX IF NOT EXISTS ss_ec_success  ON ss_edit_calls(success);

CREATE TABLE IF NOT EXISTS ss_edit_sections (
    id                       INTEGER PRIMARY KEY,
    session_file             TEXT NOT NULL,
    call_id                  TEXT NOT NULL,
    seq                      INTEGER NOT NULL,
    section_idx              INTEGER NOT NULL,
    target_file              TEXT NOT NULL,
    op_count                 INTEGER NOT NULL,
    deleted_lines            INTEGER NOT NULL,
    payload_count            INTEGER NOT NULL,
    change_size              INTEGER NOT NULL,
    min_line                 INTEGER,
    max_line                 INTEGER,
    payload_blocks           TEXT NOT NULL DEFAULT '[]', -- JSON list[list[str]]
    op_anchors               TEXT NOT NULL DEFAULT '[]', -- JSON list[str]
    longest_repeat_len       INTEGER NOT NULL DEFAULT 0,
    longest_repeat_block_idx INTEGER,
    longest_repeat_sample    TEXT,
    dup_anchors              TEXT NOT NULL DEFAULT '[]', -- JSON list[[anchor,count]]
    parser_version           INTEGER NOT NULL DEFAULT 1,
    UNIQUE(session_file, call_id, section_idx)
);
CREATE INDEX IF NOT EXISTS ss_es_target  ON ss_edit_sections(session_file, target_file, seq);
CREATE INDEX IF NOT EXISTS ss_es_repeat  ON ss_edit_sections(longest_repeat_len);
"""


def _migrate(conn: sqlite3.Connection) -> None:
    """Best-effort additive migrations for older databases."""
    cols = {r[1] for r in conn.execute("PRAGMA table_info(ss_sessions)").fetchall()}
    if "parser_version" not in cols:
        conn.execute(
            "ALTER TABLE ss_sessions ADD COLUMN parser_version INTEGER NOT NULL DEFAULT 0"
        )


# --------------------------------------------------------------------------- #
# Tokenizer (one per worker thread).

_tls = threading.local()


def get_encoder() -> "tiktoken.Encoding":
    enc = getattr(_tls, "enc", None)
    if enc is None:
        enc = tiktoken.get_encoding(TOKENIZER_NAME)
        _tls.enc = enc
    return enc


def count_tokens(s: str) -> int:
    if not s:
        return 0
    return len(get_encoder().encode_ordinary(s))


def batch_count_tokens(strings: list[str]) -> list[int]:
    """Tokenize many strings in one FFI call. Empty strings short-circuit."""
    if not strings:
        return []
    enc = get_encoder()
    nonempty_idx = [i for i, s in enumerate(strings) if s]
    if not nonempty_idx:
        return [0] * len(strings)
    nonempty = [strings[i] for i in nonempty_idx]
    encoded = enc.encode_ordinary_batch(nonempty, num_threads=4)
    out = [0] * len(strings)
    for i, e in zip(nonempty_idx, encoded):
        out[i] = len(e)
    return out


# --------------------------------------------------------------------------- #
# Hashline edit parser.
#
# The session corpus spans several hashline generations, so the parser
# recognizes all of them and normalizes every `¶`/`§` section into the same
# EditSection shape. A `¶` section commits to a grammar from its FIRST op line,
# so the verb and sigil grammars never cross-contaminate (a body line such as
# `delete 5` inside a sigil-era section stays payload, not a phantom delete op).
#
#   verb (current): ¶PATH[#TAG]  replace N..M: / delete N..M /
#                                insert before N: / insert after N: /
#                                insert head: / insert tail:    (+ `+TEXT` body rows)
#   sigil (corpus): ¶PATH[#TAG]  N↑[body] / N↓[body] / A[-B]:[body] / A[-B]!
#   legacy:         §PATH        «ANCHOR / »ANCHOR / ≔ANCHOR[..ANCHOR]
#
# TAG width/case drifted across releases (2-4 hex, lower or upper, sometimes
# absent), so the header accepts any `#<token>` suffix instead of a fixed width.
# Legacy "anchor" tokens were `<line><2-letter-hash>` (e.g. `4fb`, `12*`).

# Header: one or more `¶`, optional whitespace, path (no whitespace/#/¶),
# optional `#TAG` of any width/case.
_HEADER_NEW_RE = re.compile(r"^¶+\s*([^\s#¶]+)(?:#\S+)?\s*$")

# Verb-based v4 (current) ops; body rows are `+TEXT` on the following lines.
_VERB_REPLACE_RE = re.compile(
    r"^\s*replace\s+([1-9][0-9]*)(?:\s*(?:\.\.|-|…)\s*([1-9][0-9]*))?\s*:?\s*$"
)
_VERB_DELETE_RE = re.compile(
    r"^\s*delete\s+([1-9][0-9]*)(?:\s*(?:\.\.|-|…)\s*([1-9][0-9]*))?\s*$"
)
_VERB_INSERT_RE = re.compile(
    r"^\s*insert\s+(?:(?P<pos>before|after)\s+(?P<anchor>[1-9][0-9]*)|(?P<edge>head|tail))\s*:?\s*$"
)

# Sigil/colon ops (historical corpus); body rows are bare lines.
# Insert op: LINE↑BODY / LINE↓BODY / BOF↑BODY / EOF↓BODY …
_OP_INSERT_HL_RE = re.compile(
    r"^\s*(?:[>+\-*]+\s*)?(?P<anchor>[1-9][0-9]*|BOF|EOF)(?P<sigil>[↑↓])(?P<inline>.*)$"
)
# Replace / delete op: A:BODY / A-B:BODY / A! / A-B!
_OP_RANGE_HL_RE = re.compile(
    r"^\s*(?:[>+\-*]+\s*)?(?P<a>[1-9][0-9]*)(?:-(?P<b>[1-9][0-9]*))?(?P<sigil>[:!])(?P<inline>.*)$"
)

# Legacy `§`/`«»≔` ops.
_LEGACY_RANGE_RE = re.compile(r"^\s*(\d+)[a-z*]+(?:\.\.(\d+)[a-z*]+)?\s*$")
_LEGACY_SINGLE_ANCHOR_RE = re.compile(r"^\s*(\d+)[a-z*]+\s*$")
_LEGACY_OP_RE = re.compile(r"^([«»≔])\s*(\S+)\s*$")

_HASHLINE_ENVELOPE_MARKERS = {"*** Begin Patch", "*** End Patch", "*** Abort"}


def _parse_legacy_range(raw: str) -> tuple[int, tuple[int, int] | None]:
    """Returns (range_size, optional (start_line, end_line)). Size >= 1."""
    m = _LEGACY_RANGE_RE.match(raw.strip())
    if not m:
        return (1, None)
    start = int(m.group(1))
    end_raw = m.group(2)
    end = int(end_raw) if end_raw else start
    size = max(end - start + 1, 1)
    lines = (start, max(end, start)) if start > 0 else None
    return (size, lines)


def _parse_legacy_anchor_line(raw: str) -> int | None:
    m = _LEGACY_SINGLE_ANCHOR_RE.match(raw.strip())
    if not m:
        return None
    try:
        return int(m.group(1))
    except ValueError:
        return None


@dataclass
class EditSection:
    target_file: str = ""
    payload_blocks: list[list[str]] = field(default_factory=list)
    op_anchors: list[str] = field(default_factory=list)
    deleted_lines: int = 0
    op_count: int = 0
    min_line: int | None = None
    max_line: int | None = None

    def touch(self, line: int) -> None:
        self.min_line = line if self.min_line is None else min(self.min_line, line)
        self.max_line = line if self.max_line is None else max(self.max_line, line)

    @property
    def payload_count(self) -> int:
        return sum(len(b) for b in self.payload_blocks)

    @property
    def change_size(self) -> int:
        return self.payload_count + self.deleted_lines


def parse_hashline_input(input_str: str) -> list[EditSection]:
    sections: list[EditSection] = []
    cur: EditSection | None = None
    cur_format: str | None = None  # "hash" (¶) | "legacy" (§)
    cur_grammar: str | None = None  # within "hash": None | "verb" | "sigil"
    open_idx: int | None = None  # current open payload block in cur

    def open_new(s: EditSection) -> int:
        s.payload_blocks.append([])
        return len(s.payload_blocks) - 1

    for raw_line in input_str.split("\n"):
        line = raw_line[:-1] if raw_line.endswith("\r") else raw_line
        trimmed_end = line.rstrip()

        if trimmed_end in _HASHLINE_ENVELOPE_MARKERS:
            if trimmed_end != "*** Begin Patch":
                break
            continue

        # Headers — `¶` (verb/sigil eras) first, then legacy `§`.
        new_header = _HEADER_NEW_RE.match(line)
        if new_header:
            if cur is not None:
                sections.append(cur)
            cur = EditSection(target_file=new_header.group(1))
            cur_format = "hash"
            cur_grammar = None
            open_idx = None
            continue
        if line.startswith("§"):
            if cur is not None:
                sections.append(cur)
            prefix_end = 0
            while prefix_end < len(line) and line[prefix_end] == "§":
                prefix_end += 1
            cur = EditSection(target_file=line[prefix_end:].strip())
            cur_format = "legacy"
            cur_grammar = None
            open_idx = None
            continue

        if cur is None:
            continue

        if cur_format == "hash":
            # Verb-based v4 ops; tried only while the grammar is undecided or
            # already verb, so sigil-era body lines never match a verb keyword.
            if cur_grammar in (None, "verb"):
                m = _VERB_REPLACE_RE.match(line)
                if m:
                    cur_grammar = "verb"
                    a = int(m.group(1))
                    b = int(m.group(2)) if m.group(2) else a
                    cur.deleted_lines += max(b - a + 1, 1)
                    cur.op_anchors.append(str(a))
                    if b != a:
                        cur.op_anchors.append(str(b))
                    cur.touch(a)
                    cur.touch(b)
                    cur.op_count += 1
                    open_idx = open_new(cur)
                    continue
                m = _VERB_DELETE_RE.match(line)
                if m:
                    cur_grammar = "verb"
                    a = int(m.group(1))
                    b = int(m.group(2)) if m.group(2) else a
                    cur.deleted_lines += max(b - a + 1, 1)
                    cur.op_anchors.append(str(a))
                    if b != a:
                        cur.op_anchors.append(str(b))
                    cur.touch(a)
                    cur.touch(b)
                    cur.op_count += 1
                    open_idx = None  # delete carries no body
                    continue
                m = _VERB_INSERT_RE.match(line)
                if m:
                    cur_grammar = "verb"
                    anchor = m.group("anchor")
                    if anchor is not None:
                        cur.op_anchors.append(anchor)
                        cur.touch(int(anchor))
                    cur.op_count += 1
                    open_idx = open_new(cur)
                    continue
            if cur_grammar == "verb":
                # Body rows are `+TEXT` (`+` alone = blank line); skip stray rows.
                if open_idx is not None and line.startswith("+"):
                    cur.payload_blocks[open_idx].append(line[1:])
                continue

            # Sigil/colon ops (historical corpus); body rows are bare lines.
            ins = _OP_INSERT_HL_RE.match(line)
            if ins:
                cur_grammar = "sigil"
                anchor = ins.group("anchor")
                inline = ins.group("inline")
                cur.op_anchors.append(anchor)
                if anchor not in ("BOF", "EOF"):
                    try:
                        cur.touch(int(anchor))
                    except ValueError:
                        pass
                open_idx = open_new(cur)
                cur.op_count += 1
                if inline:
                    cur.payload_blocks[open_idx].append(inline)
                continue

            rng = _OP_RANGE_HL_RE.match(line)
            if rng:
                cur_grammar = "sigil"
                sigil = rng.group("sigil")
                a_str = rng.group("a")
                b_str = rng.group("b") or a_str
                inline = rng.group("inline")
                try:
                    a = int(a_str)
                    b = int(b_str)
                    size = max(b - a + 1, 1)
                    cur.touch(a)
                    cur.touch(b)
                except ValueError:
                    size = 1
                cur.op_anchors.append(a_str)
                if b_str != a_str:
                    cur.op_anchors.append(b_str)
                cur.deleted_lines += size
                cur.op_count += 1
                if sigil == "!":
                    # Delete op: payload forbidden by the production parser; close.
                    open_idx = None
                    continue
                # sigil == ":" — replace.
                open_idx = open_new(cur)
                if inline:
                    cur.payload_blocks[open_idx].append(inline)
                continue
        else:
            op_match = _LEGACY_OP_RE.match(line)
            if op_match:
                op = op_match.group(1)
                body = op_match.group(2)
                if op in ("«", "»"):
                    anchor_trimmed = body.strip()
                    if anchor_trimmed and anchor_trimmed not in ("BOF", "EOF"):
                        cur.op_anchors.append(anchor_trimmed)
                    line_no = _parse_legacy_anchor_line(body)
                    if line_no is not None:
                        cur.touch(line_no)
                    open_idx = open_new(cur)
                    cur.op_count += 1
                    continue
                if op == "≔":
                    size, lines = _parse_legacy_range(body)
                    cur.deleted_lines += size
                    if lines is not None:
                        cur.touch(lines[0])
                        cur.touch(lines[1])
                    for part in body.strip().split(".."):
                        t = part.strip()
                        if t:
                            cur.op_anchors.append(t)
                    cur.op_count += 1
                    open_idx = open_new(cur)
                    continue

        if open_idx is not None:
            cur.payload_blocks[open_idx].append(line)
        elif not line.strip():
            continue

    if cur is not None:
        sections.append(cur)
    return sections


def find_longest_repeat(block: list[str], min_len: int = 4) -> tuple[int, int] | None:
    """Returns (start_index, repeat_len) if a repeat of >= min_len with at least
    half meaningful lines exists. O(n^2) per block — fine for typical edits."""
    n = len(block)
    if n < 2 * min_len:
        return None
    best: tuple[int, int] | None = None
    for i in range(n - min_len + 1):
        for j in range(i + min_len, n - min_len + 1):
            k = 0
            while i + k < j and j + k < n and block[i + k] == block[j + k]:
                k += 1
            if k < min_len:
                continue
            meaningful = sum(1 for s in block[i : i + k] if len(s.strip()) >= 4)
            if meaningful < max((k + 1) // 2, 2):
                continue
            if best is None or k > best[1]:
                best = (i, k)
    return best


def duplicated_anchors(sections: list[EditSection]) -> list[list]:
    """Returns [[anchor, count, target_file], ...] for anchors referenced
    by >= 2 ops within one section. Skips BOF/EOF/* anchors."""
    out: list[list] = []
    for sec in sections:
        counts: dict[str, int] = defaultdict(int)
        for a in sec.op_anchors:
            if a in ("BOF", "EOF") or "*" in a:
                continue
            counts[a] += 1
        for anchor, c in counts.items():
            if c >= 2:
                out.append([anchor, c, sec.target_file])
    out.sort(key=lambda r: -r[1])
    return out


# --------------------------------------------------------------------------- #
# Edit result classification (port of cmd_followups.rs success/warnings).

_RE_FAILURE_HEAD = re.compile(
    r"^(edit rejected|error\b|failed\b|invalid\b|unrecognized\b|cannot\b|"
    r"no enclosing|file has been (modified|changed)|file has not been read|"
    r"permission denied|tool execution was aborted|request was aborted|"
    r"cancelled|canceled|line \d+:|expected|unexpected|patch failed|"
    r"no replacements|0 matches)",
    re.IGNORECASE,
)


def looks_successful(text: str) -> bool:
    if not text:
        return False
    head = ""
    for ln in text.split("\n"):
        if ln.strip():
            head = ln
            break
    if not head:
        return False
    return _RE_FAILURE_HEAD.match(head.lstrip()) is None


def extract_warnings(text: str) -> list[str]:
    out: list[str] = []
    for ln in text.split("\n"):
        t = ln.lstrip()
        if t.startswith("Auto-rebased anchor"):
            out.append("auto-rebased")
        elif t.startswith("Auto-absorbed"):
            out.append("auto-absorbed")
        elif t.startswith("Auto-dropped"):
            out.append("auto-dropped")
    return out


# --------------------------------------------------------------------------- #
# JSONL parsing


def parse_iso_ms(s: str | None) -> int:
    if not s:
        return 0
    try:
        if s.endswith("Z"):
            s = s[:-1] + "+00:00"
        from datetime import datetime

        return int(datetime.fromisoformat(s).timestamp() * 1000)
    except Exception:
        return 0


def join_text(items) -> str:
    parts: list[str] = []
    for it in items or []:
        if not isinstance(it, dict):
            continue
        t = it.get("text")
        if isinstance(t, str) and t:
            parts.append(t)
    return "\n".join(parts)


def session_meta_from_path(path: Path) -> tuple[str, bool, str | None, str | None]:
    parts = path.parts
    try:
        idx = parts.index("sessions")
    except ValueError:
        return (path.parent.name, False, None, None)
    rel = parts[idx + 1 :]
    if len(rel) == 2:
        return (rel[0], False, None, None)
    if len(rel) == 3:
        folder = rel[0]
        parent = str(path.parent) + ".jsonl"
        label = path.stem
        return (folder, True, parent, label)
    return (rel[0] if rel else path.parent.name, False, None, None)


def _is_edit_call(name: str) -> bool:
    # cmd_followups.rs targets `edit` only (hashline).
    return name == "edit"


@dataclass
class SessionRecords:
    session_meta: dict
    tool_calls: list[list] = field(default_factory=list)
    tool_results: list[list] = field(default_factory=list)
    assistant_msgs: list[list] = field(default_factory=list)
    user_msgs: list[list] = field(default_factory=list)
    edit_calls: list[tuple] = field(default_factory=list)  # initial stub on toolCall
    edit_call_results: list[tuple] = field(
        default_factory=list
    )  # success+warnings on toolResult
    edit_sections: list[tuple] = field(default_factory=list)  # one row per section
    pending_tokens: list[tuple] = field(default_factory=list)  # (row, field_idx, text)
    starting_seq: int = 0
    full_rebuild: bool = False
    starting_offset: int = 0
    final_offset: int = 0
    final_line_count: int = 0
    file_size: int = 0
    file_mtime: int = 0


def parse_file(
    path: Path,
    starting_offset: int,
    starting_seq: int,
    full_rebuild: bool,
) -> SessionRecords | None:
    try:
        st = path.stat()
    except FileNotFoundError:
        return None

    folder, is_subagent, parent_session, subagent_label = session_meta_from_path(path)
    rec = SessionRecords(
        session_meta={
            "session_file": str(path),
            "folder": folder,
            "is_subagent": int(is_subagent),
            "parent_session": parent_session,
            "subagent_label": subagent_label,
            "cwd": None,
            "session_uuid": None,
            "version": None,
            "title": None,
            "started_at": None,
        },
        starting_seq=starting_seq,
        starting_offset=starting_offset,
        full_rebuild=full_rebuild,
        file_size=st.st_size,
        file_mtime=int(st.st_mtime * 1000),
    )

    seq = starting_seq
    offset = starting_offset
    try:
        with path.open("rb") as f:
            if starting_offset:
                f.seek(starting_offset)
            for raw in f:
                offset += len(raw)
                if not raw.strip():
                    seq += 1
                    continue
                try:
                    ev = json.loads(raw)
                except json.JSONDecodeError:
                    seq += 1
                    continue

                kind = ev.get("type")
                ts = parse_iso_ms(ev.get("timestamp"))
                entry_id = ev.get("id")

                if kind == "session" and seq == 0:
                    rec.session_meta["session_uuid"] = ev.get("id")
                    rec.session_meta["version"] = ev.get("version")
                    rec.session_meta["title"] = ev.get("title")
                    rec.session_meta["cwd"] = ev.get("cwd")
                    rec.session_meta["started_at"] = ts or None
                elif kind == "message":
                    msg = ev.get("message") or {}
                    role = msg.get("role")
                    content = msg.get("content")
                    if role == "assistant" and isinstance(content, list):
                        _ingest_assistant(rec, path, seq, entry_id, ts, msg, content)
                    elif role == "toolResult":
                        _ingest_tool_result(rec, path, seq, entry_id, ts, msg)
                    elif role == "user" and isinstance(content, list):
                        _ingest_user(rec, path, seq, entry_id, ts, content)
                seq += 1
    except OSError as e:
        print(f"!! {path}: {e}", file=sys.stderr)
        return None

    rec.final_offset = offset
    rec.final_line_count = seq

    # Single batched tokenization pass for the whole file.
    if rec.pending_tokens:
        texts = [p[2] for p in rec.pending_tokens]
        tokens = batch_count_tokens(texts)
        for (row, field_idx, _), n in zip(rec.pending_tokens, tokens):
            row[field_idx] = n
        rec.pending_tokens.clear()
    return rec


def _parse_worker(item: tuple[Path, bool, int, int]) -> SessionRecords | None:
    path, full_rebuild, start_off, start_seq = item
    return parse_file(path, start_off, start_seq, full_rebuild)


def _ingest_assistant(rec, path, seq, entry_id, ts, msg, content) -> None:
    sf = str(path)
    model = msg.get("model")
    provider = msg.get("provider")

    text_parts: list[str] = []
    thinking_parts: list[str] = []
    for it in content:
        if not isinstance(it, dict):
            continue
        t = it.get("type")
        if t == "toolCall":
            call_id = it.get("id") or ""
            raw_name = it.get("name") or ""
            tool_name = raw_name or "<unknown>"
            arg_obj = it.get("arguments")
            if arg_obj is None:
                arg_json = ""
            elif isinstance(arg_obj, str):
                arg_json = arg_obj
            else:
                arg_json = json.dumps(
                    arg_obj, separators=(",", ":"), ensure_ascii=False
                )
            row = [
                sf,
                seq,
                entry_id,
                call_id,
                tool_name,
                raw_name,
                ts,
                model,
                provider,
                arg_json,
                0,
            ]
            rec.tool_calls.append(row)
            if arg_json:
                rec.pending_tokens.append((row, 10, arg_json))
            if _is_edit_call(tool_name):
                _ingest_edit_call(rec, sf, seq, ts, call_id, arg_obj, arg_json)
        elif t == "thinking":
            v = it.get("thinking")
            if isinstance(v, str) and v:
                thinking_parts.append(v)
        elif t == "text":
            v = it.get("text")
            if isinstance(v, str) and v:
                text_parts.append(v)

    text_blob = "\n".join(text_parts) if text_parts else None
    thinking_blob = "\n".join(thinking_parts) if thinking_parts else None
    text_tokens_slot = 0
    thinking_tokens_slot = 0
    if text_blob or thinking_blob:
        row = [
            sf,
            seq,
            entry_id,
            ts,
            model,
            provider,
            text_blob,
            thinking_blob,
            text_tokens_slot,
            thinking_tokens_slot,
        ]
        rec.assistant_msgs.append(row)
        if text_blob:
            rec.pending_tokens.append((row, 8, text_blob))
        if thinking_blob:
            rec.pending_tokens.append((row, 9, thinking_blob))


def _ingest_edit_call(rec, sf, seq, ts, call_id, arg_obj, arg_json) -> None:
    """Parse the hashline `input` and emit ss_edit_calls + ss_edit_sections rows."""
    # Recover `input` from arg_obj (preferred) or arg_json (legacy).
    input_str: str | None = None
    if isinstance(arg_obj, dict):
        v = arg_obj.get("input")
        if isinstance(v, str):
            input_str = v
    if input_str is None and arg_json:
        try:
            parsed = json.loads(arg_json)
            v = parsed.get("input") if isinstance(parsed, dict) else None
            if isinstance(v, str):
                input_str = v
        except Exception:
            pass
    if input_str is None:
        input_str = ""
    raw_input_len = len(input_str.encode("utf-8"))

    # Stub call row (success + warnings come from toolResult later).
    rec.edit_calls.append((sf, call_id, seq, ts, raw_input_len, EDIT_PARSER_VERSION))

    if not any(
        line.startswith(("¶", "§")) for line in input_str.lstrip("\ufeff").splitlines()
    ):
        # Vim-mode or other shape — no sections to record.
        return

    sections = parse_hashline_input(input_str)
    for idx, sec in enumerate(sections):
        repeat = None
        repeat_block_idx: int | None = None
        for bi, block in enumerate(sec.payload_blocks):
            r = find_longest_repeat(block, 4)
            if r is None:
                continue
            start_i, k = r
            if repeat is None or k > repeat[1]:
                repeat = (start_i, k)
                repeat_block_idx = bi
        if repeat is not None and repeat_block_idx is not None:
            blk = sec.payload_blocks[repeat_block_idx]
            sample_line = blk[repeat[0]] if repeat[0] < len(blk) else ""
            sample = (sample_line[:80] + "…") if len(sample_line) > 80 else sample_line
            longest_repeat_len = repeat[1]
        else:
            sample = None
            longest_repeat_len = 0

        dups = duplicated_anchors([sec])

        rec.edit_sections.append(
            (
                sf,
                call_id,
                seq,
                idx,
                sec.target_file,
                sec.op_count,
                sec.deleted_lines,
                sec.payload_count,
                sec.change_size,
                sec.min_line,
                sec.max_line,
                json.dumps(sec.payload_blocks, ensure_ascii=False),
                json.dumps(sec.op_anchors, ensure_ascii=False),
                longest_repeat_len,
                repeat_block_idx,
                sample,
                json.dumps(dups, ensure_ascii=False),
                EDIT_PARSER_VERSION,
            )
        )


def _ingest_tool_result(rec, path, seq, entry_id, ts, msg) -> None:
    sf = str(path)
    call_id = msg.get("toolCallId") or ""
    raw_name = msg.get("toolName") or ""
    tool_name = raw_name or "<unknown>"
    content = msg.get("content")
    text = join_text(content) if isinstance(content, list) else ""
    is_error = 1 if msg.get("isError") else 0
    row = [sf, seq, entry_id, call_id, tool_name, raw_name, ts, text, 0, is_error]
    rec.tool_results.append(row)
    if text:
        rec.pending_tokens.append((row, 8, text))
    if _is_edit_call(tool_name):
        success = 1 if looks_successful(text) else 0
        warnings = extract_warnings(text) if success else []
        rec.edit_call_results.append(
            (sf, call_id, success, json.dumps(warnings, ensure_ascii=False))
        )


def _ingest_user(rec, path, seq, entry_id, ts, content) -> None:
    text = join_text(content)
    if not text:
        return
    row = [str(path), seq, entry_id, ts, text, 0]
    rec.user_msgs.append(row)
    rec.pending_tokens.append((row, 5, text))


# --------------------------------------------------------------------------- #
# DB


def open_db() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, isolation_level=None, check_same_thread=False)
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA synchronous = NORMAL")
    conn.execute("PRAGMA temp_store = MEMORY")
    conn.execute("PRAGMA mmap_size = 268435456")  # 256 MiB
    conn.executescript(SCHEMA_SQL)
    _migrate(conn)
    return conn


def existing_state(
    conn: sqlite3.Connection,
) -> dict[str, tuple[int, int, int, int, int]]:
    """{session_file: (mtime, size, byte_offset, line_count, parser_version)}"""
    rows = conn.execute(
        "SELECT session_file, mtime, size, byte_offset, line_count, parser_version "
        "FROM ss_sessions"
    ).fetchall()
    return {r[0]: (r[1], r[2], r[3], r[4], r[5]) for r in rows}


def write_records(conn: sqlite3.Connection, rec: SessionRecords, now_ms: int) -> None:
    sf = rec.session_meta["session_file"]
    cur = conn.cursor()
    cur.execute("BEGIN IMMEDIATE")
    try:
        if rec.full_rebuild:
            for tbl in (
                "ss_tool_calls",
                "ss_tool_results",
                "ss_assistant_msgs",
                "ss_user_msgs",
                "ss_edit_calls",
                "ss_edit_sections",
            ):
                cur.execute(f"DELETE FROM {tbl} WHERE session_file = ?", (sf,))

        if rec.tool_calls:
            cur.executemany(
                "INSERT OR REPLACE INTO ss_tool_calls "
                "(session_file, seq, entry_id, call_id, tool_name, raw_tool_name, "
                " timestamp, model, provider, arg_json, arg_tokens) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                rec.tool_calls,
            )
        if rec.tool_results:
            cur.executemany(
                "INSERT OR REPLACE INTO ss_tool_results "
                "(session_file, seq, entry_id, call_id, tool_name, raw_tool_name, "
                " timestamp, result_text, result_tokens, is_error) "
                "VALUES (?,?,?,?,?,?,?,?,?,?)",
                rec.tool_results,
            )
        if rec.assistant_msgs:
            cur.executemany(
                "INSERT OR REPLACE INTO ss_assistant_msgs "
                "(session_file, seq, entry_id, timestamp, model, provider, "
                " text_blob, thinking_blob, text_tokens, thinking_tokens) "
                "VALUES (?,?,?,?,?,?,?,?,?,?)",
                rec.assistant_msgs,
            )
        if rec.user_msgs:
            cur.executemany(
                "INSERT OR REPLACE INTO ss_user_msgs "
                "(session_file, seq, entry_id, timestamp, text_blob, text_tokens) "
                "VALUES (?,?,?,?,?,?)",
                rec.user_msgs,
            )
        if rec.edit_calls:
            # Stub row when seeing toolCall; preserve any existing success/warnings
            # if a prior sync already paired the result.
            cur.executemany(
                "INSERT INTO ss_edit_calls "
                "(session_file, call_id, seq, timestamp, raw_input_len, parser_version) "
                "VALUES (?,?,?,?,?,?) "
                "ON CONFLICT(session_file, call_id) DO UPDATE SET "
                " seq=excluded.seq, timestamp=excluded.timestamp, "
                " raw_input_len=excluded.raw_input_len, "
                " parser_version=excluded.parser_version",
                rec.edit_calls,
            )
        if rec.edit_call_results:
            cur.executemany(
                "INSERT INTO ss_edit_calls "
                "(session_file, call_id, seq, timestamp, raw_input_len, success, warnings, parser_version) "
                "VALUES (?,?,0,0,0,?,?,?) "
                "ON CONFLICT(session_file, call_id) DO UPDATE SET "
                " success=excluded.success, warnings=excluded.warnings, "
                " parser_version=excluded.parser_version",
                [
                    (sf_, cid, succ, warn, EDIT_PARSER_VERSION)
                    for (sf_, cid, succ, warn) in rec.edit_call_results
                ],
            )
        if rec.edit_sections:
            cur.executemany(
                "INSERT OR REPLACE INTO ss_edit_sections "
                "(session_file, call_id, seq, section_idx, target_file, "
                " op_count, deleted_lines, payload_count, change_size, "
                " min_line, max_line, payload_blocks, op_anchors, "
                " longest_repeat_len, longest_repeat_block_idx, longest_repeat_sample, "
                " dup_anchors, parser_version) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                rec.edit_sections,
            )

        m = rec.session_meta
        cur.execute(
            "INSERT INTO ss_sessions "
            "(session_file, folder, is_subagent, parent_session, subagent_label, "
            " started_at, title, cwd, session_uuid, version, "
            " mtime, size, byte_offset, line_count, last_synced, tokenizer, "
            " schema_version, parser_version) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) "
            "ON CONFLICT(session_file) DO UPDATE SET "
            " folder=excluded.folder, "
            " is_subagent=excluded.is_subagent, "
            " parent_session=excluded.parent_session, "
            " subagent_label=excluded.subagent_label, "
            " started_at=COALESCE(excluded.started_at, ss_sessions.started_at), "
            " title=COALESCE(excluded.title, ss_sessions.title), "
            " cwd=COALESCE(excluded.cwd, ss_sessions.cwd), "
            " session_uuid=COALESCE(excluded.session_uuid, ss_sessions.session_uuid), "
            " version=COALESCE(excluded.version, ss_sessions.version), "
            " mtime=excluded.mtime, "
            " size=excluded.size, "
            " byte_offset=excluded.byte_offset, "
            " line_count=excluded.line_count, "
            " last_synced=excluded.last_synced, "
            " tokenizer=excluded.tokenizer, "
            " schema_version=excluded.schema_version, "
            " parser_version=excluded.parser_version",
            (
                sf,
                m["folder"],
                m["is_subagent"],
                m["parent_session"],
                m["subagent_label"],
                m["started_at"],
                m["title"],
                m["cwd"],
                m["session_uuid"],
                m["version"],
                rec.file_mtime,
                rec.file_size,
                rec.final_offset,
                rec.final_line_count,
                now_ms,
                TOKENIZER_NAME,
                SCHEMA_VERSION,
                EDIT_PARSER_VERSION,
            ),
        )
        cur.execute("COMMIT")
    except Exception:
        cur.execute("ROLLBACK")
        raise


# --------------------------------------------------------------------------- #
# Driver


def discover_sessions(root: Path, limit: int | None) -> list[Path]:
    if not root.exists():
        return []
    files = [p for p in root.rglob("*.jsonl") if p.is_file()]
    files.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    if limit and limit > 0:
        files = files[:limit]
    return files


def decide_action(
    path: Path,
    state: dict[str, tuple[int, int, int, int, int]],
    full: bool,
) -> tuple[bool, int, int] | None:
    """Returns (full_rebuild, starting_offset, starting_seq) or None to skip."""
    try:
        st = path.stat()
    except FileNotFoundError:
        return None
    mtime_ms = int(st.st_mtime * 1000)
    size = st.st_size
    prev = state.get(str(path))
    if full or prev is None:
        return (True, 0, 0)
    prev_mtime, prev_size, prev_offset, prev_lines, prev_parser = prev
    if prev_parser < EDIT_PARSER_VERSION:
        # Stale parser output → rebuild this file from scratch.
        return (True, 0, 0)
    if size == prev_size and mtime_ms <= prev_mtime:
        return None
    if size < prev_offset:
        return (True, 0, 0)
    if size == prev_offset and mtime_ms > prev_mtime:
        return (True, 0, 0)
    return (False, prev_offset, prev_lines)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--workers", type=int, default=min(16, (os.cpu_count() or 4) * 2))
    ap.add_argument(
        "--limit",
        type=int,
        default=0,
        help="only sync the N most-recent files (0 = all)",
    )
    ap.add_argument(
        "--full",
        action="store_true",
        help="ignore stored state, re-ingest every file from scratch",
    )
    ap.add_argument("--root", default=str(SESSIONS_ROOT))
    args = ap.parse_args()

    root = Path(args.root).expanduser()
    print(f"-> sessions root: {root}", file=sys.stderr)
    print(f"-> db:            {DB_PATH}", file=sys.stderr)
    print(
        f"-> parser_version={EDIT_PARSER_VERSION} schema_version={SCHEMA_VERSION}",
        file=sys.stderr,
    )

    conn = open_db()
    state = existing_state(conn)
    print(f"-> known sessions in db: {len(state)}", file=sys.stderr)

    files = discover_sessions(root, args.limit or None)
    print(f"-> on-disk sessions:     {len(files)}", file=sys.stderr)

    work: list[tuple[Path, bool, int, int]] = []
    for p in files:
        decision = decide_action(p, state, args.full)
        if decision is None:
            continue
        full_rebuild, start_off, start_seq = decision
        work.append((p, full_rebuild, start_off, start_seq))

    print(f"-> dirty:                {len(work)}", file=sys.stderr)
    if not work:
        return 0

    out_q: queue.Queue[SessionRecords | None] = queue.Queue(maxsize=args.workers * 2)

    def writer_loop() -> None:
        now_ms = int(time.time() * 1000)
        n = 0
        t0 = time.monotonic()
        last_log = t0
        while True:
            rec = out_q.get()
            if rec is None:
                break
            try:
                write_records(conn, rec, now_ms)
            except Exception as e:
                print(
                    f"!! write failed for {rec.session_meta['session_file']}: {e}",
                    file=sys.stderr,
                )
            n += 1
            now = time.monotonic()
            if now - last_log >= 1.0:
                rate = n / max(now - t0, 1e-6)
                print(
                    f"   wrote {n}/{len(work)} files ({rate:.1f} files/s)",
                    file=sys.stderr,
                )
                last_log = now
        rate = n / max(time.monotonic() - t0, 1e-6)
        print(f"-> wrote {n} files total ({rate:.1f} files/s)", file=sys.stderr)

    writer_thread = threading.Thread(target=writer_loop, daemon=True)
    writer_thread.start()

    t0 = time.monotonic()
    with ProcessPoolExecutor(max_workers=args.workers) as ex:
        futures = [ex.submit(_parse_worker, item) for item in work]
        for fut in as_completed(futures):
            try:
                rec = fut.result()
            except Exception as e:
                print(f"!! parse failed: {e}", file=sys.stderr)
                continue
            if rec is not None:
                out_q.put(rec)

    out_q.put(None)
    writer_thread.join()
    print(f"-> total wallclock: {time.monotonic() - t0:.1f}s", file=sys.stderr)

    conn.execute("PRAGMA optimize")
    conn.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
