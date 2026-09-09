# `omp.urls`

Use `omp.urls` to parse addresses and read selectors without I/O, inspect the host's live scheme capabilities, and ask the authoritative host resolver to read an address. Typed artifact, history, and agent addresses preserve their scheme at API boundaries.

```python
from omp import urls

parsed = urls.parse("artifact://01K...:20-40:raw")
assert parsed.scheme is urls.Scheme.ARTIFACT
text = await urls.read(parsed)
```

## Errors

### `omp.urls.UrlError`

```python
class UrlError(OmpError, ValueError)
```

Base exception for URL parsing and resolution failures.

### `omp.urls.SelectorError`

```python
class SelectorError(UrlError)
```

Raised when a read selector has invalid syntax, invalid bounds, or is used with a scheme that does not support selectors.

### `omp.urls.SchemeNotReadable`

```python
class SchemeNotReadable(UrlError)
```

Raised when the deployment knows a scheme but has no active reader for it.

## Typed addresses

### `omp.urls.AgentUrl`

```python
class AgentUrl:
    def __new__(cls, /, value: str) -> AgentUrl
    def read(self, /) -> Any
    def with_selector(self, /, selector: str) -> AgentUrl
```

A typed `agent://` address. `resource`, `selector`, and `uri` are read-only `str`, `str | None`, and `str` properties. `with_selector()` returns a new value; `read()` returns the host-backed awaitable, so await it.

```python
address = AgentUrl("agent://worker-17/result")
text = await address.with_selector("1-40").read()
```

**Raises**

: `ValueError`: The address is malformed.

### `omp.urls.ArtifactUrl`

```python
class ArtifactUrl:
    def __new__(cls, /, value: str) -> ArtifactUrl
    def read(self, /) -> Any
    def with_selector(self, /, selector: str) -> ArtifactUrl
```

A typed `artifact://` address. It exposes the same immutable `resource`, `selector`, and `uri` properties and host-backed `read()` operation as `AgentUrl`. See [artifact storage](omp.artifacts.md).

### `omp.urls.HistoryUrl`

```python
class HistoryUrl:
    def __new__(cls, /, value: str) -> HistoryUrl
    def read(self, /) -> Any
    def with_selector(self, /, selector: str) -> HistoryUrl
```

A typed `history://` address with immutable `resource`, `selector`, and `uri` properties. Await `read()` to resolve it through the host.

## Parsed values

### `omp.urls.Scheme`

```python
class Scheme(StrEnum)
```

The built-in scheme vocabulary generated from the shared tool schema.

| Member | Wire value | Selectors |
|---|---|---:|
| `FILE` | `file` | yes |
| `HTTP` | `http` (`https` is an alias while parsing) | yes |
| `ARTIFACT` | `artifact` | yes |
| `HISTORY` | `history` | yes |
| `AGENT` | `agent` | yes |
| `LOCAL` | `local` | yes |
| `MEMORY` | `memory` | yes |
| `MCP` | `mcp` | no |
| `SKILL` | `skill` | yes |
| `RULE` | `rule` | yes |
| `OMP` | `omp` | yes |
| `ISSUE` | `issue` | yes |
| `PR` | `pr` | yes |
| `SSH` | `ssh` | yes |
| `SECURITY` | `security` | yes |
| `VAULT` | `vault` | yes |
| `JOB` | `job` | yes |
| `ATTACHMENT` | `attachment` | yes |
| `CONFLICT` | `conflict` | yes |
| `UNKNOWN` | `unknown` | no |

> **Note** Scheme support is deployment-dependent. Check `schemes()` before assuming a known scheme can be read or minted.

### `omp.urls.Selector`

```python
@dataclass(frozen=True, slots=True)
class Selector:
    ranges: tuple[tuple[int, int | None], ...] = ()
    raw: bool = False
    conflicts: bool = False
```

A normalized read selection. Ranges are one-based and inclusive; `None` as an end means through end-of-content. Parsing sorts and merges overlapping or adjacent ranges.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `ranges` | `tuple[tuple[int, int | None], ...]` | `()` | Ordered inclusive ranges. |
| `raw` | `bool` | `False` | Return unnumbered source text. |
| `conflicts` | `bool` | `False` | Select unresolved merge-conflict blocks. |

### `omp.urls.Url`

```python
@dataclass(frozen=True, slots=True)
class Url:
    scheme: Scheme
    raw_scheme: str
    resource: str
    selector: Selector | None
    text: str
    value: TypedUrl | None
```

The pure result of parsing an address or bare file path.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `scheme` | `Scheme` | required | Canonical recognized scheme, or `UNKNOWN`. |
| `raw_scheme` | `str` | required | Scheme spelling supplied by the caller; empty for a bare path. |
| `resource` | `str` | required | Address body with any recognized selector removed. |
| `selector` | `Selector | None` | required | Parsed selector. |
| `text` | `str` | required | Original complete input. |
| `value` | `ArtifactUrl | HistoryUrl | AgentUrl | EnvPath | None` | required | Typed value when this parser supports one. |

### `omp.urls.SchemeInfo`

```python
@dataclass(frozen=True, slots=True)
class SchemeInfo:
    readable: bool
    mintable: bool
    selectors: bool
    description: str
```

Live capabilities for one scheme.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `readable` | `bool` | required | The host can resolve reads. |
| `mintable` | `bool` | required | The deployment can create addresses of this scheme. |
| `selectors` | `bool` | required | Read selectors are accepted. |
| `description` | `str` | required | Host-provided purpose text. |

## Operations

### `omp.urls.schemes`

```python
def schemes() -> Mapping[Scheme, SchemeInfo]
```

Return an immutable live capability table. The module refreshes its cache when the host's device-side digest changes; before a source is bound, it returns the current empty cache.

**Returns**

: `Mapping[Scheme, SchemeInfo]`: Current scheme capabilities.

### `omp.urls.parse`

```python
def parse(url: str | TypedUrl) -> Url
```

Parse an address or bare file path without reading anything. Unknown syntactically valid schemes become `Scheme.UNKNOWN`. Bare paths become `Scheme.FILE`. A selector is detached only where the grammar and scheme allow it.

**Parameters**

: `url` (`str | ArtifactUrl | HistoryUrl | AgentUrl | EnvPath`): Address or path to parse.

**Returns**

: `Url`: Immutable parsed components.

**Raises**

: `UrlError`: The scheme or resource is malformed.
: `SelectorError`: A selector-looking suffix has invalid bounds or syntax.

```python
value = parse("src/app.py:10+5:raw")
assert value.selector == Selector(ranges=((10, 14),), raw=True)
```

### `omp.urls.parse_selector`

```python
def parse_selector(text: str) -> Selector
```

Parse one selector fragment. Accepted forms include `N`, `N-M`, `N+K`, `N-`, comma-separated ranges, `raw`, `conflicts`, and `raw` combined with ranges. Lines are one-indexed.

**Parameters**

: `text` (`str`): Fragment without the leading colon.

**Returns**

: `Selector`: Sorted, merged selection.

**Raises**

: `SelectorError`: The fragment is empty, malformed, starts at zero, reverses a range, or exceeds unsigned 64-bit bounds.

### `omp.urls.read`

```python
async def read(
    url: str | Url | TypedUrl,
    selector: str | None = None,
) -> str
```

Read through the host resolver. A separate `selector` is validated and appended to the target; it cannot be combined with a selector already present in the address.

**Parameters**

: `url` (`str | Url | ArtifactUrl | HistoryUrl | AgentUrl | EnvPath`): Target address.
: `selector` (`str | None`): Optional selector fragment without a leading colon.

**Returns**

: `str`: Resolver output.

**Raises**

: `HostDisconnected`: No scheme capability snapshot is installed.
: `SchemeNotReadable`: The scheme has no reader in this deployment.
: `SelectorError`: The selector is invalid, duplicated, or unsupported by the scheme.
: `UrlError`: Parsing fails or the resolver returns a non-string value.

```python
excerpt = await read("artifact://01K...", "50-100:raw")
```
