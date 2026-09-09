# Agents, sessions, journals, and context

Extensions often need more than one model call: delegate a bounded task, follow the child while it runs, inspect work from an earlier session, or add a small fact to the next model context. These APIs give you handles and immutable records instead of asking you to manage subprocesses or transcript files.

This guide connects four modules:

- [`omp.agents`](../reference/omp.agents.md) starts and supervises child agents.
- [`omp.sessions`](../reference/omp.sessions.md) indexes current and historical sessions.
- [`omp.journal`](../reference/omp.journal.md) writes and reads typed durable records in the current session.
- [`omp.context`](../reference/omp.context.md) projects the model's live context and defines bounded patches.

## Spawn a subagent and await its result

A child starts from a frozen `SubagentSpec`. Keep the assignment narrow and choose explicit limits for work initiated by extension code.

```python
import omp

async def review_parser() -> omp.agents.SubagentResult:
    spec = omp.agents.SubagentSpec(
        name="ParserReview",
        agent="reviewer",
        task=(
            "Review src/parser.py for correctness. "
            "Return concrete findings with line references."
        ),
        isolation=omp.agents.Isolation.CLEAN,
        max_depth=0,
        allowed_devices=frozenset(),
        budget=omp.agents.Budget(
            max_requests=6,
            max_output_tokens=8_000,
            max_wall=omp.Duration("5m"),
        ),
    )

    handle = await omp.agents.spawn(spec)
    return await handle.wait()
```

`spawn()` returns after Core admits the child and constructs its handle; it does not wait for the first turn. `wait()` returns only after the run reaches a terminal `RunStatus`. A timeout passed to `wait()` raises `asyncio.TimeoutError` but does not cancel the child.

Inspect both status and durable locations:

```python
result = await review_parser()

if result.status is omp.agents.RunStatus.COMPLETED:
    print(result.text)
else:
    print(result.fault)

print("output:", result.output_url)
print("transcript:", result.transcript_url)
print("subtree requests:", result.subtree_usage.requests)
```

> **Note** `COMPLETED` reports lifecycle completion, not independent validation of the child's claims.

### Choose conversation and workspace isolation separately

`SubagentSpec.isolation` controls inherited conversation:

| Mode | Child context |
|---|---|
| `Isolation.CLEAN` | Starts without the parent conversation. |
| `Isolation.FORK` | Inherits the parent projection. |
| `Isolation.FILTERED` | Inherits a projection after thread-projection handlers run. |

Workspace isolation uses different fields. Set `worktree=True` to request a worktree and select `MergeMode.NONE`, `BRANCH`, or `PATCH` for its disposition. Read `handle.worktree_path` while the child is live and `result.worktree` after settlement.

```python
spec = omp.agents.SubagentSpec(
    task="Apply the formatter migration in the isolated workspace.",
    worktree=True,
    merge=omp.agents.MergeMode.PATCH,
    max_depth=0,
)
```

Conversation isolation and workspace isolation are orthogonal: a clean child can share the workspace, while a forked child can work in a worktree.

### Set limits deliberately

`Budget` supplies hard ceilings for requests, input tokens, output tokens, USD cost, and wall time. `request_budget` is a separate optional field retained in the child spec. Read `await omp.agents.limits()` before presenting a spawn action when your UI needs current depth and concurrency availability.

```python
limits = await omp.agents.limits()
if not limits.spawn_allowed:
    return
```

`max_depth` limits the subtree below the child. A leaf task should use `max_depth=0`; `handle.effective_max_depth` tells you what Core accepted.

## Steer and supervise a live child

A `SubagentHandle` is an id-based control surface. It carries stable session/output locations and asks Core for changing state.

```python
handle = await omp.agents.spawn(
    omp.agents.SubagentSpec(
        task="Investigate the failing parser cases.",
        background=True,
    )
)

progress = await handle.progress()
print(progress.status, progress.activity)

receipt = await handle.steer(
    "Prioritize malformed UTF-8 inputs.",
    mode=omp.agents.DeliveryMode.ASIDE,
)
print(receipt.value)
```

Delivery modes let you choose the boundary:

- `ASIDE` posts a non-interrupting correction.
- `STEER` requests immediate steering.
- `NEXT_TURN` queues the item behind the current turn.

Use `result()` for a non-blocking check and `wait()` when your coroutine actually depends on the result.

```python
result = await handle.result()
if result is None:
    result = await handle.wait(timeout=omp.Duration("2m"))
```

### Structural ownership

For scoped work, use the handle as an async context manager. Leaving the block cancels an unreleased child, including exceptional exits.

```python
async with await omp.agents.spawn(
    omp.agents.SubagentSpec(task="Check this tentative design", max_depth=0)
) as child:
    result = await child.wait()
```

Call `release()` when you intentionally transfer ownership away from the scope:

```python
async with await omp.agents.spawn(
    omp.agents.SubagentSpec(task="Run the long audit")
) as child:
    await child.release()
```

`background=True` records background intent in the frozen spec sent to Core. `release()` is the handle operation that relinquishes structural ownership after creation. Keep `run_id`, `output_url`, or `transcript_url` when later code needs to resolve the work without retaining the handle object.

Call `cancel()` for explicit cancellation. If the child is already terminal, steering or other live-only operations can raise `AgentGone`; the exception includes its transcript location.

## Fan out one wave

`spawn_all()` accepts a sequence of specs and validates the returned cardinality. Results remain aligned with the input handles.

```python
import asyncio

specs = [
    omp.agents.SubagentSpec(task="Review the API surface", name="ApiReview", max_depth=0),
    omp.agents.SubagentSpec(task="Review error handling", name="ErrorReview", max_depth=0),
]
handles = await omp.agents.spawn_all(specs)
results = await asyncio.gather(*(handle.wait() for handle in handles))
```

Use one task per genuinely independent slice. Pass durable URLs to downstream children instead of pasting large transcripts into prompts.

## Work with interactive sessions

`omp.sessions.current()` is a synchronous snapshot supplied by the host. Historical and transition operations are async.

```python
current = omp.sessions.current()
print(current.id, current.project, current.status)
```

### Create a prepared session

`create()` atomically creates, seeds, and switches to a top-level interactive session. `initial_prompt` is persisted as a visible prompt but is not submitted by `create()` itself. If you want model work to begin, inject a separate item after creation.

```python
created = await omp.sessions.create(
    omp.sessions.SessionSetup(
        title="Parser follow-up",
        parent=omp.sessions.current().id,
        initial_prompt="The extension prepared a parser follow-up.",
    )
)

await omp.agents.inject(
    "Continue by reviewing the parser failures.",
    session=created.id,
    mode=omp.agents.DeliveryMode.NEXT_TURN,
    visible=True,
    role="user",
)
```

A refused create raises `SessionTransitionDenied` before durable state is created. `SessionTransitionIndeterminate` means Core cannot prove whether the create became durable; its `idempotency_key` and `details` are reconciliation data, not permission to issue an unrelated duplicate.

Use `resume(session_id)` to resume an indexed interactive session, `rename()` for a durable user title, and `lineage()` to read its oldest-first parent chain. `delete()` always goes through Core approval.

## Recipe: inspect project journal history

First query the indexed sessions for the current project, then stream each historical journal through CONTROL instead of reading storage files directly.

```python
async def project_history():
    project = omp.sessions.current().project
    sessions = await omp.sessions.list(
        omp.sessions.SessionFilter(
            project=project,
            kind=None,
            limit=100,
        )
    )

    for session in sessions:
        print(f"\n{session.id}  {session.title or '(untitled)'}")
        async for entry in omp.sessions.journal(session.id, live=True):
            print(entry.id, entry.kind, entry.rev, entry.ts)
```

Each yielded `JournalEntry` exposes:

- physical identity in `id`;
- entry family and revision in `kind` and `rev`;
- authenticated `principal` and package `provenance`;
- typed `value` when decoding succeeds;
- canonical `raw` bytes for exact inspection;
- `display`, `in_context`, and optional spill `artifact` metadata.

Historical turn or tool records returned by the host use the same `JournalEntry` envelope. Inspect `entry.kind` before selecting host-owned families, and pass explicit kind names only when you know their contract. For the current live model projection, `MessageKind.USER`, `ASSISTANT`, `TOOL_CALL`, and `TOOL_RESULT` provide a typed view of conversation items.

When you need physical structure rather than decoded records, use `tree()` or `branch()`:

```python
roots = await omp.sessions.tree()
live_branch = await omp.sessions.branch()
```

`tree()` preserves all decoded nodes, including orphans as roots. `branch()` walks one parent chain from a selected `EntryId`, current-session index, or the current live leaf.

## Write extension-owned journal records

Declare a dataclass entry kind, then append instances. The journal accepts JSON-compatible dataclass fields and writes canonical bytes.

```python
from dataclasses import dataclass

@omp.entry_kind("com.example.audit.completed", rev="1")
@dataclass(frozen=True, slots=True)
class AuditCompleted:
    run_id: str
    findings: int

record_id = await omp.journal.append(
    AuditCompleted(run_id=result.run_id, findings=len(result.warnings)),
    idempotency_key=f"audit:{result.run_id}",
)
```

Use `append_atomic()` with a required idempotency key for an all-or-nothing group. `append_many()` is ordered but non-atomic; if it fails after partial acceptance, `JournalError.appended` reports known accepted ids.

Read your type directly and keep a watermark for incremental work:

```python
records = await omp.journal.entries(AuditCompleted, since=record_id)
latest = await omp.journal.latest(AuditCompleted)
```

## Read the live model context

A context view contains body-free `MessageRef` values so an extension can inspect shape and token pressure without pulling every message body.

```python
view = await omp.context.view()
print(f"{view.usage.fraction:.1%} of context in use")

for turn_id, messages in view.by_turn():
    kinds = ", ".join(message.kind.value for message in messages)
    print(turn_id, kinds)
```

Fetch bodies only for selected items:

```python
for message in view.messages:
    if message.kind is omp.context.MessageKind.TOOL_CALL:
        raw = await message.raw_args()
        print(message.tool, raw)
    elif message.kind is omp.context.MessageKind.TOOL_RESULT:
        verdict = await message.verdict()
        print(type(verdict).__name__)
```

A message can disappear from the live chain after compaction or reset. Handle `ContextGone` if body retrieval is optional. `NoVerdict` means the selected message has no durable structured verdict.

Use `pin(ids, reason=...)` only for items that must survive projection and compaction. Pins consume a configured budget and are owned by the calling extension; release them with `unpin()`.

## Recipe: contribute a context fragment

A thread-projection hook returns a `ContextPatch`. The patch changes the working model projection; it does not rewrite durable journal records.

```python
@omp.hook("thread_projection")
def add_repository_rule(
    view: omp.ContextView,
    ctx: omp.Context,
) -> omp.ContextPatch | None:
    del ctx
    if any(message.preview == "Generated files are read-only." for message in view.messages):
        return None

    return omp.ContextPatch(
        insert=[
            omp.context.Insert(
                parts=(omp.Part.text("Generated files are read-only."),),
                anchor=omp.context.Anchor.head(),
                role="system",
                ephemeral=True,
                dedupe_key="generated-files-policy",
            )
        ],
        note="repository rule",
    )
```

Choose the smallest operation that expresses the change:

- `Prune` removes complete items from the working copy.
- `DropParts` removes model-facing parts but retains typed verdict and journal data.
- `Replace` combines named items into one synthetic item.
- `Insert` contributes a new synthetic item at an `Anchor`.
- `Reorder` moves named items without changing their internal order.

> **Warning** Message ids belong to a particular projection epoch. Core can reject structurally stale or invalid patches with `PatchRejected`.

For auxiliary work that may race compaction, use a strict lane:

```python
from dataclasses import dataclass

@omp.entry_kind("com.example.thread.summary", rev="1")
@dataclass(frozen=True, slots=True)
class ThreadSummary:
    text: str

async with omp.context.lane(strict_epoch=True):
    summary = await omp.agents.completion(
        "Summarize the current thread in three bullets.",
        context="thread",
    )
    await omp.journal.append(ThreadSummary(summary.text))
```

The strict lane captures the current compaction epoch and supplies it as a fence to journal mutations. If the epoch changes first, the write raises `StaleEpoch` instead of committing work derived from an obsolete projection.
