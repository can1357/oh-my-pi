#!/usr/bin/env python3
"""
Replay-based optimizer for the read tool's config.

Inputs (from ~/.omp/stats.db, since --since):
  * every `read` call's args  (selector / offset / limit / bare)
  * every result's `[Showing lines A-B of N]` footer  → actual returned
    range AND the file's total line count
  * every result's `[Output truncated` marker         → byte cap hit

For each (session, file) pair we replay the sequence under a candidate
config C = (default_page D, line cap L, byte cap B*) and add up:
   reads kept * estimated_tokens(range, file)  +  reads kept * ROUNDTRIP

`*` byte cap is modelled as "an explicit range read of size > B/avg_bpl is
clipped to floor(B/avg_bpl) lines" so we don't have to know raw bytes.

We sweep D and L over a grid, find the (D, L) minimizing simulated total
tokens, and verify the simulator reproduces the baseline within ~5% of the
actually-observed spend.

Output:
  scripts/session-stats/out/read-config-sweep.png
  console table with the recommended config + savings
"""

from __future__ import annotations

import argparse
import json
import math
import re
import sqlite3
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import NamedTuple

import matplotlib.pyplot as plt
import matplotlib.patches as mpatches
import numpy as np

DB_PATH = Path.home() / ".omp" / "stats.db"
OUT_DIR = Path(__file__).resolve().parent / "out"
DEFAULT_SINCE = "2026-05-04"

# Tool current values (packages/coding-agent/src/session/streaming-output.ts +
# tools/read.ts) — used for baseline comparison.
CURRENT_DEFAULT = 3000
CURRENT_LINE_CAP = 3000
CURRENT_BYTE_CAP = 50 * 1024  # 50 KB

# Average bytes per line — only used to convert byte cap → line cap when the
# model didn't pass an explicit limit. Computed at runtime from observed
# bytes_per_line per file, with this as a fallback for files we never saw.
FALLBACK_BPL = 60.0
FALLBACK_TPL = 12.0  # tokens per line if a file has no observed reads

# Cost of an extra tool roundtrip: at minimum the assistant text+thinking
# preceding the call (median ~120-250 tokens) + the call envelope + the
# result-header overhead. We charge a flat 200 tokens per call kept; the
# answer is qualitatively stable across 50-400.
ROUNDTRIP_OVERHEAD = 200

# Selector parser (reuses the same rules as analyze_selector_reads.py).
_RANGE_RE = re.compile(r"^(\d+)(?:([-+])(\d+))?$")
_FOOTER_RE = re.compile(r"\[Showing lines (\d+)-(\d+) of (\d+)\.")
_TRUNCATED_RE = re.compile(r"\[Output truncated")


# --------------------------------------------------------------------------- #
# Selector → intent


class Intent(NamedTuple):
    kind: str  # 'bare' | 'range' | 'raw' | 'conflicts' | 'other'
    start: int | None  # requested start line (1-indexed) — only meaningful for 'range'
    end: int | None  # requested end line  (1-indexed, inclusive) — None = open-ended


def parse_selector(path: str) -> tuple[str, Intent]:
    tail_idx = path.rfind("/")
    tail = path[tail_idx + 1 :]
    colon = tail.rfind(":")
    if colon < 0:
        return path, Intent("bare", None, None)
    suffix = tail[colon + 1 :]
    base = (path[: tail_idx + 1] + tail[:colon]) if tail_idx >= 0 else tail[:colon]
    if suffix == "raw":
        return base, Intent("raw", None, None)
    if suffix == "conflicts":
        return base, Intent("conflicts", None, None)
    m = _RANGE_RE.match(suffix)
    if not m:
        return path, Intent("other", None, None)
    s = int(m.group(1))
    op, nval = m.group(2), m.group(3)
    if op == "-" and nval is not None:
        return base, Intent("range", s, int(nval))
    if op == "+" and nval is not None:
        return base, Intent("range", s, s + int(nval) - 1)
    return base, Intent("range", s, None)  # open-ended `:N`


def parse_args(arg_json: str | None) -> tuple[str | None, Intent]:
    if not arg_json:
        return None, Intent("other", None, None)
    try:
        obj = json.loads(arg_json)
    except json.JSONDecodeError:
        return None, Intent("other", None, None)
    path = obj.get("path")
    if not isinstance(path, str):
        return None, Intent("other", None, None)
    base, intent = parse_selector(path)
    if intent.kind != "bare":
        return base, intent
    # Legacy offset/limit treated as an explicit range.
    offset = obj.get("offset")
    limit = obj.get("limit")
    if (
        isinstance(offset, int)
        and isinstance(limit, int)
        and offset >= 1
        and limit >= 1
    ):
        return path, Intent("range", offset, offset + limit - 1)
    if isinstance(offset, int) and offset >= 1:
        return path, Intent("range", offset, None)
    return path, Intent("bare", None, None)


# --------------------------------------------------------------------------- #
# Footer parser → (returned_start, returned_end, file_total_lines)


def parse_footer(tail: str | None) -> tuple[int | None, int | None, int | None, bool]:
    """Returns (returned_a, returned_b, file_total, was_byte_truncated)."""
    if not tail:
        return None, None, None, False
    m = _FOOTER_RE.search(tail)
    if not m:
        return None, None, None, bool(_TRUNCATED_RE.search(tail))
    return (
        int(m.group(1)),
        int(m.group(2)),
        int(m.group(3)),
        bool(_TRUNCATED_RE.search(tail)),
    )


# --------------------------------------------------------------------------- #
# Coverage utilities


def merge(ivs: list[tuple[int, int]]) -> list[tuple[int, int]]:
    if not ivs:
        return []
    ivs = sorted(ivs)
    out = [ivs[0]]
    for s, e in ivs[1:]:
        ls, le = out[-1]
        if s <= le + 1:
            out[-1] = (ls, max(le, e))
        else:
            out.append((s, e))
    return out


def contained(s: int, e: int, ivs: list[tuple[int, int]]) -> bool:
    for ls, le in ivs:
        if ls <= s and le >= e:
            return True
    return False


def subtract(s: int, e: int, ivs: list[tuple[int, int]]) -> list[tuple[int, int]]:
    """Return [s,e] minus the union of `ivs` as a list of remaining intervals."""
    out = [(s, e)]
    for ls, le in ivs:
        new = []
        for a, b in out:
            if le < a or ls > b:
                new.append((a, b))
                continue
            if ls > a:
                new.append((a, ls - 1))
            if le < b:
                new.append((le + 1, b))
        out = new
        if not out:
            break
    return out


# --------------------------------------------------------------------------- #
# Data model


class ReadCall(NamedTuple):
    seq: int
    intent: Intent
    base: str
    actual_a: int | None  # what came back: lines [actual_a, actual_b]
    actual_b: int | None
    file_total: int | None  # from footer
    tokens: int  # observed result tokens
    was_truncated: bool  # [Output truncated marker present


def fetch_reads(conn: sqlite3.Connection, since_ms: int) -> list[tuple[str, ReadCall]]:
    """Returns list of (session, ReadCall) in (session, seq) order."""
    # Pull only the last 320 bytes of result_text — enough for the footer +
    # truncation marker, keeps the working set small.
    sql = """
        SELECT c.session_file,
               c.seq,
               c.arg_json,
               COALESCE(r.result_tokens, 0) AS tokens,
               substr(COALESCE(r.result_text, ''),
                      MAX(1, LENGTH(COALESCE(r.result_text, '')) - 320))
                 AS tail
        FROM ss_tool_calls c
        LEFT JOIN ss_tool_results r
               ON r.session_file = c.session_file
              AND r.call_id      = c.call_id
              AND r.seq          >= c.seq
        WHERE c.tool_name = 'read' AND c.timestamp >= ?
        ORDER BY c.session_file, c.seq
    """
    out: list[tuple[str, ReadCall]] = []
    for session, seq, arg_json, tokens, tail in conn.execute(sql, (since_ms,)):
        base, intent = parse_args(arg_json)
        if not base or base.endswith("/") or "://" in base:
            continue
        actual_a, actual_b, file_total, was_trunc = parse_footer(tail)
        out.append(
            (
                session,
                ReadCall(
                    seq,
                    intent,
                    base,
                    actual_a,
                    actual_b,
                    file_total,
                    int(tokens),
                    was_trunc,
                ),
            )
        )
    return out


# --------------------------------------------------------------------------- #
# Per-file aggregates


class FileStats(NamedTuple):
    size_lines: int  # best-effort estimate
    tokens_per_line: float
    bytes_per_line: float  # only when we can derive (currently we can't, so fallback)


def aggregate_files(reads: list[tuple[str, ReadCall]]) -> dict[str, FileStats]:
    """Estimate per-file size + tokens/line from observed reads.

    size_lines:
      - if any footer reported `of N`, use the max N seen for this file (most
        reads agree but files grow over time).
      - else fall back to max(actual_b or intent.end) ever observed.
    tokens_per_line:
      - weighted average of (tokens / lines_returned) across reads of this file
        that have a footer (so we know `lines_returned`).
    """
    by_file_total_lines: dict[str, int] = {}
    by_file_max_end: dict[str, int] = {}
    by_file_tok_lines: dict[str, list[tuple[int, int]]] = defaultdict(list)

    for _session, rc in reads:
        if rc.file_total:
            prev = by_file_total_lines.get(rc.base, 0)
            if rc.file_total > prev:
                by_file_total_lines[rc.base] = rc.file_total
        # Track max line ever observed.
        cands = [v for v in (rc.actual_b, rc.intent.end) if v is not None]
        if cands:
            cur = max(cands)
            prev = by_file_max_end.get(rc.base, 0)
            if cur > prev:
                by_file_max_end[rc.base] = cur
        # tok/line: only when we know how many lines came back AND tokens > 0.
        if rc.actual_a is not None and rc.actual_b is not None and rc.tokens > 0:
            n = rc.actual_b - rc.actual_a + 1
            if n > 0:
                by_file_tok_lines[rc.base].append((rc.tokens, n))

    out: dict[str, FileStats] = {}
    files = set(by_file_total_lines) | set(by_file_max_end) | set(by_file_tok_lines)
    for f in files:
        size = by_file_total_lines.get(f) or by_file_max_end.get(f, 1)
        tok_lines = by_file_tok_lines.get(f, [])
        if tok_lines:
            tot_tok = sum(t for t, _ in tok_lines)
            tot_ln = sum(n for _, n in tok_lines)
            tpl = tot_tok / max(tot_ln, 1)
        else:
            tpl = FALLBACK_TPL
        out[f] = FileStats(
            size_lines=size, tokens_per_line=tpl, bytes_per_line=max(8.0, tpl * 4.0)
        )
    return out


# --------------------------------------------------------------------------- #
# Per-pair grouping


def group_pairs(
    reads: list[tuple[str, ReadCall]],
) -> dict[tuple[str, str], list[ReadCall]]:
    by_pair: dict[tuple[str, str], list[ReadCall]] = defaultdict(list)
    for session, rc in reads:
        by_pair[(session, rc.base)].append(rc)
    # Already sorted by session, seq from the SQL.
    return by_pair


# --------------------------------------------------------------------------- #
# Simulator


class Config(NamedTuple):
    default_page: int  # lines returned for a bare path read
    line_cap: int  # absolute max lines per read
    byte_cap: int  # max bytes per read (modelled as line cap via bytes_per_line)
    summarize_min: int  # min file size (lines) for summarizer to fire on bare reads
    # (-1 disables summarizer; 0 = always)


def effective_returned(
    rc: ReadCall, fs: FileStats, cfg: Config
) -> tuple[int, int] | None:
    """Range the tool actually returns for one call under cfg.

    Honours intent (what the agent asked for), then applies (default_page,
    line_cap, byte_cap, file_size) as bounding constraints. Returns None for
    intents without line bounds (conflicts/other).

    The model is one observed call → one simulated call: we do NOT generate
    synthetic follow-ups when the cap shrinks the response. If the original
    session needed more lines, those follow-ups will appear as their own
    observed calls in the same pair.
    """
    intent = rc.intent
    size = max(fs.size_lines, 1)
    if intent.kind == "bare":
        start, end_intent = 1, cfg.default_page
    elif intent.kind == "range":
        start = intent.start or 1
        end_intent = (
            intent.end if intent.end is not None else (start + cfg.default_page - 1)
        )
    elif intent.kind == "raw":
        start, end_intent = 1, size
    else:
        return None
    end = min(end_intent, size, start + cfg.line_cap - 1)
    if fs.bytes_per_line > 0:
        end = min(end, start + max(1, int(cfg.byte_cap / fs.bytes_per_line)) - 1)
    if end < start:
        end = start
    return (start, end)


def cost_of_chunk(
    start: int, end: int, fs: FileStats, intent_kind: str, cfg: Config
) -> float:
    """Estimated result tokens for returning [start, end] of this file."""
    span = max(end - start + 1, 0)
    raw = span * fs.tokens_per_line
    if (
        intent_kind == "bare"
        and cfg.summarize_min >= 0
        and fs.size_lines >= cfg.summarize_min
    ):
        # Calibrated from observed post-deploy summary-eligible reads:
        # tokens/line collapses to ~0.35× the verbatim rate.
        return raw * 0.35
    return raw


def chunk_range(s: int, e: int, fs: FileStats, cfg: Config) -> list[tuple[int, int]]:
    """Break [s, e] into chunks no larger than (line_cap, byte_cap)."""
    max_per_call = cfg.line_cap
    if fs.bytes_per_line > 0:
        max_per_call = min(max_per_call, max(1, int(cfg.byte_cap / fs.bytes_per_line)))
    out: list[tuple[int, int]] = []
    cur = s
    while cur <= e:
        end = min(cur + max_per_call - 1, e)
        out.append((cur, end))
        cur = end + 1
    return out


def replay_pair(reads: list[ReadCall], fs: FileStats, cfg: Config) -> tuple[float, int]:
    """Estimated tokens + calls for one (session, file).

    Two-phase replay:
      1. For every observed call, compute the new returned range under cfg.
         Drop if fully covered; otherwise charge tokens + roundtrip and fold
         it into the simulated coverage.
      2. Compare simulated coverage against what the agent ACTUALLY received
         (union of observed returned ranges). Any shortfall is filled by
         synthetic chunks at (line_cap, byte_cap) granularity, charged at
         tokens + roundtrip. Phase 2 prevents the simulator from claiming
         free savings by silently returning fewer lines than the agent
         demonstrably needed.
    """
    covered: list[tuple[int, int]] = []
    observed_needed: list[tuple[int, int]] = []
    total = 0.0
    kept = 0
    for rc in reads:
        if (
            rc.actual_a is not None
            and rc.actual_b is not None
            and rc.actual_b >= rc.actual_a
        ):
            observed_needed.append((rc.actual_a, rc.actual_b))
        ret = effective_returned(rc, fs, cfg)
        if ret is None:
            continue
        s, e = ret
        if contained(s, e, covered):
            continue
        total += cost_of_chunk(s, e, fs, rc.intent.kind, cfg)
        total += ROUNDTRIP_OVERHEAD
        kept += 1
        covered.append((s, e))
        covered = merge(covered)
    # Shortfall: lines the agent originally read that sim never delivered.
    observed_needed = merge(observed_needed)
    gaps: list[tuple[int, int]] = []
    for need_s, need_e in observed_needed:
        gaps.extend(subtract(need_s, need_e, covered))
    for gap_s, gap_e in gaps:
        for cs, ce in chunk_range(gap_s, gap_e, fs, cfg):
            total += cost_of_chunk(cs, ce, fs, "range", cfg)
            total += ROUNDTRIP_OVERHEAD
            kept += 1
            covered.append((cs, ce))
        covered = merge(covered)
    return total, kept


def simulate(
    by_pair: dict, files: dict[str, FileStats], cfg: Config
) -> tuple[float, int]:
    grand = 0.0
    kept = 0
    for (_session, base), reads in by_pair.items():
        fs = files.get(base) or FileStats(
            size_lines=1, tokens_per_line=FALLBACK_TPL, bytes_per_line=FALLBACK_BPL
        )
        t, k = replay_pair(reads, fs, cfg)
        grand += t
        kept += k
    return grand, kept


def baseline_observed(reads: list[tuple[str, ReadCall]]) -> tuple[int, int]:
    """Actual observed token spend (sum of result_tokens) and call count."""
    tot = sum(rc.tokens for _, rc in reads)
    return tot, len(reads)


# --------------------------------------------------------------------------- #
# Sweep + report


def sweep(by_pair: dict, files: dict[str, FileStats]) -> dict:
    defaults = [200, 300, 400, 500, 700, 1000, 1500, 2000, 3000]
    line_caps = [500, 1000, 1500, 2000, 3000, 5000]
    summary_thresholds = [-1, 0, 50, 150, 300, 600]  # min file size to summarize

    grid_tokens = np.zeros((len(defaults), len(line_caps)))
    grid_calls = np.zeros((len(defaults), len(line_caps)), dtype=np.int64)
    for i, D in enumerate(defaults):
        for j, L in enumerate(line_caps):
            cfg = Config(
                default_page=D, line_cap=L, byte_cap=CURRENT_BYTE_CAP, summarize_min=0
            )
            t, k = simulate(by_pair, files, cfg)
            grid_tokens[i, j] = t
            grid_calls[i, j] = k

    # Best (D, L) for fixed summarize_min=0.
    flat = np.argmin(grid_tokens)
    i_best, j_best = np.unravel_index(flat, grid_tokens.shape)
    best_DL = (defaults[i_best], line_caps[j_best])

    # Sweep summarize_min at best (D, L).
    sm_tokens = []
    for sm in summary_thresholds:
        cfg = Config(
            default_page=best_DL[0],
            line_cap=best_DL[1],
            byte_cap=CURRENT_BYTE_CAP,
            summarize_min=sm,
        )
        t, k = simulate(by_pair, files, cfg)
        sm_tokens.append((sm, t, k))
    best_sm = min(sm_tokens, key=lambda x: x[1])

    # Sweep byte_cap at best (D, L, summarize_min).
    byte_caps = [
        16 * 1024,
        32 * 1024,
        50 * 1024,
        75 * 1024,
        100 * 1024,
        150 * 1024,
        200 * 1024,
    ]
    bc_tokens = []
    for bc in byte_caps:
        cfg = Config(
            default_page=best_DL[0],
            line_cap=best_DL[1],
            byte_cap=bc,
            summarize_min=best_sm[0],
        )
        t, k = simulate(by_pair, files, cfg)
        bc_tokens.append((bc, t, k))
    best_bc = min(bc_tokens, key=lambda x: x[1])

    # Final combined config (D, L, summarize_min, byte_cap) — should be the
    # global minimum given the order of dimensions.
    final_cfg = Config(
        default_page=best_DL[0],
        line_cap=best_DL[1],
        byte_cap=best_bc[0],
        summarize_min=best_sm[0],
    )
    final_tokens, final_calls = simulate(by_pair, files, final_cfg)

    return {
        "defaults": defaults,
        "line_caps": line_caps,
        "grid_tokens": grid_tokens,
        "grid_calls": grid_calls,
        "best_DL": best_DL,
        "summary_sweep": sm_tokens,
        "best_summary": best_sm,
        "byte_cap_sweep": bc_tokens,
        "best_byte_cap": best_bc,
        "final_cfg": final_cfg,
        "final_tokens": final_tokens,
        "final_calls": final_calls,
    }


# --------------------------------------------------------------------------- #
# Plotting


def plot(result: dict, baseline_sim: float, observed: int, out_path: Path) -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    plt.rcParams.update({"figure.dpi": 110, "font.size": 10})

    fig, axes = plt.subplots(2, 2, figsize=(15, 11))

    # Heatmap: relative to baseline (current config).
    ax = axes[0, 0]
    grid = result["grid_tokens"]
    rel = grid / baseline_sim
    im = ax.imshow(
        rel,
        cmap="RdYlGn_r",
        aspect="auto",
        origin="lower",
        vmin=max(0.6, rel.min()),
        vmax=min(1.4, rel.max() + 0.02),
    )
    ax.set_xticks(range(len(result["line_caps"])))
    ax.set_xticklabels(result["line_caps"])
    ax.set_yticks(range(len(result["defaults"])))
    ax.set_yticklabels(result["defaults"])
    ax.set_xlabel("line cap (L)")
    ax.set_ylabel("default page (D)")
    ax.set_title("simulated read tokens / baseline\n(green = cheaper, red = more)")
    for i in range(grid.shape[0]):
        for j in range(grid.shape[1]):
            ax.text(
                j,
                i,
                f"{rel[i, j]:.2f}",
                ha="center",
                va="center",
                color="black",
                fontsize=8,
            )
    fig.colorbar(im, ax=ax, fraction=0.05)
    # Highlight current and best.
    cur_i = (
        result["defaults"].index(CURRENT_DEFAULT)
        if CURRENT_DEFAULT in result["defaults"]
        else None
    )
    cur_j = (
        result["line_caps"].index(CURRENT_LINE_CAP)
        if CURRENT_LINE_CAP in result["line_caps"]
        else None
    )
    if cur_i is not None and cur_j is not None:
        ax.add_patch(
            mpatches.Rectangle(
                (cur_j - 0.5, cur_i - 0.5),
                1,
                1,
                fill=False,
                edgecolor="#1d4ed8",
                linewidth=2.4,
                label="current",
            )
        )
    best_i = result["defaults"].index(result["best_DL"][0])
    best_j = result["line_caps"].index(result["best_DL"][1])
    ax.add_patch(
        mpatches.Rectangle(
            (best_j - 0.5, best_i - 0.5),
            1,
            1,
            fill=False,
            edgecolor="#000",
            linewidth=2.4,
            linestyle="--",
            label="optimum",
        )
    )
    ax.legend(loc="upper right", frameon=True, fontsize=9)

    # Default-page line (at best line cap).
    ax = axes[0, 1]
    best_L = result["best_DL"][1]
    j = result["line_caps"].index(best_L)
    col = grid[:, j] / baseline_sim
    ax.plot(result["defaults"], col, marker="o", linewidth=1.8, color="#0f766e")
    ax.axhline(1.0, color="#9ca3af", linestyle="--", linewidth=1.0)
    ax.axvline(
        CURRENT_DEFAULT,
        color="#1d4ed8",
        linestyle=":",
        linewidth=1.2,
        label="current default",
    )
    best_D = result["best_DL"][0]
    ax.axvline(
        best_D, color="#000", linestyle="--", linewidth=1.4, label=f"optimum D={best_D}"
    )
    ax.set_xscale("log")
    ax.set_xlabel("default page (D) — log scale")
    ax.set_ylabel("simulated tokens / baseline")
    ax.set_title(f"sensitivity to default page  (line cap fixed at L={best_L})")
    ax.grid(True, alpha=0.25, linestyle="--")
    ax.legend(loc="best", frameon=False)

    # Summarizer threshold sweep.
    ax = axes[1, 0]
    sm_data = result["summary_sweep"]
    xs = [
        str("off") if sm == -1 else ("always" if sm == 0 else f"≥{sm}")
        for sm, _, _ in sm_data
    ]
    ys = [t / baseline_sim for _, t, _ in sm_data]
    bars = ax.bar(
        xs,
        ys,
        color=["#dc2626" if y > 1 else "#0f766e" for y in ys],
        edgecolor="#111",
        linewidth=0.5,
    )
    for bar, y in zip(bars, ys):
        ax.text(
            bar.get_x() + bar.get_width() / 2,
            y + 0.005,
            f"{(y - 1) * 100:+.1f}%",
            ha="center",
            va="bottom",
            fontsize=9,
        )
    ax.axhline(1.0, color="#9ca3af", linestyle="--", linewidth=1.0)
    ax.set_ylabel("simulated tokens / baseline")
    ax.set_xlabel("summarize files ≥ N lines")
    ax.set_title(
        f"summarizer threshold sweep  (D={result['best_DL'][0]}, L={result['best_DL'][1]})"
    )
    ax.grid(True, axis="y", alpha=0.25, linestyle="--")

    # Byte cap sweep.
    ax = axes[1, 1]
    bc_data = result["byte_cap_sweep"]
    xs_kb = [bc // 1024 for bc, _, _ in bc_data]
    ys = [t / baseline_sim for _, t, _ in bc_data]
    ax.plot(xs_kb, ys, marker="o", linewidth=1.8, color="#7c3aed")
    ax.axhline(1.0, color="#9ca3af", linestyle="--", linewidth=1.0)
    ax.axvline(
        CURRENT_BYTE_CAP / 1024,
        color="#1d4ed8",
        linestyle=":",
        linewidth=1.2,
        label="current byte cap",
    )
    best_bc_kb = result["best_byte_cap"][0] // 1024
    ax.axvline(
        best_bc_kb,
        color="#000",
        linestyle="--",
        linewidth=1.4,
        label=f"optimum {best_bc_kb} KB",
    )
    ax.set_xlabel("byte cap (KB)")
    ax.set_ylabel("simulated tokens / baseline")
    ax.set_title("sensitivity to byte cap")
    ax.grid(True, alpha=0.25, linestyle="--")
    ax.legend(loc="best", frameon=False)

    fig.suptitle(
        f"read tool config sweep — observed read spend {observed:,}, "
        f"simulator baseline {baseline_sim:,.0f}",
        fontsize=12,
        y=1.02,
    )
    fig.tight_layout()
    fig.savefig(out_path, bbox_inches="tight")
    plt.close(fig)


# --------------------------------------------------------------------------- #
# Report


def fmt_pct(x: float) -> str:
    if x >= 0:
        return f"+{x * 100:.1f}%"
    return f"{x * 100:.1f}%"


def report(
    result: dict,
    baseline_sim: float,
    baseline_calls: int,
    observed: int,
    observed_calls: int,
) -> None:
    defaults = result["defaults"]
    line_caps = result["line_caps"]
    grid = result["grid_tokens"]
    calls = result["grid_calls"]

    print(f"\nbaseline (current config: D={CURRENT_DEFAULT}, L={CURRENT_LINE_CAP}):")
    print(f"  observed result tokens   = {observed:>13,}  (truth)")
    print(
        f"  simulator under baseline = {baseline_sim:>13,.0f}  "
        f"({fmt_pct((baseline_sim - observed) / observed)} vs observed)"
    )
    print(f"  observed read calls      = {observed_calls:>13,}")
    print(f"  simulator calls (baseline) = {baseline_calls:>11,}")

    # Sweep table.
    print(f"\nsimulated read tokens (× of baseline) by (D, L):")
    header = "  D \\ L     " + "  ".join(f"{L:>6}" for L in line_caps)
    print(header)
    for i, D in enumerate(defaults):
        row = "  ".join(
            f"{grid[i, j] / baseline_sim:>6.2f}" for j in range(len(line_caps))
        )
        print(f"  D={D:<6}  {row}")
    print(
        f"\nbest (D, L) = {result['best_DL']} → "
        f"{grid[defaults.index(result['best_DL'][0]), line_caps.index(result['best_DL'][1])]:,.0f} tokens"
        f"  ({fmt_pct(grid.min() / baseline_sim - 1)})"
    )

    # Summarizer threshold sweep at best (D, L).
    print(f"\nsummarizer threshold sweep at best (D, L) = {result['best_DL']}:")
    print(f"  {'min_file_lines':<16} {'tokens':>12}  {'vs baseline':>12}")
    for sm, t, k in result["summary_sweep"]:
        label = "off" if sm == -1 else ("always" if sm == 0 else f">={sm}")
        print(f"  {label:<16} {t:>12,.0f}  {fmt_pct(t / baseline_sim - 1):>12}")
    print(
        f"\nbest summarize_min = {result['best_summary'][0]} → "
        f"{result['best_summary'][1]:,.0f} tokens  "
        f"({fmt_pct(result['best_summary'][1] / baseline_sim - 1)})"
    )

    # Byte cap sweep at (best D, L, summarize_min).
    print(f"\nbyte cap sweep at best (D, L, summarize_min):")
    print(f"  {'byte_cap':<10} {'tokens':>12}  {'vs baseline':>12}")
    for bc, t, k in result["byte_cap_sweep"]:
        print(
            f"  {bc // 1024:>4} KB    {t:>12,.0f}  {fmt_pct(t / baseline_sim - 1):>12}"
        )
    print(
        f"\nbest byte_cap = {result['best_byte_cap'][0] // 1024} KB → "
        f"{result['best_byte_cap'][1]:,.0f} tokens  "
        f"({fmt_pct(result['best_byte_cap'][1] / baseline_sim - 1)})"
    )

    # Final recommendation.
    cfg = result["final_cfg"]
    print("\n" + "=" * 64)
    print("  RECOMMENDED CONFIG")
    print("=" * 64)
    print(
        f"  read.defaultLimit   {cfg.default_page} lines   (current: {CURRENT_DEFAULT})"
    )
    print(f"  read.lineCap        {cfg.line_cap} lines   (current: {CURRENT_LINE_CAP})")
    print(
        f"  read.byteCap        {cfg.byte_cap // 1024} KB    (current: {CURRENT_BYTE_CAP // 1024} KB)"
    )
    sm_label = (
        "off"
        if cfg.summarize_min == -1
        else (
            "always"
            if cfg.summarize_min == 0
            else f"only files ≥ {cfg.summarize_min} lines"
        )
    )
    print(f"  read.summarizer     {sm_label}")
    print(
        f"  simulated savings   {fmt_pct(result['final_tokens'] / baseline_sim - 1)}  "
        f"({baseline_sim - result['final_tokens']:,.0f} fewer tokens / window)"
    )
    print(
        f"  calls               {result['final_calls']:,}  "
        f"(baseline sim: {baseline_calls:,})"
    )


# --------------------------------------------------------------------------- #
# Entry


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[1])
    ap.add_argument("--since", default=DEFAULT_SINCE)
    args = ap.parse_args()

    since = datetime.strptime(args.since, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    since_ms = int(since.timestamp() * 1000)

    if not DB_PATH.exists():
        sys.exit(f"db missing: {DB_PATH}")
    conn = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
    print(f"loading reads since {args.since}...")
    reads = fetch_reads(conn, since_ms)
    conn.close()
    print(f"  {len(reads):,} read calls")

    # Per-file aggregates.
    files = aggregate_files(reads)
    sizes = np.array([f.size_lines for f in files.values()], dtype=np.int64)
    tpls = np.array([f.tokens_per_line for f in files.values()], dtype=float)
    print(f"  {len(files):,} distinct files")
    print(
        f"  file size      p50={int(np.percentile(sizes, 50))}  "
        f"p90={int(np.percentile(sizes, 90))}  max={int(sizes.max())}"
    )
    print(
        f"  tokens/line    p50={np.percentile(tpls, 50):.2f}  "
        f"p90={np.percentile(tpls, 90):.2f}  max={tpls.max():.2f}"
    )

    # Per-pair.
    by_pair = group_pairs(reads)
    print(f"  {len(by_pair):,} (session, file) pairs")

    # Baseline simulation.
    print("\nsimulating baseline...")
    baseline_cfg = Config(
        default_page=CURRENT_DEFAULT,
        line_cap=CURRENT_LINE_CAP,
        byte_cap=CURRENT_BYTE_CAP,
        summarize_min=0,
    )
    baseline_sim, baseline_calls = simulate(by_pair, files, baseline_cfg)
    observed, observed_calls = baseline_observed(reads)

    print("sweeping (default_page, line_cap, summarize_min)...")
    result = sweep(by_pair, files)

    report(result, baseline_sim, baseline_calls, observed, observed_calls)

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out = OUT_DIR / "read-config-sweep.png"
    plot(result, baseline_sim, observed, out)
    print(f"\nwrote {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
