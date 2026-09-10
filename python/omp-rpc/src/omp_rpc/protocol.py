from __future__ import annotations

import base64
import mimetypes
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Final, Literal, NotRequired, TypeAlias, TypedDict, cast

JsonPrimitive: TypeAlias = str | int | float | bool | None
JsonValue: TypeAlias = JsonPrimitive | list["JsonValue"] | dict[str, "JsonValue"]
JsonObject: TypeAlias = dict[str, JsonValue]

Attribution: TypeAlias = Literal["user", "agent"]
Effort: TypeAlias = Literal["minimal", "low", "medium", "high", "xhigh", "max"]
ThinkingLevel: TypeAlias = Literal[
    "off", "minimal", "low", "medium", "high", "xhigh", "max"
]
StreamingBehavior: TypeAlias = Literal["steer", "followUp"]
SteeringMode: TypeAlias = Literal["all", "one-at-a-time"]
InterruptMode: TypeAlias = Literal["immediate", "wait"]
StopReason: TypeAlias = Literal["stop", "length", "toolUse", "error", "aborted"]
NotifyType: TypeAlias = Literal["info", "warning", "error"]
WidgetPlacement: TypeAlias = Literal["aboveEditor", "belowEditor"]
TodoStatus: TypeAlias = Literal[
    "pending", "in_progress", "completed", "abandoned", "blocked"
]
ExtensionUiMethod: TypeAlias = Literal[
    "select",
    "confirm",
    "input",
    "editor",
    "cancel",
    "notify",
    "setStatus",
    "setWidget",
    "setTitle",
    "set_editor_text",
    "open_url",
]
InteractiveExtensionUiMethod: TypeAlias = Literal[
    "select", "confirm", "input", "editor"
]
PassiveExtensionUiMethod: TypeAlias = Literal[
    "notify",
    "setStatus",
    "setWidget",
    "setTitle",
    "set_editor_text",
    "open_url",
]
ValueExtensionUiMethod: TypeAlias = Literal["select", "input", "editor"]

PASSIVE_EXTENSION_UI_METHODS: Final[frozenset[PassiveExtensionUiMethod]] = frozenset(
    {
        "notify",
        "setStatus",
        "setWidget",
        "setTitle",
        "set_editor_text",
        "open_url",
    }
)
INTERACTIVE_EXTENSION_UI_METHODS: Final[frozenset[InteractiveExtensionUiMethod]] = (
    frozenset({"select", "confirm", "input", "editor"})
)
VALUE_EXTENSION_UI_METHODS: Final[frozenset[ValueExtensionUiMethod]] = frozenset(
    {"select", "input", "editor"}
)
_EFFORT_VALUES: Final[frozenset[str]] = frozenset(
    {"minimal", "low", "medium", "high", "xhigh", "max"}
)
_THINKING_LEVEL_VALUES: Final[frozenset[str]] = _EFFORT_VALUES | frozenset({"off"})
_STEERING_MODE_VALUES: Final[frozenset[str]] = frozenset({"all", "one-at-a-time"})
_INTERRUPT_MODE_VALUES: Final[frozenset[str]] = frozenset({"immediate", "wait"})
_STOP_REASON_VALUES: Final[frozenset[str]] = frozenset(
    {"stop", "length", "toolUse", "error", "aborted"}
)
_NOTIFY_TYPE_VALUES: Final[frozenset[str]] = frozenset({"info", "warning", "error"})
_WIDGET_PLACEMENT_VALUES: Final[frozenset[str]] = frozenset(
    {"aboveEditor", "belowEditor"}
)
_TODO_STATUS_VALUES: Final[frozenset[str]] = frozenset(
    {"pending", "in_progress", "completed", "abandoned", "blocked"}
)
_EXTENSION_UI_METHOD_VALUES: Final[frozenset[str]] = frozenset(
    {
        "select",
        "confirm",
        "input",
        "editor",
        "cancel",
        "notify",
        "setStatus",
        "setWidget",
        "setTitle",
        "set_editor_text",
        "open_url",
    }
)
_AGENT_MESSAGE_ROLE_VALUES: Final[frozenset[str]] = frozenset(
    {
        "user",
        "developer",
        "assistant",
        "toolResult",
        "bashExecution",
        "pythonExecution",
        "custom",
        "hookMessage",
        "branchSummary",
        "compactionSummary",
        "fileMention",
    }
)
_ASSISTANT_MESSAGE_EVENT_TYPE_VALUES: Final[frozenset[str]] = frozenset(
    {
        "start",
        "text_start",
        "text_delta",
        "text_end",
        "thinking_start",
        "thinking_delta",
        "thinking_end",
        "toolcall_start",
        "toolcall_delta",
        "toolcall_end",
        "done",
        "error",
    }
)
_ASSISTANT_DONE_REASON_VALUES: Final[frozenset[str]] = frozenset(
    {"stop", "length", "toolUse"}
)
_ASSISTANT_ERROR_REASON_VALUES: Final[frozenset[str]] = frozenset({"aborted", "error"})
_AUTO_COMPACTION_REASON_VALUES: Final[frozenset[str]] = frozenset(
    {"threshold", "overflow", "idle", "incomplete"}
)
_AUTO_COMPACTION_ACTION_VALUES: Final[frozenset[str]] = frozenset(
    {"context-full", "handoff", "shake", "snapcompact"}
)


def _clone_json_value(value: object, *, field: str) -> JsonValue:
    if value is None or isinstance(value, (str, int, float, bool)):
        return cast(JsonValue, value)
    if isinstance(value, list):
        return [_clone_json_value(item, field=field) for item in value]
    if isinstance(value, dict):
        cloned: JsonObject = {}
        for key, item in value.items():
            if not isinstance(key, str):
                raise ValueError(f"{field} must contain string keys")
            cloned[key] = _clone_json_value(item, field=field)
        return cloned
    raise ValueError(f"{field} must be JSON-serializable")


def _clone_json_object(value: object, *, field: str) -> JsonObject:
    if not isinstance(value, dict):
        raise ValueError(f"{field} must be an object")
    return cast(JsonObject, _clone_json_value(value, field=field))


def _optional_json_object(value: object, *, field: str) -> JsonObject | None:
    if value is None:
        return None
    return _clone_json_object(value, field=field)


def _optional_json_objects(
    values: object, *, field: str
) -> tuple[JsonObject, ...] | None:
    if values is None:
        return None
    if not isinstance(values, list):
        raise ValueError(f"{field} must be a list")
    return tuple(_clone_json_object(item, field=f"{field}[]") for item in values)


def _clone_json_objects(values: object, *, field: str) -> tuple[JsonObject, ...]:
    if values is None:
        return ()
    if not isinstance(values, list):
        raise ValueError(f"{field} must be a list")
    return tuple(_clone_json_object(item, field=f"{field}[]") for item in values)


def _require_literal(value: object, allowed: frozenset[str], *, field: str) -> str:
    if not isinstance(value, str) or value not in allowed:
        expected = ", ".join(sorted(allowed))
        raise ValueError(f"{field} must be one of: {expected}")
    return value


def _optional_literal(
    value: object, allowed: frozenset[str], *, field: str
) -> str | None:
    if value is None:
        return None
    return _require_literal(value, allowed, field=field)


def _require_str(payload: JsonObject, field: str) -> str:
    value = payload.get(field)
    if not isinstance(value, str):
        raise ValueError(f"{field} must be a string")
    return value


def _require_bool(payload: JsonObject, field: str) -> bool:
    value = payload.get(field)
    if not isinstance(value, bool):
        raise ValueError(f"{field} must be a boolean")
    return value


def _optional_str(payload: JsonObject, field: str) -> str | None:
    value = payload.get(field)
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError(f"{field} must be a string")
    return value


def _optional_str_list(payload: JsonObject, field: str) -> tuple[str, ...]:
    """Parse an optional string-or-array-of-strings field.

    The agent's `systemPrompt` (and similar) became `string[]` server-side
    when multi-prompt support landed. Older daemons still emit a bare string,
    so we accept either shape. Returns an empty tuple when the field is
    absent or null.
    """
    value = payload.get(field)
    if value is None:
        return ()
    if isinstance(value, str):
        return (value,)
    if isinstance(value, list):
        items: list[str] = []
        for index, item in enumerate(value):
            if not isinstance(item, str):
                raise ValueError(f"{field}[{index}] must be a string")
            items.append(item)
        return tuple(items)
    raise ValueError(f"{field} must be a string or an array of strings")


def _optional_bool(payload: JsonObject, field: str) -> bool | None:
    value = payload.get(field)
    if value is None:
        return None
    if not isinstance(value, bool):
        raise ValueError(f"{field} must be a boolean")
    return value


def _optional_int(payload: JsonObject, field: str) -> int | None:
    value = payload.get(field)
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError(f"{field} must be an integer")
    return value


def _optional_float(payload: JsonObject, field: str) -> float | None:
    value = payload.get(field)
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{field} must be a number")
    return float(value)


def _tuple_of_strings(values: object, *, field: str) -> tuple[str, ...] | None:
    if values is None:
        return None
    if not isinstance(values, list):
        raise ValueError(f"{field} must be a list")

    result: list[str] = []
    for item in values:
        if not isinstance(item, str):
            raise ValueError(f"{field} must contain only strings")
        result.append(item)
    return tuple(result) or None


def _parse_agent_message(payload: JsonObject, *, field: str) -> AgentMessage:
    _require_literal(
        payload.get("role"), _AGENT_MESSAGE_ROLE_VALUES, field=f"{field}.role"
    )
    return cast(AgentMessage, _clone_json_object(payload, field=field))


def _parse_assistant_message(payload: JsonObject, *, field: str) -> AssistantMessage:
    message = _parse_agent_message(payload, field=field)
    if message.get("role") != "assistant":
        raise ValueError(f"{field}.role must be 'assistant'")
    return cast(AssistantMessage, message)


def _parse_tool_result_message(payload: JsonObject, *, field: str) -> ToolResultMessage:
    message = _parse_agent_message(payload, field=field)
    if message.get("role") != "toolResult":
        raise ValueError(f"{field}.role must be 'toolResult'")
    return cast(ToolResultMessage, message)


def parse_agent_messages(payload: JsonValue | None) -> tuple[AgentMessage, ...]:
    if payload is None:
        return ()
    if not isinstance(payload, list):
        raise ValueError("messages must be a list")

    messages: list[AgentMessage] = []
    for index, item in enumerate(payload):
        messages.append(
            _parse_agent_message(
                _clone_json_object(item, field=f"messages[{index}]"),
                field=f"messages[{index}]",
            )
        )
    return tuple(messages)


def parse_assistant_message_event(payload: JsonObject) -> AssistantMessageEvent:
    event_type = _require_literal(
        payload.get("type"),
        _ASSISTANT_MESSAGE_EVENT_TYPE_VALUES,
        field="assistantMessageEvent.type",
    )
    if event_type == "start":
        return AssistantMessageStartEvent(
            type="start",
            partial=_parse_assistant_message(
                _clone_json_object(
                    payload.get("partial"), field="assistantMessageEvent.partial"
                ),
                field="assistantMessageEvent.partial",
            ),
        )
    if event_type in {"text_start", "thinking_start", "toolcall_start"}:
        partial = _parse_assistant_message(
            _clone_json_object(
                payload.get("partial"), field="assistantMessageEvent.partial"
            ),
            field="assistantMessageEvent.partial",
        )
        content_index = _optional_int(payload, "contentIndex")
        if content_index is None:
            raise ValueError("assistantMessageEvent.contentIndex must be an integer")
        if event_type == "text_start":
            return AssistantTextStartEvent(
                type="text_start", contentIndex=content_index, partial=partial
            )
        if event_type == "thinking_start":
            return AssistantThinkingStartEvent(
                type="thinking_start", contentIndex=content_index, partial=partial
            )
        return AssistantToolCallStartEvent(
            type="toolcall_start", contentIndex=content_index, partial=partial
        )
    if event_type in {"text_delta", "thinking_delta", "toolcall_delta"}:
        partial = _parse_assistant_message(
            _clone_json_object(
                payload.get("partial"), field="assistantMessageEvent.partial"
            ),
            field="assistantMessageEvent.partial",
        )
        content_index = _optional_int(payload, "contentIndex")
        delta = _optional_str(payload, "delta")
        if content_index is None:
            raise ValueError("assistantMessageEvent.contentIndex must be an integer")
        if delta is None:
            raise ValueError("assistantMessageEvent.delta must be a string")
        if event_type == "text_delta":
            return AssistantTextDeltaEvent(
                type="text_delta",
                contentIndex=content_index,
                delta=delta,
                partial=partial,
            )
        if event_type == "thinking_delta":
            return AssistantThinkingDeltaEvent(
                type="thinking_delta",
                contentIndex=content_index,
                delta=delta,
                partial=partial,
            )
        return AssistantToolCallDeltaEvent(
            type="toolcall_delta",
            contentIndex=content_index,
            delta=delta,
            partial=partial,
        )
    if event_type in {"text_end", "thinking_end"}:
        partial = _parse_assistant_message(
            _clone_json_object(
                payload.get("partial"), field="assistantMessageEvent.partial"
            ),
            field="assistantMessageEvent.partial",
        )
        content_index = _optional_int(payload, "contentIndex")
        content = _optional_str(payload, "content")
        if content_index is None:
            raise ValueError("assistantMessageEvent.contentIndex must be an integer")
        if content is None:
            raise ValueError("assistantMessageEvent.content must be a string")
        if event_type == "text_end":
            return AssistantTextEndEvent(
                type="text_end",
                contentIndex=content_index,
                content=content,
                partial=partial,
            )
        return AssistantThinkingEndEvent(
            type="thinking_end",
            contentIndex=content_index,
            content=content,
            partial=partial,
        )
    if event_type == "toolcall_end":
        partial = _parse_assistant_message(
            _clone_json_object(
                payload.get("partial"), field="assistantMessageEvent.partial"
            ),
            field="assistantMessageEvent.partial",
        )
        content_index = _optional_int(payload, "contentIndex")
        if content_index is None:
            raise ValueError("assistantMessageEvent.contentIndex must be an integer")
        tool_call = _clone_json_object(
            payload.get("toolCall"), field="assistantMessageEvent.toolCall"
        )
        return AssistantToolCallEndEvent(
            type="toolcall_end",
            contentIndex=content_index,
            toolCall=cast(ToolCall, tool_call),
            partial=partial,
        )
    if event_type == "done":
        return AssistantDoneEvent(
            type="done",
            reason=cast(
                Literal["stop", "length", "toolUse"],
                _require_literal(
                    payload.get("reason"),
                    _ASSISTANT_DONE_REASON_VALUES,
                    field="assistantMessageEvent.reason",
                ),
            ),
            message=_parse_assistant_message(
                _clone_json_object(
                    payload.get("message"), field="assistantMessageEvent.message"
                ),
                field="assistantMessageEvent.message",
            ),
        )
    return AssistantErrorEvent(
        type="error",
        reason=cast(
            Literal["aborted", "error"],
            _require_literal(
                payload.get("reason"),
                _ASSISTANT_ERROR_REASON_VALUES,
                field="assistantMessageEvent.reason",
            ),
        ),
        error=_parse_assistant_message(
            _clone_json_object(
                payload.get("error"), field="assistantMessageEvent.error"
            ),
            field="assistantMessageEvent.error",
        ),
    )


class TextContent(TypedDict, total=False):
    type: Literal["text"]
    text: str
    textSignature: NotRequired[str]


class ThinkingContent(TypedDict, total=False):
    type: Literal["thinking"]
    thinking: str
    thinkingSignature: NotRequired[str]


class RedactedThinkingContent(TypedDict, total=False):
    type: Literal["redactedThinking"]
    data: str


class ImageContent(TypedDict, total=False):
    type: Literal["image"]
    data: str
    mimeType: str


class ToolCall(TypedDict, total=False):
    type: Literal["toolCall"]
    id: str
    name: str
    arguments: dict[str, Any]
    thoughtSignature: NotRequired[str]
    intent: NotRequired[str]


class UsageCost(TypedDict):
    input: float
    output: float
    cacheRead: float
    cacheWrite: float
    total: float


class Usage(TypedDict, total=False):
    input: int
    output: int
    cacheRead: int
    cacheWrite: int
    totalTokens: int
    premiumRequests: NotRequired[int]
    cost: UsageCost


class UserMessage(TypedDict, total=False):
    role: Literal["user"]
    content: str | list[TextContent | ImageContent]
    synthetic: NotRequired[bool]
    attribution: NotRequired[Attribution]
    providerPayload: NotRequired[JsonObject]
    timestamp: int


class DeveloperMessage(TypedDict, total=False):
    role: Literal["developer"]
    content: str | list[TextContent | ImageContent]
    attribution: NotRequired[Attribution]
    providerPayload: NotRequired[JsonObject]
    timestamp: int


class AssistantMessage(TypedDict, total=False):
    role: Literal["assistant"]
    content: list[TextContent | ThinkingContent | RedactedThinkingContent | ToolCall]
    api: str
    provider: str
    model: str
    responseId: NotRequired[str]
    usage: Usage
    stopReason: StopReason
    errorMessage: NotRequired[str]
    providerPayload: NotRequired[JsonObject]
    timestamp: int
    duration: NotRequired[int]
    ttft: NotRequired[int]


class ToolResultMessage(TypedDict, total=False):
    role: Literal["toolResult"]
    toolCallId: str
    toolName: str
    content: list[TextContent | ImageContent]
    details: NotRequired[JsonValue]
    isError: bool
    attribution: NotRequired[Attribution]
    prunedAt: NotRequired[int]
    timestamp: int


class BashExecutionMessage(TypedDict, total=False):
    role: Literal["bashExecution"]
    command: str
    output: str
    exitCode: int | None
    cancelled: bool
    truncated: bool
    meta: NotRequired[JsonObject]
    timestamp: int
    excludeFromContext: NotRequired[bool]


class PythonExecutionMessage(TypedDict, total=False):
    role: Literal["pythonExecution"]
    code: str
    output: str
    exitCode: int | None
    cancelled: bool
    truncated: bool
    meta: NotRequired[JsonObject]
    timestamp: int
    excludeFromContext: NotRequired[bool]


class CustomMessage(TypedDict, total=False):
    role: Literal["custom"]
    customType: str
    content: str | list[TextContent | ImageContent]
    display: bool
    details: NotRequired[JsonValue]
    attribution: NotRequired[Attribution]
    timestamp: int


class HookMessage(TypedDict, total=False):
    role: Literal["hookMessage"]
    customType: str
    content: str | list[TextContent | ImageContent]
    display: bool
    details: NotRequired[JsonValue]
    attribution: NotRequired[Attribution]
    timestamp: int


class BranchSummaryMessage(TypedDict, total=False):
    role: Literal["branchSummary"]
    summary: str
    fromId: str
    timestamp: int


class CompactionSummaryMessage(TypedDict, total=False):
    role: Literal["compactionSummary"]
    summary: str
    shortSummary: NotRequired[str]
    tokensBefore: int
    providerPayload: NotRequired[JsonObject]
    timestamp: int


class FileMentionItem(TypedDict, total=False):
    path: str
    content: str
    lineCount: NotRequired[int]
    byteSize: NotRequired[int]
    skippedReason: NotRequired[Literal["tooLarge"]]
    image: NotRequired[ImageContent]


class FileMentionMessage(TypedDict, total=False):
    role: Literal["fileMention"]
    files: list[FileMentionItem]
    timestamp: int


AgentMessage: TypeAlias = (
    UserMessage
    | DeveloperMessage
    | AssistantMessage
    | ToolResultMessage
    | BashExecutionMessage
    | PythonExecutionMessage
    | CustomMessage
    | HookMessage
    | BranchSummaryMessage
    | CompactionSummaryMessage
    | FileMentionMessage
)


class AssistantMessageStartEvent(TypedDict):
    type: Literal["start"]
    partial: AssistantMessage


class AssistantTextStartEvent(TypedDict):
    type: Literal["text_start"]
    contentIndex: int
    partial: AssistantMessage


class AssistantTextDeltaEvent(TypedDict):
    type: Literal["text_delta"]
    contentIndex: int
    delta: str
    partial: AssistantMessage


class AssistantTextEndEvent(TypedDict):
    type: Literal["text_end"]
    contentIndex: int
    content: str
    partial: AssistantMessage


class AssistantThinkingStartEvent(TypedDict):
    type: Literal["thinking_start"]
    contentIndex: int
    partial: AssistantMessage


class AssistantThinkingDeltaEvent(TypedDict):
    type: Literal["thinking_delta"]
    contentIndex: int
    delta: str
    partial: AssistantMessage


class AssistantThinkingEndEvent(TypedDict):
    type: Literal["thinking_end"]
    contentIndex: int
    content: str
    partial: AssistantMessage


class AssistantToolCallStartEvent(TypedDict):
    type: Literal["toolcall_start"]
    contentIndex: int
    partial: AssistantMessage


class AssistantToolCallDeltaEvent(TypedDict):
    type: Literal["toolcall_delta"]
    contentIndex: int
    delta: str
    partial: AssistantMessage


class AssistantToolCallEndEvent(TypedDict):
    type: Literal["toolcall_end"]
    contentIndex: int
    toolCall: ToolCall
    partial: AssistantMessage


class AssistantDoneEvent(TypedDict):
    type: Literal["done"]
    reason: Literal["stop", "length", "toolUse"]
    message: AssistantMessage


class AssistantErrorEvent(TypedDict):
    type: Literal["error"]
    reason: Literal["aborted", "error"]
    error: AssistantMessage


AssistantMessageEvent: TypeAlias = (
    AssistantMessageStartEvent
    | AssistantTextStartEvent
    | AssistantTextDeltaEvent
    | AssistantTextEndEvent
    | AssistantThinkingStartEvent
    | AssistantThinkingDeltaEvent
    | AssistantThinkingEndEvent
    | AssistantToolCallStartEvent
    | AssistantToolCallDeltaEvent
    | AssistantToolCallEndEvent
    | AssistantDoneEvent
    | AssistantErrorEvent
)


@dataclass(slots=True, frozen=True)
class ModelCost:
    input: float
    output: float
    cache_read: float
    cache_write: float


@dataclass(slots=True, frozen=True)
class ThinkingConfig:
    mode: str
    efforts: tuple[Effort, ...]
    default_level: Effort | None = None
    effort_map: dict[str, str] | None = None
    supports_display: bool | None = None
    effort_routing: dict[str, str] | None = None
    suppress_when_off: bool | None = None
    requires_effort: bool | None = None


@dataclass(slots=True, frozen=True)
class ModelInfo:
    id: str
    name: str
    api: str
    provider: str
    base_url: str
    reasoning: bool
    input_modalities: tuple[str, ...]
    cost: ModelCost
    context_window: int
    max_tokens: int
    headers: dict[str, str] | None = None
    premium_multiplier: float | None = None
    prefer_websockets: bool | None = None
    context_promotion_target: str | None = None
    priority: int | None = None
    thinking: ThinkingConfig | None = None
    compat: JsonObject | None = None


@dataclass(slots=True, frozen=True)
class ToolDescriptor:
    name: str
    description: str
    parameters: JsonValue


@dataclass(slots=True, frozen=True)
class TodoItem:
    id: str
    content: str
    status: TodoStatus
    notes: str | None = None
    details: str | None = None
    # What a `blocked` task is waiting on; None for all other statuses.
    blocker: str | None = None


@dataclass(slots=True, frozen=True)
class TodoPhase:
    id: str
    name: str
    tasks: tuple[TodoItem, ...]


@dataclass(slots=True, frozen=True)
class ContextUsage:
    tokens: int
    context_window: int
    percent: float


@dataclass(slots=True, frozen=True)
class SessionState:
    model: ModelInfo | None
    thinking_level: ThinkingLevel | None
    is_streaming: bool
    is_compacting: bool
    steering_mode: SteeringMode
    follow_up_mode: SteeringMode
    interrupt_mode: InterruptMode
    session_file: str | None
    session_id: str
    session_name: str | None
    auto_compaction_enabled: bool
    message_count: int
    queued_message_count: int
    todo_phases: tuple[TodoPhase, ...] = ()
    system_prompt: tuple[str, ...] = ()
    dump_tools: tuple[ToolDescriptor, ...] = ()
    fast_mode_enabled: bool = False
    fast_mode_active: bool = False
    tokens_per_second: float | None = None
    context_usage: ContextUsage | None = None


@dataclass(slots=True, frozen=True)
class BashResult:
    output: str
    exit_code: int | None
    cancelled: bool
    truncated: bool
    total_lines: int
    total_bytes: int
    output_lines: int
    output_bytes: int
    artifact_id: str | None = None


@dataclass(slots=True, frozen=True)
class FastModeResult:
    enabled: bool
    active: bool


@dataclass(slots=True, frozen=True)
class CompactionResult:
    summary: str
    first_kept_entry_id: str
    tokens_before: int
    short_summary: str | None = None
    details: JsonValue | None = None
    preserve_data: JsonObject | None = None


@dataclass(slots=True, frozen=True)
class ModelCycleResult:
    model: ModelInfo
    thinking_level: ThinkingLevel | None
    is_scoped: bool


@dataclass(slots=True, frozen=True)
class ThinkingLevelCycleResult:
    level: ThinkingLevel


@dataclass(slots=True, frozen=True)
class CancellationResult:
    cancelled: bool


@dataclass(slots=True, frozen=True)
class BranchMessage:
    entry_id: str
    text: str


@dataclass(slots=True, frozen=True)
class BranchResult:
    text: str
    cancelled: bool


@dataclass(slots=True, frozen=True)
class TokenUsage:
    input: int
    output: int
    cache_read: int
    cache_write: int
    total: int


@dataclass(slots=True, frozen=True)
class SessionStats:
    session_file: str | None
    session_id: str
    user_messages: int
    assistant_messages: int
    tool_calls: int
    tool_results: int
    total_messages: int
    tokens: TokenUsage
    premium_requests: int
    cost: float


@dataclass(slots=True, frozen=True)
class ReadyEvent:
    protocol_version: int | None = None
    supported_protocol_versions: tuple[int, ...] | None = None
    max_frame_bytes: int | None = None
    max_reassembled_frame_bytes: int | None = None
    type: Literal["ready"] = "ready"


@dataclass(slots=True, frozen=True)
class MessagesPage:
    messages: tuple[AgentMessage, ...]
    total_messages: int
    next_cursor: str | None


@dataclass(slots=True, frozen=True)
class ExtensionUiRequest:
    id: str
    method: ExtensionUiMethod
    title: str | None = None
    options: tuple[str, ...] | None = None
    message: str | None = None
    option_details: tuple[JsonObject, ...] | None = field(default=None, kw_only=True)
    placeholder: str | None = None
    prefill: str | None = None
    timeout: int | None = None
    prompt_style: bool | None = None
    target_id: str | None = None
    notify_type: NotifyType | None = None
    status_key: str | None = None
    status_text: str | None = None
    widget_key: str | None = None
    widget_lines: tuple[str, ...] | None = None
    widget_placement: WidgetPlacement | None = None
    text: str | None = None
    url: str | None = None
    launch_url: str | None = None
    instructions: str | None = None
    type: Literal["extension_ui_request"] = "extension_ui_request"

    def is_passive(self) -> bool:
        return self.method in PASSIVE_EXTENSION_UI_METHODS

    def is_interactive(self) -> bool:
        return self.method in INTERACTIVE_EXTENSION_UI_METHODS

    def accepts_text(self) -> bool:
        return self.method in VALUE_EXTENSION_UI_METHODS

    def requires_response(self) -> bool:
        return self.is_interactive()


@dataclass(slots=True, frozen=True)
class ExtensionError:
    extension_path: str
    event: str
    error: str
    type: Literal["extension_error"] = "extension_error"


@dataclass(slots=True, frozen=True)
class AgentStartEvent:
    type: Literal["agent_start"] = "agent_start"


@dataclass(slots=True, frozen=True)
class AgentEndEvent:
    messages: tuple[AgentMessage, ...]
    type: Literal["agent_end"] = "agent_end"
    message_count: int | None = field(default=None, kw_only=True)
    is_terminal: bool | None = field(default=None, kw_only=True)


@dataclass(slots=True, frozen=True)
class TurnStartEvent:
    type: Literal["turn_start"] = "turn_start"


@dataclass(slots=True, frozen=True)
class TurnEndEvent:
    message: AgentMessage
    tool_results: tuple[ToolResultMessage, ...]
    type: Literal["turn_end"] = "turn_end"


@dataclass(slots=True, frozen=True)
class MessageStartEvent:
    message: AgentMessage
    type: Literal["message_start"] = "message_start"


@dataclass(slots=True, frozen=True)
class MessageUpdateEvent:
    message: AgentMessage
    assistant_message_event: AssistantMessageEvent
    type: Literal["message_update"] = "message_update"


@dataclass(slots=True, frozen=True)
class MessageEndEvent:
    message: AgentMessage
    type: Literal["message_end"] = "message_end"


@dataclass(slots=True, frozen=True)
class ToolExecutionStartEvent:
    tool_call_id: str
    tool_name: str
    args: JsonValue
    intent: str | None = None
    type: Literal["tool_execution_start"] = "tool_execution_start"


@dataclass(slots=True, frozen=True)
class ToolExecutionUpdateEvent:
    tool_call_id: str
    tool_name: str
    args: JsonValue
    partial_result: JsonValue
    type: Literal["tool_execution_update"] = "tool_execution_update"


@dataclass(slots=True, frozen=True)
class ToolExecutionEndEvent:
    tool_call_id: str
    tool_name: str
    result: JsonValue
    is_error: bool | None = None
    type: Literal["tool_execution_end"] = "tool_execution_end"


@dataclass(slots=True, frozen=True)
class AutoCompactionStartEvent:
    reason: Literal["threshold", "overflow", "idle", "incomplete"]
    action: Literal["context-full", "handoff", "shake", "snapcompact"]
    type: Literal["auto_compaction_start"] = "auto_compaction_start"


@dataclass(slots=True, frozen=True)
class AutoCompactionEndEvent:
    action: Literal["context-full", "handoff", "shake", "snapcompact"]
    result: CompactionResult | None
    aborted: bool
    will_retry: bool
    error_message: str | None = None
    skipped: bool | None = None
    type: Literal["auto_compaction_end"] = "auto_compaction_end"


@dataclass(slots=True, frozen=True)
class AutoRetryStartEvent:
    attempt: int
    max_attempts: int
    delay_ms: int
    error_message: str
    type: Literal["auto_retry_start"] = "auto_retry_start"


@dataclass(slots=True, frozen=True)
class AutoRetryEndEvent:
    success: bool
    attempt: int
    final_error: str | None = None
    type: Literal["auto_retry_end"] = "auto_retry_end"


@dataclass(slots=True, frozen=True)
class RetryFallbackAppliedEvent:
    from_model: str
    to_model: str
    role: str
    type: Literal["retry_fallback_applied"] = "retry_fallback_applied"


@dataclass(slots=True, frozen=True)
class RetryFallbackSucceededEvent:
    model: str
    role: str
    type: Literal["retry_fallback_succeeded"] = "retry_fallback_succeeded"


@dataclass(slots=True, frozen=True)
class TtsrTriggeredEvent:
    rules: tuple[JsonObject, ...]
    type: Literal["ttsr_triggered"] = "ttsr_triggered"


@dataclass(slots=True, frozen=True)
class TodoReminderEvent:
    todos: tuple[TodoItem, ...]
    attempt: int
    max_attempts: int
    type: Literal["todo_reminder"] = "todo_reminder"


@dataclass(slots=True, frozen=True)
class TodoAutoClearEvent:
    type: Literal["todo_auto_clear"] = "todo_auto_clear"


@dataclass(slots=True, frozen=True)
class UnknownNotification:
    payload: JsonObject
    type: Literal["unknown"] = "unknown"
    parse_error: str | None = field(default=None, kw_only=True)


RpcAgentEvent: TypeAlias = (
    AgentStartEvent
    | AgentEndEvent
    | TurnStartEvent
    | TurnEndEvent
    | MessageStartEvent
    | MessageUpdateEvent
    | MessageEndEvent
    | ToolExecutionStartEvent
    | ToolExecutionUpdateEvent
    | ToolExecutionEndEvent
    | AutoCompactionStartEvent
    | AutoCompactionEndEvent
    | AutoRetryStartEvent
    | AutoRetryEndEvent
    | RetryFallbackAppliedEvent
    | RetryFallbackSucceededEvent
    | TtsrTriggeredEvent
    | TodoReminderEvent
    | TodoAutoClearEvent
)

RpcNotification: TypeAlias = (
    ReadyEvent
    | ExtensionUiRequest
    | ExtensionError
    | RpcAgentEvent
    | UnknownNotification
)


def image_from_path(path: str | Path, mime_type: str | None = None) -> ImageContent:
    file_path = Path(path)
    resolved_mime_type = (
        mime_type
        or mimetypes.guess_type(file_path.name)[0]
        or "application/octet-stream"
    )
    return {
        "type": "image",
        "mimeType": resolved_mime_type,
        "data": base64.b64encode(file_path.read_bytes()).decode("ascii"),
    }


def message_text(
    message: AgentMessage, *, include_thinking: bool = False
) -> str | None:
    role = message.get("role")
    if role not in {
        "user",
        "developer",
        "assistant",
        "toolResult",
        "custom",
        "hookMessage",
    }:
        return None

    content = message.get("content")
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return None

    fragments: list[str] = []
    for block in content:
        if not isinstance(block, dict):
            continue
        block_type = block.get("type")
        if block_type == "text" and isinstance(block.get("text"), str):
            fragments.append(cast(str, block["text"]))
        elif (
            include_thinking
            and block_type == "thinking"
            and isinstance(block.get("thinking"), str)
        ):
            fragments.append(cast(str, block["thinking"]))
    return "".join(fragments) or None


def message_text_with_thinking(message: AgentMessage) -> str | None:
    return message_text(message, include_thinking=True)


def assistant_text(
    message: AgentMessage, *, include_thinking: bool = False
) -> str | None:
    if message.get("role") != "assistant":
        return None
    return message_text(message, include_thinking=include_thinking)


def assistant_text_with_thinking(message: AgentMessage) -> str | None:
    return assistant_text(message, include_thinking=True)


def _parse_thinking_config(payload: object) -> ThinkingConfig | None:
    if not isinstance(payload, dict):
        return None
    raw_efforts = payload.get("efforts")
    if not isinstance(raw_efforts, list):
        raise ValueError("model.thinking.efforts must be a list")
    efforts: tuple[Effort, ...] = tuple(
        cast(
            Effort,
            _require_literal(item, _EFFORT_VALUES, field="model.thinking.efforts[]"),
        )
        for item in raw_efforts
    )
    return ThinkingConfig(
        mode=_require_str(cast(JsonObject, payload), "mode"),
        efforts=efforts,
        default_level=cast(
            Effort | None,
            _optional_literal(
                payload.get("defaultLevel"),
                _EFFORT_VALUES,
                field="model.thinking.defaultLevel",
            ),
        ),
        effort_map=cast(
            dict[str, str] | None,
            _optional_json_object(
                payload.get("effortMap"), field="model.thinking.effortMap"
            ),
        ),
        supports_display=_optional_bool(cast(JsonObject, payload), "supportsDisplay"),
        effort_routing=cast(
            dict[str, str] | None,
            _optional_json_object(
                payload.get("effortRouting"), field="model.thinking.effortRouting"
            ),
        ),
        suppress_when_off=_optional_bool(cast(JsonObject, payload), "suppressWhenOff"),
        requires_effort=_optional_bool(cast(JsonObject, payload), "requiresEffort"),
    )


def parse_model_info(payload: JsonObject | None) -> ModelInfo | None:
    if payload is None:
        return None
    cost_payload = _optional_json_object(payload.get("cost"), field="model.cost") or {}
    thinking_payload = payload.get("thinking")
    headers_payload = payload.get("headers")
    compat_payload = payload.get("compat")
    return ModelInfo(
        id=_require_str(payload, "id"),
        name=_require_str(payload, "name"),
        api=_require_str(payload, "api"),
        provider=_require_str(payload, "provider"),
        base_url=_require_str(payload, "baseUrl"),
        reasoning=bool(payload.get("reasoning", False)),
        input_modalities=_tuple_of_strings(payload.get("input"), field="model.input")
        or (),
        cost=ModelCost(
            input=float(cost_payload.get("input", 0.0)),
            output=float(cost_payload.get("output", 0.0)),
            cache_read=float(cost_payload.get("cacheRead", 0.0)),
            cache_write=float(cost_payload.get("cacheWrite", 0.0)),
        ),
        context_window=int(payload.get("contextWindow", 0)),
        max_tokens=int(payload.get("maxTokens", 0)),
        headers=cast(
            dict[str, str] | None,
            _optional_json_object(headers_payload, field="model.headers"),
        ),
        premium_multiplier=float(payload["premiumMultiplier"])
        if "premiumMultiplier" in payload
        else None,
        prefer_websockets=bool(payload["preferWebsockets"])
        if "preferWebsockets" in payload
        else None,
        context_promotion_target=(
            str(payload["contextPromotionTarget"])
            if "contextPromotionTarget" in payload
            else None
        ),
        priority=int(payload["priority"]) if "priority" in payload else None,
        thinking=_parse_thinking_config(thinking_payload),
        compat=_optional_json_object(compat_payload, field="model.compat"),
    )


def parse_tool_descriptor(payload: JsonObject) -> ToolDescriptor:
    return ToolDescriptor(
        name=_require_str(payload, "name"),
        description=_require_str(payload, "description"),
        parameters=_clone_json_value(
            payload.get("parameters"), field="tool.parameters"
        ),
    )


def parse_todo_item(payload: JsonObject) -> TodoItem:
    return TodoItem(
        id=str(payload.get("id", "")),
        content=_require_str(payload, "content"),
        status=cast(
            TodoStatus,
            _require_literal(
                payload.get("status", "pending"),
                _TODO_STATUS_VALUES,
                field="todo.status",
            ),
        ),
        notes=_optional_str(payload, "notes"),
        details=_optional_str(payload, "details"),
        blocker=_optional_str(payload, "blocker"),
    )


def parse_todo_phase(payload: JsonObject) -> TodoPhase:
    raw_tasks = payload.get("tasks")
    if raw_tasks is None:
        tasks = ()
    else:
        if not isinstance(raw_tasks, list):
            raise ValueError("tasks must be a list")
        tasks = tuple(
            parse_todo_item(_clone_json_object(item, field="tasks[]"))
            for item in raw_tasks
        )
    return TodoPhase(
        id=str(payload.get("id", "")),
        name=_require_str(payload, "name"),
        tasks=tasks,
    )


def parse_todo_phases(payload: JsonValue | None) -> tuple[TodoPhase, ...]:
    if not isinstance(payload, list):
        return ()
    return tuple(parse_todo_phase(cast(JsonObject, item)) for item in payload)


def parse_session_state(payload: JsonObject) -> SessionState:
    dump_tools = tuple(
        parse_tool_descriptor(_clone_json_object(item, field="dumpTools[]"))
        for item in cast(list[Any], payload.get("dumpTools") or [])
    )
    return SessionState(
        model=parse_model_info(cast(JsonObject | None, payload.get("model"))),
        thinking_level=cast(
            ThinkingLevel | None,
            _optional_literal(
                payload.get("thinkingLevel"),
                _THINKING_LEVEL_VALUES,
                field="thinkingLevel",
            ),
        ),
        is_streaming=bool(payload.get("isStreaming", False)),
        is_compacting=bool(payload.get("isCompacting", False)),
        steering_mode=cast(
            SteeringMode,
            _require_literal(
                payload.get("steeringMode", "one-at-a-time"),
                _STEERING_MODE_VALUES,
                field="steeringMode",
            ),
        ),
        follow_up_mode=cast(
            SteeringMode,
            _require_literal(
                payload.get("followUpMode", "one-at-a-time"),
                _STEERING_MODE_VALUES,
                field="followUpMode",
            ),
        ),
        interrupt_mode=cast(
            InterruptMode,
            _require_literal(
                payload.get("interruptMode", "immediate"),
                _INTERRUPT_MODE_VALUES,
                field="interruptMode",
            ),
        ),
        session_file=_optional_str(payload, "sessionFile"),
        session_id=_require_str(payload, "sessionId"),
        session_name=_optional_str(payload, "sessionName"),
        auto_compaction_enabled=bool(payload.get("autoCompactionEnabled", False)),
        message_count=int(payload.get("messageCount", 0)),
        queued_message_count=int(payload.get("queuedMessageCount", 0)),
        todo_phases=parse_todo_phases(
            cast(JsonValue | None, payload.get("todoPhases"))
        ),
        system_prompt=_optional_str_list(payload, "systemPrompt"),
        dump_tools=dump_tools,
        fast_mode_enabled=bool(payload.get("fastModeEnabled", False)),
        fast_mode_active=bool(payload.get("fastModeActive", False)),
        tokens_per_second=_optional_float(payload, "tokensPerSecond"),
        context_usage=parse_context_usage(
            _optional_json_object(
                payload.get("contextUsage"), field="sessionState.contextUsage"
            )
        ),
    )


def parse_bash_result(payload: JsonObject) -> BashResult:
    return BashResult(
        output=str(payload.get("output", "")),
        exit_code=_optional_int(payload, "exitCode"),
        cancelled=bool(payload.get("cancelled", False)),
        truncated=bool(payload.get("truncated", False)),
        total_lines=int(payload.get("totalLines", 0)),
        total_bytes=int(payload.get("totalBytes", 0)),
        output_lines=int(payload.get("outputLines", 0)),
        output_bytes=int(payload.get("outputBytes", 0)),
        artifact_id=_optional_str(payload, "artifactId"),
    )


def parse_fast_mode_result(payload: JsonObject) -> FastModeResult:
    return FastModeResult(
        enabled=_require_bool(payload, "enabled"),
        active=_require_bool(payload, "active"),
    )


def parse_compaction_result(payload: JsonObject) -> CompactionResult:
    return CompactionResult(
        summary=str(payload.get("summary", "")),
        short_summary=_optional_str(payload, "shortSummary"),
        first_kept_entry_id=str(payload.get("firstKeptEntryId", "")),
        tokens_before=int(payload.get("tokensBefore", 0)),
        details=_clone_json_value(payload.get("details"), field="compaction.details")
        if "details" in payload
        else None,
        preserve_data=_optional_json_object(
            payload.get("preserveData"), field="compaction.preserveData"
        ),
    )


def parse_model_cycle_result(payload: JsonObject | None) -> ModelCycleResult | None:
    if payload is None:
        return None
    model = parse_model_info(cast(JsonObject, payload.get("model")))
    if model is None:
        raise ValueError("cycle_model response did not include a model")
    return ModelCycleResult(
        model=model,
        thinking_level=cast(ThinkingLevel | None, payload.get("thinkingLevel")),
        is_scoped=bool(payload.get("isScoped", False)),
    )


def parse_thinking_level_cycle_result(
    payload: JsonObject | None,
) -> ThinkingLevelCycleResult | None:
    if payload is None or payload.get("level") is None:
        return None
    return ThinkingLevelCycleResult(level=cast(ThinkingLevel, payload["level"]))


def parse_cancellation_result(payload: JsonObject | None) -> CancellationResult:
    return CancellationResult(cancelled=bool((payload or {}).get("cancelled", False)))


def parse_branch_result(payload: JsonObject | None) -> BranchResult:
    payload = payload or {}
    return BranchResult(
        text=str(payload.get("text", "")),
        cancelled=bool(payload.get("cancelled", False)),
    )


def parse_branch_messages(payload: JsonObject | None) -> tuple[BranchMessage, ...]:
    messages = (payload or {}).get("messages") or []
    if not isinstance(messages, list):
        raise ValueError("messages must be a list")
    return tuple(
        BranchMessage(
            entry_id=str(
                _clone_json_object(item, field="messages[]").get("entryId", "")
            ),
            text=str(_clone_json_object(item, field="messages[]").get("text", "")),
        )
        for item in messages
    )


def parse_session_stats(payload: JsonObject) -> SessionStats:
    tokens_payload = (
        _optional_json_object(payload.get("tokens"), field="sessionStats.tokens") or {}
    )
    return SessionStats(
        session_file=_optional_str(payload, "sessionFile"),
        session_id=str(payload.get("sessionId", "")),
        user_messages=int(payload.get("userMessages", 0)),
        assistant_messages=int(payload.get("assistantMessages", 0)),
        tool_calls=int(payload.get("toolCalls", 0)),
        tool_results=int(payload.get("toolResults", 0)),
        total_messages=int(payload.get("totalMessages", 0)),
        tokens=TokenUsage(
            input=int(tokens_payload.get("input", 0)),
            output=int(tokens_payload.get("output", 0)),
            cache_read=int(tokens_payload.get("cacheRead", 0)),
            cache_write=int(tokens_payload.get("cacheWrite", 0)),
            total=int(tokens_payload.get("total", 0)),
        ),
        premium_requests=int(payload.get("premiumRequests", 0)),
        cost=float(payload.get("cost", 0.0)),
    )


def parse_context_usage(payload: JsonObject | None) -> ContextUsage | None:
    if payload is None:
        return None
    return ContextUsage(
        tokens=int(payload.get("tokens", 0)),
        context_window=int(payload.get("contextWindow", 0)),
        percent=float(payload.get("percent", 0.0)),
    )


def parse_extension_ui_request(payload: JsonObject) -> ExtensionUiRequest:
    return ExtensionUiRequest(
        id=_require_str(payload, "id"),
        method=cast(
            ExtensionUiMethod,
            _require_literal(
                payload.get("method"),
                _EXTENSION_UI_METHOD_VALUES,
                field="extension_ui_request.method",
            ),
        ),
        title=_optional_str(payload, "title"),
        options=_tuple_of_strings(
            payload.get("options"), field="extension_ui_request.options"
        ),
        option_details=_optional_json_objects(
            payload.get("optionDetails"), field="extension_ui_request.optionDetails"
        ),
        message=_optional_str(payload, "message"),
        placeholder=_optional_str(payload, "placeholder"),
        prefill=_optional_str(payload, "prefill"),
        timeout=_optional_int(payload, "timeout"),
        prompt_style=_optional_bool(payload, "promptStyle"),
        target_id=_optional_str(payload, "targetId"),
        notify_type=cast(
            NotifyType | None,
            _optional_literal(
                payload.get("notifyType"),
                _NOTIFY_TYPE_VALUES,
                field="extension_ui_request.notifyType",
            ),
        ),
        status_key=_optional_str(payload, "statusKey"),
        status_text=_optional_str(payload, "statusText"),
        widget_key=_optional_str(payload, "widgetKey"),
        widget_lines=_tuple_of_strings(
            payload.get("widgetLines"), field="extension_ui_request.widgetLines"
        ),
        widget_placement=cast(
            WidgetPlacement | None,
            _optional_literal(
                payload.get("widgetPlacement"),
                _WIDGET_PLACEMENT_VALUES,
                field="extension_ui_request.widgetPlacement",
            ),
        ),
        text=_optional_str(payload, "text"),
        url=_optional_str(payload, "url"),
        launch_url=_optional_str(payload, "launchUrl"),
        instructions=_optional_str(payload, "instructions"),
    )


def parse_extension_error(payload: JsonObject) -> ExtensionError:
    return ExtensionError(
        extension_path=_require_str(payload, "extensionPath"),
        event=_require_str(payload, "event"),
        error=_require_str(payload, "error"),
    )


def parse_notification(payload: JsonObject) -> RpcNotification:
    event_type = payload.get("type")
    if event_type == "ready":
        raw_versions = payload.get("supportedProtocolVersions")
        supported_versions: tuple[int, ...] | None = None
        if raw_versions is not None:
            if not isinstance(raw_versions, list) or any(
                not isinstance(version, int) or isinstance(version, bool)
                for version in raw_versions
            ):
                raise ValueError("ready.supportedProtocolVersions must be integers")
            supported_versions = tuple(raw_versions)
        return ReadyEvent(
            protocol_version=_optional_int(payload, "protocolVersion"),
            supported_protocol_versions=supported_versions,
            max_frame_bytes=_optional_int(payload, "maxFrameBytes"),
            max_reassembled_frame_bytes=_optional_int(
                payload, "maxReassembledFrameBytes"
            ),
        )
    if event_type == "extension_ui_request":
        return parse_extension_ui_request(payload)
    if event_type == "extension_error":
        return parse_extension_error(payload)
    if event_type == "agent_start":
        return AgentStartEvent()
    if event_type == "agent_end":
        return AgentEndEvent(
            messages=parse_agent_messages(
                cast(JsonValue | None, payload.get("messages"))
            ),
            message_count=_optional_int(payload, "messageCount"),
            is_terminal=_optional_bool(payload, "isTerminal"),
        )
    if event_type == "turn_start":
        return TurnStartEvent()
    if event_type == "turn_end":
        return TurnEndEvent(
            message=_parse_agent_message(
                _clone_json_object(payload.get("message"), field="turn_end.message"),
                field="turn_end.message",
            ),
            tool_results=tuple(
                _parse_tool_result_message(
                    _clone_json_object(item, field="turn_end.toolResults[]"),
                    field="turn_end.toolResults[]",
                )
                for item in cast(list[Any], payload.get("toolResults") or [])
            ),
        )
    if event_type == "message_start":
        return MessageStartEvent(
            message=_parse_agent_message(
                _clone_json_object(
                    payload.get("message"), field="message_start.message"
                ),
                field="message_start.message",
            )
        )
    if event_type == "message_update":
        return MessageUpdateEvent(
            message=_parse_agent_message(
                _clone_json_object(
                    payload.get("message"), field="message_update.message"
                ),
                field="message_update.message",
            ),
            assistant_message_event=parse_assistant_message_event(
                _clone_json_object(
                    payload.get("assistantMessageEvent"),
                    field="message_update.assistantMessageEvent",
                )
            ),
        )
    if event_type == "message_end":
        return MessageEndEvent(
            message=_parse_agent_message(
                _clone_json_object(payload.get("message"), field="message_end.message"),
                field="message_end.message",
            )
        )
    if event_type == "tool_execution_start":
        return ToolExecutionStartEvent(
            tool_call_id=str(payload.get("toolCallId", "")),
            tool_name=str(payload.get("toolName", "")),
            args=_clone_json_value(
                payload.get("args"), field="tool_execution_start.args"
            )
            if "args" in payload
            else None,
            intent=_optional_str(payload, "intent"),
        )
    if event_type == "tool_execution_update":
        return ToolExecutionUpdateEvent(
            tool_call_id=str(payload.get("toolCallId", "")),
            tool_name=str(payload.get("toolName", "")),
            args=_clone_json_value(
                payload.get("args"), field="tool_execution_update.args"
            )
            if "args" in payload
            else None,
            partial_result=(
                _clone_json_value(
                    payload.get("partialResult"),
                    field="tool_execution_update.partialResult",
                )
                if "partialResult" in payload
                else None
            ),
        )
    if event_type == "tool_execution_end":
        return ToolExecutionEndEvent(
            tool_call_id=str(payload.get("toolCallId", "")),
            tool_name=str(payload.get("toolName", "")),
            result=_clone_json_value(
                payload.get("result"), field="tool_execution_end.result"
            )
            if "result" in payload
            else None,
            is_error=_optional_bool(payload, "isError"),
        )
    if event_type == "auto_compaction_start":
        return AutoCompactionStartEvent(
            reason=cast(
                Literal["threshold", "overflow", "idle", "incomplete"],
                _require_literal(
                    payload.get("reason", "threshold"),
                    _AUTO_COMPACTION_REASON_VALUES,
                    field="auto_compaction_start.reason",
                ),
            ),
            action=cast(
                Literal["context-full", "handoff", "shake", "snapcompact"],
                _require_literal(
                    payload.get("action", "context-full"),
                    _AUTO_COMPACTION_ACTION_VALUES,
                    field="auto_compaction_start.action",
                ),
            ),
        )
    if event_type == "auto_compaction_end":
        result_payload = payload.get("result")
        return AutoCompactionEndEvent(
            action=cast(
                Literal["context-full", "handoff", "shake", "snapcompact"],
                _require_literal(
                    payload.get("action", "context-full"),
                    _AUTO_COMPACTION_ACTION_VALUES,
                    field="auto_compaction_end.action",
                ),
            ),
            result=(
                parse_compaction_result(
                    _clone_json_object(
                        result_payload, field="auto_compaction_end.result"
                    )
                )
                if result_payload is not None
                else None
            ),
            aborted=bool(payload.get("aborted", False)),
            will_retry=bool(payload.get("willRetry", False)),
            error_message=_optional_str(payload, "errorMessage"),
            skipped=_optional_bool(payload, "skipped"),
        )
    if event_type == "auto_retry_start":
        return AutoRetryStartEvent(
            attempt=int(payload.get("attempt", 0)),
            max_attempts=int(payload.get("maxAttempts", 0)),
            delay_ms=int(payload.get("delayMs", 0)),
            error_message=str(payload.get("errorMessage", "")),
        )
    if event_type == "auto_retry_end":
        return AutoRetryEndEvent(
            success=bool(payload.get("success", False)),
            attempt=int(payload.get("attempt", 0)),
            final_error=_optional_str(payload, "finalError"),
        )
    if event_type == "retry_fallback_applied":
        return RetryFallbackAppliedEvent(
            from_model=str(payload.get("from", "")),
            to_model=str(payload.get("to", "")),
            role=str(payload.get("role", "")),
        )
    if event_type == "retry_fallback_succeeded":
        return RetryFallbackSucceededEvent(
            model=str(payload.get("model", "")), role=str(payload.get("role", ""))
        )
    if event_type == "ttsr_triggered":
        return TtsrTriggeredEvent(
            rules=_clone_json_objects(
                payload.get("rules"), field="ttsr_triggered.rules"
            )
        )
    if event_type == "todo_reminder":
        return TodoReminderEvent(
            todos=tuple(
                parse_todo_item(_clone_json_object(item, field="todo_reminder.todos[]"))
                for item in cast(list[Any], payload.get("todos") or [])
            ),
            attempt=int(payload.get("attempt", 0)),
            max_attempts=int(payload.get("maxAttempts", 0)),
        )
    if event_type == "todo_auto_clear":
        return TodoAutoClearEvent()
    return UnknownNotification(
        payload=_clone_json_object(payload, field="notification")
    )
