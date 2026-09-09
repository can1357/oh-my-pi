# `omp.index`

Use `omp.index` to decode the static extension catalog, PEP 691 project responses, and pre-resolved lock fragments. Parsing functions are pure. `IndexClient` makes fetching explicit and lets you supply both transport and signature policy.

```python
from omp.index import parse_catalog

catalog = parse_catalog(b'{"entries": []}')
assert catalog.entries == ()
```

## Errors

### `omp.index.IndexError`

```python
class IndexError(OmpError, ValueError)
```

Raised when a static index document violates the expected schema.

### `omp.index.IndexTransportError`

```python
class IndexTransportError(OmpError, RuntimeError)
```

Raised when a live request has no configured fetcher or cannot be routed through the Environment.

### `omp.index.IndexVerificationError`

```python
class IndexVerificationError(IndexError)
```

Raised when the caller-provided signature verifier rejects a catalog or closure.

## Catalog values

### `omp.index.IdentityClaim`

```python
@dataclass(frozen=True, slots=True)
class IdentityClaim:
    publisher: str
    extension_id: str
    fingerprint: str
```

A stable publisher-qualified identity.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `publisher` | `str` | required | Publisher identifier or key. |
| `extension_id` | `str` | required | Stable extension identifier. |
| `fingerprint` | `str` | required | Publisher fingerprint. |

### `omp.index.CapabilityAttestation`

```python
@dataclass(frozen=True, slots=True)
class CapabilityAttestation:
    capability_digest: str | None
    outcome: str
    build_provenance: str | None
    signature: str | None
```

An advisory review attached to a catalog entry.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `capability_digest` | `str | None` | required | Reviewed capability-set digest, when supplied. |
| `outcome` | `str` | required | Attestation result or status. |
| `build_provenance` | `str | None` | required | Optional build provenance. |
| `signature` | `str | None` | required | Optional attestation signature. |

### `omp.index.CatalogEntry`

```python
@dataclass(frozen=True, slots=True)
class CatalogEntry:
    identity: IdentityClaim
    distribution: str
    versions: tuple[str, ...]
    summary: str
    capabilities: tuple[str, ...]
    attestation: CapabilityAttestation | None
    deprecated: str | None
    revocation: str | None
    downloads: int | None
```

One discoverable extension record.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `identity` | `IdentityClaim` | required | Publisher-qualified identity. |
| `distribution` | `str` | required | Python distribution name. |
| `versions` | `tuple[str, ...]` | required | Published version strings. |
| `summary` | `str` | required | Short catalog description. |
| `capabilities` | `tuple[str, ...]` | required | Declared capability names. |
| `attestation` | `CapabilityAttestation | None` | required | Advisory review, if present. |
| `deprecated` | `str | None` | required | Deprecation notice. |
| `revocation` | `str | None` | required | Revocation pointer or notice. |
| `downloads` | `int | None` | required | Non-negative download count, if published. |

### `omp.index.Catalog`

```python
@dataclass(frozen=True, slots=True)
class Catalog:
    entries: tuple[CatalogEntry, ...]

    def get(self, extension_id: str) -> CatalogEntry | None
```

A cacheable catalog with lookup by stable extension identifier.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `entries` | `tuple[CatalogEntry, ...]` | required | Catalog records in document order. |

**Parameters**

: `extension_id` (`str`): Identity to find with `get()`.

**Returns**

: `CatalogEntry | None`: First matching entry or `None`.

## Simple-index values

### `omp.index.SimpleFile`

```python
@dataclass(frozen=True, slots=True)
class SimpleFile:
    filename: str
    url: str
    hashes: tuple[tuple[str, str], ...]
    requires_python: str | None
    yanked: str | bool
```

One artifact link from a PEP 691 project response.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `filename` | `str` | required | Distribution filename. |
| `url` | `str` | required | Artifact URL from the index. |
| `hashes` | `tuple[tuple[str, str], ...]` | required | Algorithm/digest pairs sorted by algorithm. |
| `requires_python` | `str | None` | required | Python version constraint. |
| `yanked` | `str | bool` | required | `False`, `True`, or a yank reason. |

### `omp.index.SimpleProject`

```python
@dataclass(frozen=True, slots=True)
class SimpleProject:
    name: str
    files: tuple[SimpleFile, ...]
```

A static PEP 691 project response suitable for PEP 503-compatible clients.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `name` | `str` | required | Project name. |
| `files` | `tuple[SimpleFile, ...]` | required | Available artifact links. |

## Resolved closures

### `omp.index.ResolvedClosure`

```python
@dataclass(frozen=True, slots=True)
class ResolvedClosure:
    extension_id: str
    version: str
    target: str
    lock: str
    signature: str | None
```

A platform-specific lock fragment carried as uninterpreted TOML text.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `extension_id` | `str` | required | Extension being locked. |
| `version` | `str` | required | Requested version. |
| `target` | `str` | required | Platform target. |
| `lock` | `str` | required | Non-empty lock document. |
| `signature` | `str | None` | required | Optional signature supplied or extracted by the client. |

## Pure parsers

### `omp.index.parse_catalog`

```python
def parse_catalog(payload: bytes | str | Mapping[str, Any]) -> Catalog
```

Decode a catalog JSON object without fetching or verifying it. The parser accepts the canonical field names and the compatibility aliases present in the source schema.

**Parameters**

: `payload` (`bytes | str | Mapping[str, Any]`): JSON bytes/text or an already-decoded mapping.

**Returns**

: `Catalog`: Frozen catalog values.

**Raises**

: `IndexError`: JSON or a required field has the wrong shape; download counts must be non-negative integers.

```python
catalog = parse_catalog({
    "entries": [{
        "identity": {"publisher": "acme", "id": "fmt", "fingerprint": "sha256:..."},
        "distribution": "acme-fmt",
        "versions": ["1.2.0"],
        "capabilities": ["env.doc.read"],
    }]
})
```

### `omp.index.parse_simple_project`

```python
def parse_simple_project(
    payload: bytes | str | Mapping[str, Any],
) -> SimpleProject
```

Decode a PEP 691 JSON project response. API version `1.0` and an omitted API version are accepted.

**Returns**

: `SimpleProject`: Project name and immutable file records.

**Raises**

: `IndexError`: The version, files, hashes, filename, URL, or yank marker is malformed.

### `omp.index.parse_closure`

```python
def parse_closure(
    payload: bytes | str | Mapping[str, Any],
    *,
    extension_id: str,
    version: str,
    target: str,
    signature: str | None = None,
) -> ResolvedClosure
```

Wrap a non-empty UTF-8 lock fragment. Mapping input is read from its `lock` field. This function does not interpret dependencies and does not verify signatures.

**Parameters**

: `payload` (`bytes | str | Mapping[str, Any]`): Lock text or mapping containing it.
: `extension_id` (`str`): Extension identity to associate.
: `version` (`str`): Version to associate.
: `target` (`str`): Platform target to associate.
: `signature` (`str | None`): Already-obtained signature.

**Returns**

: `ResolvedClosure`: Wrapped lock fragment.

**Raises**

: `IndexError`: Bytes are not UTF-8 or lock text is empty.

## Client

### `omp.index.IndexClient`

```python
class IndexClient:
    def __init__(
        self,
        base_url: str,
        fetcher: _Fetcher | None = None,
        verifier: _Verifier | None = None,
    ) -> None
```

An explicit asynchronous reader for a static index. The fetcher receives an absolute URL and an Accept value. The optional verifier receives the signed bytes/text (or canonical compact JSON for mappings) plus a signature.

**Parameters**

: `base_url` (`str`): Non-empty index root; the client normalizes one trailing slash.
: `fetcher` (`Callable | None`): Async transport. Omit only when constructing through `live()`.
: `verifier` (`Callable | None`): Caller-owned signature decision.

**Raises**

: `TypeError`: `base_url` is empty or not a string.

#### `IndexClient.live`

```python
@classmethod
def live(
    cls,
    base_url: str,
    verifier: _Verifier | None = None,
) -> "IndexClient"
```

Construct a client whose fetcher routes future requests through the active `omp.env` bridge.

#### `IndexClient.catalog`

```python
async def catalog(self) -> Catalog
```

Fetch `catalog/v1/index.json`, verify it when a verifier is configured, then parse it.

**Raises**

: `IndexTransportError`: Fetching cannot be routed.
: `IndexVerificationError`: The signature is missing or rejected when verification is configured.
: `IndexError`: The document is malformed.

#### `IndexClient.simple`

```python
async def simple(self, distribution: str) -> SimpleProject
```

Fetch `simple/<percent-encoded-distribution>/` as PEP 691 JSON and parse it.

**Parameters**

: `distribution` (`str`): Distribution name; every URL-sensitive character is percent-encoded.

**Returns**

: `SimpleProject`: Parsed project response.

#### `IndexClient.closure`

```python
async def closure(
    self, extension_id: str, version: str, target: str
) -> ResolvedClosure
```

Fetch the target-specific `.omp.lock`, extract a top-level TOML or mapping signature when present, apply the optional verifier, and wrap the lock text.

#### `IndexClient.closure_or_resolve`

```python
async def closure_or_resolve(
    self,
    extension_id: str,
    version: str,
    target: str,
    fallback: _Fallback,
) -> ResolvedClosure
```

Return the indexed closure, or call `fallback(extension_id, version, target)` only when `closure()` raises `IndexTransportError`. Malformed or rejected index content is not downgraded to local resolution.

```python
closure = await client.closure_or_resolve(
    "acme.formatter", "1.2.0", "aarch64-apple-darwin", resolve_locally
)
```
