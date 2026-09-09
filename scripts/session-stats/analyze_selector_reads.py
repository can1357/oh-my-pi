#!/usr/bin/env python3
"""
Per-session range-coverage analysis for read calls.

For each (session, file) we collect every read's [start, end] interval and
build a coverage map. From that we derive:

  * does the model follow up after the first read?
  * where does each follow-up land relative to the initial range?
      forward   : extends past the initial end
      backward  : extends before the initial start
      inside    : fully inside the initial range
      gap-above : disjoint, above the initial range (start > init_end + 1)
      gap-below : disjoint, below the initial range (end   < init_start - 1)
  * how many disjoint regions does the final coverage have?
  * how does total covered lines compare to the initial range?

`:raw` / `:conflicts` reads don't have line bounds; they're tracked in a
separate cohort and excluded from interval math.

Outputs:
  scripts/session-stats/out/selector-coverage.png
"""

from __future__ import annotations

import argparse
import json
import re
import sqlite3
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np

DB_PATH = Path.home() / ".omp" / "stats.db"
OUT_DIR = Path(__file__).resolve().parent / "out"
DEFAULT_SINCE = "2026-05-04"

# When a read has start but no explicit end (`:50` or default bare path with
# no offset/limit), assume the read tool returns this many lines. The read
# tool's default page is 500.
DEFAULT_PAGE = 500

_RANGE_RE = re.compile(r"^(\d+)(?:([-+])(\d+))?$")


# --------------------------------------------------------------------------- #
# Selector parsing


def parse_selector(path: str) -> tuple[str, int | None, int | None, str]:
    """Returns (base_path, start, end, kind)."""
    if not path:
        return path, None, None, "none"
    tail_idx = path.rfind("/")
    tail = path[tail_idx + 1 :]
    colon = tail.rfind(":")
    if colon < 0:
        return path, None, None, "none"
    suffix = tail[colon + 1 :]
    base = (path[: tail_idx + 1] + tail[:colon]) if tail_idx >= 0 else tail[:colon]
    if suffix == "raw":
        return base, None, None, "raw"
    if suffix == "conflicts":
        return base, None, None, "conflicts"
    m = _RANGE_RE.match(suffix)
    if not m:
        return path, None, None, "none"
    start = int(m.group(1))
    op = m.group(2)
    nval = m.group(3)
    if op == "-" and nval is not None:
        return base, start, int(nval), "range"
    if op == "+" and nval is not None:
        return base, start, start + int(nval) - 1, "range"
    # bare `:N` — open-ended; assume one page.
    return base, start, start + DEFAULT_PAGE - 1, "range"


def args_to_interval(
    arg_json: str | None,
) -> tuple[str, int | None, int | None, str] | None:
    """Decode arg_json into (base, start, end, kind)."""
    if not arg_json:
        return None
    try:
        obj = json.loads(arg_json)
    except json.JSONDecodeError:
        return None
    path = obj.get("path")
    if not isinstance(path, str):
        return None
    base, start, end, kind = parse_selector(path)
    if kind != "none":
        return base, start, end, kind
    # Legacy offset/limit.
    offset = obj.get("offset")
    limit = obj.get("limit")
    if (
        isinstance(offset, int)
        and isinstance(limit, int)
        and offset >= 1
        and limit >= 1
    ):
        return path, offset, offset + limit - 1, "range"
    if isinstance(offset, int) and offset >= 1:
        return path, offset, offset + DEFAULT_PAGE - 1, "range"
    # Bare path — read tool default returns first page. Marked as `default`
    # so the rest of the script can exclude it from "explicit selector".
    return path, 1, DEFAULT_PAGE, "default"


# --------------------------------------------------------------------------- #
# Coverage math


def merge_intervals(ivs: list[tuple[int, int]]) -> list[tuple[int, int]]:
    """Merge overlapping / adjacent intervals. Inclusive bounds."""
    if not ivs:
        return []
    ivs = sorted(ivs)
    out = [ivs[0]]
    for s, e in ivs[1:]:
        ls, le = out[-1]
        if s <= le + 1:  # touching or overlapping
            out[-1] = (ls, max(le, e))
        else:
            out.append((s, e))
    return out


def classify_followup(s: int, e: int, init_s: int, init_e: int) -> str:
    """Where does follow-up [s,e] land relative to initial [init_s, init_e]?"""
    if s >= init_s and e <= init_e:
        return "inside"
    if s > init_e + 1:
        return "gap-above"
    if e < init_s - 1:
        return "gap-below"
    if e > init_e and s >= init_s:
        return "forward"
    if s < init_s and e <= init_e:
        return "backward"
    # Spans both sides of initial range.
    return "both"


# --------------------------------------------------------------------------- #
# Pull


def iter_reads(conn: sqlite3.Connection, since_ms: int):
    sql = """
        SELECT session_file, seq, timestamp, arg_json
        FROM ss_tool_calls
        WHERE tool_name = 'read' AND timestamp >= ?
        ORDER BY session_file, seq
    """
    return conn.execute(sql, (since_ms,))


def collect(conn, since_ms) -> dict[tuple[str, str], list[tuple[int, int, int, str]]]:
    """key (session, file) -> ordered list of (seq, start, end, kind)."""
    by_key: dict[tuple[str, str], list[tuple[int, int | None, int | None, str]]] = (
        defaultdict(list)
    )
    for session, seq, _ts, arg_json in iter_reads(conn, since_ms):
        parsed = args_to_interval(arg_json)
        if parsed is None:
            continue
        base, start, end, kind = parsed
        if not base or base.endswith("/") or "://" in base:
            continue
        by_key[(session, base)].append((seq, start, end, kind))
    return by_key


# --------------------------------------------------------------------------- #
# Analyze


def analyze(by_key: dict) -> dict:
    """Compute coverage statistics over (session, file) groups whose FIRST
    read is a numeric range."""
    eligible: list[dict] = []
    first_kind_counts: Counter = Counter()
    # Position counter across all follow-ups (not just first one).
    followup_positions: Counter = Counter()
    for (session, base), reads in by_key.items():
        first = reads[0]
        _, s0, e0, kind0 = first
        first_kind_counts[kind0] += 1
        if kind0 != "range" or s0 is None or e0 is None:
            continue
        followups = reads[1:]

        intervals = [(s0, e0)]
        followup_kinds: list[str] = []
        first_followup_pos: str | None = None

        for _, s, e, k in followups:
            followup_kinds.append(k)
            # `range` (explicit) and `default` (bare path → first page) both
            # contribute a known interval to coverage. `raw`/`conflicts`
            # have no line bounds so we skip them here.
            if k not in ("range", "default") or s is None or e is None:
                continue
            pos = classify_followup(s, e, s0, e0)
            followup_positions[pos] += 1
            if first_followup_pos is None:
                first_followup_pos = pos
            intervals.append((s, e))

        merged = merge_intervals(intervals)
        covered_lines = sum(e - s + 1 for s, e in merged)
        init_size = e0 - s0 + 1
        regions = len(merged)
        # Span = bounding box length, gaps = span - covered.
        bbox = (merged[0][0], merged[-1][1])
        span = bbox[1] - bbox[0] + 1
        gap_lines = span - covered_lines
        extra_lines = max(0, covered_lines - init_size)  # new lines past initial

        eligible.append(
            {
                "session": session,
                "file": base,
                "init_start": s0,
                "init_end": e0,
                "init_size": init_size,
                "n_followups": len(followups),
                "n_range_followups": sum(
                    1 for k in followup_kinds if k in ("range", "default")
                ),
                "n_raw_followups": sum(1 for k in followup_kinds if k == "raw"),
                "first_followup_pos": first_followup_pos,
                "intervals": merged,
                "regions": regions,
                "covered": covered_lines,
                "extra_lines": extra_lines,
                "span": span,
                "gap_lines": gap_lines,
            }
        )
    return {
        "eligible": eligible,
        "first_kind": dict(first_kind_counts),
        "followup_pos": dict(followup_positions),
    }


# --------------------------------------------------------------------------- #
# Report

POS_ORDER = ["forward", "backward", "inside", "both", "gap-above", "gap-below"]
POS_COLORS = {
    "forward": "#2563eb",
    "backward": "#0f766e",
    "inside": "#9ca3af",
    "both": "#7c3aed",
    "gap-above": "#dc2626",
    "gap-below": "#d97706",
}
POS_HELP = {
    "forward": "extended past initial end",
    "backward": "extended before initial start",
    "inside": "re-read inside the initial range",
    "both": "extended on both sides",
    "gap-above": "disjoint hop above initial",
    "gap-below": "disjoint hop below initial",
}


def report(stats: dict) -> None:
    eligible = stats["eligible"]
    first_kind = stats["first_kind"]
    total_pairs = sum(first_kind.values())

    print("first-read selector breakdown across (session, file) pairs:")
    for k in ("default", "range", "raw", "conflicts", "none"):
        n = first_kind.get(k, 0)
        if n == 0:
            continue
        print(f"  {k:<10} {n:>8,}  {100 * n / total_pairs:>5.1f}%")
    print(f"  total      {total_pairs:>8,}")

    if not eligible:
        print("\nno (session, file) pairs with a ranged first read.")
        return

    n = len(eligible)
    with_followup = sum(1 for e in eligible if e["n_followups"] > 0)
    with_range_followup = sum(1 for e in eligible if e["n_range_followups"] > 0)
    print(f"\nfor {n:,} (session, file) pairs whose first read was a range:")
    print(
        f"  any follow-up read         : {with_followup:>8,}  ({100 * with_followup / n:.1f}%)"
    )
    print(
        f"  follow-up with a range     : {with_range_followup:>8,}  ({100 * with_range_followup / n:.1f}%)"
    )
    print()
    print("  ----- follow-up position breakdown (all follow-up reads) -----")
    positions = stats["followup_pos"]
    total_pos = sum(positions.values())
    for k in POS_ORDER:
        v = positions.get(k, 0)
        if v == 0:
            continue
        print(f"  {k:<10} {v:>8,}  ({100 * v / total_pos:>5.1f}%)  -- {POS_HELP[k]}")

    # Region count distribution.
    regions = np.array([e["regions"] for e in eligible], dtype=np.int64)
    print(f"\ndisjoint regions in final coverage (per session/file):")
    print(
        f"  mean={regions.mean():.2f}  median={int(np.median(regions))}  "
        f"p90={int(np.percentile(regions, 90))}  max={int(regions.max())}"
    )
    edges = [1, 2, 3, 4, 6, 11, 10**6]
    labels = ["1 (contig)", "2", "3", "4-5", "6-10", "11+"]
    hist, _ = np.histogram(regions, bins=edges)
    for label, nb in zip(labels, hist):
        print(f"  {label:<10} {nb:>8,}  ({100 * nb / regions.size:>5.1f}%)")

    # Extra lines vs initial (only when follow-ups exist).
    fu = [e for e in eligible if e["n_range_followups"] > 0]
    extra = np.array([e["extra_lines"] for e in fu], dtype=np.int64)
    if extra.size:
        print(f"\nextra lines covered beyond initial range (n={extra.size:,}):")
        print(
            f"  mean={extra.mean():.0f}  median={int(np.median(extra))}  "
            f"p75={int(np.percentile(extra, 75))}  p90={int(np.percentile(extra, 90))}  "
            f"max={int(extra.max())}"
        )
        edges = [0, 1, 51, 201, 501, 2001, 10**9]
        labels = ["0 (no new)", "1-50", "51-200", "201-500", "501-2000", "2000+"]
        hist, _ = np.histogram(extra, bins=edges)
        for label, nb in zip(labels, hist):
            print(f"  {label:<12} {nb:>8,}  ({100 * nb / extra.size:>5.1f}%)")

    # Coverage ratio.
    init_sizes = np.array([e["init_size"] for e in fu], dtype=np.int64)
    covered = np.array([e["covered"] for e in fu], dtype=np.int64)
    if init_sizes.size:
        with np.errstate(divide="ignore", invalid="ignore"):
            ratio = np.where(init_sizes > 0, covered / init_sizes, np.nan)
        ratio = ratio[np.isfinite(ratio)]
        print(f"\ntotal covered / initial size:")
        print(
            f"  mean={ratio.mean():.2f}x  median={np.median(ratio):.2f}x  "
            f"p90={np.percentile(ratio, 90):.2f}x"
        )


# --------------------------------------------------------------------------- #
# Plot


def plot(stats: dict, since: str) -> Path | None:
    eligible = stats["eligible"]
    if not eligible:
        return None

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    plt.rcParams.update({"figure.dpi": 110, "font.size": 10})

    fig, axes = plt.subplots(2, 2, figsize=(15, 9))

    # 1) Follow-up position breakdown.
    ax = axes[0, 0]
    pos = stats["followup_pos"]
    total = sum(pos.values())
    if total:
        keys = [k for k in POS_ORDER if pos.get(k, 0)]
        vals = [100 * pos[k] / total for k in keys]
        colors = [POS_COLORS[k] for k in keys]
        bars = ax.bar(keys, vals, color=colors, edgecolor="#111", linewidth=0.5)
        for bar, v, k in zip(bars, vals, keys):
            ax.text(
                bar.get_x() + bar.get_width() / 2,
                v + 1.0,
                f"{v:.1f}%\nn={pos[k]:,}",
                ha="center",
                va="bottom",
                fontsize=8,
            )
        ax.set_title(f"where do follow-up reads land vs initial range  (n={total:,})")
        ax.set_ylabel("share of follow-up reads")
        ax.set_ylim(0, max(vals) + 12)
        ax.yaxis.set_major_formatter(plt.FuncFormatter(lambda v, _: f"{v:.0f}%"))
        ax.grid(True, axis="y", alpha=0.25, linestyle="--")

    # 2) Disjoint region count.
    ax = axes[0, 1]
    regions = np.array([e["regions"] for e in eligible], dtype=np.int64)
    edges = [1, 2, 3, 4, 6, 11, regions.max() + 1 if regions.size else 12]
    labels = ["1\n(contiguous)", "2", "3", "4-5", "6-10", "11+"]
    hist, _ = np.histogram(regions, bins=edges)
    pct = 100 * hist / regions.size
    colors = ["#16a34a"] + ["#2563eb"] * 5
    bars = ax.bar(labels, pct, color=colors, edgecolor="#111", linewidth=0.5)
    for bar, p, h in zip(bars, pct, hist):
        ax.text(
            bar.get_x() + bar.get_width() / 2,
            p + 1.5,
            f"{p:.1f}%\nn={h:,}",
            ha="center",
            va="bottom",
            fontsize=8,
        )
    ax.set_title(f"disjoint regions in final coverage  (n={regions.size:,})")
    ax.set_ylabel("share of (session, file) pairs")
    ax.set_ylim(0, max(pct.max() + 12, 20))
    ax.yaxis.set_major_formatter(plt.FuncFormatter(lambda v, _: f"{v:.0f}%"))
    ax.grid(True, axis="y", alpha=0.25, linestyle="--")

    # 3) Extra lines past initial.
    ax = axes[1, 0]
    fu = [e for e in eligible if e["n_range_followups"] > 0]
    extra = np.array([e["extra_lines"] for e in fu], dtype=np.int64)
    if extra.size:
        edges = [0, 1, 51, 201, 501, 2001, max(extra.max(), 2001) + 1]
        labels = ["0", "1-50", "51-200", "201-500", "501-2000", "2000+"]
        hist, _ = np.histogram(extra, bins=edges)
        pct = 100 * hist / extra.size
        bars = ax.bar(labels, pct, color="#d97706", edgecolor="#7c2d12", linewidth=0.5)
        for bar, p, h in zip(bars, pct, hist):
            ax.text(
                bar.get_x() + bar.get_width() / 2,
                p + 1.5,
                f"{p:.1f}%\nn={h:,}",
                ha="center",
                va="bottom",
                fontsize=8,
            )
        ax.set_title(
            f"extra lines covered beyond initial range\n"
            f"(only pairs that follow up, n={extra.size:,})"
        )
        ax.set_ylabel("share of pairs")
        ax.set_ylim(0, max(pct.max() + 12, 20))
        ax.yaxis.set_major_formatter(plt.FuncFormatter(lambda v, _: f"{v:.0f}%"))
        ax.grid(True, axis="y", alpha=0.25, linestyle="--")

    # 4) Coverage ratio CDF.
    ax = axes[1, 1]
    init_sizes = np.array([e["init_size"] for e in fu], dtype=np.int64)
    covered = np.array([e["covered"] for e in fu], dtype=np.int64)
    if init_sizes.size:
        with np.errstate(divide="ignore", invalid="ignore"):
            ratio = np.where(init_sizes > 0, covered / init_sizes, np.nan)
        ratio = ratio[np.isfinite(ratio)]
        ratio.sort()
        cdf = np.arange(1, ratio.size + 1) / ratio.size
        ax.plot(ratio, cdf, color="#0f766e", linewidth=1.9)
        ax.axvline(
            1.0,
            color="#9ca3af",
            linestyle="--",
            linewidth=1.0,
            label="covered = initial",
        )
        for q in (0.5, 0.9):
            x = np.interp(q, cdf, ratio)
            ax.scatter([x], [q], color="#dc2626", s=22, zorder=3)
            ax.annotate(
                f"p{int(q * 100)}={x:.2f}x",
                (x, q),
                textcoords="offset points",
                xytext=(6, -8),
                fontsize=9,
            )
        ax.set_xscale("log")
        ax.set_xlim(0.8, max(ratio.max(), 10))
        ax.set_xlabel("total covered lines / initial range  (×, log)")
        ax.set_ylabel("CDF of pairs with follow-up")
        ax.set_title(
            f"how much of the file does the session end up reading? (n={ratio.size:,})"
        )
        ax.set_ylim(0, 1.01)
        ax.legend(loc="lower right", frameon=False)
        ax.grid(True, which="both", alpha=0.25, linestyle="--")

    fig.suptitle(
        f"selector reads — coverage map analysis (since {since})", fontsize=13, y=0.995
    )
    fig.tight_layout()
    p = OUT_DIR / "selector-coverage.png"
    fig.savefig(p, bbox_inches="tight")
    plt.close(fig)
    return p


# --------------------------------------------------------------------------- #
# Examples


def dump_examples(stats: dict, k: int = 8) -> None:
    """Print a few coverage-map examples for sanity / intuition."""
    fu = [e for e in stats["eligible"] if e["n_range_followups"] > 0]
    if not fu:
        return
    # Bucket by region count → pick one example from each bucket; for buckets
    # with many candidates prefer one whose initial range isn't the bare-path
    # default [1, 500] so the maps look more meaningful.
    buckets: dict[int, list[dict]] = defaultdict(list)
    for e in fu:
        bucket = min(e["regions"], 10)
        buckets[bucket].append(e)
    picks: list[dict] = []
    for r in sorted(buckets.keys()):
        candidates = buckets[r]
        # Prefer ones with non-default initial windows.
        non_default = [
            c
            for c in candidates
            if (c["init_start"], c["init_end"]) != (1, DEFAULT_PAGE)
        ]
        chosen = non_default[0] if non_default else candidates[0]
        picks.append(chosen)
        if len(picks) >= k:
            break
    print("\nexample coverage maps:")
    for e in picks[:k]:
        # Compact ASCII map of intervals over the bounding range.
        bbox_lo = e["intervals"][0][0]
        bbox_hi = e["intervals"][-1][1]
        width = 50
        span = max(1, bbox_hi - bbox_lo)
        bar = ["·"] * width
        for s, ee in e["intervals"]:
            i0 = int((s - bbox_lo) / span * (width - 1))
            i1 = int((ee - bbox_lo) / span * (width - 1))
            for i in range(i0, i1 + 1):
                bar[i] = "█"
        # Highlight initial range positions.
        init_s, init_e = e["init_start"], e["init_end"]
        i0 = int((init_s - bbox_lo) / span * (width - 1))
        i1 = int((init_e - bbox_lo) / span * (width - 1))
        for i in range(i0, i1 + 1):
            if bar[i] == "█":
                bar[i] = "▓"
        bar_str = "".join(bar)
        file_short = e["file"][-50:]
        print(
            f"  [{bar_str}] regions={e['regions']:>2} "
            f"init=[{e['init_start']},{e['init_end']}] "
            f"covered={e['covered']:>4} span={e['span']:>4}  {file_short}"
        )


# --------------------------------------------------------------------------- #
# Entry


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[1])
    ap.add_argument(
        "--since",
        default=DEFAULT_SINCE,
        help=f"only reads at or after this date (default {DEFAULT_SINCE})",
    )
    ap.add_argument(
        "--examples",
        type=int,
        default=8,
        help="how many coverage-map examples to print (default 8)",
    )
    args = ap.parse_args()

    since = datetime.strptime(args.since, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    since_ms = int(since.timestamp() * 1000)

    if not DB_PATH.exists():
        sys.exit(f"db missing: {DB_PATH}")
    conn = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
    by_key = collect(conn, since_ms)
    conn.close()

    print(
        f"loaded {sum(len(v) for v in by_key.values()):,} read calls across "
        f"{len(by_key):,} (session, file) pairs since {args.since}"
    )

    stats = analyze(by_key)
    report(stats)
    if args.examples:
        dump_examples(stats, args.examples)
    out = plot(stats, args.since)
    if out:
        print(f"\nwrote {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
