# `omp.events`

`omp.events` contains the immutable payload classes and introspection API for every frozen hook event. Its public names are star-exported into `omp`, so `omp.ToolCallEvent` and `omp.events.ToolCallEvent` are the same class.

Use payload types as callback annotations and inspect `EventSpec` when you need catalog behavior at runtime:

```python
import omp

@omp.hook("turn_end")
def report_turn(event: omp.TurnEndEvent, ctx: omp.Context) -> None:
    print(event.turn_id, event.stop, event.usage)

row = omp.events.spec("turn_end")
print(row.id, row.latency, row.default_timeout)
```

See the [hooks guide](../guides/hooks.md) for registration and phase behavior, and [`omp.hooks`](omp.hooks.md) for decisions and filters.

## Catalog introspection

### `omp.events.EVENT_IDS`

```python
EVENT_IDS: Final[Mapping[str, int]]
```

Maps every event name to its stable subscription-bitmap identifier. The mapping is read-only; identifier 59 remains unused as a tombstone.

### `omp.events.spec`

```python
def spec(event: str) -> EventSpec
```

Returns the immutable catalog row for one event.

**Parameters**

| Name | Type | Meaning |
|---|---|---|
| `event` | `str` | Frozen event name. |

**Returns**

The corresponding `EventSpec`.

**Raises**

`UnknownEvent` if the name is unknown or not a string-keyed catalog entry.

```python
if omp.events.spec("tool_call").gateable:
    print(omp.events.field_composition("tool_call"))
```

### `omp.events.specs`

```python
def specs() -> Iterator[EventSpec]
```

Iterates all catalog rows in stable event-id order.

**Returns**

An iterator of `EventSpec` objects.

```python
stream_events = [row.name for row in omp.events.specs() if row.latency is omp.LatencyClass.STREAM]
```

### `omp.events.default_decision`

```python
def default_decision(event: str) -> type | None
```

Returns the decision class used when the event's handlers do not decide.

**Parameters**

| Name | Type | Meaning |
|---|---|---|
| `event` | `str` | Frozen event name. |

**Returns**

A decision class such as `Allow`, or `None` for events without a composed gate default.

**Raises**

`UnknownEvent` if `event` is not in the catalog.

### `omp.events.field_composition`

```python
def field_composition(event: str) -> Mapping[str, Composition]
```

Returns the immutable composition rules for fields that `TRANSFORM` hooks may change.

**Parameters**

| Name | Type | Meaning |
|---|---|---|
| `event` | `str` | Frozen event name. |

**Returns**

A read-only mapping from field names to `Composition` values. An empty mapping means the catalog declares no mutable fields.

**Raises**

`UnknownEvent` if `event` is not in the catalog.

```python
rules = omp.events.field_composition("before_agent_start")
assert rules["text"] is omp.Composition.REPLACE
```

## Enumerations

### `omp.events.InputSource`

```python
class InputSource(StrEnum)
```

Defines the wire values for how the submission entered the harness.

| Member | Wire value | Meaning |
|---|---|---|
| `INTERACTIVE` | `'interactive'` | How the submission entered the harness: interactive. |
| `RPC` | `'rpc'` | How the submission entered the harness: rpc. |
| `EXTENSION` | `'extension'` | How the submission entered the harness: extension. |
| `SCHEDULE` | `'schedule'` | How the submission entered the harness: schedule. |

### `omp.events.ItemKind`

```python
class ItemKind(StrEnum)
```

Defines the wire values for durable projected item category.

| Member | Wire value | Meaning |
|---|---|---|
| `MESSAGE` | `'message'` | Durable projected item category: message. |
| `TOOL_CALL` | `'tool_call'` | Durable projected item category: tool call. |
| `TOOL_RESULT` | `'tool_result'` | Durable projected item category: tool result. |
| `REASONING` | `'reasoning'` | Durable projected item category: reasoning. |

### `omp.events.ResourceKind`

```python
class ResourceKind(StrEnum)
```

Defines the wire values for extension resource category.

| Member | Wire value | Meaning |
|---|---|---|
| `SKILL` | `'skill'` | Extension resource category: skill. |
| `PROMPT` | `'prompt'` | Extension resource category: prompt. |
| `THEME` | `'theme'` | Extension resource category: theme. |
| `RULE` | `'rule'` | Extension resource category: rule. |
| `AGENT` | `'agent'` | Extension resource category: agent. |

### `omp.events.OutcomeKind`

```python
class OutcomeKind(StrEnum)
```

Defines the wire values for durable call outcome arm.

| Member | Wire value | Meaning |
|---|---|---|
| `OK` | `'ok'` | Durable call outcome arm: ok. |
| `FAULTED` | `'faulted'` | Durable call outcome arm: faulted. |
| `ARGS_REJECTED` | `'args_rejected'` | Durable call outcome arm: args rejected. |
| `ABORTED` | `'aborted'` | Durable call outcome arm: aborted. |

### `omp.events.ShutdownReason`

```python
class ShutdownReason(StrEnum)
```

Defines the wire values for cause of session shutdown.

| Member | Wire value | Meaning |
|---|---|---|
| `USER_EXIT` | `'user_exit'` | Cause of session shutdown: user exit. |
| `SIGNAL` | `'signal'` | Cause of session shutdown: signal. |
| `SWITCH` | `'switch'` | Cause of session shutdown: switch. |
| `FATAL` | `'fatal'` | Cause of session shutdown: fatal. |
| `HOST_REPLACED` | `'host_replaced'` | Cause of session shutdown: host replaced. |

### `omp.events.SwitchReason`

```python
class SwitchReason(StrEnum)
```

Defines the wire values for cause of a session switch.

| Member | Wire value | Meaning |
|---|---|---|
| `NEW` | `'new'` | Cause of a session switch: new. |
| `RESUME` | `'resume'` | Cause of a session switch: resume. |
| `FORK` | `'fork'` | Cause of a session switch: fork. |
| `HANDOFF` | `'handoff'` | Cause of a session switch: handoff. |

### `omp.events.BranchReason`

```python
class BranchReason(StrEnum)
```

Defines the wire values for cause of session branching.

| Member | Wire value | Meaning |
|---|---|---|
| `USER` | `'user'` | Cause of session branching: user. |
| `REWIND` | `'rewind'` | Cause of session branching: rewind. |
| `COMPACTION` | `'compaction'` | Cause of session branching: compaction. |

### `omp.events.AgentPhase`

```python
class AgentPhase(StrEnum)
```

Defines the wire values for coarse agent-loop phase.

| Member | Wire value | Meaning |
|---|---|---|
| `IDLE` | `'idle'` | Coarse agent-loop phase: idle. |
| `PROJECTING` | `'projecting'` | Coarse agent-loop phase: projecting. |
| `TURNING` | `'turning'` | Coarse agent-loop phase: turning. |
| `TOOL_BATCH` | `'tool_batch'` | Coarse agent-loop phase: tool batch. |

### `omp.events.TurnInputMode`

```python
class TurnInputMode(StrEnum)
```

Defines the wire values for turn projection shape.

| Member | Wire value | Meaning |
|---|---|---|
| `FULL` | `'full'` | Turn projection shape: full. |
| `DELTA` | `'delta'` | Turn projection shape: delta. |

### `omp.events.SettleReason`

```python
class SettleReason(StrEnum)
```

Defines the wire values for cause of caller-submission settlement.

| Member | Wire value | Meaning |
|---|---|---|
| `STOP` | `'stop'` | Cause of caller-submission settlement: stop. |
| `INTERRUPTED` | `'interrupted'` | Cause of caller-submission settlement: interrupted. |
| `EMPTY_OUTPUT` | `'empty_output'` | Cause of caller-submission settlement: empty output. |
| `MAILBOX_EMPTY` | `'mailbox_empty'` | Cause of caller-submission settlement: mailbox empty. |

### `omp.events.InterruptClass`

```python
class InterruptClass(StrEnum)
```

Defines the wire values for boundary used to drain an interrupt.

| Member | Wire value | Meaning |
|---|---|---|
| `IMMEDIATE` | `'immediate'` | Boundary used to drain an interrupt: immediate. |
| `TURN_BOUNDARY` | `'turn_boundary'` | Boundary used to drain an interrupt: turn boundary. |
| `IDLE` | `'idle'` | Boundary used to drain an interrupt: idle. |

### `omp.events.DrainPoint`

```python
class DrainPoint(StrEnum)
```

Defines the wire values for agent mailbox drain boundary.

| Member | Wire value | Meaning |
|---|---|---|
| `IMMEDIATE` | `'immediate'` | Agent mailbox drain boundary: immediate. |
| `TURN_BOUNDARY` | `'turn_boundary'` | Agent mailbox drain boundary: turn boundary. |
| `IDLE` | `'idle'` | Agent mailbox drain boundary: idle. |

### `omp.events.InterruptSource`

```python
class InterruptSource(StrEnum)
```

Defines the wire values for producer of an interrupt.

| Member | Wire value | Meaning |
|---|---|---|
| `JOB` | `'job'` | Producer of an interrupt: job. |
| `PRODUCER` | `'producer'` | Producer of an interrupt: producer. |
| `USER` | `'user'` | Producer of an interrupt: user. |
| `DEADLINE` | `'deadline'` | Producer of an interrupt: deadline. |

### `omp.events.DeadlineScope`

```python
class DeadlineScope(StrEnum)
```

Defines the wire values for operation whose deadline expired.

| Member | Wire value | Meaning |
|---|---|---|
| `AGENT` | `'agent'` | Operation whose deadline expired: agent. |
| `TURN` | `'turn'` | Operation whose deadline expired: turn. |
| `CALL` | `'call'` | Operation whose deadline expired: call. |
| `HOOK` | `'hook'` | Operation whose deadline expired: hook. |

### `omp.events.PartKind`

```python
class PartKind(StrEnum)
```

Defines the wire values for streamed message-part category.

| Member | Wire value | Meaning |
|---|---|---|
| `TEXT` | `'text'` | Streamed message-part category: text. |
| `REASONING` | `'reasoning'` | Streamed message-part category: reasoning. |
| `TOOL_ARGS` | `'tool_args'` | Streamed message-part category: tool args. |
| `IMAGE` | `'image'` | Streamed message-part category: image. |

### `omp.events.FinishReason`

```python
class FinishReason(StrEnum)
```

Defines the wire values for cause of message-stream completion.

| Member | Wire value | Meaning |
|---|---|---|
| `COMPLETE` | `'complete'` | Cause of message-stream completion: complete. |
| `TRUNCATED` | `'truncated'` | Cause of message-stream completion: truncated. |
| `INTERRUPTED` | `'interrupted'` | Cause of message-stream completion: interrupted. |
| `ERROR` | `'error'` | Cause of message-stream completion: error. |

### `omp.events.DeviceListReason`

```python
class DeviceListReason(StrEnum)
```

Defines the wire values for cause for assembling the effective device list.

| Member | Wire value | Meaning |
|---|---|---|
| `SESSION_START` | `'session_start'` | Cause for assembling the effective device list: session start. |
| `TOOLSET_CHANGED` | `'toolset_changed'` | Cause for assembling the effective device list: toolset changed. |
| `MODE_CHANGED` | `'mode_changed'` | Cause for assembling the effective device list: mode changed. |
| `MODEL_CHANGED` | `'model_changed'` | Cause for assembling the effective device list: model changed. |
| `MANUAL` | `'manual'` | Cause for assembling the effective device list: manual. |

### `omp.events.EvalLanguage`

```python
class EvalLanguage(StrEnum)
```

Defines the wire values for user-evaluation language.

| Member | Wire value | Meaning |
|---|---|---|
| `PY` | `'py'` | User-evaluation language: py. |
| `JS` | `'js'` | User-evaluation language: js. |

### `omp.events.DiscoverReason`

```python
class DiscoverReason(StrEnum)
```

Defines the wire values for cause for rediscovering extension resources.

| Member | Wire value | Meaning |
|---|---|---|
| `STARTUP` | `'startup'` | Cause for rediscovering extension resources: startup. |
| `RELOAD` | `'reload'` | Cause for rediscovering extension resources: reload. |
| `WORKSPACE_CHANGED` | `'workspace_changed'` | Cause for rediscovering extension resources: workspace changed. |
| `EXTENSION_CHANGED` | `'extension_changed'` | Cause for rediscovering extension resources: extension changed. |

### `omp.events.ModelChangeReason`

```python
class ModelChangeReason(StrEnum)
```

Defines the wire values for cause of model selection change.

| Member | Wire value | Meaning |
|---|---|---|
| `USER` | `'user'` | Cause of model selection change: user. |
| `FALLBACK` | `'fallback'` | Cause of model selection change: fallback. |
| `ROLE` | `'role'` | Cause of model selection change: role. |
| `POLICY` | `'policy'` | Cause of model selection change: policy. |

### `omp.events.UnloadReason`

```python
class UnloadReason(StrEnum)
```

Defines the wire values for cause for unloading an extension.

| Member | Wire value | Meaning |
|---|---|---|
| `USER` | `'user'` | Cause for unloading an extension: user. |
| `RELOAD` | `'reload'` | Cause for unloading an extension: reload. |
| `ERROR` | `'error'` | Cause for unloading an extension: error. |
| `QUARANTINE` | `'quarantine'` | Cause for unloading an extension: quarantine. |
| `SHUTDOWN` | `'shutdown'` | Cause for unloading an extension: shutdown. |

## Payload and catalog dataclasses

All classes in this section are frozen, slotted dataclasses. Event instances are normally constructed by the host and passed to your callback; the signatures are also available when you need fixtures or typed support values.

### `omp.events.CallRef`

```python
CallRef(call_id: str, target: CallTarget)
```

Identifies one logical call together with its resolved target.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `call_id` | `str` | required | Stable logical call identifier. |
| `target` | `CallTarget` | required | Resolved logical call target. |

### `omp.events.ItemRef`

```python
ItemRef(event_index: int, item_id: str, kind: ItemKind, role: Role | None)
```

Identifies one durable projected item.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `event_index` | `int` | required | Durable event position. |
| `item_id` | `str` | required | Stable projected-item identifier. |
| `kind` | `ItemKind` | required | Wire discriminator or category. |
| `role` | `Role | None` | required | Message role when the item has one. |

### `omp.events.SessionOrigin`

```python
SessionOrigin(session_id: str, at_event: int | None)
```

Records the source of a resumed or forked session.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `session_id` | `str` | required | Stable session identifier. |
| `at_event` | `int | None` | required | Journal position at which the operation applies. |

### `omp.events.RunSummary`

```python
RunSummary(committed_turns: int, interrupted: bool, stop: StopReason | None)
```

Summarizes the durable result of a caller submission.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `committed_turns` | `int` | required | Count of committed turns. |
| `interrupted` | `bool` | required | Whether execution was interrupted. |
| `stop` | `StopReason | None` | required | Turn or run stop reason. |

### `omp.events.RewindTarget`

```python
RewindTarget(event_index: int, keep_event: int | None, text: str)
```

Describes one projected item affected by rewind.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `event_index` | `int` | required | Durable event position. |
| `keep_event` | `int | None` | required | Optional retained event boundary. |
| `text` | `str` | required | Text associated with the rewind target. |

### `omp.events.ResourceRef`

```python
ResourceRef(uri: EnvPath, kind: ResourceKind, origin: str)
```

Identifies a discovered extension resource.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `uri` | `EnvPath` | required | Environment-scoped resource URI. |
| `kind` | `ResourceKind` | required | Wire discriminator or category. |
| `origin` | `str` | required | Extension or discovery source that supplied the resource. |

### `omp.events.Annotation`

```python
Annotation(kind: str, data: Mapping[str, Any], display: bool = True)
```

Adds structured optional display metadata to a tool outcome.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `kind` | `str` | required | Application-defined annotation category. |
| `data` | `Mapping[str, Any]` | required | Structured annotation data. |
| `display` | `bool` | `True` | Whether the annotation may be presented to the user. |

### `omp.events.SessionStartEvent`

```python
SessionStartEvent(
    session_id: str,
    root: EnvPath,
    cwd: EnvPath,
    dirs: tuple[EnvPath, ...],
    resumed: bool,
    forked_from: SessionOrigin | None,
    agent: str | None,
    trust: Trust,
    head_event: int,
    prompt_rev: str,
    previous_session: str | None = None,
)
```

Carries the immutable payload for the `session_start` hook event.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `session_id` | `str` | required | Stable session identifier. |
| `root` | `EnvPath` | required | Environment-scoped workspace root. |
| `cwd` | `EnvPath` | required | Environment-scoped working directory. |
| `dirs` | `tuple[EnvPath, ...]` | required | Ordered environment-scoped directories. |
| `resumed` | `bool` | required | Whether an existing session was resumed. |
| `forked_from` | `SessionOrigin | None` | required | Source session and branch point, when forked. |
| `agent` | `str | None` | required | Selected agent identifier, when one is active. |
| `trust` | `Trust` | required | Effective trust level. |
| `head_event` | `int` | required | Current durable journal head. |
| `prompt_rev` | `str` | required | Prompt assembly revision. |
| `previous_session` | `str | None` | `None` | Session active before this transition, when any. |

### `omp.events.SessionShutdownEvent`

```python
SessionShutdownEvent(
    session_id: str,
    reason: ShutdownReason,
    budget: Duration,
    target_session: str | None = None,
)
```

Carries the immutable payload for the `session_shutdown` hook event.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `session_id` | `str` | required | Stable session identifier. |
| `reason` | `ShutdownReason` | required | Typed or textual cause of the event. |
| `budget` | `Duration` | required | Allowed duration for the described operation. |
| `target_session` | `str | None` | `None` | Session targeted by shutdown or switching. |

### `omp.events.SessionSwitchEvent`

```python
SessionSwitchEvent(
    reason: SwitchReason,
    from_session: str | None,
    to_session: str | None,
    target_cwd: EnvPath | None,
)
```

Carries the immutable payload for the `session_switch` hook event.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `reason` | `SwitchReason` | required | Typed or textual cause of the event. |
| `from_session` | `str | None` | required | Session being left, when any. |
| `to_session` | `str | None` | required | Destination session, when any. |
| `target_cwd` | `EnvPath | None` | required | Requested destination working directory. |

### `omp.events.SessionSwitchedEvent`

```python
SessionSwitchedEvent(
    reason: SwitchReason,
    from_session: str | None,
    to_session: str,
    head_event: int,
)
```

Carries the immutable payload for the `session_switched` hook event.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `reason` | `SwitchReason` | required | Typed or textual cause of the event. |
| `from_session` | `str | None` | required | Session being left, when any. |
| `to_session` | `str` | required | Destination session, when any. |
| `head_event` | `int` | required | Current durable journal head. |

### `omp.events.SessionBranchEvent`

```python
SessionBranchEvent(at_event: int, keep_event: int | None, reason: BranchReason, summarize: bool)
```

Carries the immutable payload for the `session_branch` hook event.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `at_event` | `int` | required | Journal position at which the operation applies. |
| `keep_event` | `int | None` | required | Optional retained event boundary. |
| `reason` | `BranchReason` | required | Typed or textual cause of the event. |
| `summarize` | `bool` | required | Whether the branch operation should create a summary. |

### `omp.events.SessionBranchedEvent`

```python
SessionBranchedEvent(at_event: int, new_head: int, summary_event: int | None)
```

Carries the immutable payload for the `session_branched` hook event.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `at_event` | `int` | required | Journal position at which the operation applies. |
| `new_head` | `int` | required | Journal head after the operation. |
| `summary_event` | `int | None` | required | Journal position of a generated summary, when present. |

### `omp.events.SessionRewindEvent`

```python
SessionRewindEvent(
    to_event: int | None,
    restore_workspace: bool,
    targets: tuple[RewindTarget, ...],
    dropped_items: int,
)
```

Carries the immutable payload for the `session_rewind` hook event.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `to_event` | `int | None` | required | Requested rewind destination, or `None` for the beginning. |
| `restore_workspace` | `bool` | required | Whether workspace restoration was requested. |
| `targets` | `tuple[RewindTarget, ...]` | required | Items affected by the rewind. |
| `dropped_items` | `int` | required | Number of projected items removed. |

### `omp.events.SessionRewoundEvent`

```python
SessionRewoundEvent(to_event: int | None, new_head: int, restored_workspace: bool)
```

Carries the immutable payload for the `session_rewound` hook event.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `to_event` | `int | None` | required | Requested rewind destination, or `None` for the beginning. |
| `new_head` | `int` | required | Journal head after the operation. |
| `restored_workspace` | `bool` | required | Whether workspace restoration completed. |

### `omp.events.SessionResetEvent`

```python
SessionResetEvent(at_event: int, kept_events: int)
```

Carries the immutable payload for the `session_reset` hook event.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `at_event` | `int` | required | Journal position at which the operation applies. |
| `kept_events` | `int` | required | Number of durable events retained. |

### `omp.events.BeforeAgentStartEvent`

```python
BeforeAgentStartEvent(
    submission_id: str,
    text: str,
    items: tuple[ItemRef, ...],
    source: InputSource,
    prompt_rev: str,
    staged_interrupts: int,
    resuming: bool,
    schedule_id: str | None = None,
)
```

Carries the immutable payload for the `before_agent_start` hook event.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `submission_id` | `str` | required | Stable caller-submission identifier. |
| `text` | `str` | required | Text carried by the event. |
| `items` | `tuple[ItemRef, ...]` | required | Projected item references associated with the event. |
| `source` | `InputSource` | required | Producer or source category. |
| `prompt_rev` | `str` | required | Prompt assembly revision. |
| `staged_interrupts` | `int` | required | Interrupts waiting before agent start. |
| `resuming` | `bool` | required | Whether execution resumes prior work. |
| `schedule_id` | `str | None` | `None` | Associated schedule identifier, when scheduled. |

### `omp.events.AgentStartEvent`

```python
AgentStartEvent(submission_id: str, from_phase: AgentPhase, pending_items: int)
```

Carries the immutable payload for the `agent_start` hook event.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `submission_id` | `str` | required | Stable caller-submission identifier. |
| `from_phase` | `AgentPhase` | required | Agent phase preceding the transition. |
| `pending_items` | `int` | required | Number of queued input items. |

### `omp.events.TurnStartEvent`

```python
TurnStartEvent(
    turn_id: str,
    turn_index: int,
    prompt_hash: str,
    toolset_hash: str,
    enabled_tools: tuple[str, ...],
    input_mode: TurnInputMode,
    model: ModelRef,
    route: RouteRef,
    thinking: Effort,
    deadline: Duration | None,
    attempt: int,
    prompt_changed: bool,
    toolset_changed: bool,
)
```

Carries the immutable payload for the `turn_start` hook event.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `turn_id` | `str` | required | Stable model-turn identifier. |
| `turn_index` | `int` | required | Zero-based or durable turn sequence number. |
| `prompt_hash` | `str` | required | Digest of the assembled prompt. |
| `toolset_hash` | `str` | required | Digest of the effective tool set. |
| `enabled_tools` | `tuple[str, ...]` | required | Names of tools enabled for this turn. |
| `input_mode` | `TurnInputMode` | required | Full or delta projection mode. |
| `model` | `ModelRef` | required | Selected inference model. |
| `route` | `RouteRef` | required | Selected provider route. |
| `thinking` | `Effort` | required | Selected reasoning effort. |
| `deadline` | `Duration | None` | required | Optional operation deadline. |
| `attempt` | `int` | required | Current attempt number. |
| `prompt_changed` | `bool` | required | Whether prompt assembly changed since the prior turn. |
| `toolset_changed` | `bool` | required | Whether the effective tool set changed. |

### `omp.events.TurnEndEvent`

```python
TurnEndEvent(
    turn_id: str,
    turn_index: int,
    event_index: int,
    stop: StopReason,
    usage: Usage,
    session_usage: Usage,
    revision: str | None,
    calls: tuple[CallRef, ...],
    items: tuple[ItemRef, ...],
)
```

Carries the immutable payload for the `turn_end` hook event.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `turn_id` | `str` | required | Stable model-turn identifier. |
| `turn_index` | `int` | required | Zero-based or durable turn sequence number. |
| `event_index` | `int` | required | Durable event position. |
| `stop` | `StopReason` | required | Turn or run stop reason. |
| `usage` | `Usage` | required | Usage attributable to this unit. |
| `session_usage` | `Usage` | required | Cumulative session usage. |
| `revision` | `str | None` | required | Optional provider or output revision. |
| `calls` | `tuple[CallRef, ...]` | required | Call references associated with the event. |
| `items` | `tuple[ItemRef, ...]` | required | Projected item references associated with the event. |

### `omp.events.TodoRef`

```python
TodoRef(phase: str, text: str, status: Literal['pending', 'in_progress'])
```

Provides a read-only view of one incomplete built-in todo.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `phase` | `str` | required | Todo workflow phase. |
| `text` | `str` | required | Actionable todo description. |
| `status` | `Literal['pending', 'in_progress']` | required | Pending or in-progress todo state. |

### `omp.events.AgentSettledEvent`

```python
AgentSettledEvent(
    submission_id: str,
    reason: SettleReason,
    committed_turns: int,
    last_stop: StopReason | None,
    pending_jobs: tuple[str, ...],
    continuations_used: int,
    incomplete_todos: tuple[TodoRef, ...] = (),
)
```

Carries the immutable payload for the `agent_settled` hook event.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `submission_id` | `str` | required | Stable caller-submission identifier. |
| `reason` | `SettleReason` | required | Typed or textual cause of the event. |
| `committed_turns` | `int` | required | Count of committed turns. |
| `last_stop` | `StopReason | None` | required | Most recent stop reason, if a turn completed. |
| `pending_jobs` | `tuple[str, ...]` | required | Detached jobs still unsettled. |
| `continuations_used` | `int` | required | Number of continuation decisions already consumed. |
| `incomplete_todos` | `tuple[TodoRef, ...]` | `()` | Actionable todo items not yet complete. |

### `omp.events.AgentEndEvent`

```python
AgentEndEvent(submission_id: str, summary: RunSummary, continued: bool, error: str | None)
```

Carries the immutable payload for the `agent_end` hook event.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `submission_id` | `str` | required | Stable caller-submission identifier. |
| `summary` | `RunSummary` | required | Durable summary of the completed submission. |
| `continued` | `bool` | required | Whether the goal loop requested another turn. |
| `error` | `str | None` | required | Error text, when execution failed. |

### `omp.events.InterruptEvent`

```python
InterruptEvent(
    source: InterruptSource,
    reason: str,
    klass: InterruptClass,
    drain_point: DrainPoint,
    turn_id: str | None,
)
```

Carries the immutable payload for the `interrupt` hook event.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `source` | `InterruptSource` | required | Producer that raised the interrupt. |
| `reason` | `str` | required | Typed or textual cause of the event. |
| `klass` | `InterruptClass` | required | Interrupt boundary class. |
| `drain_point` | `DrainPoint` | required | Mailbox boundary where the interrupt was observed. |
| `turn_id` | `str | None` | required | Stable model-turn identifier. |

### `omp.events.DeadlineEvent`

```python
DeadlineEvent(
    scope: DeadlineScope,
    elapsed: Duration,
    budget: Duration,
    turn_id: str | None,
    call_id: str | None,
)
```

Carries the immutable payload for the `deadline` hook event.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `scope` | `DeadlineScope` | required | Operation category whose deadline expired. |
| `elapsed` | `Duration` | required | Elapsed duration at expiry. |
| `budget` | `Duration` | required | Allowed duration for the described operation. |
| `turn_id` | `str | None` | required | Stable model-turn identifier. |
| `call_id` | `str | None` | required | Stable logical call identifier. |

### `omp.events.MessageStartEvent`

```python
MessageStartEvent(turn_id: str, item_id: str, role: Role, index: int)
```

Carries the immutable payload for the `message_start` hook event.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `turn_id` | `str` | required | Stable model-turn identifier. |
| `item_id` | `str` | required | Stable projected-item identifier. |
| `role` | `Role` | required | Role of the streamed message. |
| `index` | `int` | required | Message position in the stream. |

### `omp.events.MessageUpdateEvent`

```python
MessageUpdateEvent(
    turn_id: str,
    item_id: str,
    part_index: int,
    kind: PartKind,
    delta: str,
    coalesced: int,
    total_chars: int,
)
```

Carries the immutable payload for the `message_update` hook event.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `turn_id` | `str` | required | Stable model-turn identifier. |
| `item_id` | `str` | required | Stable projected-item identifier. |
| `part_index` | `int` | required | Index of the streamed message part. |
| `kind` | `PartKind` | required | Category of the message part being updated. |
| `delta` | `str` | required | Coalesced content added during this window. |
| `coalesced` | `int` | required | Number of raw updates folded into this payload. |
| `total_chars` | `int` | required | Running character count for the message. |

### `omp.events.MessageEndEvent`

```python
MessageEndEvent(turn_id: str, item_id: str, role: Role, parts: int, finish: FinishReason)
```

Carries the immutable payload for the `message_end` hook event.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `turn_id` | `str` | required | Stable model-turn identifier. |
| `item_id` | `str` | required | Stable projected-item identifier. |
| `role` | `Role` | required | Role of the completed message. |
| `parts` | `int` | required | Number of message parts. |
| `finish` | `FinishReason` | required | Reason streaming ended. |

### `omp.events.ItemCommittedEvent`

```python
ItemCommittedEvent(event_index: int, turn_id: str | None, item: ItemRef)
```

Carries the immutable payload for the `item_committed` hook event.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `event_index` | `int` | required | Durable event position. |
| `turn_id` | `str | None` | required | Stable model-turn identifier. |
| `item` | `ItemRef` | required | Committed item reference. |

### `omp.events.CallOpenEvent`

```python
CallOpenEvent(call_id: str, target: CallTarget, kind: TargetKind, turn_id: str, place: Place)
```

Carries the immutable payload for the `call_open` hook event.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `call_id` | `str` | required | Stable logical call identifier. |
| `target` | `CallTarget` | required | Resolved logical call target. |
| `kind` | `TargetKind` | required | Discriminator matching the resolved target. |
| `turn_id` | `str` | required | Stable model-turn identifier. |
| `place` | `Place` | required | Execution placement. |

### `omp.events.ToolCallEvent`

```python
ToolCallEvent(
    call_id: str,
    invocation_id: str,
    target: CallTarget,
    kind: TargetKind,
    args: Mapping[str, Any],
    raw_args: bytes,
    repaired: bool,
    turn_id: str,
    session_id: str,
    cwd: EnvPath,
    origin: CallOrigin,
    batch: tuple[CallRef, ...],
    deadline: Duration | None,
    bash: BashIR | None,
)
```

Carries the immutable payload for the `tool_call` hook event.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `call_id` | `str` | required | Stable logical call identifier. |
| `invocation_id` | `str` | required | Stable executor invocation identifier. |
| `target` | `CallTarget` | required | Resolved logical call target. |
| `kind` | `TargetKind` | required | Discriminator matching the resolved target. |
| `args` | `Mapping[str, Any]` | required | Canonical argument mapping. |
| `raw_args` | `bytes` | required | Original encoded argument bytes. |
| `repaired` | `bool` | required | Whether argument repair changed the input. |
| `turn_id` | `str` | required | Stable model-turn identifier. |
| `session_id` | `str` | required | Stable session identifier. |
| `cwd` | `EnvPath` | required | Environment-scoped working directory. |
| `origin` | `CallOrigin` | required | Source extension or operation. |
| `batch` | `tuple[CallRef, ...]` | required | Sibling calls issued in the same batch. |
| `deadline` | `Duration | None` | required | Optional operation deadline. |
| `bash` | `BashIR | None` | required | Parsed shell representation, when applicable. |

### `omp.events.ToolExecutionStartEvent`

```python
ToolExecutionStartEvent(
    call_id: str,
    invocation_id: str,
    target: CallTarget,
    place: Place,
    deadline: Duration | None,
)
```

Carries the immutable payload for the `tool_execution_start` hook event.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `call_id` | `str` | required | Stable logical call identifier. |
| `invocation_id` | `str` | required | Stable executor invocation identifier. |
| `target` | `CallTarget` | required | Resolved logical call target. |
| `place` | `Place` | required | Execution placement. |
| `deadline` | `Duration | None` | required | Optional operation deadline. |

### `omp.events.ToolUpdateEvent`

```python
ToolUpdateEvent(call_id: str, target: CallTarget, update: Mapping[str, Any], coalesced: int)
```

Carries the immutable payload for the `tool_update` hook event.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `call_id` | `str` | required | Stable logical call identifier. |
| `target` | `CallTarget` | required | Resolved logical call target. |
| `update` | `Mapping[str, Any]` | required | Structured progress data. |
| `coalesced` | `int` | required | Number of raw updates folded into this payload. |

### `omp.events.ToolExecutionEndEvent`

```python
ToolExecutionEndEvent(
    call_id: str,
    target: CallTarget,
    outcome: OutcomeKind,
    duration: Duration,
    spilled: bool,
    artifact: ArtifactUrl | None,
    effects_unknown: bool,
)
```

Carries the immutable payload for the `tool_execution_end` hook event.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `call_id` | `str` | required | Stable logical call identifier. |
| `target` | `CallTarget` | required | Resolved logical call target. |
| `outcome` | `OutcomeKind` | required | Durable execution outcome category. |
| `duration` | `Duration` | required | Elapsed operation duration. |
| `spilled` | `bool` | required | Whether payload data was moved to an artifact. |
| `artifact` | `ArtifactUrl | None` | required | Related artifact URL, when present. |
| `effects_unknown` | `bool` | required | Whether external effects could not be determined. |

### `omp.events.ToolResultEvent`

```python
ToolResultEvent(
    call_id: str,
    target: CallTarget,
    outcome: OutcomeKind,
    payload: Mapping[str, Any] | None,
    fault: Mapping[str, Any] | None,
    abort: Mapping[str, Any] | None,
    artifact: ArtifactUrl | None,
    useless: bool,
    annotate: tuple[Annotation, ...] = (),
    spill: bool | None = None,
)
```

Carries the immutable payload for the `tool_result` hook event.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `call_id` | `str` | required | Stable logical call identifier. |
| `target` | `CallTarget` | required | Resolved logical call target. |
| `outcome` | `OutcomeKind` | required | Durable execution outcome category. |
| `payload` | `Mapping[str, Any] | None` | required | Structured successful result payload, when present. |
| `fault` | `Mapping[str, Any] | None` | required | Structured fault arm, when faulted. |
| `abort` | `Mapping[str, Any] | None` | required | Structured abort arm, when aborted. |
| `artifact` | `ArtifactUrl | None` | required | Related artifact URL, when present. |
| `useless` | `bool` | required | Whether the result was marked unhelpful to context. |
| `annotate` | `tuple[Annotation, ...]` | `()` | Annotations to append to the result. |
| `spill` | `bool | None` | `None` | Optional advice to spill the result. |

### `omp.events.ToolApprovalRequestedEvent`

```python
ToolApprovalRequestedEvent(
    call_id: str,
    ticket_id: str,
    target: CallTarget,
    reasons: tuple[str, ...],
    requested_by: str,
)
```

Carries the immutable payload for the `tool_approval_requested` hook event.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `call_id` | `str` | required | Stable logical call identifier. |
| `ticket_id` | `str` | required | Stable approval-ticket identifier. |
| `target` | `CallTarget` | required | Resolved logical call target. |
| `reasons` | `tuple[str, ...]` | required | Policy reasons merged into the approval request. |
| `requested_by` | `str` | required | Identity that requested approval. |

### `omp.events.ToolApprovalResolvedEvent`

```python
ToolApprovalResolvedEvent(
    call_id: str,
    ticket_id: str,
    target: CallTarget,
    approved: bool,
    reason: str | None,
    resolved_by: str,
    waited: Duration,
)
```

Carries the immutable payload for the `tool_approval_resolved` hook event.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `call_id` | `str` | required | Stable logical call identifier. |
| `ticket_id` | `str` | required | Stable approval-ticket identifier. |
| `target` | `CallTarget` | required | Resolved logical call target. |
| `approved` | `bool` | required | Whether the ticket was approved. |
| `reason` | `str | None` | required | Typed or textual cause of the event. |
| `resolved_by` | `str` | required | Identity that resolved the ticket. |
| `waited` | `Duration` | required | Time spent awaiting resolution. |

### `omp.events.DeviceListEvent`

```python
DeviceListEvent(devices: tuple[DeviceInfo, ...], turn_id: str | None)
```

Carries the immutable payload for the `device_list` hook event.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `devices` | `tuple[DeviceInfo, ...]` | required | Effective device descriptions. |
| `turn_id` | `str | None` | required | Stable model-turn identifier. |

### `omp.events.UserInputEvent`

```python
UserInputEvent(
    text: str,
    images: tuple[BlobRef, ...],
    source: InputSource,
    session_id: str,
    pasted: bool,
)
```

Carries the immutable payload for the `user_input` hook event.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `text` | `str` | required | Text carried by the event. |
| `images` | `tuple[BlobRef, ...]` | required | Submitted image blob references. |
| `source` | `InputSource` | required | Way the user submission entered the harness. |
| `session_id` | `str` | required | Stable session identifier. |
| `pasted` | `bool` | required | Whether the text was pasted. |

### `omp.events.UserBashEvent`

```python
UserBashEvent(
    command: str,
    cwd: EnvPath,
    exclude_from_context: bool,
    bash: BashIR | None,
    env_overrides: Mapping[str, str | None],
)
```

Carries the immutable payload for the `user_bash` hook event.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `command` | `str` | required | Shell command text. |
| `cwd` | `EnvPath` | required | Environment-scoped working directory. |
| `exclude_from_context` | `bool` | required | Whether the result stays out of projected context. |
| `bash` | `BashIR | None` | required | Parsed shell representation, when applicable. |
| `env_overrides` | `Mapping[str, str | None]` | required | Per-run environment additions and removals. |

### `omp.events.UserEvalEvent`

```python
UserEvalEvent(code: str, language: EvalLanguage, cwd: EnvPath, exclude_from_context: bool)
```

Carries the immutable payload for the `user_eval` hook event.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `code` | `str` | required | Evaluation source or stable error code. |
| `language` | `EvalLanguage` | required | Evaluation language. |
| `cwd` | `EnvPath` | required | Environment-scoped working directory. |
| `exclude_from_context` | `bool` | required | Whether the result stays out of projected context. |

### `omp.events.CommandInvokeEvent`

```python
CommandInvokeEvent(
    name: str,
    argv: tuple[str, ...],
    raw: str,
    mode: InvocationMode,
    source: InputSource,
)
```

Carries the immutable payload for the `command_invoke` hook event.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `name` | `str` | required | Parsed extension-command name. |
| `argv` | `tuple[str, ...]` | required | Parsed command arguments. |
| `raw` | `str` | required | Original unparsed command text. |
| `mode` | `InvocationMode` | required | Invocation mode. |
| `source` | `InputSource` | required | Way the command invocation entered the harness. |

### `omp.events.ResourcesDiscoverEvent`

```python
ResourcesDiscoverEvent(
    reason: DiscoverReason,
    root: EnvPath,
    found: tuple[ResourceRef, ...],
    add: tuple[ResourceRef, ...] = (),
    keep: frozenset[str] | None = None,
)
```

Carries the immutable payload for the `resources_discover` hook event.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `reason` | `DiscoverReason` | required | Typed or textual cause of the event. |
| `root` | `EnvPath` | required | Environment-scoped workspace root. |
| `found` | `tuple[ResourceRef, ...]` | required | Resources discovered by the host. |
| `add` | `tuple[ResourceRef, ...]` | `()` | Additional resources proposed by handlers. |
| `keep` | `frozenset[str] | None` | `None` | Optional set of resource URIs to retain. |

### `omp.events.ResourcesChangedEvent`

```python
ResourcesChangedEvent(
    added: tuple[ResourceRef, ...],
    removed: tuple[ResourceRef, ...],
    reason: DiscoverReason,
)
```

Carries the immutable payload for the `resources_changed` hook event.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `added` | `tuple[ResourceRef, ...]` | required | Resources added by the committed change. |
| `removed` | `tuple[ResourceRef, ...]` | required | Resources removed by the committed change. |
| `reason` | `DiscoverReason` | required | Typed or textual cause of the event. |

### `omp.events.CapabilityBudgetEvent`

```python
CapabilityBudgetEvent(
    turn_id: str,
    granted: tuple[Intent, ...],
    degraded: tuple[Intent, ...],
    refused: tuple[Intent, ...],
)
```

Carries the immutable payload for the `capability_budget` hook event.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `turn_id` | `str` | required | Stable model-turn identifier. |
| `granted` | `tuple[Intent, ...]` | required | Intents granted without degradation. |
| `degraded` | `tuple[Intent, ...]` | required | Intents granted with reduced capability. |
| `refused` | `tuple[Intent, ...]` | required | Intents not granted. |

### `omp.events.ModelChangedEvent`

```python
ModelChangedEvent(
    from_model: ModelRef | None,
    to_model: ModelRef,
    role: str,
    reason: ModelChangeReason,
    previous_thinking: Effort | None = None,
    thinking: Effort | None = None,
)
```

Carries the immutable payload for the `model_changed` hook event.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `from_model` | `ModelRef | None` | required | Previously selected model, when any. |
| `to_model` | `ModelRef` | required | Newly selected model. |
| `role` | `str` | required | Routing role whose selected model changed. |
| `reason` | `ModelChangeReason` | required | Typed or textual cause of the event. |
| `previous_thinking` | `Effort | None` | `None` | Reasoning effort before the model transition. |
| `thinking` | `Effort | None` | `None` | Selected reasoning effort. |

### `omp.events.CredentialDisabledEvent`

```python
CredentialDisabledEvent(provider: str, account: str | None, cause: str)
```

Carries the immutable payload for the `credential_disabled` hook event.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `provider` | `str` | required | Provider identifier. |
| `account` | `str | None` | required | Provider account identifier, when known. |
| `cause` | `str` | required | Diagnostic cause. |

### `omp.events.JobRegisteredEvent`

```python
JobRegisteredEvent(
    job_id: str,
    owner: str,
    call_id: str | None,
    lifetime: ArtifactLifetime,
    expected_artifact: ArtifactUrl | None,
)
```

Carries the immutable payload for the `job_registered` hook event.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `job_id` | `str` | required | Stable detached-job identifier. |
| `owner` | `str` | required | Owner of a detached job. |
| `call_id` | `str | None` | required | Stable logical call identifier. |
| `lifetime` | `ArtifactLifetime` | required | Retention policy for the expected artifact. |
| `expected_artifact` | `ArtifactUrl | None` | required | Artifact expected when the job settles. |

### `omp.events.JobSettledEvent`

```python
JobSettledEvent(
    job_id: str,
    owner: str,
    artifact: ArtifactUrl | None,
    failed: bool,
    duration: Duration,
)
```

Carries the immutable payload for the `job_settled` hook event.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `job_id` | `str` | required | Stable detached-job identifier. |
| `owner` | `str` | required | Owner of a detached job. |
| `artifact` | `ArtifactUrl | None` | required | Related artifact URL, when present. |
| `failed` | `bool` | required | Whether settlement represents failure. |
| `duration` | `Duration` | required | Elapsed operation duration. |

### `omp.events.ExtensionActivateEvent`

```python
ExtensionActivateEvent(
    extension: str,
    reason: ActivateReason,
    session_started_at: datetime,
    generation: int,
    trigger: str | None,
)
```

Carries the immutable payload for the `extension_activate` hook event.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `extension` | `str` | required | Extension identifier. |
| `reason` | `ActivateReason` | required | Typed or textual cause of the event. |
| `session_started_at` | `datetime` | required | Timestamp at which the active session began. |
| `generation` | `int` | required | Host or activation generation. |
| `trigger` | `str | None` | required | Declaration that triggered lazy activation. |

### `omp.events.ExtensionLoadEvent`

```python
ExtensionLoadEvent(extension: str, version: str, source: str, trust: Trust, reloaded: bool)
```

Carries the immutable payload for the `extension_load` hook event.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `extension` | `str` | required | Extension identifier. |
| `version` | `str` | required | Extension version. |
| `source` | `str` | required | Package or build source loaded by the host. |
| `trust` | `Trust` | required | Effective trust level. |
| `reloaded` | `bool` | required | Whether this load replaced an earlier build. |

### `omp.events.ExtensionUnloadEvent`

```python
ExtensionUnloadEvent(extension: str, reason: UnloadReason, pending_hooks: int)
```

Carries the immutable payload for the `extension_unload` hook event.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `extension` | `str` | required | Extension identifier. |
| `reason` | `UnloadReason` | required | Typed or textual cause of the event. |
| `pending_hooks` | `int` | required | Callbacks pending when unload began. |

### `omp.events.HostReconnectEvent`

```python
HostReconnectEvent(generation: int, missed_events: int, restart_cause: str, uptime: Duration)
```

Carries the immutable payload for the `host_reconnect` hook event.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `generation` | `int` | required | Host or activation generation. |
| `missed_events` | `int` | required | Number of events missed before reconnect. |
| `restart_cause` | `str` | required | Reason the host generation was replaced. |
| `uptime` | `Duration` | required | Replacement host uptime. |

### `omp.events.TtsrTriggeredEvent`

```python
TtsrTriggeredEvent(
    session_id: str,
    turn_id: str,
    sequence: int,
    rule: str,
    matched: str,
    interrupted: bool,
)
```

Carries the immutable payload for the `ttsr_triggered` hook event.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `session_id` | `str` | required | Stable session identifier. |
| `turn_id` | `str` | required | Stable model-turn identifier. |
| `sequence` | `int` | required | Monotonic sequence within the lifecycle stream. |
| `rule` | `str` | required | Identifier of the triggered rule. |
| `matched` | `str` | required | Text or pattern fragment that matched. |
| `interrupted` | `bool` | required | Whether execution was interrupted. |

### `omp.events.RetryLifecycleEvent`

```python
RetryLifecycleEvent(
    session_id: str,
    turn_id: str,
    sequence: int,
    attempt: int,
    maximum: int,
    delay_ms: int,
    reason: str,
    outcome: str | None = None,
)
```

Carries the shared immutable payload for `retry_start` and `retry_end` notifications.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `session_id` | `str` | required | Stable session identifier. |
| `turn_id` | `str` | required | Stable model-turn identifier. |
| `sequence` | `int` | required | Monotonic sequence within the lifecycle stream. |
| `attempt` | `int` | required | Current attempt number. |
| `maximum` | `int` | required | Maximum configured retry attempts. |
| `delay_ms` | `int` | required | Delay before the retry, in milliseconds. |
| `reason` | `str` | required | Typed or textual cause of the event. |
| `outcome` | `str | None` | `None` | Terminal retry outcome on `retry_end`; otherwise `None`. |

### `omp.events.FallbackLifecycleEvent`

```python
FallbackLifecycleEvent(
    session_id: str,
    turn_id: str,
    sequence: int,
    source_model: str,
    target_model: str,
    reason: str,
)
```

Carries the shared immutable payload for `fallback_applied` and `fallback_succeeded` notifications.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `session_id` | `str` | required | Stable session identifier. |
| `turn_id` | `str` | required | Stable model-turn identifier. |
| `sequence` | `int` | required | Monotonic sequence within the lifecycle stream. |
| `source_model` | `str` | required | Model being replaced. |
| `target_model` | `str` | required | Fallback model selected. |
| `reason` | `str` | required | Typed or textual cause of the event. |

### `omp.events.McpNotificationEvent`

```python
McpNotificationEvent(server: str, method: str, params: Any | None, sequence: int)
```

Carries the immutable payload for the `mcp_notification` hook event.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `server` | `str` | required | Mounted MCP server name. |
| `method` | `str` | required | MCP notification method. |
| `params` | `Any | None` | required | Notification parameters, when supplied. |
| `sequence` | `int` | required | Monotonic sequence within the lifecycle stream. |

### `omp.events.ProviderResponseEvent`

```python
ProviderResponseEvent(
    provider: str,
    model: ModelRef,
    status: int,
    headers: Mapping[str, str],
    request_id: str | None,
)
```

Carries the immutable payload for the `provider_response` hook event.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `provider` | `str` | required | Provider identifier. |
| `model` | `ModelRef` | required | Selected inference model. |
| `status` | `int` | required | HTTP response status code. |
| `headers` | `Mapping[str, str]` | required | Response headers. |
| `request_id` | `str | None` | required | Provider request identifier, when supplied. |

### `omp.events.SessionRenamedEvent`

```python
SessionRenamedEvent(session: str, name: str | None)
```

Carries the immutable payload for the `session_renamed` hook event.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `session` | `str` | required | Live session identifier. |
| `name` | `str | None` | required | Committed live-session name, or `None` when cleared. |

### `omp.events.EventSpec`

```python
EventSpec(
    name: str,
    id: int,
    rev: int,
    payload: type,
    returns: object | None,
    channel: Channel,
    phase: HookPhase | str | None,
    latency: LatencyClass,
    on_failure: OnFailure,
    default_decision: type | None,
    reentrant: bool,
    gateable: bool,
    fields: Mapping[str, Composition],
    default_timeout: Duration,
    ceiling_timeout: Duration,
)
```

Describes one immutable row in the hook event catalog.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `name` | `str` | required | Frozen event name. |
| `id` | `int` | required | Stable numeric event identifier. |
| `rev` | `int` | required | Payload schema revision. |
| `payload` | `type` | required | Python class used to decode the event payload. |
| `returns` | `object | None` | required | Declared callback result type, or `None` for a notification. |
| `channel` | `Channel` | required | Transport used for dispatch. |
| `phase` | `HookPhase | str | None` | required | Catalog-supplied fixed phase, domain marker, or `None`. |
| `latency` | `LatencyClass` | required | Frequency and deadline class. |
| `on_failure` | `OnFailure` | required | Catalog failure policy. |
| `default_decision` | `type | None` | required | Decision type used when no handler decides. |
| `reentrant` | `bool` | required | Whether callbacks may make supported nested CONTROL calls. |
| `gateable` | `bool` | required | Whether Core composes a `HookDecision` for the event. |
| `fields` | `Mapping[str, Composition]` | required | Immutable map of mutable field names to composition rules. |
| `default_timeout` | `Duration` | required | Handler deadline used when the decorator omits one. |
| `ceiling_timeout` | `Duration` | required | Largest timeout a subscription may request. |
