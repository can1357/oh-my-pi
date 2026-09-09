#!/usr/bin/env python3
"""
Backtest GPT-5 Harmony-header leak handling against ~/.omp/stats.db.

This is a dry-run analysis tool. It does not mutate stats.db or session JSONL.
It scans stored assistant/tool-call surfaces, applies a selected detection and
recovery strategy, and prints which edit inputs would be preserved by a
sanitize-tail strategy versus aborted/replayed.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sqlite3
import sys
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

DB_PATH = Path.home() / ".omp" / "stats.db"

MARKER_RE = re.compile(r"\bto=functions\.[A-Za-z_][A-Za-z0-9_]*")
HARMONY_RE = re.compile(r"<\|(start|end|channel|message|call|return)\|>")
CHANNEL_WORD_RE = re.compile(
    r"\b(analysis|commentary|assistant|user|system|developer|tool)\s+to=functions\."
)
GLITCH_RE = re.compile(
    r"\b(changedFiles|RTLU|Jsii(?:_commentary)?|Japgolly|tRTLUfunctions|Joshi_commentary|Japgolly_commentary|jsii_commentary|Jsii_commentary|Jsii)\b"
)
NULLISH_RE = re.compile(r"\b(undefined|null)\b")
BODY_CASCADE_RE = re.compile(r"\bto=functions\.[A-Za-z_][A-Za-z0-9_]*\s+code(?:\s|$)")
FAKE_RESULT_RE = re.compile(
    r"\bto=functions\.[A-Za-z_][A-Za-z0-9_]*(?s:.{0,80}?)code_output\s*\nCell\s+\d+:"
)
FENCE_RE = re.compile(r"^\s*(```+|~~~+)")

# Python's stdlib re has no Unicode script properties, so keep the exact
# ranges local and explicit.
SCRIPT_RUN_RE = re.compile(
    "["
    "\u3400-\u4dbf"  # CJK Extension A
    "\u4e00-\u9fff"  # CJK Unified Ideographs
    "\uf900-\ufaff"  # CJK Compatibility Ideographs
    "\u0400-\u04ff"  # Cyrillic
    "\u0e00-\u0e7f"  # Thai
    "\u10a0-\u10ff"  # Georgian
    "\u0530-\u058f"  # Armenian
    "\u0c80-\u0cff"  # Kannada
    "\u0c00-\u0c7f"  # Telugu
    "\u0900-\u097f"  # Devanagari
    "\u0600-\u06ff"  # Arabic
    "\u0d00-\u0d7f"  # Malayalam
    "]{2,}"
)

# Header detector — matches any of:
#   ¶PATH or ¶PATH#hash  (current hashline format)
#   §PATH                (legacy hashline format, pre-2026-05)
#   *** Update File: PATH (Codex apply_patch envelope)
HEADER_RE = re.compile(
    r"^(?:§+(?P<hl_legacy>.*)|¶+\s*(?P<hl_new>[^\s#¶]+)(?:#[0-9a-f]{4})?|\*\*\* Update File:\s+(?P<upd>\S.*))\s*$"
)
BEGIN_PATCH_RE = re.compile(r"^\*\*\* Begin Patch\s*$")
END_PATCH_RE = re.compile(r"^\*\*\* End Patch\s*$")

# Legacy hashline ops (kept for historical session corpus).
LEGACY_INSERT_RE = re.compile(
    r"^(?P<op>[«»])\s*(?P<anchor>BOF|EOF|[1-9][0-9]*[A-Za-z]{2})\s*$"
)
LEGACY_RANGE_RE = re.compile(
    r"(?P<a>[1-9][0-9]*[A-Za-z]{2})(?:\.\.(?P<b>[1-9][0-9]*[A-Za-z]{2}))?"
)
LEGACY_REPLACE_RE = re.compile(
    r"^≔\s*(?P<range>[1-9][0-9]*[A-Za-z]{2}(?:\.\.[1-9][0-9]*[A-Za-z]{2})?)\s*$"
)

# Current hashline ops.
NEW_INSERT_RE = re.compile(
    r"^\s*(?:[>+\-*]+\s*)?(?P<anchor>[1-9][0-9]*|BOF|EOF)(?P<sigil>[↑↓])(?P<inline>.*)$"
)
NEW_RANGE_RE = re.compile(
    r"^\s*(?:[>+\-*]+\s*)?(?P<a>[1-9][0-9]*)(?:-(?P<b>[1-9][0-9]*))?(?P<sigil>[:!])(?P<inline>.*)$"
)

JSON_DECODER = json.JSONDecoder()


@dataclass(frozen=True)
class Signal:
    cls: str
    start: int
    end: int
    detail: str


@dataclass
class MarkerEvidence:
    start: int
    end: int
    classes: set[str] = field(default_factory=lambda: {"M"})

    @property
    def label(self) -> str:
        return "+".join(sorted(self.classes))


@dataclass
class EditSection:
    target_file: str
    op_count: int = 0
    payload_lines: int = 0
    deleted_lines: int = 0


@dataclass
class EditBoundary:
    ok: bool
    parsed_end: int
    reason: str
    sections: list[EditSection] = field(default_factory=list)
    line_no: int = 0

    @property
    def op_count(self) -> int:
        return sum(s.op_count for s in self.sections)

    @property
    def payload_lines(self) -> int:
        return sum(s.payload_lines for s in self.sections)

    @property
    def deleted_lines(self) -> int:
        return sum(s.deleted_lines for s in self.sections)


@dataclass
class ToolBacktest:
    surface: str
    row_id: str
    session_file: str
    seq: int
    entry_id: str | None
    call_id: str | None
    tool_name: str
    model: str | None
    provider: str | None
    action: str
    signals: list[str]
    signal_offsets: list[int]
    text_len: int
    parsed_end: int | None = None
    removed_len: int = 0
    removed_sha16: str | None = None
    removed_preview: str = ""
    clean_preview: str = ""
    context_preview: str = ""
    edit_files: list[str] = field(default_factory=list)
    edit_ops: int = 0
    edit_payload_lines: int = 0
    edit_deleted_lines: int = 0
    parse_reason: str = ""


@dataclass
class TextBacktest:
    surface: str
    row_id: str
    session_file: str
    seq: int
    entry_id: str | None
    model: str | None
    provider: str | None
    action: str
    signals: list[str]
    signal_offsets: list[int]
    text_len: int
    context_preview: str


def open_ro(path: Path) -> sqlite3.Connection:
    if not path.exists():
        sys.exit(f"db not found: {path}. Run scripts/session-stats/sync.py first.")
    conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def commas(n: int) -> str:
    return f"{n:,}"


def one_line(text: str, limit: int = 180) -> str:
    text = text.replace("\r", "\\r").replace("\n", " | ").replace("\t", "\\t")
    if len(text) <= limit:
        return text
    return text[: max(0, limit - 3)] + "..."


def snippet(text: str, pos: int, radius: int = 120) -> str:
    lo = max(0, pos - radius)
    hi = min(len(text), pos + radius)
    prefix = "..." if lo > 0 else ""
    suffix = "..." if hi < len(text) else ""
    return one_line(prefix + text[lo:hi] + suffix, radius * 2 + 20)


def sha16(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8", errors="replace")).hexdigest()[:16]


def is_inside_fenced_block(text: str, pos: int) -> bool:
    """Best-effort Markdown fence context used to avoid doc/test false positives."""
    in_fence = False
    for line in text[:pos].splitlines():
        if FENCE_RE.match(line):
            in_fence = not in_fence
    return in_fence


def ascii_ratio(text: str) -> float:
    if not text:
        return 1.0
    ascii_count = sum(1 for ch in text if ord(ch) < 128)
    return ascii_count / len(text)


def script_mismatch_near(text: str, start: int, end: int) -> bool:
    near = text[max(0, start - 32) : min(len(text), end + 32)]
    if not SCRIPT_RUN_RE.search(near):
        return False
    surrounding = text[max(0, start - 200) : min(len(text), end + 200)]
    return ascii_ratio(surrounding) >= 0.85


def marker_evidence_for(
    text: str,
    marker: re.Match[str],
    parsed_end: int | None,
    respect_fences: bool,
    include_nullish: bool,
) -> MarkerEvidence | None:
    start, end = marker.span()
    if respect_fences and is_inside_fenced_block(text, start):
        return None

    ev = MarkerEvidence(start=start, end=end)
    window16 = text[max(0, start - 16) : min(len(text), end + 16)]
    window200 = text[start : min(len(text), start + 200)]

    for c in CHANNEL_WORD_RE.finditer(
        text[max(0, start - 64) : min(len(text), end + 16)]
    ):
        absolute_start = max(0, start - 64) + c.start()
        absolute_end = max(0, start - 64) + c.end()
        if absolute_start <= start < absolute_end:
            ev.classes.add("C")
            break

    if GLITCH_RE.search(window16):
        ev.classes.add("G")
    if include_nullish and NULLISH_RE.search(window16):
        ev.classes.add("N")
    if script_mismatch_near(text, start, end):
        ev.classes.add("S")
    if BODY_CASCADE_RE.match(window200) and MARKER_RE.search(
        window200[marker.end() - start :]
    ):
        ev.classes.add("B")
    if FAKE_RESULT_RE.match(text, start):
        ev.classes.add("R")
    if parsed_end is not None and start >= parsed_end:
        ev.classes.add("T")
    return ev


def detect_signals(
    text: str,
    strategy: str,
    parsed_end: int | None = None,
    respect_fences: bool = True,
    include_nullish: bool = False,
) -> tuple[list[Signal], list[MarkerEvidence]]:
    signals: list[Signal] = []
    marker_evidence: list[MarkerEvidence] = []

    for h in HARMONY_RE.finditer(text):
        if respect_fences and is_inside_fenced_block(text, h.start()):
            continue
        signals.append(Signal("H", h.start(), h.end(), h.group(0)))

    for marker in MARKER_RE.finditer(text):
        ev = marker_evidence_for(
            text, marker, parsed_end, respect_fences, include_nullish
        )
        if ev is None:
            continue
        marker_evidence.append(ev)
        if strategy == "marker":
            signals.append(Signal(ev.label, ev.start, ev.end, text[ev.start : ev.end]))
        elif len(ev.classes) > 1:
            signals.append(Signal(ev.label, ev.start, ev.end, text[ev.start : ev.end]))

    if strategy == "tail":
        signals = [s for s in signals if s.cls == "H" or "T" in s.cls.split("+")]

    signals.sort(key=lambda s: (s.start, s.end, s.cls))
    marker_evidence.sort(key=lambda e: (e.start, e.end))
    return signals, marker_evidence


def complete_json_end(raw: str) -> tuple[bool, int, str]:
    try:
        _, end = JSON_DECODER.raw_decode(raw)
        return True, end, "json-prefix-ok"
    except json.JSONDecodeError as exc:
        return False, exc.pos, exc.msg


def line_spans(text: str) -> list[tuple[str, int, int]]:
    out: list[tuple[str, int, int]] = []
    pos = 0
    for raw in text.splitlines(keepends=True):
        start = pos
        pos += len(raw)
        out.append((raw.rstrip("\r\n"), start, pos))
    if text and (text.endswith("\n") or text.endswith("\r")):
        return out
    if not text:
        return []
    # splitlines(keepends=True) already includes the final unterminated line.
    return out


def parse_legacy_diff_boundary(text: str, *, loose_tail: bool = False) -> EditBoundary:
    """Best-effort parser for pre-hashline edit inputs.

    Older sessions used `---path` followed by compact hash/range operations
    whose replacement payload was raw text, not `~`-prefixed. That format is
    not safe enough for production recovery, but this backtest needs to answer
    where a tail-only cleaner would cut if we supported those historical rows.
    """
    sections: list[EditSection] = []
    cur: EditSection | None = None
    parsed_end = 0
    line_no = 0
    in_payload = False

    old_replace = re.compile(
        r"^\s*(?P<range>[1-9][0-9]*[A-Za-z]{2}(?:\.\.[1-9][0-9]*[A-Za-z]{2})?)(?P<op>[=+<])(?P<tail>.*)$"
    )
    old_delete = re.compile(
        r"^\s*-(?P<range>[1-9][0-9]*[A-Za-z]{2}(?:\.\.[1-9][0-9]*[A-Za-z]{2})?)\s*$"
    )

    for line, _start, end in line_spans(text):
        line_no += 1
        if (
            loose_tail
            and (MARKER_RE.search(line) or HARMONY_RE.search(line))
            and cur is not None
            and cur.op_count > 0
        ):
            break

        if line.startswith("---"):
            target = line[3:].strip()
            if not target:
                break
            cur = EditSection(target_file=target)
            sections.append(cur)
            parsed_end = end
            in_payload = False
            continue

        if cur is None:
            if not line.strip():
                parsed_end = end
                continue
            break

        if line.startswith("+++") or line.startswith("@@"):
            if line.startswith("@@"):
                cur.op_count += 1
                in_payload = True
            else:
                in_payload = False
            parsed_end = end
            continue

        dele = old_delete.match(line)
        if dele:
            cur.op_count += 1
            cur.deleted_lines += range_deleted_lines(dele.group("range"))
            parsed_end = end
            in_payload = False
            continue

        repl = old_replace.match(line)
        if repl:
            cur.op_count += 1
            if repl.group("op") == "=":
                cur.deleted_lines += range_deleted_lines(repl.group("range"))
            if repl.group("tail"):
                cur.payload_lines += 1
            parsed_end = end
            in_payload = True
            continue

        if line.startswith("+") and not line.startswith("+++"):
            cur.payload_lines += 1
            parsed_end = end
            in_payload = True
            continue

        if in_payload and (
            line.startswith("-") or line.startswith(" ") or line.startswith("\\")
        ):
            if line.startswith("-") and not line.startswith("---"):
                cur.deleted_lines += 1
            parsed_end = end
            continue

        if in_payload:
            cur.payload_lines += 1
            parsed_end = end
            continue

        if not line.strip():
            parsed_end = end
            continue

        break

    return EditBoundary(
        ok=parsed_end > 0 and bool(sections),
        parsed_end=parsed_end,
        reason="legacy-edit-ok"
        if parsed_end > 0 and sections
        else "no-complete-edit-prefix",
        sections=sections,
        line_no=line_no,
    )


def anchor_line_no(anchor: str) -> int | None:
    m = re.match(r"([1-9][0-9]*)", anchor)
    return int(m.group(1)) if m else None


def legacy_range_deleted_lines(raw_range: str) -> int:
    m = LEGACY_RANGE_RE.fullmatch(raw_range)
    if not m:
        return 1
    a = anchor_line_no(m.group("a")) or 0
    b = anchor_line_no(m.group("b") or m.group("a")) or a
    return max(1, b - a + 1)


def new_range_deleted_lines(a_raw: str, b_raw: str | None) -> int:
    try:
        a = int(a_raw)
        b = int(b_raw) if b_raw else a
    except ValueError:
        return 1
    return max(1, b - a + 1)


def parse_edit_boundary(text: str, *, legacy_loose_tail: bool = False) -> EditBoundary:
    """Find the longest tool-input prefix that parses as a complete sequence of
    edit sections.

    Supports both the current hashline format (``¶PATH#hash`` / ``↑↓:!``) and
    the legacy format (``§PATH`` / ``«»≔``) since the analyzed corpus spans the
    format transition. Codex ``*** Update File:`` envelopes are also recognized.
    """
    sections: list[EditSection] = []
    cur: EditSection | None = None
    # Per-section format: "new", "legacy_hl", or "codex". Determines which op
    # regexes apply and whether `needs_payload` semantics are in effect.
    cur_format: str | None = None
    parsed_end = 0
    line_no = 0
    # Legacy hashline (`«»`) inserts demand at least one payload line before the
    # boundary advances. New-format inserts are self-completing on their own
    # line, so these flags only matter when ``cur_format == "legacy_hl"``.
    needs_payload = False
    payload_allowed = False
    saw_required_payload = False
    seen_content = False

    legacy_payload_blockers = {"«", "»", "≔", "§"}
    new_payload_blockers = ("¶",)

    for line, _start, end in line_spans(text):
        line_no += 1
        stripped = line.strip()

        if not seen_content and not stripped:
            parsed_end = end
            continue
        seen_content = True

        if BEGIN_PATCH_RE.match(line):
            if needs_payload and not saw_required_payload:
                break
            parsed_end = end
            payload_allowed = False
            continue

        if END_PATCH_RE.match(line):
            if needs_payload and not saw_required_payload:
                break
            parsed_end = end
            payload_allowed = False
            continue

        header = HEADER_RE.match(line)
        if header:
            if needs_payload and not saw_required_payload:
                break
            if header.group("hl_new") is not None:
                target = header.group("hl_new").strip()
                cur_format = "new"
            elif header.group("hl_legacy") is not None:
                target = header.group("hl_legacy").strip()
                cur_format = "legacy_hl"
            else:
                target = (header.group("upd") or "").strip()
                cur_format = "codex"
            cur = EditSection(target_file=target)
            sections.append(cur)
            parsed_end = end
            needs_payload = False
            payload_allowed = False
            saw_required_payload = False
            continue

        if cur is None:
            break

        if cur_format == "new":
            # New format: payload lines are anything that does not start a new
            # op or header. `↑`/`↓`/`:` ops may be followed by additional
            # payload lines; `!` ops are self-contained.
            if payload_allowed and not line.startswith(new_payload_blockers):
                # Re-check whether the line itself is an op — an op line ends
                # the current payload run and starts a new op.
                if not NEW_INSERT_RE.match(line) and not NEW_RANGE_RE.match(line):
                    cur.payload_lines += 1
                    parsed_end = end
                    continue

            if not stripped:
                parsed_end = end
                payload_allowed = False
                continue

            ins = NEW_INSERT_RE.match(line)
            if ins:
                cur.op_count += 1
                if ins.group("inline"):
                    cur.payload_lines += 1
                parsed_end = end
                payload_allowed = True
                continue

            rng = NEW_RANGE_RE.match(line)
            if rng:
                sigil = rng.group("sigil")
                cur.op_count += 1
                cur.deleted_lines += new_range_deleted_lines(
                    rng.group("a"), rng.group("b")
                )
                if sigil == ":" and rng.group("inline"):
                    cur.payload_lines += 1
                parsed_end = end
                # `!` deletes do not accept payload; `:` replaces may carry
                # subsequent payload lines.
                payload_allowed = sigil == ":"
                continue

            break

        # Legacy hashline state machine (preserved verbatim for §«»≔ corpus).
        if payload_allowed and line[:1] not in legacy_payload_blockers:
            cur.payload_lines += 1
            parsed_end = end
            saw_required_payload = True
            needs_payload = False
            continue

        if not stripped:
            if needs_payload and not saw_required_payload:
                break
            parsed_end = end
            payload_allowed = False
            needs_payload = False
            saw_required_payload = False
            continue

        if needs_payload and not saw_required_payload:
            break

        ins = LEGACY_INSERT_RE.match(line)
        if ins:
            cur.op_count += 1
            needs_payload = True
            payload_allowed = True
            saw_required_payload = False
            # Not complete until at least one payload line appears.
            continue

        repl = LEGACY_REPLACE_RE.match(line)
        if repl:
            cur.op_count += 1
            cur.deleted_lines += legacy_range_deleted_lines(repl.group("range"))
            parsed_end = end
            needs_payload = False
            payload_allowed = True
            saw_required_payload = False
            continue

        break

    reason = "ok" if parsed_end > 0 and sections else "no-complete-edit-prefix"
    if needs_payload and not saw_required_payload:
        reason = "insert-missing-payload"
    if not sections and text.lstrip().startswith("---"):
        return parse_legacy_diff_boundary(text, loose_tail=legacy_loose_tail)
    return EditBoundary(
        ok=parsed_end > 0 and bool(sections),
        parsed_end=parsed_end,
        reason=reason,
        sections=sections,
        line_no=line_no,
    )


def parse_arg_json(raw: str) -> tuple[Any | None, bool, str]:
    try:
        return json.loads(raw), True, "ok"
    except json.JSONDecodeError as exc:
        return None, False, f"json-error:{exc.pos}:{exc.msg}"


def extract_primary_text(
    tool_name: str, arg_json: str, parsed: Any | None
) -> tuple[str, str]:
    if (
        tool_name == "edit"
        and isinstance(parsed, dict)
        and isinstance(parsed.get("input"), str)
    ):
        return "edit.input", parsed["input"]
    if (
        tool_name == "eval"
        and isinstance(parsed, dict)
        and isinstance(parsed.get("input"), str)
    ):
        return "eval.input", parsed["input"]
    if (
        tool_name == "write"
        and isinstance(parsed, dict)
        and isinstance(parsed.get("content"), str)
    ):
        return "write.content", parsed["content"]
    if (
        tool_name == "bash"
        and isinstance(parsed, dict)
        and isinstance(parsed.get("command"), str)
    ):
        return "bash.command", parsed["command"]
    return "arg_json", arg_json


def action_for_tool(
    tool_name: str,
    surface: str,
    text: str,
    signals: list[Signal],
    boundary: EditBoundary | None,
) -> str:
    if not signals:
        return "allow"
    if (
        tool_name == "edit"
        and surface == "edit.input"
        and boundary is not None
        and boundary.ok
    ):
        if all(sig.start >= boundary.parsed_end for sig in signals):
            return "sanitize_tail"
        return "abort_replay"
    return "abort_replay"


def evaluate_tool_row(
    row: sqlite3.Row,
    strategy: str,
    respect_fences: bool,
    include_nullish: bool,
    legacy_loose_tail: bool = False,
) -> ToolBacktest:
    arg_json = row["arg_json"] or ""
    tool_name = row["tool_name"] or "<unknown>"
    parsed, json_ok, json_reason = parse_arg_json(arg_json)
    surface, text = extract_primary_text(tool_name, arg_json, parsed)

    boundary: EditBoundary | None = None
    parsed_end: int | None = None
    parse_reason = json_reason
    if tool_name == "edit" and surface == "edit.input":
        boundary = parse_edit_boundary(text, legacy_loose_tail=legacy_loose_tail)
        parsed_end = boundary.parsed_end if boundary.ok else None
        parse_reason = boundary.reason
    else:
        ok, end, reason = complete_json_end(arg_json)
        if ok:
            parsed_end = end
        parse_reason = reason if json_ok else json_reason

    signals, _marker_evidence = detect_signals(
        text,
        strategy=strategy,
        parsed_end=parsed_end,
        respect_fences=respect_fences,
        include_nullish=include_nullish,
    )
    action = action_for_tool(tool_name, surface, text, signals, boundary)

    removed = ""
    clean_preview = ""
    edit_files: list[str] = []
    edit_ops = 0
    edit_payload_lines = 0
    edit_deleted_lines = 0

    if boundary is not None:
        edit_files = [s.target_file for s in boundary.sections]
        edit_ops = boundary.op_count
        edit_payload_lines = boundary.payload_lines
        edit_deleted_lines = boundary.deleted_lines
        if action == "sanitize_tail":
            removed = text[boundary.parsed_end :]
            cleaned = text[: boundary.parsed_end]
            clean_preview = tail_preview(cleaned)

    first_pos = signals[0].start if signals else 0
    return ToolBacktest(
        surface=surface,
        row_id=str(row["id"]),
        session_file=row["session_file"],
        seq=row["seq"],
        entry_id=row["entry_id"],
        call_id=row["call_id"],
        tool_name=tool_name,
        model=row["model"],
        provider=row["provider"],
        action=action,
        signals=[s.cls for s in signals],
        signal_offsets=[s.start for s in signals],
        text_len=len(text),
        parsed_end=parsed_end,
        removed_len=len(removed),
        removed_sha16=sha16(removed) if removed else None,
        removed_preview=one_line(removed, 200) if removed else "",
        clean_preview=clean_preview,
        context_preview=snippet(text, first_pos) if signals else "",
        edit_files=edit_files,
        edit_ops=edit_ops,
        edit_payload_lines=edit_payload_lines,
        edit_deleted_lines=edit_deleted_lines,
        parse_reason=parse_reason,
    )


def tail_preview(text: str, max_lines: int = 8, limit: int = 420) -> str:
    lines = text.splitlines()
    tail = "\n".join(lines[-max_lines:])
    return one_line(tail, limit)


def evaluate_text_row(
    row: sqlite3.Row,
    surface: str,
    text: str,
    strategy: str,
    respect_fences: bool,
    include_nullish: bool,
) -> TextBacktest:
    signals, _ = detect_signals(
        text,
        strategy=strategy,
        parsed_end=None,
        respect_fences=respect_fences,
        include_nullish=include_nullish,
    )
    action = "rewrite_candidate" if signals else "allow"
    first_pos = signals[0].start if signals else 0
    return TextBacktest(
        surface=surface,
        row_id=f"{row['session_file']}:{row['seq']}:{surface}",
        session_file=row["session_file"],
        seq=row["seq"],
        entry_id=row["entry_id"],
        model=row["model"],
        provider=row["provider"],
        action=action,
        signals=[s.cls for s in signals],
        signal_offsets=[s.start for s in signals],
        text_len=len(text),
        context_preview=snippet(text, first_pos) if signals else "",
    )


def candidate_where(column: str) -> str:
    return " OR ".join(
        [
            f"{column} LIKE '%to=functions.%'",
            f"{column} LIKE '%<|start|>%'",
            f"{column} LIKE '%<|end|>%'",
            f"{column} LIKE '%<|channel|>%'",
            f"{column} LIKE '%<|message|>%'",
            f"{column} LIKE '%<|call|>%'",
            f"{column} LIKE '%<|return|>%'",
        ]
    )


def scan_tools(
    conn: sqlite3.Connection, args: argparse.Namespace
) -> list[ToolBacktest]:
    where = candidate_where("arg_json")
    params: list[Any] = []
    if args.provider:
        where = f"({where}) AND provider = ?"
        params.append(args.provider)
    if args.model:
        where = f"({where}) AND model = ?"
        params.append(args.model)
    if args.tool:
        where = f"({where}) AND tool_name = ?"
        params.append(args.tool)
    sql = f"""
        SELECT id, session_file, seq, entry_id, call_id, tool_name, raw_tool_name,
               timestamp, model, provider, arg_json
        FROM ss_tool_calls
        WHERE {where}
        ORDER BY timestamp, id
    """
    rows = conn.execute(sql, params).fetchall()
    return [
        evaluate_tool_row(
            row,
            strategy=args.strategy,
            respect_fences=not args.no_fence_context,
            include_nullish=args.include_nullish,
            legacy_loose_tail=args.legacy_loose_tail,
        )
        for row in rows
    ]


def scan_assistant(
    conn: sqlite3.Connection, args: argparse.Namespace
) -> list[TextBacktest]:
    if not args.include_assistant:
        return []
    text_where = candidate_where("text_blob")
    thinking_where = candidate_where("thinking_blob")
    where = f"({text_where}) OR ({thinking_where})"
    params: list[Any] = []
    if args.provider:
        where = f"({where}) AND provider = ?"
        params.append(args.provider)
    if args.model:
        where = f"({where}) AND model = ?"
        params.append(args.model)
    sql = f"""
        SELECT session_file, seq, entry_id, timestamp, model, provider,
               text_blob, thinking_blob
        FROM ss_assistant_msgs
        WHERE {where}
        ORDER BY timestamp, session_file, seq
    """
    out: list[TextBacktest] = []
    for row in conn.execute(sql, params):
        if row["text_blob"]:
            out.append(
                evaluate_text_row(
                    row,
                    "assistant_text",
                    row["text_blob"],
                    args.strategy,
                    not args.no_fence_context,
                    args.include_nullish,
                )
            )
        if row["thinking_blob"]:
            out.append(
                evaluate_text_row(
                    row,
                    "assistant_thinking",
                    row["thinking_blob"],
                    args.strategy,
                    not args.no_fence_context,
                    args.include_nullish,
                )
            )
    return out


def print_counter(title: str, counter: Counter[str]) -> None:
    print(title)
    for key, value in counter.most_common():
        print(f"  {key:<32} {value:>6}")


def print_tool_summary(results: list[ToolBacktest]) -> None:
    print("=== tool-call scan ===")
    print(f"candidate rows: {commas(len(results))}")
    print_counter("\nby action:", Counter(r.action for r in results))
    print_counter(
        "\nby tool/action:", Counter(f"{r.tool_name}:{r.action}" for r in results)
    )
    print_counter(
        "\nby model/action:",
        Counter(f"{r.model or '<unknown>'}:{r.action}" for r in results),
    )
    signal_counter: Counter[str] = Counter()
    for r in results:
        if r.signals:
            signal_counter.update(r.signals)
        else:
            signal_counter["none"] += 1
    print_counter("\nby signal:", signal_counter)

    edit_results = [r for r in results if r.tool_name == "edit"]
    if edit_results:
        sanitized = sum(1 for r in edit_results if r.action == "sanitize_tail")
        aborted = sum(1 for r in edit_results if r.action == "abort_replay")
        print("\nedit preservation:")
        print(f"  edit candidates:              {commas(len(edit_results))}")
        print(f"  sanitize_tail:                {commas(sanitized)}")
        print(f"  abort_replay:                 {commas(aborted)}")
        if sanitized:
            preserved_ops = sum(
                r.edit_ops for r in edit_results if r.action == "sanitize_tail"
            )
            preserved_payload = sum(
                r.edit_payload_lines
                for r in edit_results
                if r.action == "sanitize_tail"
            )
            removed = sum(
                r.removed_len for r in edit_results if r.action == "sanitize_tail"
            )
            print(f"  ops preserved by sanitize:    {commas(preserved_ops)}")
            print(f"  payload lines preserved:      {commas(preserved_payload)}")
            print(f"  tail bytes removed:           {commas(removed)}")


def print_text_summary(results: list[TextBacktest]) -> None:
    if not results:
        return
    print("\n=== assistant message scan ===")
    print(f"candidate surfaces: {commas(len(results))}")
    print_counter("\nby action:", Counter(r.action for r in results))
    print_counter(
        "\nby surface/action:", Counter(f"{r.surface}:{r.action}" for r in results)
    )
    print_counter(
        "\nby model/action:",
        Counter(f"{r.model or '<unknown>'}:{r.action}" for r in results),
    )


def signal_summary(labels: list[str], limit: int = 6) -> str:
    if not labels:
        return "none"
    counts = Counter(labels)
    parts = [
        f"{label}x{count}" if count > 1 else label
        for label, count in counts.most_common(limit)
    ]
    rest = sum(counts.values()) - sum(count for _, count in counts.most_common(limit))
    if rest:
        parts.append(f"+{rest} more")
    return ",".join(parts)


def print_examples(results: list[ToolBacktest], show: int) -> None:
    if show <= 0:
        return
    print(f"\n=== sanitize_tail edit examples (up to {show}) ===")
    sanitize_examples = [
        r for r in results if r.tool_name == "edit" and r.action == "sanitize_tail"
    ]
    for r in sanitize_examples[:show]:
        print(
            f"\n[id={r.row_id} seq={r.seq} model={r.model} signals={signal_summary(r.signals)}]"
        )
        print(f"session: {r.session_file}")
        print(f"file(s): {', '.join(r.edit_files) if r.edit_files else '<none>'}")
        print(
            f"parsed_end={r.parsed_end} text_len={r.text_len} removed={r.removed_len} "
            f"sha16={r.removed_sha16} ops={r.edit_ops} payload={r.edit_payload_lines}"
        )
        print(f"last clean lines: {r.clean_preview}")
        print(f"removed preview:  {r.removed_preview}")

    print(f"\n=== abort_replay examples (up to {show}) ===")
    abort_examples = [r for r in results if r.action == "abort_replay"]
    for r in abort_examples[:show]:
        print(
            f"\n[id={r.row_id} tool={r.tool_name} surface={r.surface} seq={r.seq} model={r.model} signals={signal_summary(r.signals)}]"
        )
        print(f"session: {r.session_file}")
        if r.tool_name == "edit":
            print(
                f"parse={r.parse_reason} parsed_end={r.parsed_end} text_len={r.text_len} "
                f"ops={r.edit_ops} payload={r.edit_payload_lines} files={', '.join(r.edit_files) if r.edit_files else '<none>'}"
            )
        print(f"context: {r.context_preview}")


def write_json_report(
    path: Path, tools: list[ToolBacktest], texts: list[TextBacktest]
) -> None:
    def tool_dict(r: ToolBacktest) -> dict[str, Any]:
        return {
            "surface": r.surface,
            "row_id": r.row_id,
            "session_file": r.session_file,
            "seq": r.seq,
            "entry_id": r.entry_id,
            "call_id": r.call_id,
            "tool_name": r.tool_name,
            "model": r.model,
            "provider": r.provider,
            "action": r.action,
            "signals": r.signals,
            "signal_offsets": r.signal_offsets,
            "text_len": r.text_len,
            "parsed_end": r.parsed_end,
            "removed_len": r.removed_len,
            "removed_sha16": r.removed_sha16,
            "removed_preview": r.removed_preview,
            "clean_preview": r.clean_preview,
            "context_preview": r.context_preview,
            "edit_files": r.edit_files,
            "edit_ops": r.edit_ops,
            "edit_payload_lines": r.edit_payload_lines,
            "edit_deleted_lines": r.edit_deleted_lines,
            "parse_reason": r.parse_reason,
        }

    def text_dict(r: TextBacktest) -> dict[str, Any]:
        return {
            "surface": r.surface,
            "row_id": r.row_id,
            "session_file": r.session_file,
            "seq": r.seq,
            "entry_id": r.entry_id,
            "model": r.model,
            "provider": r.provider,
            "action": r.action,
            "signals": r.signals,
            "signal_offsets": r.signal_offsets,
            "text_len": r.text_len,
            "context_preview": r.context_preview,
        }

    payload = {
        "tool_calls": [tool_dict(r) for r in tools],
        "assistant_surfaces": [text_dict(r) for r in texts],
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Backtest Harmony leak detection/recovery against session-stats sqlite tables."
    )
    ap.add_argument("--db", type=Path, default=DB_PATH, help="stats sqlite path")
    ap.add_argument(
        "--strategy",
        choices=("marker", "fusion", "tail"),
        default="fusion",
        help=(
            "marker = trip on bare marker/control token; "
            "fusion = H or M plus co-signal; "
            "tail = only H or marker after parsed boundary"
        ),
    )
    ap.add_argument(
        "--provider", default=None, help="restrict tool/message rows to a provider"
    )
    ap.add_argument(
        "--model", default=None, help="restrict tool/message rows to a model"
    )
    ap.add_argument("--tool", default=None, help="restrict tool-call rows to one tool")
    ap.add_argument(
        "--include-assistant",
        action="store_true",
        help="also scan assistant text/thinking surfaces",
    )
    ap.add_argument(
        "--include-nullish",
        action="store_true",
        help="treat adjacent null/undefined as signal N",
    )
    ap.add_argument(
        "--no-fence-context",
        action="store_true",
        help="do not exempt Markdown fenced blocks",
    )
    ap.add_argument(
        "--legacy-loose-tail",
        action="store_true",
        help="model old raw-payload edit inputs as tail-sanitizable at first marker line",
    )
    ap.add_argument("--show", type=int, default=8, help="examples per action group")
    ap.add_argument(
        "--json-out", type=Path, default=None, help="write machine-readable report"
    )
    args = ap.parse_args()

    conn = open_ro(args.db)
    print("=== harmony leak backtest ===")
    print(f"db:        {args.db}")
    print(f"strategy:  {args.strategy}")
    print(
        f"fences:    {'ignored for action' if not args.no_fence_context else 'scanned as active text'}"
    )
    if args.legacy_loose_tail:
        print("legacy:   loose tail mode")
    if args.provider:
        print(f"provider:  {args.provider}")
    if args.model:
        print(f"model:     {args.model}")
    if args.tool:
        print(f"tool:      {args.tool}")
    print()

    tool_results = scan_tools(conn, args)
    text_results = scan_assistant(conn, args)

    print_tool_summary(tool_results)
    print_text_summary(text_results)
    print_examples(tool_results, args.show)

    if args.json_out is not None:
        write_json_report(args.json_out, tool_results, text_results)
        print(f"\nwrote JSON report: {args.json_out}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
