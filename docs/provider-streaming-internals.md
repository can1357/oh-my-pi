# Provider streaming internals

This document explains how token/tool streaming is normalized in `@oh-my-pi/pi-ai`, then propagated through `@oh-my-pi/pi-agent-core` and `coding-agent` session events.

## End-to-end flow

1. `streamSimple()` (`packages/ai/src/stream.ts`) resolves credentials, maps generic options, and dispatches to a provider stream function. Built-ins use the eagerly imported adapters in `packages/ai/src/providers/register-builtins.ts`; routing wrappers and extension-registered APIs have their own dispatch paths. Shared dispatch also applies provider in-flight limits, leaked-thinking healing, and thinking-loop guards.
2. Provider stream functions translate provider-native stream events into the unified `AssistantMessageEvent` sequence. Built-ins include Anthropic, OpenAI Responses/Completions/Codex/Azure Responses, Google Gemini/Gemini CLI/Vertex, Bedrock Converse, Ollama, Cursor, Devin, Apple Foundation Models, and pi-native gateway transport, plus GitLab Duo, GitLab Duo Workflow, Kimi, and Synthetic wrappers. xAI Grok uses the shared OpenAI Responses path with catalog-level compat. OpenRouter defaults to Responses; `PI_OPENROUTER_RESPONSES=0` selects Chat Completions.
3. Each provider pushes events into `AssistantMessageEventStream` (`packages/ai/src/utils/event-stream.ts`), which exposes:
   - async iteration for incremental updates
   - `result()` for the final `AssistantMessage`
4. The built-in forwarding wrapper supplies watchdogs where the provider does not own them. Anthropic and the OpenAI family own first-event and idle handling; Gemini CLI owns first-event recovery while the wrapper handles idle gaps. The synthetic `start` event does not count as first progress. Providers can mark server-requested local work with `trackLocalWork()` (and forward that state with `forwardLocalWorkFrom()`) so it does not look like a stall.
5. `agentLoop` (`packages/agent/src/agent-loop.ts`) consumes those events, updates in-flight assistant state, and emits `message_update` events carrying read-only snapshots of the assistant event and message. Open blocks are copied incrementally; finalized blocks are shared between snapshots.
6. `AgentSession` (`packages/coding-agent/src/session/agent-session.ts`) subscribes to agent events, persists messages, drives extension hooks, and applies session behaviors (retry, compaction, TTSR, streaming-edit abort checks).

## Unified stream contract in `@oh-my-pi/pi-ai`

All providers emit the same shape (`AssistantMessageEvent` in `packages/ai/src/types.ts`):

- `start`
- content block lifecycle triplets:
  - text: `text_start` → `text_delta`\* → `text_end`
  - thinking: `thinking_start` → `thinking_delta`\* → `thinking_end`
  - tool call: `toolcall_start` → `toolcall_delta`\* → `toolcall_end`
- complete image blocks: `image_end`
- terminal event:
  - `done` with `reason: "stop" | "length" | "toolUse"`
  - or `error` with `reason: "aborted" | "error"`

`AssistantMessageEventStream` guarantees:

- a `done` or `error` event resolves `result()` to the event's final assistant message
- `fail(error)` instead rejects iteration and `result()`; `end()` without a final
  result rejects `result()` rather than leaving it pending
- events are delivered to consumers immediately, in push order (no batching or merging)

## Delta throttling behavior

`AssistantMessageEventStream` does not throttle or merge delta events — every provider event is delivered as pushed. Tool-call argument parsing uses `parseStreamingJsonThrottled()` (`packages/utils/src/json-parse.ts`): the first nonempty buffer is parsed, then reparsing requires growth of `max(STREAMING_JSON_PARSE_MIN_GROWTH, buffer.length >> 5)`, with a default floor of 256 string code units. The geometric gate avoids fixed-cadence full-buffer reparsing for large arguments. The final parse at the tool-call boundary is unconditional and authoritative.

There is no provider backpressure: providers still produce at full speed, while the local stream queues.

## Provider normalization details

## Anthropic (`anthropic-messages`)

Source: `packages/ai/src/providers/anthropic.ts`

Normalization points:

- `message_start` initializes usage (input/output/cache tokens)
- `content_block_start` maps to text/thinking/toolcall starts
- `content_block_delta` maps:
  - `text_delta` → `text_delta`
  - `thinking_delta` → `thinking_delta`
  - `input_json_delta` → `toolcall_delta`
  - `signature_delta` updates `thinkingSignature` only (no event)
- `content_block_stop` emits corresponding `*_end`
- `message_delta.stop_reason` maps via `mapStopReason()`
- signed `compaction` blocks are retained in `providerPayload` only when the terminal stop reason confirms compaction; no ordinary text/thinking delta is synthesized for them

Tool-call argument streaming:

- each tool block carries a symbol-backed `kStreamingPartialJson` buffer
- every JSON delta appends to that buffer
- `arguments` are reparsed on appended deltas via `parseStreamingJsonThrottled()` (first buffer, then the geometric growth gate)
- `toolcall_end` reparses once more, then removes internal streaming state

## OpenAI Chat Completions (`openai-completions`)

Source: `packages/ai/src/providers/openai-completions.ts`

- Visible content deltas become text blocks; reasoning fields become thinking blocks.
- Tool-call deltas are associated with streamed call indices/IDs. String argument
  fragments accumulate with throttled JSON parsing; object-valued argument
  snapshots (MiniMax) are merged directly.
- Final tool-call arguments are parsed at the block boundary. Structured calls
  promote a benign `"stop"` finish into tool use.
- Compat controls cumulative reasoning, leaked-template-token stripping, markup
  healing, and the empty length-finish context-error case.
- First-event/idle handling and replay-safe retries live in this provider, not
  the shared forwarder.

## OpenAI Responses family (`openai-responses`, `openai-codex-responses`, `azure-openai-responses`)

Sources: `packages/ai/src/providers/openai-responses.ts`, `openai-codex-responses.ts`, and `azure-openai-responses.ts`

Normalization points:

- `response.output_item.added` starts reasoning/text/function-call/custom-tool blocks
- reasoning summary events (`response.reasoning_summary_text.delta`) and raw reasoning events (`response.reasoning_text.delta`) become `thinking_delta`
- output/refusal deltas become `text_delta`
- `response.function_call_arguments.delta` and `response.custom_tool_call_input.delta` become `toolcall_delta`
- `response.output_item.done` emits `thinking_end` / `text_end` / `toolcall_end`
- `response.completed`, `response.incomplete`, and legacy `response.done` finalize status and usage, then stop reading even if the transport remains open
- `response.failed` / `error` events throw into the terminal `error` path; `incomplete_details.reason: "content_filter"` is an error, not a length limit
- native computer calls become complete tool-call blocks; completed image-generation items emit `image_end`

Tool-call argument streaming:

- same symbol-backed accumulation pattern as Anthropic for function-call JSON arguments
- custom tools stream raw string input and expose final arguments as `{ input: <raw> }`
- providers that send only `response.function_call_arguments.done` still populate final args
- tool call IDs are normalized as `"<call_id>|<item_id>"`

## Google Generative AI (`google-generative-ai`)

Source: `packages/ai/src/providers/google.ts` (thin request wrapper) and `google-shared.ts` (`streamGoogleGenAI`, shared chunk-to-block translation)

Normalization points:

- iterates `candidate.content.parts`
- text parts are split into thinking vs text by `isThinkingPart(part)` (`thought === true`; a signature alone is not a thinking marker)
- thought signatures are preserved on their original text/thinking/tool-call blocks for replay
- block transitions close previous block before starting a new one
- `part.functionCall` is treated as a complete tool call (start/delta/end emitted immediately)
- finish reason mapped by `mapStopReason()` from `google-shared.ts`

Tool-call argument streaming:

- function call args arrive as structured object, not incremental JSON text
- implementation emits one synthetic `toolcall_delta` containing `JSON.stringify(arguments)`
- no partial JSON parser needed for Google in this path

## Partial tool-call JSON accumulation and recovery

Shared behavior uses `parseStreamingJson()` / `parseStreamingJsonThrottled()` (`packages/utils/src/json-parse.ts`):

1. try `JSON.parse`
2. fallback to the in-house `RelaxedJson` parser (relaxed/repairing) for incomplete fragments
3. if both fail, return `{}`

Implications:

- malformed or truncated argument deltas do not crash stream processing immediately
- in-progress `arguments` may temporarily be `{}`
- later valid deltas can recover structured arguments as the buffer grows; mid-stream reparsing uses the geometric growth gate
- final `toolcall_end` performs one more parse attempt before emission

## Stop reasons vs transport/runtime errors

Provider stop reasons are mapped to normalized `stopReason`:

- Anthropic: `end_turn`/`stop_sequence`/`pause_turn`/`compaction`→`stop`, `max_tokens`/`model_context_window_exceeded`→`length`, `tool_use`→`toolUse`, `refusal`/`sensitive`→`error`; unknown reasons are logged and treated as `stop`
- OpenAI Responses: `completed`→`stop`, `incomplete`→`length` except content filtering→`error`, `failed/cancelled`→`error`; completed tool calls can promote benign finishes to `toolUse`
- Google: `STOP`→`stop`, `MAX_TOKENS`→`length`, safety/prohibited/malformed-function-call classes→`error`; tool calls promote only benign stop/length finishes to `toolUse`

Error semantics are split in two stages:

1. **Model completion semantics** (provider reported finish reason/status)
2. **Transport/runtime failure** (network/client/parser/abort exceptions)

If provider stream throws or signals failure, each provider wrapper catches and emits terminal `error` event with:

- `stopReason = "aborted"` for caller cancellation
- otherwise `stopReason = "error"`
- provider errors normally pass through `finalizeErrorMessage(error, rawRequestDump)` (`packages/ai/src/utils/http-inspector.ts`), which formats retry-after information and captured HTTP/request diagnostics; shared-wrapper failures use the thrown error's message
- watchdog-triggered local aborts remain `"error"` rather than being mislabeled as caller cancellation

## Malformed chunk / SSE parse failure behavior

The OpenAI Completions/Responses paths use the in-repo HTTP+SSE transport `postOpenAIStream()` (`packages/ai/src/utils/openai-http.ts`), which decodes frames with `readSseJson()` and replaced the `openai` SDK client. Anthropic uses the in-repo `AnthropicMessagesClient` (`packages/ai/src/providers/anthropic-client.ts`); the Google paths and the Codex SSE fallback read SSE via `readSseJson()` directly, and websocket Codex frames are normalized through the same event handler.

Observed behavior in current implementation:

- malformed SSE framing or chunk JSON surfaces as an exception or stream `error` event
- malformed Codex SSE JSON/framing throws from the local SSE reader
- providers do not resume from an individual malformed chunk. Depending on the provider and whether any replay-unsafe output has been emitted, a bounded provider-owned request retry may start a fresh attempt for transient transport or malformed-envelope failures.
- provider-owned recovery includes bounded empty-completion retries and capability fallbacks such as retrying without rejected strict-tool fields; Azure also has one replay-safe transient provider-error retry
- Codex can fall back from websocket to SSE only before replay-unsafe output is emitted
- `AgentSession` separately handles message-level auto-retry; it does not replay a stream from the failed chunk

## Cancellation boundaries

Cancellation is layered:

- AI provider request: `options.signal` is passed into provider client stream call.
- Provider wrapper: after stream loop, aborted signal forces error path (`"Request was aborted"`).
- Agent loop: checks `signal.aborted` before handling each provider event and can synthesize an aborted assistant message from the latest partial.
- Session/agent controls: `AgentSession.abort()` -> `agent.abort()` -> shared abort controller cancellation.

Tool execution cancellation is separate from model stream cancellation:

- interruptible wait-like tools observe a combined external/steering/IRC abort signal
- side-effecting foreground tools observe only the external abort signal; steering and IRC reach them through a cooperative `steeringSignal`, not a hard kill
- queued interruptions are injected at execution boundaries while completed tool results are preserved

## Watchdog configuration

`packages/ai/src/utils/idle-iterator.ts` defaults both first-event and idle budgets
to 300,000 ms. Caller `streamFirstEventTimeoutMs` / `streamIdleTimeoutMs` options
win over environment values; `0` disables that watchdog. Generic transports use
`PI_STREAM_IDLE_TIMEOUT_MS` (then the legacy OpenAI alias) and
`PI_STREAM_FIRST_EVENT_TIMEOUT_MS`. OpenAI-family transports prefer
`PI_OPENAI_STREAM_IDLE_TIMEOUT_MS` and `PI_OPENAI_STREAM_FIRST_EVENT_TIMEOUT_MS`.
Without an OpenAI-specific first-event override, their first-event budget is
floored at the resolved idle budget. Catalog compat can supply provider/model
fallbacks, including unbounded first-event waits on local backends.

A pre-response timer is cleared once the HTTP attempt settles; it is not an
absolute deadline on an actively streaming body. Retries arm a fresh timer.

## Backpressure boundaries

There is no hard backpressure mechanism between provider transports and downstream consumers:

- `EventStream` uses in-memory queues with no max size
- the throttled partial-JSON re-parse reduces per-delta CPU cost but does not slow provider intake
- if consumers lag significantly, queued events can grow until completion

Current design favors responsiveness and simple ordering over bounded-buffer flow control.

## How stream events surface as agent/session events

`agentLoop.streamAssistantResponse()` bridges `AssistantMessageEvent` to `AgentEvent`:

- on `start`: pushes placeholder assistant message and emits `message_start`
- on block events (`text_*`, `thinking_*`, `image_end`, `toolcall_*`): updates the last assistant message and emits `message_update` with a read-only event/message snapshot; consumers MUST NOT mutate shared finalized blocks
- on terminal (`done`/`error`): resolves final message from `response.result()`, emits `message_end`

`AgentSession` then consumes those events for session-level behaviors:

- TTSR watches `message_update.assistantMessageEvent` for `text_delta`, `thinking_delta`, and `toolcall_delta`, and runs a final whole-buffer check on `text_end`, `thinking_end`, and `toolcall_end`
- tool argument streams consume `toolcall_*` events and emit `tool_stream_update`; the streaming edit guard aborts on an `edit` final preview (`streaming: false`) with a real file error, not a no-change diagnostic
- persistence writes finalized messages at `message_end`
- auto-retry classifies assistant failures through structured `errorId` / AI error predicates, with message classification as a fallback

## Unified vs provider-specific responsibilities

Unified (common contract):

- event shape (`AssistantMessageEvent`)
- final result extraction (`done`/`error`)
- immediate in-order event delivery
- agent/session event propagation model

Provider-specific (not fully abstracted):

- upstream event taxonomies and mapping logic
- stop-reason translation tables
- tool-call ID conventions
- reasoning/thinking block semantics and signatures
- usage token semantics and availability timing
- message conversion constraints per API

## Implementation files

- [`packages/ai/src/stream.ts`](../packages/ai/src/stream.ts) — provider dispatch, option mapping, credential/session plumbing, and custom API dispatch.
- [`packages/ai/src/utils/event-stream.ts`](../packages/ai/src/utils/event-stream.ts) — stream queue and final-result resolution.
- [`packages/utils/src/json-parse.ts`](../packages/utils/src/json-parse.ts) — partial JSON parsing for streamed tool arguments.
- [`packages/ai/src/providers/anthropic.ts`](../packages/ai/src/providers/anthropic.ts) — Anthropic event translation and tool JSON accumulation.
- [`packages/ai/src/providers/openai-shared.ts`](../packages/ai/src/providers/openai-shared.ts) — shared Responses event translation; [`openai-responses.ts`](../packages/ai/src/providers/openai-responses.ts), [`openai-codex-responses.ts`](../packages/ai/src/providers/openai-codex-responses.ts), and [`azure-openai-responses.ts`](../packages/ai/src/providers/azure-openai-responses.ts) — transport/request variants.
- [`packages/ai/src/providers/google-shared.ts`](../packages/ai/src/providers/google-shared.ts) — shared Gemini conversion and event translation; [`google.ts`](../packages/ai/src/providers/google.ts), [`google-gemini-cli.ts`](../packages/ai/src/providers/google-gemini-cli.ts), and [`google-vertex.ts`](../packages/ai/src/providers/google-vertex.ts) — request/transport variants.
- [`amazon-bedrock.ts`](../packages/ai/src/providers/amazon-bedrock.ts), [`openai-completions.ts`](../packages/ai/src/providers/openai-completions.ts), [`ollama.ts`](../packages/ai/src/providers/ollama.ts), [`cursor.ts`](../packages/ai/src/providers/cursor.ts), [`apple-foundation-models.ts`](../packages/ai/src/providers/apple-foundation-models.ts), and [`pi-native-client.ts`](../packages/ai/src/providers/pi-native-client.ts) — additional stream adapters.
- [`packages/ai/src/providers/register-builtins.ts`](../packages/ai/src/providers/register-builtins.ts) and [`packages/ai/src/utils/idle-iterator.ts`](../packages/ai/src/utils/idle-iterator.ts) — built-in forwarding, shared first-progress/idle watchdogs, and local-work-aware stall handling.
- [`packages/agent/src/agent-loop.ts`](../packages/agent/src/agent-loop.ts) — provider stream consumption and `message_update` snapshots.
- [`packages/coding-agent/src/session/agent-session.ts`](../packages/coding-agent/src/session/agent-session.ts), [`stream-guards.ts`](../packages/coding-agent/src/session/stream-guards.ts), and [`ttsr-coordinator.ts`](../packages/coding-agent/src/session/ttsr-coordinator.ts) — session updates, guards, abort, and persistence.
