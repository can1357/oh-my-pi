"""Pure, frozen verdict and projection vocabulary."""

from __future__ import annotations

import base64
import dataclasses
import datetime as _datetime
import json
import math
import types
import typing
from collections.abc import AsyncIterator, Mapping as MappingABC
from dataclasses import dataclass
from enum import Enum, IntEnum, StrEnum
from types import MappingProxyType
from typing import Any, Generic, Mapping, TypeVar

from _omp import ArtifactUrl, Duration, InvocationPhase, OmpError

from ._context import Context
from ._errors import NotWiredError


class VerdictSchemaError(OmpError):
    """Report a non-serializable field type in durable verdict truth."""

    def __init__(self, shape: object, field: str, detail: str) -> None:
        self.shape = shape
        self.field = field
        self.detail = detail
        name = getattr(shape, "__qualname__", repr(shape))
        super().__init__(f"{name}.{field} is not verdict-serializable: {detail}")


class VerdictShapeError(OmpError):
    """Report canonical verdict bytes that do not match their declared shape."""

    def __init__(self, shape: object, detail: str) -> None:
        self.shape = shape
        self.detail = detail
        name = getattr(shape, "__qualname__", repr(shape))
        super().__init__(f"verdict does not match {name}: {detail}")


class RevError(OmpError, ValueError):
    """Report a malformed textual revision."""

    def __init__(self, value: object, detail: str = "expected family.n or a bare u16") -> None:
        self.value = value
        self.detail = detail
        super().__init__(f"malformed revision {value!r}: {detail}")


class BudgetError(OmpError, ValueError):
    """Report invalid use of a sealed projection budget or text fragment."""


_PAYLOAD_MISSING = object()


@dataclass(frozen=True, slots=True, kw_only=True, init=False)
class Payload:
    """A device's durable success value, inline or subclass-shaped."""

    _inline: Mapping[str, object] | None = dataclasses.field(
        default=None,
        init=False,
        repr=False,
        compare=False,
        metadata={"omp_terminal_control": True},
    )
    terminate: bool = dataclasses.field(
        default=False,
        metadata={"omp_terminal_control": True},
    )

    def __init_subclass__(cls, **kwargs: object) -> None:
        """Reject unsupported durable field annotations when a payload is declared."""
        super().__init_subclass__(**kwargs)
        _validate_verdict_schema(cls)

    def __init__(
        self,
        value: Mapping[str, object] | object = _PAYLOAD_MISSING,
        /,
        *,
        terminate: bool = False,
    ) -> None:
        """Freeze one inline mapping payload."""

        if value is _PAYLOAD_MISSING:
            value = {}
        if not isinstance(value, MappingABC):
            raise TypeError("Payload value must be a mapping")
        object.__setattr__(self, "_inline", MappingProxyType(dict(value)))
        object.__setattr__(self, "terminate", terminate)

    def useless(self) -> bool:
        """Return whether compaction may omit this value's prompt projection."""
        return False


_P = TypeVar("_P", bound=Payload)
_F = TypeVar("_F")
_U = TypeVar("_U")
_R = TypeVar("_R")
_UPDATE_MISSING = object()


@dataclass(frozen=True, slots=True, init=False)
class Update(Generic[_U]):
    """An ephemeral typed progress payload emitted by a streaming device."""

    payload: _U

    def __init__(
        self, payload: _U | object = _UPDATE_MISSING, /, **fields: object
    ) -> None:
        if payload is not _UPDATE_MISSING and fields:
            raise TypeError("Update accepts either one payload or keyword fields")
        value = fields if payload is _UPDATE_MISSING else payload
        object.__setattr__(self, "payload", value)


@dataclass(frozen=True, slots=True)
class Done(Generic[_R]):
    """The terminal result emitted by a streaming device or finished operation."""
 
    result: _R | None = None
    useless: bool = False
 
 
@dataclass(frozen=True, slots=True)
class JobRef:
    """Name detached Environment-owned work and its expected artifact."""

    id: str
    owner_kind: str
    owner_name: str
    owner_generation: int
    description: str
    media_type: str | None
    lifetime: str


@dataclass(frozen=True, slots=True)
class Detached:
    """Terminate this turn while supervised work continues on the job board."""

    job: JobRef


class _Jobs:
    """Host-backed detached-job registration operations."""

    __slots__ = ()

    async def register(
        self, frames: AsyncIterator[Update[Any] | Done[Any]], ctx: Context
    ) -> JobRef:
        """Register an env-placed device stream as supervised detached work."""

        from . import _control_backend, _control_request

        operation = "omp.jobs.register"
        if _control_backend.get() is None:
            raise NotWiredError(operation)
        return await _control_request(operation, frames=frames, context=ctx)


jobs = _Jobs()
"""Host-backed detached-job registration namespace."""





@dataclass(frozen=True, slots=True)
class Ok(Generic[_P]):
    """A settled successful call and its durable payload."""

    payload: _P


@dataclass(frozen=True, slots=True)
class Faulted(Generic[_F]):
    """A settled expected failure and its durable fault value."""

    fault: _F


class PostconditionStatus(StrEnum):
    """Classify a durable finding attached after a call settles."""

    PASSED = "passed"
    REJECTED = "rejected"


@dataclass(frozen=True, slots=True)
class Postcondition:
    """Record a policy finding beside, without rewriting, a settled outcome."""

    status: PostconditionStatus
    reason: str
    code: str | None
    decision_id: str
    rules: tuple["RuleRef", ...] = ()


class AbortKind(StrEnum):
    """Classify why a call settled without a normal device verdict."""

    CANCELLED = "cancelled"
    SKIPPED = "skipped"
    POLICY_DENIED = "policy_denied"


@dataclass(frozen=True, slots=True)
class ArgsRejected:
    """Record a harness-owned structured argument rejection."""

    issue: object


@dataclass(frozen=True, slots=True, init=False)
class Aborted:
    """Record a harness- or Core-owned abnormal call settlement."""

    abort: object
    kind: AbortKind
    policy: object | None = None

    def __init__(
        self,
        abort: object,
        kind: AbortKind | None = None,
        policy: object | None = None,
    ) -> None:
        if kind is None:
            abort_kind = getattr(abort, "kind", None)
            if abort_kind == "skipped":
                kind = AbortKind.SKIPPED
            elif abort_kind in {
                "interrupted",
                "effects_unknown",
                "input_dropped",
                "missing_outcome",
            }:
                kind = AbortKind.CANCELLED
            else:
                raise ValueError("cannot derive AbortKind from abort")
        if not isinstance(kind, AbortKind):
            raise TypeError("kind must be AbortKind")
        has_policy = policy is not None
        if has_policy != (kind is AbortKind.POLICY_DENIED):
            raise ValueError(
                "policy must be present exactly when kind is AbortKind.POLICY_DENIED"
            )
        object.__setattr__(self, "abort", abort)
        object.__setattr__(self, "kind", kind)
        object.__setattr__(self, "policy", policy)


CallOutcome = Ok[_P] | Faulted[_F] | ArgsRejected | Aborted
"""Closed union of the four durable call-outcome arms."""


@dataclass(frozen=True, slots=True)
class ArtifactRef:
    """Reference durable bytes in the session artifact namespace."""

    id: str
    hash: str
    media_type: str
    byte_len: int

    @property
    def url(self) -> ArtifactUrl:
        """Return this reference's typed ``artifact://`` address."""

        return ArtifactUrl(f"artifact://{self.id}")


class Dialect(StrEnum):
    """Argument dialect used by a model-facing projection."""

    HASHLINE = "hl"
    REPLACE = "rep"
    PATCH = "patch"
    NATIVE = "native"


class ModelClass(IntEnum):
    """Coarse model capability band used only to size projections."""

    TINY = 0
    SMALL = 1
    STANDARD = 2
    FRONTIER = 3


@dataclass(frozen=True, slots=True)
class PromptCaps:
    """Deterministic limits for one model-facing projection."""

    maximum_parts: int
    maximum_text_bytes: int
    media: bool
    dialect: Dialect
    model_class: ModelClass

    def __post_init__(self) -> None:
        if (
            isinstance(self.maximum_parts, bool)
            or not isinstance(self.maximum_parts, int)
            or self.maximum_parts < 0
        ):
            raise ValueError("maximum_parts must be a non-negative integer")
        if (
            isinstance(self.maximum_text_bytes, bool)
            or not isinstance(self.maximum_text_bytes, int)
            or self.maximum_text_bytes < 0
        ):
            raise ValueError("maximum_text_bytes must be a non-negative integer")

    def fits(self, text: str) -> bool:
        """Return whether one text part fits this projection budget."""
        return self.maximum_parts > 0 and len(text.encode("utf-8")) <= self.maximum_text_bytes


@dataclass(frozen=True, slots=True)
class TextPart:
    """UTF-8 text exposed to the model."""

    text: str


@dataclass(frozen=True, slots=True)
class JsonPart:
    """Canonical JSON bytes exposed as structured model content."""

    json: bytes


@dataclass(frozen=True, slots=True)
class BlobPart:
    """A blob-backed media part with deterministic fallback text."""

    blob: Any
    alt: str | None = None


class Part:
    """Validated factory for model-facing projection parts."""

    __slots__ = ()

    @staticmethod
    def text(text: str) -> TextPart:
        """Construct a text part."""
        if not isinstance(text, str):
            raise TypeError("text part content must be str")
        return TextPart(text)

    @staticmethod
    def json(value: object) -> JsonPart:
        """Construct a canonical JSON part."""
        return JsonPart(_canonical_json(value))

    @staticmethod
    def blob(ref: Any, alt: str | None = None) -> BlobPart:
        """Construct a blob-backed media part."""
        if alt is not None and not isinstance(alt, str):
            raise TypeError("blob alt text must be str or None")
        return BlobPart(ref, alt)


class Budget:
    """Whole-fragment accumulator enforcing a ``PromptCaps`` budget."""

    __slots__ = ("_caps", "_parts", "_text_bytes", "_truncated", "_sealed")

    def __init__(self, caps: PromptCaps) -> None:
        if not isinstance(caps, PromptCaps):
            raise TypeError("caps must be PromptCaps")
        self._caps = caps
        self._parts: list[TextPart | JsonPart | BlobPart] = []
        self._text_bytes = 0
        self._truncated = False
        self._sealed = False

    @property
    def remaining(self) -> int:
        """Return the unconsumed UTF-8 byte budget."""
        return max(0, self._caps.maximum_text_bytes - self._text_bytes)

    def push(self, fragment: str) -> bool:
        """Append a whole text fragment when it fits."""
        self._ensure_open()
        if not isinstance(fragment, str):
            raise BudgetError("projection fragments must be str")
        size = len(fragment.encode("utf-8"))
        needs_part = not self._parts or not isinstance(self._parts[-1], TextPart)
        if size > self.remaining or (
            needs_part and len(self._parts) >= self._caps.maximum_parts
        ):
            self._truncated = True
            return False
        if needs_part:
            self._parts.append(TextPart(fragment))
        else:
            previous = self._parts[-1]
            assert isinstance(previous, TextPart)
            self._parts[-1] = TextPart(previous.text + fragment)
        self._text_bytes += size
        return True

    def push_json(self, value: object) -> bool:
        """Append one canonical JSON part when it fits."""
        self._ensure_open()
        raw = _canonical_json(value)
        if len(raw) > self.remaining or len(self._parts) >= self._caps.maximum_parts:
            self._truncated = True
            return False
        self._parts.append(JsonPart(raw))
        self._text_bytes += len(raw)
        return True

    def push_blob(self, ref: Any, alt: str) -> bool:
        """Append media, or its fallback text when media is unavailable."""
        self._ensure_open()
        if not isinstance(alt, str):
            raise BudgetError("projection fragments must be str")
        if not self._caps.media:
            return self.push(alt)
        if len(self._parts) >= self._caps.maximum_parts:
            self._truncated = True
            return False
        self._parts.append(BlobPart(ref, alt))
        return True

    def finish(self) -> list[TextPart | JsonPart | BlobPart]:
        """Seal and return the accepted parts, marking truncation when possible."""
        self._ensure_open()
        marker = "\n[truncated]"
        if self._truncated:
            marker_size = len(marker.encode("utf-8"))
            can_merge = bool(self._parts) and isinstance(self._parts[-1], TextPart)
            if marker_size <= self.remaining and (
                can_merge or len(self._parts) < self._caps.maximum_parts
            ):
                if can_merge:
                    previous = self._parts[-1]
                    assert isinstance(previous, TextPart)
                    self._parts[-1] = TextPart(previous.text + marker)
                else:
                    self._parts.append(TextPart(marker))
                self._text_bytes += marker_size
        self._sealed = True
        return list(self._parts)

    def _ensure_open(self) -> None:
        if self._sealed:
            raise BudgetError("projection budget is sealed")


@dataclass(frozen=True, slots=True, order=True)
class Rev:
    """One argument-and-projection dialect revision."""

    family: str
    n: int

    def __post_init__(self) -> None:
        if not self.family or "." in self.family:
            if self.family != "":
                raise ValueError("revision family must be empty or a non-empty dotless name")
        if not isinstance(self.n, int) or isinstance(self.n, bool) or not 0 <= self.n <= 65535:
            raise ValueError("revision number must be a u16 integer")

    def __str__(self) -> str:
        return f"{self.family}.{self.n}" if self.family else str(self.n)

    @classmethod
    def parse(cls, value: str) -> Rev:
        """Parse ``family.n`` or a bare numeric revision."""
        if not isinstance(value, str) or not value:
            raise RevError(value, "revision must be a non-empty string")
        family, separator, number = value.rpartition(".")
        if not separator:
            family, number = "", value
        if (
            not number.isascii()
            or not number.isdigit()
            or "." in family
            or (family == "" and separator and value.startswith("."))
        ):
            raise RevError(value)
        try:
            return cls(family, int(number))
        except (TypeError, ValueError) as error:
            raise RevError(value, str(error)) from error


@dataclass(frozen=True, slots=True, order=True)
class ToolIdentity:
    """Durable device name and semantic revision."""

    name: str
    rev: Rev

    def __str__(self) -> str:
        return f"{self.name}@{self.rev}"


_EMPTY_PRESENTATION: Mapping[str, object] = MappingProxyType({})


@dataclass(frozen=True, slots=True)
class View(Generic[_U, _P, _F]):
    """Immutable live-or-settled renderer fold input."""

    identity: ToolIdentity
    call_id: str
    updates: tuple[_U, ...]
    state: object | None
    verdict: CallOutcome[_P, _F] | None
    elapsed: Duration
    phase: InvocationPhase
    presentation: Mapping[str, object] = dataclasses.field(
        default_factory=lambda: _EMPTY_PRESENTATION
    )

    def __post_init__(self) -> None:
        """Freeze the host-materialized presentation snapshot."""

        if self.presentation is not _EMPTY_PRESENTATION:
            object.__setattr__(
                self,
                "presentation",
                MappingProxyType(dict(self.presentation)),
            )


@dataclass(frozen=True, slots=True)
class RecordedCall:
    """Byte-exact historical call supplied to a lift step."""

    identity: ToolIdentity
    raw_args: bytes
    verdict: bytes


@dataclass(frozen=True, slots=True)
class LiftedCall:
    """A historical call re-expressed at a destination revision."""

    raw_args: bytes
    verdict: bytes

    @classmethod
    def of(cls, args: object, verdict: object) -> LiftedCall:
        """Canonically serialize lifted arguments and verdict."""
        return cls(_canonical_json(args), _canonical_json(verdict))


class ArtifactLifetime(StrEnum):
    """Minimum retention requested for a spilled verdict artifact."""

    EPHEMERAL = "ephemeral"
    SESSION = "session"
    DURABLE = "durable"


SPILL_INLINE_LIMIT = 16 * 1024
"""Default maximum canonical verdict size retained inline."""


@dataclass(frozen=True, slots=True)
class SpillBudget:
    """Policy controlling central artifactization of a large verdict."""

    inline_limit: int = SPILL_INLINE_LIMIT
    media_type: str = "application/json"
    lifetime: ArtifactLifetime = ArtifactLifetime.SESSION
    always: bool = False


def _validate_projection(
    value: object, caps: PromptCaps
) -> list[TextPart | JsonPart | BlobPart]:
    if not isinstance(value, list):
        raise TypeError("device prompt projections must return a list")
    if any(not isinstance(part, (TextPart, JsonPart, BlobPart)) for part in value):
        raise TypeError("device prompt projections must contain only Part values")
    if len(value) > caps.maximum_parts:
        raise BudgetError("device prompt projection exceeded maximum_parts")
    text_bytes = sum(
        len(part.text.encode("utf-8"))
        if isinstance(part, TextPart)
        else len(part.json)
        if isinstance(part, JsonPart)
        else 0
        for part in value
    )
    if text_bytes > caps.maximum_text_bytes:
        raise BudgetError("device prompt projection exceeded maximum_text_bytes")
    if not caps.media and any(isinstance(part, BlobPart) for part in value):
        raise BudgetError("device prompt projection emitted media without media capability")
    return value


def _dispatch_prompt(
    name: str,
    family: str,
    rev: int,
    view: Ok[Any] | Faulted[Any],
    caps: PromptCaps,
) -> list[TextPart | JsonPart | BlobPart]:
    """Run the exact registered device projection selected by the host."""

    from ._registry import registry

    if not isinstance(view, (Ok, Faulted)):
        raise TypeError("device prompt view must be Ok or Faulted")
    if not isinstance(caps, PromptCaps):
        raise TypeError("device prompt caps must be PromptCaps")
    definition = registry.device_definition(name, family, rev)
    projector = getattr(definition.body, "prompt", None)
    if not callable(projector):
        raise LookupError(f"device {name!r}@{family or name}.{rev} has no prompt projection")
    return _validate_projection(projector(view, caps), caps)


def prompt(view: Ok[Any] | Faulted[Any], caps: PromptCaps) -> list[TextPart | JsonPart | BlobPart]:
    """Dispatch to the sole registered projection owning this verdict shape."""

    from ._registry import registry

    if not isinstance(view, (Ok, Faulted)):
        raise TypeError("device prompt view must be Ok or Faulted")
    payload = view.payload if isinstance(view, Ok) else view.fault
    matches: list[tuple[str, str, int]] = []
    for definition in registry.device_definitions():
        projector = getattr(definition.body, "prompt", None)
        shape_name = "Payload" if isinstance(view, Ok) else "Fault"
        shape = getattr(definition.body, shape_name, None)
        if callable(projector) and isinstance(shape, type) and type(payload) is shape:
            matches.append((definition.name, definition.family, definition.rev))
    if len(matches) != 1:
        detail = "no registered owner" if not matches else "multiple registered owners"
        raise LookupError(f"{detail} for {type(payload).__qualname__}")
    return _dispatch_prompt(*matches[0], view, caps)


class _ShapeMismatch(ValueError):
    pass


def _type_globals(cls: type[object]) -> dict[str, object]:
    # Base-class annotations (Payload/Fault fields) resolve against this module's
    # imports; the subclass module's names are overlaid on top.
    namespace = dict(globals())
    namespace.update(vars(__import__(cls.__module__, fromlist=("*",))))
    if any("RuleRef" in str(value) for value in cls.__dict__.get("__annotations__", {}).values()):
        from .policy import RuleRef

        namespace["RuleRef"] = RuleRef
    namespace[cls.__name__] = cls
    return namespace


def _resolved_hints(cls: type[object]) -> dict[str, object]:
    try:
        return typing.get_type_hints(cls, globalns=_type_globals(cls), localns={cls.__name__: cls})
    except (NameError, TypeError) as error:
        raise _ShapeMismatch(f"cannot resolve field annotations: {error}") from error


def _validate_verdict_schema(cls: type[object]) -> None:
    """Validate the field annotations declared by one durable marker subclass."""
    namespace = _type_globals(cls)
    for owner in reversed(cls.__mro__):
        for field, annotation in owner.__dict__.get("__annotations__", {}).items():
            if isinstance(annotation, str):
                try:
                    annotation = eval(annotation, namespace, {cls.__name__: cls})
                except NameError:
                    # A forward declaration is checked when the codec resolves the completed shape.
                    continue
            try:
                _assert_serializable_type(annotation, set())
            except TypeError as error:
                raise VerdictSchemaError(cls, field, str(error)) from error


def _assert_serializable_type(shape: object, seen: set[object]) -> None:
    if shape in seen:
        return
    try:
        seen.add(shape)
    except TypeError:
        pass

    if shape in (bool, int, float, str, bytes, type(None), _datetime.datetime, Duration):
        return
    if shape in (Any, object):
        return
    if isinstance(shape, typing.ForwardRef):
        return
    if isinstance(shape, TypeVar):
        if shape.__constraints__:
            for constraint in shape.__constraints__:
                _assert_serializable_type(constraint, seen)
            return
        if shape.__bound__ is not None:
            _assert_serializable_type(shape.__bound__, seen)
            return
        raise TypeError(f"unbound type variable {shape!s}")
    if isinstance(shape, type) and issubclass(shape, Enum):
        for member in shape:
            _assert_serializable_type(type(member.value), seen)
        return

    origin = typing.get_origin(shape)
    args = typing.get_args(shape)
    if origin is typing.Annotated:
        _assert_serializable_type(args[0], seen)
        return
    if origin is typing.Literal:
        for value in args:
            _assert_serializable_type(type(value), seen)
        return
    if origin in (typing.Union, types.UnionType):
        for arm in args:
            _assert_serializable_type(arm, seen)
        return
    if origin is list:
        _assert_serializable_type(args[0], seen)
        return
    if origin in (dict, Mapping, MappingABC):
        if args[0] is not str:
            raise TypeError("verdict mappings must have str keys")
        _assert_serializable_type(args[1], seen)
        return
    if origin is tuple:
        for item in args:
            if item is not Ellipsis:
                _assert_serializable_type(item, seen)
        return

    candidate = origin or shape
    if isinstance(candidate, type) and dataclasses.is_dataclass(candidate):
        for field_shape in _resolved_hints(candidate).values():
            _assert_serializable_type(field_shape, seen)
        return
    # During __init_subclass__, @dataclass has not run yet; annotations are still sufficient.
    if isinstance(candidate, type) and candidate.__dict__.get("__annotations__"):
        for field_shape in candidate.__dict__["__annotations__"].values():
            if not isinstance(field_shape, str):
                _assert_serializable_type(field_shape, seen)
        return
    raise TypeError(f"unsupported field type {shape!r}")


def _encode_verdict(value: object, active: set[int]) -> object:
    if value is None or isinstance(value, (bool, str)):
        if isinstance(value, str):
            value.encode("utf-8")
        return value
    if isinstance(value, int) and not isinstance(value, bool):
        return value
    if isinstance(value, float):
        if not math.isfinite(value):
            raise TypeError("non-finite floats are not verdict-serializable")
        return value
    if isinstance(value, Enum):
        return _encode_verdict(value.value, active)
    if isinstance(value, bytes):
        return {"$bytes": base64.b64encode(value).decode("ascii")}
    if isinstance(value, _datetime.datetime):
        return {"$datetime": value.isoformat()}
    if isinstance(value, Duration):
        return {"$duration": str(value)}

    identity = id(value)
    if identity in active:
        raise TypeError("cyclic values are not verdict-serializable")
    active.add(identity)
    try:
        if type(value) is Payload:
            return _encode_verdict(value._inline, active)
        if dataclasses.is_dataclass(value) and not isinstance(value, type):
            return {
                field.name: _encode_verdict(getattr(value, field.name), active)
                for field in dataclasses.fields(value)
                if not field.metadata.get("omp_terminal_control", False)
            }
        if isinstance(value, MappingABC):
            encoded: dict[str, object] = {}
            for key, item in value.items():
                if not isinstance(key, str):
                    raise TypeError("verdict mappings must have str keys")
                encoded[key] = _encode_verdict(item, active)
            return encoded
        if isinstance(value, (list, tuple)):
            return [_encode_verdict(item, active) for item in value]
    finally:
        active.remove(identity)
    raise TypeError(f"{type(value).__name__} is not verdict-serializable")


def dumps(value: object) -> bytes:
    """Serialize a verdict value to deterministic canonical UTF-8 JSON bytes."""
    encoded = _encode_verdict(value, set())
    try:
        text = json.dumps(
            encoded,
            allow_nan=False,
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
        )
        return text.encode("utf-8")
    except (TypeError, ValueError, UnicodeError) as error:
        raise TypeError(f"verdict serialization failed: {error}") from error


def _decode_dynamic(value: object) -> object:
    if isinstance(value, str):
        try:
            value.encode("utf-8")
        except UnicodeEncodeError as error:
            raise _ShapeMismatch("string is not valid UTF-8") from error
        return value
    if isinstance(value, float) and not math.isfinite(value):
        raise _ShapeMismatch("expected finite float")
    if isinstance(value, list):
        return [_decode_dynamic(item) for item in value]
    if isinstance(value, dict):
        return {key: _decode_dynamic(item) for key, item in value.items()}
    return value


def _decode_verdict(
    value: object,
    shape: object,
    bindings: Mapping[TypeVar, object] | None = None,
) -> object:
    bindings = bindings or {}
    if isinstance(shape, TypeVar):
        if shape in bindings:
            return _decode_verdict(value, bindings[shape], bindings)
        raise _ShapeMismatch(f"unbound type variable {shape!s}")

    origin = typing.get_origin(shape)
    args = typing.get_args(shape)
    if origin is typing.Annotated:
        return _decode_verdict(value, args[0], bindings)
    if origin is typing.Literal:
        matches = [
            item
            for item in args
            if type(value) is type(item) and value == item
        ]
        if len(matches) != 1:
            raise _ShapeMismatch(f"expected one of {args!r}")
        return matches[0]
    if origin in (typing.Union, types.UnionType):
        matches: list[object] = []
        for arm in args:
            try:
                matches.append(_decode_verdict(value, arm, bindings))
            except _ShapeMismatch:
                pass
        if len(matches) != 1:
            raise _ShapeMismatch("value does not select exactly one union arm")
        return matches[0]

    if shape in (Any, object):
        return _decode_dynamic(value)
    if shape is type(None):
        if value is not None:
            raise _ShapeMismatch("expected null")
        return None
    if shape is bool:
        if type(value) is not bool:
            raise _ShapeMismatch("expected bool")
        return value
    if shape is int:
        if type(value) is not int:
            raise _ShapeMismatch("expected int")
        return value
    if shape is float:
        if type(value) is not float or not math.isfinite(value):
            raise _ShapeMismatch("expected finite float")
        return value
    if shape is str:
        if type(value) is not str:
            raise _ShapeMismatch("expected str")
        try:
            value.encode("utf-8")
        except UnicodeEncodeError as error:
            raise _ShapeMismatch("string is not valid UTF-8") from error
        return value
    if shape is bytes:
        if not isinstance(value, dict) or set(value) != {"$bytes"}:
            raise _ShapeMismatch("expected tagged bytes")
        encoded = value["$bytes"]
        if not isinstance(encoded, str):
            raise _ShapeMismatch("expected base64 string")
        try:
            return base64.b64decode(encoded, validate=True)
        except ValueError as error:
            raise _ShapeMismatch("invalid base64 bytes value") from error
    if shape is _datetime.datetime:
        if not isinstance(value, dict) or set(value) != {"$datetime"}:
            raise _ShapeMismatch("expected tagged datetime")
        encoded = value["$datetime"]
        if not isinstance(encoded, str):
            raise _ShapeMismatch("expected datetime string")
        try:
            return _datetime.datetime.fromisoformat(encoded)
        except ValueError as error:
            raise _ShapeMismatch("invalid datetime value") from error
    if shape is Duration:
        if not isinstance(value, dict) or set(value) != {"$duration"}:
            raise _ShapeMismatch("expected tagged Duration")
        encoded = value["$duration"]
        if not isinstance(encoded, str):
            raise _ShapeMismatch("expected Duration string")
        try:
            return Duration(encoded)
        except (TypeError, ValueError) as error:
            raise _ShapeMismatch("invalid Duration value") from error

    candidate = origin or shape
    if isinstance(candidate, type) and issubclass(candidate, Enum):
        matches = [
            member
            for member in candidate
            if type(value) is type(member.value) and value == member.value
        ]
        if len(matches) != 1:
            raise _ShapeMismatch(f"expected a {candidate.__qualname__} value")
        return matches[0]

    if origin is list:
        if not isinstance(value, list):
            raise _ShapeMismatch("expected array")
        return [_decode_verdict(item, args[0], bindings) for item in value]
    if origin in (dict, Mapping, MappingABC):
        if not isinstance(value, dict) or args[0] is not str:
            raise _ShapeMismatch("expected string-keyed object")
        return {
            key: _decode_verdict(item, args[1], bindings)
            for key, item in value.items()
        }
    if origin is tuple:
        if not isinstance(value, list):
            raise _ShapeMismatch("expected array")
        if len(args) == 2 and args[1] is Ellipsis:
            return tuple(_decode_verdict(item, args[0], bindings) for item in value)
        if len(value) != len(args):
            raise _ShapeMismatch(f"expected tuple of length {len(args)}")
        return tuple(
            _decode_verdict(item, item_shape, bindings)
            for item, item_shape in zip(value, args, strict=True)
        )

    if isinstance(candidate, type) and dataclasses.is_dataclass(candidate):
        if not isinstance(value, dict):
            raise _ShapeMismatch(f"expected object for {candidate.__qualname__}")
        local_bindings = dict(bindings)
        parameters = getattr(candidate, "__parameters__", ())
        if origin is not None and parameters:
            local_bindings.update(zip(parameters, args, strict=True))
        fields = tuple(
            field
            for field in dataclasses.fields(candidate)
            if not field.metadata.get("omp_terminal_control", False)
        )
        expected = {field.name for field in fields}
        actual = set(value)
        if actual != expected:
            missing = sorted(expected - actual)
            extra = sorted(actual - expected)
            raise _ShapeMismatch(f"field mismatch (missing={missing!r}, extra={extra!r})")
        hints = _resolved_hints(candidate)
        decoded = {
            field.name: _decode_verdict(value[field.name], hints[field.name], local_bindings)
            for field in fields
        }
        try:
            return candidate(**decoded)
        except Exception as error:
            raise _ShapeMismatch(f"constructor rejected decoded fields: {error}") from error

    raise _ShapeMismatch(f"unsupported requested shape {shape!r}")


def loads(data: bytes, shape: type[_R]) -> _R:
    """Decode canonical UTF-8 JSON bytes against an explicit, exact verdict shape."""
    if not isinstance(data, bytes):
        raise VerdictShapeError(shape, "data must be bytes")
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError as error:
        raise VerdictShapeError(shape, "data is not valid UTF-8") from error

    def object_pairs(pairs: list[tuple[str, object]]) -> dict[str, object]:
        result: dict[str, object] = {}
        keys: list[str] = []
        for key, value in pairs:
            if key in result:
                raise _ShapeMismatch(f"duplicate object key {key!r}")
            keys.append(key)
            result[key] = value
        if keys != sorted(keys):
            raise _ShapeMismatch("object keys are not in canonical sorted order")
        return result

    def finite_float(token: str) -> float:
        value = float(token)
        if not math.isfinite(value):
            raise _ShapeMismatch(f"non-finite number {token}")
        return value

    decoder = json.JSONDecoder(
        object_pairs_hook=object_pairs,
        parse_constant=lambda token: (_ for _ in ()).throw(
            _ShapeMismatch(f"non-finite number {token}")
        ),
        parse_float=finite_float,
    )
    try:
        value, end = decoder.raw_decode(text)
        if end != len(text):
            raise _ShapeMismatch("trailing data")
        decoded = _decode_verdict(value, shape)
    except (json.JSONDecodeError, _ShapeMismatch) as error:
        raise VerdictShapeError(shape, str(error)) from error
    return typing.cast(_R, decoded)


def _canonical_json(value: object) -> bytes:
    return dumps(value)
