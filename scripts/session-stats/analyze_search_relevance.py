#!/usr/bin/env python3
"""
How relevant are search/grep results?

For every search/grep call we extract the list of distinct file paths the
result mentioned (in order of first appearance), then look ahead at the
session's subsequent tool calls for engagement:

  ENGAGED-READ        : the model `read` a file from the result list.
                        We record the deepest index reached (1-based).
  NEXT-PAGE           : the model issued the same search/grep again with
                        `skip` or `offset` > 0 (asked for more results).
  REFINED             : the model issued a *different* search/grep before
                        engaging with any result (probably narrowed query).
  ABANDONED           : neither — switched topic / used something else.

Window: until the next user message, an end-of-session, or LOOKAHEAD calls,
whichever comes first.

Outputs scripts/session-stats/out/search-relevance.png.
"""

from __future__ import annotations

import argparse
import json
import re
import sqlite3
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np

DB_PATH = Path.home() / ".omp" / "stats.db"
OUT_DIR = Path(__file__).resolve().parent / "out"

DEFAULT_SINCE = "2026-04-01"  # search/grep traffic before this is sparse
LOOKAHEAD = 30  # max tool calls to scan after a search


# --------------------------------------------------------------------------- #
# Path extraction from result_text

# Tree-style headers: `# packages/foo/bar` then `## └─ file.ext`
_TREE_DIR = re.compile(r"^#\s+(\S[^\n]*?)\s*$", re.M)
_TREE_FILE = re.compile(r"^##\s+└─\s+(\S[^\n]*?)\s*$", re.M)
# Flat path with line marker: `path/to/file.ext:fn_X>14|…` or `path:14|…`
# Require an extension on the filename so we don't match anchor-prefixed
# in-file results (`1136xo|…`).
_FLAT_PATH = re.compile(
    r"(?m)^\s*([A-Za-z0-9_./~+\-][A-Za-z0-9_./~+\-]*\.[A-Za-z0-9]{1,8})[:#]",
)


def extract_paths(result_text: str | None) -> tuple[list[str], dict[str, int]]:
    """Returns (distinct paths in order, dict of path -> match-line count).

    A "match line" is any indented match row attributed to that file
    (tree format) or any line starting with `<path>:` (flat format).
    Header lines and directory headers don't count.
    """
    if not result_text:
        return [], {}
    seen: dict[str, None] = {}
    counts: dict[str, int] = {}

    current_dir: str | None = None
    current_file: str | None = None
    for line in result_text.splitlines():
        stripped = line.rstrip()
        # `## └─ filename` — new file under current_dir.
        m = _TREE_FILE.match(stripped)
        if m and current_dir is not None:
            path = f"{current_dir.rstrip('/')}/{m.group(1).strip()}"
            seen.setdefault(path, None)
            counts.setdefault(path, 0)
            current_file = path
            continue
        # `# dir` — directory header.
        m = _TREE_DIR.match(stripped)
        if m:
            current_dir = m.group(1).strip()
            current_file = None
            continue
        # Flat path with line marker (`path/file.ext:14|…`).
        flat_match = None
        for fm in _FLAT_PATH.finditer(stripped):
            flat_match = fm
        if flat_match is not None:
            p = flat_match.group(1)
            seen.setdefault(p, None)
            counts[p] = counts.get(p, 0) + 1
            current_file = None
            continue
        # Otherwise treat as a body row for the most recently named file.
        if current_file is not None and stripped:
            # Skip anchor markers like `@imp_2#WJMV` and pure separators.
            if stripped.startswith(("@", "-@", "----@", "#")):
                continue
            counts[current_file] = counts.get(current_file, 0) + 1

    return list(seen.keys()), counts


# --------------------------------------------------------------------------- #
# Tool-call helpers


def search_signature(arg_obj: dict) -> tuple:
    """Stable identity key for a search/grep call: (pattern, path-scope).

    `pattern` is the regex/text query. `path` may be a single string or
    list. Skip / offset / limit are deliberately excluded — they're the
    pagination axis we want to detect.
    """
    pattern = arg_obj.get("pattern")
    path = arg_obj.get("path") or arg_obj.get("paths")
    if isinstance(path, list):
        path = tuple(sorted(str(p) for p in path))
    elif isinstance(path, str):
        path = (path,)
    else:
        path = ()
    return (pattern, path)


def search_offset(arg_obj: dict) -> int:
    for key in ("skip", "offset"):
        v = arg_obj.get(key)
        if isinstance(v, int):
            return v
        if isinstance(v, str):
            try:
                return int(v)
            except ValueError:
                continue
    return 0


def read_path(arg_obj: dict) -> str | None:
    p = arg_obj.get("path")
    if not isinstance(p, str):
        return None
    # Strip selector for path matching.
    tail_idx = p.rfind("/")
    tail = p[tail_idx + 1 :]
    colon = tail.rfind(":")
    if colon > 0:
        return p[: tail_idx + 1] + tail[:colon] if tail_idx >= 0 else tail[:colon]
    return p


# --------------------------------------------------------------------------- #
# Per-session walk


def classify_sessions(conn: sqlite3.Connection, since_ms: int) -> list[dict]:
    """Walks each session in seq order, classifying every search/grep call."""
    # Pull calls + paired results in one ordered stream per session.
    sql = """
        SELECT
            c.session_file, c.seq, c.tool_name, c.arg_json,
            r.result_text
        FROM ss_tool_calls c
        LEFT JOIN ss_tool_results r
               ON r.session_file = c.session_file
              AND r.call_id      = c.call_id
              AND r.seq          >= c.seq
        WHERE c.timestamp >= ?
        ORDER BY c.session_file, c.seq
    """
    by_session: dict[str, list[tuple]] = defaultdict(list)
    for row in conn.execute(sql, (since_ms,)):
        by_session[row[0]].append(row[1:])

    # Also need user message seqs for window cutoffs.
    user_seqs: dict[str, list[int]] = defaultdict(list)
    for sess, seq in conn.execute(
        "SELECT session_file, seq FROM ss_user_msgs WHERE timestamp >= ? ORDER BY session_file, seq",
        (since_ms,),
    ):
        user_seqs[sess].append(seq)

    records: list[dict] = []
    for sess, calls in by_session.items():
        user_msg_seqs = user_seqs.get(sess, [])
        for idx, (seq, tool, arg_json, result_text) in enumerate(calls):
            if tool not in ("search", "grep"):
                continue
            try:
                arg = json.loads(arg_json) if arg_json else {}
            except json.JSONDecodeError:
                continue
            sig = search_signature(arg)
            if sig[0] is None:
                continue
            paths, match_counts = extract_paths(result_text)
            if not paths:
                # Empty / unparseable results: skip — there's nothing to engage with.
                continue
            cutoff_seq = next((s for s in user_msg_seqs if s > seq), None)
            outcome = walk_ahead(calls, idx, sig, paths, cutoff_seq)
            outcome["session"] = sess
            outcome["seq"] = seq
            outcome["tool"] = tool
            outcome["pattern"] = sig[0]
            outcome["n_results"] = len(paths)
            outcome["matches_per_file"] = [match_counts.get(p, 0) for p in paths]
            records.append(outcome)
    return records


def walk_ahead(calls, idx, sig, paths, cutoff_seq) -> dict:
    """Scan forward from `idx` and classify what the model did with the result list."""
    path_to_index = {p: i for i, p in enumerate(paths)}
    deepest_index: int | None = None
    next_page = False
    refined = False
    engaged_count = 0

    upper = min(len(calls), idx + 1 + LOOKAHEAD)
    for j in range(idx + 1, upper):
        seq, tool, arg_json, _result = calls[j]
        if cutoff_seq is not None and seq >= cutoff_seq:
            break
        try:
            arg = json.loads(arg_json) if arg_json else {}
        except json.JSONDecodeError:
            continue

        if tool == "read":
            path = read_path(arg)
            if path is not None and path in path_to_index:
                deepest_index = max(deepest_index or 0, path_to_index[path])
                engaged_count += 1
            continue

        if tool in ("search", "grep"):
            other_sig = search_signature(arg)
            if other_sig == sig and search_offset(arg) > 0:
                next_page = True
                # Don't break — model may also read something afterward.
                continue
            if other_sig != sig:
                # Different query — flag as potential refinement, but keep
                # scanning in case the model later reads from THIS list.
                refined = True
            continue

    # Outcome label.
    if deepest_index is not None:
        outcome = "engaged-read"
    elif next_page:
        outcome = "next-page"
    elif refined:
        outcome = "refined"
    else:
        outcome = "abandoned"

    return {
        "outcome": outcome,
        "deepest_index": deepest_index,
        "engaged_count": engaged_count,
        "next_page": next_page,
        "refined": refined,
    }


# --------------------------------------------------------------------------- #
# Reporting

OUTCOME_COLORS = {
    "engaged-read": "#16a34a",
    "next-page": "#2563eb",
    "refined": "#d97706",
    "abandoned": "#9ca3af",
}


def report(records: list[dict]) -> None:
    if not records:
        print("no search/grep calls with extractable paths in window.")
        return
    total = len(records)
    by_outcome = defaultdict(int)
    for r in records:
        by_outcome[r["outcome"]] += 1

    print(f"\nsearch/grep calls analysed: {total:,}")
    print(f"  {'outcome':<14} {'count':>8}  {'share':>7}")
    for outcome in ("engaged-read", "next-page", "refined", "abandoned"):
        n = by_outcome.get(outcome, 0)
        print(f"  {outcome:<14} {n:>8,}  {100 * n / total:>6.1f}%")

    engaged = [r for r in records if r["outcome"] == "engaged-read"]
    if engaged:
        deepest = np.array([r["deepest_index"] for r in engaged], dtype=np.int64)
        result_counts = np.array([r["n_results"] for r in engaged], dtype=np.int64)
        # +1 because deepest_index is 0-based.
        deepest_1b = deepest + 1
        coverage = deepest_1b / result_counts
        engaged_n = np.array([r["engaged_count"] for r in engaged], dtype=np.int64)
        print(f"\nfor engaged-read calls (n={len(engaged):,}):")
        print(
            f"  deepest index reached       p50={int(np.median(deepest_1b))}  "
            f"p75={int(np.percentile(deepest_1b, 75))}  "
            f"p90={int(np.percentile(deepest_1b, 90))}  "
            f"max={int(deepest_1b.max())}"
        )
        print(
            f"  result list length          p50={int(np.median(result_counts))}  "
            f"p90={int(np.percentile(result_counts, 90))}  "
            f"max={int(result_counts.max())}"
        )
        print(
            f"  deepest / list size         p50={np.median(coverage) * 100:.0f}%  "
            f"p25={np.percentile(coverage, 25) * 100:.0f}%"
        )
        print(
            f"  reads per result list       p50={int(np.median(engaged_n))}  "
            f"p90={int(np.percentile(engaged_n, 90))}"
        )

    next_page = sum(1 for r in records if r["next_page"])
    refined = sum(1 for r in records if r["refined"])
    print(f"\nbehaviours (not exclusive):")
    print(
        f"  any next-page request   : {next_page:,}  ({100 * next_page / total:.1f}%)"
    )
    print(f"  any refined-query       : {refined:,}  ({100 * refined / total:.1f}%)")

    # Shape of result lists — files per result, matches per file, and whether
    # diversity (files-per-result / matches-per-file) correlates with engagement.
    files_per_result = np.array([r["n_results"] for r in records], dtype=np.int64)
    matches_per_file_flat = np.array(
        [m for r in records for m in r["matches_per_file"] if m > 0],
        dtype=np.int64,
    )
    print(f"\nresult shape across all {total:,} calls:")
    print(
        f"  files per result            "
        f"p50={int(np.median(files_per_result))}  "
        f"p75={int(np.percentile(files_per_result, 75))}  "
        f"p90={int(np.percentile(files_per_result, 90))}  "
        f"p99={int(np.percentile(files_per_result, 99))}  "
        f"max={int(files_per_result.max())}"
    )
    if matches_per_file_flat.size:
        print(
            f"  matches per file (flat)     "
            f"p50={int(np.median(matches_per_file_flat))}  "
            f"p75={int(np.percentile(matches_per_file_flat, 75))}  "
            f"p90={int(np.percentile(matches_per_file_flat, 90))}  "
            f"p99={int(np.percentile(matches_per_file_flat, 99))}  "
            f"max={int(matches_per_file_flat.max())}"
        )

    # Engagement vs shape: is the model more likely to read at all when there
    # are more distinct files? When matches are more concentrated per file?
    print(f"\nengagement vs result shape:")
    print(
        f"  {'files-per-result':<22} {'n calls':>9}  {'engaged %':>10}  {'p50 deepest':>12}"
    )
    bins = [
        (1, 1, "1"),
        (2, 2, "2"),
        (3, 5, "3-5"),
        (6, 10, "6-10"),
        (11, 20, "11-20"),
        (21, 50, "21-50"),
        (51, 10**9, "51+"),
    ]
    for lo, hi, label in bins:
        bucket = [r for r in records if lo <= r["n_results"] <= hi]
        if not bucket:
            continue
        eng = [r for r in bucket if r["outcome"] == "engaged-read"]
        eng_share = 100 * len(eng) / len(bucket)
        if eng:
            p50_deep = int(np.median([r["deepest_index"] + 1 for r in eng]))
        else:
            p50_deep = 0
        print(f"  {label:<22} {len(bucket):>9,}  {eng_share:>9.1f}%  {p50_deep:>12}")

    print(
        f"\n  {'max matches/file':<22} {'n calls':>9}  {'engaged %':>10}  {'p50 deepest':>12}"
    )
    bins = [
        (1, 1, "1"),
        (2, 5, "2-5"),
        (6, 20, "6-20"),
        (21, 100, "21-100"),
        (101, 10**9, "100+"),
    ]
    for lo, hi, label in bins:
        bucket = [
            r
            for r in records
            if r["matches_per_file"] and lo <= max(r["matches_per_file"]) <= hi
        ]
        if not bucket:
            continue
        eng = [r for r in bucket if r["outcome"] == "engaged-read"]
        eng_share = 100 * len(eng) / len(bucket)
        if eng:
            p50_deep = int(np.median([r["deepest_index"] + 1 for r in eng]))
        else:
            p50_deep = 0
        print(f"  {label:<22} {len(bucket):>9,}  {eng_share:>9.1f}%  {p50_deep:>12}")


# --------------------------------------------------------------------------- #
# Plot


def plot(records: list[dict], since: str) -> Path | None:
    if not records:
        return None

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    plt.rcParams.update({"figure.dpi": 110, "font.size": 10})
    fig, axes = plt.subplots(3, 2, figsize=(15, 14))

    # Panel A — outcome breakdown.
    ax = axes[0, 0]
    counts = defaultdict(int)
    for r in records:
        counts[r["outcome"]] += 1
    ordered = ["engaged-read", "next-page", "refined", "abandoned"]
    nvals = [counts.get(o, 0) for o in ordered]
    total = sum(nvals)
    pct = [100 * n / total for n in nvals]
    colors = [OUTCOME_COLORS[o] for o in ordered]
    bars = ax.bar(ordered, pct, color=colors, edgecolor="#1f2937", linewidth=0.5)
    for b, p, n in zip(bars, pct, nvals):
        ax.text(
            b.get_x() + b.get_width() / 2,
            p + 1.5,
            f"{p:.1f}%\nn={n:,}",
            ha="center",
            va="bottom",
            fontsize=9,
        )
    ax.set_title(f"search outcome (n={total:,})")
    ax.set_ylabel("share of calls")
    ax.set_ylim(0, max(pct) + 12)
    ax.yaxis.set_major_formatter(plt.FuncFormatter(lambda v, _: f"{v:.0f}%"))
    ax.grid(True, axis="y", alpha=0.25, linestyle="--")

    # Panel B — deepest result index touched.
    ax = axes[0, 1]
    engaged = [r for r in records if r["outcome"] == "engaged-read"]
    if engaged:
        deepest = np.array([r["deepest_index"] + 1 for r in engaged], dtype=np.int64)
        edges = [1, 2, 3, 6, 11, 21, 51, 101, max(deepest.max(), 102) + 1]
        labels = ["1", "2", "3-5", "6-10", "11-20", "21-50", "51-100", "100+"]
        hist, _ = np.histogram(deepest, bins=edges)
        pct = 100 * hist / deepest.size
        bars = ax.bar(labels, pct, color="#0f766e", edgecolor="#134e4a", linewidth=0.5)
        for b, p, n in zip(bars, pct, hist):
            ax.text(
                b.get_x() + b.get_width() / 2,
                p + 1.2,
                f"{p:.1f}%\nn={n:,}",
                ha="center",
                va="bottom",
                fontsize=8,
            )
        ax.set_title("deepest result index the model read")
        ax.set_ylabel("share of engaged-read calls")
        ax.set_ylim(0, max(pct) + 12)
        ax.yaxis.set_major_formatter(plt.FuncFormatter(lambda v, _: f"{v:.0f}%"))
        ax.grid(True, axis="y", alpha=0.25, linestyle="--")

    # Panel C — coverage ratio (deepest / list-size) CDF.
    ax = axes[1, 0]
    if engaged:
        coverage = np.array(
            [(r["deepest_index"] + 1) / r["n_results"] for r in engaged],
            dtype=float,
        )
        coverage.sort()
        cdf = np.arange(1, coverage.size + 1) / coverage.size
        ax.plot(coverage, cdf, color="#7c3aed", linewidth=2.0)
        ax.axvline(
            0.1, color="#9ca3af", linestyle="--", linewidth=1, label="10% of list"
        )
        ax.axvline(
            0.5, color="#9ca3af", linestyle=":", linewidth=1, label="50% of list"
        )
        ax.set_title("coverage CDF — deepest read / list size")
        ax.set_xlabel("fraction of list reached")
        ax.set_ylabel("CDF of engaged-read calls")
        ax.set_xlim(0, 1.0)
        ax.set_ylim(0, 1.0)
        ax.legend(loc="lower right", frameon=False)
        ax.grid(True, which="both", alpha=0.25, linestyle="--")

    # Panel D — result-list size distribution per outcome.
    ax = axes[1, 1]
    bins = np.logspace(0, np.log10(max(r["n_results"] for r in records) + 1), 30)
    for outcome in ordered:
        sizes = [r["n_results"] for r in records if r["outcome"] == outcome]
        if not sizes:
            continue
        ax.hist(
            sizes,
            bins=bins,
            histtype="step",
            linewidth=1.8,
            color=OUTCOME_COLORS[outcome],
            label=f"{outcome} (p50={int(np.median(sizes))})",
        )
    ax.set_xscale("log")
    ax.set_yscale("log")
    ax.set_xlabel("result list size")
    ax.set_ylabel("calls")
    ax.set_title("result list size by outcome")
    ax.legend(loc="upper right", frameon=False, fontsize=9)
    ax.grid(True, which="both", alpha=0.2, linestyle="--")

    # Panel E — engagement rate vs files-per-result, with p50 deepest overlay.
    ax = axes[2, 0]
    bins = [
        (1, 1, "1"),
        (2, 2, "2"),
        (3, 5, "3-5"),
        (6, 10, "6-10"),
        (11, 20, "11-20"),
        (21, 50, "21-50"),
        (51, 10**9, "51+"),
    ]
    labels = []
    eng_share = []
    deep_p50 = []
    n_calls = []
    for lo, hi, label in bins:
        bucket = [r for r in records if lo <= r["n_results"] <= hi]
        if not bucket:
            continue
        labels.append(label)
        n_calls.append(len(bucket))
        engs = [r for r in bucket if r["outcome"] == "engaged-read"]
        eng_share.append(100 * len(engs) / len(bucket))
        deep_p50.append(
            int(np.median([r["deepest_index"] + 1 for r in engs])) if engs else 0
        )
    x = np.arange(len(labels))
    bars = ax.bar(
        x,
        eng_share,
        color="#16a34a",
        edgecolor="#14532d",
        linewidth=0.5,
        label="engaged %",
    )
    for b, p, n in zip(bars, eng_share, n_calls):
        ax.text(
            b.get_x() + b.get_width() / 2,
            p + 0.8,
            f"{p:.0f}%\nn={n:,}",
            ha="center",
            va="bottom",
            fontsize=8,
        )
    ax.set_xticks(x)
    ax.set_xticklabels(labels)
    ax.set_ylabel("engaged %", color="#15803d")
    ax.tick_params(axis="y", labelcolor="#15803d")
    ax.set_ylim(0, max(eng_share) + 12)
    ax.set_title("engagement vs files-per-result")
    ax.set_xlabel("files in result")
    ax2 = ax.twinx()
    ax2.plot(
        x,
        deep_p50,
        color="#7c3aed",
        marker="o",
        linewidth=1.8,
        label="p50 deepest index",
    )
    ax2.set_ylabel("p50 deepest index", color="#5b21b6")
    ax2.tick_params(axis="y", labelcolor="#5b21b6")
    ax.grid(True, axis="y", alpha=0.25, linestyle="--")

    # Panel F — engagement rate vs max matches-per-file.
    ax = axes[2, 1]
    bins = [
        (1, 1, "1"),
        (2, 5, "2-5"),
        (6, 20, "6-20"),
        (21, 100, "21-100"),
        (101, 10**9, "100+"),
    ]
    labels = []
    eng_share = []
    deep_p50 = []
    n_calls = []
    for lo, hi, label in bins:
        bucket = [
            r
            for r in records
            if r["matches_per_file"] and lo <= max(r["matches_per_file"]) <= hi
        ]
        if not bucket:
            continue
        labels.append(label)
        n_calls.append(len(bucket))
        engs = [r for r in bucket if r["outcome"] == "engaged-read"]
        eng_share.append(100 * len(engs) / len(bucket))
        deep_p50.append(
            int(np.median([r["deepest_index"] + 1 for r in engs])) if engs else 0
        )
    x = np.arange(len(labels))
    bars = ax.bar(
        x,
        eng_share,
        color="#dc2626",
        edgecolor="#7f1d1d",
        linewidth=0.5,
        label="engaged %",
    )
    for b, p, n in zip(bars, eng_share, n_calls):
        ax.text(
            b.get_x() + b.get_width() / 2,
            p + 0.8,
            f"{p:.0f}%\nn={n:,}",
            ha="center",
            va="bottom",
            fontsize=8,
        )
    ax.set_xticks(x)
    ax.set_xticklabels(labels)
    ax.set_ylabel("engaged %", color="#991b1b")
    ax.tick_params(axis="y", labelcolor="#991b1b")
    ax.set_ylim(0, max(eng_share) + 12)
    ax.set_title("engagement vs concentration (max matches in one file)")
    ax.set_xlabel("max matches in single file")
    ax2 = ax.twinx()
    ax2.plot(
        x,
        deep_p50,
        color="#7c3aed",
        marker="o",
        linewidth=1.8,
        label="p50 deepest index",
    )
    ax2.set_ylabel("p50 deepest index", color="#5b21b6")
    ax2.tick_params(axis="y", labelcolor="#5b21b6")
    ax.grid(True, axis="y", alpha=0.25, linestyle="--")
    fig.suptitle(
        f"search/grep result relevance — calls since {since}", fontsize=13, y=1.0
    )
    fig.tight_layout()
    p = OUT_DIR / "search-relevance.png"
    fig.savefig(p, bbox_inches="tight")
    plt.close(fig)
    return p


# --------------------------------------------------------------------------- #
# Entry


def main() -> int:
    ap = argparse.ArgumentParser(description="search/grep result relevance analysis")
    ap.add_argument(
        "--since",
        default=DEFAULT_SINCE,
        help=f"only calls after this date (default {DEFAULT_SINCE})",
    )
    args = ap.parse_args()

    since = datetime.strptime(args.since, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    since_ms = int(since.timestamp() * 1000)

    if not DB_PATH.exists():
        sys.exit(f"db missing: {DB_PATH}")
    conn = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
    records = classify_sessions(conn, since_ms)
    conn.close()
    report(records)
    out = plot(records, args.since)
    if out:
        print(f"\nwrote {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
