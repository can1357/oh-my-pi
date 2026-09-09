# `omp.agents`

Use `omp.agents` when your extension needs to run or supervise subagents, communicate with another agent, control the interactive session, schedule work, or manage workspace snapshots. Agent operations are asynchronous CONTROL requests unless an entry says otherwise.

```python
import omp

handle = await omp.agents.spawn(
    omp.agents.SubagentSpec(task="Review the parser for correctness", max_depth=0)
)
result = await handle.wait()
print(result.status, result.text)
```

See [Agents and sessions](../guides/agents-and-sessions.md) for lifecycle recipes and [`omp.sessions`](omp.sessions.md) for historical session access.

## Errors

### `omp.agents.AgentsError`

```python
class AgentsError(OmpError)
```

Base exception for agent operations.

### `omp.agents.ModelSwitchDenied`

```python
class ModelSwitchDenied(AgentsError)
```

Raised when Core refuses to change the active interactive model.

### `omp.agents.SessionInjectionDenied`

```python
class SessionInjectionDenied(AgentsError)
```

Raised when `inject()` targets an unknown session or one not owned by the authenticated client.

### `omp.agents.SpawnDenied`

```python
class SpawnDenied(AgentsError):
    def __init__(self, reason: str, field: str | None = None) -> None
```

Raised before admission when a child declaration is invalid or unavailable. Constructing `SubagentSpec` also raises it for a blank task or invalid explicit name.

### `omp.agents.DepthExceeded`

```python
class DepthExceeded(AgentsError):
    def __init__(self, depth: int, max_depth: int) -> None
```

Raised when the current tree depth has reached its ceiling.

### `omp.agents.ConcurrencyExhausted`

```python
class ConcurrencyExhausted(AgentsError):
    def __init__(
        self, running: int, queued: int, max_concurrency: int
    ) -> None
```

Raised when both running capacity and queued admission capacity are exhausted.

### `omp.agents.AgentGone`

```python
class AgentGone(AgentsError):
    def __init__(
        self, ref: str, status: AgentStatus, transcript_url: str
    ) -> None
```

Raised when an operation needs a live agent but the addressed agent is terminal or tombstoned. Use `transcript_url` to inspect its durable history.

### `omp.agents.RewindPending`

```python
class RewindPending(AgentsError):
    def __init__(self, turn_id: str) -> None
```

Raised when `rewind()` reaches a durable turn that has no terminal receipt yet.

### `omp.agents.SnapshotUnsupported`

```python
class SnapshotUnsupported(AgentsError):
    def __init__(
        self, capability: str = "env:workspace.snapshot"
    ) -> None
```

Raised when the bound environment cannot snapshot its workspace.

### `omp.agents.ScheduleRejected`

```python
class ScheduleRejected(AgentsError):
    def __init__(self, reason: str, field: str | None = None) -> None
```

Raised when a durable schedule declaration is invalid.

### `omp.agents.CompletionFailed`

```python
class CompletionFailed(AgentsError):
    def __init__(self, reason: str, raw: str | None, usage: Usage) -> None
```

Raised when `completion()` cannot produce an accepted result and you did not supply `default`.

### `omp.agents.PolicyDenied`

```python
@dataclass(frozen=True, slots=True)
class PolicyDenied(OmpError):
    reason: str
    code: str
    decision_id: str
    rules: tuple[RuleRef, ...]
```

Re-export of [`omp.policy.PolicyDenied`](omp.policy.md). Agent operations surface it when policy or a grant denies the request.
| Field | Meaning |
|---|---|
| `reason` | Human-readable denial reason. |
| `code` | Stable denial code. |
| `decision_id` | Policy decision identifier. |
| `rules` | Rules contributing to the denial. |

## Usage and one-shot completions

### `omp.agents.Usage`

```python
@dataclass(frozen=True, slots=True)
class Usage:
    input_tokens: int = 0
    cached_input_tokens: int = 0
    output_tokens: int = 0
    reasoning_tokens: int = 0
    cache_write_tokens: int = 0
    requests: int = 0
    cost_usd: float = 0.0
    wall: Duration = Duration("0s")
```

Usage attributed to one agent node or completion.

| Field | Type | Default | Meaning |
|---|---|---:|---|
| `input_tokens` | `int` | `0` | Uncached input tokens. |
| `cached_input_tokens` | `int` | `0` | Input served from cache. |
| `output_tokens` | `int` | `0` | Generated output tokens. |
| `reasoning_tokens` | `int` | `0` | Reasoning tokens. |
| `cache_write_tokens` | `int` | `0` | Tokens written to cache. |
| `requests` | `int` | `0` | Provider requests. |
| `cost_usd` | `float` | `0.0` | Attributed cost in USD. |
| `wall` | `Duration` | `Duration("0s")` | Elapsed wall time. |

### `omp.agents.Completion`

```python
@dataclass(frozen=True, slots=True)
class Completion:
    text: str
    choice: str | None
    data: object | None
    usage: Usage
    model: str
    fell_back: bool = False
    fault: object | None = None
```

Settled output from one completion request. `choice` is populated for `choices=`, `data` for `schema=`, and `fell_back` records use of your `default`.

### `omp.agents.completion`

```python
async def completion(
    prompt: str | Sequence[TextPart | BlobPart],
    *,
    role: str = "smol",
    system: str | None = None,
    choices: Sequence[str] | None = None,
    schema: Mapping[str, object] | None = None,
    default: object = _DEFAULT,
    scope: Literal["turn", "session"] = "turn",
    context: Literal["none", "thread"] = "none",
    max_output_tokens: int | None = None,
    deadline: Duration = Duration("10s"),
    labels: Mapping[str, str] | None = None,
) -> Completion
```

Runs one budgeted, non-streaming completion.

**Parameters**

- `prompt`: Text or typed text/blob parts. Thread-context calls accept plain text only.
- `role`: Stateless model role selector.
- `system`: Optional stateless system instruction.
- `choices`: Ordered accepted strings; mutually exclusive with `schema`.
- `schema`: JSON schema for structured output.
- `default`: Caller-chosen fallback. Omitting it permits `CompletionFailed`.
- `scope`: Cancellation lifetime: the current turn or current session.
- `context`: `"none"` for stateless inference; `"thread"` for a non-persisted side-channel turn over the live conversation.
- `max_output_tokens`: Stateless output ceiling.
- `deadline`: Request deadline.
- `labels`: Attribution labels.

**Returns**: A settled `Completion`.

**Raises**: `ValueError` for incompatible options; `TypeError` for invalid prompt parts; `CompletionFailed` when no accepted result and no default exists.

```python
answer = await omp.agents.completion(
    "Classify this release note",
    choices=("breaking", "compatible"),
    default="breaking",
)
```

## Continuations

### `omp.agents.Continue`

```python
@dataclass(frozen=True, slots=True)
class Continue:
    prompt: str
    visible: bool = False
    role: Literal["user", "system"] = "system"
    label: str | None = None
    collapse_prior: bool = True
```

Declines settlement by supplying the next continuation item. Return it from the settled-boundary hook.

### `omp.agents.Settle`

```python
@dataclass(frozen=True, slots=True)
class Settle:
    pass
```

Explicitly accepts settlement without another turn.

### `omp.agents.ContinuationPolicy`

```python
@dataclass(frozen=True, slots=True)
class ContinuationPolicy:
    max_consecutive: int = DEFAULT_CONTINUATION_CAP
    max_total: int | None = None
    min_interval: Duration = Duration("0s")
    on_exhausted: Literal["settle", "notify"] = "notify"
```

Sets one extension's recursive continuation limits.

### `omp.agents.ContinuationLedger`

```python
@dataclass(frozen=True, slots=True)
class ContinuationLedger:
    consecutive: int
    total: int
    cap: int
    last_ms: int
    refusals: int
    owner: str | None = None
```

Durable projection of the current continuation budget.

### `omp.agents.LoopSignal`

```python
@dataclass(frozen=True, slots=True)
class LoopSignal:
    repeats: int
    digest: str
    no_progress_turns: int
    empty_output_retries: int
    stalled: bool
```

Core-owned repetition and progress facts for an autonomous loop.

### `omp.agents.continuations`

```python
async def continuations() -> ContinuationLedger
```

Returns the current recursive continuation ledger.

### `omp.agents.set_continuation_policy`

```python
async def set_continuation_policy(policy: ContinuationPolicy) -> None
```

Sets this extension's continuation policy.

**Parameters**: `policy` must be a `ContinuationPolicy`.

**Raises**: `TypeError` for another value; `PolicyDenied` when the extension lacks authority.

### `omp.agents.loop_signal`

```python
async def loop_signal() -> LoopSignal
```

Returns Core's current conservative loop-stall signal.

## Child declarations

### `omp.agents.DeliveryMode`

```python
class DeliveryMode(StrEnum):
    ASIDE = "aside"
    STEER = "steer"
    NEXT_TURN = "next_turn"
```

Selects when an injected item becomes visible: a non-interrupting in-flight boundary, immediate steering, or the next turn.

### `omp.agents.Isolation`

```python
class Isolation(StrEnum):
    CLEAN = "clean"
    FORK = "fork"
    FILTERED = "filtered"
```

Selects how much parent conversation a child inherits. `CLEAN` inherits none; `FORK` takes the parent projection; `FILTERED` applies thread projection before inheritance.

### `omp.agents.ThinkingLevel`

```python
class ThinkingLevel(StrEnum):
    OFF = "off"
    LO = "lo"
    MED = "med"
    HI = "hi"
```

Portable coarse reasoning level requested for a child.

### `omp.agents.MergeMode`

```python
class MergeMode(StrEnum):
    NONE = "none"
    BRANCH = "branch"
    PATCH = "patch"
```

Selects the disposition of a worktree-isolated child's changes.

### `omp.agents.Budget`

```python
@dataclass(frozen=True, slots=True)
class Budget:
    max_requests: int | None = None
    max_input_tokens: int | None = None
    max_output_tokens: int | None = None
    max_usd: float | None = None
    max_wall: Duration | None = None
```

Hard resource ceilings for a child and its subtree.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `max_requests` | `int | None` | `None` | Provider request ceiling. |
| `max_input_tokens` | `int | None` | `None` | Input-token ceiling. |
| `max_output_tokens` | `int | None` | `None` | Output-token ceiling. |
| `max_usd` | `float | None` | `None` | Cost ceiling. |
| `max_wall` | `Duration | None` | `None` | Wall-time ceiling. |

### `omp.agents.SubagentSpec`

```python
@dataclass(frozen=True, slots=True)
class SubagentSpec:
    task: str
    name: str | None = None
    agent: str = "task"
    system_prompt: str | None = None
    model: str | None = None
    on_model_unavailable: Literal["fail", "parent"] = "fail"
    thinking: ThinkingLevel | None = None
    allowed_devices: frozenset[str] | None = None
    disallowed_devices: frozenset[str] = frozenset()
    isolation: Isolation = Isolation.CLEAN
    max_depth: int = 1
    cwd: EnvPath | None = None
    worktree: bool = False
    merge: MergeMode = MergeMode.NONE
    env_vars: Mapping[str, str] = field(default_factory=dict)
    background: bool = False
    output_schema: Mapping[str, object] | None = None
    schema_mode: Literal["permissive", "strict"] = "permissive"
    deadline: Duration | None = None
    request_budget: int | None = None
    budget: Budget | None = None
    labels: Mapping[str, str] = field(default_factory=dict)
```

Complete frozen declaration of one child.

| Field | Meaning |
|---|---|
| `task` | Non-empty assignment delivered to the child. |
| `name` | Optional addressable name matching `^[A-Za-z][A-Za-z0-9_]{0,31}$`. |
| `agent` | Agent definition; defaults to `"task"`. |
| `system_prompt` | Additional child system instruction. |
| `model` / `on_model_unavailable` | Requested model and explicit fail-or-parent fallback behavior. |
| `thinking` | Portable reasoning request. |
| `allowed_devices` / `disallowed_devices` | Child device capability filter. |
| `isolation` | Parent-context inheritance. |
| `max_depth` | Maximum depth below the child. |
| `cwd` | Typed environment working directory. |
| `worktree` / `merge` | Workspace isolation and change disposition. |
| `env_vars` | Child environment variables. |
| `background` | Whether Core, rather than the caller's scope, owns continued execution. |
| `output_schema` / `schema_mode` | Structured-output contract and enforcement mode. |
| `deadline` / `request_budget` / `budget` | Time, soft request, and hard subtree limits. |
| `labels` | Attribution metadata. |

**Raises**: `SpawnDenied` at construction for a blank task or invalid explicit name.

### `omp.agents.RunStatus`

```python
class RunStatus(StrEnum):
    PENDING = "pending"
    RUNNING = "running"
    SETTLED = "settled"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"
    EXHAUSTED = "exhausted"

    @property
    def terminal(self) -> bool
```

Lifecycle state of one supervised child run. `terminal` is true for `COMPLETED`, `FAILED`, `CANCELLED`, and `EXHAUSTED`.

### `omp.agents.Progress`

```python
@dataclass(frozen=True, slots=True)
class Progress:
    status: RunStatus
    turns: int
    requests: int
    tool_calls: int
    context_tokens: int
    context_window: int
    usage: Usage
    activity: str
    model: str
    last_activity_ms: int
```

Sanitized progress snapshot suitable for rendering.

### `omp.agents.WorktreeOutcome`

```python
@dataclass(frozen=True, slots=True)
class WorktreeOutcome:
    path: EnvPath
    merge: MergeMode
    applied: bool
    branch: str | None
    patch_url: ArtifactUrl | None
    conflicts: tuple[str, ...]
```

Reports the disposition and recovery locations for a child's worktree.

### `omp.agents.SubagentResult`

```python
@dataclass(frozen=True, slots=True)
class SubagentResult:
    run_id: str
    session_id: str
    name: str
    status: RunStatus
    text: str
    data: object | None
    fault: Fault | None
    usage: Usage
    subtree_usage: Usage
    turns: int
    model: str
    model_fallback: bool
    warnings: tuple[str, ...]
    output_url: AgentUrl
    transcript_url: HistoryUrl
    worktree: WorktreeOutcome | None
```

Terminal child result plus durable output and transcript locations.

### `omp.agents.SubagentHandle`

```python
class SubagentHandle:
    run_id: str
    session_id: str
    name: str
    agent: str
    depth: int
    effective_max_depth: int
    spec: SubagentSpec
    worktree_path: EnvPath | None
    output_url: AgentUrl
    transcript_url: HistoryUrl

    async def status(self) -> RunStatus
    async def progress(self) -> Progress
    async def steer(self, text: str, *, mode: DeliveryMode = DeliveryMode.ASIDE) -> Receipt
    async def cancel(
        self,
        *,
        reason: str = "cancelled by extension",
        grace: Duration = STEER_GRACE,
    ) -> None
    async def wait(self, *, timeout: Duration | None = None) -> SubagentResult
    async def result(self) -> SubagentResult | None
    async def release(self) -> None
```

Live CONTROL handle over a supervised child.

- `status()` and `progress()` read current state.
- `steer()` posts a non-empty message and returns its delivery receipt.
- `cancel()` requests structural cancellation.
- `wait()` blocks until a terminal result; a host timeout is translated to `asyncio.TimeoutError` without cancelling the child.
- `result()` returns a terminal result if available, otherwise `None`.
- `release()` transfers structural ownership away from the caller.

Used as an async context manager, the handle cancels on exit unless you called `release()`.

```python
async with await omp.agents.spawn(omp.agents.SubagentSpec(task="Check types")) as child:
    await child.steer("Focus on public APIs")
    result = await child.wait()
```

### `omp.agents.spawn`

```python
async def spawn(spec: SubagentSpec) -> SubagentHandle
```

Admits and starts one child, returning as soon as Core creates the handle.

**Parameters**: `spec` is the complete child declaration.

**Returns**: A live `SubagentHandle`.

**Raises**: `TypeError`, `SpawnDenied`, `DepthExceeded`, `ConcurrencyExhausted`, or `PolicyDenied`.

### `omp.agents.spawn_all`

```python
async def spawn_all(specs: Sequence[SubagentSpec]) -> _builtins.list[SubagentHandle]
```

Atomically admits and starts an ordered batch.

**Parameters**: `specs` must be a non-string sequence containing only `SubagentSpec` values.

**Returns**: Handles in input order.

**Raises**: `TypeError` for a malformed sequence and the same admission errors as `spawn()`.

### `omp.agents.AgentKind`

```python
class AgentKind(StrEnum):
    MAIN = "main"
    SUB = "sub"
    ADVISOR = "advisor"
```

Kind represented by a roster row.

### `omp.agents.AgentStatus`

```python
class AgentStatus(StrEnum):
    RUNNING = "running"
    IDLE = "idle"
    PARKED = "parked"
    ABORTED = "aborted"
```

Session-lifecycle status used by the roster. This differs from `RunStatus`, which describes one run.

### `omp.agents.AgentRef`

```python
@dataclass(frozen=True, slots=True)
class AgentRef:
    id: str
    name: str
    kind: AgentKind
    status: AgentStatus
    agent: str
    parent: str | None
    depth: int
    activity: str
    last_activity_ms: int
    usage: Usage
    output_url: AgentUrl
    transcript_url: HistoryUrl
```

Addressable, body-free roster snapshot.

### `omp.agents.SpawnLimits`

```python
@dataclass(frozen=True, slots=True)
class SpawnLimits:
    max_depth: int
    depth: int
    max_concurrency: int
    running: int
    queued: int
    continuation_cap: int
    continuations_used: int
    spawn_allowed: bool
```

Snapshot of every reported ceiling that can refuse another spawn.

### `omp.agents.get`

```python
async def get(ref: str) -> SubagentHandle
```

Resolves a non-empty agent reference to a live handle.

**Raises**: `ValueError` for an empty reference or `AgentGone` when Core cannot produce a live handle.

### `omp.agents.revive`

```python
async def revive(ref: str) -> SubagentHandle
```

Cold-revives a parked child session and returns a new run handle.

### `omp.agents.limits`

```python
async def limits() -> SpawnLimits
```

Reads current child-spawn ceilings and updates the module-level `depth` value.

### `omp.agents.list`

```python
async def list(
    *,
    kind: AgentKind | None = None,
    status: AgentStatus | None = None,
    include_parked: bool = True,
) -> _builtins.list[AgentRef]
```

Lists visible agents in tree order, optionally filtered by kind and status.

### `omp.agents.depth`

```python
depth: int = 0
```

Cached depth of the agent served by this host. `limits()` refreshes it from Core.

## Messaging and session control

### `omp.agents.Receipt`

```python
class Receipt(StrEnum):
    DELIVERED = "delivered"
    WOKEN = "woken"
    REVIVED = "revived"
    BUFFERED = "buffered"
    FAILED = "failed"
```

Disposition of an inter-agent message.

### `omp.agents.Message`

```python
@dataclass(frozen=True, slots=True)
class Message:
    id: str
    from_: str
    to: str
    text: str
    mode: DeliveryMode
    reply_to: str | None
    sent_ms: int
    session_id: str
```

One typed mailbox message.

### `omp.agents.send`

```python
async def send(
    to: str,
    text: str,
    *,
    mode: DeliveryMode = DeliveryMode.ASIDE,
    reply_to: str | None = None,
    await_reply: bool = False,
    timeout: Duration = Duration("60s"),
) -> Receipt | Message
```

Sends a message to an addressable agent.

**Parameters**: `to` is a non-empty address; `text` is the message; `mode` chooses delivery timing; `reply_to` correlates a response; `await_reply` waits for a correlated message; `timeout` bounds that wait.

**Returns**: A `Receipt`, or a `Message` when `await_reply=True`.

**Raises**: `ValueError` for an empty recipient; `asyncio.TimeoutError` when a requested reply does not arrive.

### `omp.agents.broadcast`

```python
async def broadcast(
    text: str,
    *,
    scope: Literal["session", "project"] = "session",
    mode: DeliveryMode = DeliveryMode.ASIDE,
) -> dict[str, Receipt]
```

Sends a message to every agent resolved in the selected scope and returns one receipt per peer.

### `omp.agents.inbox`

```python
async def inbox(*, peek: bool = False, limit: int | None = None) -> _builtins.list[Message]
```

Drains buffered messages, or inspects them without draining when `peek=True`.

### `omp.agents.wait_for`

```python
async def wait_for(
    *,
    sender: str | None = None,
    reply_to: str | None = None,
    timeout: Duration = Duration("60s"),
) -> Message | None
```

Waits for a mailbox message matching the optional sender and reply correlation. Returns `None` when Core reports no match before the wait ends.

### `omp.agents.peers`

```python
async def peers(
    *, scope: Literal["session", "project"] = "session"
) -> _builtins.list[AgentRef]
```

Lists messageable peers in the selected scope.

### `omp.agents.set_model`

```python
async def set_model(model: str, *, thinking: str | None = None) -> ModelRef
```

Switches the active interactive session model for subsequent turns.

**Raises**: `TypeError` for an empty/non-string model or non-string `thinking`; `ModelSwitchDenied` when Core refuses the transition.

### `omp.agents.abort`

```python
async def abort() -> None
```

Requests interruption of the main agent's active run, if any.

### `omp.agents.shutdown`

```python
async def shutdown(reason: str = "") -> None
```

Requests graceful shutdown of the current interactive session.

### `omp.agents.reload_extensions`

```python
async def reload_extensions() -> None
```

Requests supervised hot reload of extension hosts.

### `omp.agents.is_idle`

```python
async def is_idle() -> bool
```

Returns whether the main agent currently has no active run.

### `omp.agents.wait_for_idle`

```python
async def wait_for_idle() -> None
```

Waits until the main agent has no active run.

### `omp.agents.pending_messages`

```python
async def pending_messages() -> int
```

Returns the non-negative number of messages queued for the main agent.

### `omp.agents.inject`

```python
async def inject(
    prompt: str,
    *,
    mode: DeliveryMode = DeliveryMode.NEXT_TURN,
    visible: bool = False,
    role: Literal["user", "system"] = "system",
    session: str | None = None,
) -> Receipt
```

Injects an out-of-band item into the current session or an explicitly targeted owned session.

**Returns**: The delivery `Receipt`.

**Raises**: `SessionInjectionDenied` for an unknown or foreign targeted session.

## Workspace rewind and snapshots

### `omp.agents.RestoreScope`

```python
class RestoreScope(StrEnum):
    THREAD = "thread"
    WORKSPACE = "workspace"
    BOTH = "both"
```

Selects which state a rewind affects.

### `omp.agents.RewindTarget`

```python
@dataclass(frozen=True, slots=True)
class RewindTarget:
    event: int
    keep: int | None
    text: str
    ts_ms: int
    snapshot_id: str | None
```

Selectable live user-message point in the journal.

### `omp.agents.Conflict`

```python
@dataclass(frozen=True, slots=True)
class Conflict:
    path: EnvPath
    reason: Literal["open_lease", "modified_after_snapshot", "outside_root", "permission"]
    lease_holder: str | None
```

Structured reason a workspace generation cannot be restored.

### `omp.agents.RestoreReport`

```python
@dataclass(frozen=True, slots=True)
class RestoreReport:
    from_generation: int
    to_generation: int
    written: int
    deleted: int
    unchanged: int
    conflicts: tuple[Conflict, ...]
    undo_snapshot_id: str
    dry_run: bool
```

Reports workspace restore effects and the snapshot that can undo them.

### `omp.agents.RewindReport`

```python
@dataclass(frozen=True, slots=True)
class RewindReport:
    head: int
    dropped_items: int
    scope: RestoreScope
    restore: RestoreReport | None
    dry_run: bool
```

Reports the atomic thread and optional workspace rewind.

### `omp.agents.Snapshot`

```python
@dataclass(frozen=True, slots=True)
class Snapshot:
    id: str
    generation: int
    label: str | None
    created_ms: int
    root: WorkspaceUri
    parent: str | None
    tree_hash: str
    entry_count: int
    bytes: int
    partial: bool
```

Content-addressed workspace generation.

### `omp.agents.rewind_targets`

```python
async def rewind_targets() -> _builtins.list[RewindTarget]
```

Lists live user-message rewind targets oldest first.

### `omp.agents.rewind`

```python
async def rewind(
    to: int | None,
    *,
    scope: RestoreScope = RestoreScope.THREAD,
    snapshot_id: str | None = None,
    dry_run: bool = False,
) -> RewindReport
```

Atomically rewinds thread state and, when requested, workspace state. `to=None` selects the transcript root; `dry_run=True` reports without committing.

**Raises**: `RewindPending` when an affected turn lacks its receipt, or `SnapshotUnsupported` when workspace state is requested without the capability.

### `omp.agents.snapshot`

```python
async def snapshot(
    *, label: str | None = None, paths: Sequence[str] | None = None
) -> Snapshot
```

Captures a content-addressed workspace generation. Supplying `paths` produces a partial snapshot.

### `omp.agents.snapshots`

```python
async def snapshots(*, limit: int = 50) -> _builtins.list[Snapshot]
```

Lists workspace snapshots newest first.

**Raises**: `ValueError` when `limit` is negative.

### `omp.agents.restore`

```python
async def restore(
    snapshot_id: str,
    *,
    paths: Sequence[str] | None = None,
    dry_run: bool = False,
) -> RestoreReport
```

Restores all or selected files from a workspace generation.

**Raises**: `ValueError` for an empty snapshot id; `SnapshotUnsupported` when the environment lacks support.

## Durable schedules

### `omp.agents.MissedRunPolicy`

```python
class MissedRunPolicy(StrEnum):
    SKIP = "skip"
    COALESCE = "coalesce"
    BACKFILL = "backfill"
```

Recovery policy for firings missed while the scheduler was unavailable.

### `omp.agents.ScheduleScope`

```python
class ScheduleScope(StrEnum):
    SESSION = "session"
    PROJECT = "project"
```

Durability scope of a schedule declaration.

### `omp.agents.UpgradePolicy`

```python
class UpgradePolicy(StrEnum):
    PINNED = "pinned"
    AUTO = "auto"
```

Selects the extension artifact used by future firings.

### `omp.agents.Cron`

```python
@dataclass(frozen=True, slots=True)
class Cron:
    expr: str
    tz: str = "UTC"
```

Cron trigger evaluated in the named IANA timezone.

### `omp.agents.Every`

```python
@dataclass(frozen=True, slots=True)
class Every:
    interval: Duration
    jitter: Duration = Duration("0s")
    align: bool = False
```

Fixed-interval trigger with optional jitter and alignment.

### `omp.agents.At`

```python
@dataclass(frozen=True, slots=True)
class At:
    epoch_ms: int
```

One-shot trigger at an absolute Unix epoch millisecond.

### `omp.agents.AfterIdle`

```python
@dataclass(frozen=True, slots=True)
class AfterIdle:
    idle: Duration
```

Trigger armed after the agent remains settled for the requested duration.

### `omp.agents.Trigger`

```python
Trigger: TypeAlias = Cron | Every | At | AfterIdle
```

Union of accepted schedule trigger declarations.

### `omp.agents.Inject`

```python
@dataclass(frozen=True, slots=True)
class Inject:
    prompt: str
    mode: DeliveryMode = DeliveryMode.NEXT_TURN
    visible: bool = False
```

Scheduled delivery that injects a prompt into the declaring agent.

### `omp.agents.Spawn`

```python
@dataclass(frozen=True, slots=True)
class Spawn:
    spec: SubagentSpec
```

Scheduled delivery that spawns a supervised child. Serialization forces the child spec's `background` value to true.

### `omp.agents.Delivery`

```python
Delivery: TypeAlias = Inject | Spawn
```

Union of accepted schedule delivery declarations.

### `omp.agents.ScheduleBudget`

```python
@dataclass(frozen=True, slots=True)
class ScheduleBudget:
    max_usd_per_firing: float | None = None
    max_usd_per_window: float | None = None
    window: Duration = Duration("720h")
    max_requests_per_firing: int | None = None
```

Hard cost and request ceilings for a durable schedule.

### `omp.agents.Schedule`

```python
@dataclass(frozen=True, slots=True)
class Schedule:
    id: str
    name: str
    trigger: Trigger
    delivery: Delivery
    scope: ScheduleScope
    enabled: bool
    owner: str
    principal: str
    artifact_digest: str
    upgrade: UpgradePolicy
    missed: MissedRunPolicy
    budget: ScheduleBudget | None
    overlap: Literal["skip", "queue"]
    created_ms: int
    next_ms: int | None
    last_ms: int | None
    fire_count: int
    miss_count: int
```

Frozen projection of one durable schedule.

### `omp.agents.Firing`

```python
@dataclass(frozen=True, slots=True)
class Firing:
    schedule_id: str
    idempotency_key: str
    at_ms: int
    late_ms: int
    outcome: Literal["injected", "spawned", "skipped", "failed", "duplicate", "budget_refused"]
    artifact_digest: str
    principal: str
    run_id: str | None
    detail: str | None
```

Durable outcome of one schedule firing.

### `omp.agents.ScheduleHandle`

```python
class ScheduleHandle:
    id: str
    name: str

    async def pause(self) -> None
    async def resume(self) -> None
    async def delete(self) -> None
    async def fire_now(self) -> Receipt
    async def info(self) -> Schedule
    async def history(self, limit: int = 20) -> _builtins.list[Firing]
```

Live identity and control surface for a durable schedule. The methods pause, resume, delete, manually fire, inspect, or read firing history for that stable id.

### `omp.agents.schedule`

```python
async def schedule(
    name: str,
    trigger: Trigger,
    delivery: Delivery,
    *,
    scope: ScheduleScope = ScheduleScope.SESSION,
    missed: MissedRunPolicy = MissedRunPolicy.COALESCE,
    overlap: Literal["skip", "queue"] = "skip",
    upgrade: UpgradePolicy = UpgradePolicy.PINNED,
    budget: ScheduleBudget | None = None,
) -> ScheduleHandle
```

Upserts a durable schedule by name and returns its handle.

**Raises**: `ScheduleRejected` for an invalid declaration and `PolicyDenied` when authority is missing.

```python
handle = await omp.agents.schedule(
    "audit-once",
    omp.agents.At(epoch_ms=1_800_000_000_000),
    omp.agents.Spawn(omp.agents.SubagentSpec(task="Audit the workspace", max_depth=0)),
)
```

### `omp.agents.schedules`

```python
async def schedules(
    *, scope: ScheduleScope | None = None, owner: str | None = None
) -> _builtins.list[Schedule]
```

Lists visible durable schedules, optionally filtered by scope and owner.

### `omp.agents.unschedule`

```python
async def unschedule(name_or_id: str) -> bool
```

Deletes a schedule by owner-local name or stable id. Returns false when none matched.

**Raises**: `ValueError` for an empty name or id.

## Host-local timers

### `omp.agents.TimerHandle`

```python
class TimerHandle:
    def cancel(self) -> None

    @property
    def active(self) -> bool
```

Cancellable handle for a host-local asynchronous timer. A callback exception cancels repetition and propagates through its task.

### `omp.agents.timer`

```python
def timer(
    delay: Duration,
    callback: Callable[[], Awaitable[None]],
    *,
    repeat: bool = False,
) -> TimerHandle
```

Schedules an async callback on the running event loop. It is not durable and does not survive host shutdown.

**Returns**: A `TimerHandle` immediately.

## Constants

### `omp.agents.DEFAULT_MAX_DEPTH`

```python
DEFAULT_MAX_DEPTH = 2
```

Default agent-tree depth ceiling.

### `omp.agents.DEFAULT_MAX_CONCURRENCY`

```python
DEFAULT_MAX_CONCURRENCY = 32
```

Default tree-wide child concurrency ceiling.

### `omp.agents.DEFAULT_CONTINUATION_CAP`

```python
DEFAULT_CONTINUATION_CAP = _limits.SETTLE_CONTINUATION_CAP
```

Default consecutive continuation cap.

### `omp.agents.MAILBOX_CAPACITY`

```python
MAILBOX_CAPACITY = 100
```

Published per-agent buffered mailbox capacity.

### `omp.agents.STEER_GRACE`

```python
STEER_GRACE = Duration("500ms")
```

Default grace passed to child cancellation.

### `omp.agents.MIN_SCHEDULE_INTERVAL`

```python
MIN_SCHEDULE_INTERVAL = Duration("30s")
```

Published minimum durable schedule interval.

### `omp.agents.MAX_BACKFILL`

```python
MAX_BACKFILL = 32
```

Published recovery backfill ceiling.

### `omp.agents.EMPTY_OUTPUT_RETRY_CAP`

```python
EMPTY_OUTPUT_RETRY_CAP = 3
```

Published empty-output retry ceiling.
## Data model field index

The signatures above are authoritative; these tables provide a compact field lookup for frozen result and declaration values not already tabulated at their entries.

| Dataclass | Fields |
|---|---|
| `Completion` | `text`, `choice`, `data`, `usage`, `model`, `fell_back=False`, `fault=None` |
| `Continue` | `prompt`, `visible=False`, `role="system"`, `label=None`, `collapse_prior=True` |
| `ContinuationPolicy` | `max_consecutive=DEFAULT_CONTINUATION_CAP`, `max_total=None`, `min_interval=Duration("0s")`, `on_exhausted="notify"` |
| `ContinuationLedger` | `consecutive`, `total`, `cap`, `last_ms`, `refusals`, `owner=None` |
| `LoopSignal` | `repeats`, `digest`, `no_progress_turns`, `empty_output_retries`, `stalled` |
| `Progress` | `status`, `turns`, `requests`, `tool_calls`, `context_tokens`, `context_window`, `usage`, `activity`, `model`, `last_activity_ms` |
| `WorktreeOutcome` | `path`, `merge`, `applied`, `branch`, `patch_url`, `conflicts` |
| `SubagentResult` | `run_id`, `session_id`, `name`, `status`, `text`, `data`, `fault`, `usage`, `subtree_usage`, `turns`, `model`, `model_fallback`, `warnings`, `output_url`, `transcript_url`, `worktree` |
| `AgentRef` | `id`, `name`, `kind`, `status`, `agent`, `parent`, `depth`, `activity`, `last_activity_ms`, `usage`, `output_url`, `transcript_url` |
| `SpawnLimits` | `max_depth`, `depth`, `max_concurrency`, `running`, `queued`, `continuation_cap`, `continuations_used`, `spawn_allowed` |
| `Message` | `id`, `from_`, `to`, `text`, `mode`, `reply_to`, `sent_ms`, `session_id` |
| `RewindTarget` | `event`, `keep`, `text`, `ts_ms`, `snapshot_id` |
| `Conflict` | `path`, `reason`, `lease_holder` |
| `RestoreReport` | `from_generation`, `to_generation`, `written`, `deleted`, `unchanged`, `conflicts`, `undo_snapshot_id`, `dry_run` |
| `RewindReport` | `head`, `dropped_items`, `scope`, `restore`, `dry_run` |
| `Snapshot` | `id`, `generation`, `label`, `created_ms`, `root`, `parent`, `tree_hash`, `entry_count`, `bytes`, `partial` |
| `Cron` | `expr`, `tz="UTC"` |
| `Every` | `interval`, `jitter=Duration("0s")`, `align=False` |
| `At` | `epoch_ms` |
| `AfterIdle` | `idle` |
| `Inject` | `prompt`, `mode=DeliveryMode.NEXT_TURN`, `visible=False` |
| `Spawn` | `spec` |
| `ScheduleBudget` | `max_usd_per_firing=None`, `max_usd_per_window=None`, `window=Duration("720h")`, `max_requests_per_firing=None` |
| `Schedule` | `id`, `name`, `trigger`, `delivery`, `scope`, `enabled`, `owner`, `principal`, `artifact_digest`, `upgrade`, `missed`, `budget`, `overlap`, `created_ms`, `next_ms`, `last_ms`, `fire_count`, `miss_count` |
| `Firing` | `schedule_id`, `idempotency_key`, `at_ms`, `late_ms`, `outcome`, `artifact_digest`, `principal`, `run_id`, `detail` |

## Enum member index

| Enum | Member | Wire value | Meaning |
|---|---|---|---|
| `DeliveryMode` | `ASIDE` | `"aside"` | Deliver at a non-interrupting aside boundary. |
| `DeliveryMode` | `STEER` | `"steer"` | Request immediate steering. |
| `DeliveryMode` | `NEXT_TURN` | `"next_turn"` | Queue for the next turn boundary. |
| `Isolation` | `CLEAN` | `"clean"` | Start without inherited parent conversation. |
| `Isolation` | `FORK` | `"fork"` | Fork the parent projection. |
| `Isolation` | `FILTERED` | `"filtered"` | Filter the parent projection before inheritance. |
| `ThinkingLevel` | `OFF` | `"off"` | Request no reasoning. |
| `ThinkingLevel` | `LO` | `"lo"` | Request low reasoning. |
| `ThinkingLevel` | `MED` | `"med"` | Request medium reasoning. |
| `ThinkingLevel` | `HI` | `"hi"` | Request high reasoning. |
| `MergeMode` | `NONE` | `"none"` | Do not request branch or patch disposition. |
| `MergeMode` | `BRANCH` | `"branch"` | Request branch disposition. |
| `MergeMode` | `PATCH` | `"patch"` | Request patch disposition. |
| `RunStatus` | `PENDING` | `"pending"` | Admitted but not running. |
| `RunStatus` | `RUNNING` | `"running"` | Work is active. |
| `RunStatus` | `SETTLED` | `"settled"` | Loop is settled but the run is not terminal. |
| `RunStatus` | `COMPLETED` | `"completed"` | Terminal successful completion. |
| `RunStatus` | `FAILED` | `"failed"` | Terminal failure. |
| `RunStatus` | `CANCELLED` | `"cancelled"` | Terminal cancellation. |
| `RunStatus` | `EXHAUSTED` | `"exhausted"` | Terminal resource exhaustion. |
| `AgentKind` | `MAIN` | `"main"` | Interactive main agent. |
| `AgentKind` | `SUB` | `"sub"` | Child task agent. |
| `AgentKind` | `ADVISOR` | `"advisor"` | Advisor agent. |
| `AgentStatus` | `RUNNING` | `"running"` | Session is running. |
| `AgentStatus` | `IDLE` | `"idle"` | Session is idle. |
| `AgentStatus` | `PARKED` | `"parked"` | Session is parked. |
| `AgentStatus` | `ABORTED` | `"aborted"` | Session is aborted. |
| `Receipt` | `DELIVERED` | `"delivered"` | Message was delivered. |
| `Receipt` | `WOKEN` | `"woken"` | Delivery woke the recipient. |
| `Receipt` | `REVIVED` | `"revived"` | Delivery revived the recipient. |
| `Receipt` | `BUFFERED` | `"buffered"` | Message was buffered. |
| `Receipt` | `FAILED` | `"failed"` | Delivery failed. |
| `RestoreScope` | `THREAD` | `"thread"` | Affect thread state. |
| `RestoreScope` | `WORKSPACE` | `"workspace"` | Affect workspace state. |
| `RestoreScope` | `BOTH` | `"both"` | Affect thread and workspace state. |
| `MissedRunPolicy` | `SKIP` | `"skip"` | Skip missed firings. |
| `MissedRunPolicy` | `COALESCE` | `"coalesce"` | Combine missed firings. |
| `MissedRunPolicy` | `BACKFILL` | `"backfill"` | Backfill missed firings. |
| `ScheduleScope` | `SESSION` | `"session"` | Scope durability to the session. |
| `ScheduleScope` | `PROJECT` | `"project"` | Scope durability to the project. |
| `UpgradePolicy` | `PINNED` | `"pinned"` | Keep the recorded artifact selection. |
| `UpgradePolicy` | `AUTO` | `"auto"` | Resolve the current artifact on future firings. |
