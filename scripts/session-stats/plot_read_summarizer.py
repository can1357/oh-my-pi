#!/usr/bin/env python3
"""
Did the read summarizer help?

The summarizer (commits 17ea26f86 / df8e41d7b / 7eaa9393311) shipped on
2026-05-04. It only runs on reads with *no selector* (no `:N-M`, `:raw`,
`:conflicts`, etc.). We classify each read call into:

  summary-eligible : `path` has no selector after the final '/'
  selector         : path ends in `:<digits>` / `:raw` / `:conflicts` / ...

Daily volume is normalized to *share of all tokens spent that day*, where
the denominator = every tool's args + results + assistant text + assistant
thinking + user messages. That removes the "I worked harder that day" effect.

Outputs to scripts/session-stats/out/read-summarizer-*.png.
"""

from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

import matplotlib.dates as mdates
import matplotlib.pyplot as plt
import numpy as np

DB_PATH = Path.home() / ".omp" / "stats.db"
OUT_DIR = Path(__file__).resolve().parent / "out"
DAY_MS = 86_400_000

# Deploy boundary; override with --deploy YYYY-MM-DD.
DEFAULT_DEPLOY = "2026-05-04"

COHORT_COLORS = {
    "summary-eligible": "#2563eb",
    "selector": "#9ca3af",
}


# --------------------------------------------------------------------------- #
# Classification


def has_selector(path: str) -> bool:
    """True iff `path` carries a read selector (`:50-200`, `:raw`, ...)."""
    if not path:
        return False
    tail = path.rsplit("/", 1)[-1]
    idx = tail.rfind(":")
    if idx < 0:
        return False
    suffix = tail[idx + 1 :]
    if not suffix:
        return False
    if suffix in ("raw", "conflicts"):
        return True
    return any(ch.isdigit() for ch in suffix)


def cohort_of(arg_json: str | None) -> str | None:
    if not arg_json:
        return None
    try:
        obj = json.loads(arg_json)
    except json.JSONDecodeError:
        return None
    path = obj.get("path")
    if not isinstance(path, str):
        return None
    return "selector" if has_selector(path) else "summary-eligible"


# --------------------------------------------------------------------------- #
# Data


def fetch_read_calls(conn) -> dict[str, dict[str, np.ndarray]]:
    sql = """
        SELECT c.timestamp,
               c.arg_json,
               COALESCE(c.arg_tokens, 0) + COALESCE(r.result_tokens, 0) AS tok
        FROM ss_tool_calls c
        LEFT JOIN ss_tool_results r
               ON r.session_file = c.session_file
              AND r.call_id      = c.call_id
              AND r.seq          >= c.seq
        WHERE c.tool_name = 'read'
    """
    by: dict[str, list[tuple[int, int]]] = {k: [] for k in COHORT_COLORS}
    for ts, arg_json, tok in conn.execute(sql):
        c = cohort_of(arg_json)
        if c is None:
            continue
        by[c].append((ts, tok))
    out: dict[str, dict[str, np.ndarray]] = {}
    for c, rows in by.items():
        if not rows:
            out[c] = {
                "ts": np.array([], dtype=np.int64),
                "tok": np.array([], dtype=np.int64),
            }
            continue
        ts = np.fromiter((r[0] for r in rows), dtype=np.int64, count=len(rows))
        tok = np.fromiter((r[1] for r in rows), dtype=np.int64, count=len(rows))
        order = np.argsort(ts)
        out[c] = {"ts": ts[order], "tok": tok[order]}
    return out


def fetch_daily_denominator(conn) -> tuple[np.ndarray, np.ndarray]:
    """Total tokens spent per day across every counted source."""
    sql = """
        SELECT bucket_ms, SUM(tok) FROM (
            SELECT CAST(c.timestamp / :day AS INTEGER) * :day AS bucket_ms,
                   COALESCE(c.arg_tokens, 0) + COALESCE(r.result_tokens, 0) AS tok
            FROM ss_tool_calls c
            LEFT JOIN ss_tool_results r
                   ON r.session_file = c.session_file
                  AND r.call_id      = c.call_id
                  AND r.seq          >= c.seq
            UNION ALL
            SELECT CAST(timestamp / :day AS INTEGER) * :day,
                   COALESCE(text_tokens,0) + COALESCE(thinking_tokens,0)
            FROM ss_assistant_msgs
            UNION ALL
            SELECT CAST(timestamp / :day AS INTEGER) * :day,
                   COALESCE(text_tokens,0)
            FROM ss_user_msgs
        )
        GROUP BY bucket_ms
        ORDER BY bucket_ms
    """
    rows = conn.execute(sql, {"day": DAY_MS}).fetchall()
    if not rows:
        return np.array([]), np.array([])
    bucket = np.fromiter((r[0] for r in rows), dtype=np.int64, count=len(rows))
    tot = np.fromiter((r[1] for r in rows), dtype=np.int64, count=len(rows))
    return bucket, tot


def daily_sum(ts_ms: np.ndarray, tok: np.ndarray, day_axis: np.ndarray) -> np.ndarray:
    """Sum `tok` per day (key = day_axis bucket_ms). Returns array len(day_axis)."""
    out = np.zeros(day_axis.size, dtype=np.int64)
    if ts_ms.size == 0:
        return out
    bucket = (ts_ms // DAY_MS) * DAY_MS
    idx = {int(d): i for i, d in enumerate(day_axis)}
    # Vectorize via searchsorted on a sorted day_axis (it is).
    pos = np.searchsorted(day_axis, bucket)
    for p, t, b in zip(pos, tok, bucket):
        if p < day_axis.size and day_axis[p] == b:
            out[p] += t
    return out


def daily_percentile(
    ts_ms: np.ndarray, tok: np.ndarray, q: float
) -> tuple[np.ndarray, np.ndarray]:
    if ts_ms.size == 0:
        return np.array([]), np.array([])
    day_idx = ts_ms // DAY_MS
    days = np.arange(day_idx.min(), day_idx.max() + 1)
    pct = np.full(days.size, np.nan)
    order = np.searchsorted(day_idx, days)
    order = np.append(order, ts_ms.size)
    for i in range(days.size):
        lo, hi = order[i], order[i + 1]
        if hi > lo:
            pct[i] = np.percentile(tok[lo:hi], q)
    dates = np.array(
        [datetime.fromtimestamp(int(d) * DAY_MS / 1000, tz=timezone.utc) for d in days]
    )
    return dates, pct


def smooth_nan(y: np.ndarray, w: int) -> np.ndarray:
    if w <= 1 or y.size < w:
        return y
    mask = np.isfinite(y).astype(float)
    yf = np.where(mask > 0, y, 0.0)
    kernel = np.ones(w, dtype=float)
    num = np.convolve(yf, kernel, mode="same")
    den = np.convolve(mask, kernel, mode="same")
    with np.errstate(divide="ignore", invalid="ignore"):
        return np.where(den > 0, num / den, np.nan)


# --------------------------------------------------------------------------- #
# Plot helpers


def thousands(x: float, _p=0) -> str:
    if x >= 1000:
        return f"{x / 1000:.1f}k"
    return f"{x:.0f}"


def style_time(ax: plt.Axes, deploy: datetime) -> None:
    ax.xaxis.set_major_locator(mdates.MonthLocator())
    ax.xaxis.set_major_formatter(mdates.DateFormatter("%b %Y"))
    ax.grid(True, alpha=0.25, linestyle="--")
    ax.axvline(deploy, color="#dc2626", linestyle="--", linewidth=1.2, alpha=0.8)
    y1 = ax.get_ylim()[1] if ax.get_ylim()[1] > 0 else 1
    ax.text(
        deploy,
        y1,
        "  summarizer\n  deploy",
        color="#dc2626",
        va="top",
        ha="left",
        fontsize=9,
    )


def panel_share_stacked(
    ax: plt.Axes, reads, denom_dates, denom, deploy: datetime
) -> None:
    """Stacked area: per-day read-cohort share of total tokens."""
    series = []
    labels = []
    colors = []
    for cohort, color in COHORT_COLORS.items():
        d = reads[cohort]
        sums = daily_sum(d["ts"], d["tok"], denom_dates)
        with np.errstate(divide="ignore", invalid="ignore"):
            share = np.where(denom > 0, sums / denom, 0.0)
        series.append(smooth_nan(share, 7))
        labels.append(cohort)
        colors.append(color)
    x = np.array(
        [datetime.fromtimestamp(int(d) / 1000, tz=timezone.utc) for d in denom_dates]
    )
    ax.stackplot(x, series, labels=labels, colors=colors, alpha=0.85)
    ax.set_title("read share of daily token spend (7d MA)")
    ax.set_ylabel("share of all tokens that day")
    ax.yaxis.set_major_formatter(plt.FuncFormatter(lambda v, _: f"{v * 100:.0f}%"))
    ax.set_ylim(0, None)
    ax.legend(loc="upper left", frameon=False)
    style_time(ax, deploy)


def panel_share_line(ax: plt.Axes, reads, denom_dates, denom, deploy: datetime) -> None:
    """Lines: each cohort's share, plus the combined total."""
    x = np.array(
        [datetime.fromtimestamp(int(d) / 1000, tz=timezone.utc) for d in denom_dates]
    )
    total = np.zeros(denom_dates.size, dtype=np.int64)
    for cohort, color in COHORT_COLORS.items():
        d = reads[cohort]
        sums = daily_sum(d["ts"], d["tok"], denom_dates)
        total += sums
        with np.errstate(divide="ignore", invalid="ignore"):
            share = np.where(denom > 0, sums / denom, 0.0)
        ax.plot(x, smooth_nan(share, 7), label=cohort, color=color, linewidth=1.7)
    with np.errstate(divide="ignore", invalid="ignore"):
        combined = np.where(denom > 0, total / denom, 0.0)
    ax.plot(
        x,
        smooth_nan(combined, 7),
        label="all reads",
        color="#111111",
        linewidth=2.2,
        linestyle="-",
    )
    ax.set_title("read share by cohort (7d MA)")
    ax.set_ylabel("share of daily tokens")
    ax.yaxis.set_major_formatter(plt.FuncFormatter(lambda v, _: f"{v * 100:.0f}%"))
    ax.set_ylim(0, None)
    ax.legend(loc="upper left", frameon=False)
    style_time(ax, deploy)


def panel_per_call(
    ax: plt.Axes, reads, deploy: datetime, q: float, label_q: str
) -> None:
    for cohort, color in COHORT_COLORS.items():
        d = reads[cohort]
        if d["ts"].size == 0:
            continue
        dates, pct = daily_percentile(d["ts"], d["tok"], q)
        ax.plot(
            dates,
            smooth_nan(pct, 7),
            label=f"{cohort} ({label_q})",
            color=color,
            linewidth=1.9,
        )
    ax.set_title(f"daily {label_q} tokens per read call (7d MA)")
    ax.set_ylabel("tokens / call")
    ax.set_yscale("log")
    ax.yaxis.set_major_formatter(plt.FuncFormatter(thousands))
    ax.legend(loc="upper left", frameon=False)
    style_time(ax, deploy)


# --------------------------------------------------------------------------- #
# Stats


def share_stats(reads, denom_dates, denom, deploy_ms: int) -> None:
    pre_mask = denom_dates < deploy_ms
    post_mask = denom_dates >= deploy_ms
    pre_total = int(denom[pre_mask].sum())
    post_total = int(denom[post_mask].sum())
    print(f"\nshare-of-day (pre vs post deploy):")
    print(
        f"  denominator pre  = {pre_total:>14,} tokens across {int(pre_mask.sum())} days"
    )
    print(
        f"  denominator post = {post_total:>14,} tokens across {int(post_mask.sum())} days"
    )
    print(f"  {'cohort':<22} {'pre share':>10} {'post share':>11} {'delta':>10}")
    grand_pre = 0
    grand_post = 0
    for cohort in COHORT_COLORS:
        d = reads[cohort]
        sums = daily_sum(d["ts"], d["tok"], denom_dates)
        pre = int(sums[pre_mask].sum())
        post = int(sums[post_mask].sum())
        grand_pre += pre
        grand_post += post
        pre_share = pre / pre_total if pre_total else 0
        post_share = post / post_total if post_total else 0
        print(
            f"  {cohort:<22} {pre_share * 100:>9.2f}% {post_share * 100:>10.2f}% "
            f"{(post_share - pre_share) * 100:>+9.2f}pp"
        )
    pre_share = grand_pre / pre_total if pre_total else 0
    post_share = grand_post / post_total if post_total else 0
    print(
        f"  {'all reads':<22} {pre_share * 100:>9.2f}% {post_share * 100:>10.2f}% "
        f"{(post_share - pre_share) * 100:>+9.2f}pp"
    )


def per_call_stats(reads, deploy_ms: int) -> None:
    print(f"\nper-call stats (pre vs post deploy):")
    print(
        f"  {'cohort':<22} {'window':<6} {'n':>9}  {'p50':>7}  {'p90':>7}  {'mean':>8}"
    )
    for cohort in COHORT_COLORS:
        d = reads[cohort]
        if d["ts"].size == 0:
            continue
        pre = d["tok"][d["ts"] < deploy_ms]
        post = d["tok"][d["ts"] >= deploy_ms]
        for name, arr in (("pre", pre), ("post", post)):
            if arr.size == 0:
                continue
            print(
                f"  {cohort:<22} {name:<6} {arr.size:>9,}  "
                f"{int(np.percentile(arr, 50)):>7,}  "
                f"{int(np.percentile(arr, 90)):>7,}  "
                f"{int(arr.mean()):>8,}"
            )


# --------------------------------------------------------------------------- #
# Entry


def main() -> int:
    ap = argparse.ArgumentParser(description="read summarizer impact analysis")
    ap.add_argument(
        "--deploy",
        default=DEFAULT_DEPLOY,
        help=f"deploy date YYYY-MM-DD (default {DEFAULT_DEPLOY})",
    )
    args = ap.parse_args()

    deploy = datetime.strptime(args.deploy, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    deploy_ms = int(deploy.timestamp() * 1000)

    if not DB_PATH.exists():
        sys.exit(f"db missing: {DB_PATH}")
    conn = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
    reads = fetch_read_calls(conn)
    denom_dates, denom = fetch_daily_denominator(conn)
    conn.close()
    if denom_dates.size == 0:
        sys.exit("no daily totals available")

    for c in COHORT_COLORS:
        print(f"{c:<22} calls={reads[c]['ts'].size:,}")

    per_call_stats(reads, deploy_ms)
    share_stats(reads, denom_dates, denom, deploy_ms)

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    plt.rcParams.update({"figure.dpi": 110, "font.size": 10})

    fig, axes = plt.subplots(2, 2, figsize=(15, 9))
    panel_share_stacked(axes[0, 0], reads, denom_dates, denom, deploy)
    panel_share_line(axes[0, 1], reads, denom_dates, denom, deploy)
    panel_per_call(axes[1, 0], reads, deploy, q=50, label_q="p50")
    panel_per_call(axes[1, 1], reads, deploy, q=90, label_q="p90")
    fig.suptitle(
        f"read summarizer impact — deploy = {args.deploy}", fontsize=13, y=0.995
    )
    fig.tight_layout()
    p = OUT_DIR / "read-summarizer.png"
    fig.savefig(p, bbox_inches="tight")
    plt.close(fig)
    print(f"\nwrote {p}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
