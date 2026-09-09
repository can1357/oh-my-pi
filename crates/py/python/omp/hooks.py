"""Pure-Python hook declarations, CONTROL dispatch, and decision codecs."""

from __future__ import annotations

import asyncio
import inspect
import math
import types
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, fields, is_dataclass
from enum import StrEnum
from typing import (
    Any,
    ClassVar,
    Final,
    TypeAlias,
    TypeVar,
    get_args,
    get_origin,
    get_type_hints,
)

from _omp import Duration, OmpError, Secret

from ._errors import NotWiredError
from ._registry import registry


_HookFn = TypeVar("_HookFn", bound=Callable[..., object])


class UnknownEvent(OmpError, ValueError):
    """A hook declaration or catalog lookup named no frozen event."""


class UnsupportedEvent(OmpError, ValueError):
    """A known hook name has no typed production route in this build."""


class HookContractError(OmpError, ValueError):
    """A hook declaration or decision violates the frozen hook contract."""


class LateRegistration(OmpError, RuntimeError):
    """A hook was declared after the extension declaration table was sealed."""


class ReentrancyError(OmpError):
    """A hook exceeded ``omp.limits.REENTRANCY_DEPTH``."""


class PhaseConflict(OmpError):
    """A hook awaited a CONTROL operation blocked by its pending loop phase."""


class HostShuttingDown(OmpError):
    """A hook operation was attempted after session shutdown began."""


class HookPhase(StrEnum):
    """Order one hook within the per-event decision procedure."""

    PRECHECK = "precheck"
    TRANSFORM = "transform"
    REVIEW = "review"
    APPROVAL = "approval"
    OBSERVE = "observe"


class CallOrigin(StrEnum):
    """Identify who issued a logical call."""

    MODEL = "model"
    USER = "user"
    SUBAGENT = "subagent"
    REPLAY = "replay"


class TargetKind(StrEnum):
    """Discriminate built-in, extension-device, and MCP dispatch targets."""

    CORE = "core"
    DEVICE = "device"
    MCP = "mcp"


class Composition(StrEnum):
    """Select how ordered hook mutations combine for one payload field."""

    REPLACE = "replace"
    APPEND = "append"
    INTERSECT = "intersect"


class OnFailure(StrEnum):
    """Select fail-open or fail-closed behavior for an unavailable handler."""

    DEFER = "defer"
    DENY = "deny"


class LatencyClass(StrEnum):
    """Classify an event by how frequently it can delay harness progress."""

    SESSION = "session"
    SUBMISSION = "submission"
    TURN = "turn"
    CALL = "call"
    INPUT = "input"
    STREAM = "stream"
    ASYNC = "async"


class Channel(StrEnum):
    """Identify the transport carrying hook dispatches."""

    CONTROL = "control"


class ApprovalKind(StrEnum):
    """Classify an approval for presentation and configuration lookup."""

    EXEC = "exec"
    WRITE = "write"
    READ = "read"
    NETWORK = "network"
    PRIVILEGE = "privilege"
    DEVICE = "device"
    SPAWN = "spawn"


class PolicyScope(StrEnum):
    """Bound the lifetime of a policy decision or approval grant."""

    ONCE = "once"
    CALL = "call"
    TURN = "turn"
    SESSION = "session"
    PERSIST = "persist"


class ApprovalRoute(StrEnum):
    """Choose where Core routes a durable approval ticket."""

    AUTO = "auto"
    LOCAL = "local"
    PARENT = "parent"
    EXTERNAL = "external"
    NONE = "none"


class Unreachable(StrEnum):
    """Resolve an approval whose selected route cannot answer."""

    FAIL_CLOSED = "fail_closed"
    ESCALATE_LOCAL = "escalate_local"
    FAIL_OPEN_AUDITED = "fail_open_audited"


DEFAULT_HOOK_TIMEOUT: Final[Duration] = Duration("5s")
"""Host fallback deadline for an event without a catalog-specific timeout."""

APPROVAL_DEADLINE: Final[Duration] = Duration("5m")
"""Default wall-clock deadline carried by a durable approval request."""


@dataclass(frozen=True, slots=True)
class ApprovalSpec:
    """Describe one reason to open or merge into a durable approval ticket."""

    title: str
    body: str
    subject: str
    kind: ApprovalKind = ApprovalKind.EXEC
    scopes: tuple[PolicyScope, ...] = (PolicyScope.ONCE, PolicyScope.SESSION)
    default: bool | None = None
    route: ApprovalRoute = ApprovalRoute.AUTO
    approver: str | None = None
    timeout: Duration = APPROVAL_DEADLINE
    unreachable: Unreachable = Unreachable.FAIL_CLOSED
    require_human: bool = False
    pattern: str | None = None
    evidence: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class Allow:
    """Cast an affirmative hook vote without bypassing later phases."""

    reason: str | None = None


@dataclass(frozen=True, slots=True)
class Deny:
    """Refuse an event and optionally classify the refusal durably."""

    reason: str
    fatal: bool = False
    code: str | None = None


@dataclass(frozen=True, slots=True)
class Modify:
    """Replace or shallow-patch the mutable fields of a hook payload."""

    target: CallTarget | None = None
    args: Mapping[str, Any] | None = None
    patch: Mapping[str, Any] | None = None
    env_overrides: Mapping[str, str | None] | None = None
    reason: str | None = None

    def __post_init__(self) -> None:
        if self.args is not None and (
            self.patch is not None or self.env_overrides is not None
        ):
            raise HookContractError(
                "Modify args and patch fields are mutually exclusive"
            )
        if (
            self.env_overrides is not None
            and self.patch is not None
            and "env_overrides" in self.patch
        ):
            raise HookContractError(
                "Modify env_overrides cannot also appear in patch"
            )
        if self.env_overrides is not None and (
            any(not isinstance(key, str) for key in self.env_overrides)
            or any(
                value is not None and not isinstance(value, str)
                for value in self.env_overrides.values()
            )
        ):
            raise HookContractError(
                "Modify env_overrides must map strings to strings or None"
            )


@dataclass(frozen=True, slots=True)
class Defer:
    """Abstain from a hook decision while optionally recording a debug note."""

    note: str | None = None


@dataclass(frozen=True, slots=True)
class RequireApproval:
    """Complete a hook by asking Core to file a durable approval ticket."""

    spec: ApprovalSpec


HookDecision: TypeAlias = Allow | Deny | Modify | Defer | RequireApproval
"""The closed five-arm return vocabulary for gateable hooks."""


UNSET: Final[object] = object()
"""Sentinel used by ``Modify.patch`` to remove a mapping key."""


@dataclass(frozen=True, slots=True)
class CoreTool:
    """Identify one built-in harness tool dispatch."""

    kind: ClassVar[TargetKind] = TargetKind.CORE
    name: str
    rev: str
    args: Mapping[str, Any]


@dataclass(frozen=True, slots=True)
class DeviceCall:
    """Identify one extension or mounted-device dispatch."""

    kind: ClassVar[TargetKind] = TargetKind.DEVICE
    name: str
    family: str
    rev: str
    args: Mapping[str, Any]


@dataclass(frozen=True, slots=True)
class McpCall:
    """Identify one tool on a mounted MCP server."""

    kind: ClassVar[TargetKind] = TargetKind.MCP
    server: str
    tool: str
    args: Mapping[str, Any]


CallTarget: TypeAlias = CoreTool | DeviceCall | McpCall
"""Discriminated target of a logical tool dispatch."""


@dataclass(frozen=True, slots=True)
class When:
    """Declare a Core-side pre-filter evaluated before payload construction."""

    target: frozenset[TargetKind] | None = None
    name: frozenset[str] | None = None
    server: frozenset[str] | None = None
    rev: frozenset[str] | None = None
    path_globs: tuple[str, ...] = ()
    method_globs: tuple[str, ...] = ()
    origin: frozenset["CallOrigin"] | None = None
    reason: frozenset[str] | None = None
    provider: frozenset[str] | None = None
    once: bool = False
    after_gap: Duration | None = None

    def __post_init__(self) -> None:


        for field in ("target", "name", "server", "rev", "origin", "reason", "provider"):
            value = getattr(self, field)
            if value is not None and not isinstance(value, frozenset):
                object.__setattr__(self, field, frozenset(value))
        if not isinstance(self.path_globs, tuple):
            object.__setattr__(self, "path_globs", tuple(self.path_globs))
        if not isinstance(self.method_globs, tuple):
            object.__setattr__(self, "method_globs", tuple(self.method_globs))


_EVENT_NAMES = (
    "session_start", "session_shutdown", "session_switch", "session_switched",
    "session_branch", "session_branched", "session_rewind", "session_rewound",
    "session_reset", "before_agent_start", "agent_start", "turn_start", "turn_end",
    "agent_settled", "agent_end", "interrupt", "deadline", "message_start",
    "message_update", "message_end", "item_committed", "call_open", "tool_call",
    "tool_execution_start", "tool_update", "tool_execution_end", "tool_result",
    "tool_approval_requested", "tool_approval_resolved", "device_list", "user_input",
    "user_bash", "user_eval", "command_invoke", "resources_discover",
    "resources_changed", "provider_login", "provider_refresh", "provider_sign",
    "before_request", "models_discover", "provider_error", "provider_usage", "search_parse",
    "sandbox_profile", "sandbox_violation",
    "capability_budget", "model_changed", "credential_disabled", "compaction",
    "compaction_done", "context_reset", "thread_projection", "subagent_spawn", "worker_state",
    "job_registered", "job_settled", "extension_activate", "extension_load",
    "extension_unload", "host_reconnect", "ttsr_triggered",
    "retry_start", "retry_end", "fallback_applied", "fallback_succeeded",
    "mcp_notification", "provider_response", "session_renamed",
)

_REJECTED_EVENTS = types.MappingProxyType(
    {
        "search_parse": "no HookEventId or production search-parser emitter exists",
        "sandbox_profile": "no HookEventId or production sandbox-profile emitter exists",
        "sandbox_violation": "no HookEventId or production sandbox-violation emitter exists",
        "context_reset": "no HookEventId or production context-reset emitter exists",
    }
)
_ROUTABLE_EVENT_NAMES = frozenset(_EVENT_NAMES) - _REJECTED_EVENTS.keys()
_TRANSFORM_UNSUPPORTED = frozenset({"session_branch", "session_rewind"})


@dataclass(frozen=True, slots=True)
class _HookDeclaration:
    event: str
    phase: HookPhase | str
    handler: Callable[..., object]
    order: int
    on_failure: OnFailure | None
    timeout: Duration | None
    coalesce: Duration | None
    when: When | None
    concurrency: int
    threadsafe: bool
    name: str


_OBSERVATION_EVENTS = frozenset(
    {
        "session_shutdown", "session_switched", "session_branched", "session_rewound",
        "session_reset", "agent_start", "turn_end", "agent_end", "interrupt", "deadline",
        "message_start", "message_update", "message_end", "item_committed", "call_open",
        "tool_execution_start", "tool_update", "tool_execution_end",
        "tool_approval_requested", "tool_approval_resolved", "resources_changed",
        "capability_budget", "model_changed", "credential_disabled",
        "compaction_done", "context_reset", "worker_state", "job_registered", "job_settled",
        "extension_activate", "extension_load", "extension_unload", "host_reconnect",
        "ttsr_triggered", "retry_start", "retry_end",
        "fallback_applied", "fallback_succeeded", "mcp_notification",
        "provider_response", "session_renamed",
    }
)
_DOMAIN_EVENTS = frozenset(
    {
        "agent_settled",
        "compaction",
        "models_discover",
        "provider_login",
        "provider_refresh",
        "provider_sign",
        "provider_error",
        "provider_usage",
        "search_parse",
        "sandbox_violation",
        "thread_projection",
    }
)
_STREAM_EVENTS = frozenset({"message_start", "message_update", "message_end", "call_open", "tool_update"})


def hook(
    event: str,
    *,
    phase: HookPhase | None = None,
    order: int = 0,
    on_failure: OnFailure | None = None,
    timeout: Duration | None = None,
    coalesce: Duration | None = None,
    when: When | None = None,
    provider: str | None = None,
    concurrency: int = 1,
    threadsafe: bool = False,
    name: str | None = None,
) -> Callable[[_HookFn], _HookFn]:
    """Declare one hook subscription without performing host I/O."""

    if event not in _EVENT_NAMES:
        raise UnknownEvent(f"unknown hook event {event!r}")
    if reason := _REJECTED_EVENTS.get(event):
        raise UnsupportedEvent(f"unsupported hook event {event!r}: {reason}")
    if registry.sealed:
        raise LateRegistration("hook declarations are sealed")
    if isinstance(phase, str):
        try:
            phase = HookPhase(phase)
        except ValueError as error:
            raise HookContractError(f"unknown hook phase {phase!r}") from error
    if phase is not None and not isinstance(phase, HookPhase):
        raise TypeError("phase must be HookPhase or None")
    if event in _TRANSFORM_UNSUPPORTED and phase is HookPhase.TRANSFORM:
        raise HookContractError(
            f"{event!r} does not support TRANSFORM until Core applies its mutable fields"
        )
    if event in _DOMAIN_EVENTS:
        if phase is not None:
            raise HookContractError(f"domain event {event!r} does not accept phase")
        registry_phase: HookPhase | str = "domain"
    elif event in _OBSERVATION_EVENTS:
        if phase not in (None, HookPhase.OBSERVE):
            raise HookContractError(f"observation event {event!r} only accepts OBSERVE")
        registry_phase = HookPhase.OBSERVE
    elif event == "sandbox_profile":
        if phase != HookPhase.TRANSFORM:
            raise HookContractError("sandbox_profile requires TRANSFORM phase")
        registry_phase = phase
    else:
        if phase is None:
            raise HookContractError(f"gateable event {event!r} requires phase")
        registry_phase = phase
    if isinstance(on_failure, str):
        try:
            on_failure = OnFailure(on_failure)
        except ValueError as error:
            raise HookContractError(f"unknown hook failure policy {on_failure!r}") from error
    if event in _OBSERVATION_EVENTS and on_failure is not None:
        raise HookContractError("observation hooks do not accept on_failure")
    from .events import spec as event_spec

    try:
        catalog = event_spec(event)
    except UnknownEvent:
        catalog = None
    if (
        catalog is not None
        and catalog.on_failure is OnFailure.DENY
        and on_failure is OnFailure.DEFER
    ):
        raise HookContractError(
            f"{event!r} is fail-closed and cannot lower on_failure to DEFER"
        )
    if timeout is not None:
        if not isinstance(timeout, Duration):
            raise TypeError("timeout must be omp.Duration or None")
        if timeout.seconds <= 0:
            raise HookContractError("hook timeout must be greater than zero")
        if (
            catalog is not None
            and timeout.seconds > catalog.ceiling_timeout.seconds
        ):
            raise HookContractError(
                f"hook timeout exceeds {event!r} ceiling "
                f"{catalog.ceiling_timeout}"
            )
    if not isinstance(order, int) or isinstance(order, bool):
        raise TypeError("order must be an integer")
    if registry_phase != HookPhase.TRANSFORM and order != 0:
        raise HookContractError("order is legal only in TRANSFORM")
    if event in _STREAM_EVENTS and coalesce is None:
        raise HookContractError(f"stream event {event!r} requires coalesce")
    if event not in _STREAM_EVENTS and coalesce is not None:
        raise HookContractError(f"non-stream event {event!r} does not accept coalesce")
    if event == "mcp_notification":
        if when is None or not (
            (when.server is not None and len(when.server) > 0)
            or when.method_globs
        ):
            raise HookContractError(
                "mcp_notification requires a non-empty When.server or When.method_globs"
            )
        if (
            when.server is not None
            and any(not isinstance(value, str) or not value for value in when.server)
        ) or any(
            not isinstance(value, str) or not value for value in when.method_globs
        ):
            raise HookContractError(
                "mcp_notification filters must contain non-empty strings"
            )
    if coalesce is not None:
        if not isinstance(coalesce, Duration):
            raise TypeError("coalesce must be omp.Duration or None")
        if coalesce.seconds < 0.016:
            raise HookContractError("stream hook coalesce must be at least 16ms")
    if provider is not None:
        if when is not None and when.provider is not None:
            raise HookContractError("provider and When.provider are mutually exclusive")
        when = When(provider=frozenset({provider})) if when is None else When(
            target=when.target, name=when.name, server=when.server, rev=when.rev,
            path_globs=when.path_globs, method_globs=when.method_globs,
            origin=when.origin, reason=when.reason,
            provider=frozenset({provider}), once=when.once, after_gap=when.after_gap,
        )
    if isinstance(concurrency, bool) or not isinstance(concurrency, int) or concurrency < 1:
        raise ValueError("concurrency must be a positive integer")
    if not isinstance(threadsafe, bool):
        raise TypeError("threadsafe must be bool")

    def decorate(handler: _HookFn) -> _HookFn:
        if not callable(handler):
            raise TypeError("@omp.hook may decorate only a callable")
        if event in _OBSERVATION_EVENTS:
            annotation = inspect.signature(handler).return_annotation
            if annotation not in (
                inspect.Signature.empty,
                None,
                type(None),
                "None",
                "NoneType",
            ):
                raise HookContractError("observation hooks may only annotate a None return")
        stable_name = name or f"{handler.__module__}.{handler.__qualname__}"
        if not stable_name:
            raise ValueError("hook name must be non-empty")
        declaration = _HookDeclaration(
            event, registry_phase, handler, order, on_failure, timeout, coalesce,
            when, concurrency, threadsafe, stable_name,
        )
        registry.register_hook(event, registry_phase, declaration)
        prior = tuple(getattr(handler, "__omp_hooks__", ()))
        setattr(handler, "__omp_hooks__", prior + (declaration,))
        return handler

    return decorate


def _target_to_wire(target: CallTarget) -> dict[str, object]:
    if isinstance(target, CoreTool):
        return {
            "kind": TargetKind.CORE.value,
            "name": target.name,
            "rev": target.rev,
            "args": _wire_value(target.args),
        }
    if isinstance(target, DeviceCall):
        return {
            "kind": TargetKind.DEVICE.value,
            "name": target.name,
            "family": target.family,
            "rev": target.rev,
            "args": _wire_value(target.args),
        }
    if isinstance(target, McpCall):
        return {
            "kind": TargetKind.MCP.value,
            "server": target.server,
            "tool": target.tool,
            "args": _wire_value(target.args),
        }
    raise HookContractError(f"unknown call target {type(target).__name__}")


def _target_from_wire(value: object) -> CallTarget:
    if not isinstance(value, Mapping):
        raise HookContractError("hook target must be a mapping")
    kind = value.get("kind")
    args = value.get("args")
    if not isinstance(args, Mapping):
        raise HookContractError("hook target args must be a mapping")
    if any(not isinstance(key, str) for key in args):
        raise HookContractError("hook target args keys must be strings")
    try:
        if kind == TargetKind.CORE.value:
            name = value["name"]
            rev = value["rev"]
            if not isinstance(name, str) or not isinstance(rev, str):
                raise HookContractError(
                    "core hook target name and rev must be strings"
                )
            return CoreTool(name, rev, dict(args))
        if kind == TargetKind.DEVICE.value:
            name = value["name"]
            family = value["family"]
            rev = value["rev"]
            if any(
                not isinstance(field, str)
                for field in (name, family, rev)
            ):
                raise HookContractError(
                    "device hook target name, family, and rev must be strings"
                )
            return DeviceCall(name, family, rev, dict(args))
        if kind == TargetKind.MCP.value:
            server = value["server"]
            tool = value["tool"]
            if not isinstance(server, str) or not isinstance(tool, str):
                raise HookContractError(
                    "MCP hook target server and tool must be strings"
                )
            return McpCall(server, tool, dict(args))
    except KeyError as error:
        raise HookContractError("hook target omitted a required field") from error
    raise HookContractError(f"unknown hook target kind {kind!r}")


def _approval_to_wire(spec: ApprovalSpec) -> dict[str, object]:
    if not isinstance(spec, ApprovalSpec):
        raise HookContractError("RequireApproval requires an ApprovalSpec")
    if any(
        not isinstance(value, str)
        for value in (spec.title, spec.body, spec.subject)
    ):
        raise HookContractError(
            "approval title, body, and subject must be strings"
        )
    return {
        "title": spec.title,
        "body": spec.body,
        "subject": spec.subject,
        "kind": spec.kind.value,
        "scopes": [scope.value for scope in spec.scopes],
        "default": spec.default,
        "route": spec.route.value,
        "approver": spec.approver,
        "timeout": str(spec.timeout),
        "unreachable": spec.unreachable.value,
        "require_human": spec.require_human,
        "pattern": spec.pattern,
        "evidence": list(spec.evidence),
    }


def _approval_from_wire(value: object) -> ApprovalSpec:
    if not isinstance(value, Mapping):
        raise HookContractError("approval decision spec must be a mapping")
    try:
        title = value["title"]
        body = value["body"]
        subject = value["subject"]
    except KeyError as error:
        raise HookContractError("invalid approval decision spec") from error
    if any(
        not isinstance(field, str)
        for field in (title, body, subject)
    ):
        raise HookContractError(
            "approval title, body, and subject must be strings"
        )

    scopes = value.get(
        "scopes",
        (PolicyScope.ONCE.value, PolicyScope.SESSION.value),
    )
    evidence = value.get("evidence", ())
    if (
        not isinstance(scopes, Sequence)
        or isinstance(scopes, (str, bytes))
        or not all(isinstance(scope, str) for scope in scopes)
    ):
        raise HookContractError("approval scopes must be a sequence of strings")
    if (
        not isinstance(evidence, Sequence)
        or isinstance(evidence, (str, bytes))
        or not all(isinstance(item, str) for item in evidence)
    ):
        raise HookContractError(
            "approval evidence must be a sequence of strings"
        )

    default = value.get("default")
    approver = value.get("approver")
    timeout = value.get("timeout", str(APPROVAL_DEADLINE))
    require_human = value.get("require_human", False)
    pattern = value.get("pattern")
    if default is not None and not isinstance(default, bool):
        raise HookContractError("approval default must be bool or None")
    if approver is not None and not isinstance(approver, str):
        raise HookContractError("approval approver must be a string or None")
    if not isinstance(timeout, str):
        raise HookContractError("approval timeout must be a string")
    if not isinstance(require_human, bool):
        raise HookContractError("approval require_human must be bool")
    if pattern is not None and not isinstance(pattern, str):
        raise HookContractError("approval pattern must be a string or None")

    try:
        return ApprovalSpec(
            title=title,
            body=body,
            subject=subject,
            kind=ApprovalKind(value.get("kind", ApprovalKind.EXEC.value)),
            scopes=tuple(PolicyScope(scope) for scope in scopes),
            default=default,
            route=ApprovalRoute(value.get("route", ApprovalRoute.AUTO.value)),
            approver=approver,
            timeout=Duration(timeout),
            unreachable=Unreachable(
                value.get("unreachable", Unreachable.FAIL_CLOSED.value)
            ),
            require_human=require_human,
            pattern=pattern,
            evidence=tuple(evidence),
        )
    except (TypeError, ValueError) as error:
        raise HookContractError("invalid approval decision spec") from error


def _decision_to_wire(decision: HookDecision) -> dict[str, object]:
    if isinstance(decision, Allow):
        if decision.reason is not None and not isinstance(decision.reason, str):
            raise HookContractError("Allow.reason must be a string or None")
        return {"kind": "allow", "reason": decision.reason}
    if isinstance(decision, Deny):
        if not isinstance(decision.reason, str):
            raise HookContractError("Deny.reason must be a string")
        if not isinstance(decision.fatal, bool):
            raise HookContractError("Deny.fatal must be bool")
        if decision.code is not None and not isinstance(decision.code, str):
            raise HookContractError("Deny.code must be a string or None")
        return {
            "kind": "deny",
            "reason": decision.reason,
            "fatal": decision.fatal,
            "code": decision.code,
        }
    if isinstance(decision, Modify):
        patch: dict[str, object] | None = None
        unset: list[str] = []
        if decision.patch is not None:
            patch = {}
            for key, value in decision.patch.items():
                if not isinstance(key, str):
                    raise HookContractError("Modify.patch keys must be strings")
                if value is UNSET:
                    unset.append(key)
                else:
                    patch[key] = _wire_value(value)
        if decision.env_overrides is not None:
            if patch is None:
                patch = {}
            patch["env_overrides"] = _wire_value(decision.env_overrides)
        return {
            "kind": "modify",
            "target": (
                _target_to_wire(decision.target)
                if decision.target is not None
                else None
            ),
            "args": (
                _wire_value(decision.args)
                if decision.args is not None
                else None
            ),
            "patch": patch,
            "unset": unset,
            "reason": decision.reason,
        }
    if isinstance(decision, Defer):
        if decision.note is not None and not isinstance(decision.note, str):
            raise HookContractError("Defer.note must be a string or None")
        return {"kind": "defer", "note": decision.note}
    if isinstance(decision, RequireApproval):
        return {
            "kind": "require_approval",
            "spec": _approval_to_wire(decision.spec),
        }
    raise HookContractError(
        f"hook returned unsupported decision {type(decision).__name__}"
    )


def _decision_from_wire(value: object) -> HookDecision:
    if not isinstance(value, Mapping):
        raise HookContractError("hook decision response must be a mapping")
    kind = value.get("kind")
    if kind == "allow":
        reason = value.get("reason")
        if reason is not None and not isinstance(reason, str):
            raise HookContractError(
                "Allow response reason must be a string or None"
            )
        return Allow(reason)
    if kind == "deny":
        reason = value.get("reason")
        if not isinstance(reason, str):
            raise HookContractError("Deny response requires a reason")
        fatal = value.get("fatal", False)
        if not isinstance(fatal, bool):
            raise HookContractError("Deny response fatal must be bool")
        code = value.get("code")
        if code is not None and not isinstance(code, str):
            raise HookContractError(
                "Deny response code must be a string or None"
            )
        return Deny(reason, fatal=fatal, code=code)
    if kind == "modify":
        target = value.get("target")
        args = value.get("args")
        patch_value = value.get("patch")
        unset = value.get("unset", ())
        reason = value.get("reason")
        if args is not None and not isinstance(args, Mapping):
            raise HookContractError("Modify args response must be a mapping")
        if patch_value is not None and not isinstance(patch_value, Mapping):
            raise HookContractError("Modify patch response must be a mapping")
        if (
            not isinstance(unset, Sequence)
            or isinstance(unset, (str, bytes))
        ):
            raise HookContractError("Modify unset response must be a sequence")
        if reason is not None and not isinstance(reason, str):
            raise HookContractError(
                "Modify response reason must be a string or None"
            )
        if args is not None and any(
            not isinstance(key, str) for key in args
        ):
            raise HookContractError("Modify args keys must be strings")
        if patch_value is not None and any(
            not isinstance(key, str) for key in patch_value
        ):
            raise HookContractError("Modify patch keys must be strings")
        if not all(isinstance(key, str) for key in unset):
            raise HookContractError("Modify unset keys must be strings")

        patch = dict(patch_value) if patch_value is not None else None
        if patch is not None and any(key in patch for key in unset):
            raise HookContractError(
                "Modify response cannot patch and unset the same key"
            )
        if unset:
            if patch is None:
                patch = {}
            patch.update((key, UNSET) for key in unset)
        env_overrides = None
        if patch is not None and "env_overrides" in patch:
            env_overrides = patch.pop("env_overrides")
            if not isinstance(env_overrides, Mapping):
                raise HookContractError(
                    "Modify env_overrides response must be a mapping"
                )
        decoded_patch = (
            None
            if env_overrides is not None and not patch
            else patch
        )
        return Modify(
            target=_target_from_wire(target) if target is not None else None,
            args=dict(args) if args is not None else None,
            patch=decoded_patch,
            env_overrides=env_overrides,
            reason=reason,
        )
    if kind == "defer":
        note = value.get("note")
        if note is not None and not isinstance(note, str):
            raise HookContractError(
                "Defer response note must be a string or None"
            )
        return Defer(note)
    if kind == "require_approval":
        return RequireApproval(_approval_from_wire(value.get("spec")))
    raise HookContractError(f"unknown hook decision kind {kind!r}")


def _wire_value(value: object) -> object:
    if isinstance(value, Secret):
        with value.use() as revealed:
            return bytes(revealed)
    if isinstance(value, StrEnum):
        return value.value
    if isinstance(value, float) and not math.isfinite(value):
        raise HookContractError("non-finite floats cannot cross CONTROL")
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    if value is UNSET:
        raise HookContractError("UNSET is legal only as a Modify.patch value")
    if isinstance(value, Duration):
        return str(value)
    if isinstance(value, (CoreTool, DeviceCall, McpCall)):
        return _target_to_wire(value)
    if isinstance(value, Mapping):
        encoded: dict[str, object] = {}
        for key, item in value.items():
            if not isinstance(key, str):
                raise HookContractError("CONTROL mapping keys must be strings")
            encoded[key] = _wire_value(item)
        return encoded
    if isinstance(value, (tuple, list, frozenset)):
        return [_wire_value(item) for item in value]
    if is_dataclass(value) and not isinstance(value, type):
        return {
            field.name: _wire_value(getattr(value, field.name))
            for field in fields(value)
            if not field.name.startswith("_")
        }
    raise HookContractError(
        f"{type(value).__name__} cannot cross the hook CONTROL boundary"
    )


def _value_from_wire(annotation: object, value: object) -> object:
    if annotation in (Any, object):
        return value
    if annotation == CallTarget:
        return _target_from_wire(value)
    origin = get_origin(annotation)
    arguments = get_args(annotation)
    if origin in (types.UnionType,):
        if (
            isinstance(value, Mapping)
            and value.get("kind") in {kind.value for kind in TargetKind}
            and any(
                candidate in (CoreTool, DeviceCall, McpCall)
                for candidate in arguments
            )
        ):
            return _target_from_wire(value)
        for candidate in arguments:
            if candidate is type(None) and value is None:
                return None
            try:
                return _value_from_wire(candidate, value)
            except (HookContractError, TypeError, ValueError):
                continue
        raise HookContractError(f"value does not match {annotation!r}")
    if origin is not None and str(origin) == "typing.Union":
        for candidate in arguments:
            if candidate is type(None) and value is None:
                return None
            try:
                return _value_from_wire(candidate, value)
            except (HookContractError, TypeError, ValueError):
                continue
        raise HookContractError(f"value does not match {annotation!r}")
    if origin in (tuple, list, frozenset, Sequence):
        if not isinstance(value, Sequence) or isinstance(value, (str, bytes)):
            raise HookContractError("hook sequence field must be a sequence")
        item_type = arguments[0] if arguments else Any
        converted = [_value_from_wire(item_type, item) for item in value]
        return tuple(converted) if origin is tuple else (
            frozenset(converted) if origin is frozenset else converted
        )
    if origin in (dict, Mapping):
        if not isinstance(value, Mapping):
            raise HookContractError("hook mapping field must be a mapping")
        value_type = arguments[1] if len(arguments) == 2 else Any
        return {
            str(key): _value_from_wire(value_type, item)
            for key, item in value.items()
        }
    if isinstance(annotation, type) and issubclass(annotation, StrEnum):
        return annotation(value)
    if annotation is Duration:
        return Duration(str(value))
    if annotation is Secret:
        if not isinstance(value, bytes):
            raise HookContractError("hook secret field must use the sealed bytes envelope")
        return Secret(value)
    if (
        isinstance(annotation, type)
        and annotation.__name__ == "LoginUi"
        and annotation.__module__ == "omp.provider"
    ):
        return annotation()
    if isinstance(annotation, type) and is_dataclass(annotation):
        if not isinstance(value, Mapping):
            raise HookContractError(
                f"{annotation.__name__} payload must be a mapping"
            )
        hints = get_type_hints(annotation)
        kwargs = {
            field.name: _value_from_wire(
                hints.get(field.name, Any), value[field.name]
            )
            for field in fields(annotation)
            if not field.name.startswith("_") and field.name in value
        }
        try:
            return annotation(**kwargs)
        except (TypeError, ValueError) as error:
            raise HookContractError(
                f"invalid {annotation.__name__} hook payload"
            ) from error
    return value


def _validate_decision(decision: object, phase: HookPhase) -> HookDecision | None:
    if phase is HookPhase.OBSERVE:
        if decision is not None:
            raise HookContractError("OBSERVE hooks must return None")
        return None
    if decision is None:
        decision = Defer()
    legal: tuple[type, ...]
    if phase is HookPhase.PRECHECK:
        legal = (Deny, Defer)
    elif phase is HookPhase.TRANSFORM:
        legal = (Modify, Defer)
    elif phase is HookPhase.REVIEW:
        legal = (Allow, Deny, Defer)
    else:
        legal = (RequireApproval, Allow, Deny, Defer)
    if not isinstance(decision, legal):
        raise HookContractError(
            f"{type(decision).__name__} is illegal in {phase.value.upper()}"
        )
    return decision


async def _dispatch_hook_callback(
    event: str,
    phase: str,
    name: str,
    payload: object,
    context: object | None = None,
) -> object:
    """Execute exactly one host-selected frozen subscription."""
    from ._context import Context
    from .events import spec as event_spec

    catalog = event_spec(event)
    hook_phase: HookPhase | None
    if phase == "domain":
        hook_phase = None
    else:
        try:
            hook_phase = HookPhase(phase)
        except ValueError as error:
            raise HookContractError(
                f"unknown dispatched hook phase {phase!r}"
            ) from error
    matches = tuple(
        definition.handler
        for definition in registry.snapshot().hook_definitions
        if definition.event == event
        and definition.phase == (
            "domain" if hook_phase is None else hook_phase.value
        )
        and definition.handler.name == name
    )
    if len(matches) != 1:
        raise HookContractError(
            f"host selected unknown hook subscription {name!r} "
            f"for {event!r}/{phase!r}"
        )
    declaration = matches[0]
    event_value = _value_from_wire(catalog.payload, payload)
    if context is None:
        try:
            context_value = Context.current()
        except LookupError as error:
            raise HookContractError(
                "host hook dispatch omitted its callback context"
            ) from error
    elif isinstance(context, Context):
        context_value = context
    else:
        context_value = _value_from_wire(Context, context)

    async def call_handler() -> object:
        result = declaration.handler(event_value, context_value)
        if inspect.isawaitable(result):
            return await result
        return result

    timeout = declaration.timeout or catalog.default_timeout
    if timeout.seconds > 0:
        result = await asyncio.wait_for(call_handler(), timeout.seconds)
    else:
        result = await call_handler()
    if hook_phase is None:
        return _wire_value(result)
    decision = _validate_decision(result, hook_phase)
    if isinstance(decision, Deny) and decision.fatal:
        if catalog.latency is LatencyClass.CALL:
            raise HookContractError("fatal=True is illegal for CALL hooks")
    return None if decision is None else _decision_to_wire(decision)


async def dispatch_hook(event: str, payload: object = None) -> HookDecision:
    """Dispatch one event through Core's composed CONTROL decision procedure."""
    from . import _control_backend, _control_request

    if _control_backend.get() is None:
        raise NotWiredError("omp.hooks.dispatch")
    if not isinstance(event, str):
        raise TypeError("hook event must be a string")
    from .events import spec as event_spec

    catalog = event_spec(event)
    if not catalog.gateable:
        raise HookContractError(
            f"event {event!r} has no composed HookDecision"
        )
    response = await _control_request(
        "omp.hooks.dispatch",
        event=event,
        event_rev=catalog.rev,
        payload=_wire_value(payload),
    )
    return _decision_from_wire(response)

__all__ = (
    "APPROVAL_DEADLINE", "DEFAULT_HOOK_TIMEOUT", "Allow", "ApprovalKind", "ApprovalRoute",
    "ApprovalSpec", "CallOrigin", "CallTarget", "Channel", "Composition", "CoreTool", "Defer",
    "Deny", "DeviceCall", "HookContractError", "HookDecision", "HookPhase",
    "HostShuttingDown", "LatencyClass", "LateRegistration", "McpCall", "Modify", "OnFailure",
    "PhaseConflict", "PolicyScope", "ReentrancyError", "RequireApproval", "TargetKind",
    "UNSET", "UnknownEvent", "UnsupportedEvent", "Unreachable", "When", "dispatch_hook", "hook",
)
