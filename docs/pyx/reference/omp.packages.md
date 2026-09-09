# `omp.packages`

Use `omp.packages` to inspect the verified distribution snapshot installed for the current extension host. The module reads host-provided metadata only: listing and lookup do not scan `sys.path`, import a requested module, open a lockfile, or access the network.

```python
from omp import packages

current = packages.own()
print(current.name, current.version)
for distribution in packages.list():
    print(distribution.name, distribution.origin)
```

For the resolver, site-tree, and integrity model behind this snapshot, see [Placement and packaging](../guides/placement-and-packaging.md).

## Errors

### `omp.packages.PackageError`

```python
class PackageError(OmpError, RuntimeError): ...
```

Base error for package metadata that is unavailable in the current execution context.

### `omp.packages.ResolutionError`

```python
class ResolutionError(PackageError): ...
```

Signals that verified ownership metadata contradicts the materialized site tree.

### `omp.packages.IntegrityError`

```python
class IntegrityError(PackageError): ...
```

Signals failure of an explicit distribution integrity check.

### `omp.packages.GrantError`

```python
class GrantError(PackageError): ...
```

Signals that a deployment operation lacks its operator-recorded capability grant.

## Enums

### `omp.packages.Origin`

```python
class Origin(StrEnum):
    FROZEN = "frozen"
    STORE = "store"
    LINK = "link"
```

Describes how a distribution became visible in the host's site tree.

| Member | Wire value | Meaning |
|---|---|---|
| `FROZEN` | `"frozen"` | Distribution is embedded in the host runtime. |
| `STORE` | `"store"` | Distribution came from the content-addressed extension store. |
| `LINK` | `"link"` | Distribution is a development link. |

### `omp.packages.ContentKind`

```python
class ContentKind(StrEnum):
    SKILLS = "skills"
    RULES = "rules"
    CONTEXT_FILES = "context-files"
    PROMPTS = "prompts"
```

Provides the closed vocabulary for shipped non-executable content.

| Member | Wire value | Meaning |
|---|---|---|
| `SKILLS` | `"skills"` | Skill content. |
| `RULES` | `"rules"` | Rule content. |
| `CONTEXT_FILES` | `"context-files"` | Context files. |
| `PROMPTS` | `"prompts"` | Prompt content. |

## Data models

### `omp.packages.ContentDeclaration`

```python
@dataclass(frozen=True, slots=True)
class ContentDeclaration:
    kind: ContentKind
    path: str
    metadata: Mapping[str, Any] = field(
        default_factory=lambda: MappingProxyType({})
    )
```

Represents one manifest-declared content path or glob. Construction converts a compatible string kind to `ContentKind` and freezes a copy of `metadata`.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `kind` | `ContentKind` | required | Content category. |
| `path` | `str` | required | Non-empty distribution-relative path or glob supplied by the manifest snapshot. |
| `metadata` | `Mapping[str, Any]` | empty immutable mapping | Author metadata associated with the content row. |

**Raises**

: `omp.ManifestError` — `path` is empty or not a string, or `metadata` is not a mapping.
: `ValueError` — `kind` cannot be converted to `ContentKind`.

### `omp.packages.SettingSchema`

```python
@dataclass(frozen=True, slots=True)
class SettingSchema:
    type: Literal["string", "number", "boolean", "enum"]
    default: str | float | bool | None = None
    description: str | None = None
    values: tuple[str, ...] | None = None
    min: float | None = None
    max: float | None = None
    step: float | None = None
    secret: bool = False
    env: str | None = None

    def validate(self) -> None: ...
```

Defines one user-editable manifest setting. Construction calls `validate()` immediately; calling it again is useful after decoding an external representation.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `type` | `Literal["string", "number", "boolean", "enum"]` | required | Setting value category. |
| `default` | `str | float | bool | None` | `None` | Default setting value. |
| `description` | `str | None` | `None` | User-facing explanation. |
| `values` | `tuple[str, ...] | None` | `None` | Allowed non-empty strings for an enum. |
| `min` | `float | None` | `None` | Numeric minimum. |
| `max` | `float | None` | `None` | Numeric maximum. |
| `step` | `float | None` | `None` | Positive numeric step. |
| `secret` | `bool` | `False` | Whether the setting contains secret material. |
| `env` | `str | None` | `None` | Optional non-empty environment variable name. |

For `type="enum"`, `values` is required and a non-`None` default must be a member. `values` is forbidden for other types. Numeric bounds and `step` are allowed only for `type="number"`; `min` cannot exceed `max`, and `step` must be positive.

**Returns**

: `None` — The schema is internally consistent.

**Raises**

: `omp.ManifestError` — Any schema invariant is violated.

```python
schema = packages.SettingSchema(
    type="enum",
    default="compact",
    values=("compact", "expanded"),
)
schema.validate()
```

### `omp.packages.Provenance`

```python
@dataclass(frozen=True, slots=True)
class Provenance:
    publisher: str
    extension_id: str
    version: str
    artifact_digest: str
    layer: str
    tier: str
    generation: int
```

Carries the structural provenance stamped on an extension action.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `publisher` | `str` | required | Publisher identity or fingerprint. |
| `extension_id` | `str` | required | Stable extension identifier. |
| `version` | `str` | required | Exact extension version. |
| `artifact_digest` | `str` | required | Digest of the installed artifact. |
| `layer` | `str` | required | Installation layer. |
| `tier` | `str` | required | Granted trust tier. |
| `generation` | `int` | required | Acting host generation. |

### `omp.packages.SiteTree`

```python
@dataclass(frozen=True, slots=True)
class SiteTree:
    path: Path
    key: str
    layer: str
    tier: str
    pool: str | None
    resolution: str
    lock: Path | None
```

Describes the single materialized import tree used by this host.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `path` | `pathlib.Path` | required | Site-tree path used by the host. |
| `key` | `str` | required | Materialization key. |
| `layer` | `str` | required | Owning layer. |
| `tier` | `str` | required | Trust tier of the host. |
| `pool` | `str | None` | required | Explicit sharing pool, or `None`. |
| `resolution` | `str` | required | Resolution fingerprint. |
| `lock` | `pathlib.Path | None` | required | Source lockfile when one produced the tree. |

### `omp.packages.Distribution`

```python
@dataclass(frozen=True, slots=True)
class Distribution:
    name: str
    version: str
    extension_id: str | None
    origin: Origin
    tag: str | None
    blake3: str | None
    root: Path | None
    files: tuple[Path, ...]
    declarations: tuple[ContentDeclaration, ...]
    requested_by: tuple[str, ...]
    vendored: tuple[str, ...]

    def verify(self, deep: bool = False) -> None: ...
```

Provides verified metadata for one distribution visible to this host. `verify()` is intentionally explicit: ordinary metadata access performs no filesystem verification.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `name` | `str` | required | PEP 503-normalized distribution name. |
| `version` | `str` | required | Exact distribution version. |
| `extension_id` | `str | None` | required | Owning extension id for an extension root, otherwise `None`. |
| `origin` | `Origin` | required | How the distribution entered the site tree. |
| `tag` | `str | None` | required | Selected wheel tag, when applicable. |
| `blake3` | `str | None` | required | Recorded BLAKE3 digest, when applicable. |
| `root` | `pathlib.Path | None` | required | Materialized root, when applicable. |
| `files` | `tuple[pathlib.Path, ...]` | required | Recorded distribution files. |
| `declarations` | `tuple[ContentDeclaration, ...]` | required | Shipped non-executable content declarations. |
| `requested_by` | `tuple[str, ...]` | required | Extension ids that introduced the distribution. |
| `vendored` | `tuple[str, ...]` | required | Declared vendored distribution names. |

**Parameters**

: **`deep`** (`bool`) — Request the host verifier's deep mode, such as per-file verification.

**Returns**

: `None` — Verification completed successfully.

**Raises**

: `IntegrityError` — No verifier is installed, or the verifier reports any failure.

```python
own_distribution = packages.own()
own_distribution.verify(deep=True)
```

## Snapshot queries

### `omp.packages.list`

```python
def list() -> _builtins.list[Distribution]: ...
```

Returns a new list containing every distribution in the installed snapshot.

**Returns**

: `list[Distribution]` — Snapshot entries in host-provided order.

### `omp.packages.get`

```python
def get(name: str) -> Distribution | None: ...
```

Looks up a distribution using the PEP 503 comparison form. Case differences and runs of `.`, `_`, or `-` normalize to hyphens.

**Parameters**

: **`name`** (`str`) — Non-empty distribution name.

**Returns**

: `Distribution | None` — The matching distribution, if present.

**Raises**

: `TypeError` — `name` is not a non-empty string.
: `ValueError` — Normalization produces no name segment.

```python
httpx = packages.get("HTTPX")
```

### `omp.packages.of`

```python
def of(module: str | ModuleType) -> Distribution | None: ...
```

Returns the recorded owner of a loaded module without importing it. Lookup starts with the full module name, then walks parent module names until it finds an owner.

**Parameters**

: **`module`** (`str | ModuleType`) — Loaded module object or module name.

**Returns**

: `Distribution | None` — Nearest recorded owner, if any.

**Raises**

: `TypeError` — The resolved module name is not a string.

```python
import json

owner = packages.of(json)
```

### `omp.packages.own`

```python
def own() -> Distribution: ...
```

Returns the distribution that owns the calling extension.

**Returns**

: `Distribution` — The installed extension root.

**Raises**

: `PackageError` — The host did not install a calling-extension distribution, as in a non-extension execution context.

### `omp.packages.site`

```python
def site() -> SiteTree: ...
```

Returns this host's one materialized site tree.

**Returns**

: `SiteTree` — Immutable tree metadata.

**Raises**

: `PackageError` — No site tree is installed for this host.
