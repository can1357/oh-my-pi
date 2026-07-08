# Tool-Use Capture Layer

## Purpose

The tool-use capture layer records tool activity in a compact, redacted, training-friendly format. It is designed for two related workflows:

1. **Tool-routing cross-training** — learn when to call a tool, which tool to choose, and which result-retention policy worked.
2. **Context savings** — replace large tool outputs with small summaries and token-saving estimates.

The layer is intentionally independent from any specific tool runtime. It can be used through:

- `LLMRouter.captureTool(...)`
- `ToolUseCaptureLayer.record(...)`
- `ToolUseCaptureLayer.wrapTool(...)`
- OMP extension tool `router_capture_tool_use`
- OMP runtime hooks when the fork emits compatible tool events
- CLI command `tool-capture`

## Capture lifecycle

```text
agent decides it needs a tool
  ↓
tool call is requested / started
  ↓
arguments are snapshotted with redaction
  ↓
tool completes or fails
  ↓
result/error is snapshotted using configured capture mode
  ↓
contextSummary is produced
  ↓
JSONL record is written
  ↓
training JSONL can be exported
```

## Event phases

Supported phases:

- `requested` — the agent or runtime selected the tool.
- `started` — tool execution began.
- `completed` — tool execution succeeded.
- `failed` — tool execution errored.
- `skipped` — a candidate tool was not called.

Use `requested`/`skipped` examples when you want to train a tool-selection model with positive and negative candidates. Use `completed`/`failed` examples when you want to train outcome-aware routing or context-retention policies.

## Capture record shape

Each captured line in `.llm-router/tool-use.jsonl` is a `ToolUseCaptureRecord`:

```json
{
  "requestId": "req_123",
  "toolCallId": "tool_abc",
  "timestamp": "2026-07-08T00:00:00.000Z",
  "toolName": "file_search.msearch",
  "namespace": "file_search",
  "phase": "completed",
  "durationMs": 84,
  "args": {
    "mode": "redacted",
    "kind": "json",
    "tokenEstimate": 32,
    "keys": ["queries", "source_filter"],
    "preview": "{...}",
    "hash": "...",
    "truncated": false,
    "redacted": false
  },
  "result": {
    "mode": "summary",
    "kind": "json",
    "tokenEstimate": 1200,
    "preview": "{...}",
    "hash": "...",
    "truncated": true,
    "redacted": false
  },
  "features": {
    "operation": "msearch",
    "phase": "completed",
    "status": "success",
    "argumentKeys": ["queries", "source_filter"],
    "hasUrl": false,
    "hasFileRef": false,
    "hasSecretLikeValue": false,
    "argTokenEstimate": 32,
    "resultTokenEstimate": 1200,
    "totalPayloadTokens": 1232
  },
  "contextSummary": {
    "text": "Tool file_search.msearch completed; args: queries, source_filter; result: ...",
    "tokenEstimate": 84,
    "savedContextTokensEstimate": 1148,
    "keepFields": ["toolName", "phase", "status", "argumentKeys", "preview", "hash", "latency"],
    "droppedFields": ["raw_result"]
  },
  "trainingHint": {
    "useTool": true,
    "toolName": "file_search.msearch",
    "phase": "completed",
    "success": true,
    "contextPolicy": "drop_raw_result_keep_summary",
    "expectedSavedContextTokens": 1148,
    "confidence": 0.85
  }
}
```

## Context-saving policy

The key field is `contextSummary.text`. It is safe to carry forward in conversation context instead of the raw tool payload.

The router estimates savings as:

```text
savedContextTokensEstimate = raw args/result/error token estimate - summary token estimate
```

This is approximate but useful for comparing policies such as:

- keep full tool output
- keep redacted preview
- keep summary only
- keep metadata only
- drop result entirely after extracting required fields

## Payload capture modes

`captureArgs` and `captureResults` can be configured independently.

| Mode | Behavior | Suggested use |
|---|---|---|
| `none` | No preview or hash | highly sensitive tools |
| `metadata` | keys, kind, hash, token estimate | production privacy default for sensitive orgs |
| `summary` | compact preview | long tool results |
| `redacted` | redacted truncated preview | arguments, structured short results |
| `full` | redacted payload up to `maxPayloadChars` | local development only |

Even in `full` mode, configured redaction still applies.

## Redaction

Redaction happens in two passes:

1. Object-key redaction, using `toolCapture.redactKeys`.
2. Serialized-payload regex redaction, using `toolCapture.redactPatterns`.

Default key redactions include tokens, cookies, API keys, passwords, client secrets, and private keys.

## Training export

Run:

```bash
node dist/cli.js tool-export \
  --path .llm-router/tool-use.jsonl \
  --output .llm-router/tool-routing-training.jsonl
```

Each exported line is a compact `ToolRoutingTrainingExample`:

```json
{
  "version": 1,
  "id": "tool_abc:completed",
  "input": {
    "promptPreview": "What does my lease say about pets?",
    "availableTools": ["file_search.msearch", "web.search"],
    "toolFeatures": {
      "operation": "msearch",
      "phase": "completed",
      "status": "success",
      "argumentKeys": ["queries", "source_filter"]
    },
    "contextSummary": "Tool file_search.msearch completed; ..."
  },
  "label": {
    "useTool": true,
    "toolName": "file_search.msearch",
    "success": true,
    "contextPolicy": "drop_raw_result_keep_summary"
  }
}
```

This JSONL can train a small tool-router model, ranker, or contextual bandit. The data is already compacted to avoid teaching the router to rely on massive raw tool outputs.

## OMP integration patterns

### Manual capture tool

Call `router_capture_tool_use` after any tool call:

```json
{
  "toolName": "file_search.msearch",
  "phase": "completed",
  "args": { "queries": ["lease pet policy"] },
  "result": { "hits": 3 },
  "requestId": "req_123"
}
```

### Runtime hooks

The extension listens for common event names:

- `tool_use`
- `tool_call`
- `tool_start`
- `tool_result`
- `tool_end`
- `tool_error`

If your fork uses different event names, call `router.captureTool(...)` directly from that hook.

### Wrapping tools directly

```ts
const layer = new ToolUseCaptureLayer(router.config);

const wrapped = layer.wrapTool("web.search", async (query: string) => {
  return search(query);
}, {
  requestId: "req_123",
  getArgsPayload: query => ({ query })
});
```

## Recommended production defaults

For production traffic:

```json
{
  "captureArgs": "redacted",
  "captureResults": "summary",
  "maxPayloadChars": 2000,
  "maxSummaryChars": 900,
  "emitToTelemetry": false,
  "sampleRate": 1
}
```

For sensitive deployments:

```json
{
  "captureArgs": "metadata",
  "captureResults": "metadata",
  "emitToTelemetry": false
}
```

For local development only:

```json
{
  "captureArgs": "redacted",
  "captureResults": "redacted",
  "maxPayloadChars": 8000
}
```
