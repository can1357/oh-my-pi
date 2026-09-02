# Provider quirks: special casings, streams, auth, and catalog handling

Per-provider deep dive for `packages/ai` transports: what each provider special-cases beyond
the shared pipeline, how its stream differs from the plain SSE/delta model, how it
authenticates and tracks usage/quotas, and what `packages/catalog` does specially for its
models (descriptors, discovery, identity, thinking metadata, pricing).

Related references:

- [Provider compat reference](./provider-compat-reference.md) — compat flags, reasoning levels, tool handling, forced tool choice
- [Provider endpoint constraints](./provider-endpoint-constraints.md) — where new constraints should live
- [Provider streaming internals](./provider-streaming-internals.md) — stream event normalization
- [Providers](./providers.md) — availability, credentials, login flows


## OpenAI Chat Completions
The OpenAI Chat Completions provider implements HTTP POST JSON body streaming over Server-Sent Events (SSE) for the standard OpenAI `/chat/completions` wire contract (`ChatCompletionCreateParamsStreaming` request schema and `ChatCompletionChunk` event payloads). It serves as the primary workhorse transport for OpenAI models as well as dozens of OpenAI-compatible gateways and third-party providers including Groq, Cerebras, Mistral, DeepSeek, Fireworks, Zhipu (Z.AI), Qwen (DashScope), Kimi (Moonshot), Synthetic, GitLab Duo, OpenRouter, Vercel AI Gateway, CoreWeave, HuggingFace, Nvidia NIM, Novita, GMI Cloud, Baseten, NanoGPT, and Sakana/Fugu. The transport is implemented across `packages/ai/src/providers/openai-completions.ts` (main streaming runner `streamOpenAICompletions`), `packages/ai/src/providers/openai-chat-wire.ts` (vendored wire types), `packages/ai/src/providers/openai-shared.ts` (shared request/policy/usage helpers), `packages/ai/src/providers/openai-reasoning-fallback.ts` (400 reasoning-effort recovery), `packages/ai/src/utils/openai-http.ts` (HTTP SSE client `postOpenAIStream`), and `packages/ai/src/utils/empty-completion-retry.ts` (`withReplaySafeStreamRetry` wrapper).

### Special casings
- **Azure Deployment Name Mapping**: `parseAzureDeploymentNameMap` in `packages/ai/src/providers/openai-shared.ts` parses the `AZURE_OPENAI_DEPLOYMENT_NAME_MAP` environment variable (comma-separated `modelId:deploymentName` pairs) in `createRequestSetup` (`packages/ai/src/providers/openai-completions.ts`) to translate model IDs into Azure deployment names, defaulting to `model.id` if unmapped.
- **Gateway Routing & Variant Transformations**: `applyOpenAIGatewayRouting` in `packages/ai/src/providers/openai-shared.ts` injects OpenRouter provider routing preferences (`params.provider`). `applyOpenRouterRoutingVariant` and `applyWireModelIdTransform` append OpenRouter model variant suffixes (`:nitro`, `:floor`, `:online`, `:extended`). `resolveSakanaRequestBaseUrl` handles Sakana/Fugu base URL overrides (`SAKANA_BASE_URL` / `FUGU_BASE_URL`), and `applyCoreWeaveProjectHeader` injects CoreWeave project headers.
- **Empty-Completion Retry**: `streamOpenAICompletions` is wrapped with `withReplaySafeStreamRetry` (`packages/ai/src/utils/empty-completion-retry.ts`), which retries a request up to `MAX_EMPTY_COMPLETION_RETRIES` (2 retries with exponential backoff `EMPTY_COMPLETION_BASE_DELAY_MS` = 500ms) if an attempt finishes cleanly with `finish_reason: "stop"` but emits no visible assistant content (`hasVisibleAssistantContent` checks for text, thinking, image, or tool calls) and <= 1 output token. The wrapper buffers pre-output events so discarded attempts are never replayed, and (with `retryProviderErrors: true`, `maxProviderErrorRetries: 1`) also retries transient provider errors before any output is committed.
- **Reasoning-Effort 400 Fallback**: `resolveOpenAIReasoningEffortFallback` and `applyOpenAIReasoningEffortFallback` (`packages/ai/src/providers/openai-reasoning-fallback.ts`) intercept 400/422 HTTP error responses caused by unsupported `reasoning_effort` values. It parses allowed levels from error messages (or resolves nearest supported level/null), remembers the fallback per-endpoint/model key (`createOpenAIReasoningEffortFallbackKey`, `rememberOpenAIReasoningEffortFallback`) in provider session state (`getOpenAICompletionsProviderSessionState`), and transparently retries the request without failing the turn.
- **Finish Reason Promotion**: In `streamOpenAICompletionsOnce` (`packages/ai/src/providers/openai-completions.ts`), if the backend reports `finish_reason: "stop"` but the turn produced structural `toolCall` blocks or healed tool calls via `StreamMarkupHealing`, `output.stopReason` is promoted from `"stop"` to `"toolUse"` so the agent execution loop correctly invokes tool handlers.
- **Mistral Tool ID Normalization**: `normalizeMistralToolId` in `packages/ai/src/providers/openai-completions.ts` restricts tool call IDs for Mistral models to exactly 9 alphanumeric characters (padding with deterministic characters `"ABCDEFGHI"` or truncating).
- **MiniMax Object Arguments Deep Merge**: `mergeStreamingArgumentObjects` in `packages/ai/src/providers/openai-completions.ts` handles MiniMax-compatible backends that stream `function.arguments` as JSON objects rather than strings, recursively merging partial object deltas across stream chunks.
- **DeepSeek Chat Template & Special Token Stripping**: `stripDeepseekSpecialTokens` and `getTrailingPartialDeepseekToken` in `packages/ai/src/providers/openai-completions.ts` buffer and strip raw `<｜...｜>` / `<|...|>` chat-template markers leaked in `delta.content` on DeepSeek endpoints (e.g. NVIDIA NIM, DeepSeek native API).
- **Dialect & Provider-Specific Quirks**: `isZaiReasoningEffortDialect` in `packages/ai/src/providers/openai-shared.ts` handles GLM-5.2 `zai` thinking formats. `dropOpenRouterKimiForcedToolReasoning`, `hasActiveNativeKimiK3Reasoning`, and `normalizeSchemaForMoonshot` manage Kimi (Moonshot) K3 tool schemas and reasoning modes. `applyOpenAIChatCompletionsPromptCachePolicy` injects prompt caching breakpoints (`cache_control: { type: "ephemeral" }` or `normalizeOpenAIPromptCacheKey` 64-char `pc_` prefix).

### Stream behavior
- **SSE Delta Decoding & Normalization**: `postOpenAIStream` (`packages/ai/src/utils/openai-http.ts`) uses `readSseJson` to decode raw SSE `data:` payloads into `ChatCompletionChunk` objects. `normalizeStreamingContentText` (`packages/ai/src/providers/openai-completions.ts`) normalizes `delta.content` whether received as a string or an array of content parts (`[{ type: "text", text: "..." }]`, e.g., Mistral Medium 3.5), preventing `[object Object]` string coercions.
- **Reasoning Fields & Encrypted Signatures**: `streamOpenAICompletionsOnce` inspects `delta.reasoning_content` (llama.cpp/vLLM), `delta.reasoning`, and `delta.reasoning_text`, using the first non-empty field per chunk to prevent duplicate reasoning text. Encrypted reasoning signatures in `delta.reasoning_details` (`reasoning.encrypted`) are attached to corresponding `toolCall.thoughtSignature`.
- **Partial JSON Throttling**: `parseStreamingJsonThrottled` (from `@oh-my-pi/pi-utils`) throttles incremental JSON parsing during tool argument streaming in `streamOpenAICompletionsOnce` to avoid high CPU overhead.
- **Stream Markup Healing**: `StreamMarkupHealing` (`packages/ai/src/utils/stream-markup-healing.ts`) is activated when `policy.stream.markupHealingPattern` is configured. It inspects streamed text for XML/markdown-wrapped tool calls (e.g. DSML leaks), parses completed tool calls, emits `toolcall_start`/`toolcall_delta`/`toolcall_end` events, and promotes `stop` finish reasons to `toolUse`.
- **Demoted Thinking & Cumulative Reasoning**: `renderDemotedThinking` (`packages/ai/src/dialect/demotion.ts`) handles demoted thinking blocks (`isDemotedThinking`). `lastCumulativeReasoningBySignature` tracks cumulative reasoning streams (e.g., MiniMax-M3) across text block transitions to prevent re-emitting thinking text as duplicate blocks after visible text has started.
- **Watchdogs & Terminal Grace Window**: `iterateWithIdleTimeout` (`packages/ai/src/utils/idle-iterator.ts`) monitors stream activity using `getOpenAIStreamFirstEventTimeoutMs` and `getOpenAIStreamIdleTimeoutMs`, injecting `X-Stainless-Timeout` headers downstream. On stream finish, `iterateWithTerminalGrace` enforces a 2,500ms post-finish grace window (`OPENAI_COMPLETIONS_POST_FINISH_GRACE_MS`) allowing trailing usage-only chunks (`stream_options.include_usage`) with cache-read token details (`awaitTrailingUsageDetails`) to arrive before closing the stream.
- **Usage Chunk Parsing**: `parseChunkUsage` and `applyUsagePayload` in `packages/ai/src/providers/openai-completions.ts` process token usage from `chunk.usage` or `choice.usage`. Fields extracted include `prompt_tokens_details.cached_tokens`, `prompt_cache_hit_tokens`, `prompt_cache_miss_tokens`, `completion_tokens_details.reasoning_tokens`, `cache_write_tokens`, and provider-reported costs via `applyProviderReportedCost` (`packages/ai/src/providers/openai-shared.ts`).

### Auth & usage
- **API-Key Validation**: `validateOpenAICompatibleApiKey` in `packages/ai/src/registry/api-key-validation.ts` validates API credentials by issuing a lightweight `POST /chat/completions` request with `messages: [{ role: "user", content: "ping" }]`, `max_tokens: 1`, `temperature: 0`, and `Authorization: Bearer ${apiKey}`.
- **Credential Resolution & Env Vars**: `getEnvApiKey` in `packages/ai/src/stream.ts` resolves provider-specific environment variables for OpenAI-compatible providers: `OPENAI_API_KEY`, `GROQ_API_KEY`, `CEREBRAS_API_KEY`, `MISTRAL_API_KEY`, `DEEPSEEK_API_KEY`, `FIREWORKS_API_KEY`, `OPENROUTER_API_KEY`, `TOGETHER_API_KEY`, `SAMBANOVA_API_KEY`, `NEBIUS_API_KEY`, `NOVITA_API_KEY`, `AVALAI_API_KEY`, `CHUTES_API_KEY`, `NANOGPT_API_KEY`, `HYPERBOLIC_API_KEY`, `PERPLEXITY_API_KEY`, `XAI_API_KEY`, and `AZURE_OPENAI_API_KEY`.
- **Usage Accounting & Quota Surfacing**: `calculateOpenAIUsageAccounting` (`packages/ai/src/providers/openai-shared.ts`) reconciles input, output, cache-read, and cache-write tokens into standard `Usage` records. OpenRouter and ClinePass authoritative gateway charges are populated into `output.usage.cost` via `applyProviderReportedCost`. Copilot request counts are stored in `output.usage.premiumRequests`. Transport HTTP errors (e.g. 429 Rate Limit, 408 Timeout, 5xx Server Error) are thrown as `OpenAIHttpError` (`packages/ai/src/utils/openai-http.ts`), capturing status, headers, and error envelope details for upstream error mapping in `AIError.finalize`.

### Catalog model handling
- **Provider Descriptors**: `CATALOG_PROVIDERS` in `packages/catalog/src/provider-models/descriptors.ts` registers all catalog entries using this transport (e.g., `openai`, `groq`, `cerebras`, `mistral`, `deepseek`, `fireworks`, `openrouter`), specifying `api: "openai-completions"`, `defaultModel`, environment variable keys, and documentation URLs.
- **Model Resolvers & Managers**: `createOpenAICompatibleModelManagerOptions` in `packages/catalog/src/provider-models/openai-compat.ts` constructs model managers for `openai-completions` providers. It combines static/curated model definitions, bundled reference specs (`getBundledModels`), and live models fetched from remote catalog endpoints.
- **Catalog Discovery**: `fetchOpenAICompatibleModels` in `packages/catalog/src/discovery/openai-compatible.ts` queries provider `/models` endpoints. It safely parses envelopes (`data`, `models`, `result`, `items`), enforces request timeouts using `withOpenAICompatibleDiscoveryTimeout`, validates model record schemas (`openAICompatibleModelRecordSchema`), applies custom mappers/filters, and deduplicates models by ID.
- **Identity & Classification**: `parseKnownModel` and `parseOpenAIModel` in `packages/catalog/src/identity/classify.ts` extract model families, variants (`base`, `codex`, `mini`, `max`, `nano`), and SemVer versions (`parseSemVer`) for OpenAI models matching `gpt-(\d+(?:\.\d+){0,2})(?:-(...))?`. Version comparison utilities (`semverGte`, `semverEqual`) drive capabilities detection across GPT-4, GPT-4o, and GPT-5 families.
- **Thinking Metadata & Effort Ladders**: `resolveModelThinking` and `deriveThinking` in `packages/catalog/src/model-thinking.ts` construct thinking metadata (`ThinkingConfig`) and map model identity/compat settings to effort ladders:
  - `DEFAULT_REASONING_EFFORTS`: `[minimal, low, medium, high]`
  - `DEFAULT_REASONING_EFFORTS_WITH_XHIGH`: `[minimal, low, medium, high, xhigh]` (e.g., OpenRouter GLM-5.2)
  - `GPT_5_2_PLUS_EFFORTS`: `[low, medium, high, xhigh]`
  - `FIVE_TIER_EFFORTS_LOW_TO_MAX`: `[low, medium, high, xhigh, max]` (GPT-5.6+ wire effort models, Fire Pass Kimi router)
  - `LOW_HIGH_MAX_REASONING_EFFORTS`: `[low, high, max]` (Kimi K3, DeepSeek V4 Flash)
  - `HIGH_MAX_REASONING_EFFORTS`: `[high, max]` (GLM-5.2 on Z.ai/Umans/Baseten, DeepSeek V4 Pro)
  - `HIGH_ONLY_REASONING_EFFORTS`: `[high]` (OpenRouter DeepSeek)
  - `OLLAMA_REASONING_EFFORTS`: `[low, medium, high, max]` (Ollama endpoints)

## OpenAI Responses
The OpenAI Responses provider (`packages/ai/src/providers/openai-responses.ts`) handles OpenAI's stateful `/v1/responses` HTTP Server-Sent Events (SSE) streaming wire protocol (types defined in `openai-responses-wire.ts`, shared encoding and decoding logic in `openai-shared.ts`). Unlike chat completions, the Responses API operates on a structured item sequence (`ResponseInput`) containing typed input/output items (`input_text`, `input_image`, `input_file`, `message`, `function_call`, `custom_tool_call`, `computer_call`, `reasoning`), supports server-side context chaining via `previous_response_id`, explicit prompt-cache breakpoints, and native reasoning summaries and encrypted content blocks.

### Special casings
- **Responses input-item model vs chat messages**: `buildResponsesInput` in `openai-shared.ts` converts standard conversation contexts into the `ResponseInput` array (`ResponseInputItem[]`). System instructions use top-level `instructions` by default or developer-role items (`{ role: "developer" }`) when `policy.messages.systemRole === "developer"` (required for reasoning models). Replayed history strips or retains reasoning items based on `filterReasoningHistory`, while Harmony dialect models (GPT-5+) escape reserved control token spellings in replayed transport data via `escapeReplayedControlTokens`.
- **`previous_response_id` chaining & stale-chain reset**: `buildOpenAIResponsesChainedParams` in `openai-responses.ts` manages stateful turns. When `statefulResponses` is active (default ON for official OpenAI endpoints via `PI_OPENAI_STATEFUL` flag and `hostMatchesUrl`), requests force `store: true` and calculate a delta payload (`buildResponsesDeltaInput`) anchored to `previous_response_id`. If history mutates, options change, or prompt-cache breakpoint policy alters, the chain resets to a full replay (`resetOpenAIResponsesChainState`). If the endpoint returns a stale ID error (`isOpenAIResponsesStalePreviousResponseError`), the provider increments `staleFailures` and falls back to a full transcript replay; after `OPENAI_RESPONSES_CHAIN_STALE_FAILURE_LIMIT` (3) consecutive failures, chaining is disabled for the session. Zero Data Retention (ZDR) org errors (`markOpenAIResponsesChainZeroDataRetention`) immediately disable chaining for the session and force `store: false`.
- **Encrypted reasoning items & summaries**: Supports `include: ["reasoning.encrypted_content"]` via `policy.reasoning.includeEncryptedReasoning`. `ResponseReasoningItem` objects contain encrypted content payloads, reasoning text deltas (`response.reasoning_text.delta`), and summary text deltas (`response.reasoning_summary_text.delta`). Thinking signatures carrying serialized JSON are parsed via `parseResponseReasoningReplayItem` and replayed as native `reasoning` items when `filterReasoningHistory` is false.
- **Composite `callId|itemId` tool IDs**: `normalizeResponsesToolCallId` in `packages/ai/src/utils.ts` handles tool call ID normalization. Tool call identifiers in Responses are composite strings formatted as `${callId}|${itemId}`. The function splits incoming IDs on `|` into distinct `callId` (truncated to 64 chars with `call_` prefix) and `itemId` (prefixed with `fc_` or `ctc_`). When an un-synthesized ID is passed, it generates a hash-based pair (`call_<hash>` and `fc_<hash>` / `ctc_<hash>`). Transformed messages use `normalizeResponsesToolCallIdForTransform` to preserve alignment across tool calls and tool result messages.
- **Custom (freeform) tools & computer tools**: Tool conversion in `convertTools` handles function, custom, and computer tools. When `model.applyPatchToolType === "freeform"` (checked via `supportsFreeformApplyPatch`), custom format tools (like `apply_patch`) are encoded as `type: "custom"` with grammar definitions (`compactGrammarDefinition`). When `model.supportsComputerUse === true`, native computer tools (`type: "computer"`) emit `computer_call` and `computer_call_output` items using structured `ComputerAction` lists; models without native computer support fall back to regular function tools. Tool schemas are sanitized via `sanitizeSchemaForOpenAIResponses` and `adaptSchemaForStrict`, and schemas violating strict constraints are quarantined (`findStrictToolSchemaViolation`) to prevent invalid MCP schemas from failing entire requests.
- **Service tier & obfuscation opt-out**: `serviceTier` option is passed down to sampling params and reported in output usage via `processResponsesStream`. When `model.compat.supportsObfuscationOptOut` is true, sampling parameters include `stream_options: { include_obfuscation: false }`.
- **Image detail handling**: Image content conversion in `convertResponsesInputContent` and `appendResponsesToolResultMessages` respects `model.compat.supportsImageDetailOriginal`. When false, `"original"` image detail values are mapped to `"auto"` to prevent upstream rejection. The [provider compatibility reference](./provider-compat-reference.md) owns the multimodal tool-result encoding contract.

### Stream behavior
- **Stream event protocol (`response.*` lifecycle)**: `processResponsesStream` in `openai-shared.ts` processes SSE events emitted by `/v1/responses`. Handles lifecycle events including `response.created`, `response.output_item.added`, `response.output_text.delta`, `response.reasoning_text.delta`, `response.reasoning_summary_text.delta`, `response.function_call_arguments.delta`, `response.custom_tool_call_input.delta`, `response.output_item.done`, `response.completed`, and `response.done`. Interleaved parallel tool calls are tracked concurrently across `output_index`, `item_id`, and prefixed call ID lookup maps (`openItemsByOutputIndex`, `openItemsByItemId`, `openItemsByPrefixedCallId`).
- **Watchdogs & transient retries**: `streamOpenAIResponsesOnce` uses `iterateWithIdleTimeout` with two timeout thresholds: `streamFirstEventTimeoutMs` (with `X-Stainless-Timeout` request header) for initial response headers/events and `streamIdleTimeoutMs` for inter-event stalls. If a stream terminates prematurely before emitting replay-unsafe output (`isOpenAIResponsesReplayUnsafeEvent`), the single-attempt streamer performs a transient retry (`OPENAI_RESPONSES_MAX_TRANSIENT_STREAM_RETRIES = 1`) after a delay (`OPENAI_RESPONSES_TRANSIENT_STREAM_RETRY_DELAY_MS = 500ms`). The public `streamOpenAIResponses` wraps execution with `withReplaySafeStreamRetry` to retry empty completions.

### Auth & usage
- Standard OpenAI auth relies on `OPENAI_API_KEY` (or provider-specific environment variables) resolved via `getEnvApiKey` and `resolveOpenAIRequestSetup` in `openai-shared.ts`. Requests pass standard Bearer token authorization headers (`Authorization: Bearer <key>`) alongside optional Stainless/Copilot headers. *(Note: `openai-codex` / ChatGPT subscription plan OAuth auth is handled separately).*

### Catalog model handling
- **`gpt-5+` identity classification**: Models in the `gpt-5` family are identified via `isOpenAIWireGen5Plus` and `isOpenAIWireGen54Plus` in `packages/catalog/src/identity/family.ts`. `gpt-5+` models reject legacy sampling parameters (such as `temperature`, `top_p`, `frequency_penalty`) with HTTP 400 errors across serving hosts, which `buildOpenAICompat` / `buildOpenAIResponsesCompat` account for via `supportsReasoningParams`.
- **Prompt-cache breakpoints (`supportsOfficialOpenAIPromptCacheBreakpoints`)**: Evaluated in `packages/catalog/src/compat/openai.ts`. `supportsOfficialOpenAIPromptCacheBreakpoints` returns true for official OpenAI endpoints serving models with version >= 5.6. When enabled and `promptCache.mode === "explicit"`, `markLatestStableResponsesCacheBreakpoint` in `openai-responses.ts` injects `{ mode: "explicit" }` `prompt_cache_breakpoint` annotations onto the latest stable developer/user message block, while preserving stateful baseline breakpoints.
- **Reasoning summary config & effort ladders**: `buildParams` applies reasoning parameters via `applyResponsesCompatPolicy`. Effort parameters map through model-specific maps (`reasoningEffortMap` or `thinking.effortMap`). For `gpt-5.6+` models and 5-tier effort scales (including `xhigh` and `max`), `model-thinking.ts` configures effort ladders (`minimal`, `low`, `medium`, `high`, `xhigh`, `max`), mapping `xhigh` and `max` 1:1 or shifting per host dialect (e.g. `KIMI_K3_REASONING_EFFORT_MAP`, `MIMO_REASONING_EFFORT_MAP`). Generated pro aliases (`gpt-5.6-*-pro`) automatically attach `reasoningMode: "pro"`.

## OpenAI Codex
The OpenAI Codex provider integrates ChatGPT Plus/Pro subscription models using the OpenAI Responses API surface over SSE or WebSocket transport. Requests target the ChatGPT backend (`https://chatgpt.com/backend-api/codex/responses` or custom base URL) using ChatGPT OAuth tokens with account-level isolation. Entry modules include streaming in `packages/ai/src/providers/openai-codex-responses.ts`, request transformation in `packages/ai/src/providers/openai-codex/request-transformer.ts`, error and rate-limit parsing in `packages/ai/src/providers/openai-codex/response-handler.ts`, quota and usage tracking in `packages/ai/src/usage/openai-codex.ts`, reset management in `packages/ai/src/usage/openai-codex-reset.ts`, base URL normalization in `packages/ai/src/usage/openai-codex-base-url.ts`, provider registry in `packages/ai/src/registry/openai-codex.ts`, and OAuth login flow in `packages/ai/src/registry/oauth/openai-codex.ts`.

### Special casings
- **WebSocket vs SSE dual transport**: Supports WebSocket streaming (`v2StreamingEnabled: true`, header `OpenAI-Beta: responses_websockets=2026-02-06`, `preferWebsockets` option) via `CodexWebSocketConnection` in `packages/ai/src/providers/openai-codex-responses.ts`. Reuses sockets with a max idle reuse cap (`CODEX_WEBSOCKET_MAX_IDLE_REUSE_MS` = 30s), ping/pong heartbeats (10s interval, 60s timeout), and queue capacity (4096). Instantly falls back to SSE on connection/handshake failures (`CODEX_WEBSOCKET_FATAL_PATTERNS`, `CodexWebSocketTransportError`).
- **Sampling parameter stripping**: Sampling parameters (`temperature`, `top_p`, `top_k`, `min_p`, `presence_penalty`, `repetition_penalty`, `frequency_penalty`, `stop`) are stripped in `packages/ai/src/providers/openai-codex/request-transformer.ts` `transformRequestBody`; the Codex backend returns HTTP 400 `Unsupported parameter` if any sampling parameters are sent (#3117).
- **Responses Lite transport**: Enabled via catalog (`useResponsesLite`), request option (`responsesLite`), or `PI_CODEX_RESPONSES_LITE` env (`resolveCodexResponsesLite`). Function `applyCodexResponsesLiteShape` embeds declared tools into a leading `additional_tools` developer item, system instructions into a developer message, strips image `detail`, turns off parallel tool calls, forces `reasoning.context: "all_turns"`, and appends `x-openai-internal-codex-responses-lite: true` header (or `ws_request_header_x_openai_internal_codex_responses_lite` in WS `client_metadata`). Hosted tool choices (`tool_choice`) fall back to `"auto"` if no matching declared tool is present (#5771).
- **Tool call/output pair repair**: `repairToolCallPairs` in `request-transformer.ts` rewrites orphaned `function_call_output`/`custom_tool_call_output` lacking prior calls into assistant messages (`[Previous tool result; call_id=...]`), and injects synthetic outputs (`[No tool output recorded...]`) for orphaned calls missing outputs, preventing backend HTTP 400 validation failures.
- **Session affinity & headers**: Emits session headers including `session_id`, `session-id`, `x-codex-installation-id`, `x-codex-window-id`, `x-codex-turn-metadata` (JSON containing `turn_id`, `installation_id`, `parent_turn_id`, `request_kind`), `x-codex-parent-thread-id`, and `x-openai-subagent` defined in `packages/catalog/src/wire/codex.ts` and `openai-codex-responses.ts`.
- **Attestation & compression**: Consults process-wide DeviceCheck attestation hook `setCodexAttestationProvider` for `x-oai-attestation` header (`getCodexAttestationHeader`). Compresses request body payloads with zstd (`compressCodexRequestBody`) for official origins when `PI_CODEX_ZSTD` is active.
- **Region-pinned workspace residency**: Enterprise ChatGPT workspaces can be pinned to a data-residency region, and reject any Codex request whose egress region differs — HTTP 401 `Workspace is not authorized in this region.` — unless the client declares the workspace residency itself. Codex request builders read it from the OAuth access token (`getCodexResidency` in `packages/catalog/src/wire/codex.ts`, claim `chatgpt_data_residency` with `chatgpt_compute_residency` as fallback) and send `x-openai-internal-codex-residency` on chat SSE and WebSocket transports, web search, remote compaction, and `generate_image`. Accounts without the claim (personal ChatGPT, opaque proxy keys that are not JWTs) send no header, and a caller-supplied header of the same name is never overwritten.
- **Harmony control token escaping**: Sanitizes replayed input text with `escapeHarmonyControlTokens` for models operating on the Harmony dialect (`isHarmonyDialectModel`).

### Stream behavior
- **Event protocol**: Parses SSE JSON payloads or WebSocket frames (`response`, `sequence_number`, `type`). Fires progress events (`isOpenAIResponsesProgressEvent`, `CODEX_ADDITIONAL_PROGRESS_EVENT_TYPES` such as `response.done` and `response.incomplete`).
- **Timeout watchdogs**: Enforces `CODEX_WEBSOCKET_FIRST_EVENT_TIMEOUT_MS` (300s) for first event, `CODEX_WEBSOCKET_IDLE_TIMEOUT_MS` (300s) for steady-state stream idle cap, and `iterateWithIdleTimeout` for SSE streams.
- **Stale history recovery**: Re-streams/replays on stale `previous_response_id` errors (`CODEX_STALE_PREVIOUS_RESPONSE_CODES`) by clearing the invalid chained response pointer and retrying.
- **Retry budget & rate limits**: Up to `CODEX_MAX_RETRIES` (5) retries on transient errors (`model_error`, `server_error`, `internal_error`, or `CODEX_RETRYABLE_EVENT_MESSAGE`). Handles HTTP 429 backoff with server retry delays within a 5-minute budget (`CODEX_RATE_LIMIT_BUDGET_MS`).
- **Whitespace loop defense**: Detects infinite whitespace tool call argument deltas (`CODEX_WHITESPACE_TOOL_CALL_ARGUMENT_DELTA_EVENT_LIMIT` = 256, 16KB limit), interrupting execution with `CodexWhitespaceToolCallLoopError` and attempting up to 2 retries (`CODEX_WHITESPACE_LOOP_RETRY_LIMIT`).
- **Concurrent reasoning summaries**: Request body includes `stream_options: { reasoning_summary_delivery: "sequential_cutoff" }` when reasoning summaries are requested (`supportsCodexReasoningSummary`), enabling output text streaming before summary completion.

### Auth & usage
- **OAuth login flows**: Implements ChatGPT OAuth in `packages/ai/src/registry/oauth/openai-codex.ts`. Browser flow uses PKCE S256 (`createOpenAICodexAuthorizationUrl`) with fixed local port 1455 (`http://localhost:1455/auth/callback`), client ID `app_EMoamEEZ73f0CkXaXp7hrann`, and simplified CLI flow flags. Headless device-code flow (`loginOpenAICodexDevice`) uses `https://auth.openai.com/api/accounts/deviceauth/usercode` and polls `deviceauth/token`.
- **Token refresh & claims**: `refreshOpenAICodexToken` posts `grant_type: refresh_token` to `https://auth.openai.com/oauth/token`. Extracts `chatgpt_account_id` and user `email` from JWT claims (`https://api.openai.com/auth` and `https://api.openai.com/profile` in `getTokenProfile`).
- **Account rotation & rate-limit ranking**: Account identity is set via `ChatGPT-Account-Id` header (`getCodexAccountId`). `codexRankingStrategy` in `packages/ai/src/usage/openai-codex.ts` isolates standard chat limits (5h primary, 7d secondary) from Spark meter limits (`-spark` model suffix spends `spark` scope), preventing Spark exhaustion from blocking normal chat requests.
- **Usage tracking**: `openaiCodexUsageProvider` queries `/wham/usage` on canonical ChatGPT origins. Parses `primary_window` (5h) and `secondary_window` (7d), plus `additional_rate_limits` (Spark/extra meters). Ingests response headers (`x-codex-primary-used-percent`, `x-codex-primary-window-minutes`, `x-codex-primary-reset-at`, `x-codex-secondary-*`) in `parseCodexRateLimitHeaders` (`response-handler.ts` `parseCodexError`).
- **Saved rate limit reset credits**: Reads `rate_limit_reset_credits` from `/wham/usage`. Lists available credits with `listCodexResetCredits` (`GET /wham/rate-limit-reset-credits`), selects soonest-expiring credit with `pickSoonestExpiringCredit`, and redeems via `consumeCodexResetCredit` (`POST /wham/rate-limit-reset-credits/consume` with client UUID `redeem_request_id`).
- **Base URL normalization**: `normalizeCodexBaseUrl` in `packages/ai/src/usage/openai-codex-base-url.ts` forces account API requests (`wham/usage`, reset credits) to canonical `chatgpt.com` or `chat.openai.com` origins (`/backend-api`), ignoring custom proxy overrides (`providers.openai-codex.baseUrl`) that would 404. Stream URLs resolve via `resolveCodexResponsesUrl` in `openai-codex-responses.ts`.

### Catalog model handling
- **Descriptor & management**: Defined as `openai-codex` provider descriptor in `packages/catalog/src/provider-models/descriptors.ts` (default model `"gpt-5.5"`). Configured in `packages/catalog/src/provider-models/special.ts` `createOpenAICodexModelManagerOptions` as a special-managed provider with dynamic model discovery.
- **Dynamic discovery**: `fetchCodexModels` in `packages/catalog/src/discovery/codex.ts` queries `/codex/models` or `/models` with `v2StreamingEnabled: true`, parsing `reasoning_presets` (`effort`, `summary`) into `ModelSpec<"openai-codex-responses">`.
- **Identity & classification**: `OpenAIVariant` in `packages/catalog/src/identity/classify.ts` supports `"codex"`, `"codex-max"`, `"codex-mini"`, `"codex-spark"`. `parseOpenAIModel` matches `gpt-X.Y-(codex-spark|codex-mini|codex-max|codex|mini|max|nano)`. Priority list in `packages/catalog/src/identity/priority.ts` ranks `openai-codex` above generic provider fallbacks.
- **Thinking & effort limits**: `packages/catalog/src/model-thinking.ts` maps supported efforts (`minimal`, `low`, `medium`, `high`, `xhigh`, `max`), pinpoints model-specific tiers (e.g. `GPT_5_1_CODEX_MINI_EFFORTS`), and checks `supportsAllTurnsReasoningContext` and `supportsCodexReasoningSummary` in `identity/family.ts`.
- **Pricing fallback**: `applyCodexPricingFallback` in `packages/catalog/scripts/generate-models.ts` copies billable costs from `openai` provider entries with matching model IDs when Codex discovery models lack explicit cost metadata.

## Azure OpenAI
Azure OpenAI Responses provider (`azure-openai-responses`) handles transport, endpoint resolution, and compatibility wrapping for OpenAI-family models (GPT-4/4.1/4o, GPT-5 series, o-series, Codex) served over Azure OpenAI's Responses API. It uses the internal `postOpenAIStream` transport (`packages/ai/src/utils/openai-http.ts`) to make JSON-POST / SSE requests. Stream generation is initialized in `streamAzureOpenAIResponses` (`packages/ai/src/providers/azure-openai-responses.ts`), while shared Responses input/output processing logic lives in `packages/ai/src/providers/openai-shared.ts`.

### Special casings
- **Deployment-name mapping**: Azure OpenAI requires deployment names in request payloads. `resolveDeploymentName` (`packages/ai/src/providers/azure-openai-responses.ts`) checks `options.azureDeploymentName`, then checks the `AZURE_OPENAI_DEPLOYMENT_NAME_MAP` environment variable (parsed by `parseAzureDeploymentNameMap` in `openai-shared.ts` into a map of `modelId=deploymentName` pairs, e.g. `gpt-5-mini=my-mini-dep,o3=my-o3-dep`), and defaults to `model.id`.
- **Base-URL / resource resolution**: `resolveAzureConfig` (`packages/ai/src/providers/azure-openai-responses.ts`) checks `options.azureBaseUrl` or `$env.AZURE_OPENAI_BASE_URL`. If missing, it constructs `https://${resourceName}.openai.azure.com/openai/v1` from `options.azureResourceName` or `$env.AZURE_OPENAI_RESOURCE_NAME`. If still missing, it falls back to `model.baseUrl`, throwing `AIError.ConfigurationError` if no endpoint is found. Trailing slashes are stripped.
- **API-version handling**: `resolveAzureConfig` resolves the API version from `options.azureApiVersion`, `$env.AZURE_OPENAI_API_VERSION`, or defaults to `"v1"`. It is passed as the `api-version` URL query parameter on the request (`${baseUrl}/responses?api-version=${apiVersion}`), not as an HTTP header.
- **Strict responses tool-pairing**: Enabled by default for Azure OpenAI models via `buildOpenAIResponsesCompat` (`packages/catalog/src/compat/openai.ts`, `isAzure = true`). In `buildResponsesInput` / `appendResponsesToolResultMessages` (`packages/ai/src/providers/openai-shared.ts`), unpaired tool outputs (results whose `callId` was not emitted by a prior assistant `function_call` item) are rejected by Azure's strict backend. Omp folds orphan tool results into synthetic assistant note messages (`[Orphan <tool> result; call_id=<id>]: <text>` up to 16,000 characters, or `[Orphan computer result; call_id=<id>]`) rather than sending un-paired output items.
- **Image detail clamps**: In `appendResponsesToolResultMessages` / `convertResponsesInputContent`, `clampResponsesImageDetail` clamps `detail: "original"` to `"auto"` if `supportsImageDetailOriginal` is `false`. For Azure OpenAI, `supportsImageDetailOriginal` is `true` (unlike GitHub Copilot and xAI OAuth), preserving original image resolution.
- **Computer-tool fallback mapping**: `modelForAzureEndpoint` (`packages/ai/src/providers/azure-openai-responses.ts`) verifies that the resolved endpoint host ends with `.openai.azure.com` or `models.inference.ai.azure.com`. If routed through an unrecognized proxy, `supportsComputerUse` is disabled. In `buildParams`, if a tool has `native.type === "computer"` and `model.supportsComputerUse` is `true`, it is serialized as `{ type: "computer" }`. If `supportsComputerUse` is `false`, it falls back to serializing the computer tool as a standard `{ type: "function", name: tool.name, ... }` tool. `tool_choice` is automatically translated between `computer` and `function` targets.
- **Differences from plain Responses (`openai-responses`)**: Uses the `api-key` header (never `Authorization: Bearer`), uses a fixed endpoint path `${baseUrl}/responses?api-version=...` (the `/responses` path is non-deployment-scoped, unlike Chat Completions `/deployments/{dep}/chat/completions`), passes the deployment name inside the request body as `model`, performs dynamic runtime endpoint construction from env/options, and defaults `strictResponsesPairing` to `true`.

### Stream behavior
- **Event processing**: Uses `processResponsesStream` in `packages/ai/src/providers/openai-shared.ts` to consume SSE stream events (`response.created`, `response.output_item.added`, `response.content_part.added`, `response.output_text.delta`, `response.completed`, `response.incomplete`). Terminal `response.incomplete` events (output-token truncation) update usage counters and set `stopReason: "length"`.
- **Idle & first-event watchdogs**: Wrapped with `iterateWithIdleTimeout`. If the first SSE event does not arrive within `streamFirstEventTimeoutMs`, aborts with `"Azure OpenAI responses stream timed out while waiting for the first event"`.
- **Untyped SSE payload resolution**: `onSseEvent` inspects untyped JSON event data (`type` or `object` properties) to attach the event type tag when missing from standard SSE header lines.
- **Reasoning effort fallback**: Catches `OpenAIHttpError` during stream initiation. If the endpoint rejects the requested reasoning effort (e.g. `xhigh`), `resolveOpenAIReasoningEffortFallback` determines a lower effort level, steps down `params.reasoning`, and retries the request using `createOpenAIReasoningEffortFallbackKey("azure-responses", url, model)`.

### Auth & usage
- **Credential source**: Sourced from `options.apiKey` or `$env.AZURE_OPENAI_API_KEY` (retrieved via `getEnvApiKey(model.provider)` in `packages/ai/src/stream.ts` or `buildAzureResponsesRequest`). Sent as the `api-key` header.
- **Usage tracking**: Extracted directly from terminal `response.completed` / `response.incomplete` stream events (`input_tokens`, `output_tokens`, `reasoning_tokens`, `cached_tokens`) by `processResponsesStream`. No separate usage tracker exists under `packages/ai/src/usage/`.
- **Prompt caching controls**: `prompt_cache_key` is generated via `getOpenAIPromptCacheKey(options)`. Explicit prompt caching mode is rejected (`AIError.ConfigurationError`) because Azure Responses does not support explicit cache control headers or retention directives.

### Catalog model handling
- **Descriptors**: Catalog provider defined in `packages/catalog/src/provider-models/descriptors.ts` (`id: "azure"`, `defaultModel: "gpt-5.5"`, `envVars: ["AZURE_OPENAI_API_KEY"]`). In `packages/catalog/src/provider-models/openai-compat.ts`, mapped via `simpleModelsDevDescriptor("azure", "azure", "azure-openai-responses", "", ...)` which filters stencil catalog models to tool-capable OpenAI-family IDs (`gpt-`, `o1`, `o3`, `o4`, `codex`, `chatgpt`), dropping third-party Foundry models (Claude, DeepSeek, Llama, Mistral, Phi).
- **Why bundled models carry no `baseUrl`**: Azure OpenAI endpoints are resource-specific and unknown during catalog generation (`models.json` stores `baseUrl: ""`). Runtime resolution resolves endpoints from `AZURE_OPENAI_BASE_URL` or `AZURE_OPENAI_RESOURCE_NAME`. Compat detection (`isAzure` in `packages/catalog/src/compat/openai.ts`) matches `provider === "azure"`, ensuring bundled models with empty `baseUrl` still receive Azure compat flags (`strictResponsesPairing`, `supportsDeveloperRole`, `supportsStrictMode`).
- **Identity & classification**: `hosts.ts` defines `azureOpenAI` matching `provider: "azure"` or hostnames ending with `.openai.azure.com`, `azure.com/openai`, or `models.inference.ai.azure.com`.
- **Thinking metadata**: In `packages/catalog/src/model-thinking.ts`, Azure reasoning models (o-series, GPT-5, Codex) resolve discrete OpenAI reasoning effort tiers (`minimal`, `low`, `medium`, `high`, `xhigh`, `max`) via `DEFAULT_REASONING_EFFORTS_WITH_XHIGH`.

## Anthropic Messages
The Anthropic provider (`packages/ai/src/providers/anthropic.ts`) implements the Anthropic Messages API protocol over HTTPS POST to `/v1/messages` (or `/v1/messages?beta=true`) using Server-Sent Events (SSE) for streaming. Custom HTTP client transport is provided by `AnthropicMessagesClient` (`packages/ai/src/providers/anthropic-client.ts`), replacing `@anthropic-ai/sdk` with built-in retry and timeout logic. Wire structures and SSE payloads are typed in `packages/ai/src/providers/anthropic-wire.ts`. Client fingerprinting constants (version, user agent, tool prefix) live in `packages/ai/src/providers/claude-code-fingerprint.ts`, while low-level Node HTTPS socket reuse and header ordering are handled by `coworkFetch` (`packages/ai/src/providers/cowork-fetch.ts`).

### Special casings
- **OAuth vs API Key Paths**: `buildAnthropicHeaders` (`packages/ai/src/providers/anthropic.ts`) checks `options.isOAuth ?? isAnthropicOAuthToken(apiKey)`. OAuth requests send `Authorization: Bearer <token>` without `X-Api-Key`, default `Accept: application/json` (or `text/event-stream`), and inject Cowork desktop beta flags (`buildCoworkBetas`). API key requests send `X-Api-Key: <key>` without `Authorization` and include only caller extra betas. Non-official endpoints allow header overrides when `allowAnthropicHeaderOverrides` is enabled.
- **Claude Code Fingerprint Headers & Betas**: Default headers include `anthropic-version: 2023-06-01`, `anthropic-dangerous-direct-browser-access: true`, `x-app: cli`, and `User-Agent: claude-cli/2.1.220 (external, claude-desktop)` (`coworkUserAgent`). Active beta flags (`buildCoworkBetas`) include `claude-code-20250219`, `interleaved-thinking-2025-05-14`, `thinking-token-count-2026-05-13`, `context-management-2025-06-27`, `prompt-caching-scope-2026-01-05`, `mid-conversation-system-2026-04-07`, `advanced-tool-use-2025-11-20`, `effort-2025-11-24`, and `fallback-credit-2026-06-01` (`context-1m-2025-08-07` is omitted to avoid 429 credit errors on subscription tokens, #7238). Fingerprint metadata (`generateClaudeCloakingUserId`, `deriveClaudeDeviceId`, `generateClaudeJsonUserId`) generates device/session IDs. Billing attestation headers (`createClaudeBillingHeader`, `wrapFetchForCch`, `patchCch`) embed `cch=00000` XXHash64 hashes into `system[0]`.
- **System-Prompt Injection**: `buildAnthropicSystemBlocks` (`packages/ai/src/providers/anthropic.ts`) automatically prepends `claudeCodeSystemInstruction` ("You are a Claude agent, built on Anthropic's Claude Agent SDK.") as `system[0]` for OAuth credentials. Mid-conversation system messages in turn history are enabled for Opus 4.8+ / Sonnet 5+ via `mid-conversation-system-2026-04-07`.
- **Thinking Signatures & Redacted Thinking**: Replaying modified or unsigned thinking blocks causes Anthropic API errors (`invalid signature in thinking block`). `convertAnthropicMessages` converts `ThinkingContent` and `RedactedThinkingContent` (`type: "redacted_thinking"`, `data`). `maybeAddReplayUnsignedThinkingHint` attaches recovery hints on signature errors, while `unwrapAnthropicThinkingEnvelope` strips legacy `<thinking>` XML wrappers.
- **Tool Use Replay & Prefixes**: `encodeAnthropicToolName` / `decodeAnthropicToolName` (`packages/ai/src/providers/anthropic.ts`) prefixes custom tool names with `_` (`claudeToolPrefix`) when using OAuth to prevent collisions with built-in tools (`web_search`, `code_execution`, `text_editor`, `computer`). Server-executed web searches and tool searches (`AnthropicServerToolHistoryBlockParam` in `anthropic-wire.ts`) are detected via `isAnthropicServerToolHistoryBlock` for turn replay. Empty tool errors are filled by `ensureErrorToolResultWireContent`.
- **Strict-Tool Schema Normalization & Fallback**: `normalizeAnthropicToolSchema` and `normalizeAnthropicStrictSchema` strip unsupported JSON schema keywords (e.g. `minItems`/`maxItems` on objects) for the `structured-outputs-2025-12-15` beta. If a strict tool schema causes HTTP 400, `streamAnthropicOnce` calls `dropAnthropicStrictTools` and automatically retries without strict mode.
- **Adaptive vs Budget Thinking**: `ThinkingConfigParam` (`anthropic-wire.ts`) supports budget thinking (`{ type: "enabled", budget_tokens: N }` enforced by `ensureMaxTokensForThinking`) and adaptive thinking (`{ type: "adaptive" }` paired with `output_config: { effort: level }` via `effort-2025-11-24` beta). Forced tool choices (`disableThinkingIfToolChoiceForced`) automatically disable thinking.
- **Prompt Cache Breakpoints**: `applyPromptCaching` (`packages/ai/src/providers/anthropic.ts:3195`, called at `:3506`) marks a two-message rolling window at the tail of the conversation: it attaches `cache_control: { type: "ephemeral" }` (plus `ttl: "1h"` only for long retention on models that support it, built by `getCacheControl` at `:497`) to the last ordinary content block of each of the two trailing turns, skipping `thinking`, `redacted_thinking`, and `fallback` blocks (`applyCacheControlToLastBlock` at `:3179`). When the trailing user message is the neutral `"Continue."` pad appended after an assistant prefill, the window anchors on the preceding real assistant instead. Caching is never applied to system prompts or tool definitions, and there is no total-breakpoint cap.

### Stream behavior
- **Event Protocol**: SSE streams in `streamAnthropicOnce` (`packages/ai/src/providers/anthropic.ts`) emit standard framing events: `message_start` (delivering initial input and cache usage), `content_block_start` (initializing block types: text, thinking, tool_use, redacted_thinking, fallback), `content_block_delta` (streaming `text_delta`, `thinking_delta`, `signature_delta`, `input_json_delta`), `message_delta` (delivering `stop_reason` and final `output_tokens`), `content_block_stop`, `message_stop`, and `ping`.
- **Fine-Grained Tool Streaming**: Enabled via `fine-grained-tool-streaming-2025-05-14` beta. Incoming `input_json_delta` chunks accumulate in `kStreamingPartialJson`, parsed continuously by `parseStreamingJsonThrottled` to surface streaming tool arguments.
- **Stream Watchdogs & Healing**: Streams are monitored for stall timeouts using `getStreamFirstEventTimeoutMs` and `getStreamIdleTimeoutMs` inside `iterateWithIdleTimeout`. `ping` events (`ANTHROPIC_PING_EVENT`) reset idle timeout multipliers. Empty completion responses (0 tokens) trigger automatic retry via `withReplaySafeStreamRetry`. Fast mode (`speed: "fast"`) failures clear session fast mode state (`clearAnthropicFastModeFallback`, `dropAnthropicFastMode`) to fallback to standard execution.

### Auth & usage
- **OAuth Authentication & PKCE**: `AnthropicOAuthFlow` (`packages/ai/src/registry/oauth/anthropic.ts`) performs PKCE `S256` authentication against `https://claude.ai/oauth/authorize` and `https://api.anthropic.com/v1/oauth/token` using decoded Client ID (`OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl`). OAuth tokens carry an absolute grant TTL of 30 days (`ANTHROPIC_OAUTH_GRANT_TTL_MS` in `anthropic-constants.ts`), requiring monthly interactive re-login regardless of refresh token rotation. Account identity is resolved via `extractAccountFromTokenResponse` or `fetchBootstrapIdentity` (`/api/claude_cli/bootstrap`).
- **Quota Tracking & Account Rotation**: `packages/ai/src/usage/claude.ts` polls `https://api.anthropic.com/api/oauth/usage` to track rolling `five_hour`, `seven_day`, `limits[]` (`weekly_scoped`), and `anthropic-ratelimit-unified-*` headers. Errors matching `isUsageLimitOutcome` (`packages/ai/src/error/rate-limit.ts`) and `parseRateLimitReason` (`QUOTA_EXHAUSTED`) trigger automatic credential rotation.
- **Error Classification**: HTTP errors are categorized by `parseRateLimitReason` (`packages/ai/src/error/rate-limit.ts`) into `QUOTA_EXHAUSTED` (30m backoff / rotation), `RATE_LIMIT_EXCEEDED` (30s backoff), `CONCURRENT_LIMIT` (5s backoff), and `MODEL_CAPACITY_EXHAUSTED` (45s ± 15s backoff). Transient HTTP 408/409/429/5xx errors are retried by `AnthropicMessagesClient` (`packages/ai/src/providers/anthropic-client.ts`), respecting `retry-after-ms` / `retry-after` headers.

### Catalog model handling
- **Model Identity & Classification**: `isClaudeModelId` (`packages/catalog/src/identity/family.ts`) uses regex `/(^|[/.])claude[-.]/i` to identify bare, namespaced (`anthropic/claude-*`), and Bedrock (`us.anthropic.claude-*`) Claude models. `parseAnthropicModel` (`packages/catalog/src/identity/classify.ts`) parses model kind (Opus, Sonnet, Fable, Mythos), version, and variant. Feature checks include `anthropicModelSupportsThinking` (v>=3.7), `supportsAdaptiveThinkingDisplay` (v>=4.7), `supportsMidConversationSystemMessages` (v>=4.8), and `isAnthropicFableOrMythosModel`.
- **Provider Descriptor**: `CATALOG_PROVIDERS` (`packages/catalog/src/provider-models/descriptors.ts`) defines the Anthropic provider entry with `defaultModel: "claude-opus-4-8"`, `envVars: ["ANTHROPIC_API_KEY"]`, and model manager options `anthropicModelManagerOptions`.
- **Thinking Configuration**: `resolveModelThinking` (`packages/catalog/src/model-thinking.ts`) derives thinking capabilities. Modern adaptive models (Opus 4.7+, Sonnet 5+) use `FIVE_TIER_EFFORTS_LOW_TO_MAX` (`[low, medium, high, xhigh, max]`), while older adaptive models use `FOUR_TIER_EFFORTS_LOW_TO_MAX`. Effort levels map to Anthropic wire values via `mapEffortToAnthropicAdaptiveEffort`.
- **Pricing & Multipliers**: `COPILOT_PREMIUM_MULTIPLIERS` in `packages/catalog/scripts/generate-models.ts` assigns premium multipliers for GitHub Copilot Anthropic models (e.g. `claude-opus-4.6`: 3x, `claude-haiku-4.5`: 0.33x) during model catalog generation.

## Google Gemini
Google Gemini integrations use REST/SSE over HTTP (`POST https://generativelanguage.googleapis.com/v1beta/models/{model}:streamGenerateContent?alt=sse`). Core provider entry points are `packages/ai/src/providers/google.ts` (`streamGoogle`), `packages/ai/src/providers/google-shared.ts` (`streamGoogleGenAI`, `buildGoogleGenerateContentParams`, `convertMessages`, `consumeGoogleStream`), and `packages/ai/src/providers/google-types.ts`.

### Special casings
- **`generateContent` protocol**: System prompts are lifted into `{ systemInstruction: { parts: [{ text }] } }` in `buildGoogleGenerateContentParams`. Tools are formatted into `tools[].functionDeclarations` using `parametersJsonSchema` (sanitized via `normalizeSchemaForGoogle` in `packages/ai/src/utils/schema/normalize.ts`).
- **`thinkingConfig` mapping**: `buildGoogleGenerateContentParams` sets `includeThoughts: !options.hideThinkingSummary`. Gemini 3 models map `options.thinking.level` to `thinkingLevel` (`THINKING_LEVEL_UNSPECIFIED`, `MINIMAL`, `LOW`, `MEDIUM`, `HIGH`). Gemini 2.x models map `options.thinking.budgetTokens` to `thinkingBudget`. Cloud Code Assist providers (`google-gemini-cli.ts`) map `thinking.suppress` to explicit `includeThoughts: false` with level/budget when disabled (`suppressWhenOff`).
- **Function call ID synthesis & Vertex AI strip**: `nextToolCallId` in `google-shared.ts` generates unique IDs (`${name}_${Date.now()}_${++toolCallCounter}`) when IDs are missing or duplicate. `supportsFunctionPartId` enables `functionCall.id` / `functionResponse.id` propagation for `claude-` models or Gemini 3 models (`isGemini3Model`). `google-vertex` API rejects `id` fields in function parts, so `google-shared.ts` strips `part.functionCall.id` and `part.functionResponse.id` for Vertex requests.
- **Contiguous `functionResponse` rule**: Gemini requires parallel tool call results to reside in a single contiguous `user` role message. `convertMessages` in `google-shared.ts` inspects `lastContent` and merges `functionResponse` parts into existing `user` turns (`lastContent.parts.push(functionResponsePart)`).
- **Multimodal function responses by version**: Gemini 3+ models (`supportsMultimodalFunctionResponse` checked via `getGeminiMajorVersion >= 3`) support inline tool output images nested directly inside `functionResponse.parts`. Gemini < 3 models buffer tool images into `pendingToolImageParts` and flush them in a separate subsequent `user` text/image turn.
- **Safety settings & Prompt feedback**: Safety blocks in `PromptFeedback` (`blockReason`, `blockReasonMessage`) throw `AIError.ProviderResponseError` with `kind: "content-blocked"`. `FinishReason` values (`SAFETY`, `BLOCKLIST`, `PROHIBITED_CONTENT`, `SPII`, `IMAGE_SAFETY`, `RECITATION`, `MALFORMED_FUNCTION_CALL`, `UNEXPECTED_TOOL_CALL`, `NO_IMAGE`, `OTHER`) map to `stopReason: "error"` in `mapStopReason`.

### Stream behavior
- **`streamGenerateContent` SSE protocol**: Streams are consumed via `readSseJson<GenerateContentResponse>` in `streamGoogleGenAI`.
- **Thought parts & signature retention**: `isThinkingPart` identifies reasoning text when `part.thought === true`. Encrypted `part.thoughtSignature` fields are preserved across deltas using `retainThoughtSignature`. In `convertMessages`, thought signatures are retained only when message provider/model match the target (`msg.provider === model.provider && msg.model === model.id`) and pass `isValidThoughtSignature` (base64 check). For Gemini 3 tool calls lacking a valid signature, the public Gemini API emits the `skip_thought_signature_validator` bypass sentinel on every unsigned call. Cloud Code Assist / Antigravity emits it only when the first call of a turn is unsigned; signed-first parallel turns omit it from unsigned secondary calls. Vertex AI always omits the sentinel (#9638, #10602).
- **Empty response retry loop**: `streamGoogleGenAI` guards against Gemini returning `finishReason: STOP` with blank content without calling tools. `hasMeaningfulGoogleContent` validates output; if empty, `streamGoogleGenAI` retries up to `MAX_EMPTY_STREAM_RETRIES` (2 retries, 3 total attempts) with exponential backoff (`EMPTY_STREAM_BASE_DELAY_MS * 2^attempt`) after resetting stream output via `resetGoogleStreamOutputForRetry`.
- **Thinking loop guard**: Implemented in `packages/ai/src/utils/thinking-loop.ts` (`ThinkingLoopDetector`). Gemini, DeepSeek, and Grok model-id families are monitored before tool calls for three runaway shapes:
  1. *Verbatim tail repetition* (`EXACT_TAIL_WINDOW = 4096`, >= 180 repeated chars).
  2. *Near-duplicate segments* (trigram Jaccard similarity >= 0.8 across last 16 segments).
  3. *Progress-lexicon stall* (novelty <= 0.2 without new concrete reference anchors over 8 consecutive segments).
  4. Gemini's `GEMINI_HEADER_RUNAWAY_THRESHOLD = 24` halts streams emitting excessive titled reasoning summaries without acting. Triggers emit a synthetic retryable `error` tagged with `AIError.Flag.ThinkingLoop`.
- **Finish reason mapping & incomplete streams**: `candidate.finishReason` is mapped via `mapStopReason`; `stop`/`length` reasons upgrade to `toolUse` if output contains tool calls. Drops without `finishReason` throw `ProviderResponseError` with `kind: "incomplete-stream"`.
- **UsageMetadata accounting**: Attached to trailing chunks in `consumeGoogleStream`. `input` is calculated as `promptTokenCount - (cachedContentTokenCount || 0)`; `output` as `candidatesTokenCount + (thoughtsTokenCount || 0)`; `cacheRead` as `cachedContentTokenCount || 0`; and `reasoningTokens` as `thoughtsTokenCount`. Token costs are computed via `calculateCost(model, output.usage)`.

### Auth & usage
- **Credential source**: Directly authenticates via `x-goog-api-key: apiKey` header (or `GEMINI_API_KEY` environment variable retrieved via `getEnvApiKey(model.provider)` in `packages/ai/src/providers/google.ts`).
- **Usage tracker**: `googleGeminiCliUsageProvider` in `packages/ai/src/usage/gemini.ts` monitors OAuth-backed Cloud Code Assist usage by calling `POST /v1internal:loadCodeAssist` (for project resolution) and `POST /v1internal:retrieveUserQuota`. Quota buckets are mapped to tiers (`Flash`, `Pro`, `3-Flash`) with remaining fraction usage percentages and reset windows (`parseWindow`).

### Catalog model handling
- **Identity & classification**: `parseGeminiModel` in `packages/catalog/src/identity/classify.ts` parses model IDs matching `gemini-{version}-{kind}` (with optional `-preview` suffix), returning `GeminiModel` (`family: "gemini"`, `kind: "pro" | "flash"`, `version: SemVer`).
- **Thinking metadata & levels**: `packages/catalog/src/model-thinking.ts` configures thinking options using `ThinkingLevel` enum strings (`THINKING_LEVEL_UNSPECIFIED`, `MINIMAL`, `LOW`, `MEDIUM`, `HIGH`). Effort ladders are defined for Gemini 3 models: `GEMINI_3_PRO_EFFORTS` (`[low, high]`) and `GEMINI_3_FLASH_EFFORTS` (`[minimal, low, medium, high]`).
- **Descriptors & discovery**: Configured in `packages/catalog/src/provider-models/descriptors.ts` (`CATALOG_PROVIDERS` entry for `google`, default model `gemini-3.1-pro-preview`, `GEMINI_API_KEY`). Dynamic discovery in `packages/catalog/src/discovery/gemini.ts` (`fetchGeminiModels`) fetches `GET /v1beta/models?key=...`, filtering for `generateContent` methods and parsing `inputTokenLimit` and `outputTokenLimit`.
- **Pricing & Antigravity backfill**: Base prices are calculated via `calculateCost`. In `scripts/generated-policies.ts` and `scripts/generate-models.ts`, `google-antigravity` models report $0 list price upstream and are backfilled using `ANTIGRAVITY_PRICING_PEERS` (`["google", "google-vertex", "anthropic"]`), resolving Gemini aliases via `ANTIGRAVITY_PRICING_ID_ALIASES` (e.g. `gemini-3-flash` -> `gemini-3-flash-preview`).

## Google Vertex AI

The Google Vertex AI provider enables streaming generation for Gemini models hosted on Google Cloud Vertex AI as well as third-party models (such as Anthropic Claude) served via Vertex endpoints. Entry points include `streamGoogleVertex` in `packages/ai/src/providers/google-vertex.ts` for Gemini models (API type `"google-vertex"`), `streamAnthropic` via `createVertexAuthenticatedFetch` in `packages/ai/src/stream.ts` for Claude models (API type `"anthropic-messages"`), and ADC authentication in `packages/ai/src/providers/google-auth.ts`. Transport uses HTTPS REST / SSE with either Application Default Credentials (ADC OAuth Bearer tokens) or Vertex Express Mode API key (`x-goog-api-key`).

### Special casings
* **Endpoint & Project/Location Resolution**: In ADC mode (`packages/ai/src/providers/google-vertex.ts`), request URLs follow `https://${host}/v1/projects/${project}/locations/${location}/publishers/google/models/${model.id}:streamGenerateContent?alt=sse`. `project` is resolved from `options.project`, `$env.GOOGLE_CLOUD_PROJECT`, `$env.GCP_PROJECT`, or `$env.GCLOUD_PROJECT` (throws `ConfigurationError` if missing). `location` is resolved from `options.location`, `$env.GOOGLE_VERTEX_LOCATION`, `$env.GOOGLE_CLOUD_LOCATION`, or `$env.VERTEX_LOCATION` (throws `ConfigurationError` if missing). In Express Mode (API Key mode via `options.apiKey` or `$env.GOOGLE_CLOUD_API_KEY`), URL follows `https://${host}/v1/publishers/google/models/${model.id}:streamGenerateContent?alt=sse` with `x-goog-api-key` header and defaults `location` to `"global"` with global endpoint fallback if an ambient region host fails.
* **Endpoint Host Resolution**: `resolveVertexEndpointHost(location)` in `packages/catalog/src/hosts.ts` maps locations to hostnames: `"global"` → `aiplatform.googleapis.com`; multi-regions `"eu"` / `"us"` → `aiplatform.{location}.rep.googleapis.com` (preventing 404s from standard interpolation); regional (e.g. `"us-central1"`, `"europe-west4"`) → `${location}-aiplatform.googleapis.com`.
* **Function Call & Response ID Stripping**: `supportsFunctionPartId(model)` in `packages/ai/src/providers/google-shared.ts` returns `false` for `google-vertex`. `convertMessages` explicitly deletes `part.functionCall.id` and `functionResponsePart.functionResponse.id` before wire serialisation because Vertex AI returns `400 INVALID_ARGUMENT` when function parts contain an `id` field.
* **Safety Settings Defaults**: `streamGoogleVertex` in `packages/ai/src/providers/google-vertex.ts` automatically injects safety settings disabling all harm categories (`HARM_CATEGORY_HATE_SPEECH`, `HARM_CATEGORY_DANGEROUS_CONTENT`, `HARM_CATEGORY_SEXUALLY_EXPLICIT`, `HARM_CATEGORY_HARASSMENT` set to `threshold: "OFF"`) into `params.config.safetySettings` if unconfigured.
* **Service Tier Priority Header**: Direct `serviceTier` request-body fields are ignored by Vertex; `options.serviceTier === "priority"` is transmitted as the request header `X-Vertex-AI-LLM-Shared-Request-Type: priority` (`google-vertex.ts`). `flex` has no documented control and is a no-op.
* **Cached Content Passthrough**: Passes caller-supplied `cachedContent` resource names opaquely into `params.config.cachedContent` (`google-shared.ts`), bypassing creation/refresh lifecycle.

### Stream behavior
* **Gemini Streaming Execution**: Delegated to `streamGoogleGenAI` and `consumeGoogleStream` in `packages/ai/src/providers/google-shared.ts` with `retainTextSignature: true`. Handles SSE chunk parsing, text/thinking block aggregation (`thoughtSignature`), tool-call ID synthesis (generating IDs when Vertex omits them), and finish reasons.
* **Anthropic-on-Vertex RawPredict Handling**: `isGoogleVertexAuthenticatedModel` in `packages/ai/src/stream.ts` matches `model.provider === "google-vertex"` with `anthropic-messages` API and `:streamRawPredict` baseUrl. Requests route through `streamAnthropic` using `apiKey: "vertex-adc"` and `createVertexAuthenticatedFetch`.
* **Anthropic Request Rewriting**: `createVertexAuthenticatedFetch` in `packages/ai/src/stream.ts` invokes `resolveVertexRequest` to substitute `{project}` and `{location}` placeholders in URL, normalizes `:streamRawPredict/v1/messages` path to `:streamRawPredict`, and applies `transformVertexAnthropicBody` to strip `payload.model` (encoded in URL path) and inject `payload.anthropic_version = "vertex-2023-10-16"` into the JSON body.
* **Anthropic Effort Beta Gating**: Vertex `rawPredict` rejects `anthropic-beta` HTTP headers with a 400 error. In `packages/ai/src/providers/anthropic.ts`, `effortBeta` (`effort-2025-11-24`), `contextManagementBeta`, and `output_config.effort` fields are gated off for `model.provider === "google-vertex"`. Fallback payloads in `anthropic.ts` also scrub `output_config.effort` on Vertex requests (#5614).

### Auth & usage
* **ADC Resolution Ladder**: `packages/ai/src/providers/google-auth.ts` resolves credentials in priority order:
  1. `GOOGLE_APPLICATION_CREDENTIALS` env pointing to JSON credentials file. Supports `type: "service_account"` (RS256 JWT assertion signed via WebCrypto `crypto.subtle` exchanged at `https://oauth2.googleapis.com/token`), `type: "authorized_user"` (refresh-token exchange), or `type: "impersonated_service_account"` (exchanges source credentials then calls GCP IAM `generateAccessToken`).
  2. User ADC file `~/.config/gcloud/application_default_credentials.json` (`authorized_user` flow).
  3. GCE / Cloud Run metadata server (`http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token`).
* **Explicit Access Token Override**: `GOOGLE_CLOUD_ACCESS_TOKEN` or `CLOUDSDK_AUTH_ACCESS_TOKEN` environment variables bypass file/metadata lookup and caching entirely.
* **Token Caching & In-flight Deduplication**: Access tokens are stored in `tokenCache` (Map) keyed by resolved source and refreshed `GOOGLE_VERTEX_REFRESH_SKEW_MS` before expiry (default 60s). Concurrent resolution requests share a single in-flight promise in `inflight` Map, bounded by `SHARED_TOKEN_RESOLVE_TIMEOUT_MS` (30s). Individual callers race their abort signals against the shared promise via `raceWithSignal` so one caller's abort does not cancel batch resolution. OAuth scope requested: `https://www.googleapis.com/auth/cloud-platform`.
* **Usage & Token Normalization**: `consumeGoogleStream` in `packages/ai/src/providers/google-shared.ts` extracts `usageMetadata` from responses: `input` is calculated as `promptTokenCount - cachedContentTokenCount`, `output` as `candidatesTokenCount + thoughtsTokenCount`, `cacheRead` as `cachedContentTokenCount`, and `reasoningTokens` as `thoughtsTokenCount`. Passes normalized usage to `calculateCost(model, output.usage)`.

### Catalog model handling
* **Catalog API Resolution**: `resolveGoogleVertexApi` in `packages/catalog/src/provider-models/openai-compat.ts` routes `@ai-sdk/google-vertex/anthropic` npm package models to `api: "anthropic-messages"` with `GOOGLE_VERTEX_ANTHROPIC_BASE_URL` (`https://{location}-aiplatform.googleapis.com/v1/projects/{project}/locations/{location}/publishers/anthropic/models/{model}:streamRawPredict`). Models with slash IDs or `@ai-sdk/openai-compatible` route to `api: "openai-completions"`. All other models route to `api: "google-vertex"` with `GOOGLE_VERTEX_BASE_URL` (`https://{location}-aiplatform.googleapis.com`).
* **Provider Descriptor**: `packages/catalog/src/provider-models/descriptors.ts` registers `id: "google-vertex"` with `defaultModel: "gemini-3.1-pro-preview"`.
* **Registry Credentials Guard**: `googleVertexProvider` in `packages/ai/src/registry/google-vertex.ts` exports `envKeys()`. Returns `$env.GOOGLE_CLOUD_API_KEY` if set, or `AUTHENTICATED_SENTINEL` (`"<authenticated>"`) if ADC credentials exist (`hasVertexAdcCredentials()`) AND project env (`GOOGLE_CLOUD_PROJECT`/`GCP_PROJECT`/`GCLOUD_PROJECT`) AND location env (`GOOGLE_VERTEX_LOCATION`/`GOOGLE_CLOUD_LOCATION`/`VERTEX_LOCATION`) are present. Returns `undefined` otherwise, preventing models from appearing in catalog listings without proper auth.

## Google Gemini CLI / Antigravity
Google Cloud Code Assist (CCA) transport wrapper accessing Gemini and Claude models over `/v1internal:streamGenerateContent` SSE endpoints. Implementation spans `packages/ai/src/providers/google-gemini-cli.ts` (shared execution engine, request construction, stream parsing, and planning leak filters), `packages/ai/src/registry/google-gemini-cli.ts` & `packages/ai/src/registry/google-antigravity.ts` (provider definitions and OAuth lazy-loaders), `packages/ai/src/registry/oauth/google-gemini-cli.ts` & `google-antigravity.ts` (OAuth login flows, project discovery, and onboarding), `packages/ai/src/usage/google-antigravity.ts` & `packages/ai/src/usage/gemini.ts` (quota tracking and credential ranking), and `packages/catalog/src/discovery/antigravity.ts` (model catalog discovery).

### Special casings
- **CCA JSON Schema Normalization**: `normalizeSchemaForCCA` (`packages/ai/src/utils/schema/normalize.ts`) recursively strips unsupported JSON Schema keywords (`propertyNames`, `additionalProperties`, `patternProperties`, `$schema`, `title`, `description`, etc.) to prevent HTTP 400 errors from CCA. Accurately tracks context inside properties named `properties` to avoid premature re-assertion of property stripping. Tools are normalized in `buildRequest` (`packages/ai/src/providers/google-gemini-cli.ts`) via `normalizeSchemaForCCA`.
- **Function Calling Config Mode**: Defaults to `functionCallingConfig: { mode: "VALIDATED" }` for Antigravity in `buildRequest`. Claude models on Antigravity force `VALIDATED` mode even when context contains no declared tools (`isClaudeModel`). Single named tool choice (`options.toolChoice`) sets `mode: "ANY"` with `allowedFunctionNames: [...]`.
- **Provider Protocol & Request Envelope**:
  - **Endpoints**: `google-gemini-cli` defaults to `https://cloudcode-pa.googleapis.com`. `google-antigravity` uses auto-failover across `https://daily-cloudcode-pa.googleapis.com` (primary) and `https://daily-cloudcode-pa.sandbox.googleapis.com` (sandbox), persisting `lastGoodEndpoint` in `AntigravityProviderSessionState`.
  - **Headers & User-Agent**: `google-gemini-cli` sends `getGeminiCliHeaders()` (`GeminiCLI/0.46.0/<modelId> (platform; arch; terminal)`). `google-antigravity` sends `getAntigravityUserAgent()` (`antigravity/hub/<version> (aidev_client; os_type=<os>; arch=<arch>; cl=<cl>)`); the backend gates newer models (e.g. gemini-3.7-flash) on the client version. Reasoning Claude models on Antigravity send `anthropic-beta: interleaved-thinking-2025-05-14` (`needsClaudeThinkingBetaHeader`).
  - **System Instructions**: Antigravity tags system instructions with `role: "user"`. No identity prompt is injected — the backend accepts arbitrary system instructions on all routes (verified against gemini-3.x and Claude wire ids).
  - **Request Envelope & Session State**: Antigravity wraps requests in `buildAntigravityRequestEnvelope`: `project` (projectId), `requestId` (`agent/<agentId>/<ts>/<trajectoryId>/<step>`), `userAgent` (`antigravity`), `requestType` (`agent`), and `labels` (`last_step_index`, `model_enum`, `trajectory_id`, `used_claude`, `used_claude_conservative`, `last_execution_id`). State maintains monotonic `stepIndex`, persistent `agentId`, `trajectoryId`, and signed-decimal `sessionId` (`deriveAntigravitySessionId`).
  - **Wire Profiles**: `getAntigravityModelWireProfile` (`packages/catalog/src/wire/gemini-headers.ts`) maps wire IDs to `maxOutputTokens` and `model_enum`. Claude wire IDs cap `maxOutputTokens` at `64000` (backend rejects >64000 with 400).
- **Thinking Configuration & Wire Suppression**: Gemini 2.x models send `thinkingConfig.thinkingBudget`, while Gemini 3 models send `thinkingConfig.thinkingLevel`. When reasoning is disabled for models with `thinking.suppressWhenOff`, `buildRequest` emits explicit wire suppression (`includeThoughts: false` with level/budget). Omitting `thinkingConfig` causes CCA to re-apply server defaults and silently bill thinking tokens.

### Stream behavior
- **Transport & SSE Protocol**: Consumes `POST /v1internal:streamGenerateContent?alt=sse` via `readSseJson<CloudCodeAssistResponseChunk>`. Chunks deliver `candidates[0].content.parts`, `usageMetadata`, `modelVersion`, `responseId`, `promptFeedback`, or top-level `error`.
- **In-band Errors & Block Reasons**: `chunk.error` status/code >=400 throws `AIError.GeminiCliApiError` or `AIError.ProviderResponseError`. `promptFeedback.blockReason` throws `AIError.ProviderResponseError` with `kind: "content-blocked"`.
- **Planning Leak Detection & Filtering**: Flash models (`isFlashLeakModel`) can stream raw JSON internal planning blocks into visible text parts. `consumePlanningBuffer` checks prefixes starting with `{` or `"thought":` using `isPlanningLeakPrefix` and `splitLeadingJsonObject`. If parsed JSON contains `thought`, `call` (matching active tool names), `_i`, `paths`, `command`, or `path`/`content`, the object is classified as `kind: "leak"` and stripped from visible output.
- **Thinking Parts & Signature Retention**: Parts with `thought: true` or `isThinkingPart()` route to thinking blocks. `thoughtSignature` on text, thinking, or toolCall parts is retained via `retainThoughtSignature`. Inline `<thinking>` tags are processed using `StreamMarkupHealing`.
- **Empty Stream Retry**: Google models can return `finishReason: "STOP"` with empty text parts and no tool call. `hasMeaningfulGoogleContent` checks for non-empty text, thinking, or tool calls. Empty responses with `stopReason === "stop"` trigger up to `MAX_EMPTY_STREAM_RETRIES` (3 retries) with exponential backoff (`EMPTY_STREAM_BASE_DELAY_MS = 1000ms`) before failing (`packages/ai/src/providers/google-gemini-cli.ts`).
- **Pre-Response Watchdogs**: Arms `armPreResponseTimeout` with `getStreamFirstEventTimeoutMs` (5-minute ceiling) to prevent hung HTTP proxy connections before the first SSE chunk arrives. Native Bun fetch pre-response timeout is disabled (`timeout: false`).

### Auth & usage
- **Credential Model & Token Expiry**: Credentials stored as JSON (`parseGeminiCliCredentials`): `{ token, projectId, refreshToken, expiresAt, email }`. AuthStorage is the sole refresh authority. `shouldRefreshGeminiCliCredentials` checks token expiry with a 60s skew (`ANTIGRAVITY_REFRESH_SKEW_MS` / `GOOGLE_GEMINI_REFRESH_SKEW_MS`). Stale tokens fail fast before making HTTP requests.
- **OAuth Installed-App Flow**: Callback ports are `8085` (`google-gemini-cli`, `/oauth2callback`) and `51121` (`google-antigravity`, `/oauth-callback`). Supports paste code flow (`pasteCodeFlow: true`). Authorizes via Google PKCE OAuth 2.0 (`accounts.google.com/o/oauth2/v2/auth`). Antigravity scopes include `cloud-platform`, `userinfo.email`, `userinfo.profile`, `cclog`, and `experimentsandconfigs`.
- **Project Discovery & Onboarding**:
  - `google-gemini-cli` (`packages/ai/src/registry/oauth/google-gemini-cli.ts`): calls `POST /v1internal:loadCodeAssist` with `$GOOGLE_CLOUD_PROJECT` fallback. If project absent, calls `POST /v1internal:onboardUser` with `tierId` (`free-tier`, `legacy-tier`, `standard-tier`) and polls `LongRunningOperationResponse` via `pollOperation` (up to `POLL_MAX_ATTEMPTS = 24` at 5s intervals). Detects VPC-SC restriction (`SECURITY_POLICY_VIOLATED`).
  - `google-antigravity` (`packages/ai/src/registry/oauth/google-antigravity.ts`): mirrors the native `antigravity/hub` flow against `https://daily-cloudcode-pa.googleapis.com`: `loadCodeAssist` requests carry `{ metadata: { ideType: "ANTIGRAVITY" } }`, repeat with `cloudaicompanionProject` when the response lacks `paidTier`, and refresh after resolving the account state. Accounts without `currentTier` are provisioned once with `onboardUser` and `tierId: "free-tier"`; its long-running operation is polled with `GET /v1internal/{operation.name}` every second under one 30-second deadline.
- **Usage & Quota Tracking (`google-antigravity`)**: `antigravityUsageProvider` (`packages/ai/src/usage/google-antigravity.ts`) queries `POST /v1internal:fetchAvailableModels`. Normalizes quota buckets into daily (24h) and weekly (7d) windows. Deduplicates quotas into backend counter keys (`Anthropic`, `Google`, `OpenAI`). `antigravityRankingStrategy` scopes ranking by requested model family (`getAntigravityCounterKeyForModel`: `claude-` → Anthropic, `gemini-`/`gemma-` → Google, `gpt-`/`openai/` → OpenAI), selecting stored OAuth credentials with available quota headroom.
- **Usage & Quota Tracking (`google-gemini-cli`)**: `googleGeminiCliUsageProvider` (`packages/ai/src/usage/gemini.ts`) queries `loadCodeAssist` and `retrieveUserQuota`, surfacing quota percentages per model tier (`3-Flash`, `Flash`, `Pro`).

### Catalog model handling
- **Provider Descriptors**: `google-antigravity` (default model `gemini-3.1-pro`) and `google-gemini-cli` (default model `gemini-3.1-pro-preview`) are defined in `CATALOG_PROVIDERS` with `specialModelManager: true` (`packages/catalog/src/provider-models/descriptors.ts`), bypassing standard factories.
- **Model Resolution & Discovery**: `googleAntigravityModelManagerOptions` & `googleGeminiCliModelManagerOptions` (`packages/catalog/src/provider-models/google.ts`) invoke `fetchAntigravityDiscoveryModels` (`packages/catalog/src/discovery/antigravity.ts`).
- **Identity & Thinking Metadata**: Parsed as `family: "gemini"` with kinds `pro` / `flash` (`packages/catalog/src/identity/classify.ts`). Gemini 3.0+ models enforce mandatory reasoning (`impliesMandatoryReasoning` in `model-thinking.ts`). Efforts: `GEMINI_3_PRO_EFFORTS` (`[Low, High]`) and `GEMINI_3_FLASH_EFFORTS` (`[Minimal, Low, Medium, High]`).
- **Variant Collapsing**: Effort-tier variants are collapsed into logical specs at discovery (`packages/catalog/src/variant-collapse.ts`):
  - `gemini-3.5-flash`: collapses `gemini-3.5-flash-extra-low`, `gemini-3.5-flash-low`, `gemini-3-flash-agent`. Antigravity budget mode maps Minimal/Low → `extra-low` (1000 tokens), Medium → `low` (4000 tokens), High → `agent` (10000 tokens). Gemini CLI maps to level transport. Alias: `gemini-3-flash`.
  - `gemini-3.6-flash`: collapses `gemini-3.6-flash-low`, `-medium`, `-high`, `-tiered` into `gemini-3.6-flash` with `google-level` mode.
  - `gemini-3.1-pro`: collapses `gemini-3.1-pro-low`, `gemini-pro-agent`, `gemini-3.1-pro-high`. High effort routes to `gemini-pro-agent` because upstream `gemini-3.1-pro-high` deployment returns INVALID_ARGUMENT on streamGenerateContent.
  - `claude-*`: bare and `-thinking` pairs collapse into `claude-*` using `thinkingPair` (`preserveAbsentEffortRoutes: true`).
- **Catalog Generator Integration**: `fetchAntigravityModels` (`packages/catalog/scripts/generate-models.ts`) fetches models via discovery token (falling back from `google-antigravity` to `google-gemini-cli` OAuth credentials) and fixes `baseUrl` to `https://daily-cloudcode-pa.googleapis.com`.

## Amazon Bedrock
Amazon Bedrock (`amazon-bedrock` provider, `bedrock-converse-stream` API) communicates directly with `bedrock-runtime.{region}.amazonaws.com/model/{modelId}/converse-stream` via HTTPS POST requests using AWS SigV4 signatures or explicit bearer tokens, decoding binary `application/vnd.amazon.eventstream` responses. The implementation bypasses heavy AWS SDK dependencies (`@aws-sdk/*`, `@smithy/*`), executing native fetches signed with WebCrypto and decoded via a lightweight eventstream parser. Entry modules comprise `packages/ai/src/providers/amazon-bedrock.ts` (`streamBedrock`), `packages/ai/src/registry/amazon-bedrock.ts` (`amazonBedrockProvider`), `packages/ai/src/registry/aws.ts`, `packages/ai/src/providers/aws-credentials.ts` (`resolveAwsCredentials`), `packages/ai/src/providers/aws-eventstream.ts` (`decodeEventStream`), and `packages/ai/src/providers/aws-sigv4.ts` (`signRequest`).

### Special casings
- **Converse API Payload & Message Mapping**: Requests build a `ConverseStreamRequest` with `messages`, `system`, `inferenceConfig` (`maxTokens`, `temperature`, `topP`), `toolConfig`, and `additionalModelRequestFields`. System prompts normalize to `SystemContent[]` with text blocks and `CachePoint` markers (`{ cachePoint: { type: "default", ttl?: "1h" } }`). User content maps to `text`, `image` (`jpeg`/`png`/`gif`/`webp` base64 via `createImageBlock`), `toolResult`, or `cachePoint`. Bedrock requires consecutive tool result blocks to be consolidated into a single `user` role `WireMessage` (`convertMessages` loops to merge adjacent `toolResult` turns). Empty text blocks and empty content arrays are filtered to avoid HTTP 400 validation failures.
- **NO_TOOLS_SENTINEL (`__no_tools__`)**: Bedrock validates that any request containing prior `toolUse` or `toolResult` blocks must supply a `toolConfig`. When tools are disabled (`toolChoice: "none"`) or empty on a turn with tool history, `planToolConfig` injects a placeholder tool `NO_TOOLS_SENTINEL` (`name: "__no_tools__"`, dummy schema). Per-request flag `sentinelInjected` tracks injection (so caller tools named `__no_tools__` work normally). When `sentinelInjected` is true, `handleContentBlockStart` ignores synthetic tool-use start events, and `messageStop` demotes `stopReason: "tool_use"` to `"stop"`.
- **Thinking & Reasoning (`additionalModelRequestFields`)**:
  - `anthropic-adaptive` models (Claude Opus 4.7+, Sonnet/Opus 5, Fable/Mythos 5): mapped to `{ thinking: { type: "adaptive", display? }, output_config: { effort } }` via `mapEffortToAnthropicAdaptiveEffort`. `thinkingDisplay` defaults to `"summarized"` on display-supporting models so silent reasoning streams under Anthropic's `"omitted"` default are avoided (issue #1373).
  - Budget-mode models (e.g. Claude 3.7 / 4.6): mapped to `{ thinking: { type: "enabled", budget_tokens, display }, anthropic_beta? }`. Sets `anthropic_beta: ["interleaved-thinking-2025-05-14"]` when `interleavedThinking` is true.
  - Forced Tool Choice Conflict: Bedrock rejects thinking when `toolChoice` forces tool execution (`any` or named `{ tool: { name } }`). `streamBedrock` clears `additionalModelRequestFields` when forced tool choice is active.
  - Thinking Signatures & Demotion: Assistant thinking blocks without `thinkingSignature` on Claude models (`supportsThinkingSignature`) are demoted to text via `renderDemotedThinking`. Non-Claude models (Nova, Titan, Llama, Mistral) reject thinking signatures and receive unsigned `reasoningContent`.
- **Region & Inference-Profile Resolution**: `resolveBedrockRegion` resolves runtime regions in order: explicit `options.region` -> ARN-embedded region (`inferRegionFromBedrockArn`) -> ambient environment/profile region (`resolveAwsAmbientRegion`). For geo-prefixed cross-region inference profiles (`us.`, `us-gov.`, `eu.`, `apac.`, `au.`, `jp.`), `regionServesGeo` verifies ambient region compatibility; mismatched or missing ambient regions fallback to geo-default endpoints (`INFERENCE_PROFILE_GEO_DEFAULT_REGION`: `us` -> `us-east-1`, `us-gov` -> `us-gov-west-1`, `eu` -> `eu-west-1`, `apac` -> `ap-southeast-1`, `au` -> `ap-southeast-2`, `jp` -> `ap-northeast-1`). `global.` profiles use ambient region or `us-east-1`.

### Stream behavior
- **AWS Eventstream Binary Decoding**: Framed as big-endian integers (`[total len u32][headers len u32][prelude CRC u32][headers][payload][message CRC u32]`). `decodeMessage` in `packages/ai/src/providers/aws-eventstream.ts` checks total length (minimum 16 bytes), computes IEEE 802.3 CRC32 via `Bun.hash.crc32(bytes) >>> 0` (`crc32`), and verifies both prelude (first 8 bytes) and message CRCs (entire frame minus 4 bytes). Header parser (`parseHeaders`) reads typed headers (bool, byte, short, int, long, byte-array, string, timestamp, uuid). `decodeEventStream` yields messages from a `ReadableStream<Uint8Array>` using a growable Uint8Array buffer and cancels reader lock on abort.
- **Event Dispatch & Error Handling**: Stream messages carrying `:message-type = "event"` dispatch:
  - `messageStart`: verifies `role === "assistant"` and pushes stream `start`.
  - `contentBlockStart`: pushes `toolcall_start` (skipping sentinel).
  - `contentBlockDelta`: pushes `text_delta` (creates text block if absent), `toolcall_delta` (accumulates JSON input delta in `kStreamingPartialJson`, throttled via `parseStreamingJsonThrottled`), or `thinking_delta` (accumulates reasoning text and signature).
  - `contentBlockStop`: parses tool JSON via `parseStreamingJson` and pushes `text_end`/`thinking_end`/`toolcall_end`.
  - `messageStop`: maps `stopReason` (`end_turn`/`stop_sequence` -> `stop`, `max_tokens`/`model_context_window_exceeded` -> `length`, `tool_use` -> `toolUse`).
  - `metadata`: extracts usage (`inputTokens`, `outputTokens`, `cacheReadInputTokens`, `cacheWriteInputTokens`) and invokes `calculateCost`.
  - `:message-type = "exception"` extracts `:exception-type` and error payload to throw `BedrockApiError` (400). `:message-type = "error"` extracts `:error-code` and `:error-message`.
- **Idle Watchdogs & Pre-Response Timeout**: Bun's native `fetch` timeout is disabled (`timeout: false`) to support long prefill prompts. Pre-response timeout is armed via `armPreResponseTimeout` using `streamFirstEventTimeoutMs`. Bedrock streams send no ping/keepalive events during reasoning; catalog compat (`packages/catalog/src/compat/bedrock.ts` `buildBedrockCompat`) sets `streamIdleTimeoutMs` floor to 600s for standard reasoning models and 900s for adaptive-thinking models (Claude Opus 4.7+, Sonnet/Opus 5, Fable 5).

### Auth & usage
- **Dual Auth Modes**:
  - Bearer Token: If `options.bearerToken`, `options.apiKey`, or `$env.AWS_BEARER_TOKEN_BEDROCK` is present (`resolveAwsBearerToken`), sets `Authorization: Bearer <token>` and bypasses SigV4 signing.
  - AWS SigV4 Signing: `signRequest` (`packages/ai/src/providers/aws-sigv4.ts`) signs headers using WebCrypto (`crypto.subtle`). Computes SHA-256 payload digest (`x-amz-content-sha256`), date (`x-amz-date`), host, and security token (`x-amz-security-token`). Derives HMAC-SHA256 signing key chain (`AWS4` + `secretAccessKey` -> `kDate` -> `kRegion` -> `kService` ("bedrock") -> `kSigning`).
- **5-Tier Credential Resolution Chain**: `resolveAwsCredentials` (`packages/ai/src/providers/aws-credentials.ts`) caches resolved credentials per `profile\0region\0config` key with a 60s refresh skew (`REFRESH_SKEW_MS`) and single-flight inflight deduplication bounded by 30s timeout (`SHARED_RESOLVE_TIMEOUT_MS`). Chain precedence:
  1. Environment Variables: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, optional `AWS_SESSION_TOKEN`.
  2. Web Identity / OIDC: `AWS_WEB_IDENTITY_TOKEN_FILE`, `AWS_ROLE_ARN`, `AWS_ROLE_SESSION_NAME`. Calls STS `AssumeRoleWithWebIdentity` on `sts.{region}.amazonaws.com`.
  3. Shared Config / Profile (`~/.aws/credentials`, `~/.aws/config` parsed via `parseAwsIni`): Static keys (file session tokens capped at 5 min TTL via `FILE_SESSION_CREDS_TTL_MS`), AWS SSO (`sso_account_id`, `sso_role_name`, legacy `sso_start_url`/`sso_region` or `sso-session` block; reads cached token from `~/.aws/sso/cache/*.json` and calls `portal.sso.{ssoRegion}.amazonaws.com/federation/credentials`), or `credential_process` (spawns external process using POSIX tokenization `tokenizeCredentialProcessCommand`; Windows `.cmd`/`.bat` routed through `cmd.exe /c`; expects Version 1 JSON envelope).
  4. ECS / Container: `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI` (on `http://169.254.170.2/`) or `AWS_CONTAINER_CREDENTIALS_FULL_URI` with optional auth token/file.
  5. EC2 IMDSv2: `169.254.169.254` (or IPv6 `[fd00:ec2::254]`), requests PUT token from `latest/api/token` with 1s timeout (`IMDS_TIMEOUT_MS`).
- **Cache Invalidation & Registry Status**: On 401/403 HTTP response, `streamBedrock` calls `invalidateAwsCredentialCache({ profile, region })` to drop cached credentials so subsequent turns re-resolve fresh credentials. `amazonBedrockProvider` (`packages/ai/src/registry/amazon-bedrock.ts`) evaluates `hasAwsCredentialSource()` (`packages/ai/src/registry/aws.ts`) to return `AUTHENTICATED_SENTINEL` when valid credentials or environment tokens exist.

### Catalog model handling
- **Descriptor Registration**: Registered in `CATALOG_PROVIDERS` (`packages/catalog/src/provider-models/descriptors.ts`) with default model `us.anthropic.claude-opus-4-8`.
- **models.dev Mapping & Cross-Region Profiles**: `MODELS_DEV_PROVIDER_DESCRIPTORS` (`packages/catalog/src/provider-models/openai-compat.ts`) maps `modelsDevKey: "amazon-bedrock"` to API `bedrock-converse-stream`. `bedrockCrossRegionId` prefixes `global.` or `us.` for matching models. For `anthropic.claude-*` models, `transformModel` automatically emits EU (`eu.`) and AWS GovCloud (`us-gov.`) cross-region inference-profile spec variants. Non-tool and legacy models (`ai21.jamba`, `titan-text-express`, `mistral-7b`) are filtered out.
- **Mantle & Undocumented Model Exclusion**: Bedrock Mantle is a distinct provider (`bedrock-mantle`, `openai-responses` API, `https://bedrock-mantle.{region}.api.aws/openai/v1`) covered by a separate subagent. Catalog build policies (`packages/catalog/scripts/generated-policies.ts`) run `dropBedrockMantleOpenAIModels` to exclude Mantle OpenAI model rows (`openai.gpt-5.4`, `5.5`, `5.6-luna`, `sol`, `terra`) from `amazon-bedrock`. `dropUnsupportedBedrockGeoIds` prunes `jp.anthropic.claude-opus-5` (listed upstream on models.dev but unsupported and rejected by AWS Bedrock).
- **Prompt Caching & Thinking Compat**: `buildBedrockCompat` (`packages/catalog/src/compat/bedrock.ts`) maps model IDs to explicit prompt caching contracts (`promptCacheMode`: `explicit` or `none`, minimum token thresholds 512, 1024, 2048, 4096; `supportsLongPromptCacheRetention` 1h vs 5m; maximum 4 checkpoints). `inferThinkingControlMode` (`packages/catalog/src/model-thinking.ts`) classifies Claude 4.6+ adaptive models as `anthropic-adaptive` (setting `supportsDisplay: true`), Opus 4.5 as `anthropic-budget-effort`, and non-adaptive models as `budget`. Pricing is generated and materialized into `packages/catalog/src/models.json`.

## Amazon Bedrock Mantle

Amazon Bedrock Mantle is AWS's gateway endpoint serving OpenAI-compatible models (such as `openai.gpt-5.4`, `openai.gpt-5.5`, and `openai.gpt-5.6` Luna/Sol/Terra variants) over the OpenAI Responses API (`openai-responses`) protocol rather than Bedrock's native Converse JSON transport (`amazon-bedrock`). Requests target region-interpolated endpoints (`https://bedrock-mantle.{region}.api.aws/openai/v1`) with OpenAI Responses API payloads (`/responses`). Entry modules are `packages/ai/src/providers/bedrock-mantle.ts`, `packages/ai/src/registry/bedrock-mantle.ts`, and catalog setup in `packages/catalog/src/provider-models/openai-compat.ts`.

### Special casings
- **Endpoint Structure**: Unlike standard Bedrock Converse endpoints (`bedrock-runtime.{region}.amazonaws.com`), Mantle requests target `https://bedrock-mantle.{region}.api.aws/openai/v1`. The `{region}` template placeholder in `model.baseUrl` is dynamically replaced at request preparation time in `prepareBedrockMantleRequest` (`packages/ai/src/providers/bedrock-mantle.ts`).
- **Region Resolution Hierarchy**: Region substitution in `resolveAwsRegion` (`packages/ai/src/utils/aws-profile.ts`) evaluates in order: explicit `providerOptions.region` -> `AWS_REGION` -> `AWS_DEFAULT_REGION` -> region from active AWS shared-config profile in `~/.aws/config` (`resolveAwsProfileRegion`) -> fallback default `"us-east-1"`.
- **401/403 Credential Invalidation**: When using SigV4 signed requests in `createSignedFetch` (`packages/ai/src/providers/bedrock-mantle.ts`), an HTTP 401 or 403 response triggers `invalidateAwsCredentialCache({ profile, region })` (`packages/ai/src/providers/aws-credentials.ts`) so subsequent attempts re-resolve fresh credentials from profile, environment, or STS roles.
- **Registry Sentinel & Auth Flag**: `bedrockMantleProvider` in `packages/ai/src/registry/bedrock-mantle.ts` sets `allowsMissingApiKey: true`. When ambient AWS credentials exist (`hasAwsCredentialSource` in `packages/ai/src/registry/aws.ts`), `resolveAwsRegistryApiKey` returns `AUTHENTICATED_SENTINEL`. `resolveAwsBearerToken` strips this sentinel value so SigV4 authentication is selected unless an actual bearer token is present.
- **Generator Model Drop Policy**: In `packages/catalog/scripts/generated-policies.ts`, `dropBedrockMantleOpenAIModels` filters out `openai.gpt-5.*` rows from the `amazon-bedrock` provider (where upstream `models.dev` incorrectly assigns them under Bedrock Converse) so that only working `bedrock-mantle` Responses API models are exposed.

### Stream behavior
- **Transport**: Delegated to the `openai-responses` provider pipeline (`packages/ai/src/providers/openai-responses.ts`), consuming SSE stream events like `response.created`, `response.text.delta`, `response.output_item.added`, and `response.completed`.
- **Reasoning & Thinking Effort**: Configured via `BEDROCK_MANTLE_GPT_5_X_THINKING` and `BEDROCK_MANTLE_GPT_5_6_THINKING` (`packages/catalog/src/provider-models/openai-compat.ts`) supporting effort levels (`low`, `medium`, `high`, `xhigh`, `max`). Reasoning content is streamed in `openai-responses` reasoning delta frames.
- **Error Handling**: Non-2xx SSE streams pass error status codes back to the stream result handler; 401/403 status codes invalidate the cached AWS credential state in `createSignedFetch`.

### Auth & usage
- **Dual Authentication Modes**:
  - **Bearer Token**: Evaluated by `resolveBearerToken` (`packages/ai/src/providers/bedrock-mantle.ts`). Active when `AWS_BEARER_TOKEN_BEDROCK`, `providerOptions.bearerToken`, or an explicit non-sentinel `apiKey` is provided. `createBedrockMantleAuthenticatedFetch` injects `Authorization: Bearer <token>`.
  - **AWS SigV4 Signing**: Active when no bearer token exists but ambient credentials pass `hasAwsCredentialSource`. Request headers are signed by `signRequest` (`packages/ai/src/providers/aws-sigv4.ts`) using service name `"bedrock-mantle"`, setting `Authorization: AWS4-HMAC-SHA256 ...` and `x-amz-security-token` (when using session credentials).
- **Authentication Precedence**: Bearer token takes precedence over SigV4 signing when both are available.
- **Usage Tracking**: Input, output, cached, and reasoning token usages are parsed directly from the standard OpenAI Responses wire payload (`usage.input_tokens`, `usage.output_tokens`, `usage.input_token_details.cached_tokens`, `usage.output_token_details.reasoning_tokens`) by `openai-responses`.

### Catalog model handling
- **Provider Descriptor**: The `bedrock-mantle` descriptor in `packages/catalog/src/provider-models/descriptors.ts` sets `defaultModel: "openai.gpt-5.6-terra"`, `envVars: ["AWS_BEARER_TOKEN_BEDROCK"]`, and `dynamicModelsAuthoritative: true`.
- **Static Seeds**: Pre-bundled in `BEDROCK_MANTLE_STATIC_MODELS` (`packages/catalog/src/provider-models/openai-compat.ts`) with 5 OpenAI models (`openai.gpt-5.4`, `openai.gpt-5.5`, `openai.gpt-5.6-luna`, `openai.gpt-5.6-sol`, `openai.gpt-5.6-terra`) defining context windows (272,000), max tokens (128,000), pricing structures, and thinking effort specs.
- **Authenticated Model Discovery**:
  - `prepareModelDiscovery` in `packages/ai/src/registry/bedrock-mantle.ts` requires a valid bearer token (`resolveAwsBearerToken`). If unauthenticated or SigV4-only, `authenticated: false` is returned and discovery is bypassed.
  - When authenticated, discovery strips `/openai/v1` to call `https://bedrock-mantle.{region}.api.aws/v1/models` via `fetchOpenAICompatibleModels`.
- **Authoritative Dynamic Model Replacement**: `dynamicModelsAuthoritative: true` in `bedrockMantleModelManagerOptions` causes successful dynamic discovery responses to **replace** static seeds entirely, pruning models not enabled for the AWS account/token.
- **Reference Attribute Merging**: `mapWithBundledReference` merges statically defined costs, thinking configs, and context windows onto dynamically discovered model definitions matching `BEDROCK_MANTLE_MODEL_BY_ID`.

## Kimi Code
Kimi Code (`kimi-code`) and Moonshot (`moonshot`) provide access to Moonshot AI's model family through dual-transport execution—wrapping OpenAI-compatible chat completions (`/coding/v1/chat/completions`) and Anthropic-compatible messages (`/coding/v1/messages`). Entry points are `packages/ai/src/providers/kimi.ts` (`streamKimi`) and `packages/ai/src/providers/openai-anthropic-shim.ts` (`streamOpenAIAnthropicShim`), with model discovery and catalog descriptors configured in `packages/catalog/src/provider-models/descriptors.ts` and `packages/catalog/src/provider-models/openai-compat.ts`.

### Special casings
- **Dual Transport Routing**: `streamKimi` delegates to `streamOpenAIAnthropicShim` in `packages/ai/src/providers/openai-anthropic-shim.ts`, selecting format from `model.compat.kimiApiFormat` or explicit `options.format` in `KimiOptions`.
  - `anthropic`: Reconstructs model spec with `api: "anthropic-messages"`, adjusts base URL via `model.baseUrl.replace(/\/v1\/?$/, "")` (`https://api.kimi.com/coding`), injects `getKimiCommonHeaders()`, maps thinking format to `anthropic-adaptive`, computes token budgets via `ANTHROPIC_THINKING`, and streams via `streamAnthropic`.
  - `openai`: Retains `model.baseUrl` (`https://api.kimi.com/coding/v1`), injects `getKimiCommonHeaders()`, passes `reasoning` effort, and streams via `streamOpenAICompletions`.
- **MFJS Tool Schema Validation**: `toolSchemaFlavor: "moonshot-mfjs"` is enforced in `packages/catalog/src/compat/openai.ts` (`buildOpenAICompat`) for native Moonshot hosts (`isMoonshotNative`) and Kimi model IDs across third-party proxies. Moonshot Flavored JSON Schema collapses single-value `const` constructs into single-element `enum` arrays, infers explicit `type` on bare `enum` declarations, and strips unsupported non-standard keywords to prevent 400 schema validation errors.
- **Forced Tool Choice Guards**: Native K2.7 Code models (`kimi-k2.7-code`, `kimi-for-coding`) and K3 models require server-side thinking (`requiresThinkingEnabled = true` in `packages/catalog/src/compat/anthropic.ts`). On the Anthropic surface, forced tool selection is downgraded to `auto`. On the OpenAI surface (`packages/catalog/src/compat/openai.ts`), `supportsForcedToolChoice` is `false` for mandatory-thinking K2.7 models (`requiresEnabledThinking`) but remains `true` for K3 (`!isMoonshotKimiK3`).
- **Turn & Token Invariants**:
  - `alwaysSendMaxTokens: isKimiModel` in `packages/catalog/src/compat/openai.ts`: Kimi calculates rate limits (TPM) based on `max_tokens` rather than emitted tokens, requiring explicit max tokens on every request.
  - `requiresReasoningContentForToolCalls`: True for Kimi models on non-OpenCode providers (`packages/catalog/src/compat/openai.ts`). Prior assistant tool-call turns must carry `reasoning_content` on thinking follow-ups, with synthetic placeholder `"."` allowed when raw reasoning is missing (`allowsSyntheticReasoningContentForToolCalls`).
  - `requiresAssistantContentForToolCalls`: Forces non-empty text content in assistant tool-calling turns.

### Stream behavior
- **Inband Control Tag & Thinking Scanning**: `KimiInbandScanner` in `packages/ai/src/dialect/kimi.ts` processes raw output streams for XML-like tool control tags (`<|tool_calls_section_begin|>`, `<|tool_call_begin|>`, `<|tool_call_argument_begin|>`, `<|tool_call_end|>`, `<|tool_calls_section_end|>`) and `<think>...</think>` thinking blocks, emitting structured `InbandScanEvent` events (`text`, `thinkingStart`, `thinkingDelta`, `thinkingEnd`, `toolStart`, `toolEnd`).
- **Stream Markup Healing**: `streamMarkupHealingPattern: "kimi"` in `packages/catalog/src/compat/openai.ts` (`detectStreamMarkupHealingPattern`) fixes truncated or split inband control tokens across chunk boundaries for `kimi-code`, `moonshot`, or `kimi-k2` model IDs.
- **Idle Watchdog Timeout**: `streamIdleTimeoutMs` floor is extended to 300s for native K2.7 Code models (`packages/catalog/src/compat/openai.ts`) to prevent premature stream aborts during long initial reasoning generation.

### Auth & usage
- **Device OAuth Flow**: Implemented in `packages/ai/src/registry/oauth/kimi.ts` (`loginKimi`, `refreshKimiToken`). Uses OAuth 2.0 Device Authorization Grant (`urn:ietf:params:oauth:grant-type:device_code`) with client ID `17e5f671-d194-4dfb-9706-5516cb48c098` against host `${resolveOAuthHost()}` (`https://auth.kimi.com`, configurable via `KIMI_CODE_OAUTH_HOST` or `KIMI_OAUTH_HOST`).
  - Initiates via `POST /api/oauth/device_authorization`, prompts user with `userCode` and `verificationUriComplete`, and polls `POST /api/oauth/token` with backoff on `authorization_pending` and `slow_down`. Token refresh uses `grant_type: "refresh_token"`.
- **Fingerprinting Headers & Device ID**: `getKimiCommonHeaders()` in `packages/ai/src/registry/oauth/kimi.ts` injects device tracking headers: `User-Agent: KimiCLI/<ver>`, `X-Msh-Platform: kimi_cli`, `X-Msh-Version`, `X-Msh-Device-Name`, `X-Msh-Device-Model`, `X-Msh-Os-Version`, and `X-Msh-Device-Id`. `getDeviceId` persists a random hex UUID to `path.join(getAgentDir(), "kimi-device-id")` (mode 0600) or falls back to an ephemeral process UUID.
- **Usage & Quota Tracker**: `kimiUsageProvider` in `packages/ai/src/usage/kimi.ts` targets `GET /coding/v1/usages` (`https://api.kimi.com/coding/v1/usages`, configurable via `KIMI_CODE_BASE_URL`) with OAuth bearer token and `getKimiCommonHeaders()`.
  - Short-circuits when credentials are expired (`credential.expiresAt <= nowMs`). Parses `KimiUsagePayload`: maps `usage` object to a `Total quota` summary row and `limits` array (extracting `detail` and `window` duration/timeUnit) into `UsageLimit` entries, resolving reset timestamps via `parseResetTime` (`reset_at`, `resetTime`, `ttl`).

### Catalog model handling
- **Provider Descriptors**: `packages/catalog/src/provider-models/descriptors.ts` defines:
  - `kimi-code`: Default model `"kimi-for-coding"`, env `KIMI_API_KEY`, dynamic discovery via `kimiCodeModelManagerOptions`.
  - `moonshot`: Default model `"kimi-k2.7-code"`, envs `MOONSHOT_API_KEY` and `KIMI_API_KEY` fallback, dynamic discovery via `moonshotModelManagerOptions` (default base URL `https://api.moonshot.ai/v1`, overrideable via `MOONSHOT_BASE_URL`).
- **Identity Classification**: `packages/catalog/src/identity/family.ts` exports `isKimiModelId` (matches `moonshotai/kimi` or `/(^|\/)kimi[-.]/`), `isKimiK26ModelId` (`/kimi-k2(\.6|p6)/`), and `isKimiK3ModelId` (`/kimi-k3/`). `isKimiK27CodeModelId` in `packages/catalog/src/provider-models/openai-compat.ts` matches `/kimi-k2.7-code/`.
- **K2.x vs K3 Reasoning Differences**:
  - **K2.x**: Native Moonshot K2.x models use binary thinking (`thinking: { type: "enabled" | "disabled" }`) via `thinkingFormat: "zai"` in `packages/catalog/src/compat/openai.ts`. Configured with 4-tier effort range `[Minimal, Low, Medium, High]` in `moonshotModelManagerOptions`. K2.6 retains full thinking context (`thinkingKeep: "all"`).
  - **K3**: K3 models use OpenAI-style `reasoning_effort` (`thinkingFormat: "openai"`). Configured with 3-tier wire scale `LOW_HIGH_MAX_REASONING_EFFORTS` (`[Low, High, Max]`), `defaultLevel: Effort.Max`, and mandatory reasoning (`requiresEffort: true`, `impliesMandatoryReasoning` in `packages/catalog/src/model-thinking.ts`). `moonshotModelManagerOptions` stamps 1M context window, 131,072 maxTokens, and vision input (`["text", "image"]`).
- **Output Token Ceilings**: `kimiCodeMaxTokens` in `packages/catalog/src/provider-models/openai-compat.ts` derives per-family output limits: 131,072 (`KIMI_CODE_K3_MAX_TOKENS`) for `k3` / `k3-256k`, 32,768 (`KIMI_CODE_FOR_CODING_MAX_TOKENS`) for `kimi-for-coding` / `kimi-for-coding-highspeed`, and fallback 32,000 (`KIMI_CODE_DEFAULT_MAX_TOKENS`) for legacy K2 discovery rows. Applied in catalog generator (`packages/catalog/scripts/generate-models.ts`).

## Ollama
The Ollama integration consists of two distinct provider definitions in `packages/ai`: `ollama` for local Ollama instances (using `openai-responses` or `openai-completions` API via `baseUrl` pointing to local endpoint `/v1`, defaulting to `http://127.0.0.1:11434/v1`), and `ollama-cloud` for Ollama Cloud (using native `ollama-chat` API transport at `https://ollama.com/api/chat`). Entry modules are `packages/ai/src/providers/ollama.ts` for native streaming, `packages/catalog/src/provider-models/openai-compat.ts` for local Ollama catalog options (`ollamaModelManagerOptions`), and `packages/catalog/src/provider-models/ollama.ts` for Ollama Cloud catalog options (`ollamaCloudModelManagerOptions`).

### Special casings
- **Transport Routing**: Local `ollama` defaults to OpenAI-compatible paths (`openai-responses` / `openai-completions`), while `ollama-cloud` uses the native `ollama-chat` protocol.
- **Thinking / Reasoning Support**: For `ollama-chat`, reasoning is controlled via the native `think` field in `createChatBody` mapped by `mapReasoning` (`minimal`/`low` -> `"low"`, `medium` -> `"medium"`, `high`/`xhigh` -> `"high"`, `max` -> `"max"`, or `false` when `disableReasoning` is set). Ollama Cloud effort levels for GLM-5.2 are restricted to `high` and `max` (`OLLAMA_CLOUD_GLM_52_THINKING` in `packages/catalog/src/provider-models/ollama.ts`). Local `ollama` on OpenAI-compat paths supports `reasoning.effort` with values `low`, `medium`, `high`, `max`, `none` (`OLLAMA_REASONING_EFFORTS` in `packages/catalog/src/model-thinking.ts`), with `replayReasoningContent: true` auto-enabled for local KV-cache/chat-template preservation (`LOCAL_OPENAI_COMPAT_PROVIDERS` in `packages/catalog/src/compat/openai.ts`).
- **Tool Choice Emulation**: `selectToolsForToolChoice` in `packages/ai/src/providers/ollama.ts` manually filters `context.tools` down to the target tool when a specific named tool choice is requested (`{ type: "function", function: { name } }` or `{ name }`). Map `toolChoice` maps `"none"` to `"none"`, `"required"`/`"any"`/named object to `"required"`, and `"auto"` to `undefined`.
- **Developer Role & History Sanitization**: Developer system prompts stay on Ollama's `system` role if they are initial system prompts or agent-attributed, but user-attributed developer turns demote to `user` for stable prefix caching. If no `user` role exists, `convertMessages` demotes the last system turn to `user` to prevent Ollama from emitting `done_reason: "load"` without generating output. For `ollama-cloud`, `thinking` fields are stripped from assistant history messages (`convertMessages`) because Ollama Cloud rejects incoming history carrying `thinking` with HTTP 400.
- **Schema Sanitization**: Tool schemas pass through `sanitizeSchemaForOllama(toolWireSchema(tool))` to ensure compatibility.
- **Model Loading / `keep_alive` & Error Rewriting**: When a request contains no user turn or Ollama generates zero tokens, Ollama returns `done_reason: "load"`, mapped to stopReason `"error"` with `EMPTY_OLLAMA_LOAD_COMPLETION_MESSAGE`. Malformed tool-call JSON errors from local llama.cpp backend (HTTP 500) are rewritten by `rewriteOllamaToolCallJsonError` in `packages/ai/src/error/format.ts`. `shouldRetryOllamaResponse` retries 5xx errors unless matched by `LLAMA_CPP_TOOL_CALL_PARSE_PATTERN`.

### Stream behavior
- **NDJSON / JSONL Event Protocol**: Native `ollama-chat` streams NDJSON chunks parsed via `readJsonl<OllamaChatChunk>`.
- **Reasoning vs Content Handling**: Reasoning chunks arrive as `chunk.message.thinking` (yielding `thinking_start`, `thinking_delta`, `thinking_end`). Content text arrives as `chunk.message.content`. Structured tool calls arrive as `chunk.message.tool_calls`.
- **Stream Markup Healing**: Stream markup healing (`StreamMarkupHealing` using `getStreamMarkupHealingPattern`) is engaged for text-channel tool call and reasoning recovery. When native `chunk.message.thinking` is present, `suppressHealedThinking` is set to `true` to avoid double-counting reasoning blocks.
- **Finish Reason Mapping**: `mapDoneReason` maps `done_reason`: `"length"` -> `"length"`, `"tool_calls"` -> `"toolUse"`, `"load"` -> `"error"`, and `undefined` with tool calls -> `"toolUse"`. Natural `stop` with produced tool calls is promoted to `"toolUse"`.
- **Watchdogs & Local Prefill**: Pre-response timeout is armed via `armPreResponseTimeout` with `firstEventTimeoutMs` (derived from `PI_STREAM_FIRST_EVENT_TIMEOUT_MS` or `idleTimeoutMs`) while `timeout: false` is passed to `fetchWithRetry` to avoid premature Bun fetch timeout aborts during heavy local prefill. Retries use delays `[2000, 5000, 10000]`.
- **Empty Completion Retry**: `streamOllama` is wrapped with `withReplaySafeStreamRetry` to transparently retry EOS-only empty completions.

### Auth & usage
- **Credential Source**: `loginOllama` (`packages/ai/src/registry/ollama.ts`) prompts for an optional API key (`allowEmpty: true`), defaulting to no-auth local usage with `envVars: ["OLLAMA_API_KEY"]`. `loginOllamaCloud` (`packages/ai/src/registry/ollama-cloud.ts`) mandates an API key created at `https://ollama.com/settings/keys` with `envVars: ["OLLAMA_CLOUD_API_KEY"]`.
- **Authentication Headers**: Local requests attach `Authorization: Bearer ${apiKey}` if provided; `ollama-cloud` requires `Authorization: Bearer ${apiKey}`.
- **Usage & Quota**: Quota tracking is registered via `ollamaUsageProvider` and `ollamaCloudUsageProvider` in `packages/ai/src/usage/ollama.ts`. Neither provider exposes a standalone usage/quota API (`validatesCredentials: false`, empty `limits`), relying on per-response `prompt_eval_count` (input) and `eval_count` (output) returned in stream completion chunks.

### Catalog model handling
- **Descriptors**: Defined in `packages/catalog/src/provider-models/descriptors.ts`:
  - `ollama`: `defaultModel: "gpt-oss:20b"`, `allowUnauthenticated: true`, `envVars: ["OLLAMA_API_KEY"]`, options built via `ollamaModelManagerOptions`. Excluded from `generate-models.ts` static baking (`DISCOVERY_ONLY_PROVIDERS`).
  - `ollama-cloud`: `defaultModel: "gpt-oss:120b"`, `envVars: ["OLLAMA_CLOUD_API_KEY"]`, `catalogDiscovery: { label: "Ollama Cloud", oauthProvider: "ollama-cloud" }`, options built via `ollamaCloudModelManagerOptions`.
- **Local Catalog Discovery**: `ollamaModelManagerOptions` in `packages/catalog/src/provider-models/openai-compat.ts` attempts `fetchOpenAICompatibleModels` at `/v1/models` first. If unavailable, it falls back to native `fetchOllamaNativeModels` querying `/api/tags`.
- **Cloud Catalog Discovery**: `ollamaCloudModelManagerOptions` in `packages/catalog/src/provider-models/ollama.ts` queries `/api/tags` on `https://ollama.com` using `OLLAMA_CLOUD_API_KEY`.
- **Context-Length & Capability Detection via `/api/show`**: Both local and cloud discovery query Ollama's `/api/show` for each model to inspect `model_info` and `capabilities`.
  - Context length is extracted from `model_info` keys ending in `.context_length`, `.num_ctx`, or `.context_window`. Fallback context window is `128_000` (`OLLAMA_FALLBACK_CONTEXT_WINDOW`).
  - Capability stamping: `capabilities.includes("thinking")` sets `reasoning: true` and configures `thinking` effort config (`[minimal, low, medium, high]`). `capabilities.includes("vision")` stamps `input: ["text", "image"]`.
- **Output Token Ceiling Capping**: Ollama Cloud enforces `OLLAMA_CLOUD_MAX_OUTPUT_TOKENS = 65_536` for DeepSeek V4 Pro/Flash models (`isOllamaCloudOutputCapped`). `ollamaCloudModelManagerOptions` caps `maxTokens` at `min(contextWindow, 65536)` and sets `omitMaxOutputTokens: true`. `resolveNumPredict` in `packages/ai/src/providers/ollama.ts` further clamps `num_predict` on wire payloads to `65_536`.
- **Cache Provider ID**: Resolved by `resolveModelCacheProviderId` in `packages/catalog/src/provider-models/cache-provider-id.ts` using `http://127.0.0.1:11434` for `ollama` or endpoint hash.

## Cursor

Cursor's integration in `packages/ai` operates over an HTTP/2 Connect RPC transport (`/agent.v1.AgentService/Run`) sending length-prefixed binary Protobuf messages (`AgentClientMessage` and `AgentServerMessage`). Key implementation entry points include `packages/ai/src/providers/cursor.ts` for connection lifecycle, Connect message streaming, and frame dispatching; `packages/ai/src/providers/cursor-pi-args.ts` for pure argument and path transformations; `packages/ai/src/providers/cursor/exec-modern.ts` for local tool result frame builders; `packages/ai/src/registry/cursor.ts` and `packages/ai/src/registry/oauth/cursor.ts` for PKCE browser authentication and token refresh; `packages/ai/src/usage/cursor.ts` for multi-endpoint quota tracking; and `packages/catalog/src/discovery/cursor.ts` for Connect RPC model discovery.

### Special casings
- **Pure Argument Translation (`cursor-pi-args.ts`)**: Path and argument formatting functions (`piReadPath`, `piReadPathHasRange`, `piReadDisplayPath`, `piGrepSkip`, `piJoinPath`, `piLsPath`, `piEscapeRegexLiteral`, `piLimit`, `piTimeout`) are kept strictly independent of Protobuf imports so legacy shims can share them without bundling protobuf schemas into virtual registries.
- **Empty Grep Pattern Rejection**: `grepArgs` frames with an empty `pattern` and non-empty `glob` are rejected up front (`emptyGrepPatternRejection`) with a descriptive error, forcing the model to retry or switch tools rather than triggering local tool failure after block persistence.
- **Native Tools & `SoftToolRequirement` Interplay**:
  - Native tools (`CURSOR_NATIVE_TOOL_NAMES`: `bash`, `read`, `write`, `delete`, `ls`, `grep`, `todo`) are omitted when building `requestContext` MCP tool definitions.
  - **Exception**: `write` is explicitly re-included in `buildMcpToolDefinitions` whenever pi-agent tools are advertised. `write` acts as the `xd://` transport for staged previews (e.g. `ast_edit`). Without `write`, staged previews cannot be resolved and `SoftToolRequirement('write')` escalation aborts the turn.
- **`rootPromptMessagesJson` & Blob Store**:
  - `buildGrpcRequest` passes conversation history as SHA-256 binary blob IDs (`blobStore`) in `rootPromptMessagesJson` and `turns`.
  - System prompts are stored as individual JSON blobs (`buildCursorSystemPromptJsons`), allowing independent server-side prefix blob caching hits when only downstream prompts change.
- **Thinking Replay Safeguards**:
  - Assistant thinking content is replayed in turn history (`canReplayCursorThinking`) only for same-model Kimi K3 variants (`assertCursorKimiK3HistoryReplayable`). Foreign or hidden reasoning is omitted to prevent leaking non-Cursor thinking blocks into native conversation turns.

### Stream behavior
- **Length-Prefixed Connect Framing**:
  - Connect HTTP/2 streams use 5-byte headers (1-byte flag + 4-byte big-endian uint32 payload length).
  - `CONNECT_END_STREAM_FLAG` (`0b00000010`) flags terminal frames carrying JSON error objects (`parseConnectEndStream`).
- **Trailer & Transport Error Handling**:
  - Monitors HTTP/2 trailers (`grpc-status`, `grpc-message`) and maps socket or TLS disconnects using `mapH2TransportError`.
- **Bi-Directional RPC Dispatch**:
  - Server streams `AgentServerMessage` (`interactionUpdate`, `execServerMessage`, `kvServerMessage`, `interactionQuery`).
  - Client writes `AgentClientMessage` (`runRequest`, periodic `clientHeartbeat` every 5 seconds, `interactionResponse`) and `ExecClientMessage` tool responses (`readResult`, `writeResult`, `execClientThrow`, `requestContextResult`).
- **Interaction Query Handshake**:
  - Hosted web search / Exa / unnamed field-9 WebFetch send `interactionQuery` and block the turn until the client writes `interactionResponse`.
  - Heartbeats keep HTTP/2 alive but are not semantic progress; an unanswered query sits silent until the 300s idle watchdog (`Provider stream stalled while waiting for the next event`).
  - `handleInteractionQuery` approves network permission gates and rejects interactive ask / switch-mode / create-plan. VM setup is left unanswered because its result oneof is success-only.
- **Async Execution Drain & Turn Completion**:
  - `handleServerMessage` processes frames asynchronously so the socket continues draining. Dispatches are tracked in `inFlightDispatches` and bounded by `options.signal` abort handling before finalizing stream completion.
  - Stream completion verifies `turnEnded` (`sawTurnEnded`) or throws `incomplete-stream`.
- **Tool Call Synthesis**:
  - `synthesizeCursorExecToolCall` generates display `toolCall` blocks on assistant output messages to mirror local tool execution in the UI and transcript.

### Auth & usage
- **Credentials & Headers**:
  - Authenticates via `CURSOR_ACCESS_TOKEN` sent in `Authorization: Bearer <token>`.
  - Client headers: `x-ghost-mode: true`, `x-cursor-client-version: cli-2026.07.23-e383d2b`, `x-cursor-client-type: cli`, `x-request-id`.
- **PKCE OAuth & Polling**:
  - Deep-link PKCE login generates verifier/challenge and redirects to `https://cursor.com/loginDeepControl`.
  - Polls `https://api2.cursor.sh/auth/poll?uuid=...&verifier=...` with exponential backoff (1s to 10s delay, up to 150 attempts).
  - Refresh trades refresh token via POST `https://api2.cursor.sh/auth/exchange_user_api_key`.
- **Usage & Quota Tracking (`packages/ai/src/usage/cursor.ts`)**:
  - Standard quota fetched from `https://api2.cursor.sh/auth/usage` (`parseCursorUsage`).
  - For OAuth credentials with WorkOS user sessions (`WorkosCursorSessionToken=${userId}::${accessToken}`), fetches personal usage from `https://cursor.com/api/usage-summary` (`parseCursorIndividualUsage`) and user profile email from `https://cursor.com/api/auth/me`.

### Catalog model handling
- **Descriptor Config (`packages/catalog/src/provider-models/descriptors.ts`)**:
  - Configured with provider ID `"cursor"`, default model `"claude-4.6-opus-high"`, runtime env var `CURSOR_ACCESS_TOKEN`, and catalog discovery env var `CURSOR_API_KEY`.
- **Cache Provider ID (`packages/catalog/src/provider-models/cache-provider-id.ts`)**:
  - Returns `"cursor:max-mode-v3"` to ensure context window cache invalidation.
- **Model Discovery (`packages/catalog/src/discovery/cursor.ts`)**:
  - `fetchCursorUsableModels` calls `GetUsableModels` (`/agent.v1.AgentService/GetUsableModels`) over Connect RPC.
  - Sets `cursorMaxMode` from `details.maxMode`, assigns `api: "cursor-agent"`, maps 1M max-mode vs 200k default context windows, and defaults `maxTokens` to 64,000.
  - Dynamic discovery merges with bundled reference models from `models.json`.

## Devin
The Devin integration (`devin-agent` API) communicates with Codeium Cascade backend services over HTTP/1.1 using the Connect protocol and gRPC/Protobuf messages. Its implementation spans provider stream logic in `packages/ai/src/providers/devin.ts` (`streamDevin`, `DEVIN_API_URL`), provider registry entry in `packages/ai/src/registry/devin.ts` (`devinProvider`), CLI OAuth handling in `packages/ai/src/registry/oauth/devin.ts` (`loginDevin`), and Connect protobuf schemas located in `packages/catalog/src/discovery/devin-gen/exa/*`.

### Special casings
* **Connect Binary Protocol & Frame Wrapping:** Transport uses Connect protocol over HTTP/1.1 targeting `https://server.codeium.com`. Request payloads are serialized Protobuf (`GetChatMessageRequestSchema`), compressed with gzip, and wrapped in 5-byte Connect streaming binary frame headers (`CONNECT_COMPRESSED_FLAG = 0x01`, 4-byte big-endian payload length). End-of-stream frames carry `CONNECT_END_STREAM_FLAG = 0x02` with JSON error trailers (`readConnectTrailerError`).
* **Frame Size Safeguards:** Reader enforces a 16MB frame payload cap (`MAX_CONNECT_FRAME_PAYLOAD`) in `streamDevin` to reject corrupt frame length headers prior to buffering.
* **Message Format Mapping:** System prompts are normalized (`normalizeSystemPrompts`) into the top-level `prompt` field. Messages are formatted in `buildChatMessagePrompts`:
  * User/developer messages map to `ChatMessageSource.USER` with deterministic message IDs (`cascadeId\0index\0role`).
  * Assistant messages map to `ChatMessageSource.SYSTEM` with text, `thinking`, `signature`, and `toolCalls`. Native Devin assistant turns preserve `responseId` or fall back to `bot-<uuid>`.
  * Tool results map to `ChatMessageSource.TOOL` with `toolCallId` and `toolResultIsError`.
* **Session Threading & Stop Patterns:** Session threading passes `options.conversationId` or `options.sessionId` as `cascadeId`. Default stop patterns include `<|user|>`, `<|bot|>`, `<|context_request|>`, `<|endoftext|>`, and `<|end_of_turn|>` (`DEVIN_DEFAULT_STOP_PATTERNS`). Tool selection specifies `auto` choice and ephemeral system prompt caching (`CacheControlType.EPHEMERAL`); `disableParallelToolCalls` is the inverse of the catalog's `compat.supportsParallelToolCalls`, so configs that natively allow parallel tools can use them.
* **Router Assignment:** Catalog configs with `compat.modelRouter` (currently `adaptive`) are server-side dispatchers, not valid `chatModelUid`s. Before chatting, `assignDevinModel` calls `AssignModel` with the current user/developer prompt and the turn's `cascadeId`, then sends the returned `modelUid` plus `modelAssignmentJwt` on the matching `GetChatMessage` request. A missing assignment fails the turn; the response's `actualModelUid` is surfaced as `AssistantMessage.upstreamModel`.

### Stream behavior
* **Protobuf Frame Streaming:** `streamDevin` reads chunked response bytes, parsing 5-byte Connect headers. Decompressed binary payloads are decoded into `GetChatMessageResponseSchema`.
* **Opaque Error Recovery (`invalid_argument`):** End-of-stream trailers with `invalid_argument` error codes (e.g. "internal error occurred") trigger history recovery in `streamDevin`. When eligible history request size exceeds 512KB (`LARGE_HISTORY_RECOVERY_BYTES`), the error is reclassified as `AIError.Flag.ContextOverflow` to invoke automated context pruning rather than failing as an invalid request.
* **Event Stream Translation:**
  * `deltaThinking` -> `thinking_start` / `thinking_delta` (signature populated from `deltaSignature`).
  * `deltaText` -> `text_start` / `text_delta`.
  * `deltaToolCalls` -> `toolcall_start` / `toolcall_delta`.
* **Throttled Streaming Tool Args:** Mid-stream argument parsing uses `parseStreamingJsonThrottled` (`toolLastParseLen`) to maintain O(N) performance on streaming JSON deltas before executing an authoritative `parseStreamingJson` upon `toolcall_end`.
* **Stop Reason Resolution:** Maps `StopReason.MAX_TOKENS` to `length`, active tool calls to `toolUse`, and defaults to `stop`.

### Auth & usage
* **Dual Auth Lifecycle:**
  * **Session Token Prefixing:** API key credentials are normalized via `normalizeDevinSessionToken` to ensure a `devin-session-token$` prefix.
  * **JWT Exchange:** `fetchDevinAuthMetadata` sends an initial Connect request (`GetUserJwtRequestSchema`) to `/exa.auth_pb.AuthService/GetUserJwt` using `apiKey` inside `MetadataSchema`. The server returns a `userJwt` (and optional server base URL override) which is included in subsequent chat request metadata.
* **CLI OAuth Flow:** `loginDevin` in `packages/ai/src/registry/oauth/devin.ts` executes a PKCE OAuth flow using `https://app.devin.ai/auth/cli/continue`. Tokens are exchanged at `https://api.devin.ai/auth/cli/token` (`exchangeDevinCliToken`) with expiration derived from JWT payload or a 1-year default fallback.
* **Usage Surface:** Streaming response frames include token counts (`msg.usage`: `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`), which feed directly into `calculateCost(model, output.usage)`, plus credit metering (`creditCost`, `committedCreditCost`, `committedAcuCost`) surfaced on `usage.credits`. Account plan and balance reporting uses `devinUsageProvider` (`packages/ai/src/usage/devin.ts`), which calls `SeatManagementService/GetUserStatus` with the native CLI identity and maps prompt/flow/flex credit buckets, dated daily/weekly quota windows, plan tier, overage balance, and account/org identity into `/usage`. Credit-billed plans omit undated percent windows so they do not render as exhausted quotas.

### Catalog model handling
* **Model Manager Config:** `devinModelManagerOptions` in `packages/catalog/src/provider-models/special.ts` configures dynamic discovery with `dynamicModelsAuthoritative: true` when an API key is available. `descriptors.ts` registers `devin` in `CATALOG_PROVIDERS` (`DEVIN_API_KEY`, OAuth provider `devin`, `defaultModel: "swe-1-6"`).
* **Static Seed:** Cascade's catalog is credential-scoped, so catalog generation without a `DEVIN_API_KEY` fetches nothing and never marks the provider authoritative — the previous `models.json` snapshot would otherwise be retained forever. `DEVIN_STATIC_MODELS` (`special.ts`) seeds both live SWE-1.6 lanes (`swe-1-6-fast`, `swe-1-6`) as `staticModels` and is pushed unconditionally by `scripts/generate-models.ts`; `CREDENTIAL_SCOPED_PROVIDERS` there keeps Devin out of generation-time fetch and drops its previous-snapshot rows (retiring the dead `devin/swe-1-6-slow` row). A configured `baseUrl` re-points the seed at that host.
* **Dynamic Discovery:** `fetchDevinModels` in `packages/catalog/src/discovery/devin.ts` invokes the unary Connect RPC `GetCliModelConfigs` (`/exa.api_server_pb.ApiServerService/GetCliModelConfigs`) with the native `chisel` discovery metadata from `packages/catalog/src/wire/devin.ts` and every supported display slot. `normalizeDevinModels` drops disabled/internal configs, converts `ClientModelConfig` into `ModelSpec<"devin-agent">` entries (defaulting to 200k context window, 64k max tokens), and preserves server-supplied output caps, pricing dimensions, tool/parallel-tool/image support, description, and `new`/`beta`/`recommended` badges. Exception: `DEVIN_IMAGE_BLIND_UIDS` strips the image modality from `swe-1-6`/`swe-1-6-fast`, whose configs advertise `supports_images` while the backend silently drops the `ChatMessagePrompt.images` field (verified live; every other model reads it). An empty-but-200 catalog response logs a stale-identity-pin warning. Router configs (`displayOption MODEL_ROUTER` or `isModelRouter`) stay standalone with `compat.modelRouter`.
* **Family Collapse:** Server `modelFamilyMetadata` effort lanes collapse first, keyed by the normalized family label and split into a `-fast` sibling for Fast Mode order 1; the server's default member becomes the collapsed spec's `requestModelId` and `thinking.defaultLevel`. The static `DEVIN_VARIANT_COLLAPSE_TABLE` then handles known families whose live config lacks family metadata.
* **Thinking Detection:** `supportsDevinThinking` prefers `modelInfo.modelFeatures.supportsThinking`; the label regex patterns (`/think|thinking|minimal|high|medium|low|xhigh|max|reasoning/i` vs `/\bno thinking\b/i`) are only the no-features fallback.
* **Compat Resolution:** `buildDevinCompat` in `packages/catalog/src/compat/devin.ts` sets `trustExplicitThinkingOnly: true` (`ResolvedDevinCompat`), preventing implicit effort ladder inference (`model-thinking.ts`).
* **Reasoning Effort Routing:** Devin models use sibling model routing instead of wire reasoning fields (`variant-collapse.ts`). `DEVIN_VARIANT_COLLAPSE_TABLE` maps model families (e.g. `gpt-5-6-luna`, `claude-opus-5`) across wire effort levels (`low`, `medium`, `high`, `xhigh`, `max`) to specific routed sibling model UIDs.
* **Selector Parity:** `DEVIN_VARIANT_COLLAPSE_TABLE.providerAliases` mirrors the native CLI's short labels (`opus`, `claude`/`sonnet`, `haiku`, `gemini`, `gpt`, `codex`, `swe`) and dotted upstream spellings (`gpt-5.6-terra`, `gemini-3.7-flash`, `swe-1.7-lightning`, `grok-4.6`, `glm-5.2`, `claude-haiku-4.5`). Provider aliases resolve only through `resolveVariantAlias(provider, id)` — they are deliberately absent from `resolveBareVariantAlias` and the reverse index, so a bare `gpt` or `opus` keeps its global meaning and cannot re-key config. Families collapsed only at discovery time carry no hand-table alias, so `resolveProviderModelReference` (`packages/coding-agent/src/config/model-resolver.ts`) also reverse-resolves any raw wire uid found in a live model's `thinking.effortRouting`; an exact live model id still wins.

## GitLab Duo

GitLab Duo is integrated via two distinct providers in OMP: **GitLab Duo Non-Agentic** (`gitlab-duo`), which proxies LLM requests through GitLab AI Gateway using standard HTTP/SSE sub-providers, and **GitLab Duo Agent** (`gitlab-duo-agent`), which connects to the GitLab Duo Workflow Service (DWS) over a WebSocket-based agent execution protocol. Entry modules for `gitlab-duo` are `packages/ai/src/providers/gitlab-duo.ts` and `packages/ai/src/registry/gitlab-duo.ts` (OAuth in `packages/ai/src/registry/oauth/gitlab-duo.ts`), while `gitlab-duo-agent` is implemented in `packages/ai/src/providers/gitlab-duo-workflow.ts`, `packages/ai/src/registry/gitlab-duo-workflow.ts` (OAuth in `packages/ai/src/registry/oauth/gitlab-duo-workflow.ts`), and catalog discovery in `packages/catalog/src/discovery/gitlab-duo-workflow.ts`.

### Special casings
- **`gitlab-duo` Model Routing & Proxying**: Maps Duo model identifiers (`duo-chat-opus-4-6`, `duo-chat-sonnet-4-6`, `duo-chat-gpt-5-1`, `duo-chat-gpt-5-codex`, etc.) in `MODEL_MAPPINGS` (`packages/ai/src/providers/gitlab-duo.ts`) to underlying provider types (`anthropic` or `openai`) and API flavors (`anthropic-messages`, `openai-completions`, `openai-responses`). Requests are proxied to GitLab AI Gateway endpoints (`https://cloud.gitlab.com/ai/v1/proxy/anthropic/` or `https://cloud.gitlab.com/ai/v1/proxy/openai/v1`) using direct access tokens exchanged via `getDirectAccessToken`.
- **`gitlab-duo-agent` ChatML Goal Generation**: Translates OMP conversation history (`context.messages`) into a single flattened rendered ChatML prompt string (`buildGitLabDuoWorkflowGoal`, `renderGitLabDuoWorkflowChatMl`, `buildGitLabDuoWorkflowInlineFlowConfig` in `packages/ai/src/providers/gitlab-duo-workflow.ts`). Guided by system prompt instructions in `gitlab-duo-workflow-chatml-note.md`.
- **`gitlab-duo-agent` Inline Flow Spec**: Sends an ambient inline workflow definition (`buildGitLabDuoWorkflowInlineFlowConfig`) with an `AgentComponent` named `"omp_agent"`, carrying OMP's system prompt in its template and user template `{{goal}}`, with UI log events (`on_agent_reasoning`, `on_agent_final_answer`, `on_tool_execution_success`, `on_tool_execution_failed`).
- **`gitlab-duo-agent` Byte Budget & Overflow**: Enforces goal byte limits (`GITLAB_DUO_WORKFLOW_GOAL_SOFT_OVERFLOW_BYTES` = 1MB, `GITLAB_DUO_WORKFLOW_GOAL_HARD_OVERFLOW_BYTES` = 2MB). Goals exceeding limits trigger an overflow error message (`buildGitLabDuoWorkflowGoalOverflowMessage`), driving automatic context compaction in the session loop.
- **`gitlab-duo-agent` Tool Execution Protocol**: Maps OMP tools into MCP tool definitions (`buildGitLabDuoWorkflowMcpTools`, `GitLabMcpToolDefinition`) sent in `startRequest.mcpTools`. Tool invocation requests (`runMCPTool`, `run_mcp_tool`) received over WebSocket are extracted (`extractGitLabDuoWorkflowAction`), dispatched to OMP tool execution (`mapGitLabDuoWorkflowActionToOmpTool`, `emitGitLabDuoWorkflowActionToolCall`), and returned via `buildGitLabDuoWorkflowActionResponse`.
- **`gitlab-duo-agent` Namespace Settings Auto-Enable**: REST setup routinely invokes `ensureGitLabDuoWorkflowSettings` posting `buildGitLabDuoWorkflowSettingsBody` to `/api/v4/ai/duo_workflows/settings` to enable required namespace flags (`duo_workflow`, `duo_workflow_service`, `duo_agent_platform`).

### Stream behavior
- **`gitlab-duo` Delegate Streaming**: Calls `streamAnthropic`, `streamOpenAICompletions`, or `streamOpenAIResponses` directly inside `streamGitLabDuo` (`packages/ai/src/providers/gitlab-duo.ts`), piping underlying SSE events verbatim after injecting Direct Access headers (`Authorization: Bearer <direct_access_token>`).
- **`gitlab-duo-agent` WebSocket Agent Loop**: Connects via WebSocket (`wss://<instance>/api/v4/ai/duo_workflows/ws` or DWS runway host `buildGitLabDuoWorkflowWebSocketUrl`). Receives raw JSON events parsed by `parseGitLabDuoWorkflowSocketData` and handled in `runGitLabDuoWorkflowSocket` (`packages/ai/src/providers/gitlab-duo-workflow.ts`).
- **`gitlab-duo-agent` Event Processing & Reasoning**: Extracts workflow checkpoints (`extractGitLabDuoWorkflowCheckpoint`), emitting incremental text (`emitGitLabDuoWorkflowText`) and chain-of-thought reasoning (`emitGitLabDuoWorkflowThinking`) derived from `on_agent_reasoning` UI log events.
- **`gitlab-duo-agent` Approval & Completion Signals**: Monitors workflow approval states (`isGitLabWorkflowApprovalStatus`: `PLAN_APPROVAL_REQUIRED`, `TOOL_CALL_APPROVAL_REQUIRED`) and completion states (`isGitLabWorkflowCompletionStatus`: `INPUT_REQUIRED`, `FINISHED`).
- **`gitlab-duo-agent` Timeouts & Health Deadlines**: Implements a 90-second idle deadline on the WebSocket (`GITLAB_DUO_WORKFLOW_IDLE_TIMEOUT_MS`). Socket inactivity triggers an abort and resume on the existing `workflowID`. REST setup calls are bounded by a 30-second timeout (`GITLAB_DUO_WORKFLOW_REST_TIMEOUT_MS`).
- **`gitlab-duo-agent` Bounded Restarts**:
  - Step limit overruns: Up to 4 restarts (`GITLAB_DUO_WORKFLOW_MAX_STEP_LIMIT_RESTARTS`) on fresh workflows when server reports max step limits (`isGitLabDuoWorkflowStepLimitMessage`).
  - Generic errors: Up to 1 retry (`GITLAB_DUO_WORKFLOW_MAX_GENERIC_ERROR_RETRIES`) for transient processing faults (`isGitLabDuoWorkflowGenericProcessingError`).
  - Stall detection: Up to 2 restarts (`GITLAB_DUO_WORKFLOW_MAX_STALL_RESTARTS`) when `detectGitLabDuoWorkflowStall` detects consecutive unchanged checkpoint content lengths at tool boundaries (`lastToolBoundaryContentLength`).

### Auth & usage
- **`gitlab-duo` Authentication**: Supports PAT via `GITLAB_TOKEN` or OAuth (`loginGitLabDuo` in `packages/ai/src/registry/oauth/gitlab-duo.ts`). Direct Access tokens are fetched via `POST /api/v4/ai/third_party_agents/direct_access` with `DuoAgentPlatformNext: true` (`getDirectAccessToken` in `packages/ai/src/providers/gitlab-duo.ts`) and cached for 25 minutes (`DIRECT_ACCESS_TTL_MS`). OAuth uses PKCE with `DEFAULT_CLIENT_ID` (overrideable via `GITLAB_CLIENT_ID` / `GITLAB_REDIRECT_URI`) and callback port 8080 (`packages/ai/src/registry/gitlab-duo.ts`).
- **`gitlab-duo-agent` Authentication**: Accepts PAT via `GITLAB_TOKEN` or OAuth (`loginGitLabDuoWorkflow` in `packages/ai/src/registry/oauth/gitlab-duo-workflow.ts`). Direct Access workflow tokens are obtained via `POST /api/v4/ai/duo_workflows/direct_access` (`requestGitLabDuoWorkflowDirectAccess`). OAuth relies on the official GitLab VS Code client ID (`GITLAB_DUO_WORKFLOW_OAUTH_CLIENT_ID = "36f2a70cddeb5a0889d4fd8295c241b7e9848e89cf9e599d0eed2d8e5350fbf5"`), redirecting to `vscode://gitlab.gitlab-workflow/authentication` (`pasteCodeFlow: true`).
- **`gitlab-duo-agent` Protocol Headers**: Requests include `x-gitlab-client-type: node-websocket`, `x-gitlab-language-server-version: 8.104.0`, and resource scope headers (`x-gitlab-project-id`, `x-gitlab-namespace-id`, `x-gitlab-root-namespace-id`) constructed by `buildGitLabDuoWorkflowWebSocketHeaders`.
- **Usage Tracking**: Neither provider uses a module under `packages/ai/src/usage/`. For `gitlab-duo-agent`, context occupancy is extracted from server checkpoint telemetry (`extractGitLabDuoWorkflowContextUsage` reading `agent_context_usage`), prioritizing `"Chat Agent"` and `"context_builder"` entries, and applied to prompt token estimates in `applyGitLabDuoWorkflowContextUsage`.

### Catalog model handling
- **Provider Descriptors**: Defined in `packages/catalog/src/provider-models/descriptors.ts`:
  - `gitlab-duo`: default model `duo-chat-opus-4-6`, `envVars: ["GITLAB_TOKEN"]`. Models static-built via `getGitLabDuoModels()`.
  - `gitlab-duo-agent`: default model `claude_sonnet_4_6_vertex`, `envVars: ["GITLAB_TOKEN"]`, `dynamicModelsAuthoritative: true`, manager options built by `gitLabDuoWorkflowModelManagerOptions` in `packages/catalog/src/provider-models/special.ts`.
- **Namespace Auto-Discovery**: `discoverGitLabDuoWorkflowNamespace` (`packages/catalog/src/discovery/gitlab-duo-workflow.ts`) locates the root namespace from explicit overrides, configuration, or workspace Git remotes (`discoverGitLabDuoWorkflowProject`). Models are discovered via GraphQL query `aiChatAvailableModels(rootNamespaceId:)` (`fetchGitLabDuoWorkflowModels`).
- **Context Window Resolution**: `resolveGitLabDuoWorkflowContextWindow` in `packages/catalog/src/discovery/gitlab-duo-workflow.ts` infers context window sizes from model refs (Claude Opus/Sonnet: 1,000,000; Haiku: 200,000; GPT-5: 400,000; default: 200,000).
- **Cache Partitioning**: `gitLabDuoWorkflowModelCacheProviderId` (`packages/catalog/src/provider-models/special.ts`) partitions dynamic catalog cache keys by hashing `apiKey`, `baseUrl`, `namespaceId`, `projectId`, and workspace `cwd`.
- **Catalog Generation Rules**: `scripts/generate-models.ts` excludes `gitlab-duo-agent` from static generation discovery to prevent bundling single-account namespace models into static catalogs, bundling only `buildGitLabDuoWorkflowFallbackModel` as a generic fallback seed.

## Pi Native
Pi Native is a lossless internal server/client transport protocol used when a pi-ai client (such as containerized `omp` or a sidecar agent slot) delegates request execution to an `omp auth-gateway` holding real provider credentials. Activated when a `Model` sets `transport: "pi-native"`, `streamSimple` in `packages/ai/src/stream.ts` short-circuits local provider resolution and POSTs the canonical `Context` directly to `/v1/pi/stream`. Primary entry modules are `packages/ai/src/providers/pi-native-client.ts` (`streamPiNative`) on the client side, `packages/ai/src/providers/pi-native-server.ts` (`parseRequest`, `encodeStream`, `formatError`) on the wire framing side, and `packages/ai/src/auth-gateway/server.ts` (`POST /v1/pi/stream` route handler) on the server side.

### Special casings
- **Lossless Pass-through & Dialect Absence**: Unlike OpenAI/Anthropic routes, `pi-native` is not a textual tool-call dialect (`docs/toolconv/pi-native.md`). Tool calls remain canonical pi-ai `ToolCall` content blocks inside `Context` and `AssistantMessageEvent`. It preserves first-class pi-ai fields (service tier, cache markers, thinking budgets, tool-choice variants, image blocks, tool-call IDs) without foreign-wire quantization.
- **Wire Request & Minimal Boundary Validation**: Client POSTs `{ modelId: "${provider}/${id}", context, options, stream: true }` to `${model.baseUrl}/v1/pi/stream` (`packages/ai/src/providers/pi-native-client.ts` `resolveStreamUrl`). `packages/ai/src/providers/pi-native-server.ts` `parseRequest` accepts `modelId`, `model.id`, or string `model` (supporting `streamProxy` target swaps). Validation checks only object shapes and arrays (`context.messages`, optional `context.systemPrompt`, `context.tools`), leaving message/tool internals unvalidated until downstream provider execution.
- **Option Allow-list & Non-Wire Key Stripping**: Server filters `options` against `ALLOWED_OPTION_KEYS` (31 keys) in `packages/ai/src/providers/pi-native-server.ts` `parseRequest`, silently dropping unknown keys for cross-version compatibility. Client strips runtime-only and function-valued fields (`signal`, `apiKey`, `fetch`, `onPayload`, `onResponse`, `onSseEvent`, `execHandlers`, `cursorExecHandlers`, `cursorOnToolResult`, `providerSessionState`) via `NON_WIRE_KEYS` in `packages/ai/src/providers/pi-native-client.ts` `buildWireOptions`.
- **Gateway Options Modification**: On the auth-gateway (`packages/ai/src/auth-gateway/server.ts`), sampling controls (`temperature`, `topP`, `topK`, `minP`, `stopSequences`, penalties) are stripped for `openai-codex-responses` models to prevent 400 errors, and passthrough request headers are captured (`captureRequestHeaders`) and merged under client headers.
- **Dispatch Precedence & Cache Bypass**: In `packages/ai/src/stream.ts` `streamSimple`, `model.transport === "pi-native"` takes precedence over extension-registered custom APIs (`getCustomApi`). `packages/ai/src/stream.ts` `assertExplicitOpenAIResponsesPromptCacheSupport` explicitly bypasses prompt cache assertions for `pi-native` transports because validation is deferred to the gateway-resolved model.

### Stream behavior
- **Verbatim SSE Framing**: Server's `encodeStream` (`packages/ai/src/providers/pi-native-server.ts`) streams each canonical `AssistantMessageEvent` verbatim as JSON-serialized SSE frames (`data: ${JSON.stringify(event)}\n\n`) terminated by `data: [DONE]\n\n`. Client (`packages/ai/src/providers/pi-native-client.ts` `streamPiNative`) uses `readSseJson` and pushes events directly into `AssistantMessageEventStream`.
- **Quadratic Partial Framing**: Delta events include rolling `partial: AssistantMessage` snapshots, making wire bandwidth O(N²) in turn length. This overhead is accepted for loopback / sidecar topologies where provider latency dominates.
- **Idle & First-Event Watchdogs**: Client wraps SSE streams with `iterateWithIdleTimeout` using `PI_STREAM_FIRST_EVENT_TIMEOUT_MS` and `PI_STREAM_IDLE_TIMEOUT_MS`. `isPiNativeProgressEvent` in `packages/ai/src/providers/pi-native-client.ts` ignores `type: "start"` events so initial setup does not reset the idle timeout.
- **Synthetic Terminal Boundaries**: If the SSE stream closes without a `done` or `error` event, client's `streamPiNative` constructs a synthetic assistant message via `makeSyntheticAssistant`. It pushes `{ type: "error", reason: "aborted", error: { ..., stopReason: "aborted", errorMessage: "stream closed without terminal event" } }` if caller aborted, or `{ type: "done", reason: "stop", message: { ..., stopReason: "stop" } }` on ungraceful clean close.
- **Server Iterator Exception Fallback**: If the server's `encodeStream` event iterator throws, it enqueues `data: {"type":"error","reason":"error","errorMessage":"..."}\n\n` followed by `data: [DONE]\n\n` so client iterators resolve instead of hanging.
- **Thinking loop guard**: `packages/ai/src/stream.ts` `streamSimple` wraps `streamPiNative` with `withThinkingLoopGuard` and `withProviderInFlightLimit`, ensuring Gemini, DeepSeek, and Grok runaway thinking streams abort with empty-content retryable errors.

### Auth & usage
- **Bearer Token Authorization**: Client (`packages/ai/src/providers/pi-native-client.ts` `buildHeaders`) passes `options.apiKey` (the gateway bearer token) in `Authorization: Bearer <apiKey>`, unless `model.headers.Authorization` is explicitly provided.
- **Gateway Credential Resolution**: Server route handler (`packages/ai/src/auth-gateway/server.ts`) validates the gateway bearer first. Missing/invalid tokens return `401` via `packages/ai/src/providers/pi-native-server.ts` `formatError`. Valid requests instantiate `buildGatewayApiKeyResolver` to fetch target provider credentials from `AuthStorage` using `sessionId`/`promptCacheKey` and format `"pi-native"`.
- **Error Envelope & Gateway Mapping**: Server emits errors via `formatError` as `{ error: { type, message } }` with HTTP status, `application/json`, and `Cache-Control: no-store`. Client's `decodeGatewayError` converts non-2xx responses into `AIError.AuthGatewayError`, preserving HTTP status, headers, and error `type`.
- **Usage & Header Tracking**: Token usage (`input`, `output`, `cacheRead`, `cacheWrite`, `cost`) is carried directly inside canonical `AssistantMessage` events. Client notifies response metadata (`x-request-id`, headers) via `notifyProviderResponse`.

### Catalog model handling
- **No Catalog Provider Entry**: `pi-native` is NOT a provider in `packages/catalog` (absent from `descriptors.ts` `CATALOG_PROVIDERS`, `src/provider-models/*`, `src/identity/classify.ts`, `src/model-thinking.ts`, and `scripts/generate-models.ts`).
- **Transport Override Property**: Defined solely as `transport?: "pi-native"` on the `Model` interface in `packages/catalog/src/types.ts`.
- **Local Catalog Resolution**: Metadata (pricing, context windows, max tokens, thinking configurations in `ThinkingConfig`, capability flags, provider priority) resolves locally from the catalog model definition (e.g. `anthropic/claude-3-5-sonnet`), while execution dispatch is routed to the gateway `baseUrl`.

---

# Catalog providers

Every `CATALOG_PROVIDERS` entry (`packages/catalog/src/provider-models/descriptors.ts`) that is not itself a transport, one section per provider id, alphabetical. These providers ride one of the transports documented above; each section covers only what the provider adds on top: special casings, auth and usage/quota tracking, and catalog wiring. Providers whose id IS a transport (anthropic, openai, openai-codex, azure, google, google-vertex, amazon-bedrock, bedrock-mantle, cursor, devin) are covered by their transport sections in the first half. Shared-engine providers (google-gemini-cli, google-antigravity, gitlab-duo, gitlab-duo-agent, kimi-code, moonshot, ollama, ollama-cloud) get both: engine mechanics above, per-id auth/usage/catalog wiring below.

## ai& (`aiand`)
ai& (`aiand`) is an OpenAI-compatible inference API provider (aiand.com) offering open-weights and flagship LLMs with dynamic model catalog discovery, reasoning effort metadata, and token usage pricing. Transport: OpenAI Chat Completions.

### Special casings
- **Base URL Normalization**: `normalizeAiandBaseUrl` in `packages/catalog/src/provider-models/openai-compat.ts` trims base URLs, defaults to `https://api.aiand.com/v1`, strips trailing slashes, and appends `/v1` if omitted. Nothing beyond the OpenAI Chat Completions pipeline.

### Auth & usage
- **API-Key Authentication**: Supports API key authentication configured via the `AIAND_API_KEY` environment variable (resolved via `getEnvApiKey("aiand")` in `packages/ai/src/stream.ts`) or explicit `apiKey` options.
- **Console Login & Validation**: Interactive login (`loginAiand` in `packages/ai/src/registry/aiand.ts`) prompts for an API key from `https://console.aiand.com/api-keys` and validates credentials via `createApiKeyLogin` against `https://api.aiand.com/v1/models`. Registered as `aiandProvider` in `packages/ai/src/registry/registry.ts`.

### Catalog model handling
- **Provider Descriptor**: Registered in `packages/catalog/src/provider-models/descriptors.ts` with `defaultModel: "moonshotai/kimi-k2.7-code"`, `envVars: ["AIAND_API_KEY"]`, and `dynamicModelsAuthoritative: true`.
- **Static Seed Models**: `AIAND_STATIC_MODELS` in `packages/catalog/src/provider-models/openai-compat.ts` provides 9 bundled offline model specs (`qwen/qwen3.6-27b`, `deepseek-ai/deepseek-v4-flash`, `google/gemma-4-31b-it`, `openai/gpt-oss-120b`, `deepseek-ai/deepseek-v4-pro`, `moonshotai/kimi-k2.7-code`, `moonshotai/kimi-k2.6`, `zai-org/glm-5.2`, `zai-org/glm-5.1`) created via `createAiandStaticModel` with effort reasoning ladders (`[low, medium, high]`, default `medium`). Seed models are pushed in `scripts/generate-models.ts` when authoritative online catalog generation is disabled.
- **Authoritative Discovery**: `aiandModelManagerOptions` in `packages/catalog/src/provider-models/openai-compat.ts` sets `dynamicModelsAuthoritative: true` and invalidates static IDs via `dropCachedModelIdsOnStaticMismatch: AIAND_STATIC_MODEL_IDS`. When an `apiKey` is supplied, `fetchDynamicModels` queries `/v1/models` using `fetchOpenAICompatibleModels` with `mapAiandModel`.
- **Thinking Configuration (`mapAiandThinking`)**: `mapAiandThinking` converts wire string array `reasoning_efforts` into pi `Effort` levels via `AIAND_EFFORT_BY_WIRE_VALUE` (`minimal`, `low`, `medium`, `high`, `xhigh`, `max`), setting `defaultLevel` from `reasoning_effort_default` when valid. Returns `undefined` if efforts are empty.
- **Cost Mapping (`mapAiandCost`)**: `mapAiandCost` extracts `input_per_1m` and `output_per_1m` USD token prices via `toPositiveNumber`. Non-USD org billing currencies (e.g. `currency !== "usd"`) fall back to `{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }` to avoid cost model corruption.
- **Model Attribute Mapping (`mapAiandModel`)**: `mapAiandModel` maps model descriptions or names (`toModelName`), checks `capabilities` for `"reasoning"` (attaching `thinking`) and `"vision"` (setting `input: ["text", "image"]`), and parses `context_window`.

## AIML API (`aimlapi`)
AIML API is an AI model aggregator platform providing access to diverse multi-vendor models through a unified OpenAI-compatible endpoint. It uses the OpenAI Chat Completions (`openai-completions`) transport pipeline.

### Special casings
- **Non-chat model filtering**: Dynamic model listings are filtered via `isLikelyAimlApiChatModelId` (`packages/catalog/src/provider-models/openai-compat.ts`), excluding audio, embedding, image, video, and TTS models matched by regex `/(?:^|[/:._-])(?:audio|embed|embedding|embeddings|i2i|i2v|image|speech|t2i|t2v|tts|video)(?:$|[/:._-])/i` or substrings (`dall-e`, `dalle`, `flux`, `imagen`, `sora`, `veo`, `whisper`).
- **Standard transport pipeline**: Uses un-customized `openai-completions` transport with no custom request transformers or error handlers (`packages/catalog/src/provider-models/openai-compat.ts`).

### Auth & usage
- **Environment authentication**: Configured to discover credentials via the `AIMLAPI_API_KEY` environment variable (`packages/catalog/src/provider-models/descriptors.ts`, `packages/ai/src/registry/aimlapi.ts`).
- **API authorization**: Transmits key as an HTTP `Authorization: Bearer <key>` header to target host `https://api.aimlapi.com/v1`.
- **Usage tracking**: Has no dedicated quota or usage parsing module registered in `packages/ai/src/usage/`.

### Catalog model handling
- **Descriptor registration**: Defined in `PROVIDER_DESCRIPTORS` with `defaultModel: "gpt-5.5-2026-04-23"`, `dynamicModelsAuthoritative: true`, and label `"AIML API"` (`packages/catalog/src/provider-models/descriptors.ts`).
- **Dynamic discovery**: Managed via `aimlApiModelManagerOptions()` in `packages/catalog/src/provider-models/openai-compat.ts`, which fetches `https://api.aimlapi.com/v1/models` and maps candidates via `filterModel` (`isLikelyAimlApiChatModelId`) and `mapWithBundledReference`.
- **Canonical resolution**: Multi-vendor namespaced models (e.g., `alibaba/qwen3-32b`, `x-ai/grok-4-3`) resolve canonical parameter defaults through `buildModelProviderPriorityRank`, where `aimlapi` participates in cross-provider identity lookup (`packages/catalog/src/identity/priority.ts`, `packages/catalog/test/canonical-limit-fallback.test.ts`).

## Alibaba Coding Plan (`alibaba-coding-plan`)
Alibaba Coding Plan provides coding-oriented model endpoints hosted on Alibaba Cloud's DashScope platform. It uses the `OpenAI Chat Completions` transport (`openai-completions`) connecting to international (`https://coding-intl.dashscope.aliyuncs.com/v1`) or mainland China (`https://coding.dashscope.aliyuncs.com/v1`) endpoints.

### Special casings
- **Structured API key parsing**: In `packages/ai/src/providers/openai-shared.ts`, when `alibabaCodingPlanAuth` is enabled (`packages/ai/src/providers/openai-completions.ts`), JSON-formatted API keys (emitted by login/OAuth storage) are parsed to extract the bearer `token` and override `baseUrl` via `enterpriseUrl`.
- **Low priority selection**: Included in `LOW_PRIORITY_PROVIDERS` (`packages/catalog/src/identity/priority.ts`), preventing `alibaba-coding-plan` models from winning ambiguous automatic role selection over primary providers.
- **Host classification**: Grouped under the `alibabaDashscope` host entry in `packages/catalog/src/hosts.ts` (`urlMarkers: ["dashscope", "token-plan."]`).
- **OAuth structured key flag**: Registered in `needsStructuredApiKey` (`packages/ai/src/registry/oauth/index.ts`) to serialize endpoint and token metadata (`enterpriseUrl`, `access`, `refresh`, `expires`) into a JSON key string.

### Auth & usage
- **Interactive login & endpoint selection**: `loginAlibabaCodingPlan` (`packages/ai/src/registry/alibaba-coding-plan.ts`) prompts users to select between International (`https://coding-intl.dashscope.aliyuncs.com/v1`), Mainland China (`https://coding.dashscope.aliyuncs.com/v1`), or a custom proxy base URL.
- **API key validation**: Validates credentials via `apiKeyValidation.validateOpenAICompatibleApiKey` against model `qwen3.5-plus` for preset endpoints, or `validateApiKeyAgainstModelsEndpoint` for custom URLs (`packages/ai/src/registry/alibaba-coding-plan.ts`).
- **Environment variable**: API key is retrieved via `ALIBABA_CODING_PLAN_API_KEY` (`packages/catalog/src/provider-models/descriptors.ts`).
- **Usage & quota tracking**: Unlike `alibaba-token-plan`, `alibaba-coding-plan` has no dedicated usage provider or quota tracking in `packages/ai/src/usage/`.

### Catalog model handling
- **Model manager options**: `alibabaCodingPlanModelManagerOptions` (`packages/catalog/src/provider-models/openai-compat.ts`) creates manager options via `createOpenAICompatibleModelManagerOptions` configured with `providerId: "alibaba-coding-plan"`, `defaultBaseUrl: "https://coding-intl.dashscope.aliyuncs.com/v1"`, and `mapWithBundledReference`.
- **Descriptor & defaults**: Registered descriptor (`packages/catalog/src/provider-models/descriptors.ts`) sets `defaultModel: "qwen3.7-plus"`.
- **Model source**: Model specifications are bundled in `packages/catalog/src/models.json` under `"alibaba-coding-plan"`.

### Stream behavior
- **Extended stream idle timeout**: Sets `streamIdleTimeoutMs` to 600,000 ms (`ALIBABA_CODING_PLAN_STREAM_IDLE_TIMEOUT_MS = 600_000` in `packages/catalog/src/compat/openai.ts`) to prevent premature stream watchdogs aborting during long initial generation delays before the first SSE event.

## QwenCloud Token Plan (`alibaba-token-plan`)
QwenCloud Token Plan provides model subscription access to Alibaba Cloud's Qwen and DeepSeek model suites. It operates using the OpenAI Chat Completions transport (`openai-completions` API schema) over HTTP POST JSON and Server-Sent Events (SSE) streaming (`packages/ai/src/providers/openai-shared.ts`).

### Special casings
- **Explicit Credential Isolation**: `resolveOpenAIRequestSetup` (`packages/ai/src/providers/openai-shared.ts`) requires an explicit `ALIBABA_TOKEN_PLAN_API_KEY` or `BAILIAN_TOKEN_PLAN_API_KEY` credential and explicitly disables the generic `$env.OPENAI_API_KEY` fallback to prevent key leakage to QwenCloud endpoints.
- **Region Base URL Routing**: Credentials support region-locked endpoints: International Singapore (`ALIBABA_TOKEN_PLAN_BASE_URL` = `https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1`) and China Beijing (`ALIBABA_TOKEN_PLAN_CN_BASE_URL` = `https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1`). Region keys are non-interchangeable; stored `baseUrl` overrides catalog defaults for inference and model discovery (`packages/catalog/src/provider-models/openai-compat.ts`).
- **Store Deduplication**: `hasAuthCredentialForProvider` (`packages/ai/src/auth/sqlite-credential-store.ts`) parses JSON compound credentials (`parseAlibabaTokenPlanCredential`) to compare inner `token` strings rather than raw JSON text.

### Auth & usage
- **Environment & Wire Credential**: Resolves `ALIBABA_TOKEN_PLAN_API_KEY` then `BAILIAN_TOKEN_PLAN_API_KEY`. Supports plain bearer keys (`sk-sp-...`) or serialized JSON strings (`{ token, cookie?, baseUrl? }`) parsed via `parseAlibabaTokenPlanCredential` and formatted via `serializeAlibabaTokenPlanCredential` (`packages/catalog/src/wire/alibaba-token-plan.ts`).
- **Interactive Login**: `loginAlibabaTokenPlan` (`packages/ai/src/registry/alibaba-token-plan.ts`) prompts for region (1=International, 2=China Beijing, 3=Custom URL), validates the API key via `${baseUrl}/models` (`validateApiKeyAgainstModelsEndpoint`), and accepts an optional `cs-data.qwencloud.com` browser `Cookie` header for quota reporting.
- **Console Quota Scraping**: `alibabaTokenPlanUsageProvider` (`packages/ai/src/usage/alibaba-token-plan.ts`) uses the stored `Cookie` header to fetch `secToken` from `https://home.qwencloud.com/tool/user/info.json` and issues a POST to `https://cs-data.qwencloud.com/data/api.json?product=sfm_bailian&action=IntlBroadScopeAspnGateway&api=zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/usage` with URL-encoded parameters.
- **Quota Windows & Ranking**: Parses `per5HourPercentage`/`per5HourResetTime` (5-hour window, `credits:5h`) and `per1WeekPercentage`/`per1WeekResetTime` (7-day window, `credits:7d`). `alibabaTokenPlanRankingStrategy` configures `credits:5h` as primary limit (5h window) and `credits:7d` as secondary limit (7d window).

### Catalog model handling
- **Authoritative Discovery**: Configured with `dynamicModelsAuthoritative: true` (`packages/catalog/src/provider-models/descriptors.ts`). `/models` discovery is subscription-scoped; a successful endpoint response is authoritative and overrides static fallback catalogs even if empty (`packages/catalog/scripts/generate-models.ts`).
- **Discovery Filtering & Overrides**: `isAlibabaTokenPlanChatModelId` (`packages/catalog/src/provider-models/openai-compat.ts`) filters non-chat prefixes (`qwen-audio-`, `qwen-image-`, `text-embedding-`, `wan2.7-`). Discovered `deepseek-v4*` models are mapped with `reasoning: true` and effort thinking (`[Effort.High, Effort.Max]`).
- **Static Catalog Fallback**: `ALIBABA_TOKEN_PLAN_STATIC_MODELS` provides static catalog seed fallback when uncredentialed or when discovery fails (`packages/catalog/scripts/generate-models.ts`).

## Baseten (`baseten`)
Baseten provides high-performance infrastructure for hosting open-weight LLMs (including Moonshot Kimi, DeepSeek, Zhipu GLM, and gpt-oss series). Requests execute over the OpenAI Chat Completions transport (`openai-completions` API) targeting default base URL `https://inference.baseten.co/v1`.

### Special casings
- Nothing beyond the `openai-completions` pipeline.

### Auth & usage
- **API Key Authentication**: Authenticates via `BASETEN_API_KEY` (`packages/catalog/src/provider-models/descriptors.ts`). Login flow `loginBaseten` (`packages/ai/src/registry/baseten.ts`) uses `createApiKeyLogin` pointing to dashboard `https://app.baseten.co/settings/api_keys` with placeholder `bt_...`.
- **Endpoint Validation**: API key validation in `loginBaseten` (`packages/ai/src/registry/baseten.ts`) verifies credentials via `GET https://inference.baseten.co/v1/models` (`models-endpoint` validation kind).
- **Usage Accounting**: Reconciles token usage and pricing through standard OpenAI Chat Completions usage handling (`calculateOpenAIUsageAccounting` in `packages/ai/src/providers/openai-shared.ts`).

### Catalog model handling
- **Provider Descriptor**: Registered in `CATALOG_PROVIDERS` (`packages/catalog/src/provider-models/descriptors.ts`) with `id: "baseten"`, `defaultModel: "moonshotai/Kimi-K2.7-Code"`, `envVars: ["BASETEN_API_KEY"]`, `dynamicModelsAuthoritative: true`, and discovery label `"Baseten"`.
- **Model Manager Options**: `basetenModelManagerOptions` in `packages/catalog/src/provider-models/openai-compat.ts` configures model resolution with `defaultBaseUrl: "https://inference.baseten.co/v1"` and `requireApiKey: true`.
- **Dynamic Model Discovery & Pricing**: `fetchDynamicModels` queries `https://inference.baseten.co/v1/models`. `mapModel` parses raw record metadata including `supported_features`, `input_modalities` (`image` for vision capability), context and completion token bounds (`context_length`, `max_completion_tokens`), and per-million token pricing (`prompt`, `completion`, `input_cache_read`).
- **Native Reasoning Identification**: Flags `reasoning: true` for `openai/gpt-oss-120b`, `deepseek-ai/DeepSeek-V4-Pro`, and `zai-org/GLM-5.2` when dynamic features list `reasoning` or `reasoning_effort`.
- **Reasoning Effort Tier Restrictions**: `getModelDefinedEfforts` in `packages/catalog/src/model-thinking.ts` and `basetenModelManagerOptions` in `packages/catalog/src/provider-models/openai-compat.ts` restrict reasoning effort tiers for both `zai-org/GLM-5.2` (`isGlm52ReasoningEffortModelId`) and `openai/gpt-oss-120b` (`isOpenAIGptOssModelId`) routes to the two-tier `HIGH_MAX_REASONING_EFFORTS` scale (`[high, max]`).
- **Identity Priority & Host Matching**: Prioritized in `PROVIDER_PRIORITY` (`packages/catalog/src/identity/priority.ts`) and matched via URL marker `baseten.co` in `packages/catalog/src/hosts.ts`.

## Cerebras (`cerebras`)
Cerebras provides ultra-fast inference on wafer-scale engine hardware for open-weights models such as `zai-glm-4.7`, `gpt-oss-120b`, `qwen-3-235b-a22b-instruct-2507`, and `gemma-4-31b`. It communicates via the OpenAI Chat Completions (`openai-completions`) transport.

### Special casings
- **`all_strict` Tool Mode**: `toolStrictMode` defaults to `"all_strict"` for Cerebras in `packages/catalog/src/compat/openai.ts` (`isCerebras`), forcing `strict: true` across all passed tool schemas in `openai-completions.ts` (`AppliedToolStrictMode`).
- **`supportsUsageInStreaming: false`**: Configured via `supportsUsageInStreaming: !isCerebras` in `packages/catalog/src/compat/openai.ts` to suppress `stream_options: { include_usage: true }` in `openai-completions.ts`, preventing API rejections when streaming responses.
- **Empty 400/413 Context-Overflow Detection**: Cerebras context and payload overflow errors return empty HTTP 400 or 413 response bodies. Recognized in `packages/ai/src/error/flags.ts` by `OVERFLOW_NO_BODY_PATTERN` (`/\b4(00|13)\s*(status code)?\s*\(no body\)/i`), allowing `isContextOverflow` to set `Flag.ContextOverflow` so agent sessions auto-compact context rather than failing terminally.
- **Gemma Image Input Serialization**: Models matching `gemma-4-31b` serialize attached image blocks into Chat Completions `image_url` data URIs (`data:image/png;base64,...`) when processed by `convertMessages` in `packages/ai/src/providers/openai-completions.ts`.

### Auth & usage
- **API Key Login**: Configured via `loginCerebras` in `packages/ai/src/registry/cerebras.ts` using `createApiKeyLogin` with default validation model `gpt-oss-120b` and base URL `https://api.cerebras.ai/v1`.
- **Environment Resolution**: Registered as `cerebrasProvider` in `packages/ai/src/registry/cerebras.ts` and catalog descriptor `descriptors.ts` using environment variable `CEREBRAS_API_KEY`.

### Catalog model handling
- **Provider Registration**: Catalog entry in `descriptors.ts` (`CATALOG_PROVIDERS`) sets `id: "cerebras"`, `defaultModel: "zai-glm-4.7"`, and delegates option construction to `cerebrasModelManagerOptions`.
- **Manager Options & Discovery**: `cerebrasModelManagerOptions` in `packages/catalog/src/provider-models/openai-compat.ts` uses `createOpenAICompatibleModelManagerOptions` with `providerId: "cerebras"` and default base URL `https://api.cerebras.ai/v1`.
- **Gemma Image Capability Override**: `applyCerebrasDiscoveryOverrides` in `packages/catalog/src/provider-models/openai-compat.ts` checks `CEREBRAS_IMAGE_INPUT_MODEL_IDS` (`Set(["gemma-4-31b"])`) during model mapping to explicitly append `"image"` to `input` capabilities (`input: ["text", "image"]`), overriding missing vision capability flags in remote endpoint discovery metadata.

## Cloudflare AI Gateway (`cloudflare-ai-gateway`)
Cloudflare AI Gateway proxies requests through Cloudflare's edge infrastructure to model providers, utilizing the Anthropic Messages transport. Base URLs require substituting `<account>` and `<gateway>` path placeholders with the user's specific Cloudflare account ID and gateway slug in model configurations.

### Special casings
- **Custom Authorization Header**: Uses `cf-aig-authorization: Bearer <key>` instead of standard `x-api-key` or `Authorization` headers (`packages/ai/src/providers/anthropic.ts:buildAnthropicHeaders`).
- **Suppressed Client Credentials**: `apiKey` and `authToken` are set to `null` on the Anthropic client options object so credentials travel exclusively via pre-built default headers (`packages/ai/src/providers/anthropic.ts:3027-3037`).
- **Signing Proxy Detection**: URLs matching `gateway.ai.cloudflare.com/.+/anthropic` are recognized via `isCloudflareAnthropicGateway` as Anthropic signing proxies (`packages/catalog/src/compat/anthropic.ts:CLOUDFLARE_ANTHROPIC_GATEWAY_URL_MARKER`, `isAnthropicSigningProxyUrl`).
- **OAuth Session Protection**: Excluded from receiving Claude OAuth `account_uuid` headers to prevent identity leakage to third-party proxies (`packages/coding-agent/src/session/session-metadata.ts`).

### Auth & usage
- **Authentication Prompt**: `loginCloudflareAiGateway` prompts for a Cloudflare AI Gateway token/API key (`cf-aig-...`) and directs users to Cloudflare's authentication documentation (`packages/ai/src/registry/cloudflare-ai-gateway.ts`).
- **Environment Variable**: Reads API key credentials from `CLOUDFLARE_AI_GATEWAY_API_KEY` (`packages/catalog/src/provider-models/descriptors.ts`).
- **Account & Gateway Resolution**: Uses `https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/anthropic` as the base URL template where `<account>` and `<gateway>` placeholders are replaced with the user's Cloudflare account ID and gateway slug (`packages/catalog/src/provider-models/openai-compat.ts:cloudflareAiGatewayModelManagerOptions`).

### Catalog model handling
- **Descriptor & Default Model**: Wired via `anthropicMessagesDescriptor` with default model `anthropic/claude-opus-4-8` (`packages/catalog/src/provider-models/descriptors.ts`).
- **Static Fallback Model**: Injects `CLOUDFLARE_FALLBACK_MODEL` (`claude-sonnet-4-5`, reasoning enabled, 200k context) during catalog generation when no models are returned by discovery (`packages/catalog/scripts/generated-policies.ts`, `packages/catalog/scripts/generate-models.ts:536-538`).
- **Priority Wiring**: Assigned catalog priority level 39 in `providerPriority` (`packages/catalog/src/identity/priority.ts`).

## CoreWeave Serverless Inference (`coreweave`)
CoreWeave Serverless Inference provides hosted AI model inference powered by Weights & Biases (W&B) infrastructure at `https://api.inference.wandb.ai/v1`. It operates using the "OpenAI Chat Completions" transport.

### Special casings
- **Project Header Injection**: `applyCoreWeaveProjectHeader` in `packages/ai/src/providers/openai-shared.ts` intercepts requests for `coreweave` models in `resolveOpenAIRequestSetup` and injects the required `OpenAI-Project` HTTP header. Header resolution is handled by `resolveCoreWeaveProject` and `coreWeaveProjectHeaders` in `packages/catalog/src/wire/coreweave.ts`, checking `COREWEAVE_PROJECT`, `WANDB_INFERENCE_PROJECT`, or `WANDB_ENTITY`/`WANDB_PROJECT`. `removeBlankCoreWeaveProjectHeaders` removes empty project headers to allow fallback to environment variables.
- **GPT-OSS Reasoning Transformation**: In `openAiCompletionsDescriptor` (`packages/catalog/src/provider-models/openai-compat.ts`), models starting with `openai/gpt-oss-` are transformed to set `reasoning: true` and configured with effort-based thinking (`Effort.Low`, `Effort.Medium`, `Effort.High`).

### Auth & usage
- **API Key & Environment Resolution**: Authenticates via `COREWEAVE_API_KEY`, falling back to `WANDB_API_KEY` (`descriptors.ts`, `getEnvApiKey` in `packages/ai/src/stream.ts`).
- **Login Flow & Project Validation**: Interactive login is configured in `loginCoreWeave` (`packages/ai/src/registry/coreweave.ts`), referencing settings at `https://wandb.ai/settings`. `requireCoreWeaveProjectHeaders` enforces that a valid `OpenAI-Project` header can be constructed from environment variables before validating credentials against `https://api.inference.wandb.ai/v1/models`.

### Catalog model handling
- **Descriptor Configuration**: Registered in `CATALOG_PROVIDERS` in `packages/catalog/src/provider-models/descriptors.ts` with ID `coreweave`, default model `openai/gpt-oss-120b`, and discovery label `"CoreWeave Serverless Inference"`.
- **Model Manager & Dynamic Discovery**: `coreWeaveModelManagerOptions` in `packages/catalog/src/provider-models/openai-compat.ts` constructs provider options for `https://api.inference.wandb.ai/v1` via `createSimpleOpenAICompletionsOptions`, dynamically supplying `coreWeaveProjectHeaders(Bun.env)` on catalog model fetches.

## DeepSeek (`deepseek`)
The DeepSeek provider interfaces directly with DeepSeek's API (`https://api.deepseek.com/v1`) using the OpenAI Chat Completions transport (`openai-completions`). It powers official DeepSeek models like `deepseek-v4-pro` and `deepseek-v4-flash`, implementing provider-specific reasoning flags, token-stripping stream filters, custom prompt-cache usage accounting, and Bearer-sanitized API key storage.

### Special casings
- **Reasoning Compat & `whenThinking` Swap**: Direct DeepSeek reasoning models (`isDirectDeepseekReasoning` in `packages/catalog/src/compat/openai.ts`) configure `supportsToolChoice: false` (omitting `tool_choice` on reasoning calls) and `reasoningDisableMode: "zai-thinking-disabled"`. Active reasoning activates a `whenThinking` compat pointer-swap that merges `extraBody: { thinking: { type: "enabled" } }`. Setting any `tool_choice` drops reasoning fields (`disableReasoningOnToolChoice: true`). See [Provider compat reference](./provider-compat-reference.md).
- **Reasoning Content Invariants**: Replays exact prior `reasoning_content` on follow-up turns (`requiresReasoningContentForToolCalls` and `requiresReasoningContentForAllAssistantTurns`), rejecting synthetic `"."` placeholders (`allowsSyntheticReasoningContentForToolCalls: false`). Empty assistant content on tool turns is promoted to `"."` (`requiresAssistantContentForToolCalls: true`).
- **Chat Template Token Stripping & Healing**: `stripDeepseekSpecialTokens` in `packages/ai/src/providers/openai-completions.ts` buffers and strips raw streamed chat-template tokens (`<｜User｜>`, `<｜Assistant｜>`, etc.). In-band DSML tool blocks (`<｜DSML｜tool_calls>`) are healed via `StreamMarkupHealing` with pattern `"dsml"`.
- **Wire Parameters & Stream Watchdog**: Output token ceiling uses `max_tokens` (`maxTokensField: "max_tokens"`). Inter-event stream watchdog extends to 300 s (`DEEPSEEK_REASONING_STREAM_IDLE_TIMEOUT_MS`) to allow for lengthy prefill/thinking delays. `supportsStrictMode: true` is enabled for function tools.

### Auth & usage
- **API Key Normalization & Login**: `normalizeDeepSeekApiKey` in `packages/ai/src/registry/deepseek.ts` trims inputs and strips any leading `Bearer ` prefix (case-insensitive), throwing `ApiKeyRequiredError` if empty. Interactive `loginDeepSeek` wraps `onPrompt` with normalization and validates against `/v1/models`. Runtime credential relies on `DEEPSEEK_API_KEY`.
- **Prompt-Cache Usage Accounting**: DeepSeek returns top-level usage fields `prompt_cache_hit_tokens` and `prompt_cache_miss_tokens`. `calculateOpenAIUsageAccounting` (`packages/ai/src/providers/openai-shared.ts`) detects `isDeepSeekUsage`, mapping net input tokens to `Math.max(0, promptTokens - cachedTokens)` (the miss count) and setting `cacheWrite` to `0` to avoid double-charging uncached prompt tokens as explicit cache writes.

### Catalog model handling
- **Descriptor & Manager**: Catalog entry `deepseek` in `packages/catalog/src/provider-models/descriptors.ts` sets `defaultModel: "deepseek-v4-pro"` and uses `deepseekModelManagerOptions` (`packages/catalog/src/provider-models/openai-compat.ts`) targeting `https://api.deepseek.com`. Built-in discovery filters for tool-calling `deepseek-v4` models.
- **Reasoning Effort Ladders**: Configures `HIGH_MAX_REASONING_EFFORTS` (`[high, max]`) for `deepseek-v4-pro` and `LOW_HIGH_MAX_REASONING_EFFORTS` (`[low, high, max]`) for `deepseek-v4-flash`. Normalizes `xhigh` effort requests to `max` across DeepSeek models (`isDeepseekModelIdOrName`).

## Fire Pass (`firepass`)
Fire Pass is a Fireworks AI subscription tier providing dedicated high-throughput router access to Kimi K2.6 Turbo. It uses the OpenAI Chat Completions transport (`https://api.fireworks.ai/inference/v1`) with Fireworks router endpoint translation.

### Special casings
- **Wire Model ID Translation (`wireModelIdMode: "firepass"`)**: `buildOpenAICompat` (`packages/catalog/src/compat/openai.ts`) assigns `wireModelIdMode: "firepass"` for `firepass` or Fireworks fast router models (`isFireworksFastRouter`). `applyWireModelIdTransform` (`packages/ai/src/providers/openai-shared.ts`) uses `toFirepassWireModelId` (`packages/catalog/src/fireworks-model-id.ts`) to convert friendly catalog IDs (e.g., `kimi-k2.6-turbo`) into Fireworks router wire IDs (`accounts/fireworks/routers/kimi-k2p6-turbo`) by replacing dots with `p`.
- **Max Output Token Cap**: Output tokens are capped at 32,768 (`FIREWORKS_KIMI_MAX_TOKENS`) via `clampFireworksKimiMaxTokens` (`packages/catalog/src/provider-models/openai-compat.ts`) and `applyKimiMaxTokensCap` (`packages/catalog/scripts/generate-models.ts`) to prevent runaway reasoning traces on Kimi K2 models.
- **Five-Tier Thinking Effort**: `getThinkingConfig` (`packages/catalog/src/model-thinking.ts`) maps `firepass` to `FIVE_TIER_EFFORTS_LOW_TO_MAX` (`low`, `medium`, `high`, `xhigh`, `max`).

### Auth & usage
- **Authentication**: Defined in `packages/ai/src/registry/firepass.ts` (`firepassProvider`, `loginFirepass`) using environment variable `FIREPASS_API_KEY` (`fpk_...`).
- **Validation**: Dedicated `fpk_...` keys only authorize the router endpoint and fail on `/v1/models`. `loginFirepass` uses `validation.kind: "chat-completions"` targeting `accounts/fireworks/routers/kimi-k2p6-turbo` directly.

### Catalog model handling
- **Descriptor**: Registered in `packages/catalog/src/provider-models/descriptors.ts` (`id: "firepass"`, `defaultModel: "kimi-k2.6-turbo"`, `envVars: ["FIREPASS_API_KEY"]`).
- **Manager Options**: `firepassModelManagerOptions` (`packages/catalog/src/provider-models/openai-compat.ts`) returns a static configuration without dynamic discovery, relying on the canonical bundled catalog in `models.json`.
- **Script Cleanups**: `dropFireworksWireIds` (`packages/catalog/scripts/generate-models.ts`) strips internal `accounts/fireworks/` wire IDs during catalog generation.

## Fireworks (`fireworks`)
Fireworks (`packages/ai/src/registry/fireworks.ts`) is a high-throughput AI inference provider serving serverless and dedicated models via an OpenAI-compatible HTTP REST API (`https://api.fireworks.ai/inference/v1`). It uses the OpenAI Chat Completions transport (`streamOpenAICompletions` in `packages/ai/src/providers/openai-completions.ts`) with custom model ID wire translation, thinking parameter conflict resolution, and priority tier handling.

### Special casings
- **`wireModelIdMode: "fireworks"` & Wire Model ID Transformation**: `applyWireModelIdTransform` (`packages/ai/src/providers/openai-shared.ts`), enabled by `wireModelIdMode: "fireworks"` resolved in `packages/catalog/src/compat/openai.ts`, invokes `toFireworksWireModelId` (`packages/catalog/src/fireworks-model-id.ts`) to prefix public catalog model IDs with `accounts/fireworks/models/` and convert version dots to `p` (e.g., `glm-5.1` maps to `accounts/fireworks/models/glm-5p1`). Public catalog normalization uses `toFireworksPublicModelId`.
- **Fast Router & Fire Pass Model Wire Routing**: Models ending in `-fast` (`isFireworksFastModelId` in `packages/catalog/src/fireworks-model-id.ts`) represent high-throughput serving routes. `buildOpenAICompat` (`packages/catalog/src/compat/openai.ts`) resolves `isFireworksFastRouter` to `wireModelIdMode: "firepass"`, mapping wire dispatch via `toFirepassWireModelId` to `accounts/fireworks/routers/<id>-fast` instead of `accounts/fireworks/models/`.
- **`dropThinkingWhenReasoningEffort` Conflict Resolution**: `compat.dropThinkingWhenReasoningEffort` is set to `true` for Fireworks in `packages/catalog/src/compat/openai.ts`. When `reasoning_effort` is present in request parameters, `applyOpenAIExtraBody` (`packages/ai/src/providers/openai-shared.ts`) deletes top-level `thinking` toggle objects to prevent HTTP 400 errors from Fireworks rejecting both parameters simultaneously.
- **Qwen Thinking Format Override**: `buildOpenAICompat` (`packages/catalog/src/compat/openai.ts`) assigns `thinkingFormat: "openai"` to Fireworks-hosted Qwen models (e.g., `fireworks/qwen3.7-plus`) rather than `"qwen"`, forcing the use of `reasoning_effort` instead of Alibaba DashScope's `enable_thinking` boolean (which Fireworks rejects with 400).
- **Service Tier / Priority Control**: `excludesInferredOpenAIServiceTier` and `shouldSendServiceTier` (`packages/ai/src/types.ts`) allow `fireworks` requests to send `service_tier: "priority"` when `providers.fireworksTier: priority` (or `/fast` mode) is enabled, suppressing unneeded tier defaults.
- **Stream Markup Healing**: `modelMayLeakDsmlToolCalls` in `packages/ai/src/utils/stream-markup-healing.ts` flags `provider === "fireworks"`, invoking `ThinkingInbandScanner` to buffer and clean leaked DSML XML markup from visible text deltas.

### Auth & usage
- **API Key Authentication**: Authenticates with HTTP Bearer tokens (`Authorization: Bearer ${apiKey}`) configured via `FIREWORKS_API_KEY` (resolved via `getEnvApiKey` in `packages/ai/src/stream.ts`).
- **Control-Plane Login Validation**: `/login fireworks` (`loginFireworks` in `packages/ai/src/registry/fireworks.ts`) validates credentials against the static control-plane catalog `GET /v1/accounts/fireworks/models?filter=supports_serverless%3Dtrue&pageSize=1` rather than `/v1/models` (the inference endpoint serves per-account deployments and returns 500 for accounts without active deployments).
- **Usage Accounting**: Token usage is processed via standard `openai-completions` accounting in `calculateOpenAIUsageAccounting` (`packages/ai/src/providers/openai-shared.ts`), extracting `prompt_tokens`, `completion_tokens`, `prompt_tokens_details.cached_tokens`, and `completion_tokens_details.reasoning_tokens`.

### Catalog model handling
- **Descriptor Registration**: Registered in `CATALOG_PROVIDERS` (`packages/catalog/src/provider-models/descriptors.ts`) with `id: "fireworks"`, `defaultModel: "kimi-k2.7-code"`, `envVars: ["FIREWORKS_API_KEY"]`, and `createModelManagerOptions: fireworksModelManagerOptions`.
- **Control-Plane Discovery**: `fireworksModelManagerOptions` (`packages/catalog/src/provider-models/openai-compat.ts`) enumerates models via control-plane catalog `GET /v1/accounts/fireworks/models?filter=supports_serverless=true` instead of `/v1/models`, converting resource names (`accounts/fireworks/models/<id>`) to public catalog IDs using `toFireworksPublicModelId`. Internal account resource IDs are pruned during catalog generation in `scripts/generate-models.ts`.
- **Fast Variant Seeding**: `buildFireworksFastSeed` (`packages/catalog/src/provider-models/openai-compat.ts`) programmatically generates `-fast` catalog seeds (e.g., `kimi-k2.7-code-fast`, `glm-5.1-fast`) paired to curated base models, retaining base pricing while targeting high-speed router wire paths.
- **Kimi Family Output Token Caps**: `clampFireworksKimiMaxTokens` (`packages/catalog/src/provider-models/openai-compat.ts`) clamps output budget `maxTokens` to `FIREWORKS_KIMI_MAX_TOKENS = 32_768` for Kimi K2.5/K2.6 models (`isFireworksKimiK2ModelId`) to prevent runaway reasoning traces caused by Fireworks' reported `max_completion_tokens: 65536`. `kimi-k2.7-code` is explicitly excluded from this cap and allowed up to its full output budget (`FIREWORKS_KIMI_K27_CODE_MAX_TOKENS = 65_536`).
- **Reasoning Effort Ladders**: `FIREWORKS_REASONING_EFFORT_MAP` (`packages/catalog/src/model-thinking.ts`) maps `minimal -> "none"` (disabling reasoning on Fireworks) while passing `low`, `medium`, and `high` through. Restrictive models (e.g., `minimax-m2.7`, `gpt-oss-120b`) override effort ladders to `[low, medium, high]` in catalog definitions.

## GitHub Copilot (`github-copilot`)
GitHub Copilot routes multi-vendor model execution (OpenAI GPT, Anthropic Claude, xAI Grok, Google Gemini) through GitHub's unified proxy endpoints (`https://api.githubcopilot.com` or Enterprise `copilot-api.<domain>`). The provider dynamically dispatches across three wire transports: OpenAI Chat Completions, OpenAI Responses, and Anthropic Messages.

### Special casings
- **Dynamic Copilot Headers & Initiator**: `buildCopilotDynamicHeaders` (`packages/ai/src/registry/github-copilot.ts`) injects per-request headers `X-Initiator` (`"user"` vs `"agent"` inferred from message history via `inferCopilotInitiator` or overridden via `getCopilotInitiatorOverride`), `Openai-Intent: conversation-edits`, and `Copilot-Vision-Request: true` when `hasCopilotVisionInput` detects image payloads in user or tool result blocks.
- **API Versioning & Wire Headers**: `COPILOT_API_HEADERS` (`packages/catalog/src/wire/github-copilot.ts`) mandates `User-Agent: opencode/1.3.15` (`COPILOT_USER_AGENT`) and `X-GitHub-Api-Version: 2026-06-01` (`COPILOT_API_VERSION`). `restorableHeaderFallback` in `packages/catalog/src/provider-models/openai-compat.ts` preserves static wire headers during offline cache rehydration.
- **Base URL & Endpoint Resolution**: `resolveGitHubCopilotBaseUrl` (`packages/ai/src/registry/github-copilot.ts`) and `parseGitHubCopilotApiKey` (`packages/catalog/src/wire/github-copilot.ts`) parse custom `enterpriseUrl` and `apiEndpoint` properties embedded in API keys or credentials, defaulting to `https://api.githubcopilot.com` (`PERSONAL_GITHUB_COPILOT_BASE_URL`).
- **OpenAI & Responses Compat Flags**:
  - `supportsReasoningParams`: Disabled (`supportsReasoningParams: provider !== "github-copilot"`) in `packages/catalog/src/compat/openai.ts` because Copilot Chat Completions endpoints reject `reasoning_effort` and reasoning fields with HTTP 400.
  - `supportsDeveloperRole`: Disabled for Chat Completions specs (`openai-compat.ts`) but enabled on OpenAI Responses specs.
  - `strictResponsesPairing`: Enabled (`spec.provider === "github-copilot"`) in `packages/catalog/src/compat/openai.ts`, forcing strict pairing between tool calls and tool result messages on Responses endpoints.
  - `supportsImageDetailOriginal`: Disabled (`supportsImageDetailOriginal: false`), clamping image detail from `"original"` to `"auto"` to avoid proxy 400/422 rejection.
- **Anthropic Wire & Signing Compat**:
  - `supportsEagerToolInputStreaming`: Disabled (`supportsEagerToolInputStreaming: false`) in `packages/catalog/src/compat/anthropic.ts` and fine-grained tool streaming beta headers are omitted because the Copilot Anthropic proxy rejects `eager_input_streaming` (#2558).
  - Recognized as a signing host (`buildAnthropicCompat`), suppressing unsigned thinking replay for Claude models (#2851).

### Auth & usage
- **Device-Flow OAuth (`opencode` OAuth app)**:
  - `loginGitHubCopilot` in `packages/ai/src/registry/oauth/github-copilot.ts` executes the GitHub Device Authorization Flow using client ID `Ov23li8tweQw6odWQebz` (`CLIENT_ID`) and scope `read:user`.
  - `startDeviceFlow` posts to `https://<domain>/login/device/code` with `OPENCODE_HEADERS`. `pollForGitHubAccessToken` polls `https://<domain>/login/oauth/access_token`, automatically handling `authorization_pending` and `slow_down` rate-limit backoffs.
  - Post-login, `discoverGitHubCopilotApiEndpoint` queries `https://api.github.com/copilot_internal/user`, and `enableAllGitHubCopilotModels` issues model enablement requests (`POST /models/{modelId}/policy` with `{ state: "enabled" }` and `openai-intent: chat-policy`).
- **Token Exchange & Refresh**:
  - `refreshGitHubCopilotToken` (`packages/ai/src/registry/oauth/github-copilot.ts`) uses long-lived GitHub OAuth tokens directly without secondary JWT exchange cycles, setting expiry to `FAR_FUTURE_MS` (10 years).
- **Usage & Quota Accounting**:
  - `fetchInternalUsage` in `packages/ai/src/usage/github-copilot.ts` queries `GET /copilot_internal/user` on `resolveGitHubApiBaseUrl` with `OPENCODE_HEADERS`.
  - `normalizeQuotaSnapshots` and `buildLimitFromQuota` convert `quota_snapshots` (`chat`, `completions`, `premium_interactions`) and `quota_reset_date` into monthly `UsageLimit` structures (`copilot:premium`, `copilot:chat`, `copilot:completions`). `fetchBillingUsage` provides supplementary user billing details (`/settings/billing/premium_request/usage`).
  - `getCopilotPremiumRequests` (`packages/ai/src/registry/github-copilot.ts`) calculates model premium request cost: `0` for agent turns (`initiator === "agent"`), or `getCopilotPremiumMultiplier(premiumMultiplier, planTier)` for user turns.

### Catalog model handling
- **Descriptor & Management**: Registered as `github-copilot` descriptor in `PROVIDER_DESCRIPTORS` (`packages/catalog/src/provider-models/descriptors.ts`) with `defaultModel: "gpt-5.5"` and env var `COPILOT_GITHUB_TOKEN`. Options constructed via `githubCopilotModelManagerOptions`.
- **Dynamic Model Discovery**: `fetchDynamicModels` in `packages/catalog/src/provider-models/openai-compat.ts` fetches `/models` using `COPILOT_API_HEADERS`. Parses window/token limits from `entry.capabilities.limits` (`maxContextWindowTokens`, `maxPromptTokens`, `maxOutputTokens`), infers wire API (`inferCopilotApi`), and configures vision support (`extractCopilotSupportsVision`).
- **Long-Context Variant Synthesis**: Models advertising long-context pricing in `billing.token_prices.long_context` trigger `createCopilotLongContextVariant` to synthesize opt-in `-1m` catalog models (e.g., `claude-opus-4.7-1m` with `requestModelId: "claude-opus-4.7"`). The base model receives a `contextPromotionTarget` pointing to its long-context sibling.
- **Premium Request Multipliers**: Model-specific request multipliers are mapped in `COPILOT_PREMIUM_MULTIPLIERS` (`packages/catalog/scripts/generate-models.ts`), assigning values such as `gpt-4o: 0`, `grok-code-fast-1: 0.25`, `claude-haiku-4.5: 0.33`, `gpt-5.4-mini: 0.33`, and `claude-opus-4.6: 3`.

## GitLab Duo Non-Agentic (`gitlab-duo`)

`GitLab Duo Non-Agentic` (`gitlab-duo`) proxies Duo Chat LLM completion requests to GitLab AI Gateway proxy endpoints. Depending on the target model mapping, it dynamically delegates execution to the [Anthropic Messages](#anthropic-messages), [OpenAI Chat Completions](#openai-chat-completions), or [OpenAI Responses](#openai-responses) wire transports. It rides the shared [GitLab Duo](#gitlab-duo) transport section.

### Special casings
- **Model ID Mapping & Routing:** `MODEL_MAPPINGS` in `packages/ai/src/providers/gitlab-duo.ts` maps Duo model identifiers (`duo-chat-opus-4-6`, `duo-chat-sonnet-4-6`, `duo-chat-opus-4-5`, `duo-chat-sonnet-4-5`, `duo-chat-haiku-4-5`, `duo-chat-gpt-5-1`, `duo-chat-gpt-5-2`, `duo-chat-gpt-5-mini`, `duo-chat-gpt-5-codex`, `duo-chat-gpt-5-2-codex`) to backend providers (`anthropic` or `openai`), underlying model IDs, API schemas (`anthropic-messages`, `openai-completions`, `openai-responses`), and proxy target URLs (`ANTHROPIC_PROXY_URL` = `https://cloud.gitlab.com/ai/v1/proxy/anthropic/` or `OPENAI_PROXY_URL` = `https://cloud.gitlab.com/ai/v1/proxy/openai/v1`).
- **Canonical Model Alias Lookup:** `getModelMapping` in `packages/ai/src/providers/gitlab-duo.ts` resolves model mappings by matching either the Duo alias key or the underlying canonical model ID string (e.g. `gpt-5-codex` or `claude-sonnet-4-5-20250929`).
- **Direct Access Token Exchange & Caching:** `getDirectAccessToken` in `packages/ai/src/providers/gitlab-duo.ts` exchanges a user's GitLab access token for a short-lived direct access token via `POST https://gitlab.com/api/v4/ai/third_party_agents/direct_access` with `{ feature_flags: { DuoAgentPlatformNext: true } }`. The resulting token and headers are cached in `directAccessCache` for 25 minutes (`DIRECT_ACCESS_TTL_MS`).
- **Delegated Stream Dispatch:** `streamGitLabDuo` in `packages/ai/src/providers/gitlab-duo.ts` validates the user token (`MissingApiKeyError`), fetches direct access headers, translates Anthropic tool choice via `mapAnthropicToolChoice` (`packages/ai/src/stream.ts`), and dispatches to `streamAnthropic`, `streamOpenAICompletions`, or `streamOpenAIResponses` (`packages/ai/src/providers/register-builtins.ts`) using synthesized model specs (`buildModel`).

### Auth & usage
- **PAT & OAuth Support:** `gitlabDuoProvider` in `packages/ai/src/registry/gitlab-duo.ts` supports Personal Access Tokens via `GITLAB_TOKEN` or PKCE browser OAuth via `loginGitLabDuo` in `packages/ai/src/registry/oauth/gitlab-duo.ts`.
- **OAuth Authorization & Client ID:** `GitLabDuoOAuthFlow` in `packages/ai/src/registry/oauth/gitlab-duo.ts` executes PKCE OAuth against `https://gitlab.com/oauth/authorize` (`scope: "api"`, `callbackPort: 8080`, `pasteCodeFlow: true`). Uses `DEFAULT_CLIENT_ID` (`"da4edff2e6ebd2bc3208611e2768bc1c1dd7be791dc5ff26ca34ca9ee44f7d4b"`), overrideable via `GITLAB_CLIENT_ID` (`resolveClientId`) and `GITLAB_REDIRECT_URI` (`resolveCallbackOptions`).
- **Token Refresh & Cache Invalidation:** `refreshGitLabDuoToken` in `packages/ai/src/registry/oauth/gitlab-duo.ts` exchanges refresh tokens at `https://gitlab.com/oauth/token`. Both exchange and refresh clear cached direct access tokens via `clearGitLabDuoDirectAccessCache` (`packages/ai/src/providers/gitlab-duo.ts`).
- **Usage Surface:** Nothing beyond the [GitLab Duo](#gitlab-duo) pipeline.

### Catalog model handling
- **Descriptor Config:** `PROVIDER_DESCRIPTORS` in `packages/catalog/src/provider-models/descriptors.ts` registers `gitlab-duo` with `defaultModel: "duo-chat-opus-4-6"` and `envVars: ["GITLAB_TOKEN"]`.
- **Static Catalog Generation:** `scripts/generate-models.ts` in `packages/catalog` invokes `getGitLabDuoModels` (`packages/ai/src/providers/gitlab-duo.ts`), converting `MODEL_MAPPINGS` entries into bundled `ModelSpec` definitions in `models.json`.
- **Provider Priority:** `PROVIDER_PRIORITY` in `packages/catalog/src/identity/priority.ts` assigns `gitlab-duo` priority rank 35.

## GitLab Duo Agent (`gitlab-duo-agent`)
The `gitlab-duo-agent` provider connects OMP to the GitLab Duo Workflow Service (DWS) for agentic execution over a WebSocket action-bridge protocol. It rides the `GitLab Duo` transport section.

### Special casings
- **Stream Direct Bypass & Thinking Healing**: In `packages/ai/src/stream.ts`, `gitlab-duo-agent` bypasses `withProviderInFlightLimit` and standard `iterateWithIdleTimeout` wrappers. `streamGitLabDuoWorkflow` (`packages/ai/src/providers/gitlab-duo-workflow.ts`) is invoked directly wrapped in `healLeakedThinking`.
- **Runtime Namespace Resolution & Auto-Enablement**: Stream initialization invokes `resolveGitLabDuoWorkflowNamespaceSelection` (`packages/ai/src/providers/gitlab-duo-workflow.ts`) to resolve the root namespace from options, `GITLAB_DUO_NAMESPACE_ID`/`GITLAB_DUO_PROJECT_ID` env vars, or workspace git remotes. `ensureGitLabDuoWorkflowSettings` posts to `/api/v4/ai/duo_workflows/settings` (30s timeout via `GITLAB_DUO_WORKFLOW_REST_TIMEOUT_MS`) to auto-enable required namespace settings (`duo_workflow`, `duo_workflow_service`, `duo_agent_platform`).
- **ChatML Goal & Inline Spec Generation**: Renders conversation history into a ChatML goal string (`buildGitLabDuoWorkflowGoal`, `renderGitLabDuoWorkflowChatMl`), subject to 1MB soft (`GITLAB_DUO_WORKFLOW_GOAL_SOFT_OVERFLOW_BYTES`) and 2MB hard (`GITLAB_DUO_WORKFLOW_GOAL_HARD_OVERFLOW_BYTES`) limits. Emits an ambient inline workflow definition (`buildGitLabDuoWorkflowInlineFlowConfig`) targeting `omp_agent`.
- **WebSocket Action Bridge**: Tool definitions are converted into MCP format (`buildGitLabDuoWorkflowMcpTools`) in `startRequest.mcpTools`. Incoming `runMCPTool`/`run_mcp_tool` actions over the WebSocket are extracted (`extractGitLabDuoWorkflowAction`), executed locally, and returned via `buildGitLabDuoWorkflowActionResponse`.

### Auth & usage
- **Registry & Credential Resolution**: Provider definition `gitLabDuoWorkflowProvider` (`packages/ai/src/registry/gitlab-duo-workflow.ts`) requires `GITLAB_TOKEN` (PAT or OAuth token).
- **OAuth PKCE & Official Client ID**: Browser authentication (`loginGitLabDuoWorkflow` in `packages/ai/src/registry/oauth/gitlab-duo-workflow.ts`) uses S256 PKCE with `pasteCodeFlow: true` on callback port 8080. It uses official GitLab VS Code client ID `GITLAB_DUO_WORKFLOW_OAUTH_CLIENT_ID` (`36f2a70cddeb5a0889d4fd8295c241b7e9848e89cf9e599d0eed2d8e5350fbf5`) and redirect URI `vscode://gitlab.gitlab-workflow/authentication`, supporting manual callback URL pasting if VS Code intercepts the redirect. Token refresh uses `refreshGitLabDuoWorkflowToken`.
- **Direct Access Tokens**: Requests ephemeral credentials via `POST /api/v4/ai/duo_workflows/direct_access` (`requestGitLabDuoWorkflowDirectAccess` in `packages/ai/src/providers/gitlab-duo-workflow.ts`). No dedicated usage module exists under `packages/ai/src/usage/`.
- **Context Telemetry Usage**: `extractGitLabDuoWorkflowContextUsage` extracts checkpoint telemetry (`agent_context_usage`), prioritizing `"Chat Agent"` and `"context_builder"` entries, and updates token estimates via `applyGitLabDuoWorkflowContextUsage`.

### Catalog model handling
- **Provider Descriptor**: Registered in `packages/catalog/src/provider-models/descriptors.ts` with `defaultModel: "claude_sonnet_4_6_vertex"`, `envVars: ["GITLAB_TOKEN"]`, and `dynamicModelsAuthoritative: true`. Omits `catalogDiscovery` to prevent single-account namespace discovery from running during static catalog generation.
- **Fingerprinted Scope Cache**: `gitLabDuoWorkflowModelManagerOptions` in `packages/catalog/src/provider-models/special.ts` configures dynamic model management. `gitLabDuoWorkflowModelCacheProviderId` partitions dynamic catalog caches using `Bun.hash` on `apiKey` and a scope string of `baseUrl`, `namespaceId`, `projectId`, and workspace `cwd`.
- **GraphQL Discovery**: `fetchGitLabDuoWorkflowModels` (`packages/catalog/src/discovery/gitlab-duo-workflow.ts`) calls `discoverGitLabDuoWorkflowNamespace` to locate the root namespace (via explicit config, env, or git remote matching `discoverGitLabRemoteProjectPath`) and executes GraphQL query `aiChatAvailableModels(rootNamespaceId:)` to query `defaultModel`, `selectableModels`, and `pinnedModel`.
- **Model Specs & Context Windows**: `buildGitLabDuoWorkflowModelSpec` constructs model specs with `reasoning: false` (disabling thinking UI controls because Duo Agent Platform manages Anthropic reasoning parameters server-side). `resolveGitLabDuoWorkflowContextWindow` maps model refs to context window sizes (Claude Opus/Sonnet: 1,000,000; Haiku: 200,000; Gemini: 1,000,000; GPT-5: 400,000; default: 200,000).
- **Fallback Model Seeding**: `scripts/generate-models.ts` seeds `buildGitLabDuoWorkflowFallbackModel()` (`claude_sonnet_4_6_vertex`) so unauthenticated/fresh installations contain a default model entry.

## GMI Cloud (`gmi-cloud`)
GMI Cloud is an AI GPU infrastructure and cloud model inference provider hosting open-weight and proprietary model endpoints. It operates over the OpenAI Chat Completions transport using the standard `/v1` wire protocol hosted at `https://api.gmi-serving.com/v1`.

### Special casings
- Nothing beyond the OpenAI Chat Completions pipeline.

### Auth & usage
- **API Key Login & Validation**: `loginGmiCloud` (`packages/ai/src/registry/gmi-cloud.ts`) implements interactive API key authentication via `createApiKeyLogin`, pointing users to `https://console.gmicloud.ai`. Key validation uses `kind: "models-endpoint"` hitting `https://api.gmi-serving.com/v1/models` through `validateOpenAICompatibleApiKey` (`packages/ai/src/registry/api-key-validation.ts`).
- **Environment Variables**: Primary credential resolution inspects `GMI_API_KEY` (`envVars` in `packages/catalog/src/provider-models/descriptors.ts`).
- **Provider Registry**: `gmiCloudProvider` (`packages/ai/src/registry/gmi-cloud.ts`) is exported in `packages/ai/src/registry/registry.ts` within the provider definitions array.

### Catalog model handling
- **Descriptor & Gateway Options**: Registered in `CATALOG_PROVIDERS` (`packages/catalog/src/provider-models/descriptors.ts`) with `id: "gmi-cloud"`, `defaultModel: "deepseek-ai/DeepSeek-V4-Flash"`, and `dynamicModelsAuthoritative: true`. Gateway options are created by `gmiCloudModelManagerOptions` wrapping `createSimpleOpenAICompletionsOptions` with `GMI_CLOUD_BASE_URL` (`https://api.gmi-serving.com/v1`) (`packages/catalog/src/provider-models/openai-compat.ts`).
- **Dynamic Model Discovery**: Configured with `catalogDiscovery: { label: "GMI Cloud" }` (`packages/catalog/src/provider-models/descriptors.ts`) to dynamically query `/v1/models` via `fetchOpenAICompatibleModels` (`packages/catalog/src/discovery/openai-compatible.ts`). When API credentials are available, live discovery results marked as authoritative overwrite cached or static entries.
- **Static Seed Model**: `GMI_CLOUD_STATIC_MODELS` (`packages/catalog/src/provider-models/openai-compat.ts`) defines a bundled fallback seed for `deepseek-ai/DeepSeek-V4-Flash` (1,048,576 context window, 384,000 max tokens, `$0.14`/`$0.28` per 1M input/output tokens, reasoning enabled with `High` and `Max` effort modes). This seed ensures that fresh installs or model generation runs lacking `GMI_API_KEY` can synchronously resolve the provider's default model (`packages/catalog/scripts/generate-models.ts`, `packages/catalog/test/gmi-cloud-provider.test.ts`).

## Google Antigravity (`google-antigravity`)
The Google Antigravity provider (`google-antigravity`) routes requests to Google Cloud Code Assist daily/sandbox endpoints (`daily-cloudcode-pa.googleapis.com`) using dedicated OAuth credentials. It provides access to Google Gemini 3.x/2.5 models as well as Anthropic Claude and OpenAI GPT-OSS models using the shared "Google Gemini CLI / Antigravity" transport (`packages/ai/src/providers/google-gemini-cli.ts`).

### Special casings
- **Validated Function Calling Default**: Default tool selection mode in `buildRequest` (`packages/ai/src/providers/google-gemini-cli.ts`) is `VALIDATED` (`functionCallingConfig: { mode: "VALIDATED" }`). Claude models on Antigravity always force `VALIDATED` tool mode even when no tools are declared (`packages/ai/src/providers/google-gemini-cli.ts`).
- **System Instruction & Request Envelope**: Antigravity tags `systemInstruction` with `role: "user"` and sends the caller's prompts unmodified. `buildAntigravityRequestEnvelope` injects structured `requestId` (`agent/<id>/<ts>/<trajectoryId>/<step>`), `userAgent: "antigravity"`, `requestType: "agent"`, `sessionId`, and `labels` (`model_enum`, `trajectory_id`, `last_step_index`, `last_execution_id`, `used_claude*`) using `getAntigravityModelWireProfile`.
- **Endpoint Auto-Failover**: Operates across `ANTIGRAVITY_DAILY_ENDPOINT` (`https://daily-cloudcode-pa.googleapis.com`) and `ANTIGRAVITY_SANDBOX_ENDPOINT` (`https://daily-cloudcode-pa.sandbox.googleapis.com`) with state-tracked fallback in `getAntigravityProviderSessionState` (`packages/ai/src/providers/google-gemini-cli.ts`).

### Auth & usage
- **Dedicated OAuth Flow**: `loginAntigravity` and `refreshAntigravityToken` (`packages/ai/src/registry/oauth/google-antigravity.ts`) execute an independent OAuth flow with distinct client credentials and callback port 51121. Project discovery mirrors native `antigravity/hub`: exact-200 `loadCodeAssist` calls use `ANTIGRAVITY_LOAD_CODE_ASSIST_METADATA`, free-tier eligibility is honored, missing tiers trigger one `onboardUser` request plus 1s operation polling under a 30s deadline, and a final load refresh supplies `cloudaicompanionProject`.
- **Model-Family Credential Ranking**: `antigravityRankingStrategy` (`packages/ai/src/usage/google-antigravity.ts`) scopes usage limits by model family (`scopeAntigravityLimitsForModel` via `getAntigravityCounterKeyForModel`: `anthropic` for `claude-`, `google` for `gemini-`/`gemma-`, `openai` for `gpt-`/`openai/`). This prevents quota exhaustion on one counter (e.g. Gemini) from blocking multi-account credential selection for another family (e.g. Claude).

### Catalog model handling
- **Catalog Discovery**: `fetchAntigravityDiscoveryModels` (`packages/catalog/src/discovery/antigravity.ts`) queries `/v1internal:fetchAvailableModels`, filters denylisted IDs (`chat_20706`, `chat_23310`, `gemini-2.5-pro`) and internal models (`isInternal`), and applies effort-tier variant collapsing via `ANTIGRAVITY_VARIANT_COLLAPSE_TABLE`.
- **Claude & GPT-OSS Model Availability**: Exposes Anthropic Claude models (`claude-opus-4-5`, `claude-opus-4-6`, `claude-sonnet-4-5`, `claude-sonnet-4-6`) and `gpt-oss-120b` alongside Gemini 3.x/2.5 models in `models.json` (`packages/catalog/src/models.json`).
- **Pricing Fallback**: `applyAntigravityPricingFallback` (`packages/catalog/scripts/generated-policies.ts`) backfills 0-cost discovery models using `ANTIGRAVITY_PRICING_PEERS` (`google`, `google-vertex`, `anthropic`) and `ANTIGRAVITY_PRICING_ID_ALIASES` (`gemini-3-flash` -> `gemini-3-flash-preview`, `claude-opus-4-5` -> `claude-opus-4-5@20251101`), mapping Gemini models to Google API prices and Claude models to Google Vertex list prices.

## Google Gemini CLI (`google-gemini-cli`)
Google Cloud Code Assist (Gemini CLI) (`google-gemini-cli`) is Google's OAuth-authenticated developer free and workspace tier providing direct access to Gemini models over the Cloud Code Assist API endpoint (`https://cloudcode-pa.googleapis.com`). Rides the shared **Google Gemini CLI / Antigravity** transport section (`packages/ai/src/providers/google-gemini-cli.ts`).

### Special casings
- **Default Endpoint & Headers**: Dispatches requests to `https://cloudcode-pa.googleapis.com` and emits headers via `getGeminiCliHeaders()` (`GeminiCLI/0.46.0/<modelId> ...` in `packages/catalog/src/wire/gemini-headers.ts`).
- **Thinking Transport**: Maps Gemini thinking via `google-level` `thinkingLevel` transport (`GEMINI_CLI_VARIANT_COLLAPSE_TABLE` in `packages/catalog/src/variant-collapse.ts`), unlike `google-antigravity` which uses `budget` transport (`ANTIGRAVITY_VARIANT_COLLAPSE_TABLE`).
- Standard request pipeline: Nothing beyond the Google Gemini CLI / Antigravity transport pipeline.

### Auth & usage
- **OAuth Installed-App Flow**: Authorizes via Google PKCE OAuth 2.0 (`loginGeminiCli` in `packages/ai/src/registry/oauth/google-gemini-cli.ts`) on callback port `8085` (`/oauth2callback`) requesting Google Cloud scopes (`cloud-platform`, `userinfo.email`, `userinfo.profile`). Refresh is handled via `refreshGoogleCloudToken` (`packages/ai/src/registry/oauth/google-gemini-cli.ts`).
- **Project Discovery & Onboarding**: `discoverProject` (`packages/ai/src/registry/oauth/google-gemini-cli.ts`) checks existing projects via `POST /v1internal:loadCodeAssist` with `$GOOGLE_CLOUD_PROJECT` / `$GOOGLE_CLOUD_PROJECT_ID` fallback. Non-free tiers (`legacy-tier`, `standard-tier`) or new accounts call `POST /v1internal:onboardUser` with `tierId` (`free-tier`, `legacy-tier`, `standard-tier`) and poll `pollOperation` (up to `POLL_MAX_ATTEMPTS = 24` at 5s intervals). Detects VPC-SC restrictions (`isVpcScAffectedUser` checking `SECURITY_POLICY_VIOLATED`).
- **Quota & Usage Provider**: `googleGeminiCliUsageProvider` (`packages/ai/src/usage/gemini.ts`) posts to `loadCodeAssist` and `retrieveUserQuota` (`/v1internal:retrieveUserQuota`), mapping remaining bucket fractions into usage percentages grouped by model tier (`3-Flash`, `Flash`, `Pro` via `getModelTier`).

### Catalog model handling
- **Provider Descriptor**: Registered in `CATALOG_PROVIDERS` (`packages/catalog/src/provider-models/descriptors.ts`) with `defaultModel: "gemini-3.1-pro-preview"` and `specialModelManager: true`, bypassing standard model factories.
- **Model Resolution & Discovery**: `googleGeminiCliModelManagerOptions` (`packages/catalog/src/provider-models/google.ts`) calls `fetchAntigravityDiscoveryModels` (`packages/catalog/src/discovery/antigravity.ts`) against the Antigravity daily endpoints with `GEMINI_CLI_VARIANT_COLLAPSE_TABLE`, filters the result to Gemini models, then rewrites providers to `google-gemini-cli` and inference base URLs to `https://cloudcode-pa.googleapis.com`. When the Antigravity endpoint is unauthorized for the credential (Gemini Code Assist Standard returns HTTP 403), it falls back to `fetchGeminiCliQuotaModels` (`packages/catalog/src/discovery/gemini-cli.ts`), which derives the model list from the account's own `retrieveUserQuota` response on Cloud Code Assist, filling metadata from the bundled catalog where the id is known.
- **Generator Integration & Priority**: Serves as fallback OAuth token provider in `fetchAntigravityModels` (`packages/catalog/scripts/generate-models.ts`) if `google-antigravity` access is unavailable. Ranked second in provider priority (`packages/catalog/src/identity/priority.ts`).

## Groq (`groq`)
Groq provides high-speed LLM inference powered by custom LPU hardware for open-weights models using the OpenAI Chat Completions transport (`https://api.groq.com/openai/v1`).

### Special casings
- **Context Overflow**: Detected when error messages match `/reduce the length of the messages/i` in `OVERFLOW_PATTERNS` (`packages/ai/src/error/flags.ts`).
- **Reasoning Effort Mapping**: Model `qwen/qwen3-32b` maps `Minimal`, `Low`, `Medium`, `High`, and `XHigh` to `"default"` via `GROQ_QWEN3_32B_REASONING_EFFORT_MAP` (`packages/catalog/src/model-thinking.ts`).
- **Multiple System Messages**: Supported natively by default in OpenAI compatibility settings via `isGroqHost` in `supportsMultipleSystemMessagesDefault` (`packages/catalog/src/compat/openai.ts`).

### Auth & usage
- **Auth**: Authenticates via `GROQ_API_KEY` environment variable (`packages/catalog/src/provider-models/descriptors.ts`).
- **Provider Registry**: Registered as `groqProvider` (`packages/ai/src/registry/groq.ts`).
- **Priority**: Listed 19th in provider priority ordering (`packages/catalog/src/identity/priority.ts`).

### Catalog model handling
- **Host Matching**: Matched by URL marker `api.groq.com` or provider `groq` in host definitions (`packages/catalog/src/hosts.ts`).
- **Manager Options**: Configured via `groqModelManagerOptions` targeting `https://api.groq.com/openai/v1` (`packages/catalog/src/provider-models/openai-compat.ts`).
- **Default Model**: Defaults to `openai/gpt-oss-120b` (`packages/catalog/src/provider-models/descriptors.ts`).

## Hugging Face Inference (`huggingface`)
Hugging Face Inference provides access to open-source model serverless endpoints hosted on the Hugging Face Hub using the OpenAI Chat Completions transport (`openai-completions`) pointing to `https://router.huggingface.co/v1`. The provider enables serverless LLM generation across models including DeepSeek-R1.

### Special casings
- **Standard Transport Pipeline**: Nothing beyond the OpenAI Chat Completions pipeline (`packages/ai/src/providers/openai-completions.ts`).

### Auth & usage
- **Environment Fallbacks**: Environment variable resolution in `getEnvApiKey` (`packages/ai/src/stream.ts`) consults `envVars` from `CATALOG_PROVIDERS` (`packages/catalog/src/provider-models/descriptors.ts`), checking `HUGGINGFACE_HUB_TOKEN` first, followed by `HF_TOKEN`.
- **Interactive CLI Login**: `loginHuggingface` in `packages/ai/src/registry/huggingface.ts` uses `createApiKeyLogin` (`packages/ai/src/registry/api-key-login.ts`) to prompt for fine-grained user access tokens (placeholder `hf_...`).
- **Fine-Grained Token Permission**: Auth setup directs users to `https://huggingface.co/settings/tokens/new?ownUserPermissions=inference.serverless.write&tokenType=fineGrained` (`AUTH_URL` in `packages/ai/src/registry/huggingface.ts`), which automatically selects fine-grained tokens with the required "Make calls to Inference Providers" permission (`inference.serverless.write`).
- **Credential Validation**: `loginHuggingface` validates API keys using lightweight chat completion requests to base URL `https://router.huggingface.co/v1` (`API_BASE_URL`) against validation model `openai/gpt-oss-120b` (`VALIDATION_MODEL` in `packages/ai/src/registry/huggingface.ts`).

### Catalog model handling
- **Provider Descriptor**: Registered in `CATALOG_PROVIDERS` (`packages/catalog/src/provider-models/descriptors.ts`) with `id: "huggingface"`, `defaultModel: "deepseek-ai/DeepSeek-R1"`, environment fallbacks `envVars: ["HUGGINGFACE_HUB_TOKEN", "HF_TOKEN"]`, and `catalogDiscovery: { label: "Hugging Face" }`.
- **Model Manager Options**: `huggingfaceModelManagerOptions` in `packages/catalog/src/provider-models/openai-compat.ts` constructs manager options via `createSimpleOpenAICompletionsOptions`, binding default base URL `https://router.huggingface.co/v1` and mapping static models with bundled reference specs (`mapWithBundledReference`).
- **Catalog Descriptor**: `openAiCompletionsDescriptor` in `packages/catalog/src/provider-models/openai-compat.ts` registers `huggingface` in `PROVIDER_DESCRIPTORS` targeting `https://router.huggingface.co/v1`.
- **Catalog Discovery**: Participating in catalog generation via `catalogDiscovery`, `generate-models.ts` (`packages/catalog/scripts/generate-models.ts`) resolves API tokens via `resolveProviderApiKey` and calls `fetchOpenAICompatibleModels` (`packages/catalog/src/discovery/openai-compatible.ts`) against `https://router.huggingface.co/v1/models` to discover available Hub inference endpoints.

## Kilo Gateway (`kilo`)
Kilo Gateway (`kilo`) is an AI model aggregator and proxy service (`https://api.kilo.ai/api/gateway`) using the OpenAI Chat Completions transport (`api: "openai-completions"`). It supports authentication via `KILO_API_KEY` or device-code OAuth flow (`/login kilo`), and allows unauthenticated dynamic model discovery from its OpenAI-compatible `/models` catalog endpoint.

### Special casings
- **Device-Code OAuth Authentication**: `loginKilo` in `packages/ai/src/registry/kilo.ts` initiates device authorization via `POST https://api.kilo.ai/api/device-auth/codes`, returning a user `code`, `verificationUrl`, and `expiresIn` seconds. It displays instructions via `callbacks.onAuth` and polls `GET https://api.kilo.ai/api/device-auth/codes/<userCode>` every 5,000ms until expiration. Handles HTTP 202 (pending), 403/410 (denied/expired), and rate limiting (HTTP 429), returning access tokens with 1-year expiration upon approval (`pollData.status === "approved"`). Supports cancellation via `callbacks.signal`.
- **Non-Standard Host Classification**: `modelMatchesHost(hostModel, "kilo")` sets `isKilo` in `packages/catalog/src/compat/openai.ts`, placing Kilo among non-standard OpenAI-compatible providers (`isNonStandard`) to govern transport compatibility behavior.
- **Host URL Matching**: Host mapping in `packages/catalog/src/hosts.ts` associates URL marker `api.kilo.ai` with provider `"kilo"`.
- **Provider Priority**: Included in `packages/catalog/src/identity/priority.ts` provider priority sequence (`"opencode-go"`, `"kilo"`, `"vercel-ai-gateway"`).

### Auth & usage
- **API Key & OAuth Tokens**: Authenticates via static environment variable `KILO_API_KEY` or OAuth access tokens issued through the device-code flow (`/login kilo`).
- **Bearer Token Headers**: Requests pass credentials as standard Bearer tokens (`Authorization: Bearer <key>`) against base URL `https://api.kilo.ai/api/gateway`.

### Catalog model handling
- **Provider Descriptor**: Registered in `packages/catalog/src/provider-models/descriptors.ts` with `defaultModel: "anthropic/claude-opus-4.8"`, environment variable `KILO_API_KEY`, and `catalogDiscovery: { label: "Kilo Gateway", allowUnauthenticated: true }` enabling catalog discovery without requiring an API key.
- **Model Manager & Wire Descriptor**: `kiloModelManagerOptions` in `packages/catalog/src/provider-models/openai-compat.ts` maps `providerId: "kilo"` to base URL `https://api.kilo.ai/api/gateway` and delegates dynamic model discovery to `fetchOpenAICompatibleModels`. Associated with `openAiCompletionsDescriptor("kilo", "kilo", "https://api.kilo.ai/api/gateway")`.
- **Thinking Configuration**: Models routed via Kilo (such as `moonshotai/kimi-k2.6`) inherit standard OpenAI-style thinking format resolution (`compat.thinkingFormat = "openai"`).

## Kimi Code (`kimi-code`)
Kimi Code provides subscription-backed access to Kimi models (`kimi-for-coding`, `k3`) via Moonshot AI's `/coding/v1` API endpoints. It rides the [Kimi Code](#kimi-code) transport pipeline, delegating request execution to `streamKimi` (`packages/ai/src/providers/kimi.ts`) and `streamOpenAIAnthropicShim` (`packages/ai/src/providers/openai-anthropic-shim.ts`).

### Special casings
- **Prompt Cache Key Sharing**: `isKimiModel` (`packages/ai/src/providers/kimi.ts`) gates prompt caching; Anthropic-compatible (`packages/ai/src/providers/anthropic.ts:3480`) and OpenAI-compatible (`packages/ai/src/providers/openai-completions.ts:1508`) requests both attach `prompt_cache_key` derived via `getOpenAIPromptCacheKey` to share affinity identity across transport switches.
- **Common Header Prepending**: `prependHeaders` in `packages/ai/src/providers/openai-completions.ts` injects `getKimiCommonHeaders()` (`packages/ai/src/registry/oauth/kimi.ts`) into all `kimi-code` requests.
- **Schema Validation & Tool Choice**: Matched via `isMoonshotNative` (`packages/catalog/src/hosts.ts`), enforcing `toolSchemaFlavor: "moonshot-mfjs"` (`packages/catalog/src/compat/openai.ts`). Mandatory-thinking models (`kimi-for-coding`, `k3`) resolve `requiresThinkingEnabled = true` in Anthropic compat (`packages/catalog/src/compat/anthropic.ts`), downgrading forced tool choice to `auto`.
- **Reasoning Guard**: `stream.ts:1214` checks `isKimiModel` before execution, disabling unsupported reasoning configurations on K3 (`packages/ai/src/providers/openai-completions.ts:1454`).

### Auth & usage
- **Device OAuth Flow**: `kimiCodeProvider` (`packages/ai/src/registry/kimi-code.ts`) lazy-loads `loginKimi` and `refreshKimiToken` (`packages/ai/src/registry/oauth/kimi.ts`). Uses OAuth 2.0 Device Code Authorization (`CLIENT_ID` `17e5f671-d194-4dfb-9706-5516cb48c098`) against `${resolveOAuthHost()}` (`https://auth.kimi.com`, overrideable via `KIMI_CODE_OAUTH_HOST` or `KIMI_OAUTH_HOST`).
- **Fingerprinting & Device Persistence**: `getKimiCommonHeaders()` injects tracking headers (`User-Agent: KimiCLI/<ver>`, `X-Msh-Platform`, `X-Msh-Version`, `X-Msh-Device-Name`, `X-Msh-Device-Model`, `X-Msh-Os-Version`, `X-Msh-Device-Id`). `getDeviceId` persists a random hex UUID to `path.join(getAgentDir(), "kimi-device-id")` (mode `0600`), falling back to an in-memory ephemeral UUID if file writing fails.
- **Usage & Quota Tracker**: `kimiUsageProvider` (`packages/ai/src/usage/kimi.ts`) fetches `GET /coding/v1/usages` (`https://api.kimi.com/coding/v1/usages`, configurable via `KIMI_CODE_BASE_URL`) for OAuth credentials. Short-circuits when tokens are expired (`credential.expiresAt <= nowMs`). Parses `usage` and `limits` into `UsageLimit` entries, carrying row-level reset timestamps (`reset_at`, `resetTime`, `ttl`) to the window object when window reset time is absent.

### Catalog model handling
- **Provider Descriptor**: Registered in `CATALOG_PROVIDERS` (`packages/catalog/src/provider-models/descriptors.ts`) with `id: "kimi-code"`, `defaultModel: "kimi-for-coding"`, discovery label `"Kimi Code"`, and `envVars: ["KIMI_API_KEY"]`. Delegate options build via `kimiCodeModelManagerOptions`.
- **Dynamic Model Discovery**: `kimiCodeModelManagerOptions` (`packages/catalog/src/provider-models/openai-compat.ts`) queries `/coding/v1/models` using `fetchOpenAICompatibleModels` with `KimiCLI/1.0` headers. Maps models via `kimiSupportsReasoning`, `mapKimiThinking`, and `mapKimiApiFormat` (setting `compat.kimiApiFormat` to `"anthropic"` or `"openai"`).
- **Per-Family Output Ceilings**: `kimiCodeMaxTokens` (`packages/catalog/src/provider-models/openai-compat.ts`) derives output caps by ID: 131,072 (`KIMI_CODE_K3_MAX_TOKENS`) for `k3`/`k3-256k`, 32,768 (`KIMI_CODE_FOR_CODING_MAX_TOKENS`) for `kimi-for-coding`/`kimi-for-coding-highspeed`, and fallback 32,000 (`KIMI_CODE_DEFAULT_MAX_TOKENS`) for legacy K2 rows. Applied during static generation (`packages/catalog/scripts/generate-models.ts`).

## LiteLLM (`litellm`)
LiteLLM is an open-source AI proxy and gateway that unifies access to multiple LLM providers behind an OpenAI-compatible API host. In `pi`, it operates using the OpenAI Chat Completions (`openai-completions`) transport pipeline.

### Special casings
- **Reasoning replay exclusion (`packages/catalog/src/compat/openai.ts`)**: Listed in `PROXY_OPENAI_COMPAT_PROVIDERS`. Unlike native local runtimes (`llama.cpp`, `vllm`), `replayReasoningContent` defaults to `false` because LiteLLM proxies route turns to arbitrary upstream providers (e.g., Anthropic, OpenAI) where replaying `reasoning_content` can trigger HTTP 400 errors.
- **Loopback stream-timeout floor (`packages/catalog/src/compat/openai.ts`)**: Even though LiteLLM is excluded from `isLocalOpenAICompatBackend`, loopback/RFC1918 URLs (`localhost`, `127.0.0.1`) still participate in `hasLocalLoopbackBaseUrl`, preserving the local stream-timeout floor to avoid premature prefill timeouts when fronting slow local backends.
- **Anthropic & Bedrock tool compatibility (`packages/ai/src/providers/openai-completions.ts`)**:
  - When `context.tools` is `undefined` but conversation history contains tool calls, `params.tools` is set to `[]` for Anthropic-via-LiteLLM compatibility.
  - When `context.tools` is explicitly empty (`[]`, e.g., `/btw` or background turns), `params.tools` and `tool_choice: "none"` are omitted so LiteLLM → Bedrock routes do not generate invalid, empty `toolConfig` blocks.
- **Telemetry & gateway header detection (`packages/agent/src/telemetry.ts`, `packages/ai/src/auth-gateway/http.ts`)**: `detectGatewayFromHeaders` inspects `x-litellm-call-id` (falling back to `x-litellm-model-id` or `x-litellm-model-group`) to populate `pi.gen_ai.gateway.*` span attributes. Auth gateway HTTP endpoints expose `x-litellm-model-id`, `x-litellm-model-api-base`, `x-litellm-response-cost`, and `x-litellm-response-duration-ms`.

### Auth & usage
- **Credentials & env (`packages/catalog/src/provider-models/descriptors.ts`, `packages/ai/src/registry/litellm.ts`)**: Authenticates via `LITELLM_API_KEY`.
- **Login onboarding (`packages/ai/src/registry/litellm.ts`)**: `loginLiteLLM` (via `createApiKeyLogin`) directs users to setup docs (`https://docs.litellm.ai/docs/proxy/deploy`), prompts for master/virtual keys (`sk-...`), and notes `LITELLM_BASE_URL` for custom proxy endpoints. CLI `login` delegates to `SqliteAuthCredentialStore.login()`.
- **Default base URL (`packages/catalog/src/provider-models/cache-provider-id.ts`)**: Resolves to `Bun.env.LITELLM_BASE_URL` or `http://localhost:4000/v1`.

### Catalog model handling
- **Bundled catalog exclusion (`packages/scripts/generate-models.ts`)**: Included in `DISCOVERY_ONLY_PROVIDERS`. LiteLLM models are excluded from static `models.json` generation to avoid leaking developer localhost endpoints.
- **Rich management endpoint discovery (`packages/catalog/src/provider-models/openai-compat.ts`)**: `fetchLiteLLMRichModels` probes `/model_group/info`, `/v2/model/info`, `/model/info`, and `/v1/model/info`. It filters sentinel placeholder IDs (`all-team-models`, `all-proxy-models`, `no-default-models`) and parses context limits (`max_input_tokens`), output limits (`max_output_tokens`), `supports_vision`, `supports_reasoning`, `supported_openai_params` (mapping `reasoning_effort`), and per-token pricing (`input_cost_per_token`, `output_cost_per_token`, cache read/write costs mapped to $/million tokens).
- **Fallback discovery & display names (`packages/catalog/src/provider-models/openai-compat.ts`)**: If rich endpoints fail, discovery falls back to `/v1/models` (`fetchOpenAICompatibleModels`) and resolves specs against `models.dev` references. Strips reseller multiplier suffixes (e.g., `(1.5x usage)`) from display names.
- **Compatibility overrides (`packages/catalog/src/provider-models/openai-compat.ts`)**: Hardcodes `compat.supportsStore: false` and `compat.supportsDeveloperRole: false` for all resolved models.

## LM Studio (`lm-studio`)
LM Studio is a local OpenAI-compatible model server running on user hardware (defaulting to `http://127.0.0.1:1234/v1`). It uses the [OpenAI Chat Completions](#openai-chat-completions) transport (`api: "openai-completions"`) to stream chat completions and tool calls.

### Special casings
- **String-Only Named Tool Choice**: Registered in `STRING_ONLY_NAMED_TOOL_CHOICE_PROVIDERS` (`packages/catalog/src/compat/openai.ts`) with `supportsNamedToolChoice: false`. Object-style forced tool choices (`{ type: "function", function: { name: "..." } }`) are downgraded to `"required"` while the advertised `tools` list is narrowed to the single forced tool.
- **Grammar Schema Normalization**: Configures `toolSchemaFlavor: "grammar"` in catalog compat (`packages/catalog/src/compat/openai.ts`). Tool JSON schemas are sanitized via `sanitizeSchemaForGrammar` (`packages/ai/src/utils/schema/normalize.ts`), widening bare boolean `true` or `{}` subschemas in property positions into primitive unions to avoid GBNF grammar parser failures (`Unrecognized schema: true`, issue #5914).
- **Replay Reasoning Content & Append-Only Context**: Included in `LOCAL_OPENAI_COMPAT_PROVIDERS` (`packages/catalog/src/compat/openai.ts`) and `LOCAL_INFERENCE_PROVIDERS` (`packages/coding-agent/src/config/append-only-context-mode.ts`). `replayReasoningContent` is auto-enabled for local reasoning models so `<think>` blocks are preserved in `reasoning_content` across turns for KV-cache hits in local chat templates; `qwenPreserveThinking` is also enabled for Qwen thinking dialects.
- **Static Catalog Generator Exclusion**: Listed in `DISCOVERY_ONLY_PROVIDERS` (`scripts/generate-models.ts`) and `LOCAL_ONLY_PROVIDERS` (`test/models-json-no-local-endpoints.test.ts`), ensuring local endpoints are never fetched during build or committed to static `models.json`.

### Stream behavior
- **Watchdog Timeout Floors**: Configures `streamFirstEventTimeoutMs: 0` (`packages/catalog/src/compat/openai.ts`) to disable the pre-response first-event watchdog during long local model cold-loads or prompt prefills, and sets `streamIdleTimeoutMs: 300_000` (300s inter-event floor; see [Provider compat reference](./provider-compat-reference.md)) to prevent stream cancellation during slow token generation.

### Auth & usage
- **Keyless Local Auth**: Defined as a keyless provider (`lmStudioProvider` in `packages/ai/src/registry/lm-studio.ts`, `allowUnauthenticated: true` in `packages/catalog/src/provider-models/descriptors.ts`). Uses `DEFAULT_LOCAL_TOKEN = "lm-studio-local"` when `LM_STUDIO_API_KEY` is not provided.
- **Endpoint & Credentials**: Base URL defaults to `http://127.0.0.1:1234/v1` or `LM_STUDIO_BASE_URL`. Interactive CLI login uses `loginLmStudio` (`createApiKeyLogin` in `packages/ai/src/registry/lm-studio.ts`).
- **Usage Accounting**: Employs standard OpenAI Chat Completions usage accounting (`calculateOpenAIUsageAccounting` in `packages/ai/src/providers/openai-shared.ts`).

### Catalog model handling
- **Implicit & Dynamic Discovery**: `ModelRegistry` (`packages/coding-agent/src/config/model-registry.ts`) auto-registers `lm-studio` as an implicit discoverable provider when unconfigured. Dynamic model resolution (`lmStudioModelManagerOptions` in `packages/catalog/src/provider-models/openai-compat.ts` / `discoverLmStudioModels` in `packages/coding-agent/src/config/model-discovery.ts`) queries `/v1/models`.
- **Native Metadata Probe**: Probes LM Studio's native endpoint `/api/v0/models` via `fetchLmStudioNativeModelMetadata` (with `LM_STUDIO_NATIVE_METADATA_TIMEOUT_MS = 250`). Sets `input: ["text", "image"]` when `type === "vlm"` or capabilities include `vision`/`image` (setting `imageInputDecoder: "stb"` during discovery).
- **Loaded Context Length**: `getLmStudioNativeContextWindow` prefers `loaded_context_length` for active models over architectural ceilings (`max_context_length`, `context_length`, `max_model_len`), ensuring context window limits accurately reflect current VRAM/RAM allocations.

## Meta Model API (`meta`)
Meta Model API is Meta's commercial API platform hosting first-party models such as `muse-spark-1.1`. It interacts with the model service via the OpenAI Responses transport targeting `https://api.meta.ai/v1`.

### Special casings
- **Output Token Clamp Bypass**: `resolveOpenAIResponsesOutputClamp` (`packages/ai/src/providers/openai-shared.ts`) checks `model.provider === "meta"` to allow Meta requests to output up to `model.maxTokens` (131,072 tokens) rather than being restricted by the default 64,000 token ceiling (`OPENAI_MAX_OUTPUT_TOKENS`).

### Auth & usage
- **API Key Login**: Configured via `loginMeta` / `metaProvider` (`packages/ai/src/registry/meta.ts`) using `createApiKeyLogin` with dashboard URL `https://developer.meta.com/ai/`. Validation issues a GET request to `https://api.meta.ai/v1/models`.
- **Environment Variables**: Key resolution checks `MODEL_API_KEY` first, falling back to `META_API_KEY` (`packages/catalog/src/provider-models/descriptors.ts`).

### Catalog model handling
- **Descriptor & Management**: Defined in `CATALOG_PROVIDERS` (`packages/catalog/src/provider-models/descriptors.ts`) with `defaultModel: "muse-spark-1.1"`. Uses `metaModelManagerOptions` (`packages/catalog/src/provider-models/openai-compat.ts`) constructed via `createOpenAICompatibleModelManagerOptions` (`api: "openai-responses"`, `providerId: "meta"`, `defaultBaseUrl: "https://api.meta.ai/v1"`, `mapModel: mapWithBundledReference`).
- **Static Bundled Models**: `META_MUSE_STATIC_MODELS` (`packages/catalog/src/provider-models/openai-compat.ts`) defines `muse-spark-1.1`:
  - 1,048,576 token context window and 131,072 token max output limit.
  - Multimodal input support (`text`, `image`).
  - Reasoning enabled with effort-based thinking levels (`minimal`, `low`, `medium`, `high`, `xhigh`).
  - Compatibility flags `supportsReasoningEffort: true` and `includeEncryptedReasoning: true`.

## MiniMax (`minimax`)
MiniMax provides foundation models (including MiniMax-M3 and M2 generation) accessible via regional international (`api.minimax.io`) and mainland China (`api.minimaxi.com`) endpoints. Transport depends on descriptor type: standard `minimax` and `minimax-cn` use "Anthropic Messages" (`/anthropic`), while MiniMax Token Plan `minimax-code` and `minimax-code-cn` use "OpenAI Chat Completions" (`/v1`).

### Special casings
- **Cumulative reasoning deltas**: `MINIMAX_PROVIDER_OR_ID_PATTERN` in `packages/catalog/src/compat/openai.ts` flags `reasoningDeltasMayBeCumulative: true` for any provider or model ID matching `/minimax/i`, preventing duplicate reasoning content when streams resend cumulative thinking text.
- **Object tool args**: `streamOpenAICompletions` in `packages/ai/src/providers/openai-completions.ts` intercepts MiniMax-compatible hosts that stream `function.arguments` as raw JSON objects rather than standard JSON strings, deep-merging object deltas into `block.partialArgs` and serializing a single concat-safe string delta at `finishToolCallBlock` before `toolcall_end`.
- **Single system message constraint**: `isMiniMaxHost` in `packages/catalog/src/compat/openai.ts` (matching `api.minimax.io` and `api.minimaxi.com` in `packages/catalog/src/hosts.ts`) sets `supportsMultipleSystemMessagesDefault` to `false`, requiring system prompts to be merged into a single system message.
- **Thinking effort restriction**: `isMinimaxM2FamilyModelId` in `packages/catalog/src/identity/family.ts` enforces `low|medium|high` allowed `reasoning_effort` for M2/M3 models and rejects `minimal`/`xhigh`.
- **Inband XML dialect**: `packages/ai/src/dialect/minimax.ts` registers the `minimax` dialect (`<minimax:tool_call>`) for fallback XML tool invocation parsing.
- **Gateway API overrides**: `OPENCODE_ZEN_API_RESOLUTION` and `OPENCODE_GO_API_RESOLUTION` in `packages/catalog/src/provider-models/openai-compat.ts` force `minimax-m3` / `minimax-m3-free` / `minimax-m2.7` on OpenCode gateways to route over `openai-completions` at `/v1/chat/completions` instead of Anthropic `/v1/messages`.

### Auth & usage
- **Auth keys**: Uses `MINIMAX_API_KEY` (`minimax`), `MINIMAX_CODE_API_KEY` (`minimax-code`), and `MINIMAX_CODE_CN_API_KEY` (`minimax-code-cn`) declared in `packages/catalog/src/provider-models/descriptors.ts`.
- **Token Plan login**: `loginMiniMaxCode` and `loginMiniMaxCodeCn` in `packages/ai/src/registry/oauth/minimax-code.ts` drive browser login flows to `platform.minimax.io` (international) and `platform.minimaxi.com` (China) to prompt and validate API key setup against model `MiniMax-M3`.
- **Usage quota**: `minimaxCodeUsageProvider` in `packages/ai/src/usage/minimax-code.ts` polls `GET /v1/token_plan/remains` at `https://api.minimax.io` (or China equivalent), parsing rolling interval and weekly usage windows per plan bucket into remaining percentages for `omp usage`.

### Catalog model handling
- **Default model**: `MiniMax-M3` set in `packages/catalog/src/provider-models/descriptors.ts` (`minimax`, `minimax-code`, `minimax-code-cn`).
- **Context window policy**: `scripts/generated-policies.ts` overrides `MiniMax-M3` context limits to 1,000,000 tokens for `minimax`, `minimax-cn`, `minimax-code`, and `minimax-code-cn`, matching the documented 1M long-context tier over upstream pricing boundaries.
- **OpenAI completions flags**: `openAiCompletionsDescriptor` in `packages/catalog/src/provider-models/openai-compat.ts` configures `supportsStore: false`, `supportsDeveloperRole: false`, `supportsReasoningEffort: false`, and `reasoningContentField: "reasoning_content"`.

## MiniMax Token Plan (`minimax-code`)
The MiniMax Token Plan provider (`minimax-code`, alongside its mainland China regional variant `minimax-code-cn`) provides access to MiniMax subscription models such as `MiniMax-M3` and `MiniMax-M2.5` using the OpenAI Chat Completions transport over HTTP POST SSE (`https://api.minimax.io/v1` for international, `https://api.minimaxi.com/v1` for China). In contrast to plain `minimax` (which routes over the Anthropic Messages transport using standard static API key authentication), `minimax-code` uses an interactive subscription login flow and features token plan quota monitoring via `omp usage`.

### Special casings
- **Transport Difference from Plain `minimax`**: Plain `minimax` (`minimax` / `minimax-cn`) communicates over the `anthropic-messages` transport (`https://api.minimax.io/anthropic`), whereas `minimax-code` (`minimax-code` / `minimax-code-cn`) targets the `openai-completions` transport (`/v1/chat/completions`).
- **Streaming Object Tool Call Arguments**: `mergeStreamingArgumentObjects` in `packages/ai/src/providers/openai-completions.ts` handles MiniMax backends that stream `function.arguments` as partial JSON objects instead of standard OpenAI JSON strings, deep-merging object properties across deltas to prevent `[object Object]` string coercions.
- **Reasoning Content & Think Tag Deduplication**: Configured with `reasoningContentField: "reasoning_content"` (`packages/catalog/src/provider-models/openai-compat.ts`). The provider parses inline `<think>`...`</think>` tags into thinking blocks while deduplicating MiniMax-M3 cumulative reasoning snapshots to prevent re-emitting thinking text after visible answer content has started.
- **Compat Flag Restrictions**: OpenAI compatibility policy explicitly disables `store`, developer system roles, and reasoning effort controls (`supportsStore: false`, `supportsDeveloperRole: false`, `supportsReasoningEffort: false` in `packages/catalog/src/provider-models/openai-compat.ts`).

### Auth & usage
- **Interactive Subscription Login Flow**: Implemented via `createApiKeyLogin` in `packages/ai/src/registry/oauth/minimax-code.ts` (lazy-loaded by `packages/ai/src/registry/minimax-code.ts` and `minimax-code-cn.ts`). Despite residing under `oauth/`, this is an interactive API key prompt rather than OAuth PKCE: it opens the regional subscription portal (`https://platform.minimax.io/subscribe/token-plan` for international, `https://platform.minimaxi.com/subscribe/token-plan` for China), prompts for key entry (`sk-...`), and validates the key via a `POST /v1/chat/completions` request using `MiniMax-M3`.
- **Environment Variables**: Resolves credentials from `MINIMAX_CODE_API_KEY` for international `minimax-code` and `MINIMAX_CODE_CN_API_KEY` for China `minimax-code-cn` (plain `minimax` resolves `MINIMAX_API_KEY` / `MINIMAX_CN_API_KEY`).
- **Token Plan Quota Tracking**: `minimaxCodeUsageProvider` in `packages/ai/src/usage/minimax-code.ts` queries `GET /v1/token_plan/remains` with `Authorization: Bearer ${apiKey}`.
- **Quota Metric Parsing & Normalization**: Parses `model_remains[]` entries into rolling interval windows (`current_interval_*`) and 7-day windows (`current_weekly_*`). The shared plan quota `general` is scoped as `{ shared: true }`. Calculates `usedFraction` via `(100 - remainingPercent) / 100` and overrides status if `current_*_status === 2` (`STATUS_EXHAUSTED`). Out-of-plan models (status 3 `STATUS_UNLIMITED` with zero totals) are filtered out into `metadata.unavailableModels`. Validates success via `base_resp.status_code === 0` to catch API errors returned under HTTP 200 responses.

### Catalog model handling
- **Provider Descriptors**: Registered in `packages/catalog/src/provider-models/descriptors.ts` (`id: "minimax-code"`, `id: "minimax-code-cn"`), defaulting to `MiniMax-M3`.
- **Catalog Wiring**: `openAiCompletionsDescriptor` in `packages/catalog/src/provider-models/openai-compat.ts` registers descriptors `"minimax-coding-plan"` and `"minimax-cn-coding-plan"` bound to base URLs `https://api.minimax.io/v1` and `https://api.minimaxi.com/v1`.
- **1M Context Tier Override**: Policy generation (`packages/catalog/scripts/generated-policies.ts`) explicitly overrides `MiniMax-M3` context windows for `minimax-code` and `minimax-code-cn` to report the documented 1,000,000-token tier instead of the upstream 512,000-token pricing boundary.
- **Host Matching**: Provider host mapping in `packages/catalog/src/hosts.ts` associates `urlMarkers` `api.minimax.io` and `api.minimaxi.com` with `minimax`, `minimax-code`, and `minimax-code-cn`.

## MiniMax Token Plan (China) (`minimax-code-cn`)
MiniMax Token Plan (China) provides access to MiniMax models for mainland China subscribers using the OpenAI Chat Completions transport (`openai-completions`). It connects to China regional endpoints for subscription onboarding, API key validation, and model execution.

### Special casings
- **Streaming Argument Deep Merge**: `mergeStreamingArgumentObjects` in `packages/ai/src/providers/openai-completions.ts` handles MiniMax backends streaming `function.arguments` as raw JSON objects instead of standard OpenAI JSON strings, recursively merging partial object deltas across stream chunks without failing or coercing arguments to `[object Object]` (`test/issue-1776-repro.test.ts`, `test/issue-2080-repro.test.ts`).
- **Reasoning Deduplication & Think Tags**: `<think>` tags delivered in content streams are normalized into thinking blocks (`test/issue-1203-repro.test.ts`), while `lastCumulativeReasoningBySignature` in `packages/ai/src/dialect/demotion.ts` and `streamOpenAICompletionsOnce` (`packages/ai/src/providers/openai-completions.ts`) deduplicate cumulative reasoning snapshots for `MiniMax-M3` across text block transitions.
- **Unsupported Feature Stripping**: Requests omit unsupported thinking options (`test/issue-955-repro.test.ts`) and apply static compatibility overrides in `packages/catalog/src/provider-models/openai-compat.ts` (`supportsStore: false`, `supportsDeveloperRole: false`, `supportsReasoningEffort: false`, `reasoningContentField: "reasoning_content"`).

### Auth & usage
- **API Key & Interactive Login**: Authenticates via `MINIMAX_CODE_CN_API_KEY` (`packages/catalog/src/provider-models/descriptors.ts`). Interactive login (`loginMiniMaxCodeCn` in `packages/ai/src/registry/oauth/minimax-code.ts`) opens `https://platform.minimaxi.com/subscribe/token-plan` and validates the pasted key via a `MiniMax-M3` completions check against `https://api.minimaxi.com/v1`.
- **Endpoints & Host Detection**: API requests target `https://api.minimaxi.com/v1` (`packages/catalog/src/models.json`). `urlMarkers` includes `api.minimaxi.com` under the `minimax` host classification in `packages/catalog/src/hosts.ts`.
- **Usage Telemetry Availability**: Unlike `minimax-code` (which fetches quota remaining percentages from `https://api.minimax.io/v1/token_plan/remains` via `minimaxCodeUsageProvider` in `packages/ai/src/usage/minimax-code.ts`), `minimax-code-cn` has no usage provider registered (`storage.usageProviderFor("minimax-code-cn")` returns `undefined` in `packages/ai/src/auth-storage.ts` and `test/minimax-token-plan-usage.test.ts`), so usage telemetry is disabled for China regional accounts.

### Catalog model handling
- **Default Model**: Configured to default to `MiniMax-M3` in `CATALOG_PROVIDERS` (`packages/catalog/src/provider-models/descriptors.ts`).
- **1M Context Window Override**: `packages/catalog/scripts/generated-policies.ts` overrides `MiniMax-M3` context window from the upstream 512K pricing boundary to 1,000,000 (1M) tokens (`model.contextWindow = 1_000_000`) for `minimax-code-cn` (alongside `minimax-code`, `minimax`, and `minimax-cn`).
- **Catalog Policy Overrides**: `generated-policies.ts` removes `thinkingFormat` from `model.compat` and enforces `reasoningContentField: "reasoning_content"`, `supportsStore: false`, `supportsDeveloperRole: false`, and `supportsReasoningEffort: false`.

## Mistral (`mistral`)
Mistral AI provides access to Mistral, Codestral, Devstral, Ministral, and Pixtral models via `api.mistral.ai/v1`. Requests use the OpenAI Chat Completions transport (`openai-completions`).

### Special casings
- **Compat Cluster (`packages/catalog/src/compat/openai.ts`: `isMistral`)**:
  - `requiresMistralToolIds` / `toolCallIdKind: "mistral-9-alnum"` (`packages/ai/src/providers/openai-shared.ts`): Restricts tool call IDs to 9-character alphanumeric strings (`[a-zA-Z0-9]{9}`).
  - `requiresAssistantAfterToolResult`: Synthesizes an assistant message bridge following tool result messages prior to subsequent content (`packages/ai/src/providers/openai-completions.ts`).
  - `requiresToolResultName`: Mandates the tool function `name` property on tool result messages (`packages/ai/src/providers/openai-completions.ts`).
  - `requiresThinkingAsText`: Formats reasoning and thinking content as plain text blocks instead of native reasoning fields (`packages/catalog/src/compat/openai.ts`).
  - `maxTokensField: "max_tokens"`: Emits `max_tokens` instead of `max_completion_tokens` in request payloads (`packages/catalog/src/compat/openai.ts`).
- **Array `delta.content` Streaming Normalization (`packages/ai/src/providers/openai-completions.ts`: `normalizeStreamingContentText`)**: Unpacks streaming response chunks where models (e.g. `mistral-medium-2604`) deliver `delta.content` as typed arrays (`[{ type: "text", text: "..." }]`), preventing `[object Object]` string coercion bugs.

### Auth & usage
- **Authentication**: Authenticates using bearer tokens from the `MISTRAL_API_KEY` environment variable (`packages/catalog/src/provider-models/descriptors.ts`: `mistral`).
- **Usage Tracking**: Standard OpenAI chat completions usage parsing (`packages/ai/src/providers/openai-completions.ts`).

### Catalog model handling
- **Provider Descriptor**: Configured via `mistralModelManagerOptions` pointing to `https://api.mistral.ai/v1` (`packages/catalog/src/provider-models/openai-compat.ts`) with default model `devstral-medium-latest` (`packages/catalog/src/provider-models/descriptors.ts`).
- **Host Matching**: Host URL marker matching checks for `mistral.ai` (`packages/catalog/src/hosts.ts`: `mistral`).

## Moonshot (`moonshot`)
Moonshot is the pay-as-you-go open platform provider for Moonshot AI endpoints (`https://api.moonshot.ai/v1` or mainland China `https://api.moonshot.cn/v1`). It rides the `OpenAI Chat Completions` transport engine (`openai-completions` API surface) and shares Kimi-family dialect and thinking mechanics (`isKimiModelId` in `packages/catalog/src/identity/family.ts`). It is distinct from `kimi-code`, which uses subscription device OAuth and subscription endpoints (`api.kimi.com` / `/coding/v1/*`).

### Special casings
- **`MOONSHOT_BASE_URL` Override**: `resolveOpenAIRequestSetup` (`packages/ai/src/providers/openai-shared.ts`) overrides default catalog base URLs (`api.moonshot.ai/v1`) with `$env.MOONSHOT_BASE_URL` (e.g. `https://api.moonshot.cn/v1` for mainland China platform users whose keys are rejected by the international endpoint; issue #2883).
- **Moonshot Flavored JSON Schema (`moonshot-mfjs`)**: `toolSchemaFlavor` defaults to `"moonshot-mfjs"` for native Moonshot hosts (`moonshotNative` in `packages/catalog/src/hosts.ts`) and Kimi model IDs (`isKimiModel`) via `buildOpenAICompat` (`packages/catalog/src/compat/openai.ts`). `normalizeSchemaForMoonshot` (`packages/ai/src/utils/schema/normalize.ts`) normalizes tool parameters (collapses `const` into `enum`, infers `type` on bare enums, strips unsupported constructs) in `packages/ai/src/providers/openai-completions.ts` and `openai-responses.ts` to prevent HTTP 400 validation failures (`tools.function.parameters is not a valid moonshot flavored json schema`).
- **Z.AI Thinking Format & Preserved Thinking**: `isMoonshotKimi` in `packages/catalog/src/compat/openai.ts` sets `thinkingFormat: "zai"`. For `kimi-k2.6` (and `kimi-k2.x` models), `thinkingKeep: "all"` is enabled (`usesMoonshotKimiPreservedThinking` in `compat/openai.ts`). Active reasoning turns emit `thinking: { type: "enabled", keep: "all" }` (or `{ type: "disabled" }` when disabled) in `openai-completions.ts` (`issues #1838`, `#2113`). K3 models use OpenAI-style `reasoning_effort: "max"` via `MOONSHOT_KIMI_K3_THINKING` (`packages/catalog/src/provider-models/openai-compat.ts`).
- **Stream Markup Healing & Inband Control Tags**: `modelMayLeakKimiToolCalls` (`packages/ai/src/utils/stream-markup-healing.ts`) and `detectStreamMarkupHealingPattern` (`packages/catalog/src/compat/openai.ts`) return `"kimi"` for `provider === "moonshot"`, enabling stream parsing for raw inband control tags (`<|tool_calls_section_begin|>`, etc.).
- **Max Token Output Ceiling & Forced Tokens**: `alwaysSendMaxTokens` (`packages/catalog/src/compat/openai.ts`) forces `max_tokens` on every Kimi request because Moonshot calculates TPM rate limits from `max_tokens`. `resolveOpenAIRequestSetup` (`packages/ai/src/providers/openai-shared.ts`) caps `max_tokens` for K3 models (`isKimiK3ModelId`) to `131_072`.
- **Reasoning Content Replay Requirement**: `requiresReasoningContentForToolCalls` (`packages/catalog/src/compat/openai.ts`) forces tool-call continuation turns to replay prior `reasoning_content` (or a synthetic placeholder `.`), preventing Moonshot from aborting or re-deriving reasoning from scratch.

### Auth & usage
- **API-Key Authentication**: `loginMoonshot` (`packages/ai/src/registry/moonshot.ts`) uses `createApiKeyLogin` pointing users to dashboard `https://platform.moonshot.ai/console/api-keys`.
- **Endpoint Validation**: `resolveMoonshotModelsUrl` (`packages/ai/src/registry/moonshot.ts`) validates keys via `GET ${MOONSHOT_BASE_URL || "https://api.moonshot.ai/v1"}/models` (`kind: "models-endpoint"`).
- **Environment Variable Resolution**: `envVars: ["MOONSHOT_API_KEY", "KIMI_API_KEY"]` in `packages/catalog/src/provider-models/descriptors.ts` accepts `KIMI_API_KEY` as a fallback for mainland China users who configure Kimi keys without `MOONSHOT_API_KEY` (issue #2883).
- **No Dedicated Usage Tracker**: Token usage is returned directly in OpenAI stream chunk `usage` objects in `openai-completions`; no separate usage API or file exists in `packages/ai/src/usage/`.

### Catalog model handling
- **Descriptor Registration**: Registered as `moonshot` in `CATALOG_PROVIDERS` (`packages/catalog/src/provider-models/descriptors.ts`) with `defaultModel: "kimi-k2.7-code"`, `envVars: ["MOONSHOT_API_KEY", "KIMI_API_KEY"]`, and `createModelManagerOptions: moonshotModelManagerOptions`.
- **Dynamic Model Discovery**: `moonshotModelManagerOptions` (`packages/catalog/src/provider-models/openai-compat.ts`) uses `createOpenAICompatibleModelManagerOptions` with `defaultBaseUrl: Bun.env.MOONSHOT_BASE_URL ?? "https://api.moonshot.ai/v1"`.
- **Dynamic K3 & K2.x Model Mapping**: In `moonshotModelManagerOptions` (`packages/catalog/src/provider-models/openai-compat.ts`):
  - Unreferenced `kimi-k3` entries are stamped with `reasoning: true`, input `["text", "image"]`, `MOONSHOT_KIMI_K3_COST`, `contextWindow: 1_000_000`, `maxTokens: 131_072`, and effort-based `thinking` config (issue #5756).
  - `kimi-k2.x` entries (e.g. `kimi-k2.5`, `kimi-k2.6`) are marked with `reasoning: true`, vision `["text", "image"]`, and multi-tier effort (`[Minimal, Low, Medium, High]`), ensuring `thinking` payloads are generated so models do not stall (issue #2113).
- **Host & Priority Token Classification**: Host marker `moonshotNative` (`urlMarkers: ["api.moonshot.ai", "api.kimi.com"]`) in `packages/catalog/src/hosts.ts` maps native Moonshot endpoints. Family priority token in `packages/catalog/src/identity/priority.ts` ranks `"moonshot"` right after `"kimi-code"`.

## NanoGPT (`nanogpt`)
NanoGPT is a pay-per-token API gateway exposing diverse open-weights and commercial language models via an OpenAI-compatible interface. It executes requests using the OpenAI Chat Completions transport (`openai-completions`) with a default base URL of `https://nano-gpt.com/api/v1`.

### Special casings
- **DSML Leak Healing**: NanoGPT is included in `modelMayLeakDsmlToolCalls` in `packages/ai/src/utils/stream-markup-healing.ts`. DeepSeek models hosted on NanoGPT (such as `nanogpt/deepseek/deepseek-v4-pro`) that leak `<｜DSML｜tool_calls>...</｜DSML｜tool_calls>` text envelopes during streaming are routed to `getStreamMarkupHealingPattern("nanogpt", modelId)` to heal the stream into structured tool calls.
- **Direct Route Execution**: NanoGPT avoids appending `:tools` model route suffixes on DeepSeek requests, preventing `502` errors with `code: "malformed_tool_call"` triggered by NanoGPT's server-side tool parser on complex schemas.
- **Indexed Tool Delta Preservation**: Relies on `tool_calls[].index` tracking in `streamOpenAICompletionsOnce` (`packages/ai/src/providers/openai-completions.ts`) to ensure parallel streaming tool calls from NanoGPT do not merge or drop arguments across deltas.

### Auth & usage
- **API Key & Environment Variables**: Authenticates via `NANO_GPT_API_KEY` (resolved via `getEnvApiKey` in `packages/ai/src/stream.ts` and configured in catalog descriptors `packages/catalog/src/provider-models/descriptors.ts`).
- **Interactive Login**: `loginNanoGPT` in `packages/ai/src/registry/nanogpt.ts` prompts for an API key linked from `https://nano-gpt.com/api` and validates credentials via `models-endpoint` against `https://nano-gpt.com/api/v1/models`.

### Catalog model handling
- **Descriptor & Options**: Registered in `CATALOG_PROVIDERS` (`packages/catalog/src/provider-models/descriptors.ts`) with default model `openai/gpt-5.5` and options configured via `nanoGptModelManagerOptions` (`packages/catalog/src/provider-models/openai-compat.ts`).
- **Model Variant Filtering**: During dynamic discovery in `fetchDynamicModels`, models matching non-text tokens in `NANO_GPT_NON_TEXT_MODEL_TOKENS` (e.g., `embedding`, `image`, `vision`, `audio`, `speech`, `transcribe`, `moderation`, `realtime`, `whisper`, `tts`) are filtered out by `isLikelyNanoGptTextModelId`.
- **Thinking Variant Detection**: Models with `:thinking` or `:thinking:<level>` suffixes are matched by `NANO_GPT_THINKING_SUFFIX_RE` and excluded from model listings, while their base model IDs are recorded in `thinkingBaseIds` to flag corresponding base models as reasoning-capable (`model.reasoning = true`).

## Novita (`novita`)
Novita AI is an AI cloud platform offering serverless OpenAI-compatible LLM inference for open models. It uses the OpenAI Chat Completions transport over `https://api.novita.ai/openai/v1`.

### Special casings
- Nothing beyond the OpenAI Chat Completions pipeline.

### Auth & usage
- **Authentication**: Configured via `loginNovita` (`packages/ai/src/registry/novita.ts`) using standard API key prompt (`sk_...`) linking to `https://novita.ai/settings/key-management`. Environment variable `NOVITA_API_KEY` is checked via catalog descriptors (`packages/catalog/src/provider-models/descriptors.ts`).
- **Inference-based key validation**: `loginNovita` (`packages/ai/src/registry/novita.ts`) validates keys by sending a 1-token request to `/chat/completions` using `moonshotai/kimi-k2.7-code`. Novita's Developer and Basic team roles lack permission for `/openapi/v1/billing/balance/detail`, so inference validation avoids rejecting valid developer keys.

### Catalog model handling
- **Model discovery**: Configured via `novitaModelManagerOptions` (`packages/catalog/src/provider-models/openai-compat.ts`) with `defaultBaseUrl: "https://api.novita.ai/openai/v1"` and `dynamicModelsAuthoritative: true`.
- **Unauthenticated discovery**: Descriptor sets `catalogDiscovery.allowUnauthenticated: true` (`packages/catalog/src/provider-models/descriptors.ts`), allowing public catalog retrieval from `/openai/v1/models` without an API key.
- **Model filtering**: `filterModel` verifies active status (`status === 1` or non-number), requires `endpoints` to include `"chat/completions"`, checks positive `max_output_tokens`, and excludes internal test model IDs using `isPublicNovitaModelId` (excluding prefixes starting with `ai_infer_test`).
- **Cost scaling**: `toNovitaCostPerMillion` converts price fields (`input_token_price_per_m`, `output_token_price_per_m`, `pricing.input_cache_read.price_per_m`) by dividing by 10,000, scaling Novita's 1/10,000-USD per million rate to standard USD per million tokens.
- **Capabilities & metadata**: `mapNovitaModel` inspects `features` via `novitaArrayIncludes` for `"reasoning"` and `"function-calling"`, parses input modalities with `toInputCapabilities`, and extracts context/output window bounds.

## NVIDIA (`nvidia`)
NVIDIA NIM (Inference Microservice) provides access to hosted open and proprietary foundation models via the OpenAI Chat Completions transport (`openai-completions` API). Base endpoints default to `https://integrate.api.nvidia.com/v1`.

### Special casings
- **Qwen Thinking Format**: Host `nvidia` (`integrate.api.nvidia.com`, `packages/catalog/src/hosts.ts:63`) routes Qwen models (`isQwen`) to `thinkingFormat: "qwen-chat-template"` (`packages/catalog/src/compat/openai.ts:452`). Top-level `enable_thinking` is rejected by NIM's strict request schema (`additionalProperties: false`), so thinking is passed via `chat_template_kwargs.enable_thinking`.
- **DeepSeek Token Stripping & DSML Markup**: `stripDeepseekSpecialTokens` is set to `true` for DeepSeek models under `provider === "nvidia"` (`packages/catalog/src/compat/openai.ts:596,755`), stripping leaked raw `<｜DSML｜...｜>` envelopes and thinking tags from visible output (`packages/ai/test/openai-completions-compat.test.ts:2096-2216`). Registered in `modelMayLeakDsmlToolCalls` for stream markup healing (`packages/ai/src/utils/stream-markup-healing.ts:227`).
- **Tool Choice & Reasoning**: DeepSeek reasoning models disable reasoning when tool choice is active (`disableReasoningOnToolChoice`, `packages/catalog/src/compat/openai.ts:487`), while standard models support forced tool choice (`supportsForcedToolChoice: true`, `packages/ai/test/openai-completions-compat.test.ts:1801`).

### Auth & usage
- **Authentication**: Key-based auth using NVIDIA NGC Personal Keys (`AUTH_URL = "https://org.ngc.nvidia.com/setup/personal-keys"`, `packages/ai/src/registry/nvidia.ts:6`), stored in `NVIDIA_API_KEY` (`packages/catalog/src/provider-models/descriptors.ts:316`). Base URL is `API_BASE_URL = "https://integrate.api.nvidia.com/v1"` (`packages/ai/src/registry/nvidia.ts:7`).
- **Login & Validation**: CLI login (`loginNvidia`, `packages/ai/src/registry/nvidia.ts:12`) validates keys against `VALIDATION_MODEL = "nvidia/llama-3.1-nemotron-70b-instruct"` (`packages/ai/src/registry/nvidia.ts:8`) using `validateOpenAICompatibleApiKey`. Fatal auth errors (`401`/`403`, `AIError.Flag.AuthFailed`) abort login; non-fatal validation errors are caught to allow custom or newly deployed models.
- **Provider Registration**: Registered as `nvidiaProvider` (`packages/ai/src/registry/nvidia.ts:57`, `packages/ai/src/registry/registry.ts:126`). Credential storage and deduplication are tested in `packages/ai/test/auth-storage-email-dedupe.test.ts:756-775`.
- **Usage**: Standard OpenAI Chat Completions usage metrics; no custom usage handler or quota endpoint.

### Catalog model handling
- **Descriptor & Options**: Configured via `nvidiaModelManagerOptions` (`packages/catalog/src/provider-models/openai-compat.ts:1072`) and `openAiCompletionsDescriptor` (`packages/catalog/src/provider-models/openai-compat.ts:5675`).
- **Defaults**: Default context window is `131072` (`packages/catalog/src/provider-models/openai-compat.ts:5676`). Default model is `nvidia/llama-3.1-nemotron-70b-instruct` (`packages/catalog/src/provider-models/descriptors.ts:315`).
- **Catalog Discovery**: Registered in catalog descriptors with `catalogDiscovery: { label: "NVIDIA" }` (`packages/catalog/src/provider-models/descriptors.ts:318`).

## Ollama (`ollama`)
Local OpenAI-compatible provider integration running on local or self-hosted Ollama instances (defaulting to base URL `http://127.0.0.1:11434/v1`). Discovered models ride the shared Ollama and OpenAI Responses transport engines.

### Special casings
- **Tool-Call Error Rewriting**: `rewriteOllamaToolCallJsonError` in `packages/ai/src/error/format.ts` intercepts HTTP 500 tool-call JSON parse failures from the local `llama.cpp` backend matching `LLAMA_CPP_TOOL_CALL_PARSE_PATTERN` and rewrites them to explain deterministic model-output degradation during context overflow.
- **Empty-Length Finish Context Error**: `emptyLengthFinishIsContextError` is set to `true` when `provider === "ollama"` in `buildOpenAICompat` (`packages/catalog/src/compat/openai.ts`), treating empty completions with `finish_reason: "length"` as context overflow errors.
- **KV-Cache Reasoning Replay**: `LOCAL_OPENAI_COMPAT_PROVIDERS` in `packages/catalog/src/compat/openai.ts` includes `"ollama"`, auto-enabling `OpenAICompat.replayReasoningContent` so local Qwen3 / DeepSeek-R1 / GLM chat-templates reconstruct prior `<think>` blocks across turns for byte-identical prefix-KV-cache reuse.
- **DSML Tool-Call Markup Healing**: `modelMayLeakDsmlToolCalls` in `packages/ai/src/utils/stream-markup-healing.ts` and `DSML_HEALING_PROVIDERS` in `packages/catalog/src/compat/openai.ts` include `"ollama"` to heal leaked DeepSeek DSML tool-call envelopes in visible text streams.
- **Wire Reasoning Effort Ladder**: `spec.provider === "ollama"` in `packages/catalog/src/model-thinking.ts` returns `OLLAMA_REASONING_EFFORTS` (`[low, medium, high, max]`), matching Ollama's native wire effort vocabulary without requiring compat-level effort remapping.

### Auth & usage
- **Interactive Login & Optional Key**: `loginOllama` in `packages/ai/src/registry/ollama.ts` prompts via `options.onPrompt` for an optional API key/token (`allowEmpty: true`, placeholder `"ollama-local"`) pointing to `OLLAMA_DOCS_URL`; returning `""` signals local keyless mode. `ollamaProvider` registers `loginOllama`.
- **Usage Provider & Quota Surfacing**: `ollamaUsageProvider` in `packages/ai/src/usage/ollama.ts` (`id: "ollama"`) implements `fetchUsage`, returning a `UsageReport` with empty `limits` and a note that standalone quota endpoints are not exposed; `validatesCredentials` is set to `false`.
- **Environment Variable Fallback**: `envVars: ["OLLAMA_API_KEY"]` in `CATALOG_PROVIDERS` (`packages/catalog/src/provider-models/descriptors.ts`) resolves optional caller credentials from `process.env.OLLAMA_API_KEY`.

### Catalog model handling
- **Descriptor & Keyless Registration**: `CATALOG_PROVIDERS` in `packages/catalog/src/provider-models/descriptors.ts` registers `id: "ollama"` with `defaultModel: "gpt-oss:20b"`, `envVars: ["OLLAMA_API_KEY"]`, `allowUnauthenticated: true` (permitting model manager creation without a key), and `createModelManagerOptions` delegating to `ollamaModelManagerOptions`.
- **Static Bundle Exclusion**: `DISCOVERY_ONLY_PROVIDERS` in `scripts/generate-models.ts` includes `"ollama"`, preventing local endpoints from baking machine-specific localhost models into the committed `models.json`.
- **Dynamic Model Discovery**: `ollamaModelManagerOptions` in `packages/catalog/src/provider-models/openai-compat.ts` normalizes the endpoint via `normalizeOllamaBaseUrl` (defaulting to `http://127.0.0.1:11434/v1`) and queries `/v1/models` using `fetchOpenAICompatibleModels` (`packages/catalog/src/discovery/openai-compatible.ts`). If `/v1/models` is unavailable or empty, it falls back to native `fetchOllamaNativeModels` querying `/api/tags` on `toOllamaNativeBaseUrl` (`http://127.0.0.1:11434`).
- **Capability Probing & Context-Length Stamping**: `fetchOllamaShowMetadata` in `packages/catalog/src/provider-models/openai-compat.ts` posts `{ model: modelId }` to `/api/show` via `createOllamaMetadataResolver`. It extracts context length from `model_info` keys matching `.context_length`, `.num_ctx`, or `.context_window` (falling back to `OLLAMA_FALLBACK_CONTEXT_WINDOW` = 128,000 and `OLLAMA_DEFAULT_MAX_TOKENS` = 8,192). `capabilities.includes("thinking")` sets `reasoning: true` and configures `thinking` efforts (`[minimal, low, medium, high]`), while `capabilities.includes("vision")` stamps `input: ["text", "image"]`.
- **Model Cache Partitioning**: `cacheProviderId` in `ollamaModelManagerOptions` invokes `resolveModelCacheProviderId` (`packages/catalog/src/provider-models/cache-provider-id.ts`), partitioning local model cache keys by `ollama:ollama-models-v1:<hash>` derived from `baseUrl`.

## Ollama Cloud (`ollama-cloud`)
Ollama Cloud provides managed cloud access to open-weight LLMs via native `ollama-chat` protocol endpoints at `https://ollama.com`. It rides the [Ollama](#ollama) transport section, distinguishing itself from local Ollama by requiring explicit API key authentication and enforcing cloud-specific history sanitization and output token caps.

### Special casings
- **Assistant History Thinking Stripping**: `convertMessages` (`packages/ai/src/providers/ollama.ts`) strips `thinking` fields from assistant history messages when `model.provider === "ollama-cloud"`. Ollama Cloud endpoints reject incoming history containing `thinking` with HTTP 400 errors, whereas local `ollama` retains them.
- **Reasoning Effort Mapping**: `mapReasoning` (`packages/ai/src/providers/ollama.ts`) maps reasoning through `model.thinking.effortMap`. `OLLAMA_CLOUD_GLM_52_THINKING` (`packages/catalog/src/provider-models/ollama.ts`) restricts GLM-5.2 reasoning effort levels to `high` and `max`, assigned via `isOllamaCloudGlm52ReasoningEffortModel` (`packages/catalog/src/model-thinking.ts`).
- **Wire-Level Output Token Clamping**: `resolveNumPredict` (`packages/ai/src/providers/ollama.ts`) clamps `options.num_predict` to `OLLAMA_CLOUD_NUM_PREDICT_CAP` (65,536) for `ollama-cloud` models, acting as a safety net against HTTP 400 errors when `maxTokens` or overrides are passed (#3392). Local `ollama` endpoints do not clamp `num_predict`.
- **Stream Markup Healing**: Registered in `DSML_HEALING_PROVIDERS` (`packages/catalog/src/compat/openai.ts`) and `getStreamMarkupHealingPattern` (`packages/ai/src/utils/stream-markup-healing.ts`) for XML/markdown tool call and reasoning recovery.

### Auth & usage
- **Interactive Key Authentication**: `loginOllamaCloud` (`packages/ai/src/registry/ollama-cloud.ts`) prompts for an API key generated at `https://ollama.com/settings/keys`, rejecting empty input with `ApiKeyRequiredError`.
- **Environment Variable Resolution**: `descriptors.ts` (`packages/catalog/src/provider-models/descriptors.ts`) and `getEnvApiKey` (`packages/ai/src/stream.ts`) resolve credentials via `OLLAMA_CLOUD_API_KEY`.
- **Usage Accounting**: `ollamaCloudUsageProvider` (`packages/ai/src/usage/ollama.ts`) handles usage for `ollama-cloud` using `fetchOllamaUsage`. Because Ollama Cloud has no standalone quota API (`validatesCredentials: false`), usage is tracked per-response via `prompt_eval_count` and `eval_count` stream metrics.

### Catalog model handling
- **Descriptor & Discovery Wiring**: Descriptor `CATALOG_PROVIDERS` (`packages/catalog/src/provider-models/descriptors.ts`) defines `defaultModel: "gpt-oss:120b"`, `envVars: ["OLLAMA_CLOUD_API_KEY"]`, options builder `ollamaCloudModelManagerOptions`, and `catalogDiscovery: { label: "Ollama Cloud", oauthProvider: "ollama-cloud" }`.
- **Dynamic Model Discovery & `/api/show` Metadata**: `ollamaCloudModelManagerOptions` (`packages/catalog/src/provider-models/ollama.ts`) fetches models via `GET /api/tags` on `https://ollama.com` using Bearer token auth, then queries `POST /api/show` (`fetchShowMetadata`) per model to inspect capabilities (`thinking`, `vision`) and `model_info` context window size (defaulting to 128,000). Returns an empty list when unauthenticated.
- **Output Token Ceiling & Token Parameter Omission**: `isOllamaCloudOutputCapped` (`packages/catalog/src/provider-models/ollama.ts`) identifies DeepSeek V4 Pro/Flash models, pinning `maxTokens` to `Math.min(contextWindow, OLLAMA_CLOUD_MAX_OUTPUT_TOKENS)` (65,536) to prevent backend rejected requests (ollama/ollama#16890, #7266). All discovered cloud models set `omitMaxOutputTokens: true` (also enforced via `applyGeneratedModelPolicy` in `packages/catalog/scripts/generated-policies.ts`).

## OpenCode Go (`opencode-go`)
OpenCode Go provides access to multi-provider subscription models (including Kimi, DeepSeek, GLM, Qwen, and MiniMax) through a unified gateway at `https://opencode.ai/zen/go`. Depending on the target model, requests route over the OpenAI Chat Completions or Anthropic Messages transport pipelines with dynamic API resolution.

### Special casings
- **API Resolution & Model ID Overrides**: `createOpenCodeApiResolution` (`packages/catalog/src/provider-models/openai-compat.ts`) constructs `OPENCODE_GO_API_RESOLUTION` for `https://opencode.ai/zen/go`. Explicit ID overrides (`minimax-m2.7`, `minimax-m3`, `minimax-m3-free`, `qwen3.5-plus`, `qwen3.6-plus`) take precedence over npm-based heuristics (`@ai-sdk/anthropic`), forcing route resolution to `openai-completions` at `/v1/chat/completions` to prevent gateway 404 HTML errors or raw tool-call markup leaks.
- **Reasoning Tool-Call Replay Policy**: `OPENCODE_WHEN_THINKING` in `packages/catalog/src/compat/openai.ts` is applied when `isOpenCodeProvider` is true (`opencode-go` / `opencode-zen`) and reasoning is active. It sets `requiresReasoningContentForToolCalls: true`, `allowsSyntheticReasoningContentForToolCalls: false`, and `reasoningContentField: "reasoning_content"`, satisfying gateway requirements that 400 when `reasoning_content` is missing on thinking tool-call replays (#1484) or sent when thinking is off (#1071).
- **`X-Api-Key` Auth Normalization**: In `packages/ai/src/providers/anthropic.ts` (lines 3045–3046), when `model.provider === "opencode-go"`, the transport deletes auto-generated `Authorization` Bearer headers so `AnthropicMessagesClient` emits `X-Api-Key`. Bearer-only requests to OpenCode Anthropic endpoints fail with HTTP `401 Missing API key` (#6510).

### Auth & usage
- **API Key Login Flow**: `opencodeGoProvider` (`packages/ai/src/registry/opencode-go.ts`) lazy-imports `loginOpenCode` from `packages/ai/src/registry/oauth/opencode.ts`. It directs the user to `https://opencode.ai/auth` via `onAuth`, prompts for the API key via `onPrompt`, and returns the trimmed key stored under `OPENCODE_API_KEY`.
- **Rolling Spend Windows**: `opencodeGoUsageProvider` (`packages/ai/src/usage/opencode-go.ts`) tracks OMP-observed request costs across three rolling time windows: `rolling-5h` ($12 / 5 hours), `weekly` ($30 / 7 days), and `monthly` ($60 / 30 days). Costs are aggregated from `ctx.listUsageCosts` via `sumWindowCosts` to compute fractional usage, reset timestamps (`resetsAt`), and limit statuses (`ok`, `warning` at >=80%, `exhausted` at >=100%).

### Catalog model handling
- **Authoritative Dynamic Models**: `opencodeGoModelManagerOptions` (`packages/catalog/src/provider-models/openai-compat.ts`) and descriptor configuration (`packages/catalog/src/provider-models/descriptors.ts`, default model `kimi-k2.7-code`) specify `dynamicModelsAuthoritative: true`. Successful runtime discovery via `fetchOpenAICompatibleModels` from `https://opencode.ai/zen/go/v1/models` completely replaces bundled provider models instead of merging fallback-only IDs (`model-manager.ts`).

## OpenCode Zen (`opencode-zen`)
OpenCode Zen (`opencode-zen`) is a subscription service providing access to multi-vendor AI models (Anthropic Claude, DeepSeek, MiniMax, Gemini, etc.) routed through unified proxy endpoints at `https://opencode.ai/zen`. Requests are dispatched dynamically across multiple underlying transport APIs—primarily "Anthropic Messages" (`/zen`), "OpenAI Chat Completions" (`/zen/v1`), "OpenAI Responses" (`/zen/v1`), and "Google Generative AI" (`/zen/v1`)—based on catalog resolution rules, with `claude-opus-4-8` designated as its default model.

### Special casings
- **Multi-API Resolution & Endpoint Wiring**: `createOpenCodeApiResolution` in `packages/catalog/src/provider-models/openai-compat.ts` resolves model transport targets via `@ai-sdk/*` npm metadata. `OPENCODE_ZEN_API_RESOLUTION` defines per-id overrides mapping `"minimax-m3"` and `"minimax-m3-free"` to `"openai-completions"` at `https://opencode.ai/zen/v1`, overriding upstream `@ai-sdk/anthropic` tags that lead to HTTP 400 errors or raw `<invoke>`/`<|minimax|>`/`<tool_call>` markup leaks (#1617).
- **Anthropic Proxy Header & Beta Handling**: In `packages/ai/src/providers/anthropic.ts`, `opencode-zen` deletes default `Authorization` headers (`delete defaultHeaders.Authorization`) and supplies `apiKey` to emit `X-Api-Key` headers. Thinking requests on `opencode-zen` suppress the `context_management_20251015` beta header and body field (`context_management`) because the Zen Anthropic proxy rejects unrecognized fields with `400 Extra inputs are not permitted` (#6510).
- **Thinking Mode Content Replay (`whenThinking`)**: Baseline compat for OpenCode models sets `requiresReasoningContentForToolCalls: false` to prevent sending unrecognized parameters on thinking-disabled requests (#1071). When reasoning is enabled, `buildOpenAICompat` in `packages/catalog/src/compat/openai.ts` constructs an `OPENCODE_WHEN_THINKING` overlay (`requiresReasoningContentForToolCalls: true`, `allowsSyntheticReasoningContentForToolCalls: false`), which `resolveOpenAICompatPolicy` in `packages/ai/src/providers/openai-shared.ts` pointer-swaps in at request time to prevent `400 thinking is enabled but reasoning_content is missing in assistant tool call message` errors (#1484, #2084).
- **Aliased Reasoning Models (`big-pickle`)**: The model ID `big-pickle` is an OpenCode Zen DeepSeek reasoning alias recognized via `isOpenCodeDeepseekAlias` in `packages/catalog/src/compat/openai.ts` and `packages/catalog/src/model-thinking.ts`. It is classified as part of `isDeepseekFamily`, enforcing strict `reasoning_content` replay during thinking tool-call turns.

### Auth & usage
- **API Key Manual Auth**: Configured via the `OPENCODE_API_KEY` environment variable (`CATALOG_PROVIDERS` descriptor in `packages/catalog/src/provider-models/descriptors.ts`).
- **Interactive CLI Login Flow**: `opencodeZenProvider.login` (`packages/ai/src/registry/opencode-zen.ts`) lazily invokes `loginOpenCode` in `packages/ai/src/registry/oauth/opencode.ts`. Despite residing under `oauth/`, it is an API key prompt flow: it opens `https://opencode.ai/auth` in the browser and prompts the user to paste their API key.
- **Wire Authentication**: Credentials across both Anthropic and OpenAI-compatible protocol endpoints are passed via `X-Api-Key` headers rather than standard Bearer tokens.

### Catalog model handling
- **Descriptor & Options**: Catalog entry `opencode-zen` (`packages/catalog/src/provider-models/descriptors.ts`) sets `defaultModel: "claude-opus-4-8"`, `dynamicModelsAuthoritative: true`, and instantiates `opencodeZenModelManagerOptions` from `packages/catalog/src/provider-models/openai-compat.ts`.
- **Dynamic Discovery & Base URL Normalization**: `opencodeZenModelManagerOptions` invokes `openCodeModelManagerOptions("opencode-zen", config)`, fetching dynamic OpenAI-compatible models from `https://opencode.ai/zen/v1/models` (`discoveryBaseUrl`). Models are mapped to positive `contextWindow` (`context_length`) and `maxTokens` (`max_completion_tokens`), with base URLs normalized per API type (`openCodeBaseUrlForApi` / `normalizeOpenCodeBasePath`).
- **Zen vs Go Differences**:
  - **Base URL Root**: Zen uses base path `https://opencode.ai/zen` (completions at `/zen/v1`), whereas OpenCode Go (`opencode-go`) targets `https://opencode.ai/zen/go` (completions at `/zen/go/v1`).
  - **Default Models**: Zen defaults to `claude-opus-4-8`; Go defaults to `kimi-k2.7-code`.
  - **API Resolution Overrides**: Zen (`OPENCODE_ZEN_API_RESOLUTION`) overrides `"minimax-m3"` and `"minimax-m3-free"` to `"openai-completions"`. Go (`OPENCODE_GO_API_RESOLUTION`) overrides `"minimax-m2.7"`, `"minimax-m3"`, `"minimax-m3-free"`, `"qwen3.5-plus"`, and `"qwen3.6-plus"` to `"openai-completions"` to prevent gateway 404s or XML markup leaks (#887, #1617).
  - **Model Aliasing**: Zen includes the `big-pickle` alias (DeepSeek reasoning), which is uniquely detected via `isOpenCodeDeepseekAlias` for DeepSeek compat policy application.

## OpenRouter (`openrouter`)
OpenRouter is a unified multi-provider routing gateway serving hundreds of third-party models over OpenAI-compatible interfaces. Requests execute using the pseudo-API `openrouter`, dispatching by default to the OpenAI Responses transport or falling back to OpenAI Chat Completions based on environment configuration.

### Special casings
- **Pseudo-API Dispatch & Dual-Wire Fallback**: `streamSimple` in `packages/ai/src/stream.ts` evaluates `model.api === "openrouter"`. When `$env.PI_OPENROUTER_RESPONSES !== "0"` (default), it dispatches to `streamOpenAIResponses` ("OpenAI Responses"); when set to `"0"`, it falls back to `streamOpenAICompletions` ("OpenAI Chat Completions"). Catalog compat uses `ResolvedOpenRouterCompat` (`packages/catalog/src/types.ts`), constructed via `buildOpenRouterCompat` in `packages/catalog/src/compat/openai.ts` by combining `ResolvedOpenAICompat` and `ResolvedOpenAIResponsesCompat`.
- **Routing Variant Transformation (`:nitro` / `:floor`)**: Options specifying `openrouterVariant` (`"nitro"`, `"floor"`, `"online"`, `"exacto"`, `"extended"`) map through `applyOpenRouterRoutingVariant` (`packages/ai/src/providers/openai-shared.ts`). The variant suffix (`:<variant>`) is appended to `model.id` at request time unless a colon already exists after the final slash (`lastColon > lastSlash`), preserving explicit user or catalog variant overrides.
- **Provider Order & Exclusion Preferences**: `applyOpenAIGatewayRouting` in `packages/ai/src/providers/openai-shared.ts` injects catalog `openRouterRouting` preferences (`OpenRouterRouting` interface with `only?: string[]` and `order?: string[]`) into the top-level `provider` request parameter when `compat.isOpenRouterHost` is true.
- **Anthropic `cache_control` Breakpoints**: The resolved compat field `cacheControlFormat === "anthropic"` (baseline: OpenRouter host + Anthropic model class) selects the Anthropic cache-marker dialect. On the Chat Completions wire, `applyOpenAIChatCompletionsPromptCachePolicy` (`openai-completions.ts`) attaches `cache_control: { type: "ephemeral" }` to the last non-empty text part of the latest message. On the Responses wire, `applyOpenAIResponsesPromptCachePolicy` (`openai-responses.ts`) sets `params.cache_control = cacheRetention === "long" ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" }`.
- **Catalog Default Max-Tokens Omission**: `resolveOpenAIOutputTokenParam` in `packages/ai/src/providers/openai-shared.ts` omits default output token limits (`max_tokens`, `max_completion_tokens`, `max_output_tokens`) when `isOpenRouterHost` is true and `maxTokensExplicit` is false. This prevents OpenRouter from filtering out upstreams whose advertised output ceiling is below catalog maximums when executing `provider.order` / `only` fallbacks; explicitly specified caller `maxTokens` are retained.
- **Custom Request Headers**: `getOpenRouterHeaders` in `packages/ai/src/utils/openrouter-headers.ts` attaches `User-Agent: omp/<ver>`, `HTTP-Referer: https://omp.sh/`, `X-OpenRouter-Title: omp`, `X-OpenRouter-Categories: cli-agent`, `X-OpenRouter-Cache: true`, and `X-OpenRouter-Cache-TTL: 3600` to all requests for edge response caching.

### Auth & usage
- **Auth Key Validation via `/api/v1/auth/key`**: `loginOpenRouter` in `packages/ai/src/registry/openrouter.ts` configures API key validation using `validateApiKeyAgainstModelsEndpoint` targeted at `https://openrouter.ai/api/v1/auth/key`. Public `/api/v1/models` returns HTTP 200 for unauthenticated requests, so `/api/v1/auth/key` is used as the canonical identity check (returning 200 for valid keys, 401 otherwise). Key resolution checks `OPENROUTER_API_KEY` via `getEnvApiKey` in `packages/ai/src/stream.ts`.
- **Authoritative Reported Cost Reconciling**: `applyProviderReportedCost` in `packages/ai/src/providers/openai-shared.ts` extracts `rawUsage.cost` echoed by OpenRouter and ClinePass. If estimated token cost is finite and positive, input, output, cache-read, and cache-write costs are scaled by `reportedCost / estimatedCost` to match the exact billable total; otherwise, `usage.cost.input` is assigned the reported cost directly.

### Catalog model handling
- **Descriptor & Unauthenticated Discovery**: Registered as `openrouter` in `CATALOG_PROVIDERS` (`packages/catalog/src/provider-models/descriptors.ts`), with `defaultModel: "openai/gpt-5.5"`, `envVars: ["OPENROUTER_API_KEY"]`, and `catalogDiscovery: { label: "OpenRouter", allowUnauthenticated: true }`.
- **Dynamic Discovery & Filter**: `openrouterModelManagerOptions` in `packages/catalog/src/provider-models/openai-compat.ts` queries `https://openrouter.ai/api/v1/models` using `fetchOpenAICompatibleModels` with `api: "openrouter"`. Cache entries are partitioned under `resolveModelCacheProviderId("openrouter")`. Discovered models are filtered to entries specifying `supported_parameters.includes("tools")`.
- **Spec Mapping**: `openrouterModelManagerOptions` maps `modality` (`text`/`image`), pricing per million tokens (`prompt`, `completion`, `input_cache_read`, `input_cache_write`), `context_length`, `top_provider.max_completion_tokens`, and reasoning effort ladders via `mapOpenRouterThinking`.

## Qianfan (`qianfan`)
Qianfan (Baidu Cloud) provides access to Baidu's hosted model family via an OpenAI-compatible v2 API using the OpenAI Chat Completions transport. Entry points include `packages/ai/src/registry/qianfan.ts` (`qianfanProvider`, `loginQianfan`) for provider registration and API key authentication, `packages/catalog/src/provider-models/descriptors.ts` (`CATALOG_PROVIDERS`) for catalog registration, and `packages/catalog/src/provider-models/openai-compat.ts` (`qianfanModelManagerOptions`) for model manager options.

### Special casings
- Nothing beyond the OpenAI Chat Completions pipeline.

### Auth & usage
- **API Key Authentication & Validation**: Authenticates via `QIANFAN_API_KEY` or stored credentials using API keys with format `bce-v3/ALTAK-...` obtained from `https://console.bce.baidu.com/qianfan/ais/console/apiKey`. The CLI login flow (`loginQianfan` in `packages/ai/src/registry/qianfan.ts`) validates credentials using `createApiKeyLogin` by issuing an `openai-completions` request to `https://qianfan.baidubce.com/v2` with `deepseek-v3.2`.
- **Usage & Quotas**: Standard OpenAI Chat Completions token usage tracking (`input`, `output`, `reasoning`) and HTTP status code error handling apply.

### Catalog model handling
- **Provider Descriptor**: Configured in `CATALOG_PROVIDERS` (`packages/catalog/src/provider-models/descriptors.ts`) with `defaultModel: "deepseek-v3.2"`, `envVars: ["QIANFAN_API_KEY"]`, and catalog discovery label `"Qianfan"`.
- **Model Options**: `qianfanModelManagerOptions` (`packages/catalog/src/provider-models/openai-compat.ts`) constructs `openai-completions` options bound to `https://qianfan.baidubce.com/v2` via `createSimpleOpenAICompletionsOptions`.
- **Bundled Models**: Static model specifications in `packages/catalog/src/models.json` define Qianfan models (e.g. `deepseek-v3.2` with `reasoning: true` and `baseUrl: "https://qianfan.baidubce.com/v2"`).

## Qwen Portal (`qwen-portal`)
Qwen Portal provides access to Qwen hosted models via an OpenAI-compatible endpoint at `https://portal.qwen.ai/v1`. It uses the OpenAI Chat Completions transport for model execution and tool calling.

### Special casings
- **System message restriction**: Host matching (`qwenPortal` in `packages/catalog/src/hosts.ts`, matching `portal.qwen.ai`) sets `supportsMultipleSystemMessagesDefault = false` (`packages/catalog/src/compat/openai.ts`). This forces multi-system message blocks to be coalesced into a single block to prevent 500 internal server errors triggered by the default Qwen chat template.

### Auth & usage
- **Environment variables**: Automatically resolves credentials from `QWEN_OAUTH_TOKEN` or `QWEN_PORTAL_API_KEY` (`packages/catalog/src/provider-models/descriptors.ts:385`).
- **Interactive login**: `loginQwenPortal` (`packages/ai/src/registry/qwen-portal.ts:8`) guides users to copy a token or API key from `https://chat.qwen.ai` and prompts for input via `options.onPrompt`.
- **Credential validation**: Validates input tokens against `https://portal.qwen.ai/v1` using `validateOpenAICompatibleApiKey` targeting the `coder-model` (`packages/ai/src/registry/qwen-portal.ts:35`).
- **Usage tracking**: No dedicated usage reporting module exists under `packages/ai/src/usage/`.

### Catalog model handling
- **Descriptor setup**: `qwenPortalModelManagerOptions` uses `createSimpleOpenAICompletionsOptions` (`packages/catalog/src/provider-models/openai-compat.ts:4139`) with default context window 128,000 tokens and max output tokens 8,192 (`openai-compat.ts:5894`).
- **Catalog configuration**: Registered in `descriptors.ts:383` with default model `coder-model`, discovery label `"Qwen Portal"`, and `oauthProvider: "qwen-portal"`.
- **Static model definitions**: Exposes pre-defined static models in `packages/catalog/src/models.json`: `coder-model` (Qwen Coder) and `vision-model` (Qwen Vision, supporting `text` and `image` modalities).

## Sakana AI (`sakana`)
Sakana AI provides reasoning models from the Fugu model family hosted via `api.sakana.ai`.
Requests are routed through the stateful OpenAI Responses transport (`api: "openai-responses"`).

### Special casings
- **Base URL Normalization & Overrides**: `resolveSakanaRequestBaseUrl` in `packages/ai/src/providers/openai-shared.ts`
  and `normalizeSakanaBaseUrl` in `packages/catalog/src/provider-models/openai-compat.ts` resolve base URL overrides
  from `SAKANA_BASE_URL` or fallback `FUGU_BASE_URL`. Base URLs are normalized to remove trailing slashes and ensure
  a `/v1` path suffix, falling back to `https://api.sakana.ai/v1`.

### Auth & usage
- **API Key Resolution**: Environment variable discovery checks `SAKANA_API_KEY` first, then falls back to `FUGU_API_KEY`
  (configured in descriptor `packages/catalog/src/provider-models/descriptors.ts`).
- **Interactive Login**: `loginSakana` in `packages/ai/src/registry/sakana.ts` configures API key login directing users
  to the Sakana AI console (`https://console.sakana.ai/api-keys`), validating credentials against `https://api.sakana.ai/v1/models`.

### Catalog model handling
- **Static Fugu Seeds**: `SAKANA_FUGU_STATIC_MODELS` in `packages/catalog/src/provider-models/openai-compat.ts` exports bundled
  seed specs (`fugu`, `fugu-ultra`, `fugu-ultra-20260615`), with default provider model `fugu`.
- **Dynamic Model Manager**: `sakanaModelManagerOptions` marks live `/models` discovery as authoritative
  (`dynamicModelsAuthoritative: true`) and purges stale cached model rows on seed changes via `dropCachedModelIdsOnStaticMismatch`.
- **Two-Tier Effort Config**: `isSakanaFuguReasoningModel` (`packages/catalog/src/model-thinking.ts`) and `isSakanaFuguModelId`
  (`packages/catalog/src/provider-models/openai-compat.ts`) match Fugu models (`/^fugu(?:$|-)/i`), marking them as reasoning
  models with a two-tier effort scale (`HIGH_MAX_REASONING_EFFORTS`: `[high, max]`).

## SiliconFlow (`siliconflow`)
SiliconFlow is a high-performance AI inference platform providing access to open-source models (such as DeepSeek and GLM). It uses the OpenAI Chat Completions transport (`https://api.siliconflow.com/v1` for global, `https://api.siliconflow.cn/v1` for China region).

### Special casings
- **Dynamic-Only Catalog**: Configured as `dynamicModelsAuthoritative: true` in `CATALOG_PROVIDERS` (`packages/catalog/src/provider-models/descriptors.ts`). No static catalog models are bundled (`catalogDiscovery` is omitted and `MODELS_DEV_PROVIDER_DESCRIPTORS` excludes it for generator bundling); models are discovered live via `/v1/models`.
- **Non-Chat Model Filtering**: `isLikelySiliconFlowChatModelId` in `packages/catalog/src/provider-models/openai-compat.ts` uses `SILICONFLOW_NON_CHAT_MODEL_TOKENS` to filter out non-chat models (embeddings, rerankers, Stable Diffusion, Flux, audio/video generators like Whisper, Wan2, CosyVoice) returned by `/v1/models`.
- **Runtime Metadata Hydration & Fallbacks**: `loadSiliconFlowModelsDevReferences` queries models.dev with a 5,000ms timeout (`SILICONFLOW_MODELS_DEV_REFERENCE_TIMEOUT_MS`). Missing models fall back to canonical bundled specs (`resolveModelReference`) to infer context window, max tokens, and reasoning capabilities while excluding pricing.

### Auth & usage
- **API Key Login**: Authenticates via API key stored in `SILICONFLOW_API_KEY` (or `SILICONFLOW_CN_API_KEY` for `siliconflow-cn`). Interactively registered via `loginSiliconFlow` (`packages/ai/src/registry/siliconflow.ts`) and `loginSiliconFlowCn` (`packages/ai/src/registry/siliconflow-cn.ts`).
- **Endpoint Validation**: Credentials are validated during login via a `models-endpoint` request to `https://api.siliconflow.com/v1/models` (`https://api.siliconflow.cn/v1/models`).
- **Console URLs**: Key creation instructions point to `https://cloud.siliconflow.com/account/ak` (`https://cloud.siliconflow.cn/account/ak` for China region).

### Catalog model handling
- **Manager Construction**: `siliconflowModelManagerOptions` and `siliconflowCnModelManagerOptions` in `packages/catalog/src/provider-models/openai-compat.ts` construct dynamic OpenAI-compatible model managers via `createSiliconFlowModelManagerOptions`.
- **Default Models**: Default model is `zai-org/GLM-5.1` for `siliconflow` and `deepseek-ai/DeepSeek-V4-Pro` for `siliconflow-cn` (defined in `packages/catalog/src/provider-models/descriptors.ts`).
- **Dynamic Model Discovery**: When an API key is available, `fetchDynamicModels` calls `fetchOpenAICompatibleModels` to fetch live models from `/v1/models`, joining models.dev pricing/limits (`mapWithBundledReference`) or canonical fallback references.

## SiliconFlow (China) (`siliconflow-cn`)
SiliconFlow (China) is the domestic China deployment of SiliconFlow's AI model platform, offering OpenAI-compatible LLM inference for open-weight models tailored for regional availability. It uses the OpenAI Chat Completions transport (`openai-completions`) with base URL `https://api.siliconflow.cn/v1`.

### Special casings
- **Endpoint Differences**: Uses `https://api.siliconflow.cn/v1` for model endpoints in `siliconflowCnModelManagerOptions` (`packages/catalog/src/provider-models/openai-compat.ts`), distinct from global `siliconflow` (`https://api.siliconflow.com/v1`).
- **Non-Chat Model Filtering**: Model discovery excludes non-chat model IDs (embedding, reranker, image, TTS, audio, and video models containing tokens such as `bge-`, `bce-`, `stable-diffusion`, `flux`, `kolors`, `sensevoice`, `cosyvoice`, `fish-speech`, `wan2`, etc.) via `isLikelySiliconFlowChatModelId` in `packages/catalog/src/provider-models/openai-compat.ts`.
- **Bundled Upstream Reference Fallback**: Models absent from models.dev recover intrinsic capabilities (`reasoning`, `input`), context window, and max output tokens from bundled upstream model reference definitions (`getBundledModelReferenceIndex`), while provider-specific pricing is omitted.

### Auth & usage
- **Environment Variable**: Authenticates via `SILICONFLOW_CN_API_KEY` configured in descriptor `envVars` (`packages/catalog/src/provider-models/descriptors.ts`), separate from global `SILICONFLOW_API_KEY`.
- **API Key Login**: Configured via `createApiKeyLogin` in `packages/ai/src/registry/siliconflow-cn.ts` with management console URL `https://cloud.siliconflow.cn/account/ak` and validation endpoint `https://api.siliconflow.cn/v1/models`.
- **No Usage Tracking**: No dedicated quota or usage resolution module is present under `packages/ai/src/usage/`.

### Catalog model handling
- **Descriptor Configuration**: Defined in `packages/catalog/src/provider-models/descriptors.ts` with `defaultModel: "deepseek-ai/DeepSeek-V4-Pro"` (vs `zai-org/GLM-5.1` for `siliconflow`), `envVars: ["SILICONFLOW_CN_API_KEY"]`, and `dynamicModelsAuthoritative: true`.
- **Dynamic-Only Model Discovery**: Deliberately omitted from `MODELS_DEV_PROVIDER_DESCRIPTORS` and static catalog generation (`scripts/generate-models.ts`), fetching available chat models live from `https://api.siliconflow.cn/v1/models`.
- **Runtime Reference Hydration**: Live discovered models are cross-referenced with models.dev catalog entries (`SILICONFLOW_MODELS_DEV_DESCRIPTORS`) with a 5-second timeout (`SILICONFLOW_MODELS_DEV_REFERENCE_TIMEOUT_MS`) in `loadSiliconFlowModelsDevReferences` (`packages/catalog/src/provider-models/openai-compat.ts`) to hydrate pricing and limit metadata.

## Synthetic (`synthetic`)
Synthetic is an AI platform offering dual API format support for its models, exposing both OpenAI-compatible (`https://api.synthetic.new/openai/v1/chat/completions`) and Anthropic-compatible (`https://api.synthetic.new/anthropic/v1/messages`) endpoints. Calls default to the `OpenAI Chat Completions` transport, but can switch dynamically to the `Anthropic Messages` transport when configured.

### Special casings
- **Dual API Surface**: `streamSynthetic` (`packages/ai/src/providers/synthetic.ts`) utilizes `streamOpenAIAnthropicShim` (`packages/ai/src/providers/openai-anthropic-shim.ts`) to wrap both OpenAI completions and Anthropic messages endpoints. The API format is selectable via the request's `syntheticApiFormat` option (`"openai"` | `"anthropic"`), defaulting to `"openai"`.
- **Eager Module Import**: `streamSynthetic` and `isSyntheticModel` are imported eagerly in `packages/ai/src/stream.ts` (bypassing lazy builtin registration) to support immediate model provider classification and routing.
- **Dynamic Reasoning & Features**: In `packages/catalog/src/provider-models/openai-compat.ts`, `syntheticModelManagerOptions` maps dynamic model entries from `GET /openai/v1/models`. It checks `supported_features` for `"reasoning"` and parses wire effort tiers (e.g. `reasoning_parameters.efforts`) to construct `thinking` options and set the `reasoning` flag appropriately.

### Auth & usage
- **Authentication**: Key-based auth using `SYNTHETIC_API_KEY` (`packages/ai/src/registry/synthetic.ts`). Validated via `createApiKeyLogin` against `GET https://api.synthetic.new/openai/v1/models`.
- **Usage & Quota Polling**: `syntheticUsageProvider` (`packages/ai/src/usage/synthetic.ts`) polls `GET https://api.synthetic.new/v2/quotas` with the bearer API key. It reports two distinct limit windows:
  - `synthetic:requests:5h`: Rolling 5-hour request limit with per-tick regeneration percentage (`rollingFiveHourLimit`).
  - `synthetic:usd:7d`: Weekly credit limit in USD (`weeklyTokenLimit`) with per-tick dollar regeneration rates.

### Catalog model handling
- Default model: `hf:zai-org/GLM-5.1` (`packages/catalog/src/provider-models/descriptors.ts`).
- `dynamicModelsAuthoritative: true`: Models are fetched dynamically via `syntheticModelManagerOptions` (`packages/catalog/src/provider-models/openai-compat.ts`).
- Modalities and Vision: `input` modalities (`"text"`, `"image"`) are dynamically resolved from `input_modalities`, `supports_vision`, or fallback reference specs.
- Capabilities Filter: `supported_features` strictly bounds tool support; if present without `"tools"`, tool calling is disabled for that model.

## Together (`together`)
Together is a cloud inference provider offering access to various open-source and proprietary foundation models via an OpenAI Chat Completions-compatible API.

### Special casings
- **Strict JSON Schema Mode**: Identified as supporting strict schema mode (`detectStrictModeSupport` in `packages/catalog/src/compat/openai.ts`), enabled for `together` provider ID and `api.together.xyz` base URLs.
- **Multiple System Messages**: Recognized as supporting multiple system messages (`supportsMultipleSystemMessagesDefault` in `packages/catalog/src/compat/openai.ts`), so system messages are not forced to coalesce at index 0.

### Auth & usage
- **API Key Auth**: Authenticates using the `TOGETHER_API_KEY` environment variable or API key input during `pi-ai login together`.
- **Validation**: `loginTogether` validates keys via `createApiKeyLogin` using `chat-completions` against `https://api.together.xyz/v1` with model `moonshotai/Kimi-K2.5`.
- **API Base URL**: `https://api.together.xyz/v1`.

### Catalog model handling
- **Descriptor & Defaults**: Configured in `descriptors.ts` with default model `moonshotai/Kimi-K2.7-Code` and `togetherModelManagerOptions` in `openai-compat.ts`.
- **Catalog Source**: Models generated via `models.dev` descriptor using key `togetherai` mapping to provider `together` at `https://api.together.xyz/v1` (`packages/catalog/src/provider-models/openai-compat.ts`).
- **Host Matching**: Listed in `packages/catalog/src/hosts.ts` matching host URL markers `api.together.xyz` and registered in `priority.ts` identity mapping.

## Umans AI Coding Plan (`umans`)
Umans AI Coding Plan is a proxy service for AI coding models, operating via the Anthropic Messages wire format ("Anthropic Messages") with its default base URL set to `https://api.code.umans.ai`.

### Special casings
- **Auth header strategy**: Anthropic-compatible Umans requests force `X-Api-Key` header authentication (`loginUmans` in `packages/ai/src/registry/umans.ts`) instead of `Authorization: Bearer` (`buildAnthropicClientOptions` in `packages/ai/src/providers/anthropic.ts`).
- **Tool name escaping**: Configured with `compat.escapeBuiltinToolNames: true` (`packages/catalog/src/compat/anthropic.ts`) to prefix client tool names with `_` on outbound requests and strip them on return, avoiding collision with gateway built-in tool names unless gateway web search is active (`packages/ai/src/providers/anthropic.ts`).
- **Gateway web search**: Routes web search requests by inspecting `X-Umans-Websearch-Provider` caller headers or the `UMANS_WEBSEARCH_PROVIDER` (`native` | `exa`) environment variable (`packages/ai/src/providers/anthropic.ts`). When enabled, `web_search` tool names pass through unescaped.
- **Thinking / reasoning effort**: Supports thinking configurations with levels mapped via `UMANS_REASONING_EFFORT_BY_LEVEL` (`packages/catalog/src/provider-models/openai-compat.ts`). GLM-5.2 on Umans uses a two-tier high/max effort scale where `max` maps to the `anthropic-budget-effort` mode (`xhigh` effort) (`packages/catalog/src/model-thinking.ts`).

### Auth & usage
- **Auth**: Uses `UMANS_AI_CODING_PLAN_API_KEY` environment variable or `/login umans` key prompt (`packages/ai/src/registry/umans.ts`, `packages/ai/src/registry/registry.ts`). Key validation executes a lightweight Anthropic messages call (`max_tokens: 1`) to `https://api.code.umans.ai/v1/messages`.
- **Usage endpoint**: Fetches quota and rate limit status from `GET /v1/usage` (`packages/ai/src/usage/umans.ts`) using `Authorization: Bearer <key>`.
- **Limits surfaced**: Returns a rolling 5-hour request split into a model-weighted soft cap (`umans:requests:soft`, the "effective requests" contract) and a raw burst ceiling (`umans:requests:hard`, `hard_cap`), plus an instantaneous session concurrency limit (`umans:concurrency`). The soft cap only ever warns — `exhausted` is reserved for the burst ceiling, where throttling actually starts. Payloads without a reported burst ceiling (`hard_cap`) collapse to a single weighted `umans:requests` row that can exhaust at the effective-request limit, so request exhaustion is never unreportable; legacy payloads without weighted counters fall back to a single raw `umans:requests` row. In both single-row shapes the weighted counter (when present) stays authoritative — raw burst traffic above the limit never fabricates an exhausted state. Also surfaces low-priority status notes when rate-limit bursts occur.

### Catalog model handling
- **Descriptor & discovery**: Registered as `umans` with default model `umans-coder` (`packages/catalog/src/provider-models/descriptors.ts`). Dynamic discovery fetches model details from `GET /v1/models/info` (`packages/catalog/src/provider-models/openai-compat.ts`).
- **Vision capability filtering**: `umansSupportsVision` strictly checks for `supports_vision === true`. Sentinel string values (such as `"via-handoff"` for `umans-glm-5.1` and `umans-glm-5.2`) are mapped to text-only (`["text"]`) so image content is handled via client-side vision handoff rather than sending raw image blocks that cause HTTP 400 errors (`packages/catalog/src/provider-models/openai-compat.ts`).
- **Pricing & fallback**: Generates catalog entries with pricing fallback rules for pay-as-you-go and technical alias models like `umans-qwen3.6-35b-a3b` mapping to `umans-flash` (`packages/catalog/scripts/generate-models.ts`).

## Venice (`venice`)
Venice is a privacy-focused AI platform delivering uncensored and open-source models. It operates over the OpenAI Chat Completions transport (`api: "openai-completions"`) with default base URL `https://api.venice.ai/api/v1`.

### Special casings
- **Qwen Reasoning Dialect**: Venice's strict chat-completions schema rejects DashScope's top-level `enable_thinking`. `buildOpenAICompat` identifies Venice by provider or `api.venice.ai` base URL and routes Qwen reasoning levels through OpenAI-style `reasoning_effort`.
- **Explicit Thinking Off**: `reasoningDisableMode: "venice-disable-thinking"` encodes an explicit off selection as `venice_parameters.disable_thinking: true`, preserving sibling Venice settings such as `include_venice_system_prompt`.

### Auth & usage
- **API Key Login & Validation**: `loginVenice` in `packages/ai/src/registry/venice.ts` uses `createApiKeyLogin` (`packages/ai/src/registry/api-key-login.ts`) to direct users to `https://venice.ai/settings/api` for API keys (`vapi_...` placeholder prefix) and validates credentials via a lightweight `chat-completions` request using validation model `qwen3-4b`. Registered as `veniceProvider` in `packages/ai/src/registry/registry.ts`.
- **Environment Variables & Credentials**: Resolves API keys from the `VENICE_API_KEY` environment variable configured in `CATALOG_PROVIDERS` (`packages/catalog/src/provider-models/descriptors.ts`).
- **Usage Accounting**: Uses standard OpenAI Chat Completions usage accounting (`calculateOpenAIUsageAccounting` in `packages/ai/src/providers/openai-shared.ts`) without custom quota or usage endpoints.

### Catalog model handling
- **Provider Descriptor**: Registered in `CATALOG_PROVIDERS` (`packages/catalog/src/provider-models/descriptors.ts`) with default model `llama-3.3-70b`, `envVars: ["VENICE_API_KEY"]`, and catalog discovery configured with `allowUnauthenticated: true`.
- **Model Manager Options**: `veniceModelManagerOptions` in `packages/catalog/src/provider-models/openai-compat.ts` configures model management using `createOpenAICompatibleModelManagerOptions` over `https://api.venice.ai/api/v1`.
- **Streaming Usage Compat**: In `veniceModelManagerOptions` (`packages/catalog/src/provider-models/openai-compat.ts`), mapped models explicitly disable streaming usage payloads by setting `compat: { ...model.compat, supportsUsageInStreaming: false }`.
- **Kimi K2.7 Code Max Tokens Capping**: `clampKimiK27CodeMaxTokens` in `packages/catalog/src/provider-models/openai-compat.ts` (and `applyKimiMaxTokensCap` in `packages/catalog/scripts/generate-models.ts`) caps output tokens (`maxTokens`) for Kimi K2.7 Code models (`isKimiK27CodeModelId`) to `KIMI_K27_CODE_RECOMMENDED_MAX_TOKENS`.
- **Catalog Transformation**: `openAiCompletionsDescriptor` for Venice in `packages/catalog/src/provider-models/openai-compat.ts` applies `clampKimiK27CodeMaxTokens` during model catalog build and discovery transformations.

## Vercel AI Gateway (`vercel-ai-gateway`)
Vercel AI Gateway routes LLM requests through a unified proxy (`https://ai-gateway.vercel.sh`) to underlying upstream providers (such as Anthropic, OpenAI, or Bedrock). It operates across the Anthropic Messages (`anthropic-messages`), OpenAI Chat Completions (`openai-completions`), and OpenAI Responses (`openai-responses`) transport protocols depending on model configuration.

### Special casings
- **Host Detection**: `isVercelGatewayHost` is evaluated via `modelMatchesHost({ provider, baseUrl }, "vercelAIGateway")` (`packages/catalog/src/compat/openai.ts`, `packages/catalog/src/hosts.ts`), matching `provider === "vercel-ai-gateway"

## vLLM (Local OpenAI-compatible) (`vllm`)
vLLM is an open-source high-throughput LLM serving engine running local or self-hosted OpenAI-compatible inference servers. It uses the OpenAI Chat Completions transport over HTTP/SSE. Entry modules include `packages/ai/src/registry/vllm.ts` for authentication and credential handling, and `packages/catalog/src/provider-models/openai-compat.ts` (`vllmModelManagerOptions`) for catalog options and dynamic model discovery.

### Special casings
- **Reasoning Content Replay (`replayReasoningContent`)**: Registered in `LOCAL_OPENAI_COMPAT_PROVIDERS` (`packages/catalog/src/compat/openai.ts`). Because local inference backends rely on prefix KV-cache reuse, `isLocalOpenAICompatBackend` auto-enables `replayReasoningContent: true`. When assistant history contains reasoning content (`<think>` blocks), it is replayed in `reasoning_content` on subsequent requests to maintain exact prompt token alignments.
- **Qwen Thinking Preservation (`qwenPreserveThinking`)**: Auto-enabled (`packages/catalog/src/compat/openai.ts`) when `thinkingFormat` is `"qwen"` or `"qwen-chat-template"` and `isLocalOpenAICompatBackend` is true. Sets `qwenPreserveThinking: true` on the compat object, emitting `preserve_thinking: true` in request bodies (both top-level and in `chat_template_kwargs`) so Qwen 3.6+ chat templates retain `<think>` blocks across multi-turn histories.
- **Stream Idle Timeout Floor**: As a local serving backend (`isLocalServingBackend` in `packages/catalog/src/compat/openai.ts`), vLLM automatically applies an expanded stream idle timeout floor (`streamIdleTimeoutMs: 300_000` / 5 minutes) rather than the default 100 seconds to accommodate heavy model prefill delays on local GPUs or CPUs.
- **Dynamic-Only Catalog Exclusion**: Included in `DISCOVERY_ONLY_PROVIDERS` (`scripts/generate-models.ts`) and `LOCAL_ONLY_PROVIDERS` (`test/models-json-no-local-endpoints.test.ts`). Local vLLM models are excluded from static catalog generation so machine-specific endpoints are never committed to `models.json`.

### Auth & usage
- **Credential Resolution & Defaults**: Managed via `loginVllm` (`createApiKeyLogin` in `packages/ai/src/registry/vllm.ts`). Reads optional API keys from the `VLLM_API_KEY` environment variable or credentials stored via `omp auth-broker login vllm`.
- **Unauthenticated Local Mode**: Defaults to base URL `http://127.0.0.1:8000/v1` and placeholder token `"vllm-local"` (`DEFAULT_LOCAL_TOKEN`) when no key is supplied (`emptyKeyFallback: "vllm-local"`). Descriptor settings specify `catalogDiscovery: { label: "vLLM", allowUnauthenticated: true }`.
- **Documentation & Endpoint Setup**: The login helper points to `https://docs.vllm.ai/en/latest/serving/openai_compatible_server.html` for configuring local vLLM OpenAI-compatible server endpoints.

### Catalog model handling
- **Descriptor Configuration**: Registered in `packages/catalog/src/provider-models/descriptors.ts` with `id: "vllm"`, `defaultModel: "gpt-oss-20b"`, `envVars: ["VLLM_API_KEY"]`, `allowUnauthenticated: true`, and manager options generated by `vllmModelManagerOptions`.
- **Dynamic Model Discovery**: `vllmModelManagerOptions` (`packages/catalog/src/provider-models/openai-compat.ts`) invokes `fetchOpenAICompatibleModels` with `api: "openai-completions"`, `provider: "vllm"`, base URL `config?.baseUrl ?? getDefaultModelDiscoveryBaseUrl("vllm")!` (`http://127.0.0.1:8000/v1`), and a 10-second timeout (`VLLM_DISCOVERY_TIMEOUT_MS = 10_000`).
- **Context Window Extraction**: Custom `mapModel` in `vllmModelManagerOptions` extracts `contextWindow` from vLLM's non-standard `/v1/models` response field `entry.max_model_len` using `toPositiveNumber(entry.max_model_len, model.contextWindow)`.
- **Cache Provider ID**: Resolved by `resolveModelCacheProviderId("vllm", { baseUrl })` in `packages/catalog/src/provider-models/cache-provider-id.ts` (using `getDefaultModelDiscoveryBaseUrl("vllm")`), generating base-URL-hashed cache keys formatted as `vllm:${Bun.hash(baseUrl).toString(36)}`.

## Wafer Serverless (`wafer-serverless`)
Wafer Serverless is a pay-as-you-go provider proxying multiple upstream models (such as Zhipu GLM, Moonshot Kimi, Alibaba Qwen, and DeepSeek) through an OpenAI-compatible API at `https://pass.wafer.ai/v1`. It relies on the OpenAI Chat Completions transport (`openai-completions`).

### Special casings
- Upstream thinking parameter selection is configured dynamically via `resolveWaferServerlessThinkingFormat` (`packages/catalog/src/provider-models/openai-compat.ts:2137`) based on the `wafer.provider` envelope hint:
  - Upstreams matching `zai`, `zhipu`, `moonshot`, or `kimi` set `thinkingFormat: "zai"`.
  - Upstreams matching `qwen`, `alibaba`, or `dashscope` set `thinkingFormat: "qwen"`.
  - Fallback without envelope hints uses `isReasoningGlmModelId` or `isKimiModelId` for `"zai"` (`packages/catalog/src/provider-models/openai-compat.ts:2150`).
  - Static policies in `generated-policies.ts` apply `thinkingFormat: "zai"` for bundled GLM/Kimi models (`packages/catalog/scripts/generated-policies.ts:364`).
- All reasoning entries configure `reasoningContentField: "reasoning_content"` and set `supportsDeveloperRole: false` (`packages/catalog/src/provider-models/openai-compat.ts:2244`).
- `wafer-pass` has been retired in favor of `wafer-serverless` (`packages/catalog/scripts/generate-models.ts:79`).

### Auth & usage
- Authenticates using Bearer API keys (`wfr_…` prefix) supplied via the `WAFER_SERVERLESS_API_KEY` environment variable (`packages/catalog/src/provider-models/descriptors.ts:465`).
- Interactive login is handled by `loginWaferServerless` using `createApiKeyLogin` (`packages/ai/src/registry/oauth/wafer.ts:14`), pointing users to `https://app.wafer.ai/usage`.
- Key validation probes `https://pass.wafer.ai/v1/models` (`packages/ai/src/registry/oauth/wafer.ts:11`).

### Catalog model handling
- Registered in provider descriptors with `defaultModel: "GLM-5.1"` and base URL `https://pass.wafer.ai/v1` (`packages/catalog/src/provider-models/descriptors.ts:463`).
- Dynamic catalog generation uses `waferServerlessModelManagerOptions` (`packages/catalog/src/provider-models/openai-compat.ts:2252`) and parses the `/v1/models` response via `readWaferRecord` (`packages/catalog/src/provider-models/openai-compat.ts:2151`).
- Map model capabilities from `wafer.capabilities`: `vision` enables `["text", "image"]` input, `reasoning` enables reasoning mode, and `tools` sets `supportsTools` (`packages/catalog/src/provider-models/openai-compat.ts:2193`).
- Context window reads `wafer.context_length` (falling back to `max_model_len`), and `maxTokens` is capped at `65536` (`WAFER_MAX_TOKENS_CAP`, `packages/catalog/src/provider-models/openai-compat.ts:2201`).
- Pricing converts internal wholesale units from `wafer.pricing` to USD/M tokens using `cents * 125 / 10000` (`cents * 0.0125`) (`packages/catalog/src/provider-models/openai-compat.ts:2203`).
- Model IDs are preserved verbatim on the wire without case transformation (`packages/catalog/src/provider-models/openai-compat.ts:2210`).

## xAI API (`xai`)
xAI API (`xai`) provides access to xAI's Grok model suite using standard API key authentication. It routes inference requests through the OpenAI Chat Completions transport (`https://api.x.ai/v1`), distinct from `xai-oauth` which uses OAuth bearer tokens and the OpenAI Responses transport.

### Special casings
- **Grok Host Compatibility**: Host detection (`packages/catalog/src/hosts.ts` symbol `hosts.xai`) matches provider `"xai"` and `api.x.ai` URLs to evaluate `isGrok` in the Chat Completions compatibility layer (`packages/catalog/src/compat/openai.ts` symbol `resolveOpenAICompatForHost`).
- **Prompt Cache Header**: Configures `promptCacheSessionHeader: "x-grok-conv-id"` when `isGrok` is true (`packages/catalog/src/compat/openai.ts` symbol `resolveOpenAICompatForHost`), enabling conversation ID header attachment for prompt cache retention.
- **Reasoning Effort Disabled**: Explicitly sets `supportsReasoningEffort: false` via `!isGrok` check in Chat Completions compatibility (`packages/catalog/src/compat/openai.ts` symbol `resolveOpenAICompatForHost`), contrasting with `xai-oauth`'s selective reasoning-effort support.
- **Provider Priority Ranking**: Positioned in provider priority (`packages/catalog/src/identity/priority.ts` symbol `PROVIDER_PRIORITY`) below `xai-oauth` (`"xai-oauth"` > `"xai"` > `"mistral"`).

### Auth & usage
- **Authentication**: Key-based auth implemented via `createApiKeyLogin` in `packages/ai/src/registry/xai.ts` (symbols `loginXAI`, `xaiProvider`). Directs users to `"https://console.x.ai/team/default/api-keys"` with prompt `"Paste your xAI API key"` (placeholder `"xai-..."`).
- **Validation**: Performs credentials check via `models-endpoint` against `"https://api.x.ai/v1/models"` (`packages/ai/src/registry/xai.ts` symbol `loginXAI`).
- **Environment Fallback**: Configured to resolve `XAI_API_KEY` (`packages/catalog/src/provider-models/descriptors.ts` symbol `descriptors`).
- **Usage Tracking**: Nothing beyond the `OpenAI Chat Completions` pipeline.

### Catalog model handling
- **Descriptor Config**: Provider descriptor (`packages/catalog/src/provider-models/descriptors.ts` symbol `descriptors`) specifies default model `grok-4-fast-non-reasoning` and delegates to `xaiModelManagerOptions`.
- **Manager Options**: Constructed via `createSimpleOpenAICompletionsOptions("xai", "https://api.x.ai/v1", config)` (`packages/catalog/src/provider-models/openai-compat.ts` symbol `xaiModelManagerOptions`).
- **Completions Descriptor**: Registered with `openAiCompletionsDescriptor("xai", "xai", "https://api.x.ai/v1")` (`packages/catalog/src/provider-models/openai-compat.ts` symbol `openAiCompletionsDescriptor`), serving Grok models over the `openai-completions` API.

## xAI Grok OAuth (SuperGrok) (`xai-oauth`)
xAI Grok OAuth provides subscription-backed access (SuperGrok / X Premium+) to xAI Grok models over the OpenAI Responses transport (`api: "openai-responses"`, `baseUrl: "https://api.x.ai/v1"`). Authentication uses RFC 8628 device code flow against `https://auth.x.ai`, while usage tracking probes the dedicated SuperGrok CLI billing proxy.

### Special casings
- **Encrypted Reasoning & History Replay**: `includeEncryptedReasoning` is `false` (`packages/catalog/src/compat/openai.ts` `buildOpenAIResponsesCompat`) to suppress encrypted reasoning item replay. `filterReasoningHistory` is `true` (`packages/catalog/src/compat/openai.ts`, `packages/ai/src/providers/openai-responses.ts`) to filter native reasoning items and thinking signatures out of replayed Responses history.
- **Image Detail Clamping**: `supportsImageDetailOriginal` is `false` (`packages/catalog/src/compat/openai.ts` `buildOpenAIResponsesCompat`), clamping image detail from `"original"` to `"auto"` because xAI endpoints return HTTP 400/422 on `"original"`.
- **Reasoning Effort Gating & Summary**: `supportsReasoningEffort` is `false` unless the model is on the `isGrokReasoningEffortCapable` allowlist (`packages/catalog/src/identity/family.ts`, e.g. `grok-3-mini`, `grok-4.20-multi-agent`, `grok-4.3`, `grok-4.5`). Non-capable models (`grok-build`, `grok-build-0.1`, `grok-4.20-0309-reasoning`, `grok-composer-2.5-fast`) set `omitReasoningEffort: true` to prevent HTTP 400 on `api.x.ai`. `reasoningSummary` is set to `null` (or `undefined` when disabled) in `packages/ai/src/providers/openai-responses.ts` to omit unsupported `reasoning.summary` wire fields.
- **Reasoning Effort Map & Caching**: Maps `minimal` to `"low"` (`packages/catalog/src/provider-models/openai-compat.ts` `XAI_REASONING_EFFORT_MAP`). Sends `X-Grok-Conv-Id` for session prompt-cache retention (`promptCacheSessionHeader`).

### Auth & usage
- **OAuth Authentication**: `xaiOauthProvider` (`packages/ai/src/registry/xai-oauth.ts`) delegates to `loginXAIOAuth` and `refreshXAIOAuthToken` (`packages/ai/src/registry/oauth/xai-oauth.ts`). Executes RFC 8628 device authorization against `https://auth.x.ai` (client ID `b1a00492-073a-47ea-816f-4c329264a828`, scope `openid profile email offline_access grok-cli:access api:access`). `xaiOAuthDiscovery` fetches OIDC configuration and validates endpoints (`validateXAIEndpoint` pins to HTTPS `*.x.ai`). Fetches user identity from `https://auth.x.ai/oauth2/userinfo` (`fetchXAIOAuthIdentity`). Env fallbacks: `XAI_OAUTH_TOKEN` then `XAI_API_KEY` (`descriptors.ts`).
- **Usage Tracking**: `xaiOauthUsageProvider` (`packages/ai/src/usage/xai-oauth.ts`) queries `https://cli-chat-proxy.grok.com/v1/billing` (`validateXAIBillingEndpoint` pins to HTTPS `*.grok.com`) with header `X-XAI-Token-Auth: xai-grok-cli` (`getXAICliBillingHeaders`). Only accepts valid OAuth bearer credentials. Probes legacy weekly credits (`?format=credits`, `parseWeeklyBillingConfig` for `creditUsagePercent` and `productUsage`) and unified monthly quota (`parseMonthlyBillingConfig` for `monthlyLimit` and `used`), plus positive `onDemandCap` / `onDemandUsed` limits.

### Catalog model handling
- **Curated Models & Static Seed**: `XAI_OAUTH_CURATED_MODELS` (`packages/catalog/src/provider-models/openai-compat.ts`) defines static models (`grok-build`, `grok-build-0.1`, `grok-4.3`, `grok-4.5`, `grok-4.6`, `grok-4.20-multi-agent-0309`, `grok-4.20-0309-reasoning`, `grok-4.20-0309-non-reasoning`, `grok-composer-2.5-fast`) with zero cost (`cost: 0`). Default model is `grok-4.6` (`descriptors.ts`). `buildXaiOAuthStaticSeed` seeds `ModelRegistry` synchronously at boot so `modelRoles.default = "xai-oauth/<id>"` works before dynamic refresh.
- **Dynamic Curation Overlay**: `applyXAIOAuthCuration` (`openai-compat.ts`, `xaiOAuthModelManagerOptions`) filters non-chat prefixes (`grok-imagine-`, `grok-stt-`, `grok-voice-`), overlays curated context windows (up to 2M), sets `maxTokens` equal to `contextWindow`, preserves image capabilities and reasoning flags, and injects missing curated models.
- **Reference Resolution Exclusion**: `isZeroCostXaiOAuthCandidate` (`packages/catalog/src/identity/reference.ts`) excludes zero-cost subscription entries from reference index matching so subscription pricing and limits do not override public/paid Grok references.

## Xiaomi MiMo (`xiaomi`)
Xiaomi MiMo delivers Xiaomi's proprietary MiMo model family (such as `mimo-v2.5` and `mimo-v2.5-pro`) over OpenAI-compatible endpoints. Requests execute over the OpenAI Chat Completions transport using standard pay-as-you-go base URLs (`https://api.xiaomimimo.com/v1`) or regional Token Plan base URLs (`https://token-plan-{sgp,ams,cn}.xiaomimimo.com/v1`).

### Special casings
- **MiMo Compat Classification**: Matched via `isXiaomiHost` (`modelMatchesHost(hostModel, "xiaomi")`) and `isMimoModelIdOrName` (`packages/catalog/src/identity/family.ts`) in `packages/catalog/src/compat/openai.ts`.
- **Reasoning Content Invariants**:
  - `requiresReasoningContentForToolCalls: true` (`packages/catalog/src/compat/openai.ts`): MiMo models require exact `reasoning_content` replay on thinking-mode tool-call continuations across standard and Token Plan hosts.
  - `requiresReasoningContentForAllAssistantTurns: true` (`packages/catalog/src/compat/openai.ts`): Enforces `reasoning_content` presence on all prior assistant turns during reasoning mode (except when routed via OpenRouter).
  - `allowsSyntheticReasoningContentForToolCalls: false` (`packages/catalog/src/compat/openai.ts`): Rejects synthetic `reasoning_content` placeholders (e.g. `"."`) on tool-call turns.
- **Thinking Format & Effort Mapping**:
  - `thinkingFormat: "zai"` (`packages/catalog/src/compat/openai.ts`): Formats thinking mode payloads using the z.ai binary `thinking` structure.
  - `supportsReasoningEffort: false` (`packages/catalog/src/compat/openai.ts`): Suppresses standard `reasoning_effort` parameters.
- **Non-Standard Host Protocol Flags**: `isXiaomiHost` is categorized under `isNonStandard` (`packages/catalog/src/compat/openai.ts`), setting `supportsStore: false` and defaulting `supportsDeveloperRole: false`.

### Stream behavior
- **Widen Idle Watchdog Timeout**: `streamIdleTimeoutMs` is widened to 300,000 ms (5 minutes) via `XIAOMI_MIMO_STREAM_IDLE_TIMEOUT_MS` in `packages/catalog/src/compat/openai.ts` because MiMo Pro on `api.xiaomimimo.com` can stall ~2 minutes before emitting its first SSE event (issue #1770).

### Auth & usage
- **Registry & Provider Definitions**: Primary provider is defined in `packages/ai/src/registry/xiaomi.ts` (`xiaomiProvider`); regional Token Plan providers are exported in `packages/ai/src/registry/xiaomi-token-plan-{ams,cn,sgp}.ts` (`xiaomiTokenPlanAmsProvider`, `xiaomiTokenPlanCnProvider`, `xiaomiTokenPlanSgpProvider`).
- **Interactive Key Prompts & Validation**: `loginXiaomi` and `loginXiaomiTokenPlan` (`packages/ai/src/registry/oauth/xiaomi.ts`) prompt for standard (`sk-...`) or Token Plan (`tp-...`) API keys and validate them via `validateXiaomiApiKey`.
- **Token Plan Validation Fallback**: Standard `xiaomi` login with `tp-` keys falls back sequentially through SGP (`https://token-plan-sgp.xiaomimimo.com/v1`) → AMS (`https://token-plan-ams.xiaomimimo.com/v1`) → CN (`https://token-plan-cn.xiaomimimo.com/v1`), using fresh per-endpoint `AbortSignal.timeout(15_000)` signals so regional timeouts do not abort subsequent fallback endpoints. Regional `xiaomi-token-plan-*` logins validate against their specific cluster.
- **Environment Variables**: `XIAOMI_API_KEY` for standard `xiaomi`, and `XIAOMI_TOKEN_PLAN_AMS_API_KEY`, `XIAOMI_TOKEN_PLAN_CN_API_KEY`, `XIAOMI_TOKEN_PLAN_SGP_API_KEY` for regional Token Plan providers (`packages/catalog/src/provider-models/descriptors.ts`).

### Catalog model handling
- **Provider Descriptors**: Catalog descriptors in `packages/catalog/src/provider-models/descriptors.ts` configure `xiaomi`, `xiaomi-token-plan-ams`, `xiaomi-token-plan-cn`, and `xiaomi-token-plan-sgp` with `defaultModel: "mimo-v2.5"`.
- **Dynamic Model Discovery**: `xiaomiModelManagerOptions` in `packages/catalog/src/provider-models/openai-compat.ts` inspects keys (`tp-` vs `sk-`) and provider IDs to query standard or regional `/models` endpoints (`XIAOMI_TOKEN_PLAN_BASE_URLS`), preserving regional provider IDs on returned models.
- **Audio Model Filtering**: Speech and audio models are excluded from discovery and catalog generation (`!model.id.includes("-tts") && !model.id.includes("-asr")`) in `xiaomiModelManagerOptions` (`packages/catalog/src/provider-models/openai-compat.ts`) and `scripts/generate-models.ts`.
- **Host Matching**: `modelMatchesHost` (`packages/catalog/src/hosts.ts`) matches `xiaomi` provider IDs, `xiaomi-token-plan-` provider prefixes, and `xiaomimimo.com` URL markers to the `xiaomi` host class.

## Xiaomi Token Plan (Europe) (`xiaomi-token-plan-ams`)
Xiaomi Token Plan (Europe) (`xiaomi-token-plan-ams`) provides regional access to Xiaomi's MiMo model family (such as `mimo-v2.5` and `mimo-v2-omni`) via Xiaomi's European Token Plan gateway (`https://token-plan-ams.xiaomimimo.com/v1`). It uses the OpenAI Chat Completions transport (`api: "openai-completions"`). This regional provider allows CLI login (`omp login`) and dynamic model lookup to store and validate `tp-` API keys against the European cluster without falling back across regions.

### Special casings
- **Host Matching & Extended Idle Timeout**: Matched under host class `xiaomi` via `providerPrefixes: ["xiaomi-token-plan-"]` in `packages/catalog/src/hosts.ts`. In `packages/catalog/src/compat/openai.ts`, `isXiaomiHost` matches, enabling `isXiaomiMimo` which configures `XIAOMI_MIMO_STREAM_IDLE_TIMEOUT_MS = 300_000` (5-minute stream idle watchdog) to accommodate initial response stalls on MiMo models.
- **TTS/ASR Model Filter**: Dynamic model manager options (`xiaomiModelManagerOptions` in `packages/catalog/src/provider-models/openai-compat.ts`) and model generation scripts (`scripts/generate-models.ts`) filter out audio models (`!model.id.includes("-tts") && !model.id.includes("-asr")`).
- **Provider ID Retention**: `xiaomiModelManagerOptions` (`packages/catalog/src/provider-models/openai-compat.ts`) explicitly sets `providerId: "xiaomi-token-plan-ams"` and maps dynamic discovery entries back to `provider: "xiaomi-token-plan-ams"` rather than collapsing them to generic `xiaomi`.

### Auth & usage
- **Registry Provider & OAuth Lazy Loader**: `xiaomiTokenPlanAmsProvider` in `packages/ai/src/registry/xiaomi-token-plan-ams.ts` registers ID `"xiaomi-token-plan-ams"` and lazy-loads `loginXiaomiTokenPlan` from `packages/ai/src/registry/oauth/xiaomi.ts`.
- **Region Console Instructions**: Interactive CLI login (`loginXiaomiTokenPlan(cb, "ams")`) prompts users for a `tp-` prefix API key and directs them to the Token Plan console URL (`https://platform.xiaomimimo.com/console/plan-manage`).
- **Single-Cluster Validation**: `validateXiaomiApiKey` in `packages/ai/src/registry/oauth/xiaomi.ts` validates keys directly against `https://token-plan-ams.xiaomimimo.com/v1/chat/completions` (using `mimo-v2.5`, `max_tokens: 1`), bypassing the multi-region fallback sequence used by generic `loginXiaomi`.
- **Headers & Errors**: Requests pass standard `Authorization: Bearer tp-...` headers. Authentication or network failures throw `AIError.OAuthError` or `AIError.ApiKeyRequiredError`.

### Catalog model handling
- **Provider Descriptors**: Registered in `CATALOG_PROVIDERS` (`packages/catalog/src/provider-models/descriptors.ts`) with `id: "xiaomi-token-plan-ams"`, `defaultModel: "mimo-v2.5"`, and manager factory `xiaomiModelManagerOptions({ ...config, providerId: "xiaomi-token-plan-ams", tokenPlanRegion: "ams" })`.
- **OpenAI-Compat Descriptor**: Configured via `openAiCompletionsDescriptor("xiaomi-token-plan-ams", "xiaomi-token-plan-ams", "https://token-plan-ams.xiaomimimo.com/v1")` in `packages/catalog/src/provider-models/openai-compat.ts`.
- **Dynamic Model Manager**: `xiaomiModelManagerOptions` (`packages/catalog/src/provider-models/openai-compat.ts`) maps `tokenPlanRegion: "ams"` to base URL `https://token-plan-ams.xiaomimimo.com/v1` for `fetchDynamicModels`, utilizing `createBundledReferenceMap("xiaomi")` for baseline specs.
- **Pre-packaged Catalog Models**: Bundled models (e.g. `mimo-v2-omni`, `mimo-v2.5`) are registered in `packages/catalog/src/models.json` under key `"xiaomi-token-plan-ams"`, setting `baseUrl: "https://token-plan-ams.xiaomimimo.com/v1"` with `api: "openai-completions"`.

## Xiaomi Token Plan (China) (`xiaomi-token-plan-cn`)
Xiaomi Token Plan (China) is the regional China endpoint for Xiaomi MiMo's Token Plan subscription service (`https://token-plan-cn.xiaomimimo.com/v1`). It provides access to MiMo AI models using regional `tp-...` API keys. It uses the "OpenAI Chat Completions" transport.

### Special casings
- **Host classification**: `KNOWN_HOSTS.xiaomi` in `packages/catalog/src/hosts.ts` matches `xiaomi-token-plan-cn` via `providerPrefixes: ["xiaomi-token-plan-"]` and `urlMarkers: ["xiaomimimo.com"]`, enabling host-level compatibility flags across all Token Plan endpoints.
- **Reasoning content replay**: `packages/catalog/src/compat/openai.ts` marks MiMo models on Xiaomi hosts with `requiresReasoningContentForToolCalls: true` and `requiresReasoningContentForAllAssistantTurns: true`, requiring prior assistant tool-call turns to preserve exact `reasoning_content`.
- **Synthetic reasoning rejection**: `allowsSyntheticReasoningContentForToolCalls` in `packages/catalog/src/compat/openai.ts` evaluates to `false` for MiMo models, rejecting synthetic `.` placeholders on tool-call continuations.
- **Extended stream idle timeout**: `XIAOMI_MIMO_STREAM_IDLE_TIMEOUT_MS` (300,000 ms / 5 minutes) in `packages/catalog/src/compat/openai.ts` overrides default first-event/idle timeouts to accommodate pre-generation reasoning stalls.
- **Audio SKU filtering**: `packages/catalog/scripts/generate-models.ts` filters out speech-synthesis and recognition SKUs containing `-tts` or `-asr` for `xiaomi-token-plan-` providers.

### Auth & usage
- **Environment variable & login**: Authenticates via `XIAOMI_TOKEN_PLAN_CN_API_KEY`. `xiaomiTokenPlanCnProvider.login` in `packages/ai/src/registry/xiaomi-token-plan-cn.ts` invokes `loginXiaomiTokenPlan(options, "cn")` in `packages/ai/src/registry/oauth/xiaomi.ts`.
- **Regional API key validation**: Prompts for a `tp-...` key from `https://platform.xiaomimimo.com/console/plan-manage` and validates it via `validateXiaomiApiKey` by sending a `POST /v1/chat/completions` request for `mimo-v2.5` strictly against `https://token-plan-cn.xiaomimimo.com/v1` with a 15-second timeout (`VALIDATION_TIMEOUT_MS`).
- **Usage accounting**: Standard OpenAI Chat Completions usage accounting applies (`calculateOpenAIUsageAccounting`); no provider-specific usage or quota module exists.

### Catalog model handling
- **Provider descriptor**: Configured in `packages/catalog/src/provider-models/descriptors.ts` with `id: "xiaomi-token-plan-cn"`, `defaultModel: "mimo-v2.5"`, `envVars: ["XIAOMI_TOKEN_PLAN_CN_API_KEY"]`, and `createModelManagerOptions` delegating to `xiaomiModelManagerOptions` with `tokenPlanRegion: "cn"`.
- **OpenAI compat entry**: Registered via `openAiCompletionsDescriptor` in `packages/catalog/src/provider-models/openai-compat.ts` with base URL `https://token-plan-cn.xiaomimimo.com/v1`.
- **Regional discovery & model manager**: `xiaomiModelManagerOptions` in `packages/catalog/src/provider-models/openai-compat.ts` pins discovery to `XIAOMI_TOKEN_PLAN_BASE_URLS.cn` (`https://token-plan-cn.xiaomimimo.com/v1`). Dynamic model discovery preserves `providerId: "xiaomi-token-plan-cn"`, filters `-tts` and `-asr` models, and merges metadata from bundled `xiaomi` reference specs using `createBundledReferenceMap("xiaomi")`.

## Xiaomi Token Plan (Singapore) (`xiaomi-token-plan-sgp`)
The Xiaomi Token Plan (Singapore) provider (`xiaomi-token-plan-sgp`) routes requests to Xiaomi's Singapore Token Plan cluster using the OpenAI Chat Completions transport (`openai-completions`). It provides dedicated access to Xiaomi MiMo models (`mimo-v2.5`, `mimo-v2-omni`) using region-bound `tp-...` API keys targeted at `https://token-plan-sgp.xiaomimimo.com/v1`. This regional entry allows login and model storage isolated from standard Xiaomi MiMo (`xiaomi`) and other regional token plan endpoints (`xiaomi-token-plan-ams`, `xiaomi-token-plan-cn`).

### Special casings
- **Regional Base URL Binding**: `xiaomiModelManagerOptions` (`packages/catalog/src/provider-models/openai-compat.ts`) explicitly sets `baseUrl` to `https://token-plan-sgp.xiaomimimo.com/v1` (`XIAOMI_TOKEN_PLAN_BASE_URLS.sgp`) when configured with `tokenPlanRegion: "sgp"`, preventing token-plan keys from reverting to the standard Xiaomi endpoint `https://api.xiaomimimo.com/v1` (`XIAOMI_STANDARD_BASE_URL`).
- **Audio/Speech Model Exclusion**: `fetchOpenAICompatibleModels` (`packages/catalog/src/provider-models/openai-compat.ts`) and model generator filtering in `scripts/generate-models.ts` (`isXiaomiProvider`) filter out non-chat models containing `-tts` or `-asr` from dynamic catalog discovery and generation.
- **Extended Stream Idle Timeout**: `modelMatchesHost` (`packages/catalog/src/hosts.ts`) matches `xiaomi-token-plan-` via `providerPrefixes`, inheriting `XIAOMI_MIMO_STREAM_IDLE_TIMEOUT_MS` (300,000ms / 5 minutes) in `packages/catalog/src/compat/openai.ts` to prevent premature timeouts during long initial response delays on MiMo models.

### Auth & usage
- **Pinned Regional Validation**: `loginXiaomiTokenPlan` (`packages/ai/src/registry/oauth/xiaomi.ts`) validates keys strictly against the Singapore endpoint `https://token-plan-sgp.xiaomimimo.com/v1` (`TOKEN_PLAN_VALIDATION_ENDPOINTS.sgp`) using `validateXiaomiApiKey` (`packages/ai/src/registry/oauth/xiaomi.ts`). Unlike generic `loginXiaomi` (which performs SGP -> AMS -> CN fallback for `tp-` keys), `xiaomi-token-plan-sgp` disables cross-region fallback during auth validation.
- **Plan Management Auth URL**: `loginXiaomiTokenPlan` (`packages/ai/src/registry/oauth/xiaomi.ts`) invoked by `xiaomiTokenPlanSgpProvider` (`packages/ai/src/registry/xiaomi-token-plan-sgp.ts`) prompts users with instructions pointing to `https://platform.xiaomimimo.com/console/plan-manage` (`TOKEN_PLAN_AUTH_URL`) for acquiring regional `tp-` keys (`TOKEN_PLAN_KEY_PREFIX`), contrasting with `STANDARD_AUTH_URL` (`https://platform.xiaomimimo.com/#/console/api-keys`).
- **Validation Handshake**: `validateXiaomiApiKey` (`packages/ai/src/registry/oauth/xiaomi.ts`) tests credentials via `POST /chat/completions` using model `mimo-v2.5` (`TOKEN_PLAN_VALIDATION_MODEL`), `max_tokens: 1`, and `messages: [{ role: "user", content: "ping" }]`, enforcing a 15-second timeout (`VALIDATION_TIMEOUT_MS = 15_000`).
- **Usage Accounting**: Token consumption and cache metrics are calculated using standard OpenAI Chat Completions accounting via `calculateOpenAIUsageAccounting` (`packages/ai/src/providers/openai-shared.ts`).

### Catalog model handling
- **Provider Descriptor**: Registered in `CATALOG_PROVIDERS` (`packages/catalog/src/provider-models/descriptors.ts`) with `id: "xiaomi-token-plan-sgp"`, `defaultModel: "mimo-v2.5"`, and `createModelManagerOptions` supplying `tokenPlanRegion: "sgp"` and `providerId: "xiaomi-token-plan-sgp"`. Static model metadata is declared in `openAiCompletionsDescriptor` (`packages/catalog/src/provider-models/openai-compat.ts`).
- **Provider Identity Preservation**: `xiaomiModelManagerOptions` (`packages/catalog/src/provider-models/openai-compat.ts`) dynamic model fetcher (`fetchOpenAICompatibleModels`) tags all discovered models with `provider: "xiaomi-token-plan-sgp"` and `baseUrl: "https://token-plan-sgp.xiaomimimo.com/v1"`, ensuring stored model selections map back to the Singapore provider entry.
- **Bundled Spec Mapping**: Dynamic model mapping uses `createBundledReferenceMap` (`packages/catalog/src/provider-models/openai-compat.ts`) to merge dynamic models with static reference specs defined under `"xiaomi"` in `packages/catalog/src/models.json`.

## Z.AI (GLM Coding Plan) (`zai`)
Z.AI provides GLM family models (such as `glm-5.2`) via Zhipu AI's coding plan infrastructure using the Anthropic Messages transport (`https://api.z.ai/api/anthropic`). Authentication supports both direct API keys and an OAuth browser sign-in flow that mints a durable API key.

### Special casings
- **`zai` thinking format dialect**: `isZaiThinkingFormat` (`packages/catalog/src/model-thinking.ts`) and `isZaiReasoningEffortDialect` (`packages/ai/src/providers/openai-shared.ts`) identify endpoints using the `thinkingFormat: "zai"` dialect (`thinking: { type: "enabled" | "disabled" }`). When reasoning is turned off (`reasoningDisableMode === "zai-thinking-disabled"` or wire effort `"none"`), `resolveOpenAICompatPolicy` (`packages/ai/src/providers/openai-shared.ts`) sets `params.thinking = { type: "disabled" }`.
- **Reasoning content continuation replay**: In `streamOpenAICompletionsOnce` (`packages/ai/src/providers/openai-completions.ts`), when `compat.thinkingFormat === "zai"` and `model.reasoning` is true, preserved thinking blocks are re-serialized into `assistantMsg.reasoning_content` on cross-API provider switches (e.g. Anthropic → OpenAI) to preserve structured reasoning history without text demotion (#3434).
- **Foreign thinking preservation**: `targetReadsForeignThinking` in `packages/ai/src/providers/transform-messages.ts` returns true for reasoning models with `compat.thinkingFormat === "zai"`, preserving non-native thinking blocks across message transforms.
- **Max output token clamping**: `resolveOpenAICompletionsOutputClamp` in `packages/ai/src/providers/openai-shared.ts` clamps output for `isZaiReasoningEffortDialect` models (`glm-5.2`) to `model.maxTokens` rather than the default 64k ceiling.
- **Host URL matching**: `hostMatchesUrl` in `packages/catalog/src/hosts.ts` matches Z.AI endpoints against the `api.z.ai` URL marker.

### Auth & usage
- **API Key Login**: `loginZai` in `packages/ai/src/registry/zai.ts` prompts for `ZAI_API_KEY` (dashboard `https://z.ai/manage-apikey/apikey-list`) and validates via a chat completions probe against `https://api.z.ai/api/coding/paas/v4` with model `glm-5.2` (`VALIDATION_MODEL`).
- **OAuth flow & browser sign-in**: `zaiCodingPlanProvider` (`packages/ai/src/registry/zai.ts`) routes sign-in to `loginZaiOAuth` / `ZaiOAuthFlow` (`packages/ai/src/registry/oauth/zai.ts`). It initiates authorization at `AUTHORIZE_URL` (`https://chat.z.ai/api/oauth/authorize`) with the ZCode-registered CLI redirect `http://127.0.0.1:9999/callback` (paste-code fallback) and exchanges authorization codes at `TOKEN_URL` (`https://zcode.z.ai/api/v1/oauth/token`).
- **Durable key minting**: `mintZaiApiKey` (`packages/ai/src/registry/oauth/zai.ts`) exchanges the short-lived OAuth token for a business token via `businessLogin` (`https://api.z.ai/api/auth/z/login`), resolves default org/project via `getCustomerInfo` (`BIZ_BASE` = `https://api.z.ai`), creates or reuses key `"oh-my-pi"` (`KEY_NAME`), and copies the secret via `/copy/${apiKey}` to output a durable 49-char `${apiKey}.${secretKey}` token saved as `storeCredentialsAs: "zai"`.
- **Usage & quota fetcher**: `fetchZaiUsage` / `zaiUsageProvider` (`packages/ai/src/usage/zai.ts`) queries `QUOTA_PATH` (`/api/monitor/usage/quota/limit`) on `DEFAULT_ENDPOINT` (`https://api.z.ai`) with direct key authorization. `parseLimitItem` parses `TOKENS_LIMIT` into token quotas (`zai:tokens:<window>`), `TIME_LIMIT` into request quotas (`zai:requests:<window>` or `zai:features:zread:<window>` when `isZaiFeatureRequestLimit` matches), and `CREDIT_LIMIT` into credit quotas (`zai:credits:<window>`, unit `credits`) for the credit-based GLM Coding Plan (e.g. 12k credits / 5h + 60k credits / week; `usage` is the allotment, `currentValue` the spend). The payload's `data.level` (e.g. `"lite"`, `"pro"`, `"max"`) is surfaced as `metadata.planType`. `buildZaiWindow` maps time units to 1h, 1d, 1mo, or 1w windows, and optionally fetches `MODEL_USAGE_PATH` (`/api/monitor/usage/model-usage`).
- **Credential ranking**: `zaiRankingStrategy` (`packages/ai/src/usage/zai.ts`, registered in `packages/ai/src/auth-storage.ts`) ranks request limits via `rankZaiRequestLimits` (falling back to the full credential limit set — tokens/requests/credits — when no request quotas exist), selecting primary 5-hour and secondary weekly quota windows.

### Catalog model handling
- **Descriptor & PAYG pricing**: `MODELS_DEV_PROVIDER_DESCRIPTORS_CODING_PLANS` in `packages/catalog/src/provider-models/openai-compat.ts` defines `anthropicMessagesDescriptor("zai", "zai", "https://api.z.ai/api/anthropic")`, mapping models.dev `zai` pay-as-you-go pricing key instead of `zai-coding-plan` to avoid surfacing subscription rates as all-$0 Free models (#5598).
- **Default model & context policy**: `PROVIDER_DESCRIPTORS` in `packages/catalog/src/provider-models/descriptors.ts` sets default model `glm-5.2`. `generated-policies.ts` (`packages/catalog/scripts/generated-policies.ts`) pins `glm-5.2` context window to 1,000,000 tokens, while `dropUnusableZaiContextTierIds` (`packages/catalog/scripts/generate-models.ts`) filters out `[1m]` context tier ID suffixes.
- **GLM-5.2 effort support**: `getModelDefinedEfforts` in `packages/catalog/src/model-thinking.ts` (checked via `isAnthropicMessagesGlm52ReasoningEffortModel`) assigns `HIGH_MAX_REASONING_EFFORTS` (`["high", "max"]`) to `glm-5.2`, treating `"none"` as the disabled state rather than a user tier level.

## ZenMux (`zenmux`)
ZenMux is a multi-provider gateway using dual transport routing based on model ownership. Models owned by Anthropic (identified by `owned_by: "anthropic"` or an `anthropic/` prefix) route through Anthropic Messages (`https://zenmux.ai/api/anthropic`), while all other models route through OpenAI Chat Completions (`https://zenmux.ai/api/v1`).

### Special casings
- **Dual Transport Base URL Normalization**: `normalizeZenMuxOpenAiBaseUrl` and `toZenMuxAnthropicBaseUrl` (`packages/catalog/src/provider-models/openai-compat.ts`) translate between endpoint URLs. OpenAI endpoints default to `https://zenmux.ai/api/v1` and Anthropic routes to `https://zenmux.ai/api/anthropic`, automatically converting paths when custom base URLs are specified.
- **Anthropic Proxy Signature Integrity**: `KNOWN_HOSTS.zenmux` (`packages/catalog/src/hosts.ts`) identifies ZenMux as a signing host. In `buildAnthropicCompat` (`packages/catalog/src/compat/anthropic.ts`), `isZenmux` marks the proxy as a `signingEndpoint`, setting `replayUnsignedThinking: false`. This ensures historical thinking blocks retain valid signatures rather than replaying empty signatures that trigger HTTP 400 errors.
- **Strict Mode Support**: `detectStrictModeSupport` (`packages/catalog/src/compat/openai.ts`) enables strict structured tool outputs for ZenMux OpenAI-compatible endpoints.

### Auth & usage
- **API Key Resolution**: `ZENMUX_API_KEY` is registered in `descriptors.ts` (`packages/catalog/src/provider-models/descriptors.ts`) and resolved via `getEnvApiKey("zenmux")` in `packages/ai/src/stream.ts`.
- **Key Validation & Login**: `loginZenMux` in `packages/ai/src/registry/zenmux.ts` directs users to `https://zenmux.ai/settings/keys` and validates credentials with `kind: "models-endpoint"` against `https://zenmux.ai/api/v1/models`.
- **Unauthenticated Discovery**: `allowUnauthenticated: true` in `descriptors.ts` enables model catalog discovery without requiring an API key.

### Catalog model handling
- **Descriptor & Default Model**: `descriptors.ts` defines the provider descriptor with default model `anthropic/claude-opus-4.8`.
- **Dynamic Model Discovery**: `zenmuxModelManagerOptions` in `packages/catalog/src/provider-models/openai-compat.ts` queries `https://zenmux.ai/api/v1/models` using `fetchOpenAICompatibleModels`. `isZenMuxAnthropicModel` inspects `entry.owned_by === "anthropic"` or ID prefix `anthropic/` to set `api: "anthropic-messages"` or `api: "openai-completions"`.
- **Pricing Extraction**: `getZenMuxPricingValue` and `getZenMuxCacheWritePrice` (`packages/catalog/src/provider-models/openai-compat.ts`) extract token costs from `entry.pricings`: `prompt` for input cost, `completion` for output cost, `input_cache_read` for cache read cost, and hierarchical lookup of `input_cache_write_1_h`, `input_cache_write_5_min`, or `input_cache_write` for cache write cost.
- **Capabilities & Limits**: Maps `entry.display_name`, `entry.context_length` (`contextWindow`), `entry.max_completion_tokens` (`maxTokens`), `entry.input_modalities` (`input`), and `capabilities.reasoning` (`reasoning`).

## Zhipu Coding Plan (智谱) (`zhipu-coding-plan`)
Zhipu (智谱) BigModel's domestic coding-plan provider using the OpenAI Chat Completions transport (`openai-completions` API). It routes requests to Zhipu's dedicated Coding Plan endpoint (`https://open.bigmodel.cn/api/coding/paas/v4`) rather than the general BigModel endpoint to ensure API calls consume coding-plan quota instead of account balance.

### Special casings
- **Z.AI Thinking Format & Reasoning Effort**: Configures `thinkingFormat: "zai"` (`packages/catalog/src/compat/openai.ts` line 447) to structure thinking outputs via `thinking: { type: "enabled" }` and `reasoning_content` deltas (cross-referencing the Z.AI format). Enables `supportsReasoningEffort` only for GLM-5.2+ models via `isGlm52ReasoningEffortModelId` (`packages/catalog/src/compat/openai.ts` lines 283, 469).
- **Stream Watchdog Idle Floor**: Applies a 600s (`600_000` ms) stream idle timeout floor (`GLM_CODING_PLAN_STREAM_IDLE_TIMEOUT_MS = 600_000`, `GLM_CODING_PLAN_MODEL_PATTERN` in `packages/catalog/src/compat/openai.ts` lines 39-40, 417) for GLM coding-plan model IDs (`glm-5...`) when `isZhipu` is active, avoiding spurious stream watchdog aborts during long reasoning phases.
- **Max Tokens & System Messages**: Sets `useMaxTokens: true` (`packages/catalog/src/compat/openai.ts` line 362) and enables `supportsMultipleSystemMessages: true` (`packages/catalog/src/compat/openai.ts` line 408) for `isZhipu`.

### Auth & usage
- **Credentials & API Base**: Authenticates via `ZHIPU_API_KEY` (`packages/catalog/src/provider-models/descriptors.ts` line 541) with API base URL `https://open.bigmodel.cn/api/coding/paas/v4` (`packages/ai/src/registry/zhipu-coding-plan.ts` line 6) and dashboard URL `https://bigmodel.cn/coding-plan/personal/overview` (`packages/ai/src/registry/zhipu-coding-plan.ts` line 5).
- **API Key Login & Validation**: `loginZhipuCodingPlan` (`packages/ai/src/registry/zhipu-coding-plan.ts` line 10) uses `createApiKeyLogin` with key format `<id>.<secret>`, validating against `glm-5.1` at `https://open.bigmodel.cn/api/coding/paas/v4`. Host detection is wired via `hosts.ts` (`zhipu`, urlMarker `open.bigmodel.cn`, `packages/catalog/src/hosts.ts` line 42).
- **Chinese-Language 429 Quota Classification**: `CN_QUOTA_EXHAUSTED_PATTERN` in `packages/ai/src/error/rate-limit.ts` line 60 (`/使用.{0,30}?上限|(?:额度|配额)已?(?:用|耗)(?:完|尽)|限额.{0,30}重置|余额不足/`) classifies Zhipu's 429 quota exhaustion responses (`"429 已达到 5 小时的使用上限。您的限额将在 ... 重置。"`) as `QUOTA_EXHAUSTED`, triggering credential rotation instead of transient backoff.

### Catalog model handling
- **Provider Descriptor**: Registered in `CATALOG_PROVIDERS` (`packages/catalog/src/provider-models/descriptors.ts` line 539) with default model `glm-5.1`, `dynamicModelsAuthoritative: true`, and model manager options from `zhipuCodingPlanModelManagerOptions` (`packages/catalog/src/provider-models/openai-compat.ts` lines 1689, 5764).
- **GLM Identity Classification**: Uses `parseGlmModel` (`packages/catalog/src/identity/classify.ts` line 145) to parse `glm-<version>[v][-<variant>]` into family (`"glm"`), version, vision flag (`v`), and variant (`base`, `air`, `turbo`, `flash`, `flashx`, `preview`).
- **Capability Gates & Policies**: `isReasoningGlmModelId` (`packages/catalog/src/identity/family.ts` line 219) gates reasoning on version >= 4.5 (`base`/`air`/`turbo`), `isGlm52ReasoningEffortModelId` gates `reasoning_effort` on version >= 5.2, and `isGlmVisionModelId` detects vision models (`glm-4v`, `glm-4.5v`). Generated policy pins `glm-5.2` context window to 1,000,000 tokens (`packages/catalog/scripts/generated-policies.ts` line 332).
