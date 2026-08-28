"""Frozen extension declarations and manifest-gated CONTROL services.

Importing this module performs no I/O and does not open either host socket. The
host installs its existing CONTROL request transport only after declaration
verification; journal entries and agent messages are never accepted as service
transports.
"""

from __future__ import annotations

import importlib
import inspect
import json
from collections.abc import Awaitable, Callable, Iterable, Mapping
from dataclasses import MISSING, dataclass, fields, is_dataclass, replace
from enum import Enum, StrEnum
from types import UnionType
from typing import (
    Annotated,
    Any,
    Literal,
    Protocol,
    TypeVar,
    Union,
    get_args,
    get_origin,
    get_type_hints,
)

from _omp import QuotaStatus, ResourceReceipt, resources


from . import QuotaExceeded
from ._errors import (
    CapabilityError,
    DeclarationLimit,
    DeclarationSealed,
    DuplicateRegistration,
    ExtensionError,
    ManifestError,
    SpecError,
)
from . import packages as _packages


_T = TypeVar("_T", bound=type)
_ToolKey = tuple[str, str, int]
_HookKey = tuple[str, str]
_EntryKindKey = tuple[str, str]
_ServiceKey = tuple[str, int]
_ProviderKey = str
_WorkerKey = str


class _ActivationTrigger(StrEnum):
    """Closed manifest vocabulary for declaration activation."""

    STATIC = "static"
    LAZY = "lazy"
    EAGER_PROMPT = "eager-prompt"
    EAGER_UI = "eager-ui"


_EXECUTABLE_KINDS = frozenset(
    {
        "soft",
        "hard",
        "hook",
        "regime",
        "worker",
        "provider",
        "prompt_slot",
        "command",
        "shortcut",
        "completion",
        "message_renderer",
        "verdict_renderer",
        "telemetry",
        "service",
    }
)
_CONTENT_KINDS = frozenset({"skills", "rules", "context-files", "prompts"})


@dataclass(frozen=True, slots=True)
class _ExecutableDeclaration:
    """One validated executable row from the uniform manifest table."""

    declaration_id: str
    kind: str
    module: str
    key: str
    trigger: _ActivationTrigger
    api: int
    failure: str


MAX_DECLARATIONS = 256
"""Maximum decorator declarations accepted from one extension."""

@dataclass(frozen=True, slots=True)
class ManifestTableSchema:
    """Ratified authoring spelling for one projected manifest table."""

    table: str
    fields: frozenset[str]


TELEMETRY_MANIFEST_SCHEMA = ManifestTableSchema(
    table="telemetry",
    fields=frozenset({"kinds", "scope", "queue", "overflow"}),
)
"""The ratified ``[[telemetry]]`` authoring row and its required fields."""

SCHEDULES_PROJECT_CAPABILITY = "schedules:project"
"""The ratified capability key granting project-scoped schedules."""


class DeclarationDrift(ExtensionError, RuntimeError):
    """The frozen decorator existence sets differ from the manifest."""

    def __init__(
        self,
        *,
        missing_tools: frozenset[_ToolKey],
        undeclared_tools: frozenset[_ToolKey],
        missing_hooks: frozenset[_HookKey],
        undeclared_hooks: frozenset[_HookKey],
        missing_services: frozenset[_ServiceKey],
        undeclared_services: frozenset[_ServiceKey],
        missing_declarations: frozenset[tuple[str, str]],
        undeclared_declarations: frozenset[tuple[str, str]],
    ) -> None:
        groups = (
            ("missing tools", missing_tools),
            ("undeclared tools", undeclared_tools),
            ("missing hooks", missing_hooks),
            ("undeclared hooks", undeclared_hooks),
            ("missing services", missing_services),
            ("undeclared services", undeclared_services),
            ("missing declarations", missing_declarations),
            ("undeclared declarations", undeclared_declarations),
        )
        detail = "; ".join(
            f"{label}: {', '.join(repr(item) for item in sorted(items))}"
            for label, items in groups
            if items
        )
        super().__init__(f"frozen declarations differ from the manifest: {detail}")
        self.missing_tools = missing_tools
        self.undeclared_tools = undeclared_tools
        self.missing_hooks = missing_hooks
        self.undeclared_hooks = undeclared_hooks
        self.missing_services = missing_services
        self.undeclared_services = undeclared_services
        self.missing_declarations = missing_declarations
        self.undeclared_declarations = undeclared_declarations


@dataclass(frozen=True, slots=True)
class ServiceMethodDefinition:
    """Structural wire contract for one public service method."""

    name: str
    input_schema: Mapping[str, object]
    result_schema: Mapping[str, object]


@dataclass(frozen=True, slots=True)
class ServiceDefinition:
    """One sealed ``@omp.service`` implementation."""

    name: str
    rev: int
    implementation: type
    methods: tuple[str, ...]
    method_schemas: tuple[ServiceMethodDefinition, ...]
    trigger: _ActivationTrigger = _ActivationTrigger.LAZY

@dataclass(frozen=True, slots=True)
class EntryKindDefinition:
    """One import-time ``@omp.entry_kind`` declaration."""

    name: str
    rev: str
    display: bool | None
    spill: bool
    implementation: type
    trigger: _ActivationTrigger = _ActivationTrigger.LAZY
@dataclass(frozen=True, slots=True)
class ProviderDefinition:
    """One import-time ``@omp.provider`` declaration."""

    id: str
    spec: object
    implementation: type | None
    priority: int
    extends: str | None
    replaces: str | None
    trigger: _ActivationTrigger = _ActivationTrigger.LAZY


@dataclass(frozen=True, slots=True)
class CommandDefinition:
    """One import-time slash-command declaration and its dispatch callbacks."""

    name: str
    aliases: tuple[str, ...]
    description: str
    args: tuple[object, ...]
    hint: str | None
    arg_completions: object | None
    handler: object
    trigger: _ActivationTrigger = _ActivationTrigger.LAZY

@dataclass(frozen=True, slots=True)
class ShortcutDefinition:
    """One import-time shortcut declaration and its dispatch callback."""

    chord: str
    action_id: str
    description: str
    when: frozenset[object] | None
    handler: object
    trigger: _ActivationTrigger = _ActivationTrigger.LAZY


@dataclass(frozen=True, slots=True)
class WorkerDefinition:
    """One import-time ``omp.workers.declare`` declaration."""

    name: str
    spec: object
    trigger: _ActivationTrigger = _ActivationTrigger.LAZY

@dataclass(frozen=True, slots=True)
class ArgSpec:
    """Immutable metadata for one argument path of a device revision."""

    path: tuple[str | int, ...]
    aliases: tuple[str, ...]
    coerce: tuple[object, ...]
    expected: str | None
    example: str | None
    description: str | None
    additional_properties: bool


@dataclass(frozen=True, slots=True)
class DeviceDefinition:
    """One import-time static device declaration."""

    name: str
    family: str
    rev: int
    place: object
    summary: str | None
    docs: object | None
    schema: object | None
    examples: tuple[object, ...]
    available: object | None
    precedence: int
    replaces: str | None
    intents: tuple[object, ...]
    effects: object | None
    tier: object
    deadline: object | None
    aliases: Mapping[str, str] | None
    body: object
    arg_specs: tuple[ArgSpec, ...] = ()
    trigger: _ActivationTrigger = _ActivationTrigger.LAZY


@dataclass(frozen=True, slots=True)
class PreludeParamSpec:
    """Immutable metadata for one eval-prelude helper parameter."""

    name: str
    kind: str
    default_json: str | None
    annotation: str | None


@dataclass(frozen=True, slots=True)
class PreludeDefinition:
    """One import-time eval-prelude helper declaration."""

    name: str
    rev: int
    doc: str
    summary: str
    params: tuple[PreludeParamSpec, ...]
    body: object
    handler: object
    module: str


@dataclass(frozen=True, slots=True)
class WorkerToolDefinition:
    """One runnable tool projection retained by the sealed worker registry."""

    name: str
    family: str
    rev: int
    description: str
    schema: object
    strict: bool | None
    streams_args: bool
    handler: object
    source_module: str
    place: object
    legacy: bool = False
    # The device name this revision replaces, when its claim chain names one;
    # the host admission gate verifies the chain from this projection.
    replaces: str | None = None


@dataclass(frozen=True, slots=True)
class ChildDeviceDefinition:
    """One static route projected below a declared parent device."""

    parent: _ToolKey
    path: str
    definition: DeviceDefinition
    trigger: _ActivationTrigger = _ActivationTrigger.LAZY


@dataclass(frozen=True, slots=True)
class ExportDefinition:
    """One import-time telemetry export declaration."""

    target: object
    kinds: tuple[str, ...]
    sample: float
    trigger: _ActivationTrigger = _ActivationTrigger.LAZY




@dataclass(frozen=True, slots=True)
class TelemetryDefinition:
    """One import-time ``@omp.telemetry`` subscription declaration."""

    kinds: tuple[str, ...]
    scope: str
    queue: int
    overflow: str
    coalesce_key: object | None
    batch: int | None
    replay: bool
    replay_limit: int
    handler: object
    trigger: _ActivationTrigger = _ActivationTrigger.LAZY


@dataclass(frozen=True, slots=True)
class PromptSlotDefinition:
    """One import-time ``@omp.prompt_slot`` contribution declaration."""

    slot: str
    priority: int
    cls: str
    renderer: object
    trigger: _ActivationTrigger = _ActivationTrigger.EAGER_PROMPT


@dataclass(frozen=True, slots=True)
class ApproverDefinition:
    """One import-time ``@omp.approver`` declaration."""

    name: str
    kinds: tuple[object, ...]
    timeout: object
    unreachable: object
    handler: object
    trigger: _ActivationTrigger = _ActivationTrigger.LAZY


@dataclass(frozen=True, slots=True)
class HookDefinition:
    """One import-time hook subscription and its activation trigger."""

    event: str
    phase: str
    handler: object
    trigger: _ActivationTrigger


@dataclass(frozen=True, slots=True)
class UIDefinition:
    """One UI callback declaration stored by the shared registry."""

    kind: str
    name: object
    value: object
    trigger: _ActivationTrigger


@dataclass(frozen=True, slots=True)
class DeclarationSnapshot:
    """Immutable view of the complete decorator registry."""

    entry_kinds: tuple[EntryKindDefinition, ...]
    tools: frozenset[_ToolKey]
    capabilities: frozenset[str]
    hooks: frozenset[_HookKey]
    services: frozenset[_ServiceKey]
    preludes: tuple[PreludeDefinition, ...] = ()
    telemetry: tuple[TelemetryDefinition, ...] = ()
    commands: tuple[CommandDefinition, ...] = ()
    shortcuts: tuple[ShortcutDefinition, ...] = ()
    prompt_slots: tuple[PromptSlotDefinition, ...] = ()
    providers: tuple[ProviderDefinition, ...] = ()
    workers: tuple[WorkerDefinition, ...] = ()
    device_definitions: tuple[DeviceDefinition, ...] = ()
    child_device_definitions: tuple[ChildDeviceDefinition, ...] = ()
    exports: tuple[ExportDefinition, ...] = ()
    approvers: tuple[ApproverDefinition, ...] = ()
    device_states: tuple[tuple[_ToolKey, bool, str | None], ...] = ()
    arg_specs: tuple[tuple[_ToolKey, tuple[ArgSpec, ...]], ...] = ()
    hook_definitions: tuple[HookDefinition, ...] = ()
    service_definitions: tuple[ServiceDefinition, ...] = ()
    completions: tuple[UIDefinition, ...] = ()
    message_renderers: tuple[UIDefinition, ...] = ()
    verdict_renderers: tuple[UIDefinition, ...] = ()
    regimes: tuple[object, ...] = ()


class DeclarationRegistry:
    """Process-local declaration authority sealed exactly once at FREEZE."""

    __slots__ = (
        "_approvers",
        "_configured",
        "_commands",
        "_completions",
        "_message_renderers",
        "_verdict_renderers",
        "_shortcuts",
        "_device_claims",
        "_device_definitions",
        "_child_device_definitions",
        "_device_states",
        "_entry_kinds",
        "_export_sequence",
        "_exports",
        "_extension_id",
        "_providers",
        "_provider_candidates",
        "_hooks",
        "_hook_definitions",
        "_regimes",
        "_prompt_slots",
        "_preludes",
        "_telemetry",
        "_manifest_hooks",
        "_manifest_capabilities",
        "_manifest_executables",
        "_uniform_manifest_configured",
        "_manifest_requires",
        "_manifest_services",
        "_manifest_tools",
        "_legacy_worker_tools",
        "_sealed",
        "_service_instances",
        "_services",
        "_tools",
        "_workers",
        "_verified",
    )

    def __init__(self) -> None:
        self._configured = False
        self._sealed = False
        self._verified = False
        self._approvers: dict[str, ApproverDefinition] = {}
        self._commands: dict[str, CommandDefinition] = {}
        self._completions: dict[object, UIDefinition] = {}
        self._message_renderers: dict[object, UIDefinition] = {}
        self._verdict_renderers: dict[object, UIDefinition] = {}
        self._shortcuts: dict[str, ShortcutDefinition] = {}
        self._tools: dict[_ToolKey, object] = {}
        self._device_definitions: dict[_ToolKey, DeviceDefinition] = {}
        self._child_device_definitions: dict[_ToolKey, ChildDeviceDefinition] = {}
        self._device_claims: dict[
            str, list[tuple[int, str | None, _ToolKey]]
        ] = {}
        self._device_states: dict[_ToolKey, tuple[bool, str | None]] = {}
        self._entry_kinds: dict[_EntryKindKey, EntryKindDefinition] = {}
        self._provider_candidates: dict[_ProviderKey, list[ProviderDefinition]] = {}
        self._providers: dict[_ProviderKey, ProviderDefinition] = {}
        self._hooks: dict[_HookKey, object] = {}
        self._hook_definitions: dict[_HookKey, HookDefinition] = {}
        self._regimes: dict[str, object] = {}
        self._telemetry: dict[str, TelemetryDefinition] = {}
        self._exports: dict[int, ExportDefinition] = {}
        self._export_sequence = 0
        self._extension_id: str | None = None
        self._prompt_slots: dict[tuple[str, str], PromptSlotDefinition] = {}
        self._preludes: dict[str, PreludeDefinition] = {}
        self._services: dict[_ServiceKey, ServiceDefinition] = {}
        self._workers: dict[_WorkerKey, WorkerDefinition] = {}
        self._service_instances: dict[_ServiceKey, object] = {}
        self._manifest_tools: frozenset[_ToolKey] = frozenset()
        self._manifest_hooks: frozenset[_HookKey] = frozenset()
        self._manifest_capabilities: frozenset[str] = frozenset()
        self._manifest_services: frozenset[_ServiceKey] = frozenset()
        self._manifest_executables: dict[
            tuple[str, str], _ExecutableDeclaration
        ] = {}
        self._uniform_manifest_configured = False
        self._manifest_requires: frozenset[_ServiceKey] = frozenset()
        self._legacy_worker_tools: dict[_ToolKey, WorkerToolDefinition] = {}

    @property
    def sealed(self) -> bool:
        """Whether FREEZE has made every declaration immutable."""

        return self._sealed
    @property
    def extension_id(self) -> str | None:
        """Return the configured extension identity, if any."""

        return self._extension_id

    @property
    def required_services(self) -> frozenset[_ServiceKey]:
        """Manifest-granted service dependencies for this extension."""

        return self._manifest_requires

    def configure_manifest(
        self,
        *,
        tools: Iterable[_ToolKey] = (),
        hooks: Iterable[_HookKey] = (),
        capabilities: Iterable[str] = (),
        services: Iterable[_ServiceKey] = (),
        requires: Iterable[_ServiceKey] = (),
        declarations: Iterable[
            _packages.ContentDeclaration | Mapping[str, object]
        ] | None = None,
        extension: str | None = None,
    ) -> None:
        """Install authoritative manifest sets before the first module import."""

        self._ensure_open("manifest")
        content_declarations: list[_packages.ContentDeclaration] = []
        executable_declarations: dict[
            tuple[str, str], _ExecutableDeclaration
        ] = {}
        if declarations is not None:
            for index, declaration in enumerate(declarations):
                if isinstance(declaration, _packages.ContentDeclaration):
                    content_declarations.append(declaration)
                    continue
                if not isinstance(declaration, Mapping):
                    raise ManifestError(
                        "omp.toml",
                        f"declarations[{index}]",
                        "row must be a mapping or ContentDeclaration",
                    )
                kind = declaration.get("kind")
                if isinstance(kind, str) and kind in _CONTENT_KINDS:
                    try:
                        content_declarations.append(
                            _packages._content_declaration(declaration)
                        )
                    except (KeyError, TypeError, ValueError) as error:
                        raise ManifestError(
                            "omp.toml",
                            f"declarations[{index}]",
                            str(error),
                        ) from error
                    continue
                executable = _executable_declaration(declaration, index)
                identity = (executable.kind, executable.key)
                if identity in executable_declarations:
                    raise ManifestError(
                        "omp.toml",
                        f"declarations[{index}].key",
                        f"duplicate executable declaration {identity!r}",
                    )
                executable_declarations[identity] = executable
        if self._configured:
            raise RuntimeError("manifest declaration sets are already configured")
        if (
            self._tools
            or self._hooks
            or self._regimes
            or self._services
            or self._commands
            or self._completions
            or self._message_renderers
            or self._verdict_renderers
            or self._shortcuts
            or self._approvers
            or self._preludes
        ):
            raise RuntimeError("manifest must be configured before declaration import")
        if declarations is not None:
            _packages._configure_own_declarations(
                extension, tuple(content_declarations)
            )
        manifest_tools = {_tool_key(*item) for item in tools}
        manifest_hooks = {_hook_key(*item) for item in hooks}
        for executable in executable_declarations.values():
            if executable.kind in {"soft", "hard"}:
                manifest_tools.add(_manifest_tool_key(executable.key))
            elif executable.kind == "hook":
                manifest_hooks.add(_manifest_hook_key(executable.key))
        self._manifest_tools = frozenset(manifest_tools)
        self._manifest_hooks = frozenset(manifest_hooks)
        normalized_capabilities = frozenset(capabilities)
        if any(
            not isinstance(capability, str) or not capability
            for capability in normalized_capabilities
        ):
            raise ManifestError("omp.toml", "capabilities", "capabilities must be non-empty strings")
        self._manifest_capabilities = normalized_capabilities
        self._manifest_services = frozenset(_service_key(*item) for item in services)
        self._manifest_requires = frozenset(_service_key(*item) for item in requires)
        self._manifest_executables = executable_declarations
        self._uniform_manifest_configured = declarations is not None
        self._extension_id = extension
        self._configured = True

    def register_tool(
        self,
        name: str,
        family: str,
        rev: int,
        declaration: object,
        *,
        definition: DeviceDefinition | None = None,
    ) -> object:
        """Records a tool decorator during sequential manifest import."""

        key = _tool_key(name, family, rev)
        if definition is not None:
            if not isinstance(definition, DeviceDefinition):
                raise TypeError("device definition must be a DeviceDefinition")
            if (definition.name, definition.family, definition.rev) != key:
                raise ValueError("device definition identity does not match its tool key")
            definition = replace(
                definition,
                arg_specs=_extract_arg_specs(definition.body, definition.schema),
            )
        if definition is not None:
            from .devices import PrecedenceConflict

            extension_id = self._extension_id or "<unconfigured extension>"
            for prior_precedence, _prior_replaces, prior_key in self.device_claims(name):
                claimant_detail = (
                    f"local claimant {(extension_id, prior_key)!r} and "
                    f"local claimant {(extension_id, key)!r}; competing claimants from "
                    "another extension are outside this process"
                )
                if prior_precedence == definition.precedence:
                    raise PrecedenceConflict(
                        f"equal-precedence {claimant_detail}"
                    )
                if definition.replaces is None:
                    raise PrecedenceConflict(
                        f"{claimant_detail} conflict; name the replaced device explicitly"
                    )
        self._insert(self._tools, key, declaration, "tool")
        if definition is not None:
            self._device_definitions[key] = definition
            self._device_claims.setdefault(name, []).append(
                (definition.precedence, definition.replaces, key)
            )
            self._device_states[key] = (True, None)
        return declaration

    def register_legacy_worker_tool(
        self, declaration: Mapping[str, object]
    ) -> WorkerToolDefinition:
        """Normalize a documented ``OMP_TOOLS`` row into this registry."""

        if not isinstance(declaration, Mapping):
            raise TypeError("OMP_TOOLS entries must be mappings")
        name = declaration.get("name")
        if not isinstance(name, str) or not name:
            raise TypeError("OMP_TOOLS name must be a non-empty string")
        rev_value = declaration.get("rev", "1")
        if not isinstance(rev_value, str):
            raise TypeError("OMP_TOOLS rev must be a string")
        family, separator, number = rev_value.rpartition(".")
        if not separator:
            family, number = "", rev_value
        if not number.isascii() or not number.isdigit():
            raise ValueError("OMP_TOOLS rev must be '<family>.<n>' or a bare integer")
        rev = int(number)
        key = _tool_key(name, family, rev)
        handler = declaration.get("handler")
        if not callable(handler):
            raise TypeError(f"Python tool {name!r} handler is not callable")
        description = declaration.get("description", "")
        if not isinstance(description, str):
            raise TypeError("OMP_TOOLS description must be a string")
        schema = declaration.get(
            "schema",
            {"type": "object", "additionalProperties": True},
        )
        if not isinstance(schema, (str, Mapping)):
            raise TypeError("OMP_TOOLS schema must be JSON text or a mapping")
        if isinstance(schema, str):
            decoded = json.loads(schema)
            if not isinstance(decoded, Mapping):
                raise TypeError("OMP_TOOLS schema JSON must encode an object")
        strict = declaration.get("strict")
        if strict is not None and not isinstance(strict, bool):
            raise TypeError("OMP_TOOLS strict must be bool or None")
        streams_args = declaration.get("streams_args", False)
        if not isinstance(streams_args, bool):
            raise TypeError("OMP_TOOLS streams_args must be bool")
        source_module = getattr(handler, "__module__", "")
        if not isinstance(source_module, str) or not source_module:
            raise TypeError("OMP_TOOLS handler must have a source module")
        projected = WorkerToolDefinition(
            name=name,
            family=family,
            rev=rev,
            description=description,
            schema=schema,
            strict=strict,
            streams_args=streams_args,
            handler=handler,
            source_module=source_module,
            kind="legacy",
            place="host",
            legacy=True,
        )
        self.register_tool(name, family, rev, handler)
        self._legacy_worker_tools[key] = projected
        return projected

    def worker_tool_definitions(self) -> tuple[WorkerToolDefinition, ...]:
        """Project every sealed tool identity to one runnable worker row."""

        if not self._verified:
            raise RuntimeError("worker tools are unavailable before FREEZE")
        projected: list[WorkerToolDefinition] = []
        for key in sorted(self._tools):
            if key in self._legacy_worker_tools:
                projected.append(self._legacy_worker_tools[key])
                continue
            definition = self._device_definitions.get(key)
            if definition is None:
                raise RuntimeError(f"sealed tool {key!r} has no worker projection")
            body = definition.body
            source_module = getattr(body, "__module__", "")
            if not isinstance(source_module, str) or not source_module:
                raise TypeError(f"device {definition.name!r} body has no source module")
            kind = getattr(body, "__omp_tool_kind__", "soft")
            projected.append(
                WorkerToolDefinition(
                    name=definition.name,
                    family=definition.family,
                    rev=definition.rev,
                    description=_worker_description(definition),
                    schema=_worker_schema(definition, kind),
                    strict=True if kind == "hard" else None,
                    streams_args=False,
                    handler=_worker_handler(definition, kind),
                    source_module=source_module,
                    kind=kind,
                    place=str(definition.place),
                    replaces=definition.replaces,
                )
            )
        return tuple(projected)

    def register_child_device(
        self,
        parent: _ToolKey,
        path: str,
        declaration: object,
        *,
        definition: DeviceDefinition,
    ) -> object:
        """Record one static child route and its inherited projection."""

        if parent not in self._device_definitions:
            raise LookupError(f"parent device definition is not registered: {parent!r}")
        registered = self.register_tool(
            definition.name,
            definition.family,
            definition.rev,
            declaration,
            definition=definition,
        )
        key = _tool_key(definition.name, definition.family, definition.rev)
        self._child_device_definitions[key] = ChildDeviceDefinition(
            parent=parent,
            path=path,
            definition=self._device_definitions[key],
        )
        return registered

    def child_device_definitions(self) -> tuple[ChildDeviceDefinition, ...]:
        """Return static child routes in deterministic device-key order."""

        return tuple(
            self._child_device_definitions[key]
            for key in sorted(self._child_device_definitions)
        )

    def device_claims(
        self, name: str
    ) -> tuple[tuple[int, str | None, _ToolKey], ...]:
        """Return earlier static claims for a device name."""

        return tuple(self._device_claims.get(name, ()))

    def device_definition(
        self, name: str, family: str, rev: int
    ) -> DeviceDefinition:
        """Return one registered static device definition."""

        key = _tool_key(name, family, rev)
        try:
            return self._device_definitions[key]
        except KeyError as error:
            raise LookupError(f"device definition is not registered: {key!r}") from error

    def device_definitions(self) -> tuple[DeviceDefinition, ...]:
        """Return static device definitions in deterministic key order."""

        return tuple(
            self._device_definitions[key] for key in sorted(self._device_definitions)
        )

    def arg_specs(
        self, name: str, family: str, rev: int
    ) -> tuple[ArgSpec, ...]:
        """Return immutable argument metadata for one device revision."""

        return self.device_definition(name, family, rev).arg_specs

    def set_device_enabled(
        self,
        name: str,
        family: str,
        rev: int,
        enabled: bool,
        reason: str | None = None,
    ) -> None:
        """Record a local static-device enablement projection before FREEZE."""

        self._ensure_open()
        key = _tool_key(name, family, rev)
        if key not in self._device_definitions:
            raise LookupError(f"device definition is not registered: {key!r}")
        if not isinstance(enabled, bool):
            raise TypeError("device enabled state must be bool")
        if enabled and reason is not None:
            raise ValueError("an enabled device cannot carry a disabled reason")
        self._device_states[key] = (enabled, reason)

    def device_state(
        self, name: str, family: str, rev: int
    ) -> tuple[bool, str | None]:
        """Return the projected local enablement state for one static device."""

        key = _tool_key(name, family, rev)
        try:
            return self._device_states[key]
        except KeyError as error:
            raise LookupError(f"device definition is not registered: {key!r}") from error

    def register_export(self, definition: ExportDefinition) -> ExportDefinition:
        """Record one declarative telemetry export during import."""

        if not isinstance(definition, ExportDefinition):
            raise TypeError("export definition must be an ExportDefinition")
        key = self._export_sequence
        self._insert(self._exports, key, definition, "telemetry export")
        self._export_sequence += 1
        return definition

    def export_definitions(self) -> tuple[ExportDefinition, ...]:
        """Return telemetry exports in declaration order."""

        return tuple(self._exports[key] for key in sorted(self._exports))

    def register_hook(self, event: str, phase: object, handler: object) -> object:
        """Records a hook decorator during sequential manifest import."""

        key = _hook_key(event, phase)
        trigger = (
            _ActivationTrigger.EAGER_PROMPT
            if str(getattr(handler, "on_failure", "")) == "fail-closed"
            else _ActivationTrigger.LAZY
        )
        self._insert(self._hooks, key, handler, "hook")
        self._hook_definitions[key] = HookDefinition(
            key[0], key[1], handler, trigger
        )
        return handler
    def register_regime(self, regime_id: str, declaration: object) -> object:
        """Record one regime decorator during sequential manifest import."""

        self._insert(self._regimes, regime_id, declaration, "regime")
        return declaration

    def regime_definitions(self) -> tuple[object, ...]:
        """Return regime declarations in stable identifier order."""

        return tuple(self._regimes[key] for key in sorted(self._regimes))

    def register_approver(
        self,
        name: str,
        kinds: tuple[object, ...],
        timeout: object,
        unreachable: object,
        handler: object,
    ) -> object:
        """Record one external approver declaration during import."""

        definition = ApproverDefinition(name, kinds, timeout, unreachable, handler)
        self._insert(self._approvers, name, definition, "approver")
        return handler

    def approver_definitions(self) -> tuple[ApproverDefinition, ...]:
        """Return approver declarations in deterministic name order."""

        return tuple(self._approvers[key] for key in sorted(self._approvers))

    def register_telemetry(
        self,
        kinds: Iterable[object],
        scope: object,
        queue: int,
        overflow: object,
        coalesce_key: object | None,
        batch: int | None,
        replay: bool,
        replay_limit: int,
        handler: object,
    ) -> object:
        """Records one static telemetry subscription during import."""

        key = f"{getattr(handler, '__module__', '')}.{getattr(handler, '__qualname__', '')}"
        definition = TelemetryDefinition(
            tuple(str(kind) for kind in kinds),
            str(scope),
            queue,
            str(overflow),
            coalesce_key,
            batch,
            replay,
            replay_limit,
            handler,
        )
        self._insert(self._telemetry, key, definition, "telemetry")
        return handler

    def register_prompt_slot(
        self, slot: str, priority: int, cls: object, renderer: object
    ) -> object:
        """Records one static prompt-slot contribution during import."""

        callable_key = (
            f"{getattr(renderer, '__module__', '')}."
            f"{getattr(renderer, '__qualname__', '')}"
        )
        key = (slot, callable_key)
        definition = PromptSlotDefinition(slot, priority, str(cls), renderer)
        self._insert(self._prompt_slots, key, definition, "prompt slot")
        return renderer

    def register_entry_kind(
        self,
        name: str,
        rev: str,
        display: bool | None,
        spill: bool,
        implementation: type,
    ) -> type:
        """Records one typed journal entry declaration during import."""

        key = _entry_kind_key(name, rev)
        if not isinstance(implementation, type):
            raise TypeError("@omp.entry_kind may decorate only a class")
        if display is not None and not isinstance(display, bool):
            raise TypeError("entry kind display must be bool or None")
        if not isinstance(spill, bool):
            raise TypeError("entry kind spill must be bool")
        definition = EntryKindDefinition(
            key[0], key[1], display, spill, implementation
        )
        self._insert(self._entry_kinds, key, definition, "entry kind")
        return implementation


    def entry_kind_definitions(self) -> tuple[EntryKindDefinition, ...]:
        """Returns entry-kind rows in deterministic declaration-key order."""

        return tuple(self._entry_kinds[key] for key in sorted(self._entry_kinds))
    def register_provider(
        self,
        provider_id: str,
        spec: object,
        implementation: type | None = None,
        *,
        priority: int = 0,
        extends: str | None = None,
        replaces: str | None = None,
    ) -> type | None:
        """Record a data-only provider or bind its decorated implementation."""

        self._ensure_open(provider_id)
        if not isinstance(provider_id, str) or not provider_id:
            raise SpecError("provider id must be a non-empty string")
        if implementation is not None and not isinstance(implementation, type):
            raise TypeError("@omp.provider may decorate only a class")
        definition = ProviderDefinition(
            provider_id, spec, implementation, priority, extends, replaces
        )
        candidates = self._provider_candidates.get(provider_id)
        if candidates is None:
            self._check_declaration_limit()
            self._provider_candidates[provider_id] = [definition]
            self._providers[provider_id] = definition
            return implementation

        if implementation is not None:
            for index, existing in enumerate(candidates):
                if existing.spec is spec and existing.implementation is None:
                    candidates[index] = definition
                    if self._providers.get(provider_id) is existing:
                        self._providers[provider_id] = definition
                    return implementation

        self._check_declaration_limit()
        candidates.append(definition)
        self._providers.pop(provider_id, None)
        return implementation

    def provider_definitions(self) -> tuple[ProviderDefinition, ...]:
        """Return active providers followed by their retained collision evidence."""

        definitions: list[ProviderDefinition] = []
        for key in sorted(self._providers):
            winner = self._providers[key]
            definitions.append(winner)
            definitions.extend(
                candidate
                for candidate in self._provider_candidates[key]
                if candidate is not winner
            )
        return tuple(definitions)

    def _resolve_provider_collisions(self) -> None:
        """Resolve provider priority contests or fail closed on a highest tie."""

        for provider_id, candidates in self._provider_candidates.items():
            if len(candidates) < 2:
                continue
            highest_priority = max(candidate.priority for candidate in candidates)
            winners = tuple(
                candidate
                for candidate in candidates
                if candidate.priority == highest_priority
            )
            if len(winners) != 1:
                claimants = ", ".join(
                    f"declaration {index} (provider_id={candidate.id!r}, "
                    f"declaration_id={_provider_declaration_id(candidate)!r}, "
                    f"priority={candidate.priority})"
                    for index, candidate in enumerate(winners, start=1)
                )
                raise SpecError(
                    f"provider activation conflict for {provider_id!r}: equal highest "
                    f"priority claimants {claimants}; provider id is withheld"
                )
            self._providers[provider_id] = winners[0]

    def register_worker(self, name: str, spec: object) -> None:
        """Record one worker manifest projection during import."""

        if not isinstance(name, str) or not name:
            raise ValueError("worker name must be a non-empty string")
        self._insert(self._workers, name, WorkerDefinition(name, spec), "worker")

    def worker_definitions(self) -> tuple[WorkerDefinition, ...]:
        """Return worker declarations in deterministic name order."""

        return tuple(self._workers[key] for key in sorted(self._workers))

    def register_prelude(self, definition: PreludeDefinition) -> object:
        """Record one eval-prelude helper and its worker invocation adapter."""

        self._insert(self._preludes, definition.name, definition, "prelude")
        return definition.body

    def prelude_definitions(self) -> tuple[PreludeDefinition, ...]:
        """Return eval-prelude helpers in deterministic name order."""

        return tuple(self._preludes[key] for key in sorted(self._preludes))

    def register_command(
        self,
        name: str,
        aliases: tuple[str, ...],
        description: str,
        args: tuple[object, ...],
        hint: str | None,
        arg_completions: object | None,
        handler: object,
    ) -> object:
        """Record one slash command and its static and dynamic completion metadata."""

        if not isinstance(name, str) or not name:
            raise ValueError("command name must be a non-empty string")
        if any(not isinstance(alias, str) or not alias for alias in aliases):
            raise ValueError("command aliases must be non-empty strings")
        if not isinstance(description, str):
            raise TypeError("command description must be a string")
        if hint is not None and not isinstance(hint, str):
            raise TypeError("command hint must be a string or None")
        if arg_completions is not None and not callable(arg_completions):
            raise TypeError("command arg_completions must be callable or None")
        if not callable(handler):
            raise TypeError("@omp.command may decorate only a callable")
        definition = CommandDefinition(
            name,
            aliases,
            description,
            args,
            hint,
            arg_completions,
            handler,
        )
        self._insert(self._commands, name, definition, "command")
        return handler

    def command_definitions(self) -> tuple[CommandDefinition, ...]:
        """Return command declarations in deterministic name order."""

        return tuple(self._commands[key] for key in sorted(self._commands))

    def register_ui(
        self, kind: str, name: object, value: object
    ) -> object:
        """Insert one completion or renderer through the shared declaration gate."""

        targets = {
            "completion": (
                self._completions,
                _ActivationTrigger.EAGER_UI,
            ),
            "message_renderer": (
                self._message_renderers,
                _ActivationTrigger.LAZY,
            ),
            "verdict_renderer": (
                self._verdict_renderers,
                _ActivationTrigger.LAZY,
            ),
        }
        try:
            declarations, trigger = targets[kind]
        except (KeyError, TypeError) as error:
            raise ValueError(
                "UI declaration kind must be completion, message_renderer, "
                "or verdict_renderer"
            ) from error
        try:
            hash(name)
        except TypeError as error:
            raise TypeError("UI declaration name must be hashable") from error
        definition = UIDefinition(kind, name, value, trigger)
        self._insert(declarations, name, definition, kind)
        return value

    def register_shortcut(
        self,
        chord: str,
        action_id: str,
        description: str,
        when: frozenset[object] | None,
        handler: object,
    ) -> object:
        """Record one normalized shortcut and its static dispatch metadata."""

        if not isinstance(chord, str) or not chord:
            raise ValueError("shortcut chord must be a non-empty string")
        if not isinstance(action_id, str) or not action_id:
            raise ValueError("shortcut action_id must be a non-empty string")
        if not isinstance(description, str):
            raise TypeError("shortcut description must be a string")
        if not callable(handler):
            raise TypeError("@omp.shortcut may decorate only a callable")
        definition = ShortcutDefinition(chord, action_id, description, when, handler)
        self._insert(self._shortcuts, chord, definition, "shortcut")
        return handler

    def shortcut_definitions(self) -> tuple[ShortcutDefinition, ...]:
        """Return shortcut declarations in deterministic chord order."""

        return tuple(self._shortcuts[key] for key in sorted(self._shortcuts))


    def register_service(self, name: str, rev: int, implementation: type) -> type:
        """Records and validates an async service implementation."""

        key = _service_key(name, rev)
        if not isinstance(implementation, type):
            raise TypeError("@omp.service may decorate only a class")
        members = inspect.getmembers(implementation)
        methods = tuple(
            method_name
            for method_name, value in members
            if not method_name.startswith("_") and inspect.iscoroutinefunction(value)
        )
        public_non_async = tuple(
            method_name
            for method_name, value in members
            if not method_name.startswith("_")
            and callable(value)
            and not inspect.iscoroutinefunction(value)
        )
        if public_non_async:
            names = ", ".join(public_non_async)
            raise TypeError(f"service public methods must be async: {names}")
        if not methods:
            raise TypeError("a service must declare at least one public async method")
        method_schemas = tuple(
            _service_method_definition(method_name, getattr(implementation, method_name))
            for method_name in methods
        )
        definition = ServiceDefinition(
            key[0], key[1], implementation, methods, method_schemas
        )
        self._insert(self._services, key, definition, "service")
        return implementation

    def freeze(self) -> DeclarationSnapshot:
        """Seals the Core-verified registry and returns its immutable sets."""

        self._ensure_open("declaration registry")
        self._sealed = True
        self._resolve_provider_collisions()
        missing_tools: frozenset[_ToolKey] = frozenset()
        undeclared_tools: frozenset[_ToolKey] = frozenset()
        missing_hooks: frozenset[_HookKey] = frozenset()
        undeclared_hooks: frozenset[_HookKey] = frozenset()
        missing_services: frozenset[_ServiceKey] = frozenset()
        undeclared_services: frozenset[_ServiceKey] = frozenset()
        if self._configured:
            actual_tools = frozenset(self._tools).union(
                (definition.name, "prelude", definition.rev)
                for definition in self._preludes.values()
            )
            missing_tools = self._manifest_tools.difference(actual_tools)
            undeclared_tools = actual_tools.difference(self._manifest_tools)
            missing_hooks = self._manifest_hooks.difference(self._hooks)
            undeclared_hooks = frozenset(self._hooks).difference(
                self._manifest_hooks
            )
            uniform_service_names = {
                declaration.key
                for declaration in self._manifest_executables.values()
                if declaration.kind == "service"
            }
            actual_legacy_services = frozenset(
                key for key in self._services if key[0] not in uniform_service_names
            )
            missing_services = self._manifest_services.difference(self._services)
            undeclared_services = actual_legacy_services.difference(
                self._manifest_services
            )
        missing_declarations: frozenset[tuple[str, str]] = frozenset()
        undeclared_declarations: frozenset[tuple[str, str]] = frozenset()
        if self._uniform_manifest_configured:
            manifest_declarations = frozenset(self._manifest_executables)
            decorated_declarations = self._decorated_executable_keys()
            missing_declarations = manifest_declarations.difference(
                decorated_declarations
            )
            undeclared_declarations = decorated_declarations.difference(
                manifest_declarations
            )
        if (
            missing_tools
            or undeclared_tools
            or missing_hooks
            or undeclared_hooks
            or missing_services
            or undeclared_services
            or missing_declarations
            or undeclared_declarations
        ):
            raise DeclarationDrift(
                missing_tools=frozenset(missing_tools),
                undeclared_tools=frozenset(undeclared_tools),
                missing_hooks=frozenset(missing_hooks),
                undeclared_hooks=frozenset(undeclared_hooks),
                missing_services=frozenset(missing_services),
                undeclared_services=frozenset(undeclared_services),
                missing_declarations=missing_declarations,
                undeclared_declarations=undeclared_declarations,
            )
        from .devices import Availability

        for key, definition in self._device_definitions.items():
            enabled, disabled_reason = self._device_states[key]
            mounted = enabled
            reason = disabled_reason
            if enabled and definition.available is not None:
                try:
                    result = definition.available()
                except Exception as error:
                    mounted = False
                    reason = f"{type(error).__name__}: {error}"
                else:
                    if isinstance(result, bool):
                        mounted = result
                        reason = None
                    elif isinstance(result, Availability):
                        mounted = result.mounted
                        reason = result.reason
                    else:
                        mounted = False
                        reason = "availability predicate returned neither bool nor Availability"
            self._device_states[key] = (mounted, reason)
            declaration = self._tools[key]
            if hasattr(declaration, "mounted"):
                declaration.mounted = mounted
        self._verified = True
        return self.snapshot()

    def _decorated_executable_keys(self) -> frozenset[tuple[str, str]]:
        declarations: set[tuple[str, str]] = set()
        for key, value in self._tools.items():
            body = self._device_definitions.get(key)
            kind = getattr(value, "__omp_tool_kind__", None)
            if kind is None and body is not None:
                kind = getattr(body.body, "__omp_tool_kind__", None)
            declarations.add(
                (str(kind or "soft"), _manifest_tool_static_key(key))
            )
        declarations.update(
            ("hook", _manifest_hook_static_key(key)) for key in self._hooks
        )
        declarations.update(("regime", key) for key in self._regimes)
        declarations.update(("service", key[0]) for key in self._services)
        declarations.update(("command", key) for key in self._commands)
        declarations.update(("shortcut", key) for key in self._shortcuts)
        declarations.update(("provider", key) for key in self._providers)
        declarations.update(
            ("prompt_slot", definition.slot)
            for definition in self._prompt_slots.values()
        )
        declarations.update(("worker", key) for key in self._workers)
        for definition in self._telemetry.values():
            declarations.update(("telemetry", kind) for kind in definition.kinds)
        for kind, values in (
            ("completion", self._completions),
            ("message_renderer", self._message_renderers),
            ("verdict_renderer", self._verdict_renderers),
        ):
            declarations.update(
                (kind, _ui_manifest_key(kind, name)) for name in values
            )
        return frozenset(declarations)

    def snapshot(self) -> DeclarationSnapshot:
        """Returns the current declaration existence sets without mutation."""

        return DeclarationSnapshot(
            entry_kinds=self.entry_kind_definitions(),
            tools=frozenset(self._tools),
            capabilities=self._manifest_capabilities,
            hooks=frozenset(self._hooks),
            services=frozenset(self._services),
            preludes=self.prelude_definitions(),
            commands=self.command_definitions(),
            shortcuts=self.shortcut_definitions(),
            telemetry=tuple(self._telemetry[key] for key in sorted(self._telemetry)),
            prompt_slots=tuple(
                self._prompt_slots[key] for key in sorted(self._prompt_slots)
            ),
            providers=self.provider_definitions(),
            workers=self.worker_definitions(),
            device_definitions=self.device_definitions(),
            child_device_definitions=self.child_device_definitions(),
            exports=self.export_definitions(),
            approvers=self.approver_definitions(),
            device_states=tuple(
                (key, *self._device_states[key]) for key in sorted(self._device_states)
            ),
            arg_specs=tuple(
                (key, self._device_definitions[key].arg_specs)
                for key in sorted(self._device_definitions)
            ),
            hook_definitions=tuple(
                self._hook_definitions[key] for key in sorted(self._hook_definitions)
            ),
            service_definitions=tuple(
                self._services[key] for key in sorted(self._services)
            ),
            completions=tuple(
                self._completions[key]
                for key in sorted(self._completions, key=repr)
            ),
            message_renderers=tuple(
                self._message_renderers[key]
                for key in sorted(self._message_renderers, key=repr)
            ),
            verdict_renderers=tuple(
                self._verdict_renderers[key]
                for key in sorted(self._verdict_renderers, key=repr)
            ),
            regimes=self.regime_definitions(),
        )


    def service_definition(self, name: str, rev: int) -> ServiceDefinition:
        """Returns one verified provider definition for CONTROL dispatch."""

        if not self._verified:
            raise RuntimeError("service dispatch is unavailable before FREEZE")
        key = _service_key(name, rev)
        try:
            return self._services[key]
        except KeyError as error:
            raise LookupError(f"service {name!r} rev {rev} is not registered") from error

    def service_instance(self, name: str, rev: int) -> object:
        """Returns the generation-local provider instance for a verified service."""

        definition = self.service_definition(name, rev)
        key = (definition.name, definition.rev)
        instance = self._service_instances.get(key)
        if instance is None:
            instance = definition.implementation()
            self._service_instances[key] = instance
        return instance

    def _ensure_open(self, name: object = "declaration registry") -> None:
        if self._sealed:
            raise DeclarationSealed(str(name))

    def _check_declaration_limit(self) -> None:
        """Refuse a declaration that would exceed the per-extension bound."""

        count = (
            len(self._tools)
            + len(self._commands)
            + len(self._completions)
            + len(self._message_renderers)
            + len(self._verdict_renderers)
            + len(self._shortcuts)
            + len(self._hooks)
            + len(self._regimes)
            + len(self._approvers)
            + len(self._services)
            + len(self._entry_kinds)
            + len(self._telemetry)
            + len(self._prompt_slots)
            + sum(len(candidates) for candidates in self._provider_candidates.values())
            + len(self._workers)
            + len(self._exports)
            + len(self._preludes)
        )
        if count >= MAX_DECLARATIONS:
            raise DeclarationLimit(count + 1, MAX_DECLARATIONS)

    def _insert(
        self,
        declarations: dict[object, object],
        key: object,
        value: object,
        kind: str,
    ) -> None:
        self._ensure_open(key)
        if key in declarations:
            holder = self._extension_id or _declaration_holder(declarations[key])
            raise DuplicateRegistration(str(key), holder)
        self._check_declaration_limit()
        declarations[key] = value


class ControlServiceTransport(Protocol):
    """Existing host CONTROL request path used by service clients."""

    def request(self, operation: str, payload: Mapping[str, object]) -> Awaitable[object]:
        """Sends one correlated Request and awaits its matching response."""


class ServiceClient:
    """Dynamic typed-service proxy bound to an exact name and revision."""

    __slots__ = ("_methods", "_name", "_rev", "_transport")

    def __init__(
        self,
        name: str,
        rev: int,
        transport: ControlServiceTransport,
        methods: Mapping[str, Mapping[str, object]],
    ) -> None:
        self._name = name
        self._rev = rev
        self._transport = transport
        self._methods = methods

    @property
    def name(self) -> str:
        """Globally qualified service name."""

        return self._name

    @property
    def rev(self) -> int:
        """Exact service revision."""

        return self._rev

    def __getattr__(self, method: str) -> Callable[..., Awaitable[object]]:
        if method.startswith("_") or method not in self._methods:
            raise AttributeError(method)

        async def invoke(*args: object, **kwargs: object) -> object:
            return await self._transport.request(
                "omp.services.call",
                {
                    "name": self._name,
                    "rev": self._rev,
                    "method": method,
                    "args": args,
                    "kwargs": kwargs,
                },
            )

        return invoke


class Services:
    """Manifest-gated service connector using only the CONTROL request path."""

    __slots__ = ("_transport",)

    def __init__(self) -> None:
        self._transport: ControlServiceTransport | None = None

    def _install_control_transport(self, transport: ControlServiceTransport) -> None:
        """Installs the host's correlated CONTROL transport after VERIFY."""

        if self._transport is not None and self._transport is not transport:
            raise RuntimeError("CONTROL service transport is already installed")
        self._transport = transport

    async def connect(self, name: str, *, rev: int) -> ServiceClient:
        """Connects to an exact service revision granted by ``[requires]``."""

        key = _service_key(name, rev)
        if key not in registry.required_services:
            raise CapabilityError(f"service:{name}@{rev}")
        transport = self._transport
        if transport is None:
            raise RuntimeError("CONTROL service transport is unavailable before ACTIVATE")
        connected = await transport.request(
            "omp.services.connect", {"name": key[0], "rev": key[1]}
        )
        if not isinstance(connected, Mapping):
            raise TypeError("service connect response must carry method schemas")
        rows = connected.get("methods")
        if not isinstance(rows, (tuple, list)):
            raise TypeError("service connect response has no method schema list")
        methods: dict[str, Mapping[str, object]] = {}
        for row in rows:
            if not isinstance(row, Mapping):
                raise TypeError("service method schema row must be a mapping")
            method = row.get("name")
            input_schema = row.get("input_schema")
            result_schema = row.get("result_schema")
            if (
                not isinstance(method, str)
                or not isinstance(input_schema, Mapping)
                or not isinstance(result_schema, Mapping)
            ):
                raise TypeError("service method schema row is malformed")
            methods[method] = {
                "input_schema": input_schema,
                "result_schema": result_schema,
            }
        return ServiceClient(key[0], key[1], transport, methods)


registry = DeclarationRegistry()
"""The sole declaration authority in one extension-host process."""

services = Services()
"""The sole manifest-gated service connector in one extension-host process."""


def configure_manifest(
    *,
    tools: Iterable[_ToolKey] = (),
    hooks: Iterable[_HookKey] = (),
    capabilities: Iterable[str] = (),
    services: Iterable[_ServiceKey] = (),
    requires: Iterable[_ServiceKey] = (),
    declarations: Iterable[
        _packages.ContentDeclaration | Mapping[str, object]
    ] | None = None,
    extension: str | None = None,
) -> None:
    """Install authoritative existence and content sets before sequential import."""

    registry.configure_manifest(
        tools=tools,
        hooks=hooks,
        capabilities=capabilities,
        services=services,
        requires=requires,
        declarations=declarations,
        extension=extension,
    )


def freeze_declarations() -> DeclarationSnapshot:
    """Runs the FREEZE transition without socket or filesystem work."""

    return registry.freeze()

def prelude_definitions() -> tuple[PreludeDefinition, ...]:
    """Return registered eval-prelude helpers in deterministic name order."""

    return registry.prelude_definitions()

def bootstrap_worker_registry(
    manifest_json: str,
    modules: Iterable[str],
) -> tuple[tuple[WorkerToolDefinition, ...], str]:
    """Configure, sequentially import, seal, and project one admitted worker."""

    manifest = json.loads(manifest_json)
    if not isinstance(manifest, Mapping):
        raise TypeError("worker manifest snapshot must encode an object")
    configure_manifest(
        tools=manifest.get("tools", ()),
        hooks=manifest.get("hooks", ()),
        capabilities=manifest.get("capabilities", ()),
        services=manifest.get("services", ()),
        requires=manifest.get("requires", ()),
        declarations=manifest.get("declarations"),
        extension=manifest.get("extension"),
    )
    seen: set[str] = set()
    for module_name in modules:
        if not isinstance(module_name, str) or not module_name:
            raise TypeError("worker import modules must be non-empty strings")
        if module_name in seen:
            continue
        seen.add(module_name)
        module = importlib.import_module(module_name)
        legacy = getattr(module, "OMP_TOOLS", ())
        for declaration in legacy:
            register_legacy_worker_tool(declaration)
    freeze_declarations()
    return project_worker_registry()

def register_legacy_worker_tool(
    declaration: Mapping[str, object],
) -> WorkerToolDefinition:
    """Register one documented legacy ``OMP_TOOLS`` row before FREEZE."""

    return registry.register_legacy_worker_tool(declaration)


def project_worker_registry() -> tuple[tuple[WorkerToolDefinition, ...], str]:
    """Project the complete sealed registry for the production stdio worker."""

    if not registry.sealed:
        raise RuntimeError("worker registry projection requires FREEZE")
    snapshot = registry.snapshot()
    tools = registry.worker_tool_definitions()
    metadata = {
        "tools": [
            {
                "name": tool.name,
                "family": tool.family,
                "rev": tool.rev,
                "kind": tool.kind,
                "place": str(tool.place),
                "source_module": tool.source_module,
            }
            for tool in tools
        ],
        "hooks": [
            {
                "event": declaration.event,
                "phase": str(getattr(declaration.phase, "value", declaration.phase)),
                "name": declaration.name,
                "order": declaration.order,
                "on_failure": (
                    None
                    if declaration.on_failure is None
                    else declaration.on_failure.value
                ),
                "timeout": _worker_wire_value(declaration.timeout),
                "concurrency": declaration.concurrency,
                "threadsafe": declaration.threadsafe,
                "when": _worker_wire_value(declaration.when),
                "event_rev": _hook_catalog(declaration.event).rev,
                "event_on_failure": _hook_catalog(declaration.event).on_failure.value,
                "event_default": (
                    "allow" if _hook_catalog(declaration.event).gateable else None
                ),
                "event_timeout": _worker_wire_value(
                    _hook_catalog(declaration.event).default_timeout
                ),
                "composition": {
                    name: value.value
                    for name, value in _hook_catalog(declaration.event).fields.items()
                },
            }
            for declaration in snapshot.hook_definitions
        ],
        "services": [
            {
                "name": definition.name,
                "rev": definition.rev,
                "source_module": definition.implementation.__module__,
                "methods": [
                    _worker_wire_value(method)
                    for method in definition.method_schemas
                ],
            }
            for definition in snapshot.service_definitions
        ],
        "entry_kinds": [_worker_wire_value(value) for value in snapshot.entry_kinds],
        "providers": [_worker_wire_value(value) for value in snapshot.providers],
        "regimes": [_worker_wire_value(value) for value in snapshot.regimes],
        "commands": [_worker_wire_value(value) for value in snapshot.commands],
        "shortcuts": [_worker_wire_value(value) for value in snapshot.shortcuts],
        "telemetry": [_worker_wire_value(value) for value in snapshot.telemetry],
        "prompt_slots": [_worker_wire_value(value) for value in snapshot.prompt_slots],
        "workers": [_worker_wire_value(value) for value in snapshot.workers],
        "exports": [_worker_wire_value(value) for value in snapshot.exports],
        "approvers": [_worker_wire_value(value) for value in snapshot.approvers],
        "completions": [_worker_wire_value(value) for value in snapshot.completions],
        "message_renderers": [
            _worker_wire_value(value) for value in snapshot.message_renderers
        ],
        "verdict_renderers": [
            _worker_wire_value(value) for value in snapshot.verdict_renderers
        ],
    }
    return tools, json.dumps(metadata, sort_keys=True, separators=(",", ":"))


def _hook_catalog(event: str) -> object:
    """Return the frozen event policy paired with a hook declaration."""

    from .events import spec

    return spec(event)


def _worker_wire_value(value: object) -> object:
    """Lower declaration metadata without serializing executable Python objects."""

    if callable(value):
        module = getattr(value, "__module__", None)
        qualname = getattr(value, "__qualname__", None)
        if not isinstance(module, str) or not isinstance(qualname, str):
            raise TypeError("registered callback has no stable qualified name")
        return {"$omp.callable": f"{module}.{qualname}"}
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    if isinstance(value, Enum):
        return _worker_wire_value(value.value)
    if isinstance(value, bytes):
        return value.hex()
    if isinstance(value, Mapping):
        return {
            str(key): _worker_wire_value(item)
            for key, item in sorted(value.items(), key=lambda pair: str(pair[0]))
        }
    if isinstance(value, (tuple, list)):
        return [_worker_wire_value(item) for item in value]
    if isinstance(value, (set, frozenset)):
        return [
            _worker_wire_value(item)
            for item in sorted(value, key=lambda item: repr(item))
        ]
    if is_dataclass(value) and not isinstance(value, type):
        return {
            field.name: _worker_wire_value(getattr(value, field.name))
            for field in fields(value)
        }
    return str(value)




def service(name: str, *, rev: int) -> Callable[[_T], _T]:
    """Declares an async inter-extension service implementation."""

    key = _service_key(name, rev)

    def decorate(implementation: _T) -> _T:
        registry.register_service(key[0], key[1], implementation)
        return implementation

    return decorate


def entry_kind(
    name: str,
    *,
    rev: str,
    display: bool | None = None,
    spill: bool = True,
) -> Callable[[_T], _T]:
    """Declare a typed, versioned session-journal entry kind."""

    key = _entry_kind_key(name, rev)

    def decorate(implementation: _T) -> _T:
        registry.register_entry_kind(
            key[0], key[1], display, spill, implementation
        )
        return implementation

    return decorate


async def dispatch_service(
    request_id: int,
    name: str,
    rev: int,
    method: str,
    args: tuple[object, ...],
    kwargs: Mapping[str, object],
) -> tuple[int, object]:
    """Dispatches a correlated provider call received from CONTROL."""

    if isinstance(request_id, bool) or not isinstance(request_id, int) or request_id <= 0:
        raise ValueError("service request correlation id must be a positive integer")
    definition = registry.service_definition(name, rev)
    if method not in definition.methods:
        raise AttributeError(f"service {name!r} has no public async method {method!r}")
    instance = registry.service_instance(name, rev)
    result = await getattr(instance, method)(*args, **dict(kwargs))
    return request_id, result




def _executable_declaration(
    value: Mapping[str, object], index: int
) -> _ExecutableDeclaration:
    """Decode and validate one executable manifest declaration row."""

    required = frozenset(
        {"id", "kind", "module", "key", "trigger", "api", "failure"}
    )
    fields = frozenset(value)
    missing = required.difference(fields)
    if missing:
        field = sorted(missing)[0]
        raise ManifestError(
            "omp.toml",
            f"declarations[{index}].{field}",
            "required executable declaration field is missing",
        )
    unknown = fields.difference(required)
    if unknown:
        field = sorted(str(item) for item in unknown)[0]
        raise ManifestError(
            "omp.toml",
            f"declarations[{index}].{field}",
            "unknown executable declaration field",
        )

    declaration_id = value["id"]
    kind = value["kind"]
    module = value["module"]
    key = value["key"]
    for field, item in (
        ("id", declaration_id),
        ("kind", kind),
        ("module", module),
        ("key", key),
    ):
        if not isinstance(item, str) or not item:
            raise ManifestError(
                "omp.toml",
                f"declarations[{index}].{field}",
                "must be a non-empty string",
            )
    if kind not in _EXECUTABLE_KINDS:
        raise ManifestError(
            "omp.toml",
            f"declarations[{index}].kind",
            f"unknown executable declaration kind {kind!r}",
        )

    raw_trigger = value["trigger"]
    try:
        trigger = _ActivationTrigger(raw_trigger)
    except (TypeError, ValueError) as error:
        raise ManifestError(
            "omp.toml",
            f"declarations[{index}].trigger",
            "must be static, lazy, eager-prompt, or eager-ui",
        ) from error
    failure = value["failure"]
    if (
        not isinstance(failure, str)
        or failure not in {"fault", "fail-open", "fail-closed"}
    ):
        raise ManifestError(
            "omp.toml",
            f"declarations[{index}].failure",
            "must be fault, fail-open, or fail-closed",
        )
    required_trigger = {
        "prompt_slot": _ActivationTrigger.EAGER_PROMPT,
        "completion": _ActivationTrigger.EAGER_UI,
    }.get(kind)
    if kind == "hook" and failure == "fail-closed":
        required_trigger = _ActivationTrigger.EAGER_PROMPT
    if required_trigger is not None and trigger is not required_trigger:
        raise ManifestError(
            "omp.toml",
            f"declarations[{index}].trigger",
            f"{kind} declarations require trigger {required_trigger.value!r}",
        )
    if required_trigger is None and trigger is _ActivationTrigger.STATIC:
        raise ManifestError(
            "omp.toml",
            f"declarations[{index}].trigger",
            f"{kind} declarations may not use the static trigger",
        )

    api = value["api"]
    if isinstance(api, bool) or not isinstance(api, int) or api < 1:
        raise ManifestError(
            "omp.toml",
            f"declarations[{index}].api",
            "must be a positive integer",
        )

    normalized_key = key
    if kind in {"soft", "hard"}:
        normalized_key = _manifest_tool_static_key(_manifest_tool_key(key))
    elif kind == "hook":
        normalized_key = _manifest_hook_static_key(_manifest_hook_key(key))
    elif kind == "service":
        service_name, separator, revision = key.rpartition("@")
        if separator and revision.isascii() and revision.isdigit():
            normalized_key = service_name
        if "." not in normalized_key:
            raise ManifestError(
                "omp.toml",
                f"declarations[{index}].key",
                "service key must be a globally qualified dotted name",
            )

    return _ExecutableDeclaration(
        declaration_id,
        kind,
        module,
        normalized_key,
        trigger,
        api,
        failure,
    )


def _manifest_tool_key(value: str) -> _ToolKey:
    """Decode a uniform-manifest tool static key."""

    name, separator, revision = value.rpartition("@")
    family, revision_separator, number = revision.rpartition(".")
    if (
        not separator
        or not name
        or not revision_separator
        or not number.isascii()
        or not number.isdigit()
    ):
        raise ManifestError(
            "omp.toml",
            "declarations[].key",
            "tool key must have the form 'name@family.rev'",
        )
    try:
        return _tool_key(name, family, int(number))
    except (TypeError, ValueError) as error:
        raise ManifestError(
            "omp.toml",
            "declarations[].key",
            str(error),
        ) from error


def _manifest_tool_static_key(key: _ToolKey) -> str:
    """Encode a canonical uniform-manifest tool static key."""

    return f"{key[0]}@{key[1]}.{key[2]}"


def _manifest_hook_key(value: str) -> _HookKey:
    """Decode a uniform-manifest hook static key."""

    event, separator, phase = value.rpartition("/")
    if not separator:
        raise ManifestError(
            "omp.toml",
            "declarations[].key",
            "hook key must have the form 'event/phase'",
        )
    try:
        return _hook_key(event, phase)
    except ValueError as error:
        raise ManifestError(
            "omp.toml",
            "declarations[].key",
            str(error),
        ) from error


def _manifest_hook_static_key(key: _HookKey) -> str:
    """Encode a canonical uniform-manifest hook static key."""

    return f"{key[0]}/{key[1]}"


def _ui_manifest_key(kind: str, name: object) -> str:
    """Project a UI registry key to its uniform-manifest spelling."""

    if (
        kind == "verdict_renderer"
        and isinstance(name, tuple)
        and len(name) == 3
        and isinstance(name[0], str)
        and isinstance(name[1], str)
        and isinstance(name[2], int)
    ):
        if name[1] or name[2]:
            return _manifest_tool_static_key(name)
        return name[0]
    return str(name)


def _declaration_holder(value: object) -> str:
    """Name the incumbent callable or class for duplicate diagnostics."""

    for candidate in (
        value,
        getattr(value, "handler", None),
        getattr(value, "implementation", None),
        getattr(value, "body", None),
        getattr(value, "value", None),
    ):
        module = getattr(candidate, "__module__", None)
        qualname = getattr(candidate, "__qualname__", None)
        if isinstance(module, str) and isinstance(qualname, str):
            return f"{module}.{qualname}"
    return type(value).__name__


def _provider_declaration_id(definition: ProviderDefinition) -> str:
    """Name one provider declaration for activation diagnostics."""

    if definition.implementation is not None:
        return _declaration_holder(definition.implementation)
    return _declaration_holder(definition.spec)


def _worker_description(definition: DeviceDefinition) -> str:
    if definition.summary:
        return definition.summary
    candidates = (
        definition.docs if isinstance(definition.docs, str) else None,
        inspect.getdoc(definition.body),
    )
    for candidate in candidates:
        if candidate:
            for line in candidate.splitlines():
                if line.strip():
                    return line.strip()
    return ""

def _service_method_definition(
    name: str, method: object
) -> ServiceMethodDefinition:
    try:
        signature = inspect.signature(method)
        hints = get_type_hints(method, include_extras=True)
    except (NameError, TypeError, ValueError) as error:
        raise TypeError(f"service method {name!r} annotations are not resolvable") from error
    properties: dict[str, object] = {}
    required: list[str] = []
    additional = False
    for parameter in signature.parameters.values():
        if parameter.name in {"self", "cls"}:
            continue
        if parameter.kind is inspect.Parameter.VAR_POSITIONAL:
            raise TypeError(f"service method {name!r} may not declare *args")
        if parameter.kind is inspect.Parameter.VAR_KEYWORD:
            additional = True
            continue
        annotation = hints.get(parameter.name, parameter.annotation)
        if annotation is inspect.Parameter.empty:
            raise TypeError(
                f"service method {name!r} argument {parameter.name!r} is untyped"
            )
        properties[parameter.name] = _schema_for_annotation(annotation)
        if parameter.default is inspect.Parameter.empty:
            required.append(parameter.name)
    result_annotation = hints.get("return", signature.return_annotation)
    if result_annotation is inspect.Signature.empty:
        raise TypeError(f"service method {name!r} return is untyped")
    input_schema: dict[str, object] = {
        "type": "object",
        "properties": properties,
        "additionalProperties": additional,
    }
    if required:
        input_schema["required"] = required
    return ServiceMethodDefinition(
        name=name,
        input_schema=input_schema,
        result_schema=_schema_for_annotation(result_annotation),
    )


def service_json_value(value: object) -> object:
    """Recursively lower a typed service value to reversible JSON data."""

    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    if isinstance(value, Enum):
        return {
            "$omp.enum": f"{type(value).__module__}.{type(value).__qualname__}",
            "value": service_json_value(value.value),
        }
    if is_dataclass(value) and not isinstance(value, type):
        return {
            "$omp.type": f"{type(value).__module__}.{type(value).__qualname__}",
            "$omp.fields": {
                field.name: service_json_value(getattr(value, field.name))
                for field in fields(value)
            },
        }
    if isinstance(value, Mapping):
        if any(not isinstance(key, str) for key in value):
            raise TypeError("service result mappings must have string keys")
        return {key: service_json_value(item) for key, item in value.items()}
    if isinstance(value, (tuple, list)):
        return [service_json_value(item) for item in value]
    if isinstance(value, (set, frozenset)):
        return [
            service_json_value(item)
            for item in sorted(value, key=lambda item: repr(item))
        ]
    to_json = getattr(value, "to_json", None)
    if callable(to_json):
        return {
            "$omp.type": f"{type(value).__module__}.{type(value).__qualname__}",
            "$omp.value": service_json_value(to_json()),
        }
    raise TypeError(
        f"unsupported service result type "
        f"{type(value).__module__}.{type(value).__qualname__}"
    )



def _worker_schema(definition: DeviceDefinition, kind: object) -> object:
    if isinstance(definition.schema, Mapping):
        return dict(definition.schema)
    if isinstance(definition.schema, type):
        return _schema_for_annotation(definition.schema)
    try:
        signature = inspect.signature(definition.body)
        hints = get_type_hints(definition.body, include_extras=True)
    except (NameError, TypeError, ValueError):
        return {"type": "object", "additionalProperties": True}
    parameters = tuple(signature.parameters.values())
    if kind in {"soft", "hard"} and hasattr(definition.body, "__omp_tool_kind__"):
        properties: dict[str, object] = {}
        required: list[str] = []
        additional = False
        for parameter in parameters:
            if parameter.name == "ctx":
                continue
            if parameter.kind is inspect.Parameter.VAR_POSITIONAL:
                continue
            if parameter.kind is inspect.Parameter.VAR_KEYWORD:
                additional = True
                continue
            annotation = hints.get(parameter.name, parameter.annotation)
            properties[parameter.name] = _schema_for_annotation(annotation)
            if parameter.default is inspect.Parameter.empty:
                required.append(parameter.name)
        schema: dict[str, object] = {
            "type": "object",
            "properties": properties,
            "additionalProperties": additional,
        }
        if required:
            schema["required"] = required
        return schema
    argument = next(
        (parameter for parameter in parameters if parameter.name != "ctx"),
        None,
    )
    if argument is None:
        return {"type": "object", "additionalProperties": False}
    annotation = hints.get(argument.name, argument.annotation)
    if annotation is inspect.Parameter.empty:
        return {"type": "object", "additionalProperties": True}
    return _schema_for_annotation(annotation)



def _schema_for_annotation(annotation: object) -> dict[str, object]:
    from . import Field

    metadata: tuple[object, ...] = ()
    if get_origin(annotation) is Annotated:
        annotation, *metadata = get_args(annotation)
    origin = get_origin(annotation)
    arguments = get_args(annotation)
    if annotation in {Any, object, inspect.Parameter.empty}:
        schema: dict[str, object] = {}
    elif annotation is str:
        schema = {"type": "string"}
    elif annotation is bool:
        schema = {"type": "boolean"}
    elif annotation is int:
        schema = {"type": "integer"}
    elif annotation is float:
        schema = {"type": "number"}
    elif annotation in {None, type(None)}:
        schema = {"type": "null"}
    elif origin is Literal:
        values = list(arguments)
        schema = {"enum": values}
        if values and all(isinstance(value, str) for value in values):
            schema["type"] = "string"
    elif origin in {Union, UnionType}:
        schema = {"anyOf": [_schema_for_annotation(item) for item in arguments]}
    elif origin in {list, set, frozenset, tuple}:
        item = arguments[0] if arguments else Any
        schema = {"type": "array", "items": _schema_for_annotation(item)}
    elif origin in {dict, Mapping}:
        item = arguments[1] if len(arguments) > 1 else Any
        schema = {
            "type": "object",
            "additionalProperties": _schema_for_annotation(item),
        }
    elif isinstance(annotation, type) and issubclass(annotation, Enum):
        schema = {
            "enum": [item.value for item in annotation],
            "x-omp-python-type": f"{annotation.__module__}.{annotation.__qualname__}",
        }
    elif isinstance(annotation, type):
        try:
            hints = get_type_hints(annotation, include_extras=True)
        except (NameError, TypeError):
            hints = inspect.get_annotations(annotation, eval_str=False)
        properties = {
            name: _schema_for_annotation(field_annotation)
            for name, field_annotation in hints.items()
        }
        required = list(properties)
        if is_dataclass(annotation):
            required = [
                field.name
                for field in fields(annotation)
                if field.default is MISSING and field.default_factory is MISSING
            ]
        schema = {
            "type": "object",
            "properties": properties,
            "additionalProperties": False,
        }
        if required:
            schema["required"] = required
        if is_dataclass(annotation):
            schema["x-omp-python-type"] = (
                f"{annotation.__module__}.{annotation.__qualname__}"
            )
    else:
        schema = {}
    for item in metadata:
        if isinstance(item, Field) and item.description:
            schema["description"] = item.description
    return schema



def _worker_handler(
    definition: DeviceDefinition, kind: object
) -> Callable[[Mapping[str, object], object], Awaitable[object]]:
    body = definition.body
    ergonomic = kind in {"soft", "hard"} and hasattr(body, "__omp_tool_kind__")

    async def invoke(params: Mapping[str, object], context: object) -> object:
        if not isinstance(params, Mapping):
            raise TypeError("worker tool arguments must decode to an object")
        if ergonomic:
            signature = inspect.signature(body)
            positional: list[object] = []
            keywords: dict[str, object] = {}
            consumed: set[str] = set()
            has_var_kwargs = False
            for parameter in signature.parameters.values():
                if parameter.name == "ctx":
                    value = context
                elif parameter.kind is inspect.Parameter.VAR_KEYWORD:
                    has_var_kwargs = True
                    continue
                elif parameter.kind is inspect.Parameter.VAR_POSITIONAL:
                    continue
                elif parameter.name in params:
                    value = params[parameter.name]
                    consumed.add(parameter.name)
                elif parameter.default is not inspect.Parameter.empty:
                    continue
                else:
                    raise TypeError(f"missing required tool argument {parameter.name!r}")
                if parameter.kind is inspect.Parameter.POSITIONAL_ONLY:
                    positional.append(value)
                else:
                    keywords[parameter.name] = value
            unexpected = set(params).difference(consumed)
            if unexpected and not has_var_kwargs:
                raise TypeError(f"unexpected tool argument {sorted(unexpected)[0]!r}")
            if has_var_kwargs:
                keywords.update((name, params[name]) for name in unexpected)
            result = body(*positional, **keywords)
        else:
            parameters = tuple(inspect.signature(body).parameters.values())
            result = body(params, context) if len(parameters) > 1 else body(params)
        if inspect.isawaitable(result):
            return await result
        return result

    return invoke


def _extract_arg_specs(body: object, schema: object | None) -> tuple[ArgSpec, ...]:
    from . import Coerce, Field

    annotations: list[tuple[str, object]] = []
    if isinstance(schema, type):
        try:
            schema_hints = get_type_hints(schema, include_extras=True)
        except (NameError, TypeError):
            schema_hints = inspect.get_annotations(schema, eval_str=False)
        annotations.extend(schema_hints.items())
    try:
        body_hints = get_type_hints(body, include_extras=True)
    except (NameError, TypeError):
        body_hints = inspect.get_annotations(body, eval_str=False)
    try:
        parameters = inspect.signature(body).parameters
    except (TypeError, ValueError):
        parameters = {}
    annotations.extend(
        (name, body_hints[name]) for name in parameters if name in body_hints
    )

    specs: list[ArgSpec] = []
    seen_paths: set[str] = set()
    for name, annotation in annotations:
        metadata = tuple(_annotation_metadata(annotation))
        fields = tuple(item for item in metadata if isinstance(item, Field))
        coercions = tuple(item for item in metadata if isinstance(item, Coerce))
        if not fields and not coercions:
            continue
        if len(fields) > 1:
            raise TypeError(f"argument {name!r} carries more than one omp.Field")
        field = fields[0] if fields else Field()
        if name in seen_paths:
            raise TypeError(f"argument metadata path is declared twice: {name!r}")
        seen_paths.add(name)
        specs.append(
            ArgSpec(
                path=(name,),
                aliases=field.alias,
                coerce=field.coerce + coercions,
                expected=field.expected,
                example=field.example,
                description=field.description,
                additional_properties=field.additional_properties,
            )
        )
    return tuple(specs)


def _annotation_metadata(annotation: object) -> Iterable[object]:
    origin = get_origin(annotation)
    arguments = get_args(annotation)
    if origin is Annotated:
        yield from arguments[1:]
        yield from _annotation_metadata(arguments[0])
        return
    for argument in arguments:
        yield from _annotation_metadata(argument)


def _tool_key(name: str, family: str, rev: int) -> _ToolKey:
    if not name:
        raise ValueError("tool name must be non-empty")
    if isinstance(rev, bool) or not isinstance(rev, int) or not 0 <= rev <= 65_535:
        raise ValueError("tool rev must be an unsigned 16-bit integer")
    return name, family, rev


def _hook_key(event: str, phase: object) -> _HookKey:
    if not event:
        raise ValueError("hook event must be non-empty")
    value = getattr(phase, "value", phase)
    if not isinstance(value, str) or not value:
        raise ValueError("hook phase must be a non-empty string enum")
    return event, value.lower()


def _entry_kind_key(name: str, rev: str) -> _EntryKindKey:
    if not isinstance(name, str) or "." not in name or name.startswith("omp."):
        raise ValueError("entry kind name must be a non-core globally qualified name")
    if not isinstance(rev, str):
        raise TypeError("entry kind rev must be a string")
    family, separator, number = rev.rpartition(".")
    if not separator or not family or not number.isascii() or not number.isdigit():
        raise ValueError("entry kind rev must have the form '<family>.<n>'")
    return name, rev


def _service_key(name: str, rev: int) -> _ServiceKey:
    if not name or "." not in name:
        raise ValueError("service name must be globally qualified")
    if (
        isinstance(rev, bool)
        or not isinstance(rev, int)
        or not 1 <= rev <= 4_294_967_295
    ):
        raise ValueError("service rev must be a positive unsigned 32-bit integer")
    return name, rev


__all__ = (
    "ApproverDefinition",
    "ArgSpec",
    "ControlServiceTransport",
    "DeclarationDrift",
    "CommandDefinition",
    "ShortcutDefinition",
    "DeclarationRegistry",
    "ChildDeviceDefinition",
    "DeviceDefinition",
    "DeclarationSnapshot",
    "PreludeDefinition",
    "PreludeParamSpec",
    "MAX_DECLARATIONS",
    "QuotaExceeded",
    "EntryKindDefinition",
    "ExportDefinition",
    "QuotaStatus",
    "ResourceReceipt",
    "ServiceClient",
    "ServiceDefinition",
    "ServiceMethodDefinition",
    "Services",
    "WorkerToolDefinition",
    "entry_kind",
    "configure_manifest",
    "dispatch_service",
    "freeze_declarations",
    "prelude_definitions",
    "registry",
    "resources",
    "service",
    "services",
)
