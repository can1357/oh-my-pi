# Provider streaming internals

This document explains how token/tool streaming is normalized in `@pk-nerdsaver-ai/pi-ai`, then propagated through `@pk-nerdsaver-ai/pi-agent-core` and `coding-agent` session events.

## End-to-end flow

1. `streamSimple()` (`packages/ai/src/stream.ts`) maps generic options and dispatches to a provider stream function.
2. Provider stream functions translate provider-native stream events into the unified `AssistantMessageEvent` sequence. Current built-ins include Anthropic, OpenAI Responses/Completions/Codex/Azure Responses, Google Gemini/Gemini CLI/Vertex, Bedrock Converse, Ollama, Cursor, pi-native gateway transport, plus GitLab Duo/Kimi/Synthetic/xAI-Grok-Responses wrappers and extension-registered custom APIs.
3. Each provider pushes events into `AssistantMessageEventStream` (`packages/ai/src/utils/event-stream.ts`), which exposes:
   - async iteration for incremental updates
   - `result()` for final `AssistantMessage`
4. `agentLoop` (`packages/agent/src/agent-loop.ts`) consumes those events, mutates in-flight assistant state, and emits `message_update` events carrying the raw `assistantMessageEvent`.
5. `AgentSession` (`packages/coding-agent/src/session/agent-session.ts`) subscribes to agent events, persists messages, drives extension hooks, and applies session behaviors (retry, compaction, TTSR, streaming-edit abort checks).

## Unified stream contract in `@pk-nerdsaver-ai/pi-ai`

All providers emit the same shape (`AssistantMessageEvent` in `packages/ai/src/types.ts`):

- `start`
- content block lifecycle triplets:
  - text: `text_start` → `text_delta`\* → `text_end`
  - thinking: `thinking_start` → `thinking_delta`\* → `thinking_end`
  - tool call: `toolcall_start` → `toolcall_delta`\* → `toolcall_end`
- terminal event:
  - `done` with `reason: "stop" | "length" | "toolUse"`
  - or `error` with `reason: "aborted" | "error"`

`AssistantMessageEventStream` guarantees:

- final result is resolved by terminal event (`done` or `error`)
- events are delivered to consumers immediately, in push order (no batching or merging)

## Delta throttling behavior

`AssistantMessageEventStream` itself no longer throttles or merges delta events — every provider event is delivered as pushed. The per-delta cost control moved into tool-call argument parsing: providers accumulate partial JSON and re-parse it via `parseStreamingJsonThrottled()` (`packages/ai/src/utils/json-parse.ts`), which skips the re-parse until at least `STREAMING_JSON_PARSE_MIN_GROWTH` (256) new bytes have arrived, bounding mid-stream parse cost from quadratic to linear. The final `toolcall_end` parse is always unconditional and authoritative.

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

Tool-call argument streaming:

- each tool block carries internal `partialJson`
- every JSON delta appends to `partialJson`
- `arguments` are reparsed on appended deltas via `parseStreamingJsonThrottled()` (re-parse only after ≥256 new bytes)
- `toolcall_end` reparses once more, then strips `partialJson`

## OpenAI Responses family (`openai-responses`, `openai-codex-responses`, `azure-openai-responses`)

Sources: `packages/ai/src/providers/openai-responses.ts`, `openai-codex-responses.ts`, and `azure-openai-responses.ts`

Normalization points:

- `response.output_item.added` starts reasoning/text/function-call/custom-tool blocks
- reasoning summary events (`response.reasoning_summary_text.delta`) and raw reasoning events (`response.reasoning_text.delta`) become `thinking_delta`
- output/refusal deltas become `text_delta`
- `response.function_call_arguments.delta` and `response.custom_tool_call_input.delta` become `toolcall_delta`
- `response.output_item.done` emits `thinking_end` / `text_end` / `toolcall_end`
- `response.completed` maps status to stop reason and usage; `response.failed` / SDK `error` events throw into the wrapper's terminal `error` path

Tool-call argument streaming:

- same `partialJson` accumulation pattern as Anthropic for function-call JSON arguments
- custom tools stream raw string input and expose final arguments as `{ input: <raw> }`
- providers that send only `response.function_call_arguments.done` still populate final args
- tool call IDs are normalized as `"<call_id>|<item_id>"`

## Google Generative AI (`google-generative-ai`)

Source: `packages/ai/src/providers/google.ts` (thin request wrapper) and `google-shared.ts` (`streamGoogleGenAI`, shared chunk-to-block translation)

Normalization points:

- iterates `candidate.content.parts`
- text parts are split into thinking vs text by `isThinkingPart(part)`
- block transitions close previous block before starting a new one
- `part.functionCall` is treated as a complete tool call (start/delta/end emitted immediately)
- finish reason mapped by `mapStopReason()` from `google-shared.ts`

Tool-call argument streaming:

- function call args arrive as structured object, not incremental JSON text
- implementation emits one synthetic `toolcall_delta` containing `JSON.stringify(arguments)`
- no partial JSON parser needed for Google in this path

## Partial tool-call JSON accumulation and recovery

Shared behavior for Anthropic/OpenAI Responses uses `parseStreamingJson()` / `parseStreamingJsonThrottled()` (`packages/ai/src/utils/json-parse.ts`):

1. try `JSON.parse`
2. fallback to the in-house `RelaxedJson` parser (relaxed/repairing) for incomplete fragments
3. if both fail, return `{}`

Implications:

- malformed or truncated argument deltas do not crash stream processing immediately
- in-progress `arguments` may temporarily be `{}`
- later valid deltas can recover structured arguments because parsing is retried as the buffer grows (throttled to ≥256-byte growth steps mid-stream)
- final `toolcall_end` performs one more parse attempt before emission

## Stop reasons vs transport/runtime errors

Provider stop reasons are mapped to normalized `stopReason`:

- Anthropic: `end_turn`→`stop`, `max_tokens`→`length`, `tool_use`→`toolUse`, safety/refusal cases→`error`
- OpenAI Responses: `completed`→`stop`, `incomplete`→`length`, `failed/cancelled`→`error`
- Google: `STOP`→`stop`, `MAX_TOKENS`→`length`, safety/prohibited/malformed-function-call classes→`error`

Error semantics are split in two stages:

1. **Model completion semantics** (provider reported finish reason/status)
2. **Transport/runtime failure** (network/client/parser/abort exceptions)

If provider stream throws or signals failure, each provider wrapper catches and emits terminal `error` event with:

- `stopReason = "aborted"` when abort signal is set
- otherwise `stopReason = "error"`
- `errorMessage = finalizeErrorMessage(error, rawRequestDump)` (`packages/ai/src/utils/http-inspector.ts`), which wraps `formatErrorMessageWithRetryAfter()` and appends any captured HTTP-error body / raw-request dump (the `cursor` wrapper calls `formatErrorMessageWithRetryAfter()` directly)

## Malformed chunk / SSE parse failure behavior

The OpenAI Completions/Responses paths use the in-repo HTTP+SSE transport `postOpenAIStream()` (`packages/ai/src/utils/openai-http.ts`), which decodes frames with `readSseJson()` and replaced the `openai` SDK client. Anthropic uses the in-repo `AnthropicMessagesClient` (`packages/ai/src/providers/anthropic-client.ts`); the Google paths and the Codex SSE fallback read SSE via `readSseJson()` directly, and websocket Codex frames are normalized through the same event handler.

Observed behavior in current implementation:

- malformed SSE framing or chunk JSON surfaces as an exception or stream `error` event
- malformed Codex SSE JSON/framing throws from the local SSE reader
- provider wrapper converts failures into unified terminal `error` events
- no provider-specific resume/retry inside the stream function itself, except Codex websocket-to-SSE transport fallback before replay-unsafe output is emitted
- higher-level retries are handled in `AgentSession` auto-retry logic (message-level retry, not stream-chunk replay)

## Cancellation boundaries

Cancellation is layered:

- AI provider request: `options.signal` is passed into provider client stream call.
- Provider wrapper: after stream loop, aborted signal forces error path (`"Request was aborted"`).
- Agent loop: checks `signal.aborted` before handling each provider event and can synthesize an aborted assistant message from the latest partial.
- Session/agent controls: `AgentSession.abort()` -> `agent.abort()` -> shared abort controller cancellation.

Tool execution cancellation is separate from model stream cancellation:

- tool runners use `AbortSignal.any([agentSignal, steeringAbortSignal])`
- steering interrupts can abort remaining tool execution while preserving already-produced tool results

## Backpressure boundaries

There is no hard backpressure mechanism between provider SDK stream and downstream consumers:

- `EventStream` uses in-memory queues with no max size
- the throttled partial-JSON re-parse reduces per-delta CPU cost but does not slow provider intake
- if consumers lag significantly, queued events can grow until completion

Current design favors responsiveness and simple ordering over bounded-buffer flow control.

## How stream events surface as agent/session events

`agentLoop.streamAssistantResponse()` bridges `AssistantMessageEvent` to `AgentEvent`:

- on `start`: pushes placeholder assistant message and emits `message_start`
- on block events (`text_*`, `thinking_*`, `toolcall_*`): updates last assistant message, emits `message_update` with raw `assistantMessageEvent`
- on terminal (`done`/`error`): resolves final message from `response.result()`, emits `message_end`

`AgentSession` then consumes those events for session-level behaviors:

- TTSR watches `message_update.assistantMessageEvent` for `text_delta`, `thinking_delta`, and `toolcall_delta`
- streaming edit guard inspects `toolcall_delta`/`toolcall_end` on `edit` calls and can abort early
- persistence writes finalized messages at `message_end`
- auto-retry examines assistant `stopReason === "error"` plus `errorMessage` heuristics

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

- [`../../ai/src/stream.ts`](../packages/ai/src/stream.ts) — provider dispatch, option mapping, API key/session plumbing, custom API dispatch, and provider-specific credential handling.
- [`../../ai/src/utils/event-stream.ts`](../packages/ai/src/utils/event-stream.ts) — generic stream queue + final-result resolution.
- [`../../ai/src/utils/json-parse.ts`](../packages/ai/src/utils/json-parse.ts) — partial JSON parsing for streamed tool arguments.
- [`../../ai/src/providers/anthropic.ts`](../packages/ai/src/providers/anthropic.ts) — Anthropic event translation and tool JSON delta accumulation.
- [`../../ai/src/providers/openai-responses.ts`](../packages/ai/src/providers/openai-responses.ts), [`openai-shared.ts`](../packages/ai/src/providers/openai-shared.ts), [`openai-codex-responses.ts`](../packages/ai/src/providers/openai-codex-responses.ts), [`azure-openai-responses.ts`](../packages/ai/src/providers/azure-openai-responses.ts) — Responses-family event translation and status mapping.
- [`../../ai/src/providers/google.ts`](../packages/ai/src/providers/google.ts), [`google-gemini-cli.ts`](../packages/ai/src/providers/google-gemini-cli.ts), [`google-vertex.ts`](../packages/ai/src/providers/google-vertex.ts) — Gemini stream chunk-to-block translation variants.
- [`../../ai/src/providers/google-shared.ts`](../packages/ai/src/providers/google-shared.ts) — Gemini finish-reason mapping and shared conversion rules.
- [`../../ai/src/providers/amazon-bedrock.ts`](../packages/ai/src/providers/amazon-bedrock.ts), [`openai-completions.ts`](../packages/ai/src/providers/openai-completions.ts), [`ollama.ts`](../packages/ai/src/providers/ollama.ts), [`cursor.ts`](../packages/ai/src/providers/cursor.ts), [`pi-native-client.ts`](../packages/ai/src/providers/pi-native-client.ts) — additional built-in stream adapters using the same event contract.
- [`../../agent/src/agent-loop.ts`](../packages/agent/src/agent-loop.ts) — provider stream consumption and `message_update` bridging.
- [`../src/session/agent-session.ts`](../packages/coding-agent/src/session/agent-session.ts) — session-level handling of streaming updates, abort, retry, and persistence.
