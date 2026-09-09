# `omp` module reference

The top-level `omp` module is the entry point for declaring extension tools and reading the active host context. Reach for it when you need a decorator, manifest metadata, capability check, invocation state, or an exception shared across submodules. APIs owned by a submodule are indexed at the end of this page and documented on that submodule's reference page.

## Minimal example

```python
from typing import Annotated

import omp


@omp.tool(kind="soft", rev=1)
async def greet(
    name: Annotated[str, omp.Field("Person to greet", example="Ada")],
) -> str:
    ctx = omp.Context.current()
    ctx.log(omp.LogLevel.INFO, "greeting requested", name=name)
    return f"Hello, {name}."
```

Declaration happens when Python imports the module. Runtime-only calls such as `Context.current()` belong inside the decorated body or another host callback.

## Declaring tools

### `omp.device`

```python
def device(
    name: str | None = None,
    *,
    family: str = "",
    rev: int = 1,
    place: str | Place = "host",
    summary: str | None = None,
    docs: str | os.PathLike[str] | None = None,
    schema: type | dict[str, object] | None = None,
    examples: Sequence[Example] = (),
    available: Callable[[], bool | Availability] | None = None,
    precedence: int = Precedence.DEFAULT,
    replaces: str | None = None,
    intents: Sequence[Intent] = (),
    effects: Effects | None = None,
    tier: Tier = Tier.WRITE,
    deadline: Duration | None = None,
    aliases: Mapping[str, str] | None = None,
    constraint: ToolConstraint | None = None,
    serial: bool = False,
) -> Callable[[Any], Device]
```

Declares a catalog device and returns its `Device` handle.

The decorator records an inert declaration during import. If `name` is omitted, the callable name is used after leading underscores are removed. Device names must begin with a lowercase ASCII letter, contain only lowercase letters, digits, and underscores, and contain at most 64 characters. `resolve`, `reject`, `propose`, and `report_issue` are reserved. The availability predicate is saved for registry freeze rather than evaluated by the decorator.

**Parameters**

| Name | Type | Meaning |
|---|---|---|
| `name` | `str | None` | Catalog name, or the callable name when omitted. |
| `family` | `str` | Version family used in declaration identity. |
| `rev` | `int` | Declaration revision; booleans are rejected. |
| `place` | `str | Place` | Execution placement accepted by `Place.parse`. |
| `summary` | `str | None` | Short catalog summary. |
| `docs` | `str | os.PathLike[str] | None` | Inline documentation or a documentation path. |
| `schema` | `type | dict[str, object] | None` | Explicit input schema; otherwise the callable supplies it. |
| `examples` | `Sequence[Example]` | Device examples, frozen to a tuple at declaration. |
| `available` | `Callable[[], bool | Availability] | None` | Predicate evaluated when declarations freeze. |
| `precedence` | `int` | Claim priority below `Precedence.CORE`. |
| `replaces` | `str | None` | Declaration this device intentionally replaces. |
| `intents` | `Sequence[Intent]` | Provider intents associated with the device. |
| `effects` | `Effects | None` | Declared effect profile. |
| `tier` | `Tier` | Policy tier; defaults to `Tier.WRITE`. |
| `deadline` | `Duration | None` | Optional invocation deadline. |
| `aliases` | `Mapping[str, str] | None` | Argument aliases mapped to canonical names. |
| `constraint` | `ToolConstraint | None` | Optional routing constraint. |
| `serial` | `bool` | Whether invocations must be serialized. |

**Returns**

A decorator that replaces the callable with its registered [`Device`](omp.devices.md) handle.

**Raises**

- `TypeError` for a non-callable body or invalid primitive option type.
- [`DeviceNameError`](omp.devices.md) for an invalid or reserved name or core-level precedence.
- [`SchemaError`](omp.devices.md) for invalid schema, examples, aliases, availability, or constraint metadata.
- `DuplicateRegistration`, `DeclarationSealed`, or `DeclarationLimit` when the declaration registry rejects the new entry.

```python
@omp.device(
    "project_search",
    family="dev.example.search",
    rev=2,
    summary="Search indexed project text.",
    effects=omp.Effects(),
)
async def search(query: str) -> list[str]:
    return await run_search(query)
```

See [devices and schemas](omp.devices.md) for `Device`, `Effects`, placement, precedence, constraints, and examples.

### `omp.tool`

```python
def tool(
    name: str | Callable[..., Any] | None = None,
    *,
    kind: str = "soft",
    effects: Effects | None = None,
    tier: Tier | None = None,
    rev: int = 1,
    constraint: ToolConstraint | None = None,
    serial: bool = False,
) -> Callable[[Callable[..., Any]], Device] | Device
```

Declares a host-placed leaf tool using the device registry.

You may write `@omp.tool`, `@omp.tool()`, or `@omp.tool("name", ...)`. The wrapper sets host placement, uses the extension id as the family, and defaults a missing `tier` to `Tier.WRITE` before delegating to `device()`.

**Parameters**

| Name | Type | Meaning |
|---|---|---|
| `name` | `str | Callable[..., Any] | None` | Explicit tool name, a bare-decorator callable, or `None`. |
| `kind` | `str` | `"soft"` or `"hard"`. |
| `effects` | `Effects | None` | Declared effects. |
| `tier` | `Tier | None` | Policy tier; `None` becomes `Tier.WRITE`. |
| `rev` | `int` | Declaration revision; booleans are rejected. |
| `constraint` | `ToolConstraint | None` | Optional routing constraint. |
| `serial` | `bool` | Whether calls must be serialized. |

**Returns**

A decorator, or a registered `Device` immediately when used as bare `@omp.tool`.

**Raises**

- `ValueError` when `kind` is not `"soft"` or `"hard"`.
- `TypeError` for an invalid revision or `serial` value.
- [`SchemaError`](omp.devices.md) for an invalid constraint.
- The declaration errors described for `device()`.

```python
@omp.tool("word_count", kind="soft")
def count_words(text: str) -> int:
    return len(text.split())
```

### `omp.prelude`

```python
def prelude(
    name: str | Callable[..., Any] | None = None,
    *,
    rev: int = 1,
    summary: str | None = None,
) -> Callable[[Callable[..., Any]], Callable[..., Any]] | Callable[..., Any]
```

Publishes a synchronous-looking helper in eval namespaces while returning the original callable unchanged.

The name defaults to `function.__name__`. Names follow the device-name pattern and may not be Python keywords or reserved SDK names. Revisions range from 1 through 65,535. Only positional-or-keyword and keyword-only parameters are accepted; defaults must encode as strict JSON. An omitted summary comes from the first docstring line, or becomes an empty string.

**Parameters**

| Name | Type | Meaning |
|---|---|---|
| `name` | `str | Callable[..., Any] | None` | Published name, bare-decorator callable, or `None`. |
| `rev` | `int` | Positive unsigned 16-bit declaration revision. |
| `summary` | `str | None` | Display summary or first docstring line when omitted. |

**Returns**

The original function, either directly or through a decorator.

**Raises**

- `TypeError` for a non-callable target or invalid `rev` or `summary` type.
- `ValueError` when `rev` is outside `1..65535`.
- [`DeviceNameError`](omp.devices.md) for an invalid or reserved name.
- [`SchemaError`](omp.devices.md) for an unsupported parameter shape or non-JSON default.

```python
@omp.prelude("normalize_key", rev=1)
def normalize(value: str, *, lowercase: bool = True) -> str:
    value = value.strip()
    return value.lower() if lowercase else value
```

## Argument and failure declarations

### `omp.Field`

```python
Field(
    description: str | None = None,
    *,
    additional_properties: bool = False,
    alias: tuple[str, ...] = (),
    coerce: tuple[Coerce, ...] = (),
    expected: str | None = None,
    example: str | None = None,
)
```

Adds immutable metadata to an `Annotated` device argument.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `description` | `str | None` | `None` | Human-readable argument purpose. |
| `additional_properties` | `bool` | `False` | Whether an object may contain undeclared keys. |
| `alias` | `tuple[str, ...]` | `()` | Unique, non-empty alternate names. |
| `coerce` | `tuple[Coerce, ...]` | `()` | Ordered declared coercions. |
| `expected` | `str | None` | `None` | Expected-value hint for repair messages. |
| `example` | `str | None` | `None` | Example input text. |

Construction freezes aliases and coercions as tuples. Invalid field types raise `TypeError`; duplicate aliases raise `ValueError`.

```python
from typing import Annotated

PathArg = Annotated[
    str,
    omp.Field("Project-relative path", alias=("file",), coerce=(omp.Coerce.STRIP,)),
]
```

### `omp.Coerce`

```python
class Coerce(StrEnum)
```

Names an argument conversion that becomes part of the declared schema and journaled call.

| Member | Wire value | Meaning |
|---|---|---|
| `LOOSE_BOOL` | `"loose_bool"` | Accept a permissive boolean spelling. |
| `INTEGER` | `"integer"` | Convert to an integer. |
| `NUMBER` | `"number"` | Convert to a numeric value. |
| `STRING` | `"string"` | Convert to text. |
| `SINGLETON` | `"singleton"` | Wrap one value where a collection is expected. |
| `JSON_STRING` | `"json_string"` | Decode JSON carried in a string. |
| `STRIP` | `"strip"` | Remove surrounding whitespace. |
| `CSV` | `"csv"` | Split comma-separated text. |
| `NULL_ELISION` | `"null_elision"` | Elide an explicit null where permitted. |

### `omp.Fault`

```python
@dataclass(frozen=True, slots=True, kw_only=True)
class Fault:
    terminate: bool = False

    def useless(self) -> bool
```

Provides the marker base for a durable typed tool failure.

Do not instantiate `Fault` directly. Define a frozen dataclass subclass; the subclass schema is checked when the class is created. `terminate` asks the host to treat the failure as terminal control. `useless()` returns `False` by default and may be overridden when prompt compaction may omit the failure's projection.

```python
from dataclasses import dataclass

@dataclass(frozen=True, slots=True, kw_only=True)
class MissingRecord(omp.Fault):
    record_id: str
```

The result wrappers that carry faults are documented under [verdicts](verdicts.md).

## Manifest

### `omp.Manifest`

```python
Manifest(
    id: str,
    name: str,
    version: str,
    omp_api: int,
    description: str | None,
    entry: str,
    capabilities: frozenset[Capability],
    tools: tuple[ToolEntry, ...],
    hooks: tuple[HookEntry, ...],
    services: tuple[ServiceEntry, ...],
    workers: Mapping[str, WorkerSpec],
    settings: Mapping[str, SettingSchema],
    requires: Requires,
)
```

Represents the parsed, immutable manifest delivered for the calling extension.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `id` | `str` | required | Reverse-DNS extension id, 3–128 lowercase letters, digits, dots, or hyphens. |
| `name` | `str` | required | Display name. |
| `version` | `str` | required | Extension version. |
| `omp_api` | `int` | required | API level, which must occur in `API_LEVELS`. |
| `description` | `str | None` | required | Optional long description. |
| `entry` | `str` | required | Entry module. |
| `capabilities` | `frozenset[Capability]` | required | Requested capability set. |
| `tools` | `tuple[ToolEntry, ...]` | required | Static tool declarations. |
| `hooks` | `tuple[HookEntry, ...]` | required | Static hook subscriptions. |
| `services` | `tuple[ServiceEntry, ...]` | required | Service implementations. |
| `workers` | `Mapping[str, WorkerSpec]` | required | Immutable named worker specifications. |
| `settings` | `Mapping[str, SettingSchema]` | required | Immutable setting schemas. |
| `requires` | `Requires` | required | Python, wheel, and service requirements. |

Construction normalizes capabilities and nested declaration mappings into their typed forms, freezes mappings with read-only proxies, and validates that worker mapping keys match `WorkerSpec.name`. Malformed values raise `ManifestError` or `ApiLevelError`.

### `omp.ToolEntry`

```python
ToolEntry(name: str, kind: str, family: str, rev: int, module: str, summary: str)
```

Describes one tool declared in the static manifest.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `name` | `str` | required | Non-empty tool name. |
| `kind` | `str` | required | `"soft"` or `"hard"`. |
| `family` | `str` | required | Tool family; an empty string is allowed. |
| `rev` | `int` | required | Positive revision; booleans are rejected. |
| `module` | `str` | required | Non-empty import module. |
| `summary` | `str` | required | Non-empty summary. |

Invalid entries raise `ManifestError`.

### `omp.HookEntry`

```python
HookEntry(event: str, phase: str, module: str, order: int | None = None)
```

Describes one static hook subscription.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `event` | `str` | required | Non-empty event id. |
| `phase` | `str` | required | Non-empty hook phase. |
| `module` | `str` | required | Non-empty import module. |
| `order` | `int | None` | `None` | Optional ordering key; booleans are rejected. |

Invalid entries raise `ManifestError`.

### `omp.ServiceEntry`

```python
ServiceEntry(name: str, rev: int, module: str)
```

Describes one service implementation declared by the manifest.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `name` | `str` | required | Non-empty service name. |
| `rev` | `int` | required | Positive service revision; booleans are rejected. |
| `module` | `str` | required | Non-empty implementation module. |

Invalid entries raise `ManifestError`.

### `omp.Requires`

```python
Requires(
    python: str | None = None,
    wheels: tuple[str, ...] = (),
    services: tuple[str, ...] = (),
)
```

Holds inert dependency requirements from the manifest.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `python` | `str | None` | `None` | Non-empty Python version requirement when present. |
| `wheels` | `tuple[str, ...]` | `()` | Non-empty wheel requirement strings. |
| `services` | `tuple[str, ...]` | `()` | Non-empty service requirement strings. |

Sequences are frozen to tuples. A string is not accepted in place of a sequence. Invalid values raise `ManifestError`.

### `omp.manifest`

```python
def manifest() -> Manifest
```

Returns the host-delivered manifest for the calling extension.

A prebuilt `Manifest` is returned unchanged. A mapping is passed to `Manifest`; any other host value raises `TypeError`.

**Returns**

The active extension's immutable `Manifest`.

**Raises**

- `NotWiredError` when no host manifest is installed.
- `TypeError` when the host supplies neither a `Manifest` nor a mapping.
- `ManifestError` or `ApiLevelError` when mapping construction fails validation.

```python
extension_id = omp.manifest().id
```

Worker and setting types are documented in [placement](omp.placement.md) and [packages](omp.packages.md).

## Capabilities and trust

### `omp.Capability`

```python
class Capability(StrEnum)
```

Names a capability that may be requested by a manifest and enforced by the host.

| Member | Wire value | Meaning |
|---|---|---|
| `ENV_BLOB` | `"env.blob"` | Blob operations. |
| `ENV_DOC_READ` | `"env.doc.read"` | Read live documents. |
| `ENV_DOC_WRITE` | `"env.doc.write"` | Change live documents. |
| `ENV_EXEC` | `"env.exec"` | Execute environment commands. |
| `ENV_FS_READ` | `"env.fs.read"` | Read environment files. |
| `ENV_FS_WRITE` | `"env.fs.write"` | Write environment files. |
| `ENV_LSP` | `"env.lsp"` | Use language-server operations. |
| `ENV_NET` | `"env.net"` | Use environment networking. |
| `ENV_PROCESS` | `"env.process"` | Manage named processes. |
| `ENV_SEARCH` | `"env.search"` | Search workspace content. |
| `ENV_WORKSPACE_SNAPSHOT` | `"env.workspace.snapshot"` | Read workspace snapshots. |
| `ENV_WORKTREE` | `"env.worktree"` | Manage worktrees. |
| `PLACE_ENV` | `"place.env"` | Place execution in the environment. |
| `PLACE_WORKER` | `"place.worker"` | Place execution on a worker. |
| `SCHEDULES_PROJECT` | `"schedules:project"` | Manage project schedules. |

### `omp.Layer`

```python
class Layer(StrEnum)
```

Identifies the deployment layer that admitted an extension.

| Member | Wire value | Meaning |
|---|---|---|
| `CLIENT` | `"client"` | Client-side declaration. |
| `WORKSPACE` | `"workspace"` | Workspace-side declaration. |

### `omp.Trust`

```python
class Trust(StrEnum)
```

Reports the confinement tier granted to the extension child.

| Member | Wire value | Meaning |
|---|---|---|
| `SANDBOXED` | `"sandboxed"` | Confined child. |
| `TRUSTED` | `"trusted"` | Trusted child. |

### `omp.LogLevel`

```python
class LogLevel(StrEnum)
```

Selects a structured extension-log severity.

| Member | Wire value | Meaning |
|---|---|---|
| `TRACE` | `"trace"` | Fine-grained diagnostic detail. |
| `DEBUG` | `"debug"` | Debug information. |
| `INFO` | `"info"` | Normal informational record. |
| `WARNING` | `"warning"` | Recoverable concern. |
| `ERROR` | `"error"` | Failed operation. |

### `omp.RestartReason`

```python
class RestartReason
```

Names why the supervisor replaced an extension generation.

| Member | Wire value | Meaning |
|---|---|---|
| `CRASH` | `"crash"` | The preceding child crashed. |
| `HOT_RELOAD` | `"hot_reload"` | Code or declarations were reloaded. |
| `CANCEL_ESCALATION` | `"cancel_escalation"` | Cooperative cancellation escalated to replacement. |
| `PROTOCOL_ERROR` | `"protocol_error"` | The child violated its host protocol. |
| `OOM` | `"oom"` | The child exhausted memory. |
| `HEALTH_TIMEOUT` | `"health_timeout"` | The child missed its health deadline. |

Instances expose the string through `.value`.

### `omp.restart_reason`

```python
def restart_reason() -> RestartReason | None
```

Returns the reason for the current child generation, or `None` when it is not a restart.

**Raises**

`NotWiredError` when no restart-reason channel is installed.

### `omp.is_subscribed`

```python
def is_subscribed(event: str) -> bool
```

Reports whether the current declaration snapshot contains a hook for `event`.

**Parameters**

- `event` (`str`) — event id to inspect.

**Returns**

`True` when at least one registered hook key has the requested event id.

**Raises**

`TypeError` when `event` is not a string.

### `omp.require`

```python
def require(*caps: Capability) -> None
```

Checks that every requested capability is granted.

Inside a callback, the function uses `Context.current()`. Outside a callback it consults the installed host capability set. The first missing capability raises `CapabilityError`; an empty call succeeds.

**Parameters**

- `caps` (`Capability`) — capabilities to require, in check order. String values accepted by `Capability` are normalized as well.

**Raises**

- `ValueError` when an argument is not a valid `Capability` value.
- `CapabilityError` for the first missing capability.
- `NotWiredError` when neither an active context nor a host capability set exists.

```python
omp.require(omp.Capability.ENV_FS_READ, omp.Capability.ENV_SEARCH)
```

## Core operation metadata

### `omp.ActivateReason`

```python
class ActivateReason
```

Names the broad activation cause: `FIRST_REACH` (`"first_reach"`), `HOT_RELOAD` (`"hot_reload"`), or `RESTART` (`"restart"`). Instances expose `.value`.

### `omp.Authority`

```python
class Authority
```

Names the enforcing side of an operation: `CORE` (`"core"`) or `ENVIRONMENT` (`"environment"`).

### `omp.CostClass`

```python
class CostClass
```

Classifies operation cost as `NONE` (`"none"`), `METERED` (`"metered"`), or `PAID` (`"paid"`).

### `omp.Durability`

```python
class Durability
```

Classifies an operation as `EPHEMERAL` (`"ephemeral"`) or `DURABLE` (`"durable"`).

### `omp.Duration`

```python
Duration(value: Any | None = None, *, seconds: float | None = None)
```

Creates an immutable duration while retaining the source unit. Read `.seconds` for the numeric duration, `.unit` for the source unit, and `.value` for its integral source value. Durations compare, hash, stringify, and support subtraction.

```python
retry_window = omp.Duration("30s")
```

### `omp.InvocationPhase`

```python
class InvocationPhase
```

Provides the ordered invocation phases `OPEN`, `ADMISSION`, `ADMITTED`, `ARGS_FINALIZED`, `EFFECTS_AUTHORIZED`, `ASSISTANT_ITEM_COMMITTED`, and `SETTLED`. Each value exposes `.value` and the ordering key `.ordinal`. See [parameters](omp.params.md) for the invocation state machine.

### `omp.LifecyclePhase`

```python
class LifecyclePhase
```

Provides the ordered extension phases `DECLARED`, `FROZEN`, `VERIFIED`, `ACTIVE`, and `DEGRADED`. Each value exposes `.value` and `.ordinal`.

### `omp.OperationSpec`

```python
class OperationSpec
```

Carries generated enforcement metadata. Its read-only properties are `minimum_phase: InvocationPhase`, `durability: Durability`, `cost: CostClass`, and `authority: Authority`.

### `omp.Principal`

```python
class Principal
```

Exposes the core-authenticated identity through read-only `id: str` and `display: str` properties. The host creates principals; extension code only reads them from a `Context`.

### `omp.operation_spec`

```python
def operation_spec(symbol: str | Any) -> OperationSpec | None
```

Returns canonical generated operation metadata for a public symbol. Pass a qualified symbol name or a public object. Unknown symbols return `None`.

```python
spec = omp.operation_spec("omp.state.append")
if spec is not None:
    print(spec.minimum_phase, spec.durability)
```

### `omp.RUNTIME_METADATA`

```python
RUNTIME_METADATA: Mapping[str, Mapping[str, object]]
```

Contains generated metadata keyed by qualified public symbol. Entries supply the operation metadata, rendered signature, examples, and owner used to attach `__omp_symbol__`, `__operation_spec__`, `__signature_text__`, `__examples__`, and `__owner__` where the Python object permits attributes.

### `omp.PHASE_LEGALITY_MATRIX`

```python
PHASE_LEGALITY_MATRIX: object
```

Contains the generated phase-legality matrix returned by the native runtime. Consult it when tooling needs the authoritative symbol-by-phase view rather than testing a call.

### `omp.APPROVAL_DEADLINE`

```python
APPROVAL_DEADLINE: Duration = Duration("5m")
```

Provides the default wall-clock deadline for durable approval requests. The top-level name is the same value exported by [`omp.policy`](omp.policy.md).

## Runtime context

### `omp.Context`

```python
@dataclass(frozen=True, slots=True)
class Context:
    extension: str
    session: str
    invocation: str
    principal: Principal
    generation: int
    turn: int | None = None
    event: str | None = None
    call: str | None = None
    device: str | None = None
    trust: Trust = Trust.SANDBOXED
    caps: frozenset[str] = frozenset()
    place: Place = Place.HOST
    phase: LifecyclePhase = LifecyclePhase.ACTIVE
    roots: tuple[WorkspaceUri, ...] = ()
    remote: bool = False
    has_ui: bool = False
    headless: bool = True
    model: ModelRef | None = None
    route: RouteRef | None = None
    thinking: Effort | None = None
    settings: Mapping[str, object] = MappingProxyType({})
    deadline: float | None = None
```

Presents an immutable view of the active host-owned callback scope.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `extension` | `str` | required | Extension id. |
| `session` | `str` | required | Session id. |
| `invocation` | `str` | required | Invocation id. |
| `principal` | `Principal` | required | Authenticated caller. |
| `generation` | `int` | required | Host generation fence. |
| `turn` | `int | None` | `None` | Turn number when applicable. |
| `event` | `str | None` | `None` | Current event id. |
| `call` | `str | None` | `None` | Current call id. |
| `device` | `str | None` | `None` | Current device name. |
| `trust` | `Trust` | `Trust.SANDBOXED` | Granted trust tier. |
| `caps` | `frozenset[str]` | empty | Granted capability values. |
| `place` | `Place` | `Place.HOST` | Current execution placement. |
| `phase` | `LifecyclePhase` | `LifecyclePhase.ACTIVE` | Extension lifecycle phase. |
| `roots` | `tuple[WorkspaceUri, ...]` | `()` | Workspace roots. |
| `remote` | `bool` | `False` | Whether execution is remote. |
| `has_ui` | `bool` | `False` | Whether an interactive UI exists. |
| `headless` | `bool` | `True` | Whether the invocation is headless. |
| `model` | `ModelRef | None` | `None` | Active model, when available. |
| `route` | `RouteRef | None` | `None` | Active provider route, when available. |
| `thinking` | `Effort | None` | `None` | Active reasoning effort, when available. |
| `settings` | `Mapping[str, object]` | empty read-only mapping | Resolved extension settings. |
| `deadline` | `float | None` | `None` | Monotonic absolute deadline. |

The actual dataclass also carries private host attachments for cancellation and progress updates. Do not construct or replace those private fields in extension code.

```python
ctx = omp.Context.current()
ctx.checkpoint()
ctx.log(omp.LogLevel.DEBUG, "starting", invocation=ctx.invocation)
```

#### `Context.from_scope`

```python
@classmethod
def from_scope(cls, scope: Scope) -> Context
```

Projects a host-owned internal scope into the public immutable view. This adapter is primarily for host integration; ordinary callbacks use `current()`.

#### `Context.current`

```python
@classmethod
def current(cls) -> Context
```

Returns the active callback context.

**Raises**

`LookupError` when called outside an omp invocation context.

#### `Context.root`

```python
@property
def root(self) -> WorkspaceUri
```

Returns the first workspace root.

**Raises**

`LookupError` when the context has no roots.

#### `Context.deadline_in`

```python
def deadline_in(self) -> Duration | None
```

Returns time remaining as a `Duration`, clamped to zero, or `None` when no deadline applies.

#### `Context.cancelled`

```python
def cancelled(self) -> bool
```

Reports whether cancellation was requested on the attached invocation scope. A detached context reports `False`.

#### `Context.signal`

```python
@property
def signal(self) -> asyncio.Event
```

Returns the invocation-fenced event set when cancellation is requested.

**Raises**

`RuntimeError` when the context is not attached to an invocation scope.

#### `Context.checkpoint`

```python
def checkpoint(self) -> None
```

Raises `CancelledError` when cancellation is pending; otherwise returns normally.

#### `Context.update`

```python
def update(self, value: object) -> None
```

Emits one ephemeral progress value for the active tool invocation. If `value` has a `payload` attribute, that payload is sent.

**Raises**

`RuntimeError` when no tool update sink is attached.

#### `Context.on_cancel`

```python
def on_cancel(self, fn: Callable[[], None]) -> Callable[[], None]
```

Registers a synchronous cancellation callback and returns a function that removes it. If cancellation has already arrived, the callback runs immediately and callback exceptions are suppressed.

**Raises**

`RuntimeError` when the context is not attached to an invocation scope.

#### `Context.shield`

```python
@asynccontextmanager
async def shield(self) -> AsyncIterator[None]
```

Defers cooperative cancellation delivery while an async critical section is active.

```python
async with ctx.shield():
    await commit_atomic_result()
```

#### `Context.require`

```python
def require(self, *caps: Any) -> None
```

Checks capability values against `ctx.caps` and raises `CapabilityError` for the first missing value.

#### `Context.log`

```python
def log(self, level: object, message: str, /, **fields: object) -> None
```

Emits a structured log when a host sink is installed. Fields matching secret-setting names are replaced with `"[REDACTED]"`; extension, session, generation, and available event/call identifiers are added. Logging is best-effort: a missing sink or sink exception does not escape.

#### `Context.child`

```python
def child(self, **overrides: object) -> Context
```

Returns a dataclass replacement with the requested field overrides. Unknown field names and invalid replacement arguments raise the normal dataclass `TypeError`.

## State

### `omp.StateScope`

```python
class StateScope
```

Selects durable state ownership: `SESSION` (`"session"`), `USER` (`"user"`), `PROJECT` (`"project"`), or `ORGANIZATION` (`"organization"`). The type is available as `omp.StateScope` for the state methods even though it is not included by `from omp import *`.

### `omp.state`

```python
state: _State
```

Provides the singleton typed append-log and content-addressed state client. Every I/O method is asynchronous and requires an explicit `StateScope`.

### `omp.state.append`

```python
async def append(
    entry: Any,
    *,
    scope: StateScope,
    idempotency_key: str | None = None,
) -> Any
```

Appends one typed state entry durably.

**Parameters**

| Name | Type | Meaning |
|---|---|---|
| `entry` | `Any` | Registered typed entry value. |
| `scope` | `StateScope` | Durable ownership scope. |
| `idempotency_key` | `str | None` | Optional key for retry-safe append identity. |

**Returns**

The host's append result.

**Raises**

`HostDisconnected` when no CONTROL bridge exists, plus the [journal errors](omp.journal.md) reported by the host.

### `omp.state.entries`

```python
async def entries(
    kind: Any,
    *,
    scope: StateScope,
    since: Any = None,
    limit: int | None = None,
) -> Any
```

Reads ordered records for one registered entry kind.

`since` supplies a host-understood starting mark and `limit` bounds the result. The host's collection is returned unchanged.

### `omp.state.latest`

```python
async def latest(kind: Any, *, scope: StateScope) -> Any
```

Returns the latest record of a registered kind, or the host's empty result when no record exists.

### `omp.state.fold`

```python
async def fold(
    kind: Any,
    reducer: Any,
    initial: Any,
    *,
    scope: StateScope,
    since: Any = None,
) -> tuple[Any, Any]
```

Folds ordered records locally after retrieving them with `entries()`.

The reducer is called as `reducer(current_value, record)`. The result is `(value, mark)`, where `mark` is the last record's `id` attribute or `None` when no record was read.

```python
total, mark = await omp.state.fold(
    CounterEntry,
    lambda value, record: value + record.amount,
    0,
    scope=omp.StateScope.PROJECT,
)
```

### `omp.state.cas_put`

```python
async def cas_put(data: bytes, *, scope: StateScope) -> BlobRef
```

Stores bytes in content-addressed state rooted at the requested scope and returns their `BlobRef`.

### `omp.state.cas_get`

```python
async def cas_get(ref: BlobRef, *, scope: StateScope) -> bytes
```

Reads content-addressed bytes from the requested scope.

### `omp.state_dir`

```python
async def state_dir() -> EnvPath
```

Returns the environment path reserved for rebuildable extension indexes.

**Raises**

`HostDisconnected` when no CONTROL bridge is installed, plus host-side environment or scope errors.

```python
index_root = await omp.state_dir()
```

See [journal](omp.journal.md) for entry registration and durable journal types, [artifacts](omp.artifacts.md) for artifact storage, and [environment](omp.env.md) for `EnvPath` and `BlobRef`.

## Errors

The shared hierarchy lets you catch broadly at `OmpError` or handle a declaration, capability, transport, or state failure specifically. Errors owned by submodules are linked in the re-export index below.

```text
BaseException
├── asyncio.CancelledError                         (omp.CancelledError)
└── Exception
    ├── OmpError
    │   ├── HostDisconnected
    │   ├── EnvUnavailable
    │   │   └── NotWiredError
    │   ├── PlacementError
    │   ├── StaleGeneration
    │   ├── ManifestError
    │   │   ├── ApiLevelError
    │   │   └── DeclarationLimit
    │   ├── CapabilityError
    │   │   └── TrustError
    │   ├── DuplicateRegistration
    │   ├── DeclarationSealed
    │   ├── EffectsNotAuthorized
    │   ├── DeadlineExceeded
    │   ├── FrameTooLarge
    │   ├── ExtensionError
    │   │   └── SpecError
    │   ├── QuotaExceeded
    │   └── PermissionDenied  (also PermissionError)
    └── JournalError
        └── StateScopeDenied
```

### `omp.OmpError`

```python
class OmpError(Exception)
```

Base class for runtime failures raised by the omp extension API.

### `omp.ManifestError`

```python
ManifestError(path: str, key: str, detail: str)
```

Reports one malformed manifest field. The exception exposes `path`, `key`, and `detail`.

### `omp.ApiLevelError`

```python
ApiLevelError(requested: int, supported: frozenset[int])
```

Reports a requested API level outside the supported set. The exception exposes `requested` and `supported` and is a `ManifestError`.

### `omp.DeclarationLimit`

```python
DeclarationLimit(count: int, limit: int)
```

Reports that import produced too many declarations. The exception exposes the observed `count` and allowed `limit` and is a `ManifestError`.

### `omp.CapabilityError`

```python
CapabilityError(capability: object)
```

Reports the first required capability that was not granted. The rejected value is available as `capability`.

### `omp.TrustError`

```python
TrustError(required: object, actual: object)
```

Reports that the actual trust tier is below the required tier. The exception exposes `required` and `actual` and is a `CapabilityError`. This top-level attribute is not included by `from omp import *`.

### `omp.DuplicateRegistration`

```python
DuplicateRegistration(name: str, holder: str)
```

Reports a declaration collision. The exception exposes the attempted `name` and incumbent `holder`.

### `omp.DeclarationSealed`

```python
DeclarationSealed(name: str)
```

Reports a declaration attempted after registry freeze. The rejected declaration name is available as `name`.

### `omp.EffectsNotAuthorized`

```python
EffectsNotAuthorized(invocation: str, spec: object)
```

Reports an operation attempted before its invocation authorized the required effects. The exception exposes `invocation` and `spec`.

### `omp.DeadlineExceeded`

```python
DeadlineExceeded(deadline: object)
```

Reports a deadline that passed before an operation could start. The elapsed value is available as `deadline`.

### `omp.FrameTooLarge`

```python
FrameTooLarge(actual: int, limit: int)
```

Reports an encoded transport frame over its size limit. The exception exposes byte counts as `actual` and `limit`.

### `omp.ExtensionError`

```python
class ExtensionError(OmpError)
```

Base class for extension declaration and runtime-surface failures.

### `omp.SpecError`

```python
class SpecError(ExtensionError)
```

Reports validation failure in a provider declaration.

### `omp.NotWiredError`

```python
class NotWiredError(EnvUnavailable)
```

Reports that a frozen API has no installed host dispatch arm.

### `omp.QuotaExceeded`

```python
QuotaExceeded(quota: str, receipt: ResourceReceipt | None)
```

Reports exhaustion of a hard per-extension quota. The exception exposes `quota` and the available `receipt`; `receipt` may be `None` when the host cannot attach a snapshot.

### `omp.StateScopeDenied`

```python
class StateScopeDenied(JournalError)
```

Reports that the authenticated principal may not access the requested state scope. This top-level attribute is not included by `from omp import *`.

### `omp.PermissionDenied`

```python
class PermissionDenied(PermissionError, OmpError)
```

Reports that the authenticated principal lacks permission for an operation. Catch either `PermissionError` or `OmpError` when that distinction is useful.

### `omp.CancelledError`

```python
CancelledError = asyncio.CancelledError
```

Aliases Python's cooperative cancellation exception. It derives from `BaseException`, so a broad `except Exception` does not consume cancellation.

### `omp.HostDisconnected`

```python
class HostDisconnected(OmpError)
```

Reports loss or absence of the host CONTROL channel.

### `omp.EnvUnavailable`

```python
class EnvUnavailable(OmpError)
```

Reports that no environment is available at the current placement.

### `omp.PlacementError`

```python
class PlacementError(OmpError)
```

Reports a placement declaration or execution claim the host cannot honor.

### `omp.StaleGeneration`

```python
class StaleGeneration(OmpError)
```

Reports a request carrying a retired host or session generation. This top-level attribute is not included by `from omp import *`.

## UI decorator aliases

These top-level attributes are aliases of the UI declarations; their complete signatures and behavior live in the [UI reference](omp.ui.md).

- [`omp.renderer`](omp.ui.md) — registers a verdict renderer.
- [`omp.message_renderer`](omp.ui.md) — registers a message renderer.
- [`omp.markdown_transformer`](omp.ui.md) — registers a markdown transformation.
- [`omp.command`](omp.ui.md) — registers an interactive command.
- [`omp.shortcut`](omp.ui.md) — registers an interactive shortcut.

## Re-export index

The remaining `omp.__all__` names preserve convenient top-level access to APIs owned elsewhere. Each name below links to its exhaustive reference; importing it from `omp` does not change its owner or contract.

### [omp.artifacts](omp.artifacts.md)

[`omp.ArtifactCorrupt`](omp.artifacts.md), [`omp.ArtifactError`](omp.artifacts.md), [`omp.ArtifactNotFound`](omp.artifacts.md), [`omp.ArtifactNotText`](omp.artifacts.md), [`omp.ArtifactReader`](omp.artifacts.md), [`omp.ArtifactStat`](omp.artifacts.md), [`omp.ArtifactWriter`](omp.artifacts.md).

### [omp.context](omp.context.md)

[`omp.Anchor`](omp.context.md), [`omp.CancelCompaction`](omp.context.md), [`omp.CompactionBusy`](omp.context.md), [`omp.CompactionEvent`](omp.context.md), [`omp.CompactionOutcome`](omp.context.md), [`omp.CompactionRefused`](omp.context.md), [`omp.CompactionTier`](omp.context.md), [`omp.CompactionVerdict`](omp.context.md), [`omp.ContextGone`](omp.context.md), [`omp.ContextPatch`](omp.context.md), [`omp.ContextResetEvent`](omp.context.md), [`omp.ContextUsage`](omp.context.md), [`omp.ContextView`](omp.context.md), [`omp.CustomSummary`](omp.context.md), [`omp.DelegateCompaction`](omp.context.md), [`omp.DropParts`](omp.context.md), [`omp.Insert`](omp.context.md), [`omp.MessageKind`](omp.context.md), [`omp.MessageRef`](omp.context.md), [`omp.NoVerdict`](omp.context.md), [`omp.PatchRejected`](omp.context.md), [`omp.PinBudgetExceeded`](omp.context.md), [`omp.Prune`](omp.context.md), [`omp.Reorder`](omp.context.md), [`omp.Replace`](omp.context.md), [`omp.StaleEpoch`](omp.context.md), [`omp.ToolRef`](omp.context.md), [`omp.context`](omp.context.md).

### [omp.creds](omp.creds.md)

[`omp.CredentialMeta`](omp.creds.md).

### [omp.devices](omp.devices.md)

[`omp.DeclarationDrift`](omp.devices.md), [`omp.DeclarationRegistry`](omp.devices.md), [`omp.DeclarationSnapshot`](omp.devices.md), [`omp.Availability`](omp.devices.md), [`omp.AvailabilityDelta`](omp.devices.md), [`omp.ConstraintFallback`](omp.devices.md), [`omp.ConstraintKind`](omp.devices.md), [`omp.Device`](omp.devices.md), [`omp.DeviceError`](omp.devices.md), [`omp.DeviceInfo`](omp.devices.md), [`omp.DeviceNameError`](omp.devices.md), [`omp.DeviceUnavailable`](omp.devices.md), [`omp.DocEffects`](omp.devices.md), [`omp.DocsBudgetError`](omp.devices.md), [`omp.DocsMode`](omp.devices.md), [`omp.DynamicDeviceParent`](omp.devices.md), [`omp.Effects`](omp.devices.md), [`omp.HARD_SLOT_BUDGET`](omp.devices.md), [`omp.Example`](omp.devices.md), [`omp.ExecEffects`](omp.devices.md), [`omp.GrammarSyntax`](omp.devices.md), [`omp.InferenceEffects`](omp.devices.md), [`omp.MountSpec`](omp.devices.md), [`omp.Precedence`](omp.devices.md), [`omp.PrecedenceConflict`](omp.devices.md), [`omp.Router`](omp.devices.md), [`omp.SchemaError`](omp.devices.md), [`omp.ToolPath`](omp.devices.md), [`omp.ToolConstraint`](omp.devices.md), [`omp.MAX_DECLARATIONS`](omp.devices.md), [`omp.Devices`](omp.devices.md), [`omp.EXTERNAL_SUMMARY_CAP`](omp.devices.md), [`omp.PER_DEVICE_CAP`](omp.devices.md), [`omp.ServiceClient`](omp.devices.md), [`omp.ServiceDefinition`](omp.devices.md), [`omp.Services`](omp.devices.md), [`omp.resources`](omp.devices.md), [`omp.service`](omp.devices.md), [`omp.services`](omp.devices.md), [`omp.skill`](omp.devices.md).

### [omp.diagnostics](omp.diagnostics.md)

[`omp.WarningCode`](omp.diagnostics.md).

### [omp.env](omp.env.md)

[`omp.BlobRef`](omp.env.md), [`omp.ClientPath`](omp.env.md), [`omp.EnvPath`](omp.env.md).

### [omp.events](omp.events.md)

[`omp.events`](omp.events.md), [`omp.EVENT_IDS`](omp.events.md), [`omp.default_decision`](omp.events.md), [`omp.field_composition`](omp.events.md), [`omp.spec`](omp.events.md), [`omp.specs`](omp.events.md), [`omp.InputSource`](omp.events.md), [`omp.ItemKind`](omp.events.md), [`omp.ResourceKind`](omp.events.md), [`omp.OutcomeKind`](omp.events.md), [`omp.ShutdownReason`](omp.events.md), [`omp.SwitchReason`](omp.events.md), [`omp.BranchReason`](omp.events.md), [`omp.AgentPhase`](omp.events.md), [`omp.TurnInputMode`](omp.events.md), [`omp.SettleReason`](omp.events.md), [`omp.InterruptClass`](omp.events.md), [`omp.DrainPoint`](omp.events.md), [`omp.InterruptSource`](omp.events.md), [`omp.DeadlineScope`](omp.events.md), [`omp.PartKind`](omp.events.md), [`omp.FinishReason`](omp.events.md), [`omp.DeviceListReason`](omp.events.md), [`omp.EvalLanguage`](omp.events.md), [`omp.DiscoverReason`](omp.events.md), [`omp.ModelChangeReason`](omp.events.md), [`omp.UnloadReason`](omp.events.md), [`omp.CallRef`](omp.events.md), [`omp.ItemRef`](omp.events.md), [`omp.SessionOrigin`](omp.events.md), [`omp.RunSummary`](omp.events.md), [`omp.RewindTarget`](omp.events.md), [`omp.ResourceRef`](omp.events.md), [`omp.Annotation`](omp.events.md), [`omp.SessionStartEvent`](omp.events.md), [`omp.SessionShutdownEvent`](omp.events.md), [`omp.SessionSwitchEvent`](omp.events.md), [`omp.SessionSwitchedEvent`](omp.events.md), [`omp.SessionBranchEvent`](omp.events.md), [`omp.SessionBranchedEvent`](omp.events.md), [`omp.SessionRewindEvent`](omp.events.md), [`omp.SessionRewoundEvent`](omp.events.md), [`omp.SessionResetEvent`](omp.events.md), [`omp.BeforeAgentStartEvent`](omp.events.md), [`omp.AgentStartEvent`](omp.events.md), [`omp.TurnStartEvent`](omp.events.md), [`omp.TurnEndEvent`](omp.events.md), [`omp.TodoRef`](omp.events.md), [`omp.AgentSettledEvent`](omp.events.md), [`omp.AgentEndEvent`](omp.events.md), [`omp.InterruptEvent`](omp.events.md), [`omp.DeadlineEvent`](omp.events.md), [`omp.MessageStartEvent`](omp.events.md), [`omp.MessageUpdateEvent`](omp.events.md), [`omp.MessageEndEvent`](omp.events.md), [`omp.ItemCommittedEvent`](omp.events.md), [`omp.CallOpenEvent`](omp.events.md), [`omp.ToolCallEvent`](omp.events.md), [`omp.ToolExecutionStartEvent`](omp.events.md), [`omp.ToolUpdateEvent`](omp.events.md), [`omp.ToolExecutionEndEvent`](omp.events.md), [`omp.ToolResultEvent`](omp.events.md), [`omp.ToolApprovalRequestedEvent`](omp.events.md), [`omp.ToolApprovalResolvedEvent`](omp.events.md), [`omp.DeviceListEvent`](omp.events.md), [`omp.UserInputEvent`](omp.events.md), [`omp.UserBashEvent`](omp.events.md), [`omp.UserEvalEvent`](omp.events.md), [`omp.CommandInvokeEvent`](omp.events.md), [`omp.ResourcesDiscoverEvent`](omp.events.md), [`omp.ResourcesChangedEvent`](omp.events.md), [`omp.CapabilityBudgetEvent`](omp.events.md), [`omp.ModelChangedEvent`](omp.events.md), [`omp.CredentialDisabledEvent`](omp.events.md), [`omp.JobRegisteredEvent`](omp.events.md), [`omp.JobSettledEvent`](omp.events.md), [`omp.ExtensionActivateEvent`](omp.events.md), [`omp.ExtensionLoadEvent`](omp.events.md), [`omp.ExtensionUnloadEvent`](omp.events.md), [`omp.HostReconnectEvent`](omp.events.md), [`omp.TtsrTriggeredEvent`](omp.events.md), [`omp.RetryLifecycleEvent`](omp.events.md), [`omp.FallbackLifecycleEvent`](omp.events.md), [`omp.McpNotificationEvent`](omp.events.md), [`omp.ProviderResponseEvent`](omp.events.md), [`omp.SessionRenamedEvent`](omp.events.md), [`omp.EventSpec`](omp.events.md).

### [omp.hooks](omp.hooks.md)

[`omp.hooks`](omp.hooks.md), [`omp.DEFAULT_HOOK_TIMEOUT`](omp.hooks.md), [`omp.Allow`](omp.hooks.md), [`omp.ApprovalKind`](omp.hooks.md), [`omp.ApprovalRoute`](omp.hooks.md), [`omp.ApprovalSpec`](omp.hooks.md), [`omp.CallOrigin`](omp.hooks.md), [`omp.CallTarget`](omp.hooks.md), [`omp.Channel`](omp.hooks.md), [`omp.Composition`](omp.hooks.md), [`omp.CoreTool`](omp.hooks.md), [`omp.Defer`](omp.hooks.md), [`omp.Deny`](omp.hooks.md), [`omp.DeviceCall`](omp.hooks.md), [`omp.HookContractError`](omp.hooks.md), [`omp.HookDecision`](omp.hooks.md), [`omp.HookPhase`](omp.hooks.md), [`omp.HostShuttingDown`](omp.hooks.md), [`omp.LatencyClass`](omp.hooks.md), [`omp.LateRegistration`](omp.hooks.md), [`omp.McpCall`](omp.hooks.md), [`omp.Modify`](omp.hooks.md), [`omp.OnFailure`](omp.hooks.md), [`omp.PhaseConflict`](omp.hooks.md), [`omp.PolicyScope`](omp.hooks.md), [`omp.ReentrancyError`](omp.hooks.md), [`omp.RequireApproval`](omp.hooks.md), [`omp.TargetKind`](omp.hooks.md), [`omp.UNSET`](omp.hooks.md), [`omp.UnknownEvent`](omp.hooks.md), [`omp.Unreachable`](omp.hooks.md), [`omp.When`](omp.hooks.md), [`omp.dispatch_hook`](omp.hooks.md), [`omp.hook`](omp.hooks.md).

### [omp.index](omp.index.md)

[`omp.index`](omp.index.md).

### [omp.journal](omp.journal.md)

[`omp.EntryId`](omp.journal.md), [`omp.JournalEntry`](omp.journal.md), [`omp.JournalError`](omp.journal.md), [`omp.EntryAccessDenied`](omp.journal.md), [`omp.EntryKindConflict`](omp.journal.md), [`omp.EntryTooLarge`](omp.journal.md), [`omp.EntryUndecodable`](omp.journal.md), [`omp.JournalIndeterminate`](omp.journal.md), [`omp.StateEntry`](omp.journal.md), [`omp.StateEntryId`](omp.journal.md), [`omp.UnknownEntryKind`](omp.journal.md).

### [omp.limits](omp.limits.md)

[`omp.CANCEL_GRACE`](omp.limits.md), [`omp.HEALTH_TIMEOUT`](omp.limits.md), [`omp.MAX_FRAME_BYTES`](omp.limits.md), [`omp.SHUTDOWN_GRACE`](omp.limits.md), [`omp.limits`](omp.limits.md), [`omp.ACTIVATION_TIMEOUT`](omp.limits.md), [`omp.API_LEVEL`](omp.limits.md), [`omp.API_LEVELS`](omp.limits.md), [`omp.DOCS_TOTAL_BUDGET`](omp.limits.md), [`omp.HOST_VERSION`](omp.limits.md), [`omp.MAX_HOST_CHILDREN`](omp.limits.md), [`omp.MAX_PENDING_EFFECTS`](omp.limits.md), [`omp.PING_INTERVAL`](omp.limits.md), [`omp.PYTHON_REV`](omp.limits.md), [`omp.SCHEMA_REV`](omp.limits.md).

### [omp.mcp](omp.mcp.md)

[`omp.mcp`](omp.mcp.md).

### [omp.packages](omp.packages.md)

[`omp.packages`](omp.packages.md), [`omp.SettingSchema`](omp.packages.md).

### [omp.params](omp.params.md)

[`omp.Abort`](omp.params.md), [`omp.Alias`](omp.params.md), [`omp.Arg`](omp.params.md), [`omp.ArgArray`](omp.params.md), [`omp.ArgFault`](omp.params.md), [`omp.ArgIssue`](omp.params.md), [`omp.ArgIssueKind`](omp.params.md), [`omp.ArgObject`](omp.params.md), [`omp.Args`](omp.params.md), [`omp.CommitAborted`](omp.params.md), [`omp.Ev`](omp.params.md), [`omp.IncomingParams`](omp.params.md), [`omp.Interrupt`](omp.params.md), [`omp.InterruptClosed`](omp.params.md), [`omp.Interrupted`](omp.params.md), [`omp.InterruptibleParams`](omp.params.md), [`omp.InvocationEnded`](omp.params.md), [`omp.ParamsMisuse`](omp.params.md), [`omp.ParamsProtocol`](omp.params.md), [`omp.Repair`](omp.params.md), [`omp.RepairKind`](omp.params.md), [`omp.params`](omp.params.md).

### [omp.placement](omp.placement.md)

[`omp.WorkerEvicted`](omp.placement.md).

### [omp.policy](omp.policy.md)

[`omp.Access`](omp.policy.md), [`omp.Amend`](omp.policy.md), [`omp.AndOrOp`](omp.policy.md), [`omp.ApprovalDecision`](omp.policy.md), [`omp.ApprovalSource`](omp.policy.md), [`omp.ApprovalTicket`](omp.policy.md), [`omp.BASH_IR_MAX_DEPTH`](omp.policy.md), [`omp.BASH_IR_MAX_NODES`](omp.policy.md), [`omp.BASH_IR_MAX_SOURCE`](omp.policy.md), [`omp.BASH_IR_REV`](omp.policy.md), [`omp.BashAndOrList`](omp.policy.md), [`omp.BashArg`](omp.policy.md), [`omp.BashAssignment`](omp.policy.md), [`omp.BashCommandIR`](omp.policy.md), [`omp.BashCompound`](omp.policy.md), [`omp.BashFunctionDef`](omp.policy.md), [`omp.BashIR`](omp.policy.md), [`omp.BashNode`](omp.policy.md), [`omp.BashPipeline`](omp.policy.md), [`omp.BashRedirect`](omp.policy.md), [`omp.BashTestExpr`](omp.policy.md), [`omp.CompoundKind`](omp.policy.md), [`omp.DnsPolicy`](omp.policy.md), [`omp.DomainRule`](omp.policy.md), [`omp.Dynamism`](omp.policy.md), [`omp.EnforcementUnavailable`](omp.policy.md), [`omp.ExecPolicy`](omp.policy.md), [`omp.FilesystemGrade`](omp.policy.md), [`omp.FilesystemPolicy`](omp.policy.md), [`omp.HereDoc`](omp.policy.md), [`omp.NetDirection`](omp.policy.md), [`omp.NetKind`](omp.policy.md), [`omp.NetRef`](omp.policy.md), [`omp.NetworkGrade`](omp.policy.md), [`omp.NetworkMode`](omp.policy.md), [`omp.NetworkPolicy`](omp.policy.md), [`omp.OpaqueEvaluator`](omp.policy.md), [`omp.OpaqueReason`](omp.policy.md), [`omp.POLICY_DEADLINE`](omp.policy.md), [`omp.ParseError`](omp.policy.md), [`omp.ParseFailure`](omp.policy.md), [`omp.PathOrigin`](omp.policy.md), [`omp.PathRef`](omp.policy.md), [`omp.PathRule`](omp.policy.md), [`omp.PolicyDenied`](omp.policy.md), [`omp.PolicyError`](omp.policy.md), [`omp.ProcessGrade`](omp.policy.md), [`omp.ProcessSubDirection`](omp.policy.md), [`omp.ProcessSubIR`](omp.policy.md), [`omp.ProfileHandle`](omp.policy.md), [`omp.ProfileRejected`](omp.policy.md), [`omp.ProfileWidened`](omp.policy.md), [`omp.Quoting`](omp.policy.md), [`omp.RedirectOp`](omp.policy.md), [`omp.RedirectTarget`](omp.policy.md), [`omp.ResourceBudget`](omp.policy.md), [`omp.RuleEffect`](omp.policy.md), [`omp.RuleRef`](omp.policy.md), [`omp.SandboxBackend`](omp.policy.md), [`omp.SandboxCapabilities`](omp.policy.md), [`omp.SandboxEnforcement`](omp.policy.md), [`omp.SandboxMode`](omp.policy.md), [`omp.SandboxProfile`](omp.policy.md), [`omp.SandboxRequest`](omp.policy.md), [`omp.SandboxSessionKind`](omp.policy.md), [`omp.Separator`](omp.policy.md), [`omp.Span`](omp.policy.md), [`omp.TicketState`](omp.policy.md), [`omp.Tier`](omp.policy.md), [`omp.VIOLATION_COALESCE`](omp.policy.md), [`omp.Violation`](omp.policy.md), [`omp.ViolationKind`](omp.policy.md), [`omp.policy`](omp.policy.md), [`omp.tier_of`](omp.policy.md).

### [omp.prompts](omp.prompts.md)

[`omp.PromptContext`](omp.prompts.md), [`omp.VolatilePrompt`](omp.prompts.md).

### [omp.provider](omp.provider.md)

[`omp.AccountScope`](omp.provider.md), [`omp.Api`](omp.provider.md), [`omp.AudioFormat`](omp.provider.md), [`omp.AuthMode`](omp.provider.md), [`omp.AuthSpec`](omp.provider.md), [`omp.CacheRetention`](omp.provider.md), [`omp.Cap`](omp.provider.md), [`omp.CatalogAlias`](omp.provider.md), [`omp.ChatCaps`](omp.provider.md), [`omp.CodecProfile`](omp.provider.md), [`omp.CompatFlags`](omp.provider.md), [`omp.Completion`](omp.provider.md), [`omp.ContextSpec`](omp.provider.md), [`omp.Cost`](omp.provider.md), [`omp.CostTier`](omp.provider.md), [`omp.Cursor`](omp.provider.md), [`omp.Credential`](omp.provider.md), [`omp.CredentialKind`](omp.provider.md), [`omp.CredentialSource`](omp.provider.md), [`omp.Dimensions`](omp.provider.md), [`omp.DiscoveryDefaults`](omp.provider.md), [`omp.DiscoveryKind`](omp.provider.md), [`omp.DiscoveryPage`](omp.provider.md), [`omp.DiscoveryQuery`](omp.provider.md), [`omp.DiscoverySpec`](omp.provider.md), [`omp.EmulationPolicy`](omp.provider.md), [`omp.Effort`](omp.provider.md), [`omp.Facet`](omp.provider.md), [`omp.HostedTool`](omp.provider.md), [`omp.ImageCaps`](omp.provider.md), [`omp.ImageFeature`](omp.provider.md), [`omp.ImageFormat`](omp.provider.md), [`omp.ImageRequest`](omp.provider.md), [`omp.ImageResult`](omp.provider.md), [`omp.SpeechCaps`](omp.provider.md), [`omp.SpeechFeature`](omp.provider.md), [`omp.SpeechRequest`](omp.provider.md), [`omp.SpeechResult`](omp.provider.md), [`omp.LoginRequest`](omp.provider.md), [`omp.LogprobCaps`](omp.provider.md), [`omp.ManagementSpec`](omp.provider.md), [`omp.MismatchPolicy`](omp.provider.md), [`omp.Modality`](omp.provider.md), [`omp.ModelCard`](omp.provider.md), [`omp.ModelEvent`](omp.provider.md), [`omp.ModelOverlay`](omp.provider.md), [`omp.ModelPatch`](omp.provider.md), [`omp.ModelSpec`](omp.provider.md), [`omp.NegotiationPolicy`](omp.provider.md), [`omp.OAuthFlow`](omp.provider.md), [`omp.OAuthFlowKind`](omp.provider.md), [`omp.OAuthSpec`](omp.provider.md), [`omp.Operation`](omp.provider.md), [`omp.Pagination`](omp.provider.md), [`omp.Price`](omp.provider.md), [`omp.PriceUnit`](omp.provider.md), [`omp.PrincipalResolution`](omp.provider.md), [`omp.PromptCacheCaps`](omp.provider.md), [`omp.ProviderSpec`](omp.provider.md), [`omp.ProviderHandle`](omp.provider.md), [`omp.ReasoningCaps`](omp.provider.md), [`omp.RealtimeCaps`](omp.provider.md), [`omp.RealtimeCredentialRef`](omp.provider.md), [`omp.RealtimeEagerness`](omp.provider.md), [`omp.RealtimeEndpointRef`](omp.provider.md), [`omp.RealtimeFeature`](omp.provider.md), [`omp.RealtimeModality`](omp.provider.md), [`omp.RealtimeRequest`](omp.provider.md), [`omp.RealtimeSession`](omp.provider.md), [`omp.RealtimeTurnDetectionMode`](omp.provider.md), [`omp.RefreshBehavior`](omp.provider.md), [`omp.RefreshReason`](omp.provider.md), [`omp.RefreshRequest`](omp.provider.md), [`omp.RedirectTrust`](omp.provider.md), [`omp.RouteLimits`](omp.provider.md), [`omp.RouteSpec`](omp.provider.md), [`omp.ScopedAlias`](omp.provider.md), [`omp.ServerStateCaps`](omp.provider.md), [`omp.ServiceTier`](omp.provider.md), [`omp.Setting`](omp.provider.md), [`omp.SettingKind`](omp.provider.md), [`omp.SignRequest`](omp.provider.md), [`omp.TranscriptionCaps`](omp.provider.md), [`omp.TranscriptionFeature`](omp.provider.md), [`omp.TranscriptionRequest`](omp.provider.md), [`omp.TranscriptionResult`](omp.provider.md), [`omp.ThinkingMode`](omp.provider.md), [`omp.ThinkingSpec`](omp.provider.md), [`omp.TokenPlacement`](omp.provider.md), [`omp.TurnDetection`](omp.provider.md), [`omp.ToolCaps`](omp.provider.md), [`omp.ToolFeature`](omp.provider.md), [`omp.ToolSchemaFlavor`](omp.provider.md), [`omp.Transport`](omp.provider.md), [`omp.TrustDomain`](omp.provider.md), [`omp.UnknownCapabilityPolicy`](omp.provider.md), [`omp.ErrorKind`](omp.provider.md), [`omp.Failover`](omp.provider.md), [`omp.FailoverKind`](omp.provider.md), [`omp.Fallback`](omp.provider.md), [`omp.Intent`](omp.provider.md), [`omp.IntentKind`](omp.provider.md), [`omp.ModelFallback`](omp.provider.md), [`omp.ModelRef`](omp.provider.md), [`omp.ProviderError`](omp.provider.md), [`omp.Retryability`](omp.provider.md), [`omp.Role`](omp.provider.md), [`omp.RouteRef`](omp.provider.md), [`omp.StreamWatchdog`](omp.provider.md), [`omp.intents`](omp.provider.md).

### [omp.regimes](omp.regimes.md)

[`omp.regimes`](omp.regimes.md), [`omp.ADMISSION`](omp.regimes.md), [`omp.BATCH`](omp.regimes.md), [`omp.CONTEXT`](omp.regimes.md), [`omp.IDLE`](omp.regimes.md), [`omp.PRE_MODEL`](omp.regimes.md), [`omp.SETTLE`](omp.regimes.md), [`omp.STREAM`](omp.regimes.md), [`omp.TOOL_CHOICE`](omp.regimes.md), [`omp.TURN_END`](omp.regimes.md), [`omp.Next`](omp.regimes.md), [`omp.Point`](omp.regimes.md), [`omp.RegimeContext`](omp.regimes.md), [`omp.RegimeContractError`](omp.regimes.md), [`omp.RegimeEvent`](omp.regimes.md), [`omp.RegimeHandle`](omp.regimes.md), [`omp.RegimeLifetime`](omp.regimes.md), [`omp.RegimeRecord`](omp.regimes.md), [`omp.StateDecodeError`](omp.regimes.md), [`omp.StateSchemaMismatch`](omp.regimes.md), [`omp.active`](omp.regimes.md), [`omp.regime`](omp.regimes.md), [`omp.start`](omp.regimes.md), [`omp.stop`](omp.regimes.md), [`omp.user_text`](omp.regimes.md), [`omp.when`](omp.regimes.md).

### [omp.secrets](omp.secrets.md)

[`omp.Secret`](omp.secrets.md), [`omp.SecretKind`](omp.secrets.md), [`omp.SecretMode`](omp.secrets.md), [`omp.SecretRule`](omp.secrets.md).

### [omp.sessions](omp.sessions.md)

[`omp.Bucket`](omp.sessions.md), [`omp.GroupBy`](omp.sessions.md), [`omp.SessionAccessDenied`](omp.sessions.md), [`omp.SessionError`](omp.sessions.md).

### [omp.telemetry](omp.telemetry.md)

[`omp.PromptFingerprint`](omp.telemetry.md), [`omp.ModelRequest`](omp.telemetry.md), [`omp.TelemetryError`](omp.telemetry.md).

### [omp.ui](omp.ui.md)

[`omp.completion`](omp.ui.md).

### [omp.urls](omp.urls.md)

[`omp.AgentUrl`](omp.urls.md), [`omp.ArtifactUrl`](omp.urls.md), [`omp.HistoryUrl`](omp.urls.md), [`omp.Scheme`](omp.urls.md), [`omp.SchemeInfo`](omp.urls.md).

### [verdicts](verdicts.md)

- [`omp.AbortKind`](verdicts.md) — See the verdict reference for its contract and examples.
- [`omp.Aborted`](verdicts.md) — See the verdict reference for its contract and examples.
- [`omp.ArgsRejected`](verdicts.md) — See the verdict reference for its contract and examples.
- [`omp.ArtifactLifetime`](verdicts.md) — See the verdict reference for its contract and examples.
- [`omp.ArtifactRef`](verdicts.md) — See the verdict reference for its contract and examples.
- [`omp.CallOutcome`](verdicts.md) — See the verdict reference for its contract and examples.
- [`omp.BlobPart`](verdicts.md) — See the verdict reference for its contract and examples.
- [`omp.Budget`](verdicts.md) — See the verdict reference for its contract and examples.
- [`omp.Dialect`](verdicts.md) — See the verdict reference for its contract and examples.
- [`omp.Done`](verdicts.md) — See the verdict reference for its contract and examples.
- [`omp.Detached`](verdicts.md) — See the verdict reference for its contract and examples.
- [`omp.Faulted`](verdicts.md) — See the verdict reference for its contract and examples.
- [`omp.JobRef`](verdicts.md) — See the verdict reference for its contract and examples.
- [`omp.JsonPart`](verdicts.md) — See the verdict reference for its contract and examples.
- [`omp.LiftedCall`](verdicts.md) — See the verdict reference for its contract and examples.
- [`omp.ModelClass`](verdicts.md) — See the verdict reference for its contract and examples.
- [`omp.Ok`](verdicts.md) — See the verdict reference for its contract and examples.
- [`omp.BudgetError`](verdicts.md) — See the verdict reference for its contract and examples.
- [`omp.Postcondition`](verdicts.md) — See the verdict reference for its contract and examples.
- [`omp.PostconditionStatus`](verdicts.md) — See the verdict reference for its contract and examples.
- [`omp.RevError`](verdicts.md) — See the verdict reference for its contract and examples.
- [`omp.VerdictSchemaError`](verdicts.md) — See the verdict reference for its contract and examples.
- [`omp.VerdictShapeError`](verdicts.md) — See the verdict reference for its contract and examples.
- [`omp.dumps`](verdicts.md) — See the verdict reference for its contract and examples.
- [`omp.loads`](verdicts.md) — See the verdict reference for its contract and examples.

