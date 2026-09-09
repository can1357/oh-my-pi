# `omp.placement`

Use `omp.placement` to describe where a device body runs and to manage named worker generations. Importing the module only creates declarations and local value objects; worker lifecycle operations use the host control bridge.

```python
import omp

omp.workers.declare(
    omp.WorkerSpec(
        name="index",
        site=omp.Site.ENV,
        max_concurrency=2,
        restart=omp.Restart.ON_FAILURE,
    )
)

index_place = omp.Place.worker("index")
```

For choosing a locality and packaging worker dependencies, see [Placement and packaging](../guides/placement-and-packaging.md).

## Placement values

### `omp.placement.PlaceKind`

```python
class PlaceKind(StrEnum):
    HOST = "host"
    ENV = "env"
    WORKER = "worker"
```

Names the execution locality recorded for a device.

| Member | Wire value | Meaning |
|---|---|---|
| `HOST` | `"host"` | Run in the extension host. |
| `ENV` | `"env"` | Run in Environment placement. |
| `WORKER` | `"worker"` | Run in a named worker. |

### `omp.placement.Place`

```python
@dataclass(frozen=True, slots=True)
class Place:
    kind: PlaceKind
    name: str | None = None

    @classmethod
    def worker(cls, name: str) -> "Place": ...

    @classmethod
    def parse(cls, value: str | "Place") -> "Place": ...

    def __str__(self) -> str: ...
```

Stores a parsed `place=` value. `Place.HOST` and `Place.ENV` are canonical class attributes created by the module.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `kind` | `PlaceKind` | required | Locality category. |
| `name` | `str | None` | `None` | Named worker when `kind` is `WORKER`. |

`Place.worker()` accepts a non-empty name containing only letters, digits, `.`, `_`, or `-`. `Place.parse()` accepts an existing `Place`, `"host"`, `"env"`, or `"worker:<name>"`. Converting a place to `str` produces the matching declaration spelling.

**Parameters**

: **`name`** (`str`) — Worker name for `worker()`.
: **`value`** (`str | Place`) — Declaration accepted by `parse()`.

**Returns**

: `Place` — The validated placement.

**Raises**

: `ValueError` — `worker()` receives an empty or invalid name.
: `omp.PlacementError` — `parse()` receives an unsupported value.

```python
place = omp.Place.parse("worker:index")
assert place == omp.Place.worker("index")
assert str(place) == "worker:index"
```

### `omp.placement.SiteKind`

```python
class SiteKind(StrEnum):
    ENV = "env"
    LOCAL = "local"
    ATTACHED = "attached"
```

Names the site used to realize a named worker process.

| Member | Wire value | Meaning |
|---|---|---|
| `ENV` | `"env"` | Environment-owned site. |
| `LOCAL` | `"local"` | Local site. |
| `ATTACHED` | `"attached"` | An attached named process. |

### `omp.placement.Site`

```python
@dataclass(frozen=True, slots=True)
class Site:
    kind: SiteKind
    process: str | None = None
    ready: Any = None

    @classmethod
    def attached(cls, process: str, *, ready: Any = None) -> "Site": ...
```

Declares where a named worker process is hosted. `Site.ENV` and `Site.LOCAL` are canonical class attributes.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `kind` | `SiteKind` | required | Site category. |
| `process` | `str | None` | `None` | Named process used by an attached site. |
| `ready` | `Any` | `None` | Optional readiness declaration passed with the attached process. |

**Parameters**

: **`process`** (`str`) — Non-empty attached process name.
: **`ready`** (`Any`) — Optional readiness declaration.

**Returns**

: `Site` — An attached site declaration.

**Raises**

: `ValueError` — `process` is empty.

```python
site = omp.Site.attached("remote-python")
```

### `omp.placement.Restart`

```python
class Restart(StrEnum):
    NO = "no"
    ON_FAILURE = "on-failure"
    ALWAYS = "always"
```

Selects a named worker restart policy.

| Member | Wire value | Meaning |
|---|---|---|
| `NO` | `"no"` | Do not request automatic restart. |
| `ON_FAILURE` | `"on-failure"` | Restart after failure. |
| `ALWAYS` | `"always"` | Restart after any exit. |

### `omp.placement.WorkerState`

```python
class WorkerState(StrEnum):
    SPAWNING = "spawning"
    BOOTING = "booting"
    READY = "ready"
    DRAINING = "draining"
    EVICTED = "evicted"
    FAILED = "failed"
```

Represents an observed named-worker lifecycle state.

| Member | Wire value | Meaning |
|---|---|---|
| `SPAWNING` | `"spawning"` | The worker process is being created. |
| `BOOTING` | `"booting"` | Worker boot work is in progress. |
| `READY` | `"ready"` | The generation can accept calls. |
| `DRAINING` | `"draining"` | The generation is retiring. |
| `EVICTED` | `"evicted"` | The generation was retired. |
| `FAILED` | `"failed"` | The generation is unavailable because it failed. |

## Worker declarations and observations

### `omp.placement.WorkerResources`

```python
@dataclass(frozen=True, slots=True)
class WorkerResources:
    memory_bytes: int | None = None
    cpu_shares: float | None = None
    open_files: int | None = None
    wall_clock: Duration | None = None
```

Carries resource limits requested from the worker supervisor.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `memory_bytes` | `int | None` | `None` | Requested memory limit in bytes. |
| `cpu_shares` | `float | None` | `None` | Requested CPU share. |
| `open_files` | `int | None` | `None` | Requested open-file limit. |
| `wall_clock` | `omp.Duration | None` | `None` | Requested generation wall-clock limit. |

The actual enforced fields are reported by `WorkerInfo.enforced`.

### `omp.placement.WorkerSpec`

```python
@dataclass(frozen=True, slots=True)
class WorkerSpec:
    name: str
    site: Site = Site.ENV
    boot: Any = None
    idle_ttl: Duration = Duration("7m")
    max_concurrency: int = 1
    max_calls: int | None = None
    restart: Restart = Restart.NO
    resources: WorkerResources = field(default_factory=WorkerResources)
    cwd: Any = None
    env_delta: Mapping[str, str | None] = field(
        default_factory=lambda: MappingProxyType({})
    )
    readonly: bool = False
    unmanaged: bool = False
    warm: bool = False
```

Declares one persistent named worker. Construction validates the worker name and call limits, and snapshots `env_delta` into an immutable mapping.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `name` | `str` | required | Name used by `worker:<name>` and `workers.get()`. |
| `site` | `Site` | `Site.ENV` | Process site. |
| `boot` | `Any` | `None` | Host-projected boot declaration. |
| `idle_ttl` | `omp.Duration` | `Duration("7m")` | Idle lifetime requested for the generation. |
| `max_concurrency` | `int` | `1` | Maximum concurrent calls declared for the worker. |
| `max_calls` | `int | None` | `None` | Optional call-count limit. |
| `restart` | `Restart` | `Restart.NO` | Restart policy. |
| `resources` | `WorkerResources` | new `WorkerResources()` | Requested resource limits. |
| `cwd` | `Any` | `None` | Host-projected working-directory declaration. |
| `env_delta` | `Mapping[str, str | None]` | empty immutable mapping | Variables to set or remove. |
| `readonly` | `bool` | `False` | Read-only declaration forwarded to the supervisor. |
| `unmanaged` | `bool` | `False` | Marks a worker not managed by an Environment. |
| `warm` | `bool` | `False` | Requests eager warming. |

**Raises**

: `ValueError` — `name` is empty, `max_concurrency < 1`, or a non-`None` `max_calls < 1`.

```python
spec = omp.WorkerSpec(
    name="parser",
    site=omp.Site.LOCAL,
    idle_ttl=omp.Duration("2m"),
    resources=omp.WorkerResources(memory_bytes=512 * 1024 * 1024),
)
omp.workers.declare(spec)
```

### `omp.placement.WorkerInfo`

```python
@dataclass(frozen=True, slots=True)
class WorkerInfo:
    name: str
    generation: int
    state: WorkerState
    site: Site
    pid: int | None = None
    spawned_at_ms: int = 0
    last_call_at_ms: int | None = None
    calls: int = 0
    in_flight: int = 0
    code_cached: int = 0
    enforced: frozenset[str] = frozenset()
    fault: str | None = None
```

Provides a generation-fenced observation returned by worker administration calls.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `name` | `str` | required | Declared worker name. |
| `generation` | `int` | required | Supervisor generation number. |
| `state` | `WorkerState` | required | Current lifecycle state. |
| `site` | `Site` | required | Resolved process site. |
| `pid` | `int | None` | `None` | Process identifier when available. |
| `spawned_at_ms` | `int` | `0` | Spawn time in epoch milliseconds. |
| `last_call_at_ms` | `int | None` | `None` | Last call time in epoch milliseconds. |
| `calls` | `int` | `0` | Calls recorded for this generation. |
| `in_flight` | `int` | `0` | Calls currently running. |
| `code_cached` | `int` | `0` | Cached code count reported by the supervisor. |
| `enforced` | `frozenset[str]` | empty | Names of resource limits actually enforced. |
| `fault` | `str | None` | `None` | Failure detail, when supplied. |

### `omp.placement.Spill`

```python
@dataclass(frozen=True, slots=True)
class Spill:
    value: bytes
    media_type: str = "application/octet-stream"
```

Marks result bytes for Environment-side out-of-band blob storage.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `value` | `bytes` | required | Result buffer to spill. |
| `media_type` | `str` | `"application/octet-stream"` | Media type attached to the buffer. |

```python
def render_report() -> omp.Spill:
    return omp.Spill(b"<h1>Report</h1>", media_type="text/html")
```

## Worker handles and namespace

### `omp.placement.WorkerHandle`

```python
class WorkerHandle:
    def __init__(
        self,
        name: str,
        generation: int = 0,
        site: Site = Site.ENV,
    ) -> None: ...

    async def state(self) -> WorkerState: ...

    async def info(self) -> WorkerInfo: ...

    async def call(
        self, function: Callable[..., _T], /, *args: Any, **kwargs: Any
    ) -> _T: ...

    async def map(
        self,
        function: Callable[[_T], Any],
        values: Iterable[_T],
        *,
        concurrency: int | None = None,
    ) -> list[Any]: ...

    async def warm(self) -> None: ...

    async def stop(self, *, grace: Duration = Duration("5s")) -> None: ...

    def session(self) -> _WorkerSession: ...
```

Binds calls to one named worker generation. The public attributes are `name`, `generation`, and `site`.

`state()` returns `FAILED` when the host is disconnected, the control bridge is not installed, or the worker is unavailable. `info()` instead returns the complete observation or raises. `call()` opens a generation-fenced raw session and runs the blocking remote call in a thread.

`map()` currently evaluates values **serially and in input order**. Its `concurrency` parameter is validated but reserved; it does not create parallel calls in this implementation.

`warm()` asks the supervisor to reach readiness and raises `WorkerEvicted` if it observes `DRAINING` or `EVICTED`. `stop()` is idempotent across disconnected, unwired, unavailable, and already-evicted states. `session()` returns an asynchronous context manager whose yielded `omp_remote.Session` has blocking methods.

**Parameters**

: **`function`** (`Callable`) — Function executed by the remote session.
: **`args`**, **`kwargs`** — Values passed across the worker boundary.
: **`values`** (`Iterable[_T]`) — Inputs for `map()`.
: **`concurrency`** (`int | None`) — Reserved positive concurrency request.
: **`grace`** (`omp.Duration`) — Drain grace for `stop()`.

**Returns**

: `state()` returns `WorkerState`; `info()` returns `WorkerInfo`; `call()` returns the remote result; `map()` returns an ordered list; `session()` returns `_WorkerSession`.

**Raises**

: `ValueError` — `map(concurrency=...)` receives a value below one.
: `WorkerEvicted` — The bound generation is stale or draining.
: `WorkerUnavailable` — Worker administration or a remote call fails.
: `TypeError` — The supervisor returns malformed data.

```python
worker = await omp.workers.get("index")
result = await worker.call(search_index, "Placement")
status = await worker.info()
```

### `omp.placement.workers`

```python
workers: _Workers

workers.RESULT_SPILL_BYTES: Final[int] = 256 * 1024
workers.DEFAULT_IDLE_TTL: Final[Duration] = Duration("7m")
workers.MAX_CONCURRENT_SPAWNS: Final[int] = 4

def workers.declare(spec: WorkerSpec) -> None: ...
async def workers.get(name: str) -> WorkerHandle: ...
async def workers.list() -> list[WorkerInfo]: ...
async def workers.evict(
    name: str, *, grace: Duration = Duration("5s")
) -> bool: ...
async def workers.restart(
    name: str, *, grace: Duration = Duration("5s")
) -> WorkerInfo: ...
```

Provides the declaration table and host-authoritative worker namespace.

`declare()` records a `WorkerSpec` in the import-time registry; it does not perform control I/O. `get()` limits simultaneous cold resolutions to four, requires a `READY` generation, and returns a generation-fenced handle. `list()` returns an empty list when the host is disconnected, unwired, or unavailable. `evict()` likewise returns `False` for those conditions. `restart()` wraps any failure as `WorkerUnavailable`.

**Parameters**

: **`spec`** (`WorkerSpec`) — Worker declaration recorded during import.
: **`name`** (`str`) — Declared worker name.
: **`grace`** (`omp.Duration`) — Drain grace sent to the supervisor.

**Returns**

: `declare()` returns `None`; `get()` returns `WorkerHandle`; `list()` returns observations; `evict()` returns whether a generation was evicted; `restart()` returns the replacement generation's `WorkerInfo`.

**Raises**

: `TypeError` — `declare()` receives anything other than `WorkerSpec`, or a supervisor response has the wrong shape.
: `ValueError` — `get()` receives an empty name.
: `WorkerEvicted` — The supervisor resolves a retired generation.
: `WorkerUnavailable` — A generation cannot become ready or restart.
: `omp.NotWiredError` — A non-fail-open operation runs without a control backend.

```python
workers = await omp.workers.list()
for info in workers:
    print(info.name, info.generation, info.state)
```

## Exceptions and constants

### `omp.placement.WorkerUnavailable`

```python
class WorkerUnavailable(PlacementError): ...
```

Signals that a requested named worker is not currently reachable.

### `omp.placement.WorkerEvicted`

```python
class WorkerEvicted(PlacementError): ...
```

Signals that a handle refers to a draining, retired, or mismatched generation.

### `omp.placement.ShipError`

```python
class ShipError(PlacementError): ...
```

Signals failure while shipping code to a worker.

### `omp.placement.BoundaryError`

```python
class BoundaryError(PlacementError): ...
```

Signals that a value or capability cannot cross the selected placement boundary.

### `omp.placement.worker_state`

```python
worker_state = "worker_state"
```

Provides the canonical event name for worker lifecycle observations.

### `omp.placement.MAX_WORKERS`

```python
MAX_WORKERS = 8
```

Defines the public named-worker limit constant.
