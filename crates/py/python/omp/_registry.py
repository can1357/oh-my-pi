"""Frozen extension declarations and manifest-gated CONTROL services.

Importing this module performs no I/O and does not open either host socket. The
host installs its existing CONTROL request transport only after declaration
verification; journal entries and agent messages are never accepted as service
transports.
"""

from __future__ import annotations

import importlib
import importlib.util
import inspect
import json
import sys
from collections.abc import Awaitable, Callable, Iterable, Mapping
from dataclasses import MISSING, dataclass, fields, is_dataclass, replace
from enum import Enum, StrEnum
from pathlib import Path
from types import MappingProxyType, UnionType
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
_HookSubscriptionKey = tuple[str, str, str]
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
        "director",
        "component",
        "worker",
        "provider",
        "prompt_slot",
        "command",
        "shortcut",
        "completion",
        "message_renderer",
        "markdown_transformer",
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
    constraint: object | None
    serial: bool
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
    """One runnable tool projection retained by the sealed CONTROL registry."""

    name: str
    family: str
    rev: int
    description: str
    schema: object
    strict: bool | None
    streams_args: bool
    handler: object
    source_module: str
    kind: str
    place: object
    effects: object | None
    constraint: object | None
    serial: bool
    precedence: int = 0
    replaces: str | None = None
    summary: str | None = None
    docs: object | None = None
    examples: tuple[object, ...] = ()
    legacy: bool = False


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
class SkillDecl:
    """One deterministic extension-authored generated skill resource."""

    name: str
    description: str
    hidden: bool
    disable_model_invocation: bool
    autoload: bool
    contain_root: str | None
    path: str
    content: bytes

    @property
    def metadata(self) -> Mapping[str, object]:
        """Return the exact signed metadata projected into the content row."""

        values: dict[str, object] = {
            "name": self.name,
            "description": self.description,
            "hidden": self.hidden,
            "disable_model_invocation": self.disable_model_invocation,
            "autoload": self.autoload,
        }
        if self.contain_root is not None:
            values["contain_root"] = self.contain_root
        return MappingProxyType(values)

    @property
    def declaration(self) -> _packages.ContentDeclaration:
        """Lower this generated resource to the uniform manifest row."""

        return _packages.ContentDeclaration(
            kind=_packages.ContentKind.SKILLS,
            path=self.path,
            metadata=self.metadata,
        )


@dataclass(frozen=True, slots=True)
class HookDefinition:
    """One import-time hook subscription and its activation trigger."""

    event: str
    phase: str
    handler: object
    trigger: _ActivationTrigger
    def __getattr__(self, name: str) -> object: return getattr(self.handler, name)


@dataclass(frozen=True, slots=True)
class DirectorDefinition:
    """One lifecycle behavior registered on the engine Director stack."""

    id: str
    callable: object
    claims: tuple[str, ...]
    binds: Mapping[str, bool | int | float | str]
    trigger: _ActivationTrigger = _ActivationTrigger.LAZY


@dataclass(frozen=True, slots=True)
class ComponentDefinition:
    """One pure journal-to-``<meta>`` component reducer."""

    id: str
    callable: object
    interested: tuple[str, ...]
    trigger: _ActivationTrigger = _ActivationTrigger.LAZY


@dataclass(frozen=True, slots=True)
class UIDefinition:
    """One UI callback declaration stored by the shared registry."""

    kind: str
    name: object
    value: object
    metadata: object | None
    trigger: _ActivationTrigger


@dataclass(frozen=True, slots=True)
class DeclarationSnapshot:
    """Immutable view of the complete decorator registry."""

    skills: tuple[SkillDecl, ...]
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
    directors: tuple[DirectorDefinition, ...] = ()
    components: tuple[ComponentDefinition, ...] = ()
    completions: tuple[UIDefinition, ...] = ()
    message_renderers: tuple[UIDefinition, ...] = ()
    markdown_transformers: tuple[UIDefinition, ...] = ()
    verdict_renderers: tuple[UIDefinition, ...] = ()


class DeclarationRegistry:
    """Process-local declaration authority sealed exactly once at FREEZE."""

    __slots__ = (
        "_approvers",
        "_configured",
        "_commands",
        "_completions",
        "_message_renderers",
        "_markdown_transformers",
        "_verdict_renderers",
        "_shortcuts",
        "_device_claims",
        "_device_definitions",
        "_child_device_definitions",
        "_device_states",
        "_directors",
        "_components",
        "_export_sequence",
        "_exports",
        "_extension_id",
        "_providers",
        "_provider_candidates",
        "_hooks",
        "_hook_definitions",
        "_prompt_slots",
        "_preludes",
        "_telemetry",
        "_manifest_hooks",
        "_manifest_capabilities",
        "_manifest_executables",
        "_uniform_manifest_configured",
        "_trust_runtime_declarations",
        "_manifest_requires",
        "_manifest_services",
        "_manifest_tools",
        "_legacy_worker_tools",
        "_sealed",
        "_service_instances",
        "_services",
        "_skills",
        "_manifest_content",
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
        self._markdown_transformers: dict[object, UIDefinition] = {}
        self._verdict_renderers: dict[object, UIDefinition] = {}
        self._shortcuts: dict[str, ShortcutDefinition] = {}
        self._tools: dict[_ToolKey, object] = {}
        self._device_definitions: dict[_ToolKey, DeviceDefinition] = {}
        self._child_device_definitions: dict[_ToolKey, ChildDeviceDefinition] = {}
        self._device_claims: dict[
            str, list[tuple[int, str | None, _ToolKey]]
        ] = {}
        self._device_states: dict[_ToolKey, tuple[bool, str | None]] = {}
        self._directors: dict[str, DirectorDefinition] = {}
        self._components: dict[str, ComponentDefinition] = {}
        self._provider_candidates: dict[_ProviderKey, list[ProviderDefinition]] = {}
        self._providers: dict[_ProviderKey, ProviderDefinition] = {}
        self._hooks: dict[_HookSubscriptionKey, object] = {}
        self._hook_definitions: dict[_HookSubscriptionKey, HookDefinition] = {}
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
        self._manifest_content: tuple[_packages.ContentDeclaration, ...] = ()
        self._skills: dict[str, SkillDecl] = {}
        self._manifest_executables: dict[
            tuple[str, str], _ExecutableDeclaration
        ] = {}
        self._uniform_manifest_configured = False
        self._trust_runtime_declarations = False
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
        trust_runtime_declarations: bool = False,
    ) -> None:
        """Install authoritative manifest sets before the first module import."""

        self._ensure_open("manifest")
        if not isinstance(trust_runtime_declarations, bool):
            raise TypeError("trust_runtime_declarations must be bool")
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
            or self._directors
            or self._components
            or self._services
            or self._commands
            or self._completions
            or self._message_renderers
            or self._markdown_transformers
            or self._verdict_renderers
            or self._shortcuts
            or self._approvers
            or self._preludes
            or self._skills
        ):
            raise RuntimeError("manifest must be configured before declaration import")
        if declarations is not None:
            self._manifest_content = tuple(content_declarations)
            _packages._configure_own_declarations(
                extension, self._manifest_content
            )
        if declarations is None:
            self._manifest_tools = frozenset(_tool_key(*item) for item in tools)
            self._manifest_hooks = frozenset(_hook_key(*item) for item in hooks)
            self._manifest_services = frozenset(
                _service_key(*item) for item in services
            )
        else:
            self._manifest_tools = frozenset()
            self._manifest_hooks = frozenset()
            self._manifest_services = frozenset()
        normalized_capabilities = frozenset(capabilities)
        if any(
            not isinstance(capability, str) or not capability
            for capability in normalized_capabilities
        ):
            raise ManifestError("omp.toml", "capabilities", "capabilities must be non-empty strings")
        self._manifest_capabilities = normalized_capabilities
        self._manifest_requires = frozenset(_service_key(*item) for item in requires)
        self._manifest_executables = executable_declarations
        self._uniform_manifest_configured = declarations is not None
        self._trust_runtime_declarations = trust_runtime_declarations
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
            effects=None,
            constraint=None,
            serial=False,
            summary=description or None,
            legacy=True,
        )
        self.register_tool(name, family, rev, handler)
        self._legacy_worker_tools[key] = projected
        return projected

    def _control_tool_key(self, key: _ToolKey) -> _ToolKey:
        """Map decorator sugar to the exact authenticated manifest identity."""

        if key in self._manifest_tools:
            return key
        name, family, rev = key
        manifest_key = (name, "", rev)
        definition = self._device_definitions.get(key)
        body = None if definition is None else definition.body
        kind = getattr(body, "__omp_tool_kind__", None)
        uniform = (
            self._manifest_executables.get(
                (str(kind), _manifest_tool_static_key(manifest_key))
            )
            if kind in {"soft", "hard"}
            else None
        )
        if (
            family == (self._extension_id or "")
            and body is not None
            and kind in {"soft", "hard"}
            and (
                manifest_key in self._manifest_tools
                or uniform is not None
            )
        ):
            return manifest_key
        return key

    def worker_tool_definitions(self) -> tuple[WorkerToolDefinition, ...]:
        """Project every sealed tool identity to one runnable CONTROL row."""

        if not self._verified:
            raise RuntimeError("CONTROL tools are unavailable before FREEZE")
        projected: list[WorkerToolDefinition] = []
        for key in sorted(self._tools):
            control_key = self._control_tool_key(key)
            if key in self._legacy_worker_tools:
                legacy = self._legacy_worker_tools[key]
                static_key = _manifest_tool_static_key(control_key)
                declared_kind = next(
                    (
                        kind
                        for kind in ("soft", "hard")
                        if (kind, static_key) in self._manifest_executables
                    ),
                    legacy.kind,
                )
                projected.append(replace(legacy, kind=declared_kind))
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
                    name=control_key[0],
                    family=control_key[1],
                    rev=control_key[2],
                    description=_worker_description(definition),
                    schema=_worker_schema(definition, kind),
                    strict=True if kind == "hard" else None,
                    streams_args=False,
                    handler=_worker_handler(definition, kind),
                    source_module=source_module,
                    kind=kind,
                    place=str(definition.place),
                    effects=definition.effects,
                    constraint=definition.constraint,
                    serial=definition.serial,
                    precedence=definition.precedence,
                    replaces=definition.replaces,
                    summary=definition.summary,
                    docs=definition.docs,
                    examples=definition.examples,
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
        """Records a named hook subscription during sequential manifest import."""

        key = _hook_subscription_key(event, phase, getattr(handler, "name", None))
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
    def register_director(
        self,
        director_id: str,
        callback: object,
        claims: tuple[str, ...],
        binds: Mapping[str, bool | int | float | str],
    ) -> object:
        """Record one Director callback during sequential manifest import."""

        definition = DirectorDefinition(director_id, callback, claims, binds)
        self._insert(self._directors, director_id, definition, "director")
        return callback

    def director_definitions(self) -> tuple[DirectorDefinition, ...]:
        """Return Director declarations in stable identifier order."""

        return tuple(self._directors[key] for key in sorted(self._directors))

    def register_component(
        self,
        component_id: str,
        callback: object,
        interested: tuple[str, ...],
    ) -> object:
        """Record one journal-to-DOM Component callback."""

        definition = ComponentDefinition(component_id, callback, interested)
        self._insert(self._components, component_id, definition, "component")
        return callback

    def component_definitions(self) -> tuple[ComponentDefinition, ...]:
        """Return Component declarations in stable identifier order."""

        return tuple(self._components[key] for key in sorted(self._components))

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
        self,
        kind: str,
        name: object,
        value: object,
        *,
        metadata: object | None = None,
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
            "markdown_transformer": (
                self._markdown_transformers,
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
                "markdown_transformer, or verdict_renderer"
            ) from error
        try:
            hash(name)
        except TypeError as error:
            raise TypeError("UI declaration name must be hashable") from error
        definition = UIDefinition(kind, name, value, metadata, trigger)
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

    def register_skill(self, declaration: SkillDecl) -> SkillDecl:
        """Record one already-lowered generated skill before FREEZE."""

        self._ensure_open(declaration.name)
        self._check_declaration_limit()
        self._insert(self._skills, declaration.name, declaration, "skill")
        return declaration

    def skill_declarations(self) -> tuple[SkillDecl, ...]:
        """Return generated skill resources in deterministic name order."""

        return tuple(self._skills[name] for name in sorted(self._skills))

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
        if (
            self._configured
            and not self._uniform_manifest_configured
            and not self._trust_runtime_declarations
        ):
            actual_tools = frozenset(
                self._control_tool_key(key) for key in self._tools
            ).union(
                (definition.name, "prelude", definition.rev)
                for definition in self._preludes.values()
            )
            missing_tools = self._manifest_tools.difference(actual_tools)
            undeclared_tools = actual_tools.difference(self._manifest_tools)
            actual_hooks = frozenset(key[:2] for key in self._hooks)
            missing_hooks = self._manifest_hooks.difference(actual_hooks)
            undeclared_hooks = actual_hooks.difference(self._manifest_hooks)
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
        if self._uniform_manifest_configured and not self._trust_runtime_declarations:
            manifest_declarations = frozenset(self._manifest_executables)
            decorated_declarations = self._decorated_executable_keys()
            missing_declarations = manifest_declarations.difference(
                decorated_declarations
            )
            undeclared_declarations = decorated_declarations.difference(
                manifest_declarations
            )
        if self._configured and not self._trust_runtime_declarations:
            manifest_skills = tuple(
                declaration
                for declaration in self._manifest_content
                if declaration.kind is _packages.ContentKind.SKILLS
                and ".omp-generated/skills/" in declaration.path
            )
            decorated_skills = tuple(
                declaration.declaration for declaration in self.skill_declarations()
            )
            if manifest_skills != decorated_skills:
                missing_declarations = missing_declarations.union(
                    ("skills", declaration.path)
                    for declaration in manifest_skills
                    if declaration not in decorated_skills
                )
                undeclared_declarations = undeclared_declarations.union(
                    ("skills", declaration.path)
                    for declaration in decorated_skills
                    if declaration not in manifest_skills
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
                (
                    str(kind or "soft"),
                    _manifest_tool_static_key(self._control_tool_key(key)),
                )
            )
        declarations.update(
            ("hook", _manifest_hook_static_key(key[:2])) for key in self._hooks
        )
        declarations.update(("director", key) for key in self._directors)
        declarations.update(("component", key) for key in self._components)
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
            ("message_renderer", self._markdown_transformers),
            ("verdict_renderer", self._verdict_renderers),
        ):
            declarations.update(
                (kind, _ui_manifest_key(kind, name)) for name in values
            )
        return frozenset(declarations)

    def snapshot(self) -> DeclarationSnapshot:
        """Returns the current declaration existence sets without mutation."""

        return DeclarationSnapshot(
            skills=self.skill_declarations(),
            tools=frozenset(self._tools),
            capabilities=self._manifest_capabilities,
            hooks=frozenset(key[:2] for key in self._hooks),
            services=frozenset(self._services),
            preludes=self.prelude_definitions(),
            commands=self.command_definitions(),
            shortcuts=self.shortcut_definitions(),
            telemetry=tuple(self._telemetry[key] for key in sorted(self._telemetry)),
            prompt_slots=tuple(
                self._prompt_slots[key] for key in sorted(self._prompt_slots)
            ),
            providers=self.provider_definitions(),
            directors=self.director_definitions(),
            components=self.component_definitions(),
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
            markdown_transformers=tuple(
                self._markdown_transformers[key]
                for key in sorted(self._markdown_transformers, key=repr)
            ),
            verdict_renderers=tuple(
                self._verdict_renderers[key]
                for key in sorted(self._verdict_renderers, key=repr)
            ),
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
            + len(self._directors)
            + len(self._components)
            + len(self._approvers)
            + len(self._services)
            + len(self._telemetry)
            + len(self._prompt_slots)
            + sum(len(candidates) for candidates in self._provider_candidates.values())
            + len(self._workers)
            + len(self._exports)
            + len(self._preludes)
            + len(self._skills)
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
    trust_runtime_declarations: bool = False,
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
        trust_runtime_declarations=trust_runtime_declarations,
    )


def freeze_declarations() -> DeclarationSnapshot:
    """Runs the FREEZE transition without socket or filesystem work."""

    return registry.freeze()

def prelude_definitions() -> tuple[PreludeDefinition, ...]:
    """Return registered eval-prelude helpers in deterministic name order."""

    return registry.prelude_definitions()

def bootstrap_extension_registry(
    manifest_json: str,
    modules: Iterable[str],
    entry_path: str | None = None,
) -> DeclarationSnapshot:
    """Configure, exactly load the entry, import declarations, and seal."""

    manifest = json.loads(manifest_json)
    if not isinstance(manifest, Mapping):
        raise TypeError("extension manifest snapshot must encode an object")
    configure_manifest(
        tools=manifest.get("tools", ()),
        hooks=manifest.get("hooks", ()),
        capabilities=manifest.get("capabilities", ()),
        services=manifest.get("services", ()),
        requires=manifest.get("requires", ()),
        declarations=manifest.get("declarations"),
        extension=manifest.get("extension"),
        trust_runtime_declarations=manifest.get(
            "trust_runtime_declarations", False
        ),
    )
    if entry_path is not None and (
        not isinstance(entry_path, str) or not entry_path
    ):
        raise TypeError("extension entry path must be a non-empty string or None")
    seen: set[str] = set()
    for index, module_name in enumerate(modules):
        if not isinstance(module_name, str) or not module_name:
            raise TypeError("worker import modules must be non-empty strings")
        if module_name in seen:
            continue
        seen.add(module_name)
        if index == 0 and entry_path is not None:
            module = _load_entry_module(module_name, entry_path)
        else:
            module = importlib.import_module(module_name)
        legacy = getattr(module, "OMP_TOOLS", ())
        for declaration in legacy:
            register_legacy_worker_tool(declaration)
    freeze_declarations()
    return registry.snapshot()


def _load_entry_module(module_name: str, entry_path: str) -> object:
    """Execute the operator-admitted entry file under its exact module name."""

    path = Path(entry_path)
    package_paths = [str(path.parent)] if path.name == "__init__.py" else None
    spec = importlib.util.spec_from_file_location(
        module_name,
        path,
        submodule_search_locations=package_paths,
    )
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot load extension entry {module_name!r} from {entry_path!r}")
    module = importlib.util.module_from_spec(spec)
    previous = sys.modules.get(module_name)
    sys.modules[module_name] = module
    try:
        spec.loader.exec_module(module)
    except BaseException:
        if previous is None:
            sys.modules.pop(module_name, None)
        else:
            sys.modules[module_name] = previous
        raise
    return module


def register_legacy_worker_tool(
    declaration: Mapping[str, object],
) -> WorkerToolDefinition:
    """Register one documented legacy ``OMP_TOOLS`` row before FREEZE."""

    return registry.register_legacy_worker_tool(declaration)


def project_control_registry() -> dict[str, object]:
    """Project every frozen declaration needed by the Rust CONTROL supervisor."""

    if not registry.sealed:
        raise RuntimeError("CONTROL registry projection requires FREEZE")
    snapshot = registry.snapshot()
    tools = registry.worker_tool_definitions()
    return {
        "declaration_keys": [
            {"kind": kind, "key": key}
            for kind, key in sorted(registry._decorated_executable_keys())
        ],
        "tools": [
            {
                "name": tool.name,
                "family": tool.family,
                "rev": tool.rev,
                "description": tool.description,
                "schema": _control_wire_value(tool.schema),
                "strict": tool.strict,
                "streams_args": tool.streams_args,
                "source_module": tool.source_module,
                "kind": tool.kind,
                "place": str(tool.place),
                "effects": _control_wire_value(tool.effects),
                "constraint": _control_wire_value(tool.constraint),
                "serial": tool.serial,
                "precedence": max(0, tool.precedence),
                "replaces": tool.replaces,
                "summary": tool.summary,
                "docs": _control_wire_value(tool.docs),
                "examples": _control_wire_value(tool.examples),
                "callback": {
                    "operation": "omp.devices.call",
                    "path": tool.name,
                    "family": tool.family,
                    "rev": tool.rev,
                },
            }
            for tool in tools
        ],
        "preludes": [
            {
                "name": definition.name,
                "rev": definition.rev,
                "doc": definition.doc,
                "summary": definition.summary,
                "source_module": getattr(definition.body, "__module__", ""),
                "params": [
                    {
                        "name": parameter.name,
                        "kind": parameter.kind,
                        "default_json": parameter.default_json,
                        "annotation": parameter.annotation,
                    }
                    for parameter in definition.params
                ],
                "callback": {
                    "operation": "omp.devices.call",
                    "path": definition.name,
                    "family": "prelude",
                    "rev": definition.rev,
                },
            }
            for definition in snapshot.preludes
        ],
        "availability": [
            {
                "name": name,
                "family": family,
                "rev": rev,
                "mounted": mounted,
                "reason": reason,
            }
            for key, mounted, reason in snapshot.device_states
            for name, family, rev in (registry._control_tool_key(key),)
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
                "timeout": _control_wire_value(declaration.timeout),
                "concurrency": declaration.concurrency,
                "threadsafe": declaration.threadsafe,
                "callback": _control_wire_value(declaration.handler.handler),
                "when": _control_wire_value(declaration.when),
                "event_rev": _hook_catalog(declaration.event).rev,
                "event_on_failure": _hook_catalog(declaration.event).on_failure.value,
                "event_default": (
                    "allow" if _hook_catalog(declaration.event).gateable else None
                ),
                "event_timeout": _control_wire_value(
                    _hook_catalog(declaration.event).default_timeout
                ),
                "composition": {
                    name: value.value
                    for name, value in _hook_catalog(declaration.event).fields.items()
                },
            }
            for declaration in snapshot.hook_definitions
        ],
        "skills": [
            {
                "path": declaration.path,
                "metadata": dict(declaration.metadata),
            }
            for declaration in snapshot.skills
        ],
        "services": [
            {
                "name": definition.name,
                "rev": definition.rev,
                "source_module": definition.implementation.__module__,
                "methods": [
                    _control_wire_value(method)
                    for method in definition.method_schemas
                ],
                "callback": {"operation": "omp.services.dispatch"},
            }
            for definition in snapshot.service_definitions
        ],
        "prompt_slots": [
            {
                "slot": definition.slot,
                "priority": definition.priority,
                "class": definition.cls,
                "callback": _control_wire_value(definition.renderer),
                "trigger": definition.trigger.value,
            }
            for definition in snapshot.prompt_slots
        ],
        "providers": [_control_wire_value(value) for value in snapshot.providers],
        "directors": [_control_wire_value(value) for value in snapshot.directors],
        "components": [_control_wire_value(value) for value in snapshot.components],
        "commands": [_control_wire_value(value) for value in snapshot.commands],
        "shortcuts": [_control_wire_value(value) for value in snapshot.shortcuts],
        "telemetry": [_control_wire_value(value) for value in snapshot.telemetry],
        "workers": [_control_wire_value(value) for value in snapshot.workers],
        "exports": [_control_wire_value(value) for value in snapshot.exports],
        "approvers": [_control_wire_value(value) for value in snapshot.approvers],
        "completions": [_control_wire_value(value) for value in snapshot.completions],
        "message_renderers": [
            _control_wire_value(value) for value in snapshot.message_renderers
        ],
        "markdown_transformers": [
            _control_wire_value(value) for value in snapshot.markdown_transformers
        ],
        "verdict_renderers": [
            _control_wire_value(value) for value in snapshot.verdict_renderers
        ],
    }


def _hook_catalog(event: str) -> object:
    """Return the frozen event policy paired with a hook declaration."""

    from .events import spec

    return spec(event)


def _control_wire_value(value: object) -> object:
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
        return _control_wire_value(value.value)
    if isinstance(value, bytes):
        return value.hex()
    if isinstance(value, Mapping):
        return {
            str(key): _control_wire_value(item)
            for key, item in sorted(value.items(), key=lambda pair: str(pair[0]))
        }
    if isinstance(value, (tuple, list)):
        return [_control_wire_value(item) for item in value]
    if isinstance(value, (set, frozenset)):
        return [
            _control_wire_value(item)
            for item in sorted(value, key=lambda item: repr(item))
        ]
    if is_dataclass(value) and not isinstance(value, type):
        return {
            field.name: _control_wire_value(getattr(value, field.name))
            for field in fields(value)
        }
    return str(value)




def skill(
    name: str,
    *,
    description: str,
    hidden: bool = False,
    disable_model_invocation: bool = False,
    autoload: bool = False,
    contain_root: str | None = None,
) -> Callable[[Callable[[], str]], Callable[[], str]]:
    """Declare and deterministically lower one generated ``SKILL.md`` resource."""

    if (
        not isinstance(name, str)
        or not 1 <= len(name) <= 64
        or not name[0].isalnum()
        or name != name.lower()
        or any(
            not character.isascii()
            or not (character.isalnum() or character == "-")
            for character in name
        )
    ):
        raise ValueError(
            "skill name must be 1-64 lowercase ASCII letters, digits, or hyphens "
            "and start with a letter or digit"
        )
    if not isinstance(description, str):
        raise TypeError("skill description must be str")
    description = " ".join(description.split())
    if not description:
        raise ValueError("skill description must not be empty")
    for field_name, value in (
        ("hidden", hidden),
        ("disable_model_invocation", disable_model_invocation),
        ("autoload", autoload),
    ):
        if not isinstance(value, bool):
            raise TypeError(f"skill {field_name} must be bool")
    if contain_root is not None:
        if not isinstance(contain_root, str):
            raise TypeError("skill contain_root must be str or None")
        parts = contain_root.replace("\\", "/").split("/")
        if (
            not contain_root
            or contain_root.startswith("/")
            or any(part in {"", ".", ".."} for part in parts)
        ):
            raise ValueError("skill contain_root must be a contained relative POSIX path")
        contain_root = "/".join(parts)

    def decorate(function: Callable[[], str]) -> Callable[[], str]:
        registry._ensure_open(name)
        declaration = _lower_skill_declaration(
            function,
            name=name,
            description=description,
            hidden=hidden,
            disable_model_invocation=disable_model_invocation,
            autoload=autoload,
            contain_root=contain_root,
        )
        registry.register_skill(declaration)
        return function

    return decorate


def _lower_skill_declaration(
    function: Callable[[], str],
    *,
    name: str,
    description: str,
    hidden: bool,
    disable_model_invocation: bool,
    autoload: bool,
    contain_root: str | None,
) -> SkillDecl:
    """Evaluate one skill body exactly once and produce deterministic bytes."""

    if not callable(function):
        raise TypeError("@omp.skill may decorate only a callable")
    signature = inspect.signature(function)
    if signature.parameters:
        raise TypeError("@omp.skill callable must take no arguments")
    module_root = function.__module__.split(".", 1)[0]
    if not module_root or module_root == "__main__":
        module_root = "extension"
    body = function()
    if not isinstance(body, str):
        raise TypeError("@omp.skill callable must return str")
    body = body.strip()
    escaped_description = description.replace("'", "''")
    lines = [
        "---",
        f"name: {name}",
        f"description: '{escaped_description}'",
    ]
    if hidden:
        lines.append("hidden: true")
    if disable_model_invocation:
        lines.append("disableModelInvocation: true")
    if autoload:
        lines.append("alwaysApply: true")
    lines.extend(("---", "", body, ""))
    content = "\n".join(lines).encode()
    if len(content) > 64_000:
        raise ValueError("generated skill exceeds the 64,000-byte UTF-8 limit")
    return SkillDecl(
        name=name,
        description=description,
        hidden=hidden,
        disable_model_invocation=disable_model_invocation,
        autoload=autoload,
        contain_root=contain_root,
        path=f"{module_root}/.omp-generated/skills/{name}/SKILL.md",
        content=content,
    )


def service(name: str, *, rev: int) -> Callable[[_T], _T]:
    """Declares an async inter-extension service implementation."""

    key = _service_key(name, rev)

    def decorate(implementation: _T) -> _T:
        registry.register_service(key[0], key[1], implementation)
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


async def dispatch_device_control(
    path: str,
    args: Mapping[str, object],
    *,
    family: str | None = None,
    rev: int | None = None,
) -> object:
    """Dispatch one exact frozen tool or prelude through its live update sink."""

    if family == "prelude":
        result = dispatch_prelude(path, args, family=family, rev=rev)
        if inspect.isawaitable(result):
            result = await result
        return _lower_worker_result(result)
    matches = tuple(
        definition
        for definition in registry.worker_tool_definitions()
        if definition.name == path
        and (family is None or definition.family == family)
        and (rev is None or definition.rev == rev)
    )
    if len(matches) == 1:
        if matches[0].legacy:
            return await _consume_worker_result(matches[0].handler(dict(args)))
        from . import Context

        try:
            context = Context.current()
        except LookupError:
            context = None
        return await matches[0].handler(args, context)
    from .devices import _dispatch_device

    return await _dispatch_device(path, args, family=family, rev=rev)


def dispatch_prelude(
    path: str,
    args: Mapping[str, object],
    *,
    family: str | None = None,
    rev: int | None = None,
) -> object:
    """Invoke one exact frozen eval-prelude helper over CONTROL."""

    if not isinstance(path, str) or not path:
        raise LookupError("prelude dispatch omitted its helper name")
    if family != "prelude" or isinstance(rev, bool) or not isinstance(rev, int):
        raise LookupError("prelude dispatch omitted its exact revision")
    if not isinstance(args, Mapping):
        raise TypeError("prelude dispatch arguments must be a mapping")
    matches = tuple(
        definition
        for definition in registry.prelude_definitions()
        if definition.name == path and definition.rev == rev
    )
    if len(matches) != 1:
        raise LookupError(
            f"prelude helper {path!r} rev {rev} does not match one frozen declaration"
        )
    return matches[0].handler(dict(args))


def dispatch_prompt_slot(
    slot: str,
    callback: str,
    context: Mapping[str, object],
) -> dict[str, object]:
    """Render one exact frozen prompt contribution received over CONTROL."""

    if not isinstance(slot, str) or not slot:
        raise ValueError("prompt dispatch slot must be a non-empty string")
    if not isinstance(callback, str) or not callback:
        raise ValueError("prompt dispatch callback must be a non-empty string")
    if not isinstance(context, Mapping):
        raise TypeError("prompt dispatch context must be a mapping")
    matches = tuple(
        definition
        for definition in registry.snapshot().prompt_slots
        if definition.slot == slot
        and _control_wire_value(definition.renderer).get("$omp.callable") == callback
    )
    if len(matches) != 1:
        raise LookupError("prompt dispatch does not match one frozen declaration")
    from .prompts import PromptContext, SlotClass, VolatilePrompt

    values = dict(context)
    values["slot"] = slot
    values["cls"] = SlotClass(str(values.get("cls", matches[0].cls)))
    values["roots"] = tuple(map(str, values.get("roots", ())))
    prompt_context = PromptContext(**values)
    first = matches[0].renderer(prompt_context)
    second = matches[0].renderer(prompt_context)
    if not isinstance(first, str) or not isinstance(second, str):
        raise TypeError("prompt-slot renderers must return str")
    if first != second:
        raise VolatilePrompt(f"prompt-slot renderer {callback!r} returned unstable bytes")
    return {"slot": slot, "callback": callback, "content": first}




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
    optional = {
        "command": frozenset(
            {"aliases", "description", "args", "hint", "callback", "arg_completions"}
        ),
        "shortcut": frozenset(
            {"action_id", "action", "description", "when", "callback"}
        ),
        "completion": frozenset(
            {
                "callback",
                "at_line_start",
                "min_chars",
                "debounce",
                "max_results",
                "cache",
                "refine_locally",
            }
        ),
    }.get(value.get("kind"), frozenset())
    unknown = fields.difference(required | optional | {"grants"})
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



def _bind_tool_arguments(
    body: object, params: Mapping[str, object], context: object
) -> tuple[list[object], dict[str, object]]:
    """Ergonomic parameter binding shared by decorated and legacy CONTROL tools.

    ``ctx`` parameters receive ``context``; every other parameter binds from
    ``params`` with defaults honored, unknown arguments rejected unless the
    body declares ``**kwargs``.
    """
    if context is not None:
        from ._host import dispatch_update_sink

        context = replace(context, _update_sink=dispatch_update_sink())
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
    return positional, keywords


async def _consume_worker_result(result: object) -> object:
    """Emit every yielded update before lowering one terminal device result."""

    from ._host import emit_dispatch_update
    from ._verdicts import Done, Update

    if inspect.isawaitable(result):
        result = await result
    if inspect.isasyncgen(result):
        terminal: object = None
        async for item in result:
            if isinstance(item, Done):
                terminal = item.result
                break
            emit_dispatch_update(item.payload if isinstance(item, Update) else item)
        result = terminal
    elif inspect.isgenerator(result):
        terminal = None
        for item in result:
            if isinstance(item, Done):
                terminal = item.result
                break
            emit_dispatch_update(item.payload if isinstance(item, Update) else item)
        result = terminal
    return _lower_worker_result(result)


def _worker_handler(
    definition: DeviceDefinition, kind: object
) -> Callable[[Mapping[str, object], object], Awaitable[object]]:
    body = definition.body
    ergonomic = kind in {"soft", "hard"} and hasattr(body, "__omp_tool_kind__")

    async def invoke(params: Mapping[str, object], context: object) -> object:
        if not isinstance(params, Mapping):
            raise TypeError("worker tool arguments must decode to an object")
        if context is not None and not ergonomic:
            from ._host import dispatch_update_sink

            context = replace(context, _update_sink=dispatch_update_sink())
        if ergonomic:
            positional, keywords = _bind_tool_arguments(body, params, context)
            result = body(*positional, **keywords)
        else:
            parameters = tuple(inspect.signature(body).parameters.values())
            result = body(params, context) if len(parameters) > 1 else body(params)
        return await _consume_worker_result(result)

    return invoke


def _lower_worker_result(
    result: object, streamed_updates: list[object] | None = None
) -> object:
    """Lower one Python result to the CONTROL completion shape."""

    from . import Fault
    from ._verdicts import Faulted, Ok, Payload, _canonical_json

    if isinstance(result, (Payload, Fault)):
        outcome = Ok(result) if isinstance(result, Payload) else Faulted(result)
        return {
            "updates": streamed_updates or [],
            "details": json.loads(_canonical_json(outcome)),
            "is_error": isinstance(result, Fault),
            "terminate": result.terminate,
        }
    if streamed_updates is not None:
        if isinstance(result, Mapping):
            return {"updates": streamed_updates, **result}
        return {"updates": streamed_updates, "details": result}
    return result


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


def _hook_subscription_key(
    event: str, phase: object, name: object
) -> _HookSubscriptionKey:
    event_name, phase_name = _hook_key(event, phase)
    if not isinstance(name, str) or not name:
        raise ValueError("hook subscription name must be a non-empty string")
    return event_name, phase_name, name



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
    "ComponentDefinition",
    "DeclarationRegistry",
    "DirectorDefinition",
    "ChildDeviceDefinition",
    "DeviceDefinition",
    "DeclarationSnapshot",
    "SkillDecl",
    "PreludeDefinition",
    "PreludeParamSpec",
    "MAX_DECLARATIONS",
    "QuotaExceeded",
    "ExportDefinition",
    "QuotaStatus",
    "ResourceReceipt",
    "ServiceClient",
    "ServiceDefinition",
    "ServiceMethodDefinition",
    "Services",
    "WorkerToolDefinition",
    "bootstrap_extension_registry",
    "configure_manifest",
    "dispatch_prompt_slot",
    "dispatch_service",
    "freeze_declarations",
    "prelude_definitions",
    "project_control_registry",
    "registry",
    "resources",
    "service",
    "services",
    "skill",
)
