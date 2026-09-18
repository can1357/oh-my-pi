#!/usr/bin/env python
"""Triage a v2 trace export into training-ready, quarantined, and rejected sets.

The v2 exporter (``export_traces_to_hf_v2.py``) emits every episode it can
reconstruct. Some of those episodes are unusable as positive supervision, for
reasons that are mechanically detectable:

* ``blind-observations``   -- a quarter or more of the tool results were replaced
  by transcript placeholders such as ``[bash result consumed]``, so the action
  that follows the observation is unexplainable from the visible context.
* ``orphan-observations``  -- ``role: "tool"`` messages whose ``tool_call_id``
  was never emitted by any assistant turn: observations from nowhere.
* ``telemetry-feed``       -- advisor episodes whose "user" turns are
  ``### Session update`` notifications about *another* agent's work. Well formed,
  but the wrong distribution for training a coding agent.
* ``truncated-ending``     -- the episode stops on an observation or a user turn,
  so the trajectory has no final answer to supervise.
* ``harness-failure``      -- the failing observation is a harness timeout, crash
  or cancellation rather than a real tool error.
* ``empty-assistant-turn`` / ``too-short`` -- degenerate records.
* ``user-corrected``       -- the user explicitly told the agent it was wrong.
  Quarantined rather than dropped: these are the useful negatives.
* ``weak-premise``         -- a ``[state] Continuing prior work session`` turn,
  meaning the actual instruction was summarised away before capture.

One defect is repaired rather than rejected: ``tool_call_id`` values that glue a
Chat Completions ``call_*`` id to a Responses ``fc_*`` id with whitespace. The
component that matches the emitting assistant turn is kept, which makes the row
schema-valid again without touching its content.

Usage:
    python scripts/triage_traces_v2.py [--input PATH] [--outdir DIR] [--json]
"""

from __future__ import annotations

import argparse
import json
import re
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

PLACEHOLDER = re.compile(r"^\[[^\]]*\b(?:consumed|elided|truncated|omitted)\b[^\]]*\]$", re.I)
TELEMETRY = re.compile(r"^###\s*Session update", re.M)
RESUMED = re.compile(r"^\[state\]\s*Continuing prior work session|earlier context summarised|earlier context summarized", re.M)
HARNESS_FAIL = re.compile(
    r"Command timed out|\[Command cancelled\]|exit code 143|Bun has crashed|panic\(main thread\)|Validation failed for tool",
    re.I,
)
# Deliberately precision-biased. Bare "no" is approval as often as rebuke
# ("no thats ok"), and a lone "incorrect" is usually a taxonomy label in this
# corpus ("'IX Team' -> 'Incorrect Data Input'"), so neither qualifies alone.
CORRECTION = re.compile(
    r"\b(?:that'?s (?:not|wrong|incorrect)|that isn'?t|this is wrong|you'?re wrong|"
    r"you (?:didn'?t|did not|failed to|broke|missed|were supposed to)|"
    r"not what i asked|try again|do it again|redo\b|revert that|still wrong|wrong still|"
    r"didn'?t (?:match|work)|doesn'?t work|make sure you)"
    r"|^\s*(?:wrong|nope)\b",
    re.I,
)
ID_TOKEN = re.compile(r"(?:call[_-]|fc[_-]|toolu[_-]|tooluse[_-])")
# The exporter glues a Chat Completions id to a Responses id with a newline
# (1k occurrences) or a pipe (13k), depending on the provider surface.
ID_GLUE = re.compile(r"[\s|,;]+")

HARD_DEFECTS = (
    "blind-observations",
    "orphan-observations",
    "telemetry-feed",
    "truncated-ending",
    "harness-failure",
    "empty-assistant-turn",
    "too-short",
)

BLIND_THRESHOLD = 0.25
MIN_MESSAGES = 5
GOLD_MIN_MESSAGES = 8


@dataclass
class Episode:
    record: dict[str, Any]
    index: int = 0
    tags: set[str] = field(default_factory=set)
    stats: dict[str, Any] = field(default_factory=dict)

    @property
    def episode_id(self) -> str:
        return str(self.record.get("episode_id", ""))

    @property
    def uid(self) -> str:
        """Stable key. ``episode_id`` alone collides: the exporter restarts its
        per-session index, while every advisor call collapses into one
        ``__advisor`` pseudo-session."""
        return f"{self.episode_id}@{self.index}"


def normalise_call_id(raw: str) -> str:
    """Collapse a glued ``call_x|fc_y`` id to its Chat Completions component.

    Pure function of the string, so applying it to the assistant's
    ``tool_calls[].id`` and to the matching ``tool_call_id`` keeps both sides
    consistent regardless of visit order.
    """
    parts = [p for p in ID_GLUE.split(raw) if p]
    if len(parts) <= 1:
        return raw
    return next((p for p in parts if p.startswith(("call_", "call-"))), parts[0])


def repair_tool_call_ids(record: dict[str, Any]) -> int:
    """Normalise glued ids on *both* sides of every call/result pair.

    The exporter glues the two provider ids together on the assistant turn and
    on the tool result alike, so they already match each other; normalising one
    side alone would break the pairing. Returns the number of ids rewritten.
    """
    repaired = 0
    for message in record["messages"]:
        for call in message.get("tool_calls") or []:
            raw = call.get("id") or ""
            fixed = normalise_call_id(raw)
            if fixed != raw:
                call["id"] = fixed
                repaired += 1
        if message.get("role") == "tool":
            raw = message.get("tool_call_id") or ""
            fixed = normalise_call_id(raw)
            if fixed != raw:
                message["tool_call_id"] = fixed
                repaired += 1
    return repaired


def analyse(record: dict[str, Any]) -> Episode:
    messages = record["messages"]
    episode = Episode(record=record)

    emitted: set[str] = set()
    for message in messages:
        for call in message.get("tool_calls") or []:
            if call.get("id"):
                emitted.add(call["id"])

    tool_total = blinded = errored = orphan = empty_assistant = reasoning = calls = 0
    user_turns: list[str] = []
    for message in messages:
        role = message.get("role")
        content = (message.get("content") or "").strip()
        if role == "tool":
            tool_total += 1
            if PLACEHOLDER.match(content):
                blinded += 1
            if message.get("is_error"):
                errored += 1
                if HARNESS_FAIL.search(content):
                    episode.tags.add("harness-failure")
            if (message.get("tool_call_id") or "") not in emitted:
                orphan += 1
        elif role == "assistant":
            if message.get("reasoning_content"):
                reasoning += 1
            calls += len(message.get("tool_calls") or [])
            if not content and not message.get("tool_calls"):
                empty_assistant += 1
        elif role == "user":
            user_turns.append(content)

    last = messages[-1] if messages else {}
    final_answer = (
        last.get("role") == "assistant"
        and bool((last.get("content") or "").strip())
        and not last.get("tool_calls")
    )

    telemetry = sum(1 for u in user_turns if TELEMETRY.search(u))
    resumed = sum(1 for u in user_turns if RESUMED.search(u))
    blind_rate = blinded / tool_total if tool_total else 0.0

    if user_turns and telemetry / len(user_turns) > 0.5:
        episode.tags.add("telemetry-feed")
    if blind_rate >= BLIND_THRESHOLD:
        episode.tags.add("blind-observations")
    elif blinded:
        episode.tags.add("partial-observations")
    if orphan:
        episode.tags.add("orphan-observations")
    if not final_answer:
        episode.tags.add("truncated-ending")
    if empty_assistant:
        episode.tags.add("empty-assistant-turn")
    if len(messages) < MIN_MESSAGES:
        episode.tags.add("too-short")
    if resumed:
        episode.tags.add("weak-premise")
    if any(CORRECTION.search(u) for u in user_turns):
        episode.tags.add("user-corrected")
    if tool_total == 0 and reasoning == 0:
        episode.tags.add("no-tools-no-reasoning")

    episode.stats = {
        "messages": len(messages),
        "user_turns": len(user_turns),
        "tool_results": tool_total,
        "tool_calls": calls,
        "blinded": blinded,
        "blind_rate": round(blind_rate, 4),
        "errors": errored,
        "orphan_observations": orphan,
        "reasoning_messages": reasoning,
        "final_answer": final_answer,
    }
    return episode


# A negative example only has to be *readable* — the point is to see the agent
# being told it was wrong. Blinding and a weak premise are tolerated here;
# unreadable structure is not.
UNREADABLE = ("telemetry-feed", "orphan-observations", "too-short", "empty-assistant-turn")


def classify(episode: Episode) -> str:
    if "user-corrected" in episode.tags and not any(tag in episode.tags for tag in UNREADABLE):
        return "quarantine"
    if any(tag in episode.tags for tag in HARD_DEFECTS):
        return "reject"
    stats = episode.stats
    if (
        stats["blinded"] == 0
        and stats["reasoning_messages"] > 0
        and stats["tool_calls"] > 0
        and stats["messages"] >= GOLD_MIN_MESSAGES
        and "weak-premise" not in episode.tags
    ):
        return "gold"
    return "keep"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--input", default="interconnection_dash_traces_v2.jsonl", type=Path)
    parser.add_argument("--outdir", default=Path("."), type=Path)
    parser.add_argument("--json", action="store_true", help="print the summary as JSON")
    args = parser.parse_args()

    episodes: list[Episode] = []
    repaired_ids = 0
    with open(args.input, encoding="utf-8") as handle:
        for index, line in enumerate(handle):
            line = line.strip()
            if not line:
                continue
            record = json.loads(line)
            repaired_ids += repair_tool_call_ids(record)
            episode = analyse(record)
            episode.index = index
            episodes.append(episode)

    id_counts = Counter(e.episode_id for e in episodes)
    for episode in episodes:
        if id_counts[episode.episode_id] > 1:
            episode.tags.add("duplicate-episode-id")

    verdicts = {episode.uid: classify(episode) for episode in episodes}
    tally = Counter(verdicts.values())
    tags = Counter(tag for episode in episodes for tag in episode.tags)

    args.outdir.mkdir(parents=True, exist_ok=True)
    clean_path = args.outdir / "train_v2_clean.jsonl"
    negative_path = args.outdir / "train_v2_negative.jsonl"
    report_path = args.outdir / "triage_v2_report.json"

    kept_messages = 0
    with open(clean_path, "w", encoding="utf-8") as clean, open(negative_path, "w", encoding="utf-8") as negative:
        for episode in episodes:
            verdict = verdicts[episode.uid]
            record = dict(episode.record)
            record["quality"] = {
                "uid": episode.uid,
                "verdict": verdict,
                "tags": sorted(episode.tags),
                **episode.stats,
            }
            line = json.dumps(record, ensure_ascii=False)
            if verdict in {"gold", "keep"}:
                clean.write(line + "\n")
                kept_messages += episode.stats["messages"]
            elif verdict == "quarantine":
                negative.write(line + "\n")

    report = {
        "input": str(args.input),
        "episodes": len(episodes),
        "verdicts": dict(tally),
        "tags": dict(tags.most_common()),
        "repaired_tool_call_ids": repaired_ids,
        "kept_messages": kept_messages,
        "total_messages": sum(e.stats["messages"] for e in episodes),
        "thresholds": {
            "blind_rate_reject": BLIND_THRESHOLD,
            "min_messages": MIN_MESSAGES,
            "gold_min_messages": GOLD_MIN_MESSAGES,
        },
        "per_episode": {
            e.uid: {"verdict": verdicts[e.uid], "tags": sorted(e.tags), **e.stats} for e in episodes
        },
    }
    report_path.write_text(json.dumps(report, indent=1, ensure_ascii=False), encoding="utf-8")

    if args.json:
        print(json.dumps({k: v for k, v in report.items() if k != "per_episode"}, indent=1))
        return 0

    print(f"input                  {args.input}")
    print(f"episodes               {len(episodes)}")
    print(f"repaired tool_call_ids {repaired_ids}")
    print("\nverdicts")
    for verdict in ("gold", "keep", "quarantine", "reject"):
        print(f"  {verdict:<11} {tally.get(verdict, 0):>4}")
    print("\ndefect tags")
    for tag, count in tags.most_common():
        print(f"  {tag:<24} {count:>4}")
    print(f"\nwrote {clean_path} ({tally.get('gold', 0) + tally.get('keep', 0)} episodes, {kept_messages:,} messages)")
    print(f"wrote {negative_path} ({tally.get('quarantine', 0)} episodes)")
    print(f"wrote {report_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
