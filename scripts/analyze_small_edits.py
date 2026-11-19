#!/usr/bin/env python3

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import asdict, dataclass
from pathlib import Path
import argparse
import json
import re
import sys

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from tool_io import (
        ReservoirSample,
        ToolIOConfig,
        ToolInvocation,
        iter_tool_invocations,
        list_recent_session_files,
    )
else:
    from scripts.tool_io import (
        ReservoirSample,
        ToolIOConfig,
        ToolInvocation,
        iter_tool_invocations,
        list_recent_session_files,
    )

TOOL_NAMES = ("edit", "ast_edit")


@dataclass(slots=True)
class DiffSummary:
    small: bool
    added_lines: int
    removed_lines: int
    changed_lines: int
    changed_preview: list[str]
    category: str | None = None


@dataclass(slots=True)
class CompletedEdit:
    session_file: str
    tool_call_id: str
    tool_name: str
    path: str
    args: dict[str, object]
    result_text: str
    diff: str | None
    is_error: bool
    assistant_thinking: str | None
    assistant_timestamp: str | None
    tool_timestamp: str | None
    issue: str
    small: bool
    small_category: str | None
    added_lines: int
    removed_lines: int
    changed_lines: int
    changed_preview: list[str]


@dataclass(slots=True)
class PreviousEditSummary:
    tool_name: str
    path: str
    issue: str
    is_error: bool
    small: bool
    same_path: bool
    changed_preview: list[str]


@dataclass(slots=True)
class Candidate:
    kind: str
    edit: CompletedEdit
    previous_edit: PreviousEditSummary | None = None


@dataclass(slots=True)
class RunStats:
    files_scanned: int = 0
    total_edit_attempts: int = 0
    failed_edits: int = 0
    small_edits: int = 0
    small_edits_with_previous_edit: int = 0
    small_edits_with_previous_same_path: int = 0
    small_edits_after_failed_edit: int = 0
    small_edits_after_same_path_failed_edit: int = 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Analyze small edit/ast_edit tool usage in session logs."
    )
    parser.add_argument(
        "--sessions-dir", type=Path, default=Path.home() / ".omp" / "agent" / "sessions"
    )
    parser.add_argument("--sample-size", type=positive_int, default=30)
    parser.add_argument("--max-files", type=positive_int, default=500)
    parser.add_argument("--since-days", type=positive_int, default=30)
    parser.add_argument("--max-items", type=positive_int, default=50_000)
    parser.add_argument("--limit-mode", choices=("calls", "events"), default="calls")
    parser.add_argument("--json", action="store_true")
    return parser.parse_args()


def positive_int(value: str) -> int:
    parsed = int(value)
    if parsed <= 0:
        raise argparse.ArgumentTypeError("value must be a positive integer")
    return parsed


def strip_decorations(line: str) -> str:
    return re.sub(r"^\s*\d+\s+", "", line).strip()


def is_delimiter_line(line: str) -> bool:
    return bool(re.match(r"^[\]}),;]+$", line))


def is_tiny_structural_line(line: str) -> bool:
    if len(line) == 0:
        return True
    if is_delimiter_line(line):
        return True
    if re.match(r"^(pub\s+mod|pub\s+use|mod|use|import|export)\b", line):
        return True
    if re.match(r"^(return|break|continue);$", line):
        return True
    if re.match(r"^[A-Za-z0-9_.$]+\([^)]*\);$", line) and len(line) <= 60:
        return True
    return False


def classify_success_issue(summary: DiffSummary) -> str:
    previews = summary.changed_preview
    if previews and all(len(line) == 0 for line in previews):
        return "blank-line-adjustment"
    if previews and all(is_delimiter_line(line) for line in previews):
        return "delimiter-adjustment"
    if previews and all(
        re.match(r"^(pub\s+mod|pub\s+use|mod|use|import|export)\b", line)
        for line in previews
    ):
        return "import-or-module-tweak"
    if summary.removed_lines == 1 and summary.added_lines == 0:
        return "single-line-delete"
    if summary.added_lines == 1 and summary.removed_lines == 0:
        return "single-line-add"
    if summary.added_lines == 1 and summary.removed_lines == 1:
        return "single-line-replace"
    return "small-structural-fix"


def classify_failure_issue(result_text: str) -> str:
    if re.search(r"identical content|No changes made", result_text, re.IGNORECASE):
        return "no-op-identical"
    if re.search(
        r"Failed to find context|matches for context|expected lines|tag mismatch|>>>",
        result_text,
        re.IGNORECASE,
    ):
        return "context-mismatch"
    if re.search(
        r"Unexpected line in hunk|parse error|SyntaxError", result_text, re.IGNORECASE
    ):
        return "invalid-patch-shape"
    if re.search(r"File not found", result_text, re.IGNORECASE):
        return "missing-file"
    if re.search(r"occurrence|ambiguous", result_text, re.IGNORECASE):
        return "ambiguous-target"
    if re.search(
        r"Validation failed|required property|must have required property",
        result_text,
        re.IGNORECASE,
    ):
        return "invalid-arguments"
    return "other-failure"


def summarize_diff(diff: str | None) -> DiffSummary:
    if not diff:
        return DiffSummary(
            small=False,
            added_lines=0,
            removed_lines=0,
            changed_lines=0,
            changed_preview=[],
        )

    added: list[str] = []
    removed: list[str] = []
    for raw_line in diff.splitlines():
        if raw_line.startswith(("+++", "---", "@@")):
            continue
        if raw_line.startswith("+"):
            added.append(strip_decorations(raw_line[1:]))
            continue
        if raw_line.startswith("-"):
            removed.append(strip_decorations(raw_line[1:]))

    all_changes = [*removed, *added]
    include_blank = previews_need_blank_marker(all_changes)
    previews = [line for line in all_changes if line or include_blank]
    changed_lines = len(added) + len(removed)
    tiny_only = all(is_tiny_structural_line(line) for line in all_changes)
    small = changed_lines > 0 and (
        changed_lines <= 2 or (changed_lines <= 4 and tiny_only)
    )
    preview_slice = previews[:4]
    category = None
    if small:
        category = classify_success_issue(
            DiffSummary(
                small=small,
                added_lines=len(added),
                removed_lines=len(removed),
                changed_lines=changed_lines,
                changed_preview=preview_slice,
            )
        )
    return DiffSummary(
        small=small,
        added_lines=len(added),
        removed_lines=len(removed),
        changed_lines=changed_lines,
        changed_preview=preview_slice,
        category=category,
    )


def previews_need_blank_marker(lines: list[str]) -> bool:
    return any(len(line) == 0 for line in lines)


def build_completed_edit(invocation: ToolInvocation) -> CompletedEdit | None:
    if not invocation.has_result:
        return None
    diff_summary = summarize_diff(invocation.diff)
    is_error = invocation.is_error
    issue = (
        classify_failure_issue(invocation.result_text)
        if is_error
        else (diff_summary.category or "other-success")
    )
    return CompletedEdit(
        session_file=str(invocation.session_file),
        tool_call_id=invocation.tool_call_id,
        tool_name=invocation.tool_name,
        path=invocation.path_hint,
        args=invocation.arguments,
        result_text=invocation.result_text,
        diff=invocation.diff,
        is_error=is_error,
        assistant_thinking=invocation.assistant_thinking,
        assistant_timestamp=invocation.assistant_timestamp,
        tool_timestamp=invocation.tool_timestamp,
        issue=issue,
        small=(not is_error and diff_summary.small),
        small_category=diff_summary.category,
        added_lines=diff_summary.added_lines,
        removed_lines=diff_summary.removed_lines,
        changed_lines=diff_summary.changed_lines,
        changed_preview=diff_summary.changed_preview,
    )


def analyze_small_edits(
    stream: Iterable[ToolInvocation], *, sample_size: int, files_scanned: int
) -> dict[str, object]:
    sample: ReservoirSample[Candidate] = ReservoirSample(size=sample_size)
    issue_counts: dict[str, int] = {}
    stats = RunStats(files_scanned=files_scanned)
    last_edit: CompletedEdit | None = None

    for invocation in stream:
        completed = build_completed_edit(invocation)
        if completed is None:
            continue
        stats.total_edit_attempts += 1

        if completed.is_error:
            stats.failed_edits += 1
            issue_counts[completed.issue] = issue_counts.get(completed.issue, 0) + 1
            sample.add(Candidate(kind="failed", edit=completed))

        if completed.small:
            stats.small_edits += 1
            issue_counts[completed.issue] = issue_counts.get(completed.issue, 0) + 1
            previous = None
            if last_edit is not None:
                stats.small_edits_with_previous_edit += 1
                if last_edit.is_error:
                    stats.small_edits_after_failed_edit += 1
                if last_edit.path and last_edit.path == completed.path:
                    stats.small_edits_with_previous_same_path += 1
                    if last_edit.is_error:
                        stats.small_edits_after_same_path_failed_edit += 1
                previous = PreviousEditSummary(
                    tool_name=last_edit.tool_name,
                    path=last_edit.path,
                    issue=last_edit.issue,
                    is_error=last_edit.is_error,
                    small=last_edit.small,
                    same_path=last_edit.path == completed.path,
                    changed_preview=last_edit.changed_preview,
                )
            sample.add(Candidate(kind="small", edit=completed, previous_edit=previous))

        last_edit = completed

    return {
        "stats": asdict(stats),
        "top_issues": top_entries(issue_counts, 20),
        "sample": [candidate_to_dict(candidate) for candidate in sample.items],
    }


def candidate_to_dict(candidate: Candidate) -> dict[str, object]:
    payload = {"kind": candidate.kind, "edit": asdict(candidate.edit)}
    if candidate.previous_edit is not None:
        payload["previous_edit"] = asdict(candidate.previous_edit)
    return payload


def top_entries(counts: dict[str, int], limit: int) -> list[dict[str, object]]:
    return [
        {"name": name, "count": count}
        for name, count in sorted(
            counts.items(), key=lambda entry: (-entry[1], entry[0])
        )[:limit]
    ]


def short_path(target_path: str) -> str:
    home = str(Path.home())
    return (
        f"~{target_path[len(home) :]}" if target_path.startswith(home) else target_path
    )


def truncate(text: str, limit: int) -> str:
    if len(text) <= limit:
        return text
    return f"{text[: limit - 1]}…"


def format_sample_entry(candidate: dict[str, object], index: int) -> str:
    edit = candidate["edit"]
    assert isinstance(edit, dict)
    lines = [
        f"{index + 1}. [{candidate['kind']}] {edit['issue']}",
        f"   file: {Path(str(edit['session_file'])).name}",
        f"   target: {short_path(str(edit['path'])) if edit['path'] else '(unknown path)'}",
        f"   tool: {edit['tool_name']}",
    ]
    if candidate["kind"] == "small":
        lines.append(
            f"   change: +{edit['added_lines']} / -{edit['removed_lines']} ({edit['changed_lines']} changed line(s))"
        )
        changed_preview = edit.get("changed_preview")
        if isinstance(changed_preview, list) and changed_preview:
            lines.append(
                f"   preview: {' | '.join(str(item) for item in changed_preview)}"
            )
        previous = candidate.get("previous_edit")
        if isinstance(previous, dict):
            path_part = (
                f" ({short_path(str(previous['path']))})"
                if previous.get("path")
                else ""
            )
            lines.append(
                "   previous edit: "
                f"{'same-path' if previous.get('same_path') else 'other-path'} "
                f"{'failed' if previous.get('is_error') else previous.get('issue')}{path_part}"
            )
            previous_preview = previous.get("changed_preview")
            if isinstance(previous_preview, list) and previous_preview:
                lines.append(
                    f"   previous preview: {' | '.join(str(item) for item in previous_preview)}"
                )
        else:
            lines.append("   previous edit: none")
    else:
        lines.append(
            f"   result: {truncate(' '.join(str(edit['result_text']).split()), 220)}"
        )
        changed_preview = edit.get("changed_preview")
        if isinstance(changed_preview, list) and changed_preview:
            lines.append(
                f"   diff preview: {' | '.join(str(item) for item in changed_preview)}"
            )
    return "\n".join(lines)


def main() -> None:
    options = parse_args()
    config = ToolIOConfig(
        sessions_dir=options.sessions_dir,
        since_days=options.since_days,
        max_files=options.max_files,
        max_items=options.max_items,
        limit_mode=options.limit_mode,
        include_unresolved=False,
    )
    files = list_recent_session_files(config)
    stream = iter_tool_invocations(TOOL_NAMES, config)
    analysis = analyze_small_edits(
        stream, sample_size=options.sample_size, files_scanned=len(files)
    )

    if options.json:
        print(
            json.dumps(
                {
                    "options": {
                        "sessions_dir": str(options.sessions_dir),
                        "sample_size": options.sample_size,
                        "max_files": options.max_files,
                        "since_days": options.since_days,
                        "max_items": options.max_items,
                        "limit_mode": options.limit_mode,
                        "json": options.json,
                    },
                    **analysis,
                },
                indent=2,
            )
        )
        return

    stats = analysis["stats"]
    top_issues = analysis["top_issues"]
    sample = analysis["sample"]
    assert isinstance(stats, dict)
    assert isinstance(top_issues, list)
    assert isinstance(sample, list)
    print(
        f"Scanned {stats['files_scanned']} session file(s) from {short_path(str(options.sessions_dir))}"
    )
    print(f"Edit attempts: {stats['total_edit_attempts']}")
    print(f"Failed edits: {stats['failed_edits']}")
    print(f"Small edits: {stats['small_edits']}")
    print(f"Small edits with previous edit: {stats['small_edits_with_previous_edit']}")
    print(
        f"Small edits with previous same-path edit: {stats['small_edits_with_previous_same_path']}"
    )
    print(f"Small edits after failed edit: {stats['small_edits_after_failed_edit']}")
    print(
        f"Small edits after same-path failed edit: {stats['small_edits_after_same_path_failed_edit']}"
    )
    print()
    print("Top issues:")
    for entry in top_issues[:12]:
        assert isinstance(entry, dict)
        print(f"  - {entry['name']}: {entry['count']}")
    print()
    print(f"Random sample ({len(sample)}):")
    for index, candidate in enumerate(sample):
        assert isinstance(candidate, dict)
        print(format_sample_entry(candidate, index))
        print()


if __name__ == "__main__":
    main()
