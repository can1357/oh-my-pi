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


Catalog entries are authored in `packages/catalog/src/compat/rules/providers/*.kdl` and exposed by `providerEntries()` / `providerEntry()` in `packages/catalog/src/compat/providers.ts`. `packages/catalog/src/provider-models/descriptors.ts` contains runtime model-manager factories and builds `PROVIDER_DESCRIPTORS` only for providers with a factory; it is not the catalog-entry source. Auth/login/refresh policy is authored separately in `rules/auth/*.kdl`.

`classifyModel` in `packages/catalog/src/compat/taxonomy.ts` resolves class, family, and revision from compiled taxonomy rules. `resolveModelPolicy` in `packages/catalog/src/compat/resolve.ts` combines API defaults, host facts, the KDL cascade, and explicit spec overrides, then bakes compat and thinking metadata. `packages/catalog/src/model-thinking.ts` reads that metadata at runtime rather than reclassifying IDs. Reviewed effort-family collapse and aliases use `reviewedCollapseTable` in `packages/catalog/src/compat/collapse.ts`, backed by `rules/taxonomy/_collapse.kdl`.

## OpenAI Chat Completions
The OpenAI Chat Completions provider implements HTTP POST JSON body streaming over Server-Sent Events (SSE) for the standard OpenAI `/chat/completions` wire contract (`ChatCompletionCreateParamsStreaming` request schema and `ChatCompletionChunk` event payloads). It serves as the primary workhorse transport for OpenAI models as well as dozens of OpenAI-compatible gateways and third-party providers including Groq, Cerebras, Mistral, DeepSeek, Fireworks, Zhipu (Z.AI), Qwen (DashScope), Kimi (Moonshot), Synthetic, GitLab Duo, OpenRouter, Vercel AI Gateway, CoreWeave, HuggingFace, Nvidia NIM, Novita, GMI Cloud, Baseten, NanoGPT, and Sakana/Fugu. The transport is implemented across `packages/ai/src/providers/openai-completions.ts` (main streaming runner `streamOpenAICompletions`), `packages/ai/src/providers/openai-chat-wire.ts` (vendored wire types), `packages/ai/src/providers/openai-shared.ts` (shared request/policy/usage helpers), `packages/ai/src/providers/openai-reasoning-fallback.ts` (400 reasoning-effort recovery), `packages/ai/src/utils/openai-http.ts` (HTTP SSE client `postOpenAIStream`), and `packages/ai/src/utils/empty-completion-retry.ts` (`withReplaySafeStreamRetry` wrapper).

### Special casings
- **Azure Deployment Name Mapping**: `parseAzureDeploymentNameMap` in `packages/ai/src/providers/openai-shared.ts` parses the `AZURE_OPENAI_DEPLOYMENT_NAME_MAP` environment variable (comma-separated `modelId=deploymentName` pairs) in `createRequestSetup` (`packages/ai/src/providers/openai-completions.ts`) to translate model IDs into Azure deployment names, defaulting to `model.id` if unmapped.
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
- **Credential resolution**: `getEnvApiKey` in `packages/ai/src/stream.ts` delegates to the compiled auth registry. Provider environment keys and hooks are declared in `packages/catalog/src/compat/rules/auth/*.kdl`; explicit request credentials and custom provider configuration can supply keys independently.
- **Usage Accounting & Quota Surfacing**: `calculateOpenAIUsageAccounting` (`packages/ai/src/providers/openai-shared.ts`) reconciles input, output, cache-read, and cache-write tokens into standard `Usage` records. OpenRouter and ClinePass authoritative gateway charges are populated into `output.usage.cost` via `applyProviderReportedCost`. Copilot request counts are stored in `output.usage.premiumRequests`. Transport HTTP errors (e.g. 429 Rate Limit, 408 Timeout, 5xx Server Error) are thrown as `OpenAIHttpError` (`packages/ai/src/utils/openai-http.ts`), capturing status, headers, and error envelope details for upstream error mapping in `AIError.finalize`.

### Catalog model handling
- **Provider entry (`openai`)**: `packages/catalog/src/compat/rules/providers/openai.kdl` declares default model `gpt-5.5`. Environment keys: `OPENAI_API_KEY`.
- **Authored seeds**: `daybreak-blue-latest`, `daybreak-red-latest`, `gpt-5.6-cyber`, `whisper-1`, `gpt-4o-transcribe`, `gpt-4o-mini-transcribe`, `text-embedding-3-small`, `text-embedding-3-large`, `text-embedding-ada-002`; bundle policy `always`. Limits, capabilities, and prices are authored alongside these rows.
- **Model Resolvers & Managers**: `createOpenAICompatibleModelManagerOptions` in `packages/catalog/src/provider-models/openai-compat.ts` constructs model managers for `openai-completions` providers. It combines static/curated model definitions, bundled reference specs (`getBundledModels`), and live models fetched from remote catalog endpoints.
- **Catalog Discovery**: `fetchOpenAICompatibleModels` in `packages/catalog/src/discovery/openai-compatible.ts` queries provider `/models` endpoints. It safely parses envelopes (`data`, `models`, `result`, `items`), enforces request timeouts using `withOpenAICompatibleDiscoveryTimeout`, validates model record schemas (`openAICompatibleModelRecordSchema`), applies custom mappers/filters, and deduplicates models by ID.

## OpenAI Responses
The OpenAI Responses provider (`packages/ai/src/providers/openai-responses.ts`) handles OpenAI's stateful `/v1/responses` HTTP Server-Sent Events (SSE) streaming wire protocol (types defined in `openai-responses-wire.ts`, shared encoding and decoding logic in `openai-shared.ts`). Unlike chat completions, the Responses API operates on a structured item sequence (`ResponseInput`) containing typed input/output items (`input_text`, `input_image`, `input_file`, `message`, `function_call`, `custom_tool_call`, `computer_call`, `reasoning`), supports server-side context chaining via `previous_response_id`, explicit prompt-cache breakpoints, and native reasoning summaries and encrypted content blocks.

### Special casings
- **Responses input-item model vs chat messages**: `buildResponsesInput` in `openai-shared.ts` converts standard conversation contexts into the `ResponseInput` array (`ResponseInputItem[]`). System instructions use top-level `instructions` by default or developer-role items (`{ role: "developer" }`) when `policy.messages.systemRole === "developer"` (required for reasoning models). Replayed history strips or retains reasoning items based on `filterReasoningHistory`, while Harmony dialect models (GPT-5+) escape reserved control token spellings in replayed transport data via `escapeReplayedControlTokens`.
- **`previous_response_id` chaining & stale-chain reset**: `buildOpenAIResponsesChainedParams` in `openai-responses.ts` manages stateful turns. When `statefulResponses` is active (default ON for official OpenAI endpoints via `PI_OPENAI_STATEFUL` and the baked `officialEndpoint` flag; requires a routing session ID and `providerSessionState`), requests force `store: true` and calculate a delta payload (`buildResponsesDeltaInput`) anchored to `previous_response_id`. If history mutates, options change, or prompt-cache breakpoint policy alters, the chain resets to a full replay (`resetOpenAIResponsesChainState`). If the endpoint returns a stale ID error (`isOpenAIResponsesStalePreviousResponseError`), the provider increments `staleFailures` and falls back to a full transcript replay; after `OPENAI_RESPONSES_CHAIN_STALE_FAILURE_LIMIT` (3) consecutive failures, chaining is disabled for the session. Zero Data Retention (ZDR) org errors (`markOpenAIResponsesChainZeroDataRetention`) immediately disable chaining for the session and force `store: false`.
- **Encrypted reasoning items & summaries**: Supports `include: ["reasoning.encrypted_content"]` via `policy.reasoning.includeEncryptedReasoning`. `ResponseReasoningItem` objects contain encrypted content payloads, reasoning text deltas (`response.reasoning_text.delta`), and summary text deltas (`response.reasoning_summary_text.delta`). Thinking signatures carrying serialized JSON are parsed via `parseResponseReasoningReplayItem` and replayed as native `reasoning` items when `filterReasoningHistory` is false.
- **Composite `callId|itemId` tool IDs**: `normalizeResponsesToolCallId` in `packages/ai/src/utils.ts` handles tool call ID normalization. Tool call identifiers in Responses are composite strings formatted as `${callId}|${itemId}`. The function splits incoming IDs on `|` into distinct `callId` (truncated to 64 chars with `call_` prefix) and `itemId` (prefixed with `fc_` or `ctc_`). When an un-synthesized ID is passed, it generates a hash-based pair (`call_<hash>` and `fc_<hash>` / `ctc_<hash>`). Transformed messages use `normalizeResponsesToolCallIdForTransform` to preserve alignment across tool calls and tool result messages.
- **Custom (freeform) tools & computer tools**: Tool conversion in `convertTools` handles function, custom, and computer tools. When `model.applyPatchToolType === "freeform"` (checked via `supportsFreeformApplyPatch`), custom format tools (like `apply_patch`) are encoded as `type: "custom"` with grammar definitions (`compactGrammarDefinition`). When `model.supportsComputerUse === true`, native computer tools (`type: "computer"`) emit `computer_call` and `computer_call_output` items using structured `ComputerAction` lists; models without native computer support fall back to regular function tools. Tool schemas are sanitized via `sanitizeSchemaForOpenAIResponses` and `adaptSchemaForStrict`, and schemas violating strict constraints are quarantined (`findStrictToolSchemaViolation`) to prevent invalid MCP schemas from failing entire requests.
- **Stable effort controls**: On `supportsConfigurationUpdate` models, `applyResponsesStableEffort` keeps request-level effort byte-stable and carries later changes in `configuration_update` input items. It requires a routing session ID and provider session state; without both, each request sends its own effort.
- **Service tier & obfuscation opt-out**: `serviceTier` option is passed down to sampling params and reported in output usage via `processResponsesStream`. When `model.compat.supportsObfuscationOptOut` is true, sampling parameters include `stream_options: { include_obfuscation: false }`.
- **Image detail handling**: Image content conversion in `convertResponsesInputContent` and `appendResponsesToolResultMessages` respects `model.compat.supportsImageDetailOriginal`. When false, `"original"` image detail values are mapped to `"auto"` to prevent upstream rejection. The [provider compatibility reference](./provider-compat-reference.md) owns the multimodal tool-result encoding contract.

### Stream behavior
- **Stream event protocol (`response.*` lifecycle)**: `processResponsesStream` in `openai-shared.ts` processes SSE events emitted by `/v1/responses`. Handles lifecycle events including `response.created`, `response.output_item.added`, `response.output_text.delta`, `response.reasoning_text.delta`, `response.reasoning_summary_text.delta`, `response.function_call_arguments.delta`, `response.custom_tool_call_input.delta`, `response.output_item.done`, `response.completed`, and `response.done`. Interleaved parallel tool calls are tracked concurrently across `output_index`, `item_id`, and prefixed call ID lookup maps (`openItemsByOutputIndex`, `openItemsByItemId`, `openItemsByPrefixedCallId`).
- **Watchdogs & transient retries**: `streamOpenAIResponsesOnce` uses `iterateWithIdleTimeout` with two timeout thresholds: `streamFirstEventTimeoutMs` (with `X-Stainless-Timeout` request header) for initial response headers/events and `streamIdleTimeoutMs` for inter-event stalls. If a stream terminates prematurely before emitting replay-unsafe output (`isOpenAIResponsesReplayUnsafeEvent`), the single-attempt streamer performs a transient retry (`OPENAI_RESPONSES_MAX_TRANSIENT_STREAM_RETRIES = 1`) after a delay (`OPENAI_RESPONSES_TRANSIENT_STREAM_RETRY_DELAY_MS = 500ms`). The public `streamOpenAIResponses` wraps execution with `withReplaySafeStreamRetry` to retry empty completions.

### Auth & usage
- Standard OpenAI auth relies on `OPENAI_API_KEY` (or provider-specific environment variables) resolved via `getEnvApiKey` and `resolveOpenAIRequestSetup` in `openai-shared.ts`. Requests pass standard Bearer token authorization headers (`Authorization: Bearer <key>`) alongside optional Stainless/Copilot headers. *(Note: `openai-codex` / ChatGPT subscription plan OAuth auth is handled separately).*

### Catalog model handling
- **Provider entry (`openai`)**: `packages/catalog/src/compat/rules/providers/openai.kdl` declares default model `gpt-5.5`. Environment keys: `OPENAI_API_KEY`.
- **Authored seeds**: `daybreak-blue-latest`, `daybreak-red-latest`, `gpt-5.6-cyber`, `whisper-1`, `gpt-4o-transcribe`, `gpt-4o-mini-transcribe`, `text-embedding-3-small`, `text-embedding-3-large`, `text-embedding-ada-002`; bundle policy `always`. Limits, capabilities, and prices are authored alongside these rows.


## OpenAI Codex
The OpenAI Codex provider integrates ChatGPT Plus/Pro subscription models using the OpenAI Responses API surface over SSE or WebSocket transport. Requests target the ChatGPT backend (`https://chatgpt.com/backend-api/codex/responses` or custom base URL) using ChatGPT OAuth tokens with account-level isolation. Entry modules include streaming in `packages/ai/src/providers/openai-codex-responses.ts`, request transformation in `packages/ai/src/providers/openai-codex/request-transformer.ts`, error and rate-limit parsing in `packages/ai/src/providers/openai-codex/response-handler.ts`, quota and usage tracking in `packages/ai/src/usage/openai-codex.ts`, reset management in `packages/ai/src/usage/openai-codex-reset.ts`, base URL normalization in `packages/ai/src/usage/openai-codex-base-url.ts`, auth policy in `packages/catalog/src/compat/rules/auth/openai-codex.kdl`, and OAuth handling in `packages/ai/src/registry/oauth/openai-codex.ts`.

### Special casings

Provider-specific overrides in `packages/catalog/src/compat/rules/providers/openai-codex.kdl` (more-specific selectors override provider defaults):

- For class openai; revision >=5.3.0 <5.7.0: `thinking.mode="effort"`.
- For class openai; revision >=5.4.0: `supportsAllTurnsReasoningContext=true`.
- For class openai; revision <5.4.0: `supportsReasoningSummary=false`.
- For class unknown; revision >=5.4.0: `supportsAllTurnsReasoningContext=true`.
- For class unknown; revision >=5.6.0: `requiresReasoningOffJuiceInstruction=true`.
- Provider defaults: `harmonyLeakMitigation=true`.

- **WebSocket vs SSE dual transport**: Supports WebSocket streaming (`v2StreamingEnabled: true`, header `OpenAI-Beta: responses_websockets=2026-02-06`, `preferWebsockets` option) via `CodexWebSocketConnection` in `packages/ai/src/providers/openai-codex-responses.ts`. Reuses sockets with a max idle reuse cap (`CODEX_WEBSOCKET_MAX_IDLE_REUSE_MS` = 30s), ping/pong heartbeats (10s interval, 60s timeout), and queue capacity (4096). Instantly falls back to SSE on connection/handshake failures (`CODEX_WEBSOCKET_FATAL_PATTERNS`, `CodexWebSocketTransportError`).
- **Sampling parameter stripping**: Sampling parameters (`temperature`, `top_p`, `top_k`, `min_p`, `presence_penalty`, `repetition_penalty`, `frequency_penalty`, `stop`) are stripped in `packages/ai/src/providers/openai-codex/request-transformer.ts` `transformRequestBody`; the Codex backend returns HTTP 400 `Unsupported parameter` if any sampling parameters are sent (#3117).
- **Responses Lite transport**: Normal inference uses full Responses by default; callers opt into Lite with the `responsesLite` request option or `PI_CODEX_RESPONSES_LITE=1`, while provider-native compaction explicitly follows the catalog's `useResponsesLite` flag. Function `applyCodexResponsesLiteShape` embeds declared tools into a leading `additional_tools` developer item, system instructions into a developer message, strips image `detail`, turns off parallel tool calls, forces `reasoning.context: "all_turns"`, and appends `x-openai-internal-codex-responses-lite: true` header (or `ws_request_header_x_openai_internal_codex_responses_lite` in WS `client_metadata`). Hosted tool choices (`tool_choice`) fall back to `"auto"` if no matching declared tool is present (#5771).
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

### Auth & usage
- **OAuth login flows**: Implements ChatGPT OAuth declared in `packages/catalog/src/compat/rules/auth/openai-codex.kdl` (`login "oauth-code"`, engine `packages/ai/src/registry/engine/oauth-code.ts`) and `openai-codex-device.kdl` with hooks in `packages/ai/src/registry/oauth/openai-codex.ts`. Browser flow uses PKCE S256 (`createOpenAICodexAuthorizationUrl`) with fixed local port 1455 (`http://localhost:1455/auth/callback`), client ID `app_EMoamEEZ73f0CkXaXp7hrann`, and simplified CLI flow flags. Headless device-code flow (`loginOpenAICodexDevice`) uses `https://auth.openai.com/api/accounts/deviceauth/usercode` and polls `deviceauth/token`.
- **Token refresh & claims**: The `refresh` request in `packages/catalog/src/compat/rules/auth/openai-codex.kdl` posts a refresh-token grant to `https://auth.openai.com/oauth/token`; the generic registry refresh engine executes it. `getTokenProfile` and `openAICodexProfileHook` in `packages/ai/src/registry/oauth/openai-codex.ts` extract account and profile claims and preserve stored organization identity on refresh.
- **Account rotation & rate-limit ranking**: Account identity is set via `ChatGPT-Account-Id` header (`getCodexAccountId`). `codexRankingStrategy` in `packages/ai/src/usage/openai-codex.ts` isolates standard chat limits (5h primary, 7d secondary) from Spark meter limits (`-spark` model suffix spends `spark` scope), preventing Spark exhaustion from blocking normal chat requests.
- **Usage tracking**: `openaiCodexUsageProvider` queries `/wham/usage` on canonical ChatGPT origins. Parses `primary_window` (5h) and `secondary_window` (7d), plus `additional_rate_limits` (Spark/extra meters). Ingests response headers (`x-codex-primary-used-percent`, `x-codex-primary-window-minutes`, `x-codex-primary-reset-at`, `x-codex-secondary-*`) in `parseCodexRateLimitHeaders` (`response-handler.ts` `parseCodexError`).
- **Saved rate limit reset credits**: Reads `rate_limit_reset_credits` from `/wham/usage`. Lists available credits with `listCodexResetCredits` (`GET /wham/rate-limit-reset-credits`), selects soonest-expiring credit with `pickSoonestExpiringCredit`, and redeems via `consumeCodexResetCredit` (`POST /wham/rate-limit-reset-credits/consume` with client UUID `redeem_request_id`).
- **Base URL normalization**: `normalizeCodexBaseUrl` in `packages/ai/src/usage/openai-codex-base-url.ts` forces account API requests (`wham/usage`, reset credits) to canonical `chatgpt.com` or `chat.openai.com` origins (`/backend-api`), ignoring custom proxy overrides (`providers.openai-codex.baseUrl`) that would 404. Stream URLs resolve via `resolveCodexResponsesUrl` in `openai-codex-responses.ts`.

### Catalog model handling
- **Provider entry (`openai-codex`)**: `packages/catalog/src/compat/rules/providers/openai-codex.kdl` declares default model `gpt-5.5`. Environment keys: `OPENAI_CODEX_OAUTH_TOKEN`.
- **Authored seeds**: `gpt-image-2`; bundle policy `always`. Limits, capabilities, and prices are authored alongside these rows.
- **Dynamic discovery**: `fetchCodexModels` in `packages/catalog/src/discovery/codex.ts` queries `/codex/models` or `/models` with `v2StreamingEnabled: true`, parsing `reasoning_presets` (`effort`, `summary`) into `ModelSpec<"openai-codex-responses">`.
- **Pricing fallback**: `applyCodexPricingFallback` in `packages/catalog/scripts/generate-models.ts` copies billable costs from `openai` provider entries with matching model IDs when Codex discovery models lack explicit cost metadata.

## Azure OpenAI
Azure OpenAI Responses provider (`azure-openai-responses`) handles transport, endpoint resolution, and compatibility wrapping for OpenAI-family models (GPT-4/4.1/4o, GPT-5 series, o-series, Codex) served over Azure OpenAI's Responses API. It uses the internal `postOpenAIStream` transport (`packages/ai/src/utils/openai-http.ts`) to make JSON-POST / SSE requests. Stream generation is initialized in `streamAzureOpenAIResponses` (`packages/ai/src/providers/azure-openai-responses.ts`), while shared Responses input/output processing logic lives in `packages/ai/src/providers/openai-shared.ts`.

### Special casings

Provider-specific overrides in `packages/catalog/src/compat/rules/providers/azure.kdl` (more-specific selectors override provider defaults):

- For class openai: `thinking.mode="effort"`.
- For models codex-mini, gpt-chat-latest: `thinking.efforts=["minimal","low","medium","high","xhigh"]`.
- For models gpt-5.1-codex, gpt-5.1-codex-max: `thinking.efforts=["minimal","low","medium","high"]`.
- For models gpt-5.1-codex-mini: `thinking.efforts=["medium","high"]`.
- For models gpt-6-astra*: `disableReasoningWithTools=true`, `reasoningDisableMode="none-effort"`.

- **Deployment-name mapping**: Azure OpenAI requires deployment names in request payloads. `resolveDeploymentName` (`packages/ai/src/providers/azure-openai-responses.ts`) checks `options.azureDeploymentName`, then checks the `AZURE_OPENAI_DEPLOYMENT_NAME_MAP` environment variable (parsed by `parseAzureDeploymentNameMap` in `openai-shared.ts` into a map of `modelId=deploymentName` pairs, e.g. `gpt-5-mini=my-mini-dep,o3=my-o3-dep`), and defaults to `model.id`.
- **Base-URL / resource resolution**: `resolveAzureConfig` (`packages/ai/src/providers/azure-openai-responses.ts`) checks `options.azureBaseUrl` or `$env.AZURE_OPENAI_BASE_URL`. If missing, it constructs `https://${resourceName}.openai.azure.com/openai/v1` from `options.azureResourceName` or `$env.AZURE_OPENAI_RESOURCE_NAME`. If still missing, it falls back to `model.baseUrl`, throwing `AIError.ConfigurationError` if no endpoint is found. Trailing slashes are stripped.
- **API-version handling**: `resolveAzureConfig` resolves the API version from `options.azureApiVersion`, `$env.AZURE_OPENAI_API_VERSION`, or defaults to `"v1"`. It is passed as the `api-version` URL query parameter on the request (`${baseUrl}/responses?api-version=${apiVersion}`), not as an HTTP header.
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
- **Provider entry (`azure`)**: `packages/catalog/src/compat/rules/providers/azure.kdl` declares default model `gpt-5.5`. Environment keys: `AZURE_OPENAI_API_KEY`.
- **Why bundled models carry no `baseUrl`**: Azure OpenAI endpoints are resource-specific and unknown during catalog generation (`models.json` stores `baseUrl: ""`). Runtime resolution resolves endpoints from `AZURE_OPENAI_BASE_URL` or `AZURE_OPENAI_RESOURCE_NAME`. Compat detection (`isAzure` in `packages/catalog/src/compat/resolve.ts`) matches `provider === "azure"`, ensuring bundled models with empty `baseUrl` still receive Azure compat flags (`strictResponsesPairing`, `supportsDeveloperRole`, `supportsStrictMode`).

## Anthropic Messages
The Anthropic provider (`packages/ai/src/providers/anthropic.ts`) implements the Anthropic Messages API protocol over HTTPS POST to `/v1/messages` (or `/v1/messages?beta=true`) using Server-Sent Events (SSE) for streaming. Custom HTTP client transport is provided by `AnthropicMessagesClient` (`packages/ai/src/providers/anthropic-client.ts`), replacing `@anthropic-ai/sdk` with built-in retry and timeout logic. Wire structures and SSE payloads are typed in `packages/ai/src/providers/anthropic-wire.ts`. Client fingerprinting constants (version, user agent, tool prefix) live in `packages/ai/src/providers/claude-code-fingerprint.ts`, while the streaming path uses `buildClaudeCodeTlsFetchOptions` for Claude Code TLS options.

### Special casings
- **OAuth vs API-key paths**: `buildAnthropicHeaders` in `packages/ai/src/providers/anthropic.ts` detects OAuth through `options.isOAuth ?? isAnthropicOAuthToken(apiKey)`. OAuth enforces Bearer authorization and defaults to `Accept: application/json`; API-key requests to the official endpoint use `X-Api-Key`. Non-official endpoints ordinarily use Bearer authorization. Caller authorization is honored outside OAuth and Cloudflare branches; Cloudflare uses `cf-aig-authorization`. Controlled OAuth fingerprint overrides are permitted only on non-official, non-Cloudflare endpoints.
- **Claude Code fingerprint**: OAuth uses `getClaudeCodeUserAgent()` from `packages/ai/src/providers/claude-code-fingerprint.ts`: `claude-cli/<version> (external, cli)`, with fallback version `2.1.280`. `PI_AI_CLAUDE_CODE_VERSION` overrides it; a newer version required by a server rejection can be adopted. `buildClaudeCodeBetas` in `anthropic.ts` distinguishes agent and utility calls; agent calls include the OAuth, Claude Code, interleaved-thinking, token-count, context-management, prompt-cache-scope, and mid-conversation-system betas, adding effort for thinking and fallback-credit support. The 1M-context beta is intentionally omitted for subscription credentials. Billing attestation and metadata use `generateClaudeCloakingUserId`, `deriveClaudeDeviceId`, and `resolveAnthropicMetadataUserId`.
- **System-Prompt Injection**: `buildAnthropicSystemBlocks` (`packages/ai/src/providers/anthropic.ts`) automatically prepends `claudeCodeSystemInstruction` ("You are Claude Code, Anthropic's official CLI for Claude.") as `system[0]` for OAuth credentials. Mid-conversation system messages in turn history are enabled for Opus 4.8+ / Sonnet 5+ via `mid-conversation-system-2026-04-07`.
- **Thinking Signatures & Redacted Thinking**: Replaying modified or unsigned thinking blocks causes Anthropic API errors (`invalid signature in thinking block`). `convertAnthropicMessages` converts `ThinkingContent` and `RedactedThinkingContent` (`type: "redacted_thinking"`, `data`). `maybeAddReplayUnsignedThinkingHint` attaches recovery hints on signature errors, while `unwrapAnthropicThinkingEnvelope` strips legacy `<thinking>` XML wrappers.
- **Tool Use Replay & Prefixes**: `encodeAnthropicToolName` / `decodeAnthropicToolName` (`packages/ai/src/providers/anthropic.ts`) prefixes custom tool names with `_` (`claudeToolPrefix`) when using OAuth to prevent collisions with built-in tools (`web_search`, `code_execution`, `text_editor`, `computer`). Server-executed web searches and tool searches (`AnthropicServerToolHistoryBlockParam` in `anthropic-wire.ts`) are detected via `isAnthropicServerToolHistoryBlock` for turn replay. Empty tool errors are filled by `ensureErrorToolResultWireContent`.
- **Strict-Tool Schema Normalization & Fallback**: `normalizeAnthropicToolSchema` and `normalizeAnthropicStrictSchema` strip unsupported JSON schema keywords (e.g. `minItems`/`maxItems` on objects) for the `structured-outputs-2025-12-15` beta. If a strict tool schema causes HTTP 400, `streamAnthropicOnce` calls `dropAnthropicStrictTools` and automatically retries without strict mode.
- **Adaptive vs Budget Thinking**: `ThinkingConfigParam` (`anthropic-wire.ts`) supports budget thinking (`{ type: "enabled", budget_tokens: N }` enforced by `ensureMaxTokensForThinking`) and adaptive thinking (`{ type: "adaptive" }` paired with `output_config: { effort: level }` via `effort-2025-11-24` beta). Forced tool choices (`disableThinkingIfToolChoiceForced`) automatically disable thinking. Thinking and visible output share `max_tokens`, so `streamSimple` treats a caller's `maxTokens` as the output it wants and adds the effort's thinking budget on top on every `anthropic-messages` thinking path and for adaptive Claude on Bedrock (capped at the model ceiling); without it, adaptive thinking can spend the whole cap and return nothing — an on-demand compaction then ends at `max_tokens` with no `compaction` block.
- **Prompt cache breakpoints**: `applyPromptCaching` in `packages/ai/src/providers/anthropic.ts` shares a four-breakpoint budget with system/tool markers. It selects eligible rolling-tail messages and stable historical checkpoints every 15 conversational user turns; turn-scoped/per-call messages and tool-control messages are excluded from tail anchors. A trailing synthetic `Continue.` pad is skipped. Thinking, redacted-thinking, and fallback content are not cache anchors. Long retention uses `ttl: "1h"` only when supported.

### Stream behavior
- **Event Protocol**: SSE streams in `streamAnthropicOnce` (`packages/ai/src/providers/anthropic.ts`) emit standard framing events: `message_start` (delivering initial input and cache usage), `content_block_start` (initializing block types: text, thinking, tool_use, redacted_thinking, fallback), `content_block_delta` (streaming `text_delta`, `thinking_delta`, `signature_delta`, `input_json_delta`), `message_delta` (delivering `stop_reason` and final `output_tokens`), `content_block_stop`, `message_stop`, and `ping`.
- **Fine-Grained Tool Streaming**: Enabled via `fine-grained-tool-streaming-2025-05-14` beta. Incoming `input_json_delta` chunks accumulate in `kStreamingPartialJson`, parsed continuously by `parseStreamingJsonThrottled` to surface streaming tool arguments.
- **Stream Watchdogs & Healing**: Streams are monitored for stall timeouts using `getStreamFirstEventTimeoutMs` and `getStreamIdleTimeoutMs` inside `iterateWithIdleTimeout`. `ping` events (`ANTHROPIC_PING_EVENT`) reset idle timeout multipliers. Empty completion responses (0 tokens) trigger automatic retry via `withReplaySafeStreamRetry`. Fast mode (`speed: "fast"`) failures clear session fast mode state (`clearAnthropicFastModeFallback`, `dropAnthropicFastMode`) to fallback to standard execution.

### Auth & usage
- **OAuth authentication**: `packages/catalog/src/compat/rules/auth/anthropic.kdl` declares PKCE authorization and token exchange, executed by the generic OAuth-code engine. Identity is resolved by `anthropicIdentityHook` and `fetchAnthropicBootstrapIdentity` in `packages/ai/src/registry/oauth/anthropic.ts`. The grant TTL is 30 days (`ANTHROPIC_OAUTH_GRANT_TTL_MS` in `anthropic-constants.ts`), independent of refresh-token rotation.
- **Quota Tracking & Account Rotation**: `packages/ai/src/usage/claude.ts` polls `https://api.anthropic.com/api/oauth/usage` to track rolling `five_hour`, `seven_day`, `limits[]` (`weekly_scoped`), and `anthropic-ratelimit-unified-*` headers. Errors matching `isUsageLimitOutcome` (`packages/ai/src/error/rate-limit.ts`) and `parseRateLimitReason` (`QUOTA_EXHAUSTED`) trigger automatic credential rotation.
- **Error Classification**: HTTP errors are categorized by `parseRateLimitReason` (`packages/ai/src/error/rate-limit.ts`) into `QUOTA_EXHAUSTED` (30m backoff / rotation), `RATE_LIMIT_EXCEEDED` (30s backoff), `CONCURRENT_LIMIT` (5s backoff), and `MODEL_CAPACITY_EXHAUSTED` (45s ± 15s backoff). Transient HTTP 408/409/429/5xx errors are retried by `AnthropicMessagesClient` (`packages/ai/src/providers/anthropic-client.ts`), respecting `retry-after-ms` / `retry-after` headers.

### Catalog model handling
- **Provider entry (`anthropic`)**: `packages/catalog/src/compat/rules/providers/anthropic.kdl` declares default model `claude-opus-5-5`. Environment keys: `ANTHROPIC_API_KEY`.
- **Authored seeds**: `claude-sonnet-5`, `claude-sonnet-5-5`, `claude-fable-5`, `claude-mythos-5`, `claude-fable-5-1`, `claude-mythos-5-1`; bundle policy `always`. Limits, capabilities, and prices are authored alongside these rows.
- **Pricing & Multipliers**: `COPILOT_PREMIUM_MULTIPLIERS` in `packages/catalog/scripts/generate-models.ts` assigns premium multipliers for GitHub Copilot Anthropic models (e.g. `claude-opus-4.6`: 3x, `claude-haiku-4.5`: 0.33x) during model catalog generation.

## Google Gemini
Google Gemini integrations use REST/SSE over HTTP (`POST https://generativelanguage.googleapis.com/v1beta/models/{model}:streamGenerateContent?alt=sse`). Core provider entry points are `packages/ai/src/providers/google.ts` (`streamGoogle`), `packages/ai/src/providers/google-shared.ts` (`streamGoogleGenAI`, `buildGoogleGenerateContentParams`, `convertMessages`, `consumeGoogleStream`), and `packages/ai/src/providers/google-types.ts`.

### Special casings

Provider-specific overrides in `packages/catalog/src/compat/rules/providers/google.kdl` (more-specific selectors override provider defaults):

- For class unknown: `thinking.efforts=["minimal","low","medium","high"]`, `thinking.mode="budget"`.
- For models *latest: `thinking.efforts=["minimal","low","medium","high"]`, `thinking.mode="budget"`.
- For models gemini-2.5-computer-use-preview-10-2025, gemini-robotics-er-1.6-preview: `thinking.efforts=["minimal","low","medium","high"]`.

- **`generateContent` protocol**: System prompts are lifted into `{ systemInstruction: { parts: [{ text }] } }` in `buildGoogleGenerateContentParams`. Tools are formatted into `tools[].functionDeclarations` using `parametersJsonSchema` (sanitized via `normalizeSchemaForGoogle` in `packages/ai/src/utils/schema/normalize.ts`).
- **`thinkingConfig` mapping**: `buildGoogleGenerateContentParams` sets `includeThoughts: !options.hideThinkingSummary`. Gemini 3 models map `options.thinking.level` to `thinkingLevel` (`THINKING_LEVEL_UNSPECIFIED`, `MINIMAL`, `LOW`, `MEDIUM`, `HIGH`). Gemini 2.x models map `options.thinking.budgetTokens` to `thinkingBudget`. Cloud Code Assist providers (`google-gemini-cli.ts`) map `thinking.suppress` to explicit `includeThoughts: false` with level/budget when disabled (`suppressWhenOff`).
- **Contiguous `functionResponse` rule**: Gemini requires parallel tool call results to reside in a single contiguous `user` role message. `convertMessages` in `google-shared.ts` inspects `lastContent` and merges `functionResponse` parts into existing `user` turns (`lastContent.parts.push(functionResponsePart)`).
- **Safety settings & Prompt feedback**: Safety blocks in `PromptFeedback` (`blockReason`, `blockReasonMessage`) throw `AIError.ProviderResponseError` with `kind: "content-blocked"`. `FinishReason` values (`SAFETY`, `BLOCKLIST`, `PROHIBITED_CONTENT`, `SPII`, `IMAGE_SAFETY`, `RECITATION`, `MALFORMED_FUNCTION_CALL`, `UNEXPECTED_TOOL_CALL`, `NO_IMAGE`, `OTHER`) map to `stopReason: "error"` in `mapStopReason`.

### Stream behavior
- **`streamGenerateContent` SSE protocol**: Streams are consumed via `readSseJson<GenerateContentResponse>` in `streamGoogleGenAI`.
- **Thought parts & signature retention**: `isThinkingPart` identifies reasoning text when `part.thought === true`. Encrypted `part.thoughtSignature` fields are preserved across deltas using `retainThoughtSignature`. In `convertMessages`, thought signatures are retained only when message provider/model match the target (`msg.provider === model.provider && msg.model === model.id`) and pass `isValidThoughtSignature` (base64 check). For Gemini 3 tool calls lacking a valid signature, the public Gemini API emits the `skip_thought_signature_validator` bypass sentinel on every unsigned call. Cloud Code Assist / Antigravity emits it only when the first call of a turn is unsigned; signed-first parallel turns omit it from unsigned secondary calls. Vertex AI always omits the sentinel (#9638, #10602).
- **Empty response retry loop**: `streamGoogleGenAI` guards against Gemini returning `finishReason: STOP` with blank content without calling tools. `hasMeaningfulGoogleContent` validates output; if empty, `streamGoogleGenAI` retries up to `MAX_EMPTY_STREAM_RETRIES` (2 retries, 3 total attempts) with exponential backoff (`EMPTY_STREAM_BASE_DELAY_MS * 2^attempt`) after resetting stream output via `resetGoogleStreamOutputForRetry`.
- **Thinking loop guard**: Implemented in `packages/ai/src/utils/thinking-loop.ts` (`ThinkingLoopDetector`). Gemini, DeepSeek, and Grok model-id families are monitored before tool calls for these runaway shapes:
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
- **Provider entry (`google`)**: `packages/catalog/src/compat/rules/providers/google.kdl` declares default model `gemini-3.1-pro-preview`. Environment keys: `GEMINI_API_KEY`.


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
- **Provider entry (`google-vertex`)**: `packages/catalog/src/compat/rules/providers/google-vertex.kdl` declares default model `gemini-3.1-pro-preview`. Model management permits unauthenticated access.
* **Catalog API Resolution**: `resolveGoogleVertexApi` in `packages/catalog/src/provider-models/openai-compat.ts` routes `@ai-sdk/google-vertex/anthropic` npm package models to `api: "anthropic-messages"` with `GOOGLE_VERTEX_ANTHROPIC_BASE_URL` (`https://{location}-aiplatform.googleapis.com/v1/projects/{project}/locations/{location}/publishers/anthropic/models/{model}:streamRawPredict`). Models with slash IDs or `@ai-sdk/openai-compatible` route to `api: "openai-completions"`. All other models route to `api: "google-vertex"` with `GOOGLE_VERTEX_BASE_URL` (`https://{location}-aiplatform.googleapis.com`).
* **Registry Credentials Guard**: Declared in `packages/catalog/src/compat/rules/auth/google-vertex.kdl` via `env hook="google-vertex-adc"` (`packages/ai/src/registry/hooks/env.ts`). Returns `$env.GOOGLE_CLOUD_API_KEY` if set, or `AUTHENTICATED_SENTINEL` (`"<authenticated>"`) if ADC credentials exist (`hasVertexAdcCredentials()`) AND project env (`GOOGLE_CLOUD_PROJECT`/`GCP_PROJECT`/`GCLOUD_PROJECT`) AND location env (`GOOGLE_VERTEX_LOCATION`/`GOOGLE_CLOUD_LOCATION`/`VERTEX_LOCATION`) are present. Returns `undefined` otherwise, preventing models from appearing in catalog listings without proper auth.

## Google Gemini CLI / Antigravity
Google Cloud Code Assist (CCA) transport wrapper accessing Gemini and Claude models over `/v1internal:streamGenerateContent` SSE endpoints. Implementation spans `packages/ai/src/providers/google-gemini-cli.ts` (shared execution engine, request construction, stream parsing, and planning leak filters), `packages/catalog/src/compat/rules/auth/google-gemini-cli.kdl` & `packages/catalog/src/compat/rules/auth/google-antigravity.kdl` (auth policy declarations), `packages/ai/src/registry/oauth/google-gemini-cli.ts` & `google-antigravity.ts` (OAuth hooks, project discovery, and onboarding), `packages/ai/src/usage/google-antigravity.ts` & `packages/ai/src/usage/gemini.ts` (quota tracking and credential ranking), and `packages/catalog/src/discovery/antigravity.ts` (model catalog discovery).

### Special casings

Provider-specific overrides in `packages/catalog/src/compat/rules/providers/google-gemini-cli.kdl` (more-specific selectors override provider defaults):

- For class gemini; revision >=3.0.0: `requiresSkipThoughtSignatureOnFirstFunctionCall=true`.

Provider-specific overrides in `packages/catalog/src/compat/rules/providers/google-antigravity.kdl` (more-specific selectors override provider defaults):

- For class anthropic; family opus: `thinking.mode="budget"`.
- For class gemini; revision >=3.0.0: `requiresSkipThoughtSignatureOnFirstFunctionCall=true`.
- For class gemini; family flash; revision >=3.0.0 <3.6.0: `thinking.effortBudgets={"high":10000,"low":1000,"medium":4000,"minimal":1000}`, `thinking.mode="budget"`, `thinking.suppressWhenOff=true`.
- For class gemini; family flash; revision >=3.6.0: `thinking.mode="google-level"`, `thinking.requiresEffort=true`.
- For class gemini; family pro; revision >=3.0.0 <3.2.0: `thinking.suppressWhenOff=true`.
- For models claude-opus-4-6: `thinking.efforts=["minimal","low","medium","high"]`.
- For models gemini-3-pro: `thinking.mode="google-level"`.
- For models gemini-3.1-flash-lite: `thinking.mode="google-level"`, `thinking.requiresEffort=true`.
- For models gemini-3.1-pro: `thinking.effortBudgets={"high":10001,"low":1001}`, `thinking.mode="budget"`.

- **CCA JSON Schema Normalization**: `normalizeSchemaForCCA` (`packages/ai/src/utils/schema/normalize.ts`) recursively strips unsupported JSON Schema keywords (`propertyNames`, `additionalProperties`, `patternProperties`, `$schema`, `title`, `description`, etc.) to prevent HTTP 400 errors from CCA. Accurately tracks context inside properties named `properties` to avoid premature re-assertion of property stripping. Tools are normalized in `buildRequest` (`packages/ai/src/providers/google-gemini-cli.ts`) via `normalizeSchemaForCCA`.
- **Provider Protocol & Request Envelope**:
  - **Endpoints**: `google-gemini-cli` defaults to `https://cloudcode-pa.googleapis.com`. `google-antigravity` uses auto-failover across `https://daily-cloudcode-pa.googleapis.com` (primary) and `https://daily-cloudcode-pa.sandbox.googleapis.com` (sandbox), persisting `lastGoodEndpoint` in `AntigravityProviderSessionState`.
  - **Headers & User-Agent**: `google-gemini-cli` sends `getGeminiCliHeaders()` (`GeminiCLI/0.46.0/<modelId> (platform; arch; terminal)`). `google-antigravity` sends `getAntigravityUserAgent()` (`antigravity/hub/<version> (aidev_client; os_type=<os>; arch=<arch>; cl=<cl>)`); the backend gates newer models (e.g. gemini-3.7-flash) on the client version. Reasoning Claude models on Antigravity send `anthropic-beta: interleaved-thinking-2025-05-14` (the Claude-thinking header gate).
  - **System Instructions**: Antigravity tags system instructions with `role: "user"`. No identity prompt is injected by the client.
  - **Request Envelope & Session State**: Antigravity wraps requests in `buildAntigravityRequestEnvelope`: `project` (projectId), `requestId` (`agent/<agentId>/<ts>/<trajectoryId>/<step>`), `userAgent` (`antigravity`), `requestType` (`agent`), and `labels` (`last_step_index`, `model_enum`, `trajectory_id`, `used_claude`, `used_claude_conservative`, `last_execution_id`). State maintains monotonic `stepIndex`, persistent `agentId`, `trajectoryId`, and signed-decimal `sessionId` (`deriveAntigravitySessionId`).
  - **Wire Profiles**: `getAntigravityModelWireProfile` (`packages/catalog/src/wire/gemini-headers.ts`) maps wire IDs to `maxOutputTokens` and `model_enum`. Claude wire IDs cap `maxOutputTokens` at `64000` (backend rejects >64000 with 400).
- **Thinking Configuration & Wire Suppression**: Gemini 2.x models send `thinkingConfig.thinkingBudget`, while Gemini 3 models send `thinkingConfig.thinkingLevel`. When reasoning is disabled for models with `thinking.suppressWhenOff`, `buildRequest` emits explicit wire suppression (`includeThoughts: false` with level/budget). Omitting `thinkingConfig` causes CCA to re-apply server defaults and silently bill thinking tokens.

### Stream behavior
- **Transport & SSE Protocol**: Consumes `POST /v1internal:streamGenerateContent?alt=sse` via `readSseJson<CloudCodeAssistResponseChunk>`. Chunks deliver `candidates[0].content.parts`, `usageMetadata`, `modelVersion`, `responseId`, `promptFeedback`, or top-level `error`.
- **In-band Errors & Block Reasons**: `chunk.error` status/code >=400 throws `AIError.GeminiCliApiError` or `AIError.ProviderResponseError`. `promptFeedback.blockReason` throws `AIError.ProviderResponseError` with `kind: "content-blocked"`.
- **Planning Leak Detection & Filtering**: Flash models (`isFlashLeakModel`) can stream raw JSON internal planning blocks into visible text parts. `consumePlanningBuffer` checks prefixes starting with `{` or `"thought":` using `isPlanningLeakPrefix` and `splitLeadingJsonObject`. If parsed JSON contains `thought`, `call` (matching active tool names), `_i`, `paths`, `command`, or `path`/`content`, the object is classified as `kind: "leak"` and stripped from visible output.
- **Thinking Parts & Signature Retention**: Parts with `thought: true` or `isThinkingPart()` route to thinking blocks. `thoughtSignature` on text, thinking, or toolCall parts is retained via `retainThoughtSignature`. Inline `<thinking>` tags are processed using `StreamMarkupHealing`.
- **Empty stream retry**: CCA uses `MAX_EMPTY_STREAM_RETRIES = 2` and `EMPTY_STREAM_BASE_DELAY_MS = 500`, imported from `google-shared.ts`: three total attempts, with exponential backoff, for empty stop responses.
- **Pre-Response Watchdogs**: Arms `armPreResponseTimeout` with `getStreamFirstEventTimeoutMs` (5-minute ceiling) to prevent hung HTTP proxy connections before the first SSE chunk arrives. Native Bun fetch pre-response timeout is disabled (`timeout: false`).

### Auth & usage
- **Credential Model & Token Expiry**: Credentials stored as JSON (`parseGeminiCliCredentials`): `{ token, projectId, refreshToken, expiresAt, email }`. AuthStorage is the sole refresh authority. `shouldRefreshGeminiCliCredentials` checks token expiry with a 60s skew (`ANTIGRAVITY_REFRESH_SKEW_MS` / `GOOGLE_GEMINI_REFRESH_SKEW_MS`). Stale tokens fail fast before making HTTP requests.
- **OAuth Installed-App Flow**: Callback ports are `8085` (`google-gemini-cli`, `/oauth2callback`) and `51121` (`google-antigravity`, `/oauth-callback`). Supports paste code flow (`pasteCodeFlow: true`). Authorizes via Google PKCE OAuth 2.0 (`accounts.google.com/o/oauth2/v2/auth`). Antigravity scopes include `cloud-platform`, `userinfo.email`, `userinfo.profile`, `cclog`, and `experimentsandconfigs`.
- **Project Discovery & Onboarding**:
  - `google-gemini-cli` (`packages/catalog/src/compat/rules/auth/google-gemini-cli.kdl`, hook in `packages/ai/src/registry/oauth/google-gemini-cli.ts`): calls `POST /v1internal:loadCodeAssist` with `$GOOGLE_CLOUD_PROJECT` fallback. If project absent, calls `POST /v1internal:onboardUser` with `tierId` (`free-tier`, `legacy-tier`, `standard-tier`) and polls `LongRunningOperationResponse` via `pollOperation` (up to `POLL_MAX_ATTEMPTS = 24` at 5s intervals). Detects VPC-SC restriction (`SECURITY_POLICY_VIOLATED`).
  - `google-antigravity` (`packages/catalog/src/compat/rules/auth/google-antigravity.kdl`, hook in `packages/ai/src/registry/oauth/google-antigravity.ts`): mirrors the native `antigravity/hub` flow against `https://daily-cloudcode-pa.googleapis.com`: `loadCodeAssist` requests carry `{ metadata: { ideType: "ANTIGRAVITY" } }`, repeat with `cloudaicompanionProject` when the response lacks `paidTier`, and refresh after resolving the account state. Accounts without `currentTier` are provisioned once with `onboardUser` and `tierId: "free-tier"`; its long-running operation is polled with `GET /v1internal/{operation.name}` every second under one 30-second deadline.
- **Usage & Quota Tracking (`google-antigravity`)**: `antigravityUsageProvider` (`packages/ai/src/usage/google-antigravity.ts`) queries `POST /v1internal:fetchAvailableModels`. Normalizes quota buckets into daily (24h) and weekly (7d) windows. Deduplicates quotas into backend counter keys (`Anthropic`, `Google`, `OpenAI`). `antigravityRankingStrategy` scopes ranking by requested model family (`getAntigravityCounterKeyForModel`: `claude-` → Anthropic, `gemini-`/`gemma-` → Google, `gpt-`/`openai/` → OpenAI), selecting stored OAuth credentials with available quota headroom.
- **Usage & Quota Tracking (`google-gemini-cli`)**: `googleGeminiCliUsageProvider` (`packages/ai/src/usage/gemini.ts`) queries `loadCodeAssist` and `retrieveUserQuota`, surfacing quota percentages per model tier (`3-Flash`, `Flash`, `Pro`).

### Catalog model handling
- **Provider entry (`google-gemini-cli`)**: `packages/catalog/src/compat/rules/providers/google-gemini-cli.kdl` declares default model `gemini-3.1-pro-preview`.
- **Provider entry (`google-antigravity`)**: `packages/catalog/src/compat/rules/providers/google-antigravity.kdl` declares default model `gemini-3.1-pro`.
- **Authored seeds**: `gemini-3-pro-image`; bundle policy `always`. Limits, capabilities, and prices are authored alongside these rows.
- **Model Resolution & Discovery**: `googleAntigravityModelManagerOptions` & `googleGeminiCliModelManagerOptions` (`packages/catalog/src/provider-models/google.ts`) invoke `fetchAntigravityDiscoveryModels` (`packages/catalog/src/discovery/antigravity.ts`).
- **Variant Collapsing**: Effort-tier variants are collapsed into logical specs at discovery (`packages/catalog/src/compat/collapse.ts`):
  - `gemini-3.5-flash`: collapses `gemini-3.5-flash-extra-low`, `gemini-3.5-flash-low`, `gemini-3-flash-agent`. Antigravity budget mode maps Minimal/Low → `extra-low` (1000 tokens), Medium → `low` (4000 tokens), High → `agent` (10000 tokens). Gemini CLI maps to level transport. Alias: `gemini-3-flash`.
  - `gemini-3.6-flash`: collapses `gemini-3.6-flash-low`, `-medium`, `-high`, `-tiered` into `gemini-3.6-flash` with `google-level` mode.
  - `gemini-3.1-pro`: collapses `gemini-3.1-pro-low`, `gemini-pro-agent`, `gemini-3.1-pro-high`. High effort routes to `gemini-pro-agent` because upstream `gemini-3.1-pro-high` deployment returns INVALID_ARGUMENT on streamGenerateContent.
  - `claude-*`: bare and `-thinking` pairs collapse into `claude-*` using reviewed thinking-pair collapse (`preserveAbsentEffortRoutes: true`).
- **Catalog Generator Integration**: `fetchAntigravityModels` (`packages/catalog/scripts/generate-models.ts`) fetches models via discovery token (falling back from `google-antigravity` to `google-gemini-cli` OAuth credentials) and fixes `baseUrl` to `https://daily-cloudcode-pa.googleapis.com`.

## Amazon Bedrock
Amazon Bedrock (`amazon-bedrock` provider, `bedrock-converse-stream` API) communicates directly with `bedrock-runtime.{region}.amazonaws.com/model/{modelId}/converse-stream` via HTTPS POST requests using AWS SigV4 signatures or explicit bearer tokens, decoding binary `application/vnd.amazon.eventstream` responses. The implementation bypasses heavy AWS SDK dependencies (`@aws-sdk/*`, `@smithy/*`), executing native fetches signed with WebCrypto and decoded via a lightweight eventstream parser. Entry modules comprise `packages/ai/src/providers/amazon-bedrock.ts` (`streamBedrock`), `packages/ai/src/registry/amazon-bedrock.ts` (`amazonBedrockTransport`), auth policy in `packages/catalog/src/compat/rules/auth/amazon-bedrock.kdl`, `packages/ai/src/registry/aws.ts`, `packages/ai/src/providers/aws-credentials.ts` (`resolveAwsCredentials`), `packages/ai/src/providers/aws-eventstream.ts` (`decodeEventStream`), and `packages/ai/src/providers/aws-sigv4.ts` (`signRequest`).

### Special casings

Provider-specific overrides in `packages/catalog/src/compat/rules/providers/amazon-bedrock.kdl` (more-specific selectors override provider defaults):

- For class anthropic; family opus; revision >=4.6.0 <4.7.0: `thinking.mode="anthropic-adaptive"`.
- For class anthropic; revision >=4.7.0 <5.1.0: `streamIdleTimeoutMs=900000`, `thinking.efforts=["low","medium","high","max"]`.
- For class anthropic; revision >=5.1.0: `thinking.efforts=["low","medium","high","xhigh","max"]`.
- For class xai; family grok; revision >=4.6.0: `thinking.mode="effort"`, `thinking.efforts=["low","medium","high","xhigh"]`.
- For class openai: `thinking.mode="effort"`.
- For class deepseek: `requiresReasoningContentForAllAssistantTurns=true`, `thinking.efforts=["minimal","low","medium","high"]`.
- For class minimax; family m2: `thinking.mode="budget"`.
- For class unknown: `thinking.efforts=["minimal","low","medium","high"]`, `thinking.mode="budget"`.
- For models moonshot.kimi-k2-thinking: `thinking.requiresEffort=true`.
- Provider defaults: `streamRevision="possible"`.

- **Converse API Payload & Message Mapping**: Requests build a `ConverseStreamRequest` with `messages`, `system`, `inferenceConfig` (`maxTokens`, `temperature`, `topP`), `toolConfig`, and `additionalModelRequestFields`. System prompts normalize to `SystemContent[]` with text blocks and `CachePoint` markers (`{ cachePoint: { type: "default", ttl?: "1h" } }`). User content maps to `text`, `image` (`jpeg`/`png`/`gif`/`webp` base64 via `createImageBlock`), `toolResult`, or `cachePoint`. Bedrock requires consecutive tool result blocks to be consolidated into a single `user` role `WireMessage` (`convertMessages` loops to merge adjacent `toolResult` turns). Empty text blocks and empty content arrays are filtered to avoid HTTP 400 validation failures.
- **Anthropic Messages route (`/anthropic`)**: `anthropic-messages` models under this provider send to `https://bedrock-runtime.{region}.amazonaws.com/anthropic` through the Anthropic transport instead of Converse. That route rejects the tool `strict` field and any `metadata.user_id` outside Bedrock's request-metadata pattern. `compat.bedrockMessagesApi` (detected from the `baseUrl`, overridable in `models.yml`) makes the Anthropic transport drop `strict` and fit the metadata to that pattern (`fitBedrockAnthropicPayload`, `packages/ai/src/providers/bedrock-anthropic.ts`) after any `onPayload` hook. It supports on-demand compaction. See [Models](./models.md#claude-on-bedrocks-anthropic-messages-api-anthropic).
- **NO_TOOLS_SENTINEL (`__no_tools__`)**: Bedrock validates that any request containing prior `toolUse` or `toolResult` blocks must supply a `toolConfig`. When tools are disabled (`toolChoice: "none"`) or empty on a turn with tool history, `planToolConfig` injects a placeholder tool `NO_TOOLS_SENTINEL` (`name: "__no_tools__"`, dummy schema). Per-request flag `sentinelInjected` tracks injection (so caller tools named `__no_tools__` work normally). When `sentinelInjected` is true, `handleContentBlockStart` ignores synthetic tool-use start events, and `messageStop` demotes `stopReason: "tool_use"` to `"stop"`.
- **Thinking & Reasoning (`additionalModelRequestFields`)**:
  - `anthropic-adaptive` models (Claude Opus 4.7+, Sonnet/Opus 5, Fable/Mythos 5): mapped to `{ thinking: { type: "adaptive", display? }, output_config: { effort } }` via `mapEffortToAnthropicAdaptiveEffort`. `thinkingDisplay` defaults to `"summarized"` on display-supporting models so silent reasoning streams under Anthropic's `"omitted"` default are avoided (issue #1373).
  - Budget-mode models (e.g. Claude 3.7 / 4.6): mapped to `{ thinking: { type: "enabled", budget_tokens, display }, anthropic_beta? }`. Sets `anthropic_beta: ["interleaved-thinking-2025-05-14"]` when `interleavedThinking` is true.
  - Forced Tool Choice Conflict: Bedrock rejects thinking when `toolChoice` forces tool execution (`any` or named `{ tool: { name } }`). `streamBedrock` clears `additionalModelRequestFields` when forced tool choice is active.
  - Thinking Signatures & Demotion: Assistant thinking blocks without `thinkingSignature` on Claude models (signature-capable wire models) are demoted to text via `renderDemotedThinking`. Non-Claude models (Nova, Titan, Llama, Mistral) reject thinking signatures and receive unsigned `reasoningContent`.
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
- **Cache Invalidation & Registry Status**: On 401/403 HTTP response, `streamBedrock` calls `invalidateAwsCredentialCache({ profile, region })` to drop cached credentials so subsequent turns re-resolve fresh credentials. Auth resolution in `packages/catalog/src/compat/rules/auth/amazon-bedrock.kdl` (`env hook="aws-bedrock"`) evaluates `hasAwsCredentialSource()` (`packages/ai/src/registry/aws.ts`) to return `AUTHENTICATED_SENTINEL` when valid credentials or environment tokens exist.

### Catalog model handling
- **Provider entry (`amazon-bedrock`)**: `packages/catalog/src/compat/rules/providers/amazon-bedrock.kdl` declares default model `us.anthropic.claude-opus-5-5`.
- **models.dev Mapping & Cross-Region Profiles**: `MODELS_DEV_PROVIDER_DESCRIPTORS` (`packages/catalog/src/provider-models/openai-compat.ts`) maps `modelsDevKey: "amazon-bedrock"` to API `bedrock-converse-stream`. `bedrockCrossRegionId` prefixes `global.` or `us.` for matching models. For `anthropic.claude-*` models, `transformModel` automatically emits EU (`eu.`) and AWS GovCloud (`us-gov.`) cross-region inference-profile spec variants. Non-tool and legacy models (`ai21.jamba`, `titan-text-express`, `mistral-7b`) are filtered out.

## Amazon Bedrock Mantle

Amazon Bedrock Mantle is AWS's gateway endpoint serving OpenAI-compatible models (such as `openai.gpt-5.4`, `openai.gpt-5.5`, and `openai.gpt-5.6` Luna/Sol/Terra variants) over the OpenAI Responses API (`openai-responses`) protocol rather than Bedrock's native Converse JSON transport (`amazon-bedrock`). Requests target region-interpolated endpoints (`https://bedrock-mantle.{region}.api.aws/openai/v1`) with OpenAI Responses API payloads (`/responses`). Entry modules are `packages/ai/src/providers/bedrock-mantle.ts`, `packages/ai/src/registry/bedrock-mantle.ts`, and catalog setup in `packages/catalog/src/provider-models/openai-compat.ts`.

### Special casings

Provider-specific overrides in `packages/catalog/src/compat/rules/providers/bedrock-mantle.kdl` (more-specific selectors override provider defaults):

- For class unknown: `thinking.mode="effort"`.
- For models openai.gpt-5.4, openai.gpt-5.5: `thinking.efforts=["low","medium","high","xhigh"]`.
- For models openai.gpt-5.6*: `thinking.efforts=["low","medium","high","xhigh","max"]`.

- **Endpoint Structure**: Unlike standard Bedrock Converse endpoints (`bedrock-runtime.{region}.amazonaws.com`), Mantle requests target `https://bedrock-mantle.{region}.api.aws/openai/v1`. The `{region}` template placeholder in `model.baseUrl` is dynamically replaced at request preparation time in `prepareBedrockMantleRequest` (`packages/ai/src/providers/bedrock-mantle.ts`).
- **Anthropic Messages route**: Mantle also serves Claude over the Anthropic Messages API at `https://bedrock-mantle.{region}.api.aws/anthropic` (model ids like `anthropic.claude-opus-5-5`). `anthropic-messages` models configured there use the Anthropic transport. The route rejects the tool `strict` field (dropped under `compat.bedrockMessagesApi`, as on bedrock-runtime), verifies thinking signatures, and supports on-demand compaction. See [Models](./models.md#claude-on-bedrocks-anthropic-messages-api-anthropic).
- **Native Compaction**: `openai-responses` models on this route use OpenAI's native compaction (V2 streamed `compaction_trigger`, then V1 `/responses/compact`) by default, detected by `isBedrockOpenAIUrl` (`packages/catalog/src/hosts.ts`). Only for these Bedrock URLs, the compaction requests first run `prepareBedrockCompactionRequest` (`packages/agent/src/compaction/bedrock.ts`), which applies the provider's hooks, so `{region}` and bearer/SigV4 auth match normal turns; other providers' compaction requests keep their own transport. `enabled: false` disables both methods; `v2StreamingEnabled: false` disables only V2. See [compaction](./compaction.md).
- **Region Resolution Hierarchy**: Region substitution in `resolveAwsRegion` (`packages/ai/src/utils/aws-profile.ts`) evaluates in order: explicit `providerOptions.region` -> `AWS_REGION` -> `AWS_DEFAULT_REGION` -> region from active AWS shared-config profile in `~/.aws/config` (`resolveAwsProfileRegion`) -> fallback default `"us-east-1"`.
- **401/403 Credential Invalidation**: When using SigV4 signed requests in `createSignedFetch` (`packages/ai/src/providers/bedrock-mantle.ts`), an HTTP 401 or 403 response triggers `invalidateAwsCredentialCache({ profile, region })` (`packages/ai/src/providers/aws-credentials.ts`) so subsequent attempts re-resolve fresh credentials from profile, environment, or STS roles.
- **Registry Sentinel & Auth Flag**: `packages/catalog/src/compat/rules/auth/bedrock-mantle.kdl` sets `allows-missing-api-key #true` and `env hook="aws-bedrock-mantle"` (with transport in `packages/ai/src/registry/bedrock-mantle.ts`). When ambient AWS credentials exist (`hasAwsCredentialSource` in `packages/ai/src/registry/aws.ts`), `resolveAwsRegistryApiKey` returns `AUTHENTICATED_SENTINEL`. `resolveAwsBearerToken` strips this sentinel value so SigV4 authentication is selected unless an actual bearer token is present.

### Stream behavior
- **Transport**: Delegated to the `openai-responses` provider pipeline (`packages/ai/src/providers/openai-responses.ts`), consuming SSE stream events like `response.created`, `response.text.delta`, `response.output_item.added`, and `response.completed`.
- **Error Handling**: Non-2xx SSE streams pass error status codes back to the stream result handler; 401/403 status codes invalidate the cached AWS credential state in `createSignedFetch`.

### Auth & usage
- **Dual Authentication Modes**:
  - **Bearer Token**: Evaluated by `resolveBearerToken` (`packages/ai/src/providers/bedrock-mantle.ts`). Active when `AWS_BEARER_TOKEN_BEDROCK`, `providerOptions.bearerToken`, or an explicit non-sentinel `apiKey` is provided. `createBedrockMantleAuthenticatedFetch` injects `Authorization: Bearer <token>`.
  - **AWS SigV4 Signing**: Active when no bearer token exists but ambient credentials pass `hasAwsCredentialSource`. Request headers are signed by `signRequest` (`packages/ai/src/providers/aws-sigv4.ts`) using service name `"bedrock-mantle"`, setting `Authorization: AWS4-HMAC-SHA256 ...` and `x-amz-security-token` (when using session credentials).
- **Authentication Precedence**: Bearer token takes precedence over SigV4 signing when both are available.
- **Usage Tracking**: Input, output, cached, and reasoning token usages are parsed directly from the standard OpenAI Responses wire payload (`usage.input_tokens`, `usage.output_tokens`, `usage.input_tokens_details.cached_tokens`, `usage.output_token_details.reasoning_tokens`) by `openai-responses`.

### Catalog model handling
- **Provider entry (`bedrock-mantle`)**: `packages/catalog/src/compat/rules/providers/bedrock-mantle.kdl` declares default model `openai.gpt-5.6-terra`. Environment keys: `AWS_BEARER_TOKEN_BEDROCK`.
- **Discovery replacement**: Successful authoritative discovery replaces fallback provider rows rather than retaining retired seed models.
- **Authored seeds**: `openai.gpt-5.4`, `openai.gpt-5.5`, `openai.gpt-5.6-luna`, `openai.gpt-5.6-sol`, `openai.gpt-5.6-terra`; bundle policy `always`. Limits, capabilities, and prices are authored alongside these rows.
- **Authenticated Model Discovery**:
  - `prepareModelDiscovery` in `packages/ai/src/registry/bedrock-mantle.ts` requires a valid bearer token (`resolveAwsBearerToken`). If unauthenticated or SigV4-only, `authenticated: false` is returned and discovery is bypassed.
  - When authenticated, discovery strips `/openai/v1` to call `https://bedrock-mantle.{region}.api.aws/v1/models` via `fetchOpenAICompatibleModels`.
- **Authoritative Dynamic Model Replacement**: `dynamicModelsAuthoritative: true` in `bedrockMantleModelManagerOptions` causes successful dynamic discovery responses to **replace** static seeds entirely, pruning models not enabled for the AWS account/token.
- **Reference Attribute Merging**: `mapWithBundledReference` merges statically defined costs, thinking configs, and context windows onto dynamically discovered model definitions matching `BEDROCK_MANTLE_MODEL_BY_ID`.

## Kimi Code
Kimi Code (`kimi-code`) and Moonshot (`moonshot`) provide access to Moonshot AI's model family through dual-transport execution—wrapping OpenAI-compatible chat completions (`/coding/v1/chat/completions`) and Anthropic-compatible messages (`/coding/v1/messages`). Entry points are `packages/ai/src/providers/kimi.ts` (`streamKimi`) and `packages/ai/src/providers/openai-anthropic-shim.ts` (`streamOpenAIAnthropicShim`), with model discovery and catalog descriptors configured in `packages/catalog/src/provider-models/descriptors.ts` and `packages/catalog/src/provider-models/openai-compat.ts`.

### Special casings

Provider-specific overrides in `packages/catalog/src/compat/rules/providers/kimi-code.kdl` (more-specific selectors override provider defaults):

- For class kimi; family k3: `thinkingFormat="openai"`.
- For class kimi: `thinkingFormat="zai"`.
- For class unknown: `reasoningContentField="reasoning_content"`, `supportsDeveloperRole=false`, `thinkingFormat="kimi"`, `thinking.efforts=["minimal","low","medium","high"]`.
- For models kimi-for*: `reasoningContentField="reasoning_content"`, `supportsDeveloperRole=false`, `thinkingFormat="zai"`, `thinking.efforts=["minimal","low","medium","high"]`.
- Provider defaults: `kimiApiFormat="anthropic"`, `supportsPromptCacheKey=true`, `thinking.mode="effort"`.

Provider-specific overrides in `packages/catalog/src/compat/rules/providers/moonshot.kdl` (more-specific selectors override provider defaults):

- For class kimi; family k3: `thinkingFormat="openai"`.
- For class kimi: `thinkingFormat="zai"`, `thinking.mode="effort"`.

- **Dual Transport Routing**: `streamKimi` delegates to `streamOpenAIAnthropicShim` in `packages/ai/src/providers/openai-anthropic-shim.ts`, selecting format from `model.compat.kimiApiFormat` or explicit `options.format` in `KimiOptions`.
  - `anthropic`: Reconstructs model spec with `api: "anthropic-messages"`, adjusts base URL via `model.baseUrl.replace(/\/v1\/?$/, "")` (`https://api.kimi.com/coding`), injects `getKimiCommonHeaders()`, maps thinking format to `anthropic-adaptive`, computes token budgets via `ANTHROPIC_THINKING`, and streams via `streamAnthropic`.
  - `openai`: Retains `model.baseUrl` (`https://api.kimi.com/coding/v1`), injects `getKimiCommonHeaders()`, passes `reasoning` effort, and streams via `streamOpenAICompletions`.
- **Turn & Token Invariants**:
  - `alwaysSendMaxTokens: isKimiModel` in `packages/catalog/src/compat/resolve.ts`: Kimi calculates rate limits (TPM) based on `max_tokens` rather than emitted tokens, requiring explicit max tokens on every request.
  - `requiresReasoningContentForToolCalls`: True for Kimi models on non-OpenCode providers (`packages/catalog/src/compat/resolve.ts`). Prior assistant tool-call turns must carry `reasoning_content` on thinking follow-ups, with synthetic placeholder `"."` allowed when raw reasoning is missing (`allowsSyntheticReasoningContentForToolCalls`).
  - `requiresAssistantContentForToolCalls`: Forces non-empty text content in assistant tool-calling turns.

### Stream behavior
- **Inband Control Tag & Thinking Scanning**: `KimiInbandScanner` in `packages/ai/src/dialect/kimi.ts` processes raw output streams for XML-like tool control tags (`<|tool_calls_section_begin|>`, `<|tool_call_begin|>`, `<|tool_call_argument_begin|>`, `<|tool_call_end|>`, `<|tool_calls_section_end|>`) and `<think>...</think>` thinking blocks, emitting structured `InbandScanEvent` events (`text`, `thinkingStart`, `thinkingDelta`, `thinkingEnd`, `toolStart`, `toolEnd`).
- **Idle Watchdog Timeout**: `streamIdleTimeoutMs` floor is extended to 300s for native K2.7 Code models (`packages/catalog/src/compat/resolve.ts`) to prevent premature stream aborts during long initial reasoning generation.

### Auth & usage
- **Device OAuth Flow**: Declared in `packages/catalog/src/compat/rules/auth/kimi-code.kdl` as a `login "device-code"` rule (`packages/ai/src/registry/engine/device-code.ts`) with headers hook in `packages/ai/src/registry/oauth/kimi.ts`. Uses OAuth 2.0 Device Authorization Grant (`urn:ietf:params:oauth:grant-type:device_code`) with client ID `17e5f671-d194-4dfb-9706-5516cb48c098` against host `${resolveOAuthHost()}` (`https://auth.kimi.com`, configurable via `KIMI_CODE_OAUTH_HOST` or `KIMI_OAUTH_HOST`).
  - Initiates via `POST /api/oauth/device_authorization`, prompts user with `userCode` and `verificationUriComplete`, and polls `POST /api/oauth/token` with backoff on `authorization_pending` and `slow_down`. Token refresh uses `grant_type: "refresh_token"`.
- **Fingerprinting Headers & Device ID**: `getKimiCommonHeaders()` in `packages/ai/src/registry/oauth/kimi.ts` injects device tracking headers: `User-Agent: KimiCLI/<ver>`, `X-Msh-Platform: kimi_cli`, `X-Msh-Version`, `X-Msh-Device-Name`, `X-Msh-Device-Model`, `X-Msh-Os-Version`, and `X-Msh-Device-Id`. `getDeviceId` persists a random hex UUID to `path.join(getAgentDir(), "kimi-device-id")` (mode 0600) or falls back to an ephemeral process UUID.
- **Usage & Quota Tracker**: `kimiUsageProvider` in `packages/ai/src/usage/kimi.ts` targets `GET /coding/v1/usages` (`https://api.kimi.com/coding/v1/usages`, configurable via `KIMI_CODE_BASE_URL`) with OAuth bearer token and `getKimiCommonHeaders()`.
  - Short-circuits when credentials are expired (`credential.expiresAt <= nowMs`). Parses `KimiUsagePayload`: maps `usage` object to a `Total quota` summary row and `limits` array (extracting `detail` and `window` duration/timeUnit) into `UsageLimit` entries, resolving reset timestamps via `parseResetTime` (`reset_at`, `resetTime`, `ttl`).

### Catalog model handling
- **Provider entry (`kimi-code`)**: `packages/catalog/src/compat/rules/providers/kimi-code.kdl` declares default model `kimi-for-coding`.
- **Provider entry (`moonshot`)**: `packages/catalog/src/compat/rules/providers/moonshot.kdl` declares default model `kimi-k2.7-code`. Environment keys: `MOONSHOT_API_KEY`, `KIMI_API_KEY`.
- **K2.x vs K3 Reasoning Differences**:
  - **K2.x**: Native Moonshot K2.x models use binary thinking (`thinking: { type: "enabled" | "disabled" }`) via `thinkingFormat: "zai"` in `packages/catalog/src/compat/resolve.ts`. Configured with 4-tier effort range `[Minimal, Low, Medium, High]` in `moonshotModelManagerOptions`. K2.6 retains full thinking context (`thinkingKeep: "all"`).
  - **K3**: K3 models use OpenAI-style `reasoning_effort` (`thinkingFormat: "openai"`). Configured with 3-tier wire scale `[low, high, max]`, `defaultLevel: Effort.Max`, and mandatory reasoning (`thinking.requiresEffort: true`). `moonshotModelManagerOptions` stamps 1M context window, 131,072 maxTokens, and vision input (`["text", "image"]`).

## Ollama
The Ollama integration consists of two distinct provider definitions in `packages/ai`: `ollama` for local Ollama instances (using `openai-responses` or `openai-completions` API via `baseUrl` pointing to local endpoint `/v1`, defaulting to `http://127.0.0.1:11434/v1`), and `ollama-cloud` for Ollama Cloud (using native `ollama-chat` API transport at `https://ollama.com/api/chat`). Entry modules are `packages/ai/src/providers/ollama.ts` for native streaming, `packages/catalog/src/provider-models/openai-compat.ts` for local Ollama catalog options (`ollamaModelManagerOptions`), and `packages/catalog/src/provider-models/ollama.ts` for Ollama Cloud catalog options (`ollamaCloudModelManagerOptions`).

### Special casings

Provider-specific overrides in `packages/catalog/src/compat/rules/providers/ollama.kdl` (more-specific selectors override provider defaults):

- Provider defaults: `emptyLengthFinishIsContextError=true`, `thinking.efforts=["low","medium","high","max"]`.

Provider-specific overrides in `packages/catalog/src/compat/rules/providers/ollama-cloud.kdl` (more-specific selectors override provider defaults):

- For class unknown: `thinking.efforts=["minimal","low","medium","high"]`.
- For models deepseek-v4-pro:preview: `thinking.efforts=["low","high","max"]`.
- For models glm-4*, glm-5, glm-5.1: `thinking.efforts=["minimal","low","medium","high"]`.
- For models glm-5.2: `thinking.efforts=["high","max"]`.
- Provider defaults: `thinking.mode="effort"`.

- **Transport Routing**: Local `ollama` defaults to OpenAI-compatible paths (`openai-responses` / `openai-completions`), while `ollama-cloud` uses the native `ollama-chat` protocol.
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
- **Credential Source**: Declared in `packages/catalog/src/compat/rules/auth/ollama.kdl` as a `login "api-key"` rule (`packages/ai/src/registry/engine/api-key.ts`) prompting for an optional API key (`allowEmpty: true`), defaulting to no-auth local usage with `envVars: ["OLLAMA_API_KEY"]`. `packages/catalog/src/compat/rules/auth/ollama-cloud.kdl` mandates an API key created at `https://ollama.com/settings/keys` with `envVars: ["OLLAMA_CLOUD_API_KEY"]`.
- **Authentication Headers**: Local requests attach `Authorization: Bearer ${apiKey}` if provided; `ollama-cloud` requires `Authorization: Bearer ${apiKey}`.
- **Usage & Quota**: Quota tracking is registered via `ollamaUsageProvider` and `ollamaCloudUsageProvider` in `packages/ai/src/usage/ollama.ts`. Neither provider exposes a standalone usage/quota API (`validatesCredentials: false`, empty `limits`), relying on per-response `prompt_eval_count` (input) and `eval_count` (output) returned in stream completion chunks.

### Catalog model handling
- **Provider entry (`ollama`)**: `packages/catalog/src/compat/rules/providers/ollama.kdl` declares default model `gpt-oss:20b`. Environment keys: `OLLAMA_API_KEY`. Model management permits unauthenticated access.
- **Provider entry (`ollama-cloud`)**: `packages/catalog/src/compat/rules/providers/ollama-cloud.kdl` declares default model `gpt-oss:120b`. Environment keys: `OLLAMA_CLOUD_API_KEY`.
- **Local Catalog Discovery**: `ollamaModelManagerOptions` in `packages/catalog/src/provider-models/openai-compat.ts` attempts `fetchOpenAICompatibleModels` at `/v1/models` first. If unavailable, it falls back to native `fetchOllamaNativeModels` querying `/api/tags`.
- **Cloud Catalog Discovery**: `ollamaCloudModelManagerOptions` in `packages/catalog/src/provider-models/ollama.ts` queries `/api/tags` on `https://ollama.com` using `OLLAMA_CLOUD_API_KEY`.
- **Context-Length & Capability Detection via `/api/show`**: Both local and cloud discovery query Ollama's `/api/show` for each model to inspect `model_info` and `capabilities`.
  - Context length is extracted from `model_info` keys ending in `.context_length`, `.num_ctx`, or `.context_window`. Fallback context window is `128_000` (`OLLAMA_FALLBACK_CONTEXT_WINDOW`).
  - Capability stamping: `capabilities.includes("thinking")` sets `reasoning: true` and configures `thinking` effort config (`[minimal, low, medium, high]`). `capabilities.includes("vision")` stamps `input: ["text", "image"]`.
- **Output Token Ceiling Capping**: Ollama Cloud enforces `OLLAMA_CLOUD_MAX_OUTPUT_TOKENS = 65_536` for DeepSeek V4 Pro/Flash models (`isOllamaCloudOutputCapped`). `ollamaCloudModelManagerOptions` caps `maxTokens` at `min(contextWindow, 65536)` and sets `omitMaxOutputTokens: true`. `createChatBody` in `packages/ai/src/providers/ollama.ts` further clamps `num_predict` on wire payloads to `65_536`.
- **Cache Provider ID**: Resolved by `resolveModelCacheProviderId` in `packages/catalog/src/provider-models/cache-provider-id.ts` using `http://127.0.0.1:11434` for `ollama` or endpoint hash.

## Cursor

Cursor's integration in `packages/ai` operates over an HTTP/2 Connect RPC transport (`/agent.v1.AgentService/Run`) sending length-prefixed binary Protobuf messages (`AgentClientMessage` and `AgentServerMessage`). Key implementation entry points include `packages/ai/src/providers/cursor.ts` for connection lifecycle, Connect message streaming, and frame dispatching; `packages/ai/src/providers/cursor-pi-args.ts` for pure argument and path transformations; `packages/ai/src/providers/cursor/exec-modern.ts` for local tool result frame builders; auth policy in `packages/catalog/src/compat/rules/auth/cursor.kdl` (`login "custom" hook="cursor"`) and `packages/ai/src/registry/oauth/cursor.ts` for PKCE browser authentication and token refresh; `packages/ai/src/usage/cursor.ts` for multi-endpoint quota tracking; and `packages/catalog/src/discovery/cursor.ts` for Connect RPC model discovery.

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
  - Client writes `AgentClientMessage` (`runRequest`, periodic `clientHeartbeat` every 5 seconds, interaction-query responses) and `ExecClientMessage` tool responses (read, write, error, and request-context results).
- **Interaction Query Handshake**:
  - Hosted web search / Exa / unnamed field-9 WebFetch send `interactionQuery` and block the turn until the client writes the interaction-query response.
  - Heartbeats keep HTTP/2 alive but are not semantic progress; an unanswered query sits silent until the 300s idle watchdog (`Provider stream stalled while waiting for the next event`).
  - `handleInteractionQuery` approves network permission gates and rejects interactive ask / switch-mode / create-plan. VM setup is left unanswered because its result oneof is success-only.
- **Async Execution Drain & Turn Completion**:
  - `handleServerMessage` processes frames asynchronously so the socket continues draining. Dispatches are tracked in `inFlightDispatches` and bounded by `options.signal` abort handling before finalizing stream completion.
  - Stream completion verifies `turnEnded` (`sawTurnEnded`) or throws `incomplete-stream`.
- **Tool Call Synthesis**:
  - `synthesizeCursorExecToolCall` generates display `toolCall` blocks on assistant output messages to mirror local tool execution in the UI and transcript.
  - An MCP frame with no local handler on a stream flagged `externalToolExecutor` (auth-gateway) synthesizes the block **without** `kCursorExecResolved` and pairs no result: the gateway client is the executor, and `isClientToolUse` only reports a handoff for an unresolved call.

### Auth & usage
- **Credentials & Headers**:
  - Authenticates via `CURSOR_ACCESS_TOKEN` sent in `Authorization: Bearer <token>`.
  - Client headers: `x-ghost-mode: true`, `x-cursor-client-version: cli-2026.07.23-e383d2b`, `x-cursor-client-type: cli`, `x-request-id`.
- **PKCE OAuth & Polling**:
  - Deep-link PKCE login generates verifier/challenge and redirects to `https://cursor.com/loginDeepControl`.
  - Polls `https://api2.cursor.sh/auth/poll?uuid=...&verifier=...` with exponential backoff (1s to 10s delay, up to 150 attempts).
  - Refresh trades refresh token via POST `https://api2.cursor.sh/auth/exchange_user_api_key`.
  - Login, and any refresh of a credential still missing one, records the account email from `https://cursor.com/api/auth/me` (`fetchCursorAccountEmail`), so account policies and `/session pin` can name the account; a failed lookup leaves the credential usable without it.
- **Usage & Quota Tracking (`packages/ai/src/usage/cursor.ts`)**:
  - Standard quota fetched from `https://api2.cursor.sh/auth/usage` (`parseCursorUsage`).
  - For OAuth credentials with WorkOS user sessions (`WorkosCursorSessionToken=${userId}::${accessToken}`), fetches personal usage from `https://cursor.com/api/usage-summary` (`parseCursorIndividualUsage`) and user profile email from `https://cursor.com/api/auth/me`.
- **Turn Usage Accounting (`packages/ai/src/providers/cursor.ts`)**:
  - `tokenDelta` frames accumulate a running output estimate; `TurnEndedUpdate` then reports the turn's final `input`/`output`/`cache_read`/`cache_write`/`reasoning` counters and every reported bucket replaces that estimate. A frame with no counters leaves the estimate in place.
  - `conversationCheckpointUpdate.tokenDetails.usedTokens` is whole-conversation occupancy and lands on `usage.contextTokens`, independent of the output estimate — compaction, handoff, and overflow detection size the context from it.

### Catalog model handling
- **Provider entry (`cursor`)**: `packages/catalog/src/compat/rules/providers/cursor.kdl` declares default model `claude-opus-5-high`. Environment keys: `CURSOR_ACCESS_TOKEN`.
- **Cache Provider ID (`packages/catalog/src/provider-models/cache-provider-id.ts`)**:
  - Returns `"cursor:max-mode-v3"` to ensure context window cache invalidation.
- **Model Discovery (`packages/catalog/src/discovery/cursor.ts`)**:
  - `fetchCursorUsableModels` calls `GetUsableModels` (`/agent.v1.AgentService/GetUsableModels`) over Connect RPC.
  - Sets `cursorMaxMode` from `details.maxMode`, assigns `api: "cursor-agent"`, maps 1M max-mode vs 200k default context windows, and defaults `maxTokens` to 64,000.
  - Dynamic discovery merges with bundled reference models from `models.json`.

## Devin
The Devin integration (`devin-agent` API) communicates with Codeium Cascade backend services over HTTP/1.1 using the Connect protocol and gRPC/Protobuf messages. Its implementation spans provider stream logic in `packages/ai/src/providers/devin.ts` (`streamDevin`, `DEVIN_API_URL`), auth policy in `packages/catalog/src/compat/rules/auth/devin.kdl` (`login "oauth-code"` rule, `packages/ai/src/registry/engine/oauth-code.ts`), and Connect protobuf schemas located in `packages/catalog/src/discovery/devin-gen/exa/*`.

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
* **CLI OAuth Flow:** Declared in `packages/catalog/src/compat/rules/auth/devin.kdl` as a `login "oauth-code"` rule (`packages/ai/src/registry/engine/oauth-code.ts`) executing a PKCE OAuth flow using `https://app.devin.ai/auth/cli/continue`. Tokens are exchanged at `https://api.devin.ai/auth/cli/token` with expiration derived from JWT payload or a 1-year default fallback.
* **Usage Surface:** Streaming response frames include token counts (`msg.usage`: `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`), which feed directly into `calculateCost(model, output.usage)`, plus credit metering (`creditCost`, `committedCreditCost`, `committedAcuCost`) surfaced on `usage.credits`. Account plan and balance reporting uses `devinUsageProvider` (`packages/ai/src/usage/devin.ts`), which calls `SeatManagementService/GetUserStatus` with the native CLI identity and maps prompt/flow/flex credit buckets, dated daily/weekly quota windows, plan tier, overage balance, and account/org identity into `/usage`. Credit-billed plans omit undated percent windows so they do not render as exhausted quotas.

### Catalog model handling
- **Provider entry (`devin`)**: `packages/catalog/src/compat/rules/providers/devin.kdl` declares default model `swe-1-6`. Environment keys: `DEVIN_API_KEY`.
- **Discovery replacement**: Successful authoritative discovery replaces fallback provider rows rather than retaining retired seed models.
- **Authored seeds**: `swe-1-6-fast`, `swe-1-6`; bundle policy `always`. Limits, capabilities, and prices are authored alongside these rows.
* **Dynamic Discovery:** `fetchDevinModels` in `packages/catalog/src/discovery/devin.ts` invokes the unary Connect RPC `GetCliModelConfigs` (`/exa.api_server_pb.ApiServerService/GetCliModelConfigs`) with the native `chisel` discovery metadata from `packages/catalog/src/wire/devin.ts` and every supported display slot. `normalizeDevinModels` drops disabled/internal configs, converts `ClientModelConfig` into `ModelSpec<"devin-agent">` entries (defaulting to 200k context window, 64k max tokens), and preserves server-supplied output caps, pricing dimensions, tool/parallel-tool/image support, description, and `new`/`beta`/`recommended` badges. Exception: `DEVIN_IMAGE_BLIND_UIDS` strips the image modality from `swe-1-6`/`swe-1-6-fast`, whose configs advertise `supports_images` while the backend silently drops the `ChatMessagePrompt.images` field (verified live; every other model reads it). An empty-but-200 catalog response logs a stale-identity-pin warning. Router configs (`displayOption MODEL_ROUTER` or `isModelRouter`) stay standalone with `compat.modelRouter`.

## GitLab Duo

GitLab Duo is integrated via two distinct providers in OMP: **GitLab Duo Non-Agentic** (`gitlab-duo`), which proxies LLM requests through GitLab AI Gateway using standard HTTP/SSE sub-providers, and **GitLab Duo Agent** (`gitlab-duo-agent`), which connects to the GitLab Duo Workflow Service (DWS) over a WebSocket-based agent execution protocol. Entry modules for `gitlab-duo` are `packages/ai/src/providers/gitlab-duo.ts` and `packages/catalog/src/compat/rules/auth/gitlab-duo.kdl` (OAuth hooks in `packages/ai/src/registry/oauth/gitlab-duo.ts`), while `gitlab-duo-agent` is implemented in `packages/ai/src/providers/gitlab-duo-workflow.ts`, `packages/catalog/src/compat/rules/auth/gitlab-duo-agent.kdl`, and catalog discovery in `packages/catalog/src/discovery/gitlab-duo-workflow.ts`.

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
- **`gitlab-duo` Authentication**: Supports PAT via `GITLAB_TOKEN` or OAuth declared in `packages/catalog/src/compat/rules/auth/gitlab-duo.kdl` (`login "oauth-code"`, engine `packages/ai/src/registry/engine/oauth-code.ts`) with cache-clearing hook in `packages/ai/src/registry/oauth/gitlab-duo.ts`. Direct Access tokens are fetched via `POST /api/v4/ai/third_party_agents/direct_access` with `DuoAgentPlatformNext: true` (`getDirectAccessToken` in `packages/ai/src/providers/gitlab-duo.ts`) and cached for 25 minutes (`DIRECT_ACCESS_TTL_MS`). OAuth uses PKCE with the KDL client ID (overrideable via `GITLAB_CLIENT_ID` / `GITLAB_REDIRECT_URI`) and callback port 8080.
- **`gitlab-duo-agent` Authentication**: Accepts PAT via `GITLAB_TOKEN` or OAuth declared in `packages/catalog/src/compat/rules/auth/gitlab-duo-agent.kdl` as a `login "oauth-code"` rule (`packages/ai/src/registry/engine/oauth-code.ts`). Direct Access workflow tokens are obtained via `POST /api/v4/ai/duo_workflows/direct_access` (`requestGitLabDuoWorkflowDirectAccess`). OAuth relies on the official GitLab VS Code client ID (`GITLAB_DUO_WORKFLOW_OAUTH_CLIENT_ID = "36f2a70cddeb5a0889d4fd8295c241b7e9848e89cf9e599d0eed2d8e5350fbf5"`), redirecting to `vscode://gitlab.gitlab-workflow/authentication` (`pasteCodeFlow: true`).
- **`gitlab-duo-agent` Protocol Headers**: Requests include `x-gitlab-client-type: node-websocket`, `x-gitlab-language-server-version: 8.104.0`, and resource scope headers (`x-gitlab-project-id`, `x-gitlab-namespace-id`, `x-gitlab-root-namespace-id`) constructed by `buildGitLabDuoWorkflowWebSocketHeaders`.
- **Usage Tracking**: Neither provider uses a module under `packages/ai/src/usage/`. For `gitlab-duo-agent`, context occupancy is extracted from server checkpoint telemetry (`extractGitLabDuoWorkflowContextUsage` reading `agent_context_usage`), prioritizing `"Chat Agent"` and `"context_builder"` entries, and applied to prompt token estimates in `applyGitLabDuoWorkflowContextUsage`.

### Catalog model handling
- **Provider entry (`gitlab-duo`)**: `packages/catalog/src/compat/rules/providers/gitlab-duo.kdl` declares default model `duo-chat-opus-4-6`. Environment keys: `GITLAB_TOKEN`.
- **Provider entry (`gitlab-duo-agent`)**: `packages/catalog/src/compat/rules/providers/gitlab-duo-agent.kdl` declares default model `claude_sonnet_4_6_vertex`. Environment keys: `GITLAB_TOKEN`.
- **Discovery replacement**: Successful authoritative discovery replaces fallback provider rows rather than retaining retired seed models.
- **Authored seeds**: `claude_sonnet_4_6_vertex`; bundle policy `fallback`. Limits, capabilities, and prices are authored alongside these rows.
- **Namespace Auto-Discovery**: `discoverGitLabDuoWorkflowNamespace` (`packages/catalog/src/discovery/gitlab-duo-workflow.ts`) locates the root namespace from explicit overrides, configuration, or workspace Git remotes (`discoverGitLabDuoWorkflowProject`). Models are discovered via GraphQL query `aiChatAvailableModels(rootNamespaceId:)` (`fetchGitLabDuoWorkflowModels`).
- **Context Window Resolution**: `resolveGitLabDuoWorkflowContextWindow` in `packages/catalog/src/discovery/gitlab-duo-workflow.ts` infers context window sizes from model refs (Claude Opus/Sonnet: 1,000,000; Haiku: 200,000; GPT-5: 400,000; default: 200,000).
- **Cache Partitioning**: `gitLabDuoWorkflowModelCacheProviderId` (`packages/catalog/src/provider-models/special.ts`) partitions dynamic catalog cache keys by hashing `apiKey`, `baseUrl`, `namespaceId`, `projectId`, and workspace `cwd`.
- **Catalog Generation Rules**: `scripts/generate-models.ts` excludes `gitlab-duo-agent` from static generation discovery to prevent bundling single-account namespace models into static catalogs, bundling only `buildGitLabDuoWorkflowFallbackModel` as a generic fallback seed.

## Pi Native
Pi Native is a lossless internal server/client transport protocol used when a pi-ai client (such as containerized `omp` or a sidecar agent slot) delegates request execution to an `omp auth-gateway` holding real provider credentials. Activated when a `Model` sets `transport: "pi-native"`, `streamSimple` in `packages/ai/src/stream.ts` short-circuits local provider resolution and POSTs the canonical `Context` directly to `/v1/pi/stream`. Primary entry modules are `packages/ai/src/providers/pi-native-client.ts` (`streamPiNative`) on the client side, `packages/ai/src/providers/pi-native-server.ts` (`parseRequest`, `encodeStream`, `formatError`) on the wire framing side, and `packages/ai/src/auth-gateway/server.ts` (`POST /v1/pi/stream` route handler) on the server side.

### Special casings
- **Lossless Pass-through & Dialect Absence**: Unlike OpenAI/Anthropic routes, `pi-native` is not a textual tool-call dialect (`docs/toolconv/pi-native.md`). Tool calls remain canonical pi-ai `ToolCall` content blocks inside `Context` and `AssistantMessageEvent`. It preserves first-class pi-ai fields (service tier, cache markers, thinking budgets, tool-choice variants, image blocks, tool-call IDs) without foreign-wire quantization.
- **Wire Request & Minimal Boundary Validation**: Client POSTs `{ modelId: "${provider}/${id}", context, options, stream: true }` to `${model.baseUrl}/v1/pi/stream` (`packages/ai/src/providers/pi-native-client.ts` `resolveStreamUrl`). `packages/ai/src/providers/pi-native-server.ts` `parseRequest` accepts `modelId`, `model.id`, or string `model` (supporting `streamProxy` target swaps). Validation checks only object shapes and arrays (`context.messages`, optional `context.systemPrompt`, `context.tools`), leaving message/tool internals unvalidated until downstream provider execution.
- **Option Allow-list & Non-Wire Key Stripping**: Server filters `options` against `ALLOWED_OPTION_KEYS` in `packages/ai/src/providers/pi-native-server.ts` `parseRequest`, silently dropping unknown keys for cross-version compatibility. Client strips runtime-only and function-valued fields (`signal`, `apiKey`, `fetch`, `onPayload`, `onResponse`, `onSseEvent`, `execHandlers`, `cursorExecHandlers`, `cursorOnToolResult`, `providerSessionState`) via `NON_WIRE_KEYS` in `packages/ai/src/providers/pi-native-client.ts` `buildWireOptions`.
- **Gateway Options Modification**: On the auth-gateway (`packages/ai/src/auth-gateway/server.ts`), sampling controls (`temperature`, `topP`, `topK`, `minP`, `stopSequences`, penalties) are stripped for `openai-codex-responses` models to prevent 400 errors, and passthrough request headers are captured (`captureRequestHeaders`) and merged under client headers.
- **Dispatch Precedence & Cache Bypass**: In `packages/ai/src/stream.ts` `streamSimple`, `model.transport === "pi-native"` takes precedence over extension-registered custom APIs (`getCustomApi`). `packages/ai/src/stream.ts` `assertExplicitOpenAIResponsesPromptCacheSupport` explicitly bypasses prompt cache assertions for `pi-native` transports because validation is deferred to the gateway-resolved model.

### Stream behavior
- **Verbatim SSE Framing**: Server's `encodeStream` (`packages/ai/src/providers/pi-native-server.ts`) streams each canonical `AssistantMessageEvent` verbatim as JSON-serialized SSE frames (`data: ${JSON.stringify(event)}\n\n`) terminated by `data: [DONE]\n\n`. Client (`packages/ai/src/providers/pi-native-client.ts` `streamPiNative`) uses `readSseJson` and pushes events directly into `AssistantMessageEventStream`.
- **Quadratic Partial Framing**: Delta events include rolling `partial: AssistantMessage` snapshots, making wire bandwidth O(N²) in turn length. This overhead is accepted for loopback / sidecar topologies where provider latency dominates.
- **Idle & First-Event Watchdogs**: Client wraps SSE streams with `iterateWithIdleTimeout` using `PI_STREAM_FIRST_EVENT_TIMEOUT_MS` and `PI_STREAM_IDLE_TIMEOUT_MS`. `isPiNativeProgressEvent` in `packages/ai/src/providers/pi-native-client.ts` ignores `type: "start"` events so initial setup does not reset the idle timeout.
- **Missing terminal event**: If pi-native SSE closes without `done` or `error`, a caller abort produces a synthetic aborted error. Otherwise `streamPiNative` fails with `AIError.ProviderResponseError`, `kind: "incomplete-stream"`, rather than inventing a successful completion.
- **Server Iterator Exception Fallback**: If the server's `encodeStream` event iterator throws, it enqueues `data: {"type":"error","reason":"error","errorMessage":"..."}\n\n` followed by `data: [DONE]\n\n` so client iterators resolve instead of hanging.
- **Thinking loop guard**: `packages/ai/src/stream.ts` `streamSimple` wraps `streamPiNative` with `withThinkingLoopGuard` and `withProviderInFlightLimit`, ensuring Gemini, DeepSeek, and Grok runaway thinking streams abort with empty-content retryable errors.

### Auth & usage
- **Bearer Token Authorization**: Client (`packages/ai/src/providers/pi-native-client.ts` `buildHeaders`) passes `options.apiKey` (the gateway bearer token) in `Authorization: Bearer <apiKey>`, unless `model.headers.Authorization` is explicitly provided.
- **Gateway Credential Resolution**: Server route handler (`packages/ai/src/auth-gateway/server.ts`) validates the gateway bearer first. Missing/invalid tokens return `401` via `packages/ai/src/providers/pi-native-server.ts` `formatError`. Valid requests instantiate `buildGatewayApiKeyResolver` to fetch target provider credentials from `AuthStorage` using `sessionId`/`promptCacheKey` and format `"pi-native"`.
- **Error Envelope & Gateway Mapping**: Server emits errors via `formatError` as `{ error: { type, message } }` with HTTP status, `application/json`, and `Cache-Control: no-store`. Client's `decodeGatewayError` converts non-2xx responses into `AIError.AuthGatewayError`, preserving HTTP status, headers, and error `type`.
- **Usage & Header Tracking**: Token usage (`input`, `output`, `cacheRead`, `cacheWrite`, `cost`) is carried directly inside canonical `AssistantMessage` events. Client notifies response metadata (`x-request-id`, headers) via `notifyProviderResponse`.

### Catalog model handling
- **Transport Override Property**: Defined solely as `transport?: "pi-native"` on the `Model` interface in `packages/catalog/src/types.ts`.
- **Local Catalog Resolution**: Metadata (pricing, context windows, max tokens, thinking configurations in `ThinkingConfig`, capability flags, provider priority) resolves locally from the catalog model definition (e.g. `anthropic/claude-3-5-sonnet`), while execution dispatch is routed to the gateway `baseUrl`.

---

# Catalog providers

Catalog-provider sections cover the additional auth, discovery, and wire policy layered over the transports above. Newer or non-chat routes are summarized at the end; their KDL entries are authoritative for defaults, seeds, and discovery flags.

## ai& (`aiand`)
ai& (`aiand`) is an OpenAI-compatible inference API provider (aiand.com) offering open-weights and flagship LLMs with dynamic model catalog discovery, reasoning effort metadata, and token usage pricing. Transport: OpenAI Chat Completions.

### Special casings
- **Base URL Normalization**: `normalizeAiandBaseUrl` in `packages/catalog/src/provider-models/openai-compat.ts` trims base URLs, defaults to `https://api.aiand.com/v1`, strips trailing slashes, and appends `/v1` if omitted. Nothing beyond the OpenAI Chat Completions pipeline.

### Auth & usage
- **API-Key Authentication**: Supports API key authentication configured via the `AIAND_API_KEY` environment variable (resolved via `getEnvApiKey("aiand")` in `packages/ai/src/stream.ts`) or explicit `apiKey` options.
- **Console Login & Validation**: Declared in `packages/catalog/src/compat/rules/auth/aiand.kdl` as a `login "api-key"` rule (`packages/ai/src/registry/engine/api-key.ts`), prompting for an API key from `https://console.aiand.com/api-keys` and validating credentials against `https://api.aiand.com/v1/models` (`validate "models-endpoint"`). Registered in `packages/ai/src/registry/registry.ts`.

### Catalog model handling
- **Provider entry (`aiand`)**: `packages/catalog/src/compat/rules/providers/aiand.kdl` declares default model `moonshotai/kimi-k2.7-code`. Environment keys: `AIAND_API_KEY`.
- **Discovery replacement**: Successful authoritative discovery replaces fallback provider rows rather than retaining retired seed models.
- **Authored seeds**: `qwen/qwen3.6-27b`, `deepseek-ai/deepseek-v4-flash`, `google/gemma-4-31b-it`, `openai/gpt-oss-120b`, `deepseek-ai/deepseek-v4-pro`, `moonshotai/kimi-k2.7-code`, `moonshotai/kimi-k2.6`, `zai-org/glm-5.2`, `zai-org/glm-5.1`; bundle policy `fallback`. Limits, capabilities, and prices are authored alongside these rows.
- **Authoritative Discovery**: `aiandModelManagerOptions` in `packages/catalog/src/provider-models/openai-compat.ts` sets `dynamicModelsAuthoritative: true` and invalidates static IDs via `dropCachedModelIdsOnStaticMismatch: AIAND_STATIC_MODEL_IDS`. When an `apiKey` is supplied, `fetchDynamicModels` queries `/v1/models` using `fetchOpenAICompatibleModels` with `mapAiandModel`.
- **Cost Mapping (`mapAiandCost`)**: `mapAiandCost` extracts `input_per_1m` and `output_per_1m` USD token prices via `toPositiveNumber`. Non-USD org billing currencies (e.g. `currency !== "usd"`) fall back to `{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }` to avoid cost model corruption.
- **Model Attribute Mapping (`mapAiandModel`)**: `mapAiandModel` maps model descriptions or names (`toModelName`), checks `capabilities` for `"reasoning"` (attaching `thinking`) and `"vision"` (setting `input: ["text", "image"]`), and parses `context_window`.

## AIML API (`aimlapi`)
AIML API is an AI model aggregator platform providing access to diverse multi-vendor models through a unified OpenAI-compatible endpoint. It uses the OpenAI Chat Completions (`openai-completions`) transport pipeline.

### Special casings
- **Non-chat model filtering**: Dynamic model listings are filtered via `isLikelyAimlApiChatModelId` (`packages/catalog/src/provider-models/openai-compat.ts`), excluding audio, embedding, image, video, and TTS models matched by regex `/(?:^|[/:._-])(?:audio|embed|embedding|embeddings|i2i|i2v|image|speech|t2i|t2v|tts|video)(?:$|[/:._-])/i` or substrings (`dall-e`, `dalle`, `flux`, `imagen`, `sora`, `veo`, `whisper`).
- **Standard transport pipeline**: Uses un-customized `openai-completions` transport with no custom request transformers or error handlers (`packages/catalog/src/provider-models/openai-compat.ts`).

### Auth & usage
- **Environment authentication**: Configured to discover credentials via the `AIMLAPI_API_KEY` environment variable (`packages/catalog/src/compat/rules/providers/aimlapi.kdl`, `packages/catalog/src/compat/rules/auth/aimlapi.kdl`).
- **API authorization**: Transmits key as an HTTP `Authorization: Bearer <key>` header to target host `https://api.aimlapi.com/v1`.
- **Usage tracking**: Has no dedicated quota or usage parsing module registered in `packages/ai/src/usage/`.

### Catalog model handling
- **Provider entry (`aimlapi`)**: `packages/catalog/src/compat/rules/providers/aimlapi.kdl` declares default model `gpt-5.5-2026-04-23`. Environment keys: `AIMLAPI_API_KEY`.
- **Discovery replacement**: Successful authoritative discovery replaces fallback provider rows rather than retaining retired seed models.
- **Dynamic discovery**: Managed via `aimlApiModelManagerOptions()` in `packages/catalog/src/provider-models/openai-compat.ts`, which fetches `https://api.aimlapi.com/v1/models` and maps candidates via `filterModel` (`isLikelyAimlApiChatModelId`) and `mapWithBundledReference`.
- **Canonical resolution**: Multi-vendor namespaced models (e.g., `alibaba/qwen3-32b`, `x-ai/grok-4-3`) resolve canonical parameter defaults through `buildModelProviderPriorityRank`, where `aimlapi` participates in cross-provider identity lookup (`packages/catalog/src/identity/priority.ts`, `packages/catalog/test/canonical-limit-fallback.test.ts`).

## Alibaba Coding Plan (`alibaba-coding-plan`)
Alibaba Coding Plan provides coding-oriented model endpoints hosted on Alibaba Cloud's DashScope platform. It uses the `OpenAI Chat Completions` transport (`openai-completions`) connecting to international (`https://coding-intl.dashscope.aliyuncs.com/v1`) or mainland China (`https://coding.dashscope.aliyuncs.com/v1`) endpoints.

### Special casings

Provider-specific overrides in `packages/catalog/src/compat/rules/providers/alibaba-coding-plan.kdl` (more-specific selectors override provider defaults):

- For class glm: `thinking.efforts=["minimal","low","medium","high"]`.
- For models *.5: `thinkingFormat="qwen"`.
- For models glm-5: `thinkingFormat="qwen"`.
- Provider defaults: `thinkingFormat="qwen"`, `streamIdleTimeoutMs=600000`, `thinking.mode="effort"`.

- **Structured API key parsing**: In `packages/ai/src/providers/openai-shared.ts`, when `alibabaCodingPlanAuth` is enabled (`packages/ai/src/providers/openai-completions.ts`), JSON-formatted API keys (emitted by login/OAuth storage) are parsed to extract the bearer `token` and override `baseUrl` via `enterpriseUrl`.
- **Host classification**: Grouped under the `alibabaDashscope` host entry in `packages/catalog/src/hosts.ts` (`urlMarkers: ["dashscope", "token-plan."]`).
- **Structured credentials**: The registry formats Alibaba Coding Plan credentials as a JSON API-key envelope carrying access, refresh, expiry, and enterprise endpoint metadata before transport execution.

### Auth & usage
- **Interactive login & endpoint selection**: Declared in `packages/catalog/src/compat/rules/auth/alibaba-coding-plan.kdl` (`login "custom" hook="alibaba-coding-plan"`) and implemented in `packages/ai/src/registry/oauth/alibaba-coding-plan.ts` (`loginAlibabaCodingPlan`), prompting users to select between International (`https://coding-intl.dashscope.aliyuncs.com/v1`), Mainland China (`https://coding.dashscope.aliyuncs.com/v1`), or a custom proxy base URL.
- **API key validation**: Validates credentials via `apiKeyValidation.validateOpenAICompatibleApiKey` (`packages/ai/src/registry/api-key-validation.ts`) against model `qwen3.5-plus` for preset endpoints, or `validateApiKeyAgainstModelsEndpoint` for custom URLs (`packages/ai/src/registry/oauth/alibaba-coding-plan.ts`).
- **Environment variable**: API key is retrieved via `ALIBABA_CODING_PLAN_API_KEY` (`packages/catalog/src/compat/rules/providers/alibaba-coding-plan.kdl`).
- **Usage & quota tracking**: Unlike `alibaba-token-plan`, `alibaba-coding-plan` has no dedicated usage provider or quota tracking in `packages/ai/src/usage/`.

### Catalog model handling
- **Provider entry (`alibaba-coding-plan`)**: `packages/catalog/src/compat/rules/providers/alibaba-coding-plan.kdl` declares default model `qwen3.7-plus`. Environment keys: `ALIBABA_CODING_PLAN_API_KEY`.
- **Model manager options**: `alibabaCodingPlanModelManagerOptions` (`packages/catalog/src/provider-models/openai-compat.ts`) creates manager options via `createOpenAICompatibleModelManagerOptions` configured with `providerId: "alibaba-coding-plan"`, `defaultBaseUrl: "https://coding-intl.dashscope.aliyuncs.com/v1"`, and `mapWithBundledReference`.
- **Model source**: Model specifications are bundled in `packages/catalog/src/models.json` under `"alibaba-coding-plan"`.

### Stream behavior
- **Extended stream idle timeout**: Sets `streamIdleTimeoutMs` to 600,000 ms (`ALIBABA_CODING_PLAN_STREAM_IDLE_TIMEOUT_MS = 600_000` in `packages/catalog/src/compat/resolve.ts`) to prevent premature stream watchdogs aborting during long initial generation delays before the first SSE event.

## QwenCloud Token Plan (`alibaba-token-plan`)
QwenCloud Token Plan provides model subscription access to Alibaba Cloud's Qwen and DeepSeek model suites. It operates using the OpenAI Chat Completions transport (`openai-completions` API schema) over HTTP POST JSON and Server-Sent Events (SSE) streaming (`packages/ai/src/providers/openai-shared.ts`).

### Special casings
- **Explicit Credential Isolation**: `resolveOpenAIRequestSetup` (`packages/ai/src/providers/openai-shared.ts`) requires an explicit `ALIBABA_TOKEN_PLAN_API_KEY` or `BAILIAN_TOKEN_PLAN_API_KEY` credential and explicitly disables the generic `$env.OPENAI_API_KEY` fallback to prevent key leakage to QwenCloud endpoints.
- **Region Base URL Routing**: Credentials support region-locked endpoints: International Singapore (`ALIBABA_TOKEN_PLAN_BASE_URL` = `https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1`) and China Beijing (`ALIBABA_TOKEN_PLAN_CN_BASE_URL` = `https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1`). Region keys are non-interchangeable; stored `baseUrl` overrides catalog defaults for inference and model discovery (`packages/catalog/src/provider-models/openai-compat.ts`).
- **Stored compound credentials**: Alibaba Token Plan keys can serialize `{ token, cookie?, baseUrl? }`; `parseAlibabaTokenPlanCredential` in `packages/catalog/src/wire/alibaba-token-plan.ts` recovers the wire bearer token and optional quota cookie/endpoint.

### Auth & usage
- **Environment & Wire Credential**: Resolves `ALIBABA_TOKEN_PLAN_API_KEY` then `BAILIAN_TOKEN_PLAN_API_KEY`. Supports plain bearer keys (`sk-sp-...`) or serialized JSON strings (`{ token, cookie?, baseUrl? }`) parsed via `parseAlibabaTokenPlanCredential` and formatted via `serializeAlibabaTokenPlanCredential` (`packages/catalog/src/wire/alibaba-token-plan.ts`).
- **Interactive Login**: Declared in `packages/catalog/src/compat/rules/auth/alibaba-token-plan.kdl` (`login "custom" hook="alibaba-token-plan"`) and implemented in `packages/ai/src/registry/oauth/alibaba-token-plan.ts` (`loginAlibabaTokenPlan`), prompting for region (1=International, 2=China Beijing, 3=Custom URL), validating the API key via `${baseUrl}/models` (`validateApiKeyAgainstModelsEndpoint`), and accepting an optional `cs-data.qwencloud.com` browser `Cookie` header for quota reporting.
- **Console Quota Scraping**: `alibabaTokenPlanUsageProvider` (`packages/ai/src/usage/alibaba-token-plan.ts`) uses the stored `Cookie` header to fetch `secToken` from `https://home.qwencloud.com/tool/user/info.json` and issues a POST to `https://cs-data.qwencloud.com/data/api.json?product=sfm_bailian&action=IntlBroadScopeAspnGateway&api=zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/usage` with URL-encoded parameters.
- **Quota Windows & Ranking**: Parses `per5HourPercentage`/`per5HourResetTime` (5-hour window, `credits:5h`), `per1WeekPercentage`/`per1WeekResetTime` (7-day window, `credits:7d`), and `per1MonthPercentage`/`per1MonthResetTime` (`credits:monthly`, reset deadline only — the console never states the month's span). Monthly-only plans therefore still produce a report, and the status-line usage segment promotes their monthly window (`MONTHLY_SUBSCRIPTION_PROVIDERS` in `packages/tui/src/status-line/component.ts`). `alibabaTokenPlanRankingStrategy` configures `credits:5h` as primary limit (5h window) and `credits:7d` as secondary limit (7d window); `credits:monthly` is display-only.

### Catalog model handling
- **Provider entry (`alibaba-token-plan`)**: `packages/catalog/src/compat/rules/providers/alibaba-token-plan.kdl` declares default model `qwen3.7-plus`. Environment keys: `ALIBABA_TOKEN_PLAN_API_KEY`, `BAILIAN_TOKEN_PLAN_API_KEY`.
- **Discovery replacement**: Successful authoritative discovery replaces fallback provider rows rather than retaining retired seed models.
- **Authored seeds**: `qwen3.8-max-preview`, `qwen3.8-max`, `qwen3.8-flash`, `qwen3.7-max`, `qwen3.7-plus`, `qwen3.6-flash`, `glm-5.2`, `deepseek-v4-pro`; bundle policy `fallback`. Limits, capabilities, and prices are authored alongside these rows.
- **Authoritative Discovery**: Configured with `dynamicModelsAuthoritative: true` (`packages/catalog/src/compat/rules/providers/alibaba-token-plan.kdl`). `/models` discovery is subscription-scoped; a successful endpoint response is authoritative and overrides static fallback catalogs even if empty (`packages/catalog/scripts/generate-models.ts`).
- **Discovery Filtering & Overrides**: `isAlibabaTokenPlanChatModelId` (`packages/catalog/src/provider-models/openai-compat.ts`) filters non-chat prefixes (`qwen-audio-`, `qwen-image-`, `text-embedding-`, `wan2.7-`). Discovered `deepseek-v4*` models are mapped with `reasoning: true` and effort thinking (`[Effort.High, Effort.Max]`).

## Baseten (`baseten`)
Baseten provides high-performance infrastructure for hosting open-weight LLMs (including Moonshot Kimi, DeepSeek, Zhipu GLM, and gpt-oss series). Requests execute over the OpenAI Chat Completions transport (`openai-completions` API) targeting default base URL `https://inference.baseten.co/v1`.

### Special casings
- Nothing beyond the `openai-completions` pipeline.

### Auth & usage
- **API Key Authentication**: Authenticates via `BASETEN_API_KEY` (`packages/catalog/src/compat/rules/providers/baseten.kdl`). Login flow declared in `packages/catalog/src/compat/rules/auth/baseten.kdl` as a `login "api-key"` rule (`packages/ai/src/registry/engine/api-key.ts`) pointing to dashboard `https://app.baseten.co/settings/api_keys` with placeholder `bt_...`.
- **Endpoint Validation**: API key validation in `packages/catalog/src/compat/rules/auth/baseten.kdl` verifies credentials via `GET https://inference.baseten.co/v1/models` (`models-endpoint` validation kind).
- **Usage Accounting**: Reconciles token usage and pricing through standard OpenAI Chat Completions usage handling (`calculateOpenAIUsageAccounting` in `packages/ai/src/providers/openai-shared.ts`).

### Catalog model handling
- **Provider entry (`baseten`)**: `packages/catalog/src/compat/rules/providers/baseten.kdl` declares default model `moonshotai/Kimi-K2.7-Code`. Environment keys: `BASETEN_API_KEY`.
- **Discovery replacement**: Successful authoritative discovery replaces fallback provider rows rather than retaining retired seed models.
- **Model Manager Options**: `basetenModelManagerOptions` in `packages/catalog/src/provider-models/openai-compat.ts` configures model resolution with `defaultBaseUrl: "https://inference.baseten.co/v1"` and `requireApiKey: true`.
- **Dynamic Model Discovery & Pricing**: `fetchDynamicModels` queries `https://inference.baseten.co/v1/models`. `mapModel` parses raw record metadata including `supported_features`, `input_modalities` (`image` for vision capability), context and completion token bounds (`context_length`, `max_completion_tokens`), and per-million token pricing (`prompt`, `completion`, `input_cache_read`).
- **Native Reasoning Identification**: Flags `reasoning: true` for `openai/gpt-oss-120b`, `deepseek-ai/DeepSeek-V4-Pro`, and `zai-org/GLM-5.2` when dynamic features list `reasoning` or `reasoning_effort`.

## Cerebras (`cerebras`)
Cerebras provides ultra-fast inference on wafer-scale engine hardware for open-weights models such as `zai-glm-4.7`, `gpt-oss-120b`, `qwen-3-235b-a22b-instruct-2507`, and `gemma-4-31b`. It communicates via the OpenAI Chat Completions (`openai-completions`) transport.

### Special casings

Provider-specific overrides in `packages/catalog/src/compat/rules/providers/cerebras.kdl` (more-specific selectors override provider defaults):

- For class qwen: `thinkingFormat="openai"`.
- For models qwen-3.8-27b: `reasoningDisableMode="none-effort"`, `thinking.efforts=["low","medium","high"]`.
- For models zai-glm-4.7: `thinking.efforts=["minimal","low","medium","high","xhigh"]`.
- Provider defaults: `supportsStrictMode=true`, `supportsUsageInStreaming=false`, `toolStrictMode="all_strict"`, `thinking.mode="effort"`.

- **`supportsUsageInStreaming: false`**: Configured via `supportsUsageInStreaming: !isCerebras` in `packages/catalog/src/compat/resolve.ts` to suppress `stream_options: { include_usage: true }` in `openai-completions.ts`, preventing API rejections when streaming responses.
- **Empty 400/413 Context-Overflow Detection**: Cerebras context and payload overflow errors return empty HTTP 400 or 413 response bodies. Recognized in `packages/ai/src/error/flags.ts` by `OVERFLOW_NO_BODY_PATTERN` (`/\b4(00|13)\s*(status code)?\s*\(no body\)/i`), allowing `isContextOverflow` to set `Flag.ContextOverflow` so agent sessions auto-compact context rather than failing terminally.
- **Gemma Image Input Serialization**: Models matching `gemma-4-31b` serialize attached image blocks into Chat Completions `image_url` data URIs (`data:image/png;base64,...`) when processed by `convertMessages` in `packages/ai/src/providers/openai-completions.ts`.

### Auth & usage
- **API Key Login**: Declared in `packages/catalog/src/compat/rules/auth/cerebras.kdl` as a `login "api-key"` rule (`packages/ai/src/registry/engine/api-key.ts`) with default validation model `gpt-oss-120b` and base URL `https://api.cerebras.ai/v1`.
- **Environment Resolution**: Registered in catalog descriptor `descriptors.ts` and `packages/catalog/src/compat/rules/auth/cerebras.kdl` using environment variable `CEREBRAS_API_KEY`.

### Catalog model handling
- **Provider entry (`cerebras`)**: `packages/catalog/src/compat/rules/providers/cerebras.kdl` declares default model `zai-glm-4.7`. Environment keys: `CEREBRAS_API_KEY`.
- **Manager Options & Discovery**: `cerebrasModelManagerOptions` in `packages/catalog/src/provider-models/openai-compat.ts` uses `createOpenAICompatibleModelManagerOptions` with `providerId: "cerebras"` and default base URL `https://api.cerebras.ai/v1`.

## Cloudflare AI Gateway (`cloudflare-ai-gateway`)
Cloudflare AI Gateway proxies requests through Cloudflare's edge infrastructure to model providers, utilizing the Anthropic Messages transport. Base URLs require substituting `<account>` and `<gateway>` path placeholders with the user's specific Cloudflare account ID and gateway slug in model configurations.

### Special casings

Provider-specific overrides in `packages/catalog/src/compat/rules/providers/cloudflare-ai-gateway.kdl` (more-specific selectors override provider defaults):

- For models deepseek/*: `thinking.efforts=["minimal","low","medium","high","xhigh"]`.
- For class anthropic; revision >=4.0.0 <4.6.0: `thinking.efforts=["minimal","low","medium","high","xhigh"]`.
- For models openai/gpt-5.1-codex: `thinking.efforts=["minimal","low","medium","high"]`.
- For models workers-ai/@cf/nvidia/nemotron-3-120b-a12b: `thinking.efforts=["minimal","low","medium","high","xhigh"]`.
- For models xai/grok-4.20-0309-reasoning: `thinking.requiresEffort=true`.

- **Custom Authorization Header**: Uses `cf-aig-authorization: Bearer <key>` instead of standard `x-api-key` or `Authorization` headers (`packages/ai/src/providers/anthropic.ts:buildAnthropicHeaders`).
- **Suppressed Client Credentials**: `apiKey` and `authToken` are set to `null` on the Anthropic client options object so credentials travel exclusively via pre-built default headers (`packages/ai/src/providers/anthropic.ts`).
- **OAuth Session Protection**: Excluded from receiving Claude OAuth `account_uuid` headers to prevent identity leakage to third-party proxies (`packages/coding-agent/src/session/session-metadata.ts`).

### Auth & usage
- **Authentication Prompt**: Declared in `packages/catalog/src/compat/rules/auth/cloudflare-ai-gateway.kdl` (`login "custom" hook="cloudflare-ai-gateway"`), implemented in `packages/ai/src/registry/oauth/cloudflare-ai-gateway.ts` (with transport in `packages/ai/src/registry/cloudflare-ai-gateway.ts`), prompting for a Cloudflare AI Gateway token/API key (`cf-aig-...`) and directing users to Cloudflare's authentication documentation.
- **Environment Variable**: Reads API key credentials from `CLOUDFLARE_AI_GATEWAY_API_KEY` (`packages/catalog/src/compat/rules/providers/cloudflare-ai-gateway.kdl`).
- **Account & Gateway Resolution**: Uses `https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/anthropic` as the base URL template where `<account>` and `<gateway>` placeholders are replaced with the user's Cloudflare account ID and gateway slug (`packages/catalog/src/provider-models/openai-compat.ts:cloudflareAiGatewayModelManagerOptions`).

### Catalog model handling
- **Provider entry (`cloudflare-ai-gateway`)**: `packages/catalog/src/compat/rules/providers/cloudflare-ai-gateway.kdl` declares default model `anthropic/claude-opus-5`. Environment keys: `CLOUDFLARE_AI_GATEWAY_API_KEY`.
- **Authored seeds**: `claude-sonnet-4-5`; bundle policy `empty`. Limits, capabilities, and prices are authored alongside these rows.
- **Priority Wiring**: Assigned catalog priority level 39 in `providerPriority` (`packages/catalog/src/identity/priority.ts`).

## CoreWeave Serverless Inference (`coreweave`)
CoreWeave Serverless Inference provides hosted AI model inference powered by Weights & Biases (W&B) infrastructure at `https://api.inference.wandb.ai/v1`. It operates using the "OpenAI Chat Completions" transport.

### Special casings
- **Project Header Injection**: `applyCoreWeaveProjectHeader` in `packages/ai/src/providers/openai-shared.ts` intercepts requests for `coreweave` models in `resolveOpenAIRequestSetup` and injects the required `OpenAI-Project` HTTP header. Header resolution is handled by `resolveCoreWeaveProject` and `coreWeaveProjectHeaders` in `packages/catalog/src/wire/coreweave.ts`, checking `COREWEAVE_PROJECT`, `WANDB_INFERENCE_PROJECT`, or `WANDB_ENTITY`/`WANDB_PROJECT`. `removeBlankCoreWeaveProjectHeaders` removes empty project headers to allow fallback to environment variables.
- **GPT-OSS Reasoning Transformation**: In `openAiCompletionsDescriptor` (`packages/catalog/src/provider-models/openai-compat.ts`), models starting with `openai/gpt-oss-` are transformed to set `reasoning: true` and configured with effort-based thinking (`Effort.Low`, `Effort.Medium`, `Effort.High`).

### Auth & usage
- **API Key & Environment Resolution**: Authenticates via `COREWEAVE_API_KEY`, falling back to `WANDB_API_KEY` (`descriptors.ts`, `getEnvApiKey` in `packages/ai/src/stream.ts`).
- **Login Flow & Project Validation**: Interactive login is declared in `packages/catalog/src/compat/rules/auth/coreweave.kdl` as a `login "api-key"` rule (`packages/ai/src/registry/engine/api-key.ts`), referencing settings at `https://wandb.ai/settings`. `requireCoreWeaveProjectHeaders` (`packages/ai/src/registry/oauth/coreweave.ts`) enforces that a valid `OpenAI-Project` header can be constructed from environment variables before validating credentials against `https://api.inference.wandb.ai/v1/models`.

### Catalog model handling
- **Provider entry (`coreweave`)**: `packages/catalog/src/compat/rules/providers/coreweave.kdl` declares default model `openai/gpt-oss-120b`. Environment keys: `COREWEAVE_API_KEY`, `WANDB_API_KEY`.
- **Discovery replacement**: Successful authoritative discovery replaces fallback provider rows rather than retaining retired seed models.
- **Model Manager & Dynamic Discovery**: `coreWeaveModelManagerOptions` in `packages/catalog/src/provider-models/openai-compat.ts` constructs provider options for `https://api.inference.wandb.ai/v1` via `createSimpleOpenAICompletionsOptions`, dynamically supplying `coreWeaveProjectHeaders(Bun.env)` on catalog model fetches.

## DeepSeek (`deepseek`)
The DeepSeek provider interfaces directly with DeepSeek's API (`https://api.deepseek.com/v1`) using the OpenAI Chat Completions transport (`openai-completions`). It powers official DeepSeek models like `deepseek-v4-pro` and `deepseek-v4-flash`, implementing provider-specific reasoning flags, token-stripping stream filters, custom prompt-cache usage accounting, and Bearer-sanitized API key storage.

### Special casings

Provider-specific overrides in `packages/catalog/src/compat/rules/providers/deepseek.kdl` (more-specific selectors override provider defaults):

- For class deepseek: `thinking.mode="effort"`.
- For models deepseek-flash, deepseek-v4-flash, deepseek-v4-flash-vision-exp: `clampOutputToModelMax=true`.
- For models deepseek-flash, deepseek-v4-flash, deepseek-v4.1-flash-expires-on-0910: `maxTokensField="max_tokens"`, `reasoningContentField="reasoning_content"`, `requiresAssistantContentForToolCalls=true`, `requiresReasoningContentForToolCalls=true`, `allowsSyntheticReasoningContentForToolCalls=false`, `supportsToolChoice=false`, `thinking.upgradeNeutral=true`, `thinking.efforts=["low","high","max"]`.
- Provider defaults: `extraBody={"thinking":{"type":"enabled"}}`, `supportsReasoningEffort=true`.

- **Reasoning Content Invariants**: Replays exact prior `reasoning_content` on follow-up turns (`requiresReasoningContentForToolCalls` and `requiresReasoningContentForAllAssistantTurns`), rejecting synthetic `"."` placeholders (`allowsSyntheticReasoningContentForToolCalls: false`). Empty assistant content on tool turns is promoted to `"."` (`requiresAssistantContentForToolCalls: true`).
- **Chat Template Token Stripping & Healing**: `stripDeepseekSpecialTokens` in `packages/ai/src/providers/openai-completions.ts` buffers and strips raw streamed chat-template tokens (`<｜User｜>`, `<｜Assistant｜>`, etc.). In-band DSML tool blocks (`<｜DSML｜tool_calls>`) are healed via `StreamMarkupHealing` with pattern `"dsml"` for every DeepSeek-class model on any host. This includes local backends and custom providers; the rule is the class-level `stream-markup-healing-pattern` in `classes/deepseek.kdl`. A malformed envelope (e.g. missing `<｜DSML｜tool_calls>`/`<｜DSML｜invoke>` openers) is not healed; once a bare opener is visible, the healer keeps that call's closers instead of stripping them as orphans, so the call's end stays findable. When such a turn stops with no tool call on a DSML model (DeepSeek class, or `streamMarkupHealingPattern: "dsml"`; see `isDsmlLeakRecoveryTarget`), the agent loop removes the broken markup before committing the message (`removeDsmlToolMarkupLeak` in `packages/ai/src/utils/dsml-leak.ts`), so it never reaches history. That includes the tool-name line written in place of the invoke tag. The loop then sends a "Tool call failed" developer message that shows the correct envelope, and samples the model again, at most `MAX_DSML_LEAK_NUDGES` (2) times in a row. DSML inside code fences or inline code is left untouched.

### Auth & usage
- **API Key Normalization & Login**: Declared in `packages/catalog/src/compat/rules/auth/deepseek.kdl` as a `login "api-key"` rule with `normalize "strip-bearer"` (`packages/ai/src/registry/engine/api-key.ts`), trimming inputs and stripping any leading `Bearer ` prefix (case-insensitive) and validating against `/v1/models`. Runtime credential relies on `DEEPSEEK_API_KEY`.
- **Prompt-Cache Usage Accounting**: DeepSeek returns top-level usage fields `prompt_cache_hit_tokens` and `prompt_cache_miss_tokens`. `calculateOpenAIUsageAccounting` (`packages/ai/src/providers/openai-shared.ts`) detects `isDeepSeekUsage`, mapping net input tokens to `Math.max(0, promptTokens - cachedTokens)` (the miss count) and setting `cacheWrite` to `0` to avoid double-charging uncached prompt tokens as explicit cache writes.

### Catalog model handling
- **Provider entry (`deepseek`)**: `packages/catalog/src/compat/rules/providers/deepseek.kdl` declares default model `deepseek-v4-pro`. Environment keys: `DEEPSEEK_API_KEY`.


## Fire Pass (`firepass`)
Fire Pass is a Fireworks AI subscription tier providing high-throughput router access, with authored GLM-5.2 Fast and Kimi K3 Fast fallback rows. It uses the OpenAI Chat Completions transport (`https://api.fireworks.ai/inference/v1`) with Fireworks router endpoint translation.

### Special casings

Provider-specific overrides in `packages/catalog/src/compat/rules/providers/firepass.kdl` (more-specific selectors override provider defaults):

- For class glm: `thinking.mode="effort"`, `thinking.efforts=["minimal","low","medium","high","max"]`.
- For class kimi: `thinking.mode="effort"`, `thinking.efforts=["low","high","max"]`.
- Provider defaults: `wireModelIdMode="firepass"`, `thinking.effortMap={"minimal":"none"}`.

- **Max Output Token Cap**: Output tokens are capped at 32,768 (`FIREWORKS_KIMI_MAX_TOKENS`) via `clampFireworksKimiMaxTokens` (`packages/catalog/src/provider-models/openai-compat.ts`) and `applyKimiMaxTokensCap` (`packages/catalog/scripts/generate-models.ts`) to prevent runaway reasoning traces on Kimi K2 models.

### Auth & usage
- **Authentication**: Defined in `packages/catalog/src/compat/rules/auth/firepass.kdl` as a `login "api-key"` rule (`packages/ai/src/registry/engine/api-key.ts`) using environment variable `FIREPASS_API_KEY` (`fpk_...`).
- **Validation**: Dedicated `fpk_...` keys only authorize the router endpoint and fail on `/v1/models`. Validation in `packages/catalog/src/compat/rules/auth/firepass.kdl` uses `validate "chat-completions"` targeting `accounts/fireworks/routers/kimi-k2p6-turbo` directly.

### Catalog model handling
- **Provider entry (`firepass`)**: `packages/catalog/src/compat/rules/providers/firepass.kdl` declares default model `glm-5.2-fast`. Environment keys: `FIREPASS_API_KEY`.
- **Authored seeds**: `glm-5.2-fast`, `kimi-k3-fast`; bundle policy `fallback`. Limits, capabilities, and prices are authored alongside these rows.
- **Manager Options**: `firepassModelManagerOptions` (`packages/catalog/src/provider-models/openai-compat.ts`) returns a static configuration without dynamic discovery, relying on the canonical bundled catalog in `models.json`.

## Fireworks (`fireworks`)
Fireworks (`packages/catalog/src/compat/rules/auth/fireworks.kdl`) is a high-throughput AI inference provider serving serverless and dedicated models via an OpenAI-compatible HTTP REST API (`https://api.fireworks.ai/inference/v1`). It uses the OpenAI Chat Completions transport (`streamOpenAICompletions` in `packages/ai/src/providers/openai-completions.ts`) with custom model ID wire translation, thinking parameter conflict resolution, and priority tier handling.

### Special casings

Provider-specific overrides in `packages/catalog/src/compat/rules/providers/fireworks.kdl` (more-specific selectors override provider defaults):

- For models *-fast: `wireModelIdMode="firepass"`.
- For class qwen: `thinkingFormat="openai"`.
- For class unknown: `thinking.efforts=["minimal","low","medium","high","xhigh"]`.
- For models deepseek-v4-flash: `requiresReasoningContentForAllAssistantTurns=true`.
- For models glm-5.1*, glm-5: `thinking.efforts=["minimal","low","medium","high","xhigh"]`.
- For models glm-5.2*: `thinking.efforts=["minimal","low","medium","high","max"]`.
- For models qwen3-coder-480b-a35b-instruct: `thinkingFormat="openai"`.
- For models qwen3.6-plus: `supportsDeveloperRole=false`.
- Provider defaults: `wireModelIdMode="fireworks"`, `dropThinkingWhenReasoningEffort=true`, `thinking.effortMap={"minimal":"none"}`, `thinking.mode="effort"`.

- **`wireModelIdMode: "fireworks"` & Wire Model ID Transformation**: `applyWireModelIdTransform` (`packages/ai/src/providers/openai-shared.ts`), enabled by `wireModelIdMode: "fireworks"` resolved in `packages/catalog/src/compat/resolve.ts`, invokes `toFireworksWireModelId` (`packages/catalog/src/fireworks-model-id.ts`) to prefix public catalog model IDs with `accounts/fireworks/models/` and convert version dots to `p` (e.g., `glm-5.1` maps to `accounts/fireworks/models/glm-5p1`). Public catalog normalization uses `toFireworksPublicModelId`.
- **`dropThinkingWhenReasoningEffort` Conflict Resolution**: `compat.dropThinkingWhenReasoningEffort` is set to `true` for Fireworks in `packages/catalog/src/compat/resolve.ts`. When `reasoning_effort` is present in request parameters, `applyOpenAIExtraBody` (`packages/ai/src/providers/openai-shared.ts`) deletes top-level `thinking` toggle objects to prevent HTTP 400 errors from Fireworks rejecting both parameters simultaneously.
- **Service Tier / Priority Control**: `excludesInferredOpenAIServiceTier` and `shouldSendServiceTier` (`packages/ai/src/types.ts`) allow `fireworks` requests to send `service_tier: "priority"` when `providers.fireworksTier: priority` (or `/fast` mode) is enabled, suppressing unneeded tier defaults.

### Auth & usage
- **API Key Authentication**: Authenticates with HTTP Bearer tokens (`Authorization: Bearer ${apiKey}`) configured via `FIREWORKS_API_KEY` (resolved via `getEnvApiKey` in `packages/ai/src/stream.ts`).
- **Control-Plane Login Validation**: `/login fireworks` (declared in `packages/catalog/src/compat/rules/auth/fireworks.kdl` as a `login "api-key"` rule, `packages/ai/src/registry/engine/api-key.ts`) validates credentials against the static control-plane catalog `GET /v1/accounts/fireworks/models?filter=supports_serverless%3Dtrue&pageSize=1` rather than `/v1/models` (the inference endpoint serves per-account deployments and returns 500 for accounts without active deployments).
- **Usage Accounting**: Token usage is processed via standard `openai-completions` accounting in `calculateOpenAIUsageAccounting` (`packages/ai/src/providers/openai-shared.ts`), extracting `prompt_tokens`, `completion_tokens`, `prompt_tokens_details.cached_tokens`, and `completion_tokens_details.reasoning_tokens`.

### Catalog model handling
- **Provider entry (`fireworks`)**: `packages/catalog/src/compat/rules/providers/fireworks.kdl` declares default model `kimi-k3`. Environment keys: `FIREWORKS_API_KEY`.
- **Control-Plane Discovery**: `fireworksModelManagerOptions` (`packages/catalog/src/provider-models/openai-compat.ts`) enumerates models via control-plane catalog `GET /v1/accounts/fireworks/models?filter=supports_serverless=true` instead of `/v1/models`, converting resource names (`accounts/fireworks/models/<id>`) to public catalog IDs using `toFireworksPublicModelId`. Internal account resource IDs are pruned during catalog generation in `scripts/generate-models.ts`. Discovered models take their price from Fireworks' own models.dev rows (`fireworks-ai`, keyed by wire id) and fall back to the bare-id reference's price only when Fireworks publishes none.
- **Fast Variant Seeding**: `buildFireworksFastSeed` (`packages/catalog/src/provider-models/openai-compat.ts`) programmatically generates `-fast` catalog seeds (e.g., `kimi-k3-fast`, `glm-5.3-fast`) paired to curated base models, overriding only the cost with Fast pricing while targeting high-speed router wire paths.
- **Kimi Family Output Token Caps**: `clampFireworksKimiMaxTokens` (`packages/catalog/src/provider-models/openai-compat.ts`) clamps output budget `maxTokens` to `FIREWORKS_KIMI_MAX_TOKENS = 32_768` for Kimi K2.5/K2.6 models (`isFireworksKimiK2ModelId`) to prevent runaway reasoning traces caused by Fireworks' reported `max_completion_tokens: 65536`. `kimi-k2.7-code` is explicitly excluded from this cap and allowed up to its full output budget (`FIREWORKS_KIMI_K27_CODE_MAX_TOKENS = 65_536`).

## GitHub Copilot (`github-copilot`)
GitHub Copilot routes multi-vendor model execution (OpenAI GPT, Anthropic Claude, xAI Grok, Google Gemini) through GitHub's unified proxy endpoints (`https://api.githubcopilot.com` or Enterprise `copilot-api.<domain>`). The provider dynamically dispatches across three wire transports: OpenAI Chat Completions, OpenAI Responses, and Anthropic Messages.

### Special casings

Provider-specific overrides in `packages/catalog/src/compat/rules/providers/github-copilot.kdl` (more-specific selectors override provider defaults):

- For class anthropic; revision >=4.0.0 <4.6.0: `thinking.efforts=["minimal","low","medium","high","xhigh"]`.
- For class gemini; family flash: `supportsDeveloperRole=false`.
- For class gemini; revision >=2.5.0 <3.7.0: `thinking.mode="effort"`.
- For class kimi: `thinking.mode="effort"`.
- For class openai; revision >=5.0.0 <5.7.0: `thinking.mode="effort"`.
- For class unknown: `thinking.mode="effort"`.
- For class xai; family grok: `thinking.mode="effort"`.
- For models gemini-2.5-pro, gemini-3.1-pro-preview, gpt-4.1: `supportsDeveloperRole=false`.
- For models gpt-5.1-codex, gpt-5.1-codex-max: `thinking.efforts=["minimal","low","medium","high"]`.
- For models gpt-5.1-codex-mini: `thinking.efforts=["medium","high"]`.
- For models grok-4.5, mai-code-1-flash-picker: `thinking.efforts=["minimal","low","medium","high","xhigh"]`.
- For models grok-4.6, grok-4.6-1m: `thinking.efforts=["minimal","low","medium","high","xhigh"]`.
- Provider defaults: `supportsStrictMode=true`, `disableStrictTools=true`, `supportsContextManagement=false`.

- **Copilot wire identity**: `packages/catalog/src/wire/github-copilot.ts` uses `User-Agent: copilot/1.0.82`, matching `Editor-Version`, `Copilot-Integration-Id: copilot-developer-cli`, `Copilot-Harness-Id: copilot-sdk`, and Copilot API version `2026-08-01`. Chat defaults to `copilot-chat`, allows a `COPILOT_INTEGRATION_ID` pin, and can retry once with the CLI integration on policy denial. Discovery keeps the CLI identity; GitHub REST requests do not receive the Copilot API-version header.
- **Dynamic Copilot Headers & Initiator**: `buildCopilotDynamicHeaders` (`packages/ai/src/providers/github-copilot-headers.ts`) injects per-request headers `X-Initiator` (`"user"` vs `"agent"` inferred from message history via `inferCopilotInitiator` or overridden via `getCopilotInitiatorOverride`), `Openai-Intent: conversation-edits`, and `Copilot-Vision-Request: true` when `hasCopilotVisionInput` detects image payloads in user or tool result blocks.
- **Base URL & Endpoint Resolution**: `resolveGitHubCopilotBaseUrl` (`packages/ai/src/providers/github-copilot-headers.ts`) and `parseGitHubCopilotApiKey` (`packages/catalog/src/wire/github-copilot.ts`) parse custom `enterpriseUrl` and `apiEndpoint` properties embedded in API keys or credentials, defaulting to `https://api.githubcopilot.com` (`PERSONAL_GITHUB_COPILOT_BASE_URL`).
- **OpenAI & Responses Compat Flags**:
  - `supportsReasoningParams`: Disabled (`supportsReasoningParams: provider !== "github-copilot"`) in `packages/catalog/src/compat/resolve.ts` because Copilot Chat Completions endpoints reject `reasoning_effort` and reasoning fields with HTTP 400.
  - `supportsDeveloperRole`: Disabled for Chat Completions specs (`openai-compat.ts`) but enabled on OpenAI Responses specs.
  - `strictResponsesPairing`: Enabled (`spec.provider === "github-copilot"`) in `packages/catalog/src/compat/resolve.ts`, forcing strict pairing between tool calls and tool result messages on Responses endpoints.
  - `supportsImageDetailOriginal`: Disabled (`supportsImageDetailOriginal: false`), clamping image detail from `"original"` to `"auto"` to avoid proxy 400/422 rejection.
- **Anthropic Wire & Signing Compat**:
  - `supportsEagerToolInputStreaming`: Disabled (`supportsEagerToolInputStreaming: false`) in `packages/catalog/src/compat/anthropic.ts` and fine-grained tool streaming beta headers are omitted because the Copilot Anthropic proxy rejects `eager_input_streaming` (#2558).
  - Recognized as a signing host (resolved signing-endpoint policy), suppressing unsigned thinking replay for Claude models (#2851).

### Auth & usage
- **Device-Flow OAuth (`opencode` OAuth app)**:
  - Declared in `packages/catalog/src/compat/rules/auth/github-copilot.kdl` (`login "custom" hook="github-copilot"`), `loginGitHubCopilotHook` in `packages/ai/src/registry/oauth/github-copilot.ts` executes the GitHub Device Authorization Flow using client ID `Ov23li8tweQw6odWQebz` (`CLIENT_ID`) and scope `read:user`.
  - `startDeviceFlow` posts to `https://<domain>/login/device/code` with the shared GitHub OAuth headers. `pollForGitHubAccessToken` polls `https://<domain>/login/oauth/access_token`, automatically handling `authorization_pending` and `slow_down` rate-limit backoffs.
  - Post-login, `discoverGitHubCopilotApiEndpoint` queries `https://api.github.com/copilot_internal/user`, and `enableAllGitHubCopilotModels` issues model enablement requests (`POST /models/{modelId}/policy` with `{ state: "enabled" }` and `openai-intent: chat-policy`).
- **Token Exchange & Refresh**:
  - `refreshGitHubCopilotToken` (`packages/ai/src/registry/oauth/github-copilot.ts`) uses long-lived GitHub OAuth tokens directly without secondary JWT exchange cycles, setting expiry to `FAR_FUTURE_MS` (10 years).
- **Usage & Quota Accounting**:
  - `fetchInternalUsage` in `packages/ai/src/usage/github-copilot.ts` queries `GET /copilot_internal/user` on `resolveGitHubApiBaseUrl` with the shared GitHub OAuth headers.
  - `normalizeQuotaSnapshots` and `buildLimitFromQuota` convert `quota_snapshots` (`chat`, `completions`, `premium_interactions`) and `quota_reset_date` into monthly `UsageLimit` structures (`copilot:premium`, `copilot:chat`, `copilot:completions`). `fetchBillingUsage` provides supplementary user billing details (`/settings/billing/premium_request/usage`).
  - `getCopilotPremiumRequests` (`packages/ai/src/providers/github-copilot-headers.ts`) calculates model premium request cost: `0` for agent turns (`initiator === "agent"`), or `getCopilotPremiumMultiplier(premiumMultiplier, planTier)` for user turns.

### Catalog model handling
- **Provider entry (`github-copilot`)**: `packages/catalog/src/compat/rules/providers/github-copilot.kdl` declares default model `gpt-5.5`. Environment keys: `COPILOT_GITHUB_TOKEN`.
- **Dynamic Model Discovery**: `fetchDynamicModels` in `packages/catalog/src/provider-models/openai-compat.ts` fetches `/models` using `COPILOT_API_HEADERS`. Parses window/token limits from `entry.capabilities.limits` (`maxContextWindowTokens`, `maxPromptTokens`, `maxOutputTokens`), infers wire API (`inferCopilotApi`), and configures vision support (`extractCopilotSupportsVision`).
- **Long-Context Variant Synthesis**: Models advertising long-context pricing in `billing.token_prices.long_context` trigger `createCopilotLongContextVariant` to synthesize opt-in `-1m` catalog models (e.g., `claude-opus-4.7-1m` with `requestModelId: "claude-opus-4.7"`). The base model receives a `contextPromotionTarget` pointing to its long-context sibling.
- **Premium Request Multipliers**: Model-specific request multipliers are mapped in `COPILOT_PREMIUM_MULTIPLIERS` (`packages/catalog/scripts/generate-models.ts`), assigning values such as `gpt-4o: 0`, `grok-code-fast-1: 0.25`, `claude-haiku-4.5: 0.33`, `gpt-5.4-mini: 0.33`, and `claude-opus-4.6: 3`.

## GitLab Duo Non-Agentic (`gitlab-duo`)

`GitLab Duo Non-Agentic` (`gitlab-duo`) proxies Duo Chat LLM completion requests to GitLab AI Gateway proxy endpoints. Depending on the target model mapping, it dynamically delegates execution to the [Anthropic Messages](#anthropic-messages), [OpenAI Chat Completions](#openai-chat-completions), or [OpenAI Responses](#openai-responses) wire transports. It rides the shared [GitLab Duo](#gitlab-duo) transport section.

### Special casings
- **Model ID Mapping & Routing:** `MODEL_MAPPINGS` in `packages/ai/src/providers/gitlab-duo.ts` maps Duo model identifiers (`duo-chat-opus-4-6`, `duo-chat-sonnet-4-6`, `duo-chat-opus-4-5`, `duo-chat-sonnet-4-5`, `duo-chat-haiku-4-5`, `duo-chat-gpt-5-1`, `duo-chat-gpt-5-2`, `duo-chat-gpt-5-mini`, `duo-chat-gpt-5-codex`, `duo-chat-gpt-5-2-codex`) to backend providers (`anthropic` or `openai`), underlying model IDs, API schemas (`anthropic-messages`, `openai-completions`, `openai-responses`), and proxy target URLs (`ANTHROPIC_PROXY_URL` = `https://cloud.gitlab.com/ai/v1/proxy/anthropic/` or `OPENAI_PROXY_URL` = `https://cloud.gitlab.com/ai/v1/proxy/openai/v1`).
- **Canonical model aliases**: The GitLab Duo transport maps catalog Duo IDs to underlying model IDs and wire APIs before dispatch; the mappings are authored in its catalog provider policy and consumed by the transport.
- **Direct Access Token Exchange & Caching:** `getDirectAccessToken` in `packages/ai/src/providers/gitlab-duo.ts` exchanges a user's GitLab access token for a short-lived direct access token via `POST https://gitlab.com/api/v4/ai/third_party_agents/direct_access` with `{ feature_flags: { DuoAgentPlatformNext: true } }`. The resulting token and headers are cached in `directAccessCache` for 25 minutes (`DIRECT_ACCESS_TTL_MS`).
- **Delegated Stream Dispatch:** `streamGitLabDuo` in `packages/ai/src/providers/gitlab-duo.ts` validates the user token (`MissingApiKeyError`), fetches direct access headers, translates Anthropic tool choice via `mapAnthropicToolChoice` (`packages/ai/src/stream.ts`), and dispatches to `streamAnthropic`, `streamOpenAICompletions`, or `streamOpenAIResponses` (`packages/ai/src/providers/register-builtins.ts`) using synthesized model specs (`buildModel`).

### Auth & usage
- **PAT & OAuth Support:** Declared in `packages/catalog/src/compat/rules/auth/gitlab-duo.kdl` (`login "oauth-code"`, engine `packages/ai/src/registry/engine/oauth-code.ts`) with cache-clearing hook in `packages/ai/src/registry/oauth/gitlab-duo.ts`, supporting Personal Access Tokens via `GITLAB_TOKEN` or PKCE browser OAuth.
- **OAuth Authorization & Client ID:** Declared in `packages/catalog/src/compat/rules/auth/gitlab-duo.kdl`, executing PKCE OAuth against `https://gitlab.com/oauth/authorize` (`scope: "api"`, `callbackPort: 8080`, `pasteCodeFlow: true`). Uses `client-id` (`"da4edff2e6ebd2bc3208611e2768bc1c1dd7be791dc5ff26ca34ca9ee44f7d4b"`), overrideable via `GITLAB_CLIENT_ID` (`env="GITLAB_CLIENT_ID"`) and `GITLAB_REDIRECT_URI` (`redirect-uri-env="GITLAB_REDIRECT_URI"`).
- **Token Refresh & Cache Invalidation:** Token refresh in `packages/catalog/src/compat/rules/auth/gitlab-duo.kdl` exchanges refresh tokens at `https://gitlab.com/oauth/token`. Both exchange and refresh clear cached direct access tokens via `gitLabDuoClearCacheHook` (`packages/ai/src/registry/oauth/gitlab-duo.ts`, calling `clearGitLabDuoDirectAccessCache` in `packages/ai/src/providers/gitlab-duo.ts`).
- **Usage Surface:** Nothing beyond the [GitLab Duo](#gitlab-duo) pipeline.

### Catalog model handling
- **Provider entry (`gitlab-duo`)**: `packages/catalog/src/compat/rules/providers/gitlab-duo.kdl` declares default model `duo-chat-opus-4-6`. Environment keys: `GITLAB_TOKEN`.


## GitLab Duo Agent (`gitlab-duo-agent`)
The `gitlab-duo-agent` provider connects OMP to the GitLab Duo Workflow Service (DWS) for agentic execution over a WebSocket action-bridge protocol. It rides the `GitLab Duo` transport section.

### Special casings
- **Stream Direct Bypass & Thinking Healing**: In `packages/ai/src/stream.ts`, `gitlab-duo-agent` bypasses `withProviderInFlightLimit` and standard `iterateWithIdleTimeout` wrappers. `streamGitLabDuoWorkflow` (`packages/ai/src/providers/gitlab-duo-workflow.ts`) is invoked directly wrapped in `healLeakedThinking`.
- **Runtime Namespace Resolution & Auto-Enablement**: Stream initialization invokes `resolveGitLabDuoWorkflowNamespaceSelection` (`packages/ai/src/providers/gitlab-duo-workflow.ts`) to resolve the root namespace from options, `GITLAB_DUO_NAMESPACE_ID`/`GITLAB_DUO_PROJECT_ID` env vars, or workspace git remotes. `ensureGitLabDuoWorkflowSettings` posts to `/api/v4/ai/duo_workflows/settings` (30s timeout via `GITLAB_DUO_WORKFLOW_REST_TIMEOUT_MS`) to auto-enable required namespace settings (`duo_workflow`, `duo_workflow_service`, `duo_agent_platform`).
- **ChatML Goal & Inline Spec Generation**: Renders conversation history into a ChatML goal string (`buildGitLabDuoWorkflowGoal`, `renderGitLabDuoWorkflowChatMl`), subject to 1MB soft (`GITLAB_DUO_WORKFLOW_GOAL_SOFT_OVERFLOW_BYTES`) and 2MB hard (`GITLAB_DUO_WORKFLOW_GOAL_HARD_OVERFLOW_BYTES`) limits. Emits an ambient inline workflow definition (`buildGitLabDuoWorkflowInlineFlowConfig`) targeting `omp_agent`.
- **WebSocket Action Bridge**: Tool definitions are converted into MCP format (`buildGitLabDuoWorkflowMcpTools`) in `startRequest.mcpTools`. Incoming `runMCPTool`/`run_mcp_tool` actions over the WebSocket are extracted (`extractGitLabDuoWorkflowAction`), executed locally, and returned via `buildGitLabDuoWorkflowActionResponse`.

### Auth & usage
- **Registry & Credential Resolution**: Declared in `packages/catalog/src/compat/rules/auth/gitlab-duo-agent.kdl`, requiring `GITLAB_TOKEN` (PAT or OAuth token via `env "GITLAB_TOKEN"`).
- **OAuth PKCE & Official Client ID**: Browser authentication declared in `packages/catalog/src/compat/rules/auth/gitlab-duo-agent.kdl` (`login "oauth-code"`, engine `packages/ai/src/registry/engine/oauth-code.ts`) uses S256 PKCE with `manual-only=#true` on `vscode://gitlab.gitlab-workflow/authentication`. It uses official GitLab VS Code client ID (`36f2a70cddeb5a0889d4fd8295c241b7e9848e89cf9e599d0eed2d8e5350fbf5`), supporting manual callback URL pasting if VS Code intercepts the redirect. Token refresh is declared under `refresh` in the KDL rule (`packages/ai/src/registry/engine/refresh.ts`).
- **Direct Access Tokens**: Requests ephemeral credentials via `POST /api/v4/ai/duo_workflows/direct_access` (`requestGitLabDuoWorkflowDirectAccess` in `packages/ai/src/providers/gitlab-duo-workflow.ts`). No dedicated usage module exists under `packages/ai/src/usage/`.
- **Context Telemetry Usage**: `extractGitLabDuoWorkflowContextUsage` extracts checkpoint telemetry (`agent_context_usage`), prioritizing `"Chat Agent"` and `"context_builder"` entries, and updates token estimates via `applyGitLabDuoWorkflowContextUsage`.

### Catalog model handling
- **Provider entry (`gitlab-duo-agent`)**: `packages/catalog/src/compat/rules/providers/gitlab-duo-agent.kdl` declares default model `claude_sonnet_4_6_vertex`. Environment keys: `GITLAB_TOKEN`.
- **Discovery replacement**: Successful authoritative discovery replaces fallback provider rows rather than retaining retired seed models.
- **Authored seeds**: `claude_sonnet_4_6_vertex`; bundle policy `fallback`. Limits, capabilities, and prices are authored alongside these rows.
- **Fingerprinted Scope Cache**: `gitLabDuoWorkflowModelManagerOptions` in `packages/catalog/src/provider-models/special.ts` configures dynamic model management. `gitLabDuoWorkflowModelCacheProviderId` partitions dynamic catalog caches using `Bun.hash` on `apiKey` and a scope string of `baseUrl`, `namespaceId`, `projectId`, and workspace `cwd`.
- **GraphQL Discovery**: `fetchGitLabDuoWorkflowModels` (`packages/catalog/src/discovery/gitlab-duo-workflow.ts`) calls `discoverGitLabDuoWorkflowNamespace` to locate the root namespace (via explicit config, env, or git remote matching `discoverGitLabRemoteProjectPath`) and executes GraphQL query `aiChatAvailableModels(rootNamespaceId:)` to query `defaultModel`, `selectableModels`, and `pinnedModel`.
- **Model Specs & Context Windows**: `buildGitLabDuoWorkflowModelSpec` constructs model specs with `reasoning: false` (disabling thinking UI controls because Duo Agent Platform manages Anthropic reasoning parameters server-side). `resolveGitLabDuoWorkflowContextWindow` maps model refs to context window sizes (Claude Opus/Sonnet: 1,000,000; Haiku: 200,000; Gemini: 1,000,000; GPT-5: 400,000; default: 200,000).
- **Fallback Model Seeding**: `scripts/generate-models.ts` seeds `buildGitLabDuoWorkflowFallbackModel()` (`claude_sonnet_4_6_vertex`) so unauthenticated/fresh installations contain a default model entry.

## GMI Cloud (`gmi-cloud`)
GMI Cloud is an AI GPU infrastructure and cloud model inference provider hosting open-weight and proprietary model endpoints. It operates over the OpenAI Chat Completions transport using the standard `/v1` wire protocol hosted at `https://api.gmi-serving.com/v1`.

### Special casings
- Nothing beyond the OpenAI Chat Completions pipeline.

### Auth & usage
- **API Key Login & Validation**: Declared in `packages/catalog/src/compat/rules/auth/gmi-cloud.kdl` as a `login "api-key"` rule (`packages/ai/src/registry/engine/api-key.ts`), pointing users to `https://console.gmicloud.ai`. Key validation uses `kind: "models-endpoint"` hitting `https://api.gmi-serving.com/v1/models`.
- **Environment Variables**: Primary credential resolution inspects `GMI_API_KEY` (`envVars` in `packages/catalog/src/compat/rules/providers/gmi-cloud.kdl`).
- **Provider Registry**: Compiled into `packages/ai/src/registry/registry.ts` from `packages/catalog/src/compat/rules/auth/gmi-cloud.kdl` via `packages/ai/src/registry/build.ts`.

### Catalog model handling
- **Provider entry (`gmi-cloud`)**: `packages/catalog/src/compat/rules/providers/gmi-cloud.kdl` declares default model `deepseek-ai/DeepSeek-V4-Flash`. Environment keys: `GMI_API_KEY`.
- **Discovery replacement**: Successful authoritative discovery replaces fallback provider rows rather than retaining retired seed models.
- **Authored seeds**: `deepseek-ai/DeepSeek-V4-Flash`; bundle policy `fallback`. Limits, capabilities, and prices are authored alongside these rows.
- **Dynamic Model Discovery**: Configured with `catalogDiscovery: { label: "GMI Cloud" }` (`packages/catalog/src/compat/rules/providers/gmi-cloud.kdl`) to dynamically query `/v1/models` via `fetchOpenAICompatibleModels` (`packages/catalog/src/discovery/openai-compatible.ts`). When API credentials are available, live discovery results marked as authoritative overwrite cached or static entries.

## Google Antigravity (`google-antigravity`)
The Google Antigravity provider (`google-antigravity`) routes requests to Google Cloud Code Assist daily/sandbox endpoints (`daily-cloudcode-pa.googleapis.com`) using dedicated OAuth credentials. It provides access to Google Gemini 3.x/2.5 models as well as Anthropic Claude and OpenAI GPT-OSS models using the shared "Google Gemini CLI / Antigravity" transport (`packages/ai/src/providers/google-gemini-cli.ts`).

### Special casings
- **Validated Function Calling Default**: Default tool selection mode in `buildRequest` (`packages/ai/src/providers/google-gemini-cli.ts`) is `VALIDATED` (`functionCallingConfig: { mode: "VALIDATED" }`). Claude models on Antigravity always force `VALIDATED` tool mode even when no tools are declared (`packages/ai/src/providers/google-gemini-cli.ts`).
- **System Instruction & Request Envelope**: Antigravity tags `systemInstruction` with `role: "user"` and sends the caller's prompts unmodified. `buildAntigravityRequestEnvelope` injects structured `requestId` (`agent/<id>/<ts>/<trajectoryId>/<step>`), `userAgent: "antigravity"`, `requestType: "agent"`, `sessionId`, and `labels` (`model_enum`, `trajectory_id`, `last_step_index`, `last_execution_id`, `used_claude*`) using `getAntigravityModelWireProfile`.
- **Endpoint Auto-Failover**: Operates across `ANTIGRAVITY_DAILY_ENDPOINT` (`https://daily-cloudcode-pa.googleapis.com`) and `ANTIGRAVITY_SANDBOX_ENDPOINT` (`https://daily-cloudcode-pa.sandbox.googleapis.com`) with state-tracked fallback in `getAntigravityProviderSessionState` (`packages/ai/src/providers/google-gemini-cli.ts`).

### Auth & usage
- **Dedicated OAuth Flow**: Declared in `packages/catalog/src/compat/rules/auth/google-antigravity.kdl` (`login "oauth-code"` rule, `packages/ai/src/registry/engine/oauth-code.ts`) with project discovery hook in `packages/ai/src/registry/oauth/google-antigravity.ts` (`googleAntigravityProjectHook`), executing an independent OAuth flow with distinct client credentials and callback port 51121. Project discovery mirrors native `antigravity/hub`: exact-200 `loadCodeAssist` calls use `ANTIGRAVITY_LOAD_CODE_ASSIST_METADATA`, free-tier eligibility is honored, missing tiers trigger one `onboardUser` request plus 1s operation polling under a 30s deadline, and a final load refresh supplies `cloudaicompanionProject`.
- **Model-Family Credential Ranking**: `antigravityRankingStrategy` (`packages/ai/src/usage/google-antigravity.ts`) scopes usage limits by model family (`scopeAntigravityLimitsForModel` via `getAntigravityCounterKeyForModel`: `anthropic` for `claude-`, `google` for `gemini-`/`gemma-`, `openai` for `gpt-`/`openai/`). This prevents quota exhaustion on one counter (e.g. Gemini) from blocking multi-account credential selection for another family (e.g. Claude).

### Catalog model handling
- **Provider entry (`google-antigravity`)**: `packages/catalog/src/compat/rules/providers/google-antigravity.kdl` declares default model `gemini-3.1-pro`.
- **Authored seeds**: `gemini-3-pro-image`; bundle policy `always`. Limits, capabilities, and prices are authored alongside these rows.
- **Claude & GPT-OSS Model Availability**: Exposes Anthropic Claude models (`claude-opus-4-5`, `claude-opus-4-6`, `claude-sonnet-4-5`, `claude-sonnet-4-6`) and `gpt-oss-120b` alongside Gemini 3.x/2.5 models in `models.json` (`packages/catalog/src/models.json`).

## Google Gemini CLI (`google-gemini-cli`)
Google Cloud Code Assist (Gemini CLI) (`google-gemini-cli`) is Google's OAuth-authenticated developer free and workspace tier providing direct access to Gemini models over the Cloud Code Assist API endpoint (`https://cloudcode-pa.googleapis.com`). Rides the shared **Google Gemini CLI / Antigravity** transport section (`packages/ai/src/providers/google-gemini-cli.ts`).

### Special casings

Provider-specific overrides in `packages/catalog/src/compat/rules/providers/google-gemini-cli.kdl` (more-specific selectors override provider defaults):

- For class gemini; revision >=3.0.0: `requiresSkipThoughtSignatureOnFirstFunctionCall=true`.

- **Default Endpoint & Headers**: Dispatches requests to `https://cloudcode-pa.googleapis.com` and emits headers via `getGeminiCliHeaders()` (`GeminiCLI/0.46.0/<modelId> ...` in `packages/catalog/src/wire/gemini-headers.ts`).
- Standard request pipeline: Nothing beyond the Google Gemini CLI / Antigravity transport pipeline.

### Auth & usage
- **OAuth Installed-App Flow**: Authorizes via Google PKCE OAuth 2.0 declared in `packages/catalog/src/compat/rules/auth/google-gemini-cli.kdl` (`login "oauth-code"`, engine `packages/ai/src/registry/engine/oauth-code.ts`) on callback port `8085` (`/oauth2callback`) requesting Google Cloud scopes (`cloud-platform`, `userinfo.email`, `userinfo.profile`). Refresh is declared under `refresh` (`packages/ai/src/registry/engine/refresh.ts`) with project hook in `packages/ai/src/registry/oauth/google-gemini-cli.ts`.
- **Project Discovery & Onboarding**: `discoverProject` (`packages/ai/src/registry/oauth/google-gemini-cli.ts`) checks existing projects via `POST /v1internal:loadCodeAssist` with `$GOOGLE_CLOUD_PROJECT` / `$GOOGLE_CLOUD_PROJECT_ID` fallback. Non-free tiers (`legacy-tier`, `standard-tier`) or new accounts call `POST /v1internal:onboardUser` with `tierId` (`free-tier`, `legacy-tier`, `standard-tier`) and poll `pollOperation` (up to `POLL_MAX_ATTEMPTS = 24` at 5s intervals). Detects VPC-SC restrictions (`isVpcScAffectedUser` checking `SECURITY_POLICY_VIOLATED`).
- **Quota & Usage Provider**: `googleGeminiCliUsageProvider` (`packages/ai/src/usage/gemini.ts`) posts to `loadCodeAssist` and `retrieveUserQuota` (`/v1internal:retrieveUserQuota`), mapping remaining bucket fractions into usage percentages grouped by model tier (`3-Flash`, `Flash`, `Pro` via `getModelTier`).

### Catalog model handling
- **Provider entry (`google-gemini-cli`)**: `packages/catalog/src/compat/rules/providers/google-gemini-cli.kdl` declares default model `gemini-3.1-pro-preview`.
- **Generator Integration & Priority**: Serves as fallback OAuth token provider in `fetchAntigravityModels` (`packages/catalog/scripts/generate-models.ts`) if `google-antigravity` access is unavailable. Ranked second in provider priority (`packages/catalog/src/identity/priority.ts`).

## Groq (`groq`)
Groq provides high-speed LLM inference powered by custom LPU hardware for open-weights models using the OpenAI Chat Completions transport (`https://api.groq.com/openai/v1`).

### Special casings

Provider-specific overrides in `packages/catalog/src/compat/rules/providers/groq.kdl` (more-specific selectors override provider defaults):

- For class unknown: `thinking.efforts=["minimal","low","medium","high","xhigh"]`.
- Provider defaults: `thinking.mode="effort"`.

- **Context Overflow**: Detected when error messages match `/reduce the length of the messages/i` in `OVERFLOW_PATTERNS` (`packages/ai/src/error/flags.ts`).

### Auth & usage
- **Auth**: Authenticates via `GROQ_API_KEY` environment variable (`packages/catalog/src/compat/rules/providers/groq.kdl`).
- **Provider Registry**: Declared in `packages/catalog/src/compat/rules/auth/groq.kdl` and compiled into `packages/ai/src/registry/registry.ts`.
- **Priority**: Listed 19th in provider priority ordering (`packages/catalog/src/identity/priority.ts`).

### Catalog model handling
- **Provider entry (`groq`)**: `packages/catalog/src/compat/rules/providers/groq.kdl` declares default model `openai/gpt-oss-120b`. Environment keys: `GROQ_API_KEY`.
- **Host Matching**: Matched by URL marker `api.groq.com` or provider `groq` in host definitions (`packages/catalog/src/hosts.ts`).
- **Manager Options**: Configured via `groqModelManagerOptions` targeting `https://api.groq.com/openai/v1` (`packages/catalog/src/provider-models/openai-compat.ts`).

## Hugging Face Inference (`huggingface`)
Hugging Face Inference provides access to open-source model serverless endpoints hosted on the Hugging Face Hub using the OpenAI Chat Completions transport (`openai-completions`) pointing to `https://router.huggingface.co/v1`. The provider enables serverless LLM generation across models including DeepSeek-R1.

### Special casings

Provider-specific overrides in `packages/catalog/src/compat/rules/providers/huggingface.kdl` (more-specific selectors override provider defaults):

- For class unknown: `thinking.efforts=["minimal","low","medium","high","xhigh"]`.
- For models Qwen/Qwen3-235B-A22B-Thinking-2507: `thinking.requiresEffort=true`.
- For models deepseek-ai/deepseek-v3.*: `requiresReasoningContentForAllAssistantTurns=true`.
- For models zai-org/glm-4*, zai-org/GLM-5, zai-org/GLM-5.1: `thinking.efforts=["minimal","low","medium","high","xhigh"]`.
- For models zai-org/GLM-5.2: `thinking.efforts=["minimal","low","medium","high","max"]`.
- Provider defaults: `thinking.mode="effort"`.

- **Standard Transport Pipeline**: Nothing beyond the OpenAI Chat Completions pipeline (`packages/ai/src/providers/openai-completions.ts`).

### Auth & usage
- **Interactive CLI Login**: Declared in `packages/catalog/src/compat/rules/auth/huggingface.kdl` as a `login "api-key"` rule (`packages/ai/src/registry/engine/api-key.ts`) to prompt for fine-grained user access tokens (placeholder `hf_...`).
- **Fine-Grained Token Permission**: Auth setup directs users to `https://huggingface.co/settings/tokens/new?ownUserPermissions=inference.serverless.write&tokenType=fineGrained` (`AUTH_URL` in `packages/catalog/src/compat/rules/auth/huggingface.kdl`), which automatically selects fine-grained tokens with the required "Make calls to Inference Providers" permission (`inference.serverless.write`).
- **Credential Validation**: Declared in `packages/catalog/src/compat/rules/auth/huggingface.kdl`, validating API keys using lightweight chat completion requests (`validate "chat-completions"`) to base URL `https://router.huggingface.co/v1` against validation model `openai/gpt-oss-120b`.

### Catalog model handling
- **Provider entry (`huggingface`)**: `packages/catalog/src/compat/rules/providers/huggingface.kdl` declares default model `deepseek-ai/DeepSeek-R1`. Environment keys: `HUGGINGFACE_HUB_TOKEN`, `HF_TOKEN`.
- **Model Manager Options**: `huggingfaceModelManagerOptions` in `packages/catalog/src/provider-models/openai-compat.ts` constructs manager options via `createSimpleOpenAICompletionsOptions`, binding default base URL `https://router.huggingface.co/v1` and mapping static models with bundled reference specs (`mapWithBundledReference`).
- **Catalog Descriptor**: `openAiCompletionsDescriptor` in `packages/catalog/src/provider-models/openai-compat.ts` registers `huggingface` in `PROVIDER_DESCRIPTORS` targeting `https://router.huggingface.co/v1`.
- **Catalog Discovery**: Participating in catalog generation via `catalogDiscovery`, `generate-models.ts` (`packages/catalog/scripts/generate-models.ts`) resolves API tokens via `resolveProviderApiKey` and calls `fetchOpenAICompatibleModels` (`packages/catalog/src/discovery/openai-compatible.ts`) against `https://router.huggingface.co/v1/models` to discover available Hub inference endpoints.

## Kilo Gateway (`kilo`)
Kilo Gateway (`kilo`) is an AI model aggregator and proxy service (`https://api.kilo.ai/api/gateway`) using the OpenAI Chat Completions transport (`api: "openai-completions"`). It supports authentication via `KILO_API_KEY` or device-code OAuth flow (`/login kilo`), and allows unauthenticated dynamic model discovery from its OpenAI-compatible `/models` catalog endpoint.

### Special casings

Provider-specific overrides in `packages/catalog/src/compat/rules/providers/kilo.kdl` (more-specific selectors override provider defaults):

- For models moonshotai/kimi-k2.6: `streamIdleTimeoutMs=300000`.
- For class glm; family turbo: `thinking.efforts=["minimal","low","medium","high","xhigh"]`.
- For class unknown: `thinking.efforts=["minimal","low","medium","high","xhigh"]`.
- For models *thinking-2507, arcee-ai/trinity-large-thinking, nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free: `thinking.requiresEffort=true`.
- For models deepseek/deepseek-chat-v3.1: `requiresReasoningContentForAllAssistantTurns=true`, `thinking.efforts=["high","max"]`.
- For models deepseek/deepseek-r1, deepseek/deepseek-r1-0528, deepseek/deepseek-v3.1-terminus, deepseek/deepseek-v3.2, deepseek/deepseek-v3.2-exp, deepseek/deepseek-v4-flash, deepseek/deepseek-v4-flash-0731, deepseek/deepseek-v4-flash:discounted, ~deepseek/deepseek-v4-flash-latest: `requiresReasoningContentForAllAssistantTurns=true`.
- For models openai/gpt-5.1-codex, openai/gpt-5.1-codex-max: `thinking.efforts=["minimal","low","medium","high"]`.
- For models openai/gpt-5.1-codex-mini: `thinking.efforts=["medium","high"]`.
- For models z-ai/glm-4.5*, z-ai/glm-4.7*, ~google*, ~openai*, z-ai/glm-4.6, z-ai/glm-4.6v, z-ai/glm-5, z-ai/glm-5.1, ~moonshotai/kimi-latest: `thinking.efforts=["minimal","low","medium","high","xhigh"]`.
- For models z-ai/glm-5.2: `thinking.efforts=["minimal","low","medium","high","max"]`.
- Provider defaults: `thinking.mode="effort"`.

- **Device-Code OAuth Authentication**: Declared in `packages/catalog/src/compat/rules/auth/kilo.kdl` (`login "custom" hook="kilo"`) and implemented in `packages/ai/src/registry/oauth/kilo.ts` (`loginKilo`), initiating device authorization via `POST https://api.kilo.ai/api/device-auth/codes`, returning a user `code`, `verificationUrl`, and `expiresIn` seconds. It displays instructions via `callbacks.onAuth` and polls `GET https://api.kilo.ai/api/device-auth/codes/<userCode>` every 5,000ms until expiration. Handles HTTP 202 (pending), 403/410 (denied/expired), and rate limiting (HTTP 429), returning access tokens with 1-year expiration upon approval (`pollData.status === "approved"`). Supports cancellation via `callbacks.signal`.
- **Host URL Matching**: Host mapping in `packages/catalog/src/hosts.ts` associates URL marker `api.kilo.ai` with provider `"kilo"`.
- **Provider Priority**: Included in `packages/catalog/src/identity/priority.ts` provider priority sequence (`"opencode-go"`, `"kilo"`, `"vercel-ai-gateway"`).

### Auth & usage
- **API Key & OAuth Tokens**: Authenticates via static environment variable `KILO_API_KEY` or OAuth access tokens issued through the device-code flow (`/login kilo`).
- **Bearer Token Headers**: Requests pass credentials as standard Bearer tokens (`Authorization: Bearer <key>`) against base URL `https://api.kilo.ai/api/gateway`.

### Catalog model handling
- **Provider entry (`kilo`)**: `packages/catalog/src/compat/rules/providers/kilo.kdl` declares default model `anthropic/claude-opus-5`. Environment keys: `KILO_API_KEY`.
- **Model Manager & Wire Descriptor**: `kiloModelManagerOptions` in `packages/catalog/src/provider-models/openai-compat.ts` maps `providerId: "kilo"` to base URL `https://api.kilo.ai/api/gateway` and delegates dynamic model discovery to `fetchOpenAICompatibleModels`. Associated with `openAiCompletionsDescriptor("kilo", "kilo", "https://api.kilo.ai/api/gateway")`.

## Kimi Code (`kimi-code`)
Kimi Code provides subscription-backed access to Kimi models (`kimi-for-coding`, `k3`) via Moonshot AI's `/coding/v1` API endpoints. It rides the [Kimi Code](#kimi-code) transport pipeline, delegating request execution to `streamKimi` (`packages/ai/src/providers/kimi.ts`) and `streamOpenAIAnthropicShim` (`packages/ai/src/providers/openai-anthropic-shim.ts`).

### Special casings

Provider-specific overrides in `packages/catalog/src/compat/rules/providers/kimi-code.kdl` (more-specific selectors override provider defaults):

- For class kimi; family k3: `thinkingFormat="openai"`.
- For class kimi: `thinkingFormat="zai"`.
- For class unknown: `reasoningContentField="reasoning_content"`, `supportsDeveloperRole=false`, `thinkingFormat="kimi"`, `thinking.efforts=["minimal","low","medium","high"]`.
- For models kimi-for*: `reasoningContentField="reasoning_content"`, `supportsDeveloperRole=false`, `thinkingFormat="zai"`, `thinking.efforts=["minimal","low","medium","high"]`.
- Provider defaults: `kimiApiFormat="anthropic"`, `supportsPromptCacheKey=true`, `thinking.mode="effort"`.

- **Prompt Cache Key Sharing**: `isKimiModel` (`packages/ai/src/providers/kimi.ts`) gates prompt caching; Anthropic-compatible (`packages/ai/src/providers/anthropic.ts`) and OpenAI-compatible (`packages/ai/src/providers/openai-completions.ts`) requests both attach `prompt_cache_key` derived via `getOpenAIPromptCacheKey` to share affinity identity across transport switches.
- **Common Header Prepending**: `prependHeaders` in `packages/ai/src/providers/openai-completions.ts` injects `getKimiCommonHeaders()` (`packages/ai/src/registry/oauth/kimi.ts`) into all `kimi-code` requests.
- **Reasoning Guard**: `stream.ts` checks `isKimiModel` before execution, disabling unsupported reasoning configurations on K3 (`packages/ai/src/providers/openai-completions.ts`).

### Auth & usage
- **Device OAuth Flow**: Declared in `packages/catalog/src/compat/rules/auth/kimi-code.kdl` as a `login "device-code"` rule (`packages/ai/src/registry/engine/device-code.ts`) with headers hook in `packages/ai/src/registry/oauth/kimi.ts`. Uses OAuth 2.0 Device Code Authorization (`client-id` `17e5f671-d194-4dfb-9706-5516cb48c098`) against base URL `https://auth.kimi.com` (overrideable via `KIMI_CODE_OAUTH_HOST` or `KIMI_OAUTH_HOST`).
- **Fingerprinting & Device Persistence**: `getKimiCommonHeaders()` injects tracking headers (`User-Agent: KimiCLI/<ver>`, `X-Msh-Platform`, `X-Msh-Version`, `X-Msh-Device-Name`, `X-Msh-Device-Model`, `X-Msh-Os-Version`, `X-Msh-Device-Id`). `getDeviceId` persists a random hex UUID to `path.join(getAgentDir(), "kimi-device-id")` (mode `0600`), falling back to an in-memory ephemeral UUID if file writing fails.
- **Usage & Quota Tracker**: `kimiUsageProvider` (`packages/ai/src/usage/kimi.ts`) fetches `GET /coding/v1/usages` (`https://api.kimi.com/coding/v1/usages`, configurable via `KIMI_CODE_BASE_URL`) for OAuth credentials. Short-circuits when tokens are expired (`credential.expiresAt <= nowMs`). Parses `usage` and `limits` into `UsageLimit` entries, carrying row-level reset timestamps (`reset_at`, `resetTime`, `ttl`) to the window object when window reset time is absent.

### Catalog model handling
- **Provider entry (`kimi-code`)**: `packages/catalog/src/compat/rules/providers/kimi-code.kdl` declares default model `kimi-for-coding`.
- **Dynamic Model Discovery**: `kimiCodeModelManagerOptions` (`packages/catalog/src/provider-models/openai-compat.ts`) queries `/coding/v1/models` using `fetchOpenAICompatibleModels` with `KimiCLI/1.0` headers. Maps models via `kimiSupportsReasoning`, `mapKimiThinking`, and `mapKimiApiFormat` (setting `compat.kimiApiFormat` to `"anthropic"` or `"openai"`).

## LiteLLM (`litellm`)
LiteLLM is an open-source AI proxy and gateway that unifies access to multiple LLM providers behind an OpenAI-compatible API host. In `pi`, it operates using the OpenAI Chat Completions (`openai-completions`) transport pipeline.

### Special casings
- **Anthropic & Bedrock tool compatibility (`packages/ai/src/providers/openai-completions.ts`)**:
  - When `context.tools` is `undefined` but conversation history contains tool calls, `params.tools` is set to `[]` for Anthropic-via-LiteLLM compatibility.
  - When `context.tools` is explicitly empty (`[]`, e.g., `/btw` or background turns), `params.tools` and `tool_choice: "none"` are omitted so LiteLLM → Bedrock routes do not generate invalid, empty `toolConfig` blocks.
- **Telemetry & gateway header detection (`packages/agent/src/telemetry.ts`, `packages/ai/src/auth-gateway/http.ts`)**: `detectGatewayFromHeaders` inspects `x-litellm-call-id` (falling back to `x-litellm-model-id` or `x-litellm-model-group`) to populate `omp.gen_ai.gateway.*` span attributes. Auth gateway HTTP endpoints expose `x-litellm-model-id`, `x-litellm-model-api-base`, `x-litellm-response-cost`, and `x-litellm-response-duration-ms`.

### Auth & usage
- **Credentials & env (`packages/catalog/src/compat/rules/providers/litellm.kdl`, `packages/catalog/src/compat/rules/auth/litellm.kdl`)**: Authenticates via `LITELLM_API_KEY`.
- **Login onboarding (`packages/catalog/src/compat/rules/auth/litellm.kdl`)**: Declared as a `login "api-key"` rule (`packages/ai/src/registry/engine/api-key.ts`), directing users to setup docs (`https://docs.litellm.ai/docs/proxy/deploy`), prompting for master/virtual keys (`sk-...`), and noting `LITELLM_BASE_URL` for custom proxy endpoints. CLI `login` delegates to `SqliteAuthCredentialStore.login()`.
- **Default base URL (`packages/catalog/src/provider-models/cache-provider-id.ts`)**: Resolves to `Bun.env.LITELLM_BASE_URL` or `http://localhost:4000/v1`.

### Catalog model handling
- **Provider entry (`litellm`)**: `packages/catalog/src/compat/rules/providers/litellm.kdl` declares default model `claude-opus-5-5`. Environment keys: `LITELLM_API_KEY`.
- **Rich management endpoint discovery (`packages/catalog/src/provider-models/openai-compat.ts`)**: `fetchLiteLLMRichModels` probes `/model_group/info`, `/v2/model/info`, `/model/info`, and `/v1/model/info`. It filters sentinel placeholder IDs (`all-team-models`, `all-proxy-models`, `no-default-models`) and known task-specific modes (`audio_speech`, `audio_transcription`, `batch`, `embedding`, `guardrail`, `image_edit`, `image_generation`, `moderation`, `ocr`, `rerank`, `search`, `vector_store`, `video_generation`), while retaining null, missing, malformed, and unknown modes. It parses context limits (`max_input_tokens`), output limits (`max_output_tokens`), `supports_vision`, `supports_reasoning`, `supported_openai_params` (mapping `reasoning_effort`), and per-token pricing (`input_cost_per_token`, `output_cost_per_token`, cache read/write costs mapped to $/million tokens).
- **Fallback discovery & display names (`packages/catalog/src/provider-models/openai-compat.ts`)**: If rich endpoints fail, discovery falls back to `/v1/models` (`fetchOpenAICompatibleModels`), applies the same mode filtering, and resolves specs against `models.dev` references. Strips reseller multiplier suffixes (e.g., `(1.5x usage)`) from display names.
- **Compatibility overrides (`packages/catalog/src/provider-models/openai-compat.ts`)**: Hardcodes `compat.supportsStore: false` and `compat.supportsDeveloperRole: false` for all resolved models.

## LM Studio (`lm-studio`)
LM Studio is a local OpenAI-compatible model server running on user hardware (defaulting to `http://127.0.0.1:1234/v1`). It uses the [OpenAI Chat Completions](#openai-chat-completions) transport (`api: "openai-completions"`) to stream chat completions and tool calls.

### Special casings

Provider-specific overrides in `packages/catalog/src/compat/rules/providers/lm-studio.kdl` (more-specific selectors override provider defaults):

- Provider defaults: `supportsNamedToolChoice=false`.

- **Grammar Schema Normalization**: Configures `toolSchemaFlavor: "grammar"` in catalog compat (`packages/catalog/src/compat/resolve.ts`). Tool JSON schemas are sanitized via `sanitizeSchemaForGrammar` (`packages/ai/src/utils/schema/normalize.ts`), widening bare boolean `true` or `{}` subschemas in property positions into primitive unions to avoid GBNF grammar parser failures (`Unrecognized schema: true`, issue #5914).

### Stream behavior
- **Watchdog Timeout Floors**: Configures `streamFirstEventTimeoutMs: 0` (`packages/catalog/src/compat/resolve.ts`) to disable the pre-response first-event watchdog during long local model cold-loads or prompt prefills, and sets `streamIdleTimeoutMs: 300_000` (300s inter-event floor; see [Provider compat reference](./provider-compat-reference.md)) to prevent stream cancellation during slow token generation.

### Auth & usage
- **Keyless Local Auth**: Defined as a keyless provider in `packages/catalog/src/compat/rules/auth/lm-studio.kdl` (`empty-fallback "lm-studio-local"`, `allowUnauthenticated: true` in `packages/catalog/src/compat/rules/providers/lm-studio.kdl`). Uses placeholder `"lm-studio-local"` when `LM_STUDIO_API_KEY` is not provided.
- **Endpoint & Credentials**: Base URL defaults to `http://127.0.0.1:1234/v1` or `LM_STUDIO_BASE_URL`. Interactive CLI login is declared in `packages/catalog/src/compat/rules/auth/lm-studio.kdl` as a `login "api-key"` rule (`packages/ai/src/registry/engine/api-key.ts`).
- **Usage Accounting**: Employs standard OpenAI Chat Completions usage accounting (`calculateOpenAIUsageAccounting` in `packages/ai/src/providers/openai-shared.ts`).

### Catalog model handling
- **Provider entry (`lm-studio`)**: `packages/catalog/src/compat/rules/providers/lm-studio.kdl` declares default model `llama-3-8b`. Environment keys: `LM_STUDIO_API_KEY`. Model management permits unauthenticated access.
- **Native Metadata Probe**: Probes LM Studio's native endpoint `/api/v0/models` via `fetchLmStudioNativeModelMetadata` (with `LM_STUDIO_NATIVE_METADATA_TIMEOUT_MS = 250`). Sets `input: ["text", "image"]` when `type === "vlm"` or capabilities include `vision`/`image` (setting `imageInputDecoder: "stb"` during discovery).
- **Loaded Context Length**: `getLmStudioNativeContextWindow` prefers `loaded_context_length` for active models over architectural ceilings (`max_context_length`, `context_length`, `max_model_len`), ensuring context window limits accurately reflect current VRAM/RAM allocations.

## Meta Model API (`meta`)
Meta Model API is Meta's commercial API platform hosting first-party models such as `muse-spark-1.1`. It interacts with the model service via the OpenAI Responses transport targeting `https://api.meta.ai/v1`.

### Special casings
- **Output Token Clamp Bypass**: `resolveOpenAIResponsesOutputClamp` (`packages/ai/src/providers/openai-shared.ts`) checks `model.provider === "meta"` to allow Meta requests to output up to `model.maxTokens` (131,072 tokens) rather than being restricted by the default 64,000 token ceiling (`OPENAI_MAX_OUTPUT_TOKENS`).

### Auth & usage
- **API Key Login**: Declared in `packages/catalog/src/compat/rules/auth/meta.kdl` as a `login "api-key"` rule (`packages/ai/src/registry/engine/api-key.ts`) with dashboard URL `https://developer.meta.com/ai/`. Validation issues a GET request to `https://api.meta.ai/v1/models` (`validate "models-endpoint"`).
- **Environment Variables**: Key resolution checks `MODEL_API_KEY` first, falling back to `META_API_KEY` (`packages/catalog/src/compat/rules/providers/meta.kdl`).

### Catalog model handling
- **Provider entry (`meta`)**: `packages/catalog/src/compat/rules/providers/meta.kdl` declares default model `muse-spark-1.1`. Environment keys: `MODEL_API_KEY`, `META_API_KEY`.
- **Authored seeds**: `muse-spark-1.1`, `muse-spark-1.2`, `muse-spark-1.2-contributor`, `muse-spark-1.3`, `muse-spark-1.3-contributor`; bundle policy `always`. Limits, capabilities, and prices are authored alongside these rows.


## MiniMax (`minimax`)
MiniMax provides foundation models (including MiniMax-M3 and M2 generation) accessible via regional international (`api.minimax.io`) and mainland China (`api.minimaxi.com`) endpoints. Standard `minimax` / `minimax-cn` and MiniMax Token Plan `minimax-code` / `minimax-code-cn` all use "Anthropic Messages" (`/anthropic`), the protocol MiniMax recommends; only the Token Plan's legacy `*-lightning` rows stay on "OpenAI Chat Completions" (`/v1`).

### Special casings

Provider-specific overrides in `packages/catalog/src/compat/rules/providers/minimax.kdl` (more-specific selectors override provider defaults):

- Provider defaults: `reasoningDeltasMayBeCumulative=true`.

- **Object tool args**: `streamOpenAICompletions` in `packages/ai/src/providers/openai-completions.ts` intercepts MiniMax-compatible hosts that stream `function.arguments` as raw JSON objects rather than standard JSON strings, deep-merging object deltas into `block.partialArgs` and serializing a single concat-safe string delta at `finishToolCallBlock` before `toolcall_end`.
- **Inband XML dialect**: `packages/ai/src/dialect/minimax.ts` registers the `minimax` dialect (`<minimax:tool_call>`) for fallback XML tool invocation parsing.
- **Gateway API overrides**: `OPENCODE_ZEN_API_RESOLUTION` and `OPENCODE_GO_API_RESOLUTION` in `packages/catalog/src/provider-models/openai-compat.ts` force `minimax-m3` / `minimax-m3-free` / `minimax-m2.7` on OpenCode gateways to route over `openai-completions` at `/v1/chat/completions` instead of Anthropic `/v1/messages`.

### Auth & usage
- **Auth keys**: Uses `MINIMAX_API_KEY` (`minimax`), `MINIMAX_CODE_API_KEY` (`minimax-code`), and `MINIMAX_CODE_CN_API_KEY` (`minimax-code-cn`) declared in `packages/catalog/src/compat/rules/providers/minimax.kdl`.
- **Token Plan login**: Declared in `packages/catalog/src/compat/rules/auth/minimax-code.kdl` and `minimax-code-cn.kdl` as `login "api-key"` rules (`packages/ai/src/registry/engine/api-key.ts`), driving prompts linking to `https://platform.minimax.io/subscribe/token-plan` (international) and `https://platform.minimaxi.com/subscribe/token-plan` (China) and validating the key with a `MiniMax-M3` Anthropic Messages request (`validate "anthropic-messages"`).
- **Usage quota**: `minimaxCodeUsageProvider` in `packages/ai/src/usage/minimax-code.ts` polls `GET /v1/token_plan/remains` at the host root of the configured `minimax-code` base URL (default `https://api.minimax.io`; trailing `/v1`, `/anthropic`, and `/anthropic/v1` suffixes are stripped), parsing rolling interval and weekly usage windows per plan bucket into remaining percentages for `omp usage`. Only the international provider is registered; `minimax-code-cn` has no usage provider.

### Catalog model handling
- **Provider entry (`minimax`)**: `packages/catalog/src/compat/rules/providers/minimax.kdl` declares default model `MiniMax-M3`. Environment keys: `MINIMAX_API_KEY`.
- **Context window policy**: `scripts/generated-policies.ts` overrides `MiniMax-M3` context limits to 1,000,000 tokens for `minimax`, `minimax-code`, and `minimax-code-cn`, matching the documented 1M long-context tier over upstream pricing boundaries.
- **OpenAI-route flags**: For Token Plan rows still on `openai-completions` (legacy `*-lightning`), `classes/minimax.kdl` sets `supports-store #false`, `supports-developer-role #false`, `supports-reasoning-effort #false`, and `reasoning-content-field "reasoning_content"`.

## MiniMax Token Plan (`minimax-code`)
The MiniMax Token Plan provider (`minimax-code`, alongside its mainland China regional variant `minimax-code-cn`) provides access to MiniMax subscription models such as `MiniMax-M3.1-Flash-Preview`, `MiniMax-M3`, and `MiniMax-M2.5` over the Anthropic Messages transport (`https://api.minimax.io/anthropic` for international, `https://api.minimaxi.com/anthropic` for China), the same transport as plain `minimax`. Unlike plain `minimax` (static pay-as-you-go API key), `minimax-code` uses an interactive subscription login flow and features token plan quota monitoring via `omp usage`.

### Special casings
- **Shared transport with plain `minimax`**: All four MiniMax providers route over `anthropic-messages`, so the `class "minimax"` rules in `packages/catalog/src/compat/rules/classes/minimax.kdl` give them the same adaptive thinking. `MiniMax-M3.1-Flash-Preview` sends `low`..`max` as `output_config.effort`. The model always thinks (`thinking.type: "disabled"` and effort `none` return error 2013), so like the M2 family it is marked `thinking-requires-effort`: thinking-off, forced-off, and effort-less requests clamp to `low` in `normalizeMandatoryReasoningOptions` (`packages/ai/src/stream.ts`) before reaching the transport (`test/anthropic-fable-request-shaping.test.ts`).
- **Legacy lightning rows**: `MiniMax-M2.1-lightning` and `MiniMax-M2.5-lightning` are absent from models.dev, both live model lists, and the Anthropic endpoint's supported-model list, so they survive only as previous-snapshot rows on `openai-completions` (`https://api.minimax.io/v1`). A `models` residue rule in `providers/minimax-code.kdl` / `minimax-code-cn.kdl` keeps their effort-mode thinking.
- **OpenAI-route handling (lightning rows, custom overrides)**: `classes/minimax.kdl` sets `supports-store #false`, `supports-developer-role #false`, `supports-reasoning-effort #false`, and `reasoning-content-field "reasoning_content"` for `minimax-code` / `minimax-code-cn`. `mergeStreamingArgumentObjects` in `packages/ai/src/providers/openai-completions.ts` deep-merges `function.arguments` streamed as partial JSON objects, and the stream parser turns inline `<think>`...`</think>` tags into thinking blocks while deduplicating MiniMax-M3 cumulative reasoning snapshots after visible answer content has started.

### Auth & usage
- **Interactive Subscription Login Flow**: Declared in `packages/catalog/src/compat/rules/auth/minimax-code.kdl` as a `login "api-key"` rule (`packages/ai/src/registry/engine/api-key.ts`). This is an interactive API key prompt: it directs to the subscription portal (`https://platform.minimax.io/subscribe/token-plan`), prompts for key entry (`sk-...`), and validates the key via a `POST /anthropic/v1/messages` request (`validate "anthropic-messages"`) using `MiniMax-M3`.
- **Environment Variables**: Resolves credentials from `MINIMAX_CODE_API_KEY` for international `minimax-code` and `MINIMAX_CODE_CN_API_KEY` for China `minimax-code-cn` (plain `minimax` resolves `MINIMAX_API_KEY`).
- **Token Plan Quota Tracking**: `minimaxCodeUsageProvider` in `packages/ai/src/usage/minimax-code.ts` queries `GET /v1/token_plan/remains` with `Authorization: Bearer ${apiKey}` at the host root, so the bundled Anthropic-route base URL (`https://api.minimax.io/anthropic`) still resolves to `https://api.minimax.io/v1/token_plan/remains` (`test/minimax-token-plan-usage.test.ts`).
- **Quota Metric Parsing & Normalization**: Parses `model_remains[]` entries into rolling interval windows (`current_interval_*`) and 7-day windows (`current_weekly_*`). The shared plan quota `general` is scoped as `{ shared: true }`. Calculates `usedFraction` via `(100 - remainingPercent) / 100` and overrides status if `current_*_status === 2` (`STATUS_EXHAUSTED`). Out-of-plan models (status 3 `STATUS_UNLIMITED` with zero totals) are filtered out into `metadata.unavailableModels`. Validates success via `base_resp.status_code === 0` to catch API errors returned under HTTP 200 responses.

### Catalog model handling
- **Provider entry (`minimax-code`)**: `packages/catalog/src/compat/rules/providers/minimax-code.kdl` declares default model `MiniMax-M3`. Environment keys: `MINIMAX_CODE_API_KEY`.
- **Catalog Wiring**: `anthropicMessagesDescriptor` in `packages/catalog/src/provider-models/openai-compat.ts` registers descriptors `"minimax-coding-plan"` and `"minimax-cn-coding-plan"` bound to base URLs `https://api.minimax.io/anthropic` and `https://api.minimaxi.com/anthropic`.
- **1M Context Tier Override**: Policy generation (`packages/catalog/scripts/generated-policies.ts`) explicitly overrides `MiniMax-M3` context windows for `minimax-code` and `minimax-code-cn` to report the documented 1,000,000-token tier instead of the upstream 512,000-token pricing boundary.
- **Pay-as-you-go equivalent pricing**: Upstream reports $0 for every Token Plan model. The `minimax-code` / `minimax-code-cn` `pricing-peer` rules in `runtime/behavior.kdl` price rows at their `minimax` / `minimax-cn` list prices at build time (Credits overflow is billed at the PAYG list price), so usage and `omp stats` show PAYG-equivalent cost. `MiniMax-M3.1-Flash-Preview` has no published price and borrows the `MiniMax-M3` rate as an estimate. `applyPricingPeerFallback` (`packages/catalog/scripts/generated-policies.ts`) fills only zero-cost rows and tries a rule's alias `peer-id` before the row's own id, across peers in declared order.
- **Host Matching**: Provider host mapping in `packages/catalog/src/hosts.ts` associates `urlMarkers` `api.minimax.io` and `api.minimaxi.com` with `minimax`, `minimax-code`, and `minimax-code-cn`.

## MiniMax Token Plan (China) (`minimax-code-cn`)
MiniMax Token Plan (China) provides access to MiniMax models for mainland China subscribers using the Anthropic Messages transport (`anthropic-messages`, `https://api.minimaxi.com/anthropic`); only the legacy `*-lightning` rows use OpenAI Chat Completions (`https://api.minimaxi.com/v1`). It connects to China regional endpoints for subscription onboarding, API key validation, and model execution.

### Special casings
- **OpenAI-route stream handling (lightning rows, custom overrides)**: `mergeStreamingArgumentObjects` in `packages/ai/src/providers/openai-completions.ts` handles MiniMax backends streaming `function.arguments` as raw JSON objects instead of standard OpenAI JSON strings (`test/issue-1776-repro.test.ts`, `test/issue-2080-repro.test.ts`). `<think>` tags delivered in content streams are normalized into thinking blocks (`test/issue-1203-repro.test.ts`), while `lastCumulativeReasoningBySignature` in `packages/ai/src/dialect/demotion.ts` and `streamOpenAICompletionsOnce` deduplicate cumulative reasoning snapshots for `MiniMax-M3` across text block transitions. These repros build an explicit OpenAI-route Token Plan model (`minimaxTokenPlanOpenAIModel` in `packages/ai/test/helpers`) because the bundled rows ride the Anthropic route.
- **Unsupported Feature Stripping**: On the OpenAI route, requests omit unsupported thinking options (`test/issue-955-repro.test.ts`, which runs an OpenAI-route Token Plan model); `classes/minimax.kdl` applies `supports-store #false`, `supports-developer-role #false`, `supports-reasoning-effort #false`, and `reasoning-content-field "reasoning_content"`.

### Auth & usage
- **API Key & Interactive Login**: Authenticates via `MINIMAX_CODE_CN_API_KEY` (`packages/catalog/src/compat/rules/providers/minimax-code-cn.kdl`). Interactive login declared in `packages/catalog/src/compat/rules/auth/minimax-code-cn.kdl` as a `login "api-key"` rule (`packages/ai/src/registry/engine/api-key.ts`) points to `https://platform.minimaxi.com/subscribe/token-plan` and validates the pasted key with a `MiniMax-M3` Anthropic Messages request against `https://api.minimaxi.com/anthropic`.
- **Endpoints & Host Detection**: API requests target `https://api.minimaxi.com/anthropic` (lightning rows: `https://api.minimaxi.com/v1`) (`packages/catalog/src/models.json`). `urlMarkers` includes `api.minimaxi.com` under the `minimax` host classification in `packages/catalog/src/hosts.ts`.
- **Usage Telemetry Availability**: Unlike `minimax-code` (which fetches quota remaining percentages from `https://api.minimax.io/v1/token_plan/remains` via `minimaxCodeUsageProvider` in `packages/ai/src/usage/minimax-code.ts`), `minimax-code-cn` has no usage provider registered (`storage.usageProviderFor("minimax-code-cn")` returns `undefined` in `packages/ai/src/auth-storage.ts` and `test/minimax-token-plan-usage.test.ts`), so usage telemetry is disabled for China regional accounts.

### Catalog model handling
- **Provider entry (`minimax-code-cn`)**: `packages/catalog/src/compat/rules/providers/minimax-code-cn.kdl` declares default model `MiniMax-M3`. Environment keys: `MINIMAX_CODE_CN_API_KEY`.
- **1M Context Window Override**: `packages/catalog/scripts/generated-policies.ts` overrides `MiniMax-M3` context window from the upstream 512K pricing boundary to 1,000,000 (1M) tokens (`model.contextWindow = 1_000_000`) for `minimax-code-cn` (alongside `minimax-code`, `minimax`).
- **Catalog Policy Overrides**: OpenAI-route rows take `reasoning-content-field "reasoning_content"`, `supports-store #false`, `supports-developer-role #false`, and `supports-reasoning-effort #false` from `classes/minimax.kdl`; Anthropic-route rows share plain `minimax-cn`'s adaptive thinking rules.

## Mistral (`mistral`)
Mistral AI provides access to Mistral, Codestral, Devstral, Ministral, and Pixtral models via `api.mistral.ai/v1`. Requests use the OpenAI Chat Completions transport (`openai-completions`).

### Special casings
- **Compat Cluster (`packages/catalog/src/compat/resolve.ts`: `isMistral`)**:
  - `requiresMistralToolIds` / `toolCallIdKind: "mistral-9-alnum"` (`packages/ai/src/providers/openai-shared.ts`): Restricts tool call IDs to 9-character alphanumeric strings (`[a-zA-Z0-9]{9}`).
  - `requiresAssistantAfterToolResult`: Synthesizes an assistant message bridge following tool result messages prior to subsequent content (`packages/ai/src/providers/openai-completions.ts`).
  - `requiresToolResultName`: Mandates the tool function `name` property on tool result messages (`packages/ai/src/providers/openai-completions.ts`).
  - `requiresThinkingAsText`: Formats reasoning and thinking content as plain text blocks instead of native reasoning fields (`packages/catalog/src/compat/resolve.ts`).
  - `maxTokensField: "max_tokens"`: Emits `max_tokens` instead of `max_completion_tokens` in request payloads (`packages/catalog/src/compat/resolve.ts`).
- **Array `delta.content` Streaming Normalization (`packages/ai/src/providers/openai-completions.ts`: `normalizeStreamingContentText`)**: Unpacks streaming response chunks where models (e.g. `mistral-medium-2604`) deliver `delta.content` as typed arrays (`[{ type: "text", text: "..." }]`), preventing `[object Object]` string coercion bugs.

### Auth & usage
- **Authentication**: Authenticates using bearer tokens from the `MISTRAL_API_KEY` environment variable (`packages/catalog/src/compat/rules/providers/mistral.kdl`: `mistral`).
- **Usage Tracking**: Standard OpenAI chat completions usage parsing (`packages/ai/src/providers/openai-completions.ts`).

### Catalog model handling
- **Provider entry (`mistral`)**: `packages/catalog/src/compat/rules/providers/mistral.kdl` declares default model `devstral-medium-latest`. Environment keys: `MISTRAL_API_KEY`.
- **Host Matching**: Host URL marker matching checks for `mistral.ai` (`packages/catalog/src/hosts.ts`: `mistral`).

## Moonshot (`moonshot`)
Moonshot is the pay-as-you-go open platform provider for Moonshot AI endpoints (`https://api.moonshot.ai/v1` or mainland China `https://api.moonshot.cn/v1`). It rides the `OpenAI Chat Completions` transport engine (`openai-completions` API surface) and shares Kimi-family dialect and thinking mechanics (Kimi taxonomy in `packages/catalog/src/compat/taxonomy.ts`). It is distinct from `kimi-code`, which uses subscription device OAuth and subscription endpoints (`api.kimi.com` / `/coding/v1/*`).

### Special casings

Provider-specific overrides in `packages/catalog/src/compat/rules/providers/moonshot.kdl` (more-specific selectors override provider defaults):

- For class kimi; family k3: `thinkingFormat="openai"`.
- For class kimi: `thinkingFormat="zai"`, `thinking.mode="effort"`.

- **`MOONSHOT_BASE_URL` Override**: `resolveOpenAIRequestSetup` (`packages/ai/src/providers/openai-shared.ts`) overrides default catalog base URLs (`api.moonshot.ai/v1`) with `$env.MOONSHOT_BASE_URL` (e.g. `https://api.moonshot.cn/v1` for mainland China platform users whose keys are rejected by the international endpoint; issue #2883).
- **Reasoning Content Replay Requirement**: `requiresReasoningContentForToolCalls` (`packages/catalog/src/compat/resolve.ts`) forces tool-call continuation turns to replay prior `reasoning_content` (or a synthetic placeholder `.`), preventing Moonshot from aborting or re-deriving reasoning from scratch.

### Auth & usage
- **API-Key Authentication**: Declared in `packages/catalog/src/compat/rules/auth/moonshot.kdl` as a `login "api-key"` rule (`packages/ai/src/registry/engine/api-key.ts`) pointing users to dashboard `https://platform.moonshot.ai/console/api-keys`.
- **Endpoint Validation**: Validates keys via `GET ${MOONSHOT_BASE_URL || "https://api.moonshot.ai/v1"}/models` (`validate "models-endpoint"` in `packages/catalog/src/compat/rules/auth/moonshot.kdl` with `base-url-env="MOONSHOT_BASE_URL"`).
- **Environment Variable Resolution**: `envVars: ["MOONSHOT_API_KEY", "KIMI_API_KEY"]` in `packages/catalog/src/compat/rules/providers/moonshot.kdl` accepts `KIMI_API_KEY` as a fallback for mainland China users who configure Kimi keys without `MOONSHOT_API_KEY` (issue #2883).
- **No Dedicated Usage Tracker**: Token usage is returned directly in OpenAI stream chunk `usage` objects in `openai-completions`; no separate usage API or file exists in `packages/ai/src/usage/`.

### Catalog model handling
- **Provider entry (`moonshot`)**: `packages/catalog/src/compat/rules/providers/moonshot.kdl` declares default model `kimi-k2.7-code`. Environment keys: `MOONSHOT_API_KEY`, `KIMI_API_KEY`.
- **Dynamic Model Discovery**: `moonshotModelManagerOptions` (`packages/catalog/src/provider-models/openai-compat.ts`) uses `createOpenAICompatibleModelManagerOptions` with `defaultBaseUrl: Bun.env.MOONSHOT_BASE_URL ?? "https://api.moonshot.ai/v1"`.
- **Dynamic K3 & K2.x Model Mapping**: In `moonshotModelManagerOptions` (`packages/catalog/src/provider-models/openai-compat.ts`):
  - Unreferenced `kimi-k3` entries are stamped with `reasoning: true`, input `["text", "image"]`, `MOONSHOT_KIMI_K3_COST`, `contextWindow: 1_000_000`, `maxTokens: 131_072`, and effort-based `thinking` config (issue #5756).
  - `kimi-k2.x` entries (e.g. `kimi-k2.5`, `kimi-k2.6`) are marked with `reasoning: true`, vision `["text", "image"]`, and multi-tier effort (`[Minimal, Low, Medium, High]`), ensuring `thinking` payloads are generated so models do not stall (issue #2113).
- **Host & Priority Token Classification**: Host marker `moonshotNative` (`urlMarkers: ["api.moonshot.ai", "api.kimi.com"]`) in `packages/catalog/src/hosts.ts` maps native Moonshot endpoints. Family priority token in `packages/catalog/src/identity/priority.ts` ranks `"moonshot"` right after `"kimi-code"`.

## NanoGPT (`nanogpt`)
NanoGPT is a pay-per-token API gateway exposing diverse open-weights and commercial language models via an OpenAI-compatible interface. It executes requests using the OpenAI Chat Completions transport (`openai-completions`) with a default base URL of `https://nano-gpt.com/api/v1`.

### Special casings

Provider-specific overrides in `packages/catalog/src/compat/rules/providers/nanogpt.kdl` (more-specific selectors override provider defaults):

- For models moonshotai/kimi-k2.6:thinking: `streamIdleTimeoutMs=300000`.
- For class anthropic; revision >=4.0.0 <4.5.0: `thinking.requiresEffort=true`.
- For class glm; family flash: `thinking.efforts=["minimal","low","medium","high","xhigh"]`.
- For class glm; family turbo: `thinking.efforts=["minimal","low","medium","high","xhigh"]`.
- For class openai; family o-series; revision >=4.0.0 <4.1.0: `thinking.efforts=["minimal","low","medium","high","xhigh"]`.
- For models *5.2:thinking, *glm-5.2: `thinking.efforts=["minimal","low","medium","high","max"]`.
- For models *glm-5.1, aion-labs/aion-3*, google*latest, holo*, inclusionai*thinking, meta/*, nanogpt*, nex-agi/nex*, nousresearch/hermes-4*, nvidia*b, nvidia*thinking, poolside*, sakana*, sarvam*, tencent/hy*, thinkingmachines*thinking, z-ai/glm-4*, zai-org/glm-4*thinking, zai-org/glm-5-original*, TEE/glm-5-1, aion-labs/aion-2.0, arcee-ai/trinity-large, arcee-ai/trinity-mini, bytedance-seed/seed-2.0-lite, inclusionai/ring-2.6-1t, longcat-2.0:thinking, mercury-2, minimax/minimax-latest, mistralai/devstral-2-123b-instruct-2512, moonshotai/kimi-latest, nvidia/nvidia-nemotron-nano-9b-v2, openai/gpt-chat-latest, openai/gpt-latest, openai/o1, openai/o3, openai/o3-deep-research, openai/o3-pro-2025-06-10, pokee-isaac, sonar-pro, tngtech/tng-r1t-chimera, upstage/solar-pro-3, zai-org/glm-4.7, zai-org/glm-4.7-original, zai-org/glm-5, zai-org/glm-5.1:thinking, zai-org/glm-5:thinking, zai-org/glm-latest: `thinking.efforts=["minimal","low","medium","high","xhigh"]`.
- For models Qwen/Qwen3-235B-A22B-Thinking-2507: `thinking.requiresEffort=true`.
- For models claw, hermes: `thinking.efforts=["low","medium","high"]`.
- For models deepseek/deepseek-latest: `requiresReasoningContentForAllAssistantTurns=true`, `thinking.efforts=["high","max"]`.
- For models deepseek/deepseek-v4-flash*, deepseek-ai/DeepSeek-R1-0528, deepseek/deepseek-v3.2:thinking: `requiresReasoningContentForAllAssistantTurns=true`.
- For models linkup-research: `thinking.defaultLevel="high"`, `thinking.efforts=["low","medium","high","xhigh"]`, `thinking.requiresEffort=true`.
- For models nvidia/nemotron-3-nano-omni-30b-a3b-reasoning: `thinking.efforts=["minimal","low","medium","high","xhigh"]`, `thinking.requiresEffort=true`.
- For models openai/gpt-5.1-codex, openai/gpt-5.1-codex-max: `thinking.efforts=["minimal","low","medium","high"]`.
- For models openai/gpt-5.1-codex-mini: `thinking.efforts=["medium","high"]`.
- For models Qwen3.5-27B-Claude-4.6-Opus-Reasoning-Distilled-Derestricted, Qwen3.5-27B-Claude-4.6-Opus-Reasoning-Distilled-Derestricted-Lite: `disableReasoningOnForcedToolChoice=false`, `supportsStore=false`, `thinkingFormat="qwen"`.
- For models Gemma-4-31B-Claude-4.6-Opus-Reasoning-Distilled: `disableReasoningOnForcedToolChoice=false`, `thinking.requiresEffort=true`.
- For models *deepseek-r1-distill*: `streamMarkupHealingPattern="dsml"`.
- Provider defaults: `thinking.mode="effort"`.

- **Direct Route Execution**: NanoGPT avoids appending `:tools` model route suffixes on DeepSeek requests, preventing `502` errors with `code: "malformed_tool_call"` triggered by NanoGPT's server-side tool parser on complex schemas.
- **Indexed Tool Delta Preservation**: Relies on `tool_calls[].index` tracking in `streamOpenAICompletionsOnce` (`packages/ai/src/providers/openai-completions.ts`) to ensure parallel streaming tool calls from NanoGPT do not merge or drop arguments across deltas.

### Auth & usage
- **API Key & Environment Variables**: Authenticates via `NANO_GPT_API_KEY` (resolved via `getEnvApiKey` in `packages/ai/src/stream.ts` and configured in catalog descriptors `packages/catalog/src/compat/rules/providers/nanogpt.kdl`).
- **Interactive Login**: Declared in `packages/catalog/src/compat/rules/auth/nanogpt.kdl` as a `login "api-key"` rule (`packages/ai/src/registry/engine/api-key.ts`), prompting for an API key linked from `https://nano-gpt.com/api` and validating credentials via `validate "models-endpoint"` against `https://nano-gpt.com/api/v1/models`.

### Catalog model handling
- **Provider entry (`nanogpt`)**: `packages/catalog/src/compat/rules/providers/nanogpt.kdl` declares default model `openai/gpt-5.5`. Environment keys: `NANO_GPT_API_KEY`.


## Novita (`novita`)
Novita AI is an AI cloud platform offering serverless OpenAI-compatible LLM inference for open models. It uses the OpenAI Chat Completions transport over `https://api.novita.ai/openai/v1`.

### Special casings
- Nothing beyond the OpenAI Chat Completions pipeline.

### Auth & usage
- **Authentication**: Declared in `packages/catalog/src/compat/rules/auth/novita.kdl` as a `login "api-key"` rule (`packages/ai/src/registry/engine/api-key.ts`) using standard API key prompt (`sk_...`) linking to `https://novita.ai/settings/key-management`. Environment variable `NOVITA_API_KEY` is checked via catalog descriptors (`packages/catalog/src/compat/rules/providers/novita.kdl`).
- **Inference-based key validation**: Validates keys in `packages/catalog/src/compat/rules/auth/novita.kdl` by sending a request to `/chat/completions` using `moonshotai/kimi-k2.7-code` (`validate "chat-completions"`). Novita's Developer and Basic team roles lack permission for `/openapi/v1/billing/balance/detail`, so inference validation avoids rejecting valid developer keys.

### Catalog model handling
- **Provider entry (`novita`)**: `packages/catalog/src/compat/rules/providers/novita.kdl` declares default model `moonshotai/kimi-k2.7-code`. Environment keys: `NOVITA_API_KEY`.
- **Discovery replacement**: Successful authoritative discovery replaces fallback provider rows rather than retaining retired seed models.
- **Model discovery**: Configured via `novitaModelManagerOptions` (`packages/catalog/src/provider-models/openai-compat.ts`) with `defaultBaseUrl: "https://api.novita.ai/openai/v1"` and `dynamicModelsAuthoritative: true`.
- **Unauthenticated discovery**: Descriptor sets `catalogDiscovery.allowUnauthenticated: true` (`packages/catalog/src/compat/rules/providers/novita.kdl`), allowing public catalog retrieval from `/openai/v1/models` without an API key.
- **Model filtering**: `filterModel` verifies active status (`status === 1` or non-number), requires `endpoints` to include `"chat/completions"`, checks positive `max_output_tokens`, and excludes internal test model IDs using `isPublicNovitaModelId` (excluding prefixes starting with `ai_infer_test`).
- **Cost scaling**: `toNovitaCostPerMillion` converts price fields (`input_token_price_per_m`, `output_token_price_per_m`, `pricing.input_cache_read.price_per_m`) by dividing by 10,000, scaling Novita's 1/10,000-USD per million rate to standard USD per million tokens.
- **Capabilities & metadata**: `mapNovitaModel` inspects `features` via `novitaArrayIncludes` for `"reasoning"` and `"function-calling"`, parses input modalities with `toInputCapabilities`, and extracts context/output window bounds.

## NVIDIA (`nvidia`)
NVIDIA NIM (Inference Microservice) provides access to hosted open and proprietary foundation models via the OpenAI Chat Completions transport (`openai-completions` API). Base endpoints default to `https://integrate.api.nvidia.com/v1`.

### Special casings

Provider-specific overrides in `packages/catalog/src/compat/rules/providers/nvidia.kdl` (more-specific selectors override provider defaults):

- For class qwen: `thinkingFormat="qwen-chat-template"`.
- For class unknown: `thinking.efforts=["minimal","low","medium","high","xhigh"]`.
- For models nvidia/nemotron-3-nano-omni-30b-a3b-reasoning: `thinking.requiresEffort=true`.
- For models qwen/qwen3-next-80b-a3b-thinking: `thinkingFormat="qwen-chat-template"`.
- For models z-ai/glm-5.1, z-ai/glm4.7, z-ai/glm5: `thinking.efforts=["minimal","low","medium","high","xhigh"]`.
- For models z-ai/glm-5.2: `thinking.efforts=["minimal","low","medium","high","max"]`.
- Provider defaults: `thinking.mode="effort"`.

- **Tool Choice & Reasoning**: DeepSeek reasoning models disable reasoning when tool choice is active (`disableReasoningOnToolChoice`, `packages/catalog/src/compat/resolve.ts`), while standard models support forced tool choice (`supportsForcedToolChoice: true`, `packages/ai/test/openai-completions-compat.test.ts`).

### Auth & usage
- **Authentication**: Key-based auth using NVIDIA NGC Personal Keys (`auth-url "https://org.ngc.nvidia.com/setup/personal-keys"` in `packages/catalog/src/compat/rules/auth/nvidia.kdl`), stored in `NVIDIA_API_KEY` (`packages/catalog/src/compat/rules/providers/nvidia.kdl:316`). Base URL is `https://integrate.api.nvidia.com/v1`.
- **Login & Validation**: Declared in `packages/catalog/src/compat/rules/auth/nvidia.kdl` as a `login "api-key"` rule (`packages/ai/src/registry/engine/api-key.ts`), validating keys against `nvidia/llama-3.1-nemotron-70b-instruct` (`validate "chat-completions"` with `optional=#true`). Fatal auth errors (`401`/`403`, `AIError.Flag.AuthFailed`) abort login; non-fatal validation errors are caught to allow custom or newly deployed models.
- **Provider Registration**: Compiled into `packages/ai/src/registry/registry.ts` from `packages/catalog/src/compat/rules/auth/nvidia.kdl` via `packages/ai/src/registry/build.ts`. Credential storage and deduplication are tested in `packages/ai/test/auth-storage-email-dedupe.test.ts`.
- **Usage**: Standard OpenAI Chat Completions usage metrics; no custom usage handler or quota endpoint.

### Catalog model handling
- **Provider entry (`nvidia`)**: `packages/catalog/src/compat/rules/providers/nvidia.kdl` declares default model `nvidia/llama-3.1-nemotron-70b-instruct`. Environment keys: `NVIDIA_API_KEY`.
- **Catalog Discovery**: Registered in catalog descriptors with `catalogDiscovery: { label: "NVIDIA" }` (`packages/catalog/src/compat/rules/providers/nvidia.kdl:318`).

## Ollama (`ollama`)
Local OpenAI-compatible provider integration running on local or self-hosted Ollama instances (defaulting to base URL `http://127.0.0.1:11434/v1`). Discovered models ride the shared Ollama and OpenAI Responses transport engines.

### Special casings

Provider-specific overrides in `packages/catalog/src/compat/rules/providers/ollama.kdl` (more-specific selectors override provider defaults):

- Provider defaults: `emptyLengthFinishIsContextError=true`, `thinking.efforts=["low","medium","high","max"]`.

- **Tool-Call Error Rewriting**: `rewriteOllamaToolCallJsonError` in `packages/ai/src/error/format.ts` intercepts HTTP 500 tool-call JSON parse failures from the local `llama.cpp` backend matching `LLAMA_CPP_TOOL_CALL_PARSE_PATTERN` and rewrites them to explain deterministic model-output degradation during context overflow.

### Auth & usage
- **Interactive Login & Optional Key**: Declared in `packages/catalog/src/compat/rules/auth/ollama.kdl` as a `login "api-key"` rule (`packages/ai/src/registry/engine/api-key.ts`), prompting for an optional API key/token (`empty-fallback ""`, placeholder `"ollama-local"`) pointing to `auth-url`; returning `""` signals local keyless mode.
- **Usage Provider & Quota Surfacing**: `ollamaUsageProvider` in `packages/ai/src/usage/ollama.ts` (`id: "ollama"`) implements `fetchUsage`, returning a `UsageReport` with empty `limits` and a note that standalone quota endpoints are not exposed; `validatesCredentials` is set to `false`.

### Catalog model handling
- **Provider entry (`ollama`)**: `packages/catalog/src/compat/rules/providers/ollama.kdl` declares default model `gpt-oss:20b`. Environment keys: `OLLAMA_API_KEY`. Model management permits unauthenticated access.
- **Dynamic Model Discovery**: `ollamaModelManagerOptions` in `packages/catalog/src/provider-models/openai-compat.ts` normalizes the endpoint via `normalizeOllamaBaseUrl` (defaulting to `http://127.0.0.1:11434/v1`) and queries `/v1/models` using `fetchOpenAICompatibleModels` (`packages/catalog/src/discovery/openai-compatible.ts`). If `/v1/models` is unavailable or empty, it falls back to native `fetchOllamaNativeModels` querying `/api/tags` on `toOllamaNativeBaseUrl` (`http://127.0.0.1:11434`).
- **Capability Probing & Context-Length Stamping**: `fetchOllamaShowMetadata` in `packages/catalog/src/provider-models/openai-compat.ts` posts `{ model: modelId }` to `/api/show` via `createOllamaMetadataResolver`. It extracts context length from `model_info` keys matching `.context_length`, `.num_ctx`, or `.context_window` (falling back to `OLLAMA_FALLBACK_CONTEXT_WINDOW` = 128,000 and `OLLAMA_DEFAULT_MAX_TOKENS` = 8,192). `capabilities.includes("thinking")` sets `reasoning: true` and configures `thinking` efforts (`[minimal, low, medium, high]`), while `capabilities.includes("vision")` stamps `input: ["text", "image"]`.
- **Model Cache Partitioning**: `cacheProviderId` in `ollamaModelManagerOptions` invokes `resolveModelCacheProviderId` (`packages/catalog/src/provider-models/cache-provider-id.ts`), partitioning local model cache keys by `ollama:ollama-models-v1:<hash>` derived from `baseUrl`.

## Ollama Cloud (`ollama-cloud`)
Ollama Cloud provides managed cloud access to open-weight LLMs via native `ollama-chat` protocol endpoints at `https://ollama.com`. It rides the [Ollama](#ollama) transport section, distinguishing itself from local Ollama by requiring explicit API key authentication and enforcing cloud-specific history sanitization and output token caps.

### Special casings

Provider-specific overrides in `packages/catalog/src/compat/rules/providers/ollama-cloud.kdl` (more-specific selectors override provider defaults):

- For class unknown: `thinking.efforts=["minimal","low","medium","high"]`.
- For models deepseek-v4-pro:preview: `thinking.efforts=["low","high","max"]`.
- For models glm-4*, glm-5, glm-5.1: `thinking.efforts=["minimal","low","medium","high"]`.
- For models glm-5.2: `thinking.efforts=["high","max"]`.
- Provider defaults: `thinking.mode="effort"`.

- **Assistant History Thinking Stripping**: `convertMessages` (`packages/ai/src/providers/ollama.ts`) strips `thinking` fields from assistant history messages when `model.provider === "ollama-cloud"`. Ollama Cloud endpoints reject incoming history containing `thinking` with HTTP 400 errors, whereas local `ollama` retains them.
- **Wire-Level Output Token Clamping**: `createChatBody` (`packages/ai/src/providers/ollama.ts`) clamps `options.num_predict` to `OLLAMA_CLOUD_NUM_PREDICT_CAP` (65,536) for `ollama-cloud` models, acting as a safety net against HTTP 400 errors when `maxTokens` or overrides are passed (#3392). Local `ollama` endpoints do not clamp `num_predict`.

### Auth & usage
- **Interactive Key Authentication**: Declared in `packages/catalog/src/compat/rules/auth/ollama-cloud.kdl` as a `login "api-key"` rule (`packages/ai/src/registry/engine/api-key.ts`), prompting for an API key generated at `https://ollama.com/settings/keys`, rejecting empty input with `ApiKeyRequiredError`.
- **Environment Variable Resolution**: `descriptors.ts` (`packages/catalog/src/compat/rules/providers/ollama-cloud.kdl`) and `getEnvApiKey` (`packages/ai/src/stream.ts`) resolve credentials via `OLLAMA_CLOUD_API_KEY`.
- **Usage Accounting**: `ollamaCloudUsageProvider` (`packages/ai/src/usage/ollama.ts`) handles usage for `ollama-cloud` using `fetchOllamaUsage`. Because Ollama Cloud has no standalone quota API (`validatesCredentials: false`), usage is tracked per-response via `prompt_eval_count` and `eval_count` stream metrics.

### Catalog model handling
- **Provider entry (`ollama-cloud`)**: `packages/catalog/src/compat/rules/providers/ollama-cloud.kdl` declares default model `gpt-oss:120b`. Environment keys: `OLLAMA_CLOUD_API_KEY`.
- **Dynamic Model Discovery & `/api/show` Metadata**: `ollamaCloudModelManagerOptions` (`packages/catalog/src/provider-models/ollama.ts`) fetches models via `GET /api/tags` on `https://ollama.com` using Bearer token auth, then queries `POST /api/show` (`fetchShowMetadata`) per model to inspect capabilities (`thinking`, `vision`) and `model_info` context window size (defaulting to 128,000). Returns an empty list when unauthenticated.
- **Output Token Ceiling & Token Parameter Omission**: `isOllamaCloudOutputCapped` (`packages/catalog/src/provider-models/ollama.ts`) identifies DeepSeek V4 Pro/Flash models, pinning `maxTokens` to `Math.min(contextWindow, OLLAMA_CLOUD_MAX_OUTPUT_TOKENS)` (65,536) to prevent backend rejected requests (ollama/ollama#16890, #7266). All discovered cloud models set `omitMaxOutputTokens: true` (also enforced via `applyGeneratedModelPolicy` in `packages/catalog/scripts/generated-policies.ts`).

## OpenCode Go (`opencode-go`)
OpenCode Go provides access to multi-provider subscription models (including Kimi, DeepSeek, GLM, Qwen, and MiniMax) through a unified gateway at `https://opencode.ai/zen/go`. Depending on the target model, requests route over the OpenAI Chat Completions or Anthropic Messages transport pipelines with dynamic API resolution.

### Special casings

Provider-specific overrides in `packages/catalog/src/compat/rules/providers/opencode-go.kdl` (more-specific selectors override provider defaults):

- For models deepseek-flash, deepseek-v4.1-flash: `stripImageInput=false`.
- For class deepseek; family flash: `supportsToolChoice=false`.
- For class deepseek: `thinking.mode="effort"`.
- For models deepseek-v4-flash-vision-exp: `supportsToolChoice=true`.
- For models deepseek-v4-flash, deepseek-v4-pro: `supportsToolChoice=false`, `maxTokensField="max_tokens"`, `reasoningContentField="reasoning_content"`, `requiresReasoningContentForToolCalls=true`.
- For class glm: `thinking.mode="effort"`.
- For class kimi: `thinking.mode="effort"`.
- For class meta; family muse-spark: `includeEncryptedReasoning=false`, `filterReasoningHistory=true`.
- For class mimo; family v2: `thinking.mode="effort"`.
- For class mimo: `supportsToolChoice=false`.
- For class qwen; revision >=3.5.0 <3.7.0: `thinking.efforts=["minimal","low","medium","high"]`, `thinking.mode="effort"`.
- For class qwen; revision >=3.7.0 <3.9.0: `thinking.efforts=["minimal","low","medium","high"]`, `thinking.mode="effort"`.
- For models glm-5, glm-5.1: `thinking.efforts=["minimal","low","medium","high","xhigh"]`.
- For models ox-alpha*: `thinking.efforts=["low","high","max"]`, `thinking.requiresEffort=true`.
- For models qwen3.8-flash: `thinking.efforts=["minimal","low","medium","high","xhigh"]`, `thinking.mode="budget"`.
- For models glm-5.2: `thinking.efforts=["minimal","low","medium","high","max"]`.
- For models gpt-5.6-luna, grok-4.5, minimax-m2.7, minimax-m3: `thinking.mode="effort"`.
- For models hy3: `thinking.efforts=["minimal","low","medium","high","xhigh"]`, `thinking.mode="effort"`.
- For models kimi-k2.7-code: `supportsForcedToolChoice=false`.
- For models minimax-m2.5: `thinking.effortMap={"low":"adaptive","medium":"adaptive","high":"adaptive"}`, `thinking.mode="anthropic-adaptive"`.
- Provider defaults: `whenThinking={"requiresReasoningContentForToolCalls":true,"allowsSyntheticReasoningContentForToolCalls":false,"reasoningContentField":"reasoning_content"}`.

- **API Resolution & Model ID Overrides**: `createOpenCodeApiResolution` (`packages/catalog/src/provider-models/openai-compat.ts`) constructs `OPENCODE_GO_API_RESOLUTION` for `https://opencode.ai/zen/go`. Explicit ID overrides (`minimax-m2.7`, `minimax-m3`, `minimax-m3-free`, `qwen3.5-plus`, `qwen3.6-plus`) take precedence over npm-based heuristics (`@ai-sdk/anthropic`), forcing route resolution to `openai-completions` at `/v1/chat/completions` to prevent gateway 404 HTML errors or raw tool-call markup leaks.
- **`X-Api-Key` Auth Normalization**: In `packages/ai/src/providers/anthropic.ts`, when `model.provider === "opencode-go"`, the transport deletes auto-generated `Authorization` Bearer headers so `AnthropicMessagesClient` emits `X-Api-Key`. Bearer-only requests to OpenCode Anthropic endpoints fail with HTTP `401 Missing API key` (#6510).

### Auth & usage
- **API Key Login Flow**: Declared in `packages/catalog/src/compat/rules/auth/opencode-go.kdl` as a `login "api-key"` rule (`packages/ai/src/registry/engine/api-key.ts`). It directs the user to `https://opencode.ai/auth`, prompts for the API key, and returns the trimmed key stored under `OPENCODE_API_KEY`.
- **Spend Windows**: `opencodeGoUsageProvider` (`packages/ai/src/usage/opencode-go.ts`) polls `GET /zen/go/v1/usage` per stored key (Bearer + `User-Agent` + `x-opencode-session`) and decodes the three server-computed windows (`rolling` → `rolling-5h`, `weekly`, `monthly`; each `{status: "ok" | "rate-limited", percent: 0-100, resetsAt}`) into percent limits with `resetsAt` deadlines. Ranking (`opencodeGoRankingStrategy`) uses rolling/weekly headroom; `monthly` is display-only because an exhausted monthly can still serve when the console "Use balance" fallback is on — hard monthly failures still rotate via the `401 Insufficient balance` usage-limit classification (#3169). Reactive quota 429s (`Resets in …` quota errors) rotate through `markUsageLimitReached`, with the server-stated window parsed by `extractRetryHint` (`packages/utils/src/fetch-retry.ts`).
- **Account funds 402**: Go can return `402 Upstream request failed: Insufficient account funds (type=server_error)` when an account cannot fund a request. OMP treats this as an account-local usage cap and retries a stored sibling API key instead of backing off on the exhausted key (#13019).

### Catalog model handling
- **Provider entry (`opencode-go`)**: `packages/catalog/src/compat/rules/providers/opencode-go.kdl` declares default model `kimi-k2.7-code`. Environment keys: `OPENCODE_API_KEY`.
- **Discovery replacement**: Successful authoritative discovery replaces fallback provider rows rather than retaining retired seed models.
- **Authoritative Dynamic Models**: `opencodeGoModelManagerOptions` (`packages/catalog/src/provider-models/openai-compat.ts`) and descriptor configuration (`packages/catalog/src/compat/rules/providers/opencode-go.kdl`, default model `kimi-k2.7-code`) specify `dynamicModelsAuthoritative: true`. Successful runtime discovery via `fetchOpenAICompatibleModels` from `https://opencode.ai/zen/go/v1/models` completely replaces bundled provider models instead of merging fallback-only IDs (`model-manager.ts`).

## OpenCode Zen (`opencode-zen`)
OpenCode Zen (`opencode-zen`) is a subscription service providing access to multi-vendor AI models (Anthropic Claude, DeepSeek, MiniMax, Gemini, etc.) routed through unified proxy endpoints at `https://opencode.ai/zen`. Requests are dispatched dynamically across multiple underlying transport APIs—primarily "Anthropic Messages" (`/zen`), "OpenAI Chat Completions" (`/zen/v1`), "OpenAI Responses" (`/zen/v1`), and "Google Generative AI" (`/zen/v1`)—based on catalog resolution rules, with `claude-opus-5` designated as its default model.

### Special casings

Provider-specific overrides in `packages/catalog/src/compat/rules/providers/opencode-zen.kdl` (more-specific selectors override provider defaults):

- For class anthropic; revision >=4.0.0 <4.6.0: `thinking.efforts=["minimal","low","medium","high","xhigh"]`.
- For class deepseek: `thinking.mode="effort"`.
- For class glm: `thinking.mode="effort"`.
- For class kimi: `thinking.mode="effort"`.
- For class meta; family muse-spark: `includeEncryptedReasoning=false`, `filterReasoningHistory=true`.
- For class mimo; family v2: `thinking.mode="effort"`.
- For class minimax; family m3: `thinking.mode="effort"`.
- For class openai; revision >=5.0.0 <5.7.0: `thinking.mode="effort"`.
- For class unknown: `thinking.mode="effort"`.
- For class xai; family grok: `thinking.mode="effort"`.
- For models *plus: `thinking.efforts=["minimal","low","medium","high","xhigh"]`, `thinking.mode="budget"`.
- For models big-pickle: `thinking.efforts=["high","max"]`.
- For models glm-4*, hy*, ling-3*, nemotron*, glm-5, glm-5.1, laguna-s-2.1-free, longcat-2.0-free, north-mini-code-free, ring-2.6-1t-free: `thinking.efforts=["minimal","low","medium","high","xhigh"]`.
- For models glm-5.2: `thinking.efforts=["minimal","low","medium","high","max"]`.
- For models gpt-5.1-codex, gpt-5.1-codex-max: `thinking.efforts=["minimal","low","medium","high"]`.
- For models gpt-5.1-codex-mini: `thinking.efforts=["medium","high"]`.
- For models minimax-m2.1, minimax-m2.5, minimax-m2.7: `thinking.mode="effort"`.
- For models ox-alpha*, x-preview-f-free: `thinking.efforts=["low","high","max"]`, `thinking.requiresEffort=true`.
- For models minimax-m2.5-free: `thinking.effortMap={"low":"adaptive","medium":"adaptive","high":"adaptive"}`, `thinking.mode="anthropic-adaptive"`.
- For models qwen3.6-plus-free: `thinking.efforts=["minimal","low","medium","high"]`, `thinking.mode="effort"`.
- Provider defaults: `whenThinking={"requiresReasoningContentForToolCalls":true,"allowsSyntheticReasoningContentForToolCalls":false,"reasoningContentField":"reasoning_content"}`, `supportsContextManagement=false`.

- **Multi-API Resolution & Endpoint Wiring**: `createOpenCodeApiResolution` in `packages/catalog/src/provider-models/openai-compat.ts` resolves model transport targets via `@ai-sdk/*` npm metadata. `OPENCODE_ZEN_API_RESOLUTION` defines per-id overrides mapping `"minimax-m3"` and `"minimax-m3-free"` to `"openai-completions"` at `https://opencode.ai/zen/v1`, overriding upstream `@ai-sdk/anthropic` tags that lead to HTTP 400 errors or raw `<invoke>`/`<|minimax|>`/`<tool_call>` markup leaks (#1617).
- **Anthropic Proxy Header & Beta Handling**: In `packages/ai/src/providers/anthropic.ts`, `opencode-zen` deletes default `Authorization` headers (`delete defaultHeaders.Authorization`) and supplies `apiKey` to emit `X-Api-Key` headers. Thinking requests on `opencode-zen` suppress the `context_management_20251015` beta header and body field (`context_management`) because the Zen Anthropic proxy rejects unrecognized fields with `400 Extra inputs are not permitted` (#6510).

### Auth & usage
- **Interactive CLI Login Flow**: Declared in `packages/catalog/src/compat/rules/auth/opencode-zen.kdl` as a `login "api-key"` rule (`packages/ai/src/registry/engine/api-key.ts`): it opens `https://opencode.ai/auth` in the browser and prompts the user to paste their API key.
- **Wire Authentication**: Credentials across both Anthropic and OpenAI-compatible protocol endpoints are passed via `X-Api-Key` headers rather than standard Bearer tokens.

### Catalog model handling
- **Provider entry (`opencode-zen`)**: `packages/catalog/src/compat/rules/providers/opencode-zen.kdl` declares default model `claude-opus-5`. Environment keys: `OPENCODE_API_KEY`.
- **Discovery replacement**: Successful authoritative discovery replaces fallback provider rows rather than retaining retired seed models.
- **Dynamic Discovery & Base URL Normalization**: `opencodeZenModelManagerOptions` invokes `openCodeModelManagerOptions("opencode-zen", config)`, fetching dynamic OpenAI-compatible models from `https://opencode.ai/zen/v1/models` (`discoveryBaseUrl`). Models are mapped to positive `contextWindow` (`context_length`) and `maxTokens` (`max_completion_tokens`), with base URLs normalized per API type (`openCodeBaseUrlForApi` / `normalizeOpenCodeBasePath`).
- **Zen vs Go Differences**:
  - **Base URL Root**: Zen uses base path `https://opencode.ai/zen` (completions at `/zen/v1`), whereas OpenCode Go (`opencode-go`) targets `https://opencode.ai/zen/go` (completions at `/zen/go/v1`).
  - **Default Models**: Zen defaults to `claude-opus-5`; Go defaults to `kimi-k2.7-code`.
  - **API Resolution Overrides**: Zen (`OPENCODE_ZEN_API_RESOLUTION`) overrides `"minimax-m3"` and `"minimax-m3-free"` to `"openai-completions"`. Go (`OPENCODE_GO_API_RESOLUTION`) overrides `"minimax-m2.7"`, `"minimax-m3"`, `"minimax-m3-free"`, `"qwen3.5-plus"`, and `"qwen3.6-plus"` to `"openai-completions"` to prevent gateway 404s or XML markup leaks (#887, #1617).
  - **Model Aliasing**: Zen includes the `big-pickle` alias (DeepSeek reasoning), which is uniquely detected through the reviewed taxonomy override for DeepSeek compat policy application.

## OpenRouter (`openrouter`)
OpenRouter is a unified multi-provider routing gateway serving hundreds of third-party models over OpenAI-compatible interfaces. Requests execute using the pseudo-API `openrouter`, dispatching by default to the OpenAI Responses transport or falling back to OpenAI Chat Completions based on environment configuration.

### Special casings

Provider-specific overrides in `packages/catalog/src/compat/rules/providers/openrouter.kdl` (more-specific selectors override provider defaults):

- For class anthropic: `retryWithoutStrictOnGrammarError=true`.
- For class meta; family muse-spark: `filterReasoningHistory=true`, `allowsSyntheticReasoningContentForToolCalls=false`.
- For class minimax; family m3: `thinking.efforts=["minimal","low","medium","high"]`.
- For class openai; family o-series: `thinking.efforts=["minimal","low","medium","high"]`.
- For class stepfun; family step: `thinking.efforts=["minimal","low","medium","high"]`.
- For class unknown: `thinking.efforts=["minimal","low","medium","high"]`.
- For models *thinking-2507, *thinking:free, arcee-ai/trinity-large-thinking, nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free: `thinking.requiresEffort=true`.
- For models deepseek/deepseek-chat-v3.1, deepseek/deepseek-v4-pro: `thinking.efforts=["high"]`.
- For models openai/gpt-5.1-codex-mini: `thinking.efforts=["medium","high"]`.
- For models openai/o1:batch, openai/o3:batch: `thinking.efforts=["minimal","low","medium","high"]`, `thinking.requiresEffort=true`.
- For models qwen/qwen3-coder: `thinkingFormat="openrouter"`.
- For models z*5, z-ai/glm-4.6*, z-ai/glm-4.7*, amazon/nova-2-lite-v1, baidu/ernie-4.5-vl-28b-a3b, cohere/north-mini-code:free, minimax/minimax-m1, nvidia/llama-3.3-nemotron-super-49b-v1.5, openai/gpt-5.1-codex, openai/gpt-5.1-codex-max, openai/gpt-chat-latest, z-ai/glm-4.5v, z-ai/glm-5.1: `thinking.efforts=["minimal","low","medium","high"]`.
- For models z-ai/glm-5.2*: `thinking.efforts=["minimal","low","medium","high","xhigh"]`.
- Provider defaults: `wireModelIdMode="openrouter"`, `supportsStrictMode=true`, `thinkingFormat="openrouter"`, `thinking.mode="effort"`.

- **Routing Variant Transformation (`:nitro` / `:floor`)**: Options specifying `openrouterVariant` (`"nitro"`, `"floor"`, `"online"`, `"exacto"`, `"extended"`) map through `applyOpenRouterRoutingVariant` (`packages/ai/src/providers/openai-shared.ts`). The variant suffix (`:<variant>`) is appended to `model.id` at request time unless a colon already exists after the final slash (`lastColon > lastSlash`), preserving explicit user or catalog variant overrides.
- **Provider Order & Exclusion Preferences**: `applyOpenAIGatewayRouting` in `packages/ai/src/providers/openai-shared.ts` injects catalog `openRouterRouting` preferences (`OpenRouterRouting` interface with `only?: string[]` and `order?: string[]`) into the top-level `provider` request parameter when `compat.isOpenRouterHost` is true.
- **Anthropic `cache_control` Breakpoints**: The resolved compat field `cacheControlFormat === "anthropic"` (baseline: OpenRouter host + Anthropic model class) selects the Anthropic cache-marker dialect. On the Chat Completions wire, `applyOpenAIChatCompletionsPromptCachePolicy` (`openai-completions.ts`) attaches `cache_control: { type: "ephemeral" }` to the last non-empty text part of the latest message. On the Responses wire, `applyOpenAIResponsesPromptCachePolicy` (`openai-responses.ts`) sets `params.cache_control = cacheRetention === "long" ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" }`.
- **Catalog Default Max-Tokens Omission**: `resolveOpenAIOutputTokenParam` in `packages/ai/src/providers/openai-shared.ts` omits default output token limits (`max_tokens`, `max_completion_tokens`, `max_output_tokens`) when `isOpenRouterHost` is true and `maxTokensExplicit` is false. This prevents OpenRouter from filtering out upstreams whose advertised output ceiling is below catalog maximums when executing `provider.order` / `only` fallbacks; explicitly specified caller `maxTokens` are retained.
- **Custom Request Headers**: `getOpenRouterHeaders` in `packages/ai/src/utils/openrouter-headers.ts` attaches `User-Agent: omp/<ver>`, `HTTP-Referer: https://omp.sh/`, `X-OpenRouter-Title: omp`, `X-OpenRouter-Categories: cli-agent`, `X-OpenRouter-Cache: true`, and `X-OpenRouter-Cache-TTL: 3600` to all requests for edge response caching.

### Auth & usage
- **Auth Key Validation via `/api/v1/auth/key`**: Declared in `packages/catalog/src/compat/rules/auth/openrouter.kdl` as a `login "oauth-code"` rule (`packages/ai/src/registry/engine/oauth-code.ts`) with `paste-key` validation targeted at `https://openrouter.ai/api/v1/auth/key`. Public `/api/v1/models` returns HTTP 200 for unauthenticated requests, so `/api/v1/auth/key` is used as the canonical identity check (returning 200 for valid keys, 401 otherwise). Key resolution checks `OPENROUTER_API_KEY` via `getEnvApiKey` in `packages/ai/src/stream.ts`.
- **Authoritative Reported Cost Reconciling**: `applyProviderReportedCost` in `packages/ai/src/providers/openai-shared.ts` extracts `rawUsage.cost` echoed by OpenRouter and ClinePass. If estimated token cost is finite and positive, input, output, cache-read, and cache-write costs are scaled by `reportedCost / estimatedCost` to match the exact billable total; otherwise, `usage.cost.input` is assigned the reported cost directly.

### Catalog model handling
- **Provider entry (`openrouter`)**: `packages/catalog/src/compat/rules/providers/openrouter.kdl` declares default model `openai/gpt-5.5`. Environment keys: `OPENROUTER_API_KEY`.
- **Authored seeds**: `~typesafe/jev-latest`, `openai/whisper-1`, `openai/whisper-large-v3`, `openai/gpt-4o-transcribe`, `microsoft/mai-transcribe-1.5`, `microsoft/mai-transcribe-2`, `cohere/rerank-v3.5`, `openai/text-embedding-3-small`, `qwen/qwen3-embedding-8b`, `google/veo-3.1`, `minimax/hailuo-3`, `alibaba/wan-2.7`; bundle policy `always`. Limits, capabilities, and prices are authored alongside these rows.
- **Dynamic Discovery & Filter**: `openrouterModelManagerOptions` in `packages/catalog/src/provider-models/openai-compat.ts` queries `https://openrouter.ai/api/v1/models` using `fetchOpenAICompatibleModels` with `api: "openrouter"`. Cache entries are partitioned under `resolveModelCacheProviderId("openrouter")`. Discovered models are filtered to entries specifying `supported_parameters.includes("tools")`.
- **Spec Mapping**: `openrouterModelManagerOptions` maps `modality` (`text`/`image`), pricing per million tokens (`prompt`, `completion`, `input_cache_read`, `input_cache_write`), `context_length`, `top_provider.max_completion_tokens`, and reasoning effort ladders via `mapOpenRouterThinking`.

## Qianfan (`qianfan`)
Qianfan (Baidu Cloud) provides access to Baidu's hosted model family via an OpenAI-compatible v2 API using the OpenAI Chat Completions transport. Entry points include `packages/catalog/src/compat/rules/auth/qianfan.kdl` for auth policy and API key authentication, `packages/catalog/src/compat/rules/providers/qianfan.kdl` (compiled provider entry) for catalog registration, and `packages/catalog/src/provider-models/openai-compat.ts` (`qianfanModelManagerOptions`) for model manager options.

### Special casings
- Nothing beyond the OpenAI Chat Completions pipeline.

### Auth & usage
- **API Key Authentication & Validation**: Authenticates via `QIANFAN_API_KEY` or stored credentials using API keys with format `bce-v3/ALTAK-...` obtained from `https://console.bce.baidu.com/qianfan/ais/console/apiKey`. The CLI login flow is declared in `packages/catalog/src/compat/rules/auth/qianfan.kdl` as a `login "api-key"` rule (`packages/ai/src/registry/engine/api-key.ts`), validating credentials by issuing a chat completion request (`validate "chat-completions"`) to `https://qianfan.baidubce.com/v2` with `deepseek-v3.2`.
- **Usage & Quotas**: Standard OpenAI Chat Completions token usage tracking (`input`, `output`, `reasoning`) and HTTP status code error handling apply.

### Catalog model handling
- **Provider entry (`qianfan`)**: `packages/catalog/src/compat/rules/providers/qianfan.kdl` declares default model `deepseek-v3.2`. Environment keys: `QIANFAN_API_KEY`.
- **Model Options**: `qianfanModelManagerOptions` (`packages/catalog/src/provider-models/openai-compat.ts`) constructs `openai-completions` options bound to `https://qianfan.baidubce.com/v2` via `createSimpleOpenAICompletionsOptions`.
- **Bundled Models**: Static model specifications in `packages/catalog/src/models.json` define Qianfan models (e.g. `deepseek-v3.2` with `reasoning: true` and `baseUrl: "https://qianfan.baidubce.com/v2"`).

## Qwen Portal (`qwen-portal`)
Qwen Portal provides access to Qwen hosted models via an OpenAI-compatible endpoint at `https://portal.qwen.ai/v1`. It uses the OpenAI Chat Completions transport for model execution and tool calling.

### Special casings
- **System message restriction**: Host matching (`qwenPortal` in `packages/catalog/src/hosts.ts`, matching `portal.qwen.ai`) sets `supportsMultipleSystemMessagesDefault = false` (`packages/catalog/src/compat/resolve.ts`). This forces multi-system message blocks to be coalesced into a single block to prevent 500 internal server errors triggered by the default Qwen chat template.

### Auth & usage
- **Environment variables**: Automatically resolves credentials from `QWEN_OAUTH_TOKEN` or `QWEN_PORTAL_API_KEY` (`packages/catalog/src/compat/rules/providers/qwen-portal.kdl:385`).
- **Interactive login**: Declared in `packages/catalog/src/compat/rules/auth/qwen-portal.kdl` as a `login "api-key"` rule (`packages/ai/src/registry/engine/api-key.ts`), guiding users to copy a token or API key from `https://chat.qwen.ai` and prompting for input.
- **Credential validation**: Validates input tokens against `https://portal.qwen.ai/v1` using `validate "chat-completions"` in `packages/catalog/src/compat/rules/auth/qwen-portal.kdl` targeting the `coder-model`.
- **Usage tracking**: No dedicated usage reporting module exists under `packages/ai/src/usage/`.

### Catalog model handling
- **Provider entry (`qwen-portal`)**: `packages/catalog/src/compat/rules/providers/qwen-portal.kdl` declares default model `coder-model`. Environment keys: `QWEN_OAUTH_TOKEN`, `QWEN_PORTAL_API_KEY`.
- **Catalog configuration**: Registered in `descriptors.ts` with default model `coder-model`, discovery label `"Qwen Portal"`, and `oauthProvider: "qwen-portal"`.

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
  (configured in descriptor `packages/catalog/src/compat/rules/providers/sakana.kdl`).
- **Interactive Login**: Declared in `packages/catalog/src/compat/rules/auth/sakana.kdl` as a `login "api-key"` rule (`packages/ai/src/registry/engine/api-key.ts`), directing users
  to the Sakana AI console (`https://console.sakana.ai/api-keys`), validating credentials against `https://api.sakana.ai/v1/models`.

### Catalog model handling
- **Provider entry (`sakana`)**: `packages/catalog/src/compat/rules/providers/sakana.kdl` declares default model `fugu`. Environment keys: `SAKANA_API_KEY`, `FUGU_API_KEY`.
- **Discovery replacement**: Successful authoritative discovery replaces fallback provider rows rather than retaining retired seed models.
- **Authored seeds**: `fugu`, `fugu-ultra`, `fugu-ultra-20260615`; bundle policy `fallback`. Limits, capabilities, and prices are authored alongside these rows.
- **Dynamic Model Manager**: `sakanaModelManagerOptions` marks live `/models` discovery as authoritative
  (`dynamicModelsAuthoritative: true`) and purges stale cached model rows on seed changes via `dropCachedModelIdsOnStaticMismatch`.

## SiliconFlow (`siliconflow`)
SiliconFlow is a high-performance AI inference platform providing access to open-source models (such as DeepSeek and GLM). It uses the OpenAI Chat Completions transport (`https://api.siliconflow.com/v1` for global, `https://api.siliconflow.cn/v1` for China region).

### Special casings
- **Runtime Metadata Hydration & Fallbacks**: `loadSiliconFlowModelsDevReferences` queries models.dev with a 5,000ms timeout (`SILICONFLOW_MODELS_DEV_REFERENCE_TIMEOUT_MS`). Missing models fall back to canonical bundled specs (`resolveModelReference`) to infer context window, max tokens, and reasoning capabilities while excluding pricing.

### Auth & usage
- **API Key Login**: Authenticates via API key stored in `SILICONFLOW_API_KEY` (or `SILICONFLOW_CN_API_KEY` for `siliconflow-cn`). Interactively declared in `packages/catalog/src/compat/rules/auth/siliconflow.kdl` and `siliconflow-cn.kdl` as `login "api-key"` rules (`packages/ai/src/registry/engine/api-key.ts`).
- **Endpoint Validation**: Credentials are validated during login via a `models-endpoint` request to `https://api.siliconflow.com/v1/models` (`https://api.siliconflow.cn/v1/models`).
- **Console URLs**: Key creation instructions point to `https://cloud.siliconflow.com/account/ak` (`https://cloud.siliconflow.cn/account/ak` for China region).

### Catalog model handling
- **Provider entry (`siliconflow`)**: `packages/catalog/src/compat/rules/providers/siliconflow.kdl` declares default model `zai-org/GLM-5.1`. Environment keys: `SILICONFLOW_API_KEY`.
- **Discovery replacement**: Successful authoritative discovery replaces fallback provider rows rather than retaining retired seed models.
- **Manager Construction**: `siliconflowModelManagerOptions` and `siliconflowCnModelManagerOptions` in `packages/catalog/src/provider-models/openai-compat.ts` construct dynamic OpenAI-compatible model managers via `createSiliconFlowModelManagerOptions`.
- **Dynamic Model Discovery**: When an API key is available, `fetchDynamicModels` calls `fetchOpenAICompatibleModels` to fetch live models from `/v1/models`, joining models.dev pricing/limits (`mapWithBundledReference`) or canonical fallback references.

## SiliconFlow (China) (`siliconflow-cn`)
SiliconFlow (China) is the domestic China deployment of SiliconFlow's AI model platform, offering OpenAI-compatible LLM inference for open-weight models tailored for regional availability. It uses the OpenAI Chat Completions transport (`openai-completions`) with base URL `https://api.siliconflow.cn/v1`.

### Special casings
- **Endpoint Differences**: Uses `https://api.siliconflow.cn/v1` for model endpoints in `siliconflowCnModelManagerOptions` (`packages/catalog/src/provider-models/openai-compat.ts`), distinct from global `siliconflow` (`https://api.siliconflow.com/v1`).
- **Non-Chat Model Filtering**: Model discovery excludes non-chat model IDs (embedding, reranker, image, TTS, audio, and video models containing tokens such as `bge-`, `bce-`, `stable-diffusion`, `flux`, `kolors`, `sensevoice`, `cosyvoice`, `fish-speech`, `wan2`, etc.) via `isLikelySiliconFlowChatModelId` in `packages/catalog/src/provider-models/openai-compat.ts`.
- **Bundled Upstream Reference Fallback**: Models absent from models.dev recover intrinsic capabilities (`reasoning`, `input`), context window, and max output tokens from bundled upstream model reference definitions (`getBundledModelReferenceIndex`), while provider-specific pricing is omitted.

### Auth & usage
- **Environment Variable**: Authenticates via `SILICONFLOW_CN_API_KEY` configured in descriptor `envVars` (`packages/catalog/src/compat/rules/providers/siliconflow-cn.kdl`), separate from global `SILICONFLOW_API_KEY`.
- **API Key Login**: Declared in `packages/catalog/src/compat/rules/auth/siliconflow-cn.kdl` as a `login "api-key"` rule (`packages/ai/src/registry/engine/api-key.ts`) with management console URL `https://cloud.siliconflow.cn/account/ak` and validation endpoint `https://api.siliconflow.cn/v1/models`.
- **No Usage Tracking**: No dedicated quota or usage resolution module is present under `packages/ai/src/usage/`.

### Catalog model handling
- **Provider entry (`siliconflow-cn`)**: `packages/catalog/src/compat/rules/providers/siliconflow-cn.kdl` declares default model `deepseek-ai/DeepSeek-V4-Pro`. Environment keys: `SILICONFLOW_CN_API_KEY`.
- **Discovery replacement**: Successful authoritative discovery replaces fallback provider rows rather than retaining retired seed models.
- **Dynamic-Only Model Discovery**: Deliberately omitted from `MODELS_DEV_PROVIDER_DESCRIPTORS` and static catalog generation (`scripts/generate-models.ts`), fetching available chat models live from `https://api.siliconflow.cn/v1/models`.
- **Runtime Reference Hydration**: Live discovered models are cross-referenced with models.dev catalog entries (`SILICONFLOW_MODELS_DEV_DESCRIPTORS`) with a 5-second timeout (`SILICONFLOW_MODELS_DEV_REFERENCE_TIMEOUT_MS`) in `loadSiliconFlowModelsDevReferences` (`packages/catalog/src/provider-models/openai-compat.ts`) to hydrate pricing and limit metadata.

## StepFun (`stepfun`)
StepFun is the OpenAI-compatible Open Platform endpoint at `https://api.stepfun.ai/v1` serving StepFun's own chat models (`step-5-preview`, `step-3.7-flash`, `step-3.5-flash`, `step-3.5-flash-2603`). It uses the OpenAI Chat Completions transport (`openai-completions`). StepFun's China deployment (`api.stepfun.com`) and Step Plan subscription endpoints (`/step_plan/v1`) are separate deployments whose API keys are not interchangeable with `.ai` keys.

### Special casings
- **`max_tokens` Only**: The provider rule sets `max-tokens-field "max_tokens"` in `packages/catalog/src/compat/rules/providers/stepfun.kdl`. StepFun documents `max_tokens` (default `INF`) and never the `max_completion_tokens` spelling the OpenAI baseline assumes, which the endpoint silently ignores — output budgets would go unlimited.
- **Provider-Owned Effort Ladder**: The same rule file assigns `thinking-mode "effort"` and `thinking-efforts "low" "medium" "high"` for the `stepfun` class/`step` family. The census ladder for this class spans `minimal`…`xhigh` because relay hosts (OpenRouter, NanoGPT, NVIDIA, ZenMux) advertise those tiers; StepFun's own API rejects them, so the provider scope overrides the relay default.
- **`reasoning_content` Reasoning Field**: Reasoning streams arrive as `reasoning_content` deltas (StepFun's `reasoning_format: "general"` default returns a `reasoning` field, and both are parsed), handled by the generic dispatch in `packages/ai/src/providers/openai-completions.ts`.
- **Non-Chat Roster Filtering**: `/v1/models` interleaves StepAudio (ASR/TTS/realtime/gen) and image-generation SKUs with the chat models. `isStepfunChatModelId` in `packages/catalog/src/provider-models/openai-compat.ts` drops them using the `exclude-models provider="stepfun"` policy in `packages/catalog/src/compat/rules/runtime/behavior.kdl`.
- **No Cross-Host Limit Backfill**: The provider entry sets `skip-cross-provider-reference-fills #true` so the generator never copies relay-host output ceilings (e.g. the 256K figures on NanoGPT/Hugging Face rows) onto first-party rows where StepFun publishes no cap.

### Auth & usage
- **Environment Variable**: Authenticates via `STEPFUN_API_KEY` (provider entry in `packages/catalog/src/compat/rules/providers/stepfun.kdl`). Keys are region-scoped: `.ai` keys work against `api.stepfun.ai`, `.com` keys against `api.stepfun.com`.
- **API Key Login**: Declared in `packages/catalog/src/compat/rules/auth/stepfun.kdl` as a `login "api-key"` rule (`packages/ai/src/registry/engine/api-key.ts`) with console URL `https://platform.stepfun.ai/interface-key` and chat-completions validation model `step-5-preview`.
- **No Usage Tracking**: No dedicated quota or usage resolution module is present under `packages/ai/src/usage/`; prompt caching is billed by StepFun as the cache-miss input rate, so rows carry `cacheWrite: 0`.

### Catalog model handling
- **Provider entry (`stepfun`)**: `packages/catalog/src/compat/rules/providers/stepfun.kdl` declares default model `step-5-preview`. Environment keys: `STEPFUN_API_KEY`.
- **Discovery replacement**: Successful authoritative discovery replaces fallback provider rows rather than retaining retired seed models.
- **Authored seeds**: `step-5-preview`, `step-3.7-flash`, `step-3.5-flash`, `step-3.5-flash-2603`; bundle policy `always`. Limits, capabilities, and prices are authored alongside these rows.
- **Live Discovery**: `stepfunModelManagerOptions` in `packages/catalog/src/provider-models/openai-compat.ts` treats a successful `/v1/models` snapshot as authoritative (`dynamicModelsAuthoritative`): it replaces the seed rows, hydrated by `mapWithBundledReference`, so retired models leave the picker and models StepFun ships later become selectable without an omp release.

## Synthetic (`synthetic`)
Synthetic is an AI platform offering dual API format support for its models, exposing both OpenAI-compatible (`https://api.synthetic.new/openai/v1/chat/completions`) and Anthropic-compatible (`https://api.synthetic.new/anthropic/v1/messages`) endpoints. Calls default to the `OpenAI Chat Completions` transport, but can switch dynamically to the `Anthropic Messages` transport when configured.

### Special casings
- **Dual API Surface**: `streamSynthetic` (`packages/ai/src/providers/synthetic.ts`) utilizes `streamOpenAIAnthropicShim` (`packages/ai/src/providers/openai-anthropic-shim.ts`) to wrap both OpenAI completions and Anthropic messages endpoints. The API format is selectable via the request's `syntheticApiFormat` option (`"openai"` | `"anthropic"`), defaulting to `"openai"`.
- **Dispatch**: `streamSimple` routes Synthetic through `streamSynthetic`, which delegates API-format conversion to `streamOpenAIAnthropicShim`.
- **Dynamic Reasoning & Features**: In `packages/catalog/src/provider-models/openai-compat.ts`, `syntheticModelManagerOptions` maps dynamic model entries from `GET /openai/v1/models`. It checks `supported_features` for `"reasoning"` and parses wire effort tiers (e.g. `reasoning_parameters.efforts`) to construct `thinking` options and set the `reasoning` flag appropriately.

### Auth & usage
- **Authentication**: Key-based auth using `SYNTHETIC_API_KEY` (`packages/catalog/src/compat/rules/auth/synthetic.kdl`). Validated via a `login "api-key"` rule (`packages/ai/src/registry/engine/api-key.ts`) against `GET https://api.synthetic.new/openai/v1/models`.
- **Usage & Quota Polling**: `syntheticUsageProvider` (`packages/ai/src/usage/synthetic.ts`) polls `GET https://api.synthetic.new/v2/quotas` with the bearer API key. It reports two distinct limit windows:
  - `synthetic:requests:5h`: Rolling 5-hour request limit with per-tick regeneration percentage (`rollingFiveHourLimit`).
  - `synthetic:usd:7d`: Weekly credit limit in USD (`weeklyTokenLimit`) with per-tick dollar regeneration rates.

### Catalog model handling
- **Provider entry (`synthetic`)**: `packages/catalog/src/compat/rules/providers/synthetic.kdl` declares default model `hf:zai-org/GLM-5.3-Flash`. Environment keys: `SYNTHETIC_API_KEY`.
- **Discovery replacement**: Successful authoritative discovery replaces fallback provider rows rather than retaining retired seed models.
- Default model: `hf:zai-org/GLM-5.3-Flash` (`packages/catalog/src/compat/rules/providers/synthetic.kdl`).
- `dynamicModelsAuthoritative: true`: Models are fetched dynamically via `syntheticModelManagerOptions` (`packages/catalog/src/provider-models/openai-compat.ts`).
- Modalities and Vision: `input` modalities (`"text"`, `"image"`) are dynamically resolved from `input_modalities`, `supports_vision`, or fallback reference specs.
- Capabilities Filter: `supported_features` strictly bounds tool support; if present without `"tools"`, tool calling is disabled for that model.

## Together (`together`)
Together is a cloud inference provider offering access to various open-source and proprietary foundation models via an OpenAI Chat Completions-compatible API.

### Special casings

Provider-specific overrides in `packages/catalog/src/compat/rules/providers/together.kdl` (more-specific selectors override provider defaults):

- For class unknown: `thinking.efforts=["minimal","low","medium","high","xhigh"]`.
- For models deepseek-ai/DeepSeek-V3-1: `requiresReasoningContentForAllAssistantTurns=true`.
- For models zai-org/GLM-4.7, zai-org/GLM-5, zai-org/GLM-5.1: `thinking.efforts=["minimal","low","medium","high","xhigh"]`.
- For models zai-org/GLM-5.2: `thinking.efforts=["minimal","low","medium","high","max"]`.
- Provider defaults: `supportsStrictMode=true`, `thinking.mode="effort"`.


### Auth & usage
- **API Key Auth**: Authenticates using the `TOGETHER_API_KEY` environment variable or API key input during `pi-ai login together`.
- **Validation**: Validates keys in `packages/catalog/src/compat/rules/auth/together.kdl` as a `login "api-key"` rule (`packages/ai/src/registry/engine/api-key.ts`) against `https://api.together.xyz/v1/models`.
- **API Base URL**: `https://api.together.xyz/v1`.

### Catalog model handling
- **Provider entry (`together`)**: `packages/catalog/src/compat/rules/providers/together.kdl` declares default model `moonshotai/Kimi-K2.7-Code`. Environment keys: `TOGETHER_API_KEY`.
- **Catalog Source**: Models generated via `models.dev` descriptor using key `togetherai` mapping to provider `together` at `https://api.together.xyz/v1` (`packages/catalog/src/provider-models/openai-compat.ts`).
- **Host Matching**: Listed in `packages/catalog/src/hosts.ts` matching host URL markers `api.together.xyz` and registered in `priority.ts` identity mapping.

## Umans AI Coding Plan (`umans`)
Umans AI Coding Plan is a proxy service for AI coding models, operating via the Anthropic Messages wire format ("Anthropic Messages") with its default base URL set to `https://api.code.umans.ai`.

### Special casings
- **Auth header strategy**: Anthropic-compatible Umans requests force `X-Api-Key` header authentication (declared in `packages/catalog/src/compat/rules/auth/umans.kdl`) instead of `Authorization: Bearer` (`buildAnthropicClientOptions` in `packages/ai/src/providers/anthropic.ts`).
- **Tool name escaping**: Configured with `compat.escapeBuiltinToolNames: true` (`packages/catalog/src/compat/anthropic.ts`) to prefix client tool names with `_` on outbound requests and strip them on return, avoiding collision with gateway built-in tool names unless gateway web search is active (`packages/ai/src/providers/anthropic.ts`).
- **Gateway web search**: Routes web search requests by inspecting `X-Umans-Websearch-Provider` caller headers or the `UMANS_WEBSEARCH_PROVIDER` (`native` | `exa`) environment variable (`packages/ai/src/providers/anthropic.ts`). When enabled, `web_search` tool names pass through unescaped.
- **Thinking / reasoning effort**: Supports thinking configurations with levels mapped via `UMANS_REASONING_EFFORT_BY_LEVEL` (`packages/catalog/src/provider-models/openai-compat.ts`). GLM-5.2 on Umans uses a two-tier high/max effort scale where `max` maps to the `anthropic-budget-effort` mode (`xhigh` effort) (`packages/catalog/src/model-thinking.ts`).

### Auth & usage
- **Auth**: Uses `UMANS_AI_CODING_PLAN_API_KEY` environment variable or `/login umans` key prompt (`packages/catalog/src/compat/rules/auth/umans.kdl`, `packages/ai/src/registry/engine/api-key.ts`). Key validation executes a lightweight Anthropic messages call (`max_tokens: 1`) to `https://api.code.umans.ai`.
- **Usage endpoint**: Fetches quota and rate limit status from `GET /v1/usage` (`packages/ai/src/usage/umans.ts`) using `Authorization: Bearer <key>`.
- **Limits surfaced**: Returns a rolling 5-hour request split into a model-weighted soft cap (`umans:requests:soft`, the "effective requests" contract) and a raw burst ceiling (`umans:requests:hard`, `hard_cap`), plus an instantaneous session concurrency limit (`umans:concurrency`). The soft cap only ever warns — `exhausted` is reserved for the burst ceiling, where throttling actually starts. Payloads without a reported burst ceiling (`hard_cap`) collapse to a single weighted `umans:requests` row that can exhaust at the effective-request limit, so request exhaustion is never unreportable; legacy payloads without weighted counters fall back to a single raw `umans:requests` row. In both single-row shapes the weighted counter (when present) stays authoritative — raw burst traffic above the limit never fabricates an exhausted state. Also surfaces low-priority status notes when rate-limit bursts occur.

### Catalog model handling
- **Provider entry (`umans`)**: `packages/catalog/src/compat/rules/providers/umans.kdl` declares default model `umans-coder`. Environment keys: `UMANS_AI_CODING_PLAN_API_KEY`.
- **Discovery replacement**: Successful authoritative discovery replaces fallback provider rows rather than retaining retired seed models.
- **Vision capability filtering**: `umansSupportsVision` strictly checks for `supports_vision === true`. Sentinel string values (such as `"via-handoff"` for `umans-glm-5.1` and `umans-glm-5.2`) are mapped to text-only (`["text"]`) so image content is handled via client-side vision handoff rather than sending raw image blocks that cause HTTP 400 errors (`packages/catalog/src/provider-models/openai-compat.ts`).
- **Pricing & fallback**: Generates catalog entries with pricing fallback rules for pay-as-you-go and technical alias models like `umans-qwen3.6-35b-a3b` mapping to `umans-flash` (`packages/catalog/scripts/generate-models.ts`).

## Venice (`venice`)
Venice is a privacy-focused AI platform delivering uncensored and open-source models. It operates over the OpenAI Chat Completions transport (`api: "openai-completions"`) with default base URL `https://api.venice.ai/api/v1`.

### Special casings

Provider-specific overrides in `packages/catalog/src/compat/rules/providers/venice.kdl` (more-specific selectors override provider defaults):

- For class qwen: `thinkingFormat="openai"`.
- For class gemini; revision >=3.0.0 <3.1.0: `thinking.requiresEffort=true`.
- For class gemini; revision >=3.1.0 <3.8.0: `thinking.requiresEffort=false`, `thinking.efforts=["minimal","low","medium","high","xhigh"]`.
- For class unknown: `thinking.efforts=["minimal","low","medium","high","xhigh"]`.
- For models arcee-trinity-large-thinking: `thinking.requiresEffort=true`.
- For models deepseek-v4-flash*: `requiresReasoningContentForAllAssistantTurns=true`.
- For models gemini-3-flash-preview: `thinking.efforts=["minimal","low","medium","high"]`.
- For models gemini-3-pro-preview: `thinking.efforts=["low","high"]`.
- For models kimi-k2-thinking: `thinking.requiresEffort=true`.
- For models qwen3-235b: `thinkingFormat="qwen"`.
- Provider defaults: `reasoningDisableMode="venice-disable-thinking"`, `thinking.mode="effort"`.

- **Explicit Thinking Off**: `reasoningDisableMode: "venice-disable-thinking"` encodes an explicit off selection as `venice_parameters.disable_thinking: true`, preserving sibling Venice settings such as `include_venice_system_prompt`.

### Auth & usage
- **API Key Login & Validation**: Declared in `packages/catalog/src/compat/rules/auth/venice.kdl` as a `login "api-key"` rule (`packages/ai/src/registry/engine/api-key.ts`) to direct users to `https://venice.ai/settings/api` for API keys (`vapi_...` placeholder prefix) and validate credentials via a lightweight `chat-completions` request using validation model `qwen3-4b`. Registered in `packages/ai/src/registry/registry.ts`.
- **Usage Accounting**: Uses standard OpenAI Chat Completions usage accounting (`calculateOpenAIUsageAccounting` in `packages/ai/src/providers/openai-shared.ts`) without custom quota or usage endpoints.

### Catalog model handling
- **Provider entry (`venice`)**: `packages/catalog/src/compat/rules/providers/venice.kdl` declares default model `llama-3.3-70b`. Environment keys: `VENICE_API_KEY`.
- **Model Manager Options**: `veniceModelManagerOptions` in `packages/catalog/src/provider-models/openai-compat.ts` configures model management using `createOpenAICompatibleModelManagerOptions` over `https://api.venice.ai/api/v1`.
- **Streaming Usage Compat**: In `veniceModelManagerOptions` (`packages/catalog/src/provider-models/openai-compat.ts`), mapped models explicitly disable streaming usage payloads by setting `compat: { ...model.compat, supportsUsageInStreaming: false }`.
- **Kimi K2.7 Code Max Tokens Capping**: `clampKimiK27CodeMaxTokens` in `packages/catalog/src/provider-models/openai-compat.ts` (and `applyKimiMaxTokensCap` in `packages/catalog/scripts/generate-models.ts`) caps output tokens (`maxTokens`) for Kimi K2.7 Code models (`isKimiK27CodeModelId`) to `KIMI_K27_CODE_RECOMMENDED_MAX_TOKENS`.
- **Catalog Transformation**: `openAiCompletionsDescriptor` for Venice in `packages/catalog/src/provider-models/openai-compat.ts` applies `clampKimiK27CodeMaxTokens` during model catalog build and discovery transformations.

## Vercel AI Gateway (`vercel-ai-gateway`)
Vercel AI Gateway routes LLM requests through a unified proxy (`https://ai-gateway.vercel.sh`) to underlying upstream providers (such as Anthropic, OpenAI, or Bedrock). It operates across the Anthropic Messages (`anthropic-messages`), OpenAI Chat Completions (`openai-completions`), and OpenAI Responses (`openai-responses`) transport protocols depending on model configuration.

### Special casings
- **Host Detection**: `isVercelGatewayHost` is evaluated via `modelMatchesHost({ provider, baseUrl }, "vercelAIGateway")` (`packages/catalog/src/compat/resolve.ts`, `packages/catalog/src/hosts.ts`), matching `provider === "vercel-ai-gateway"
- **Translated strict tools**: Models served from a non-Anthropic upstream still ride the Anthropic Messages route, and the gateway applies Anthropic's structured-outputs `strict: true` to the upstream function tool. OpenAI strict mode additionally requires every `properties` key in `required`, which Anthropic's strict subset does not, so an allowlisted strict tool with optional parameters (`ANTHROPIC_STRICT_TOOL_ALLOWLIST` in `packages/ai/src/providers/anthropic.ts`) is rejected only after translation with `400 Invalid schema for function '<tool>': … 'required' is required to be supplied and to be an array including every key in properties`. `matchesStrictToolsRejection` (`packages/ai/src/error/flags.ts`) classifies that phrasing as `Flag.Grammar`, so `streamAnthropic` retries once without strict tools and pins `strictToolsDisabled` on the provider session.

## vLLM (Local OpenAI-compatible) (`vllm`)
vLLM is an open-source high-throughput LLM serving engine running local or self-hosted OpenAI-compatible inference servers. It uses the OpenAI Chat Completions transport over HTTP/SSE. Entry modules include `packages/catalog/src/compat/rules/auth/vllm.kdl` for authentication and credential handling, and `packages/catalog/src/provider-models/openai-compat.ts` (`vllmModelManagerOptions`) for catalog options and dynamic model discovery.

### Special casings

Provider-specific overrides in `packages/catalog/src/compat/rules/providers/vllm.kdl` (more-specific selectors override provider defaults):

- For class qwen: `thinkingFormat="qwen-chat-template"`.


### Auth & usage
- **Credential Resolution & Defaults**: Declared in `packages/catalog/src/compat/rules/auth/vllm.kdl` as a `login "api-key"` rule (`packages/ai/src/registry/engine/api-key.ts`). Reads optional API keys from the `VLLM_API_KEY` environment variable or credentials stored via `omp auth-broker login vllm`.
- **Unauthenticated Local Mode**: Defaults to base URL `http://127.0.0.1:8000/v1` and placeholder token `"vllm-local"` (`DEFAULT_LOCAL_TOKEN`) when no key is supplied (`emptyKeyFallback: "vllm-local"`). Descriptor settings specify `catalogDiscovery: { label: "vLLM", allowUnauthenticated: true }`.
- **Documentation & Endpoint Setup**: The login helper points to `https://docs.vllm.ai/en/latest/serving/openai_compatible_server.html` for configuring local vLLM OpenAI-compatible server endpoints.

### Catalog model handling
- **Provider entry (`vllm`)**: `packages/catalog/src/compat/rules/providers/vllm.kdl` declares default model `gpt-oss-20b`. Environment keys: `VLLM_API_KEY`.
- **Dynamic Model Discovery**: `vllmModelManagerOptions` (`packages/catalog/src/provider-models/openai-compat.ts`) invokes `fetchOpenAICompatibleModels` with `api: "openai-completions"`, `provider: "vllm"`, base URL `config?.baseUrl ?? getDefaultModelDiscoveryBaseUrl("vllm")!` (`http://127.0.0.1:8000/v1`), and a 10-second timeout (`VLLM_DISCOVERY_TIMEOUT_MS = 10_000`).
- **Context Window Extraction**: Custom `mapModel` in `vllmModelManagerOptions` extracts `contextWindow` from vLLM's non-standard `/v1/models` response field `entry.max_model_len` using `toPositiveNumber(entry.max_model_len, model.contextWindow)`.
- **Cache Provider ID**: Resolved by `resolveModelCacheProviderId("vllm", { baseUrl })` in `packages/catalog/src/provider-models/cache-provider-id.ts` (using `getDefaultModelDiscoveryBaseUrl("vllm")`), generating base-URL-hashed cache keys formatted as `vllm:${Bun.hash(baseUrl).toString(36)}`.

## Wafer Serverless (`wafer-serverless`)
Wafer Serverless is a pay-as-you-go provider proxying multiple upstream models (such as Zhipu GLM, Moonshot Kimi, Alibaba Qwen, and DeepSeek) through an OpenAI-compatible API at `https://pass.wafer.ai/v1`. It relies on the OpenAI Chat Completions transport (`openai-completions`).

### Special casings
- Upstream thinking parameter selection is configured dynamically via `resolveWaferServerlessThinkingFormat` (`packages/catalog/src/provider-models/openai-compat.ts`) based on the `wafer.provider` envelope hint:
  - Upstreams matching `zai`, `zhipu`, `moonshot`, or `kimi` set `thinkingFormat: "zai"`.
  - Upstreams matching `qwen`, `alibaba`, or `dashscope` set `thinkingFormat: "qwen"`.
  - Fallback without envelope hints uses GLM/Kimi taxonomy classification for `"zai"` (`packages/catalog/src/provider-models/openai-compat.ts`).
  - Static policies in `generated-policies.ts` apply `thinkingFormat: "zai"` for bundled GLM/Kimi models (`packages/catalog/scripts/generated-policies.ts`).
- All reasoning entries configure `reasoningContentField: "reasoning_content"` and set `supportsDeveloperRole: false` (`packages/catalog/src/provider-models/openai-compat.ts`).
- `wafer-pass` has been retired in favor of `wafer-serverless` (`packages/catalog/scripts/generate-models.ts`).

### Auth & usage
- Authenticates using Bearer API keys (`wfr_…` prefix) supplied via the `WAFER_SERVERLESS_API_KEY` environment variable (`packages/catalog/src/compat/rules/providers/wafer-serverless.kdl:465`).
- Interactive login is declared in `packages/catalog/src/compat/rules/auth/wafer-serverless.kdl` as a `login "api-key"` rule (`packages/ai/src/registry/engine/api-key.ts`), pointing users to `https://app.wafer.ai/usage`.
- Key validation probes `https://pass.wafer.ai/v1/models` (`validate "models-endpoint"` in `packages/catalog/src/compat/rules/auth/wafer-serverless.kdl`).

### Catalog model handling
- **Provider entry (`wafer-serverless`)**: `packages/catalog/src/compat/rules/providers/wafer-serverless.kdl` declares default model `GLM-5.1`. Environment keys: `WAFER_SERVERLESS_API_KEY`.
- Registered in provider descriptors with `defaultModel: "GLM-5.1"` and base URL `https://pass.wafer.ai/v1` (`packages/catalog/src/compat/rules/providers/wafer-serverless.kdl:463`).
- Dynamic catalog generation uses `waferServerlessModelManagerOptions` (`packages/catalog/src/provider-models/openai-compat.ts`) and parses the `/v1/models` response via `readWaferRecord` (`packages/catalog/src/provider-models/openai-compat.ts`).
- Map model capabilities from `wafer.capabilities`: `vision` enables `["text", "image"]` input, `reasoning` enables reasoning mode, and `tools` sets `supportsTools` (`packages/catalog/src/provider-models/openai-compat.ts`).
- Context window reads `wafer.context_length` (falling back to `max_model_len`), and `maxTokens` is capped at `65536` (`WAFER_MAX_TOKENS_CAP`, `packages/catalog/src/provider-models/openai-compat.ts`).
- Pricing converts internal wholesale units from `wafer.pricing` to USD/M tokens using `cents * 125 / 10000` (`cents * 0.0125`) (`packages/catalog/src/provider-models/openai-compat.ts`).
- Model IDs are preserved verbatim on the wire without case transformation (`packages/catalog/src/provider-models/openai-compat.ts`).

## xAI API (`xai`)
xAI API (`xai`) provides access to xAI's Grok model suite using standard API key authentication. It routes inference requests through the OpenAI Chat Completions transport (`https://api.x.ai/v1`), distinct from `xai-oauth` which uses OAuth bearer tokens and the OpenAI Responses transport.

### Special casings

Provider-specific overrides in `packages/catalog/src/compat/rules/providers/xai.kdl` (more-specific selectors override provider defaults):

- For class xai; family grok: `filterReasoningHistory=false`, `includeEncryptedReasoning=true`, `reasoningEffortMap={"minimal":"low","xhigh":"high","max":"high"}`, `supportsReasoningSummary=false`, `thinking.mode="effort"`.
- For models grok-3-mini*, grok-4.20-multi-agent*, grok-4.3*, grok-4.5*, grok-4.6*, grok-4.7*: `supportsReasoningEffort=true`, `omitReasoningEffort=false`.
- For models grok-4.20-multi-agent*, grok-4.6*, grok-4.7*: `reasoningEffortMap={"minimal":"low"}`.
- For models *reasoning, grok-build*, grok-code-fast*, *composer*: `omitReasoningEffort=true`, `supportsReasoningEffort=false`.
- For models grok-4.20-0309-reasoning, grok-4.20-beta-latest-reasoning: `thinking.requiresEffort=true`.
- Provider defaults: `promptCacheSessionHeader="x-grok-conv-id"`, `rejectRootObjectUnion=true`.


### Auth & usage
- **Authentication**: Key-based auth declared in `packages/catalog/src/compat/rules/auth/xai.kdl` as a `login "api-key"` rule (`packages/ai/src/registry/engine/api-key.ts`). Directs users to `"https://console.x.ai/team/default/api-keys"` with prompt `"Paste your xAI API key"` (placeholder `"xai-..."`).
- **Validation**: Performs credentials check via `models-endpoint` against `"https://api.x.ai/v1/models"` (`validate "models-endpoint"` in `packages/catalog/src/compat/rules/auth/xai.kdl`).
- **Environment Fallback**: Configured to resolve `XAI_API_KEY` (`packages/catalog/src/compat/rules/providers/xai.kdl` symbol `descriptors`).
- **Usage Tracking**: Nothing beyond the `OpenAI Chat Completions` pipeline.

### Catalog model handling
- **Provider entry (`xai`)**: `packages/catalog/src/compat/rules/providers/xai.kdl` declares default model `grok-4.6`. Environment keys: `XAI_API_KEY`.
- **Authored seeds**: `grok-tts`; bundle policy `always`. Limits, capabilities, and prices are authored alongside these rows.
- **Manager Options**: Constructed via `createSimpleOpenAICompletionsOptions("xai", "https://api.x.ai/v1", config)` (`packages/catalog/src/provider-models/openai-compat.ts` symbol `xaiModelManagerOptions`).
- **Completions Descriptor**: Registered with `openAiCompletionsDescriptor("xai", "xai", "https://api.x.ai/v1")` (`packages/catalog/src/provider-models/openai-compat.ts` symbol `openAiCompletionsDescriptor`), serving Grok models over the `openai-completions` API.

## xAI Grok OAuth (SuperGrok) (`xai-oauth`)
xAI Grok OAuth provides subscription-backed access (SuperGrok / X Premium+) to xAI Grok models over the OpenAI Responses transport (`api: "openai-responses"`, `baseUrl: "https://api.x.ai/v1"`). Authentication uses RFC 8628 device code flow against `https://auth.x.ai`, while usage tracking probes the dedicated SuperGrok CLI billing proxy.

### Special casings

Provider-specific overrides in `packages/catalog/src/compat/rules/providers/xai-oauth.kdl` (more-specific selectors override provider defaults):

- For class xai; family grok; revision >=0.1.0 <4.3.0: `omitReasoningEffort=true`.
- For class xai; family grok; revision >=4.3.0 <4.20.0: `omitReasoningEffort=false`, `supportsReasoningEffort=true`.
- For class xai; family grok: `filterReasoningHistory=false`, `includeEncryptedReasoning=true`, `reasoningEffortMap={"minimal":"low","xhigh":"high","max":"high"}`, `supportsImageDetailOriginal=false`, `supportsReasoningSummary=false`, `thinking.mode="effort"`.
- For models *reasoning, grok-build: `omitReasoningEffort=true`, `supportsReasoningEffort=false`.
- For models grok-4.6*, grok-4.7*, grok-4.20-multi-agent*: `reasoningEffortMap={"minimal":"low"}`.
- For models grok-4.20-multi-agent-0309: `omitReasoningEffort=false`, `supportsReasoningEffort=true`.
- Provider defaults: `promptCacheSessionHeader="x-grok-conv-id"`, `rejectRootObjectUnion=true`.


### Auth & usage
- **OAuth Authentication**: Declared in `packages/catalog/src/compat/rules/auth/xai-oauth.kdl` as a `login "device-code"` rule (`packages/ai/src/registry/engine/device-code.ts`) with token hook in `packages/ai/src/registry/oauth/xai-oauth.ts`. Executes RFC 8628 device authorization against `https://auth.x.ai` (client ID `b1a00492-073a-47ea-816f-4c329264a828`, scope `openid profile email offline_access grok-cli:access api:access`). Endpoint validation and identity helpers live in `packages/ai/src/registry/oauth/xai-oauth.ts` (`validateXAIEndpoint`, `fetchXAIOAuthIdentity`). Env fallbacks: `XAI_OAUTH_TOKEN` then `XAI_API_KEY` (`descriptors.ts`).
- **Usage Tracking**: `xaiOauthUsageProvider` (`packages/ai/src/usage/xai-oauth.ts`) queries `https://cli-chat-proxy.grok.com/v1/billing` (`validateXAIBillingEndpoint` pins to HTTPS `*.grok.com`) with header `X-XAI-Token-Auth: xai-grok-cli` (`getXAICliBillingHeaders`). Only accepts valid OAuth bearer credentials. Probes legacy weekly credits (`?format=credits`, `parseWeeklyBillingConfig` for `creditUsagePercent` and `productUsage`) and unified monthly quota (`parseMonthlyBillingConfig` for `monthlyLimit` and `used`), plus positive `onDemandCap` / `onDemandUsed` limits.

### Catalog model handling
- **Provider entry (`xai-oauth`)**: `packages/catalog/src/compat/rules/providers/xai-oauth.kdl` declares default model `grok-4.6`. Environment keys: `XAI_OAUTH_TOKEN`, `XAI_API_KEY`.
- **Authored seeds**: `grok-build`, `grok-build-0.1`, `grok-4.3`, `grok-4.5`, `grok-4.6`, `grok-4.7`, `grok-4.20-multi-agent-0309`, `grok-4.20-0309-reasoning`, `grok-4.20-0309-non-reasoning`, `grok-composer-2.5-fast`, `grok-tts`, `grok-imagine-image`; bundle policy `always`. Limits, capabilities, and prices are authored alongside these rows.
- **Dynamic Curation Overlay**: `applyXAIOAuthCuration` (`openai-compat.ts`, `xaiOAuthModelManagerOptions`) filters non-chat prefixes (`grok-imagine-`, `grok-stt-`, `grok-voice-`), overlays curated context windows (up to 2M), sets `maxTokens` equal to `contextWindow`, preserves image capabilities and reasoning flags, and injects missing curated models.

## Xiaomi MiMo (`xiaomi`)
Xiaomi MiMo delivers Xiaomi's proprietary MiMo model family (such as `mimo-v2.5` and `mimo-v2.5-pro`) over OpenAI-compatible endpoints. Requests execute over the OpenAI Chat Completions transport using standard pay-as-you-go base URLs (`https://api.xiaomimimo.com/v1`) or regional Token Plan base URLs (`https://token-plan-{sgp,ams,cn}.xiaomimimo.com/v1`).

### Special casings

Provider-specific overrides in `packages/catalog/src/compat/rules/providers/xiaomi.kdl` (more-specific selectors override provider defaults):

- For class mimo; family v2: `allowsSyntheticReasoningContentForToolCalls=false`, `reasoningContentField="reasoning_content"`, `requiresReasoningContentForToolCalls=true`, `supportsStore=false`, `thinkingFormat="zai"`, `thinking.mode="effort"`.
- For models mimo-v2.5: `allowsSyntheticReasoningContentForToolCalls=false`, `reasoningContentField="reasoning_content"`, `requiresReasoningContentForToolCalls=true`, `supportsStore=false`, `thinkingFormat="zai"`.

- **Reasoning Content Invariants**:
  - `requiresReasoningContentForToolCalls: true` (`packages/catalog/src/compat/resolve.ts`): MiMo models require exact `reasoning_content` replay on thinking-mode tool-call continuations across standard and Token Plan hosts.
  - `requiresReasoningContentForAllAssistantTurns: true` (`packages/catalog/src/compat/resolve.ts`): Enforces `reasoning_content` presence on all prior assistant turns during reasoning mode (except when routed via OpenRouter).
  - `allowsSyntheticReasoningContentForToolCalls: false` (`packages/catalog/src/compat/resolve.ts`): Rejects synthetic `reasoning_content` placeholders (e.g. `"."`) on tool-call turns.
- **Thinking Format & Effort Mapping**:
  - `thinkingFormat: "zai"` (`packages/catalog/src/compat/resolve.ts`): Formats thinking mode payloads using the z.ai binary `thinking` structure.
  - `supportsReasoningEffort: false` (`packages/catalog/src/compat/resolve.ts`): Suppresses standard `reasoning_effort` parameters.

### Stream behavior

### Auth & usage
- **Registry & Provider Definitions**: Primary provider is declared in `packages/catalog/src/compat/rules/auth/xiaomi.kdl`; regional Token Plan providers are declared in `packages/catalog/src/compat/rules/auth/xiaomi-token-plan-{ams,cn,sgp}.kdl`.
- **Interactive Key Prompts & Validation**: Standard Xiaomi login (`loginXiaomi` in `packages/ai/src/registry/oauth/xiaomi.ts`) prompts for standard (`sk-...`) or Token Plan (`tp-...`) API keys and validates them via `validateXiaomiApiKey`, while regional Token Plan providers use declarative `login "api-key"` rules in their respective `.kdl` files.
- **Token Plan Validation Fallback**: Standard `xiaomi` login with `tp-` keys falls back sequentially through SGP (`https://token-plan-sgp.xiaomimimo.com/v1`) → AMS (`https://token-plan-ams.xiaomimimo.com/v1`) → CN (`https://token-plan-cn.xiaomimimo.com/v1`), using fresh per-endpoint `AbortSignal.timeout(15_000)` signals so regional timeouts do not abort subsequent fallback endpoints. Regional `xiaomi-token-plan-*` logins validate against their specific cluster.
- **Environment Variables**: `XIAOMI_API_KEY` for standard `xiaomi`, and `XIAOMI_TOKEN_PLAN_AMS_API_KEY`, `XIAOMI_TOKEN_PLAN_CN_API_KEY`, `XIAOMI_TOKEN_PLAN_SGP_API_KEY` for regional Token Plan providers (`packages/catalog/src/compat/rules/providers/xiaomi.kdl`).

### Catalog model handling
- **Provider entry (`xiaomi`)**: `packages/catalog/src/compat/rules/providers/xiaomi.kdl` declares default model `mimo-v2.5`. Environment keys: `XIAOMI_API_KEY`.
- **Dynamic Model Discovery**: `xiaomiModelManagerOptions` in `packages/catalog/src/provider-models/openai-compat.ts` inspects keys (`tp-` vs `sk-`) and provider IDs to query standard or regional `/models` endpoints (`XIAOMI_TOKEN_PLAN_BASE_URLS`), preserving regional provider IDs on returned models.
- **Audio Model Filtering**: Speech and audio models are excluded from discovery and catalog generation (`!model.id.includes("-tts") && !model.id.includes("-asr")`) in `xiaomiModelManagerOptions` (`packages/catalog/src/provider-models/openai-compat.ts`) and `scripts/generate-models.ts`.
- **Host Matching**: `modelMatchesHost` (`packages/catalog/src/hosts.ts`) matches `xiaomi` provider IDs, `xiaomi-token-plan-` provider prefixes, and `xiaomimimo.com` URL markers to the `xiaomi` host class.

## Xiaomi Token Plan (Europe) (`xiaomi-token-plan-ams`)
Xiaomi Token Plan (Europe) (`xiaomi-token-plan-ams`) provides regional access to Xiaomi's MiMo model family (such as `mimo-v2.5` and `mimo-v2-omni`) via Xiaomi's European Token Plan gateway (`https://token-plan-ams.xiaomimimo.com/v1`). It uses the OpenAI Chat Completions transport (`api: "openai-completions"`). This regional provider allows CLI login (`omp login`) and dynamic model lookup to store and validate `tp-` API keys against the European cluster without falling back across regions.

### Special casings

Provider-specific overrides in `packages/catalog/src/compat/rules/providers/xiaomi-token-plan-ams.kdl` (more-specific selectors override provider defaults):

- For class mimo; family v2: `thinking.mode="effort"`.

- **TTS/ASR Model Filter**: Dynamic model manager options (`xiaomiModelManagerOptions` in `packages/catalog/src/provider-models/openai-compat.ts`) and model generation scripts (`scripts/generate-models.ts`) filter out audio models (`!model.id.includes("-tts") && !model.id.includes("-asr")`).
- **Provider ID Retention**: `xiaomiModelManagerOptions` (`packages/catalog/src/provider-models/openai-compat.ts`) explicitly sets `providerId: "xiaomi-token-plan-ams"` and maps dynamic discovery entries back to `provider: "xiaomi-token-plan-ams"` rather than collapsing them to generic `xiaomi`.

### Auth & usage
- **Registry Provider & Auth Policy**: Declared in `packages/catalog/src/compat/rules/auth/xiaomi-token-plan-ams.kdl` with ID `"xiaomi-token-plan-ams"` as a `login "api-key"` rule (`packages/ai/src/registry/engine/api-key.ts`).
- **Region Console Instructions**: Interactive CLI login declared in `packages/catalog/src/compat/rules/auth/xiaomi-token-plan-ams.kdl` prompts users for a `tp-` prefix API key and directs them to the Token Plan console URL (`https://platform.xiaomimimo.com/console/plan-manage`).
- **Single-Cluster Validation**: Validates keys directly against `https://token-plan-ams.xiaomimimo.com/v1` (using `mimo-v2.5` via `validate "chat-completions"` in `packages/catalog/src/compat/rules/auth/xiaomi-token-plan-ams.kdl`), bypassing the multi-region fallback sequence used by generic `loginXiaomi`.
- **Headers & Errors**: Requests pass standard `Authorization: Bearer tp-...` headers. Authentication or network failures throw `AIError.OAuthError` or `AIError.ApiKeyRequiredError`.

### Catalog model handling
- **Provider entry (`xiaomi-token-plan-ams`)**: `packages/catalog/src/compat/rules/providers/xiaomi-token-plan-ams.kdl` declares default model `mimo-v2.5`. Environment keys: `XIAOMI_TOKEN_PLAN_AMS_API_KEY`.
- **Dynamic Model Manager**: `xiaomiModelManagerOptions` (`packages/catalog/src/provider-models/openai-compat.ts`) maps `tokenPlanRegion: "ams"` to base URL `https://token-plan-ams.xiaomimimo.com/v1` for `fetchDynamicModels`, utilizing `createBundledReferenceMap("xiaomi")` for baseline specs.
- **Pre-packaged Catalog Models**: Bundled models (e.g. `mimo-v2-omni`, `mimo-v2.5`) are registered in `packages/catalog/src/models.json` under key `"xiaomi-token-plan-ams"`, setting `baseUrl: "https://token-plan-ams.xiaomimimo.com/v1"` with `api: "openai-completions"`.

## Xiaomi Token Plan (China) (`xiaomi-token-plan-cn`)
Xiaomi Token Plan (China) is the regional China endpoint for Xiaomi MiMo's Token Plan subscription service (`https://token-plan-cn.xiaomimimo.com/v1`). It provides access to MiMo AI models using regional `tp-...` API keys. It uses the "OpenAI Chat Completions" transport.

### Special casings

Provider-specific overrides in `packages/catalog/src/compat/rules/providers/xiaomi-token-plan-cn.kdl` (more-specific selectors override provider defaults):

- For class mimo; family v2: `thinking.mode="effort"`.

- **Host classification**: `KNOWN_HOSTS.xiaomi` in `packages/catalog/src/hosts.ts` matches `xiaomi-token-plan-cn` via `providerPrefixes: ["xiaomi-token-plan-"]` and `urlMarkers: ["xiaomimimo.com"]`, enabling host-level compatibility flags across all Token Plan endpoints.
- **Reasoning content replay**: `packages/catalog/src/compat/resolve.ts` marks MiMo models on Xiaomi hosts with `requiresReasoningContentForToolCalls: true` and `requiresReasoningContentForAllAssistantTurns: true`, requiring prior assistant tool-call turns to preserve exact `reasoning_content`.
- **Synthetic reasoning rejection**: `allowsSyntheticReasoningContentForToolCalls` in `packages/catalog/src/compat/resolve.ts` evaluates to `false` for MiMo models, rejecting synthetic `.` placeholders on tool-call continuations.
- **Audio SKU filtering**: `packages/catalog/scripts/generate-models.ts` filters out speech-synthesis and recognition SKUs containing `-tts` or `-asr` for `xiaomi-token-plan-` providers.

### Auth & usage
- **Environment variable & login**: Authenticates via `XIAOMI_TOKEN_PLAN_CN_API_KEY`. Declared in `packages/catalog/src/compat/rules/auth/xiaomi-token-plan-cn.kdl` as a `login "api-key"` rule (`packages/ai/src/registry/engine/api-key.ts`).
- **Regional API key validation**: Prompts for a `tp-...` key from `https://platform.xiaomimimo.com/console/plan-manage` and validates it via `validateXiaomiApiKey` by sending a `POST /v1/chat/completions` request for `mimo-v2.5` strictly against `https://token-plan-cn.xiaomimimo.com/v1` with a 15-second timeout (`VALIDATION_TIMEOUT_MS`).
- **Usage accounting**: Standard OpenAI Chat Completions usage accounting applies (`calculateOpenAIUsageAccounting`); no provider-specific usage or quota module exists.

### Catalog model handling
- **Provider entry (`xiaomi-token-plan-cn`)**: `packages/catalog/src/compat/rules/providers/xiaomi-token-plan-cn.kdl` declares default model `mimo-v2.5`. Environment keys: `XIAOMI_TOKEN_PLAN_CN_API_KEY`.
- **Authored seeds**: `mimo-v2.6-pro`, `mimo-v2.6-flash`, `mimo-v2.6-pro-ultraspeed`; bundle policy `always`. Limits, capabilities, and prices are authored alongside these rows.
- **Regional discovery & model manager**: `xiaomiModelManagerOptions` in `packages/catalog/src/provider-models/openai-compat.ts` pins discovery to `XIAOMI_TOKEN_PLAN_BASE_URLS.cn` (`https://token-plan-cn.xiaomimimo.com/v1`). Dynamic model discovery preserves `providerId: "xiaomi-token-plan-cn"`, filters `-tts` and `-asr` models, and merges metadata from bundled `xiaomi` reference specs using `createBundledReferenceMap("xiaomi")`.

## Xiaomi Token Plan (Singapore) (`xiaomi-token-plan-sgp`)
The Xiaomi Token Plan (Singapore) provider (`xiaomi-token-plan-sgp`) routes requests to Xiaomi's Singapore Token Plan cluster using the OpenAI Chat Completions transport (`openai-completions`). It provides dedicated access to Xiaomi MiMo models (`mimo-v2.5`, `mimo-v2-omni`) using region-bound `tp-...` API keys targeted at `https://token-plan-sgp.xiaomimimo.com/v1`. This regional entry allows login and model storage isolated from standard Xiaomi MiMo (`xiaomi`) and other regional token plan endpoints (`xiaomi-token-plan-ams`, `xiaomi-token-plan-cn`).

### Special casings

Provider-specific overrides in `packages/catalog/src/compat/rules/providers/xiaomi-token-plan-sgp.kdl` (more-specific selectors override provider defaults):

- For class mimo; family v2: `thinking.mode="effort"`.

- **Regional Base URL Binding**: `xiaomiModelManagerOptions` (`packages/catalog/src/provider-models/openai-compat.ts`) explicitly sets `baseUrl` to `https://token-plan-sgp.xiaomimimo.com/v1` (`XIAOMI_TOKEN_PLAN_BASE_URLS.sgp`) when configured with `tokenPlanRegion: "sgp"`, preventing token-plan keys from reverting to the standard Xiaomi endpoint `https://api.xiaomimimo.com/v1` (`XIAOMI_STANDARD_BASE_URL`).

### Auth & usage
- **Pinned Regional Validation**: Validates keys strictly against the Singapore endpoint `https://token-plan-sgp.xiaomimimo.com/v1` (via `validate "chat-completions"` in `packages/catalog/src/compat/rules/auth/xiaomi-token-plan-sgp.kdl`). Unlike generic `loginXiaomi` (which performs SGP -> AMS -> CN fallback for `tp-` keys), `xiaomi-token-plan-sgp` disables cross-region fallback during auth validation.
- **Plan Management Auth URL**: Declared in `packages/catalog/src/compat/rules/auth/xiaomi-token-plan-sgp.kdl`, prompting users with instructions pointing to `https://platform.xiaomimimo.com/console/plan-manage` for acquiring regional `tp-` keys (`placeholder="tp-..."`), contrasting with standard `https://platform.xiaomimimo.com/#/console/api-keys`.
- **Validation Handshake**: Validation tests credentials via `POST /chat/completions` using model `mimo-v2.5` (`validate "chat-completions"` in `packages/catalog/src/compat/rules/auth/xiaomi-token-plan-sgp.kdl`), `max_tokens: 1`, and `messages: [{ role: "user", content: "ping" }]`, enforcing a 15-second timeout.
- **Usage Accounting**: Token consumption and cache metrics are calculated using standard OpenAI Chat Completions accounting via `calculateOpenAIUsageAccounting` (`packages/ai/src/providers/openai-shared.ts`).

### Catalog model handling
- **Provider entry (`xiaomi-token-plan-sgp`)**: `packages/catalog/src/compat/rules/providers/xiaomi-token-plan-sgp.kdl` declares default model `mimo-v2.5`. Environment keys: `XIAOMI_TOKEN_PLAN_SGP_API_KEY`.
- **Bundled Spec Mapping**: Dynamic model mapping uses `createBundledReferenceMap` (`packages/catalog/src/provider-models/openai-compat.ts`) to merge dynamic models with static reference specs defined under `"xiaomi"` in `packages/catalog/src/models.json`.

## Z.AI (GLM Coding Plan) (`zai`)
Z.AI provides GLM family models (such as `glm-5.2`) via Zhipu AI's coding plan infrastructure using the Anthropic Messages transport (`https://api.z.ai/api/anthropic`). Authentication supports both direct API keys and an OAuth browser sign-in flow that mints a durable API key.

### Special casings

Provider-specific overrides in `packages/catalog/src/compat/rules/providers/zai.kdl` (more-specific selectors override provider defaults):

- For class glm; family flash: `thinking.efforts=["minimal","low","medium","high","xhigh"]`, `thinking.mode="budget"`.
- For class glm; family turbo: `thinking.efforts=["minimal","low","medium","high","xhigh"]`, `thinking.mode="budget"`.
- For models *5, *v, glm-4.5-air, glm-4.6, glm-4.7, glm-5.1: `thinking.efforts=["minimal","low","medium","high","xhigh"]`, `thinking.mode="budget"`.
- For models glm-5.2: `thinking.efforts=["high","max"]`, `thinking.mode="anthropic-budget-effort"`.
- For models glm-5.3-flash: `clampOutputToModelMax=true`, `thinking.mode="anthropic-budget-effort"`.
- Provider defaults: `requiresToolResultId=true`.

- **Reasoning content continuation replay**: In `streamOpenAICompletionsOnce` (`packages/ai/src/providers/openai-completions.ts`), when `compat.thinkingFormat === "zai"` and `model.reasoning` is true, preserved thinking blocks are re-serialized into `assistantMsg.reasoning_content` on cross-API provider switches (e.g. Anthropic → OpenAI) to preserve structured reasoning history without text demotion (#3434).
- **Foreign thinking preservation**: `targetReadsForeignThinking` in `packages/ai/src/providers/transform-messages.ts` returns true for reasoning models with `compat.thinkingFormat === "zai"`, preserving non-native thinking blocks across message transforms.
- **Max output token clamping**: `resolveOpenAICompletionsOutputClamp` in `packages/ai/src/providers/openai-shared.ts` clamps output for `isZaiReasoningEffortDialect` models (`glm-5.2`) to `model.maxTokens` rather than the default 64k ceiling.
- **Host URL matching**: `hostMatchesUrl` in `packages/catalog/src/hosts.ts` matches Z.AI endpoints against the `api.z.ai` URL marker.

### Auth & usage
- **API Key Login**: Declared in `packages/catalog/src/compat/rules/auth/zai.kdl` as a `login "api-key"` rule (`packages/ai/src/registry/engine/api-key.ts`), prompting for `ZAI_API_KEY` (dashboard `https://z.ai/manage-apikey/apikey-list`) and validating via a chat completions probe against `https://api.z.ai/api/coding/paas/v4` with model `glm-5.2`.
- **OAuth flow & browser sign-in**: Declared in `packages/catalog/src/compat/rules/auth/zai-coding-plan.kdl` as a `login "oauth-code"` rule (`packages/ai/src/registry/engine/oauth-code.ts`) with key minting hook in `packages/ai/src/registry/oauth/zai.ts`. It initiates authorization at `https://chat.z.ai/api/oauth/authorize` with the ZCode-registered CLI redirect `http://127.0.0.1:9999/callback` (paste-code fallback) and exchanges authorization codes at `https://zcode.z.ai/api/v1/oauth/token`.
- **Durable key minting**: `mintZaiApiKey` (`packages/ai/src/registry/oauth/zai.ts`) exchanges the short-lived OAuth token for a business token via `businessLogin` (`https://api.z.ai/api/auth/z/login`), resolves default org/project via `getCustomerInfo` (`BIZ_BASE` = `https://api.z.ai`), creates or reuses key `"oh-my-pi"` (`KEY_NAME`), and copies the secret via `/copy/${apiKey}` to output a durable 49-char `${apiKey}.${secretKey}` token saved as `storeCredentialsAs: "zai"`.
- **Usage & quota fetcher**: `fetchZaiUsage` / `zaiUsageProvider` (`packages/ai/src/usage/zai.ts`) queries `QUOTA_PATH` (`/api/monitor/usage/quota/limit`) on `DEFAULT_ENDPOINT` (`https://api.z.ai`) with direct key authorization. `parseLimitItem` parses `TOKENS_LIMIT` into token quotas (`zai:tokens:<window>`), `TIME_LIMIT` into request quotas (`zai:requests:<window>` or `zai:features:zread:<window>` when `isZaiFeatureRequestLimit` matches), and `CREDIT_LIMIT` into credit quotas (`zai:credits:<window>`, unit `credits`) for the credit-based GLM Coding Plan (e.g. 12k credits / 5h + 60k credits / week; `usage` is the allotment, `currentValue` the spend). The payload's `data.level` (e.g. `"lite"`, `"pro"`, `"max"`) is surfaced as `metadata.planType`. `buildZaiWindow` maps time units to 1h, 1d, 1mo, or 1w windows, and optionally fetches `MODEL_USAGE_PATH` (`/api/monitor/usage/model-usage`).
- **Credential ranking**: `zaiRankingStrategy` (`packages/ai/src/usage/zai.ts`, registered in `packages/ai/src/auth-storage.ts`) ranks request limits via `rankZaiRequestLimits` (falling back to the full credential limit set — tokens/requests/credits — when no request quotas exist), selecting primary 5-hour and secondary weekly quota windows.

### Catalog model handling
- **Provider entry (`zai`)**: `packages/catalog/src/compat/rules/providers/zai.kdl` declares default model `glm-5.3`. Environment keys: `ZAI_API_KEY`.
- **Authored seeds**: `glm-5.3`, `glm-5.3-flash`; bundle policy `always`. Limits, capabilities, and prices are authored alongside these rows.


## ZenMux (`zenmux`)
ZenMux is a multi-provider gateway using dual transport routing based on model ownership. Models owned by Anthropic (identified by `owned_by: "anthropic"` or an `anthropic/` prefix) route through Anthropic Messages (`https://zenmux.ai/api/anthropic`), while all other models route through OpenAI Chat Completions (`https://zenmux.ai/api/v1`).

### Special casings

Provider-specific overrides in `packages/catalog/src/compat/rules/providers/zenmux.kdl` (more-specific selectors override provider defaults):

- For class anthropic; revision >=3.7.0 <4.6.0: `thinking.efforts=["minimal","low","medium","high","xhigh"]`.
- For class baidu; family ernie: `thinking.mode="effort"`.
- For class bytedance; family doubao: `thinking.mode="effort"`.
- For class deepseek: `thinking.mode="effort"`.
- For class gemini; revision >=2.5.0 <3.7.0: `thinking.mode="effort"`.
- For class glm; family flash: `thinking.efforts=["minimal","low","medium","high","xhigh"]`.
- For class glm; family turbo: `thinking.efforts=["minimal","low","medium","high","xhigh"]`.
- For class glm: `thinking.mode="effort"`.
- For class kimi: `thinking.mode="effort"`.
- For class mimo; family v2: `thinking.mode="effort"`.
- For class minimax: `thinking.mode="effort"`.
- For class openai; revision >=4.0.0 <5.7.0: `thinking.mode="effort"`.
- For class qwen; revision >=3.0.0 <3.236.0: `thinking.mode="effort"`.
- For class stepfun; family step: `thinking.mode="effort"`.
- For class unknown: `thinking.efforts=["minimal","low","medium","high","xhigh"]`, `thinking.mode="effort"`.
- For class xai; family grok: `thinking.mode="effort"`.
- For models baidu/ernie-5.0-thinking-preview, tencent/hunyuan-2.0-thinking: `thinking.requiresEffort=true`.
- For models deepseek/deepseek-chat-v3.1: `requiresReasoningContentForAllAssistantTurns=true`, `thinking.efforts=["high","max"]`.
- For models deepseek/deepseek-reasoner: `requiresReasoningContentForAllAssistantTurns=true`, `thinking.efforts=["high","max"]`, `thinking.requiresEffort=true`.
- For models google/gemma-4-26b-a4b-it: `thinking.mode="effort"`.
- For models openai/gpt-5.1-codex: `thinking.efforts=["minimal","low","medium","high"]`.
- For models openai/gpt-5.1-codex-mini: `thinking.efforts=["medium","high"]`.
- For models z*5, z-ai/glm-4.5-air, z-ai/glm-4.6, z-ai/glm-4.6v, z-ai/glm-4.7, z-ai/glm-5.1: `thinking.efforts=["minimal","low","medium","high","xhigh"]`.
- For models z-ai/glm-5.2*: `thinking.efforts=["minimal","low","medium","high","max"]`.
- Provider defaults: `supportsStrictMode=true`.

- **Dual Transport Base URL Normalization**: `normalizeZenMuxOpenAiBaseUrl` and `toZenMuxAnthropicBaseUrl` (`packages/catalog/src/provider-models/openai-compat.ts`) translate between endpoint URLs. OpenAI endpoints default to `https://zenmux.ai/api/v1` and Anthropic routes to `https://zenmux.ai/api/anthropic`, automatically converting paths when custom base URLs are specified.

### Auth & usage
- **API Key Resolution**: `ZENMUX_API_KEY` is registered in `descriptors.ts` (`packages/catalog/src/compat/rules/providers/zenmux.kdl`) and resolved via `getEnvApiKey("zenmux")` in `packages/ai/src/stream.ts`.
- **Key Validation & Login**: Declared in `packages/catalog/src/compat/rules/auth/zenmux.kdl` as a `login "api-key"` rule (`packages/ai/src/registry/engine/api-key.ts`), directing users to `https://zenmux.ai/settings/keys` and validating credentials via `validate "models-endpoint"` against `https://zenmux.ai/api/v1/models`.
- **Unauthenticated Discovery**: `allowUnauthenticated: true` in `descriptors.ts` enables model catalog discovery without requiring an API key.

### Catalog model handling
- **Provider entry (`zenmux`)**: `packages/catalog/src/compat/rules/providers/zenmux.kdl` declares default model `anthropic/claude-opus-5`. Environment keys: `ZENMUX_API_KEY`. Model management permits unauthenticated access.
- **Dynamic Model Discovery**: `zenmuxModelManagerOptions` in `packages/catalog/src/provider-models/openai-compat.ts` queries `https://zenmux.ai/api/v1/models` using `fetchOpenAICompatibleModels`. `isZenMuxAnthropicModel` inspects `entry.owned_by === "anthropic"` or ID prefix `anthropic/` to set `api: "anthropic-messages"` or `api: "openai-completions"`.
- **Pricing Extraction**: `getZenMuxPricingValue` and `getZenMuxCacheWritePrice` (`packages/catalog/src/provider-models/openai-compat.ts`) extract token costs from `entry.pricings`: `prompt` for input cost, `completion` for output cost, `input_cache_read` for cache read cost, and hierarchical lookup of `input_cache_write_1_h`, `input_cache_write_5_min`, or `input_cache_write` for cache write cost.
- **Capabilities & Limits**: Maps `entry.display_name`, `entry.context_length` (`contextWindow`), `entry.max_completion_tokens` (`maxTokens`), `entry.input_modalities` (`input`), and `capabilities.reasoning` (`reasoning`).

## Zhipu Coding Plan (智谱) (`zhipu-coding-plan`)
Zhipu (智谱) BigModel's domestic coding-plan provider using the OpenAI Chat Completions transport (`openai-completions` API). It routes requests to Zhipu's dedicated Coding Plan endpoint (`https://open.bigmodel.cn/api/coding/paas/v4`) rather than the general BigModel endpoint to ensure API calls consume coding-plan quota instead of account balance.

### Special casings

Provider-specific overrides in `packages/catalog/src/compat/rules/providers/zhipu-coding-plan.kdl` (more-specific selectors override provider defaults):

- For class glm; family turbo: `reasoningContentField="reasoning_content"`, `supportsDeveloperRole=false`, `thinkingFormat="zai"`, `thinking.efforts=["minimal","low","medium","high"]`.
- For class glm: `thinking.mode="effort"`.
- For models *5, glm-4.6: `thinking.efforts=["minimal","low","medium","high"]`.
- For models glm-4.5-air: `reasoningContentField="reasoning_content"`, `supportsDeveloperRole=false`, `thinkingFormat="zai"`.
- For models glm-4.6v, glm-4.7, glm-5.1: `reasoningContentField="reasoning_content"`, `supportsDeveloperRole=false`, `thinkingFormat="zai"`, `thinking.efforts=["minimal","low","medium","high"]`.
- For models glm-5.2*: `reasoningContentField="reasoning_content"`, `supportsDeveloperRole=false`, `thinkingFormat="zai"`, `thinking.efforts=["high","max"]`.
- Provider defaults: `thinkingFormat="zai"`.


### Auth & usage
- **Credentials & API Base**: Authenticates via `ZHIPU_API_KEY` (`packages/catalog/src/compat/rules/providers/zhipu-coding-plan.kdl` line 541) with API base URL `https://open.bigmodel.cn/api/coding/paas/v4` and dashboard URL `https://bigmodel.cn/coding-plan/personal/overview` (`packages/catalog/src/compat/rules/auth/zhipu-coding-plan.kdl`).
- **API Key Login & Validation**: Declared in `packages/catalog/src/compat/rules/auth/zhipu-coding-plan.kdl` as a `login "api-key"` rule (`packages/ai/src/registry/engine/api-key.ts`) with key format `<id>.<secret>`, validating against `glm-5.1` at `https://open.bigmodel.cn/api/coding/paas/v4`. Host detection is wired via `hosts.ts` (`zhipu`, urlMarker `open.bigmodel.cn`, `packages/catalog/src/hosts.ts`).
- **Chinese-Language 429 Quota Classification**: `CN_QUOTA_EXHAUSTED_PATTERN` in `packages/ai/src/error/rate-limit.ts` (`/使用.{0,30}?上限|(?:额度|配额)已?(?:用|耗)(?:完|尽)|限额.{0,30}重置|余额不足/`) classifies Zhipu's 429 quota exhaustion responses (`"429 已达到 5 小时的使用上限。您的限额将在 ... 重置。"`) as `QUOTA_EXHAUSTED`, triggering credential rotation instead of transient backoff.

### Catalog model handling
- **Provider entry (`zhipu-coding-plan`)**: `packages/catalog/src/compat/rules/providers/zhipu-coding-plan.kdl` declares default model `glm-5.1`. Environment keys: `ZHIPU_API_KEY`.
- **Discovery replacement**: Successful authoritative discovery replaces fallback provider rows rather than retaining retired seed models.



# Additional catalog routes

## Abliteration (`abliteration`)

### Special casings
- Uses `openai-responses`; credentialed `/models` discovery is authoritative and joins bundled/curated references.

### Auth & usage
- Login kind `api-key` is declared in `packages/catalog/src/compat/rules/auth/abliteration.kdl`. Environment keys: `ABLITERATION_API_KEY`, `ABLIT_KEY`. Validation uses `models-endpoint`.

### Catalog model handling
- **Provider entry (`abliteration`)**: `packages/catalog/src/compat/rules/providers/abliteration.kdl` declares default model `abliterated-model`. Environment keys: `ABLITERATION_API_KEY`, `ABLIT_KEY`.
- **Discovery replacement**: Successful authoritative discovery replaces fallback provider rows rather than retaining retired seed models.
- **Authored seeds**: `abliterated-model`, `abliterated-model-large-v2`, `abliterated-model-large`; bundle policy `fallback`. Limits, capabilities, and prices are authored alongside these rows.
- Runtime manager: `abliterationModelManagerOptions` in `packages/catalog/src/provider-models/openai-compat.ts`.

## Apple Foundation Models (on-device) (`apple`)

### Special casings
- Apple Foundation Models is an in-process pi-natives bridge for macOS 27+ on Apple silicon. Availability is discovered at runtime; no models are bundled.

### Auth & usage
- No interactive login is declared for this route.

### Catalog model handling
- **Provider entry (`apple`)**: `packages/catalog/src/compat/rules/providers/apple.kdl` declares default model `on-device`. Model management permits unauthenticated access.

## Charm Hyper (`charm-hyper`)

### Special casings
- Uses `openai-completions`; endpoint-normalized discovery has a base-URL-scoped cache and maps advertised reasoning tiers.

### Auth & usage
- Login kind `api-key` is declared in `packages/catalog/src/compat/rules/auth/charm-hyper.kdl`. Environment keys: `CHARM_HYPER_API_KEY`, `HYPER_API_KEY`. Validation uses `models-endpoint`.

### Catalog model handling
- **Provider entry (`charm-hyper`)**: `packages/catalog/src/compat/rules/providers/charm-hyper.kdl` declares default model `glm-5.3`. Environment keys: `CHARM_HYPER_API_KEY`, `HYPER_API_KEY`. Model management permits unauthenticated access.
- **Discovery replacement**: Successful authoritative discovery replaces fallback provider rows rather than retaining retired seed models.
- Runtime manager: `charmHyperModelManagerOptions` in `packages/catalog/src/provider-models/openai-compat.ts`.

## ClinePass (`cline-pass`)

### Special casings
- Uses `openai-completions`; its dedicated catalog fetch maps live rows against bundled references. Gateway-reported cost is authoritative through `applyProviderReportedCost` in `openai-shared.ts`.

### Auth & usage
- Login kind `api-key` is declared in `packages/catalog/src/compat/rules/auth/cline-pass.kdl`. Environment keys: `CLINE_API_KEY`. Validation uses `models-endpoint`.

### Catalog model handling
- **Provider entry (`cline-pass`)**: `packages/catalog/src/compat/rules/providers/cline-pass.kdl` declares default model `kimi-k3`. Environment keys: `CLINE_API_KEY`.
- **Discovery replacement**: Successful authoritative discovery replaces fallback provider rows rather than retaining retired seed models.
- Runtime manager: `clinePassModelManagerOptions` in `packages/catalog/src/provider-models/openai-compat.ts`.

## Command Code (`commandcode`)

### Special casings
- Its public `/v1/models` discovery begins with OpenAI-compatible rows and resolves per-model API routes; the authored fallback seed uses `typesafe`. Cache identity includes credential and endpoint.

### Auth & usage
- Login kind `api-key` is declared in `packages/catalog/src/compat/rules/auth/commandcode.kdl`. Environment keys: `COMMAND_CODE_API_KEY`, `COMMANDCODE_API_KEY`. Validation uses `models-endpoint`.

### Catalog model handling
- **Provider entry (`commandcode`)**: `packages/catalog/src/compat/rules/providers/commandcode.kdl` declares default model `claude-sonnet-5`. Environment keys: `COMMAND_CODE_API_KEY`, `COMMANDCODE_API_KEY`. Model management permits unauthenticated access.
- **Discovery replacement**: Successful authoritative discovery replaces fallback provider rows rather than retaining retired seed models.
- **Authored seeds**: `typesafe/jev`; bundle policy `always`. Limits, capabilities, and prices are authored alongside these rows.
- Runtime manager: `commandCodeModelManagerOptions` in `packages/catalog/src/provider-models/openai-compat.ts`.

## DeepInfra (`deepinfra`)

### Special casings
- Chat discovery uses `openai-completions` and dedicated DeepInfra metadata mapping. The provider also authors `openai-images` seeds, so not every catalog row is a chat model.

### Auth & usage
- Login kind `api-key` is declared in `packages/catalog/src/compat/rules/auth/deepinfra.kdl`. Environment keys: `DEEPINFRA_API_KEY`. Validation uses `chat-completions` with model `deepseek-ai/DeepSeek-V4-Flash-0731`.

### Catalog model handling
- **Provider entry (`deepinfra`)**: `packages/catalog/src/compat/rules/providers/deepinfra.kdl` declares default model `deepseek-ai/DeepSeek-V4-Flash-0731`. Environment keys: `DEEPINFRA_API_KEY`.
- **Discovery replacement**: Successful authoritative discovery replaces fallback provider rows rather than retaining retired seed models.
- **Authored seeds**: `black-forest-labs/FLUX-2-pro`, `hexgrad/Kokoro-82M`; bundle policy `always`. Limits, capabilities, and prices are authored alongside these rows.
- Runtime manager: `deepinfraModelManagerOptions` in `packages/catalog/src/provider-models/openai-compat.ts`.

## Helmcode (`helmcode`)

### Special casings
- Uses `openai-completions` at `https://api.helmcode.com/v1`; credentialed discovery filters excluded IDs and joins HelmCode or upstream vendor reference metadata.

### Auth & usage
- Login kind `api-key` is declared in `packages/catalog/src/compat/rules/auth/helmcode.kdl`. Environment keys: `HELMCODE_API_KEY`. Validation uses `models-endpoint`.

### Catalog model handling
- **Provider entry (`helmcode`)**: `packages/catalog/src/compat/rules/providers/helmcode.kdl` declares default model `deepseek-v4-flash`. Environment keys: `HELMCODE_API_KEY`.
- **Discovery replacement**: Successful authoritative discovery replaces fallback provider rows rather than retaining retired seed models.
- **Authored seeds**: `deepseek-v4-flash`, `qwen3.6`, `gemma4`, `glm5.3`; bundle policy `fallback`. Limits, capabilities, and prices are authored alongside these rows.
- Runtime manager: `helmcodeModelManagerOptions` in `packages/catalog/src/provider-models/openai-compat.ts`.

## Local models (`local`)

### Special casings
- Uses `local-inference`. `localModelManagerOptions` supplies authored local model seeds and a local cache namespace rather than remote API discovery.

### Auth & usage
- No interactive login is declared for this route.

### Catalog model handling
- **Provider entry (`local`)**: `packages/catalog/src/compat/rules/providers/local.kdl` declares default model `lfm2.5-230m`. Model management permits unauthenticated access.
- **Authored seeds**: `kokoro`, `parakeet-tdt-0.6b-v3`, `whisper-base`, `whisper-small`, `whisper-large-v3-turbo`, `lfm2.5-230m`, `lfm2.5-350m`, `falcon-h1-90m`, `qwen3-1.7b`, `llama3.2:3b`, `gemma-3-1b`, `qwen2.5-1.5b`, `lfm2-1.2b`; bundle policy `always`. Limits, capabilities, and prices are authored alongside these rows.
- Runtime manager: `localModelManagerOptions` in `packages/catalog/src/provider-models/special.ts`.

## Muse Code (Subscription) (`muse-code`)

### Special casings
- Uses `openai-responses` on the Meta Model API with `x-api-version: 1.0.0`. Credentialed authoritative discovery joins authored Muse lineage references and partitions the cache by credential/endpoint.

### Auth & usage
- Login kind `device-code` is declared in `packages/catalog/src/compat/rules/auth/muse-code.kdl`.

### Catalog model handling
- **Provider entry (`muse-code`)**: `packages/catalog/src/compat/rules/providers/muse-code.kdl` declares default model `muse-spark-1.3`.
- **Discovery replacement**: Successful authoritative discovery replaces fallback provider rows rather than retaining retired seed models.
- **Authored seeds**: `muse-spark-1.1`, `muse-spark-1.2`, `muse-spark-1.2-contributor`, `muse-spark-1.3`, `muse-spark-1.3-contributor`; bundle policy `always`. Limits, capabilities, and prices are authored alongside these rows.
- Runtime manager: `museCodeModelManagerOptions` in `packages/catalog/src/provider-models/openai-compat.ts`.

## SingularityAPI (`singularityapi-dev`)

### Special casings
- Uses the shared SingularityAPI manager with metadata mapping for the `.dev` deployment.

### Auth & usage
- Login kind `api-key` is declared in `packages/catalog/src/compat/rules/auth/singularityapi-dev.kdl`. Environment keys: `SINGULARITYAPI_DEV_API_KEY`. Validation uses `models-endpoint`.

### Catalog model handling
- **Provider entry (`singularityapi-dev`)**: `packages/catalog/src/compat/rules/providers/singularityapi-dev.kdl` declares default model `deepseek-v4-flash`. Environment keys: `SINGULARITYAPI_DEV_API_KEY`.
- **Discovery replacement**: Successful authoritative discovery replaces fallback provider rows rather than retaining retired seed models.
- Runtime manager: `singularityApiDevModelManagerOptions` in `packages/catalog/src/provider-models/openai-compat.ts`.

## SingularityAPI Reserved Lanes (`singularityapi-tech`)

### Special casings
- Uses the shared SingularityAPI manager for slot-reserved `.tech` DeepSeek lanes. Its sparse `{id}` discovery rows rely on reviewed KDL policy for wire shape, limits, and effort ladders.

### Auth & usage
- Login kind `api-key` is declared in `packages/catalog/src/compat/rules/auth/singularityapi-tech.kdl`. Environment keys: `SINGULARITYAPI_TECH_API_KEY`. Validation uses `models-endpoint`.

### Catalog model handling
- **Provider entry (`singularityapi-tech`)**: `packages/catalog/src/compat/rules/providers/singularityapi-tech.kdl` declares default model `deepseek-ai/DeepSeek-V4.1-Flash`. Environment keys: `SINGULARITYAPI_TECH_API_KEY`.
- **Discovery replacement**: Successful authoritative discovery replaces fallback provider rows rather than retaining retired seed models.
- Runtime manager: `singularityApiTechModelManagerOptions` in `packages/catalog/src/provider-models/openai-compat.ts`.

## TypeSafe (`typesafe`)

### Special casings
- Uses `typesafe`. `typesafeModelManagerOptions` keeps an offline seed, honors `TYPESAFE_BASE_URL`, and enables authoritative account-visible discovery when a key is supplied.

### Auth & usage
- Login kind `api-key` is declared in `packages/catalog/src/compat/rules/auth/typesafe.kdl`. Environment keys: `TYPESAFE_API_KEY`. Validation uses `models-endpoint`.

### Catalog model handling
- **Provider entry (`typesafe`)**: `packages/catalog/src/compat/rules/providers/typesafe.kdl` declares default model `jev-latest`. Environment keys: `TYPESAFE_API_KEY`.
- **Authored seeds**: `jev-latest`; bundle policy `always`. Limits, capabilities, and prices are authored alongside these rows.
- Runtime manager: `typesafeModelManagerOptions` in `packages/catalog/src/provider-models/special.ts`.

## Web search engines (`web`)

### Special casings
- Uses `web-search`. `webModelManagerOptions` supplies authored web-search models in a dedicated cache namespace, not chat-completion discovery.

### Auth & usage
- No interactive login is declared for this route.

### Catalog model handling
- **Provider entry (`web`)**: `packages/catalog/src/compat/rules/providers/web.kdl` declares default model `public`. Model management permits unauthenticated access.
- **Authored seeds**: `hosted`, `parallel`, `perplexity`, `zai`, `exa`, `tinyfish`, `jina`, `kagi`, `tavily`, `firecrawl`, `brave`, `kimi`, `synthetic`, `ollama`, `searxng`, `startpage`, `duckduckgo`, `ecosia`, `google`, `mojeek`, `public`; bundle policy `always`. Limits, capabilities, and prices are authored alongside these rows.
- Runtime manager: `webModelManagerOptions` in `packages/catalog/src/provider-models/special.ts`.

## Yolo-Auto (`yolo-auto`)

### Special casings
- Uses `openai-completions`; curated seed metadata takes precedence over older bundled reference metadata during dynamic discovery.

### Auth & usage
- Login kind `api-key` is declared in `packages/catalog/src/compat/rules/auth/yolo-auto.kdl`. Environment keys: `YOLO_AUTO_API_KEY`. Validation uses `models-endpoint`.

### Catalog model handling
- **Provider entry (`yolo-auto`)**: `packages/catalog/src/compat/rules/providers/yolo-auto.kdl` declares default model `qwen3.8-flash`. Environment keys: `YOLO_AUTO_API_KEY`.
- **Discovery replacement**: Successful authoritative discovery replaces fallback provider rows rather than retaining retired seed models.
- **Authored seeds**: `deepseek-flash-v4`, `qwen3.8-flash`, `yolo`; bundle policy `fallback`. Limits, capabilities, and prices are authored alongside these rows.
- Runtime manager: `yoloAutoModelManagerOptions` in `packages/catalog/src/provider-models/openai-compat.ts`.
