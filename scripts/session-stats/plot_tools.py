#!/usr/bin/env python3
"""
Plot token-usage trends for the top N tools from ~/.omp/stats.db.

Reads ss_tool_calls + ss_tool_results and renders:
  1. daily total tokens (args + results)         -- stacked area
  2. daily call count                            -- lines
  3. daily mean tokens per call                  -- lines (log y)
  4. cumulative tokens                           -- lines
  5. weekly median tokens-per-call               -- lines (log y)
  6. per-call token histogram (overall)          -- log-log step

`grep` is folded into `search` (old → new name). Tools are picked as the top
N by total tokens (default 10); override with --top N or --tools a,b,c.

Output: scripts/session-stats/out/tool-trends.png + standalone panels.
"""

from __future__ import annotations

import argparse
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

import matplotlib.dates as mdates
import matplotlib.pyplot as plt
import numpy as np

DB_PATH = Path.home() / ".omp" / "stats.db"
OUT_DIR = Path(__file__).resolve().parent / "out"

DAY_MS = 86_400_000
WEEK_MS = 7 * DAY_MS

# tool_name normalization: old names → canonical names.
TOOL_ALIAS = {"grep": "search"}

# 10-class qualitative palette (tab10) — distinct hues for line + area work.
PALETTE = [
    "#1f77b4",
    "#d62728",
    "#2ca02c",
    "#ff7f0e",
    "#9467bd",
    "#8c564b",
    "#17becf",
    "#e377c2",
    "#bcbd22",
    "#7f7f7f",
    "#393b79",
    "#637939",
]


def normalize_case_sql(col: str) -> str:
    """Build a CASE expression that maps aliases to canonical names."""
    if not TOOL_ALIAS:
        return col
    whens = " ".join(f"WHEN '{k}' THEN '{v}'" for k, v in TOOL_ALIAS.items())
    return f"CASE {col} {whens} ELSE {col} END"


# --------------------------------------------------------------------------- #
# Data access


def _connect() -> sqlite3.Connection:
    if not DB_PATH.exists():
        sys.exit(f"db missing: {DB_PATH}")
    return sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)


def pick_top_tools(conn: sqlite3.Connection, top: int) -> list[str]:
    norm = normalize_case_sql("c.tool_name")
    sql = f"""
        SELECT {norm} AS tool,
               SUM(COALESCE(c.arg_tokens,0) + COALESCE(r.result_tokens,0)) AS total
        FROM ss_tool_calls c
        LEFT JOIN ss_tool_results r
               ON r.session_file = c.session_file
              AND r.call_id      = c.call_id
              AND r.seq          >= c.seq
        GROUP BY tool
        ORDER BY total DESC
        LIMIT ?
    """
    return [row[0] for row in conn.execute(sql, (top,))]


def fetch_daily(conn: sqlite3.Connection, tools: list[str]) -> dict:
    placeholders = ",".join("?" * len(tools))
    norm = normalize_case_sql("c.tool_name")
    sql = f"""
        SELECT {norm}                                        AS tool,
               CAST(c.timestamp / ? AS INTEGER) * ?          AS bucket_ms,
               COUNT(*)                                      AS calls,
               COALESCE(SUM(c.arg_tokens), 0)                AS arg_tokens,
               COALESCE(SUM(r.result_tokens), 0)             AS result_tokens
        FROM ss_tool_calls c
        LEFT JOIN ss_tool_results r
               ON r.session_file = c.session_file
              AND r.call_id      = c.call_id
              AND r.seq          >= c.seq
        WHERE {norm} IN ({placeholders})
        GROUP BY tool, bucket_ms
        ORDER BY bucket_ms
    """
    rows = conn.execute(sql, (DAY_MS, DAY_MS, *tools)).fetchall()
    if not rows:
        sys.exit(f"no rows for tools={tools}")

    all_days = sorted({r[1] for r in rows})
    start, end = all_days[0], all_days[-1]
    day_axis = list(range(start, end + DAY_MS, DAY_MS))
    idx = {d: i for i, d in enumerate(day_axis)}

    n = len(day_axis)
    per_tool = {
        t: {
            "calls": np.zeros(n, dtype=np.int64),
            "args": np.zeros(n, dtype=np.int64),
            "results": np.zeros(n, dtype=np.int64),
        }
        for t in tools
    }
    for tool, bucket_ms, calls, args, results in rows:
        i = idx[bucket_ms]
        per_tool[tool]["calls"][i] = calls
        per_tool[tool]["args"][i] = args
        per_tool[tool]["results"][i] = results

    dates = np.array(
        [datetime.fromtimestamp(d / 1000, tz=timezone.utc) for d in day_axis]
    )
    return {"dates": dates, **per_tool}


def fetch_per_call(conn: sqlite3.Connection, tools: list[str]) -> dict[str, dict]:
    placeholders = ",".join("?" * len(tools))
    norm = normalize_case_sql("c.tool_name")
    sql = f"""
        SELECT {norm}                                                  AS tool,
               c.timestamp,
               COALESCE(c.arg_tokens, 0) + COALESCE(r.result_tokens, 0) AS total
        FROM ss_tool_calls c
        LEFT JOIN ss_tool_results r
               ON r.session_file = c.session_file
              AND r.call_id      = c.call_id
              AND r.seq          >= c.seq
        WHERE {norm} IN ({placeholders})
    """
    by_tool: dict[str, list[tuple[int, int]]] = {t: [] for t in tools}
    for tool, ts, total in conn.execute(sql, tuple(tools)):
        by_tool[tool].append((ts, total))

    out: dict[str, dict] = {}
    for t, rows in by_tool.items():
        if not rows:
            out[t] = {
                "ts": np.array([], dtype=np.int64),
                "tok": np.array([], dtype=np.int64),
            }
            continue
        ts = np.fromiter((r[0] for r in rows), dtype=np.int64, count=len(rows))
        tok = np.fromiter((r[1] for r in rows), dtype=np.int64, count=len(rows))
        order = np.argsort(ts)
        out[t] = {"ts": ts[order], "tok": tok[order]}
    return out


# --------------------------------------------------------------------------- #
# Helpers


def smooth(y: np.ndarray, w: int = 7) -> np.ndarray:
    if w <= 1 or len(y) < w:
        return y.astype(float)
    kernel = np.ones(w, dtype=float) / w
    return np.convolve(y.astype(float), kernel, mode="same")


def smooth_nan(y: np.ndarray, w: int = 7) -> np.ndarray:
    if w <= 1 or len(y) < w:
        return y
    mask = np.isfinite(y).astype(float)
    yf = np.where(mask > 0, y, 0.0)
    kernel = np.ones(w, dtype=float)
    num = np.convolve(yf, kernel, mode="same")
    den = np.convolve(mask, kernel, mode="same")
    with np.errstate(divide="ignore", invalid="ignore"):
        return np.where(den > 0, num / den, np.nan)


def millions(x: float, _pos: int = 0) -> str:
    if x >= 1e6:
        return f"{x / 1e6:.1f}M"
    if x >= 1e3:
        return f"{x / 1e3:.0f}k"
    return f"{x:.0f}"


def style_time_axis(ax: plt.Axes) -> None:
    ax.xaxis.set_major_locator(mdates.MonthLocator())
    ax.xaxis.set_major_formatter(mdates.DateFormatter("%b %Y"))
    ax.tick_params(axis="x", rotation=0)
    ax.grid(True, alpha=0.25, linestyle="--")


def weekly_median(ts_ms: np.ndarray, tok: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Returns (week_dates, p50) — both 1-d, same length."""
    if ts_ms.size == 0:
        return np.array([]), np.array([])
    week_idx = ts_ms // WEEK_MS
    weeks = np.arange(week_idx.min(), week_idx.max() + 1)
    p50 = np.full(weeks.size, np.nan)
    order = np.searchsorted(week_idx, weeks)
    order = np.append(order, ts_ms.size)
    for i in range(weeks.size):
        lo, hi = order[i], order[i + 1]
        if hi > lo:
            p50[i] = np.percentile(tok[lo:hi], 50)
    week_dates = np.array(
        [
            datetime.fromtimestamp(int(w) * WEEK_MS / 1000, tz=timezone.utc)
            for w in weeks
        ]
    )
    return week_dates, p50


# --------------------------------------------------------------------------- #
# Panels


def panel_total_tokens(
    ax: plt.Axes, daily: dict, tools: list[str], colors: dict
) -> None:
    dates = daily["dates"]
    series = [smooth(daily[t]["args"] + daily[t]["results"]) for t in tools]
    ax.stackplot(
        dates, series, labels=tools, colors=[colors[t] for t in tools], alpha=0.9
    )
    ax.set_title("Daily token volume (args + results, 7d MA)")
    ax.set_ylabel("tokens / day")
    ax.yaxis.set_major_formatter(plt.FuncFormatter(millions))
    ax.legend(loc="upper left", frameon=False, ncol=2, fontsize=9)
    style_time_axis(ax)


def panel_call_counts(
    ax: plt.Axes, daily: dict, tools: list[str], colors: dict
) -> None:
    dates = daily["dates"]
    for t in tools:
        ax.plot(
            dates, smooth(daily[t]["calls"]), label=t, color=colors[t], linewidth=1.6
        )
    ax.set_title("Daily call count (7d MA)")
    ax.set_ylabel("calls / day")
    ax.legend(loc="upper left", frameon=False, ncol=2, fontsize=9)
    style_time_axis(ax)


def panel_mean_per_call(
    ax: plt.Axes, daily: dict, tools: list[str], colors: dict
) -> None:
    dates = daily["dates"]
    for t in tools:
        totals = daily[t]["args"] + daily[t]["results"]
        calls = daily[t]["calls"].astype(float)
        with np.errstate(divide="ignore", invalid="ignore"):
            mean = np.where(calls > 0, totals / calls, np.nan)
        ax.plot(dates, smooth_nan(mean), label=t, color=colors[t], linewidth=1.6)
    ax.set_title("Mean tokens per call (7d MA)")
    ax.set_ylabel("tokens / call")
    ax.set_yscale("log")
    ax.yaxis.set_major_formatter(plt.FuncFormatter(millions))
    ax.legend(loc="upper left", frameon=False, ncol=2, fontsize=9)
    style_time_axis(ax)


def panel_cumulative(ax: plt.Axes, daily: dict, tools: list[str], colors: dict) -> None:
    dates = daily["dates"]
    for t in tools:
        totals = daily[t]["args"] + daily[t]["results"]
        ax.plot(dates, np.cumsum(totals), label=t, color=colors[t], linewidth=1.6)
    ax.set_title("Cumulative tokens")
    ax.set_ylabel("tokens (total)")
    ax.yaxis.set_major_formatter(plt.FuncFormatter(millions))
    ax.legend(loc="upper left", frameon=False, ncol=2, fontsize=9)
    style_time_axis(ax)


def panel_weekly_median(
    ax: plt.Axes, per_call: dict, tools: list[str], colors: dict
) -> None:
    for t in tools:
        w, p50 = weekly_median(per_call[t]["ts"], per_call[t]["tok"])
        if w.size == 0:
            continue
        ax.plot(w, p50, label=t, color=colors[t], linewidth=1.7)
    ax.set_title("Weekly median tokens / call")
    ax.set_ylabel("tokens / call (p50)")
    ax.set_yscale("log")
    ax.yaxis.set_major_formatter(plt.FuncFormatter(millions))
    ax.legend(loc="upper left", frameon=False, ncol=2, fontsize=9)
    style_time_axis(ax)


def panel_histogram(
    ax: plt.Axes, per_call: dict, tools: list[str], colors: dict
) -> None:
    all_tok = np.concatenate(
        [per_call[t]["tok"] for t in tools if per_call[t]["tok"].size]
    )
    if all_tok.size == 0:
        return
    hi = max(all_tok.max(), 10)
    bins = np.logspace(0, np.log10(hi), 60)
    for t in tools:
        tok = per_call[t]["tok"]
        if tok.size == 0:
            continue
        p50 = int(np.percentile(tok, 50))
        p99 = int(np.percentile(tok, 99))
        ax.hist(
            np.maximum(tok, 1),
            bins=bins,
            histtype="step",
            linewidth=1.5,
            color=colors[t],
            label=f"{t} (n={tok.size:,}, p50={p50}, p99={p99})",
        )
    ax.set_xscale("log")
    ax.set_yscale("log")
    ax.set_xlabel("tokens / call")
    ax.set_ylabel("calls")
    ax.xaxis.set_major_formatter(plt.FuncFormatter(millions))
    ax.set_title("Per-call token histogram (whole window)")
    ax.legend(loc="upper right", frameon=False, fontsize=8, ncol=1)
    ax.grid(True, which="both", alpha=0.2, linestyle="--")


# --------------------------------------------------------------------------- #
# Entry


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[1])
    ap.add_argument("--top", type=int, default=10, help="top N tools by total tokens")
    ap.add_argument(
        "--tools",
        type=str,
        default=None,
        help="comma-separated tools to plot (overrides --top)",
    )
    args = ap.parse_args()

    conn = _connect()
    if args.tools:
        tools = [t.strip() for t in args.tools.split(",") if t.strip()]
    else:
        tools = pick_top_tools(conn, args.top)
    if not tools:
        sys.exit("no tools selected")
    if len(tools) > len(PALETTE):
        sys.exit(f"palette has {len(PALETTE)} colors but {len(tools)} tools requested")

    colors = {t: PALETTE[i] for i, t in enumerate(tools)}
    print(f"plotting tools (ranked): {', '.join(tools)}")

    daily = fetch_daily(conn, tools)
    per_call = fetch_per_call(conn, tools)
    conn.close()

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    plt.rcParams.update({"figure.dpi": 110, "font.size": 10})

    # Combined 3x2 dashboard.
    fig, axes = plt.subplots(3, 2, figsize=(15, 13))
    panel_total_tokens(axes[0, 0], daily, tools, colors)
    panel_call_counts(axes[0, 1], daily, tools, colors)
    panel_mean_per_call(axes[1, 0], daily, tools, colors)
    panel_cumulative(axes[1, 1], daily, tools, colors)
    panel_weekly_median(axes[2, 0], per_call, tools, colors)
    panel_histogram(axes[2, 1], per_call, tools, colors)
    fig.suptitle(
        f"top {len(tools)} tools — token-usage trends "
        f"({daily['dates'][0].date()} → {daily['dates'][-1].date()})",
        fontsize=13,
        y=0.995,
    )
    fig.tight_layout()
    combined = OUT_DIR / "tool-trends.png"
    fig.savefig(combined, bbox_inches="tight")
    plt.close(fig)
    print(f"wrote {combined}")

    panels: tuple[tuple[str, Callable, dict], ...] = (
        ("daily-tokens", panel_total_tokens, daily),
        ("daily-calls", panel_call_counts, daily),
        ("tokens-per-call", panel_mean_per_call, daily),
        ("cumulative-tokens", panel_cumulative, daily),
        ("per-call-median", panel_weekly_median, per_call),
        ("per-call-histogram", panel_histogram, per_call),
    )
    for name, fn, src in panels:
        f2, ax = plt.subplots(figsize=(11, 5))
        fn(ax, src, tools, colors)
        f2.tight_layout()
        p = OUT_DIR / f"{name}.png"
        f2.savefig(p, bbox_inches="tight")
        plt.close(f2)
        print(f"wrote {p}")

    # Summary.
    print()
    print("totals over the window:")
    header = f"  {'tool':<14} {'calls':>9}  {'total':>14}  {'p50':>6}  {'p90':>7}  {'p99':>8}  {'max':>9}"
    print(header)
    print("  " + "-" * (len(header) - 2))
    for t in tools:
        a = int(daily[t]["args"].sum())
        r = int(daily[t]["results"].sum())
        c = int(daily[t]["calls"].sum())
        tok = per_call[t]["tok"]
        if tok.size:
            p50 = int(np.percentile(tok, 50))
            p90 = int(np.percentile(tok, 90))
            p99 = int(np.percentile(tok, 99))
            mx = int(tok.max())
        else:
            p50 = p90 = p99 = mx = 0
        print(
            f"  {t:<14} {c:>9,}  {a + r:>14,}  {p50:>6,}  {p90:>7,}  {p99:>8,}  {mx:>9,}"
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
