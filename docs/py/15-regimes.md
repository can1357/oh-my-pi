# Regimes and modes

> Owner document for `@omp.regime`, fixed agent-loop events, transactional `ctx` / `next_`
> handlers, durable regime state, resource ownership, and modes.
> `omp.policy` remains the security and sandboxing namespace described in
> [`06-policy.md`](06-policy.md).
> Siblings: [`05-hooks.md`](05-hooks.md) for one-shot extension hooks,
> [`08-context.md`](08-context.md) for context projection, and
> [`12-agents.md`](12-agents.md) for agent lifecycle.

![Regimes and modes](../../assets/regimes-and-modes.svg)

## Purpose

A **regime** is durable, structured middleware attached to fixed events in the agent loop. It can
survive turns and process restart without adding private control-flow edges to the loop.

The system keeps four structural guarantees:

1. The loop has a closed set of events.
2. Each handler stages effects through `ctx` and selects at most one control through `next_`.
3. Core resolves simultaneous handlers deterministically.
4. State, committed effects, bounds, and resource ownership are journaled atomically.

The complete authoring model is:

```text
event -> regime(ctx, next_) -> staged effects + optional control -> Core resolves
```

There is no public decision object or flat verdict vocabulary.

## Middleware semantics

A handler receives two arguments:

```python
@omp.regime("goal-loop", on=omp.SETTLE)
def goal_loop(ctx, next_):
    ...
```

- `ctx` exposes the event, current typed state, read-only journal projections, and effect writers.
- `next_` selects control flow.
- Returning normally commits the handler's staged proposal into the event resolver.
- Raising discards the staged proposal and applies the declaration's failure behavior.

Python uses `next_` rather than `next` to avoid shadowing the built-in iterator function.

### Familiar surface, deterministic execution

This borrows router-middleware ergonomics, not onion-chain execution.

`next_` does **not** invoke another regime. Every active regime receives an isolated `ctx` draft;
one regime cannot suppress a sibling or expose partially staged effects to it. Core collects all
successful drafts, resolves them for the current event, and journals one atomic result.

Consequently registration order is not hidden control flow. Explicit declaration precedence,
resource queues, and event-specific resolution remain the only ordering mechanisms.

## Context effects

Effects only touch the first argument:

```python
ctx.context.append(item)
ctx.context.rewrite(patch)
ctx.tool.require("write")
ctx.settings.set("model", model)
ctx.state.replace(next_state)
```

The namespaces are transaction-scoped writers:

| Writer | Meaning |
|---|---|
| `ctx.context.append(items...)` | Append canonical context items at the event's drain point. |
| `ctx.context.rewrite(patch)` | Stage an ordered provider-context rewrite. |
| `ctx.tool.require(name)` | Request exclusive selection of one advertised tool. |
| `ctx.settings.set(name, value)` | Apply a scoped setting until the regime exits or replaces it. |
| `ctx.state.replace(value)` | Atomically replace this regime's typed journaled state. |

Current state is `ctx.state.value`. Event-specific data is available through `ctx.event`; durable
journal state is queried through the existing `omp.journal` and `omp.state` APIs.

Nothing mutates live agent state while the handler runs. Writers only populate the isolated draft.
A failed handler therefore leaks no partial context edit, tool requirement, setting, or state.

## Control

Control only touches the second argument:

```python
return next_.retry()
return next_.wait(ticket)
return next_.reject("reason")
return next_.cancel("reason")
return next_.complete()
return next_.fail(error)
```

| Control | Meaning |
|---|---|
| `retry()` | Start another model turn instead of settling. |
| `wait(ticket)` | Park until a required-deadline ticket resolves or expires. |
| `reject(reason)` | Reject work that has not started. Reasons may combine. |
| `cancel(reason)` | Cancel work already in flight, such as a stream or batch. |
| `complete()` | Finish this regime successfully and remove it. |
| `fail(error)` | Finish this regime with a typed failure. |

Each control method seals `next_`. Calling a second method is an error. Returning `None` selects no
control; any staged effects still participate in resolution. Process termination
remains outside general regime control.

A `STREAM` cancel is recoverable, not terminal: Core silently aborts the current turn, retains a
structurally suppressed abort marker carrying the reason, and opens a recovery turn whose first
items are the resolution's staged appends. The submission continues; only the interrupted
generation is discarded.

`Next` groups the complete control vocabulary for autocomplete. Runtime validation rejects any
control that is meaningless for the current event.

## Examples

Retry after rewriting context and appending a reminder:

```python
def empty_output(ctx, next_):
    if not ctx.event.empty_output:
        return None
    if ctx.event.trailing_aborts >= 3:
        return next_.fail(EmptyOutputLimit())
    ctx.context.append(retry_instruction)
    return next_.retry()
```

Retry counting needs no regime state: `trailing_aborts` is the journal's recoverable-abort
projection, so the count survives crash and restart by construction.

Cancel a stream and retain a reminder:

```python
def structured_output(ctx, next_):
    ctx.context.append(reminder)
    return next_.cancel("structured output diverged")
```

Effects only:

```python
def checkpoint_notice(ctx, next_):
    ctx.context.append(checkpoint_reminder)
```

Successful terminal:

```python
def completed(ctx, next_):
    ctx.state.replace(final_state)
    return next_.complete()
```

## Fixed events

Regimes subscribe to the existing closed loop. A regime cannot add an event or loop edge.

| Event | Core seam | Available behavior |
|---|---|---|
| `CONTEXT` | provider context projection | append or rewrite context |
| `TOOL_CHOICE` | tool-choice resolution | require one tool |
| `PRE_MODEL` | before model sampling | wait for a required ticket |
| `STREAM` | streamed model output | cancel active generation; staged appends open the recovery turn |
| `ADMISSION` | before one tool invocation | wait or reject |
| `BATCH` | active tool batch | reject pending work or cancel the batch; at settlement, prepend items to the staged tool results |
| `TURN_END` | after the tool batch | append boundary context or update state |
| `SETTLE` | before the agent stops | retry, complete, or fail |
| `IDLE` | idle mailbox boundary | append deferred context or update state |

`BATCH` resolves twice per committed batch: before execution with `delivered=False` (admission-side
supervision) and after settlement with `delivered=True`, the safe boundary for injecting items
ahead of the staged tool results.

### Event facts

`ctx.event` exposes the immutable facts captured at the event boundary:

| Fact | Meaning |
|---|---|
| `turn_id` | Durable turn identity, when a turn exists. |
| `invocation_id` | Invocation identity at `ADMISSION`. |
| `stream_delta` | Streamed UTF-8 fragment at `STREAM`. |
| `stream_part` | Part identity at `STREAM`: `index`, `source` (`text` / `thinking` / `tool`), and `tool_name` for tool-call parts. |
| `now_ms` | Epoch milliseconds. |
| `delivered` | Whether the preceding operation delivered an observable effect. |
| `checkpoint_active` | Whether an exploration checkpoint is active. |
| `hidden` | Whether the turn is system-owned and hidden from the user (for example the compaction summarizer). Stream policy should usually skip hidden turns. |
| `empty_output` | Whether this `SETTLE` follows an empty-output terminal stop. Regimes acting on ordinary settles must ignore failure settles. |
| `trailing_aborts` | Recoverable failed-turn settlements in the current recovery epoch, populated at `SETTLE`. |

A meaningless event/control pair is rejected at declaration or extension FREEZE. It never becomes
a runtime precedence surprise.

## Resolution

Core resolves each event according to that event's domain rather than exposing one global ranking
for authors to memorize.

- Context rewrites run in declared precedence order; appended items accumulate.
- Rejection reasons combine.
- Wait tickets form one required-deadline set.
- Tool requirements use an exclusive resource queue; one holder runs while later requests wait.
- Cancellation stops active work idempotently.
- A typed failure is terminal.
- Successful completion removes only the regime that completed.

The event inputs and result are journaled for forensics. Internal resolver ranks are not part of the
extension API.

## Bounds

A repeatedly retrying regime declares `max_steps`. Bound exhaustion uses the same middleware
signature instead of a second result type:

```python
def empty_output_limit(ctx, next_):
    return next_.fail(EmptyOutputLimit())


@omp.regime(
    "empty-output-retry",
    on=omp.SETTLE,
    max_steps=3,
    on_limit=empty_output_limit,
)
def empty_output(ctx, next_):
    ctx.context.append(retry_instruction)
    return next_.retry()
```

Core advances the bound only after the staged effect commits. A queued tool requirement,
undelivered context item, or unresolved wait does not consume a step.

Different behavior at each step is ordinary typed state and branching. There is no tree or ladder
language. Session-standing regimes may remain active until explicit exit instead of declaring an
artificial numeric bound.

## Durable state

A stateful regime declares one versioned type:

```python
@dataclass(frozen=True)
class GoalState:
    objective: str
    complete: bool = False


@omp.regime(
    "goal-loop",
    on=omp.SETTLE,
    lifetime="session",
    state=GoalState,
)
def goal_loop(ctx, next_):
    state = ctx.state.value
    if state.complete:
        return next_.complete()

    ctx.context.append(omp.user_text(f"Continue toward: {state.objective}"))
    return next_.retry()
```

On restart, Core restores the active regime and exact state before the next subscribed event. An
unavailable implementation or incompatible state revision follows declared failure behavior; Core
never loads an untyped payload into a new implementation.

There is no separate blackboard. The handler reads the event, typed state, and uses the ordinary journal APIs for other durable facts.

## Activation

Regimes start explicitly or through a declarative `when` condition:

```python
handle = await omp.regimes.start("goal-loop", state=GoalState("ship the release"))
active = await omp.regimes.active()
await handle.stop()
```

A start may queue for resource ownership:

```python
handle = await omp.regimes.start("autoresearch", queue=True)
```

Without `queue=True`, a conflict returns the resource, current owner, and acquisition time as
structured data.

`when` is an activation condition, not a monitor object:

```python
@omp.regime(
    "checkpoint-notice",
    on=omp.CONTEXT,
    lifetime="session",
    when=omp.when.checkpoint_active(),
)
def checkpoint_notice(ctx, next_):
    ctx.context.append(checkpoint_reminder)
```

## Modes

A **mode** is not another runtime type. It is a session regime that owns the `mode` resource and
usually applies scoped settings until explicit exit.

```python
@omp.regime(
    "plan",
    on=(omp.CONTEXT, omp.ADMISSION, omp.SETTLE),
    lifetime="session",
    owns=("mode", "worktree"),
    sets={"prompt": "plan", "toolset": "read-only"},
)
def plan(ctx, next_):
    if ctx.event.point is omp.ADMISSION and ctx.event.is_write:
        return next_.reject("plan mode is read-only")
```

Owning `mode` makes plan, vibe, goal, and autoresearch visible modes. There is no distinct mode
handler interface.

Exiting a mode is one atomic operation:

1. release owned resource leases;
2. restore scoped settings;
3. journal completion.

Resource transfer is release followed by granting the next queued owner. Regimes do not implement
custom hand-off protocols.

## Declaration surface

```python
@omp.regime(
    id,
    *,
    on,
    lifetime="run",
    state=None,
    when=None,
    max_steps=None,
    on_limit=None,
    owns=(),
    sets=None,
    minimum_duration=None,
    on_failure="defer",
)
def handler(ctx, next_):
    ...
```

Most regimes use only `id` and `on`. Ownership and lifecycle options are mode configuration, not a
second abstraction.
`on_failure="defer"` discards a failed draft; `"deny"` rejects the current event with a static
classified reason.

## Rust ownership

The target Rust boundary (`Regime` trait, `RegimeContext` draft, `Next` controls) is a design
target with no surviving implementation in the tree — there is no `Regime` type under
`crates/` today, and agent-side control-plane variables live in `crates/agent/src/vars.rs`
declared as convars (ADR 0012):

```rust
pub trait Regime: Send + Sync + 'static {
    fn apply(
        &mut self,
        ctx: &mut RegimeContext<'_>,
        next: Next<'_>,
    ) -> Result<(), RegimeError>;

    fn state(&self) -> Str;
    fn restore(&mut self, payload: &str) -> Result<(), RegimeStateError>;
}
```

`RegimeContext` stages effects in an isolated draft. `Next` control methods consume `self`, so Rust
enforces at most one control selection. Dropping `Next` selects no control.

The runtime owner is `RegimeSet`; active instances use an `ActivationId`. Resolver ranks, draft
storage, resource queue cursors, and journal projection types stay crate-private unless another
crate must consume them.

`crates/agent/src/loop.rs` owns event placement. It consumes resolved outcomes; it does not know
individual regime implementations.

Core's own cross-cutting behavior obeys the same contract: the built-in lanes (stream rules,
empty-output retry, checkpoint notice, provider failover) are ordinary `Regime` machines folded
through the same per-event resolution beside durable activations. Nothing resolves outside this
vocabulary.

## Failure behavior

| Failure | Required behavior |
|---|---|
| Handler raises or times out | Discard its draft; apply declared `on_failure`. |
| Control invalid for event | Reject declaration at FREEZE. |
| Two controls selected | Consumed `Next` prevents it in Rust; Python raises. |
| Wait has no deadline | Reject declaration or staged control. |
| State revision is incompatible | Fail or stop the regime; never guess a migration. |
| Resource is occupied | Return structured owner data or queue explicitly. |
## Design boundary

Keep:

- fixed loop events;
- isolated transactional handlers;
- deterministic event-specific resolution;
- durable typed state and revival;
- committed-effect bound accounting;
- exclusive resource queues;
- scoped settings;
- atomic mode teardown;
- journaled forensic facts.

Do not add:

- actual onion-chain semantics where one regime can suppress siblings;
- a public decision or winner enum parallel to `ctx` / `next_`;
- a tree DSL for ordinary branches;
- named abstractions for activation conditions or journal projections;
- compatibility aliases for campaign, loop-policy, engagement, verdict, reaction, ladder,
  monitor, or blackboard terminology.
