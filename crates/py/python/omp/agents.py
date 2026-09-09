"""Frozen agent completions, supervision, messaging, and scheduling."""

from __future__ import annotations

import asyncio
import builtins as _builtins
import re
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass, field, fields, is_dataclass
from enum import StrEnum
from typing import Literal, TypeAlias

from _omp import (
    AgentUrl,
    ArtifactUrl,
    BlobRef,
    Duration,
    EnvPath,
    HistoryUrl,
    OmpError,
    WorkspaceUri,
)

from . import limits as _limits
from . import Fault
from ._verdicts import BlobPart, TextPart
from .policy import PolicyDenied, RuleRef
from .provider import ModelRef


DEFAULT_MAX_DEPTH = 2
DEFAULT_MAX_CONCURRENCY = 32
DEFAULT_CONTINUATION_CAP = _limits.SETTLE_CONTINUATION_CAP
MAILBOX_CAPACITY = 100
STEER_GRACE = Duration("500ms")
MIN_SCHEDULE_INTERVAL = Duration("30s")
MAX_BACKFILL = 32
EMPTY_OUTPUT_RETRY_CAP = 3

depth: int = 0


class AgentsError(OmpError):
    """Base error for agent operations."""


class ModelSwitchDenied(AgentsError):
    """Raised when the active interactive model cannot be changed."""


class SessionInjectionDenied(AgentsError):
    """Raised when a targeted session injection is unknown or foreign."""


class SpawnDenied(AgentsError):
    """Raised when a child declaration cannot be admitted."""

    def __init__(self, reason: str, field: str | None = None) -> None:
        self.reason = reason
        self.field = field
        super().__init__(f"spawn denied: {reason}" + (f" (field: {field})" if field else ""))


class DepthExceeded(AgentsError):
    """Raised when the agent tree is already at its depth ceiling."""

    def __init__(self, depth: int, max_depth: int) -> None:
        self.depth = depth
        self.max_depth = max_depth
        super().__init__(f"agent depth {depth} exceeds maximum {max_depth}")


class ConcurrencyExhausted(AgentsError):
    """Raised when both child execution and admission queues are full."""

    def __init__(self, running: int, queued: int, max_concurrency: int) -> None:
        self.running = running
        self.queued = queued
        self.max_concurrency = max_concurrency
        super().__init__(
            f"agent concurrency exhausted: {running} running, {queued} queued, "
            f"maximum {max_concurrency}"
        )


class AgentGone(AgentsError):
    """Raised when an agent is terminal or tombstoned."""

    def __init__(self, ref: str, status: AgentStatus, transcript_url: str) -> None:
        self.ref = ref
        self.status = status
        self.transcript_url = transcript_url
        super().__init__(
            f"agent {ref!r} is {status.value}; transcript: {transcript_url}"
        )


class RewindPending(AgentsError):
    """Raised when a rewind encounters a durable turn without a receipt."""

    def __init__(self, turn_id: str) -> None:
        self.turn_id = turn_id
        super().__init__(f"turn {turn_id!r} is still pending")


class SnapshotUnsupported(AgentsError):
    """Raised when the environment cannot snapshot its workspace."""

    def __init__(self, capability: str = "env:workspace.snapshot") -> None:
        self.capability = capability
        super().__init__(f"snapshot capability unavailable: {capability}")


class ScheduleRejected(AgentsError):
    """Raised when a durable schedule declaration is invalid."""

    def __init__(self, reason: str, field: str | None = None) -> None:
        self.reason = reason
        self.field = field
        super().__init__(
            f"schedule rejected: {reason}" + (f" (field: {field})" if field else "")
        )


class CompletionFailed(AgentsError):
    """Raised when a one-shot completion cannot produce an accepted result."""

    def __init__(self, reason: str, raw: str | None, usage: Usage) -> None:
        self.reason = reason
        self.raw = raw
        self.usage = usage
        super().__init__(f"completion failed: {reason}")


@dataclass(frozen=True, slots=True)
class Usage:
    """Token, request, cost, and wall-time usage for an agent node."""

    input_tokens: int = 0
    cached_input_tokens: int = 0
    output_tokens: int = 0
    reasoning_tokens: int = 0
    cache_write_tokens: int = 0
    requests: int = 0
    cost_usd: float = 0.0
    wall: Duration = Duration("0s")


@dataclass(frozen=True, slots=True)
class Completion:
    """Settled output from one stateless completion request."""

    text: str
    choice: str | None
    data: object | None
    usage: Usage
    model: str
    fell_back: bool = False
    fault: object | None = None


_DEFAULT = object()


def _duration_ms(value: Duration | None) -> int | None:
    return None if value is None else round(value.seconds * 1000)


def _duration(value: object) -> Duration:
    if isinstance(value, Duration):
        return value
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return Duration(f"{value}ms")
    if isinstance(value, str):
        return Duration(value)
    raise TypeError("CONTROL duration must be milliseconds or a duration string")


def _mapping(value: object, what: str) -> Mapping[str, object]:
    if not isinstance(value, Mapping):
        raise TypeError(f"{what} response must be a mapping")
    return value


def _rows(value: object, what: str) -> Sequence[object]:
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes, bytearray)):
        raise TypeError(f"{what} response must be a sequence")
    return value


def _wire(value: object) -> object:
    """Convert a frozen public value to the JSON-only CONTROL representation."""
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, Duration):
        return _duration_ms(value)
    if isinstance(value, BlobRef):
        return {"hash": value.hex, "size": value.size}
    if isinstance(value, StrEnum):
        return value.value
    if isinstance(value, (AgentUrl, ArtifactUrl, EnvPath, HistoryUrl, WorkspaceUri)):
        return str(value)
    if isinstance(value, Mapping):
        return {str(key): _wire(item) for key, item in value.items()}
    if isinstance(value, (set, frozenset)):
        return [_wire(item) for item in sorted(value, key=str)]
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return [_wire(item) for item in value]
    if is_dataclass(value):
        return {item.name: _wire(getattr(value, item.name)) for item in fields(value)}
    uri = getattr(value, "uri", None)
    if isinstance(uri, str):
        return uri
    raise TypeError(f"{type(value).__name__} is not JSON-serializable for CONTROL")


async def _request(operation: str, /, **arguments: object) -> object:
    from . import _control_request

    try:
        return await _control_request(operation, **arguments)
    except Exception as error:
        code = getattr(error, "code", None)
        details = getattr(error, "details", None)
        detail = details if isinstance(details, Mapping) else {}
        message = str(error)
        if code == "CompletionFailed":
            raise CompletionFailed(
                str(detail.get("reason", message)),
                None if detail.get("raw") is None else str(detail["raw"]),
                _usage(detail.get("usage", {})),
            ) from error
        if code == "SpawnDenied":
            raise SpawnDenied(
                str(detail.get("reason", message)),
                None if detail.get("field") is None else str(detail["field"]),
            ) from error
        if code == "DepthExceeded":
            raise DepthExceeded(
                int(detail.get("depth", 0)),
                int(detail.get("max_depth", 0)),
            ) from error
        if code == "ConcurrencyExhausted":
            raise ConcurrencyExhausted(
                int(detail.get("running", 0)),
                int(detail.get("queued", 0)),
                int(detail.get("max_concurrency", 0)),
            ) from error
        if code == "AgentGone":
            raise AgentGone(
                str(detail.get("ref", "")),
                AgentStatus(str(detail.get("status", AgentStatus.ABORTED.value))),
                str(detail.get("transcript_url", "")),
            ) from error
        if code == "RewindPending":
            raise RewindPending(str(detail.get("turn_id", ""))) from error
        if code == "SnapshotUnsupported":
            raise SnapshotUnsupported(
                str(detail.get("capability", "env:workspace.snapshot"))
            ) from error
        if code == "ScheduleRejected":
            raise ScheduleRejected(
                str(detail.get("reason", message)),
                None if detail.get("field") is None else str(detail["field"]),
            ) from error
        if code == "PolicyDenied":
            rules = tuple(
                RuleRef(str(rule.get("id", "")))
                for rule in detail.get("rules", ())
                if isinstance(rule, Mapping)
            )
            raise PolicyDenied(
                reason=str(detail.get("reason", message)),
                code=str(detail.get("code", "policy_denied")),
                decision_id=str(detail.get("decision_id", "")),
                rules=rules,
            ) from error
        if code == "AgentsError":
            raise AgentsError(message) from error
        raise


def _usage(value: object) -> Usage:
    row = _mapping(value, "agent usage")
    return Usage(
        input_tokens=int(row.get("input_tokens", 0)),
        cached_input_tokens=int(row.get("cached_input_tokens", 0)),
        output_tokens=int(row.get("output_tokens", 0)),
        reasoning_tokens=int(row.get("reasoning_tokens", 0)),
        cache_write_tokens=int(row.get("cache_write_tokens", 0)),
        requests=int(row.get("requests", 0)),
        cost_usd=float(row.get("cost_usd", 0.0)),
        wall=_duration(row.get("wall_ms", 0)),
    )


async def completion(
    prompt: str | Sequence[TextPart | BlobPart],
    *,
    role: str = "smol",
    system: str | None = None,
    choices: Sequence[str] | None = None,
    schema: Mapping[str, object] | None = None,
    default: object = _DEFAULT,
    scope: Literal["turn", "session"] = "turn",
    context: Literal["none", "thread"] = "none",
    max_output_tokens: int | None = None,
    deadline: Duration = Duration("10s"),
    labels: Mapping[str, str] | None = None,
) -> Completion:
    """Request a budgeted stateless completion from text or typed media parts.

    ``context="thread"`` instead runs one non-persisted side-channel turn over
    the caller's live conversation thread on the session model: the reply sees
    the full context but never becomes a thread item. Thread-context calls
    accept only a plain-text prompt; ``role``, ``system``, ``choices``,
    ``schema``, and ``max_output_tokens`` are stateless-only.
    """
    if context not in ("none", "thread"):
        raise ValueError('completion context must be "none" or "thread"')
    if context == "thread":
        if not isinstance(prompt, str):
            raise TypeError("thread-context completion prompt must be plain text")
        if (
            system is not None
            or choices is not None
            or schema is not None
            or max_output_tokens is not None
        ):
            raise ValueError(
                "thread-context completions accept only prompt, default, scope,"
                " deadline, and labels"
            )
        if role != "smol":
            raise ValueError(
                "thread-context completions run on the session model;"
                " role is not selectable"
            )
    if not isinstance(prompt, str):
        if not isinstance(prompt, Sequence) or any(
            not isinstance(part, (TextPart, BlobPart)) for part in prompt
        ):
            raise TypeError(
                "completion prompt must be str or a sequence of TextPart and BlobPart values"
            )
        prompt_wire: object = [
            {"kind": "text", "text": part.text}
            if isinstance(part, TextPart)
            else {"kind": "blob", "blob": _wire(part.blob), "alt": part.alt}
            for part in prompt
        ]
    else:
        prompt_wire = prompt
    if choices is not None and schema is not None:
        raise ValueError("completion choices and schema are mutually exclusive")
    arguments: dict[str, object] = {
        "prompt": prompt_wire,
        "scope": scope,
        "deadline_ms": _duration_ms(deadline),
        "labels": _wire(labels or {}),
    }
    if context == "thread":
        arguments["context"] = "thread"
    else:
        arguments.update(
            role=role,
            system=system,
            choices=_wire(choices),
            schema=_wire(schema),
            max_output_tokens=max_output_tokens,
        )
    if default is not _DEFAULT:
        arguments["default"] = _wire(default)
    row = _mapping(await _request("omp.agents.completion", **arguments), "completion")
    return Completion(
        text=str(row.get("text", "")),
        choice=None if row.get("choice") is None else str(row["choice"]),
        data=row.get("data"),
        usage=_usage(row.get("usage", {})),
        model=str(row.get("model", "")),
        fell_back=bool(row.get("fell_back", False)),
        fault=row.get("fault"),
    )


@dataclass(frozen=True, slots=True)
class Continue:
    """Decline settlement by supplying the next continuation item."""

    prompt: str
    visible: bool = False
    role: Literal["user", "system"] = "system"
    label: str | None = None
    collapse_prior: bool = True


@dataclass(frozen=True, slots=True)
class Settle:
    """Explicitly accept settlement without another turn."""


@dataclass(frozen=True, slots=True)
class ContinuationPolicy:
    """Per-extension recursive continuation policy."""

    max_consecutive: int = DEFAULT_CONTINUATION_CAP
    max_total: int | None = None
    min_interval: Duration = Duration("0s")
    on_exhausted: Literal["settle", "notify"] = "notify"


@dataclass(frozen=True, slots=True)
class ContinuationLedger:
    """Durable view of the recursive continuation budget."""

    consecutive: int
    total: int
    cap: int
    last_ms: int
    refusals: int
    owner: str | None = None


@dataclass(frozen=True, slots=True)
class LoopSignal:
    """Core-owned repetition and progress facts for an autonomous loop."""

    repeats: int
    digest: str
    no_progress_turns: int
    empty_output_retries: int
    stalled: bool


async def continuations() -> ContinuationLedger:
    """Read the current recursive continuation ledger."""
    row = _mapping(await _request("omp.agents.continuations"), "continuations")
    return ContinuationLedger(
        consecutive=int(row["consecutive"]),
        total=int(row["total"]),
        cap=int(row["cap"]),
        last_ms=int(row["last_ms"]),
        refusals=int(row["refusals"]),
        owner=None if row.get("owner") is None else str(row["owner"]),
    )


async def set_continuation_policy(policy: ContinuationPolicy) -> None:
    """Set this extension's continuation policy."""
    if not isinstance(policy, ContinuationPolicy):
        raise TypeError("policy must be ContinuationPolicy")
    await _request(
        "omp.agents.set_continuation_policy",
        policy={
            "max_consecutive": policy.max_consecutive,
            "max_total": policy.max_total,
            "min_interval_ms": _duration_ms(policy.min_interval),
            "on_exhausted": policy.on_exhausted,
        },
    )


async def loop_signal() -> LoopSignal:
    """Read the Core's current conservative loop-stall signal."""
    row = _mapping(await _request("omp.agents.loop_signal"), "loop signal")
    return LoopSignal(
        repeats=int(row["repeats"]),
        digest=str(row["digest"]),
        no_progress_turns=int(row["no_progress_turns"]),
        empty_output_retries=int(row["empty_output_retries"]),
        stalled=bool(row["stalled"]),
    )


class DeliveryMode(StrEnum):
    """When an injected item becomes visible to the target agent."""

    ASIDE = "aside"
    STEER = "steer"
    NEXT_TURN = "next_turn"


class Isolation(StrEnum):
    """How much parent conversation a child inherits."""

    CLEAN = "clean"
    FORK = "fork"
    FILTERED = "filtered"


class ThinkingLevel(StrEnum):
    """Coarse reasoning level requested for a child."""

    OFF = "off"
    LO = "lo"
    MED = "med"
    HI = "hi"


class MergeMode(StrEnum):
    """Disposition of a worktree-isolated child's changes."""

    NONE = "none"
    BRANCH = "branch"
    PATCH = "patch"


@dataclass(frozen=True, slots=True)
class Budget:
    """Hard resource ceilings for one child and its subtree."""

    max_requests: int | None = None
    max_input_tokens: int | None = None
    max_output_tokens: int | None = None
    max_usd: float | None = None
    max_wall: Duration | None = None


_NAME_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_]{0,31}$")


@dataclass(frozen=True, slots=True)
class SubagentSpec:
    """Complete frozen declaration of a child agent."""

    task: str
    name: str | None = None
    agent: str = "task"
    system_prompt: str | None = None
    model: str | None = None
    on_model_unavailable: Literal["fail", "parent"] = "fail"
    thinking: ThinkingLevel | None = None
    allowed_devices: frozenset[str] | None = None
    disallowed_devices: frozenset[str] = frozenset()
    isolation: Isolation = Isolation.CLEAN
    max_depth: int = 1
    cwd: EnvPath | None = None
    worktree: bool = False
    merge: MergeMode = MergeMode.NONE
    env_vars: Mapping[str, str] = field(default_factory=dict)
    background: bool = False
    output_schema: Mapping[str, object] | None = None
    schema_mode: Literal["permissive", "strict"] = "permissive"
    deadline: Duration | None = None
    request_budget: int | None = None
    budget: Budget | None = None
    labels: Mapping[str, str] = field(default_factory=dict)

    def __post_init__(self) -> None:
        """Validate identity fields that require no host state."""
        if not self.task.strip():
            raise SpawnDenied("task must be non-empty", field="task")
        if self.name is not None and _NAME_RE.fullmatch(self.name) is None:
            raise SpawnDenied(
                "name must match ^[A-Za-z][A-Za-z0-9_]{0,31}$", field="name"
            )


class RunStatus(StrEnum):
    """Lifecycle state of a supervised child run."""

    PENDING = "pending"
    RUNNING = "running"
    SETTLED = "settled"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"
    EXHAUSTED = "exhausted"

    @property
    def terminal(self) -> bool:
        """Whether this state is terminal."""
        return self in {
            RunStatus.COMPLETED,
            RunStatus.FAILED,
            RunStatus.CANCELLED,
            RunStatus.EXHAUSTED,
        }


@dataclass(frozen=True, slots=True)
class Progress:
    """Sanitized render snapshot of a child run's progress."""

    status: RunStatus
    turns: int
    requests: int
    tool_calls: int
    context_tokens: int
    context_window: int
    usage: Usage
    activity: str
    model: str
    last_activity_ms: int


@dataclass(frozen=True, slots=True)
class WorktreeOutcome:
    """Disposition and recovery details for a child's worktree."""

    path: EnvPath
    merge: MergeMode
    applied: bool
    branch: str | None
    patch_url: ArtifactUrl | None
    conflicts: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class SubagentResult:
    """Terminal result and durable locations for a child run."""

    run_id: str
    session_id: str
    name: str
    status: RunStatus
    text: str
    data: object | None
    fault: Fault | None
    usage: Usage
    subtree_usage: Usage
    turns: int
    model: str
    model_fallback: bool
    warnings: tuple[str, ...]
    output_url: AgentUrl
    transcript_url: HistoryUrl
    worktree: WorktreeOutcome | None


def _spec_wire(spec: SubagentSpec) -> dict[str, object]:
    wire = _wire(spec)
    assert isinstance(wire, dict)
    return wire


def _spec(value: object) -> SubagentSpec:
    row = _mapping(value, "subagent spec")
    budget_value = row.get("budget")
    budget = None
    if budget_value is not None:
        item = _mapping(budget_value, "subagent budget")
        budget = Budget(
            max_requests=None if item.get("max_requests") is None else int(item["max_requests"]),
            max_input_tokens=None
            if item.get("max_input_tokens") is None
            else int(item["max_input_tokens"]),
            max_output_tokens=None
            if item.get("max_output_tokens") is None
            else int(item["max_output_tokens"]),
            max_usd=None if item.get("max_usd") is None else float(item["max_usd"]),
            max_wall=None if item.get("max_wall") is None else _duration(item["max_wall"]),
        )
    return SubagentSpec(
        task=str(row.get("task", "")),
        name=None if row.get("name") is None else str(row["name"]),
        agent=str(row.get("agent", "task")),
        system_prompt=None
        if row.get("system_prompt") is None
        else str(row["system_prompt"]),
        model=None if row.get("model") is None else str(row["model"]),
        on_model_unavailable=str(row.get("on_model_unavailable", "fail")),
        thinking=None
        if row.get("thinking") is None
        else ThinkingLevel(str(row["thinking"])),
        allowed_devices=None
        if row.get("allowed_devices") is None
        else frozenset(str(item) for item in _rows(row["allowed_devices"], "allowed devices")),
        disallowed_devices=frozenset(
            str(item)
            for item in _rows(row.get("disallowed_devices", ()), "disallowed devices")
        ),
        isolation=Isolation(str(row.get("isolation", Isolation.CLEAN.value))),
        max_depth=int(row.get("max_depth", 1)),
        cwd=None if row.get("cwd") is None else EnvPath(str(row["cwd"])),
        worktree=bool(row.get("worktree", False)),
        merge=MergeMode(str(row.get("merge", MergeMode.NONE.value))),
        env_vars={
            str(key): str(item)
            for key, item in _mapping(row.get("env_vars", {}), "environment variables").items()
        },
        background=bool(row.get("background", False)),
        output_schema=None
        if row.get("output_schema") is None
        else dict(_mapping(row["output_schema"], "output schema")),
        schema_mode=str(row.get("schema_mode", "permissive")),
        deadline=None if row.get("deadline") is None else _duration(row["deadline"]),
        request_budget=None
        if row.get("request_budget") is None
        else int(row["request_budget"]),
        budget=budget,
        labels={
            str(key): str(item)
            for key, item in _mapping(row.get("labels", {}), "subagent labels").items()
        },
    )


def _worktree(value: object | None) -> WorktreeOutcome | None:
    if value is None:
        return None
    row = _mapping(value, "worktree outcome")
    return WorktreeOutcome(
        path=EnvPath(str(row["path"])),
        merge=MergeMode(str(row.get("merge", MergeMode.NONE.value))),
        applied=bool(row.get("applied", False)),
        branch=None if row.get("branch") is None else str(row["branch"]),
        patch_url=None
        if row.get("patch_url") is None
        else ArtifactUrl(str(row["patch_url"])),
        conflicts=tuple(
            str(item) for item in _rows(row.get("conflicts", ()), "worktree conflicts")
        ),
    )


def _result(value: object) -> SubagentResult:
    row = _mapping(value, "subagent result")
    return SubagentResult(
        run_id=str(row["run_id"]),
        session_id=str(row["session_id"]),
        name=str(row["name"]),
        status=RunStatus(str(row["status"])),
        text=str(row["text"]),
        data=row["data"],
        fault=row["fault"],
        usage=_usage(row["usage"]),
        subtree_usage=_usage(row["subtree_usage"]),
        turns=int(row["turns"]),
        model=str(row["model"]),
        model_fallback=bool(row["model_fallback"]),
        warnings=tuple(
            str(item) for item in _rows(row["warnings"], "subagent warnings")
        ),
        output_url=AgentUrl(str(row["output_url"])),
        transcript_url=HistoryUrl(str(row["transcript_url"])),
        worktree=_worktree(row["worktree"]),
    )


def _progress(value: object) -> Progress:
    row = _mapping(value, "subagent progress")
    return Progress(
        status=RunStatus(str(row["status"])),
        turns=int(row["turns"]),
        requests=int(row["requests"]),
        tool_calls=int(row["tool_calls"]),
        context_tokens=int(row["context_tokens"]),
        context_window=int(row["context_window"]),
        usage=_usage(row["usage"]),
        activity=str(row["activity"]),
        model=str(row["model"]),
        last_activity_ms=int(row["last_activity_ms"]),
    )


class Receipt(StrEnum):
    """Delivery disposition for an inter-agent message."""

    DELIVERED = "delivered"
    WOKEN = "woken"
    REVIVED = "revived"
    BUFFERED = "buffered"
    FAILED = "failed"


class SubagentHandle:
    """Live CONTROL handle over a supervised child run."""
    run_id: str
    session_id: str
    name: str
    agent: str
    depth: int
    effective_max_depth: int
    spec: SubagentSpec
    worktree_path: EnvPath | None
    output_url: AgentUrl
    transcript_url: HistoryUrl


    def __init__(
        self,
        run_id: str,
        session_id: str,
        name: str,
        agent: str,
        depth: int,
        effective_max_depth: int,
        spec: SubagentSpec,
        worktree_path: EnvPath | None,
        output_url: AgentUrl,
        transcript_url: HistoryUrl,
    ) -> None:
        self.run_id = run_id
        self.session_id = session_id
        self.name = name
        self.agent = agent
        self.depth = depth
        self.effective_max_depth = effective_max_depth
        self.spec = spec
        self.worktree_path = worktree_path
        self.output_url = output_url
        self.transcript_url = transcript_url
        self._released = False

    async def status(self) -> RunStatus:
        """Read the child's current lifecycle state."""
        return RunStatus(
            str(await _request("omp.agents.status", run_id=self.run_id))
        )

    async def progress(self) -> Progress:
        """Read a sanitized progress snapshot."""
        return _progress(await _request("omp.agents.progress", run_id=self.run_id))

    async def steer(
        self, text: str, *, mode: DeliveryMode = DeliveryMode.ASIDE
    ) -> Receipt:
        """Post a message into the child's mailbox."""
        if not text:
            raise ValueError("steer text must be non-empty")
        return Receipt(
            str(
                await _request(
                    "omp.agents.steer",
                    run_id=self.run_id,
                    text=text,
                    mode=mode.value,
                )
            )
        )

    async def cancel(
        self,
        *,
        reason: str = "cancelled by extension",
        grace: Duration = STEER_GRACE,
    ) -> None:
        """Cancel the child and its structural resources."""
        await _request(
            "omp.agents.cancel",
            run_id=self.run_id,
            reason=reason,
            grace_ms=_duration_ms(grace),
        )

    async def wait(self, *, timeout: Duration | None = None) -> SubagentResult:
        """Wait for a terminal child result."""
        try:
            response = await _request(
                "omp.agents.wait",
                run_id=self.run_id,
                timeout_ms=_duration_ms(timeout),
            )
        except Exception as error:
            if getattr(error, "code", None) in {
                "deadline_exceeded",
                "DeadlineExceeded",
                "TimeoutError",
            }:
                raise asyncio.TimeoutError from error
            raise
        return _result(response)

    async def result(self) -> SubagentResult | None:
        """Return the terminal result without blocking, when available."""
        response = await _request("omp.agents.result", run_id=self.run_id)
        return None if response is None else _result(response)

    async def release(self) -> None:
        """Relinquish structural ownership of the child."""
        await _request("omp.agents.release", run_id=self.run_id)
        self._released = True

    async def __aenter__(self) -> SubagentHandle:
        """Enter structural ownership of this child."""
        return self

    async def __aexit__(self, exc_type: object, exc: object, tb: object) -> None:
        """Cancel an unreleased child when leaving its ownership scope."""
        del exc_type, exc, tb
        if not self._released:
            await self.cancel()


def _handle(value: object) -> SubagentHandle:
    row = _mapping(value, "subagent handle")
    resolved_spec = _spec(row["spec"])
    return SubagentHandle(
        run_id=str(row["run_id"]),
        session_id=str(row["session_id"]),
        name=str(row["name"]),
        agent=str(row["agent"]),
        depth=int(row["depth"]),
        effective_max_depth=int(row["effective_max_depth"]),
        spec=resolved_spec,
        worktree_path=None
        if row.get("worktree_path") is None
        else EnvPath(str(row["worktree_path"])),
        output_url=AgentUrl(str(row["output_url"])),
        transcript_url=HistoryUrl(str(row["transcript_url"])),
    )


async def spawn(spec: SubagentSpec) -> SubagentHandle:
    """Admit and start one child agent."""
    if not isinstance(spec, SubagentSpec):
        raise TypeError("spec must be SubagentSpec")
    return _handle(await _request("omp.agents.spawn", spec=_spec_wire(spec)))


async def spawn_all(specs: Sequence[SubagentSpec]) -> _builtins.list[SubagentHandle]:
    """Atomically admit and start a batch of child agents."""
    if not isinstance(specs, Sequence) or isinstance(specs, (str, bytes)):
        raise TypeError("specs must be a sequence of SubagentSpec")
    frozen = tuple(specs)
    if any(not isinstance(spec, SubagentSpec) for spec in frozen):
        raise TypeError("specs must contain only SubagentSpec values")
    response = _rows(
        await _request(
            "omp.agents.spawn_all",
            specs=[_spec_wire(spec) for spec in frozen],
        ),
        "spawn_all",
    )
    if len(response) != len(frozen):
        raise TypeError("spawn_all response cardinality does not match request")
    return [_handle(row) for row in response]


class AgentKind(StrEnum):
    """Kind of agent represented by a roster row."""

    MAIN = "main"
    SUB = "sub"
    ADVISOR = "advisor"


class AgentStatus(StrEnum):
    """Roster lifecycle state of an agent session."""

    RUNNING = "running"
    IDLE = "idle"
    PARKED = "parked"
    ABORTED = "aborted"


@dataclass(frozen=True, slots=True)
class AgentRef:
    """Addressable roster snapshot for an agent."""

    id: str
    name: str
    kind: AgentKind
    status: AgentStatus
    agent: str
    parent: str | None
    depth: int
    activity: str
    last_activity_ms: int
    usage: Usage
    output_url: AgentUrl
    transcript_url: HistoryUrl


@dataclass(frozen=True, slots=True)
class SpawnLimits:
    """Snapshot of every ceiling that can refuse another spawn."""

    max_depth: int
    depth: int
    max_concurrency: int
    running: int
    queued: int
    continuation_cap: int
    continuations_used: int
    spawn_allowed: bool


def _agent_ref(value: object) -> AgentRef:
    row = _mapping(value, "agent roster row")
    return AgentRef(
        id=str(row["id"]),
        name=str(row["name"]),
        kind=AgentKind(str(row["kind"])),
        status=AgentStatus(str(row["status"])),
        agent=str(row["agent"]),
        parent=None if row.get("parent") is None else str(row["parent"]),
        depth=int(row["depth"]),
        activity=str(row["activity"]),
        last_activity_ms=int(row["last_activity_ms"]),
        usage=_usage(row["usage"]),
        output_url=AgentUrl(str(row["output_url"])),
        transcript_url=HistoryUrl(str(row["transcript_url"])),
    )


async def get(ref: str) -> SubagentHandle:
    """Resolve an agent reference to a live handle."""
    if not ref:
        raise ValueError("agent ref must be non-empty")
    return _handle(await _request("omp.agents.get", ref=ref))


async def revive(ref: str) -> SubagentHandle:
    """Cold-revive a parked child session."""
    if not ref:
        raise ValueError("agent ref must be non-empty")
    return _handle(await _request("omp.agents.revive", ref=ref))


async def limits() -> SpawnLimits:
    """Read current child-spawn ceilings."""
    row = _mapping(await _request("omp.agents.limits"), "spawn limits")
    current_depth = int(row["depth"])
    global depth
    depth = current_depth
    return SpawnLimits(
        max_depth=int(row["max_depth"]),
        depth=current_depth,
        max_concurrency=int(row["max_concurrency"]),
        running=int(row["running"]),
        queued=int(row["queued"]),
        continuation_cap=int(row["continuation_cap"]),
        continuations_used=int(row["continuations_used"]),
        spawn_allowed=bool(row["spawn_allowed"]),
    )




@dataclass(frozen=True, slots=True)
class Message:
    """One inter-agent mailbox message."""

    id: str
    from_: str
    to: str
    text: str
    mode: DeliveryMode
    reply_to: str | None
    sent_ms: int
    session_id: str


def _message(value: object) -> Message:
    row = _mapping(value, "agent message")
    return Message(
        id=str(row["id"]),
        from_=str(row["from"]),
        to=str(row["to"]),
        text=str(row["text"]),
        mode=DeliveryMode(str(row["mode"])),
        reply_to=None if row.get("reply_to") is None else str(row["reply_to"]),
        sent_ms=int(row["sent_ms"]),
        session_id=str(row["session_id"]),
    )


def _receipt(value: object) -> Receipt:
    return Receipt(str(value))


async def send(
    to: str,
    text: str,
    *,
    mode: DeliveryMode = DeliveryMode.ASIDE,
    reply_to: str | None = None,
    await_reply: bool = False,
    timeout: Duration = Duration("60s"),
) -> Receipt | Message:
    """Send a message to an addressable agent."""
    if not to:
        raise ValueError("message recipient must be non-empty")
    try:
        response = await _request(
            "omp.agents.send",
            to=to,
            text=text,
            mode=mode.value,
            reply_to=reply_to,
            await_reply=await_reply,
            timeout_ms=_duration_ms(timeout),
        )
    except Exception as error:
        if await_reply and getattr(error, "code", None) in {
            "deadline_exceeded",
            "DeadlineExceeded",
            "TimeoutError",
        }:
            raise asyncio.TimeoutError from error
        raise
    if await_reply:
        if response is None:
            raise asyncio.TimeoutError
        return _message(response)
    return _receipt(response)


async def broadcast(
    text: str,
    *,
    scope: Literal["session", "project"] = "session",
    mode: DeliveryMode = DeliveryMode.ASIDE,
) -> dict[str, Receipt]:
    """Send a message to every agent in a scope."""
    row = _mapping(
        await _request(
            "omp.agents.broadcast", text=text, scope=scope, mode=mode.value
        ),
        "broadcast",
    )
    return {str(peer): _receipt(receipt) for peer, receipt in row.items()}


async def inbox(*, peek: bool = False, limit: int | None = None) -> _builtins.list[Message]:
    """Drain or inspect this agent's buffered mailbox."""
    response = _rows(
        await _request("omp.agents.inbox", peek=peek, limit=limit),
        "agent inbox",
    )
    return [_message(row) for row in response]


async def wait_for(
    *,
    sender: str | None = None,
    reply_to: str | None = None,
    timeout: Duration = Duration("60s"),
) -> Message | None:
    """Wait for a matching inter-agent message."""
    response = await _request(
        "omp.agents.wait_for",
        sender=sender,
        reply_to=reply_to,
        timeout_ms=_duration_ms(timeout),
    )
    return None if response is None else _message(response)


async def peers(
    *, scope: Literal["session", "project"] = "session"
) -> _builtins.list[AgentRef]:
    """List messageable peers in a scope."""
    response = _rows(
        await _request("omp.agents.peers", scope=scope),
        "agent peers",
    )
    return [_agent_ref(row) for row in response]


async def set_model(model: str, *, thinking: str | None = None) -> ModelRef:
    """Switch the active interactive session model for subsequent turns."""
    if not isinstance(model, str) or not model:
        raise TypeError("model must be a non-empty string")
    if thinking is not None and not isinstance(thinking, str):
        raise TypeError("thinking must be a string or None")
    response = _mapping(
        await _request("omp.agents.set_model", model=model, thinking=thinking),
        "model reference",
    )
    return ModelRef(
        provider=str(response["provider"]),
        api=str(response["api"]),
        model=str(response["model"]),
    )


async def abort() -> None:
    """Abort the main agent's active run, if any."""
    await _request("omp.agents.abort")


async def shutdown(reason: str = "") -> None:
    """Gracefully shut down the current interactive session."""
    if not isinstance(reason, str):
        raise TypeError("reason must be a string")
    await _request("omp.agents.shutdown", reason=reason)


async def reload_extensions() -> None:
    """Request a supervised hot reload of the extension hosts."""
    await _request("omp.agents.reload_extensions")


async def is_idle() -> bool:
    """Return whether the main agent currently has no active run."""
    response = await _request("omp.agents.is_idle")
    if not isinstance(response, bool):
        raise TypeError("agent idle response must be a boolean")
    return response


async def wait_for_idle() -> None:
    """Wait until the main agent has no active run."""
    await _request("omp.agents.wait_for_idle")


async def pending_messages() -> int:
    """Return the number of messages queued for the main agent."""
    response = await _request("omp.agents.pending_messages")
    if isinstance(response, bool) or not isinstance(response, int) or response < 0:
        raise TypeError("pending message response must be a non-negative integer")
    return response


async def inject(
    prompt: str,
    *,
    mode: DeliveryMode = DeliveryMode.NEXT_TURN,
    visible: bool = False,
    role: Literal["user", "system"] = "system",
    session: str | None = None,
) -> Receipt:
    """Inject an out-of-band item into the current or newly created session."""
    response = await _request(
        "omp.agents.inject",
        prompt=prompt,
        mode=mode.value,
        visible=visible,
        role=role,
        session=session,
    )
    return _receipt(response)


class RestoreScope(StrEnum):
    """Which state a rewind or restore operation affects."""

    THREAD = "thread"
    WORKSPACE = "workspace"
    BOTH = "both"


@dataclass(frozen=True, slots=True)
class RewindTarget:
    """Selectable live user-message point in the journal."""

    event: int
    keep: int | None
    text: str
    ts_ms: int
    snapshot_id: str | None


@dataclass(frozen=True, slots=True)
class Conflict:
    """Structured reason a workspace generation cannot be restored."""

    path: EnvPath
    reason: Literal[
        "open_lease", "modified_after_snapshot", "outside_root", "permission"
    ]
    lease_holder: str | None


@dataclass(frozen=True, slots=True)
class RestoreReport:
    """Workspace restore effects and recovery identity."""

    from_generation: int
    to_generation: int
    written: int
    deleted: int
    unchanged: int
    conflicts: tuple[Conflict, ...]
    undo_snapshot_id: str
    dry_run: bool


@dataclass(frozen=True, slots=True)
class RewindReport:
    """Atomic thread and optional workspace rewind report."""

    head: int
    dropped_items: int
    scope: RestoreScope
    restore: RestoreReport | None
    dry_run: bool


@dataclass(frozen=True, slots=True)
class Snapshot:
    """Content-addressed generation of a workspace."""

    id: str
    generation: int
    label: str | None
    created_ms: int
    root: WorkspaceUri
    parent: str | None
    tree_hash: str
    entry_count: int
    bytes: int
    partial: bool


def _conflict(value: object) -> Conflict:
    row = _mapping(value, "restore conflict")
    return Conflict(
        path=EnvPath(str(row["path"])),
        reason=str(row["reason"]),
        lease_holder=None
        if row.get("lease_holder") is None
        else str(row["lease_holder"]),
    )


def _restore_report(value: object) -> RestoreReport:
    row = _mapping(value, "restore report")
    return RestoreReport(
        from_generation=int(row["from_generation"]),
        to_generation=int(row["to_generation"]),
        written=int(row["written"]),
        deleted=int(row["deleted"]),
        unchanged=int(row["unchanged"]),
        conflicts=tuple(
            _conflict(item) for item in _rows(row["conflicts"], "restore conflicts")
        ),
        undo_snapshot_id=str(row["undo_snapshot_id"]),
        dry_run=bool(row["dry_run"]),
    )


def _snapshot(value: object) -> Snapshot:
    row = _mapping(value, "workspace snapshot")
    return Snapshot(
        id=str(row["id"]),
        generation=int(row["generation"]),
        label=None if row.get("label") is None else str(row["label"]),
        created_ms=int(row["created_ms"]),
        root=WorkspaceUri(str(row["root"])),
        parent=None if row.get("parent") is None else str(row["parent"]),
        tree_hash=str(row["tree_hash"]),
        entry_count=int(row["entry_count"]),
        bytes=int(row["bytes"]),
        partial=bool(row["partial"]),
    )


async def rewind_targets() -> _builtins.list[RewindTarget]:
    """List live user-message rewind targets oldest first."""
    response = _rows(
        await _request("omp.agents.rewind_targets"),
        "rewind targets",
    )
    return [
        RewindTarget(
            event=int(row["event"]),
            keep=None if row.get("keep") is None else int(row["keep"]),
            text=str(row["text"]),
            ts_ms=int(row["ts_ms"]),
            snapshot_id=None
            if row.get("snapshot_id") is None
            else str(row["snapshot_id"]),
        )
        for item in response
        for row in (_mapping(item, "rewind target"),)
    ]


async def rewind(
    to: int | None,
    *,
    scope: RestoreScope = RestoreScope.THREAD,
    snapshot_id: str | None = None,
    dry_run: bool = False,
) -> RewindReport:
    """Atomically rewind thread state and optionally workspace state."""
    row = _mapping(
        await _request(
            "omp.agents.rewind",
            to=to,
            scope=scope.value,
            snapshot_id=snapshot_id,
            dry_run=dry_run,
        ),
        "rewind report",
    )
    return RewindReport(
        head=int(row["head"]),
        dropped_items=int(row["dropped_items"]),
        scope=RestoreScope(str(row["scope"])),
        restore=None
        if row.get("restore") is None
        else _restore_report(row["restore"]),
        dry_run=bool(row["dry_run"]),
    )


async def snapshot(
    *, label: str | None = None, paths: Sequence[str] | None = None
) -> Snapshot:
    """Capture a content-addressed workspace generation."""
    return _snapshot(
        await _request(
            "omp.agents.snapshot",
            label=label,
            paths=None if paths is None else [str(path) for path in paths],
        )
    )


async def snapshots(*, limit: int = 50) -> _builtins.list[Snapshot]:
    """List workspace snapshots newest first."""
    if limit < 0:
        raise ValueError("snapshot limit must be non-negative")
    response = _rows(
        await _request("omp.agents.snapshots", limit=limit),
        "workspace snapshots",
    )
    return [_snapshot(row) for row in response]


async def restore(
    snapshot_id: str,
    *,
    paths: Sequence[str] | None = None,
    dry_run: bool = False,
) -> RestoreReport:
    """Restore files from a content-addressed workspace generation."""
    if not snapshot_id:
        raise ValueError("snapshot_id must be non-empty")
    return _restore_report(
        await _request(
            "omp.agents.restore",
            snapshot_id=snapshot_id,
            paths=None if paths is None else [str(path) for path in paths],
            dry_run=dry_run,
        )
    )


class MissedRunPolicy(StrEnum):
    """Recovery policy for firings missed while the scheduler was down."""

    SKIP = "skip"
    COALESCE = "coalesce"
    BACKFILL = "backfill"


class ScheduleScope(StrEnum):
    """Durability scope for a schedule declaration."""

    SESSION = "session"
    PROJECT = "project"


class UpgradePolicy(StrEnum):
    """Artifact selection policy for future schedule firings."""

    PINNED = "pinned"
    AUTO = "auto"


@dataclass(frozen=True, slots=True)
class Cron:
    """Cron trigger evaluated in an IANA timezone."""

    expr: str
    tz: str = "UTC"


@dataclass(frozen=True, slots=True)
class Every:
    """Fixed-interval trigger with optional jitter and alignment."""

    interval: Duration
    jitter: Duration = Duration("0s")
    align: bool = False


@dataclass(frozen=True, slots=True)
class At:
    """One-shot trigger at an absolute Unix epoch millisecond."""

    epoch_ms: int


@dataclass(frozen=True, slots=True)
class AfterIdle:
    """Trigger armed after an agent remains settled for a duration."""

    idle: Duration


Trigger: TypeAlias = Cron | Every | At | AfterIdle


@dataclass(frozen=True, slots=True)
class Inject:
    """Deliver a scheduled prompt to the declaring agent."""

    prompt: str
    mode: DeliveryMode = DeliveryMode.NEXT_TURN
    visible: bool = False


@dataclass(frozen=True, slots=True)
class Spawn:
    """Deliver a firing by spawning a supervised child."""

    spec: SubagentSpec


Delivery: TypeAlias = Inject | Spawn


@dataclass(frozen=True, slots=True)
class ScheduleBudget:
    """Hard request and cost ceilings for a durable schedule."""

    max_usd_per_firing: float | None = None
    max_usd_per_window: float | None = None
    window: Duration = Duration("720h")
    max_requests_per_firing: int | None = None


@dataclass(frozen=True, slots=True)
class Schedule:
    """Frozen projection of one durable schedule."""

    id: str
    name: str
    trigger: Trigger
    delivery: Delivery
    scope: ScheduleScope
    enabled: bool
    owner: str
    principal: str
    artifact_digest: str
    upgrade: UpgradePolicy
    missed: MissedRunPolicy
    budget: ScheduleBudget | None
    overlap: Literal["skip", "queue"]
    created_ms: int
    next_ms: int | None
    last_ms: int | None
    fire_count: int
    miss_count: int


@dataclass(frozen=True, slots=True)
class Firing:
    """Durable outcome of one schedule firing."""

    schedule_id: str
    idempotency_key: str
    at_ms: int
    late_ms: int
    outcome: Literal[
        "injected", "spawned", "skipped", "failed", "duplicate", "budget_refused"
    ]
    artifact_digest: str
    principal: str
    run_id: str | None
    detail: str | None


def _trigger_wire(trigger: Trigger) -> dict[str, object]:
    if isinstance(trigger, Cron):
        return {"kind": "cron", "expr": trigger.expr, "tz": trigger.tz}
    if isinstance(trigger, Every):
        return {
            "kind": "every",
            "interval_ms": _duration_ms(trigger.interval),
            "jitter_ms": _duration_ms(trigger.jitter),
            "align": trigger.align,
        }
    if isinstance(trigger, At):
        return {"kind": "at", "epoch_ms": trigger.epoch_ms}
    if isinstance(trigger, AfterIdle):
        return {"kind": "after_idle", "idle_ms": _duration_ms(trigger.idle)}
    raise TypeError("trigger must be Cron, Every, At, or AfterIdle")


def _trigger(value: object) -> Trigger:
    row = _mapping(value, "schedule trigger")
    kind = str(row.get("kind", ""))
    if kind == "cron":
        return Cron(str(row["expr"]), str(row.get("tz", "UTC")))
    if kind == "every":
        return Every(
            _duration(row["interval_ms"]),
            _duration(row.get("jitter_ms", 0)),
            bool(row.get("align", False)),
        )
    if kind == "at":
        return At(int(row["epoch_ms"]))
    if kind == "after_idle":
        return AfterIdle(_duration(row["idle_ms"]))
    raise TypeError(f"unknown schedule trigger kind: {kind!r}")


def _delivery_wire(delivery: Delivery) -> dict[str, object]:
    if isinstance(delivery, Inject):
        return {
            "kind": "inject",
            "prompt": delivery.prompt,
            "mode": delivery.mode.value,
            "visible": delivery.visible,
        }
    if isinstance(delivery, Spawn):
        spec = _spec_wire(delivery.spec)
        spec["background"] = True
        return {"kind": "spawn", "spec": spec}
    raise TypeError("delivery must be Inject or Spawn")


def _delivery(value: object) -> Delivery:
    row = _mapping(value, "schedule delivery")
    kind = str(row.get("kind", ""))
    if kind == "inject":
        return Inject(
            prompt=str(row["prompt"]),
            mode=DeliveryMode(str(row.get("mode", DeliveryMode.NEXT_TURN.value))),
            visible=bool(row.get("visible", False)),
        )
    if kind == "spawn":
        return Spawn(_spec(row["spec"]))
    raise TypeError(f"unknown schedule delivery kind: {kind!r}")


def _schedule_budget(value: object | None) -> ScheduleBudget | None:
    if value is None:
        return None
    row = _mapping(value, "schedule budget")
    return ScheduleBudget(
        max_usd_per_firing=None
        if row.get("max_usd_per_firing") is None
        else float(row["max_usd_per_firing"]),
        max_usd_per_window=None
        if row.get("max_usd_per_window") is None
        else float(row["max_usd_per_window"]),
        window=_duration(row["window_ms"]),
        max_requests_per_firing=None
        if row.get("max_requests_per_firing") is None
        else int(row["max_requests_per_firing"]),
    )


def _schedule(value: object) -> Schedule:
    row = _mapping(value, "schedule")
    return Schedule(
        id=str(row["id"]),
        name=str(row["name"]),
        trigger=_trigger(row["trigger"]),
        delivery=_delivery(row["delivery"]),
        scope=ScheduleScope(str(row["scope"])),
        enabled=bool(row["enabled"]),
        owner=str(row["owner"]),
        principal=str(row["principal"]),
        artifact_digest=str(row["artifact_digest"]),
        upgrade=UpgradePolicy(str(row["upgrade"])),
        missed=MissedRunPolicy(str(row["missed"])),
        budget=_schedule_budget(row["budget"]),
        overlap=str(row["overlap"]),
        created_ms=int(row["created_ms"]),
        next_ms=None if row.get("next_ms") is None else int(row["next_ms"]),
        last_ms=None if row.get("last_ms") is None else int(row["last_ms"]),
        fire_count=int(row["fire_count"]),
        miss_count=int(row["miss_count"]),
    )


def _firing(value: object) -> Firing:
    row = _mapping(value, "schedule firing")
    return Firing(
        schedule_id=str(row["schedule_id"]),
        idempotency_key=str(row["idempotency_key"]),
        at_ms=int(row["at_ms"]),
        late_ms=int(row["late_ms"]),
        outcome=str(row["outcome"]),
        artifact_digest=str(row["artifact_digest"]),
        principal=str(row["principal"]),
        run_id=None if row.get("run_id") is None else str(row["run_id"]),
        detail=None if row.get("detail") is None else str(row["detail"]),
    )


class ScheduleHandle:
    """Live identity and control surface for a durable schedule."""
    id: str
    name: str


    def __init__(self, id: str, name: str) -> None:
        self.id = id
        self.name = name

    async def pause(self) -> None:
        """Pause future firings."""
        await _request("omp.agents.schedule.pause", schedule_id=self.id)

    async def resume(self) -> None:
        """Resume future firings."""
        await _request("omp.agents.schedule.resume", schedule_id=self.id)

    async def delete(self) -> None:
        """Delete this durable schedule."""
        await _request("omp.agents.schedule.delete", schedule_id=self.id)

    async def fire_now(self) -> Receipt:
        """Request a journaled manual firing."""
        return _receipt(
            await _request("omp.agents.schedule.fire_now", schedule_id=self.id)
        )

    async def info(self) -> Schedule:
        """Read the current schedule projection."""
        return _schedule(
            await _request("omp.agents.schedule.info", schedule_id=self.id)
        )

    async def history(self, limit: int = 20) -> _builtins.list[Firing]:
        """Read durable firing history."""
        response = _rows(
            await _request(
                "omp.agents.schedule.history",
                schedule_id=self.id,
                limit=limit,
            ),
            "schedule firing history",
        )
        return [_firing(row) for row in response]


async def schedule(
    name: str,
    trigger: Trigger,
    delivery: Delivery,
    *,
    scope: ScheduleScope = ScheduleScope.SESSION,
    missed: MissedRunPolicy = MissedRunPolicy.COALESCE,
    overlap: Literal["skip", "queue"] = "skip",
    upgrade: UpgradePolicy = UpgradePolicy.PINNED,
    budget: ScheduleBudget | None = None,
) -> ScheduleHandle:
    """Upsert a durable schedule through the scheduler host arm."""
    if not isinstance(name, str) or not name:
        raise ScheduleRejected("name must be non-empty", field="name")
    budget_wire = None
    if budget is not None:
        budget_wire = {
            "max_usd_per_firing": budget.max_usd_per_firing,
            "max_usd_per_window": budget.max_usd_per_window,
            "window_ms": _duration_ms(budget.window),
            "max_requests_per_firing": budget.max_requests_per_firing,
        }
    row = _mapping(
        await _request(
            "omp.agents.schedule",
            name=name,
            trigger=_trigger_wire(trigger),
            delivery=_delivery_wire(delivery),
            scope=scope.value,
            missed=missed.value,
            overlap=overlap,
            upgrade=upgrade.value,
            budget=budget_wire,
        ),
        "schedule handle",
    )
    return ScheduleHandle(str(row["id"]), str(row.get("name", name)))


async def schedules(
    *, scope: ScheduleScope | None = None, owner: str | None = None
) -> _builtins.list[Schedule]:
    """List visible durable schedules."""
    response = _rows(
        await _request(
            "omp.agents.schedules",
            scope=None if scope is None else scope.value,
            owner=owner,
        ),
        "schedules",
    )
    return [_schedule(row) for row in response]


async def unschedule(name_or_id: str) -> bool:
    """Delete a schedule by owner-local name or stable identifier."""
    if not name_or_id:
        raise ValueError("schedule name or id must be non-empty")
    return bool(
        await _request("omp.agents.unschedule", name_or_id=name_or_id)
    )


class TimerHandle:
    """Host-local cancellable timer handle."""

    def __init__(
        self,
        loop: asyncio.AbstractEventLoop,
        delay: float,
        callback: Callable[[], Awaitable[None]],
        repeat: bool,
    ) -> None:
        self._loop = loop
        self._delay = delay
        self._callback = callback
        self._repeat = repeat
        self._scheduled: asyncio.TimerHandle | None = None
        self._task: asyncio.Task[None] | None = None
        self._cancelled = False
        self._arm()

    def _arm(self) -> None:
        self._scheduled = self._loop.call_later(self._delay, self._fire)

    def _fire(self) -> None:
        self._scheduled = None
        if self._cancelled:
            return
        self._task = self._loop.create_task(self._run())

    async def _run(self) -> None:
        try:
            await self._callback()
        except BaseException:
            self._cancelled = True
            raise
        else:
            if self._repeat and not self._cancelled:
                self._arm()
        finally:
            self._task = None

    def cancel(self) -> None:
        """Cancel any pending firing or running callback."""
        self._cancelled = True
        if self._scheduled is not None:
            self._scheduled.cancel()
            self._scheduled = None
        if self._task is not None:
            self._task.cancel()

    @property
    def active(self) -> bool:
        """Whether the timer still has a pending or active firing."""
        return not self._cancelled and (
            self._scheduled is not None or self._task is not None
        )


def timer(
    delay: Duration,
    callback: Callable[[], Awaitable[None]],
    *,
    repeat: bool = False,
) -> TimerHandle:
    """Schedule a host-local asynchronous callback on the running event loop."""
    loop = asyncio.get_running_loop()
    return TimerHandle(loop, delay.seconds, callback, repeat)


async def list(
    *,
    kind: AgentKind | None = None,
    status: AgentStatus | None = None,
    include_parked: bool = True,
) -> _builtins.list[AgentRef]:
    """List visible agents in tree order."""
    response = _rows(
        await _request(
            "omp.agents.list",
            kind=None if kind is None else kind.value,
            status=None if status is None else status.value,
            include_parked=include_parked,
        ),
        "agent roster",
    )
    return [_agent_ref(row) for row in response]

__all__ = (
    "AfterIdle",
    "AgentGone",
    "AgentKind",
    "AgentRef",
    "AgentStatus",
    "AgentsError",
    "At",
    "Budget",
    "Completion",
    "CompletionFailed",
    "ConcurrencyExhausted",
    "Conflict",
    "Continue",
    "ContinuationLedger",
    "ContinuationPolicy",
    "Cron",
    "DEFAULT_CONTINUATION_CAP",
    "DEFAULT_MAX_CONCURRENCY",
    "DEFAULT_MAX_DEPTH",
    "Delivery",
    "DeliveryMode",
    "DepthExceeded",
    "EMPTY_OUTPUT_RETRY_CAP",
    "Every",
    "Firing",
    "Inject",
    "Isolation",
    "LoopSignal",
    "MAILBOX_CAPACITY",
    "MAX_BACKFILL",
    "ModelSwitchDenied",
    "MIN_SCHEDULE_INTERVAL",
    "MergeMode",
    "Message",
    "MissedRunPolicy",
    "PolicyDenied",
    "Progress",
    "Receipt",
    "RestoreReport",
    "RestoreScope",
    "RewindPending",
    "RewindReport",
    "RewindTarget",
    "RunStatus",
    "STEER_GRACE",
    "Schedule",
    "ScheduleBudget",
    "ScheduleHandle",
    "ScheduleRejected",
    "ScheduleScope",
    "Settle",
    "Snapshot",
    "SnapshotUnsupported",
    "SessionInjectionDenied",
    "Spawn",
    "SpawnDenied",
    "SpawnLimits",
    "SubagentHandle",
    "SubagentResult",
    "SubagentSpec",
    "ThinkingLevel",
    "TimerHandle",
    "Trigger",
    "UpgradePolicy",
    "Usage",
    "WorktreeOutcome",
    "abort",
    "broadcast",
    "completion",
    "continuations",
    "depth",
    "get",
    "inbox",
    "inject",
    "is_idle",
    "limits",
    "set_model",
    "list",
    "loop_signal",
    "peers",
    "pending_messages",
    "reload_extensions",
    "restore",
    "revive",
    "rewind",
    "rewind_targets",
    "schedule",
    "schedules",
    "send",
    "set_continuation_policy",
    "shutdown",
    "snapshot",
    "snapshots",
    "spawn",
    "spawn_all",
    "timer",
    "unschedule",
    "wait_for",
    "wait_for_idle",
)
