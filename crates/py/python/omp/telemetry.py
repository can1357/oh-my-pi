"""Frozen telemetry subscriptions, event views, and extension instruments."""

from __future__ import annotations

import sys
import warnings
from collections.abc import Callable, Hashable, Iterator, Mapping, Sequence
from contextvars import ContextVar
from dataclasses import dataclass, field
from dataclasses import fields as dataclass_fields
from dataclasses import is_dataclass
from datetime import datetime, timedelta
from enum import Enum, StrEnum
from types import MappingProxyType, ModuleType
from typing import Any, Final

from _omp import ArtifactUrl, Duration, EnvPath, OmpError


from ._errors import NotWiredError
from ._verdicts import Rev
from ._registry import ExportDefinition, registry as _declarations
from .placement import Place
from .prompts import SlotClass
from .ui import _emit as _emit_effect

QUEUE_DEFAULT = 4096
QUEUE_MAX: Final[int] = 65_536
"""Maximum supported subscription ring capacity."""
BATCH_MAX = 1024
METRIC_PREFIX = "omp.ext."
MAX_INSTRUMENTS: Final[int] = 256
"""Maximum number of distinct metric instruments an extension may declare."""
MAX_CARDINALITY: Final[int] = 1024
"""Maximum number of distinct attribute series retained per instrument."""
DEFAULT_MAX_BYTES: Final[int] = 51_200
"""Default byte budget for an inline rendered result."""
DEFAULT_MAX_LINES: Final[int] = 3_000
"""Default line budget for an inline rendered result."""
DEFAULT_MAX_COLUMN: Final[int] = 512
"""Default UTF-16 column budget for an inline rendered result."""
QUERY_LIMIT_MAX: Final[int] = 10_000
"""Maximum number of rows one telemetry query may request."""
SPILL_BYTES: Final[int] = DEFAULT_MAX_BYTES
"""Telemetry name for the rendered-result byte spill gate."""
SPILL_LINES: Final[int] = DEFAULT_MAX_LINES
"""Telemetry name for the rendered-result line spill gate."""
SPILL_COLUMN: Final[int] = DEFAULT_MAX_COLUMN
"""Telemetry name for the rendered-result column spill gate."""


class TelemetryError(OmpError):
    """Base class for telemetry declaration, query, and export failures."""


class SubscriptionError(TelemetryError):
    """A telemetry declaration is malformed or duplicates a static key."""


class QueryError(TelemetryError):
    """A telemetry query is malformed or refers to an unknown indexed value."""


class Kind(StrEnum):
    """Core-side telemetry event vocabulary."""

    SESSION_START = "session_start"
    SESSION_END = "session_end"
    TURN_START = "turn_start"
    TURN_END = "turn_end"
    MODEL_REQUEST = "model_request"
    MODEL_ATTEMPT = "model_attempt"
    PROVIDER_ERROR = "provider_error"
    TOOL_CALL = "tool_call"
    CAPABILITY_DEGRADED = "capability_degraded"
    COMPACTION = "compaction"
    BRANCH = "branch"
    ARTIFACT_SPILL = "artifact_spill"
    ISSUE_REPORT = "issue_report"
    HOST_WARNING = "host_warning"


class StopReason(StrEnum):
    """Normalized reason a model response stopped."""

    END_TURN = "end_turn"
    TOOL_USE = "tool_use"
    MAX_TOKENS = "max_tokens"
    CONTENT_FILTER = "content_filter"
    UNSPECIFIED = "unspecified"


class DegradeAction(StrEnum):
    """Describe how the harness handled an unsupported request feature."""

    DROPPED = "dropped"
    EMULATED = "emulated"
    CLAMPED = "clamped"

class Scope(StrEnum):
    """Agent extent visible to a telemetry subscription."""

    SELF = "self"
    TREE = "tree"
    PROJECT = "project"


class Overflow(StrEnum):
    """Bounded-ring behavior when a telemetry sink falls behind."""

    DROP_OLDEST = "drop_oldest"
    DROP_NEWEST = "drop_newest"
    COALESCE_BY_KEY = "coalesce_by_key"


@dataclass(frozen=True, slots=True)
class Tokens:
    """Unabridged token-usage buckets from a settled model request."""

    input: int = 0
    output: int = 0
    cache_read: int = 0
    cache_write: int = 0
    reasoning: int = 0
    total: int = 0
    context: int | None = None
    premium_requests: int = 0
    cache_ttl_5m: int = 0
    cache_ttl_1h: int = 0
    server_web_search: int = 0
    server_web_fetch: int = 0
    orchestration_input: int = 0
    orchestration_output: int = 0
    orchestration_cache_read: int = 0
    detail: Mapping[str, int | float | str] = field(default_factory=dict)

    @property
    def uncached_input(self) -> int:
        """Input tokens not read from or written to a provider cache."""

        return max(0, self.input - self.cache_read - self.cache_write)

    @property
    def cache_hit_rate(self) -> float:
        """Fraction of input tokens served from cache."""

        return self.cache_read / self.input if self.input else 0.0


@dataclass(frozen=True, slots=True)
class PromptSlotFingerprint:
    """Describe one assembler-owned prompt slot contribution."""

    digest: str
    size_bytes: int
    band: SlotClass


@dataclass(frozen=True, slots=True)
class PromptFingerprint:
    """Assembler-owned prompt-prefix and cache-breakpoint facts."""

    digest: str
    slots: Mapping[str, PromptSlotFingerprint]
    changed: tuple[str, ...]
    prefix_stable_bytes: int
    cache_key: str
    retention: str
    mode: str
    ttl: str
    breakpoint: str
    breakpoint_indices: tuple[int, ...]


@dataclass(frozen=True, slots=True)
class Degradation:
    """Describe one requested feature the provider path could not honour."""

    what: str
    detail: str
    action: DegradeAction


@dataclass(frozen=True, slots=True)
class ModelRequest:
    """Frozen subset of a settled model request used by telemetry consumers."""

    seq: int
    usage: Tokens
    prompt: PromptFingerprint
    served_model: str
    latency_ms: int
    ttft_ms: int | None
    degraded: tuple[Degradation, ...]
    kind: Kind = Kind.MODEL_REQUEST
    request_content: bytes | None = None
    response_content: bytes | None = None


@dataclass(frozen=True, slots=True)
class DropStats:
    """Loss and delivery counters for one host-side subscription ring."""

    delivered: int
    dropped: int
    coalesced: int
    errored: int
    replay_skipped: int
    queue_depth: int
    first_drop_seq: int | None
    since_ms: int


def _subscribe(
    kinds: Sequence[Kind | str],
    *,
    scope: Scope = Scope.TREE,
    queue: int = QUEUE_DEFAULT,
    overflow: Overflow = Overflow.DROP_OLDEST,
    coalesce_key: Callable[[object], Hashable] | None = None,
    batch: int | None = None,
    replay: bool = False,
    replay_limit: int = 2048,
):
    """Declare a lossy telemetry sink without opening the CONTROL channel."""

    try:
        parsed_kinds = tuple(Kind(kind) for kind in kinds)
        parsed_scope = Scope(scope)
        parsed_overflow = Overflow(overflow)
    except ValueError as error:
        raise SubscriptionError(str(error)) from error
    if not parsed_kinds:
        raise SubscriptionError("telemetry kinds must not be empty")
    if not 1 <= queue <= QUEUE_MAX:
        raise SubscriptionError(f"telemetry queue must be in 1..={QUEUE_MAX}")
    if batch is not None and not 2 <= batch <= BATCH_MAX:
        raise SubscriptionError(f"telemetry batch must be in 2..={BATCH_MAX}")
    if replay_limit < 1:
        raise SubscriptionError("telemetry replay_limit must be positive")
    if (parsed_overflow is Overflow.COALESCE_BY_KEY) != (coalesce_key is not None):
        raise SubscriptionError("coalesce_key is required only for coalesce_by_key overflow")

    def decorate(function: Any) -> Any:
        if not callable(function):
            raise TypeError("@omp.telemetry may decorate only a callable")
        _declarations.register_telemetry(
            parsed_kinds,
            parsed_scope,
            queue,
            parsed_overflow,
            coalesce_key,
            batch,
            replay,
            replay_limit,
            function,
        )
        qualified_name = (
            f"{getattr(function, '__module__', '')}."
            f"{getattr(function, '__qualname__', '')}"
        )
        _subscription_handlers[qualified_name] = function
        _subscription_batches[qualified_name] = batch is not None
        _subscription_coalesce_keys[qualified_name] = coalesce_key
        _subscription_stats.setdefault(qualified_name, _EMPTY_DROP_STATS)
        return function

    return decorate


_EMPTY_DROP_STATS = DropStats(0, 0, 0, 0, 0, 0, None, 0)
_subscription_handlers: dict[str, Callable[..., object]] = {}
_subscription_batches: dict[str, bool] = {}
_subscription_coalesce_keys: dict[str, Callable[[object], Hashable] | None] = {}
_subscription_stats: dict[str, DropStats] = {}


def _drop_stats(value: object) -> DropStats:
    if isinstance(value, DropStats):
        return value
    if not isinstance(value, Mapping):
        raise TypeError("telemetry drop stats must be a mapping")
    return DropStats(**dict(value))


def _event_from_wire(value: object) -> object:
    """Decode one host telemetry record into its frozen Python event view."""

    if not isinstance(value, Mapping):
        return value
    body = dict(value)
    try:
        kind = Kind(body["kind"])
    except (KeyError, TypeError, ValueError):
        return value
    body["kind"] = kind
    event_type = {
        Kind.SESSION_START: SessionStart,
        Kind.SESSION_END: SessionEnd,
        Kind.TURN_START: TurnStart,
        Kind.TURN_END: TurnEnd,
        Kind.MODEL_REQUEST: ModelRequest,
        Kind.CAPABILITY_DEGRADED: CapabilityDegraded,
        Kind.COMPACTION: Compaction,
        Kind.ISSUE_REPORT: IssueReport,
    }.get(kind)
    if event_type is None:
        if isinstance(body.get("trace"), Mapping):
            body["trace"] = TraceRef(**dict(body["trace"]))
        return Envelope(
            **{
                item.name: body[item.name]
                for item in dataclass_fields(Envelope)
                if item.name in body
            }
        )
    if "trace" in body and isinstance(body["trace"], Mapping):
        body["trace"] = TraceRef(**dict(body["trace"]))
    for name in ("tokens", "usage"):
        if name in body and isinstance(body[name], Mapping):
            body[name] = Tokens(**dict(body[name]))
    if "cost" in body and isinstance(body["cost"], Mapping):
        body["cost"] = Cost(**dict(body["cost"]))
    if "context" in body and isinstance(body["context"], Mapping):
        body["context"] = ContextSnapshot(**dict(body["context"]))
    if "place" in body:
        body["place"] = Place.parse(body["place"])
    if "stop" in body:
        body["stop"] = StopReason(body["stop"])
    if "rev" in body and isinstance(body["rev"], str):
        body["rev"] = Rev.parse(body["rev"])
    if "degraded" in body:
        body["degraded"] = tuple(
            Degradation(
                what=str(item["what"]),
                detail=str(item["detail"]),
                action=DegradeAction(item["action"]),
            )
            if isinstance(item, Mapping)
            else item
            for item in body["degraded"]
        )
    if "extensions" in body:
        body["extensions"] = tuple(
            ExtensionRef(**dict(item)) if isinstance(item, Mapping) else item
            for item in body["extensions"]
        )
    if "prompt" in body and isinstance(body["prompt"], Mapping):
        prompt = dict(body["prompt"])
        if isinstance(prompt.get("slots"), Mapping):
            prompt["slots"] = {
                str(name): (
                    PromptSlotFingerprint(
                        **(dict(item) | {"band": SlotClass(item["band"])})
                    )
                    if isinstance(item, Mapping)
                    else item
                )
                for name, item in prompt["slots"].items()
            }
        body["prompt"] = PromptFingerprint(**prompt)
    for name in (
        "devices",
        "core_tools",
        "tools_used",
        "artifacts_promoted",
        "repairs",
        "labels",
    ):
        if name in body:
            body[name] = tuple(body[name])
    accepted = {item.name for item in dataclass_fields(event_type)}
    return event_type(**{name: item for name, item in body.items() if name in accepted})


async def _dispatch_subscription(
    qualified_name: str,
    event: object,
    ctx: object,
    stats: DropStats | Mapping[str, object] | None = None,
) -> None:
    """Deliver one host-filtered event or batch to its exact declared sink."""

    if ctx is None:
        from . import Context

        ctx = Context.current()
    function = _subscription_handlers.get(qualified_name)
    if function is None:
        raise SubscriptionError(f"unknown telemetry subscription {qualified_name!r}")
    if stats is not None:
        _subscription_stats[qualified_name] = _drop_stats(stats)
    if _subscription_batches[qualified_name]:
        if not isinstance(event, Sequence) or isinstance(
            event, (str, bytes, bytearray, Mapping)
        ):
            raise TypeError("batched telemetry delivery requires a sequence")
        payload: object = tuple(_event_from_wire(item) for item in event)
    else:
        payload = _event_from_wire(event)
    result = function(payload, ctx)
    if hasattr(result, "__await__"):
        await result


def _subscription_coalesce_key(qualified_name: str, event: object) -> Hashable:
    """Evaluate one declared host-side coalescing key against a typed event."""

    function = _subscription_coalesce_keys.get(qualified_name)
    if function is None:
        raise SubscriptionError(
            f"telemetry subscription {qualified_name!r} has no coalescing key"
        )
    key = function(_event_from_wire(event))
    hash(key)
    return key


_instrument_sink: ContextVar[Any | None] = ContextVar(
    "omp_telemetry_instrument_sink", default=None
)
_instruments: dict[str, Counter | Histogram] = {}
_OVERFLOW_ATTRS: Mapping[str, str] = MappingProxyType({"overflow": "true"})


def _install_instrument_sink(sink: Any | None) -> None:
    """Install the host-owned synchronous instrument sink for this context."""

    _instrument_sink.set(sink)


def _instrument_name(name: str) -> str:
    if not name or name.startswith(("omp.", "gen_ai.", "openai.")):
        raise SubscriptionError("instrument names must be nonempty and outside reserved namespaces")
    return name


def _validate_attrs(attrs: Mapping[str, object]) -> None:
    for value in attrs.values():
        if not isinstance(value, (str, int, float, bool)):
            raise TypeError("instrument attribute values must be str, int, float, or bool")


def _bounded_attrs(
    instrument: Counter | Histogram,
    attrs: Mapping[str, object],
) -> Mapping[str, object]:
    series = frozenset(attrs.items())
    if series in instrument._series:
        return attrs
    if len(instrument._series) < MAX_CARDINALITY:
        instrument._series.add(series)
        return attrs
    if not instrument._cardinality_warned:
        instrument._cardinality_warned = True
        message = (
            f"metric {instrument.name!r} exceeded attribute cardinality; "
            'folding new series into overflow="true"'
        )
        _emit_effect(
            "host_warning",
            code="cardinality",
            message=message,
            subject=instrument.name,
        )
        warnings.warn(message, RuntimeWarning, stacklevel=3)
    return _OVERFLOW_ATTRS


class Counter:
    """Extension-owned monotonic counter declaration."""

    __slots__ = ("_cardinality_warned", "_local", "_series", "description", "unit")

    def __init__(self, local: str, unit: str, description: str) -> None:
        self._local = local
        self._series: set[frozenset[tuple[str, object]]] = set()
        self._cardinality_warned = False
        self.unit = unit
        self.description = description

    @property
    def name(self) -> str:
        """Return the fully qualified, reserved-prefix-safe metric name."""

        extension = _declarations.extension_id or "unregistered"
        return f"{METRIC_PREFIX}{extension}.{self._local}"

    def add(self, value: int | float = 1, /, **attrs: str | int | float | bool) -> None:
        """Increment the counter, discarding the value when no exporter is installed."""

        if value < 0:
            raise ValueError("counter increments must be non-negative")
        _validate_attrs(attrs)
        sink = _instrument_sink.get()
        if sink is None:
            return
        sink.add(self.name, value, _bounded_attrs(self, attrs))


class Histogram:
    """Extension-owned histogram declaration."""

    __slots__ = (
        "_cardinality_warned",
        "_local",
        "_series",
        "boundaries",
        "description",
        "unit",
    )

    def __init__(
        self,
        local: str,
        unit: str,
        description: str,
        boundaries: tuple[int | float, ...] | None,
    ) -> None:
        self._local = local
        self._series: set[frozenset[tuple[str, object]]] = set()
        self._cardinality_warned = False
        self.unit = unit
        self.description = description
        self.boundaries = boundaries

    @property
    def name(self) -> str:
        """Return the fully qualified, reserved-prefix-safe metric name."""

        extension = _declarations.extension_id or "unregistered"
        return f"{METRIC_PREFIX}{extension}.{self._local}"

    def record(self, value: int | float, /, **attrs: str | int | float | bool) -> None:
        """Record an observation, discarding it when no exporter is installed."""

        _validate_attrs(attrs)
        sink = _instrument_sink.get()
        if sink is None:
            return
        sink.record(self.name, value, _bounded_attrs(self, attrs))


def counter(name: str, *, unit: str, description: str) -> Counter:
    """Create or return an extension-owned monotonic counter."""

    local = _instrument_name(name)
    existing = _instruments.get(local)
    if existing is not None:
        if (
            not isinstance(existing, Counter)
            or existing.unit != unit
            or existing.description != description
        ):
            raise SubscriptionError(f"conflicting instrument declaration: {local!r}")
        return existing
    if len(_instruments) >= MAX_INSTRUMENTS:
        raise SubscriptionError(
            f"metric instrument quota exceeded: {MAX_INSTRUMENTS}"
        )
    instrument = Counter(local, unit, description)
    _instruments[local] = instrument
    return instrument


def histogram(
    name: str,
    *,
    unit: str,
    description: str,
    boundaries: Sequence[int | float] | None = None,
) -> Histogram:
    """Create or return an extension-owned histogram."""

    local = _instrument_name(name)
    parsed_boundaries = tuple(boundaries) if boundaries is not None else None
    if parsed_boundaries is not None and any(
        a >= b for a, b in zip(parsed_boundaries, parsed_boundaries[1:])
    ):
        raise ValueError("histogram boundaries must be strictly increasing")
    existing = _instruments.get(local)
    if existing is not None:
        if (
            not isinstance(existing, Histogram)
            or existing.unit != unit
            or existing.description != description
            or existing.boundaries != parsed_boundaries
        ):
            raise SubscriptionError(f"conflicting instrument declaration: {local!r}")
        return existing
    if len(_instruments) >= MAX_INSTRUMENTS:
        raise SubscriptionError(
            f"metric instrument quota exceeded: {MAX_INSTRUMENTS}"
        )
    instrument = Histogram(local, unit, description, parsed_boundaries)
    _instruments[local] = instrument
    return instrument


class ExportError(TelemetryError):
    """An export target declaration is malformed."""


@dataclass(frozen=True, slots=True)
class ExportTarget:
    """Base class for declarative telemetry export targets."""


_EMPTY_MAP: Mapping[str, Any] = MappingProxyType({})


@dataclass(frozen=True, slots=True)
class OtlpTarget(ExportTarget):
    """An OpenTelemetry Protocol export target."""

    endpoint: str
    protocol: str = "http/protobuf"
    headers: Mapping[str, str] = field(default_factory=lambda: _EMPTY_MAP)
    signals: Sequence[str] = ("traces", "metrics", "logs")
    resource_attributes: Mapping[str, str] = field(default_factory=lambda: _EMPTY_MAP)
    timeout: Duration = Duration("10s")
    compression: str | None = "gzip"


@dataclass(frozen=True, slots=True)
class ProcessTarget(ExportTarget):
    """An Environment-supervised process export target."""

    process: str
    framing: str = "jsonl"
    flush_every: Duration = Duration("1s")
    handshake: Mapping[str, object] | None = None


@dataclass(frozen=True, slots=True)
class FileTarget(ExportTarget):
    """An Environment-file export target."""

    path: EnvPath
    framing: str = "jsonl"
    rotate_bytes: int = 64 * 1024 * 1024
    keep: int = 4


@dataclass(frozen=True, slots=True)
class ExportStats:
    """Delivery statistics for one registered export target."""

    sent: int = 0
    dropped: int = 0
    failures: int = 0
    queue_depth: int = 0
    last_flush_ms: int = 0
    last_error: str | None = None
    backoff_ms: int = 0


class ExportHandle:
    """Live handle for a declaratively registered export target."""

    __slots__ = ("_id", "_target")

    def __init__(self, export_id: int, target: ExportTarget) -> None:
        self._id = export_id
        self._target = target

    @property
    def target(self) -> ExportTarget:
        """Return the registered target."""

        return self._target

    async def stop(self) -> None:
        """Stop this export target after a final flush."""

        from . import _control_backend, _control_request

        if _control_backend.get() is None:
            raise NotWiredError("omp.telemetry.ExportHandle.stop")
        await _control_request(
            "omp.telemetry.export.stop", export_id=self._id
        )

    async def stats(self) -> ExportStats:
        """Return current delivery statistics for this export target."""

        from . import _control_backend, _control_request

        if _control_backend.get() is None:
            raise NotWiredError("omp.telemetry.ExportHandle.stats")
        result = await _control_request(
            "omp.telemetry.export.stats", export_id=self._id
        )
        if isinstance(result, ExportStats):
            return result
        if not isinstance(result, Mapping):
            raise TypeError("omp.telemetry.export.stats returned invalid statistics")
        return ExportStats(**dict(result))


def export(
    target: ExportTarget,
    *,
    kinds: Sequence[Kind | str] = (),
    sample: float = 1.0,
) -> ExportHandle:
    """Register a host-owned telemetry export target."""

    if not isinstance(target, ExportTarget):
        raise ExportError("target must be an ExportTarget")
    try:
        parsed_kinds = tuple(Kind(kind) for kind in kinds)
    except ValueError as error:
        raise ExportError(str(error)) from error
    if not 0.0 <= sample <= 1.0:
        raise ExportError("sample must be in 0.0..=1.0")
    if isinstance(target, OtlpTarget) and target.protocol != "http/protobuf":
        raise ExportError("unsupported OTLP protocol")
    if isinstance(target, (ProcessTarget, FileTarget)) and target.framing not in {
        "jsonl",
        "lenprefix",
    }:
        raise ExportError("unsupported export framing")
    definition = ExportDefinition(
        target=target,
        kinds=tuple(kind.value for kind in parsed_kinds),
        sample=sample,
    )
    _declarations.register_export(definition)
    return ExportHandle(len(_declarations.export_definitions()) - 1, target)


async def flush(*, timeout: Duration = Duration("10s")) -> bool:
    """Force every registered export target to flush."""

    from . import _control_backend, _control_request

    if not isinstance(timeout, Duration):
        raise TypeError("timeout must be omp.Duration")
    if _control_backend.get() is None:
        raise NotWiredError("omp.telemetry.flush")
    try:
        result = await _control_request("omp.telemetry.flush", timeout=str(timeout))
    except Exception:
        return False
    return result is True


def dropped(sink: object | None = None) -> DropStats | Mapping[str, DropStats]:
    """Read host-side loss counters for one or all subscriptions."""

    if sink is None:
        return MappingProxyType(dict(_subscription_stats))
    qualified_name = (
        f"{getattr(sink, '__module__', '')}.{getattr(sink, '__qualname__', '')}"
    )
    return _subscription_stats.get(qualified_name, _EMPTY_DROP_STATS)


@dataclass(frozen=True, slots=True)
class Cost:
    """Represent settled telemetry cost in exact nano-USD."""

    nanos_usd: int
    estimated: bool
    input_nanos_usd: int | None
    output_nanos_usd: int | None
    cache_read_nanos_usd: int | None
    cache_write_nanos_usd: int | None
    unavailable_reason: str | None

    @property
    def usd(self) -> float:
        """Return the total cost in USD for display."""

        return self.nanos_usd / 1_000_000_000


@dataclass(frozen=True, slots=True)
class ContextSnapshot:
    """Capture context-window occupancy at a telemetry boundary."""

    prompt_tokens: int
    non_message_tokens: int
    history_rewrite_tokens_removed: int
    last_message_at_ms: int | None
    window: int
    percent: float


@dataclass(frozen=True, slots=True)
class TraceRef:
    """Identify the OpenTelemetry span under which an event was emitted."""

    trace_id: str
    span_id: str
    sampled: bool


@dataclass(frozen=True, slots=True)
class ExtensionRef:
    """Attribute a telemetry record to one exact installed extension build."""

    publisher: str
    id: str
    version: str
    digest: str
    layer: str
    trust: str
    generation: int


@dataclass(frozen=True, slots=True)
class Envelope:
    """Carry the common identity, ordering, and trace prefix of every event."""

    kind: Kind
    seq: int
    at_ms: int
    session: str
    agent: str
    depth: int
    conversation: str
    trace: TraceRef | None
    principal: str
    generation: int


@dataclass(frozen=True, slots=True)
class SessionStart(Envelope):
    """Describe a session opening or resuming."""

    resumed: bool
    parent: str | None
    cwd: EnvPath
    place: Place
    remote: str | None
    model: str
    provider: str
    devices: tuple[str, ...]
    core_tools: tuple[str, ...]
    extensions: tuple[ExtensionRef, ...]
    schema_rev: str
    prompt: PromptFingerprint
    registry_hash: str


@dataclass(frozen=True, slots=True)
class SessionEnd(Envelope):
    """Describe final lifetime totals for a settled session."""

    reason: str
    turns: int
    requests: int
    calls: int
    tokens: Tokens
    cost: Cost | None
    wall_ms: int
    faults: int
    issues: int


@dataclass(frozen=True, slots=True)
class TurnStart(Envelope):
    """Describe the input shape and route selected for a new turn."""

    turn: int
    trigger: str
    input_chars: int
    input_parts: int
    attachments: int
    model: str
    effort: str | None


@dataclass(frozen=True, slots=True)
class TurnEnd(Envelope):
    """Describe the settled usage, latency, and outcome of one turn."""

    turn: int
    steps: int
    requests: int
    calls: int
    tokens: Tokens
    cost: Cost | None
    latency_ms: int
    stop: StopReason
    tools_used: tuple[str, ...]
    faults: int
    interrupted: bool
    context: ContextSnapshot


@dataclass(frozen=True, slots=True)
class CapabilityDegraded(Envelope):
    """Record how a provider constraint budget treated one declared intent."""

    intent: str
    tool: str | None
    rev: Rev | None
    requested_priority: int
    granted: bool
    reason: str
    provider: str
    budget_used: int
    budget_total: int


@dataclass(frozen=True, slots=True)
class Compaction(Envelope):
    """Measure one settled context-compaction attempt."""

    reason: str
    strategy: str
    by: str | None
    tokens_before: int
    tokens_after: int
    items_before: int
    items_after: int
    prompt_text_dropped_bytes: int
    outcomes_kept: int
    artifacts_promoted: tuple[ArtifactUrl, ...]
    duration_ms: int
    aborted: bool
    epoch: int


@dataclass(frozen=True, slots=True)
class IssueReport(Envelope):
    """Describe one durable AutoQA issue report."""

    issue: str
    tool: str
    rev: Rev
    summary: str
    expected: str | None
    observed: str | None
    reporter: str
    reporter_id: str | None
    call_id: str | None
    turn: int
    args_raw: str | None
    payload: object | None
    fault: object | None
    repairs: tuple[object, ...]
    labels: tuple[str, ...]
    consent: object


Event = (
    SessionStart
    | SessionEnd
    | TurnStart
    | TurnEnd
    | ModelRequest
    | CapabilityDegraded
    | Compaction
    | IssueReport
)
"""Closed union of event values currently materialized by the Python host."""


@dataclass(frozen=True, slots=True)
class Predicate:
    """Base value for a host-evaluated telemetry query predicate."""


@dataclass(frozen=True, slots=True)
class Eq(Predicate):
    """Require a telemetry field to equal ``value``."""

    value: object


@dataclass(frozen=True, slots=True)
class Step:
    """Describe one element of an ordered telemetry match sequence."""

    kinds: Sequence[Kind] = ()
    tool: str | None = None
    target: str | None = None
    rev: str | None = None
    where: Mapping[str, Predicate] = field(default_factory=dict)
    name: str | None = None


@dataclass(frozen=True, slots=True)
class Query:
    """Describe a host-side query over the durable telemetry index."""

    match: Sequence[Step]
    window: int = 8
    same_turn: bool = True
    scope: Scope = Scope.PROJECT
    sessions: Sequence[str] = ()
    since: datetime | timedelta | None = None
    until: datetime | None = None
    select: Sequence[str] = ()
    group_by: Sequence[str] = ()
    order_by: Sequence[str] = ()
    limit: int = 1000
    cursor: str | None = None


@dataclass(frozen=True, slots=True)
class Row(Mapping[str, object]):
    """Expose projected fields and the events matched by one query row."""

    events: tuple[Envelope, ...]
    bindings: Mapping[str, Envelope]
    session: str
    turn: int
    _values: Mapping[str, object] = field(default_factory=dict, repr=False)

    def __getitem__(self, key: str) -> object:
        """Return one projected field or aggregate."""

        return self._values[key]

    def __iter__(self) -> Iterator[str]:
        """Iterate projected field or aggregate names."""

        return iter(self._values)

    def __len__(self) -> int:
        """Return the number of projected fields or aggregates."""

        return len(self._values)


@dataclass(frozen=True, slots=True)
class RevMetrics:
    """Aggregate one tool revision's indexed reliability and latency facts."""

    rev: Rev
    first_seen_ms: int
    last_seen_ms: int
    sessions: int
    calls: int
    ok: int
    faults: int
    blocked: int
    timeouts: int
    aborted: int
    skipped: int
    postcondition_rejected: int
    abandoned: int
    fault_codes: Mapping[str, int]
    repaired_calls: int
    repair_paths: Mapping[str, int]
    retry_rate: float
    p50_latency_ms: float
    p95_latency_ms: float
    p99_latency_ms: float
    p50_speculation_ms: float
    p50_prompt_bytes: float
    p95_prompt_bytes: float
    spills: int
    issues: int


@dataclass(frozen=True, slots=True)
class QueryResult:
    """Report rows and scan facts from a settled telemetry query."""

    rows: tuple[Row, ...]
    total: int
    cursor: str | None
    truncated: bool
    scanned_sessions: int
    scanned_events: int
    backfilled: bool
    floored: bool
    elapsed_ms: int


def _query_wire(value: object) -> object:
    if isinstance(value, Eq):
        return {"op": "eq", "value": _query_wire(value.value)}
    if isinstance(value, Step):
        return {
            "kinds": [_query_wire(kind) for kind in value.kinds],
            "tool": value.tool,
            "target": value.target,
            "rev": value.rev,
            "where": {path: _query_wire(predicate) for path, predicate in value.where.items()},
            "name": value.name,
        }
    if isinstance(value, Query):
        return {
            "match": [_query_wire(step) for step in value.match],
            "window": value.window,
            "same_turn": value.same_turn,
            "scope": value.scope.value,
            "sessions": list(value.sessions),
            "since": _query_wire(value.since),
            "until": _query_wire(value.until),
            "select": list(value.select),
            "group_by": list(value.group_by),
            "order_by": list(value.order_by),
            "limit": value.limit,
            "cursor": value.cursor,
        }
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, timedelta):
        return value.total_seconds()
    if isinstance(value, Duration):
        return str(value)
    if isinstance(value, (EnvPath, ArtifactUrl)):
        return str(value)
    if is_dataclass(value) and not isinstance(value, type):
        return {
            item.name: _query_wire(getattr(value, item.name))
            for item in dataclass_fields(value)
        }
    if isinstance(value, Enum):
        return value.value
    if isinstance(value, Mapping):
        return {str(key): _query_wire(item) for key, item in value.items()}
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return [_query_wire(item) for item in value]
    return value


def _row_from_wire(value: object) -> Row:
    if isinstance(value, Row):
        return value
    if not isinstance(value, Mapping):
        raise TypeError("telemetry query row must be a mapping")
    body = dict(value)
    return Row(
        events=tuple(_event_from_wire(item) for item in body.get("events", ())),
        bindings={
            str(name): _event_from_wire(item)
            for name, item in dict(body.get("bindings", {})).items()
        },
        session=str(body["session"]),
        turn=int(body["turn"]),
        _values=dict(body.get("values", body.get("_values", {}))),
    )


def _query_result_from_wire(value: object) -> QueryResult:
    if isinstance(value, QueryResult):
        return value
    if not isinstance(value, Mapping):
        raise TypeError("omp.telemetry.query returned an invalid result")
    body = dict(value)
    body["rows"] = tuple(_row_from_wire(row) for row in body.get("rows", ()))
    return QueryResult(**body)


def _rev_from_wire(value: object) -> Rev:
    if isinstance(value, Rev):
        return value
    if isinstance(value, str):
        return Rev.parse(value)
    if isinstance(value, Mapping):
        return Rev(family=str(value.get("family", "")), n=int(value["n"]))
    raise TypeError("telemetry revision must be a string or mapping")


def _rev_metrics_from_wire(value: object) -> RevMetrics:
    if isinstance(value, RevMetrics):
        return value
    if not isinstance(value, Mapping):
        raise TypeError("telemetry revision metrics must be a mapping")
    body = dict(value)
    body["rev"] = _rev_from_wire(body["rev"])
    return RevMetrics(**body)



async def query(q: Query) -> QueryResult:
    """Run a serialized query through the host CONTROL bridge."""

    from . import _control_backend, _control_request

    if not isinstance(q, Query):
        raise TypeError("q must be an omp.telemetry.Query")
    if not q.match:
        raise QueryError("query match must not be empty")
    if not 1 <= q.limit <= QUERY_LIMIT_MAX:
        raise QueryError(f"query limit must be in 1..={QUERY_LIMIT_MAX}")
    if q.window < 0:
        raise QueryError("query window must be non-negative")
    if _control_backend.get() is None:
        raise NotWiredError("omp.telemetry.query")
    result = await _control_request("omp.telemetry.query", query=_query_wire(q))
    return _query_result_from_wire(result)


async def rev_metrics(
    tool: str,
    *,
    family: str | None = None,
    since: datetime | timedelta | None = None,
    scope: Scope = Scope.PROJECT,
) -> tuple[RevMetrics, ...]:
    """Return newest-first indexed metrics for one tool's revisions."""

    from . import _control_backend, _control_request

    if not isinstance(tool, str) or not tool:
        raise QueryError("tool must be a nonempty wire name")
    if family is not None and (not isinstance(family, str) or not family):
        raise QueryError("family must be a nonempty string or None")
    if since is not None and not isinstance(since, (datetime, timedelta)):
        raise TypeError("since must be a datetime, timedelta, or None")
    try:
        parsed_scope = Scope(scope)
    except ValueError as error:
        raise QueryError(str(error)) from error
    if _control_backend.get() is None:
        raise NotWiredError("omp.telemetry.rev_metrics")
    result = await _control_request(
        "omp.telemetry.rev_metrics",
        tool=tool,
        family=family,
        since=_query_wire(since),
        scope=parsed_scope.value,
    )
    if not isinstance(result, Sequence) or isinstance(
        result, (str, bytes, bytearray, Mapping)
    ):
        raise TypeError("omp.telemetry.rev_metrics returned an invalid result")
    return tuple(_rev_metrics_from_wire(item) for item in result)


semconv: Mapping[str, str] = MappingProxyType(
    {
        "model_request.requested_model": "gen_ai.request.model",
        "model_request.served_model": "gen_ai.response.model",
        "model_request.provider": "gen_ai.provider.name",
        "model_request.upstream_provider": "omp.gen_ai.response.upstream_provider",
        "model_request.ttft_ms": "gen_ai.response.time_to_first_chunk",
        "model_request.step": "omp.gen_ai.agent.step.number",
        "model_request.core_tools": "omp.gen_ai.request.available_tools",
        "model_request.effort": "omp.gen_ai.request.reasoning.effort",
        "model_request.tool_choice": "omp.gen_ai.request.tool.choice",
        "tokens.input": "gen_ai.usage.input_tokens",
        "tokens.output": "gen_ai.usage.output_tokens",
        "tokens.cache_read": "gen_ai.usage.cache_read.input_tokens",
        "tokens.cache_write": "gen_ai.usage.cache_creation.input_tokens",
        "tokens.reasoning": "gen_ai.usage.reasoning.output_tokens",
        "tokens.total": "omp.gen_ai.usage.total_tokens",
        "prompt.digest": "omp.gen_ai.prompt.digest",
        "prompt.changed": "omp.gen_ai.prompt.changed_slots",
        "prompt.prefix_stable_bytes": "omp.gen_ai.prompt.prefix_stable_bytes",
        "prompt.cache_key": "omp.gen_ai.cache.key",
        "tool_call.rev": "omp.tool.rev",
        "tool_call.place": "omp.tool.place",
        "tool_call.target": "omp.tool.target",
        "tool_call.projection_bytes": "omp.tool.prompt_bytes",
        "tool_call.repairs": "omp.tool.repairs",
        "compaction.reason": "omp.compaction.reason",
        "artifact_spill.artifact_id": "omp.artifact.id",
        "issue_report.issue_id": "omp.issue.id",
        "capability_degraded.intent": "omp.constraint.intent",
        "capability_degraded.granted": "omp.constraint.granted",
        "tool_call.status": "omp.gen_ai.tool.status",
    }
)
"""Frozen Python projection of ``omp_telemetry::semconv_gen::SEMCONV``."""


_EVENT_FIELD_PREFIX: Mapping[type[object], str] = MappingProxyType(
    {
        ModelRequest: "model_request",
        CapabilityDegraded: "capability_degraded",
        Compaction: "compaction",
        IssueReport: "issue_report",
    }
)


def _field_value(value: object, path: str) -> object | None:
    prefix = _EVENT_FIELD_PREFIX.get(type(value))
    if prefix is not None and path.startswith(prefix + "."):
        path = path[len(prefix) + 1 :]
    for part in path.split("."):
        if part == "tokens" and not hasattr(value, "tokens") and hasattr(value, "usage"):
            part = "usage"
        elif part == "issue_id" and not hasattr(value, "issue_id") and hasattr(value, "issue"):
            part = "issue"
        if isinstance(value, Mapping):
            if part not in value:
                return None
            value = value[part]
        else:
            value = getattr(value, part, None)
        if value is None:
            return None
    return value


def attributes(event: Event) -> Mapping[str, object]:
    """Project an event onto the Rust exporter's stable semantic attributes."""

    projected: dict[str, object] = {}
    for path, key in semconv.items():
        value = _field_value(event, path)
        if value is None or (
            not isinstance(value, bool)
            and isinstance(value, (int, float))
            and value == 0
        ):
            continue
        if isinstance(value, Enum):
            value = value.value
        elif isinstance(value, Sequence) and not isinstance(
            value, (str, bytes, bytearray)
        ):
            value = tuple(
                item.value if isinstance(item, Enum) else item for item in value
            )
        if isinstance(value, (str, int, float, bool, tuple)):
            projected[key] = value
    return MappingProxyType(projected)


class Span:
    """Async context manager for one extension-owned trace span."""

    __slots__ = (
        "_attrs",
        "_events",
        "_fault",
        "_handle",
        "_name",
        "_opened",
        "_trace",
    )

    def __init__(
        self,
        name: str,
        attrs: Mapping[str, str | int | float | bool],
    ) -> None:
        self._name = name
        self._attrs = dict(attrs)
        self._events: list[tuple[str, Mapping[str, object]]] = []
        self._fault: tuple[str, str] | None = None
        self._handle: object | None = None
        self._opened = False
        self._trace = TraceRef("", "", False)

    @property
    def trace(self) -> TraceRef:
        """Return this span's trace identity after it has opened."""

        return self._trace

    def set(self, **attrs: str | int | float | bool) -> None:
        """Set scalar span attributes."""

        _validate_attrs(attrs)
        self._attrs.update(attrs)

    def event(self, name: str, /, **attrs: str | int | float | bool) -> None:
        """Record a named point-in-time event on this span."""

        if not isinstance(name, str) or not name:
            raise ValueError("span event name must be nonempty")
        _validate_attrs(attrs)
        self._events.append((name, MappingProxyType(dict(attrs))))

    def fault(self, kind: str, message: str) -> None:
        """Mark this span failed without ending or raising from it."""

        if not isinstance(kind, str) or not kind:
            raise ValueError("span fault kind must be nonempty")
        if not isinstance(message, str):
            raise TypeError("span fault message must be a string")
        self._fault = (kind, message)

    async def __aenter__(self) -> Span:
        from . import _control_backend, _control_request

        if _control_backend.get() is None:
            raise NotWiredError("omp.telemetry.span")
        try:
            opened = await _control_request(
                "omp.telemetry.span.open",
                name=self._name,
                attributes=dict(self._attrs),
            )
        except Exception:
            return self
        if opened is None:
            return self
        self._opened = True
        if isinstance(opened, Mapping):
            self._handle = opened.get("handle")
            trace = opened.get("trace")
            if isinstance(trace, Mapping):
                self._trace = TraceRef(
                    trace_id=str(trace.get("trace_id", "")),
                    span_id=str(trace.get("span_id", "")),
                    sampled=bool(trace.get("sampled", False)),
                )
        else:
            self._handle = opened
        return self

    async def __aexit__(self, exc_type: object, exc: object, traceback: object) -> bool:
        from . import _control_request

        if exc_type is not None and isinstance(exc_type, type):
            self._fault = (exc_type.__name__, str(exc))
        if not self._opened:
            return False
        try:
            await _control_request(
                "omp.telemetry.span.close",
                handle=self._handle,
                attributes=_query_wire(self._attrs),
                events=[
                    {"name": name, "attributes": dict(attrs)}
                    for name, attrs in self._events
                ],
                fault=list(self._fault) if self._fault is not None else None,
            )
        except Exception:
            pass
        return False


def span(name: str, /, **attrs: str | int | float | bool) -> Span:
    """Create an extension-owned async trace span."""

    if not isinstance(name, str) or not name:
        raise ValueError("span name must be nonempty")
    _validate_attrs(attrs)
    return Span(name, attrs)


class _TelemetryModule(ModuleType):
    def __call__(self, kinds: Sequence[Kind | str], **kwargs: object):
        return _subscribe(kinds, **kwargs)


sys.modules[__name__].__class__ = _TelemetryModule

__all__ = (
    "BATCH_MAX", "CapabilityDegraded", "Compaction", "ContextSnapshot", "Cost", "Counter",
    "DEFAULT_MAX_BYTES", "DEFAULT_MAX_COLUMN", "DEFAULT_MAX_LINES", "Degradation", "DegradeAction",
    "DropStats", "Envelope", "Eq", "Event", "ExportError", "ExportHandle", "ExportStats",
    "ExportTarget", "ExtensionRef", "FileTarget", "Histogram", "IssueReport", "Kind",
    "MAX_CARDINALITY", "MAX_INSTRUMENTS", "METRIC_PREFIX", "ModelRequest", "OtlpTarget",
    "Overflow", "Predicate", "ProcessTarget", "PromptFingerprint", "PromptSlotFingerprint", "Query",
    "QueryError", "QueryResult", "QUERY_LIMIT_MAX", "QUEUE_DEFAULT", "QUEUE_MAX", "RevMetrics", "Row", "SPILL_BYTES",
    "SPILL_COLUMN", "SPILL_LINES", "Scope", "SessionEnd", "SessionStart", "Span", "Step",
    "StopReason", "SubscriptionError", "TelemetryError", "Tokens", "TraceRef", "TurnEnd",
    "TurnStart", "attributes", "counter", "dropped", "export", "flush", "histogram", "query",
    "rev_metrics", "semconv", "span",
)
