#!/usr/bin/env python3
"""
Optimize read-tool line-window settings from historical session behaviour.

This is a counterfactual replay over post-summarizer read calls. For each
(session, file), reads are replayed in order while maintaining a line-coverage
map. A candidate config changes the interval delivered by each bounded/default
read. If a later requested interval is already covered, that later read would
have been avoided.

Modelled config dimensions:
  defaultLimit     lines returned by bare reads and open selectors (`:N`)
  maxLines         hard line cap for one read result
  leadingContext   lines before explicit offsets/ranges
  trailingContext  lines after explicit bounded ranges

The replay reports estimated token cost, read calls, avoided follow-ups,
truncations, and a Pareto frontier.

Output:
  scripts/session-stats/out/read-optimizer.png
"""

from __future__ import annotations

import argparse
import json
import math
import re
import sqlite3
import sys
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np

DB_PATH = Path.home() / ".omp" / "stats.db"
OUT_DIR = Path(__file__).resolve().parent / "out"
DEFAULT_SINCE = "2026-05-04"

# Current code defaults, from packages/coding-agent/src/tools/read.ts and
# packages/coding-agent/src/config/settings-schema.ts.
CURRENT_DEFAULT = 500
CURRENT_MAX_LINES = 3000
CURRENT_LEADING = 3
CURRENT_TRAILING = 3
CURRENT_MAX_BYTES = 50 * 1024
READ_MAX_COLUMN = 768

_RANGE_RE = re.compile(r"^(\d+)(?:([-+])(\d+))?$")
TEXT_EXTS = {
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".mts",
    ".cts",
    ".mjs",
    ".cjs",
    ".rs",
    ".go",
    ".py",
    ".rb",
    ".java",
    ".kt",
    ".kts",
    ".c",
    ".cc",
    ".cpp",
    ".h",
    ".hpp",
    ".cs",
    ".swift",
    ".php",
    ".lua",
    ".sh",
    ".bash",
    ".zsh",
    ".fish",
    ".md",
    ".txt",
    ".json",
    ".jsonc",
    ".json5",
    ".yaml",
    ".yml",
    ".toml",
    ".xml",
    ".html",
    ".css",
    ".scss",
    ".sql",
    ".adoc",
    ".typ",
    ".rsx",
    ".vue",
    ".svelte",
    ".dockerfile",
    "",
}


@dataclass(frozen=True)
class ReadCall:
    session: str
    file: str
    seq: int
    kind: str  # explicit | open | default | raw | conflicts | other
    start: int | None
    end: int | None
    arg_tokens: int
    result_tokens: int
    current_lines: int
    token_per_line: float


@dataclass(frozen=True)
class Config:
    default: int
    max_lines: int
    leading: int
    trailing: int

    def label(self) -> str:
        return f"D{self.default}/M{self.max_lines}/L{self.leading}/T{self.trailing}"


@dataclass(frozen=True)
class ReplayResult:
    config: Config
    tokens: float
    calls: int
    skipped_calls: int
    truncations: int
    bytes_limited: int
    selector_tokens: float
    selector_calls: int
    selector_skipped: int
    selector_groups: int
    selector_groups_single_call: int
    selector_groups_all_covered_by_first: int
    default_tokens: float
    default_calls: int
    default_skipped: int
    raw_tokens: float
    raw_calls: int

    @property
    def first_cover_rate(self) -> float:
        if self.selector_groups == 0:
            return 0.0
        return self.selector_groups_all_covered_by_first / self.selector_groups


def parse_int_list(spec: str) -> list[int]:
    out: list[int] = []
    for part in spec.split(","):
        part = part.strip()
        if not part:
            continue
        out.append(int(part))
    return out


def parse_path_selector(path: str) -> tuple[str, str, int | None, int | None]:
    if not path:
        return path, "other", None, None
    tail_idx = path.rfind("/")
    tail = path[tail_idx + 1 :]
    colon = tail.rfind(":")
    if colon < 0:
        return path, "default", 1, CURRENT_DEFAULT

    suffix = tail[colon + 1 :]
    base = path[: tail_idx + 1] + tail[:colon] if tail_idx >= 0 else tail[:colon]
    if suffix == "raw":
        return base, "raw", None, None
    if suffix == "conflicts":
        return base, "conflicts", None, None

    m = _RANGE_RE.match(suffix)
    if not m:
        return path, "default", 1, CURRENT_DEFAULT
    start = int(m.group(1))
    op = m.group(2)
    nval = m.group(3)
    if op == "-" and nval is not None:
        return base, "explicit", start, max(start, int(nval))
    if op == "+" and nval is not None:
        return base, "explicit", start, start + max(1, int(nval)) - 1
    return base, "open", start, start + CURRENT_DEFAULT - 1


def current_line_count(kind: str, start: int | None, end: int | None) -> int:
    if kind not in ("explicit", "open", "default") or start is None or end is None:
        return 0
    if kind == "explicit":
        requested = max(1, end - start + 1)
        leading = min(start - 1, CURRENT_LEADING) if start > 1 else 0
        return min(requested + leading + CURRENT_TRAILING, CURRENT_MAX_LINES)
    if kind == "open":
        leading = min(start - 1, CURRENT_LEADING) if start > 1 else 0
        return min(CURRENT_DEFAULT + leading, CURRENT_MAX_LINES)
    return min(CURRENT_DEFAULT, CURRENT_MAX_LINES)


def parse_call(row) -> ReadCall | None:
    session, seq, arg_json, arg_tokens, result_tokens = row
    try:
        obj = json.loads(arg_json or "{}")
    except json.JSONDecodeError:
        return None
    path = obj.get("path")
    if not isinstance(path, str):
        return None
    base, kind, start, end = parse_path_selector(path)

    # Legacy/bridge fields override a bare path.
    if kind == "default":
        offset = obj.get("offset")
        limit = obj.get("limit")
        if (
            isinstance(offset, int)
            and offset >= 1
            and isinstance(limit, int)
            and limit >= 1
        ):
            kind = "explicit"
            start = offset
            end = offset + limit - 1
        elif isinstance(offset, int) and offset >= 1:
            kind = "open"
            start = offset
            end = offset + CURRENT_DEFAULT - 1

    if not base or base.endswith("/") or "://" in base:
        return None
    ext = Path(base).suffix.lower()
    if ext not in TEXT_EXTS:
        # Keep unknown extension text if it has line selectors, skip obvious binary-ish paths.
        if kind not in ("explicit", "open", "default"):
            return None

    current_lines = current_line_count(kind, start, end)
    rtok = int(result_tokens or 0)
    if current_lines > 0:
        # Include the observed framing/line-number overhead in a per-line rate.
        # Clamp avoids a one-line error response implying giant line cost.
        token_per_line = min(100.0, max(0.25, rtok / current_lines))
    else:
        token_per_line = 0.0
    return ReadCall(
        session=str(session),
        file=base,
        seq=int(seq),
        kind=kind,
        start=start,
        end=end,
        arg_tokens=int(arg_tokens or 0),
        result_tokens=rtok,
        current_lines=current_lines,
        token_per_line=token_per_line,
    )


def requested_interval(call: ReadCall, cfg: Config) -> tuple[int, int] | None:
    if call.kind == "explicit" and call.start is not None and call.end is not None:
        return call.start, call.end
    if call.kind == "open" and call.start is not None:
        return call.start, call.start + cfg.default - 1
    if call.kind == "default":
        return 1, cfg.default
    return None


def delivered_interval(call: ReadCall, cfg: Config) -> tuple[int, int] | None:
    req = requested_interval(call, cfg)
    if req is None:
        return None
    s, e = req
    if call.kind == "explicit":
        start = max(1, s - cfg.leading) if s > 1 else 1
        requested = max(1, e - s + 1)
        lines = min(requested + (s - start) + cfg.trailing, cfg.max_lines)
        return start, start + lines - 1
    if call.kind == "open":
        start = max(1, s - cfg.leading) if s > 1 else 1
        lines = min(cfg.default + (s - start), cfg.max_lines)
        return start, start + lines - 1
    if call.kind == "default":
        lines = min(cfg.default, cfg.max_lines)
        return 1, lines
    return None


def is_covered(intervals: list[tuple[int, int]], target: tuple[int, int]) -> bool:
    s, e = target
    for a, b in intervals:
        if a <= s and e <= b:
            return True
        if a > s:
            return False
    return False


def add_interval(
    intervals: list[tuple[int, int]], item: tuple[int, int]
) -> list[tuple[int, int]]:
    s, e = item
    out: list[tuple[int, int]] = []
    placed = False
    for a, b in intervals:
        if b + 1 < s:
            out.append((a, b))
        elif e + 1 < a:
            if not placed:
                out.append((s, e))
                placed = True
            out.append((a, b))
        else:
            s = min(s, a)
            e = max(e, b)
    if not placed:
        out.append((s, e))
    return out


def estimate_cost(
    call: ReadCall, delivered: tuple[int, int]
) -> tuple[float, bool, bool]:
    lines = max(0, delivered[1] - delivered[0] + 1)
    line_tokens = call.token_per_line * lines
    # Approximate byte cap. The implementation scales byte cap as
    # max(50KiB, maxLinesToCollect * 512). For normal code line lengths this is
    # rarely binding; keep the indicator so huge-line configs are visible.
    byte_budget = max(CURRENT_MAX_BYTES, lines * 512)
    approx_bytes = line_tokens * 4
    bytes_limited = approx_bytes > byte_budget
    if bytes_limited:
        line_tokens = byte_budget / 4
    return (
        call.arg_tokens + line_tokens,
        call.kind == "explicit" and lines >= call.config_max_lines if False else False,
        bytes_limited,
    )


def load_reads(
    conn: sqlite3.Connection, since_ms: int
) -> dict[tuple[str, str], list[ReadCall]]:
    sql = """
        SELECT c.session_file, c.seq, c.arg_json,
               COALESCE(c.arg_tokens,0), COALESCE(r.result_tokens,0)
        FROM ss_tool_calls c
        LEFT JOIN ss_tool_results r
               ON r.session_file = c.session_file
              AND r.call_id      = c.call_id
              AND r.seq          >= c.seq
        WHERE c.tool_name = 'read' AND c.timestamp >= ?
        ORDER BY c.session_file, c.seq
    """
    groups: dict[tuple[str, str], list[ReadCall]] = defaultdict(list)
    for row in conn.execute(sql, (since_ms,)):
        call = parse_call(row)
        if call is None:
            continue
        groups[(call.session, call.file)].append(call)
    return groups


def replay(groups: dict[tuple[str, str], list[ReadCall]], cfg: Config) -> ReplayResult:
    tokens = 0.0
    calls = 0
    skipped = 0
    trunc = 0
    bytes_limited = 0
    selector_tokens = 0.0
    selector_calls = 0
    selector_skipped = 0
    selector_groups = 0
    selector_groups_single_call = 0
    selector_groups_all_first = 0
    default_tokens = 0.0
    default_calls = 0
    default_skipped = 0
    raw_tokens = 0.0
    raw_calls = 0

    for group in groups.values():
        first = group[0]
        selector_first = first.kind in ("explicit", "open")
        default_first = first.kind == "default"
        if selector_first:
            selector_groups += 1
            if len(group) == 1:
                selector_groups_single_call += 1
        coverage: list[tuple[int, int]] = []
        paid_selector_calls = 0
        covered_all_by_first = False

        for idx, call in enumerate(group):
            req = requested_interval(call, cfg)
            delivered = delivered_interval(call, cfg)
            if req is None or delivered is None:
                cost = call.arg_tokens + call.result_tokens
                tokens += cost
                calls += 1
                raw_tokens += cost
                raw_calls += 1
                if selector_first:
                    selector_tokens += cost
                    selector_calls += 1
                    paid_selector_calls += 1
                elif default_first:
                    default_tokens += cost
                    default_calls += 1
                continue

            if idx > 0 and is_covered(coverage, req):
                skipped += 1
                if selector_first:
                    selector_skipped += 1
                elif default_first:
                    default_skipped += 1
                continue

            lines = delivered[1] - delivered[0] + 1
            if lines >= cfg.max_lines and call.kind == "explicit":
                # Candidate max cap would truncate this explicit request.
                requested_len = max(
                    1, (call.end or call.start or 1) - (call.start or 1) + 1
                )
                if requested_len + cfg.leading + cfg.trailing > cfg.max_lines:
                    trunc += 1
            line_tokens = call.token_per_line * lines
            byte_budget = max(CURRENT_MAX_BYTES, lines * 512)
            if line_tokens * 4 > byte_budget:
                bytes_limited += 1
                line_tokens = byte_budget / 4
            cost = call.arg_tokens + line_tokens
            tokens += cost
            calls += 1
            if selector_first:
                selector_tokens += cost
                selector_calls += 1
                paid_selector_calls += 1
            elif default_first:
                default_tokens += cost
                default_calls += 1

            coverage = add_interval(coverage, delivered)
            if idx == 0 and selector_first:
                # Check whether the first delivered interval covers every later
                # bounded request in the historical group.
                all_covered = True
                for later in group[1:]:
                    later_req = requested_interval(later, cfg)
                    if later_req is not None and not is_covered([delivered], later_req):
                        all_covered = False
                        break
                covered_all_by_first = all_covered

        if selector_first and (covered_all_by_first or len(group) == 1):
            selector_groups_all_first += 1

    return ReplayResult(
        config=cfg,
        tokens=tokens,
        calls=calls,
        skipped_calls=skipped,
        truncations=trunc,
        bytes_limited=bytes_limited,
        selector_tokens=selector_tokens,
        selector_calls=selector_calls,
        selector_skipped=selector_skipped,
        selector_groups=selector_groups,
        selector_groups_single_call=selector_groups_single_call,
        selector_groups_all_covered_by_first=selector_groups_all_first,
        default_tokens=default_tokens,
        default_calls=default_calls,
        default_skipped=default_skipped,
        raw_tokens=raw_tokens,
        raw_calls=raw_calls,
    )


def candidate_grid(args) -> list[Config]:
    defaults = parse_int_list(args.defaults)
    maxes = parse_int_list(args.max_lines)
    leads = parse_int_list(args.leading)
    trails = parse_int_list(args.trailing)
    out: list[Config] = []
    for d in defaults:
        for m in maxes:
            if d > m:
                continue
            for l in leads:
                for t in trails:
                    out.append(Config(d, m, l, t))
    return out


def pareto(
    results: list[ReplayResult],
    max_truncations: int,
    max_regret_tokens: float = math.inf,
) -> list[ReplayResult]:
    # Frontier over (tokens lower, calls lower), excluding configs that truncate
    # more explicit requests than today's cap.
    clean = [
        r
        for r in results
        if r.truncations <= max_truncations and r.tokens <= max_regret_tokens
    ]
    clean.sort(key=lambda r: (r.tokens, r.calls))
    frontier: list[ReplayResult] = []
    best_calls = math.inf
    for r in clean:
        if r.calls < best_calls:
            frontier.append(r)
            best_calls = r.calls
    return frontier


def choose_recommended(
    results: list[ReplayResult], current: ReplayResult
) -> ReplayResult:
    # Objective: minimize tokens plus a small penalty for still needing calls,
    # while requiring no *additional* explicit-request truncations and at least
    # current first-call coverage. One avoided read call is valued at ~250
    # tokens of ergonomics.
    viable = [
        r
        for r in results
        if r.truncations <= current.truncations
        and r.first_cover_rate >= current.first_cover_rate
        and r.tokens <= current.tokens * 1.02
    ]
    if not viable:
        viable = [r for r in results if r.truncations <= current.truncations]
    if not viable:
        viable = results
    return min(
        viable,
        key=lambda r: (
            r.tokens
            + 250 * r.calls
            + 100_000 * max(0, r.truncations - current.truncations)
        ),
    )


def print_result(prefix: str, r: ReplayResult, baseline: ReplayResult) -> None:
    dtok = r.tokens - baseline.tokens
    dcalls = r.calls - baseline.calls
    print(
        f"{prefix:<14} {r.config.label():<22} "
        f"tokens={r.tokens / 1e6:8.2f}M ({dtok / baseline.tokens * 100:+6.2f}%)  "
        f"calls={r.calls:7,} ({dcalls:+7,})  "
        f"skipped={r.skipped_calls:6,}  "
        f"first-cover={r.first_cover_rate * 100:5.1f}%  "
        f"trunc={r.truncations:4,}"
    )


def plot(
    results: list[ReplayResult], current: ReplayResult, recommended: ReplayResult
) -> Path:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    plt.rcParams.update({"figure.dpi": 110, "font.size": 10})
    fig, axes = plt.subplots(2, 2, figsize=(15, 9))

    xs = np.array([r.calls for r in results])
    ys = np.array([r.tokens / 1e6 for r in results])
    colors = np.array([r.config.default for r in results])
    sizes = np.array([20 + min(80, r.config.trailing * 5) for r in results])

    ax = axes[0, 0]
    sc = ax.scatter(
        xs, ys, c=colors, s=sizes, cmap="viridis", alpha=0.65, edgecolors="none"
    )
    ax.scatter(
        [current.calls],
        [current.tokens / 1e6],
        marker="*",
        s=180,
        color="#111",
        label="current",
    )
    ax.scatter(
        [recommended.calls],
        [recommended.tokens / 1e6],
        marker="*",
        s=180,
        color="#dc2626",
        label="recommended",
    )
    ax.set_xlabel("paid read calls after replay")
    ax.set_ylabel("estimated read tokens (M)")
    ax.set_title("candidate trade-off: tokens vs follow-up calls")
    ax.legend(frameon=False)
    ax.grid(True, alpha=0.25, linestyle="--")
    cbar = fig.colorbar(sc, ax=ax)
    cbar.set_label("defaultLimit")

    ax = axes[0, 1]
    frontier = pareto(results, current.truncations)
    frontier.sort(key=lambda r: r.calls)
    ax.plot(
        [r.calls for r in frontier],
        [r.tokens / 1e6 for r in frontier],
        color="#2563eb",
        linewidth=2,
    )
    ax.scatter(
        [r.calls for r in frontier],
        [r.tokens / 1e6 for r in frontier],
        color="#2563eb",
        s=20,
    )
    ax.scatter(
        [current.calls],
        [current.tokens / 1e6],
        marker="*",
        s=180,
        color="#111",
        label="current",
    )
    ax.scatter(
        [recommended.calls],
        [recommended.tokens / 1e6],
        marker="*",
        s=180,
        color="#dc2626",
        label="recommended",
    )
    ax.set_xlabel("paid read calls")
    ax.set_ylabel("estimated read tokens (M)")
    ax.set_title("Pareto frontier (no extra explicit truncations)")
    ax.legend(frameon=False)
    ax.grid(True, alpha=0.25, linestyle="--")

    ax = axes[1, 0]
    by_default: dict[int, list[ReplayResult]] = defaultdict(list)
    for r in results:
        if (
            r.truncations <= current.truncations
            and r.config.leading == recommended.config.leading
            and r.config.trailing == recommended.config.trailing
        ):
            by_default[r.config.default].append(r)
    defaults = sorted(by_default)
    vals = [min(v, key=lambda r: r.tokens).tokens / 1e6 for v in by_default.values()]
    ax.bar([str(d) for d in defaults], vals, color="#16a34a")
    ax.axhline(
        current.tokens / 1e6, color="#111", linestyle="--", linewidth=1, label="current"
    )
    ax.set_xlabel("defaultLimit")
    ax.set_ylabel("best tokens (M)")
    ax.set_title(
        f"defaultLimit sensitivity (L={recommended.config.leading}, T={recommended.config.trailing})"
    )
    ax.legend(frameon=False)
    ax.grid(True, axis="y", alpha=0.25, linestyle="--")

    ax = axes[1, 1]
    top = sorted(
        [r for r in results if r.truncations <= current.truncations],
        key=lambda r: r.tokens + 250 * r.calls,
    )[:12]
    labels = [r.config.label() for r in top]
    token_delta = [(r.tokens - current.tokens) / current.tokens * 100 for r in top]
    call_delta = [(r.calls - current.calls) / current.calls * 100 for r in top]
    y = np.arange(len(top))
    ax.barh(y - 0.18, token_delta, height=0.35, color="#2563eb", label="token Δ%")
    ax.barh(y + 0.18, call_delta, height=0.35, color="#d97706", label="call Δ%")
    ax.set_yticks(y, labels)
    ax.invert_yaxis()
    ax.axvline(0, color="#111", linewidth=0.8)
    ax.set_xlabel("relative to current")
    ax.set_title("top configs by token+call objective")
    ax.legend(frameon=False)
    ax.grid(True, axis="x", alpha=0.25, linestyle="--")

    fig.suptitle("read configuration counterfactual optimizer", fontsize=13, y=0.995)
    fig.tight_layout()
    out = OUT_DIR / "read-optimizer.png"
    fig.savefig(out, bbox_inches="tight")
    plt.close(fig)
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description="read configuration optimizer")
    ap.add_argument(
        "--since", default=DEFAULT_SINCE, help=f"YYYY-MM-DD (default {DEFAULT_SINCE})"
    )
    ap.add_argument("--defaults", default="100,150,200,250,300,400,500,700,1000")
    ap.add_argument("--max-lines", default="500,750,1000,1500,2000,3000")
    ap.add_argument("--leading", default="0,3,5,10,20")
    ap.add_argument("--trailing", default="0,3,10,25,50,100,200")
    ap.add_argument("--top", type=int, default=15, help="print top N configs")
    args = ap.parse_args()

    since = datetime.strptime(args.since, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    since_ms = int(since.timestamp() * 1000)

    if not DB_PATH.exists():
        sys.exit(f"db missing: {DB_PATH}")
    conn = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
    groups = load_reads(conn, since_ms)
    conn.close()
    total_calls = sum(len(v) for v in groups.values())
    print(
        f"loaded {total_calls:,} read calls across {len(groups):,} (session,file) groups since {args.since}"
    )

    current = replay(
        groups,
        Config(CURRENT_DEFAULT, CURRENT_MAX_LINES, CURRENT_LEADING, CURRENT_TRAILING),
    )
    configs = candidate_grid(args)
    # Ensure current is present even if user overrides grid.
    cur_cfg = Config(
        CURRENT_DEFAULT, CURRENT_MAX_LINES, CURRENT_LEADING, CURRENT_TRAILING
    )
    if cur_cfg not in configs:
        configs.append(cur_cfg)
    print(f"evaluating {len(configs):,} candidate configs")
    results = [replay(groups, cfg) for cfg in configs]
    recommended = choose_recommended(results, current)

    print()
    print_result("current", current, current)
    print_result("recommended", recommended, current)

    allowed = [r for r in results if r.truncations <= current.truncations]
    print(
        f"\nTop token-minimizing configs (truncations <= current {current.truncations:,}):"
    )
    for i, r in enumerate(sorted(allowed, key=lambda r: r.tokens)[: args.top], 1):
        print_result(f"#{i}", r, current)

    print(
        f"\nTop balanced configs (tokens + 250 tokens/read-call objective, truncations <= current {current.truncations:,}):"
    )
    for i, r in enumerate(
        sorted(allowed, key=lambda r: r.tokens + 250 * r.calls)[: args.top], 1
    ):
        print_result(f"#{i}", r, current)

    no_call_increase = [r for r in allowed if r.calls <= current.calls]
    print(
        f"\nBest configs with calls <= current (truncations <= current {current.truncations:,}):"
    )
    for i, r in enumerate(
        sorted(no_call_increase, key=lambda r: r.tokens)[: args.top], 1
    ):
        print_result(f"#{i}", r, current)

    print("\nRecommended breakdown:")
    print(f"  selector groups         : {recommended.selector_groups:,}")
    print(f"  selector first-cover    : {recommended.first_cover_rate * 100:.1f}%")
    print(f"  selector skipped calls  : {recommended.selector_skipped:,}")
    print(f"  default skipped calls   : {recommended.default_skipped:,}")
    print(f"  raw/unmodelled calls    : {recommended.raw_calls:,}")
    print(f"  byte-limited estimates  : {recommended.bytes_limited:,}")

    out = plot(results, current, recommended)
    print(f"\nwrote {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
