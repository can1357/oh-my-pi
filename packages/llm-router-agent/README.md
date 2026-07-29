# LLM Router Agent with Tool-Use Capture

A production-oriented LLM routing package with an added **tool-use capture layer** for cross-training tool routing and saving live context.

It includes:

- rich feature extraction for model routing
- deterministic rules plus optional learned scoring
- explicit quality / latency / cost / safety objectives
- fallback chains and output validation
- JSONL routing telemetry
- tool-call/result/error capture
- compact tool-result summaries to keep context small
- JSONL training export for tool-routing cross-training
- Oh My Pi / OMP-compatible extension entry point
- standalone CLI for local policy and telemetry testing

The package is model-provider agnostic. Defaults use symbolic selectors such as `pi/smol`, `default`, and `pi/slow`; replace these in `examples/router.config.json` for your fork or provider catalog.

## Contents

```text
src/
  agent.ts              High-level router facade
  cli.ts                Standalone CLI
  config.ts             Config loading and validation
  defaults.ts           Default objectives, model profiles, rules, and capture policy
  extension.ts          OMP-compatible extension entry point
  features.ts           Task/input/user/runtime feature extraction
  learned.ts            Optional linear learned policy layer
  policy.ts             Rule + scorer routing policy
  telemetry.ts          JSONL router telemetry helpers
  step-context.ts       StepContext adapter and compact trace projection
  tool-capture.ts       Tool-use capture, summaries, wrappers, training export
  validation.ts         Output validators and escalation decisioning
  types.ts              Public types
examples/
  router.config.json    Editable router and tool-capture configuration
  omp-config.yml        Example OMP config snippet
  schema.sample.json    Validation example

docs/
  architecture.md       Component and request lifecycle design
  omp-compatibility.md  How this maps to Oh My Pi extension loading
  routing-policy.md     Policy details and tuning notes
  tool-use-capture.md   Capture schema, context-saving, training export

tests/
  *.test.mjs            Node test suite against compiled output
```

## Quick start

```bash
cd llm-router-agent-tooluse
npm run build
node dist/cli.js decide --message "Debug this TypeScript error and return a patch"
```

Capture a tool result and export a training example:

```bash
node dist/cli.js tool-capture \
  --tool file_search.msearch \
  --phase completed \
  --args '{"queries":["lease pet policy"],"source_filter":["file_library"]}' \
  --result '{"hits":[{"title":"Lease","snippet":"Pets require written approval."}]}'

node dist/cli.js tool-summary --path .llm-router/tool-use.jsonl
node dist/cli.js tool-export --output .llm-router/tool-routing-training.jsonl
```

Pass agent-step metadata through the same request JSON when routing a specific
trajectory step:

```bash
node dist/cli.js features --json --message '{
  "message": "Operate this page and verify the form state.",
  "metadata": {
    "stepContext": {
      "stepKind": "browser",
      "stepRisk": "high",
      "lastVerifier": "fail",
      "recentFailures": 1,
      "estimatedCacheHit": false
    }
  }
}'
```

`StepContext` metadata is normalized into routing features, policy rules, and
compact telemetry traces. Raw `recentToolCalls` are not persisted in decision
telemetry; traces retain only counts and scalar fields such as risk, verifier
state, cache hints, and remaining-token budgets.

## Tool-use capture layer

The capture layer records tool activity as compact JSONL events. It is designed to support two goals:

1. **Cross-training tool routing**: convert real tool-use traces into supervised examples showing when a tool was used, which tool was selected, what payload shape it had, whether it succeeded, and which context policy was used.
2. **Saving context**: replace large raw tool payloads with a short `contextSummary` and `savedContextTokensEstimate` so the agent can keep useful state without carrying entire tool outputs forward.

Captured records include:

- request, turn, message, and tool-call IDs when available
- tool name, namespace, phase, latency, and status
- redacted argument/result/error snapshots
- payload token estimates and compact previews
- URL/file-reference/secret-like signals
- context-saving summary
- training hint label

By default, secrets are redacted and full payloads are not retained.

## Library usage

```ts
import { LLMRouter, ToolUseCaptureLayer, cloneDefaultConfig } from "@pk/llm-router-agent-tooluse";

const router = new LLMRouter(cloneDefaultConfig());

await router.captureTool({
  requestId: "req_123",
  toolCallId: "tool_abc",
  toolName: "file_search.msearch",
  phase: "completed",
  args: { queries: ["lease pet policy"], source_filter: ["file_library"] },
  result: { hits: [{ title: "Lease", snippet: "Pets require written approval." }] },
  promptPreview: "What does my lease say about pets?",
});

const layer = new ToolUseCaptureLayer(router.config);
const wrappedSearch = layer.wrapTool("file_search.msearch", async (query: string) => {
  return { hits: [{ title: "Lease", snippet: "Pets require written approval." }] };
});

await wrappedSearch("lease pet policy");
```

## OMP / Oh My Pi extension behavior

The extension registers:

- `router_decide` — returns a model route decision.
- `router_validate_output` — validates JSON/schema/regex/safety requirements.
- `router_capture_tool_use` — records a tool call/result/error and returns a compact summary.
- `router_export_tool_training` — exports captured tool-use telemetry into training JSONL.
- `/router` command — status, route inspection, telemetry, tool telemetry, export, reload.
- optional input hook — records model-route decisions for user turns.
- optional tool-event hooks — listens for common runtime events such as `tool_call`, `tool_start`, `tool_result`, `tool_end`, `tool_error`, and `tool_use` when exposed by the fork.

The runtime hooks are intentionally permissive: if your `oh-my-pk` fork emits different field names, the layer still accepts manual capture through `router_capture_tool_use` or direct library calls.

## Install into an Oh My Pi / OMP project

Build the package:

```bash
npm run build
```

Then either add the built extension directly:

```yaml
# .ompk/config.yml or ~/.ompk/agent/config.yml
extensions:
  - /absolute/path/to/llm-router-agent-tooluse/dist/extension.js
```

or copy the whole package directory into a discovered extension path:

```text
<repo>/.ompk/extensions/llm-router-agent-tooluse/
  package.json
  dist/extension.js
  dist/**/*.js
```

The manifest includes both current and legacy extension metadata:

```json
{
  "omp": { "extensions": ["./dist/extension.js"] },
  "pi": { "extensions": ["./dist/extension.js"] }
}
```

## Configuration

Start from `examples/router.config.json`.

Important tool-capture settings:

```json
{
  "toolCapture": {
    "enabled": true,
    "path": ".llm-router/tool-use.jsonl",
    "sampleRate": 1,
    "captureArgs": "redacted",
    "captureResults": "summary",
    "maxPayloadChars": 2000,
    "maxSummaryChars": 900,
    "contextBudgetTokens": 400,
    "emitToTelemetry": false,
    "includeTrainingHints": true,
    "ignoredToolNames": ["router_capture_tool_use", "router_export_tool_training"],
    "redactKeys": ["api_key", "authorization", "cookie", "password", "secret", "token"]
  }
}
```

Supported payload capture modes:

- `none` — keep no payload preview.
- `metadata` — keep hashes, keys, estimates, no preview.
- `summary` — keep compact preview suitable for context.
- `redacted` — keep redacted truncated preview.
- `full` — keep redacted payload subject to `maxPayloadChars`.

Config lookup order:

1. `LLM_ROUTER_CONFIG=/path/to/config.json`
2. `<cwd>/.llm-router/config.json`
3. `<cwd>/.llm-router.json`
4. `~/.ompk/agent/llm-router.json`
5. built-in defaults

## CLI commands

```bash
node dist/cli.js decide --message "Write unit tests for this function"
node dist/cli.js features --message "Translate this to Spanish"
node dist/cli.js validate --output '{"ok":true}' --schema examples/schema.sample.json
node dist/cli.js telemetry --path .llm-router/telemetry.jsonl

node dist/cli.js tool-capture --tool web.search --phase completed --args '{"q":"OMP extensions"}' --result '{"hits":3}'
node dist/cli.js tool-summary --path .llm-router/tool-use.jsonl
node dist/cli.js tool-export --output .llm-router/tool-routing-training.jsonl
```

## Training export shape

`tool-export` writes JSONL examples like:

```json
{
  "version": 1,
  "id": "tool_abc:completed",
  "createdAt": "2026-07-08T00:00:00.000Z",
  "input": {
    "promptPreview": "What does my lease say about pets?",
    "availableTools": ["file_search.msearch"],
    "toolFeatures": {
      "operation": "msearch",
      "phase": "completed",
      "status": "success",
      "argumentKeys": ["queries", "source_filter"],
      "totalPayloadTokens": 240
    },
    "contextSummary": "Tool file_search.msearch completed; args: queries, source_filter; result: ..."
  },
  "label": {
    "useTool": true,
    "toolName": "file_search.msearch",
    "phase": "completed",
    "success": true,
    "contextPolicy": "drop_raw_result_keep_summary",
    "expectedSavedContextTokens": 180,
    "confidence": 0.85
  }
}
```

## Development checks

```bash
npm run check
npm test
```

The test suite uses only Node's built-in `node:test` module and compiled `dist` output.

## Integration notes for `oh-my-pk`

For your fork, update config first:

- `models.*.selector`
- `models.*.fallbackSelectors`
- `extension.mode`
- `toolCapture.path`
- `toolCapture.captureArgs`
- `toolCapture.captureResults`
- `toolCapture.ignoredToolNames`
- `objectives`
- `rules`

If the fork exposes a different event name for tool calls, wire that event to `router.captureTool(...)` or `ToolUseCaptureLayer.record(...)`. The package does not import `@oh-my-pi/pi-coding-agent`, so it remains resilient when package names or type exports move.
