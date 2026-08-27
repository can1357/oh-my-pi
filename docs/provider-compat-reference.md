# Provider compat reference: OpenAI compat flags, reasoning levels, and tool handling

Reference for four subsystems of `packages/ai` (with type definitions in `packages/catalog`):

1. [OpenAI compat flags](#1-openai-compat-flags) — every `compat` field and its wire effect
2. [Reasoning levels](#2-reasoning-levels) — how efforts/thinking budgets flow to each provider
3. [Tool handling per provider](#3-tool-handling-per-provider) — schema conversion, streaming, result encoding
4. [Forced tool choice](#4-forced-tool-choice) — `toolChoice` semantics, wire mapping, emulation

Related references:

- [Provider endpoint constraints](./provider-endpoint-constraints.md) — where a new constraint should live
- [Provider streaming internals](./provider-streaming-internals.md) — stream event normalization
- [Provider quirks](./provider-quirks.md) — per-provider special casings, stream behavior, auth/usage, catalog handling
- [Model and Provider Configuration](./models.md) — `models.yml` and user-facing `compat` overrides

## 1. OpenAI compat flags

### Architecture

Compat flags are resolved in two phases:

1. **Catalog build time** (`packages/catalog/src/compat/openai.ts`): `buildOpenAICompat(spec)` / `buildOpenAIResponsesCompat(spec)` run once per model inside `buildModel`. Defaults are auto-detected from `provider`, `baseUrl`, model id/name, and `spec.reasoning`; explicit `spec.compat` overrides are merged via `applyCompatOverrides` (`packages/catalog/src/compat/apply.ts`). If a `whenThinking` variant applies (explicit override, direct DeepSeek reasoning, OpenCode reasoning gateways), a **complete alternate resolved compat object** is pre-built and attached as `compat.whenThinking`.
   OpenRouter is a pseudo-API: `buildOpenRouterCompat` merges the full chat-completions view with the Responses-only fields into `ResolvedOpenRouterCompat`, so the same model object satisfies both runtime handlers (`PI_OPENROUTER_RESPONSES` picks the dispatch).
2. **Request time** (`packages/ai/src/providers/openai-shared.ts`): `resolveOpenAICompatPolicy(model, options)` combines the resolved compat with per-request options (`reasoning`, `disableReasoning`, `toolChoice`, …) into an `OpenAICompatPolicy` with `reasoning`, `tools`, `messages`, and `stream` sub-policies. When thinking is active and `whenThinking` exists, the policy **pointer-swaps** to the pre-built variant — no per-request spreading or allocation:

   ```ts
   const compat = enabled && baseCompat.whenThinking ? baseCompat.whenThinking : baseCompat;
   ```

Consumers: `applyChatCompletionsCompatPolicy` + `buildParams` in `openai-completions.ts`, `buildResponsesInput` in `openai-responses.ts`, message transforms in `transform-messages.ts`, stream watchdogs in `stream.ts`.

Every flag declared in `packages/catalog/src/types.ts` is consumed somewhere in `packages/ai`; there are no dead flags.

### Shared flags (chat-completions + responses)

Types: `OpenAICompat` / `ResolvedOpenAISharedCompat` in `packages/catalog/src/types.ts`.

"Shared" means the field exists on both resolved views with the same wire contract — **not** that both builders detect the same default. `buildOpenAICompat` and `buildOpenAIResponsesCompat` each compute their own defaults; rows below use *Chat:* / *Responses:* where they diverge (single detection = identical on both surfaces).

#### Message shaping

| Flag | Default detection | Wire effect |
| --- | --- | --- |
| `supportsDeveloperRole` | Chat: official OpenAI, Azure. Responses: adds GitHub Copilot | System prompt sent as role `developer` instead of `system` |
| `requiresToolResultName` | Chat: `true` for Mistral. Responses: always `false` | Adds `name: <toolName>` on `role: "tool"` messages |
| `requiresAssistantAfterToolResult` | Chat: `true` for Mistral. Responses: always `false` | Inserts a synthetic assistant message between a tool result and a following user message (strict role alternation) |
| `requiresThinkingAsText` | Chat: `true` for Mistral. Responses: always `false` | Replays assistant thinking as `<thinking>...</thinking>` text instead of a native reasoning field (`transform-messages.ts`) |
| `requiresMistralToolIds` | Chat: `true` for Mistral. Responses: always `false` | Tool call ids normalized to exactly 9 alphanumeric chars (`normalizeMistralToolId`) |
| `requiresAssistantContentForToolCalls` | Chat: Kimi, direct DeepSeek reasoning. Responses: Kimi only | Empty assistant content on tool-call turns becomes `"."` to avoid HTTP 400 |
| `usesOpenAIToolCallIdLimit` | `true` for official OpenAI | Tool call ids truncated to 40 chars |

#### Reasoning wire format

| Flag | Default detection | Wire effect |
| --- | --- | --- |
| `supportsReasoningEffort` | Chat: `false` for Grok, Xiaomi MiMo, some Z.AI/Zhipu. Responses: `false` only for non-effort-capable Grok on `xai-oauth` | Gates emission of `reasoning_effort` |
| `omitReasoningEffort` | `true` when `supportsReasoningEffort` is `false` | Suppresses `reasoning_effort` even when thinking is on (the thinking toggle field still goes out) |
| `reasoningEffortMap` | Chat: Kimi K3 (`KIMI_K3_REASONING_EFFORT_MAP`), MiMo; else `{}`. Responses: always `{}` | Remaps `Effort` values to provider strings (e.g. `minimal` → `low`) |
| `thinkingFormat` | Chat: `"zai"` (Kimi K2.x/Z.AI/Zhipu/MiMo), `"qwen"` (DashScope), `"qwen-chat-template"` (Qwen on NVIDIA NIM), `"openrouter"`, `"openai"` default (including Venice/Fireworks Qwen). Responses: only `"openrouter"` or `"openai"` | Selects the thinking-enable encoding: `thinking: { type: "enabled" }` (zai), `enable_thinking: true` (qwen), `chat_template_kwargs: { enable_thinking: true }` (qwen-chat-template), `reasoning: { effort }` (openrouter), plain `reasoning_effort` (openai) |
| `reasoningDisableMode` | Derived from `thinkingFormat`, with host overrides | What to send when reasoning is explicitly off: `venice-disable-thinking` → `venice_parameters.disable_thinking: true`, `zai-thinking-disabled` → `thinking: { type: "disabled" }`, `qwen-enable-thinking-false` → `enable_thinking: false`, `qwen-template-false` → `chat_template_kwargs.enable_thinking: false`, `openrouter-enabled-false` → `reasoning: { enabled: false }`, `lowest-effort`, or `omit` (`encodeChatCompletionsDisabledReasoning`) |
| `supportsReasoningParams` | Chat: `false` for GitHub Copilot. Responses: always `true` | When `false`, suppresses **all** reasoning params |
| `reasoningContentField` | `"reasoning_content"` default; alternatives `"reasoning"`, `"reasoning_text"` | Key used when replaying assistant thinking on history messages |
| `requiresReasoningContentForToolCalls` | Chat: Kimi (except OpenCode aliases), DeepSeek reasoning, MiMo, OpenRouter reasoning requests. Responses: Kimi/DeepSeek/OpenRouter, only when reasoning-capable | Assistant tool-call turns in history must carry reasoning content (real or synthetic) |
| `requiresReasoningContentForAllAssistantTurns` | Direct DeepSeek reasoning, MiMo | Extends the above to every assistant turn |
| `allowsSyntheticReasoningContentForToolCalls` | Chat: `false` for DeepSeek reasoning family and MiMo. Responses: `false` for DeepSeek reasoning | When `true`, a `"."` placeholder may substitute for stripped reasoning; when `false`, only real content is replayed |
| `replayReasoningContent` | Chat: `true` for local backends (llama.cpp, LM Studio, vLLM, Ollama, loopback/private baseUrls). Responses: always `false` (reasoning replays via encrypted items instead) | Replays preserved thinking as `reasoning_content` on every assistant turn so local chat templates can rebuild `<think>` blocks and keep prefix KV-cache hits |
| `qwenPreserveThinking` | Chat: Qwen thinking formats on local backends with `replayReasoningContent`. Responses: always `false` (template knob is chat-completions-only) | Emits `preserve_thinking: true` (top-level and/or in `chat_template_kwargs`) so Qwen 3.6+ templates render `<think>` for older turns too — a history knob, not a per-turn switch (`applyChatCompletionsCompatPolicy`) |
| `kimiApiFormat` | Per-model protocol metadata | `"openai"` vs `"anthropic"` transport for Kimi Code models (`providers/kimi.ts`) |
| `includeEncryptedReasoning` | Chat: always `true`. Responses: `false` for `xai-oauth` | Whether Responses requests replay encrypted reasoning items |
| `filterReasoningHistory` | Chat: OpenRouter Anthropic models. Responses: adds `xai-oauth` | Filters native reasoning items out of replayed Responses history |

#### Tool choice / strict interaction

| Flag | Default detection | Wire effect |
| --- | --- | --- |
| `supportsToolChoice` | Chat: `false` for direct DeepSeek reasoning. Responses: always `true` | When `false`, `tool_choice` is omitted entirely |
| `supportsForcedToolChoice` | Chat: `false` for thinking-required models and OpenCode DeepSeek reasoning. Responses: always `true` | When `false`, `required`/named choices downgrade to `auto` |
| `supportsNamedToolChoice` | `false` for string-only hosts (llama.cpp, LM Studio) | When `false`, a named choice becomes: filter `tools` to that one function + `tool_choice: "required"` |
| `disableReasoningOnForcedToolChoice` | Chat: Kimi (except native K3) or Anthropic model ids. Responses: all Kimi | Drops reasoning fields when tool choice is forced |
| `disableReasoningOnToolChoice` | DeepSeek reasoning (except via OpenRouter) | Drops reasoning fields when **any** `tool_choice` is present |
| `supportsStrictMode` | `true` for OpenAI, OpenRouter, Cerebras, Together, Copilot, Zenmux, Azure, DeepSeek | When `false`, `strict: true` is never set on tool definitions |
| `toolSchemaFlavor` | `"moonshot-mfjs"` for Kimi/Moonshot, `"grammar"` for local backends | Extra schema normalization: `normalizeSchemaForMoonshot` or `sanitizeSchemaForGrammar` (`utils/schema/normalize.ts`) |

#### Sampling, tokens, caching, routing

| Flag | Default detection | Wire effect |
| --- | --- | --- |
| `supportsSamplingParams` | `false` for o1/o3/gpt-5+ class models | When `false`, omits `temperature`/`top_p`/penalties (they 400) |
| `alwaysSendMaxTokens` | Kimi family | Always sends the max-output-tokens field (defaults to model max) to keep Kimi TPM accounting correct |
| `openRouterRouting` | unset | Adds `provider: { only, order }` body field on OpenRouter (`applyOpenAIGatewayRouting`) |
| `promptCacheSessionHeader` | Chat: `"x-grok-conv-id"` for Grok (`xai`). Responses: same header, for `xai-oauth` | Emits that HTTP header with the prompt-cache session key |
| `supportsPromptCacheBreakpoints` / `promptCacheBreakpointTtl` | Official OpenAI GPT-5.6+ | Gates explicit prompt-cache breakpoints; `ConfigurationError` if requested unsupported. TTL default `"30m"` |
| `isOpenRouterHost` | OpenRouter host detection (both builders) | Omits default max-token cap (optional fields are routing hints on OpenRouter) and attaches routing |
| `wireModelIdMode` | Chat: `"firepass"` / `"fireworks"` / `"openrouter"` / `"raw"`. Responses: `"openrouter"` or `"raw"` | Model-id rewriting for gateway dispatch |

#### Stream parsing / watchdogs

| Flag | Default detection | Wire/stream effect |
| --- | --- | --- |
| `reasoningDeltasMayBeCumulative` | MiniMax hosts | Stream parser treats reasoning deltas as cumulative snapshots, not increments |
| `stripDeepseekSpecialTokens` | DeepSeek on NVIDIA NIM or direct API | Strips leaked chat-template tokens (`<｜User｜>`, …) from visible text |
| `streamMarkupHealingPattern` | `"kimi"` (Kimi/Moonshot), `"dsml"` (DeepSeek DSML hosts), `"thinking"` (generic compat hosts), unset for official OpenAI | Selects the `StreamMarkupHealing` pattern for leaked template markup |
| `emptyLengthFinishIsContextError` | Ollama | Empty completion with `finish_reason: "length"` → context-overflow error |
| `streamFirstEventTimeoutMs` | `0` for local backends | First-event watchdog hint (`0` = unbounded prefill/model-load time) |
| `streamIdleTimeoutMs` | GLM/Alibaba coding plans 600 s; MiMo, Kimi reasoning, DeepSeek reasoning, local backends 300 s | Inter-event idle watchdog floor (`stream.ts`) |

### Chat-completions-only flags (`ResolvedOpenAICompat`)

| Flag | Default detection | Wire effect |
| --- | --- | --- |
| `supportsStore` | `true` for standard OpenAI-shaped hosts, `false` for non-standard (Cerebras, Grok, Mistral, Fireworks, Z.AI, …) | When `true`, sends `store: false` (opt out of retention); when `false`, the field is omitted because the host rejects it |
| `supportsMultipleSystemMessages` | `true` only for a canonical host allowlist (OpenAI, Azure, OpenRouter, Cerebras, Together, Fireworks, Groq, DeepSeek, Mistral, Grok, Z.AI, Zhipu, Copilot, Zenmux) and never for MiniMax/Alibaba/Qwen hosts; `false` for everything else (openai.ts `supportsMultipleSystemMessagesDefault`) | When `false`, leading system messages are coalesced into one (joined `\n\n`); when `true`, kept separate for KV-cache reuse |
| `supportsUsageInStreaming` | `false` for Cerebras | Adds `stream_options: { include_usage: true }` |
| `maxTokensField` | `"max_tokens"` for Mistral, native Moonshot, Z.AI, Zhipu, Chutes, Fireworks, direct DeepSeek; else `"max_completion_tokens"` | Output-token field name (`resolveOpenAIOutputTokenParam`) |
| `thinkingKeep` | `"all"` for Kimi K2.6 | Adds `thinking.keep: "all"` |
| `cacheControlFormat` | `"anthropic"` for OpenRouter `anthropic/*` models | Adds Anthropic `cache_control: { type: "ephemeral" }` markers to message parts (`maybeAddAnthropicCacheControl`) |
| `toolStrictMode` | `"all_strict"` for Cerebras; `"mixed"` default | `all_strict` forces `strict: true` on all tools, `none` omits it, `mixed` honors per-tool `strict` |
| `vercelGatewayRouting` / `isVercelGatewayHost` | Vercel AI Gateway hosts (also present on the Responses view) | Routing under `providerOptions.gateway` |
| `dropThinkingWhenReasoningEffort` | Fireworks | Deletes the `thinking` block when `reasoning_effort` is present (Fireworks rejects both together) |
| `extraBody` | unset (used by DeepSeek reasoning policy) | Arbitrary JSON merged into the request body (`applyOpenAIExtraBody`) |
| `whenThinking` | OpenCode gateways, direct DeepSeek reasoning, explicit overrides | Pre-built complete alternate `ResolvedOpenAICompat`, pointer-swapped in when thinking is active (chat-completions view only; OpenRouter's merged compat inherits it) |

### Responses-only flags (`ResolvedOpenAIResponsesCompat`)

| Flag | Default detection | Wire effect |
| --- | --- | --- |
| `supportsLongPromptCacheRetention` | Official OpenAI | Sends `prompt_cache_retention: "24h"` when requested |
| `strictResponsesPairing` | Azure OpenAI, Copilot Responses | Enforces strict 1:1 tool-call/tool-result pairing when building Responses input items |
| `supportsImageDetailOriginal` | `false` for Copilot, xai-oauth | `detail: "original"` vs `detail: "auto"` on input images (hosts that 400 on `original` get `auto`) |
| `supportsObfuscationOptOut` | Official OpenAI | Allows `stream_options: { include_obfuscation: false }` |

## 2. Reasoning levels

### The effort model

The canonical intensity scale is the `Effort` enum (`packages/catalog/src/effort.ts`): `minimal`, `low`, `medium`, `high`, `xhigh`, `max`.

Per-model capabilities live in `ThinkingConfig` (`packages/catalog/src/types.ts`), resolved once at model build time by `resolveModelThinking` (`packages/catalog/src/model-thinking.ts`):

- `mode` — transport mechanism: `effort` (OpenAI-style), `budget` (token budget), `google-level` (enum levels), `anthropic-adaptive`, `anthropic-budget-effort`
- `efforts` — supported levels in canonical order
- `effortMap` — baked remap to upstream wire strings (e.g. `xhigh` → `high` on models without xhigh)
- `effortRouting` — effort (or `"off"`) → dynamic model-id variants (`resolveWireModelId` picks the wire id)
- `effortBudgets` — pre-computed token budgets for collapsed effort tiers
- `requiresEffort` — thinking cannot be disabled
- `suppressWhenOff` — "off" must be sent explicitly on the wire (`includeThoughts: false` / `thinkingBudget: 0`), not just omitted

Runtime helpers: `clampThinkingLevelForModel` (clamps a requested effort to what the model supports), `mapEffortToGoogleThinkingLevel`, `mapEffortToAnthropicAdaptiveEffort`.

### Per-provider wire mapping

| Provider | Mode | Wire encoding |
| --- | --- | --- |
| Anthropic (`providers/anthropic.ts`) | `anthropic-adaptive` or `budget` | Adaptive: `thinking: { type: "adaptive" }` + `output_config.effort: low…max` (requires beta `effort-2025-11-24`); Budget: `thinking: { type: "enabled", budget_tokens: N }`. Interleaved thinking via beta `interleaved-thinking-2025-05-14`. `ensureMaxTokensForThinking` raises `max_tokens` to at least `budget_tokens + 1024` |
| OpenAI Responses (`providers/openai-responses.ts`) | `effort` | `reasoning: { effort }` plus `reasoning.summary: "auto" \| "detailed" \| "concise" \| null` |
| OpenAI Chat Completions (`providers/openai-completions.ts`) | `effort` | `reasoning_effort` by default; the actual toggle field depends on `thinkingFormat` (see [flag table](#reasoning-wire-format)) |
| Google Gemini / Vertex (`providers/google-shared.ts`) | `google-level` or `budget` | `thinkingConfig: { includeThoughts, thinkingLevel: MINIMAL…HIGH, thinkingBudget: N }` |

### The OpenAI-compat resolution pipeline

`resolveOpenAICompatPolicy` (`providers/openai-shared.ts`) decides per request:

1. **Enabled/disabled** — requested effort vs model reasoning support, minus suppression rules (`disableReasoningOnForcedToolChoice`, `disableReasoningOnToolChoice`, `none`-effort handling).
2. **`whenThinking` swap** — enabled + variant present → active compat becomes the pre-built variant.
3. **Wire effort** — requested `Effort` mapped through `compat.reasoningEffortMap` / `model.thinking.effortMap`; `omitReasoningEffort` suppresses the field while keeping the thinking toggle.
4. **Disable encoding** — when reasoning is off but the wire needs an explicit off-signal, `encodeChatCompletionsDisabledReasoning` emits the format from `reasoningDisableMode`.

If a host rejects the emitted effort with 400/422, `resolveOpenAIReasoningEffortFallback` (`providers/openai-reasoning-fallback.ts`) parses the error text to extract accepted values or drop the parameter, then retries.

### Getting thinking back out of the stream

- **Structured deltas**: providers emit `thinking_start` / `thinking_delta` / `thinking_end` stream events.
- **History replay**: prior thinking is replayed via `reasoningContentField` on assistant messages (KV-cache preservation on DeepSeek/Z.AI/Qwen/local backends); models that demand reasoning content on tool-call turns get real content or a `"."` placeholder per `allowsSyntheticReasoningContentForToolCalls`.
- **Leaked thinking healing**: `wrapLeakedThinkingStream` (`utils/leaked-thinking-stream.ts`) converts in-band ` ```thinking ` / `<think>` fences from misbehaving hosts into structured thinking blocks live.
- **Loop guard**: `withThinkingLoopGuard` (`utils/thinking-loop.ts`) detects runaway reasoning (verbatim repeats, near-duplicate trigram clusters, progress-lexicon stalls) and kills the stream with a retryable `AIError.Flag.ThinkingLoop`.

### Interactions

- **Sampling clamps**: models with active reasoning (Opus 4.7+, Fable/Mythos 5, o-series/GPT-5) reject explicit `temperature`/`top_p`; `anthropic.ts` and the compat policy (`supportsSamplingParams`) suppress them.
- **Forced tool choice**: see [§4](#edge-cases); several providers must drop thinking when a tool call is forced.

## 3. Tool handling per provider

All providers start from the same neutral wire schema — `toolWireSchema(tool)` (`utils/schema/wire.ts`) — and diverge in normalization, streaming shape, and result encoding.

### Anthropic (`providers/anthropic.ts`)

- **Schemas**: `buildAnthropicToolSchemaPlans` decides strictness per tool: allowlist (`ANTHROPIC_STRICT_TOOL_ALLOWLIST`), no incompatible keywords (`oneOf`/`allOf`/`$ref`/`patternProperties`/`propertyNames`), and budget caps (`MAX_ANTHROPIC_STRICT_TOOLS`, optional/union parameter limits). Strict schemas get `normalizeAnthropicStrictSchema` (`additionalProperties: false`); open maps stay non-strict to preserve map semantics. Wire: `{ name, description, input_schema, eager_input_streaming?, strict? }`.
- **Streaming**: `content_block_start` (`tool_use`, carries `id`+`name`) → `input_json_delta` fragments → parse via `parseStreamingJson` at `content_block_stop`. Envelope anomalies are logged (`reportAnthropicEnvelopeAnomaly`), not fatal.
- **Results**: `user` message with `tool_result` blocks (`tool_use_id`). Images embed inside `tool_result.content`; on **error** results Anthropic rejects embedded images, so text stays in the block and images are hoisted after the `tool_result` run. Z.AI's Anthropic-shaped endpoint additionally needs `id` on the block (`requiresToolResultId`).
- **Replay quirk**: assistant turns are stably partitioned `[...non_tool_use, ...tool_use]` so `tool_use` blocks sit at the tail — otherwise Anthropic 400s with "tool_use ids were found without tool_result blocks immediately after".
- **Strict fallback**: a 400 strict rejection sets `providerSessionState.strictToolsDisabled` and retries without `strict`.

### OpenAI Chat Completions (`providers/openai-completions.ts`)

- **Schemas**: `convertTools` + `adaptSchemaForStrict`; strictness from `toolStrictMode` (`all_strict` / `mixed` / `none`) gated by `supportsStrictMode` and per-tool `strict`. Moonshot hosts additionally pass the MFJS subset check. Wire: `{ type: "function", function: { name, description, parameters, strict? } }`.
- **Streaming**: `choice.delta.tool_calls` (`index`, `id`, `function.name`, `function.arguments` fragments). MiniMax streams arguments as a raw JSON **object** instead of a string — both shapes are merged (`mergeStreamingArgumentObjects`). Leaked DeepSeek template tokens are stripped per `stripDeepseekSpecialTokens`. `finish_reason: "stop"` is promoted to `"tool_calls"` when structured calls were seen.
- **Results**: `{ role: "tool", tool_call_id, content }`; Mistral ids normalized; assistant replay sets `tool_calls` array and content `""` (or `"."` under `requiresAssistantContentForToolCalls`). Non-vision models get image placeholders via `partitionVisionContent`.

### OpenAI Responses (`providers/openai-responses.ts`)

- **Schemas**: `sanitizeSchemaForOpenAIResponses` + `adaptSchemaForStrict`. Supports function tools, freeform **custom tools**, and native **computer tools** (`model.supportsComputerUse`). Wire: flat `{ type: "function", name, description, parameters, strict? }`.
- **Streaming**: `response.output_item.added` → `response.function_call_arguments.delta` / `response.custom_tool_call_input.delta` → `response.output_item.done`. Tool call ids are composite `callId|itemId` (`normalizeResponsesToolCallId`).
- **Results**: `function_call_output` and `custom_tool_call_output` items pair with calls by `call_id` (the `callId` half of the composite). Their `output` is either a string or an array of canonical `input_text` and `input_image` blocks. Vision-capable models keep tool-result images inside that array instead of creating synthetic user messages; models without image input receive a text placeholder. Auth-gateway parsing also accepts legacy `output_text`, `text`, and `refusal` blocks, decodes inline data-image URLs into image content, and retains remote image URLs or OpenAI image file IDs as references. File IDs require a Responses-compatible upstream because other provider transports cannot resolve them. `input_file` remains supported for request messages but is rejected in tool outputs until canonical tool results can replay its bytes and references losslessly. Stateful `previous_response_id` chaining works across turns.

### Google Gemini / Vertex (`providers/google-shared.ts`, `google.ts`)

- **Schemas**: functions wrapped in `{ functionDeclarations }`. Gemini API/Vertex use `parametersJsonSchema: normalizeSchemaForGoogle(...)` (strips `$schema`, `additionalProperties`, converts type arrays to nullable); Cloud Code Assist / Antigravity / Gemini CLI use `parameters: normalizeSchemaForCCA(...)`.
- **Streaming**: `part.functionCall` arrives with `name` and a complete `args` **object** (no argument-fragment streaming). Google omits call ids → synthesized via `nextToolCallId(name)`.
- **Vertex quirk**: Vertex `GenerateContent` **rejects** `id` on `functionCall`/`functionResponse` parts; they are deleted when `model.provider === "google-vertex"`.
- **Results**: `user` message with `functionResponse` parts. All parallel responses must be merged into a **single contiguous** `user` message or Google errors with "number of function response parts is not equal to number of function call parts". Images: Gemini 3+ supports multimodal `functionResponse.parts`; older Gemini gets images buffered (`pendingToolImageParts`) and flushed as a separate user turn after the response.

### Amazon Bedrock (`providers/amazon-bedrock.ts`)

- **Schemas**: `convertToolSpec` → `{ toolSpec: { name, description, inputSchema: { json } } }`.
- **Streaming**: `start.toolUse` (`toolUseId`, `name`) then `delta.toolUse.input` fragments.
- **Results**: all consecutive tool results grouped into one `user` message with a `toolResult` array (Converse API requirement); images embed in the `content` array.
- **Sentinel quirk**: Converse validates that any request whose history contains `toolUse`/`toolResult` must supply a `toolConfig`. With no active tools (or `toolChoice: "none"`), `planToolConfig` injects `NO_TOOLS_SENTINEL` (`__no_tools__`, "do not call" description) with `toolChoice: { auto: {} }`; a call to the sentinel is dropped from the stream (`sentinelInjected` check).

### Differences summary

| | Anthropic | OpenAI Completions | OpenAI Responses | Google | Bedrock |
| --- | --- | --- | --- | --- | --- |
| Schema normalizer | strict allowlist + budgets | `adaptSchemaForStrict` | `sanitizeSchemaForOpenAIResponses` | `normalizeSchemaForGoogle` / CCA | raw JSON schema |
| Args streaming | JSON string fragments | JSON string fragments (MiniMax: objects) | JSON string fragments | complete object, no fragments | JSON string fragments |
| Call ids | native | native (+Mistral 9-char, OpenAI 40-char rules) | composite `callId\|itemId` | synthesized; Vertex strips | native |
| Result encoding | `user` + `tool_result` blocks | `role: "tool"` messages | function/custom output items | `user` + `functionResponse` parts, single message | `user` + grouped `toolResult` array |
| Images in results | embedded; hoisted on error | placeholder partition | inside output arrays; placeholder without image input | Gemini 3+ embedded, else trailing user turn | embedded |
| Parallel calls | native | native | native | native | native |

### Strict tools lifecycle

`OpenAIStrictToolsState` (`providers/openai-shared.ts`) tracks strict-mode failures per scope `${provider}:${baseUrl}:${modelId}`: a 400 strict-schema rejection calls `disableStrictToolsForScope`, and `isStrictToolsDisabledForScope` makes all subsequent requests for that scope run non-strict — one retry, then remembered, no per-turn 400 tax. Anthropic has the analogous per-session `strictToolsDisabled` flag.

### Text-based tool-call dialects (`src/dialect/`)

Used when native tool APIs are unavailable, or when history must be re-encoded for a different model family:

1. **In-band tool calling**: `renderInbandToolPrompt(tools, dialect)` injects the tool inventory into the prompt; `InbandScanner` / `wrapInbandToolStream` parse streamed text back into structured tool calls. Dialects: `harmony`, `gemini`, `qwen3`, `deepseek`, `kimi`, `glm`, `gemma`, `hermes`, `minimax`, `xml`, `anthropic`.
2. **Cross-model history replay**: switching models mid-session re-renders prior thinking/tool turns in the target's `preferredDialect(modelId)` (`renderDemotedThinking`, `encodeInbandToolHistory`).
3. **Harmony** (`dialect/harmony.ts`): GPT-5/Codex control tokens (`<|start|>`, `<|call|>`, `<|channel|>`, `<|return|>`); `utils/harmony-leak.ts` escapes them when replaying through non-Harmony endpoints.
4. **Healing**: `StreamMarkupHealing` (`utils/stream-markup-healing.ts`) uses the same scanners to reconstruct tool calls and thinking from markup leaked into visible text by hosted models.

### Edge guards

- **`utils/tool-call-loop-guard.ts`**: `ToolCallLoopGuard` canonicalizes arguments (sorted keys, `intent` stripped), hashes `${name}:${canonicalArgs}`, and on repeated identical calls returns a `RepeatedToolCallDetection` used to steer the model out of the loop.
- **`utils/deterministic-id.ts`**: `deterministicUuid(seed)` (SHA-256 → UUID shape) backs `ensureToolCallId` wherever a provider omits or mangles wire ids (Google, Bedrock, degenerate completions).
- **`providers/transform-messages.ts`**: shared pre-flight pass — tool-call dedup, sanitization, id normalization — before provider-specific conversion.

## 4. Forced tool choice

### Unified `ToolChoice` (`src/types.ts`)

```ts
type ToolChoice =
  | "auto" | "none" | "any" | "required"
  | { type: "function"; name: string }
  | { type: "function"; function: { name: string } }
  | { type: "tool"; name: string }
  | { type: "computer" };
```

- `auto` — model decides (default when tools are present)
- `none` — no tool calls this turn
- `required` / `any` — at least one tool call (OpenAI vs Anthropic spelling; interchangeable)
- named pin — call exactly this tool
- `{ type: "computer" }` — dispatch to the native computer-use tool

`toolChoice` is **one-shot per request** inside `packages/ai` — no stickiness; the caller decides each turn.

### Mapping utilities (`src/utils/tool-choice.ts`)

| Export | Semantics |
| --- | --- |
| `isForcedToolChoice(choice)` | `true` for anything other than `undefined`/`"auto"`/`"none"` — i.e. `required`, `any`, and all pins. Used everywhere a provider must react to forcing |
| `mapToOpenAICompletionsToolChoice` | → `"auto" \| "none" \| "required" \| { type: "function", function: { name } }` (`any` → `required`, nested name shape) |
| `mapToOpenAIResponsesToolChoice` | → same strings plus **flat** `{ type: "function", name }`, `{ type: "custom", name }`, `{ type: "computer" }` passthrough |
| `mapToAnthropicToolChoice` | → `"auto" \| "none" \| "any" \| { type: "tool", name }` (`required` → `any`) |

### Per-provider wire mapping

| Provider | Wire field | Values | Downgrades / guards |
| --- | --- | --- | --- |
| OpenAI Completions | `tool_choice` | strings + nested function object | `!supportsNamedToolChoice` → filter tools + `"required"`; `!supportsForcedToolChoice` → `"auto"`; forced tool absent from `tools` → delete `tool_choice`; `"none"` with no tools → dropped (LiteLLM/Bedrock proxies 400) |
| OpenAI Responses | `tool_choice` | strings + flat function/custom/computer objects | Same named/forced downgrades; choice validated against tools **surviving schema quarantine** — a pin on a dropped tool is deleted; `{ type: "computer" }` on models without native computer use is remapped to the function tool name (also `azure-openai-responses.ts`) |
| Anthropic | `tool_choice` | `{ type: "auto" \| "none" \| "any" \| "tool", name? }` | Names via `encodeAnthropicToolName`; `!supportsForcedToolChoice` (Fable/Mythos) → `auto` |
| Google Gemini/Vertex | `toolConfig.functionCallingConfig` | `mode: AUTO \| NONE \| ANY` (+ `allowedFunctionNames` for pins) | Antigravity/Gemini CLI uses `mode: VALIDATED` default (`google-gemini-cli.ts`) |
| Bedrock | `toolConfig.toolChoice` | `{ auto: {} } \| { any: {} } \| { tool: { name } }` | `planToolConfig`; `"none"` + tool history + no tools → `NO_TOOLS_SENTINEL` with `{ auto: {} }` |
| Ollama | `tool_choice` | only `"none"` / `"required"` | Pins emulated by `selectToolsForToolChoice`: filter tools to the target, send `"required"` |

### Emulation and fallback paths

1. **String-only hosts** (`supportsNamedToolChoice: false` — LM Studio, llama.cpp, Ollama): object pins are rejected by the host, so the provider advertises **only the pinned tool** and sends `tool_choice: "required"` — with one tool offered, `required` is equivalent to a pin.
2. **Bedrock sentinel**: see [§3](#amazon-bedrock-providersamazon-bedrockts).
3. **Computer pin fallback**: `{ type: "computer" }` without native support degrades to a named function pin.
4. **Stale pin pruning**: a forced tool missing from the final tool list (active-tool filtering, schema quarantine) silently drops `tool_choice` rather than emitting an invalid request.

### Interaction with reasoning

Several backends reject thinking + forced tool choice together:

- **Anthropic**: `disableThinkingIfToolChoiceForced` deletes `params.thinking`; adaptive-only models pin `output_config.effort = "low"` so default adaptive thinking doesn't kick back in.
- **Bedrock**: forced `any`/`tool` clears `additionalModelRequestFields` (where thinking config lives).
- **OpenAI compat**: `resolveOpenAICompatPolicy` honors `disableReasoningOnForcedToolChoice` / `disableReasoningOnToolChoice`. Exception: Kimi K3 keeps reasoning effort with forced `"required"` (`hasActiveNativeKimiK3Reasoning` in `openai-completions.ts`).

### How the agent loop drives it (`packages/agent`)

- **Per-turn resolution**: `agent-loop.ts` resolves `config.getToolChoice()` at the start of every turn:
  ```ts
  const effectiveToolChoice = ownedDialect ? undefined : (hostToolChoice ?? forcedToolChoice ?? config.toolChoice);
  ```
  When an owned in-band dialect is active, native tools are stripped, so `tool_choice` must be `undefined` (native `tool_choice` without native `tools` 400s).
- **Soft requirements** (`SoftToolRequirement`, `packages/agent/src/types.ts`): forcing `tool_choice` every turn would churn the provider prompt cache. A soft requirement (`{ soft: true, toolName, reminder }`) first injects the reminder text with `toolChoice` left at auto; only if the model fails to call `toolName` does the next turn escalate to a hard `{ type: "tool", name }` for a single turn.
- **Active-tool refresh**: `refreshToolChoiceForActiveTools` (`packages/agent/src/agent.ts`) drops a queued forced choice whose tool is no longer in the active set.
- **Compaction/handoff**: run with `toolChoice: "none"` to keep the prompt-cache prefix while forcing text-only output; an auto-only 400 gets one retry with `"auto"` (`packages/agent/src/compaction/compaction.ts`).
