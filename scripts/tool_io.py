#!/usr/bin/env python3

from __future__ import annotations

from collections.abc import Iterable, Iterator
from dataclasses import dataclass, field
from pathlib import Path
import json
import random
import time
from typing import Any, Literal

LimitMode = Literal["calls", "events"]

DEFAULT_MAX_ITEMS = 50_000
DEFAULT_SINCE_DAYS = 30
DEFAULT_MAX_FILES = 500
DEFAULT_SESSIONS_DIR = Path.home() / ".omp" / "agent" / "sessions"


TOOL_GROUPS: dict[str, tuple[str, ...]] = {
    "edits": ("edit", "ast_edit"),
    "reads": ("read", "grep", "find", "ast_grep", "lsp"),
    "writes": ("edit", "ast_edit", "write"),
}


@dataclass(slots=True)
class ToolIOConfig:
    sessions_dir: Path = DEFAULT_SESSIONS_DIR
    since_days: int = DEFAULT_SINCE_DAYS
    max_files: int = DEFAULT_MAX_FILES
    max_items: int = DEFAULT_MAX_ITEMS
    limit_mode: LimitMode = "calls"
    include_unresolved: bool = True


@dataclass(slots=True)
class ToolCall:
    session_file: Path
    tool_call_id: str
    tool_name: str
    arguments: dict[str, Any]
    assistant_thinking: str | None = None
    assistant_timestamp: str | None = None
    path_hint: str = ""


@dataclass(slots=True)
class ToolResult:
    tool_call_id: str
    tool_name: str
    is_error: bool
    result_text: str
    details: dict[str, Any] = field(default_factory=dict)
    tool_timestamp: str | None = None


@dataclass(slots=True)
class ToolInvocation:
    call: ToolCall
    result: ToolResult | None = None

    @property
    def session_file(self) -> Path:
        return self.call.session_file

    @property
    def tool_call_id(self) -> str:
        return self.call.tool_call_id

    @property
    def tool_name(self) -> str:
        return self.call.tool_name

    @property
    def arguments(self) -> dict[str, Any]:
        return self.call.arguments

    @property
    def assistant_thinking(self) -> str | None:
        return self.call.assistant_thinking

    @property
    def assistant_timestamp(self) -> str | None:
        return self.call.assistant_timestamp

    @property
    def tool_timestamp(self) -> str | None:
        return self.result.tool_timestamp if self.result else None

    @property
    def path_hint(self) -> str:
        return self.call.path_hint

    @property
    def has_result(self) -> bool:
        return self.result is not None

    @property
    def is_error(self) -> bool:
        return bool(self.result and self.result.is_error)

    @property
    def result_text(self) -> str:
        return self.result.result_text if self.result else ""

    @property
    def details(self) -> dict[str, Any]:
        return self.result.details if self.result else {}

    @property
    def diff(self) -> str | None:
        diff = self.details.get("diff")
        return diff if isinstance(diff, str) else None


@dataclass(slots=True)
class ReservoirSample[T]:
    size: int
    items: list[T] = field(default_factory=list)
    seen: int = 0
    rng: random.Random = field(default_factory=random.Random)

    def add(self, item: T) -> None:
        if self.size <= 0:
            return
        self.seen += 1
        if len(self.items) < self.size:
            self.items.append(item)
            return
        index = self.rng.randrange(self.seen)
        if index < self.size:
            self.items[index] = item


def list_recent_session_files(config: ToolIOConfig) -> list[Path]:
    min_mtime = time.time() - config.since_days * 24 * 60 * 60
    candidates: list[tuple[float, Path]] = []
    for session_file in config.sessions_dir.rglob("*.jsonl"):
        try:
            stat = session_file.stat()
        except FileNotFoundError:
            continue
        if stat.st_mtime < min_mtime:
            continue
        candidates.append((stat.st_mtime, session_file))
    candidates.sort(key=lambda entry: entry[0], reverse=True)
    return [entry[1] for entry in candidates[: config.max_files]]


def iter_tool_invocations(
    tool_names: str | Iterable[str],
    config: ToolIOConfig | None = None,
) -> Iterator[ToolInvocation]:
    resolved = config or ToolIOConfig()
    wanted = _normalize_tool_names(tool_names)
    seen_items = 0

    for session_file in list_recent_session_files(resolved):
        pending: dict[str, ToolCall] = {}
        for entry in _iter_session_entries(session_file):
            if entry.get("type") != "message":
                continue
            message = _as_record(entry.get("message"))
            if message is None:
                continue

            role = message.get("role")
            if role == "assistant":
                content = message.get("content")
                if not isinstance(content, list):
                    continue
                thinking = _extract_thinking(content)
                assistant_timestamp = _as_string(entry.get("timestamp"))
                for item in content:
                    payload = _as_record(item)
                    if payload is None:
                        continue
                    if payload.get("type") != "toolCall":
                        continue
                    tool_name = _as_string(payload.get("name"))
                    tool_call_id = _as_string(payload.get("id"))
                    if (
                        tool_name is None
                        or tool_call_id is None
                        or tool_name not in wanted
                    ):
                        continue
                    arguments = _as_record(payload.get("arguments")) or {}
                    pending[tool_call_id] = ToolCall(
                        session_file=session_file,
                        tool_call_id=tool_call_id,
                        tool_name=tool_name,
                        arguments=arguments,
                        assistant_thinking=thinking,
                        assistant_timestamp=assistant_timestamp,
                        path_hint=extract_path(arguments),
                    )
                continue

            if role != "toolResult":
                continue
            tool_name = _as_string(message.get("toolName"))
            tool_call_id = _as_string(message.get("toolCallId"))
            if tool_name is None or tool_call_id is None or tool_name not in wanted:
                continue
            pending_call = pending.pop(tool_call_id, None)
            if pending_call is None:
                continue
            result = ToolResult(
                tool_call_id=tool_call_id,
                tool_name=tool_name,
                is_error=message.get("isError") is True,
                result_text=extract_result_text(message),
                details=_as_record(message.get("details")) or {},
                tool_timestamp=_as_string(entry.get("timestamp")),
            )
            invocation = ToolInvocation(call=pending_call, result=result)
            seen_items += _event_weight(invocation, resolved.limit_mode)
            yield invocation
            if seen_items >= resolved.max_items:
                return

        if not resolved.include_unresolved:
            continue
        for pending_call in pending.values():
            invocation = ToolInvocation(call=pending_call)
            seen_items += _event_weight(invocation, resolved.limit_mode)
            yield invocation
            if seen_items >= resolved.max_items:
                return


def iter_results(stream: Iterable[ToolInvocation]) -> Iterator[ToolInvocation]:
    for invocation in stream:
        if invocation.has_result:
            yield invocation


def iter_failed(stream: Iterable[ToolInvocation]) -> Iterator[ToolInvocation]:
    for invocation in stream:
        if invocation.is_error:
            yield invocation


def iter_successful(stream: Iterable[ToolInvocation]) -> Iterator[ToolInvocation]:
    for invocation in stream:
        if invocation.has_result and not invocation.is_error:
            yield invocation


def iter_with_diff(stream: Iterable[ToolInvocation]) -> Iterator[ToolInvocation]:
    for invocation in stream:
        if invocation.diff:
            yield invocation


def iter_paths(
    stream: Iterable[ToolInvocation], *paths: str
) -> Iterator[ToolInvocation]:
    wanted = set(paths)
    for invocation in stream:
        if invocation.path_hint in wanted:
            yield invocation


def take(stream: Iterable[ToolInvocation], limit: int) -> Iterator[ToolInvocation]:
    if limit <= 0:
        return
    remaining = limit
    for invocation in stream:
        if remaining <= 0:
            return
        yield invocation
        remaining -= 1


def sample_reservoir[T](
    stream: Iterable[T], size: int, seed: int | None = None
) -> list[T]:
    sample: ReservoirSample[T] = ReservoirSample(size=size, rng=random.Random(seed))
    for item in stream:
        sample.add(item)
    return sample.items


def extract_result_text(message: dict[str, Any] | None) -> str:
    if message is None:
        return ""
    content = message.get("content")
    if not isinstance(content, list):
        return ""
    for item in content:
        payload = _as_record(item)
        if payload is None:
            continue
        if payload.get("type") != "text":
            continue
        text = _as_string(payload.get("text"))
        if text is not None:
            return text
    return ""


def extract_path(arguments: dict[str, Any]) -> str:
    for key in ("path", "file", "move"):
        value = arguments.get(key)
        if isinstance(value, str):
            return value
    return ""


def _iter_session_entries(session_file: Path) -> Iterator[dict[str, Any]]:
    with session_file.open("r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                continue
            payload = _as_record(entry)
            if payload is not None:
                yield payload


def _extract_thinking(content: list[Any]) -> str | None:
    for item in content:
        payload = _as_record(item)
        if payload is None:
            continue
        if payload.get("type") != "thinking":
            continue
        thinking = _as_string(payload.get("thinking"))
        if thinking:
            return thinking
    return None


def resolve_tool_names(*names_or_groups: str) -> tuple[str, ...]:
    ordered: list[str] = []
    seen: set[str] = set()
    for name in names_or_groups:
        expanded = TOOL_GROUPS.get(name, (name,))
        for tool_name in expanded:
            if tool_name in seen:
                continue
            seen.add(tool_name)
            ordered.append(tool_name)
    return tuple(ordered)


def _normalize_tool_names(tool_names: str | Iterable[str]) -> set[str]:
    if isinstance(tool_names, str):
        return set(resolve_tool_names(tool_names))
    ordered: list[str] = []
    for name in tool_names:
        ordered.extend(resolve_tool_names(name))
    return set(ordered)


def _event_weight(invocation: ToolInvocation, limit_mode: LimitMode) -> int:
    if limit_mode == "calls":
        return 1
    return 2 if invocation.has_result else 1


def _as_record(value: Any) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        return None
    return value


def _as_string(value: Any) -> str | None:
    return value if isinstance(value, str) else None
