"""The frozen omp Python extension API.

The package is declarative at import time: importing it performs no filesystem,
network, subprocess, Environment, CONTROL, or DATA operation.
"""

from __future__ import annotations

import asyncio as _asyncio
import contextvars as _contextvars
import inspect as _inspect
import keyword as _keyword
import json as _json
import os as _os
import re as _re
from dataclasses import KW_ONLY as _KW_ONLY
from dataclasses import dataclass as _dataclass
from dataclasses import field as _dataclass_field
from enum import StrEnum as _StrEnum
from collections.abc import Callable as _Callable
from collections.abc import Mapping as _Mapping
from collections.abc import Sequence as _Sequence
from types import MappingProxyType as _MappingProxyType
from typing import Any as _Any

from _omp import (
    ActivateReason,
    AgentUrl,
    ArtifactUrl,
    Authority,
    BlobRef,
    ClientPath,
    CostClass,
    Durability,
    Duration,
    EnvPath,
    EnvUnavailable,
    HistoryUrl,
    HostDisconnected,
    InvocationPhase,
    LifecyclePhase,
    OmpError,
    OperationSpec,
    RestartReason,
    StateScope,
    PlacementError,
    Principal,
    ResourceReceipt,
    Secret,
    StaleGeneration,
    WorkspaceUri,
    _scheme_snapshot,
    _phase_legality_matrix,
    _runtime_metadata,
    operation_spec as _native_operation_spec,
)


class QuotaExceeded(OmpError):
    """Report a hard per-extension quota exhaustion and its receipt snapshot."""

    def __init__(self, quota: str, receipt: ResourceReceipt | None) -> None:
        self.quota = quota
        self.receipt = receipt
        receipt_detail = (
            "resource receipt unavailable"
            if receipt is None
            else "resource receipt attached"
        )
        super().__init__(f"quota {quota!r} exceeded; {receipt_detail}")


class Coerce(_StrEnum):
    """Name one declared, journaled argument coercion."""

    LOOSE_BOOL = "loose_bool"
    INTEGER = "integer"
    NUMBER = "number"
    STRING = "string"
    SINGLETON = "singleton"
    JSON_STRING = "json_string"
    STRIP = "strip"
    CSV = "csv"
    NULL_ELISION = "null_elision"


@_dataclass(frozen=True, slots=True)
class Field:
    """Carry declarative metadata for one ``Annotated`` device argument."""

    description: str | None = None
    _: _KW_ONLY
    additional_properties: bool = False
    alias: tuple[str, ...] = ()
    coerce: tuple[Coerce, ...] = ()
    expected: str | None = None
    example: str | None = None

    def __post_init__(self) -> None:
        """Validate and freeze aliases and coercions at declaration time."""

        if self.description is not None and not isinstance(self.description, str):
            raise TypeError("field description must be str or None")
        if not isinstance(self.additional_properties, bool):
            raise TypeError("field additional_properties must be bool")
        if isinstance(self.alias, str):
            raise TypeError("field alias must be a tuple of strings")
        aliases = tuple(self.alias)
        if any(not isinstance(alias, str) or not alias for alias in aliases):
            raise TypeError("field aliases must be non-empty strings")
        if len(set(aliases)) != len(aliases):
            raise ValueError("field aliases must be unique")
        coercions = tuple(self.coerce)
        if any(not isinstance(coercion, Coerce) for coercion in coercions):
            raise TypeError("field coercions must contain only Coerce members")
        if self.expected is not None and not isinstance(self.expected, str):
            raise TypeError("field expected must be str or None")
        if self.example is not None and not isinstance(self.example, str):
            raise TypeError("field example must be str or None")
        object.__setattr__(self, "alias", aliases)
        object.__setattr__(self, "coerce", coercions)


@_dataclass(frozen=True, slots=True, kw_only=True)
class Fault:
    """Marker base for a device's durable typed failure value."""

    terminate: bool = _dataclass_field(
        default=False,
        metadata={"omp_terminal_control": True},
    )

    def __init_subclass__(cls, **kwargs: _Any) -> None:
        super().__init_subclass__(**kwargs)
        from ._verdicts import _validate_verdict_schema

        _validate_verdict_schema(cls)

    def __new__(cls, *_args: _Any, **_kwargs: _Any) -> Fault:
        if cls is Fault:
            raise TypeError("Fault is a marker base; instantiate a frozen dataclass subclass")
        return super().__new__(cls)

    def useless(self) -> bool:
        """Return whether compaction may omit this value's prompt projection."""
        return False




from ._context import Context
from ._errors import (
    ApiLevelError,
    CapabilityError,
    DeadlineExceeded,
    DeclarationLimit,
    DeclarationSealed,
    DuplicateRegistration,
    EffectsNotAuthorized,
    ExtensionError,
    FrameTooLarge,
    ManifestError,
    NotWiredError,
    SpecError,
    TrustError,
)
from ._scope import Trust
from ._verdicts import (
    ArtifactLifetime,
    ArtifactRef,
    BlobPart,
    Budget,
    BudgetError,
    AbortKind,
    Aborted,
    ArgsRejected,
    CallOutcome,
    Dialect,
    Done,
    Detached,
    Faulted,
    JsonPart,
    JobRef,
    LiftedCall,
    ModelClass,
    Ok,
    Part,
    Payload,
    Postcondition,
    PostconditionStatus,
    PromptCaps,
    RecordedCall,
    Rev,
    RevError,
    SPILL_INLINE_LIMIT,
    SpillBudget,
    TextPart,
    ToolIdentity,
    Update,
    VerdictSchemaError,
    VerdictShapeError,
    View,
    dumps,
    jobs,
    loads,
    prompt,
)

from .journal import (
    EntryAccessDenied,
    EntryId,
    EntryTooLarge,
    EntryUndecodable,
    JournalEntry,
    JournalError,
    JournalIndeterminate,
)


class StateScopeDenied(JournalError):
    """The authenticated principal may not access a requested state scope."""


class PermissionDenied(PermissionError, OmpError):
    """The authenticated principal lacks permission for a requested operation."""

_control_backend: _contextvars.ContextVar[_Any | None] = _contextvars.ContextVar(
    "omp_control_backend", default=None
)


def _install_control_backend(backend: _Any) -> None:
    """Install the host-owned CONTROL bridge in the active invocation context."""
    _control_backend.set(backend)
    from . import _context as _context_module
    from . import secrets as _secrets
    from . import telemetry as _telemetry
    from . import ui as _ui
    from .devices import _install_catalog_view

    _install_catalog_view(getattr(backend, "device_catalog", None))
    _ui._install_effect_sink(getattr(backend, "effect", None))
    _telemetry._install_instrument_sink(getattr(backend, "instrument", None))
    _secrets._install_backend(getattr(backend, "secrets", backend))
    _context_module._install_log_sink(getattr(backend, "log", None))


async def _control_request(operation: str, /, **arguments: _Any) -> _Any:
    backend = _control_backend.get()
    if backend is None:
        raise HostDisconnected("no CONTROL request bridge is installed")
    request = backend.request
    if _inspect.iscoroutinefunction(request):
        return await request(operation, arguments)
    result = await _asyncio.to_thread(request, operation, arguments)
    if _inspect.isawaitable(result):
        return await result
    return result


async def _read_url(url: _Any) -> _Any:
    """Resolve a typed URL through the host CONTROL resolver."""
    return await _control_request("omp.urls.read", url=url)



class _State:
    """Typed append-log and content-addressed state surface."""

    async def append(
        self,
        entry: _Any,
        *,
        scope: StateScope,
        idempotency_key: str | None = None,
    ) -> _Any:
        """Append one typed state entry durably."""
        return await _control_request(
            "omp.state.append", entry=entry, scope=scope, idempotency_key=idempotency_key
        )

    async def entries(
        self,
        kind: _Any,
        *,
        scope: StateScope,
        since: _Any = None,
        limit: int | None = None,
    ) -> _Any:
        """Read ordered entries of one registered kind."""
        return await _control_request(
            "omp.state.entries", kind=kind, scope=scope, since=since, limit=limit
        )

    async def latest(self, kind: _Any, *, scope: StateScope) -> _Any:
        """Return the latest entry of one kind, if present."""
        return await _control_request("omp.state.latest", kind=kind, scope=scope)

    async def fold(
        self,
        kind: _Any,
        reducer: _Any,
        initial: _Any,
        *,
        scope: StateScope,
        since: _Any = None,
    ) -> tuple[_Any, _Any]:
        """Fold ordered state entries without exposing storage internals."""
        value = initial
        mark = None
        for record in await self.entries(kind, scope=scope, since=since):
            value = reducer(value, record)
            mark = getattr(record, "id", None)
        return value, mark

    async def cas_put(self, data: bytes, *, scope: StateScope) -> BlobRef:
        """Store content-addressed state rooted in a durable scope."""
        return await _control_request("omp.state.cas_put", data=data, scope=scope)

    async def cas_get(self, ref: BlobRef, *, scope: StateScope) -> bytes:
        """Read content-addressed state rooted in a durable scope."""
        return await _control_request("omp.state.cas_get", ref=ref, scope=scope)


def operation_spec(symbol: str | _Any) -> OperationSpec | None:
    """Return canonical generated operation metadata for a public symbol."""
    return _native_operation_spec(symbol)


async def state_dir() -> EnvPath:
    """Return the Environment path for rebuildable extension indices."""
    return await _control_request("omp.state_dir")


state = _State()
CancelledError = _asyncio.CancelledError


class Capability(_StrEnum):
    """Closed manifest capability vocabulary enforced by the frozen host."""

    ENV_BLOB = "env.blob"
    ENV_DOC_READ = "env.doc.read"
    ENV_DOC_WRITE = "env.doc.write"
    ENV_EXEC = "env.exec"
    ENV_FS_READ = "env.fs.read"
    ENV_FS_WRITE = "env.fs.write"
    ENV_LSP = "env.lsp"
    ENV_NET = "env.net"
    ENV_PROCESS = "env.process"
    ENV_SEARCH = "env.search"
    ENV_WORKSPACE_SNAPSHOT = "env.workspace.snapshot"
    ENV_WORKTREE = "env.worktree"
    PLACE_ENV = "place.env"
    PLACE_WORKER = "place.worker"
    SCHEDULES_PROJECT = "schedules:project"


class Layer(_StrEnum):
    """Deployment layer that admitted an extension."""

    CLIENT = "client"
    WORKSPACE = "workspace"


class LogLevel(_StrEnum):
    """Structured extension log severity."""

    TRACE = "trace"
    DEBUG = "debug"
    INFO = "info"
    WARNING = "warning"
    ERROR = "error"


def _manifest_error(key: str, detail: str) -> ManifestError:
    return ManifestError("omp.toml", key, detail)


def _freeze_str_tuple(value: _Any, key: str) -> tuple[str, ...]:
    if isinstance(value, str):
        raise _manifest_error(key, "must be a sequence of strings")
    frozen = tuple(value)
    if any(not isinstance(item, str) or not item for item in frozen):
        raise _manifest_error(key, "must contain non-empty strings")
    return frozen


def _freeze_mapping(value: _Any, key: str) -> _Mapping[str, _Any]:
    if not isinstance(value, _Mapping):
        raise _manifest_error(key, "must be a mapping")
    if any(not isinstance(name, str) or not name for name in value):
        raise _manifest_error(key, "keys must be non-empty strings")
    return _MappingProxyType(dict(value))


def _manifest_hash_value(value: _Any) -> _Any:
    if isinstance(value, _Mapping):
        return tuple(
            sorted(
                (key, _manifest_hash_value(item))
                for key, item in value.items()
            )
        )
    if isinstance(value, (tuple, list, set, frozenset)):
        items = (_manifest_hash_value(item) for item in value)
        return tuple(sorted(items, key=repr)) if isinstance(value, (set, frozenset)) else tuple(items)
    try:
        hash(value)
    except TypeError:
        slots = getattr(type(value), "__slots__", ())
        return (
            type(value),
            tuple(
                (slot, _manifest_hash_value(getattr(value, slot)))
                for slot in slots
                if hasattr(value, slot)
            ),
        )
    return value


@_dataclass(frozen=True, slots=True)
class ToolEntry:
    """One statically declared manifest tool."""

    name: str
    kind: str
    family: str
    rev: int
    module: str
    summary: str

    def __post_init__(self) -> None:
        for key in ("name", "module", "summary"):
            if not isinstance(getattr(self, key), str) or not getattr(self, key):
                raise _manifest_error(f"tools.{key}", "must be a non-empty str")
        if not isinstance(self.family, str):
            raise _manifest_error("tools.family", "must be str")
        if self.kind not in {"soft", "hard"}:
            raise _manifest_error("tools.kind", "must be 'soft' or 'hard'")
        if not isinstance(self.rev, int) or isinstance(self.rev, bool) or self.rev < 1:
            raise _manifest_error("tools.rev", "must be a positive int")


@_dataclass(frozen=True, slots=True)
class HookEntry:
    """One statically declared manifest hook subscription."""

    event: str
    phase: str
    module: str
    order: int | None = None

    def __post_init__(self) -> None:
        for key in ("event", "phase", "module"):
            if not isinstance(getattr(self, key), str) or not getattr(self, key):
                raise _manifest_error(f"hooks.{key}", "must be a non-empty str")
        if self.order is not None and (
            not isinstance(self.order, int) or isinstance(self.order, bool)
        ):
            raise _manifest_error("hooks.order", "must be int or None")


@_dataclass(frozen=True, slots=True)
class ServiceEntry:
    """One service implementation declared by a manifest."""

    name: str
    rev: int
    module: str

    def __post_init__(self) -> None:
        if not isinstance(self.name, str) or not self.name:
            raise _manifest_error("services.name", "must be a non-empty str")
        if not isinstance(self.module, str) or not self.module:
            raise _manifest_error("services.module", "must be a non-empty str")
        if not isinstance(self.rev, int) or isinstance(self.rev, bool) or self.rev < 1:
            raise _manifest_error("services.rev", "must be a positive int")


@_dataclass(frozen=True, slots=True)
class Requires:
    """Inert Python, wheel, and service requirements from a manifest."""

    python: str | None = None
    wheels: tuple[str, ...] = ()
    services: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        if self.python is not None and (
            not isinstance(self.python, str) or not self.python
        ):
            raise _manifest_error("requires.python", "must be a non-empty str or None")
        object.__setattr__(
            self, "wheels", _freeze_str_tuple(self.wheels, "requires.wheels")
        )
        object.__setattr__(
            self, "services", _freeze_str_tuple(self.services, "requires.services")
        )


@_dataclass(frozen=True, slots=True)
class Manifest:
    """Parsed, immutable manifest of the calling extension."""

    id: str
    name: str
    version: str
    omp_api: int
    description: str | None
    entry: str
    capabilities: frozenset[Capability]
    tools: tuple[ToolEntry, ...]
    hooks: tuple[HookEntry, ...]
    services: tuple[ServiceEntry, ...]
    workers: _Mapping[str, "WorkerSpec"]
    settings: _Mapping[str, SettingSchema]
    requires: Requires

    def __post_init__(self) -> None:
        for key in ("id", "name", "version", "entry"):
            if not isinstance(getattr(self, key), str) or not getattr(self, key):
                raise _manifest_error(key, "must be a non-empty str")
        if _re.fullmatch(r"[a-z0-9.-]{3,128}", self.id) is None:
            raise _manifest_error("id", "must be reverse-DNS form")
        if not isinstance(self.omp_api, int) or isinstance(self.omp_api, bool):
            raise _manifest_error("omp_api", "must be int")
        if self.omp_api not in API_LEVELS:
            raise ApiLevelError(self.omp_api, API_LEVELS)
        if self.description is not None and not isinstance(self.description, str):
            raise _manifest_error("description", "must be str or None")
        try:
            capabilities = frozenset(Capability(cap) for cap in self.capabilities)
        except (TypeError, ValueError) as error:
            raise _manifest_error("capabilities", str(error)) from error
        try:
            tools = tuple(
                item if isinstance(item, ToolEntry) else ToolEntry(**item)
                for item in self.tools
            )
            hooks = tuple(
                item if isinstance(item, HookEntry) else HookEntry(**item)
                for item in self.hooks
            )
            services = tuple(
                item if isinstance(item, ServiceEntry) else ServiceEntry(**item)
                for item in self.services
            )
        except (TypeError, ValueError) as error:
            raise _manifest_error("declarations", str(error)) from error
        workers = _freeze_mapping(self.workers, "workers")
        try:
            workers = _MappingProxyType(
                {
                    name: (
                        worker
                        if isinstance(worker, WorkerSpec)
                        else WorkerSpec(**({"name": name} | dict(worker)))
                    )
                    for name, worker in workers.items()
                }
            )
        except (TypeError, ValueError) as error:
            raise _manifest_error("workers", str(error)) from error
        if any(worker.name != name for name, worker in workers.items()):
            raise _manifest_error("workers", "mapping key must match WorkerSpec.name")
        settings = _freeze_mapping(self.settings, "settings")
        for name, schema in settings.items():
            if not isinstance(schema, SettingSchema):
                try:
                    settings = _MappingProxyType(
                        {
                            item_name: (
                                item_schema
                                if isinstance(item_schema, SettingSchema)
                                else SettingSchema(**item_schema)
                            )
                            for item_name, item_schema in settings.items()
                        }
                    )
                except (TypeError, ValueError) as error:
                    raise _manifest_error(f"settings.{name}", str(error)) from error
                break
        try:
            requires = (
                self.requires
                if isinstance(self.requires, Requires)
                else Requires(**self.requires)
            )
        except (TypeError, ValueError) as error:
            raise _manifest_error("requires", str(error)) from error
        object.__setattr__(self, "capabilities", capabilities)
        object.__setattr__(self, "tools", tools)
        object.__setattr__(self, "hooks", hooks)
        object.__setattr__(self, "services", services)
        object.__setattr__(self, "workers", workers)
        object.__setattr__(self, "settings", settings)
        object.__setattr__(self, "requires", requires)

    def __hash__(self) -> int:
        return hash(
            (
                self.id,
                self.name,
                self.version,
                self.omp_api,
                self.description,
                self.entry,
                self.capabilities,
                self.tools,
                self.hooks,
                self.services,
                _manifest_hash_value(self.workers),
                _manifest_hash_value(self.settings),
                self.requires,
            )
        )


def manifest() -> Manifest:
    """Return the host-delivered manifest for the calling extension."""
    backend = _control_backend.get()
    value = getattr(backend, "manifest", None)
    if callable(value):
        value = value()
    if value is None:
        raise NotWiredError("omp.manifest")
    if isinstance(value, Manifest):
        return value
    if not isinstance(value, _Mapping):
        raise TypeError("host manifest must be a Manifest or mapping")
    return Manifest(**value)


def is_subscribed(event: str) -> bool:
    """Return whether this child declared a hook for ``event``."""
    if not isinstance(event, str):
        raise TypeError("event must be str")
    return any(key[0] == event for key in _declarations.snapshot().hooks)


def restart_reason() -> RestartReason | None:
    """Return the host-delivered reason for this child generation."""
    backend = _control_backend.get()
    if backend is None or not hasattr(backend, "restart_reason"):
        raise NotWiredError("omp.restart_reason")
    value = backend.restart_reason
    if value is None:
        return None
    return value if isinstance(value, RestartReason) else RestartReason(value)


def require(*caps: Capability) -> None:
    """Raise ``CapabilityError`` for the first capability not granted."""
    requested: tuple[Capability, ...] = tuple(
        cap if isinstance(cap, Capability) else Capability(cap) for cap in caps
    )
    if not requested:
        return
    try:
        Context.current().require(*requested)
        return
    except LookupError:
        backend = _control_backend.get()
        granted = getattr(backend, "capabilities", None)
        if granted is None:
            raise NotWiredError("omp.require") from None
        granted_values = frozenset(
            str(getattr(capability, "value", capability))
            for capability in granted
        )
        for capability in requested:
            if capability.value not in granted_values:
                raise CapabilityError(capability.value)

# Importing these frozen modules only creates declarations and namespace values.
from . import env as env
from . import urls as urls
from . import journal as journal
from . import artifacts as artifacts
from .artifacts import (
    ArtifactCorrupt,
    ArtifactError,
    ArtifactNotFound,
    ArtifactNotText,
    ArtifactReader,
    ArtifactStat,
    ArtifactWriter,
)
from . import ui as ui
from .ui import completion
from . import agents as agents
from . import prompts as prompts
from . import sessions as sessions
from . import telemetry as telemetry
from . import context as context
from . import convars as convars
from . import policy as policy
from . import limits as limits
from . import mcp as mcp
from .limits import (
    ACTIVATION_TIMEOUT,
    API_LEVEL,
    API_LEVELS,
    CANCEL_GRACE,
    DOCS_TOTAL_BUDGET,
    HEALTH_TIMEOUT,
    HOST_VERSION,
    MAX_FRAME_BYTES,
    MAX_HOST_CHILDREN,
    MAX_PENDING_EFFECTS,
    PING_INTERVAL,
    PYTHON_REV,
    SCHEMA_REV,
    SHUTDOWN_GRACE,
)
from . import creds as creds
from . import secrets as secrets
from . import scribe as scribe
from .creds import CredentialMeta, ScopedToken
from .secrets import SecretKind, SecretMode, SecretRule
from .params import (
    Abort,
    Alias,
    Arg,
    ArgArray,
    ArgFault,
    ArgIssue,
    ArgIssueKind,
    ArgObject,
    Args,
    CommitAborted,
    Ev,
    IncomingParams,
    Interrupt,
    InterruptClosed,
    Interrupted,
    InterruptibleParams,
    InvocationEnded,
    ParamsMisuse,
    ParamsProtocol,
    Repair,
    RepairKind,
    params,
)
from .prompts import (
    PromptContext,
    SlotClass,
    SlotClassConflict,
    UnknownSlot,
    VolatilePrompt,
    prompt_slot,
)
from .context import (
    Anchor,
    CancelCompaction,
    CompactionBusy,
    CompactionEvent,
    CompactionOutcome,
    CompactionRefused,
    CompactionTier,
    CompactionVerdict,
    ContextGone,
    ContextPatch,
    ContextResetEvent,
    ContextUsage,
    ContextView,
    CustomSummary,
    DelegateCompaction,
    DropParts,
    Insert,
    MessageKind,
    MessageRef,
    NoVerdict,
    PatchRejected,
    PinBudgetExceeded,
    Prune,
    Reorder,
    Replace,
    StaleEpoch,
    ToolRef,
)
from .sessions import (
    Bucket,
    SessionAccessDenied,
    SessionError,
    GroupBy,
    SessionFilter,
    SessionInfo,
    SessionKind,
    SessionLink,
    SessionNode,
    SessionNotFound,
    SessionSetup,
    SessionStatus,
    SessionTransitionDenied,
    SessionTransitionIndeterminate,
    TitleSource,
    Usage,
    UsageAccuracy,
    UsageBucket,
    UsageQuery,
    UsageReport,
)
from .telemetry import ModelRequest, PromptFingerprint, TelemetryError
renderer = ui.renderer
message_renderer = ui.message_renderer
markdown_transformer = ui.markdown_transformer
command = ui.command
shortcut = ui.shortcut
DuplicateRenderer = ui.DuplicateRenderer
MessageView = ui.MessageView
from .urls import (
    Scheme,
    SchemeInfo,
    SchemeNotReadable,
    Selector,
    SelectorError,
    Url,
    UrlError,
    parse,
    parse_selector,
    schemes,
)
from ._registry import (
    DeclarationDrift,
    DeviceDefinition as _DeviceDefinition,
    PreludeDefinition as _PreludeDefinition,
    PreludeParamSpec as _PreludeParamSpec,
    DeclarationRegistry,
    MAX_DECLARATIONS,
    DeclarationSnapshot,
    QuotaStatus,
    ResourceReceipt,
    ServiceClient,
    ServiceDefinition,
    Services,
    resources,
    service,
    services,
    skill,
    registry as _declarations,
)
from .placement import (
    BoundaryError,
    MAX_WORKERS,
    Place,
    PlaceKind,
    Restart,
    ShipError,
    Site,
    SiteKind,
    Spill,
    WorkerHandle,
    WorkerInfo,
    WorkerResources,
    WorkerSpec,
    WorkerState,
    WorkerEvicted,
    WorkerUnavailable,
    worker_state,
    workers,
)
from .policy import (
    APPROVAL_DEADLINE,
    Access,
    Amend,
    AndOrOp,
    approver,
    ApprovalDecision,
    ApprovalSource,
    ApprovalTicket,
    BASH_IR_MAX_DEPTH,
    BASH_IR_MAX_NODES,
    BASH_IR_MAX_SOURCE,
    BASH_IR_REV,
    BashAndOrList,
    BashArg,
    BashAssignment,
    BashCommandIR,
    BashCompound,
    BashFunctionDef,
    BashIR,
    BashNode,
    BashPipeline,
    BashRedirect,
    BashTestExpr,
    CompoundKind,
    DnsPolicy,
    DomainRule,
    Dynamism,
    EnforcementUnavailable,
    ExecPolicy,
    FilesystemGrade,
    FilesystemPolicy,
    HereDoc,
    NetDirection,
    NetKind,
    NetRef,
    NetworkGrade,
    NetworkMode,
    NetworkPolicy,
    OpaqueEvaluator,
    OpaqueReason,
    POLICY_DEADLINE,
    ParseError,
    ParseFailure,
    PathOrigin,
    PathRef,
    PathRule,
    PolicyDenied,
    PolicyError,
    ProcessGrade,
    ProcessSubDirection,
    ProcessSubIR,
    ProfileHandle,
    ProfileRejected,
    ProfileWidened,
    Quoting,
    RedirectOp,
    RedirectTarget,
    ResourceBudget,
    RuleEffect,
    RuleRef,
    SandboxBackend,
    SandboxCapabilities,
    SandboxEnforcement,
    SandboxMode,
    SandboxProfile,
    SandboxRequest,
    Separator,
    SandboxSessionKind,
    Span,
    TicketState,
    Tier,
    tier_of,
    VIOLATION_COALESCE,
    Violation,
    ViolationKind,
)
from .devices import (
    Availability,
    AvailabilityDelta,
    ConstraintFallback,
    ConstraintKind,
    Devices,
    Device,
    DeviceError,
    DeviceInfo,
    DeviceNameError,
    DeviceUnavailable,
    DocEffects,
    DocsBudgetError,
    DocsMode,
    DynamicDeviceParent,
    EXTERNAL_SUMMARY_CAP,
    HARD_SLOT_BUDGET,
    Effects,
    Example,
    ExecEffects,
    GrammarSyntax,
    InferenceEffects,
    MountSpec,
    PER_DEVICE_CAP,
    Precedence,
    PrecedenceConflict,
    Router,
    SchemaError,
    ToolPath,
    ToolConstraint,
    devices,
    router,
)
from .provider import (
    AccountScope,
    Api,
    AudioFormat,
    AuthMode,
    AuthSpec,
    CacheRetention,
    Cap,
    CatalogAlias,
    ChatCaps,
    CodecProfile,
    CompatFlags,
    Completion,
    ContextSpec,
    Cost,
    CostTier,
    Cursor,
    Credential,
    CredentialKind,
    CredentialSource,
    Dimensions,
    DiscoveryDefaults,
    DiscoveryKind,
    DiscoveryPage,
    DiscoveryQuery,
    DiscoverySpec,
    EmulationPolicy,
    ErrorKind,
    Facet,
    Failover,
    FailoverKind,
    Fallback,
    Effort,
    HostedTool,
    ImageCaps,
    ImageFeature,
    ImageFormat,
    ImageRequest,
    ImageResult,
    SpeechCaps,
    SpeechFeature,
    SpeechRequest,
    SpeechResult,
    StreamWatchdog,
    LoginRequest,
    LogprobCaps,
    ManagementSpec,
    MismatchPolicy,
    Modality,
    ModelCard,
    ModelEvent,
    ModelOverlay,
    ModelPatch,
    ModelSpec,
    NegotiationPolicy,
    OAuthFlow,
    OAuthFlowKind,
    Intent,
    IntentKind,
    intent,
    ModelFallback,
    ModelRef,
    OAuthSpec,
    Pagination,
    Operation,
    Price,
    PriceUnit,
    PrincipalResolution,
    PromptCacheCaps,
    ProviderSpec,
    ProviderHandle,
    ReasoningCaps,
    RealtimeCaps,
    RealtimeCredentialRef,
    RealtimeEagerness,
    RealtimeEndpointRef,
    RealtimeFeature,
    RealtimeModality,
    RealtimeRequest,
    RealtimeSession,
    RealtimeTurnDetectionMode,
    RefreshBehavior,
    RefreshReason,
    RefreshRequest,
    ProviderError,
    Retryability,
    Role,
    RedirectTrust,
    RouteLimits,
    RouteRef,
    RouteSpec,
    ScopedAlias,
    ServerStateCaps,
    ServiceTier,
    Setting,
    SettingKind,
    SignRequest,
    TranscriptionCaps,
    TranscriptionFeature,
    TranscriptionRequest,
    TranscriptionResult,
    ThinkingMode,
    ThinkingSpec,
    TokenPlacement,
    TurnDetection,
    ToolCaps,
    ToolFeature,
    ToolSchemaFlavor,
    Transport,
    TrustDomain,
    UnknownCapabilityPolicy,
    WatchModels,
    intents,
    models,
    watch_models,
)
from . import hooks as hooks
from .hooks import *
from . import extensions as extensions
from .extensions import *
from . import events as events
from .events import *
# Hooks and policy document the same top-level approval deadline; policy owns
# the assembled policy vocabulary.
APPROVAL_DEADLINE = policy.APPROVAL_DEADLINE


from . import index as index
from . import packages as packages
from .diagnostics import DiagnosticCode, FailureCode, WarningCode
from .packages import (
    ContentDeclaration,
    ContentKind,
    Distribution,
    GrantError,
    IntegrityError,
    Origin,
    PackageError,
    Provenance,
    ResolutionError,
    SettingSchema,
    SiteTree,
)


_DEVICE_NAME_PATTERN = _re.compile(r"^[a-z][a-z0-9_]{0,63}$")
_PRELUDE_PARAM_NAME_PATTERN = _re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
_RESERVED_DEVICE_NAMES = frozenset(
    {"resolve", "reject", "propose", "report_issue"}
)


def device(
    name: str | None = None,
    *,
    family: str = "",
    rev: int = 1,
    place: str | Place = "host",
    summary: str | None = None,
    docs: str | _os.PathLike[str] | None = None,
    schema: type | dict[str, object] | None = None,
    examples: _Sequence[Example] = (),
    available: _Callable[[], bool | Availability] | None = None,
    precedence: int = Precedence.DEFAULT,
    replaces: str | None = None,
    intents: _Sequence[Intent] = (),
    effects: Effects | None = None,
    tier: Tier = Tier.WRITE,
    deadline: Duration | None = None,
    aliases: _Mapping[str, str] | None = None,
    constraint: ToolConstraint | None = None,
    serial: bool = False,
) -> _Callable[[_Any], Device]:
    """Declare a device while deferring its availability predicate to FREEZE."""
    parsed_place = Place.parse(place)
    if not isinstance(rev, int) or isinstance(rev, bool):
        raise TypeError("device rev must be int")
    if not isinstance(precedence, int) or isinstance(precedence, bool):
        raise TypeError("device precedence must be int")
    if precedence >= Precedence.CORE:
        raise DeviceNameError(
            f"device precedence must be below Precedence.CORE: {precedence}"
        )
    if schema is not None and not isinstance(schema, (type, dict)):
        raise SchemaError("device schema must be a type, dict, or None")
    if available is not None and not callable(available):
        raise SchemaError("device available predicate must be callable")
    if constraint is not None and not isinstance(constraint, ToolConstraint):
        raise SchemaError("device constraint must be ToolConstraint or None")
    if not isinstance(serial, bool):
        raise TypeError("device serial must be bool")

    frozen_examples = tuple(examples)
    if any(not isinstance(example, Example) for example in frozen_examples):
        raise SchemaError("device examples must contain only Example values")

    frozen_aliases: _Mapping[str, str] | None = None
    if aliases is not None:
        if not isinstance(aliases, _Mapping):
            raise SchemaError("device aliases must be a mapping")
        seen_aliases: set[str] = set()
        alias_items: list[tuple[str, str]] = []
        for alias, target in aliases.items():
            if not isinstance(alias, str) or not isinstance(target, str):
                raise SchemaError("device aliases must map strings to strings")
            if alias in seen_aliases:
                raise SchemaError(f"duplicate device alias {alias!r}")
            if alias == target:
                raise SchemaError(f"device alias {alias!r} cannot map to itself")
            seen_aliases.add(alias)
            alias_items.append((alias, target))
        frozen_aliases = _MappingProxyType(dict(alias_items))

    frozen_intents = tuple(intents)

    def decorate(body: _Any) -> Device:
        if not callable(body):
            raise TypeError("@omp.device may decorate only a callable")
        resolved_name = (
            getattr(body, "__name__", "").lstrip("_") if name is None else name
        )
        if (
            not isinstance(resolved_name, str)
            or _DEVICE_NAME_PATTERN.fullmatch(resolved_name) is None
        ):
            raise DeviceNameError(f"invalid device name {resolved_name!r}")
        if resolved_name in _RESERVED_DEVICE_NAMES:
            raise DeviceNameError(f"reserved device name {resolved_name!r}")


        handle = Device(
            name=resolved_name,
            family=family,
            rev=rev,
            place=parsed_place,
            precedence=precedence,
            replaces=replaces,
            schema=schema,
            docs=docs,
            summary=summary,
            body=body,
        )
        definition = _DeviceDefinition(
            name=resolved_name,
            family=family,
            rev=rev,
            place=parsed_place,
            summary=summary,
            docs=docs,
            schema=schema,
            examples=frozen_examples,
            available=available,
            precedence=precedence,
            replaces=replaces,
            intents=frozen_intents,
            effects=effects,
            tier=tier,
            deadline=deadline,
            aliases=frozen_aliases,
            constraint=constraint,
            serial=serial,
            body=body,
        )
        try:
            body.__omp_place__ = parsed_place
        except (AttributeError, TypeError):
            pass
        _declarations.register_tool(
            resolved_name,
            family,
            rev,
            handle,
            definition=definition,
        )
        return handle

    return decorate


def tool(
    name: str | _Callable[..., _Any] | None = None,
    *,
    kind: str = "soft",
    effects: Effects | None = None,
    tier: Tier | None = None,
    rev: int = 1,
    constraint: ToolConstraint | None = None,
    serial: bool = False,
) -> _Callable[[_Callable[..., _Any]], Device] | Device:
    """Declare an ergonomic host leaf on the existing device registry path."""
    if kind not in {"soft", "hard"}:
        raise ValueError("tool kind must be 'soft' or 'hard'")
    if not isinstance(rev, int) or isinstance(rev, bool):
        raise TypeError("tool rev must be int")
    if constraint is not None and not isinstance(constraint, ToolConstraint):
        raise SchemaError("tool constraint must be ToolConstraint or None")
    if not isinstance(serial, bool):
        raise TypeError("tool serial must be bool")

    def decorate(function: _Any) -> Device:
        tool_name = function.__name__ if name is None or callable(name) else name
        function.__omp_place__ = Place.HOST
        function.__omp_tool_kind__ = kind
        function.__omp_effects__ = effects
        function.__omp_tier__ = tier
        return device(
            tool_name,
            family=_declarations.extension_id or "",
            rev=rev,
            effects=effects,
            tier=Tier.WRITE if tier is None else tier,
            constraint=constraint,
            serial=serial,
        )(function)

    if callable(name):
        return decorate(name)
    return decorate


def prelude(
    name: str | _Callable[..., _Any] | None = None,
    *,
    rev: int = 1,
    summary: str | None = None,
) -> _Callable[[_Callable[..., _Any]], _Callable[..., _Any]] | _Callable[..., _Any]:
    """Declare a documented synchronous helper in every eval namespace."""
    if not isinstance(rev, int) or isinstance(rev, bool):
        raise TypeError("prelude rev must be int")
    if not 1 <= rev <= 65_535:
        raise ValueError("prelude rev must be a positive unsigned 16-bit integer")
    if summary is not None and not isinstance(summary, str):
        raise TypeError("prelude summary must be str or None")

    def decorate(function: _Any) -> _Callable[..., _Any]:
        if not callable(function):
            raise TypeError("@omp.prelude may decorate only a callable")
        resolved_name = (
            function.__name__ if name is None or callable(name) else name
        )
        if (
            not isinstance(resolved_name, str)
            or _DEVICE_NAME_PATTERN.fullmatch(resolved_name) is None
        ):
            raise DeviceNameError(f"invalid prelude name {resolved_name!r}")
        if resolved_name in _RESERVED_DEVICE_NAMES or _keyword.iskeyword(
            resolved_name
        ):
            raise DeviceNameError(f"reserved prelude name {resolved_name!r}")

        params: list[_PreludeParamSpec] = []
        for parameter in _inspect.signature(function).parameters.values():
            if (
                _PRELUDE_PARAM_NAME_PATTERN.fullmatch(parameter.name) is None
                or _keyword.iskeyword(parameter.name)
            ):
                raise SchemaError(
                    f"prelude parameter {parameter.name!r} has an invalid name"
                )
            if parameter.kind is _inspect.Parameter.POSITIONAL_OR_KEYWORD:
                kind = "positional_or_keyword"
            elif parameter.kind is _inspect.Parameter.KEYWORD_ONLY:
                kind = "keyword_only"
            else:
                raise SchemaError(
                    f"prelude parameter {parameter.name!r} has unsupported "
                    f"kind {parameter.kind.name}"
                )
            default_json: str | None = None
            if parameter.default is not _inspect.Parameter.empty:
                try:
                    default_json = _json.dumps(parameter.default, allow_nan=False)
                except (TypeError, ValueError) as error:
                    raise SchemaError(
                        f"prelude parameter {parameter.name!r} has a non-JSON default"
                    ) from error
            annotation = (
                None
                if parameter.annotation is _inspect.Parameter.empty
                else _inspect.formatannotation(parameter.annotation)
            )
            params.append(
                _PreludeParamSpec(
                    name=parameter.name,
                    kind=kind,
                    default_json=default_json,
                    annotation=annotation,
                )
            )

        doc = _inspect.getdoc(function) or ""
        resolved_summary = summary or (doc.splitlines()[0] if doc else "")

        def _handler(arguments: _Mapping[str, object]) -> object:
            return function(**arguments)

        _declarations.register_prelude(
            _PreludeDefinition(
                name=resolved_name,
                rev=rev,
                doc=doc,
                summary=resolved_summary,
                params=tuple(params),
                body=function,
                handler=_handler,
                module=function.__module__.split(".")[0],
            )
        )
        return function

    if callable(name):
        return decorate(name)
    return decorate


urls._bind_scheme_source(_scheme_snapshot)

RUNTIME_METADATA = _runtime_metadata()
PHASE_LEGALITY_MATRIX = _phase_legality_matrix()


def _attach_generated_metadata() -> None:
    namespace = globals()
    for public_name, metadata in RUNTIME_METADATA.items():
        parts = public_name.split(".")
        if not parts or parts[0] != "omp":
            continue
        target: _Any = namespace.get(parts[1])
        for part in parts[2:]:
            if target is None:
                break
            target = getattr(target, part, None)
        if target is None:
            continue
        target = getattr(target, "__func__", target)
        try:
            target.__omp_symbol__ = public_name
            target.__operation_spec__ = metadata["operation"]
            target.__signature_text__ = metadata["signature"]
            target.__examples__ = tuple(metadata["examples"])
            target.__owner__ = metadata["owner"]
        except (AttributeError, TypeError):
            # Native immutable classes expose metadata through RUNTIME_METADATA.
            pass


_attach_generated_metadata()
del _attach_generated_metadata



__all__ = (
    "ActivateReason",
    "AgentUrl",
    "ApiLevelError",
    "ArtifactUrl",
    "AbortKind",
    "Aborted",
    "ArgsRejected",
    "ArtifactCorrupt",
    "ArtifactError",
    "ArtifactLifetime",
    "ArtifactNotFound",
    "ArtifactNotText",
    "ArtifactReader",
    "ArtifactRef",
    "ArtifactStat",
    "ArtifactWriter",
    "Authority",
    "BlobRef",
    "CancelledError",
    "CapabilityError",
    "CANCEL_GRACE",
    "ClientPath",
    "CostClass",
    "Coerce",
    "DeadlineExceeded",
    "DeclarationDrift",
    "DeclarationLimit",
    "DeclarationRegistry",
    "DeclarationSealed",
    "DeclarationSnapshot",
    "DuplicateRegistration",
    "Durability",
    "Duration",
    "EffectsNotAuthorized",
    "EnvPath",
    "ExtensionError",
    "EnvUnavailable",
    "EntryId",
    "CallOutcome",
    "BlobPart",
    "Budget",
    "Context",
    "Field",
    "Fault",
    "Bucket",
    "AccountScope",
    "Api",
    "AudioFormat",
    "AuthMode",
    "AuthSpec",
    "Availability",
    "AvailabilityDelta",
    "ConstraintFallback",
    "ConstraintKind",
    "CacheRetention",
    "Cap",
    "CatalogAlias",
    "ChatCaps",
    "CodecProfile",
    "CompatFlags",
    "Completion",
    "ContextSpec",
    "Cost",
    "CostTier",
    "Cursor",
    "Credential",
    "CredentialKind",
    "CredentialMeta",
    "CredentialSource",
    "Dimensions",
    "DiscoveryDefaults",
    "DiscoveryKind",
    "DiscoveryPage",
    "DiscoveryQuery",
    "DiscoverySpec",
    "EmulationPolicy",
    "Device",
    "DeviceError",
    "DeviceInfo",
    "DeviceNameError",
    "DeviceUnavailable",
    "DocEffects",
    "DocsBudgetError",
    "DocsMode",
    "DynamicDeviceParent",
    "Effects",
    "HARD_SLOT_BUDGET",
    "Example",
    "ExecEffects",
    "GrammarSyntax",
    "Effort",
    "Facet",
    "HostedTool",
    "ImageCaps",
    "ImageFeature",
    "ImageFormat",
    "ImageRequest",
    "ImageResult",
    "SpeechCaps",
    "SpeechFeature",
    "SpeechRequest",
    "SpeechResult",
    "LoginRequest",
    "LogprobCaps",
    "InferenceEffects",
    "ManagementSpec",
    "MismatchPolicy",
    "Modality",
    "ModelCard",
    "ModelEvent",
    "ModelOverlay",
    "ModelPatch",
    "ModelSpec",
    "MountSpec",
    "NegotiationPolicy",
    "OAuthFlow",
    "OAuthFlowKind",
    "OAuthSpec",
    "Operation",
    "Pagination",
    "Price",
    "PriceUnit",
    "PrincipalResolution",
    "Precedence",
    "PrecedenceConflict",
    "PromptCacheCaps",
    "ProviderSpec",
    "ProviderHandle",
    "ReasoningCaps",
    "RealtimeCaps",
    "RealtimeCredentialRef",
    "RealtimeEagerness",
    "RealtimeEndpointRef",
    "RealtimeFeature",
    "RealtimeModality",
    "RealtimeRequest",
    "RealtimeSession",
    "RealtimeTurnDetectionMode",
    "RefreshBehavior",
    "RefreshReason",
    "RefreshRequest",
    "RedirectTrust",
    "RouteLimits",
    "RouteSpec",
    "Router",
    "ScopedAlias",
    "SchemaError",
    "ServerStateCaps",
    "ServiceTier",
    "Setting",
    "SettingKind",
    "SignRequest",
    "SpecError",
    "TranscriptionCaps",
    "TranscriptionFeature",
    "TranscriptionRequest",
    "TranscriptionResult",
    "ThinkingMode",
    "ThinkingSpec",
    "TokenPlacement",
    "TurnDetection",
    "ToolCaps",
    "ToolFeature",
    "ToolSchemaFlavor",
    "ToolPath",
    "ToolConstraint",
    "Transport",
    "TrustDomain",
    "UnknownCapabilityPolicy",
    "GroupBy",
    "Dialect",
    "Done",
    "Detached",
    "Faulted",
    "FrameTooLarge",
    "HEALTH_TIMEOUT",
    "HistoryUrl",
    "HostDisconnected",
    "JournalEntry",
    "JournalError",
    "JobRef",
    "InvocationPhase",
    "PHASE_LEGALITY_MATRIX",
    "LifecyclePhase",
    "ManifestError",
    "JsonPart",
    "LiftedCall",
    "ModelClass",
    "NotWiredError",
    "PromptContext",
    "PromptFingerprint",
    "Ok",
    "OmpError",
    "OperationSpec",
    "MAX_DECLARATIONS",
    "MAX_FRAME_BYTES",
    "PlacementError",
    "Principal",
    "QuotaExceeded",
    "RUNTIME_METADATA",
    "RestartReason",
    "Scheme",
    "SchemeInfo",
    "SHUTDOWN_GRACE",
    "Secret",
    "SecretKind",
    "SecretMode",
    "SecretRule",
    "WarningCode",
    "index",
    "packages",
)
__all__ += (
    "Access",
    "Amend",
    "Anchor",
    "AndOrOp",
    "ApprovalDecision",
    "ApprovalSource",
    "ApprovalTicket",
    "BASH_IR_MAX_DEPTH",
    "BASH_IR_MAX_NODES",
    "BASH_IR_MAX_SOURCE",
    "BASH_IR_REV",
    "BashAndOrList",
    "BashArg",
    "BashAssignment",
    "BashCommandIR",
    "BashCompound",
    "BashFunctionDef",
    "BashIR",
    "BashNode",
    "BashPipeline",
    "BashRedirect",
    "BashTestExpr",
    "CancelCompaction",
    "CompactionBusy",
    "CompactionEvent",
    "CompactionOutcome",
    "CompactionRefused",
    "CompactionTier",
    "CompactionVerdict",
    "CompoundKind",
    "ContextGone",
    "ContextPatch",
    "ContextResetEvent",
    "ContextUsage",
    "ContextView",
    "CustomSummary",
    "DelegateCompaction",
    "Devices",
    "DnsPolicy",
    "DropParts",
    "DomainRule",
    "Dynamism",
    "EXTERNAL_SUMMARY_CAP",
    "EnforcementUnavailable",
    "ErrorKind",
    "ExecPolicy",
    "Failover",
    "FailoverKind",
    "Fallback",
    "FilesystemGrade",
    "FilesystemPolicy",
    "HereDoc",
    "Insert",
    "Intent",
    "IntentKind",
    "MessageKind",
    "MessageRef",
    "ModelFallback",
    "ModelRef",
    "NetDirection",
    "NetKind",
    "NetRef",
    "NetworkGrade",
    "NetworkMode",
    "NetworkPolicy",
    "NoVerdict",
    "OpaqueEvaluator",
    "OpaqueReason",
    "PER_DEVICE_CAP",
    "POLICY_DEADLINE",
    "ParseError",
    "ParseFailure",
    "PatchRejected",
    "PathOrigin",
    "PathRef",
    "PathRule",
    "PermissionDenied",
    "PinBudgetExceeded",
    "PolicyDenied",
    "PolicyError",
    "ProcessGrade",
    "ProcessSubDirection",
    "ProcessSubIR",
    "ProfileHandle",
    "ProfileRejected",
    "ProfileWidened",
    "ProviderError",
    "Prune",
    "Quoting",
    "RedirectOp",
    "RedirectTarget",
    "Reorder",
    "Replace",
    "ResourceBudget",
    "Retryability",
    "Role",
    "RouteRef",
    "RuleEffect",
    "RuleRef",
    "SandboxBackend",
    "SandboxCapabilities",
    "SandboxEnforcement",
    "SandboxMode",
    "SandboxProfile",
    "SandboxRequest",
    "SandboxSessionKind",
    "Separator",
    "SettingSchema",
    "Span",
    "StaleEpoch",
    "TicketState",
    "Tier",
    "ToolRef",
    "Trust",
    "VIOLATION_COALESCE",
    "Violation",
    "ViolationKind",
    "context",
    "convars",
    "limits",
    "policy",
)
__all__ += (
    "ACTIVATION_TIMEOUT",
    "API_LEVEL",
    "API_LEVELS",
    "Abort",
    "Alias",
    "Arg",
    "ArgArray",
    "ArgFault",
    "ArgIssue",
    "ArgIssueKind",
    "ArgObject",
    "Args",
    "BudgetError",
    "Capability",
    "CommitAborted",
    "DOCS_TOTAL_BUDGET",
    "EntryAccessDenied",
    "EntryTooLarge",
    "EntryUndecodable",
    "Ev",
    "HOST_VERSION",
    "HookEntry",
    "IncomingParams",
    "Interrupt",
    "InterruptClosed",
    "Interrupted",
    "InterruptibleParams",
    "InvocationEnded",
    "JournalIndeterminate",
    "Layer",
    "LogLevel",
    "MAX_HOST_CHILDREN",
    "MAX_PENDING_EFFECTS",
    "Manifest",
    "ModelRequest",
    "PING_INTERVAL",
    "PYTHON_REV",
    "ParamsMisuse",
    "ParamsProtocol",
    "Postcondition",
    "PostconditionStatus",
    "Repair",
    "RepairKind",
    "Requires",
    "RevError",
    "SCHEMA_REV",
    "ServiceClient",
    "ServiceDefinition",
    "ServiceEntry",
    "Services",
    "SessionAccessDenied",
    "SessionError",
    "StreamWatchdog",
    "TelemetryError",
    "ToolEntry",
    "VerdictSchemaError",
    "VerdictShapeError",
    "VolatilePrompt",
    "WorkerEvicted",
    "completion",
    "dumps",
    "intents",
    "intent",
    "is_subscribed",
    "loads",
    "manifest",
    "mcp",
    "params",
    "prelude",
    "require",
    "resources",
    "restart_reason",
    "service",
    "services",
    "skill",
    "tier_of",
)
__all__ += (
    hooks.__all__
    + extensions.__all__
    + events.__all__
    + ("hooks", "extensions", "events")
)
