# `omp.telemetry`

Use `omp.telemetry` to observe settled harness activity, declare extension metrics and spans, export telemetry, or query the durable telemetry index. Subscription delivery is lossy and post-hoc: use it for observation, not for a correctness-critical workflow.

`ModelRequest`, `PromptFingerprint`, and `TelemetryError` are also available directly from `omp`.

```python
import omp

@omp.telemetry([omp.telemetry.Kind.MODEL_REQUEST])
async def observe_usage(event: omp.telemetry.ModelRequest, ctx: omp.Context) -> None:
    print(event.served_model, event.usage.total, event.latency_ms)
```

## Subscription declarations

### `omp.telemetry`

```python
omp.telemetry(
    kinds: Sequence[Kind | str],
    *,
    scope: Scope = Scope.TREE,
    queue: int = QUEUE_DEFAULT,
    overflow: Overflow = Overflow.DROP_OLDEST,
    coalesce_key: Callable[[object], Hashable] | None = None,
    batch: int | None = None,
    replay: bool = False,
    replay_limit: int = 2048,
)
```

Declares a telemetry subscription by decorating a callable.

The decorated callable receives `(event, ctx)`. When `batch` is set, `event` is a tuple of decoded events; otherwise it is one event. A returned awaitable is awaited. The declaration is registered when the module is imported, and the original callable is returned unchanged.

| Parameter | Type | Meaning |
|---|---|---|
| `kinds` | `Sequence[Kind | str]` | Non-empty event-kind filter. |
| `scope` | `Scope` | Agent extent visible to the subscription. |
| `queue` | `int` | Ring capacity from `1` through `QUEUE_MAX`. |
| `overflow` | `Overflow` | Full-ring strategy. |
| `coalesce_key` | `Callable[[object], Hashable] | None` | Key function required only with `COALESCE_BY_KEY`. |
| `batch` | `int | None` | Batch size from `2` through `BATCH_MAX`, or one-at-a-time delivery. |
| `replay` | `bool` | Whether to request already-recorded matching events. |
| `replay_limit` | `int` | Positive maximum replay count. |

**Returns:** A decorator that returns its callable unchanged.

**Raises:** `SubscriptionError` for invalid kinds or limits and inconsistent overflow settings; `TypeError` if the decorated value is not callable.

### `omp.telemetry.Kind`

```python
class Kind(StrEnum)
```

Names the core telemetry event vocabulary.

| Member | Wire value | Meaning |
|---|---|---|
| `SESSION_START` | `"session_start"` | A session opened or resumed. |
| `SESSION_END` | `"session_end"` | A session ended. |
| `TURN_START` | `"turn_start"` | A turn started. |
| `TURN_END` | `"turn_end"` | A turn settled. |
| `MODEL_REQUEST` | `"model_request"` | A model request settled. |
| `MODEL_ATTEMPT` | `"model_attempt"` | A model attempt was recorded. |
| `PROVIDER_ERROR` | `"provider_error"` | A provider error occurred. |
| `TOOL_CALL` | `"tool_call"` | A tool call settled. |
| `CAPABILITY_DEGRADED` | `"capability_degraded"` | A requested capability was reduced. |
| `COMPACTION` | `"compaction"` | Context compaction settled. |
| `BRANCH` | `"branch"` | A conversation branch changed. |
| `ARTIFACT_SPILL` | `"artifact_spill"` | Content spilled to an artifact. |
| `ISSUE_REPORT` | `"issue_report"` | An issue report was filed. |
| `HOST_WARNING` | `"host_warning"` | The host emitted a warning. |

Only some kinds currently receive specialized Python event classes; other decoded kinds are represented by `Envelope`.

### `omp.telemetry.Scope`

```python
class Scope(StrEnum)
```

Controls which agents a subscription or query can see.

| Member | Wire value | Meaning |
|---|---|---|
| `SELF` | `"self"` | The current agent only. |
| `TREE` | `"tree"` | The current agent tree. |
| `PROJECT` | `"project"` | Project-wide scope. |

### `omp.telemetry.Overflow`

```python
class Overflow(StrEnum)
```

Selects bounded-ring behavior when a subscriber falls behind.

| Member | Wire value | Meaning |
|---|---|---|
| `DROP_OLDEST` | `"drop_oldest"` | Discard the oldest queued item. |
| `DROP_NEWEST` | `"drop_newest"` | Discard the incoming item. |
| `COALESCE_BY_KEY` | `"coalesce_by_key"` | Combine queued items by a subscriber-supplied key. |

### `omp.telemetry.DropStats`

```python
DropStats(
    delivered: int,
    dropped: int,
    coalesced: int,
    errored: int,
    replay_skipped: int,
    queue_depth: int,
    first_drop_seq: int | None,
    since_ms: int,
)
```

Reports delivery and loss for one subscription ring.

| Field | Type | Default | Meaning |
|---|---|---:|---|
| `delivered` | `int` | required | Delivered items. |
| `dropped` | `int` | required | Items discarded by overflow. |
| `coalesced` | `int` | required | Items combined by key. |
| `errored` | `int` | required | Sink deliveries that raised. |
| `replay_skipped` | `int` | required | Matching replay items omitted by the replay limit. |
| `queue_depth` | `int` | required | Current queued item count. |
| `first_drop_seq` | `int | None` | required | Sequence of the first drop, when known. |
| `since_ms` | `int` | required | Start of the statistics interval. |

### `omp.telemetry.dropped`

```python
dropped(sink: object | None = None) -> DropStats | Mapping[str, DropStats]
```

Reads locally known subscription loss counters.

Pass a decorated sink to read its counters. With no argument, you receive an immutable mapping keyed by qualified sink name. An unknown sink returns zeroed statistics.

## Model usage and prompt fingerprints

### `omp.telemetry.StopReason`

```python
class StopReason(StrEnum)
```

Normalizes why model generation stopped.

| Member | Wire value | Meaning |
|---|---|---|
| `END_TURN` | `"end_turn"` | The model completed its turn. |
| `TOOL_USE` | `"tool_use"` | The model requested a tool. |
| `MAX_TOKENS` | `"max_tokens"` | The output limit was reached. |
| `CONTENT_FILTER` | `"content_filter"` | Provider filtering stopped output. |
| `UNSPECIFIED` | `"unspecified"` | No more specific reason was supplied. |

### `omp.telemetry.DegradeAction`

```python
class DegradeAction(StrEnum)
```

Describes how an unsupported request feature was handled.

| Member | Wire value | Meaning |
|---|---|---|
| `DROPPED` | `"dropped"` | The feature was omitted. |
| `EMULATED` | `"emulated"` | The harness approximated it. |
| `CLAMPED` | `"clamped"` | The requested value was restricted. |

### `omp.telemetry.Tokens`

```python
Tokens(
    input: int = 0,
    output: int = 0,
    cache_read: int = 0,
    cache_write: int = 0,
    reasoning: int = 0,
    total: int = 0,
    context: int | None = None,
    premium_requests: int = 0,
    cache_ttl_5m: int = 0,
    cache_ttl_1h: int = 0,
    server_web_search: int = 0,
    server_web_fetch: int = 0,
    orchestration_input: int = 0,
    orchestration_output: int = 0,
    orchestration_cache_read: int = 0,
    detail: Mapping[str, int | float | str] = field(default_factory=dict),
)
```

Contains unabridged usage buckets for a settled request.

| Field | Type | Default | Meaning |
|---|---|---:|---|
| `input` | `int` | `0` | Input tokens. |
| `output` | `int` | `0` | Output tokens. |
| `cache_read` | `int` | `0` | Input tokens read from cache. |
| `cache_write` | `int` | `0` | Input tokens written to cache. |
| `reasoning` | `int` | `0` | Reasoning tokens. |
| `total` | `int` | `0` | Total reported tokens. |
| `context` | `int | None` | `None` | Context usage when reported. |
| `premium_requests` | `int` | `0` | Provider premium-request units. |
| `cache_ttl_5m` | `int` | `0` | Tokens written with a five-minute cache lifetime. |
| `cache_ttl_1h` | `int` | `0` | Tokens written with a one-hour cache lifetime. |
| `server_web_search` | `int` | `0` | Provider-side web search usage. |
| `server_web_fetch` | `int` | `0` | Provider-side web fetch usage. |
| `orchestration_input` | `int` | `0` | Orchestration input tokens. |
| `orchestration_output` | `int` | `0` | Orchestration output tokens. |
| `orchestration_cache_read` | `int` | `0` | Cached orchestration input tokens. |
| `detail` | `Mapping[str, int | float | str]` | new empty mapping | Provider-specific usage details. |

`uncached_input: int` returns `max(0, input - cache_read - cache_write)`. `cache_hit_rate: float` returns `cache_read / input`, or `0.0` when `input` is zero.

### `omp.telemetry.PromptSlotFingerprint`

```python
PromptSlotFingerprint(digest: str, size_bytes: int, band: SlotClass)
```

Identifies one assembler-owned prompt slot.

| Field | Type | Default | Meaning |
|---|---|---:|---|
| `digest` | `str` | required | Content digest. |
| `size_bytes` | `int` | required | Encoded slot size. |
| `band` | `SlotClass` | required | Prompt slot band; see [omp.prompts](omp.prompts.md). |

### `omp.telemetry.PromptFingerprint`

```python
PromptFingerprint(
    digest: str,
    slots: Mapping[str, PromptSlotFingerprint],
    changed: tuple[str, ...],
    prefix_stable_bytes: int,
    cache_key: str,
    retention: str,
    mode: str,
    ttl: str,
    breakpoint: str,
    breakpoint_indices: tuple[int, ...],
)
```

Captures prompt-prefix and cache-breakpoint facts owned by the prompt assembler.

| Field | Type | Default | Meaning |
|---|---|---:|---|
| `digest` | `str` | required | Overall prompt digest. |
| `slots` | `Mapping[str, PromptSlotFingerprint]` | required | Fingerprints keyed by slot name. |
| `changed` | `tuple[str, ...]` | required | Slots changed from the comparison point. |
| `prefix_stable_bytes` | `int` | required | Stable prefix size. |
| `cache_key` | `str` | required | Assembler cache key. |
| `retention` | `str` | required | Cache retention selection. |
| `mode` | `str` | required | Cache mode. |
| `ttl` | `str` | required | Cache lifetime selection. |
| `breakpoint` | `str` | required | Breakpoint strategy. |
| `breakpoint_indices` | `tuple[int, ...]` | required | Selected breakpoint indices. |

### `omp.telemetry.Degradation`

```python
Degradation(what: str, detail: str, action: DegradeAction)
```

Records one requested feature the provider path could not honor.

| Field | Type | Default | Meaning |
|---|---|---:|---|
| `what` | `str` | required | Feature affected. |
| `detail` | `str` | required | Explanation. |
| `action` | `DegradeAction` | required | Handling applied. |

### `omp.telemetry.ModelRequest`

```python
ModelRequest(
    seq: int,
    usage: Tokens,
    prompt: PromptFingerprint,
    served_model: str,
    latency_ms: int,
    ttft_ms: int | None,
    degraded: tuple[Degradation, ...],
    request_content: bytes | None = None,
    response_content: bytes | None = None,
)
```

Provides the frozen Python view of a settled model request.

| Field | Type | Default | Meaning |
|---|---|---:|---|
| `seq` | `int` | required | Event sequence. |
| `usage` | `Tokens` | required | Settled token usage. |
| `prompt` | `PromptFingerprint` | required | Prompt and cache fingerprint. |
| `served_model` | `str` | required | Model that served the request. |
| `latency_ms` | `int` | required | End-to-end latency in milliseconds. |
| `ttft_ms` | `int | None` | required | Time to first token when available. |
| `degraded` | `tuple[Degradation, ...]` | required | Provider-path degradations. |
| `request_content` | `bytes | None` | `None` | Captured request bytes when granted. |
| `response_content` | `bytes | None` | `None` | Captured response bytes when granted. |

## Event views

All event dataclasses are frozen and slotted.

### `omp.telemetry.TraceRef`

```python
TraceRef(trace_id: str, span_id: str, sampled: bool)
```

Identifies the trace and span associated with an event.

| Field | Type | Default | Meaning |
|---|---|---:|---|
| `trace_id` | `str` | required | Trace identifier. |
| `span_id` | `str` | required | Span identifier. |
| `sampled` | `bool` | required | Whether the trace is sampled. |

### `omp.telemetry.ExtensionRef`

```python
ExtensionRef(publisher: str, id: str, version: str, digest: str, layer: str, trust: str, generation: int)
```

Pins an event to an installed extension build.

| Field | Type | Default | Meaning |
|---|---|---:|---|
| `publisher` | `str` | required | Publisher identity. |
| `id` | `str` | required | Extension identifier. |
| `version` | `str` | required | Installed version. |
| `digest` | `str` | required | Build digest. |
| `layer` | `str` | required | Installation layer. |
| `trust` | `str` | required | Trust classification. |
| `generation` | `int` | required | Host generation. |

### `omp.telemetry.Envelope`

```python
Envelope(kind: Kind, seq: int, at_ms: int, session: str, agent: str, depth: int, conversation: str, trace: TraceRef | None, principal: str, generation: int)
```

Carries the identity, ordering, and trace fields common to event records.

| Field | Type | Default | Meaning |
|---|---|---:|---|
| `kind` | `Kind` | required | Event kind. |
| `seq` | `int` | required | Ordered event sequence. |
| `at_ms` | `int` | required | Event time in milliseconds. |
| `session` | `str` | required | Session identifier. |
| `agent` | `str` | required | Agent identifier. |
| `depth` | `int` | required | Agent-tree depth. |
| `conversation` | `str` | required | Conversation identifier. |
| `trace` | `TraceRef | None` | required | Trace identity, if available. |
| `principal` | `str` | required | Emitting principal. |
| `generation` | `int` | required | Host generation. |

### `omp.telemetry.Cost`

```python
Cost(nanos_usd: int, estimated: bool, input_nanos_usd: int | None, output_nanos_usd: int | None, cache_read_nanos_usd: int | None, cache_write_nanos_usd: int | None, unavailable_reason: str | None)
```

Represents request cost in exact nano-US dollars.

| Field | Type | Default | Meaning |
|---|---|---:|---|
| `nanos_usd` | `int` | required | Total nano-USD. |
| `estimated` | `bool` | required | Whether pricing is estimated. |
| `input_nanos_usd` | `int | None` | required | Input component. |
| `output_nanos_usd` | `int | None` | required | Output component. |
| `cache_read_nanos_usd` | `int | None` | required | Cache-read component. |
| `cache_write_nanos_usd` | `int | None` | required | Cache-write component. |
| `unavailable_reason` | `str | None` | required | Why pricing is unavailable, if applicable. |

`usd: float` converts the total to US dollars for display.

### `omp.telemetry.ContextSnapshot`

```python
ContextSnapshot(prompt_tokens: int, non_message_tokens: int, history_rewrite_tokens_removed: int, last_message_at_ms: int | None, window: int, percent: float)
```

Captures context-window occupancy at an event boundary.

| Field | Type | Default | Meaning |
|---|---|---:|---|
| `prompt_tokens` | `int` | required | Prompt tokens. |
| `non_message_tokens` | `int` | required | Tokens outside messages. |
| `history_rewrite_tokens_removed` | `int` | required | Tokens removed by history rewriting. |
| `last_message_at_ms` | `int | None` | required | Time of the last message. |
| `window` | `int` | required | Context-window size. |
| `percent` | `float` | required | Window occupancy percentage. |

### `omp.telemetry.SessionStart`

```python
SessionStart(kind: Kind, seq: int, at_ms: int, session: str, agent: str, depth: int, conversation: str, trace: TraceRef | None, principal: str, generation: int, resumed: bool, parent: str | None, cwd: EnvPath, place: Place, remote: str | None, model: str, provider: str, devices: tuple[str, ...], core_tools: tuple[str, ...], extensions: tuple[ExtensionRef, ...], schema_rev: str, prompt: PromptFingerprint, registry_hash: str)
```

Describes a session opening or resumption. In addition to all `Envelope` fields, it records resumption state, parent, environment location, route, available tools and extensions, schema revision, prompt fingerprint, and registry hash.
The inherited fields are documented under `Envelope`; this table lists the fields added by `SessionStart`.

| Field | Type | Default | Meaning |
|---|---|---:|---|
| `resumed` | `bool` | required | Whether this resumes an existing session. |
| `parent` | `str | None` | required | Parent session identifier. |
| `cwd` | `EnvPath` | required | Environment working directory. |
| `place` | `Place` | required | Execution placement; see [omp.placement](omp.placement.md). |
| `remote` | `str | None` | required | Remote identity, when applicable. |
| `model` | `str` | required | Selected model. |
| `provider` | `str` | required | Selected provider. |
| `devices` | `tuple[str, ...]` | required | Available extension devices. |
| `core_tools` | `tuple[str, ...]` | required | Available core tools. |
| `extensions` | `tuple[ExtensionRef, ...]` | required | Installed extension builds. |
| `schema_rev` | `str` | required | Active schema revision. |
| `prompt` | `PromptFingerprint` | required | Starting prompt fingerprint. |
| `registry_hash` | `str` | required | Declaration-registry hash. |

### `omp.telemetry.SessionEnd`

```python
SessionEnd(kind: Kind, seq: int, at_ms: int, session: str, agent: str, depth: int, conversation: str, trace: TraceRef | None, principal: str, generation: int, reason: str, turns: int, requests: int, calls: int, tokens: Tokens, cost: Cost | None, wall_ms: int, faults: int, issues: int)
```

Reports final session totals. Inherited fields are documented under `Envelope`.

| Field | Type | Default | Meaning |
|---|---|---:|---|
| `reason` | `str` | required | Session-end reason. |
| `turns` | `int` | required | Total turns. |
| `requests` | `int` | required | Total model requests. |
| `calls` | `int` | required | Total tool calls. |
| `tokens` | `Tokens` | required | Lifetime token usage. |
| `cost` | `Cost | None` | required | Lifetime cost, when available. |
| `wall_ms` | `int` | required | Session wall time. |
| `faults` | `int` | required | Fault count. |
| `issues` | `int` | required | Issue-report count. |

### `omp.telemetry.TurnStart`

```python
TurnStart(kind: Kind, seq: int, at_ms: int, session: str, agent: str, depth: int, conversation: str, trace: TraceRef | None, principal: str, generation: int, turn: int, trigger: str, input_chars: int, input_parts: int, attachments: int, model: str, effort: str | None)
```

Describes the admitted turn input and selected model route. Inherited fields are documented under `Envelope`.

| Field | Type | Default | Meaning |
|---|---|---:|---|
| `turn` | `int` | required | Turn number. |
| `trigger` | `str` | required | Turn trigger. |
| `input_chars` | `int` | required | Input character count. |
| `input_parts` | `int` | required | Input part count. |
| `attachments` | `int` | required | Attachment count. |
| `model` | `str` | required | Selected model. |
| `effort` | `str | None` | required | Requested effort, when set. |

### `omp.telemetry.TurnEnd`

```python
TurnEnd(kind: Kind, seq: int, at_ms: int, session: str, agent: str, depth: int, conversation: str, trace: TraceRef | None, principal: str, generation: int, turn: int, steps: int, requests: int, calls: int, tokens: Tokens, cost: Cost | None, latency_ms: int, stop: StopReason, tools_used: tuple[str, ...], faults: int, interrupted: bool, context: ContextSnapshot)
```

Reports a settled turn's result. Inherited fields are documented under `Envelope`.

| Field | Type | Default | Meaning |
|---|---|---:|---|
| `turn` | `int` | required | Turn number. |
| `steps` | `int` | required | Agent steps. |
| `requests` | `int` | required | Model requests. |
| `calls` | `int` | required | Tool calls. |
| `tokens` | `Tokens` | required | Turn token usage. |
| `cost` | `Cost | None` | required | Turn cost, when available. |
| `latency_ms` | `int` | required | Turn latency. |
| `stop` | `StopReason` | required | Normalized stop reason. |
| `tools_used` | `tuple[str, ...]` | required | Tool wire names used. |
| `faults` | `int` | required | Fault count. |
| `interrupted` | `bool` | required | Whether the turn was interrupted. |
| `context` | `ContextSnapshot` | required | Context occupancy at settlement. |

### `omp.telemetry.CapabilityDegraded`

```python
CapabilityDegraded(kind: Kind, seq: int, at_ms: int, session: str, agent: str, depth: int, conversation: str, trace: TraceRef | None, principal: str, generation: int, intent: str, tool: str | None, rev: Rev | None, requested_priority: int, granted: bool, reason: str, provider: str, budget_used: int, budget_total: int)
```

Records how the provider constraint budget treated one capability intent. Inherited fields are documented under `Envelope`.

| Field | Type | Default | Meaning |
|---|---|---:|---|
| `intent` | `str` | required | Capability intent. |
| `tool` | `str | None` | required | Associated tool, when applicable. |
| `rev` | `Rev | None` | required | Associated tool revision. |
| `requested_priority` | `int` | required | Requested priority. |
| `granted` | `bool` | required | Whether the intent was granted. |
| `reason` | `str` | required | Resolution reason. |
| `provider` | `str` | required | Provider path. |
| `budget_used` | `int` | required | Constraint budget consumed. |
| `budget_total` | `int` | required | Total constraint budget. |

### `omp.telemetry.Compaction`

```python
Compaction(kind: Kind, seq: int, at_ms: int, session: str, agent: str, depth: int, conversation: str, trace: TraceRef | None, principal: str, generation: int, reason: str, strategy: str, by: str | None, tokens_before: int, tokens_after: int, items_before: int, items_after: int, prompt_text_dropped_bytes: int, outcomes_kept: int, artifacts_promoted: tuple[ArtifactUrl, ...], duration_ms: int, aborted: bool, epoch: int)
```

Measures one context-compaction attempt. Inherited fields are documented under `Envelope`.

| Field | Type | Default | Meaning |
|---|---|---:|---|
| `reason` | `str` | required | Compaction reason. |
| `strategy` | `str` | required | Strategy used. |
| `by` | `str | None` | required | Initiator, when identified. |
| `tokens_before` | `int` | required | Token count before compaction. |
| `tokens_after` | `int` | required | Token count after compaction. |
| `items_before` | `int` | required | Item count before compaction. |
| `items_after` | `int` | required | Item count after compaction. |
| `prompt_text_dropped_bytes` | `int` | required | Prompt bytes removed. |
| `outcomes_kept` | `int` | required | Outcomes retained. |
| `artifacts_promoted` | `tuple[ArtifactUrl, ...]` | required | Promoted artifacts. |
| `duration_ms` | `int` | required | Compaction duration. |
| `aborted` | `bool` | required | Whether compaction aborted. |
| `epoch` | `int` | required | Compaction epoch. |

### `omp.telemetry.IssueReport`

```python
IssueReport(kind: Kind, seq: int, at_ms: int, session: str, agent: str, depth: int, conversation: str, trace: TraceRef | None, principal: str, generation: int, issue: str, tool: str, rev: Rev, summary: str, expected: str | None, observed: str | None, reporter: str, reporter_id: str | None, call_id: str | None, turn: int, args_raw: str | None, payload: object | None, fault: object | None, repairs: tuple[object, ...], labels: tuple[str, ...], consent: object)
```

Carries a durable issue report. Inherited fields are documented under `Envelope`.

| Field | Type | Default | Meaning |
|---|---|---:|---|
| `issue` | `str` | required | Issue identifier. |
| `tool` | `str` | required | Tool wire name. |
| `rev` | `Rev` | required | Tool revision. |
| `summary` | `str` | required | Concise report. |
| `expected` | `str | None` | required | Expected behavior. |
| `observed` | `str | None` | required | Observed behavior. |
| `reporter` | `str` | required | Reporter kind. |
| `reporter_id` | `str | None` | required | Reporter identity. |
| `call_id` | `str | None` | required | Related call identifier. |
| `turn` | `int` | required | Related turn. |
| `args_raw` | `str | None` | required | Raw emitted arguments when captured. |
| `payload` | `object | None` | required | Structured success payload. |
| `fault` | `object | None` | required | Structured fault. |
| `repairs` | `tuple[object, ...]` | required | Applied repairs. |
| `labels` | `tuple[str, ...]` | required | Issue labels. |
| `consent` | `object` | required | Capture-consent record. |

### `omp.telemetry.Event`

```python
Event = SessionStart | SessionEnd | TurnStart | TurnEnd | ModelRequest | CapabilityDegraded | Compaction | IssueReport
```

Defines the closed union of event values that the Python host currently materializes as specialized types.

## Extension metrics

Instrument declarations are cached by local name. Repeating an identical declaration returns the existing object; a conflicting declaration raises `SubscriptionError`. Metric names are emitted as `omp.ext.<extension-id>.<local-name>`. New attribute series beyond `MAX_CARDINALITY` are folded into `overflow="true"`.

### `omp.telemetry.Counter`

```python
Counter(local: str, unit: str, description: str)
```

Represents an extension-owned monotonic counter. Prefer `counter()` over constructing it directly.

```python
requests = omp.telemetry.counter("requests", unit="1", description="Requests handled")
requests.add(1, route="search")
```

`name: str` returns the fully qualified metric name.

```python
add(value: int | float = 1, /, **attrs: str | int | float | bool) -> None
```

Adds a non-negative value. The call is discarded when no exporter sink is installed.

**Raises:** `ValueError` for a negative increment; `TypeError` for a non-scalar attribute value.

### `omp.telemetry.Histogram`

```python
Histogram(local: str, unit: str, description: str, boundaries: tuple[int | float, ...] | None)
```

Represents an extension-owned histogram. Prefer `histogram()` over constructing it directly. `name: str` returns the fully qualified metric name.

```python
record(value: int | float, /, **attrs: str | int | float | bool) -> None
```

Records one observation, or discards it when no exporter sink is installed.

**Raises:** `TypeError` for a non-scalar attribute value.

### `omp.telemetry.counter`

```python
counter(name: str, *, unit: str, description: str) -> Counter
```

Creates or retrieves a monotonic counter declaration.

**Raises:** `SubscriptionError` for an empty or reserved name, a conflicting declaration, or more than `MAX_INSTRUMENTS` declarations.

### `omp.telemetry.histogram`

```python
histogram(name: str, *, unit: str, description: str, boundaries: Sequence[int | float] | None = None) -> Histogram
```

Creates or retrieves a histogram declaration. Explicit boundaries must be strictly increasing.

**Raises:** `ValueError` for unsorted or repeated boundaries; `SubscriptionError` for an invalid name, conflict, or quota overflow.

## Export targets

### `omp.telemetry.ExportTarget`

```python
ExportTarget()
```

Is the frozen base class for declarative export targets.

| Field | Type | Default | Meaning |
|---|---|---:|---|
| — | — | — | This base dataclass defines no fields. |

### `omp.telemetry.OtlpTarget`

```python
OtlpTarget(endpoint: str, protocol: str = "http/protobuf", headers: Mapping[str, str] = field(default_factory=lambda: _EMPTY_MAP), signals: Sequence[str] = ("traces", "metrics", "logs"), resource_attributes: Mapping[str, str] = field(default_factory=lambda: _EMPTY_MAP), timeout: Duration = Duration("10s"), compression: str | None = "gzip")
```

Describes an OpenTelemetry Protocol destination.

| Field | Type | Default | Meaning |
|---|---|---:|---|
| `endpoint` | `str` | required | Collector endpoint. |
| `protocol` | `str` | `"http/protobuf"` | OTLP transport; this is the only accepted value. |
| `headers` | `Mapping[str, str]` | empty | Request headers. |
| `signals` | `Sequence[str]` | traces, metrics, logs | Signals to export. |
| `resource_attributes` | `Mapping[str, str]` | empty | Resource attributes. |
| `timeout` | `Duration` | `Duration("10s")` | Export timeout. |
| `compression` | `str | None` | `"gzip"` | Compression selection. |

### `omp.telemetry.ProcessTarget`

```python
ProcessTarget(process: str, framing: str = "jsonl", flush_every: Duration = Duration("1s"), handshake: Mapping[str, object] | None = None)
```

Sends telemetry to an Environment-supervised process.

| Field | Type | Default | Meaning |
|---|---|---:|---|
| `process` | `str` | required | Named process. |
| `framing` | `str` | `"jsonl"` | `"jsonl"` or `"lenprefix"`. |
| `flush_every` | `Duration` | `Duration("1s")` | Flush interval. |
| `handshake` | `Mapping[str, object] | None` | `None` | Optional startup handshake. |

### `omp.telemetry.FileTarget`

```python
FileTarget(path: EnvPath, framing: str = "jsonl", rotate_bytes: int = 67108864, keep: int = 4)
```

Writes framed telemetry to an Environment file.

| Field | Type | Default | Meaning |
|---|---|---:|---|
| `path` | `EnvPath` | required | Destination path. |
| `framing` | `str` | `"jsonl"` | `"jsonl"` or `"lenprefix"`. |
| `rotate_bytes` | `int` | `67108864` | Rotation threshold. |
| `keep` | `int` | `4` | Rotated files retained. |

### `omp.telemetry.ExportStats`

```python
ExportStats(sent: int = 0, dropped: int = 0, failures: int = 0, queue_depth: int = 0, last_flush_ms: int = 0, last_error: str | None = None, backoff_ms: int = 0)
```

Reports delivery state for one exporter.

| Field | Type | Default | Meaning |
|---|---|---:|---|
| `sent` | `int` | `0` | Records sent. |
| `dropped` | `int` | `0` | Records dropped. |
| `failures` | `int` | `0` | Export failures. |
| `queue_depth` | `int` | `0` | Pending records. |
| `last_flush_ms` | `int` | `0` | Last flush time. |
| `last_error` | `str | None` | `None` | Latest error text. |
| `backoff_ms` | `int` | `0` | Current retry backoff. |

### `omp.telemetry.ExportHandle`

```python
ExportHandle(export_id: int, target: ExportTarget)
```

Controls one registered exporter. `target: ExportTarget` returns its declaration.

```python
async stop() -> None
async stats() -> ExportStats
```

`stop()` performs a final flush and stops the target. `stats()` retrieves current delivery statistics. Both require a wired CONTROL backend and may raise `NotWiredError`; `stats()` raises `TypeError` for an invalid host response.

### `omp.telemetry.export`

```python
export(target: ExportTarget, *, kinds: Sequence[Kind | str] = (), sample: float = 1.0) -> ExportHandle
```

Registers a host-owned export target. An empty `kinds` sequence leaves the export unfiltered.

**Raises:** `ExportError` for the wrong target type, invalid event kind, sampling outside `0.0..=1.0`, unsupported OTLP protocol, or unsupported process/file framing.

### `omp.telemetry.flush`

```python
async flush(*, timeout: Duration = Duration("10s")) -> bool
```

Requests a flush of every registered target. It returns `True` only when the host reports success; CONTROL errors are converted to `False`.

**Raises:** `TypeError` unless `timeout` is `Duration`; `NotWiredError` when no CONTROL backend exists.

## Queries

### `omp.telemetry.Predicate`

```python
Predicate()
```

Is the frozen base value for host-evaluated query predicates.

| Field | Type | Default | Meaning |
|---|---|---:|---|
| — | — | — | This base dataclass defines no fields. |

### `omp.telemetry.Eq`

```python
Eq(value: object)
```

Requires a queried telemetry field to equal `value`.

| Field | Type | Default | Meaning |
|---|---|---:|---|
| `value` | `object` | required | Exact comparison value. |

### `omp.telemetry.Step`

```python
Step(kinds: Sequence[Kind] = (), tool: str | None = None, target: str | None = None, rev: str | None = None, where: Mapping[str, Predicate] = field(default_factory=dict), name: str | None = None)
```

Defines one element in an ordered event match.

| Field | Type | Default | Meaning |
|---|---|---:|---|
| `kinds` | `Sequence[Kind]` | `()` | Accepted event kinds. |
| `tool` | `str | None` | `None` | Tool wire-name filter. |
| `target` | `str | None` | `None` | Target filter. |
| `rev` | `str | None` | `None` | Revision filter. |
| `where` | `Mapping[str, Predicate]` | empty | Field predicates keyed by path. |
| `name` | `str | None` | `None` | Binding name for the matched event. |

### `omp.telemetry.Query`

```python
Query(match: Sequence[Step], window: int = 8, same_turn: bool = True, scope: Scope = Scope.PROJECT, sessions: Sequence[str] = (), since: datetime | timedelta | None = None, until: datetime | None = None, select: Sequence[str] = (), group_by: Sequence[str] = (), order_by: Sequence[str] = (), limit: int = 1000, cursor: str | None = None)
```

Describes a durable-index query.

| Field | Type | Default | Meaning |
|---|---|---:|---|
| `match` | `Sequence[Step]` | required | Non-empty ordered match sequence. |
| `window` | `int` | `8` | Maximum match window; must be non-negative. |
| `same_turn` | `bool` | `True` | Restrict a sequence to one turn. |
| `scope` | `Scope` | `PROJECT` | Agent extent queried. |
| `sessions` | `Sequence[str]` | `()` | Optional session restriction. |
| `since` | `datetime | timedelta | None` | `None` | Absolute or relative lower bound. |
| `until` | `datetime | None` | `None` | Absolute upper bound. |
| `select` | `Sequence[str]` | `()` | Projected fields or aggregates. |
| `group_by` | `Sequence[str]` | `()` | Grouping fields. |
| `order_by` | `Sequence[str]` | `()` | Ordering expressions. |
| `limit` | `int` | `1000` | Row limit from `1` through `QUERY_LIMIT_MAX`. |
| `cursor` | `str | None` | `None` | Continuation cursor. |

### `omp.telemetry.Row`

```python
Row(events: tuple[Envelope, ...], bindings: Mapping[str, Envelope], session: str, turn: int, _values: Mapping[str, object] = field(default_factory=dict, repr=False))
```

Exposes one query match as an immutable mapping of projected values.

| Field | Type | Default | Meaning |
|---|---|---:|---|
| `events` | `tuple[Envelope, ...]` | required | Events in match order. |
| `bindings` | `Mapping[str, Envelope]` | required | Named events. |
| `session` | `str` | required | Matching session. |
| `turn` | `int` | required | Matching turn. |
| `_values` | `Mapping[str, object]` | empty | Projected fields and aggregates. |

`row[key]`, iteration, and `len(row)` operate on projected values.

### `omp.telemetry.QueryResult`

```python
QueryResult(rows: tuple[Row, ...], total: int, cursor: str | None, truncated: bool, scanned_sessions: int, scanned_events: int, backfilled: bool, floored: bool, elapsed_ms: int)
```

Reports rows and scan metadata from a settled query.

| Field | Type | Default | Meaning |
|---|---|---:|---|
| `rows` | `tuple[Row, ...]` | required | Returned rows. |
| `total` | `int` | required | Total matches reported by the host. |
| `cursor` | `str | None` | required | Continuation cursor. |
| `truncated` | `bool` | required | Whether more data was omitted. |
| `scanned_sessions` | `int` | required | Sessions scanned. |
| `scanned_events` | `int` | required | Events scanned. |
| `backfilled` | `bool` | required | Whether index backfill contributed. |
| `floored` | `bool` | required | Whether the query was restricted by its visibility floor. |
| `elapsed_ms` | `int` | required | Query time in milliseconds. |

### `omp.telemetry.query`

```python
async query(q: Query) -> QueryResult
```

Runs a serialized query through CONTROL.

```python
result = await omp.telemetry.query(
    omp.telemetry.Query(match=[omp.telemetry.Step(kinds=[omp.telemetry.Kind.TURN_END])], limit=20)
)
```

**Raises:** `TypeError` unless `q` is `Query`; `QueryError` for an empty match, invalid limit, or negative window; `NotWiredError` without CONTROL.

### `omp.telemetry.RevMetrics`

```python
RevMetrics(rev: Rev, first_seen_ms: int, last_seen_ms: int, sessions: int, calls: int, ok: int, faults: int, blocked: int, timeouts: int, aborted: int, skipped: int, postcondition_rejected: int, abandoned: int, fault_codes: Mapping[str, int], repaired_calls: int, repair_paths: Mapping[str, int], retry_rate: float, p50_latency_ms: float, p95_latency_ms: float, p99_latency_ms: float, p50_speculation_ms: float, p50_prompt_bytes: float, p95_prompt_bytes: float, spills: int, issues: int)
```

Aggregates indexed reliability, repair, latency, prompt-size, spill, and issue data for one tool revision.

| Field | Type | Default | Meaning |
|---|---|---:|---|
| `rev` | `Rev` | required | Tool revision. |
| `first_seen_ms` | `int` | required | First indexed observation. |
| `last_seen_ms` | `int` | required | Latest indexed observation. |
| `sessions` | `int` | required | Distinct sessions. |
| `calls` | `int` | required | Calls. |
| `ok` | `int` | required | Successful calls. |
| `faults` | `int` | required | Faulted calls. |
| `blocked` | `int` | required | Blocked calls. |
| `timeouts` | `int` | required | Timed-out calls. |
| `aborted` | `int` | required | Aborted calls. |
| `skipped` | `int` | required | Skipped calls. |
| `postcondition_rejected` | `int` | required | Calls rejected by postconditions. |
| `abandoned` | `int` | required | Abandoned calls. |
| `fault_codes` | `Mapping[str, int]` | required | Counts by fault code. |
| `repaired_calls` | `int` | required | Calls requiring repair. |
| `repair_paths` | `Mapping[str, int]` | required | Counts by repair path. |
| `retry_rate` | `float` | required | Retry ratio. |
| `p50_latency_ms` | `float` | required | Median latency. |
| `p95_latency_ms` | `float` | required | 95th-percentile latency. |
| `p99_latency_ms` | `float` | required | 99th-percentile latency. |
| `p50_speculation_ms` | `float` | required | Median speculation time. |
| `p50_prompt_bytes` | `float` | required | Median prompt size. |
| `p95_prompt_bytes` | `float` | required | 95th-percentile prompt size. |
| `spills` | `int` | required | Spill count. |
| `issues` | `int` | required | Issue-report count. |

### `omp.telemetry.rev_metrics`

```python
async rev_metrics(tool: str, *, family: str | None = None, since: datetime | timedelta | None = None, scope: Scope = Scope.PROJECT) -> tuple[RevMetrics, ...]
```

Returns newest-first metrics for revisions of one tool.

**Raises:** `QueryError` for an empty tool or family or invalid scope; `TypeError` for an invalid `since` or host response; `NotWiredError` without CONTROL.

## Semantic attributes and spans

### `omp.telemetry.semconv`

```python
semconv: Mapping[str, str]
```

Is an immutable mapping from Python event field paths to stable exported semantic attribute names.

### `omp.telemetry.attributes`

```python
attributes(event: Event) -> Mapping[str, object]
```

Projects an event onto the semantic attributes in `semconv`. Missing values and numeric zero values are omitted; enum values are converted to wire strings. The returned mapping is immutable.

### `omp.telemetry.Span`

```python
Span(name: str, attrs: Mapping[str, str | int | float | bool])
```

Is the async context manager for an extension-owned trace span. Prefer `span()` to construct it.

```python
async with omp.telemetry.span("index.lookup", shard=3) as current:
    current.event("cache_miss", key="users")
    current.set(rows=12)
```

`trace: TraceRef` exposes the opened span identity, initially an empty unsampled reference.

```python
set(**attrs: str | int | float | bool) -> None
event(name: str, /, **attrs: str | int | float | bool) -> None
fault(kind: str, message: str) -> None
```

`set()` adds scalar attributes. `event()` queues a named point event. `fault()` marks the span failed without raising or closing it. An exception leaving the context records its type and text and is never suppressed. Opening requires CONTROL; failures after an open request begins are fail-open, and close failures are ignored.

### `omp.telemetry.span`

```python
span(name: str, /, **attrs: str | int | float | bool) -> Span
```

Creates an extension trace span.

**Raises:** `ValueError` for an empty name; `TypeError` for non-scalar attributes.

## Errors

### `omp.telemetry.TelemetryError`

```python
class TelemetryError(OmpError)
```

Is the base exception for telemetry declarations, queries, and exports. It is also re-exported as `omp.TelemetryError`.

### `omp.telemetry.SubscriptionError`

```python
class SubscriptionError(TelemetryError)
```

Reports malformed or conflicting subscription and instrument declarations.

### `omp.telemetry.QueryError`

```python
class QueryError(TelemetryError)
```

Reports malformed queries and invalid indexed-value requests.

### `omp.telemetry.ExportError`

```python
class ExportError(TelemetryError)
```

Reports malformed export-target declarations.

## Limits and names

### `omp.telemetry.QUEUE_DEFAULT`

```python
QUEUE_DEFAULT = 4096
```

Is the default subscription ring capacity.

### `omp.telemetry.QUEUE_MAX`

```python
QUEUE_MAX: Final[int] = 65_536
```

Is the maximum subscription ring capacity.

### `omp.telemetry.BATCH_MAX`

```python
BATCH_MAX = 1024
```

Is the maximum subscription batch size.

### `omp.telemetry.METRIC_PREFIX`

```python
METRIC_PREFIX = "omp.ext."
```

Is the reserved prefix applied to extension metrics.

### `omp.telemetry.MAX_INSTRUMENTS`

```python
MAX_INSTRUMENTS: Final[int] = 256
```

Is the maximum distinct metric declarations per extension.

### `omp.telemetry.MAX_CARDINALITY`

```python
MAX_CARDINALITY: Final[int] = 1024
```

Is the retained attribute-series limit for each instrument.

### `omp.telemetry.DEFAULT_MAX_BYTES`

```python
DEFAULT_MAX_BYTES: Final[int] = 51_200
```

Is the default inline rendered-result byte budget.

### `omp.telemetry.DEFAULT_MAX_LINES`

```python
DEFAULT_MAX_LINES: Final[int] = 3_000
```

Is the default inline rendered-result line budget.

### `omp.telemetry.DEFAULT_MAX_COLUMN`

```python
DEFAULT_MAX_COLUMN: Final[int] = 512
```

Is the default inline UTF-16 column budget.

### `omp.telemetry.QUERY_LIMIT_MAX`

```python
QUERY_LIMIT_MAX: Final[int] = 10_000
```

Is the largest query row limit.

### `omp.telemetry.SPILL_BYTES`

```python
SPILL_BYTES: Final[int] = DEFAULT_MAX_BYTES
```

Names the rendered-result byte spill gate.

### `omp.telemetry.SPILL_LINES`

```python
SPILL_LINES: Final[int] = DEFAULT_MAX_LINES
```

Names the rendered-result line spill gate.

### `omp.telemetry.SPILL_COLUMN`

```python
SPILL_COLUMN: Final[int] = DEFAULT_MAX_COLUMN
```

Names the rendered-result column spill gate.
