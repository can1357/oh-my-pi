# `omp.devices`

`omp.devices` contains the device catalog, path, effect-envelope, routing, and dynamic-mounting vocabulary. Reach for it when you need to inspect catalog state, declare child routes, or attach runtime-discovered leaves below a frozen parent.

Most classes are also re-exported from `omp`. The module-level `devices` object is the live namespace for catalog operations.

## Minimal example

```python
import omp


@omp.device("ping", rev=1, summary="Return a liveness response.")
async def ping(args, ctx):
    return {"alive": True}


for row in omp.devices.list(mounted_only=False):
    print(row.identity, row.available)
```

## Constants

### `omp.devices.HARD_SLOT_BUDGET`

```python
HARD_SLOT_BUDGET: int = 8
```

Maximum hard-tool slots available to the device surface.

### `omp.devices.EXTERNAL_SUMMARY_CAP`

```python
EXTERNAL_SUMMARY_CAP: int = 200
```

Maximum external summary allowance.

### `omp.devices.PER_DEVICE_CAP`

```python
PER_DEVICE_CAP: int = 10_000
```

Maximum per-device documentation allowance.

The same values are exposed as class attributes on `Devices`.

## Ordering and documentation modes

### `omp.devices.Precedence`

```python
class Precedence(IntEnum)
```

Orders competing claims on one device name.

| Member | Value | Meaning |
|---|---:|---|
| `CORE` | `1000` | Reserved core priority; extension declarations must stay below it. |
| `INTEGRATION` | `700` | Integration-owned claim. |
| `ENHANCEMENT` | `500` | Enhancement of an existing capability. |
| `DEFAULT` | `0` | Ordinary extension claim. |
| `FALLBACK` | `-500` | Lowest-priority fallback implementation. |

### `omp.devices.DocsMode`

```python
class DocsMode(StrEnum)
```

Selects how much device documentation is inlined.

| Member | Wire value | Meaning |
|---|---|---|
| `CATALOG` | `"catalog"` | Catalog-level documentation. |
| `BUILTINS` | `"builtins"` | Built-in documentation set. |
| `INLINE` | `"inline"` | Inline the device documentation. |

## Availability and examples

### `omp.devices.Availability`

```python
Availability(mounted: bool, reason: str | None = None)
```

Describes the result of an availability predicate.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `mounted` | `bool` | required | Whether the declared device is mounted. |
| `reason` | `str | None` | `None` | Explanation when it is not mounted. |

### `omp.devices.AvailabilityDelta`

```python
AvailabilityDelta(path: str, mounted: bool, reason: str | None = None)
```

Describes one requested mountedness change in an atomic transition.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `path` | `str` | required | Non-empty absolute device path. |
| `mounted` | `bool` | required | Desired mounted state. |
| `reason` | `str | None` | `None` | Explanation for an unavailable path. |

A mounted delta cannot carry a reason.

**Raises**

- `ValueError` if `path` is empty or a mounted delta has a reason.
- `TypeError` for a non-boolean `mounted` value or invalid `reason` type.

```python
await omp.devices.set_availability(
    omp.AvailabilityDelta("mcp/search", True),
    omp.AvailabilityDelta("mcp/write", False, "server is read-only"),
)
```

### `omp.devices.Example`

```python
Example(
    args: Mapping[str, object],
    note: str | None = None,
    result: str | None = None,
)
```

Carries one worked invocation for device documentation.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `args` | `Mapping[str, object]` | required | Example argument object. |
| `note` | `str | None` | `None` | Optional explanatory note. |
| `result` | `str | None` | `None` | Optional expected-result text. |

## Effect envelopes

### `omp.devices.DocEffects`

```python
DocEffects(read: bool = False, write_globs: tuple[str, ...] = ())
```

Bounds a device's document access.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `read` | `bool` | `False` | Whether document reads may occur. |
| `write_globs` | `tuple[str, ...]` | `()` | Glob patterns the device may write. |

### `omp.devices.ExecEffects`

```python
ExecEffects(commands: tuple[str, ...] = (), network: bool = False)
```

Bounds command and network access.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `commands` | `tuple[str, ...]` | `()` | Command names the device may execute. |
| `network` | `bool` | `False` | Whether network access may occur. |

### `omp.devices.InferenceEffects`

```python
InferenceEffects(max_requests: int = 0, max_usd: float = 0.0)
```

Bounds nested inference use.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `max_requests` | `int` | `0` | Maximum nested inference requests. |
| `max_usd` | `float` | `0.0` | Maximum declared dollar cost. |

### `omp.devices.Effects`

```python
Effects(
    documents: DocEffects | None = None,
    exec: ExecEffects | None = None,
    inference: InferenceEffects | None = None,
    subagents: int = 0,
)
```

Combines the maximum static effect envelope for a device.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `documents` | `DocEffects | None` | `None` | Document envelope. |
| `exec` | `ExecEffects | None` | `None` | Command and network envelope. |
| `inference` | `InferenceEffects | None` | `None` | Nested inference envelope. |
| `subagents` | `int` | `0` | Maximum subagents. |

```python
limits = omp.Effects(
    documents=omp.DocEffects(read=True, write_globs=("reports/**",)),
    exec=omp.ExecEffects(commands=("git",), network=False),
    subagents=0,
)
```

## Sampling constraints

### `omp.devices.ConstraintKind`

```python
class ConstraintKind(StrEnum)
```

Selects the provider-side argument constraint kind.

| Member | Wire value | Meaning |
|---|---|---|
| `SCHEMA` | `"schema"` | Constrain sampling with the device JSON Schema. |
| `GRAMMAR` | `"grammar"` | Constrain sampling with an explicit grammar. |

### `omp.devices.ConstraintFallback`

```python
class ConstraintFallback(StrEnum)
```

Selects behavior when the chosen route cannot honor a constraint.

| Member | Wire value | Meaning |
|---|---|---|
| `UNSPECIFIED` | `"unspecified"` | Leave fallback selection to the host. |
| `ERROR` | `"error"` | Refuse the unsupported constrained request. |
| `DROP` | `"drop"` | Continue without the constraint. |

### `omp.devices.GrammarSyntax`

```python
class GrammarSyntax(StrEnum)
```

Identifies the grammar notation carried by a tool constraint.

| Member | Wire value | Meaning |
|---|---|---|
| `LARK` | `"lark"` | Lark grammar. |
| `REGEX` | `"regex"` | Regular expression. |
| `EBNF` | `"ebnf"` | Extended Backus–Naur form. |
| `GBNF` | `"gbnf"` | GBNF grammar. |

### `omp.devices.ToolConstraint`

```python
ToolConstraint(
    kind: ConstraintKind = ConstraintKind.SCHEMA,
    priority: int = 100,
    syntax: GrammarSyntax | None = None,
    definition: str | None = None,
    on_unsupported: ConstraintFallback = ConstraintFallback.UNSPECIFIED,
)
```

Requests constrained argument sampling for one declared tool.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `kind` | `ConstraintKind` | `SCHEMA` | Schema or grammar constraint. |
| `priority` | `int` | `100` | Arbitration priority from 0 through 255. |
| `syntax` | `GrammarSyntax | None` | `None` | Grammar syntax; grammar constraints require it. |
| `definition` | `str | None` | `None` | Non-empty grammar definition. |
| `on_unsupported` | `ConstraintFallback` | `UNSPECIFIED` | Unsupported-route behavior. |

String enum values are normalized to their enum members. Schema constraints reject grammar fields. Grammar constraints require both `syntax` and a non-empty `definition`.

**Raises**

- `TypeError` if `priority` is not an integer.
- `ValueError` if `priority` is outside 0–255 or the selected kind has incompatible fields.

#### `ToolConstraint.schema`

```python
@classmethod
def schema(
    cls,
    *,
    priority: int = 100,
    on_unsupported: ConstraintFallback = ConstraintFallback.UNSPECIFIED,
) -> ToolConstraint
```

Builds a strict JSON-Schema sampling request.

#### `ToolConstraint.grammar`

```python
@classmethod
def grammar(
    cls,
    syntax: GrammarSyntax,
    definition: str,
    *,
    priority: int = 100,
    on_unsupported: ConstraintFallback = ConstraintFallback.UNSPECIFIED,
) -> ToolConstraint
```

Builds a grammar-constrained sampling request.

```python
constraint = omp.ToolConstraint.grammar(
    omp.GrammarSyntax.REGEX,
    r"[0-9]+",
    priority=200,
    on_unsupported=omp.ConstraintFallback.ERROR,
)
```

## Paths and catalog rows

### `omp.devices.ToolPath`

```python
ToolPath(name: str, sub: str | None = None, claimant: str | None = None)
```

Identifies a root device, optional child subpath, and optional claimant.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `name` | `str` | required | Root path segment. |
| `sub` | `str | None` | `None` | Slash-separated relative child path. |
| `claimant` | `str | None` | `None` | Qualified claimant in `publisher/extension` form. |

`str(path)` renders `name/sub@claimant`, omitting absent portions. Segments use lowercase ASCII letters, digits, and underscores and must start with a letter.

**Raises**

- `DeviceError` if a segment or claimant is invalid.

```python
path = omp.ToolPath("jira", "issue/create", "acme/tracker")
assert str(path) == "jira/issue/create@acme/tracker"
```

### `omp.devices.DeviceInfo`

```python
DeviceInfo(
    name: str,
    family: str,
    rev: int,
    identity: str,
    claimant: str,
    path: ToolPath,
    summary: str | None,
    place: Place,
    precedence: int,
    tier: Tier,
    effects: Effects | None,
    mounted: bool,
    enabled: bool,
    available: bool,
    reason: str | None,
    shadowed_by: str | None,
    source: str,
    provenance: Provenance,
    slotted: bool,
    schema_bytes: int,
    schema_tokens: int,
)
```

Captures an immutable catalog snapshot for one claimant.

| Field | Type | Meaning |
|---|---|---|
| `name` | `str` | Declared full name. |
| `family` | `str` | Revision family. |
| `rev` | `int` | Semantic revision number. |
| `identity` | `str` | Rendered durable identity. |
| `claimant` | `str` | Claiming extension. |
| `path` | `ToolPath` | Catalog address. |
| `summary` | `str | None` | Short documentation summary. |
| `place` | `Place` | Execution placement. |
| `precedence` | `int` | Claim ordering value. |
| `tier` | `Tier` | Policy tier. |
| `effects` | `Effects | None` | Static effect envelope. |
| `mounted` | `bool` | Whether the identity is mounted. |
| `enabled` | `bool` | Whether dispatch is enabled. |
| `available` | `bool` | Effective availability. |
| `reason` | `str | None` | Unavailability reason. |
| `shadowed_by` | `str | None` | Winning claimant, when shadowed. |
| `source` | `str` | Source extension identifier. |
| `provenance` | `Provenance` | Package provenance snapshot. |
| `slotted` | `bool` | Whether it occupies a hard model-tool slot. |
| `schema_bytes` | `int` | Encoded schema size. |
| `schema_tokens` | `int` | Estimated schema token count. |

See [placement](omp.placement.md), [policy](omp.policy.md), and [packages](omp.packages.md) for the referenced types.

## Static routing

### `omp.devices.Router`

```python
Router(prefix: str)
```

Collects static child routes before a parent device is available.

**Parameters**

- `prefix` (`str`) — valid relative path prefix.

**Raises**

- `DeviceError` if the prefix is not a valid device subpath.

#### `Router.subtool`

```python
def subtool(
    self,
    path: str,
    **overrides: object,
) -> Callable[[Callable[..., Any]], Callable[..., Any]]
```

Declares a route under the router prefix.

Allowed overrides are `family`, `place`, `precedence`, `tier`, `effects`, `docs`, and `summary`. The decorator returns the original body.

**Raises**

- `DeviceError` for an invalid or duplicate route path.
- `TypeError` for an unknown override or non-callable body.

```python
search_routes = omp.router("search")


@search_routes.subtool("files", summary="Search project files.")
async def search_files(pattern: str):
    return {"pattern": pattern}
```

### `omp.devices.router`

```python
def router(prefix: str) -> Router
```

Creates a standalone static router.

**Parameters**

- `prefix` (`str`) — relative path mounted below a parent.

**Returns**

A new `Router`.

### `omp.devices.Device`

```python
Device(
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
)
```

Provides the live handle returned by `@omp.device` and `@omp.tool`.

Public attributes include `name`, `family`, `rev`, `identity`, `path`, `place`, `precedence`, `replaces`, `schema`, `docs`, `summary`, `body`, `enabled`, `mounted`, `prompt`, `lift`, `shadows`, `shadowed_by`.

You normally obtain a handle from a decorator rather than constructing it.

#### `Device.enable`

```python
def enable(self) -> None
```

Enables this declaration for the host's freeze projection.

#### `Device.disable`

```python
def disable(self, reason: str | None = None) -> None
```

Disables this declaration for the freeze projection.

**Parameters**

- `reason` (`str | None`) — optional unavailable explanation.

#### `Device.subtool`

```python
def subtool(
    self,
    path: str,
    **overrides: object,
) -> Callable[[Callable[..., Any]], Device]
```

Declares a static child below this device. The returned decorator registers and returns a child `Device` handle.

Child declarations inherit unspecified values from the parent. Allowed overrides are `family`, `place`, `precedence`, `tier`, `effects`, `docs`, and `summary`.

**Raises**

- `DeviceError` for an invalid path or invalid placement.
- `DeviceNameError` when child precedence is at least `Precedence.CORE`.
- `TypeError` for invalid override names, values, or bodies.

#### `Device.mount`

```python
def mount(self, mounted_router: Router) -> tuple[Device, ...]
```

Registers every route in a standalone router below this static parent.

**Returns**

The child handles in router declaration order.

**Raises**

- `TypeError` unless passed a `Router`.
- `DeclarationSealed` after the declaration registry is sealed.

#### `Device.__call__`

```python
async def __call__(self, *args: Any, **kwargs: Any) -> Any
```

Invokes the decorated body directly in the current process. This bypasses host catalog dispatch, admission, and placement; use it for ordinary direct-call behavior, not to simulate a host invocation.

## Dynamic mounting

### `omp.devices.MountSpec`

```python
MountSpec(
    subpath: str,
    body: Callable[..., Any],
    schema: Mapping[str, object],
    summary: str,
    docs: str | None = None,
)
```

Describes one runtime-discovered leaf relative to a dynamic parent.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `subpath` | `str` | required | Relative validated device subpath. |
| `body` | `Callable[..., Any]` | required | Leaf implementation. |
| `schema` | `Mapping[str, object]` | required | JSON-serializable object schema. |
| `summary` | `str` | required | Leaf summary. |
| `docs` | `str | None` | `None` | Optional full documentation. |

Construction copies `schema` through JSON and freezes the resulting mapping, so Python-only values and non-finite numbers are rejected.

**Raises**

- `TypeError` for an invalid body, schema, summary, docs, or non-JSON schema value.
- `ValueError` for an invalid subpath.

### `omp.devices.DynamicDeviceParent`

```python
DynamicDeviceParent(name: str, family: str, rev: int, place: str)
```

Represents a manifest-authorized top-level parent for post-freeze leaves.

| Field | Type | Meaning |
|---|---|---|
| `name` | `str` | Frozen root name. |
| `family` | `str` | Frozen revision family. |
| `rev` | `int` | Frozen semantic revision. |
| `place` | `str` | Frozen placement spelling. |

#### `DynamicDeviceParent.path`

```python
def path(self, subpath: str) -> str
```

Validates a relative path and returns `"parent/subpath"`.

#### `DynamicDeviceParent.mount_many`

```python
async def mount_many(self, *specs: MountSpec) -> tuple[str, ...]
```

Atomically mounts discovered leaves below this parent and installs the authoritative catalog returned by the host.

**Returns**

Absolute paths in the same order as `specs`.

**Raises**

- `NotWiredError` without an active control backend.
- `TypeError` if any item is not a `MountSpec`.
- `DeviceError` for duplicates, an already-mounted path, or an invalid host response.

If the host request fails, locally staged bodies are removed before the error propagates.

#### `DynamicDeviceParent.mount`

```python
async def mount(self, spec: MountSpec) -> str
```

Mounts one leaf through `mount_many` and returns its absolute path.

## Catalog namespace

### `omp.devices.Devices`

```python
Devices()
```

Provides dynamic-parent declarations and session-scoped catalog operations. Use the singleton `omp.devices` rather than constructing another instance.

#### `Devices.parent`

```python
def parent(
    self,
    name: str,
    *,
    family: str,
    rev: int,
    place: str = "host",
) -> DynamicDeviceParent
```

Declares a manifest-backed dynamic parent during import.

**Parameters**

- `name` (`str`) — valid root segment.
- `family` (`str`) — revision family.
- `rev` (`int`) — semantic revision; booleans are rejected.
- `place` (`str`) — placement spelling.

**Returns**

The registered `DynamicDeviceParent`.

**Raises**

- `DeviceError` for an invalid name or placement.
- `TypeError` for invalid `family` or `rev` values.

#### `Devices.set_availability`

```python
async def set_availability(self, *deltas: AvailabilityDelta) -> None
```

Applies all deltas as one host transition and installs the returned authoritative catalog.

**Raises**

- `NotWiredError` without an active control backend.
- `TypeError` if any item is not an `AvailabilityDelta`.
- `DeviceError` for an invalid host response.

#### `Devices.enable`

```python
async def enable(self, *paths: str) -> None
```

Marks paths mounted in one availability transition.

#### `Devices.disable`

```python
async def disable(
    self,
    *paths: str,
    reason: str | None = None,
) -> None
```

Marks paths unmounted in one transition, using one reason for every path.

#### `Devices.refresh`

```python
async def refresh(self) -> tuple[DeviceInfo, ...]
```

Asks the host to recompute ordinary availability predicates and returns its authoritative catalog.

**Raises**

- `NotWiredError` without an active control backend.
- `DeviceError` for an invalid response.

#### `Devices.invoke`

```python
async def invoke(
    self,
    path: str,
    args: Mapping[str, object],
    *,
    deadline: Duration | None = None,
) -> object
```

Invokes another device through the host dispatcher. The nested call receives independent admission and policy decisions and inherits no ambient authority. This operation is valid only from host placement.

**Parameters**

- `path` (`str`) — non-empty catalog path.
- `args` (`Mapping[str, object]`) — JSON-serializable argument object.
- `deadline` (`Duration | None`) — optional nested-call deadline.

**Returns**

The host response object.

**Raises**

- `NotWiredError` without a control backend.
- `ValueError` for an empty path.
- `TypeError` for invalid argument values, non-JSON argument content, or an invalid deadline.

```python
result = await omp.devices.invoke(
    "search/files",
    {"query": "DeviceInfo"},
    deadline=omp.Duration("2s"),
)
```

#### `Devices.list`

```python
def list(self, *, mounted_only: bool = True) -> tuple[DeviceInfo, ...]
```

Returns immutable catalog rows. Before a host catalog is installed, locally declared rows are synthesized; afterward, authoritative rows are combined with declarations not present in that view.

**Parameters**

- `mounted_only` (`bool`) — omit unmounted claims when true.

**Returns**

A tuple of `DeviceInfo` snapshots.

### `omp.devices.devices`

```python
devices: Devices
```

Singleton catalog namespace re-exported as `omp.devices`.

## Exceptions

### `omp.devices.DeviceError`

```python
class DeviceError(ExtensionError)
```

Base error for device declarations and runtime catalog operations.

### `omp.devices.DeviceNameError`

```python
class DeviceNameError(DeviceError)
```

Raised for an invalid device name or prohibited precedence claim.

### `omp.devices.SchemaError`

```python
class SchemaError(DeviceError, JournalError)
```

Raised for an invalid device schema, example, or schema-revision decode.

### `omp.devices.PrecedenceConflict`

```python
class PrecedenceConflict(DeviceError)
```

Raised when competing claims cannot be ordered unambiguously.

### `omp.devices.DocsBudgetError`

```python
class DocsBudgetError(DeviceError)
```

Raised when device documentation exceeds its allowed budget.

### `omp.devices.DeviceUnavailable`

```python
class DeviceUnavailable(DeviceError)
```

Raised when no mounted device satisfies a selected path.
