# `omp.journal`

Use `omp.journal` for typed, durable extension records in the authoritative session journal. You declare entry kinds elsewhere with `@omp.entry_kind`; this module serializes declared values canonically, appends them through Core, and reads immutable records back in durable order.

```python
from dataclasses import dataclass
import omp

@omp.entry_kind("com.example.review", rev="1")
@dataclass(frozen=True, slots=True)
class ReviewRecord:
    path: str
    passed: bool

entry_id = await omp.journal.append(ReviewRecord("src/parser.py", True))
```

`EntryAccessDenied`, `EntryId`, `EntryKindConflict`, `EntryTooLarge`, `EntryUndecodable`, `JournalEntry`, `JournalError`, `JournalIndeterminate`, `StateEntry`, `StateEntryId`, and `UnknownEntryKind` are also re-exported from top-level `omp`. Their canonical reference entries remain on this page.

See [Agents and sessions](../guides/agents-and-sessions.md), [`omp.sessions`](omp.sessions.md), and [`omp.context`](omp.context.md).

## Identifiers and records

### `omp.journal.EntryId`

```python
@dataclass(frozen=True, slots=True, order=True)
class EntryId:
    session: str
    index: int

    @classmethod
    def parse(cls, value: str) -> EntryId

    def __str__(self) -> str
```

Opaque, totally ordered physical index within one session journal. String form is `<session_id>:<index>`.

**Parameters**: `parse()` accepts only the canonical string form; the index must contain canonical ASCII decimal digits without redundant leading zeroes.

**Returns**: A parsed `EntryId`.

**Raises**: `TypeError` for a non-string and `ValueError` for a non-canonical id.

```python
entry_id = omp.EntryId.parse("01JSESSION:42")
assert str(entry_id) == "01JSESSION:42"
```

### `omp.journal.StateEntryId`

```python
@dataclass(frozen=True, slots=True, order=True)
class StateEntryId:
    scope: str
    index: int

    def __str__(self) -> str
```

Opaque, totally ordered physical index within one scoped state log. String form is `<scope_instance>:<index>`.

### `omp.journal.JournalEntry`

```python
@dataclass(frozen=True, slots=True)
class JournalEntry(Generic[_T]):
    id: EntryId
    kind: str
    rev: str
    ts: int
    principal: Principal
    provenance: Provenance
    value: _T | None
    raw: bytes
    display: bool
    in_context: bool
    artifact: ArtifactRef | None = None
```

Immutable decoded view of one durable session-journal record.

| Field | Meaning |
|---|---|
| `id` | Physical session-journal position. |
| `kind` / `rev` | Declared entry identity and revision. |
| `ts` | Host timestamp. |
| `principal` / `provenance` | Core-authenticated writer and package provenance. |
| `value` | Typed decoded value when its declaration can be resolved, otherwise `None` or the host-supplied value for an unknown kind. |
| `raw` | Canonical JSON bytes. |
| `display` / `in_context` | Host projection flags. |
| `artifact` | Spill reference when the payload is stored outside the inline record. |

### `omp.journal.StateEntry`

```python
@dataclass(frozen=True, slots=True)
class StateEntry(Generic[_T]):
    id: StateEntryId
    kind: str
    rev: str
    ts: int
    principal: Principal
    provenance: Provenance
    value: _T | None
    raw: bytes
    artifact: ArtifactRef | None = None
```

Immutable decoded view of one durable scoped-state record. It parallels `JournalEntry` without session display/context flags.

## Errors

### `omp.journal.JournalError`

```python
class JournalError(OmpError):
    def __init__(
        self,
        message: str,
        *,
        appended: Iterable[EntryId] = (),
    ) -> None
```

Base error for journal operations. For a partial non-atomic multi-entry append, `appended` records entries already accepted.

### `omp.journal.UnknownEntryKind`

```python
class UnknownEntryKind(JournalError):
    def __init__(self, kind: object) -> None
```

Raised when an appended value is not an instance of a declared entry kind, or a requested type is undeclared.

### `omp.journal.EntryKindConflict`

```python
class EntryKindConflict(JournalError):
    def __init__(self, name: str, owner: str | None = None) -> None
```

Raised when an entry-kind name is already owned by another declaration.

### `omp.journal.EntryTooLarge`

```python
class EntryTooLarge(JournalError):
    def __init__(self, actual: int, limit: int) -> None
```

Raised when canonical encoded bytes exceed the applicable inline or hard ceiling.

### `omp.journal.EntryAccessDenied`

```python
class EntryAccessDenied(JournalError):
    def __init__(self, kind: str) -> None
```

Raised when the caller may not read an entry-kind namespace.

### `omp.journal.JournalIndeterminate`

```python
class JournalIndeterminate(JournalError):
    def __init__(
        self,
        operation: str = "journal mutation",
        *,
        appended: Iterable[EntryId] = (),
    ) -> None
```

Raised when Core cannot prove the durability outcome of a mutation.

### `omp.journal.EntryUndecodable`

```python
class EntryUndecodable(JournalError):
    def __init__(self, raw: bytes, reason: str) -> None
```

Raised when bytes are not exactly the canonical JSON encoding accepted by `decode()`.

## Writing entries

### `omp.journal.append`

```python
async def append(
    entry: object,
    *,
    display: bool | None = None,
    idempotency_key: str | None = None,
) -> EntryId
```

Appends one declared value through the authoritative session journal.

**Parameters**

- `entry`: Instance of a registered entry-kind implementation.
- `display`: Optional per-append display override.
- `idempotency_key`: Non-empty caller key; `None` generates a fresh UUID key.

**Returns**: The durable `EntryId`.

**Raises**: `UnknownEntryKind`, `EntryTooLarge`, `TypeError` for invalid display/key or non-JSON-compatible fields, and mutation errors reported by Core.

### `omp.journal.append_many`

```python
async def append_many(
    entries: Iterable[object], *, idempotency_key: str | None = None
) -> list[EntryId]
```

Appends an ordered, non-atomic group in one CONTROL round trip.

**Returns**: Accepted ids in order.

**Raises**: `JournalError`; inspect its `appended` field when Core reports partial success.

> **Warning** This operation is not atomic. Use `append_atomic()` when the group must be all-or-nothing.

### `omp.journal.append_atomic`

```python
async def append_atomic(
    entries: Iterable[object], *, idempotency_key: str
) -> list[EntryId]
```

Appends an idempotent group atomically.

**Parameters**: `idempotency_key` is required and must be non-empty.

**Returns**: Durable ids in input order.

**Raises**: `JournalError` when the batch exceeds `MAX_ATOMIC_ENTRIES`; `TypeError` for an invalid key or value; `EntryTooLarge` for an oversized entry.

```python
ids = await omp.journal.append_atomic(
    [ReviewRecord("src/a.py", True), ReviewRecord("src/b.py", False)],
    idempotency_key="review-wave-17",
)
```

### `omp.journal.label`

```python
async def label(target: EntryId, label: str | None) -> EntryId
```

Appends a durable label assignment for an addressable journal entry. `None` clears the live label.

**Returns**: The id of the appended label event.

**Raises**: `TypeError` for an invalid target or label; `JournalError` when the label exceeds `MAX_LABEL_BYTES`.

### `omp.journal.label_of`

```python
async def label_of(target: EntryId) -> str | None
```

Returns the latest live label assignment for an entry.

**Raises**: `TypeError` when `target` is not an `EntryId` or when the host response is malformed.

## Reading entries

### `omp.journal.decode`

```python
def decode(raw: bytes) -> Any
```

Decodes bytes only when they are exactly the canonical JSON encoding written by the host. Canonical form uses UTF-8, sorted keys, compact separators, and finite JSON numbers.

**Returns**: The decoded JSON value.

**Raises**: `TypeError` for non-bytes and `EntryUndecodable` for invalid UTF-8, invalid JSON, non-finite values, or a non-canonical encoding.

### `omp.journal.entries`

```python
async def entries(
    kind: str | type[_T] | None = None,
    *,
    rev: str | None = None,
    since: EntryId | None = None,
    limit: int | None = None,
    live: bool = True,
) -> Sequence[JournalEntry[_T]]
```

Reads authoritative entries in ascending durable order.

**Parameters**

- `kind`: Entry-kind name, declared implementation type, or `None` for all readable kinds.
- `rev`: Optional non-empty revision filter.
- `since`: Optional physical watermark.
- `limit`: Optional non-negative maximum.
- `live`: Select the host's live projection when true.

**Returns**: An immutable tuple of decoded entries.

**Raises**: `UnknownEntryKind`, `TypeError` for invalid filters or malformed responses, `EntryAccessDenied`, or `JournalError` if Core returns non-increasing ids.

```python
for entry in await omp.journal.entries(ReviewRecord):
    if entry.value is not None:
        print(entry.value.path, entry.value.passed)
```

### `omp.journal.latest`

```python
async def latest(
    kind: str | type[_T]
) -> JournalEntry[_T] | None
```

Returns the highest-index live entry of one kind, or `None` when no such entry exists.

### `omp.journal.fold`

```python
async def fold(
    kind: str | type[_T],
    reducer: Callable[[_A, JournalEntry[_T]], _A],
    initial: _A,
    *,
    since: EntryId | None = None,
) -> tuple[_A, EntryId | None]
```

Folds authoritative live entries left-to-right and returns the accumulator with the last processed id.

**Parameters**: `kind` selects records; `reducer` combines the accumulator and each entry; `initial` seeds the fold; `since` supplies a watermark.

**Returns**: `(accumulator, watermark)`, where the watermark is `None` when no entries were processed.

**Raises**: `TypeError` when `reducer` is not callable, plus errors from `entries()` or your reducer.

## Limits

### `omp.journal.MAX_INLINE_BYTES`

```python
MAX_INLINE_BYTES = 65_536
```

Largest canonical entry encoded inline before artifact spilling is required. A declaration that does not permit spilling raises `EntryTooLarge` beyond this value.

### `omp.journal.MAX_ENTRY_BYTES`

```python
MAX_ENTRY_BYTES = 16_777_216
```

Hard canonical encoded-size ceiling for one entry.

### `omp.journal.MAX_LABEL_BYTES`

```python
MAX_LABEL_BYTES = 256
```

Maximum UTF-8 byte length of a journal label.

### `omp.journal.MAX_ATOMIC_ENTRIES`

```python
MAX_ATOMIC_ENTRIES = 1_024
```

Maximum number of values accepted by one atomic append.
## Data model field index

| Dataclass | Fields |
|---|---|
| `EntryId` | `session`, `index` |
| `StateEntryId` | `scope`, `index` |
| `JournalEntry` | `id`, `kind`, `rev`, `ts`, `principal`, `provenance`, `value`, `raw`, `display`, `in_context`, `artifact=None` |
| `StateEntry` | `id`, `kind`, `rev`, `ts`, `principal`, `provenance`, `value`, `raw`, `artifact=None` |
