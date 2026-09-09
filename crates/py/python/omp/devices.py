"""Declared dynamic-device parents and post-FREEZE runtime leaves.

The static declaration table records only a parent with
``devices.parent(name, family=..., rev=..., place=...)`` during IMPORT.  After
FREEZE, an activation hook may attach discovered leaves beneath that authority
with one ``await parent.mount_many(MountSpec(...), ...)`` call.  A mount spec's
``subpath`` is relative to the parent, so runtime discovery cannot claim an
unrelated top-level name or change the parent's family, revision, placement, or
manifest provenance.

Mounting and availability are deliberately distinct.  Mounting supplies stable
identity, schema, docs, and a body for a discovered leaf.  Reachability changes
are sent through ``await devices.set_availability(*deltas)``; all deltas in the
call form one host transition, one catalog notification, and one journal item.
``enable`` and ``disable`` are convenience batch constructors over that same
operation.  Thus dynamic MCP leaves use the ordinary ``omp.devices`` mounted
set rather than maintaining a second registry or re-registering on reconnect.
Runtime mutations ride the common CONTROL bridge.  The host validates them
against the frozen manifest and returns its authoritative catalog projection;
Python never maintains a competing device registry.
"""
from __future__ import annotations

import contextvars
import inspect
import json
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass
from enum import IntEnum, StrEnum
from types import MappingProxyType
from typing import Any

from _omp import Duration
from ._errors import DeclarationSealed, ExtensionError, NotWiredError
from ._registry import registry
from .journal import JournalError
from .packages import Provenance
from .placement import Place
from .policy import Tier


HARD_SLOT_BUDGET = 8
EXTERNAL_SUMMARY_CAP = 200
PER_DEVICE_CAP = 10_000


class Precedence(IntEnum):
    """Order competing claims on one device name."""

    CORE = 1000
    INTEGRATION = 700
    ENHANCEMENT = 500
    DEFAULT = 0
    FALLBACK = -500


@dataclass(frozen=True, slots=True)
class Availability:
    """Describe whether a declared device is currently mounted."""

    mounted: bool
    reason: str | None = None


@dataclass(frozen=True, slots=True)
class Example:
    """Describe one worked device invocation."""

    args: Mapping[str, object]
    note: str | None = None
    result: str | None = None


@dataclass(frozen=True, slots=True)
class DocEffects:
    """Bound a device's document effects."""

    read: bool = False
    write_globs: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class ExecEffects:
    """Bound a device's command and network effects."""

    commands: tuple[str, ...] = ()
    network: bool = False


@dataclass(frozen=True, slots=True)
class InferenceEffects:
    """Bound a device's inference effects."""

    max_requests: int = 0
    max_usd: float = 0.0


@dataclass(frozen=True, slots=True)
class Effects:
    """Declare a device's maximum static effect envelope."""

    documents: DocEffects | None = None
    exec: ExecEffects | None = None
    inference: InferenceEffects | None = None
    subagents: int = 0


class ConstraintKind(StrEnum):
    """Select the provider-side argument constraint requested by a tool."""

    SCHEMA = "schema"
    GRAMMAR = "grammar"


class ConstraintFallback(StrEnum):
    """Select behavior when a route cannot honor a tool constraint."""

    UNSPECIFIED = "unspecified"
    ERROR = "error"
    DROP = "drop"


class GrammarSyntax(StrEnum):
    """Identify the grammar syntax carried by a tool constraint."""

    LARK = "lark"
    REGEX = "regex"
    EBNF = "ebnf"
    GBNF = "gbnf"


@dataclass(frozen=True, slots=True)
class ToolConstraint:
    """Request constrained argument sampling for one declared tool."""

    kind: ConstraintKind = ConstraintKind.SCHEMA
    priority: int = 100
    syntax: GrammarSyntax | None = None
    definition: str | None = None
    on_unsupported: ConstraintFallback = ConstraintFallback.UNSPECIFIED

    def __post_init__(self) -> None:
        if not isinstance(self.kind, ConstraintKind):
            object.__setattr__(self, "kind", ConstraintKind(self.kind))
        if not isinstance(self.priority, int) or isinstance(self.priority, bool):
            raise TypeError("tool constraint priority must be int")
        if not 0 <= self.priority <= 255:
            raise ValueError("tool constraint priority must be between 0 and 255")
        if not isinstance(self.on_unsupported, ConstraintFallback):
            object.__setattr__(
                self,
                "on_unsupported",
                ConstraintFallback(self.on_unsupported),
            )
        if self.kind is ConstraintKind.SCHEMA:
            if self.syntax is not None or self.definition is not None:
                raise ValueError("schema constraints do not accept grammar fields")
            return
        if self.syntax is None or not isinstance(self.definition, str) or not self.definition:
            raise ValueError("grammar constraints require syntax and definition")
        if not isinstance(self.syntax, GrammarSyntax):
            object.__setattr__(self, "syntax", GrammarSyntax(self.syntax))

    @classmethod
    def schema(
        cls,
        *,
        priority: int = 100,
        on_unsupported: ConstraintFallback = ConstraintFallback.UNSPECIFIED,
    ) -> ToolConstraint:
        """Build a strict JSON-Schema sampling request."""
        return cls(priority=priority, on_unsupported=on_unsupported)

    @classmethod
    def grammar(
        cls,
        syntax: GrammarSyntax,
        definition: str,
        *,
        priority: int = 100,
        on_unsupported: ConstraintFallback = ConstraintFallback.UNSPECIFIED,
    ) -> ToolConstraint:
        """Build a grammar-constrained sampling request."""
        return cls(
            kind=ConstraintKind.GRAMMAR,
            priority=priority,
            syntax=syntax,
            definition=definition,
            on_unsupported=on_unsupported,
        )


class DocsMode(StrEnum):
    """Select how much device documentation is inlined."""

    CATALOG = "catalog"
    BUILTINS = "builtins"
    INLINE = "inline"


class DeviceError(ExtensionError):
    """A device declaration or runtime operation failed."""


class DeviceNameError(DeviceError):
    """Raised when a device name or precedence claim is invalid."""


class SchemaError(DeviceError, JournalError):
    """Raised when a device schema or example is invalid.

    Spans both documented taxonomies: schema failures surface while
    declaring or decoding a device (docs/py/01) and while decoding a
    journal-recorded call against its schema revision (docs/py/09).
    """


class PrecedenceConflict(DeviceError):
    """Raised when device claims cannot be ordered unambiguously."""


class DocsBudgetError(DeviceError):
    """Raised when device documentation exceeds its allowed budget."""


class DeviceUnavailable(DeviceError):
    """Raised when no mounted device satisfies a requested path."""


def _segment(value: str) -> str:
    if not isinstance(value, str) or not value:
        raise ValueError("device path segments must be non-empty strings")
    if (
        len(value) > 64
        or not ("a" <= value[0] <= "z")
        or any(
            not ("a" <= character <= "z" or "0" <= character <= "9" or character == "_")
            for character in value
        )
    ):
        raise ValueError(f"invalid device path segment {value!r}")
    return value


def _subpath(value: str) -> str:
    if not isinstance(value, str):
        raise TypeError("dynamic device subpath must be a string")
    parts = value.split("/")
    if not parts or any(not part for part in parts):
        raise ValueError(f"invalid dynamic device subpath {value!r}")
    return "/".join(_segment(part) for part in parts)


@dataclass(frozen=True, slots=True)
class ToolPath:
    """Identify one device-tree path and optional claimant."""

    name: str
    sub: str | None = None
    claimant: str | None = None

    def __post_init__(self) -> None:
        try:
            _segment(self.name)
            if self.sub is not None:
                _subpath(self.sub)
        except (TypeError, ValueError) as error:
            raise DeviceError(str(error)) from error
        if self.claimant is not None:
            if (
                not isinstance(self.claimant, str)
                or self.claimant.count("/") != 1
                or any(not part for part in self.claimant.split("/"))
            ):
                raise DeviceError(f"invalid device claimant {self.claimant!r}")

    def __str__(self) -> str:
        """Render the canonical model-facing device path."""
        rendered = self.name
        if self.sub is not None:
            rendered = f"{rendered}/{self.sub}"
        if self.claimant is not None:
            rendered = f"{rendered}@{self.claimant}"
        return rendered


@dataclass(frozen=True, slots=True)
class DeviceInfo:
    """Capture an immutable snapshot of one device claimant."""

    name: str
    family: str
    rev: int
    identity: str
    claimant: str
    path: ToolPath
    summary: str | None
    place: Place
    precedence: int
    tier: Tier
    effects: Effects | None
    mounted: bool
    enabled: bool
    available: bool
    reason: str | None
    shadowed_by: str | None
    source: str
    provenance: Provenance
    slotted: bool
    schema_bytes: int
    schema_tokens: int


_ROUTE_OVERRIDES = frozenset(
    {"family", "place", "precedence", "tier", "effects", "docs", "summary"}
)


@dataclass(frozen=True, slots=True)
class _Route:
    path: str
    body: Callable[..., Any]
    overrides: Mapping[str, object]


class Router:
    """Collect static child routes for later mounting below a device."""

    __slots__ = ("_routes", "prefix")

    def __init__(self, prefix: str) -> None:
        """Initialize a standalone router at one relative path prefix."""
        try:
            self.prefix = _subpath(prefix)
        except (TypeError, ValueError) as error:
            raise DeviceError(str(error)) from error
        self._routes: list[_Route] = []

    def subtool(
        self, path: str, **overrides: object
    ) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
        """Declare a route without requiring its parent device to exist yet."""
        try:
            route_path = _subpath(path)
        except (TypeError, ValueError) as error:
            raise DeviceError(str(error)) from error
        unknown = overrides.keys() - _ROUTE_OVERRIDES
        if unknown:
            raise TypeError(f"unknown subtool override {sorted(unknown)[0]!r}")
        frozen_overrides = MappingProxyType(dict(overrides))

        def decorate(body: Callable[..., Any]) -> Callable[..., Any]:
            if not callable(body):
                raise TypeError("Router.subtool may decorate only a callable")
            if any(route.path == route_path for route in self._routes):
                raise DeviceError(f"duplicate router path {route_path!r}")
            self._routes.append(_Route(route_path, body, frozen_overrides))
            return body

        return decorate


def router(prefix: str) -> Router:
    """Create a standalone static sub-router for mounting below a device."""
    return Router(prefix)


_catalog_view: contextvars.ContextVar[tuple[DeviceInfo, ...] | None] = (
    contextvars.ContextVar("omp_device_catalog_view", default=None)
)

_dynamic_bodies: dict[str, Callable[..., Any]] = {}


def _install_catalog_view(rows: Iterable[DeviceInfo] | None) -> None:
    """Install the host's immutable device-catalog view for this invocation."""
    if rows is None:
        _catalog_view.set(None)
        return
    frozen = tuple(rows)
    if any(not isinstance(row, DeviceInfo) for row in frozen):
        raise TypeError("device catalog rows must be DeviceInfo values")
    _catalog_view.set(frozen)


def _json_value(value: object, field: str) -> object:
    """Copy one value through JSON so CONTROL never sees Python-only objects."""
    try:
        return json.loads(
            json.dumps(value, separators=(",", ":"), allow_nan=False)
        )
    except (TypeError, ValueError) as error:
        raise TypeError(f"{field} must contain only JSON-serializable values") from error


def _path_from_wire(value: object) -> ToolPath:
    if not isinstance(value, str) or not value:
        raise DeviceError("device catalog path must be a non-empty string")
    path, marker, claimant = value.partition("@")
    root, separator, subpath = path.partition("/")
    return ToolPath(
        root,
        subpath if separator else None,
        claimant if marker else None,
    )


def _effects_from_wire(value: object) -> Effects | None:
    if value is None:
        return None
    if not isinstance(value, Mapping):
        raise DeviceError("device catalog effects must be a mapping or None")
    documents = value.get("documents")
    execution = value.get("exec")
    inference = value.get("inference")
    if documents is not None and not isinstance(documents, Mapping):
        raise DeviceError("device catalog document effects must be a mapping")
    if execution is not None and not isinstance(execution, Mapping):
        raise DeviceError("device catalog exec effects must be a mapping")
    if inference is not None and not isinstance(inference, Mapping):
        raise DeviceError("device catalog inference effects must be a mapping")
    return Effects(
        documents=DocEffects(
            read=bool(documents.get("read", False)),
            write_globs=tuple(documents.get("write_globs", ())),
        ) if documents is not None else None,
        exec=ExecEffects(
            commands=tuple(execution.get("commands", ())),
            network=bool(execution.get("network", False)),
        ) if execution is not None else None,
        inference=InferenceEffects(
            max_requests=int(inference.get("max_requests", 0)),
            max_usd=float(inference.get("max_usd", 0.0)),
        ) if inference is not None else None,
        subagents=int(value.get("subagents", 0)),
    )


def _catalog_row_from_wire(value: object) -> DeviceInfo:
    if not isinstance(value, Mapping):
        raise DeviceError("device catalog rows must be mappings")
    provenance = value.get("provenance")
    if not isinstance(provenance, Mapping):
        raise DeviceError("device catalog provenance must be a mapping")

    def string(row: Mapping[object, object], key: str) -> str:
        item = row.get(key)
        if not isinstance(item, str):
            raise TypeError(f"device catalog {key} must be str")
        return item

    def integer(row: Mapping[object, object], key: str) -> int:
        item = row.get(key)
        if not isinstance(item, int) or isinstance(item, bool):
            raise TypeError(f"device catalog {key} must be int")
        return item

    def boolean(key: str) -> bool:
        item = value.get(key)
        if not isinstance(item, bool):
            raise TypeError(f"device catalog {key} must be bool")
        return item

    def optional_string(key: str) -> str | None:
        item = value.get(key)
        if item is not None and not isinstance(item, str):
            raise TypeError(f"device catalog {key} must be str or None")
        return item

    try:
        return DeviceInfo(
            name=string(value, "name"),
            family=string(value, "family"),
            rev=integer(value, "rev"),
            identity=string(value, "identity"),
            claimant=string(value, "claimant"),
            path=_path_from_wire(value["path"]),
            summary=optional_string("summary"),
            place=Place.parse(value["place"]),
            precedence=integer(value, "precedence"),
            tier=Tier(value["tier"]),
            effects=_effects_from_wire(value.get("effects")),
            mounted=boolean("mounted"),
            enabled=boolean("enabled"),
            available=boolean("available"),
            reason=optional_string("reason"),
            shadowed_by=optional_string("shadowed_by"),
            source=string(value, "source"),
            provenance=Provenance(
                publisher=string(provenance, "publisher"),
                extension_id=string(provenance, "extension_id"),
                version=string(provenance, "version"),
                artifact_digest=string(provenance, "artifact_digest"),
                layer=string(provenance, "layer"),
                tier=string(provenance, "tier"),
                generation=integer(provenance, "generation"),
            ),
            slotted=boolean("slotted"),
            schema_bytes=integer(value, "schema_bytes"),
            schema_tokens=integer(value, "schema_tokens"),
        )
    except (KeyError, TypeError, ValueError) as error:
        raise DeviceError("omp.devices returned an invalid catalog row") from error


def _accept_catalog_response(
    response: object,
    *,
    operation: str,
) -> tuple[DeviceInfo, ...]:
    if not isinstance(response, Mapping):
        raise DeviceError(f"{operation} returned an invalid response")
    catalog = response.get("catalog")
    if (
        not isinstance(catalog, Iterable)
        or isinstance(catalog, (str, bytes, Mapping))
    ):
        raise DeviceError(f"{operation} returned no authoritative catalog")
    rows = tuple(_catalog_row_from_wire(row) for row in catalog)
    _install_catalog_view(rows)
    return rows


async def _dispatch_device(
    path: str,
    args: Mapping[str, object],
    *,
    family: str | None = None,
    rev: int | None = None,
) -> object:
    """Run one host-placed body selected by the authoritative router."""
    if not isinstance(path, str) or not path:
        raise DeviceUnavailable("dynamic device callback omitted its path")
    if not isinstance(args, Mapping):
        raise SchemaError("dynamic device callback args must be a mapping")
    body = _dynamic_bodies.get(path)
    legacy = False
    if body is None:
        candidates = tuple(
            definition
            for definition in registry.snapshot().device_definitions
            if definition.name == path
            and (family is None or definition.family == family)
            and (rev is None or definition.rev == rev)
        )
        if len(candidates) == 1:
            body = candidates[0].body
        else:
            legacy_candidates = tuple(
                definition.handler
                for definition in registry.worker_tool_definitions()
                if definition.legacy
                and definition.name == path
                and (family is None or definition.family == family)
                and (rev is None or definition.rev == rev)
            )
            if len(legacy_candidates) == 1:
                body = legacy_candidates[0]
                legacy = True
        if body is None:
            raise DeviceUnavailable(
                f"authoritative catalog selected unknown or ambiguous "
                f"host device {path!r}"
            )
    if hasattr(body, "__omp_tool_kind__"):
        # Parity with the stdio worker path: ergonomic tools receive the
        # ambient invocation context in their `ctx` parameter.
        from . import Context
        from ._registry import _bind_tool_arguments

        try:
            context = Context.current()
        except LookupError:
            context = None
        positional, keywords = _bind_tool_arguments(body, dict(args), context)
        result = body(*positional, **keywords)
    else:
        result = body(dict(args)) if legacy else body(**dict(args))
    if inspect.isawaitable(result):
        result = await result
    from ._registry import _lower_worker_result

    return _lower_worker_result(result)


def _declared_rows() -> tuple[DeviceInfo, ...]:
    snapshot = registry.snapshot()
    states = {
        key: (mounted, reason) for key, mounted, reason in snapshot.device_states
    }
    extension_id = registry.extension_id or ""
    provenance = Provenance(
        publisher="",
        extension_id=extension_id,
        version="",
        artifact_digest="",
        layer="extension",
        tier="extension",
        generation=0,
    )
    rows: list[DeviceInfo] = []
    for definition in snapshot.device_definitions:
        key = (definition.name, definition.family, definition.rev)
        mounted, reason = states[key]
        root, separator, subpath = definition.name.partition("/")
        body = definition.body
        rows.append(
            DeviceInfo(
                name=definition.name,
                family=definition.family,
                rev=definition.rev,
                identity=(
                    f"{definition.name}@"
                    f"{definition.family or definition.name}/{definition.rev}"
                ),
                claimant=extension_id,
                path=ToolPath(root, subpath if separator else None),
                summary=definition.summary,
                place=definition.place,
                precedence=definition.precedence,
                tier=definition.tier,
                effects=definition.effects,
                mounted=mounted,
                enabled=mounted,
                available=mounted,
                reason=reason,
                shadowed_by=None,
                source=extension_id,
                provenance=provenance,
                slotted=getattr(body, "__omp_tool_kind__", "soft") == "hard",
                schema_bytes=0,
                schema_tokens=0,
            )
        )
    return tuple(rows)


class Device:
    """Provide the live handle returned by ``@omp.device``."""

    __slots__ = (
        "body",
        "docs",
        "enabled",
        "family",
        "identity",
        "lift",
        "mounted",
        "name",
        "path",
        "place",
        "precedence",
        "replaces",
        "rev",
        "schema",
        "prompt",
        "shadowed_by",
        "shadows",
        "summary",
    )

    def __init__(
        self,
        *,
        name: str,
        family: str,
        rev: int,
        place: Place,
        precedence: int,
        replaces: str | None,
        schema: type | dict[str, object] | None,
        docs: object | None,
        summary: str | None,
        body: Callable[..., Any],
    ) -> None:
        """Initialize one declared device handle."""
        self.name = name
        self.family = family
        self.rev = rev
        self.identity = f"{name}@{family or name}/{rev}"
        root, separator, subpath = name.partition("/")
        self.path = ToolPath(root, subpath if separator else None)
        self.place = place
        self.precedence = precedence
        self.replaces = replaces
        self.schema = schema
        self.docs = docs
        self.summary = summary
        self.body = body
        self.enabled = True
        self.mounted = False
        # Projection hooks per docs/py/02 §Projecting for the model: a device
        # that declares a Payload assigns its pure `prompt(view, caps)` here;
        # `lift(from_rev, call)` re-expresses historical calls across revisions.
        self.prompt = None
        self.lift = None
        self.shadows = ()
        self.shadowed_by = None

    def enable(self) -> None:
        """Enable this device for the host's FREEZE projection."""
        registry.set_device_enabled(self.name, self.family, self.rev, True)
        self.enabled = True

    def disable(self, reason: str | None = None) -> None:
        """Disable this device for the host's FREEZE projection."""
        registry.set_device_enabled(
            self.name, self.family, self.rev, False, reason=reason
        )
        self.enabled = False

    def subtool(
        self, path: str, **overrides: object
    ) -> Callable[[Callable[..., Any]], Device]:
        """Declare a static child route below this device's path."""
        try:
            route_path = _subpath(path)
        except (TypeError, ValueError) as error:
            raise DeviceError(str(error)) from error
        unknown = overrides.keys() - _ROUTE_OVERRIDES
        if unknown:
            raise TypeError(f"unknown subtool override {sorted(unknown)[0]!r}")
        frozen_overrides = MappingProxyType(dict(overrides))

        def decorate(body: Callable[..., Any]) -> Device:
            if not callable(body):
                raise TypeError("Device.subtool may decorate only a callable")
            return self._register_route(route_path, body, frozen_overrides)

        return decorate

    def mount(self, mounted_router: Router) -> tuple[Device, ...]:
        """Mount every standalone-router route below this device."""
        if not isinstance(mounted_router, Router):
            raise TypeError("Device.mount expects an omp.Router")
        if registry.sealed:
            raise DeclarationSealed(self.name)
        return tuple(
            self._register_route(
                f"{mounted_router.prefix}/{route.path}",
                route.body,
                route.overrides,
            )
            for route in mounted_router._routes
        )

    def _register_route(
        self,
        path: str,
        body: Callable[..., Any],
        overrides: Mapping[str, object],
    ) -> Device:
        from ._registry import DeviceDefinition

        parent = registry.device_definition(self.name, self.family, self.rev)
        family = overrides.get("family", parent.family)
        if not isinstance(family, str):
            raise TypeError("subtool family must be a string")
        place_value = overrides.get("place", parent.place)
        try:
            place = Place.parse(place_value)
        except (TypeError, ValueError) as error:
            raise DeviceError(str(error)) from error
        precedence = overrides.get("precedence", parent.precedence)
        if isinstance(precedence, bool) or not isinstance(precedence, int):
            raise TypeError("subtool precedence must be an int")
        if precedence >= Precedence.CORE:
            raise DeviceNameError(
                f"subtool precedence must be below Precedence.CORE: {precedence}"
            )
        tier = overrides.get("tier", parent.tier)
        if not isinstance(tier, Tier):
            raise TypeError("subtool tier must be an omp.Tier")
        effects = overrides.get("effects", parent.effects)
        if effects is not None and not isinstance(effects, Effects):
            raise TypeError("subtool effects must be omp.Effects or None")
        docs = overrides.get("docs", parent.docs)
        summary = overrides.get("summary", parent.summary)
        if summary is not None and not isinstance(summary, str):
            raise TypeError("subtool summary must be a string or None")

        child_name = f"{self.name}/{path}"
        handle = Device(
            name=child_name,
            family=family,
            rev=self.rev,
            place=place,
            precedence=precedence,
            replaces=None,
            schema=None,
            docs=docs,
            summary=summary,
            body=body,
        )
        definition = DeviceDefinition(
            name=child_name,
            family=family,
            rev=self.rev,
            place=place,
            summary=summary,
            docs=docs,
            schema=None,
            examples=(),
            available=None,
            precedence=precedence,
            replaces=None,
            intents=parent.intents,
            effects=effects,
            tier=tier,
            deadline=parent.deadline,
            aliases=None,
            constraint=parent.constraint,
            serial=parent.serial,
            body=body,
        )
        registry.register_child_device(
            (self.name, self.family, self.rev),
            path,
            handle,
            definition=definition,
        )
        return handle

    async def __call__(self, *args: Any, **kwargs: Any) -> Any:
        """Invoke the decorated body directly in process."""
        return await self.body(*args, **kwargs)


@dataclass(frozen=True, slots=True)
class MountSpec:
    """One runtime-discovered leaf relative to a declared parent."""

    subpath: str
    body: Callable[..., Any]
    schema: Mapping[str, object]
    summary: str
    docs: str | None = None

    def __post_init__(self) -> None:
        object.__setattr__(self, "subpath", _subpath(self.subpath))
        if not callable(self.body):
            raise TypeError("dynamic device body must be callable")
        if not isinstance(self.schema, Mapping):
            raise TypeError("dynamic device schema must be a mapping")
        schema = _json_value(dict(self.schema), "dynamic device schema")
        if not isinstance(schema, dict):
            raise TypeError("dynamic device schema must encode as a JSON object")
        object.__setattr__(self, "schema", MappingProxyType(schema))
        if not isinstance(self.summary, str):
            raise TypeError("dynamic device summary must be a string")
        if self.docs is not None and not isinstance(self.docs, str):
            raise TypeError("dynamic device docs must be a string or None")


@dataclass(frozen=True, slots=True)
class AvailabilityDelta:
    """One desired mountedness change in a batched availability transition."""

    path: str
    mounted: bool
    reason: str | None = None

    def __post_init__(self) -> None:
        if not isinstance(self.path, str) or not self.path:
            raise ValueError("availability path must be a non-empty string")
        if not isinstance(self.mounted, bool):
            raise TypeError("availability mounted must be bool")
        if self.reason is not None and not isinstance(self.reason, str):
            raise TypeError("availability reason must be a string or None")
        if self.mounted and self.reason is not None:
            raise ValueError("an available device cannot carry an unavailable reason")


@dataclass(frozen=True, slots=True)
class DynamicDeviceParent:
    """Manifest-authorized top-level parent for post-FREEZE discovered leaves."""

    name: str
    family: str
    rev: int
    place: str

    def path(self, subpath: str) -> str:
        """Return the canonical absolute path for one relative leaf."""
        return f"{self.name}/{_subpath(subpath)}"

    async def mount_many(self, *specs: MountSpec) -> tuple[str, ...]:
        """Atomically mount discovered leaves beneath this frozen parent."""
        from . import _control_backend, _control_request

        if _control_backend.get() is None:
            raise NotWiredError("omp.devices.dynamic_mount")
        if any(not isinstance(spec, MountSpec) for spec in specs):
            raise TypeError("mount_many expects only omp.MountSpec values")
        paths = tuple(self.path(spec.subpath) for spec in specs)
        if len(set(paths)) != len(paths):
            raise DeviceError("dynamic mount contains duplicate paths")
        if any(path in _dynamic_bodies for path in paths):
            raise DeviceError("dynamic device path is already mounted")

        staged = {
            path: spec.body
            for path, spec in zip(paths, specs, strict=True)
        }
        _dynamic_bodies.update(staged)
        try:
            response = await _control_request(
                "omp.devices.dynamic_mount",
                parent={
                    "name": self.name,
                    "family": self.family,
                    "rev": self.rev,
                    "place": self.place,
                },
                specs=[
                    {
                        "path": path,
                        "subpath": spec.subpath,
                        "schema": dict(spec.schema),
                        "summary": spec.summary,
                        "docs": spec.docs,
                    }
                    for path, spec in zip(paths, specs, strict=True)
                ],
            )
            if not isinstance(response, Mapping):
                raise DeviceError(
                    "omp.devices.dynamic_mount returned an invalid response"
                )
            returned = response.get("paths")
            if (
                not isinstance(returned, Iterable)
                or isinstance(returned, (str, bytes, Mapping))
                or tuple(returned) != paths
            ):
                raise DeviceError(
                    "omp.devices.dynamic_mount returned mismatched paths"
                )
            _accept_catalog_response(
                response, operation="omp.devices.dynamic_mount"
            )
        except BaseException:
            for path, body in staged.items():
                if _dynamic_bodies.get(path) is body:
                    _dynamic_bodies.pop(path, None)
            raise
        return paths

    async def mount(self, spec: MountSpec) -> str:
        """Mount one discovered leaf through the same runtime operation."""
        mounted, = await self.mount_many(spec)
        return mounted


class Devices:
    """Static parent declarations plus the session-scoped mounted-set surface."""

    HARD_SLOT_BUDGET = HARD_SLOT_BUDGET
    EXTERNAL_SUMMARY_CAP = EXTERNAL_SUMMARY_CAP
    PER_DEVICE_CAP = PER_DEVICE_CAP

    __slots__ = ()

    def parent(
        self,
        name: str,
        *,
        family: str,
        rev: int,
        place: str = "host",
    ) -> DynamicDeviceParent:
        """Declare a manifest-backed dynamic parent during IMPORT."""
        try:
            parsed_place = Place.parse(place)
        except (TypeError, ValueError) as error:
            raise DeviceError(str(error)) from error
        if not isinstance(family, str):
            raise TypeError("dynamic device family must be a string")
        if not isinstance(rev, int) or isinstance(rev, bool):
            raise TypeError("dynamic device rev must be int")
        parent = DynamicDeviceParent(
            _segment(name), family, rev, str(parsed_place)
        )
        registry.register_tool(parent.name, parent.family, parent.rev, parent)
        return parent

    async def set_availability(self, *deltas: AvailabilityDelta) -> None:
        """Apply one atomic mounted-set transition for all supplied deltas."""
        from . import _control_backend, _control_request

        if _control_backend.get() is None:
            raise NotWiredError("omp.devices.set_availability")
        if any(not isinstance(delta, AvailabilityDelta) for delta in deltas):
            raise TypeError("set_availability expects omp.AvailabilityDelta values")
        response = await _control_request(
            "omp.devices.set_availability",
            deltas=[
                {
                    "path": delta.path,
                    "mounted": delta.mounted,
                    "reason": delta.reason,
                }
                for delta in deltas
            ],
        )
        _accept_catalog_response(
            response, operation="omp.devices.set_availability"
        )

    async def enable(self, *paths: str) -> None:
        """Enable paths as one availability transition."""
        await self.set_availability(
            *(AvailabilityDelta(path, True) for path in paths)
        )

    async def disable(self, *paths: str, reason: str | None = None) -> None:
        """Disable paths as one availability transition with one reason."""
        await self.set_availability(
            *(AvailabilityDelta(path, False, reason) for path in paths)
        )

    async def refresh(self) -> tuple[DeviceInfo, ...]:
        """Recompute ordinary availability predicates as one transition."""
        from . import _control_backend, _control_request

        if _control_backend.get() is None:
            raise NotWiredError("omp.devices.refresh")
        response = await _control_request("omp.devices.refresh")
        return _accept_catalog_response(response, operation="omp.devices.refresh")

    async def invoke(
        self,
        path: str,
        args: Mapping[str, object],
        *,
        deadline: Duration | None = None,
    ) -> object:
        """Invoke a device through the independently gated host dispatcher.

        Every inner call receives its own admission and policy decision; it
        inherits no ambient authority from the parent invocation. This
        CONTROL+DATA surface is legal only in host placement. The host rejects
        calls from ``place="env"`` and named-worker placements.
        """
        from . import _control_backend, _control_request

        if _control_backend.get() is None:
            raise NotWiredError("omp.devices.invoke")
        if not isinstance(path, str) or not path:
            raise ValueError("device invocation path must be a non-empty string")
        if not isinstance(args, Mapping):
            raise TypeError("device invocation args must be a mapping")
        if deadline is not None and not isinstance(deadline, Duration):
            raise TypeError("device invocation deadline must be omp.Duration or None")
        encoded_args = _json_value(dict(args), "device invocation args")
        return await _control_request(
            "omp.devices.invoke",
            path=path,
            args=encoded_args,
            deadline=str(deadline) if deadline is not None else None,
        )

    def list(self, *, mounted_only: bool = True) -> tuple[DeviceInfo, ...]:
        """Return immutable catalog rows, optionally including unmounted claims."""
        declared = _declared_rows()
        installed = _catalog_view.get()
        if installed is None:
            rows = declared
        else:
            rows_by_identity = {str(row.path): row for row in installed}
            rows_by_identity.update(
                {
                    str(row.path): row
                    for row in declared
                    if str(row.path) not in rows_by_identity
                }
            )
            rows = tuple(rows_by_identity.values())
        if mounted_only:
            return tuple(row for row in rows if row.mounted)
        return rows


# One namespace instance ensures every dynamic path uses the ordinary mounted set.
devices = Devices()

__all__ = (
    "Availability",
    "AvailabilityDelta",
    "ConstraintFallback",
    "ConstraintKind",
    "Device",
    "DeviceError",
    "DeviceInfo",
    "DeviceNameError",
    "DeviceUnavailable",
    "Devices",
    "DocsBudgetError",
    "DocsMode",
    "DocEffects",
    "DynamicDeviceParent",
    "EXTERNAL_SUMMARY_CAP",
    "HARD_SLOT_BUDGET",
    "Effects",
    "Example",
    "ExecEffects",
    "GrammarSyntax",
    "InferenceEffects",
    "MountSpec",
    "PER_DEVICE_CAP",
    "Precedence",
    "PrecedenceConflict",
    "Router",
    "SchemaError",
    "ToolPath",
    "ToolConstraint",
    "router",
    "devices",
)
