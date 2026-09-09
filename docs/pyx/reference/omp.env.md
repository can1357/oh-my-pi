# `omp.env`

`omp.env` is the capability-gated DATA-plane API for the active project Environment. Reach for it for documents, raw filesystem metadata, commands, supervised processes, scoped HTTP, blobs, language servers, document watches, and workspace search. All I/O stays explicit; importing the module performs none.

```python
from omp import EnvPath, env

env.require(env.Capability.DOC_READ)
async with await env.docs.open(EnvPath("pyproject.toml")) as doc:
    project = await doc.read()
```

See [Work with the project Environment](../guides/environment.md) for task recipes, [artifacts](omp.artifacts.md) for durable model-facing output, and [typed URLs](omp.urls.md) for host-resolved addresses.

## Connection and authorization

### `omp.env.Capability`

```python
class Capability(StrEnum)
```

A manifest-facing capability enforced on the scoped connection.

| Member | Wire value | Governs |
|---|---|---|
| `DOC_READ` | `env.doc.read` | Document reads, summaries, and events. |
| `DOC_WRITE` | `env.doc.write` | Document mutations and transactions. |
| `FS_READ` | `env.fs.read` | Filesystem metadata and namespace reads. |
| `FS_WRITE` | `env.fs.write` | Filesystem namespace mutations. |
| `EXEC` | `env.exec` | Guarded command sessions and runs. |
| `PROCESS` | `env.process` | Named processes. |
| `BLOB` | `env.blob` | Content-addressed blobs. |
| `SEARCH` | `env.search` | Workspace walk and content search. |
| `LSP` | `env.lsp` | Language-server bindings, requests, and events. |
| `NET` | `env.net` | Scoped HTTP egress. |
| `WORKSPACE_SNAPSHOT` | `env.workspace.snapshot` | Workspace snapshot authority. |
| `WORKTREE` | `env.worktree` | Worktree topology. |

### `omp.env.EnvInfo`

```python
@dataclass(frozen=True, slots=True)
class EnvInfo:
    workspace_id: bytes
    root: EnvPath
    server_epoch: bytes
    server_version: str
    server_build: str
    schema_rev: int
    capabilities: frozenset[Capability]
    remote: bool
```

The immutable handshake receipt cached in the current context.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `workspace_id` | `bytes` | required | Workspace identity. |
| `root` | `EnvPath` | required | Environment root path. |
| `server_epoch` | `bytes` | required | Server epoch identity. |
| `server_version` | `str` | required | Server version. |
| `server_build` | `str` | required | Server build identity. |
| `schema_rev` | `int` | required | Negotiated schema revision. |
| `capabilities` | `frozenset[Capability]` | required | Granted capabilities. |
| `remote` | `bool` | required | Whether the Environment is remote. |

### `omp.env.info`

```python
def info() -> EnvInfo
```

Return the cached handshake receipt without I/O.

**Returns**

: `EnvInfo`: Current invocation's Environment information.

**Raises**

: `EnvUnavailable`: No DATA client is installed at this placement.

### `omp.env.has`

```python
def has(*caps: Capability) -> bool
```

Return whether every requested capability is present. It returns `False` when no Environment is bound.

**Parameters**

: `*caps` (`Capability`): Capabilities to test.

**Returns**

: `bool`: `True` only when a binding exists and every capability is granted.

### `omp.env.require`

```python
def require(*caps: Capability) -> None
```

Require every capability, checking arguments in order.

**Parameters**

: `*caps` (`Capability`): Capabilities that must be granted.

**Raises**

: `Denied`: The first requested capability not granted.

### `omp.env.WorktreeInfo`

```python
@dataclass(frozen=True, slots=True)
class WorktreeInfo:
    id: str
    root: EnvPath
    base: str
    generation: int
```

A snapshot of the isolated worktree containing this workspace.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `id` | `str` | required | Worktree identity. |
| `root` | `EnvPath` | required | Worktree root. |
| `base` | `str` | required | Base revision or branch identity. |
| `generation` | `int` | required | Stale-topology fence. |

### `omp.env.worktree`

```python
async def worktree() -> WorktreeInfo | None
```

Return current worktree topology, or `None` for a workspace without an isolated worktree.

**Returns**

: `WorktreeInfo | None`: Isolated worktree topology, when applicable.

**Raises**

: `TypeError`: The backend returns an invalid topology.
: `EnvError`: The host rejects or cannot perform the request.

## Environment errors

### `omp.env.EnvError`

```python
class EnvError(OmpError):
    def __init__(
        self,
        message: str,
        *,
        fault: Fault | None = None,
        capability: Capability | None = None,
    ) -> None
```

Base exception for Environment operations that return typed faults. Instances expose `message`, `fault`, and optional `capability`.

### `omp.env.Denied`

```python
class Denied(EnvError)
```

The scoped connection or sandbox denied an operation.

### `omp.env.QuotaExceeded`

```python
class QuotaExceeded(EnvError):
    def __init__(
        self, message: str, *, quota: str, limit: int, fault: Fault | None = None
    ) -> None
```

A hard DATA-plane quota was exhausted. Inspect `quota` and `limit` to report the bounded resource.

### `omp.env.NotFound`

```python
class NotFound(EnvError)
```

The requested Environment resource does not exist.

### `omp.env.AlreadyExists`

```python
class AlreadyExists(EnvError)
```

A destination exists and the selected overwrite policy forbids replacement.

### `omp.env.Conflict`

```python
class Conflict(EnvError):
    def __init__(
        self,
        message: str,
        *,
        expected: Any = None,
        current: Any = None,
        ranges: Iterable[Any] = (),
        fault: Fault | None = None,
    ) -> None
```

A revisioned mutation could not be rebased. `ranges` is retained as a tuple alongside the expected and current values.

### `omp.env.EditConflictFault`

```python
@dataclass(frozen=True, slots=True)
class EditConflictFault(Fault):
    expected: Revision
    current: Revision
    ranges: tuple[tuple[int, int], ...]
```

A durable conflict fault carrying both revisions and collided byte ranges.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `expected` | `Revision` | required | Revision the edit targeted. |
| `current` | `Revision` | required | Current document revision. |
| `ranges` | `tuple[tuple[int, int], ...]` | required | Collided byte ranges. |

### `omp.env.Stale`

```python
class Stale(EnvError)
```

A retained Environment revision or generation is stale.

### `omp.env.StaleGeneration`

```python
class StaleGeneration(OmpError)
```

A host-level generation fence rejected a retained handle. Reacquire the relevant invocation, placement, or process handle.

### `omp.env.PreconditionFailed`

```python
class PreconditionFailed(EnvError)
```

A non-revision precondition failed, such as committing one `Txn` twice.

### `omp.env.Unsupported`

```python
class Unsupported(EnvError)
```

The active backend does not implement the requested operation.

### `omp.env.Invalid`

```python
class Invalid(EnvError)
```

An Environment operation argument is malformed according to the host.

### `omp.env.Cancelled`

```python
class Cancelled(EnvError)
```

The Environment cancelled an in-flight operation.

### `omp.env.TimedOut`

```python
class TimedOut(EnvError)
```

The invocation deadline elapsed while an operation was in flight.

### `omp.env.Io`

```python
class Io(EnvError):
    def __init__(
        self, message: str, *, errno: int | None = None, fault: Fault | None = None
    ) -> None
```

An unclassified filesystem I/O failure. `errno` is available when the host supplied one.

### `omp.env.Disconnected`

```python
class Disconnected(EnvError)
```

The DATA transport closed permanently.

### `omp.env.StreamLost`

```python
class StreamLost(EnvError):
    def __init__(
        self,
        message: str,
        *,
        skipped: int,
        reason: str,
        fault: Fault | None = None,
    ) -> None
```

A correlated event stream lost continuity. Inspect `skipped` and `reason`, then rebuild state rather than treating the next event as contiguous.

### `omp.env.Partial`

```python
class Partial(EnvError):
    def __init__(
        self,
        message: str,
        *,
        committed: Iterable[Any],
        failed_index: int,
        fault: Fault | None = None,
    ) -> None
```

A transaction failed after at least one edit became durable. `committed` is stored as a tuple and `failed_index` identifies the failed operation.

### `omp.env.EffectsNotAuthorized`

```python
class EffectsNotAuthorized(OmpError):
    def __init__(self, invocation: str, spec: object) -> None
```

An effectful operation was attempted before the invocation authorized effects. This error is re-exported here so callers can handle authorization-phase failures with Environment faults.

## Paths and raw filesystem

All `env.fs` paths are `omp.EnvPath` values. Passing `ClientPath` or a plain string to an Environment path parameter raises `TypeError` before the host call.

### `omp.env.FileKind`

```python
class FileKind(StrEnum)
```

Filesystem entry kind.

| Member | Wire value | Meaning |
|---|---|---|
| `REGULAR_FILE` | `regular_file` | Regular file. |
| `DIRECTORY` | `directory` | Directory. |
| `SYMLINK` | `symlink` | Symbolic link. |
| `OTHER` | `other` | Another host entry type. |

### `omp.env.PathMeta`

```python
@dataclass(frozen=True, slots=True)
class PathMeta:
    path: EnvPath
    kind: FileKind
    byte_length: int
    read_only: bool | None = None
    executable: bool | None = None
    modified: float | None = None
    accessed: float | None = None
    created: float | None = None
```

Metadata for one filesystem entry without its contents.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `path` | `EnvPath` | required | Resolved Environment location. |
| `kind` | `FileKind` | required | Entry kind. |
| `byte_length` | `int` | required | Host-reported byte length. |
| `read_only` | `bool | None` | `None` | Portable write flag when known. |
| `executable` | `bool | None` | `None` | Portable executable flag when known. |
| `modified` | `float | None` | `None` | Modification time when available. |
| `accessed` | `float | None` | `None` | Access time when available. |
| `created` | `float | None` | `None` | Creation time when available. |

### `omp.env.DirEntry`

```python
@dataclass(frozen=True, slots=True)
class DirEntry:
    name: str
    meta: PathMeta
```

One immediate directory child with unfollowed metadata.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `name` | `str` | required | Child basename. |
| `meta` | `PathMeta` | required | Child metadata. |

### `omp.env.SymlinkTarget`

```python
@dataclass(frozen=True, slots=True)
class SymlinkTarget:
    target: EnvPath
    relative: bool
```

The resolved lexical target and whether the stored link spelling was relative.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `target` | `EnvPath` | required | Absolute lexical target in the Environment namespace. |
| `relative` | `bool` | required | Whether the stored target was relative. |

### `omp.env.LinkKind`

```python
class LinkKind(StrEnum)
```

A host-facing symlink target hint.

| Member | Wire value | Meaning |
|---|---|---|
| `FILE` | `file` | File target. |
| `DIRECTORY` | `directory` | Directory target. |

### `omp.env.Overwrite`

```python
class Overwrite(StrEnum)
```

Destination replacement policy.

| Member | Wire value | Meaning |
|---|---|---|
| `FAIL` | `fail` | Reject an existing destination. |
| `REPLACE_FILE` | `replace_file` | Replace an existing file. |
| `REPLACE_EMPTY_DIR` | `replace_empty_dir` | Replace an empty directory. |

### `omp.env.CopyResult`

```python
@dataclass(frozen=True, slots=True)
class CopyResult:
    meta: PathMeta
    bytes_copied: int
```

A copy receipt containing destination metadata and copied byte count.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `meta` | `PathMeta` | required | Destination metadata. |
| `bytes_copied` | `int` | required | Number of copied bytes. |

### `omp.env.fs`

```python
fs: _Fs
```

Namespace for raw filesystem metadata and mutations.

#### `fs.stat`

```python
async def stat(path: EnvPath) -> PathMeta
```

Stat a path while following symbolic links.

#### `fs.lstat`

```python
async def lstat(path: EnvPath) -> PathMeta
```

Stat a path without following its final symbolic link.

#### `fs.list_dir`

```python
async def list_dir(path: EnvPath, *, follow: bool = False) -> list[DirEntry]
```

List immediate children. Child metadata is unfollowed unless `follow=True`.

#### `fs.read_link`

```python
async def read_link(path: EnvPath) -> SymlinkTarget
```

Read a symbolic-link target.

#### `fs.canonicalize`

```python
async def canonicalize(path: EnvPath) -> EnvPath
```

Resolve a path in the Environment namespace.

#### `fs.mkdir`

```python
async def mkdir(
    path: EnvPath, *, parents: bool = False, exist_ok: bool = False
) -> PathMeta
```

Create a directory and return its metadata.

#### `fs.remove`

```python
async def remove(
    path: EnvPath,
    *,
    recursive: bool = False,
    revision: Revision | None = None,
) -> None
```

Remove a path, optionally fenced by a document revision.

#### `fs.rename`

```python
async def rename(
    src: EnvPath,
    dest: EnvPath,
    *,
    overwrite: Overwrite = Overwrite.FAIL,
    src_revision: Revision | None = None,
    dest_revision: Revision | None = None,
) -> PathMeta
```

Rename a path inside the Environment namespace.

#### `fs.copy`

```python
async def copy(
    src: EnvPath,
    dest: EnvPath,
    *,
    follow: bool = True,
    overwrite: Overwrite = Overwrite.FAIL,
    dest_revision: Revision | None = None,
) -> CopyResult
```

Copy one non-directory entry.

#### `fs.symlink`

```python
async def symlink(
    target: EnvPath,
    link: EnvPath,
    *,
    kind: LinkKind = LinkKind.FILE,
    relative: bool = False,
    overwrite: Overwrite = Overwrite.FAIL,
) -> PathMeta
```

Create a symbolic link without ambient path conversion.

#### `fs.hard_link`

```python
async def hard_link(
    src: EnvPath,
    link: EnvPath,
    *,
    follow: bool = False,
    overwrite: Overwrite = Overwrite.FAIL,
) -> PathMeta
```

Create a hard link.

#### `fs.chmod`

```python
async def chmod(
    path: EnvPath,
    *,
    read_only: bool | None = None,
    executable: bool | None = None,
    follow: bool = True,
    revision: Revision | None = None,
) -> PathMeta
```

Update portable permission properties.

Filesystem methods raise `Denied`, `NotFound`, `AlreadyExists`, `Conflict`, `Io`, `Invalid`, `Unsupported`, or another `EnvError` as reported by the host. Type checks can raise `TypeError` before dispatch.

## Revisioned documents and watches

### `omp.env.Revision`

```python
@dataclass(frozen=True, slots=True)
class Revision:
    sequence: int
    content_hash: bytes

    @property
    def hex(self) -> str
```

An immutable document revision.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `sequence` | `int` | required | Monotonic document sequence. |
| `content_hash` | `bytes` | required | Content digest. |

#### `Revision.hex`

```python
@property
def hex(self) -> str
```

Return the lowercase content hash without I/O.

### `omp.env.Edit`

```python
@dataclass(frozen=True, slots=True)
class Edit:
    start: int
    end: int
    replacement: bytes
```

A byte-range replacement in one base revision's coordinate space.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `start` | `int` | required | Inclusive starting byte offset. |
| `end` | `int` | required | Exclusive ending byte offset. |
| `replacement` | `bytes` | required | Replacement bytes. |

### `omp.env.EditResult`

```python
@dataclass(frozen=True, slots=True)
class EditResult:
    revision: Revision
    previous: Revision
    rebased: bool
    formatted: bool
    changed_ranges: tuple[tuple[int, int], ...]
    previous_path: EnvPath | None
```

The committed outcome of a document mutation.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `revision` | `Revision` | required | New committed revision. |
| `previous` | `Revision` | required | Revision replaced. |
| `rebased` | `bool` | required | Whether the edit was rebased. |
| `formatted` | `bool` | required | Whether formatting changed the result. |
| `changed_ranges` | `tuple[tuple[int, int], ...]` | required | Changed ranges in the final head. |
| `previous_path` | `EnvPath | None` | required | Prior path for a move. |

### `omp.env.EditPlan`

```python
@dataclass(frozen=True, slots=True)
class EditPlan:
    revision: Revision
    edits: tuple[Edit, ...]
    preview: str
    first_changed_line: int | None
    warnings: tuple[str, ...]
```

A resolved mutation preview that has not been committed.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `revision` | `Revision` | required | Revision used to resolve the plan. |
| `edits` | `tuple[Edit, ...]` | required | Resolved byte edits. |
| `preview` | `str` | required | Human-readable preview. |
| `first_changed_line` | `int | None` | required | First changed line when any. |
| `warnings` | `tuple[str, ...]` | required | Resolution warnings. |

### `omp.env.OnStale`

```python
class OnStale(StrEnum)
```

Policy when a mutation's base is no longer current.

| Member | Wire value | Meaning |
|---|---|---|
| `FAIL` | `fail` | Return a conflict. |
| `REBASE` | `rebase` | Attempt a rebase. |
| `REPLACE` | `replace` | Replace against the current head. |

### `omp.env.Format`

```python
class Format(StrEnum)
```

Formatting policy for document mutations.

| Member | Wire value | Meaning |
|---|---|---|
| `OFF` | `off` | Do not format. |
| `BEST_EFFORT` | `best_effort` | Keep the edit if formatting is unavailable. |
| `REQUIRED` | `required` | Require formatting to succeed. |

### `omp.env.Presence`

```python
class Presence(StrEnum)
```

Whether a revisioned path exists: `PRESENT = "present"` or `MISSING = "missing"`.

### `omp.env.Kind`

```python
class Kind(StrEnum)
```

Pinned content kind: `TEXT = "text"` or `BINARY = "binary"`.

### `omp.env.SummaryRender`

```python
class SummaryRender(StrEnum)
```

Structural-summary rendering dialect.

| Member | Wire value |
|---|---|
| `HASHLINE` | `hashline` |
| `NUMBERED` | `numbered` |
| `PLAIN` | `plain` |

### `omp.env.SummaryReason`

```python
class SummaryReason(StrEnum)
```

Machine-readable reason a summary was unavailable.

| Member | Wire value |
|---|---|
| `BINARY` | `binary` |
| `MISSING_DOCUMENT` | `missing_document` |
| `TOO_LARGE` | `too_large` |
| `TOO_MANY_LINES` | `too_many_lines` |
| `BELOW_MINIMUM_LINES` | `below_minimum_lines` |
| `PROSE_DISABLED` | `prose_disabled` |
| `UNSUPPORTED_LANGUAGE` | `unsupported_language` |
| `EMPTY` | `empty` |
| `SYNTAX_ERROR` | `syntax_error` |
| `NO_ELISIONS` | `no_elisions` |
| `PARSER_FAILURE` | `parser_failure` |

### `omp.env.SummaryOptions`

```python
@dataclass(frozen=True, slots=True)
class SummaryOptions:
    min_body_lines: int = 2
    min_comment_lines: int = 4
    unfold_until_lines: int = 0
    unfold_limit_lines: int = 0
    prose: bool = False
    min_total_lines: int = 0
    render: SummaryRender = SummaryRender.HASHLINE
    language: str | None = None
```

Caller-controlled summary thresholds and rendering.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `min_body_lines` | `int` | `2` | Smallest body eligible for folding. |
| `min_comment_lines` | `int` | `4` | Smallest comment block eligible for folding. |
| `unfold_until_lines` | `int` | `0` | Target line count used while unfolding. |
| `unfold_limit_lines` | `int` | `0` | Upper bound for unfolding. |
| `prose` | `bool` | `False` | Permit prose summarization. |
| `min_total_lines` | `int` | `0` | Minimum document size. |
| `render` | `SummaryRender` | `HASHLINE` | Output dialect. |
| `language` | `str | None` | `None` | Optional non-empty language override. |

**Raises**

: `TypeError`: A numeric threshold is not exactly `int`, or another field has the wrong type.
: `ValueError`: A threshold is negative or `language` is empty.

### `omp.env.SummarySegment`

```python
@dataclass(frozen=True, slots=True)
class SummarySegment:
    kept: bool
    start_line: int
    end_line: int
    text: str | None
```

One kept or elided one-based inclusive summary range. Kept segments require text; elided segments forbid it.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `kept` | `bool` | required | Whether this range is retained. |
| `start_line` | `int` | required | One-based inclusive start. |
| `end_line` | `int` | required | One-based inclusive end. |
| `text` | `str | None` | required | Text for a kept range, otherwise `None`. |

### `omp.env.Summary`

```python
@dataclass(frozen=True, slots=True)
class Summary:
    language: str
    parsed: bool
    elided: bool
    total_lines: int
    segments: tuple[SummarySegment, ...]
    text: str
    display_text: str
    elided_ranges: tuple[tuple[int, int], ...]
    elided_lines: int
```

A successful bounded structural summary.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `language` | `str` | required | Resolved language. |
| `parsed` | `bool` | required | Whether parsing succeeded. |
| `elided` | `bool` | required | Whether content was elided. |
| `total_lines` | `int` | required | Source line count. |
| `segments` | `tuple[SummarySegment, ...]` | required | Kept and elided ranges. |
| `text` | `str` | required | Canonical summary text. |
| `display_text` | `str` | required | Display rendering. |
| `elided_ranges` | `tuple[tuple[int, int], ...]` | required | Elided line ranges. |
| `elided_lines` | `int` | required | Number of elided lines. |

### `omp.env.SummaryUnavailable`

```python
@dataclass(frozen=True, slots=True)
class SummaryUnavailable:
    reason: SummaryReason
    total_lines: int
    language: str
    parsed: bool
```

A structured refusal instead of a fabricated summary.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `reason` | `SummaryReason` | required | Refusal reason. |
| `total_lines` | `int` | required | Source line count. |
| `language` | `str` | required | Resolved language. |
| `parsed` | `bool` | required | Whether parsing succeeded. |

### `omp.env.DocEventKind`

```python
class DocEventKind(StrEnum)
```

Document watch event kind.

| Member | Wire value |
|---|---|
| `COMMITTED` | `committed` |
| `EXTERNAL_CREATED` | `external_created` |
| `EXTERNAL_MODIFIED` | `external_modified` |
| `EXTERNAL_DELETED` | `external_deleted` |
| `EXTERNAL_RENAMED` | `external_renamed` |
| `WATCH_RESCANNED` | `watch_rescanned` |

### `omp.env.DocEvent`

```python
@dataclass(frozen=True, slots=True)
class DocEvent:
    sequence: int
    kind: DocEventKind
    revision: Revision
    previous_revision: Revision
    txn_id: bytes | None = None
    invalidated_txn_ids: tuple[bytes, ...] = ()
    previous_path: EnvPath | None = None
```

One ordered committed or externally observed document change.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `sequence` | `int` | required | Event-stream sequence. |
| `kind` | `DocEventKind` | required | Change category. |
| `revision` | `Revision` | required | New revision. |
| `previous_revision` | `Revision` | required | Prior revision. |
| `txn_id` | `bytes | None` | `None` | Originating transaction. |
| `invalidated_txn_ids` | `tuple[bytes, ...]` | `()` | Provisional transactions invalidated by the event. |
| `previous_path` | `EnvPath | None` | `None` | Prior path for a rename. |

### `omp.env.OpenedDoc`

```python
class OpenedDoc:
    def __new__(cls, /, lease: Any, revision: Any) -> OpenedDoc
```

The backend open receipt containing opaque `lease` and pinned `revision` properties. `docs.open()` converts it into `Doc`.

### `omp.env.Doc`

```python
class Doc:
    def __init__(
        self, lease: Any, path: EnvPath, revision: Revision | None = None
    ) -> None
```

A revisioned document lease. Public attributes are `path`, `revision`, and `uri`. Prefer obtaining one from `docs.open()` and closing it with `async with`.

#### `Doc.read_bytes`

```python
async def read_bytes(self, *, revision: Any = None) -> bytes
```

Read bytes at the head or an explicitly pinned revision.

#### `Doc.read`

```python
async def read(
    self, *, revision: Any = None, encoding: str = "utf-8"
) -> str
```

Read and decode the lease.

#### `Doc.lines`

```python
async def lines(
    self, start: int, end: int, *, revision: Any = None
) -> list[str]
```

Read a zero-based, half-open line range.

#### `Doc.dry_run`

```python
async def dry_run(
    self, ops: Any, *, format: Format = Format.OFF
) -> EditPlan
```

Resolve a mutation without committing it.

#### `Doc.edit`

```python
async def edit(self, edits: Iterable[Any], **options: Any) -> Any
```

Commit ordered, non-overlapping edits.

#### `Doc.write`

```python
async def write(self, data: str | bytes, **options: Any) -> Any
```

Replace the document contents revisionally.

#### `Doc.hashline`

```python
async def hashline(self, patch: str, **options: Any) -> Any
```

Apply a hashline patch through the document actor.

#### `Doc.summary`

```python
async def summary(
    self, options: SummaryOptions | None = None
) -> Summary | SummaryUnavailable
```

Return a bounded structural summary or a typed reason it could not be produced.

#### `Doc.refresh`

```python
async def refresh(self) -> Any
```

Refresh the lease's current committed revision and update `doc.revision`.

#### `Doc.close`

```python
async def close(self) -> None
```

Close the lease idempotently.

#### `Doc.events`

```python
def events(self) -> AsyncIterator[DocEvent]
```

Return an async stream of ordered document events. Iteration can raise `StreamLost` when continuity cannot be preserved.

### `omp.env.docs`

```python
docs: _Docs
```

Namespace for opening document leases and constructing transactions.

#### `docs.open`

```python
async def open(
    path: EnvPath, *, language: str | None = None, create: bool = False
) -> Doc
```

Open a document and return a server-owned lease.

**Parameters**

: `path` (`EnvPath`): Environment path.
: `language` (`str | None`): Optional language-server language id.
: `create` (`bool`): Allow creation when the path is missing.

#### `docs.transaction`

```python
def transaction(*, txn_id: bytes | None = None) -> Txn
```

Create an invocation-scoped document transaction handle.

### `omp.env.Txn`

```python
class Txn:
    def __init__(self, txn_id: bytes | None = None) -> None
```

An ordered document transaction. It is also an async context manager that commits on a clean exit unless already committed.

#### `Txn.edit`

```python
def edit(self, doc: Doc, ops: Iterable[Any], **options: Any) -> None
```

Queue a revisioned edit.

#### `Txn.create`

```python
def create(
    self, path: EnvPath, content: str | bytes, **options: Any
) -> None
```

Queue document creation.

#### `Txn.write`

```python
def write(
    self, doc: Doc, content: str | bytes, **options: Any
) -> None
```

Queue whole-document replacement.

#### `Txn.move`

```python
def move(self, doc: Doc, destination: EnvPath, **options: Any) -> None
```

Queue a document move.

#### `Txn.delete`

```python
def delete(self, doc: Doc) -> None
```

Queue document deletion.

#### `Txn.commit`

```python
async def commit(self) -> Any
```

Commit once and return the retained terminal transaction outcome.

**Raises**

: `PreconditionFailed`: The handle has already committed.
: `Partial`: A non-atomic backend failure occurs after durable edits.
: `EnvError`: The host rejects the transaction.

### `omp.env.TxnOutcome`

```python
class TxnOutcome:
    def __new__(
        cls, /, txn_id: Any, committed: Any, operation_count: Any
    ) -> TxnOutcome
```

A terminal transaction outcome with `txn_id`, `committed`, and `operation_count` properties.

### `omp.env.TxnReceipt`

```python
class TxnReceipt:
    def __new__(
        cls, /, txn_id: Any, revision: Any, rebased: Any, formatted: Any
    ) -> TxnReceipt
```

A per-operation receipt with `txn_id`, `revision`, `rebased`, and `formatted` properties.

## Language servers

### `omp.env.SyncKind`

```python
class SyncKind(StrEnum)
```

Negotiated text-document synchronization mode: `NONE = "none"`, `FULL = "full"`, or `INCREMENTAL = "incremental"`.

### `omp.env.SyncPolicy`

```python
@dataclass(frozen=True, slots=True)
class SyncPolicy:
    change: SyncKind
    open_close: bool
    will_save: bool
    will_save_wait_until: bool
    save: bool
    save_include_text: bool
    position_encoding: str
```

Resolved synchronization behavior for a document/server binding.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `change` | `SyncKind` | required | Change synchronization mode. |
| `open_close` | `bool` | required | Whether open/close notifications are used. |
| `will_save` | `bool` | required | Whether pre-save notification is used. |
| `will_save_wait_until` | `bool` | required | Whether pre-save edits are requested. |
| `save` | `bool` | required | Whether save notification is used. |
| `save_include_text` | `bool` | required | Whether save includes text. |
| `position_encoding` | `str` | required | Negotiated position encoding. |

### `omp.env.LspBinding`

```python
@dataclass(frozen=True, slots=True)
class LspBinding:
    server_id: bytes
    name: str
    sync: SyncPolicy
    capabilities: dict[str, Any]
```

One language server bound to a document. `capabilities` is copied into an ordinary dict.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `server_id` | `bytes` | required | Opaque server identity. |
| `name` | `str` | required | Server name. |
| `sync` | `SyncPolicy` | required | Negotiated synchronization policy. |
| `capabilities` | `dict[str, Any]` | required | Server capabilities. |

### `omp.env.LspStale`

```python
class LspStale(StrEnum)
```

Stale-revision request policy: `FAIL = "fail"` or `RETRY_HEAD = "retry_head"`.

### `omp.env.LspBindingEventKind`

```python
class LspBindingEventKind(StrEnum)
```

Binding transition kind.

| Member | Wire value |
|---|---|
| `READY` | `ready` |
| `POLICY_CHANGED` | `policy_changed` |
| `RESTARTED` | `restarted` |
| `STOPPED` | `stopped` |

### `omp.env.LspEvent`

```python
@dataclass(frozen=True, slots=True)
class LspEvent:
    server_id: bytes
    method: str
    params: Any
    path: str | None
    revision: Revision | None
```

A server notification and its authoritative revision when known.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `server_id` | `bytes` | required | Source server. |
| `method` | `str` | required | Notification method. |
| `params` | `Any` | required | JSON-RPC parameters. |
| `path` | `str | None` | required | Associated path, when known. |
| `revision` | `Revision | None` | required | Authoritative revision, when known. |

### `omp.env.LspBindingEvent`

```python
@dataclass(frozen=True, slots=True)
class LspBindingEvent:
    kind: LspBindingEventKind
    binding: LspBinding
    path: str | None
```

A connection-wide language-server binding transition.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `kind` | `LspBindingEventKind` | required | Transition category. |
| `binding` | `LspBinding` | required | Affected binding. |
| `path` | `str | None` | required | Associated path, when known. |

### `omp.env.LspFailure`

```python
class LspFailure(EnvError):
    def __init__(
        self,
        code: int,
        message: str,
        data: Any = None,
        *,
        fault: Fault | None = None,
    ) -> None
```

A JSON-RPC error from the selected server. Inspect `code` and `data`.

### `omp.env.lsp`

```python
lsp: _Lsp
```

Namespace for revision-aware language-server multiplexing.

#### `lsp.last_revision`

```python
@property
def last_revision() -> Revision | None
```

Return the authoritative revision used by the latest request in this context.

#### `lsp.bindings`

```python
async def bindings(path: EnvPath) -> list[LspBinding]
```

Return servers currently bound to a path.

#### `lsp.request`

```python
async def request(
    server: bytes,
    method: str,
    params: Any,
    *,
    doc: Doc | None = None,
    on_stale: LspStale = LspStale.RETRY_HEAD,
    timeout: Duration | None = None,
) -> Any
```

Issue a revision-aware request and retain the revision actually used in `last_revision`.

**Raises**

: `TypeError` or `ValueError`: Local argument validation fails.
: `LspFailure`: The server returns a JSON-RPC error.
: `EnvError`: Dispatch fails.

#### `lsp.notify`

```python
async def notify(server: bytes, method: str, params: Any) -> None
```

Issue a language-server notification.

#### `lsp.events`

```python
def events() -> AsyncIterator[LspEvent | LspBindingEvent]
```

Return a typed stream of registry and server events.

## Commands

### `omp.env.Pty`

```python
@dataclass(frozen=True, slots=True)
class Pty:
    rows: int = 24
    columns: int = 80
    terminal: str = "xterm-256color"
```

PTY dimensions and terminal emulation for a command.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `rows` | `int` | `24` | Terminal rows. |
| `columns` | `int` | `80` | Terminal columns. |
| `terminal` | `str` | `"xterm-256color"` | Terminal emulation name. |

### `omp.env.Channel`

```python
class Channel(StrEnum)
```

Command output channel: `STDOUT = "stdout"`, `STDERR = "stderr"`, or `PTY = "pty"`.

### `omp.env.Output`

```python
@dataclass(frozen=True, slots=True)
class Output:
    channel: Channel
    data: bytes
    sequence: int
```

One ordered output frame.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `channel` | `Channel` | required | Output channel. |
| `data` | `bytes` | required | Frame payload. |
| `sequence` | `int` | required | Stream sequence. |

### `omp.env.Exit`

```python
@dataclass(frozen=True, slots=True)
class Exit:
    status: Completed
```

The terminal event in a `Run` stream.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `status` | `Completed` | required | Terminal command receipt. |

### `omp.env.Outcome`

```python
class Outcome(StrEnum)
```

Terminal command outcome.

| Member | Wire value |
|---|---|
| `EXITED` | `exited` |
| `FAILED` | `failed` |
| `TIMEOUT` | `timeout` |
| `CANCELLED` | `cancelled` |
| `DENIED` | `denied` |

### `omp.env.Completed`

```python
@dataclass(frozen=True, slots=True)
class Completed:
    outcome: Outcome
    exit_code: int | None
    signal: str
    wall: Duration
    output: bytes
    artifact: BlobRef | None
    aborted: bool

    def text(self, channel: Channel | None = None) -> str
```

A bounded terminal command receipt.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `outcome` | `Outcome` | required | Terminal category. |
| `exit_code` | `int | None` | required | Exit code when available. |
| `signal` | `str` | required | Terminal signal name. |
| `wall` | `Duration` | required | Wall-clock duration. |
| `output` | `bytes` | required | Bounded collected output. |
| `artifact` | `BlobRef | None` | required | Spill blob when present. |
| `aborted` | `bool` | required | Whether collection aborted. |

#### `Completed.text`

```python
def text(self, channel: Channel | None = None) -> str
```

Decode collected output as UTF-8 with replacement. The current implementation accepts `channel` but does not filter on it.

### `omp.env.StartedRun`

```python
class StartedRun:
    def __new__(cls, /, id: Any) -> StartedRun
```

A backend run-start receipt with an opaque `id` property.

### `omp.env.OpenedSession`

```python
class OpenedSession:
    def __new__(cls, /, id: Any, cwd: Any) -> OpenedSession
```

A backend session-open receipt with `id` and resolved `cwd` properties.

### `omp.env.Run`

```python
class Run:
    def __init__(self, run_id: bytes) -> None
```

A guarded command handle and async iterator of `Output | Exit`.

#### `Run.wait`

```python
async def wait(self) -> Completed
```

Drain output and return the terminal receipt.

#### `Run.stdin`

```python
async def stdin(self, data: bytes) -> None
```

Write bytes to stdin or the PTY master.

#### `Run.eof`

```python
async def eof(self) -> None
```

Close command stdin.

#### `Run.signal`

```python
async def signal(self, signal: str) -> None
```

Signal the Environment-owned process group.

#### `Run.resize`

```python
async def resize(self, rows: int, columns: int) -> None
```

Resize the command PTY.

#### `Run.cancel`

```python
def cancel(self) -> None
```

Request non-blocking structural teardown.

#### `Run.detach`

```python
async def detach(self, name: str) -> None
```

Relinquish the guard to an Environment-owned named job.

### `omp.env.Session`

```python
class Session:
    def __init__(self, session_id: bytes, cwd: EnvPath) -> None
```

A persistent server-owned shell session with public `id` and `cwd`. It is an async context manager.

#### `Session.run`

```python
async def run(self, script: str, **options: Any) -> Run
```

Start one serialized command in the session.

#### `Session.close`

```python
async def close(self) -> None
```

Close the session idempotently.

### `omp.env.sh`

```python
sh: _Sh
```

Namespace for guarded command execution.

#### `sh.session`

```python
def session(**options: Any) -> Session
```

Synchronously create a server-owned session handle. When supplied, `cwd` must be an `EnvPath`.

#### `sh.run`

```python
async def run(script: str, **options: Any) -> Completed
```

Run a non-empty command in a temporary session and collect its bounded completion receipt. The temporary session is closed in all cases.

```python
result = await sh.run("git status --short", cwd=EnvPath("."))
print(result.text())
```

#### `sh.parse`

```python
def parse(script: str) -> Any
```

Parse a script through the bound backend without executing it.

## Named processes

### `omp.env.RestartPolicy`

```python
@dataclass(frozen=True, slots=True)
class RestartPolicy:
    policy: Restart
    delay: Duration = Duration("500ms")
    max_restarts: int | None = None
```

Automatic restart policy for a named process.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `policy` | `Restart` | required | Restart mode. |
| `delay` | `Duration` | `Duration("500ms")` | Delay before restart. |
| `max_restarts` | `int | None` | `None` | Optional restart limit. |

### `omp.env.ReadyLog`

```python
@dataclass(frozen=True, slots=True)
class ReadyLog:
    pattern: str
    timeout: Duration = Duration("30s")
```

A readiness probe matching a regular expression against combined output.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `pattern` | `str` | required | Regular expression. |
| `timeout` | `Duration` | `Duration("30s")` | Probe deadline. |

### `omp.env.ReadyTcp`

```python
@dataclass(frozen=True, slots=True)
class ReadyTcp:
    port: int
    host: str = "127.0.0.1"
    timeout: Duration = Duration("30s")
```

A readiness probe that connects to a TCP endpoint.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `port` | `int` | required | TCP port. |
| `host` | `str` | `"127.0.0.1"` | TCP host. |
| `timeout` | `Duration` | `Duration("30s")` | Probe deadline. |

### `omp.env.ReadyPing`

```python
@dataclass(frozen=True, slots=True)
class ReadyPing:
    nonce: int = 1
    timeout: Duration = Duration("30s")
```

A readiness probe requiring a matching toolhost Pong frame.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `nonce` | `int` | `1` | Expected Pong nonce. |
| `timeout` | `Duration` | `Duration("30s")` | Probe deadline. |

### `omp.env.ReadyAll`

```python
@dataclass(frozen=True, slots=True, init=False)
class ReadyAll:
    probes: tuple[ReadyLog | ReadyTcp | ReadyPing, ...]

    def __init__(self, *probes: ReadyLog | ReadyTcp | ReadyPing) -> None
```

A group that becomes ready only when every supplied probe passes.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `probes` | `tuple[ReadyLog | ReadyTcp | ReadyPing, ...]` | positional variadic | Probes that must all pass. |

### `omp.env.Ready`

```python
Ready = ReadyLog | ReadyTcp | ReadyPing | ReadyAll
```

The accepted named-process readiness probe union.

### `omp.env.ProcState`

```python
class ProcState(StrEnum)
```

Observable named-process state.

| Member | Wire value |
|---|---|
| `STARTING` | `starting` |
| `READY` | `ready` |
| `RUNNING` | `running` |
| `EXITED` | `exited` |
| `STOPPED` | `stopped` |
| `FAILED` | `failed` |

### `omp.env.Lifecycle`

```python
class Lifecycle(StrEnum)
```

Wait target for named processes: `READY = "ready"` or `EXIT = "exit"`.

### `omp.env.ProcessInfo`

```python
@dataclass(frozen=True, slots=True)
class ProcessInfo:
    name: str
    generation: int
    state: ProcState
    status: Completed | None = None
```

An immutable snapshot of one named-process generation.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `name` | `str` | required | Process name. |
| `generation` | `int` | required | Generation fence. |
| `state` | `ProcState` | required | Current lifecycle state. |
| `status` | `Completed | None` | `None` | Terminal receipt when available. |

### `omp.env.ProcessOutput`

```python
@dataclass(frozen=True, slots=True)
class ProcessOutput:
    generation: int
    channel: Channel
    data: bytes
    sequence: int
```

One ordered output frame from a named-process generation.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `generation` | `int` | required | Source generation. |
| `channel` | `Channel` | required | Output channel. |
| `data` | `bytes` | required | Frame payload. |
| `sequence` | `int` | required | Output sequence. |

### `omp.env.StartedProcess`

```python
class StartedProcess:
    def __new__(
        cls, /, name: Any, generation: Any, endpoint: Any
    ) -> StartedProcess
```

A backend start receipt with `name`, `generation`, and `endpoint` properties.

### `omp.env.Process`

```python
class Process:
    def __init__(
        self, name: str, generation: int, endpoint: str | None = None
    ) -> None
```

A stable, generation-fenced named-process handle.

#### `Process.endpoint`

```python
@property
def endpoint(self) -> str
```

Return the generation's authorized loopback or Unix endpoint.

**Raises**

: `Unsupported`: The Environment exposes no endpoint authority.
: `Stale`: The generation no longer has an endpoint.

#### `Process.info`

```python
async def info(self) -> ProcessInfo
```

Return the current generation snapshot.

#### `Process.output`

```python
def output(self, *, after: int = 0) -> AsyncIterator[ProcessOutput]
```

Stream retained and live output after a sequence number.

#### `Process.states`

```python
def states(self) -> AsyncIterator[ProcessInfo]
```

Stream lifecycle transitions.

#### `Process.send`

```python
async def send(self, data: bytes) -> None
```

Send bytes to process stdin.

#### `Process.eof`

```python
async def eof(self) -> None
```

Close process stdin.

#### `Process.send_secret`

```python
async def send_secret(self, name: str, value: str) -> None
```

Inject a scoped secret without placing it in argv or the environment.

#### `Process.signal`

```python
async def signal(self, signal: str) -> None
```

Signal the process group.

#### `Process.stop`

```python
async def stop(self, **options: Any) -> ProcessInfo
```

Stop the process tree and return terminal state.

#### `Process.restart`

```python
async def restart(self) -> Process
```

Restart from the retained launch specification and return the next generation.

### `omp.env.proc`

```python
proc: _Proc
```

Namespace for server-owned named processes.

#### `proc.start`

```python
async def start(name: str, script: str, **options: Any) -> Process
```

Start a named process. When supplied, `cwd` must be an `EnvPath`.

#### `proc.adopt`

```python
async def adopt(name: str) -> Process | None
```

Adopt a live named process, or return `None` when absent.

#### `proc.ensure`

```python
async def ensure(
    name: str,
    script: str,
    *,
    cwd: EnvPath | None = None,
    env: Mapping[str, str] | None = None,
    pty: Pty | None = None,
    restart: RestartPolicy | None = None,
    ready: Ready | None = None,
) -> Process
```

Atomically adopt a matching process or start it.

#### `proc.list`

```python
async def list() -> list[ProcessInfo]
```

List named processes visible to this connection.

## Scoped HTTP

### `omp.env.HttpResponse`

```python
@dataclass(frozen=True, slots=True)
class HttpResponse:
    status: int
    headers: Mapping[str, str]
    body: bytes
    final_url: str

    def json(self) -> Any
```

An immutable scoped-egress response. Headers are copied into a read-only mapping.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `status` | `int` | required | HTTP status code. |
| `headers` | `Mapping[str, str]` | required | Read-only response headers. |
| `body` | `bytes` | required | Response body. |
| `final_url` | `str` | required | URL producing the response after redirects. |

#### `HttpResponse.json`

```python
def json(self) -> Any
```

Decode `body` with `json.loads`.

**Returns**

: `Any`: The JSON value.

**Raises**

: `json.JSONDecodeError`: The body is not valid JSON.

### `omp.env.http_get`

```python
async def http_get(
    url: str,
    *,
    timeout: Duration | None = None,
    headers: Mapping[str, str] = MappingProxyType({}),
    redirects: int = 10,
) -> HttpResponse
```

Issue a GET through scoped Environment egress.

**Parameters**

: `url` (`str`): Absolute request URL.
: `timeout` (`Duration | None`): Optional request deadline.
: `headers` (`Mapping[str, str]`): Request headers.
: `redirects` (`int`): Maximum redirect hops, from zero through ten.

**Returns**

: `HttpResponse`: Immutable response bytes and metadata.

**Raises**

: `TypeError` or `ValueError`: Local argument validation fails.
: `EnvError`: Policy or transport rejects the request.

### `omp.env.http_post`

```python
async def http_post(
    url: str,
    *,
    body: bytes = b"",
    headers: Mapping[str, str] = MappingProxyType({}),
    timeout: Duration | None = None,
    redirects: int = 10,
) -> HttpResponse
```

Issue a POST through scoped Environment egress.

**Parameters**

: `url` (`str`): Absolute request URL.
: `body` (`bytes`): Request body.
: `headers` (`Mapping[str, str]`): Request headers.
: `timeout` (`Duration | None`): Optional request deadline.
: `redirects` (`int`): Maximum redirect hops, from zero through ten.

**Returns**

: `HttpResponse`: Immutable response bytes and metadata.

**Raises**

: `TypeError` or `ValueError`: Local argument validation fails.
: `EnvError`: Policy or transport rejects the request.

### `omp.env.http_put`

```python
async def http_put(
    url: str,
    *,
    body: bytes = b"",
    headers: Mapping[str, str] = MappingProxyType({}),
    timeout: Duration | None = None,
    redirects: int = 10,
) -> HttpResponse
```

Issue a PUT through scoped Environment egress.

**Parameters**

: `url` (`str`): Absolute request URL.
: `body` (`bytes`): Request body.
: `headers` (`Mapping[str, str]`): Request headers.
: `timeout` (`Duration | None`): Optional request deadline.
: `redirects` (`int`): Maximum redirect hops, from zero through ten.

**Returns**

: `HttpResponse`: Immutable response bytes and metadata.

**Raises**

: `TypeError` or `ValueError`: Local argument validation fails.
: `EnvError`: Policy or transport rejects the request.

## Blobs

### `omp.env.BlobStat`

```python
@dataclass(frozen=True, slots=True)
class BlobStat:
    present: bool
    size: int
```

Presence and stored size for a content digest.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `present` | `bool` | required | Whether content is present. |
| `size` | `int` | required | Stored size. |

### `omp.env.BlobWriter`

```python
class BlobWriter:
    def __init__(self, upload: Any) -> None
```

An incremental blob upload handle. Use it as an async context manager.

#### `BlobWriter.write`

```python
async def write(self, chunk: bytes) -> None
```

Append one ordered byte chunk.

#### `BlobWriter.commit`

```python
async def commit(self) -> BlobRef
```

Commit staged chunks and return their content identity.

#### `BlobWriter.abort`

```python
def abort(self) -> None
```

Abandon staged chunks. Leaving the async context without a successful commit aborts automatically.

### `omp.env.blobs`

```python
blobs: _Blobs
```

Namespace for streaming, content-addressed Environment storage.

#### `blobs.put`

```python
async def put(data: Any) -> BlobRef
```

Store `bytes`, an `EnvPath`, or a synchronous/asynchronous iterable of byte chunks.

#### `blobs.writer`

```python
def writer() -> BlobWriter
```

Create an incremental upload context manager.

#### `blobs.get`

```python
async def get(
    ref: BlobRef, *, offset: int = 0, length: int | None = None
) -> bytes
```

Fetch a complete blob or byte range into one `bytes` object.

#### `blobs.stream`

```python
def stream(
    ref: BlobRef, *, offset: int = 0, length: int | None = None
) -> AsyncIterator[bytes]
```

Return an async stream without materializing the full payload.

#### `blobs.stat`

```python
async def stat(ref: BlobRef) -> BlobStat
```

Return presence and stored size.

#### `blobs.delete`

```python
async def delete(ref: BlobRef) -> bool
```

Delete a blob and report whether it existed.

For model-facing retention and `artifact://` addresses, promote a blob with [omp.artifacts](omp.artifacts.md).

## Workspace index and search

### `omp.env.Follow`

```python
class Follow(StrEnum)
```

Symbolic-link traversal policy for workspace walks.

| Member | Wire value | Meaning |
|---|---|---|
| `NEVER` | `never` | Do not follow links. |
| `ROOTS` | `roots` | Follow configured roots. |
| `ALWAYS` | `always` | Follow links throughout the walk. |

### `omp.env.Rank`

```python
class Rank(StrEnum)
```

Workspace result ranking: `NONE = "none"` or `PATH = "path"`.

### `omp.env.Entry`

```python
@dataclass(frozen=True, slots=True)
class Entry:
    path: EnvPath
    kind: str
    size: int | None = None
    mtime_ms: float | None = None
    depth: int = 0
```

One workspace walk result.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `path` | `EnvPath` | required | Entry path. |
| `kind` | `str` | required | Host-reported kind. |
| `size` | `int | None` | `None` | File size when known. |
| `mtime_ms` | `float | None` | `None` | Modification time in milliseconds when known. |
| `depth` | `int` | `0` | Walk depth. |

### `omp.env.Match`

```python
@dataclass(frozen=True, slots=True)
class Match:
    path: EnvPath
    line: int
    byte_offset: int
    line_bytes: bytes
```

One content-search match with a one-based line and zero-based whole-file byte offset.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `path` | `EnvPath` | required | Matching file. |
| `line` | `int` | required | One-based line number. |
| `byte_offset` | `int` | required | Zero-based whole-file byte offset. |
| `line_bytes` | `bytes` | required | Matching line bytes. |

### `omp.env.find`

```python
find: _Find
```

Namespace for cached, gitignore-aware workspace walking and search.

#### `find.files`

```python
async def files(**options: Any) -> list[Entry]
```

Return bounded workspace entries. A supplied `root` must be an `EnvPath`.

#### `find.walk`

```python
def walk(**options: Any) -> AsyncIterator[Entry]
```

Stream workspace entries lazily.

#### `find.search`

```python
def search(
    pattern: str | bytes, **options: Any
) -> AsyncIterator[Match]
```

Stream content matches lazily.

#### `find.grep`

```python
async def grep(pattern: str | bytes, **options: Any) -> list[Match]
```

Collect content matches under the server-side walker.

```python
async for match in find.search("needle", root=EnvPath("src"), limit=50):
    print(match.path, match.line)
```

## Trusted direct filesystem

### `omp.env.DirectFilesystemGrant`

```python
@dataclass(frozen=True, slots=True)
class DirectFilesystemGrant:
    extension_id: str
    publisher: str
    capability_digest: str
    grant_id: str
    granted_at: str
    generation: int
```

Durable provenance for the exceptional trusted direct-filesystem capability.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `extension_id` | `str` | required | Granted extension. |
| `publisher` | `str` | required | Publisher identity. |
| `capability_digest` | `str` | required | Granted manifest digest. |
| `grant_id` | `str` | required | Durable grant identity. |
| `granted_at` | `str` | required | Grant timestamp. |
| `generation` | `int` | required | Grant generation fence. |

### `omp.env.DirectFilesystemDenied`

```python
class DirectFilesystemDenied(PermissionError, OmpError)
```

The trusted direct-filesystem escape was not declared and granted.

### `omp.env.DirectFilesystem`

```python
class DirectFilesystem
```

A deliberately separate, audited absolute-path escape for trusted extensions.

#### `DirectFilesystem.request`

```python
async def request(
    self,
    operation: str,
    path: str | Path,
    *,
    data: bytes | None = None,
) -> object
```

Perform `read`, `write`, `stat`, `list`, `mkdir`, or `remove` through the granted CONTROL arm. Paths must be absolute and payloads are limited to 1 MiB.

**Raises**

: `DirectFilesystemDenied`: No durable grant is installed.
: `ValueError`: The path is relative, the operation is unsupported, or payload is too large.
: `NotWiredError`: The granted backend has no request method.

#### `DirectFilesystem.grant`

```python
def grant(self) -> DirectFilesystemGrant
```

Return immutable grant provenance without I/O.

### `omp.env.direct_filesystem`

```python
direct_filesystem: DirectFilesystem
```

The singleton exceptional capability. It is never an alias for `fs` and is unavailable unless the host installs a durable trusted grant.
