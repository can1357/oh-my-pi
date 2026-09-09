# `omp.artifacts`

Use `omp.artifacts` when bytes must outlive one tool response or be handed to another consumer by an `artifact://` address. Artifact metadata is journal-aware; the payload itself moves through the Environment blob store. See [the Environment API](omp.env.md) for raw blobs and [typed URLs](omp.urls.md) for selector-aware reads.

```python
from omp import artifacts

ref = await artifacts.put(
    "build completed\n",
    media_type="text/plain",
    description="Build log",
)
print(artifacts.url(ref))
```

## Errors

### `omp.artifacts.ArtifactError`

```python
class ArtifactError(OmpError)
```

Base exception for artifact storage and retention operations.

### `omp.artifacts.ArtifactNotFound`

```python
class ArtifactNotFound(ArtifactError)
```

Raised when an artifact or adopted blob is absent or is not visible to the current scope.

### `omp.artifacts.ArtifactCorrupt`

```python
class ArtifactCorrupt(ArtifactError)
```

Raised when metadata, content length, content identity, UTF-8 text, or a host response disagrees with the durable artifact reference.

### `omp.artifacts.ArtifactNotText`

```python
class ArtifactNotText(ArtifactError)
```

Raised when `read()` is used for a media type that is not textual.

## Streaming interfaces

### `omp.artifacts.ArtifactReader`

```python
class ArtifactReader(Protocol):
    async def read(self, n: int = -1) -> bytes
    async def seek(self, offset: int) -> int
    def __aiter__(self) -> AsyncIterator[bytes]
```

An asynchronous, absolute-seek byte reader. Iteration yields bounded chunks and advances the same cursor used by `read()`.

**Methods**

: `read(n=-1)`: Read at most `n` bytes; a negative value reads all remaining bytes.
: `seek(offset)`: Move to an absolute offset from zero through the stored byte length.
: `__aiter__()`: Stream remaining bytes.

**Raises**

: `TypeError`: A size or offset is not an integer.
: `ValueError`: An offset is outside the stored range.
: `ArtifactCorrupt`: The stream length or chunk type violates metadata.

### `omp.artifacts.ArtifactWriter`

```python
class ArtifactWriter(Protocol):
    @property
    def ref(self) -> ArtifactRef
    async def write(self, chunk: bytes | str) -> None
    async def __aenter__(self) -> ArtifactWriter
    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        traceback: object | None,
    ) -> bool | None
```

An atomic streaming writer. Enter it before writing; successful exit commits and adopts the blob, while exceptional exit discards staged content. `ref` is available only after a successful close.

```python
writer = await open_write(media_type="application/json")
async with writer:
    await writer.write('{"ok":')
    await writer.write(b"true}")
ref = writer.ref
```

**Raises**

: `RuntimeError`: The writer is not open, is entered twice, or `ref` is read before commit.
: `TypeError`: A chunk is neither `bytes` nor `str`.

## Metadata

### `omp.artifacts.ArtifactStat`

```python
@dataclass(frozen=True, slots=True)
class ArtifactStat:
    ref: ArtifactRef
    url: ArtifactUrl
    media_type: str
    byte_len: int
    description: str | None
    lifetime: ArtifactLifetime
    created_ms: int
    source: str
    reachable_from: Sequence[EntryId]
    lines: int | None
```

An immutable metadata snapshot.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `ref` | `ArtifactRef` | required | Durable reference and content identity. |
| `url` | `ArtifactUrl` | required | Typed address for consumers. |
| `media_type` | `str` | required | Declared media type. |
| `byte_len` | `int` | required | Stored byte count. |
| `description` | `str | None` | required | Optional human description. |
| `lifetime` | `ArtifactLifetime` | required | Current minimum retention promise. |
| `created_ms` | `int` | required | Host timestamp in milliseconds. |
| `source` | `str` | required | Host-reported origin. |
| `reachable_from` | `Sequence[EntryId]` | required | Journal entries retaining the artifact. |
| `lines` | `int | None` | required | Text line count when known. |

`ArtifactRef` and `ArtifactLifetime` are documented with [verdict values](verdicts.md).

## Creating artifacts

### `omp.artifacts.put`

```python
async def put(
    data: bytes | str | EnvPath,
    *,
    media_type: str,
    description: str | None = None,
    lifetime: ArtifactLifetime = ArtifactLifetime.SESSION,
) -> ArtifactRef
```

Store a complete byte string, UTF-8 text, or Environment path, then adopt its content-addressed blob into the artifact namespace.

**Parameters**

: `data` (`bytes | str | EnvPath`): Payload or workspace path. Strings are UTF-8 encoded.
: `media_type` (`str`): Required media type.
: `description` (`str | None`): Optional explanation shown with metadata.
: `lifetime` (`ArtifactLifetime`): Minimum retention, defaulting to the session.

**Returns**

: `ArtifactRef`: Session-addressable reference.

**Raises**

: `TypeError`: `data` has another type.
: `ArtifactError`: Blob upload or adoption fails.

### `omp.artifacts.open_write`

```python
async def open_write(
    *,
    media_type: str,
    description: str | None = None,
    lifetime: ArtifactLifetime = ArtifactLifetime.SESSION,
) -> ArtifactWriter
```

Create an atomic streaming writer over the DATA plane. Await the factory, then use the returned writer as an async context manager.

**Parameters**

: `media_type` (`str`): Non-empty media type.
: `description` (`str | None`): Optional description.
: `lifetime` (`ArtifactLifetime`): Minimum retention.

**Returns**

: `ArtifactWriter`: Unopened writer transaction.

**Raises**

: `ValueError`: `media_type` is empty.
: `TypeError`: `description` or `lifetime` has the wrong type.

### `omp.artifacts.adopt`

```python
async def adopt(
    blob: BlobRef,
    *,
    media_type: str | None = None,
    description: str | None = None,
    lifetime: ArtifactLifetime = ArtifactLifetime.SESSION,
) -> ArtifactRef
```

Promote an existing Environment blob into the artifact namespace without uploading its bytes again.

**Parameters**

: `blob` (`BlobRef`): Content identity in the active Environment blob store.
: `media_type` (`str | None`): Optional non-empty media type.
: `description` (`str | None`): Optional description.
: `lifetime` (`ArtifactLifetime`): Minimum retention.

**Returns**

: `ArtifactRef`: Minted artifact reference.

**Raises**

: `TypeError`: Arguments have invalid types.
: `ValueError`: `media_type` is empty.
: `ArtifactNotFound`: The blob cannot be adopted in this scope.
: `ArtifactCorrupt`: The returned reference is malformed.

## Reading artifacts

### `omp.artifacts.get`

```python
async def get(ref: ArtifactRef) -> bytes
```

Fetch the complete artifact after checking current metadata, then verify its stored length.

**Parameters**

: `ref` (`ArtifactRef`): Artifact to fetch.

**Returns**

: `bytes`: Complete payload.

**Raises**

: `ArtifactNotFound`: The reference is not visible.
: `ArtifactCorrupt`: Reference or payload length is inconsistent.

### `omp.artifacts.open`

```python
async def open(ref: ArtifactRef) -> ArtifactReader
```

Open a streaming reader after validating metadata. This function does not shadow Python's built-in outside the module namespace.

**Returns**

: `ArtifactReader`: Reader positioned at byte zero.

### `omp.artifacts.read`

```python
async def read(ref: ArtifactRef, selector: str | None = None) -> str
```

Read a UTF-8 text artifact, optionally applying the shared selector grammar. Non-raw line selections prefix each returned line with `N|`; `raw` preserves source text. `conflicts` returns complete unresolved conflict blocks.

**Parameters**

: `ref` (`ArtifactRef`): Text artifact.
: `selector` (`str | None`): Selector fragment such as `10-20`, `raw:10-20`, or `conflicts`.

**Returns**

: `str`: Selected text.

**Raises**

: `ArtifactNotText`: The media type is not `text/*`, JSON, XML, YAML, or a corresponding structured suffix.
: `ArtifactCorrupt`: Content is invalid UTF-8 or violates metadata.
: `SelectorError`: The selector is invalid.

```python
excerpt = await read(ref, "50+25:raw")
```

## Metadata and retention

### `omp.artifacts.stat`

```python
async def stat(ref: ArtifactRef) -> ArtifactStat
```

Read metadata without fetching payload bytes.

**Returns**

: `ArtifactStat`: Current immutable metadata.

**Raises**

: `ArtifactNotFound`: The reference is absent or invisible.
: `ArtifactCorrupt`: The host response is malformed.

### `omp.artifacts.list`

```python
async def list(
    *, session: str | None = None, mine: bool = True, limit: int = 200
) -> Sequence[ArtifactStat]
```

List artifacts reachable from a session journal.

**Parameters**

: `session` (`str | None`): Session to inspect, or the current session when omitted.
: `mine` (`bool`): Restrict the query to artifacts attributed to the caller.
: `limit` (`int`): Maximum rows requested from the host.

**Returns**

: `Sequence[ArtifactStat]`: Immutable tuple of decoded rows.

**Raises**

: `ArtifactCorrupt`: The host returns a non-sequence or malformed row.

### `omp.artifacts.pin`

```python
async def pin(ref: ArtifactRef, lifetime: ArtifactLifetime) -> None
```

Raise an artifact's minimum retention promise. Pinning does not return payload bytes.

**Parameters**

: `ref` (`ArtifactRef`): Artifact to retain.
: `lifetime` (`ArtifactLifetime`): New minimum lifetime.

**Raises**

: `TypeError`: `lifetime` is not an `ArtifactLifetime`.
: `ArtifactNotFound`: The artifact is not visible.

### `omp.artifacts.url`

```python
def url(ref: ArtifactRef) -> ArtifactUrl
```

Return the typed `artifact://` address already carried by a reference. This is pure and performs no host request.

**Parameters**

: `ref` (`ArtifactRef`): Artifact reference.

**Returns**

: `ArtifactUrl`: Typed address.

**Raises**

: `TypeError`: `ref` is not an `ArtifactRef`.
