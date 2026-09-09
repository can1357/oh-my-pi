# `omp.sessions`

Use `omp.sessions` to inspect the write-time session index, create or resume interactive sessions, query durable usage, and stream historical journals. The current session is available synchronously; historical and mutating operations cross CONTROL and are asynchronous.

```python
import omp

current = omp.sessions.current()
recent = await omp.sessions.list(
    omp.sessions.SessionFilter(project=current.project, limit=10)
)
```

See [Agents and sessions](../guides/agents-and-sessions.md), [`omp.agents`](omp.agents.md), and [`omp.journal`](omp.journal.md).

## Errors

### `omp.sessions.SessionError`

```python
class SessionError(OmpError)
```

Base exception for historical session operations.

### `omp.sessions.SessionAccessDenied`

```python
class SessionAccessDenied(SessionError):
    def __init__(self, session_id: str) -> None
```

Raised when the caller may not read the requested historical session.

### `omp.sessions.SessionNotFound`

```python
class SessionNotFound(OmpError)
```

Raised when a session does not exist or is not visible to the caller.

### `omp.sessions.SessionTransitionDenied`

```python
class SessionTransitionDenied(SessionError):
    def __init__(
        self,
        reason: str,
        *,
        details: Mapping[str, object] | None = None,
    ) -> None
```

Raised when Core refuses a session transition before creating durable state.

### `omp.sessions.SessionTransitionIndeterminate`

```python
class SessionTransitionIndeterminate(SessionError):
    def __init__(
        self,
        idempotency_key: str | None,
        reason: str,
        *,
        details: Mapping[str, object] | None = None,
    ) -> None
```

Raised when Core cannot prove whether a create transaction became durable. Preserve `idempotency_key` when reconciling the outcome.

## Session index types

### `omp.sessions.SessionStatus`

```python
class SessionStatus(StrEnum):
    COMPLETE = "complete"
    INTERRUPTED = "interrupted"
    ABORTED = "aborted"
    ERROR = "error"
    PENDING = "pending"
    UNKNOWN = "unknown"
```

Disposition derived from the latest durable turn records.

### `omp.sessions.SessionKind`

```python
class SessionKind(StrEnum):
    INTERACTIVE = "interactive"
    SUBAGENT = "subagent"
    ADVISOR = "advisor"
```

Runtime role represented by a session index row.

### `omp.sessions.TitleSource`

```python
class TitleSource(StrEnum):
    USER = "user"
    MODEL = "model"
    SYSTEM = "system"
```

Authority that assigned a session title.

### `omp.sessions.SessionInfo`

```python
@dataclass(frozen=True, slots=True)
class SessionInfo:
    id: str
    title: str | None
    title_source: TitleSource
    cwd: EnvPath
    project: str
    created_ms: int
    updated_ms: int
    status: SessionStatus
    kind: SessionKind
    parent: str | None
    entries: int
    turns: int
    usage: Usage
    cost: Cost
    models: Sequence[str]
    remote: bool
```

Frozen row from the write-time session index.

| Field | Meaning |
|---|---|
| `id` | Stable session identifier. |
| `title` / `title_source` | Display title and its authority. |
| `cwd` / `project` | Indexed working directory and project identity. |
| `created_ms` / `updated_ms` | Unix millisecond timestamps. |
| `status` / `kind` | Durable disposition and runtime role. |
| `parent` | Parent session id, when present. |
| `entries` / `turns` | Indexed journal and turn counts. |
| `usage` / `cost` | Indexed accounting. |
| `models` | Models observed in the session. |
| `remote` | Whether the indexed environment is remote. |

### `omp.sessions.SessionLink`

```python
@dataclass(frozen=True, slots=True)
class SessionLink:
    id: str
    parent: str | None
    at: int | None = None
```

One durable parent relation in a session lineage chain. `at` is the optional physical relation point.

### `omp.sessions.SessionNode`

```python
@dataclass(frozen=True, slots=True)
class SessionNode:
    id: EntryId
    parent: EntryId | None
    kind: str
    ts: int
    data: Mapping[str, object]
    label: str | None = None
    children: tuple[SessionNode, ...] = ()
```

Immutable node in a materialized physical session tree.

### `omp.sessions.SessionFilter`

```python
@dataclass(frozen=True, slots=True)
class SessionFilter:
    project: str | None = None
    since_ms: int | None = None
    until_ms: int | None = None
    status: Sequence[SessionStatus] | None = None
    kind: Sequence[SessionKind] | None = (SessionKind.INTERACTIVE,)
    contains_kind: str | None = None
    limit: int = 200
```

Indexed filters for session listing and usage queries. By default, listings include interactive sessions only.

### `omp.sessions.SessionSetup`

```python
class SessionSetup:
    def __init__(
        self,
        title = None,
        parent = None,
        entries = None,
        initial_prompt = None,
    ) -> None

    @property
    def title(self) -> str | None
    @property
    def parent(self) -> str | None
    @property
    def entries(self) -> tuple[object, ...]
    @property
    def initial_prompt(self) -> object | None
```

Immutable setup for an atomic interactive-session transition. This type is implemented by `_omp` and re-exported here.

| Field | Default | Meaning |
|---|---|---|
| `title` | `None` | Optional user title. |
| `parent` | `None` | Optional accessible lineage parent. |
| `entries` | empty tuple | Values declared with `@omp.entry_kind`, written while creating the session. |
| `initial_prompt` | `None` | Visible prompt persisted without submission; accepts text or a non-empty tuple of text/blob parts. |

> **Note** `create()` validates entry declarations and prompt parts while serializing the setup.

## Usage types

### `omp.sessions.GroupBy`

```python
class GroupBy(StrEnum):
    MODEL = "model"
    PROVIDER = "provider"
    PROJECT = "project"
    SESSION = "session"
    KIND = "kind"
```

Available dimensions for usage aggregation.

### `omp.sessions.Bucket`

```python
class Bucket(StrEnum):
    NONE = "none"
    HOUR = "hour"
    DAY = "day"
    WEEK = "week"
    MONTH = "month"
```

Time bucket applied to usage series output.

### `omp.sessions.UsageAccuracy`

```python
class UsageAccuracy(StrEnum):
    EXACT = "exact"
    ESTIMATED = "estimated"
    MIXED = "mixed"
```

Provenance of token counts in an aggregate.

### `omp.sessions.Usage`

```python
@dataclass(frozen=True, slots=True)
class Usage:
    input: int = 0
    output: int = 0
    cache_read: int = 0
    cache_write: int = 0
    reasoning: int = 0
    premium_requests: int = 0
    context: int | None = None
    total: int = 0
    accuracy: UsageAccuracy = UsageAccuracy.EXACT
    detail: Mapping[str, int | str] = field(default_factory=dict)
```

Unabridged token accounting stored in the sessions index.

### `omp.sessions.Cost`

```python
@dataclass(frozen=True, slots=True)
class Cost:
    nanos_usd: int = 0
    estimated: bool = False
    input_nanos_usd: int | None = None
    output_nanos_usd: int | None = None

    @property
    def usd(self) -> float
```

Nano-USD cost aggregate. `usd` divides `nanos_usd` by `1_000_000_000` for display.

### `omp.sessions.UsageQuery`

```python
@dataclass(frozen=True, slots=True)
class UsageQuery:
    since_ms: int | None = None
    until_ms: int | None = None
    group_by: Sequence[GroupBy] = (GroupBy.MODEL,)
    bucket: Bucket = Bucket.NONE
    filter: SessionFilter | None = None
    include_subagents: bool = True
```

Grouping and time bounds for durable usage aggregation.

### `omp.sessions.UsageBucket`

```python
@dataclass(frozen=True, slots=True)
class UsageBucket:
    key: Mapping[str, str]
    start_ms: int | None
    usage: Usage
    cost: Cost
    requests: int
    errors: int
    duration: Duration
```

One total, grouping row, or time-series bucket.

### `omp.sessions.UsageReport`

```python
@dataclass(frozen=True, slots=True)
class UsageReport:
    total: UsageBucket
    groups: Sequence[UsageBucket]
    series: Sequence[UsageBucket]
    sessions: int
    truncated: bool
```

Complete result of one indexed usage query.

## Session operations

### `omp.sessions.current`

```python
def current() -> SessionInfo
```

Reads the current session's host-materialized index projection without an async round trip.

**Returns**: Current `SessionInfo`.

**Raises**: `NotWiredError` when no host backend supplies the projection.

### `omp.sessions.list`

```python
async def list(filter: SessionFilter | None = None) -> Sequence[SessionInfo]
```

Lists visible sessions by newest indexed activity.

**Parameters**: `filter` selects project, time, status, kind, contained entry kind, and limit.

**Returns**: An immutable tuple of `SessionInfo` rows.

### `omp.sessions.get`

```python
async def get(session_id: str) -> SessionInfo
```

Returns indexed metadata for one visible session.

**Raises**: `SessionNotFound` or `SessionAccessDenied` as reported by Core.

### `omp.sessions.lineage`

```python
async def lineage(session_id: str) -> Sequence[SessionLink]
```

Returns durable lineage reaching a session, oldest first.

### `omp.sessions.resume`

```python
async def resume(session_id: str) -> SessionInfo
```

Resumes an interactive session and journals the host transition receipt.

**Returns**: The updated index projection.

### `omp.sessions.create`

```python
async def create(setup: SessionSetup = SessionSetup()) -> SessionInfo
```

Atomically creates, seeds, and switches to a top-level interactive session. It does not itself submit `initial_prompt` for inference.

**Parameters**: `setup` supplies title, lineage, typed entries, and an optional visible initial prompt.

**Returns**: The created `SessionInfo`.

**Raises**: `TypeError` or `ValueError` for malformed setup values; `SessionTransitionDenied` when Core refuses before durability; `SessionTransitionIndeterminate` when durability cannot be proven.

```python
created = await omp.sessions.create(
    omp.sessions.SessionSetup(
        title="Focused review",
        parent=omp.sessions.current().id,
        initial_prompt="Review the pending migration.",
    )
)
```

### `omp.sessions.rename`

```python
async def rename(session_id: str, title: str) -> SessionInfo
```

Assigns a user title and journals the durable rename receipt.

### `omp.sessions.delete`

```python
async def delete(session_id: str) -> None
```

Requests deletion through a Core-approved policy ticket.

> **Warning** This operation never bypasses approval. Core rejects an unapproved request.

### `omp.sessions.usage`

```python
async def usage(query: UsageQuery) -> UsageReport
```

Aggregates token and cost usage from the write-time index.

```python
report = await omp.sessions.usage(
    omp.sessions.UsageQuery(
        group_by=(omp.sessions.GroupBy.MODEL,),
        bucket=omp.sessions.Bucket.DAY,
    )
)
print(report.total.cost.usd)
```

## Historical journals and structure

### `omp.sessions.journal`

```python
async def journal(
    session_id: str,
    *,
    kinds: Sequence[str] | None = None,
    since: object | None = None,
    until: object | None = None,
    live: bool = True,
) -> AsyncIterator[Any]
```

Streams decoded historical entries through bounded authoritative pages.

**Parameters**

- `session_id`: Historical session to read.
- `kinds`: Optional entry-kind names.
- `since` / `until`: `EntryId`, non-negative physical index, or `None`; an `EntryId` must belong to `session_id`.
- `live`: Select the host's live projection when true.

**Returns**: An async iterator of `JournalEntry` values.

**Raises**: `TypeError` for invalid bounds or malformed host pages; `ValueError` for a bound from another session.

```python
session_id = omp.sessions.current().id
async for entry in omp.sessions.journal(session_id):
    print(entry.id, entry.kind)
```

### `omp.sessions.tree`

```python
async def tree(session_id: str | None = None) -> tuple[SessionNode, ...]
```

Materializes the physical session tree. Missing-parent nodes and cycle survivors are returned as roots. `None` selects the current session.

### `omp.sessions.branch`

```python
async def branch(
    from_id: EntryId | int | None = None
) -> tuple[SessionNode, ...]
```

Materializes one root-first physical branch. `None` follows the current session's live leaf; an `EntryId` selects its own session; an integer selects an index in the current session.

**Raises**: `TypeError` for a boolean, negative integer, or unsupported value.
## Data model field index

| Dataclass | Fields |
|---|---|
| `SessionInfo` | `id`, `title`, `title_source`, `cwd`, `project`, `created_ms`, `updated_ms`, `status`, `kind`, `parent`, `entries`, `turns`, `usage`, `cost`, `models`, `remote` |
| `SessionLink` | `id`, `parent`, `at=None` |
| `SessionNode` | `id`, `parent`, `kind`, `ts`, `data`, `label=None`, `children=()` |
| `SessionFilter` | `project=None`, `since_ms=None`, `until_ms=None`, `status=None`, `kind=(SessionKind.INTERACTIVE,)`, `contains_kind=None`, `limit=200` |
| `Usage` | `input=0`, `output=0`, `cache_read=0`, `cache_write=0`, `reasoning=0`, `premium_requests=0`, `context=None`, `total=0`, `accuracy=UsageAccuracy.EXACT`, `detail={}` |
| `Cost` | `nanos_usd=0`, `estimated=False`, `input_nanos_usd=None`, `output_nanos_usd=None` |
| `UsageQuery` | `since_ms=None`, `until_ms=None`, `group_by=(GroupBy.MODEL,)`, `bucket=Bucket.NONE`, `filter=None`, `include_subagents=True` |
| `UsageBucket` | `key`, `start_ms`, `usage`, `cost`, `requests`, `errors`, `duration` |
| `UsageReport` | `total`, `groups`, `series`, `sessions`, `truncated` |

## Enum member index

| Enum | Member | Wire value | Meaning |
|---|---|---|---|
| `SessionStatus` | `COMPLETE` | `"complete"` | Latest durable turns form a complete session. |
| `SessionStatus` | `INTERRUPTED` | `"interrupted"` | Latest durable state records interruption. |
| `SessionStatus` | `ABORTED` | `"aborted"` | Latest durable state records abort. |
| `SessionStatus` | `ERROR` | `"error"` | Latest durable state records an error. |
| `SessionStatus` | `PENDING` | `"pending"` | Durable work is pending. |
| `SessionStatus` | `UNKNOWN` | `"unknown"` | The index cannot derive a known disposition. |
| `SessionKind` | `INTERACTIVE` | `"interactive"` | Top-level interactive session. |
| `SessionKind` | `SUBAGENT` | `"subagent"` | Child-agent session. |
| `SessionKind` | `ADVISOR` | `"advisor"` | Advisor session. |
| `TitleSource` | `USER` | `"user"` | User assigned the title. |
| `TitleSource` | `MODEL` | `"model"` | Model assigned the title. |
| `TitleSource` | `SYSTEM` | `"system"` | System assigned the title. |
| `GroupBy` | `MODEL` | `"model"` | Group usage by model. |
| `GroupBy` | `PROVIDER` | `"provider"` | Group usage by provider. |
| `GroupBy` | `PROJECT` | `"project"` | Group usage by project. |
| `GroupBy` | `SESSION` | `"session"` | Group usage by session. |
| `GroupBy` | `KIND` | `"kind"` | Group usage by session kind. |
| `Bucket` | `NONE` | `"none"` | Do not build a time series. |
| `Bucket` | `HOUR` | `"hour"` | Bucket by hour. |
| `Bucket` | `DAY` | `"day"` | Bucket by day. |
| `Bucket` | `WEEK` | `"week"` | Bucket by week. |
| `Bucket` | `MONTH` | `"month"` | Bucket by month. |
| `UsageAccuracy` | `EXACT` | `"exact"` | Counts are exact. |
| `UsageAccuracy` | `ESTIMATED` | `"estimated"` | Counts are estimated. |
| `UsageAccuracy` | `MIXED` | `"mixed"` | Aggregate combines exact and estimated counts. |
