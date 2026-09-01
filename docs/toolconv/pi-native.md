# pi-native auth-gateway transport

`pi-native` is the lossless transport between a pi-ai client and an
`omp auth-gateway`. It is **not a textual tool-call dialect**: there is no
`<call:NAME>` grammar, parser, renderer, or `PI_DIALECT=pi-native` value in the
current implementation. Tool calls remain canonical pi-ai `ToolCall` content
blocks inside `Context` and `AssistantMessageEvent`.

Use this transport when the client already speaks pi-ai and the gateway owns
provider credentials—for example, a containerized omp talking to a host
gateway or a robomp slot talking to its sidecar. OpenAI/Anthropic-compatible
routes translate and can lose pi-specific fields; pi-native sends the
canonical types directly, preserving service tier, cache markers, thinking
budgets, tool-choice variants, images, and tool-call IDs.

### Removed omp tool-call dialect

Historically, "pi-native" named an in-band tool-call serialization: an XML
dialect of `<call:NAME …>` blocks, replaced by a sigil-delimited format
(v16.0.10, `f743ddc`, 2026-06-19), then deleted outright (v16.2.2,
`053da98`, 2026-06-27) along with its selection knobs (`tools.format: "pi"`,
`PI_DIALECT=pi`). Nothing in `packages/ai` emits or parses either spelling.
Old references to `<call:…>` blocks or `§` headers as "the omp tool-call
format" describe a format that no longer exists; the in-band dialects that
remain serve third-party model families (the live list is the registry in
`packages/ai/src/dialect/factory.ts`).

## Configuration and dispatch

A model opts in with:

```yaml
transport: pi-native
baseUrl: http://gateway.internal:4000
```

`baseUrl` MUST identify an `omp auth-gateway` (or compatible service). Missing
`baseUrl` fails with:

```text
pi-native transport requires `baseUrl` on model MODEL_ID (set it on the provider config in models.yml)
```

When `model.transport === "pi-native"`, `streamSimple` bypasses the normal
per-API provider implementation and calls `streamPiNative`. The client removes
trailing slashes from `baseUrl` and posts to `/v1/pi/stream`.

The gateway bearer is the resolved model/API key. It is sent as
`Authorization: Bearer …`, never in the JSON options. Model headers are also
forwarded; an explicit `model.headers.Authorization` takes precedence over the
resolved key.

`transport` changes only dispatch. Pricing, context window, maximum-token and
thinking metadata still resolve locally from the model catalog.

## Request

```http
POST /v1/pi/stream
Content-Type: application/json
Accept: text/event-stream

{
  "modelId": "provider/model-id",
  "context": {
    "systemPrompt": ["..."],
    "messages": [],
    "tools": []
  },
  "options": {},
  "stream": true
}
```

The client always qualifies `modelId` as `${provider}/${id}` and always
requests streaming. The server also accepts `modelId`, a string `model`, or
`model.id`; its lower-level request parser defaults `stream` to `true`.

Validation at the gateway boundary is intentionally shallow:

- the body MUST be an object;
- a non-empty model identifier MUST be present;
- `context` MUST be an object with a `messages` array;
- when present, `context.systemPrompt` and `context.tools` MUST be arrays.

Invalid shapes produce validation errors. Canonical message/tool internals are
not revalidated at this boundary; downstream failures surface as gateway
upstream errors.

## Options crossing the wire

The server accepts this `SimpleStreamOptions` subset:

`temperature`, `topP`, `topK`, `minP`, `presencePenalty`,
`frequencyPenalty`, `repetitionPenalty`, `stopSequences`, `maxTokens`,
`cacheRetention`, `cachedContent`, `headers`, `initiatorOverride`,
`maxRetryDelayMs`, `metadata`, `sessionId`, `promptCacheKey`, `promptCache`,
`statefulResponses`, `streamFirstEventTimeoutMs`, `streamIdleTimeoutMs`,
`reasoning`, `disableReasoning`, `hideThinkingSummary`, `thinkingBudgets`,
`toolChoice`, `serviceTier`, `kimiApiFormat`, `syntheticApiFormat`,
`preferWebsockets`, `openrouterVariant`, and `loopGuard`.

Unknown, `null`, and `undefined` option values are silently dropped by the
server. The client additionally strips runtime/server-owned fields:
`signal`, `apiKey`, `fetch`, `onPayload`, `onResponse`, `onSseEvent`,
`execHandlers`, `cursorExecHandlers`, `cursorOnToolResult`, and
`providerSessionState`. `onResponse` still runs locally against the gateway's
HTTP response; callbacks and runtime handles themselves never cross the wire.

## Streaming response

Each canonical `AssistantMessageEvent` is JSON-serialized without reshaping
and SSE-framed:

```text
data: {"type":"start",...}

data: {"type":"text_delta",...}

data: {"type":"done","reason":"stop","message":{...}}

data: [DONE]

```

The server stops after a canonical `done` or `error` event and then writes
`[DONE]`. If its event iterator throws first, it best-effort emits
`{"type":"error","reason":"error","errorMessage":"..."}` followed by `[DONE]`.
Cancelling the HTTP body propagates cancellation to the gateway request.

The client parses every event and pushes it verbatim into
`AssistantMessageEventStream`; there is no partial-content reconstruction or
tool conversion. A caller abort cancels the response body. First-event and
idle watchdogs use request options when supplied, otherwise the standard
`PI_STREAM_FIRST_EVENT_TIMEOUT_MS` / `PI_STREAM_IDLE_TIMEOUT_MS` policy.
The initial `start` event is not considered progress for the idle watchdog.

If the SSE connection closes without a terminal event, the client synthesizes
a terminal assistant boundary so `.result()` cannot hang. Caller cancellation
emits `{type:"error", reason:"aborted", error: syntheticAssistant}`; the nested
`AssistantMessage` has `stopReason:"aborted"` and
`errorMessage:"stream closed without terminal event"`. Any other clean close
emits `{type:"done", reason:"stop", message: syntheticAssistant}`, whose nested
message has `stopReason:"stop"`. Thus `reason` is the top-level event field;
`stopReason` exists only on the nested `AssistantMessage`.

The client consumes streaming responses only. The server endpoint also
supports `stream: false`, returning:

```json
{ "message": { "role": "assistant", "content": [] } }
```

with the full canonical `AssistantMessage` in `message`.

## Errors

Provider/handler failures that reach the pi-native route use:

```json
{ "error": { "type": "rate_limit_error", "message": "..." } }
```

with the appropriate HTTP status, `Content-Type: application/json`, and
`Cache-Control: no-store`. The client converts this shape into
`AuthGatewayError`, preserving status, response headers, and `type`.

Bearer authentication runs before the route handler. A missing or invalid
gateway bearer is rejected as `{"error":"unauthorized"}` instead of the
structured provider envelope; the client therefore uses its generic
`auth-gateway STATUS: BODY_OR_STATUS_TEXT` fallback and has no provider error
`type` to preserve. Other nonconforming error bodies use the same fallback. A
successful response with no body is also an `AuthGatewayError`.

## Source of truth

- `packages/catalog/src/types.ts` — `Model.transport`
- `packages/ai/src/stream.ts` — pi-native dispatch
- `packages/ai/src/providers/pi-native-client.ts` — request, auth, SSE and
  timeout behavior
- `packages/ai/src/providers/pi-native-server.ts` — request validation,
  option allow-list, SSE and error envelopes
- `packages/ai/src/auth-gateway/server.ts` — `/v1/pi/stream` route and gateway
  model/credential resolution
