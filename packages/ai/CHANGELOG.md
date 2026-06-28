# Changelog

## [Unreleased]

### Changed

- Default reasoning context to `all_turns` for all Codex requests

## [16.2.2] - 2026-06-27

### Added

- Added a comprehensive, public-facing error module exported via the "./error" path, featuring structured error classification, provider-specific HTTP error classes (e.g., Anthropic, OpenAI, Gemini), OAuth/Auth-specific errors, rate-limit utilities, and retryability predicates.

### Changed

- Updated OpenAI Codex defaults to increase default text verbosity to medium, enable detailed reasoning summaries by default, and include all turns in the reasoning context by default.
- Updated the OpenAI Codex WebSocket transport to resolve its configuration (via PI_CODEX_WEBSOCKET_* environment variables) once at startup rather than re-parsing on every request.
- Enhanced cross-model reasoning recovery and preservation to render demoted reasoning in the target model's canonical inline thinking dialect (such as Gemini's thinking fence or standard think tags) to prevent leaking inert context or control tokens into history.
- Broadened the leaked-thinking stream healer to recover reasoning emitted in any dialect's canonical idiom (including Gemini, Gemma, Harmony, and scratchpads) and route them to thinking events instead of raw markup.
- Implemented automatic retry logic for detected thinking-loop stalls to improve response reliability.
- Hardened stateful delta chaining to ignore transient streaming bookkeeping symbols during structural equality checks, preventing unnecessary full-transcript replays.

### Fixed

- Fixed preservation of OpenAI Responses assistant message phase values across auth-gateway parsing, streaming, and history replay, ensuring GPT-5.4/GPT-5.5 intermediate updates and final answers retain their original phase labels.

### Removed

- Removed Pi dialect support and related serialization/parsing logic.

## [16.2.0] - 2026-06-27

### Breaking Changes

- Removed the `@pk-nerdsaver-ai/pi-ai/utils/json-parse` module. The JSON repair and parsing helpers (`repairJson`, `parseJsonWithRepair`, `parseStreamingJson`, `parseStreamingJsonThrottled`) have been moved to `@pk-nerdsaver-ai/pi-utils` to be shared across utilities.

### Added

- Added the GitLab Duo Agent provider (`gitlab-duo-agent`) and built-in implementation, renaming the existing AI Gateway proxy provider to "GitLab Duo Non-Agentic" (`gitlab-duo`).
- Added GitLab Duo Workflow provider support, featuring OAuth login via the official VS Code OAuth application, automatic project discovery, and automatic session-time namespace Duo settings enablement.
- Added runaway detection for Gemini models to interrupt streams stuck in excessive planning steps.
- Added a per-provider in-flight request limiter for LLM streams, shared across local OMP processes and configurable via `maxInFlightRequests`.
- Added a `credits` field to `UsageResetCredits` to display when banked rate-limit resets expire, with support for OpenAI Codex usage details.

### Changed

- Optimized GitLab Duo Agent and Workflow providers to use an inline custom "ambient" flow with MCP-only agent privileges, registering MCP tools under their bare names.
- Improved GitLab Duo Agent context management and auto-compaction by lowering the soft overflow threshold to 1 MB and stripping redundant bytes (such as tool-call UUIDs and escaped JSON) from the goal transcript.
- Enhanced GitLab Duo Agent prompt engineering to render replayed tool calls as past-tense records, reducing model confusion and preventing the model from mimicking historical markers.
- Added caching for discovered GitLab Duo Agent root namespaces per account to avoid redundant discovery requests.

### Fixed

- Fixed various GitLab Duo Agent and Workflow stability issues, including infinite tool-call loops, connection hangs on half-open WebSockets, and unhandled step-limit or generic server-side failures.
- Improved GitLab Duo Workflow routing, namespace resolution, and project-path handling, ensuring correct numeric ID resolution and support for self-managed GitLab relative install base paths.
- Fixed GitLab Duo Workflow checkpoint streaming to correctly map reasoning entries to thinking blocks, preserve tool boundaries, and accurately report token usage.
- Fixed `AuthStorage.login` to only synthesize manual-code paste prompts for paste-code providers, preventing terminal-blocking races on loopback OAuth flows.
- Fixed llama.cpp compatibility by downgrading named forced `tool_choice` objects to the string `"required"` in the chat-completions encoder.
- Fixed `omp usage` omitting Ollama and Ollama Cloud accounts by registering placeholder usage providers.
- Fixed Gemini reasoning-runaway detection to expose a dedicated thought-summary header guard to interrupt streams stuck in planning loops.

### Removed

- Removed legacy GitLab Duo Workflow `chat` and `software_development` flow paths and the non-MCP action bridge in favor of the inline custom `ambient` flow.

## [16.1.23] - 2026-06-26

### Added

- Added a third streaming thinking-loop detection heuristic to catch "progress-lexicon stalls" where models endlessly reshuffle motivational filler without introducing new vocabulary or concrete technical references
- Added branded wordmark and logo animation to authentication flow
- Added a third streaming thinking-loop detection shape — a *progress-lexicon stall* — alongside verbatim tail repetition and near-duplicate (trigram) segments. It catches reasoning-summarizer loops that reshuffle the same motivational filler ("just doing it, pushing ahead, maintaining momentum") into fresh word order every paragraph: word-trigrams never cluster, but a run of substantial segments that recycle the recent vocabulary and introduce no *new* concrete reference (path / identifier / code-span) trips the guard. Summarizer title/heading lines (`**Bold Title**`, `## Heading`) are stripped before analysis so their ever-changing wording cannot mask the stall by inflating novelty. Calibrated against 537k real non-Gemini reasoning blocks (zero false positives at novelty floor 0.2 / run length 8; the real loop sustains runs of 10+).
- Added CoreWeave Serverless Inference provider login support via `COREWEAVE_API_KEY` and `WANDB_API_KEY` fallback.

### Changed

- Redesigned the OAuth callback page (`oauth.html`) to match the oh-my-pi web brand language: OKLCH purple-tinted dark neutrals, magenta→iris→cyan brand gradient on the wordmark, frosted-glass card over an ascii grid backdrop, and a colored status halo around the success/error icon. All assets are inlined; the `__OAUTH_STATE__` injection contract and success/error JS logic are unchanged.

### Fixed

- Fixed local llama.cpp (and any local OpenAI-compatible server rendering the Qwen3.6+ chat template) re-processing the full prompt every new user message even with `replayReasoningContent` enabled (#3541 follow-up to #3528). Sending `reasoning_content` alone wasn't enough: Qwen3's chat template strips `<think>...</think>` from any assistant turn whose index is `<= last_query_index`, so the moment a new user message (the user's next prompt, or the auto-learn capture-at-stop nudge) lands, every prior assistant turn becomes "older" and is re-rendered without the `<think>` block — diverging from the generation tokens still in the slot's KV cache. The chat-completions encoder now emits `preserve_thinking: true` for Qwen thinking dialects on local servers, route-split the same way the existing `enable_thinking` emission is: the `qwen` dialect rides the top-level field (llama.cpp's `--jinja` hook and Alibaba Cloud Model Studio's compatible-mode), the `qwen-chat-template` dialect (NVIDIA NIM, vLLM/SGLang's chat-template-kwargs path) rides only `chat_template_kwargs.preserve_thinking` because NIM's request schema is `additionalProperties: false` and rejects unknown top-level fields (#2299). The emission is hoisted above the `reasoning.enabled` gate so it fires for THREE cases the original gating missed: (1) runtime-discovered local Qwen models that ship with `reasoning: false` because the upstream `/v1/models` doesn't advertise the capability (same gotcha #3532 fixed for `replayReasoningContent`), (2) caller-disabled reasoning (`/think off`) — the kwarg is a history-rendering knob, not a per-turn thinking switch, and the slot still holds `<think>` tokens from earlier turns, and (3) forced-tool-choice / DeepSeek-style auto-disable. Qwen3.6+ then renders `<think>...</think>` for every assistant turn regardless of position, and the next-turn render matches the cached generation tokens. ([#3541](https://github.com/can1357/oh-my-pi/issues/3541))

## [16.1.22] - 2026-06-26

### Fixed

- Fixed llama.cpp / LM Studio / vLLM (and any local OpenAI-compatible server on a loopback or RFC1918 baseUrl) re-processing the full prompt on every assistant continuation when the prior turn produced `reasoning_content`: the `openai-completions` encoder dropped the preserved `thinking` block on re-serialization for compat profiles without `requiresReasoningContentForToolCalls` / `thinkingFormat: "zai"`, so the chat template re-rendered the assistant turn without `<think>…</think>` and the rendered tokens diverged from the slot's KV cache state. The auto-learn capture-at-stop nudge made it reproduce on every turn. The encoder now replays preserved thinking as `reasoning_content` (honoring the streamed signature when it identifies a recognized wire field — `reasoning_content` / `reasoning` / `reasoning_text` — and falling back to the configured `reasoningContentField` for opaque signatures) whenever the new `compat.replayReasoningContent` flag is set, and the cross-API `transformMessages` predicate (`openAICompletionsReplaysUnsignedThinking`) honors the same flag ahead of the `model.reasoning` gate so a switch into a discovered local target (where the spec carries `reasoning: false` because the upstream `/models` endpoints don't advertise the capability) still preserves the prior turn's thinking block as signature-stripped reasoning instead of demoting it to conversation text. The chat-template-rendered prefix stays byte-stable across turns and llama.cpp's prefix KV cache survives. ([#3528](https://github.com/can1357/oh-my-pi/issues/3528))

## [16.1.21] - 2026-06-26

### Fixed

- Restored the `pollOAuthDeviceCodeFlow` export from `@pk-nerdsaver-ai/pi-ai/oauth` so legacy provider extensions can reuse the host OAuth device-code poller. ([#3508](https://github.com/can1357/oh-my-pi/issues/3508))

## [16.1.20] - 2026-06-25

### Fixed

- Fixed Ollama/Ollama Cloud native chat responses that finish with `done_reason: "length"` and no assistant content surfacing as a normal empty stop; they now become a context-window error instead of entering empty-stop retry recovery. ([#3464](https://github.com/can1357/oh-my-pi/issues/3464))
- Fixed direct Anthropic Claude Sonnet/Haiku 4.5 requests serializing `output_config.effort`. The catalog classification (`packages/catalog/src/model-thinking.ts`) drove the `anthropic-budget-effort` branch in `buildParams`, which Anthropic's first-party Messages API rejects on Sonnet/Haiku 4.5 with HTTP 400 `This model does not support the effort parameter.` Sonnet/Haiku 4.5 now use plain `thinking.budget_tokens`; Opus 4.5 still emits `output_config.effort` because Anthropic supports it there. ([#3497](https://github.com/can1357/oh-my-pi/issues/3497))

## [16.1.19] - 2026-06-25

### Fixed

- Fixed Ollama/llama.cpp chat payloads serializing user-attributed mid-conversation developer messages (auto-learn capture nudge, advisor cards, file-mention companions) as `system` turns; they now serialize as `user` so llama.cpp can reuse the warm prompt prefix instead of forcing full re-processing. Agent-owned developer reminders (`attribution: "agent"` — empty/unexpected-stop retries, checkpoint rewind warning, todo reminders) keep their `system` priority. ([#3456](https://github.com/can1357/oh-my-pi/issues/3456))
- Fixed prior-turn reasoning being lost on cross-API provider switches: when a session moved from an Anthropic-compatible 3p endpoint to an OpenAI-compatible one (Z.AI Anthropic → Z.AI OpenAI, Kimi Anthropic → Kimi OpenAI, DeepSeek, OpenCode-hosted reasoning models, or any custom `models.yaml` switch that crosses API types), the cross-API path of `transformMessages` text-demoted every prior `thinking` block, so the next request shipped the reasoning chain as plain conversation `content` instead of structured `reasoning_content` — losing it as reasoning context and re-billing it. `convertMessages` now threads the request-time resolved compat into `transformMessages`, which preserves the prior reasoning as a native, signature-stripped `thinking` block whenever that resolved target accepts `reasoning_content` as a continuation hint (`requiresReasoningContentForToolCalls` — including the `whenThinking` policy OpenCode reactivates for thinking-on requests, #1071/#1484 — or `thinkingFormat: "zai"`); the `openai-completions` encoder surfaces those blocks via `reasoningContentField`, with a new branch for Z.AI-format hosts (Z.AI, Zhipu, Moonshot Kimi, Xiaomi MiMo) that accept but don't require the field. Targets that can't replay unsigned reasoning (encrypted reasoning blobs, signed thought parts, non-reasoning models, thinking-disabled OpenCode) still text-demote so the reasoning survives as conversation context. ([#3437](https://github.com/can1357/oh-my-pi/pull/3437), [#3439](https://github.com/can1357/oh-my-pi/pull/3439) by [@roboomp](https://github.com/roboomp); [#3433](https://github.com/can1357/oh-my-pi/issues/3433), [#3434](https://github.com/can1357/oh-my-pi/issues/3434))
- Fixed Bedrock cross-region inference profiles routing to `us-east-1` regardless of their geo prefix: a profile such as `eu.anthropic.claude-…` (or `apac.`/`au.`/`jp.`) sent to the hardcoded `us-east-1` endpoint returned HTTP 400 `The provided model identifier is invalid`. `streamBedrock` now derives the runtime region from the profile's geo prefix — honoring an ambient `AWS_REGION`/`AWS_DEFAULT_REGION` only when it can serve that geo and falling back to the geo's default region otherwise — while explicit per-request and ARN-embedded regions still win and region-agnostic `global.` profiles stay unchanged.
- Fixed malformed tool calls (empty `name`) wedging entire sessions in HTTP 400 loops: when a model occasionally emits `{ "name": "", "arguments": "{}" }` (observed: GLM-5.2 + thinking on long turns), the agent rejected the call at execution time with `Tool  not found`, but the malformed block plus its error `toolResult` stayed in conversation history and every subsequent request 400'd on `tool_use.name`/`tool_calls[i].function.name` validation until the user ran `/clear`. `transformMessages` — the canonical sanitize boundary every provider passes through — now drops `toolCall` blocks with empty/whitespace `name`, pairs them with their `toolResult` messages only inside the same assistant→tool-result window (per-id FIFO queue cleared at non-result boundaries, so stale malformed calls without a result cannot consume later valid duplicate-id outputs), and drops the assistant turn when it has no replayable content left. Defensive (provider-agnostic, fires regardless of model), idempotent (no-op on a clean history), and self-healing (one round-trip after the fix lands sanitizes an already-poisoned session). ([#3458](https://github.com/can1357/oh-my-pi/issues/3458))

## [16.1.18] - 2026-06-25

### Added

- Added `listOAuthAccounts` for retrieving a read-only list of stored OAuth account identities
- Added `getOAuthAccessAt` to resolve an OAuth token exclusively for a specific account position

### Changed

- Refactored OAuth token persistence and disable logic to use stable credential IDs instead of positional indices to prevent race conditions during concurrent updates
- Updated OAuth failure classification to treat 403 status codes, rate limits, and network errors as transient, preventing unnecessary credential invalidation

### Fixed

- Fixed Codex Responses Lite staying enabled for image prompts, which caused GPT/Codex image turns to be rejected as `Invalid value: 'input_image'`; image-bearing Codex requests now fall back to the full Responses transport. ([#3421](https://github.com/can1357/oh-my-pi/issues/3421))
- Fixed the auth-broker background refresher disabling OAuth credentials unconditionally (`disableCredentialById`) on a definitive refresh failure, so a credential another process or a fresh login rotated mid-refresh could be torn down even though the stored row already held a valid token. The definitive-failure teardown now happens inside `AuthStorage.refreshCredentialById` via the same compare-and-set the in-stream and usage-probe paths use — it disables only when the persisted row still matches the credential the refresh actually attempted, and reloads on a CAS loss; the refresher now only logs.
- Fixed OAuth refresh persisting the rotated token by a positional index captured before the refresh `await`. A concurrent disable could reorder or shrink a provider's credential array while the refresh was in flight, landing the new token on the wrong row (or silently dropping it) and leaving accounts with a stale refresh token that failed — and was then disabled — on the next cycle. Refresh persistence, selection-index resync, and CAS-disable now address the row by id across `forceRefreshCredentialById`, candidate preflight, and in-stream selection (`#replaceCredentialById` / `#disableCredentialByIdIfMatches`).
- Fixed `isDefinitiveOAuthFailure` treating a bare HTTP 403 (and generic `unauthorized` / access-token-expired wording) as a definitive credential failure, which permanently disabled healthy OAuth accounts on WAF, egress rate-limit, permission, and account-verification responses. Bare 403, rate limits (429), gateway/5xx, and more network errors (`ECONNRESET`, `ETIMEDOUT`, `EAI_AGAIN`, …) are now classified transient; only explicit dead-grant errors (`invalid_grant`, `invalid_token`, `unauthorized_client`, revoked, `refresh token … expired`) or a bare 401 tear the credential down.

## [16.1.17] - 2026-06-24

### Added

- Added provider-level `notes?: string[]` field to `UsageReport` for disclaimers that apply to every limit (e.g. "OMP-observed spend only"). The field is declared in both the `usage.ts` schema and the auth-broker wire schema copy so it survives the `"+": "reject"` deserialization gate. ([#3268](https://github.com/can1357/oh-my-pi/issues/3268))

### Fixed

- Moved the OpenCode Go "OMP-observed spend only" disclaimer from per-limit `notes` to provider-level `notes`, so it renders once per provider instead of duplicating across every account × window. ([#3268](https://github.com/can1357/oh-my-pi/issues/3268))
- Fixed Anthropic rate-limit header usage cache entries retaining legacy missing account metadata after refresh.
- Fixed Anthropic-compatible budget-effort models dropping the selected effort before request serialization, so `output_config.effort` is emitted alongside `thinking.budget_tokens` when model metadata declares `mode: "anthropic-budget-effort"`.
- Fixed `anthropic-messages` silently dropping caller-supplied `Authorization` / `X-Api-Key` from `model.headers` and `ANTHROPIC_CUSTOM_HEADERS`, blocking custom proxy auth schemes. Non-OAuth requests now honor the caller's value (matching `openai-responses`); the lower-level client also suppresses its `X-Api-Key` add when a custom `Authorization` is supplied for a non-official endpoint so the proxy receives a single credential. OAuth bearer + Cloudflare AI Gateway keep their pre-existing enforced auth headers. ([#3391](https://github.com/can1357/oh-my-pi/issues/3391))
- Fixed Ollama Cloud `num_predict` ignoring the provider's 65536 output-token cap so stale `models.db` rows (or custom `modelOverrides` re-enabling output caps) that carried `maxTokens: 1048576` from a pre-omitMaxOutputTokens catalog 400'd every request with `max_tokens (1048576) exceeds model's maximum output tokens (65536) for model deepseek-v4-pro`. The Ollama provider now clamps `num_predict` for any `ollama-cloud` request at the documented 65536 cap before sending, independent of the cached spec's `maxTokens` and on top of the existing `omitMaxOutputTokens` policy — so the request stays valid even when the load-time policy never normalized the spec. Self-hosted `ollama` traffic is unaffected. ([#3392](https://github.com/can1357/oh-my-pi/issues/3392))
- Fixed OpenRouter Anthropic models on the Responses path omitting `cache_control`, so prompt caching engages without forcing Chat Completions. ([#3397](https://github.com/can1357/oh-my-pi/issues/3397))
- Fixed OpenRouter Anthropic Responses follow-up requests replaying prior reasoning items with stale signatures, which caused HTTP 400 `Invalid signature in thinking block` errors after a thinking turn. ([#3399](https://github.com/can1357/oh-my-pi/issues/3399))
- Fixed OpenRouter Anthropic models on the Responses path omitting `cache_control`, so prompt caching engages without forcing Chat Completions. `cacheRetention: "long"` now upgrades the breakpoint to `ttl: "1h"`. ([#3397](https://github.com/can1357/oh-my-pi/issues/3397))

## [16.1.16] - 2026-06-23

### Fixed

- Fixed Anthropic-compatible thinking requests sending replayed thinking blocks without `context_management.keep: "all"`, preserving multi-turn reasoning context for API-key providers. API-key requests now also advertise the required `context-management-2025-06-27` beta header so the field is honored instead of rejected. Injected SDK clients, GitHub Copilot's Anthropic proxy, and Vertex rawPredict are excluded because this code path cannot add the beta to caller-owned clients, Copilot strips Anthropic betas and demotes thinking blocks to text upstream, and Vertex expects betas in the JSON body rather than the Anthropic HTTP beta header. ([#3288](https://github.com/can1357/oh-my-pi/issues/3288))
- Fixed OpenRouter Responses native history replay leaking Gemini reasoning item `format` metadata back into follow-up requests, which caused HTTP 400 rejections while preserving encrypted reasoning replay.

## [16.1.15] - 2026-06-22

### Fixed

- Fixed API-key `/login` providers replacing sibling credentials instead of appending new keys for the same provider. ([#3265](https://github.com/can1357/oh-my-pi/issues/3265))
- Fixed OpenAI Codex OAuth account rotation for quota failures that surface as bare HTTP 429 or `insufficient_quota`, so pre-content failures temporarily block only the exhausted credential and retry a healthy sibling. The 429 status-only fallback applies only to absent/opaque bodies; informative transient bodies (`Too many requests`, `Service overloaded 529`, `Please retry in 5s`, …) defer to `parseRateLimitReason` and stay in the provider's own backoff layer instead of burning sibling credentials. ([#3231](https://github.com/can1357/oh-my-pi/issues/3231))

## [16.1.14] - 2026-06-22

### Added

- Added proxy support for model providers via `PI_PROXY` and `PI_PROXY_<PROVIDER>` variables
- Added `NO_PROXY` environment variable support for bypassing proxy configuration
- Added support for Sakana AI provider
- Added Sakana AI login and request base URL support for `SAKANA_*` / `FUGU_*` environment variables

### Changed

- Consolidated API key authentication logic across registry providers
- Disabled parallel tool calls for Devin provider requests

### Fixed

- Improved proxy bypass logic to correctly handle private IP ranges and local metadata services
- Enhanced memoization for proxy environment variable lookups to improve performance

## [16.1.13] - 2026-06-22

### Added

- Added support for Devin as a provider

### Changed

- Updated tool call arguments to use `Record<string, unknown>` and `unknown` for tool results

### Fixed

- Fixed OpenAI Responses native history replay dropping failed/incomplete image generation calls instead of resending their transient `ig_...` item IDs, preventing follow-up requests from failing with `404 Item with id ... not found`. ([#3225](https://github.com/can1357/oh-my-pi/issues/3225))
- Fixed `/login fireworks` rejecting valid `fw_…` keys with `Fireworks API key validation failed (500): Error listing deployed models`. The validator pinged `/inference/v1/models`, which Fireworks serves from the per-account deployment registry and 500s for accounts without active deployments. Login now hits the static control-plane `List Models` catalog (`GET /v1/accounts/fireworks/models?filter=supports_serverless=true&pageSize=1`) — the same endpoint discovery already uses — so authentication no longer depends on the caller's deployment state. ([#3219](https://github.com/can1357/oh-my-pi/issues/3219))

## [16.1.11] - 2026-06-21

### Fixed

- Fixed OpenAI Responses native history replay leaking image generation provider-only fields into the next request, which made OpenAI-compatible proxies reject `pi` tool-calling sessions with `Unknown parameter: input[1].action`. ([#3201](https://github.com/can1357/oh-my-pi/issues/3201))
- Fixed a stream thought-leakage issue for `gemini-3.5-flash` where the model's internal reasoning JSON could leak into the visible text stream. The stream parser now uses a brace-balanced counting algorithm to accurately slice and discard the leading thought JSON block, with a robust fallback for unescaped double quotes, dynamic tool-name derivation, and preservation of subsequent text deltas without triggering empty-response retries.

## [16.1.10] - 2026-06-21

### Changed

- Improved JSON robustness by replacing external dependency with a custom, high-performance parser
- Strengthened streaming JSON parsing to prevent non-finite numbers from surfacing as `undefined/NaN`
- Configured JSON parser to reject JS-specific `NaN` and `Infinity` values for tool arguments
- Replaced the JSON repair/parse helpers (`parseJsonWithRepair`, `parseStreamingJson`) with a single from-scratch tolerant parser (`RelaxedJson`) that accepts single-quoted strings, unquoted object keys, trailing/stray commas, `//` and `/* */` comments, Python `True`/`False`/`None`, raw control characters, invalid escapes, and unescaped apostrophes (`'it's'`). Final parsing still throws on truncated/garbage input (so a malformed tool call is skipped rather than executed with half-formed args) and rejects JS-only `NaN`/`Infinity`; streaming parsing stays non-throwing and rolls back incomplete trailing tokens instead of surfacing `undefined`/`NaN`. The Cursor provider's ad-hoc regex + JSON5 tool-argument parser now routes through the shared parser.

### Fixed

- Fixed tool call ID normalization for Anthropic-compatible models
- Fixed Anthropic Messages replay sanitizing malformed tool-call IDs, including aborted native tool calls with empty IDs, so retries no longer send invalid `tool_use.id` / `tool_result.tool_use_id` pairs.
- Fixed the Codex Responses WebSocket transport attributing a prior turn's output to the current one on a reused connection: a trailing/duplicate frame from a cleanly-completed previous response that slipped past the queue drain could be consumed as this request's terminal (ending the turn with empty output) or as a stale tool call. Frames are now keyed by `response.id` — a frame carrying the previous response's id is dropped, and one carrying a third id (or a regressed `sequence_number`) fails closed so the turn retries instead of mixing two responses' streams. Idless frames (deltas, the rate-limit/metadata preamble, `response.created`-less streams) still pass through, matching upstream codex-rs.
- Fixed `transformMessages` pulling an earlier, orphaned tool result onto a later tool call that reused the same id (left behind when compaction folded the originating `tool_use` into a summary). The pending-call flush now pairs each call with a result positioned *after* its assistant turn, so a reused id surfaces its own output rather than a prior turn's.
- Fixed DashScope 429 rate-limit messages that mention authorization being classified as credential failures, preventing valid API keys from being invalidated after throttling. ([#3172](https://github.com/can1357/oh-my-pi/issues/3172))
- Fixed OpenCode Go `401 Insufficient balance` quota errors being treated as unknown failures instead of usage-limit errors, restoring credential rotation and fallback chains. ([#3169](https://github.com/can1357/oh-my-pi/issues/3169))

### Removed

- Removed the `partial-json` dependency; streaming JSON parsing now uses the in-house `RelaxedJson` parser.

## [16.1.9] - 2026-06-21

### Added

- Added `llama.cpp` to the interactive `/login` provider list, accepting an optional API key while defaulting to local no-auth mode.

### Changed

- Optimized generated AI tool schemas by collapsing verbose `anyOf` unions into standard `enum` types

### Fixed

- Fixed tool-call argument validation dropping nested keys that were accidentally double-encoded
- Fixed the `moonshot` provider being locked to the international Kimi host (`api.moonshot.ai`): OpenAI-completions requests now honor a `MOONSHOT_BASE_URL` override so users can reach the Kimi China platform (`api.moonshot.cn`), which rejects keys issued for the international endpoint. ([#2883](https://github.com/can1357/oh-my-pi/issues/2883))
- Fixed tool-call argument validation dropping fields whose object keys were accidentally JSON-encoded a second time (e.g. `{ "\"op\"": "done" }`), which surfaced as spurious missing-required errors. A schema-agnostic pre-validation pass now recursively unwraps such double-encoded keys — through arrays and nested objects, and again after a JSON-string container is parsed — before the unrecognized-key repair can delete them.

### Removed

- Removed the `setNextRequestDebugPath`, `clearNextRequestDebugPath`, and `getNextRequestDebugPath` utility functions for request debugging, as request/response recording now relies exclusively on the `PI_REQ_DEBUG` environment variable.
- Removed Wafer Pass (`wafer-pass`) login support; Wafer Serverless remains available as `wafer-serverless`.

## [16.1.8] - 2026-06-20

### Changed

- Changed OpenAI Responses and Codex Responses custom grammar tool requests to leave `parallel_tool_calls` unset instead of forcing serial tool calls; Codex `responsesLite` still disables parallel tool calls when tools are present.

### Fixed

- Fixed Bedrock `/btw` and other no-tool ephemeral turns failing after prior tool calls by sending the required sentinel `toolConfig` whenever replayed history contains `toolUse`/`toolResult` blocks. ([#3124](https://github.com/can1357/oh-my-pi/issues/3124))
- Fixed Anthropic Messages pre-content TLS `bad record MAC` server transport errors surfacing before the provider retry loop exhausts its budget. ([#3134](https://github.com/can1357/oh-my-pi/issues/3134))
- Fixed API-key login flows replacing existing stored keys for the same provider, so providers such as NVIDIA NIM can keep multiple active keys available for session-level rotation. ([#2923](https://github.com/can1357/oh-my-pi/issues/2923))
- Fixed `openai-codex-responses` forwarding sampling controls (`temperature`, `top_p`, `top_k`, `min_p`, `presence_penalty`, `repetition_penalty`) into the Codex request body — the ChatGPT-subscription Codex backend rejects each of them with a 400 `{"detail":"Unsupported parameter: temperature"}`, so any caller setting non-default `StreamOptions` saw every turn fail. The provider now drops the full sampling set (matching codex-rs), and the auth-gateway's defensive strip on both `buildStreamOptions` and the pi-native path was widened from `{temperature, topP}` to the same set plus `stopSequences`/`frequencyPenalty`. ([#3117](https://github.com/can1357/oh-my-pi/issues/3117))
- Fixed Anthropic Messages retry classification for transient TLS/server-error failures such as `tls: bad record MAC (type=server_error)`. These pre-content transport blips are now retried inside the provider loop before the session sees an error banner.

## [16.1.4] - 2026-06-19

### Added

- Added bounded auto-retry for empty assistant completions specifically to the OpenAI Responses provider
- Added bounded auto-retry for empty assistant completions across the OpenAI Chat Completions, OpenAI Responses, and Anthropic Messages providers. A benign terminal stop that streamed no content and billed no output tokens — the signature of a flaky OpenAI-/Anthropic-compatible gateway that intermittently 200s with an empty body — is now retried up to twice with exponential backoff (honoring `providerRetryWait`) before being surfaced, instead of silently stalling the agent loop. Retries fire only before any content streams, so live streaming (including thinking) is never delayed, retried, or duplicated.

### Fixed

- Fixed the Antigravity (`google-antigravity`) request builder dropping `labels.model_enum` when the wire profile does not declare one. Required for Claude 4.6 ids whose `AntigravityModelWireProfile` carries only `maxOutputTokens` (no captured `model_enum`); the label is now emitted only when the catalog defines it. ([#3067](https://github.com/can1357/oh-my-pi/issues/3067))

## [16.1.3] - 2026-06-19

### Added

- Added regression test pinning that `openai-completions` emits a `thinking` block for `reasoning_content` deltas even when `delta.content` is explicitly JSON `null` (the DeepSeek-format dual-key pattern used by custom GLM/Qwen reasoning providers). See [#2996](https://github.com/can1357/oh-my-pi/issues/2996).

### Changed

- Improved the thinking loop guard to treat assistant text loops as retryable errors
- Refined text normalization logic to reduce false positives in the thinking loop detector

### Fixed

- Fixed Ollama chat requests sending image payloads to text-only models. Image blocks are now omitted and replaced with the standard non-vision placeholder for models without vision support, while vision-capable Ollama models continue to receive images. ([#3009](https://github.com/can1357/oh-my-pi/pull/3009) by [@serverinspector](https://github.com/serverinspector))
- Fixed `SqliteAuthCredentialStore.close()` leaking one-off prepared statements created by inline `this.#db.prepare()` calls in `#authCredentialsTableExists`, `#readAuthSchemaVersion`, `#inferAuthSchemaVersion`, `#migrateAuthSchemaV0ToV1`, `#backfillCredentialIdentityKeys`, and `updateAuthCredential`. Each statement is now wrapped in `try/finally` with `stmt.finalize()`, and the `close()` method finalizes `#insertUsageCostStmt` and `#listUsageCostsStmt` which were previously missed. This caused EBUSY on Windows when tests tried to delete temp dirs containing open SQLite handles.

## [16.1.2] - 2026-06-19

### Added

- Added improved JSON repair capabilities for Anthropic tool arguments
- Added authentication broker discovery to sync credentials between local SQLite and remote state

### Fixed

- Improved error feedback and transparency for malformed Anthropic tool call arguments
- Added automatic fallback for unsupported OpenAI reasoning effort levels
- Improved reliability when handling invalid reasoning parameter errors across OpenAI-compatible APIs
- Fixed OpenAI-compatible Chat Completions, Responses, and Azure Responses requests to retry once with the nearest provider-supported reasoning effort when an endpoint rejects `xhigh`/`minimal`-style effort values.

## [16.1.0] - 2026-06-19

### Added

- Added utility functions to strip schema descriptions for optimized LLM context usage

## [16.0.10] - 2026-06-18

### Added

- Replaced the old legacy XML-ish `pi` owned tool-calling dialect with the new sigil-delimited format (`§` call header with inline `key=value` scalars, `«…»` verbatim body fence for the dominant string argument, `¤` reasoning, `‡‡` tool result) using single-token markers that never occur in source code. Verbatim fences escalate Markdown-style (`««…»»`) so re-rendered history never collides with payload content, and the scanner gates a bare `§` on an exact known-tool name to avoid swallowing prose. Round-trips and streams through the existing scanner contract at ~46% fewer tokens than the legacy format on typical calls; selectable via `tools.format` or `PI_DIALECT=pi`.

### Changed

- Updated `pi` dialect formatting to use a token-frugal, sigil-delimited format (`§`, `¤`, `‡‡`)
- Updated `pi` dialect body fences to automatically escalate when content contains fence markers
- Changed `pi` dialect tool results response format to `‡‡` blocks

### Fixed

- Fixed Bedrock application inference profile ARNs to route requests to the ARN's region instead of the default Bedrock runtime region. ([#3004](https://github.com/can1357/oh-my-pi/issues/3004))

## [16.0.9] - 2026-06-18

### Fixed

- Fixed OAuth login replacing all other active accounts for the same provider, allowing multiple OAuth accounts to coexist concurrently.
- Fixed legacy `api_key` credentials not being replaced/disabled atomically upon upgrading to OAuth login.
- Fixed a logic issue where AuthStorage lost session-to-credential stickiness upon CLI restarts, causing cold-starts for server-side prompt cache (KV cache) and wasting tokens.
- Fixed GitHub Copilot Responses requests rejecting image inputs that carry the `detail: "original"` hint with an HTTP 400 by degrading the hint to `"auto"` for hosts that do not support it; other hosts still preserve native-resolution frames (snapcompact). ([#2822](https://github.com/can1357/oh-my-pi/issues/2822))

## [16.0.8] - 2026-06-18

### Fixed

- Improved reliability of auth-broker snapshot loading by implementing a robust manual schema check
- Fixed MCP tool argument validation to drop optional empty-string parameters before schema validation, matching the existing optional null handling and avoiding pattern/type failures for omitted model-filled fields. ([#2981](https://github.com/can1357/oh-my-pi/issues/2981))
- Fixed API-key credential replacement to hard-delete superseded disabled `api_key` rows so `auth_credentials` does not grow indefinitely after key rotation. ([#2941](https://github.com/can1357/oh-my-pi/issues/2941))
- Fixed Cursor provider streaming to close text blocks before tool calls so post-tool text opens a new content block and TUI transcript cards render inline instead of grouped near the bottom. ([#2924](https://github.com/can1357/oh-my-pi/issues/2924))

## [16.0.7] - 2026-06-18

### Changed

- Switched Google OAuth callback hostname from `localhost` to `127.0.0.1` to prevent IPv6 loopback fallback delays and proxy routing interception.

### Fixed

- Fixed OpenCode Go usage reporting to synthesize `/usage` limits from OMP-observed request costs for the 5h, weekly, and monthly provider caps. ([#2942](https://github.com/can1357/oh-my-pi/issues/2942))
- Fixed MiniMax Anthropic-compatible requests to serialize adaptive thinking without an invalid Anthropic `output_config.effort` tier ([#2928](https://github.com/can1357/oh-my-pi/issues/2928)).

## [16.0.6] - 2026-06-18

### Added

- Added support for ArkType schemas as tool parameters alongside existing Zod schemas
- Added `getOpenRouterHeaders` utility to export standard OpenRouter integration headers

### Changed

- Expanded thinking loop detection guard to also cover DeepSeek models (family, provider, or id matches).
- Extended loop guard to monitor assistant response prose (via `text_delta` events) in addition to thinking logs, customizable via request options.
- Modified loop guard error reporting to emit a non-retryable partial content block containing the accumulated streamed text if a loop is detected after response prose has started streaming, preventing unsafe agent session rollbacks.
- Migrated internal wire-schema validation (auth-broker, Anthropic Messages request, OpenAI Chat/Responses requests, and /v1/usage shapes) from Zod to ArkType
- Replaced the dedicated `xai-responses` provider with a unified `openai-responses` path that handles xAI-specific reasoning effort stripping dynamically
- Updated OpenAI Responses stream handling to throw a clearer error message when a stream closes without a terminal response event
- Consolidated shared OpenAI-compatible routing and strict-tool fallback helpers across Chat Completions and Responses providers.
- Consolidated the OpenAI-family provider stack: merged `openai-responses-shared` into `openai-shared` and removed the now-dead `openai-responses-shared` re-export shim; folded the three duplicated `service_tier` request blocks and the per-provider wire model-id transform into shared `applyOpenAIServiceTier`/`applyWireModelIdTransform` helpers; moved residual provider-name wire-quirk checks (DeepSeek special-token strip, cumulative reasoning deltas, Ollama empty-length context error, OpenAI tool-call-id cap, Fireworks thinking drop, OpenRouter/OpenAI Responses request fields) into resolved compat fields; shared the Responses stream per-block accumulation helpers plus the terminal pending-tool-call finalization (`finalizePendingResponsesToolCalls`) and toolUse/pause stop-reason promotion (`promoteResponsesToolUseStopReason`) between `processResponsesStream` and the Codex stream handler; and removed the redundant `getOpenAIResponsesCacheSessionId` alias in favor of `getOpenAIResponsesPromptCacheKey`.
- Centralized OpenAI-family request-param policy into shared `resolveOpenAIOutputTokenParam` (output-token field selection, OpenRouter default-cap omission, `alwaysSendMaxTokens` defaulting, model/provider clamp), `applyOpenAIGatewayRouting` (OpenRouter `provider` + Vercel AI Gateway `providerOptions`), and `applyOpenAIExtraBody` (extra-body merge + Fireworks thinking drop) helpers used by both Chat Completions and Responses `buildParams`, and moved the Chat Completions reasoning/thinking dialect dispatch (`applyChatCompletionsReasoningParams` + `disableChatCompletionsReasoningForDialect`) plus the `OpenAICompletionsParams` request type into `openai-shared` alongside `applyResponsesReasoningParams`. As a consistency consequence, direct `streamOpenAIResponses` calls (bypassing `streamSimple`) now emit `max_output_tokens` for `alwaysSendMaxTokens` (Kimi-family) models even without a caller cap — matching Chat Completions and the value `streamSimple` already supplied.
- Centralized OpenAI-family reasoning compat resolution behind a shared `resolveOpenAICompatPolicy` consumed by both Chat Completions and Responses request builders. Shared policy now drives tool-choice reasoning suppression, dialect-specific disable encoding, reasoning-history replay filters, encrypted-reasoning inclusion, Mistral/OpenAI tool-call-id modes, stream healing/DeepSeek token stripping, and xAI/OpenRouter cache-affinity wiring instead of endpoint-local provider/model checks.

### Fixed

- Fixed OpenAI Responses cost accounting to apply standard service-tier pricing multipliers (flex 0.5×, priority 2×) to the calculated cost based on the served (or requested) service tier for provider `"openai"` models.
- Fixed OpenAI Chat Completions to consume the dedicated `requiresReasoningContentForAllAssistantTurns` compatibility flag, preventing unnecessary reasoning replay on non-tool-call turns for OpenRouter DeepSeek and OpenCode models.
- Fixed the Kimi Code and Synthetic dual-surface shim (`streamOpenAIAnthropicShim`) to correctly forward caller-supplied `toolChoice`, `serviceTier`, and `disableReasoning` options.
- Fixed the OpenAI Responses tool-choice compatibility helper to drop `tool_choice` when `supportsToolChoice` is false, and downgrade forced choices to `"auto"` when `supportsForcedToolChoice` is false.
- Fixed Azure Responses to avoid emitting `tool_choice: "none"` when `context.tools` is empty.
- Fixed Kimi via OpenRouter forced-tool requests to omit the OpenRouter `reasoning` object instead of sending `reasoning: { enabled: false }`, preserving the generic OpenRouter explicit-disable behavior while avoiding Kimi's forced-tool reasoning conflict.
- Fixed Google Gemini CLI credential parsing schema to gracefully handle empty or unexpected non-string shapes without throwing unhandled exceptions
- Fixed Google Gemini CLI credential parsing to correctly prioritize `projectId` over `project_id` even when empty, and drop non-string values gracefully
- Fixed OpenRouter Responses requests to omit default max token fields unless an explicit caller cap is provided, preventing upstream filtering issues
- Fixed Chat Completions reasoning suppression (`disableReasoningOnToolChoice` / `disableReasoningOnForcedToolChoice`) to turn thinking off symmetrically across every dialect via a shared `disableChatCompletionsReasoningForDialect` helper. Previously the conflict path only deleted `reasoning_effort`/`reasoning` (and set Z.AI `thinking: { type: "disabled" }` on the forced branch alone), leaving Qwen `enable_thinking`, Qwen chat-template `chat_template_kwargs.enable_thinking`, and OpenRouter nested `reasoning` enabled — so those hosts could keep thinking on under forced/required tool choice and re-trip the incompatibility the policy guards against. OpenRouter is now set to `{ reasoning: { enabled: false } }` (not deleted, which OpenRouter treats as default-on).
- Fixed OpenRouter Responses requests to send `session_id` from `sessionId` in the request body for sticky provider routing and observability grouping.
- Fixed OpenRouter Responses request shaping to preserve provider routing, variant suffixes, caller header overrides, and strict-tool fallback behavior while omitting only unsafe default max-token caps.
- Fixed OpenAI Responses stateful chaining so a non-ZDR stale `previous_response_id` retry keeps `store: true`: the full-context retry stays chainable on the next turn and the consecutive stale-failure circuit breaker trips after the configured limit instead of alternating cold turns. Zero Data Retention rejections still disable chaining on the first strike.
- Fixed Anthropic Messages tool schema normalization demoting root `anyOf`/`allOf` and all `oneOf` constraints into descriptions instead of forwarding provider-rejected keywords in MCP tool `input_schema`.
- Fixed Ollama Cloud GLM-5.2 reasoning efforts to map `xhigh` to native think `"max"` ([#2911](https://github.com/can1357/oh-my-pi/pull/2911) by [@serverinspector](https://github.com/serverinspector))
- Fixed OpenRouter Responses requests tagging the streamed assistant message with a hardcoded `openai-responses` API instead of the runtime `model.api`, which silently disabled native-history replay (`buildResponsesInput`) and cross-model tool-call item-id stripping on subsequent OpenRouter turns. The message now carries `model.api` (matching the Chat Completions path).
- Fixed OpenAI-family streaming leaking a pre-retry `errorMessage` onto a successful turn: the OpenRouter Anthropic compiled-grammar strict-tool fallback set `errorMessage` before retrying with strict tools disabled and never cleared it on success, and the Chat Completions success path could carry an `errorMessage` from an internally-retried attempt — both made a successful turn read as errored in agent state and telemetry. The Responses fallback no longer assigns `errorMessage`, and the Completions success path clears it before emitting the terminal `done` event.
- Fixed Codex stream-error `.code` resolution to use the same nested-first precedence (`error.code` → `error.type` → top-level `code`) as `isRetryableCodexFailureEvent` and the formatted message. Previously the error factory resolved top-level-first, so a failure event carrying both a top-level and a differing nested error code surfaced a `.code` that could disagree with its own `retryable` flag and message text.

## [16.0.5] - 2026-06-17

### Added

- Added `antigravityEndpointMode` stream option with `auto`, `production`, and `sandbox` values to control Antigravity endpoint routing
- Added `seedApiKeyResolver` for reusing a pre-resolved request key while preserving resolver-driven auth retry and credential rotation
- Added optional `contextSnapshot` property to `AssistantMessage` with token usage metadata via new `ContextSnapshot` interface (`promptTokens`, `nonMessageTokens`, and optional `lastMessageTimestamp`)
- Added `LITELLM_BASE_URL` guidance to the LiteLLM login prompt so non-default proxy endpoints are discoverable. ([#2726](https://github.com/can1357/oh-my-pi/issues/2726))
- Added a Gemini thinking-loop guard that watches streamed `thinking` deltas for degenerate reasoning loops — verbatim tail repetition and near-duplicate paragraph cycling — and terminates the stream with a retryable, empty-content `error` message (worded as a transient stream stall) so the turn is discarded and re-sampled instead of committing a runaway transcript. Gated to Gemini models across every transport (OpenRouter, direct Google, Vertex) and disarmed once visible answer text or a tool call starts; disable with `PI_NO_THINKING_LOOP_GUARD=1`.

### Changed

- Changed the Antigravity (`google-antigravity`) request builder to mirror the captured `antigravity/hub` client: gemini-3.x send `thinkingConfig.thinkingBudget` per tier, a fixed per-model `maxOutputTokens`, a default `functionCallingConfig.mode: "VALIDATED"` tool mode (auto/unset tool choice only), a `role: "user"` system instruction, a structured `requestId` (`agent/<id>/<ts>/<trajectoryId>/<step>`), and `labels` (`model_enum`, `trajectory_id`, `last_step_index`, `last_execution_id`, `used_claude*`) tracked across the conversation via provider session state.

### Fixed

- Fixed Gemini usage-tier mapping so `gemini-3.5-flash` is treated as `Flash` and `gemini-3.1-pro` plus `gemini-pro-agent` are treated as `Pro` in usage accounting
- Fixed Antigravity stream state handling so a request’s `last_execution_id` is committed only after a successful completion and cleared between retry attempts
- Fixed `streamSimple()` Gemini streams to run through the thinking-loop guard for custom API and pi-native transports, so degenerate `thinking` loops now abort with the same retryable empty-content error path as other Gemini stream paths
- Fixed Antigravity model streaming and usage fetch paths to retry on transient `429`/`5xx` errors by failing over to the alternate endpoint before surfacing an error
- Fixed Antigravity endpoint tracking to prefer a previously successful endpoint in `auto` mode for subsequent requests
- Fixed Antigravity and Gemini CLI model requests failing with an opaque error when Google requires account verification. Cloud Code Assist `403 VALIDATION_REQUIRED` responses now surface the `validation_url` and the signed-in account email when available, so users see an actionable account-verification message instead of the raw API error body.
- Fixed MiniMax M3 in-band tool calls by adding a MiniMax dialect that parses `<minimax:tool_call>` wrappers instead of falling back to generic XML. ([#2759](https://github.com/can1357/oh-my-pi/issues/2759))
- Fixed GitHub Copilot OAuth for Business seats by storing the login-discovered API endpoint and routing model enablement plus chat requests to that endpoint. ([#2876](https://github.com/can1357/oh-my-pi/issues/2876))

## [16.0.4] - 2026-06-17

### Fixed

- Fixed tool argument coercion to parse double-encoded JSON strings, including quoted values like `"300"`, when schema expects a number
- Fixed object-array coercion to parse JSON object and array strings into proper array arguments instead of wrapping raw strings
- Fixed handling of malformed JSON container strings for array schema fields so validation now surfaces a top-level `expected array, received string` error rather than nested element errors
- Fixed ChatGPT/Codex browser login missing connector OAuth scopes and rendering object-shaped token endpoint errors as `[object Object]`. ([#2825](https://github.com/can1357/oh-my-pi/issues/2825))
- Fixed Zhipu/BigModel GLM-5.2 chat-completions requests so internal `xhigh` effort serializes as provider-native `reasoning_effort: "max"` and tool calls opt into `tool_stream`. ([#2833](https://github.com/can1357/oh-my-pi/issues/2833))
- Fixed Google Gemini CLI and Antigravity tool calls with `toolChoice: "auto"` serializing an explicit `toolConfig` AUTO mode, which can cause Gemini-3 models to leak raw planning JSON instead of executing tools. ([#2830](https://github.com/can1357/oh-my-pi/issues/2830))

## [16.0.3] - 2026-06-16

### Added

- Exported `renderDelimitedThinking` from the `@pk-nerdsaver-ai/pi-ai/dialect` barrel so consumers can reuse the dialect's `<thinking>` envelope unwrap-and-rewrap logic (the only `./dialect/rendering` primitive re-exported; the rest stay dialect-internal).

### Fixed

- Fixed OpenAI Responses/Codex tool schema normalization stripping provider-rejected regex lookaround patterns from MCP tool parameter schemas. ([#2784](https://github.com/can1357/oh-my-pi/issues/2784))
- Fixed OpenAI Responses parallel tool-call routing so late keyed argument deltas for a closed call are dropped instead of being appended to another open call.

## [16.0.2] - 2026-06-16

### Added

- Added `UMANS_WEBSEARCH_PROVIDER=native|exa` support for routing Umans gateway-owned web search requests.

### Fixed

- A single MCP tool whose input schema can't be emitted as a valid strict tool schema for the active provider no longer fails the whole turn with HTTP 400. `convertTools` (openai-responses) now validates each tool's emitted parameter schema for `enum`/`const`-vs-`type` contradictions that pass structural JSON-Schema validation but the provider rejects — e.g. a non-null `enum` on a `type: "null"` node, or an `enum` on an `array` node — and quarantines just the offending tool with a `logger.warn` naming the tool and schema path, keeping every other tool usable. Adds `findStrictToolSchemaViolation` to `@pk-nerdsaver-ai/pi-ai/utils/schema` ([#2652](https://github.com/can1357/oh-my-pi/issues/2652))
- Fixed OpenAI Responses-compatible streams from Ollama/local hosts dropping arguments for parallel tool calls whose deltas use `fc_<call_id>` item ids, which left earlier `ast_grep` calls with `{}` and failed validation. ([#2715](https://github.com/can1357/oh-my-pi/issues/2715))
- Fixed dialect transcript rendering so literal thinking envelopes are unwrapped before adding the dialect's own thinking tags, preventing nested `<thinking>` output in advisor raw dumps ([#2700](https://github.com/can1357/oh-my-pi/issues/2700)).
- Fixed Anthropic-compatible Umans requests escaping client tool names and forwarding gateway web search headers so Kimi answers normally instead of returning raw gateway search results.
- Fixed Google Gemini tool calls with `toolChoice: "auto"` serializing an explicit `toolConfig` AUTO mode, which can cause Gemini-3 models to leak raw planning JSON instead of executing tools. ([#2776](https://github.com/can1357/oh-my-pi/issues/2776))
- Fixed OpenAI-compatible Ollama completions that return empty `finish_reason:length` after filling `num_ctx` so they surface an actionable context-window error instead of an empty length stop. ([#2774](https://github.com/can1357/oh-my-pi/issues/2774))
- Fixed Codex browser login issuing credentials for the `opencode` OAuth originator while OMP requests identify as `pi`, which could make the first authenticated Codex request return 401 ([#2696](https://github.com/can1357/oh-my-pi/issues/2696)).

## [16.0.1] - 2026-06-15

### Added

- Added Umans AI Coding Plan API-key login support and `UMANS_AI_CODING_PLAN_API_KEY` environment fallback ([#2636](https://github.com/can1357/oh-my-pi/pull/2636) by [@oldschoola](https://github.com/oldschoola)).

### Fixed

- Fixed OpenAI Responses, Azure OpenAI Responses, and Codex Responses providers ignoring async `onPayload` replacement bodies. Provider payload hooks can now transform the actual request body sent upstream, matching the Anthropic/Gemini replacement contract.
- Fixed OpenAI-compatible chat-completions streams that send object-shaped tool arguments in fragments by deep-merging nested objects and task arrays instead of replacing earlier chunks. ([#2617](https://github.com/can1357/oh-my-pi/issues/2617))
- Fixed OpenAI Responses strict-mode tool schema normalization for nullable enum MCP parameters so enum constraints are distributed to matching `anyOf` branches instead of being copied onto the `null` branch. ([#1835](https://github.com/can1357/oh-my-pi/issues/1835))
- Fixed Cursor provider formatting tool errors with the same `[Tool Result]` prefix as successful results, causing Composer models to misinterpret error messages (e.g. "Pattern must not be empty") as directives over long conversations. Errors now use a `[Tool Error]` prefix so the model can distinguish failures from successes in the prompt history. ([#1853](https://github.com/can1357/oh-my-pi/pull/1853))
- Fixed `validateToolArguments` silently accepting JSON-encoded array strings (e.g. `'["a","b"]'`) against `union(string, array<string>)` schemas — providers that double-serialize tool-call arguments (Z.AI / GLM) caused tools like `search` to receive the literal `["a","b"]` as a single path, producing zero matches (single element) or glob parse errors (multi-element). A new pre-validation pass parses JSON-array-shaped strings when the schema explicitly accepts both shapes. ([#1788](https://github.com/can1357/oh-my-pi/issues/1788))
- Fixed Anthropic thinking summaries that arrive wrapped in literal `<thinking>` tags so advisor/raw transcript dumps do not render nested thinking tags ([#2695](https://github.com/can1357/oh-my-pi/issues/2695)).

## [16.0.0] - 2026-06-15

### Breaking Changes

- Renamed the public dialect entrypoint from `@pk-nerdsaver-ai/pi-ai/grammar` to `@pk-nerdsaver-ai/pi-ai/dialect`.
- Renamed grammar dialect identifiers from `ToolCallSyntax` to `Dialect`, renamed the `Grammar` interface to `DialectDefinition`, and renamed `Grammar.syntax` to `DialectDefinition.dialect`.
- Added `DialectDefinition.renderThinking` and `DialectDefinition.renderTranscript` so dialect implementations serialize complete native chat transcripts, not just tool call/result blocks.

### Added

- Added `renderTranscript` method to dialect definitions for serializing complete native chat transcripts
- Added `renderThinking` method to dialect definitions for rendering thinking/reasoning blocks
- Added support for 11 dialect implementations: Anthropic, DeepSeek, Gemini, Gemma, GLM, Harmony, Hermes, Kimi, Pi-native, Qwen3, and XML
- Added `createInbandScanner` factory function to instantiate dialect-specific scanners
- Added `getDialectDefinition` function to retrieve dialect implementations by name
- Added `renderToolCatalog` and `renderInbandToolPrompt` functions for tool catalog rendering
- Added `renderToolInventory` function to generate human-readable per-tool documentation with examples
- Added `renderToolExamples` function to render tool usage examples in the model's native dialect
- Added `encodeInbandToolHistory` function to encode tool call history in dialect-specific format
- Added `wrapInbandToolStream` function to process streaming responses with in-band tool call parsing
- Added `ThinkingInbandScanner` for parsing thinking/reasoning blocks across dialects
- Added `OwnedStream` class for managing dialect-aware streaming with tool call events
- Added in-band thinking channels to every dialect that was missing one: `gemini` (a ```` ```thinking ```` fence mirroring ```` ```tool_code ````), `gemma` (its native `<|channel>thought…<channel|>` reasoning channel), `kimi` (`<think>…</think>`), and `pi` (`<thinking>…</thinking>`). Each scanner now parses reasoning into thinking events instead of leaking chain-of-thought into the visible reply, and every dialect's `renderThinking` is a real channel that round-trips back through its scanner (no passthrough renderers).

### Changed

- Moved public dialect entrypoint from `@pk-nerdsaver-ai/pi-ai/grammar` to `@pk-nerdsaver-ai/pi-ai/dialect` in package exports
- Updated internal imports in `stream-markup-healing.ts` to use new dialect module path
- Changed `renderToolInventory` to demote a tool description's own markdown headers by one level when it contains a top-level `# ` header, so they nest under the wrapping `# Tool: <name>` heading instead of reading as sibling sections. Descriptions that already start at `##` and headers inside fenced code blocks are left untouched.

### Fixed

- Fixed Gemini, Gemma, Kimi, and Pi in-band scanners to respect `parseThinking: false`, leaving private reasoning markers in visible text when parsing is disabled
- Fixed thinking-channel parsing for streaming Gemini, Gemma, Kimi, and Pi outputs so split or partial `<thinking>` blocks no longer leak into visible replies
- Fixed in-band thinking finalization and Kimi stream-healing interactions so leaked `<think>` blocks are preserved when structured tool calls are present, not duplicated when explicit reasoning is present, and closed on stream flush.

### Removed

- Removed `src/grammar/factory.ts` (replaced by `src/dialect/factory.ts`)
- Removed `src/grammar/rendering.ts` (functionality moved to `src/dialect/rendering.ts`)
- Removed `src/grammar/xml.ts` (replaced by `src/dialect/xml.ts`)

## [15.13.3] - 2026-06-15

### Added

- Added the `gemini` in-band tool-call syntax with Python-style ```tool_code``` blocks and `default_api` invocations
- Added the `gemma` token-delimited in-band tool-call syntax using `<|tool_call>` and `<|tool_response>` blocks
- Added `gemini` and `gemma` to owned stream tool-result token detection so their tool responses are recognized
- Fixed truncated Gemini and Gemma tool blocks from being emitted as plain text during streaming
- Added the Azure OpenAI provider definition (`azure`) to the registry; `AZURE_OPENAI_API_KEY` resolves as its env-var API key via the catalog provider table.

### Changed

- Gemini tool-call examples now render without the `default_api.` namespace prefix, keeping `<example>` blocks concise. The live wire format still uses `default_api.` per the Gemini grammar.

### Fixed

- Fixed duplicate tool call projections by deduplicating provider-native `toolCall` events against in-band `tool_code` calls and keeping only the first real channel
- Dropped nameless native `toolCall` events so they no longer appear as surfaced tool calls in owned-mode streams
- Fixed truncated Gemini and Gemma tool blocks from being emitted as plain text during streaming
- Fixed Gemini/Gemma in-band tool-call parsing around Python comments, raw/unicode string literals, and Gemma close-token text inside string values.

## [15.13.2] - 2026-06-15

### Added

- Added `jsonSchemaToTypeScript` to `@pk-nerdsaver-ai/pi-ai/utils/schema` to render JSON Schema argument shapes as compact, human-readable TypeScript-style signatures
- Added the generic `ToolExample` type (`ToolCallExample`/`ToolCompareExample`/`ToolNoteExample`, parameterized over a tool's argument shape) and an `examples` property on the `Tool` interface for defining tool-call examples once as data.
- Added `renderToolExamples` (via `@pk-nerdsaver-ai/pi-ai/grammar`) to render a tool's examples into an `<examples>` block in the model's native tool-call syntax, with an optional `_i` intent-field placeholder injected when intent tracing is active.
- Added per-grammar `renderToolCall` rendering of a single tool-call invocation (the inner element only, without the parallel-call block envelope), distinct from `renderAssistantToolCalls` which renders a complete block of one or more parallel calls.
- Added a `GrammarRenderOptions.example` flag to `renderToolCall`: when set, the invocation renders as the bare payload — Harmony emits just the JSON arguments, dropping the verbose `<|start|>…<|message|>…<|call|>` envelope — so `renderToolExamples` keeps `<examples>` blocks legible.
- Added an `abortOnFabrication` parameter to `wrapInbandToolStream` (default `true`): when `false`, a fabricated in-band tool-result continuation is discarded without aborting the provider request instead of cutting the turn short.
- Added `@pk-nerdsaver-ai/pi-ai/utils/harmony-leak` export with helpers to detect, audit, and recover GPT-5 Harmony tool-call header leaks
- Added the `@pk-nerdsaver-ai/pi-ai/grammar` public entrypoint for grammar factories, prompt/call rendering, in-band scanning, history encoding, and related typed utilities
- Added a unified in-band tool-call grammar engine with syntax-owned scanners, prompts, history rendering, tool-result rendering, and stream adaptation for GLM, Hermes/Qwen, Kimi, XML/Anthropic, DeepSeek, Harmony, and pi-native formats.

### Changed

- Changed Harmony in-band tool-call rendering to omit the `<|constrain|>json` marker before the payload in `commentary` channel calls
- Changed tool inventory rendering to present each tool’s `Parameters` section as a simplified TypeScript-style signature derived from its wire schema
- Added raw in-band tool-call block capture to parsed owned tool calls so debugging can inspect the exact model-emitted call syntax.
- Moved the canonical `ToolCallSyntax` union to `@pk-nerdsaver-ai/pi-catalog/identity` and re-exported it from `@pk-nerdsaver-ai/pi-ai/grammar` so the catalog can own the syntax vocabulary without an `@pk-nerdsaver-ai/pi-ai` runtime import; all existing import paths are unchanged.
- Made tool-call argument validation more lenient for schema-directed scalar coercions, including object/array stringification and 0/1 boolean coercion.
- Changed `renderToolInventory` (the verbose system-prompt inventory and `/dump`) to render each tool as a `# Tool: <name>` markdown section instead of a `<tool name="…">…</tool>` wrapper.

### Fixed

- Fixed Harmony leak handling support by adding `recoverHarmonyToolCall` plus leak-detection workflows for contaminated assistant messages so recoverable tool-call arguments can be safely truncated and retried
- Fixed false-positive gating in Harmony leak heuristics using signal-based checks so unrelated text containing `to=functions...` is not treated as leaked tool-call markup
- Routed Kimi, DeepSeek DSML, and plain thinking markup healing through the shared in-band scanners so provider leak repair and owned tool calling parse the same wire formats.
- Fixed Cursor provider (`cursor-agent` API) streaming dropping large MCP tool-call arguments — most visibly the built-in `task` tool's `tasks` array on multi-subagent dispatches, which failed downstream schema validation with `tasks: Invalid input: expected array, received undefined`. Two upstream behaviors were fighting the stream handler in `packages/ai/src/providers/cursor.ts`: (1) `args_text_delta` carries the *cumulative* args text so far per `agent.proto`, but the handler concatenated each snapshot onto the buffer, garbling the JSON; (2) `tool_call_completed` carries an `McpArgs` map that omits oversized parameters entirely and downgrades unparsable values to their raw string fallback, but the handler unconditionally overwrote the streamed args with that map. The handler now strips the already-buffered prefix from each `args_text_delta` snapshot (falling back to append when the snapshot doesn't extend the buffer) and merges the decoded `McpArgs` map into the streamed args — preserving streamed keys the completion frame omits and the structured value when the completion frame downgrades to a string. ([#2615](https://github.com/can1357/oh-my-pi/issues/2615))
- Fixed Codex Responses stream mis-routing interleaved `function_call_arguments.delta` events when more than one tool call was open concurrently. The runtime tracked a singleton `currentItem`/`currentBlock`, so every delta — regardless of `item_id` — was appended to whichever item was most recently added, and `output_item.done` for the earlier call then overwrote a sibling's stored arguments (visible as `tasks: Invalid input: expected array, received undefined` on the `task` tool). Open items are now keyed by `item_id` with `output_index` fallback; deltas/done events route to the matching block, late deltas whose item already closed are dropped instead of corrupting a sibling, and `toolcall_*` stream events emit the right `contentIndex` per call ([#2619](https://github.com/can1357/oh-my-pi/issues/2619)).

## [15.13.1] - 2026-06-15

### Fixed

- Fixed the auth-broker (`OMP_AUTH_BROKER_URL`) rejecting OAuth credentials that carry provider-specific extension fields (e.g. an MCP server's `tokenUrl`/`clientId`/`clientSecret`/`resource` embedded for self-contained token refresh): the OAuth credential wire schema was `.strict()`, so `POST /v1/credential` failed with `400 unrecognized_keys` and a broker-backed MCP reauth reported success while the reloaded credential lacked its refresh material and could no longer refresh. The OAuth wire schema now uses `.loose()` to preserve unknown fields — matching the field-preserving local SQLite store — so extra OAuth fields round-trip through broker set->get (envelope and API-key schemas stay strict).

## [15.13.0] - 2026-06-14

### Fixed

- Fixed OpenAI Responses/Realtime SSE stream handler crashing with "Error Code undefined: undefined" when parsing error events with nested error details by falling back to the nested error object fields.
- Fixed OpenAI-compatible providers that reject forced `tool_choice` on thinking-required models by downgrading unsupported forced choices to `auto` while keeping tools available ([#2546](https://github.com/can1357/oh-my-pi/issues/2546)).
- Fixed GitHub Copilot Anthropic transport (`api.githubcopilot.com/v1/messages`) returning `400 tools.0.custom.eager_input_streaming: Extra inputs are not permitted` on every tool-bearing turn by stopping the emission of the per-tool `eager_input_streaming` flag and the `fine-grained-tool-streaming-2025-05-14` beta header on the Copilot transport — the proxy whitelists neither ([#2558](https://github.com/can1357/oh-my-pi/issues/2558)).
- Disabled Bun's native ~300s pre-response `fetch` timeout in every streaming provider (OpenAI completions/responses, Azure responses, Anthropic, Codex SSE, Bedrock, Gemini CLI, Ollama). The configurable first-event/idle/SDK watchdogs (`PI_STREAM_FIRST_EVENT_TIMEOUT_MS`, `PI_OPENAI_STREAM_IDLE_TIMEOUT_MS`, `compat.streamIdleTimeoutMs`) were silently capped by Bun's hidden ceiling, so cold large-context streams (e.g. self-hosted vLLM at multi-hundred-K prompts) died at exactly 300s with `TimeoutError: The operation timed out.` Direct callers of `./providers/{amazon-bedrock,google-gemini-cli,ollama,openai-codex-responses}` (which bypass `register-builtins`' iterator-level watchdog) now install a pre-response `AbortSignal.timeout(firstEventTimeoutMs)` alongside the disable, so a stalled upstream still fails within the configured budget instead of hanging forever ([#2422](https://github.com/can1357/oh-my-pi/issues/2422))
- Fixed Gemini / Antigravity streams (Google Cloud Code Assist API) creating a trailing empty text block and emitting redundant `text_start`/`text_delta`/`text_end` events at the end of the turn when the final SSE chunk contains an empty text part (`text: ""`). The parser now ignores empty text parts, preserving the active transcript block state and ensuring proper nesting and rendering of subsequent background jobs or new turns.
- Preserved terminal Google `thoughtSignature`s by still extracting and applying the signature on the active block even when the text part is empty or undefined.
- Stopped Gemini Antigravity sessions (`gemini-3*` / Claude under Cloud Code Assist) from leaking system rule reminders and personality preambles into the final response, by appending an explicit 'do not output rule checks' instruction to the injected system parts.
- Fixed Gemini / Antigravity streams (Google Cloud Code Assist API) letting a `functionCall` part's own `thoughtSignature` clobber the preceding text or thinking block's signature on `think → tool` and `text → tool` turns. A signed function-call part has `text: undefined`, so it fell into the terminal-signature branch while the prior block was still active; that branch now skips function-call parts, leaving the tool call's signature on the tool call where it belongs and preventing corrupted signatures on same-model replay.
- Fixed MiniMax-M3 OpenAI-compatible streams rendering reasoning twice when the same chunk carried both `<think>…</think>` content and structured `reasoning_content`; structured reasoning now wins and cumulative MiniMax reasoning snapshots are collapsed to deltas using a per-signature snapshot tracker that survives the `</think>`-to-text block transition (so post-answer cumulative snapshots don't reinstate a duplicate thinking block). ([#2433](https://github.com/can1357/oh-my-pi/issues/2433))

## [15.12.6] - 2026-06-14

### Changed

- Bumped Z.AI (GLM Coding Plan) API key validation probe to glm-5.2.

### Fixed

- Fixed tool schema conversion for non-Cloud Code Assist Google Gemini models by normalizing parameters with `normalizeSchemaForGoogle` to prevent un-normalized schema properties (such as `additionalProperties: false` or type arrays) from causing Gemini API errors.
- Fixed OpenAI-family request builders dropping forced named `tool_choice` directives when the named tool is absent from the serialized `tools` array, preventing spec-strict providers from rejecting self-inconsistent requests. ([#1701](https://github.com/can1357/oh-my-pi/issues/1701))

## [15.12.4] - 2026-06-13

### Added

- Added `GITLAB_CLIENT_ID` and `GITLAB_REDIRECT_URI` env-var overrides for the GitLab Duo OAuth login flow so users running with their own GitLab OAuth application can replace the bundled credentials when GitLab rejects the bundled `client_id`'s redirect URI. Setting `GITLAB_REDIRECT_URI` also disables the random-port fallback (strict OAuth providers reject mismatched URIs anyway). ([#2424](https://github.com/can1357/oh-my-pi/issues/2424))
- Added `AuthStorage.listStoredCredentials()` and `AuthStorage.removeCredential()` for per-account credential management.

### Changed

- Replaced the OpenAI SDK client usage in `openai-completions`, `openai-responses`, `azure-openai-responses`, and `openai-codex-responses` with the new internal `postOpenAIStream` OpenAI-wire JSON/SSE transport

### Fixed

- Fixed streaming providers to cancel upstream model requests when the client closes the response body, so interrupted SSE sessions stop instead of continuing in the background
- Fixed: provider request builders treat unknown `model.maxTokens` (`null`) as "no model cap" instead of coercing to `0` via `Math.min`; Anthropic falls back to the 64k Claude-Code cap for its required `max_tokens`.
- Fixed transient stream failures on OpenAI-compatible providers by retrying HTTP 408/429/5xx responses and transient network errors with Retry-After/quota-hint aware backoff
- Fixed SSE stream handling for OpenAI-compatible responses by parsing wire-level JSON frames directly and honoring `[DONE]` termination
- Fixed stream error handling for OpenAI-compatible providers by preserving structured HTTP status/headers and response body details from failed requests for retry and strict-tool fallback logic
- Fixed OpenAI-compat streams ending with a bare `finish_reason: "error"` (gateways like OpenRouter reporting upstream failures, e.g. Gemini `MALFORMED_FUNCTION_CALL`) surfacing as a non-retryable `Provider finish_reason: error`. The reason is now mapped to `Provider returned error finish_reason`, which the session retry classifier recognizes as transient, so the turn auto-retries instead of stopping with a pinned error banner.
- Fixed `SqliteAuthCredentialStore.open()` crashing with `SQLITE_BUSY_RECOVERY` (errno 261) when several `omp --session` panes restore concurrently after an unclean shutdown: `PRAGMA busy_timeout = 5000` now runs as a standalone statement BEFORE `PRAGMA journal_mode=WAL` (the first lock-taking statement during WAL recovery), and `open()` retries the BUSY family — `SQLITE_BUSY`, `SQLITE_BUSY_RECOVERY`, `SQLITE_BUSY_SNAPSHOT`, `SQLITE_BUSY_TIMEOUT` — with bounded exponential backoff. The exhausted-retry error message includes the DB path. Exported `isSqliteBusyError(err)` for callers that need the same classifier ([#2421](https://github.com/can1357/oh-my-pi/issues/2421)).
- Fixed MiniMax-M3 OpenAI-compatible streams rendering reasoning twice when the same chunk carried both `<think>…</think>` content and structured `reasoning_content`; structured reasoning now wins and cumulative MiniMax reasoning snapshots are collapsed to deltas. ([#2433](https://github.com/can1357/oh-my-pi/issues/2433))
- Fixed Gemini turns silently halting the agent when the model returned `finishReason: STOP` with only an empty (or whitespace-only) text part and no tool call — the well-known "empty response" failure. All Google surfaces (public Generative Language `streamGoogle`, Vertex `streamGoogleVertex`, and Cloud Code Assist `google-gemini-cli`/`google-antigravity`) now classify such a turn as empty via the shared `hasMeaningfulGoogleContent` check and retry it up to `MAX_EMPTY_STREAM_RETRIES` times before surfacing an error. The Cloud Code Assist path previously had an empty-stream retry that never fired for this case (its `hasContent` flag counted an empty-string text part as content), and the public/Vertex path had no retry at all; the retry now emits a single `start` event so no duplicate partial message leaks downstream.

## [15.12.1] - 2026-06-12

### Added

- Added the optional `ToolResultMessage.useless` flag: tools can declare a finished result contextually useless (zero matches, elapsed wait) so compaction passes may elide it once consumed. Never serialized to provider wire formats and never set together with `isError`.

## [15.12.0] - 2026-06-12

### Fixed

- Fixed Anthropic requests bypassing lone-surrogate sanitization after payload hooks or Anthropic-origin tool-call replay: the model itself can emit unpaired surrogate escapes in its own tool-argument JSON (streamed out fine, then rejected with `400 The request body is not valid JSON` on every subsequent request, bricking the session). The final Anthropic payload is now deep-sanitized with `toWellFormed()` immediately before SDK serialization; the pass is identity-preserving, so well-formed arguments stay byte-identical and prompt-cache prefixes are unaffected.

## [15.11.8] - 2026-06-12

### Breaking Changes

- Removed the Codex SSE stateful transport path, so SSE turns no longer send `previous_response_id` with delta input and now always send the full transcript

### Changed

- Scoped `x-codex-turn-state` handling to within-turn continuations so only tool-loop follow-ups include the turn-state header and new user turns start without it

### Removed

- Removed the `statefulResponses` option from `OpenAICodexResponsesOptions`, and SSE stateful mode is no longer controlled by the `PI_CODEX_STATEFUL`-style flag

### Fixed

- Fixed the platform OpenAI Responses and Codex websocket stale-chain classifiers missing the "Unsupported parameter: previous_response_id" rejection phrasing (FastAPI-style `detail` body with no `error.code`), so a chained turn now falls back to a full-transcript replay instead of surfacing the 400
- Fixed the HTTP-400 raw-request dump for Codex SSE to record the body actually sent on the wire instead of the pre-transport request body, which made chained-request failures look like the rejected parameter was never sent

## [15.11.7] - 2026-06-12

### Added

- Added `requestModelId` and `thinking.suppress` options to `google-gemini-cli` so collapsed effort-tier variants serialize their per-effort upstream wire id, and thinking-off requests on models with `thinking.suppressWhenOff` send an explicit `thinkingConfig` (`includeThoughts: false` with `thinkingLevel: "MINIMAL"` or `thinkingBudget: 0`) — Cloud Code Assist re-applies the per-id baked server default when the config is omitted, silently thinking and billing the tokens
- Added mandatory-reasoning clamping: models baked with `thinking.requiresEffort` floor omitted or disabled reasoning to the lowest supported effort in every api mapping, and `disableReasoning` no longer emits OpenRouter `reasoning: { enabled: false }` for them — fixes `omp bench` and utility requests 400ing with "Reasoning is mandatory for this endpoint and cannot be disabled" on OpenRouter Gemini 3.x

### Changed

- Changed `google-gemini-cli` request mapping to route per-request wire ids via `resolveWireModelId`: the session effort picks the backing variant id (collapsed `gemini-3.5-flash` at high → `gemini-3.5-flash-low`; claude pairs route off → bare id, efforts → `-thinking`) while `AssistantMessage.model` and usage attribution stay on the logical id. A thinking budget clamped to zero now falls through to the thinking-off path (off routing plus suppression) instead of only disabling thinking
- Changed `openai-completions` and `anthropic-messages` to serialize per-request wire ids via `resolveWireModelId`, so collapsed `X`/`X-thinking` pairs on aggregators and custom providers switch to the thinking SKU when reasoning is enabled (previously only `google-gemini-cli` routed effort-tier variants)

### Fixed

- Fixed `google-gemini-cli` ignoring `Model.requestModelId` when serializing the request model id

## [15.11.5] - 2026-06-12

### Added

- Added `AuthStorage.listUsageHistory` to retrieve historical usage snapshots with optional `provider` and `sinceMs` filtering
- Added durable usage-history persistence in the sqlite auth store so successful usage reports are recorded as time-series snapshots of limit utilization for later trend inspection
- Added `AuthStorage.redeemResetCredit` to redeem stored OpenAI Codex saved rate-limit reset credits for a target account by `credentialId`, `accountId`, or `email`
- Added `listCodexResetCredits` and `consumeCodexResetCredit` exports for OpenAI Codex saved reset-credit listing and redemption
- Added `resetCredits` with `availableCount` to `UsageReport` so OpenAI Codex usage data now exposes redeemable rate-limit resets
- Added `openai-codex-reset` exports via package barrel for out-of-band tooling usage
- Added a one-shot request-debug target that writes the next provider HTTP request JSON to an explicit path.

### Changed

- Changed `AuthStorage.redeemResetCredit` to invalidate cached usage data after a successful redemption so the next usage report reflects the reset immediately

### Fixed

- Fixed temporary credential block state so redeemed reset credits immediately make the affected account selectable again after `redeemResetCredit` succeeds
- Fixed one-shot request-debug path handling so an explicit request log target is consumed after the next request and no longer affects subsequent calls
- Fixed explicit request-debug path mode to create missing parent directories before writing request logs
- Fixed explicit request-debug mode to overwrite existing `.res.log` files for the requested path instead of failing when they already exist
- Fixed OpenAI Responses `previous_response_id` chaining on Zero Data Retention orgs: the in-provider retry classifier missed the ZDR-specific 400 ("Previous response cannot be used for this organization due to Zero Data Retention"), so chained turns kept failing every other request after a brief recovery — the chain was reset but not disabled, so the next successful full-replay turn re-armed it. The ZDR phrasing is now classified categorically: one strike disables chaining for the session (skipping the three-strike circuit breaker) and the in-call retry drops `store: true`/`previous_response_id` and replays the full transcript instead ([#2341](https://github.com/can1357/oh-my-pi/issues/2341)).

## [15.11.4] - 2026-06-12

### Added

- Codex/Responses providers now map `end_turn: false` on the terminal stream event (Codex backend signal for "response ended, turn didn't" — commentary-only progress updates) to `stopDetails: { type: "pause_turn" }` with stopReason `"stop"`, so the agent loop can re-sample instead of ending the turn. Wired in `openai-codex-responses` and `processResponsesStream` (`openai-responses`/`azure-openai-responses`); inert for backends that never send the field.
- Added Codex upstream protocol features to `openai-codex-responses` (tracking codex-rs as of June 2026): `onModerationMetadata` callback surfacing `response.metadata` → `openai_chatgpt_moderation_metadata` on both transports; `reasoningContext` option emitting `reasoning.context` (`auto`/`current_turn`/`all_turns`); `clientMetadata` option emitting `client_metadata` in the request body (canonical `x-codex-turn-metadata` envelope) without breaking the websocket append fast-path; and an opt-in `responsesLite` mode mirroring codex-rs — lite header on HTTP requests and the websocket upgrade, `ws_request_header_*` marker in `response.create` client metadata, lite-keyed socket pooling, image-detail stripping, forced serial tool calls, and `reasoning.context: all_turns` default. Dormant until OpenAI flips `use_responses_lite` in the model catalog.
- Added `withOAuthAccess` — the `withAuth` counterpart for OAuth-access consumers: runs an operation through the central a/b/c auth-retry policy (resolve → force-refresh same account → rotate to a sibling) while handing the attempt the full `OAuthAccess` (bearer plus `accountId`/`projectId`/`enterpriseUrl` identity metadata). Use it instead of hand-rolled `getOAuthAccess` + fetch flows so 401s and usage-limits rotate credentials instead of failing the call.
- Added `ProviderHttpError` — a typed HTTP error carrying `status`, `headers`, and `code` — replacing the ad-hoc `as Error & { status?... }` / `Object.assign` hacks at provider throw sites, with per-provider subclasses `CodexApiError`, `AuthGatewayError`, `GoogleApiError`, `GeminiCliApiError`, `OllamaApiError`, and `BedrockApiError`; `AnthropicApiError` now extends it. Google, Gemini CLI, Ollama, and Bedrock HTTP errors now also carry response headers, so server-suggested `retry-after` delays are visible to retry classification on those paths. The internal `withHttpStatus` helper was removed.
- Added stateful SSE turn chaining for OpenAI Codex (on by default; disable with `PI_CODEX_STATEFUL=0` or `statefulResponses: false`): SSE requests now reuse `previous_response_id` with delta-only input instead of replaying the full transcript, mirroring the websocket fast-path via a shared transport-aware builder. Any history mutation or option change falls back to a full replay; a server-side `previous_response_not_found` (HTTP or in-stream) resets the chain and retries the turn with full context, and three consecutive stale failures disable chaining for the session.
- Added stateful `previous_response_id` chaining to the platform OpenAI Responses provider (`openai-responses`): on by default against the official api.openai.com endpoint (forces `store: true`, which chaining requires), off for other Responses endpoints; override with `statefulResponses` or `PI_OPENAI_STATEFUL`. Chain detection compares the wire form of the conversation arguments alone — per-turn trailing scaffolding such as the GPT-5 "Juice: 0" developer item is excluded from the append-baseline prefix check and re-appended to the delta — and a rejected/stale previous response falls back to a one-shot full replay with the same circuit breaker.
- Added `AuthStorage.getOAuthAccountIdentity()` and the `OAuthAccountIdentity` type — a read-only lookup returning the `accountId`/`email`/`projectId` of the OAuth credential a session is currently routed to, for display and metadata paths.

### Changed

- The GPT-5 "Juice: 0" no-reasoning developer item in `applyResponsesReasoningParams` is now gated on the resolved `compat.requiresJuiceZeroHack` flag (auto-detected from GPT-5-family model names by `@pk-nerdsaver-ai/pi-catalog`, overridable per model) instead of an inline model-name check.

### Fixed

- Fixed websocket append fast-path to remain usable when only `client_metadata` changes between turns
- Fixed `onModerationMetadata` handling so exceptions thrown by callback observers no longer terminate the response stream
- Fixed local SQLite OAuth credential caches returning a stale Anthropic access token after another `omp` process refreshed and persisted the same row. `AuthStorage` now syncs the selected row from storage before returning or force-refreshing OAuth credentials, so concurrent sessions pick up peer-rotated tokens instead of surfacing a one-turn `401 Invalid authentication credentials`.
- Fixed forced OAuth preflight refresh failures being swallowed silently in credential selection; they now emit a debug log (`OAuth preflight refresh failed`) so stale-refresh-token replays from concurrent sessions are diagnosable.

## [15.11.3] - 2026-06-11

### Fixed

- Fixed GitHub Copilot long-context model requests to use the upstream `requestModelId` when calling Anthropic, OpenAI Responses, and OpenAI Completions APIs
- Fixed GitHub Copilot model enablement to deduplicate catalog variants by upstream model ID when enabling all models

## [15.11.2] - 2026-06-11

### Fixed

- Fixed Anthropic encoding of error tool results with whitespace-only content so requests no longer 400 with `tool_result: content cannot be empty if is_error is true`

## [15.11.1] - 2026-06-11

### Changed

- Exported `resolveAnthropicMetadataUserId` so non-streaming Anthropic Messages consumers (e.g. the coding-agent web search provider) can produce the same Claude-Code-shaped `metadata.user_id` as the main streaming path.

### Fixed

- Preserved Anthropic `stop_details` on assistant messages so refusal and sensitive classifier stops remain structurally visible to callers. ([#2290](https://github.com/can1357/oh-my-pi/issues/2290))
- Fixed OpenAI Responses, Azure OpenAI Responses, and OpenAI Completions streams hanging until the 120s idle watchdog errored the turn when a provider delivers the terminal frame but never sends `[DONE]` nor closes the connection. `processResponsesStream` now breaks out of the event loop on `response.completed`/`response.incomplete` (mirroring the Codex websocket/SSE terminal break), and the completions consumer breaks once `finish_reason` plus a usage payload arrived — or, for hosts that never send usage, ends the stream cleanly via a short post-finish grace window (`iterateWithTerminalGrace`) that aborts the transport to release the socket.

## [15.11.0] - 2026-06-10

### Added

- Added optional `ImageContent.detail` (`"auto" | "low" | "high" | "original"`): an OpenAI resolution hint forwarded by the `openai-responses` serializers (default stays `auto`) and by `openai-completions` for the values Chat Completions supports. `"original"` preserves native resolution — required for snapcompact frames, whose pixel-font glyphs do not survive the default downscale. Providers without a detail knob ignore the field.

### Fixed

- Fixed OpenRouter DeepSeek V4 strict tool schemas nesting `anyOf` inside the nullable wrapper for optional unions, which produced a branch without `type` and triggered OpenRouter's `Invalid tool parameters schema : field anyOf: missing field type` 400. ([#2270](https://github.com/can1357/oh-my-pi/issues/2270))
- Hardened strict tool-schema handling beyond the optional-union case: `enforceStrictSchema` now splices natively nested pure unions into the parent `anyOf` (only when the inner node carries no constraining siblings, since sibling keywords are conjunctive with `anyOf`), so source schemas with nested unions no longer produce type-less `anyOf` branches that strict upstream validators reject. ([#2270](https://github.com/can1357/oh-my-pi/issues/2270))
- Made the openai-completions non-strict retry reachable for `"mixed"` strict mode (previously gated to `all_strict`, i.e. Cerebras only) and taught it to recognize upstream tool-schema validation 400s (`Invalid tool parameters schema …`, `Invalid schema for function …`). A matching rejection now retries the request with base (non-strict) schemas and persists `strictToolsDisabled` on the provider session, so later requests skip the doomed strict attempt instead of paying a 400 + retry round-trip each turn. ([#2270](https://github.com/can1357/oh-my-pi/issues/2270))
- Cross-model `anthropic-messages → anthropic-messages` continuations now preserve prior assistant turns' reasoning chains end-to-end: every prior `thinking`/`redactedThinking` block survives (not just the latest surviving assistant), and third-party ↔ third-party replays keep their signatures intact so the reasoning chain stays signed for the next turn. Signatures are stripped (and any `redacted_thinking` sibling without a native landing spot is dropped) only when an official Anthropic endpoint is on either end of the replay — official Anthropic cryptographically binds reasoning signatures to its key+session+model, while compatible reasoning endpoints (Z.AI, DeepSeek, custom anthropic-messages providers configured via `models.yaml`) treat them as opaque continuation hints. Source-side official detection uses the canonical catalog provider id `"anthropic"` (assistant messages carry no `baseUrl`); target-side detection reuses the baked `compat.officialEndpoint` flag. Latest-turn byte-for-byte behavior (Anthropic's "thinking blocks in the latest assistant message cannot be modified" rule) and existing aborted/errored last-block sanitization are unchanged. ([#2257](https://github.com/can1357/oh-my-pi/issues/2257), [#2265](https://github.com/can1357/oh-my-pi/issues/2265))

## [15.10.12] - 2026-06-10

### Added

- Added `antigravityRankingStrategy` and registered it for `google-antigravity` in `DEFAULT_RANKING_STRATEGIES`, so new sessions are routed to OAuth credentials with quota headroom for the requested model backend (lowest relevant `remainingFraction` counter as the sole ranked window, 24h `windowDefaults` matching `daily-cloudcode-pa.googleapis.com` resets). Without it, the existing `antigravityUsageProvider` data never reached credential selection. ([#2198](https://github.com/can1357/oh-my-pi/issues/2198))

### Changed

- Updated MiniMax and MiniMax Token Plan defaults to `MiniMax-M3` and refreshed Token Plan login copy/links ([#1725](https://github.com/can1357/oh-my-pi/issues/1725)).

### Fixed

- Fixed OpenAI Responses and Azure OpenAI Responses streams silently surfacing incomplete output as successful when a custom/proxy provider drops the connection without sending a terminal `response.completed`/`response.incomplete` event. Both providers now detect premature stream closure and throw with `stopReason: "error"` ([#2184](https://github.com/can1357/oh-my-pi/pull/2184))
- Fixed `isUsageLimitError` missing Antigravity / Cloud Code Assist's `Individual quota reached` 429 phrasing. The `USAGE_LIMIT_PATTERN` only knew `quota.?exceeded` / `limit_reached`, so `auth-retry` and `AuthStorage.markUsageLimitReached` treated the response as a terminal provider error and pinned sessions to the exhausted OAuth account instead of rotating to a sibling credential. The pattern now also matches `quota.?reached`. ([#2198](https://github.com/can1357/oh-my-pi/issues/2198))
- Scoped Antigravity usage blocking and ranking by model family (`gemini-*`/`gemma-*` → Google, `claude-*` → Anthropic, `gpt-*`/`openai/*` → OpenAI), so an exhausted Gemini counter no longer makes a healthy Claude/OpenAI Antigravity credential unavailable until reset. ([#2198](https://github.com/can1357/oh-my-pi/issues/2198))
- Fixed no-model Antigravity credential lookups (e.g. image-provider discovery) inheriting provider-wide exhaustion: `scopeLimits` now returns no limits without a concrete backend counter, and `blockScope` always returns a counter scope so missing model context can never fall through to AuthStorage's provider-wide block bucket. ([#2198](https://github.com/can1357/oh-my-pi/issues/2198))

## [15.10.11] - 2026-06-10

### Breaking Changes

- The model catalog moved to the new `@pk-nerdsaver-ai/pi-catalog` package. Deep subpath exports `@pk-nerdsaver-ai/pi-ai/models.json`, `/models`, `/model-cache`, `/model-manager`, `/model-thinking`, `/effort`, `/provider-models*`, `/utils/discovery*`, `/providers/openai-codex/constants`, `/providers/google-gemini-headers`, and `/providers/openai-completions-compat` are gone — import the `@pk-nerdsaver-ai/pi-catalog` equivalents (`/models.json`, `/models`, `/model-cache`, `/model-manager`, `/model-thinking`, `/effort`, `/provider-models*`, `/discovery*`, `/wire/codex`, `/wire/gemini-headers`, `/compat/openai`). The pi-ai root barrel re-exports only the model/effort *types* its own signatures use (`Model`, `Api`, `ThinkingConfig`, `Effort`, `Usage`, compat interfaces) — catalog *values* (`getBundledModel(s)`, `calculateCost`, `modelsAreEqual`, `clampThinkingLevelForModel`, `DEFAULT_MODEL_PER_PROVIDER`, …) must be imported from `@pk-nerdsaver-ai/pi-catalog`.
- `ProviderDefinition` is now auth-only: `defaultModel`, `createModelManagerOptions`, `catalogDiscovery`, `dynamicModelsAuthoritative`, `allowUnauthenticated`, and `specialModelManager` moved to pi-catalog's `CATALOG_PROVIDERS` table, and `KnownProviderId` was replaced by pi-catalog's `KnownProvider` (registry completeness is enforced by a compile-time check against that union). The pure GitHub Copilot key/endpoint helpers moved from `registry/oauth/github-copilot` to `@pk-nerdsaver-ai/pi-catalog/wire/github-copilot`.

### Added

- Exported `wrapFetchForCch` so non-streaming OAuth callers (e.g. the web-search provider) can patch the Claude Code billing-header `cch` attestation into their request bodies instead of shipping the `cch=00000` placeholder.

### Changed

- Reduced idle-watchdog churn on the token hot path: the abort promise/listener is created once per stream instead of per yielded item, the deadline uses a persistent re-armed timer instead of a `setTimeout` create/destroy pair per delta, and the persistent race promises are re-minted every 1024 items so per-race reaction records cannot accumulate for the stream's whole life.
- Memoized Anthropic many-image downscaling by content-block identity, so long sessions with stable message objects no longer re-decode and re-encode every oversized image on each request and retry.
- Tool-argument validation errors now truncate embedded argument strings at 256 chars per field — a failed `write`-class call no longer echoes hundreds of KB of payload back to the model as the error message.
- Auth storage no longer issues per-boot no-op writes: the schema-version row is only rewritten when the recorded version actually changes, and the credential identity-key backfill skips rows whose derived identity is null — reopening a current-schema database now performs zero write transactions
- Plain provider env-var names moved to the catalog table: registry defs dropped their 48 `envKeys` literals (including the pure `$pickenv` pickers for `huggingface`/`qwen-portal`/`xai-oauth`), `getEnvApiKey` now derives those fallbacks from `CATALOG_PROVIDERS[].envVars`, and `envKeys` remains only for computed resolvers (Anthropic Foundry, Vertex ADC, Bedrock credential chains) and non-catalog providers (`kagi`, `tavily`, `parallel`, `perplexity`)
- Protocol handlers are now pure `model.compat` readers — the per-request `resolve*Compat`/`detect*Compat` calls (anthropic ×11, responses ×3, completions wrappers), inline `strictResponsesPairing` host detection, the OpenCode `reasoning_content` mutation block, and all `resolvedBaseUrl` threading are gone. Compat is materialized once at model build time (`@pk-nerdsaver-ai/pi-catalog` `buildModel`); the OpenCode thinking-mode quirk is a precomputed `compat.whenThinking` pointer swap, and request-time base-URL overrides only feed the HTTP client. Behavior is unchanged (the Anthropic `supportsLongCacheRetention` official-endpoint gate is folded into detection).
- Providers now read baked thinking/wire metadata instead of re-parsing model ids per request: the Anthropic handler gates sampling params on `model.compat.supportsSamplingParams` and adaptive `display` on `model.thinking.supportsDisplay` (Bedrock too), adaptive effort tiers come from the baked `thinking.effortMap`, the Google `thinkingLevel` map is static, and effort-dial-less reasoners (`thinking: undefined`, e.g. `xai-oauth/grok-build`) short-circuit `resolveOpenAiReasoningEffort` without the removed `modelOmitsReasoningEffort` predicate.
- Anthropic streaming retries now use a 10-retry budget with the Anthropic-compatible 0.5s exponential backoff capped at 8s with jitter; server `retry-after` hints still win, and retryable pre-content failures such as 502s no longer stop after three tries.

### Fixed

- Fixed Ollama chat requests honoring `omitMaxOutputTokens`, sending `think: false` when reasoning is explicitly disabled, and preserving HTTP 400 response bodies in surfaced errors.
- Fixed `AuthStorage.markUsageLimitReached` collapsing "every sibling is momentarily blocked" into "no sibling exists": it now returns `UsageLimitMarkResult` with the earliest sibling block expiry (`retryAtMs`), so retry layers can wait out a short-lived block (60s post-401, 5-min usage-probe) instead of adopting the provider's multi-hour retry-after. `rotateSessionCredential` and the auth-gateway adapt to the new shape.
- Fixed Gemini streaming silently presenting truncated or blocked output as a successful `stop`: in-band `{"error":{...}}` events and `promptFeedback.blockReason` chunks were never inspected, and a stream ending without any `finishReason` kept the initialized `stop` — all three now surface as errors (both the API-key and gemini-cli/Antigravity consumers), and the `toolUse` stop-reason override no longer masks `SAFETY`/`MALFORMED_FUNCTION_CALL` finishes that arrive after a valid tool call.
- Fixed Gemini/Bedrock error finishes reporting "An unknown error occurred": the raw finish/stop reason (`MALFORMED_FUNCTION_CALL`, `RECITATION`, `guardrail_intervened`, …) is now recorded into the surfaced error message.
- Fixed the Anthropic provider retry loop ignoring server `retry-after` on 429/529 — it now waits `max(headerDelay, backoff)` instead of hammering a rate-limited endpoint three times within ~14s of guaranteed failures.
- Fixed in-stream Anthropic SSE `error` events being thrown as raw JSON envelopes; the structured `error.type`/`message` is parsed out, keeping retry classification on the typed token instead of accidental regex hits.
- Fixed transparent-reconnect tolerance duplicating content behind replaying proxies: after a duplicate `message_start`, replayed `content_block_start` events for already-closed indexes are now consumed silently instead of appending duplicate text/tool calls.
- Fixed the Anthropic gateway accepting malformed known-type content blocks (e.g. `{type:"text", text:123}`) through the unknown-block catch-all, corrupting history and surfacing later as an opaque TypeError — they now fail validation with a clean 400. The gateway's encode stream also emits `ping` keepalives every 15s and a complete `message_start`/`message_delta`/`message_stop` envelope when the inner stream ends without a terminal event, so strict clients no longer classify slow or empty streams as protocol errors.
- Fixed dotted-version Claude ids (`claude-opus-4.7`/`4.8` on GitHub Copilot, Vercel AI Gateway, Zenmux) missing adaptive thinking `display` support — streamed reasoning stayed hidden on those entries because the display predicate only matched dash-form ids (same failure class as #1373).
- Fixed the Mistral `requiresThinkingAsText` replay path calling `.unshift()` on string assistant content — an unconditional TypeError that failed any same-model history turn carrying both thinking and text.
- Fixed the Responses gateway stripping `encrypted_content` from inbound reasoning items (strip-mode schema), which broke codex-style stateless replay; the schema is now loose, restoring the symmetry the outbound encoder already preserved. Composite internal `callId|itemId` ids are also split before hitting the wire so third-party clients that validate `call_id` charsets no longer reject them.
- Ported the shared unfinished-tool-call sweep to the codex `response.completed` handler, so a lost `output_item.done` can no longer persist a tool call with stale `{}` arguments and transient parser fields into session history.
- Fixed live text freezing until item completion when a lossy proxy drops `content_part.added`: the missing part is now synthesized on the first `output_text`/`refusal` delta (shared and codex decoders).
- Fixed interleaved `content`/`tool_calls` deltas fragmenting a tool call into a truncated call plus a nameless phantom: text/thinking transitions no longer finish open tool-call blocks, so index-only continuation deltas re-find them.
- Fixed the Azure chat-completions path ignoring `AZURE_OPENAI_DEPLOYMENT_NAME_MAP` (only the Responses provider honored it), producing opaque 404s when deployment names differ from catalog model ids.
- Fixed the chat gateway discarding inbound assistant `reasoning_content`, which fed DeepSeek/Kimi exact-replay upstreams a placeholder instead of the model's actual reasoning; it now round-trips as a thinking block, and `toolcall_end` emits a corrective id/name chunk when the streamed start carried empty values.
- Fixed the auth retry loop minting OAuth tokens and firing a doomed request after the caller aborted, and stopped masking resolver failures (broker/network/refresh errors) as "No API key" — the actual cause is preserved.
- Fixed `EventStream.end()` without a terminal result leaving `.result()` pending forever (reachable via extension streams and the lazy wrapper); it now rejects with a synthesized error.
- Fixed the Copilot retry wrapper blind-retrying every retryable error with fixed 400ms delays: 429/5xx now honor `Retry-After` (capped at 30s) and other statuses are not retried, while status-less transport blips keep the linear retry.
- Fixed the OpenAI completions error path ending the stream without closing open text/thinking/tool-call blocks, leaving consumers with orphaned block lifecycles on every stream error or idle-timeout abort.
- Fixed DSML hold-back freezing display on any bare `<` in model output for up to 256 chars: idle-state holding now only triggers on a strict DSML section-open prefix, and blowing the 1MB parameter cap no longer leaks the closing envelope tags as visible text; a capped parameter value also carries an explicit `…[parameter truncated]` marker instead of executing the tool with silently corrupted input.
- Fixed schema normalization blanking DAG-shared subtrees to `{}`: the visited-set cycle guard treated a subschema object reused across two properties as a cycle; path-tracking `enter`/`exit` now allows sharing while still short-circuiting true cycles, frozen input schemas no longer throw, and the path counter no longer leaks depth on the cycle branch (which made every later normalization of the same object misreport a cycle).
- Fixed shared in-flight Google token refreshes being bound to the first caller's `AbortSignal`, failing every concurrent waiter when one parallel Vertex call was cancelled; callers now race their own signal against a detached refresh, which is bounded by its own 30s timeout so a hung fetch cannot pin the in-flight slot until process restart.
- Fixed Gemini <3 multimodal tool results breaking the single-function-response-turn invariant for parallel tool calls (image turns are buffered and flushed after the merged functionResponse turn), and the gemini-cli consumer now defaults missing `functionCall.args` to `{}` like the shared consumer.
- Fixed Bedrock dropping `toolConfig` entirely when `toolChoice` is `"none"` while history still contains tool blocks — the Converse API rejects such requests, so tool specs are kept and only the choice is omitted.
- Fixed AWS credential handling serving expired credentials until process restart: cache entries are invalidated on 401/403, file-sourced session-token credentials get a 5-minute TTL, and concurrent first requests single-flight instead of spawning duplicate `credential_process`/SSO fetches — the shared resolution is detached from the first caller's abort signal (one cancelled request no longer fails every waiter) and bounded by its own 30s timeout. The eventstream reader also cancels the response body on abnormal exit instead of leaving the HTTP connection draining.
- Fixed an unbounded, zero-backoff Codex WebSocket reconnect loop on `websocket_connection_limit_reached`: the no-content reconnect path never consulted the retry budget and never waited, hammering the endpoint forever when the limit is account-scoped. Reconnects are now budgeted and delayed like every other WS retry path, falling back to a single SSE replay when exhausted.
- Fixed the Codex whitespace-loop breaker not observing degenerate frames that arrive after their item closed (or before it opened) — those frames count as stream progress, so the idle watchdogs never fired and the turn hung forever, which is exactly the failure mode the breaker exists for. Whitespace-loop recovery now also refuses to replay the turn once a `toolcall_end` was delivered, surfacing the error instead of re-emitting the same tool calls.
- Fixed the two remaining Codex retry paths (WS mid-stream reconnect and the empty-content SSE fallback) leaking blockless native output items (e.g. `web_search_call`) from the failed attempt into the replayed turn's `providerPayload` and append baseline.
- Fixed Codex WebSocket failure handling closing whatever connection currently occupies the session slot — including a concurrent caller's in-flight CONNECTING handshake, whose rejection (`websocket closed before open`) is classified fatal and disabled WebSockets for the whole session. Failure cleanup now skips CONNECTING sockets and the pool re-joins replacement handshakes (bounded).
- Fixed the Codex request transformer not repairing orphan `custom_tool_call_output` items (only `function_call_output` was folded into an assistant note) — a compaction splice that dropped an `apply_patch` call while keeping its result produced a hard 400 on the default GPT-5 Codex toolset.
- Fixed `processResponsesStream` finalizing reasoning items via a bare `itemId` content scan instead of the routed entry: with id-less reasoning items (local hosts), every `output_item.done` matched the FIRST thinking block — the second item's text clobbered it and the second block was never finalized or signed.
- Fixed `processResponsesStream` dropping tool calls and message text whose `output_item.added` event was lost (lossy proxies): `toolcall_end` was emitted with a dangling contentIndex while the call never entered `message.content`, so the agent loop silently never executed it. The done handler now synthesizes the missing block; still-open tool-call blocks are also final-parsed at `response.completed` so the `toolUse` override cannot hand the agent stale `{}` arguments.
- Fixed `response.incomplete` with `incomplete_details.reason: "content_filter"` being reported as a token-cap truncation (`stopReason: "length"`) — the agent loop's length recovery then asked the model to "shorten" a filtered prompt. Content-filtered turns now surface as errors; usage is also populated from `response.failed` events, and an unknown terminal status degrades to `"stop"` with a logged anomaly instead of throwing away a fully-streamed response.
- Fixed Copilot `premiumRequests` accounting being dropped from failed/cancelled responses: `populateResponsesUsageFromResponse` replaced `usage` wholesale and the error path threw before the success-path re-apply. The populate now preserves the field.
- Fixed `deduplicateToolCallIds` suffixing the whole composite Responses id (`callId|itemId`) — `normalizeResponsesToolCallId` extracts the first segment as the wire `call_id` at encode time, so both copies collapsed back onto one `call_id` and the request carried duplicate call/output pairs. The suffix and length budget now apply per segment.
- Gated native history payload replay on api + model id in both Responses providers: after a mid-session model switch, reasoning items carrying encrypted content minted by the previous model were replayed verbatim under the new model. Replay now falls back to block re-encode (which already strips foreign signatures), matching `transformMessages`' same-model trust rule.
- Fixed Azure OpenAI Responses requests omitting `store: false` while requesting `reasoning.encrypted_content` (stateless-only per OpenAI), replaying custom tool calls paired with mismatched `function_call_output` items (customCallIds was never threaded through), letting the SDK's internal retries (maxRetries 5) silently re-POST inside the explicit first-event deadline, and sending a `prompt_cache_key` when the caller opted out via `cacheRetention: "none"`.
- Fixed strict-pairing Responses backends (Azure, Copilot) silently discarding tool results whose call is absent from history — the result is now folded into an assistant note (same shape as orphan-output repair) so the model keeps the information.
- Fixed the OpenAI Responses first-event watchdog staying armed across the `onResponse` notification callback (a slow callback aborted an already-connected stream), Copilot transient-model retries re-attempting on an already-aborted signal (instant dead retry surfacing the scheduler's AbortError), Codex `reasoningSummary: null` being coerced to `"auto"` (the documented omit-summary contract was unreachable), nested Codex error codes (`response.error.code`) being invisible to the connection-limit/previous-response recovery matchers, and the session id leaking unredacted into `PI_CODEX_DEBUG` logs via the `x-client-request-id` header.
- Fixed `processResponsesStream` (shared by `openai-responses` and `azure-openai-responses`) ignoring the terminal `response.incomplete` event: a max-output-tokens-truncated response ended with `stopReason: "stop"`, zero usage, and no cost instead of `"length"` with the reported token counts. `response.incomplete` is now handled alongside `response.completed` and counts as stream progress for the idle watchdogs.
- Fixed custom tool-call content blocks keeping the transient `partialJson` accumulation buffer (and a potentially stale `arguments.input`) after `response.output_item.done` in the shared Responses stream processor — the function_call branch already cleaned these up.
- Fixed two OpenAI Codex stream-retry paths (whitespace-loop recovery and retryable provider errors) leaking native output items from the abandoned attempt into the replayed turn's `providerPayload` — stale reasoning items completed before the failure were re-sent as history input on subsequent requests alongside the retry's own items.
- Fixed the Codex WebSocket queue wiping already-received frames when a transport error arrived: a `response.completed` queued just before an eager server close was discarded, turning a finished response into a spurious `websocket closed` failure and a full request replay. Errors now append behind pending data frames.
- Fixed concurrent `getOrCreateCodexWebSocketConnection` callers (prewarm racing the first request) tearing down each other's in-flight handshake — closing a CONNECTING socket rejected the other caller with a fatal `websocket closed before open`, disabling WebSockets for the entire session. Callers now join the pending handshake.
- Stopped the Codex connection-limit recovery from replaying a turn over SSE after a `toolcall_end` had already been delivered to the consumer (`canSafelyReplayWebsocketOverSse` guard was bypassed, re-emitting the same tool calls); the error now surfaces instead.
- Extended the Codex whitespace-only argument-delta circuit breaker to `custom_tool_call_input.delta` frames, which counted as stream progress and could keep a degenerate response alive forever with no cap on buffer growth.
- Fixed Codex stream failures during transport open reporting a synthetic request dump (empty URL/body) instead of the real request, and a `response.created` event resetting the recorded time-to-first-token.
- Fixed the Codex WebSocket connect watchdog timer leaking (pinning the event loop for up to 10s) when the request signal aborted before or during the handshake.
- Fixed OpenRouter-hosted Anthropic adaptive reasoning models (Claude Fable/Mythos 5 and Opus 4.6+) so the catalog exposes `xhigh`; Fable/Mythos and Opus 4.7+ requests now map user `high`/`xhigh` onto OpenRouter's Anthropic `xhigh`/`max` effort scale.
- Fixed an unknown Anthropic `stop_reason` failing the whole turn after the response had fully streamed. `mapStopReason` threw on unrecognized values, and since the reason arrives on the trailing `message_delta` the error was unretryable — the live `model_context_window_exceeded` stop reason (default on Sonnet 4.5+) hit this path. It now maps to `length`, and any future unknown reason degrades to a logged anomaly plus a normal `stop` instead of an error.
- Stopped clamping API-key Anthropic requests to Claude Code's 64k output cap. The `CLAUDE_CODE_MAX_OUTPUT_TOKENS` clamp exists to match the OAuth wire fingerprint, but `buildParams` applied it unconditionally, silently halving the output budget of 128k-output models (e.g. Opus 4.8) for API-key callers. OAuth requests keep the clamp.
- Stopped a successful strict-tools fallback from shipping `errorMessage` on a `stopReason: "stop"` assistant message. After a grammar-too-large 400 triggered the non-strict retry, the original 400 text was kept on the final message even when the retry succeeded — consumers that treat `errorMessage` presence as failure (e.g. balance probes) misclassified the turn, and the stale text suppressed later refusal explanations. The fallback is now logged instead.
- Fixed model-supplied `User-Agent` headers being silently dropped on non-OAuth Anthropic requests. `enforcedHeaderKeys` filtered the header out of `modelHeaders` in every branch but only the OAuth branch set one back; the Cloudflare-gateway, bearer-gateway, and `X-Api-Key` branches now forward the caller's value verbatim.
- Stopped sending the `fast-mode-2026-02-01` beta header once a session has learned the endpoint+model rejects fast mode (`fastModeDisabled` provider state), matching the already-dropped `speed` param.
- Stopped `buildAnthropicHeaders` defaulting API-key requests onto the full Claude Code OAuth beta list (`oauth-2025-04-20`, `claude-code-20250219`, …). The `claudeCodeBetas` default is now OAuth-gated, matching the streaming path — the web-search header builder was the only caller hitting the default, so API-key search requests now carry just their own betas (e.g. `web-search-2025-03-05`). An empty `anthropic-beta` header is omitted entirely instead of being sent as an empty string.
- Fixed image-bearing `developer` messages being upgraded to mid-conversation `system` turns on Opus 4.8+/Fable/Mythos 5. System content is text-only on the wire, so a developer turn carrying image blocks in an upgrade-eligible position produced a 400; it now stays a `user` message.
- Fixed a spliced reconnect's second envelope overwriting the completed Anthropic message: `message_delta` was not gated by the terminal-stop flag (content events and duplicate `message_start` were), so the splice's `stop_reason`/usage replaced the finished turn's — a `tool_use` turn could be relabeled `stop`, and the harness then never executed the streamed tool calls. Post-terminal deltas are now logged as envelope anomalies and skipped.
- Fixed a `ping` arriving before `message_start` consuming the Anthropic first-event watchdog: the stall was then classified as a terminal mid-stream idle timeout instead of a retryable first-event timeout. Pings no longer count as the first item but still refresh the idle deadline once content is flowing.
- Fixed Anthropic-compatible proxies that omit `usage`/`delta` objects from `message_start`/`message_delta`/`content_block_*` envelopes crashing the turn with an unretryable `TypeError`; the missing payloads now degrade to logged envelope anomalies like every other malformed-frame case.
- Fixed `applyPromptCaching` placing `cache_control` on `thinking`/`redacted_thinking` blocks — Anthropic rejects that with a 400. A thinking-only assistant turn inside the trailing cache window (e.g. followed by the synthetic `Continue.` pad) no longer receives a breakpoint.
- Fixed consecutive `assistant` params reaching the wire when an empty user/developer turn between two assistant turns was dropped by the converter (e.g. an empty "nudge" submission after a length-truncated reply); Anthropic 400s on non-alternating assistant turns, and the broken triple replayed on every subsequent request. A `user: "Continue."` separator is now inserted, mirroring the trailing-prefill fallback.
- Fixed `supportsAdaptiveThinkingDisplay` misparsing bare dated Opus ids: `claude-opus-4-20250514` (Opus 4.0) parsed as minor `20250514` ≥ 4.7, which silently dropped the `interleaved-thinking-2025-05-14` beta for API-key Opus 4.0 requests.
- Fixed `output_config.effort` shipping without the `effort-2025-11-24` beta on thinking-off requests against adaptive-only Claude models (the effort:"low" pin), and the mid-conversation `system` role shipping without `mid-conversation-system-2026-04-07` on API-key and OAuth-utility requests; both betas are now added whenever the request can carry the corresponding field.
- Fixed GitHub Copilot anthropic-messages requests going out with no `Content-Type` and no `anthropic-version` header — the copilot branch builds its headers from scratch and Bun's fetch does not default `Content-Type` for string bodies. Both headers are now pinned to match every other branch.
- Fixed Anthropic client/provider retry multiplication: with the first-event watchdog disabled (`PI_STREAM_FIRST_EVENT_TIMEOUT_MS=0`), the client's internal `maxRetries: 5` reactivated and stacked with the provider loop's 3 retries — up to 24 wire attempts with double backoff. The provider now pins per-request `maxRetries: 0` unconditionally.
- Fixed `AnthropicMessagesClient` spreading `fetchOptions` after the core request fields, letting a caller-supplied `signal`/`method`/`body` silently disconnect the timeout controller or corrupt the request. Transport extras (TLS) still pass through; core fields now always win.
- Fixed Foundry mTLS/CA material being cached for the process lifetime when the env vars point at files: the cache key now folds in the file mtime so on-disk certificate rotation takes effect.
- Fixed the Claude Code fingerprint version drifting across surfaces: the usage endpoint (`claude-cli/2.1.160`) and OAuth bootstrap (`claude-code/2.1.160`) pinned a stale version while `/v1/messages` reported 2.1.165; both now derive from `claudeCodeVersion`.
- Fixed a system prompt that merely *mentions* `x-anthropic-billing-header:` mid-text suppressing the entire Claude Code system-block injection (billing header, instruction, and cch attestation); the resumed-session guard now anchors with `startsWith`.
- Fixed lone surrogates in cross-API tool-call arguments reaching Anthropic's strict UTF-8 validation: replayed OpenAI/Google-origin `tool_use.input` string leaves are now deep-sanitized with `toWellFormed()`, while same-API Anthropic arguments stay byte-identical to keep prompt-cache prefixes stable.
- Bounded the many-image resize fan-out to 4 concurrent decodes (it previously decoded every oversized image at once, two encode pipelines each — multi-GB transient memory at the 20+-image threshold that activates the feature).
- Fixed `mergeHeaders` merging case-sensitively on the Copilot/client-options path, where a miscased user-configured header (e.g. `authorization` next to the synthesized `Authorization`) survived as two keys that the `Headers` constructor joins comma-separated on the wire.
- Hardened the Anthropic stream lifecycle: prologue failures (e.g. a malformed Copilot credential in `buildCopilotDynamicHeaders`) and error-finalization failures now surface as an `error` event instead of an unhandled rejection that left `stream.result()` hanging forever; the spurious "cch billing placeholder not patched" warning no longer fires when the placeholder only appears in user content.

### Removed

- Removed the dead `iterateUntilAbort` helper (superseded by `iterateWithIdleTimeout`); it leaked the upstream iterator when the consumer abandoned mid-yield and had no production call sites.

## [15.10.10] - 2026-06-09

### Added

- Exported `wrapFetchForCch` so non-streaming OAuth callers (e.g. the web-search provider) can patch the Claude Code billing-header `cch` attestation into their request bodies instead of shipping the `cch=00000` placeholder.

### Fixed

- Fixed an unbounded, zero-backoff Codex WebSocket reconnect loop on `websocket_connection_limit_reached`: the no-content reconnect path never consulted the retry budget and never waited, hammering the endpoint forever when the limit is account-scoped. Reconnects are now budgeted and delayed like every other WS retry path, falling back to a single SSE replay when exhausted.
- Fixed the Codex whitespace-loop breaker not observing degenerate frames that arrive after their item closed (or before it opened) — those frames count as stream progress, so the idle watchdogs never fired and the turn hung forever, which is exactly the failure mode the breaker exists for. Whitespace-loop recovery now also refuses to replay the turn once a `toolcall_end` was delivered, surfacing the error instead of re-emitting the same tool calls.
- Fixed the two remaining Codex retry paths (WS mid-stream reconnect and the empty-content SSE fallback) leaking blockless native output items (e.g. `web_search_call`) from the failed attempt into the replayed turn's `providerPayload` and append baseline.
- Fixed Codex WebSocket failure handling closing whatever connection currently occupies the session slot — including a concurrent caller's in-flight CONNECTING handshake, whose rejection (`websocket closed before open`) is classified fatal and disabled WebSockets for the whole session. Failure cleanup now skips CONNECTING sockets and the pool re-joins replacement handshakes (bounded).
- Fixed the Codex request transformer not repairing orphan `custom_tool_call_output` items (only `function_call_output` was folded into an assistant note) — a compaction splice that dropped an `apply_patch` call while keeping its result produced a hard 400 on the default GPT-5 Codex toolset.
- Fixed `processResponsesStream` finalizing reasoning items via a bare `itemId` content scan instead of the routed entry: with id-less reasoning items (local hosts), every `output_item.done` matched the FIRST thinking block — the second item's text clobbered it and the second block was never finalized or signed.
- Fixed `processResponsesStream` dropping tool calls and message text whose `output_item.added` event was lost (lossy proxies): `toolcall_end` was emitted with a dangling contentIndex while the call never entered `message.content`, so the agent loop silently never executed it. The done handler now synthesizes the missing block; still-open tool-call blocks are also final-parsed at `response.completed` so the `toolUse` override cannot hand the agent stale `{}` arguments.
- Fixed `response.incomplete` with `incomplete_details.reason: "content_filter"` being reported as a token-cap truncation (`stopReason: "length"`) — the agent loop's length recovery then asked the model to "shorten" a filtered prompt. Content-filtered turns now surface as errors; usage is also populated from `response.failed` events, and an unknown terminal status degrades to `"stop"` with a logged anomaly instead of throwing away a fully-streamed response.
- Fixed Copilot `premiumRequests` accounting being dropped from failed/cancelled responses: `populateResponsesUsageFromResponse` replaced `usage` wholesale and the error path threw before the success-path re-apply. The populate now preserves the field.
- Fixed `deduplicateToolCallIds` suffixing the whole composite Responses id (`callId|itemId`) — `normalizeResponsesToolCallId` extracts the first segment as the wire `call_id` at encode time, so both copies collapsed back onto one `call_id` and the request carried duplicate call/output pairs. The suffix and length budget now apply per segment.
- Gated native history payload replay on api + model id in both Responses providers: after a mid-session model switch, reasoning items carrying encrypted content minted by the previous model were replayed verbatim under the new model. Replay now falls back to block re-encode (which already strips foreign signatures), matching `transformMessages`' same-model trust rule.
- Fixed Azure OpenAI Responses requests omitting `store: false` while requesting `reasoning.encrypted_content` (stateless-only per OpenAI), replaying custom tool calls paired with mismatched `function_call_output` items (customCallIds was never threaded through), letting the SDK's internal retries (maxRetries 5) silently re-POST inside the explicit first-event deadline, and sending a `prompt_cache_key` when the caller opted out via `cacheRetention: "none"`.
- Fixed strict-pairing Responses backends (Azure, Copilot) silently discarding tool results whose call is absent from history — the result is now folded into an assistant note (same shape as orphan-output repair) so the model keeps the information.
- Fixed the OpenAI Responses first-event watchdog staying armed across the `onResponse` notification callback (a slow callback aborted an already-connected stream), Copilot transient-model retries re-attempting on an already-aborted signal (instant dead retry surfacing the scheduler's AbortError), Codex `reasoningSummary: null` being coerced to `"auto"` (the documented omit-summary contract was unreachable), nested Codex error codes (`response.error.code`) being invisible to the connection-limit/previous-response recovery matchers, and the session id leaking unredacted into `PI_CODEX_DEBUG` logs via the `x-client-request-id` header.
- Fixed `processResponsesStream` (shared by `openai-responses` and `azure-openai-responses`) ignoring the terminal `response.incomplete` event: a max-output-tokens-truncated response ended with `stopReason: "stop"`, zero usage, and no cost instead of `"length"` with the reported token counts. `response.incomplete` is now handled alongside `response.completed` and counts as stream progress for the idle watchdogs.
- Fixed custom tool-call content blocks keeping the transient `partialJson` accumulation buffer (and a potentially stale `arguments.input`) after `response.output_item.done` in the shared Responses stream processor — the function_call branch already cleaned these up.
- Fixed two OpenAI Codex stream-retry paths (whitespace-loop recovery and retryable provider errors) leaking native output items from the abandoned attempt into the replayed turn's `providerPayload` — stale reasoning items completed before the failure were re-sent as history input on subsequent requests alongside the retry's own items.
- Fixed the Codex WebSocket queue wiping already-received frames when a transport error arrived: a `response.completed` queued just before an eager server close was discarded, turning a finished response into a spurious `websocket closed` failure and a full request replay. Errors now append behind pending data frames.
- Fixed concurrent `getOrCreateCodexWebSocketConnection` callers (prewarm racing the first request) tearing down each other's in-flight handshake — closing a CONNECTING socket rejected the other caller with a fatal `websocket closed before open`, disabling WebSockets for the entire session. Callers now join the pending handshake.
- Stopped the Codex connection-limit recovery from replaying a turn over SSE after a `toolcall_end` had already been delivered to the consumer (`canSafelyReplayWebsocketOverSse` guard was bypassed, re-emitting the same tool calls); the error now surfaces instead.
- Extended the Codex whitespace-only argument-delta circuit breaker to `custom_tool_call_input.delta` frames, which counted as stream progress and could keep a degenerate response alive forever with no cap on buffer growth.
- Fixed Codex stream failures during transport open reporting a synthetic request dump (empty URL/body) instead of the real request, and a `response.created` event resetting the recorded time-to-first-token.
- Fixed the Codex WebSocket connect watchdog timer leaking (pinning the event loop for up to 10s) when the request signal aborted before or during the handshake.
- Fixed OpenRouter-hosted Anthropic adaptive reasoning models (Claude Fable/Mythos 5 and Opus 4.6+) so the catalog exposes `xhigh`; Fable/Mythos and Opus 4.7+ requests now map user `high`/`xhigh` onto OpenRouter's Anthropic `xhigh`/`max` effort scale.
- Fixed an unknown Anthropic `stop_reason` failing the whole turn after the response had fully streamed. `mapStopReason` threw on unrecognized values, and since the reason arrives on the trailing `message_delta` the error was unretryable — the live `model_context_window_exceeded` stop reason (default on Sonnet 4.5+) hit this path. It now maps to `length`, and any future unknown reason degrades to a logged anomaly plus a normal `stop` instead of an error.
- Stopped clamping API-key Anthropic requests to Claude Code's 64k output cap. The `CLAUDE_CODE_MAX_OUTPUT_TOKENS` clamp exists to match the OAuth wire fingerprint, but `buildParams` applied it unconditionally, silently halving the output budget of 128k-output models (e.g. Opus 4.8) for API-key callers. OAuth requests keep the clamp.
- Stopped a successful strict-tools fallback from shipping `errorMessage` on a `stopReason: "stop"` assistant message. After a grammar-too-large 400 triggered the non-strict retry, the original 400 text was kept on the final message even when the retry succeeded — consumers that treat `errorMessage` presence as failure (e.g. balance probes) misclassified the turn, and the stale text suppressed later refusal explanations. The fallback is now logged instead.
- Fixed model-supplied `User-Agent` headers being silently dropped on non-OAuth Anthropic requests. `enforcedHeaderKeys` filtered the header out of `modelHeaders` in every branch but only the OAuth branch set one back; the Cloudflare-gateway, bearer-gateway, and `X-Api-Key` branches now forward the caller's value verbatim.
- Stopped sending the `fast-mode-2026-02-01` beta header once a session has learned the endpoint+model rejects fast mode (`fastModeDisabled` provider state), matching the already-dropped `speed` param.
- Stopped `buildAnthropicHeaders` defaulting API-key requests onto the full Claude Code OAuth beta list (`oauth-2025-04-20`, `claude-code-20250219`, …). The `claudeCodeBetas` default is now OAuth-gated, matching the streaming path — the web-search header builder was the only caller hitting the default, so API-key search requests now carry just their own betas (e.g. `web-search-2025-03-05`). An empty `anthropic-beta` header is omitted entirely instead of being sent as an empty string.
- Fixed image-bearing `developer` messages being upgraded to mid-conversation `system` turns on Opus 4.8+/Fable/Mythos 5. System content is text-only on the wire, so a developer turn carrying image blocks in an upgrade-eligible position produced a 400; it now stays a `user` message.
- Fixed a spliced reconnect's second envelope overwriting the completed Anthropic message: `message_delta` was not gated by the terminal-stop flag (content events and duplicate `message_start` were), so the splice's `stop_reason`/usage replaced the finished turn's — a `tool_use` turn could be relabeled `stop`, and the harness then never executed the streamed tool calls. Post-terminal deltas are now logged as envelope anomalies and skipped.
- Fixed a `ping` arriving before `message_start` consuming the Anthropic first-event watchdog: the stall was then classified as a terminal mid-stream idle timeout instead of a retryable first-event timeout. Pings no longer count as the first item but still refresh the idle deadline once content is flowing.
- Fixed Anthropic-compatible proxies that omit `usage`/`delta` objects from `message_start`/`message_delta`/`content_block_*` envelopes crashing the turn with an unretryable `TypeError`; the missing payloads now degrade to logged envelope anomalies like every other malformed-frame case.
- Fixed `applyPromptCaching` placing `cache_control` on `thinking`/`redacted_thinking` blocks — Anthropic rejects that with a 400. A thinking-only assistant turn inside the trailing cache window (e.g. followed by the synthetic `Continue.` pad) no longer receives a breakpoint.
- Fixed consecutive `assistant` params reaching the wire when an empty user/developer turn between two assistant turns was dropped by the converter (e.g. an empty "nudge" submission after a length-truncated reply); Anthropic 400s on non-alternating assistant turns, and the broken triple replayed on every subsequent request. A `user: "Continue."` separator is now inserted, mirroring the trailing-prefill fallback.
- Fixed `supportsAdaptiveThinkingDisplay` misparsing bare dated Opus ids: `claude-opus-4-20250514` (Opus 4.0) parsed as minor `20250514` ≥ 4.7, which silently dropped the `interleaved-thinking-2025-05-14` beta for API-key Opus 4.0 requests.
- Fixed `output_config.effort` shipping without the `effort-2025-11-24` beta on thinking-off requests against adaptive-only Claude models (the effort:"low" pin), and the mid-conversation `system` role shipping without `mid-conversation-system-2026-04-07` on API-key and OAuth-utility requests; both betas are now added whenever the request can carry the corresponding field.
- Fixed GitHub Copilot anthropic-messages requests going out with no `Content-Type` and no `anthropic-version` header — the copilot branch builds its headers from scratch and Bun's fetch does not default `Content-Type` for string bodies. Both headers are now pinned to match every other branch.
- Fixed Anthropic client/provider retry multiplication: with the first-event watchdog disabled (`PI_STREAM_FIRST_EVENT_TIMEOUT_MS=0`), the client's internal `maxRetries: 5` reactivated and stacked with the provider loop's 3 retries — up to 24 wire attempts with double backoff. The provider now pins per-request `maxRetries: 0` unconditionally.
- Fixed `AnthropicMessagesClient` spreading `fetchOptions` after the core request fields, letting a caller-supplied `signal`/`method`/`body` silently disconnect the timeout controller or corrupt the request. Transport extras (TLS) still pass through; core fields now always win.
- Fixed Foundry mTLS/CA material being cached for the process lifetime when the env vars point at files: the cache key now folds in the file mtime so on-disk certificate rotation takes effect.
- Fixed the Claude Code fingerprint version drifting across surfaces: the usage endpoint (`claude-cli/2.1.160`) and OAuth bootstrap (`claude-code/2.1.160`) pinned a stale version while `/v1/messages` reported 2.1.165; both now derive from `claudeCodeVersion`.
- Fixed a system prompt that merely *mentions* `x-anthropic-billing-header:` mid-text suppressing the entire Claude Code system-block injection (billing header, instruction, and cch attestation); the resumed-session guard now anchors with `startsWith`.
- Fixed lone surrogates in cross-API tool-call arguments reaching Anthropic's strict UTF-8 validation: replayed OpenAI/Google-origin `tool_use.input` string leaves are now deep-sanitized with `toWellFormed()`, while same-API Anthropic arguments stay byte-identical to keep prompt-cache prefixes stable.
- Bounded the many-image resize fan-out to 4 concurrent decodes (it previously decoded every oversized image at once, two encode pipelines each — multi-GB transient memory at the 20+-image threshold that activates the feature).
- Fixed `mergeHeaders` merging case-sensitively on the Copilot/client-options path, where a miscased user-configured header (e.g. `authorization` next to the synthesized `Authorization`) survived as two keys that the `Headers` constructor joins comma-separated on the wire.
- Hardened the Anthropic stream lifecycle: prologue failures (e.g. a malformed Copilot credential in `buildCopilotDynamicHeaders`) and error-finalization failures now surface as an `error` event instead of an unhandled rejection that left `stream.result()` hanging forever; the spurious "cch billing placeholder not patched" warning no longer fires when the placeholder only appears in user content.

## [15.10.9] - 2026-06-09

### Added

- Added `antigravityRankingStrategy` and registered it as the default `CredentialRankingStrategy` for `google-antigravity`, so multi-account selection consumes the per-counter Antigravity usage reports (sorted ascending by `remainingFraction` in `fetchAntigravityUsage`) before falling back to round-robin — preventing the exhausted-counter credential from being chosen first when an unblocked sibling has headroom ([#2187](https://github.com/can1357/oh-my-pi/issues/2187)).
- Added Claude Fable 5 to the first-party Anthropic catalog, seeded directly via `ANTHROPIC_CURATED_FALLBACK_MODELS` rather than waiting on models.dev (1M context / 128k output, adaptive thinking, $10/$50 per MTok). The model parser recognizes the `fable` kind so effort tiers (low→max), adaptive thinking, and Opus-4.7-style sampling restrictions apply; token limits and pricing are pinned in `applyAnthropicCatalogPolicy`.

### Fixed

- Fixed `google-antigravity` not rotating to another stored OAuth account when Cloud Code Assist returns `429 You have exhausted your capacity on this model. Your quota will reset after …`. `parseRateLimitReason` matched the literal `capacity` before the `quota will reset` suffix and downgraded the failure to `MODEL_CAPACITY_EXHAUSTED` (45–75 s backoff), and `isUsageLimitError` returned false for the same message — so `markUsageLimitReached` was never invoked and the agent kept hammering the exhausted credential while the retry layer bailed on the multi-hour `retry-after`. Both paths now treat the Antigravity phrasing as `QUOTA_EXHAUSTED` / usage-limit, blocking the current credential until reset and letting the session pick an unblocked sibling ([#2187](https://github.com/can1357/oh-my-pi/issues/2187)).
- Fixed OpenRouter Anthropic chat-completions requests placing `cache_control` on empty assistant tool-call content. The cache marker now skips empty text and attaches to the most recent non-empty text part, avoiding HTTP 400 payloads with `{type:"text", text:"", cache_control:...}`.
- Fixed Fable-only Anthropic request shaping to cover Claude Mythos 5, and added Mythos 5 to the first-party Anthropic catalog seed. Adaptive display, sampling suppression, mid-conversation system messages, forced-tool-choice downgrade, and Bedrock adaptive metadata now handle both model families.
- Fixed adaptive-only Claude models (Opus 4.6+, Sonnet 4.6+, Fable/Mythos 5) returning HTTP 400 `"thinking.type.disabled" is not supported for this model` whenever thinking was turned off (utility calls and forced-tool turns route through the disable path). These models accept only `thinking.type: "adaptive"`; the request builder now omits the thinking field and pins the lowest adaptive effort instead of emitting `type: "disabled"`.
- Widened the OpenAI-completions first-event watchdog floor from 120s to 300s for DeepSeek V4 reasoning models hosted on the official DeepSeek API. The reasoner emits no SSE bytes until its private chain-of-thought finishes, which routinely takes longer than the generic 100s first-event budget under load — every chat then aborted with `OpenAI completions stream timed out while waiting for the first event` and silently retried. Mirrors the existing GLM coding-plan widening ([#2177](https://github.com/can1357/oh-my-pi/issues/2177)).

## [15.10.8] - 2026-06-09

### Added

- Added optional `fetch` transport override (`fetch?: FetchImpl`) to Google, Ollama, and OpenAI-compatible model-manager options so dynamic model discovery and metadata lookups can use a caller-supplied HTTP client instead of only global `fetch`
- Added optional `fetch` on OAuth controller and API-key validation/login flows so token exchange, refresh, and device/PKCE login requests can be routed through a custom `fetch` implementation
- Added optional `fetch` support to usage polling context, allowing usage providers to execute usage checks using an injected HTTP client
- Added `AssistantMessage.upstreamProvider`, capturing the upstream provider an aggregator routed the request to (OpenRouter reports it via a top-level `provider` field on every chunk, e.g. `"Anthropic"`). Surfaced from the OpenAI-completions stream alongside `responseId`.

### Fixed

- Fixed a degenerate OpenAI Codex stream (the model emits whitespace-only `function_call_arguments.delta` frames forever — commonly seen right after a `todo` tool call) terminating the turn with an error instead of recovering. The whitespace-loop circuit-breaker now (a) stops aborting the shared per-request `AbortController` — `requestSignal` is an `AbortSignal.any` over it, so aborting latched it and made every reopen on the reused `requestSetup` impossible — and (b) drops the half-built junk tool call and replays the request from scratch, bounded by `CODEX_WHITESPACE_LOOP_RETRY_LIMIT` (2). Sampling nondeterminism usually clears the loop on a fresh attempt; once the budget is exhausted the error is surfaced as before, but without the junk tool call polluting the message.
- Capped requested output tokens at 64k (`OPENAI_MAX_OUTPUT_TOKENS`, mirroring Anthropic's `CLAUDE_CODE_MAX_OUTPUT_TOKENS`) on OpenAI-family wires with a known upstream output cap — the `openai-completions` request builder (non-OpenRouter) and the shared responses sampling helper (`openai-responses`, `azure-openai-responses`). A model's catalog `maxTokens` often tracks its context window rather than the upstream's per-request output cap, so requesting the full ceiling 400'd (e.g. `z-ai/glm-4.7` asking for 131072 output exceeded the upstream's 131072-token *total* context). Output is now `min(requested, model.maxTokens, 64000)`.
- Stopped sending `max_tokens`/`max_completion_tokens` on OpenRouter (`openrouter.ai`) completions requests. OpenRouter filters out any upstream whose advertised output cap is below the requested `max_tokens`, so a value derived from the catalog (which reflects the highest-cap provider) silently excluded lower-cap upstreams — `provider.order: ["cerebras"]` for `z-ai/glm-4.7` fell through to DeepInfra because Cerebras's ~40k output cap is below the request, while `only: ["cerebras"]` (no fallback target) bypassed the filter and worked. Omitting the field lets each upstream self-cap and keeps provider routing (`only`/`order`) honored. Kimi via OpenRouter stays exempt — it derives TPM rate limits from `max_tokens`.

## [15.10.7] - 2026-06-08

### Fixed

- Fixed first-party Anthropic requests returning HTTP 400 "Invalid `signature` in `thinking` block" after interrupting the model during its visible output. `transformMessages` stripped the signature from every `thinking` block of an `aborted`/`error` turn, including blocks that had already finished streaming — Anthropic delivers a block's signature at `content_block_stop` before the next block starts, so a thinking block followed by `text`/`tool_use` is fully signed. The valid signature was then replayed empty (`signature: ""`), which signature-enforcing Anthropic rejects, including when the provider is routed through an LLM gateway baseUrl. Only the single mid-stream block at the abort point is now treated as untrustworthy; completed thinking blocks keep their replayable signatures ([#2144](https://github.com/can1357/oh-my-pi/issues/2144)).
- Pinned a regression test against issue [#2123](https://github.com/can1357/oh-my-pi/issues/2123): OAuth requests to adaptive-thinking Claude Opus models (4.6+) ship a `context_management.edits[clear_thinking_20251015]` block paired with the `thinking` field, but the eager-todo prelude (and other paths that force `tool_choice` to `tool`/`any` on the first user turn) route through `disableThinkingIfToolChoiceForced`, which would strip `params.thinking` while leaving the orphan `context_management` behind. The Anthropic API then rejected the request with `400 ... clear_thinking_20251015 strategy requires thinking to be enabled or adaptive`. The fix that lands in [15.10.5] now drops both fields together; the new test locks the contract so the strategy can never outlive its enabling `thinking` payload again.
- Fixed Antigravity usage counters so exhausted Google/Gemini quota renders as `0% free` while separate Anthropic/OpenAI-backed Antigravity model counters remain visible independently, without replaying stale pre-fix cached usage reports.

## [15.10.6] - 2026-06-08

### Added

- Added AIML API as an OpenAI-compatible provider preset with `AIMLAPI_API_KEY` discovery ([#2105](https://github.com/can1357/oh-my-pi/issues/2105)).

## [15.10.5] - 2026-06-08

### Breaking Changes

- Renamed the OAuth subpath export `@pk-nerdsaver-ai/pi-ai/utils/oauth` → `@pk-nerdsaver-ai/pi-ai/oauth` (and `@pk-nerdsaver-ai/pi-ai/utils/oauth/*` → `@pk-nerdsaver-ai/pi-ai/oauth/*`, e.g. `oauth/types`, `oauth/callback-server`, `oauth/openai-codex`) after relocating the OAuth implementation out of `utils/oauth/` into `registry/oauth/`. The high-level OAuth API (`getOAuthProviders`, `refreshOAuthToken`, `getOAuthApiKey`, `registerOAuthProvider`, `unregisterOAuthProviders`, `getOAuthProvider`) and the `OAuth*` types stay exported from the package root, unchanged.

### Changed

- Changed Anthropic retry handling to avoid retrying 4xx responses other than 408 and 429
- Optimized the Anthropic `cch` attestation patch to locate the billing-header placeholder with native `Buffer.indexOf` (memmem) instead of a hand-rolled byte loop. The marker sits ~99% through the body (`messages` serializes before `system`), so the old scan walked almost the entire payload; output bytes are unchanged but the patch is ~7.5x faster (563µs -> 75µs on a 1MB body).
- Refactored provider configuration to a single-source registry (`registry/`, renamed from `provider-registry/` with its `providers/` subdir flattened up). The `KnownProvider`/`OAuthProvider` type unions, `PROVIDER_DESCRIPTORS`, `DEFAULT_MODEL_PER_PROVIDER`, the `serviceProviderMap` env-key fallbacks, the `/login` provider list (`builtInOAuthProviders`), and the `refreshOAuthToken`/`AuthStorage.login` dispatch are all derived from it. Provider defs live directly under `registry/`; thin provider-specific login flows are inlined into the def file, while heavier provider-local OAuth flows and the shared OAuth flow infra (`callback-server`, `pkce`, `google-oauth-shared`, `types`, runtime `index`) now live together under `registry/oauth/` (previously split across `provider-registry/providers/oauth/` and `utils/oauth/`). The non-OAuth API-key paste/validation helpers (`api-key-login`, `api-key-validation`) sit beside the defs in `registry/`. Adding a provider that reuses an existing wire API is now one new provider def plus one registry entry in the common case. Exposes `PROVIDER_REGISTRY`, `getProviderDefinition`, `ProviderDefinition`, and `PASTE_CODE_LOGIN_PROVIDERS`.

### Fixed

- Disabled OpenAI Codex Responses stream obfuscation by sending `stream_options.include_obfuscation=false`, reducing raw WebSocket/SSE debug noise and bandwidth.
- Interrupted OpenAI Codex Responses streams that emit long runs of whitespace-only tool-call argument deltas, preventing degenerate WebSocket/SSE responses from filling the raw stream buffer indefinitely.
- Preserved streaming responses when Anthropic emits unrecognized content_block envelopes by ignoring unknown blocks and continuing to emit known content
- Applied cache control to the most recent tool result block when building Anthropic OAuth payloads without a preceding text block, enabling ephemeral caching for tool-result-only messages
- Kept Anthropic sampling parameters (temperature, top_p, top_k) when thinking is explicitly disabled
- Fixed raw Anthropic SSE handling by parsing event frames with strict JSON parsing and matching event-type validation, surfacing malformed frames as stream errors instead of repairing them
- Fixed Anthropic stream envelope handling to reject duplicate `content_block_start` indexes and block deltas/stops for unopened blocks, preventing malformed envelope states from producing partial output
- Fixed Anthropic image conversion to normalize `image/jpg` to `image/jpeg` and emit a placeholder for unsupported image MIME types
- Fixed Anthropic thinking request preparation by clamping `max_tokens` to provider/model limits and adjusting thinking budgets to a valid value
- Fixed Anthropic request shaping around forced tool choice, unsigned thinking replay, prompt-cache marker placement, non-Anthropic bearer gateways, Foundry TLS loading, and strict tool-schema normalization so malformed or incompatible request payloads are rejected locally or shaped consistently before streaming
- Fixed the Anthropic stream parser shipping a truncated tool call as a completed turn. When a transport drop cut the SSE stream mid-`tool_use` and a transparent reconnect spliced a fresh message envelope onto the same stream, the duplicate `message_start` was deduped but the orphaned tool block — which never received its `content_block_stop` — survived in the assistant message with its seed `{}` (or partially-parsed) arguments. The terminal stop signal from the reconnect then let it flow through as a normal tool call, so e.g. a `read` dispatched with `{}` failed downstream validation (`path: expected string, received undefined`). The parser now treats any tool block left open at stream end as a truncated envelope and routes it through the existing retry/error path instead of emitting bogus arguments.
- Fixed the Zhipu Coding Plan login prompt advertising a misleading `sk-...` placeholder. Zhipu API keys are formatted `<id>.<secret>` (no `sk-` prefix), so the placeholder now matches the actual format instead of suggesting the wrong shape. ([#2106](https://github.com/can1357/oh-my-pi/issues/2106))
- Fixed Moonshot `kimi-k2.6` (and any future `kimi-k2.x`) discovered via `MOONSHOT_API_KEY` stalling on first turn with no output. The `moonshotModelManagerOptions` discovery mapper only marked ids containing `"thinking"` as `reasoning: true`, so dynamic `kimi-k2.6` entries fell through with `reasoning: false`; the openai-completions z.ai branch was then skipped and the request reached Moonshot with no `thinking` parameter at all. Moonshot K2.6 requires an explicit `thinking: {type}` field (the same native-API wire shape #1838 introduced `thinking.keep` for), so the server held the stream silently. The mapper now stamps `reasoning: true`, vision input, and default `thinking` metadata on every `kimi-k2.x` id, restoring the explicit `thinking: {type: "disabled"|"enabled"}` wire body the Moonshot endpoint expects. ([#2113](https://github.com/can1357/oh-my-pi/issues/2113))

## [15.10.4] - 2026-06-08

### Added

- Added `anthropic-client-platform` (`desktop_app`) and `anthropic-client-version` (`1.11187.4`) headers to the Anthropic request fingerprint for OAuth sessions

### Changed

- Changed non-built-in tool names sent to Anthropic from `proxy_` prefixing to `_` prefixing (for example `bash` to `_bash`) while built-in tool names remain unchanged
- Updated the Anthropic OAuth stealth fingerprint to track Claude Code 2.1.165: `claudeCodeVersion` bumped to `2.1.165` (flows into both the `cc_version` billing header and the `claude-cli/<version>` user-agent), `claudeCodeSystemInstruction` changed to `"You are a Claude agent, built on Anthropic's Claude Agent SDK."`, and the billing-header `cc_entrypoint` changed from `cli` to `local-agent`.
- Clamped the Anthropic request `max_tokens` to `Math.min(CLAUDE_CODE_MAX_OUTPUT_TOKENS, options.maxTokens || model.maxTokens)` (64k) so OAuth requests match Claude Code's requested output cap instead of sending the model's full ceiling (e.g. 128k for Opus 4.8).

## [15.10.3] - 2026-06-08

### Removed

- Removed the synthetic `<turn-aborted>` developer guidance note that `transformMessages` injected after an aborted/errored assistant turn (and its `turn-aborted-guidance.md` prompt). The per-call synthetic `"aborted"` tool results already tell the model the turn's tools were terminated, so the extra "verify current state before retrying" note was redundant — and it biased the model toward second-guessing a deliberate user interrupt when the turn was resumed.
- Removed the legacy Anthropic first-user-message skip for `<system-reminder>` blocks now that synthetic reminders no longer travel as user messages.

## [15.10.2] - 2026-06-08

### Added

- Added support for `impersonated_service_account` Application Default Credentials (ADC) in Vertex AI to enable chained impersonation without failing via 401 `invalid_client`.
- Added `AuthStorage.getCredentialOrigin(provider)` (returning a structured `CredentialOrigin` / `CredentialOriginKind`) and `getEnvApiKeyName(provider)`, so callers can render where a provider's auth comes from — runtime override, config, stored OAuth/api-key, env var (with the backing variable name), or fallback resolver — without parsing the prose of `describeCredentialSource`.

### Changed

- Changed `onSseEvent` recording for OpenAI Responses, Azure OpenAI Responses, OpenAI Completions, and Anthropic stream providers to emit reconstructed SSE events from decoded SDK stream items instead of wrapping raw fetch responses
- Changed OpenAI Completions SSE diagnostics to include `event: "chat.completion.chunk"` in `onSseEvent` records for chunked responses
- Changed the default Anthropic model in `DEFAULT_MODEL_PER_PROVIDER` from `claude-sonnet-4-6` to `claude-opus-4-6`, so sessions that fall back to the provider default (no configured `default` role, no `--model`, no restored session) now start on Claude Opus 4.6.

### Fixed

- Fixed duplicate upstream `tool_call_id` values collapsing distinct tool calls during message transformation, preserving one call/result pairing per emitted tool call before provider replay and keeping generated duplicate IDs distinct after OpenAI/Mistral wire-length caps. ([#2055](https://github.com/can1357/oh-my-pi/issues/2055))
- Fixed the Anthropic provider retrying persistent account usage/quota limits (e.g. `429 "This request would exceed your account's rate limit"`, `usage_limit_reached`) as if they were transient. Because the error text contains "rate limit", `isProviderRetryableError` matched it and the stream retry loop looped through its 2s/4s/8s backoff (then the `streamSimple` a/b/c policy re-minted the credential and ran the whole thing again) before surfacing the failure — even though the server's `retry-after` parked the account for minutes-to-hours. These errors are now recognized via `isUsageLimitError` and surfaced immediately to the credential-rotation layer, so e.g. `omp dry-balance --bench` reports a rate-limited account as failed at once instead of appearing to hang.
- Fixed MiniMax-compatible OpenAI-completions hosts losing tool-call argument content when `function.arguments` is streamed as an object across more than one delta. The accumulator added in #1776 wrote `block.partialArgs = rawArgs` per chunk, so every chunk but the last was overwritten — for an `edit` call this surfaced as a tail-slice of the patch text being applied (e.g. a single-line `replace 91..91:` body extending the deletion across the surrounding rows). Chunks are now shallow-merged; for shared string keys, `startsWith` distinguishes cumulative restatements (take the latest) from per-chunk-delta fragments (concatenate). Per-chunk `toolcall_delta` emission for the object branch is suppressed (the previous code emitted `JSON.stringify(rawArgs)` per chunk, which fed downstream concat consumers — `packages/agent/src/proxy.ts`, `openai-chat-server`, `openai-responses-server`, `anthropic-messages-server` — an invalid sequence like `{"input":"a"}{"input":"b"}`); the merged object is flushed instead as a single concat-safe delta in `finishToolCallBlock` before `toolcall_end`, so accumulators reconstruct the args correctly. The single-chunk shape covered by the existing #1776 regression test stays correct end-to-end. ([#2080](https://github.com/can1357/oh-my-pi/issues/2080))
- Fixed the OpenAI Responses compatibility server misrouting late `toolcall_delta` events for earlier parallel tool calls after a later `toolcall_start`. The encoder now keeps OpenFunctionCall state by content index, allocates output indexes at item start, and closes each tool item by its own `toolcall_end`, preserving deferred MiniMax object-argument flushes for the matching call. ([#2080](https://github.com/can1357/oh-my-pi/issues/2080))

## [15.10.1] - 2026-06-07

### Breaking Changes

- Removed the `onAuthError` option from stream request options and shifted auth retry handling to resolver-based `apiKey` behavior, requiring callers using custom auth-retry hooks to migrate

### Added

- Added `ApiKeyResolver` and `ApiKey` auth helpers, including `isApiKeyResolver`, `isAuthRetryableError`, `resolveApiKeyOnce`, and `withAuth`, and exported them from the package root
- Added support for a function-valued `apiKey` in `SimpleStreamOptions` so a single stream request can refresh or rotate credentials during retry
- Added `forceRefresh` credential option to `AuthStorage.getApiKey` and `rotateSessionCredential` support for session-level credential rotation after auth failures
- Added `AuthStorage.resolver(provider, options)` method that builds an `ApiKeyResolver` implementing the a/b/c auth-retry policy directly on the storage instance

### Changed

- Changed gateway and stream auth flows to share the a/b/c retry policy, refreshing the same session credential first and then switching to a sibling credential on repeated auth failures

### Fixed

- Fixed streaming auth retries to handle `401` and usage-limit errors before replay-unsafe content is emitted, including failures surfaced only via `errorStatus`
- Fixed tool argument validation to coerce singleton non-string values into arrays when the schema expects an array, preventing Anthropic-compatible models that emit `todo.ops` as an object from getting stuck in repeated validation-error loops. ([#2026](https://github.com/can1357/oh-my-pi/issues/2026))
- Fixed streaming retries to buffer and suppress partial `start` events from failed auth attempts so only clean retried events are delivered
- Fixed the HTTP 400 raw-request dumper (`appendRawHttpRequestDumpFor400`) littering the real `~/.omp/logs/http-400-requests` directory during tests. Provider suites exercise the 400 error path with mocked `fetch` responses, which the dumper could not distinguish from genuine failures; it now skips persistence under the Bun test runner (`isBunTestRuntime()`).
- Fixed Anthropic Opus requests unnecessarily forcing `tool_choice.disable_parallel_tool_use`, allowing Claude Opus to use the provider's default parallel tool-calling behavior again.
- Fixed parallel `function_call` items losing arguments against llama.cpp's OpenAI Responses endpoint (`/v1/responses`), where every call but the last finalized with `{}` and the agent rejected them with `path: Invalid input: expected string, received undefined`. llama.cpp's `to_json_oaicompat_resp` emits `output_item.added` with only `item.call_id` (no `item.id`, no `output_index`) while the matching `function_call_arguments.delta` carries `item_id: "fc_<call_id>"`. `processResponsesStream` now registers function-call and custom-tool-call items under `item.call_id` as a secondary lookup key (alongside `item.id`/`output_index`) so identifier-deviant hosts route deltas and done events to the right block. ([#2015](https://github.com/can1357/oh-my-pi/issues/2015))
- Fixed `PI_REQ_DEBUG` response recording truncating the captured body when a streamed response was cancelled mid-flight. The response tee in `wrapResponse` could call `FileRequestDebugResponseLog.close()` from both the `cancel` callback and the resumed `pull` (which observes `done` once the source reader is cancelled); the second caller saw the handle already nulled and returned before the first caller's pending write flushed, so the `.res.log` lost the already-buffered chunk. `close()` now memoizes its flush-and-close promise so every caller awaits the same completion.

## [15.10.0] - 2026-06-06

### Added

- Added a dependency-free `@pk-nerdsaver-ai/pi-ai/effort` module exporting the `Effort` enum and `THINKING_EFFORTS`, split out of `model-thinking` so hot-path consumers can import the thinking levels without pulling in `model-thinking` and its provider-compat dependency graph. The package barrel still re-exports both names, so existing imports are unaffected.

### Fixed

- Fixed Antigravity usage provider emitting one bar per model instead of deduplicating by tier — a single account's 15+ model entries now collapse to one bar per tier, matching the shared-quota reality of the upstream API.
- Fixed Antigravity usage reports missing `email` and `accountId` in metadata, so the `/usage` display and the deduplicator can associate reports with their credentials.
- Fixed usage-report dedup ignoring `projectId` for Google Cloud providers, preventing duplicate credential entries from being recognized as the same account.
- Fixed Cloud Code Assist (Antigravity / Gemini CLI) rejecting the `github` tool with HTTP 400 when the `pr` parameter schema contained `anyOf: [string, array]`. The CCA mixed-type combiner collapse picked the first non-null type (`string`) but indiscriminately copied type-specific keys from variant branches — `items` from the array variant leaked onto the string-typed result, producing `{type: "string", items: {...}}` which Google's API rejects as invalid. The collapse now filters merged variant fields against the winning type's allowed key set. ([#2002](https://github.com/can1357/oh-my-pi/pull/2002))
- Fixed OpenAI Responses-family providers (Codex, OpenAI Responses, Azure Responses) rejecting requests with `400 No tool output found for function call …` after the user branched/navigated the session tree to a node that ends on a tool call (the tool-result child is dropped from the reconstructed history) or after a turn was aborted/crashed between the call streaming and its result persisting. The converters now synthesize a placeholder `function_call_output`/`custom_tool_call_output` immediately after any unpaired `function_call`/`custom_tool_call`, symmetric to the existing orphan-output repair, so the model still sees the call and can recover instead of the whole request 400ing.
- Fixed Anthropic-compatible reasoning endpoints losing prior-turn reasoning on continuation requests when they emit unsigned `thinking` blocks. `convertAnthropicMessages` treated unknown endpoints as signature-enforcing and demoted unsigned reasoning to `type: "text"`, which destabilized tool-call argument serialization on the next turn — the upstream symptom behind the `args?.ops?.map is not a function` crash reported against the `todo` tool. Official `api.anthropic.com` keeps the conservative text fallback; non-official `anthropic-messages` reasoning models now replay unsigned reasoning as native `type: "thinking"` ([#2005](https://github.com/can1357/oh-my-pi/issues/2005)).

## [15.9.67] - 2026-06-06

### Fixed

- Fixed llama.cpp/OpenAI Responses parallel tool calls losing arguments when `function_call_arguments.done` events omit `output_index` and `item_id`, by routing those identifierless final-argument events through the open function calls in item order. ([#1970](https://github.com/can1357/oh-my-pi/issues/1970))
- Fixed local Ollama (`openai-responses`) turns failing with HTTP 400 `invalid reasoning value: "minimal"` when a discovered model ran with `minimal` (or `xhigh`) thinking. Ollama's OpenAI-compatible `reasoning.effort` only accepts `high|medium|low|max|none`, so discovered reasoning-capable Ollama models now carry a `compat.reasoningEffortMap` remapping `minimal → low` and `xhigh → max`; non-reasoning models are left untouched.

## [15.9.2] - 2026-06-05

### Added

- Added an AES-256-GCM auth-broker snapshot cache module and `RemoteAuthCredentialStoreOptions.onSnapshot` so broker clients can persist broker-sourced full snapshots without blocking startup on every run.
- Added `Model.omitMaxOutputTokens` so providers (notably Ollama proxies fronting cloud catalogs) can suppress `max_output_tokens` (Responses) and `max_tokens`/`max_completion_tokens` (Completions) on the wire while still using the catalog `maxTokens` for local budgeting. Without it, `applyCommonResponsesSamplingParams` unconditionally sent the catalog cap and HTTP-400'd against upstream APIs whose true output limit was unknown to OMP. ([#1881](https://github.com/can1357/oh-my-pi/issues/1881))

### Changed

- Changed usage-ranked OAuth credential selection to pick deterministic session-sticky weighted buckets instead of always choosing the top-ranked account, capping the best account at 2x the baseline session likelihood while keeping equal-priority accounts evenly balanced.

### Fixed

- Fixed parallel `function_call` items on the OpenAI Responses API losing arguments on every call except the last when the upstream server interleaves their stream events (observed against llama.cpp and other local Responses-compat hosts). `processResponsesStream` no longer routes `function_call_arguments.{delta,done}`, `output_item.done`, content_part/text/refusal/reasoning events through a singleton `currentItem`/`currentBlock` reference; it now tracks every open item in registries keyed by `output_index` and `item_id` so each event is folded into the matching block and the emitted `toolcall_end` carries the correct `contentIndex`. ([#1880](https://github.com/can1357/oh-my-pi/issues/1880))

## [15.9.1] - 2026-06-04

### Added

- Added regional Xiaomi Token Plan login/provider entries (`xiaomi-token-plan-sgp`, `xiaomi-token-plan-ams`, `xiaomi-token-plan-cn`) so `omp login` can store token-plan keys against the selected region. ([#1846](https://github.com/can1357/oh-my-pi/issues/1846))

### Fixed

- Removed the `context-1m-2025-08-07` (1M long-context) beta from the Anthropic agent request headers, the OAuth model-discovery header, and the Claude usage-API header. Sending it caused subscription/OAuth requests without long-context credits to fail with `429 Usage credits are required for long context requests`, breaking Sonnet. The remaining betas are unchanged.
- Fixed Kimi K2.x `maxTokens` on Fireworks and Fire Pass (`fireworks/kimi-k2.5`, `fireworks/kimi-k2.6`, `firepass/kimi-k2.6-turbo`) being inherited from Fireworks `/v1/models` discovery (`max_completion_tokens: 65536`) rather than the published Kimi-on-Fireworks output budget, which let callers (and the openai-completions default-injection safety net) ship a budget the router cannot honor and made runaway reasoning traces more likely. The Fireworks resolver now clamps every Kimi K2.x id (public catalog ids and the canonical `accounts/fireworks/{models,routers}/kimi-k2…` wire form) to 32,768 output tokens, and the generator applies the same cap as a post-processing safety net so the `firepass` static fallback and the bundled `fireworks` entries stay in sync across regens. ([#1849](https://github.com/can1357/oh-my-pi/issues/1849))
- Fixed Xiaomi Token Plan MiMo OpenAI-compatible tool-call continuations omitting required `reasoning_content` replay. ([#1846](https://github.com/can1357/oh-my-pi/issues/1846))
- Fixed Anthropic prompt caching for OpenAI-compatible Claude proxies by honoring `compat.cacheControlFormat: "anthropic"` outside OpenRouter. ([#1845](https://github.com/can1357/oh-my-pi/issues/1845))
- Fixed Moonshot Kimi K2.6 silently pausing for many seconds between tool calls because the server discarded the `reasoning_content` that omp was already sending with every assistant tool-call replay. The K2.6 `thinking` parameter takes an extra `keep` field whose default (`null`) ignores historical reasoning, so K2.6 had to re-derive its full chain-of-thought from the user prompt on every iteration of the agent loop. The Moonshot direct (`api.moonshot.ai`) and Kimi Code (`api.kimi.com`) wire bodies now send `thinking: { type: "enabled", keep: "all" }` for `kimi-k2.6` requests with reasoning enabled, matching Moonshot's documented best practice for multi-step tool-calling agents. The flag is gated on the K2.6 id and the two native hosts because earlier Moonshot models (K2.5 and below) 400 on the unknown field and every Kimi gateway (OpenRouter, OpenCode, Kilo, Fireworks, …) speaks its own thinking shape. ([#1838](https://github.com/can1357/oh-my-pi/issues/1838))
- Fixed Alibaba DashScope (Bailian) compatible-mode endpoint `400 InternalError.Algo.InvalidParameter: The provided messages input is invalid. The error info is [Unexpected item type in content.]` when a screenshot or other image-producing tool result was folded into a known text-only Qwen turn (e.g. `qwen3.7-max`, `qwen-max`, `qwen3-coder-*`) hosted at `dashscope.aliyuncs.com/compatible-mode/v1`. `convertMessages` in `openai-completions` no longer forwards `image_url` content parts for those text-only id families even when a misconfigured custom provider claims `input: ["text", "image"]`; multimodal compatible-mode ids such as `qwen3.7-plus` and `qwen-vl-max` still rely on the catalog `input` field. The tool-result branch and the user-content branch both fall back to the standard `[image omitted: model does not support vision]` placeholder for text-only ids so the model still sees the attachment intent. ([#1859](https://github.com/can1357/oh-my-pi/issues/1859))

## [15.9.0] - 2026-06-04

### Fixed

- Fixed MiniMax-compatible OpenAI-completions hosts (e.g. `minimax-code-cn/MiniMax-M3`) losing tool-call arguments when the stream delivers `function.arguments` as a complete object instead of the OpenAI JSON-string contract. The streaming buffer previously concatenated the object into a string, coercing it to `[object Object]` and leaving `bash`/`edit` calls with empty or malformed inputs; the tool-call block now holds the object payload directly. ([#1776](https://github.com/can1357/oh-my-pi/issues/1776))
- Fixed Cloud Code Assist (Gemini / Antigravity) rejecting tool schemas with `Invalid JSON payload received. Unknown name "propertyNames"` (HTTP 400) when a tool exposed a property literally named `properties` (e.g. the Resend MCP `create_contact` tool). The schema normalizer's `insideProperties` flag was re-asserted when descending into such a property's value schema, so Google-unsupported keywords (`propertyNames`, `additionalProperties`, …) nested inside it were never stripped. The flag is now only set when entering a real `properties` map from a schema node, not from within another `properties` map.
- Fixed local/self-hosted providers leaking machine-specific endpoints into the bundled `models.json`. A `generate-models` run on a machine with a LiteLLM proxy baked 1202 `litellm` models pinned to `http://localhost:4000/v1` into the committed catalog. `litellm` (and `lm-studio`) now join `ollama`/`vllm` in the generator's discovery-only exclusion set, so local providers are never fetched during generation nor written to `models.json` — they are discovered dynamically at runtime instead. LiteLLM model discovery now enriches metadata against models.dev (the same reference source the other gateway providers use) rather than a bundled reference map. Added a regression test pinning the invariant (no local provider blocks, no loopback/private-network `baseUrl`s in the bundled catalog).

## [15.8.2] - 2026-06-03

### Fixed

- Fixed `opencode-zen/minimax-m3-free` (and forward-compat `opencode-zen/minimax-m3`) and `opencode-go/minimax-m3` being routed to `anthropic-messages` despite the OpenCode Zen/Go gateways only serving these ids at `/v1/chat/completions`, which surfaced raw MiniMax/tool-call markup (`<invoke name="bash">`, `<tool_call>`, `<description>`, `<cwd>`, `<|minimax|>`) in the UI. Resolver overrides now pin these ids to `openai-completions` and the bundled `models.json` entries are flipped to match. ([#1617](https://github.com/can1357/oh-my-pi/issues/1617))
- Fixed MiniMax Coding Plan China login opening the international `platform.minimax.io` subscription page instead of the China `platform.minimaxi.com` page.

## [15.8.0] - 2026-06-02

### Added

- Added `AnthropicMessagesClient` and related Anthropic wire types/errors via `anthropic-client` export so callers can build a standalone Anthropic Messages client without depending on `@anthropic-ai/sdk`
- Added `parseClaudeRateLimitHeaders` and `AuthStorage.ingestUsageHeaders` so Anthropic rate-limit response headers can warm the per-credential usage cache with throttling while preserving per-tier data from the last full usage report.

### Changed

- Changed Anthropic request handling to use the package-local `AnthropicMessagesClient` implementation instead of `@anthropic-ai/sdk` as the default transport
- Updated the `AnthropicOptions.client` surface to accept any `AnthropicMessagesClientLike` implementation with `messages.create`, enabling custom compatible clients
- Changed generated OAuth metadata `user_id` to use a deterministic `device_id` derived from the install ID instead of a random value
- `claudeCodeVersion` bumped to `2.1.148` to match current Claude Code release.
- `X-Stainless-Package-Version` updated to `0.94.0` (matches the bundled `@anthropic-ai/sdk` version); `X-Stainless-Runtime-Version` pinned to `v24.3.0` (Bun version bundled with CC 2.1.148); `X-Stainless-Os` header key corrected to `X-Stainless-OS`.
- `createClaudeBillingHeader` now emits a deterministic billing header (`cc_version=<claudeCodeVersion>.<suffix>; cc_entrypoint=cli; cch=00000;`), where `<suffix>` is the first 3 hex chars of `SHA-256(salt + msg[4] + msg[7] + msg[20] + version)` instead of random bytes. The fingerprint seed is taken from the first **user** message (skipping synthetic/developer injections), mirroring Claude Code's `computeFingerprintFromMessages`.
- `cch` attestation implemented: `cch=00000` is a placeholder that, for OAuth requests, `wrapFetchForCch` rewrites on the wire to `XXHash64(body, 0x4D659218E32A3268) & 0xFFFFF` formatted as 5 lowercase hex chars, computed in-place via `Bun.hash.xxHash64`. The rewrite is anchored to the `system[0]` billing-header prefix so user content is never mutated, and is installed only when a billing-header prefix is present (OAuth turns).
- `anthropic-beta` header set for OAuth model discovery and Claude usage-API requests expanded to add `context-1m-2025-08-07`, `redact-thinking-2026-02-12`, `mid-conversation-system-2026-04-07`, `advanced-tool-use-2025-11-20`, `effort-2025-11-24`, and `extended-cache-ttl-2025-04-11`. The usage-API `user-agent` is bumped to `claude-cli/2.1.158 (external, cli)`.
- Reasoning models now append `effort-2025-11-24` to the per-request `Anthropic-Beta` header (matches Claude Code).
- `buildAnthropicSystemBlocks` (CC-instruction mode) now emits the same 3-block layout as Claude Code: billing header (never cached), system instruction (cached), all user content merged into one block with `\n\n` (cached). Previously emitted one block per item with cache only on the last, which fingerprinted the caller by block count.
- `applyPromptCaching` now matches Claude Code's breakpoint layout: 2 system (instruction + merged content) + 2 message, with no tool breakpoint. The tool breakpoint was redundant — tools follow system in the token sequence, so when system changes the tool cache prefix also changes. The instruction block (system[1]) is stable across every request and now gets its own guaranteed-hit breakpoint.
- `applyPromptCaching` now caches the last two messages regardless of role instead of the last two *user* messages. The penultimate assistant message (tool calls + response from the previous turn) is larger and more recently created than the penultimate user message, making it the higher-value cache target.
- OAuth scope set expanded: added `user:sessions:claude_code`, `user:mcp_servers`, `user:file_upload`. `AUTHORIZE_URL` stays at `claude.ai/oauth/authorize` and `TOKEN_URL` stays at `api.anthropic.com/v1/oauth/token` — the `platform.claude.com` equivalents are CC's console-credential flow and do not grant `user:inference`, which OMP requires for direct OAuth-token inference.
- Token refresh POST now sends `anthropic-beta: oauth-2025-04-20` and `User-Agent: anthropic-sdk-typescript/0.94.0 userOAuthProvider` (CC sends these on refresh but not on the initial code exchange).

### Fixed

- Fixed tool argument validation to wrap a plain string in a singleton array when the schema requires an array, allowing tool-level path/list normalization to recover from bare string arguments.
- Restored `eager_input_streaming` and strict flags on OAuth Anthropic tool definitions when model compatibility allows eager streaming.
- Fixed OAuth stream calls with injected custom clients missing a `beta` client by falling back to `client.messages.create` instead of requiring `client.beta.messages.create`
- Fixed direct use of internal API client typing so retry/timeouts and malformed-error classification remain compatible while not requiring the external SDK
- Fixed Cursor provider requests failing with `Cannot send empty user message to Cursor API` after tool-result history by selecting the latest user/developer turn instead of assuming the final context message is the active user turn.
- Fixed Anthropic web search dropping `ANTHROPIC_CUSTOM_HEADERS` when `CLAUDE_CODE_USE_FOUNDRY` was unset, causing 401s from corporate API gateways. `resolveAnthropicCustomHeadersForBaseUrl` now forwards the parsed headers whenever the base URL is non-Anthropic (or Foundry is enabled), and `buildAnthropicSearchHeaders` threads them through `buildAnthropicHeaders` so the search and streaming paths behave identically ([#1693](https://github.com/can1357/oh-my-pi/issues/1693)).
- Fixed OpenCode Go Anthropic-format models such as `qwen3.7-max` sending Anthropic `X-Api-Key` auth alongside the OpenCode bearer token, avoiding spurious Alibaba `401 Invalid API-key provided` errors. ([#1661](https://github.com/can1357/oh-my-pi/issues/1661))
- Fixed OAuth token exchange and refresh flows to fetch Claude CLI bootstrap identity when token responses omit account information, so `accountId` and `email` are now recovered when available
- Fixed Anthropic thinking traces being lost on direct OAuth requests. OAuth requests no longer send `redact-thinking-2026-02-12` unless thinking is explicitly hidden, Opus 4.7+ adaptive thinking opts into `display: "summarized"`, and the top user-facing thinking tier now sends Anthropic's `output_config.effort = "max"` rather than the next-lower `"xhigh"` tier.

### Removed

- Removed the `@anthropic-ai/sdk` runtime dependency. The Anthropic provider now uses the package-local `AnthropicMessagesClient` and hand-maintained wire types in `providers/anthropic-wire.ts`; the SDK was only ever used for URL assembly, auth-header injection, bounded retries, the pre-response timeout, and HTTP-error-to-status mapping, all of which are reproduced with identical observable behavior.

## [15.7.5] - 2026-06-01

### Added

- Added Anthropic task budget support, forwarding `taskBudget` as `output_config.task_budget` with the required `task-budgets-2026-03-13` beta header and accepting Anthropic gateway requests that send `output_config.task_budget`.

### Fixed

- Fixed OpenAI-family first-event timeouts so `PI_OPENAI_STREAM_IDLE_TIMEOUT_MS` cannot be undercut by a lower generic `PI_STREAM_FIRST_EVENT_TIMEOUT_MS` while local OpenAI-compatible servers are still processing large prompts. `PI_OPENAI_STREAM_FIRST_EVENT_TIMEOUT_MS` is now available for an explicit OpenAI-specific first-event override. ([#1603](https://github.com/can1357/oh-my-pi/issues/1603))

## [15.7.4] - 2026-05-31

### Fixed

- Fixed Anthropic stream idle-timeout retries after the provider stream has already begun.
- Fixed Xiaomi MiMo `/login` rejecting token-plan (`tp-`) keys with `401 Invalid API Key`. The validation request was still sending the legacy Anthropic `x-api-key` header against the OpenAI-compatible `/v1/chat/completions` endpoint; switched to `Authorization: Bearer`, matching the runtime path. ([#1580](https://github.com/can1357/oh-my-pi/issues/1580))
- Fixed OpenAI-compatible tool-call replay to send empty assistant content instead of `null`, avoiding strict custom backends that crash with `str`/`NoneType` concatenation after subagent tool results. ([#1585](https://github.com/can1357/oh-my-pi/issues/1585))

## [15.7.3] - 2026-05-31

### Changed

- Throttled per-delta streaming JSON re-parsing of OpenAI Responses/Codex tool-call arguments (bounding mid-stream parse cost from O(N²) to O(N)). Finalization via `response.output_item.done` now writes the authoritative full arguments back to the persisted assistant-message block, so tool calls finalized without a trailing `response.function_call_arguments.done` no longer retain stale/empty (`{}`) arguments. ([#1507](https://github.com/can1357/oh-my-pi/pull/1507))

## [15.6.0] - 2026-05-30

### Fixed

- Fixed Anthropic adaptive-thinking replay preserving signed thinking blocks on the latest abandoned tool-use assistant message, avoiding `thinking blocks in the latest assistant message cannot be modified` 400s. ([#1531](https://github.com/can1357/oh-my-pi/issues/1531))

## [15.5.15] - 2026-05-30

### Added

- Added `PI_REQ_DEBUG=1` request/response recording for provider transports. Each request writes `rr-session-N.json`; each received response writes `rr-session-N.res.log` with response headers followed by raw body bytes.

### Fixed

- Fixed OpenCode-Go dynamic model refresh downgrading `qwen3.7-max` from Anthropic Messages to OpenAI-compatible transport, which caused `401 Model qwen3.7-max is not supported for format oa-compat` after `/v1/models` cache refreshes.

## [15.5.12] - 2026-05-29

### Removed

- Removed ANTML stream markup healing for `antml:function_calls` and `antml:thinking` envelopes, so Anthropic-compatible providers no longer parse those tags into `toolCall`/`thinking` events

### Fixed

- Fixed GLM-5.x coding-plan OpenAI-compatible streams to use a longer default watchdog window, avoiding spurious `OpenAI completions stream stalled while waiting for the next event` errors during slow `glm-5.1` thinking/output phases. ([#1494](https://github.com/can1357/oh-my-pi/issues/1494))
- Fixed `zhipu-coding-plan` model discovery and credential validation to use the dedicated GLM Coding Plan endpoint (`https://open.bigmodel.cn/api/coding/paas/v4`) instead of the general BigModel endpoint, preventing requests from consuming ordinary account balance. ([#1494](https://github.com/can1357/oh-my-pi/issues/1494))
- Fixed DeepSeek tool calls failing on NanoGPT (e.g. `nanogpt/deepseek/deepseek-v4-pro` with reasoning enabled) by routing tool-bearing DeepSeek requests through NanoGPT's `:tools` model route and adding `nanogpt` to the DSML leak allowlist so streamed `<｜DSML｜tool_calls>...</｜DSML｜tool_calls>` envelopes are healed into structured tool calls instead of being passed through as visible text. ([#1488](https://github.com/can1357/oh-my-pi/issues/1488))
- Fixed DeepSeek tool calls failing on NanoGPT (e.g. `nanogpt/deepseek/deepseek-v4-pro` with reasoning enabled) by adding `nanogpt` to the DSML leak allowlist so streamed `<｜DSML｜tool_calls>...</｜DSML｜tool_calls>` envelopes are healed into structured tool calls instead of being passed through as visible text. The `:tools` model suffix is no longer appended on NanoGPT; that route triggered NanoGPT's server-side tool-call parser and 502'd with `code: "malformed_tool_call"` on complex tool schemas (`todo_write`) — the default route forwards `delta.content` (including DSML envelopes) which is healed client-side. ([#1488](https://github.com/can1357/oh-my-pi/issues/1488))
- Fixed OpenAI-compatible streamed parallel tool calls losing indexed argument deltas by tracking active tool-call blocks by the provider's `tool_calls[].index`; this keeps parallel NanoGPT `read` calls from merging or dropping their `path` arguments. ([#1488](https://github.com/can1357/oh-my-pi/issues/1488))

## [15.5.11] - 2026-05-29

### Added

- Added mid-conversation `system` message support for Anthropic Messages by upgrading eligible `developer` turns to `role: "system"` on first-party Claude API with Claude Opus 4.8+ and newer
- Added `supportsMidConversationSystem` to Anthropic compatibility settings so consumers can opt in to or disable mid-conversation `system` role handling per model
- Added `anthropic.claude-opus-4-8` model metadata in the model registry for Bedrock Converse streaming with effort-based thinking support through `xhigh`

### Changed

- Changed Anthropic adaptive-thinking effort mapping for Opus 4.7+ on the Messages API to use the model's full five-tier scale: user-facing efforts now shift up one notch (`minimal→low`, `low→medium`, `medium→high`, `high→xhigh`, `xhigh→max`) so the top tier reaches the genuine `max` level and `high` lands on Anthropic's recommended `xhigh` coding/agentic default. Older adaptive models (Opus 4.6) and Bedrock Converse keep the four-tier legacy mapping where `xhigh` aliases to `max`.

### Fixed

- Fixed OpenCode Zen `400 thinking is enabled but reasoning_content is missing in assistant tool call message` for every model behind `opencode-go`/`opencode-zen` (Kimi K2.x, DeepSeek V4 Pro/Flash, GLM-5.x, Qwen3.x, MiMo, MiniMax) by reactivating `requiresReasoningContentForToolCalls` and pinning the wire field to `reasoning_content` for any opencode request in thinking mode. The static compat default still omits the field for thinking-disabled turns to preserve the `Extra inputs are not permitted` guard from #1071; forced-tool turns also stay off because the existing `disableReasoningOnForcedToolChoice` guard strips thinking from the wire body. ([#1484](https://github.com/can1357/oh-my-pi/issues/1484))

## [15.5.8] - 2026-05-28

### Added

- Added `CheckCredentialsOptions.completionProbe` (and `completionTimeoutMs`) so `AuthStorage.checkCredentials` can additionally exercise each credential against the provider's chat-completion endpoint after refresh-on-expiry. Result lands on `CredentialHealthResult.completion` ({ok, reason?, modelId?, latencyMs?}) without disturbing the usage `ok` field. Public types: `CompletionProbe`, `CompletionProbeInput`, `CompletionProbeCredential`, `CredentialCompletionResult`. The probe is invoked even when no `UsageProvider` is registered for the row, and is skipped when OAuth refresh fails (the stale bytes would only mask the upstream failure).
- Added Wafer Pass and Wafer Serverless providers (`wafer-pass`, `wafer-serverless`). OpenAI-compatible (`https://pass.wafer.ai/v1`), bearer auth, `wfr_…` keys. `/login wafer-pass` and `/login wafer-serverless` paste-and-validate the key against `/v1/models`. `WAFER_PASS_API_KEY` and `WAFER_SERVERLESS_API_KEY` environment variables wired into `getEnvApiKey`. Bundled catalog seeds `wafer-pass/{GLM-5.1, Qwen3.5-397B-A17B}` and `wafer-serverless/{GLM-5.1, Kimi-K2.6, Qwen3.5-397B-A17B, Qwen3.6-35B-A3B, qwen3.7-max, deepseek-v4-flash, deepseek-v4-pro}`; dynamic discovery via `/v1/models` overlays additional models at runtime. Pass-tier discovery filters `wafer.tier === "pass_included"`. Pass-SKU costs are seeded at `0` (flat-rate subscription, no per-token charge — matches `kimi-code`/`firepass`/`alibaba-coding-plan`). Serverless costs are the wafer.ai retail rate, derived from the `*_cents_per_million` envelope via `value × 125 / 10000` (e.g. GLM-5.1 `120` → $1.50/M, Kimi-K2.6 `88` → $1.10/M). Reasoning entries get a thinking compat picked from the `wafer.provider` envelope: `zai`/`moonshotai` → zai-style `thinking: { type }`, `qwen` → top-level `enable_thinking`, `deepseek` and unknown upstreams stay unset so `detectOpenAICompat` can pick `reasoning_effort` from the id pattern at request time.

### Changed

- Changed auth-gateway credential resolution to use per-conversation `promptCacheKey`/`sessionId` when calling `AuthStorage.getApiKey`, so repeated turns can keep the same credential until it becomes unavailable
- Changed auth-gateway and pi-native request handling to align `sessionId` with prompt/context identity before credential lookup
- Changed Anthropic prompt preparation to downscale image blocks over 2000px when a request includes 20+ images, reducing oversized payloads automatically
- Changed OpenAI chat request parsing to accept `name` on `tool` messages and fall back to the matching assistant `tool_calls` name, so parsed tool results now carry a proper tool name when the wire omits it
- Changed `checkCredentials` to skip running `completionProbe` when OAuth refresh fails, so stale bearer tokens are never probed and the refresh failure remains the returned `reason`
- Changed completion reporting to return `completion: { ok: null, reason: ... }` when a credential has no usable bearer bytes instead of attempting the probe
- Refactored `AuthStorage.checkCredentials` so OAuth refresh-on-expiry runs up-front and the refreshed credential is shared between the usage probe and the new completion probe; rows without a registered `UsageProvider` no longer short-circuit before the completion probe runs.

### Fixed

- Fixed DeepSeek DSML tool-call envelope leaks on Ollama Cloud and OpenAI-compatible streams by healing leaked envelopes into structured tool calls without displaying raw DSML markers. ([#1462](https://github.com/can1357/oh-my-pi/issues/1462))
- Fixed auth-gateway to classify usage-limit messages such as `usage_limit_reached`, `resource_exhausted`, and Codex-style `Try again in ~X min` text as 429 `rate_limit_error` responses
- Fixed auth-gateway usage-limit handling to honor parsed retry hints and switch to a sibling credential via `markUsageLimitReached` instead of invalidating the rate-limited credential
- Fixed `streamSimple` to retry on usage-limit errors (including message-only error events) before any content is emitted, so `onAuthError` can rotate credentials automatically
- Fixed auth-gateway error classification to extract embedded status codes and use word-boundary matching, so `GenerateContentRequest` and similar messages are no longer misreported as rate-limit errors
- Fixed `checkCredentials` to handle `completionProbe` exceptions by recording the failure in `CredentialHealthResult.completion.reason` while still returning the usage probe result
- Fixed Google Vertex's bundled model list to use the authoritative models.dev catalog, including MaaS entries such as `deepseek-ai/deepseek-v3.2-maas` and removing retired Gemini 1.5 fallbacks. ([#1456](https://github.com/can1357/oh-my-pi/issues/1456))

## [15.5.7] - 2026-05-27

### Added

- `SimpleStreamOptions.openrouterVariant` (`"nitro"`, `"floor"`, `"online"`, `"exacto"`, …) — when set, appends `:<variant>` to OpenRouter model IDs at request time, leaving ids that already carry an explicit `:suffix` untouched. Plumbed through `openai-completions` and the pi-native gateway forwarder.
- xAI Grok OAuth (SuperGrok Subscription) provider in `/login`. Loopback PKCE flow on `127.0.0.1:56121`; the token unlocks Grok-4.x chat. Ported from NousResearch/hermes-agent (MIT).
- OpenRouter provider in `/login`. API-key paste flow validated against `https://openrouter.ai/api/v1/auth/key` (the `/models` endpoint is public and cannot validate auth). The pasted key is stored under the existing `openrouter` provider id used by `OPENROUTER_API_KEY`.
- `XAI_OAUTH_TOKEN` environment variable accepted as a headless fallback for the xAI Grok OAuth provider.

### Changed

- `OpenAIResponsesOptions` gains four optional, provider-agnostic fields that adapter wrappers can use to compose provider-specific behavior on top of the generic transport: `includeEncryptedReasoning` (gates `include: ["reasoning.encrypted_content"]`; default `true`, preserves current behavior), `filterReasoningHistory` (strips replayed `type: "reasoning"` items from conversation history; default `false`), `headers` (merged onto the client's default headers), and `extraBody` (merged into the request payload).
- The existing `XAI_API_KEY` path is unchanged — it continues to use the OpenAI-completions transport.

### Fixed

- Fixed OpenRouter DeepSeek V4 tool-call follow-up requests replaying normalized `reasoning` as-is instead of DeepSeek's required `reasoning_content`, which caused HTTP 400 errors in thinking mode. ([#1445](https://github.com/can1357/oh-my-pi/issues/1445))

## [15.5.6] - 2026-05-27

### Added

- Added `PI_CODEX_WEBSOCKET_MAX_IDLE_REUSE_MS` to control how long an idle Codex WebSocket stays eligible for reuse, with `0` disabling the check

### Fixed

- Fixed reused Codex WebSocket connections that had gone silent without activity to be dropped and replaced with a fresh handshake after the idle-reuse threshold, preventing stalled next requests
- Fixed stale response frames left in the websocket queue from a completed turn so subsequent requests no longer process terminal frames from the previous response
- Fixed websocket dead-socket detection to fail a stale connection when no inbound traffic or pong is observed after a ping timeout, improving recovery on runtimes that do not emit pong events

## [15.5.5] - 2026-05-27

### Added

- Added `PI_CODEX_WEBSOCKET_PING_INTERVAL_MS` to configure the interval for Codex WebSocket protocol ping heartbeats
- Added `PI_CODEX_WEBSOCKET_PONG_TIMEOUT_MS` to configure the Codex WebSocket pong timeout used to detect unresponsive connections
- Added `PI_CODEX_WEBSOCKET_MESSAGE_QUEUE_CAPACITY` to configure the maximum buffered Codex WebSocket inbound queue size before transport fallback

### Changed

- Improved Codex WebSocket timeout diagnostics to include last event type and time since last progress event
- Enhanced Codex WebSocket error classification to recognize ping, pong, send, and queue-overflow failures as retryable

### Fixed

- Fixed Codex WebSocket send failures by wrapping socket.send() in try-catch and surfacing errors as retryable transport errors
- Fixed Codex WebSocket inbound queue overflow by adding capacity bounds and triggering fallback to SSE when exceeded
- Fixed Codex WebSocket pong timeout detection by tracking pong events and failing the connection when no pong is received within the configured timeout
- Fixed Anthropic streaming to suppress hallucinated meta-prompt thinking blocks (the recent "I don't see any current rewritten thinking..." regression). When the marker phrase `rewritten thinking` appears in a streamed thinking summary the block is collapsed to a plain `Thinking...` placeholder and its signature is dropped so subsequent turns can't re-anchor on the garbled chain.
- Fixed Codex WebSocket silent stalls by adding protocol pings, inbound queue bounding, clearer idle-timeout diagnostics, and SDK retry clamping for first-event timeouts.

## [15.5.0] - 2026-05-26

### Added

- Added `zhipu-coding-plan` provider for Zhipu (智谱) BigModel's domestic coding-plan SKU at `https://open.bigmodel.cn/api/coding/paas/v4`, with dynamic model discovery (`ZHIPU_API_KEY`), zai-format thinking, `reasoning_content` field, and OAuth login flow ([#1340](https://github.com/can1357/oh-my-pi/issues/1340)).

### Removed

- Removed the `pi-ai` CLI binary (`packages/ai/src/cli.ts`) and its `bin` entry. Use the in-process equivalent in the omp coding-agent CLI: `omp auth-broker login [provider]`, `omp auth-broker logout [provider]`, and `omp auth-broker list`. The library API (`AuthStorage.login()`, `getOAuthProviders()`, etc.) is unchanged.

### Fixed

- Fixed delayed `toolResult` emissions so real tool results are emitted in the correct assistant `toolCall` window after handoff/compaction, preventing out-of-order or orphaned tool results
- Fixed delayed `toolResult` handling for aborted calls so a late real result is emitted instead of a synthetic `aborted` result for the same `toolCallId`
- Fixed usage polling to disable credentials when OAuth refresh fails definitively (for example `invalid_grant`) and clear cached last-good usage data so stale reports no longer remain visible

## [15.4.3] - 2026-05-26

### Fixed

- Fixed Google Vertex model discovery to use the project-scoped OpenAI-compatible model list so Vertex Model Garden models such as GLM and Claude are available through ADC auth ([#1412](https://github.com/can1357/oh-my-pi/issues/1412)).

## [15.4.2] - 2026-05-26

### Fixed

- Fixed OpenCode Zen `big-pickle` follow-up requests replaying assistant tool-call turns without DeepSeek-required `reasoning_content`, which caused HTTP 400 errors in thinking mode.

## [15.4.1] - 2026-05-26

### Added

- Added `isOpenAICompletionsProgressChunk` export to identify real progress chunks vs. keepalives in OpenAI completions streams
- Added per-provider stream watchdog overrides via `getStreamIdleTimeoutMs(fallbackMs)` and `getStreamFirstEventTimeoutMs(idleTimeoutMs, fallbackMs)` to allow providers like Google Gemini CLI to extend first-event timeouts without affecting global defaults
- Added `promptCacheKey` to `StreamOptions` and passed it through stream option mapping so callers can specify an explicit prompt-cache key separate from `sessionId`
- Added `promptCacheKey` support to the native server option whitelist so `promptCacheKey` is accepted by `pi-native-server` streams
- Restored the per-provider stream watchdog (`iterateWithIdleTimeout`) on top of the abortable iterator. The lazy stream forwarder in `register-builtins` now wraps every provider's event stream with the first-event + steady-state idle watchdog (`PI_STREAM_FIRST_EVENT_TIMEOUT_MS`, `PI_STREAM_IDLE_TIMEOUT_MS`; aliases honored), and Anthropic / OpenAI Completions / OpenAI Responses / Azure OpenAI Responses / Codex SSE re-emit their per-provider progress predicates so empty keepalive frames cannot keep a stalled stream alive. Reverts the partial regression from #1392 that left Codex WebSocket subagent runs hanging silently for hours when the broker dropped frames between deltas. The Codex WebSocket transport additionally now resets `lastProgressAt` only on progress events (not keepalives), giving the 300s WS-internal idle ceiling the same liveness semantics as the SSE path.

### Changed

- Enabled OpenAI Codex WebSocket streams to apply `streamIdleTimeoutMs` and `streamFirstEventTimeoutMs` from `StreamOptions` per request instead of fixed internal defaults
- Changed stream idle watchdog implementation from `iterateUntilAbort` to `iterateWithIdleTimeout`, which now enforces maximum idle gaps between streamed events and distinguishes between first-event and steady-state timeouts
- Changed Anthropic, OpenAI Responses, OpenAI Completions, Azure OpenAI Responses, and OpenAI Codex Responses providers to use the new idle-timeout iterator with per-provider progress predicates so empty keepalive frames cannot keep a stalled stream alive
- Changed Codex WebSocket transport to reset `lastProgressAt` only on progress events (not keepalives), giving the 300s WS-internal idle ceiling the same liveness semantics as the SSE path
- Changed Google Gemini CLI stream forwarding defaults to use a 5-minute first-event floor via per-provider lazy-stream limits to avoid premature first-event timeouts on slow startup
- Changed OpenAI Responses and OpenAI Codex request handling to keep `sessionId` for provider routing and conversation headers while `promptCacheKey` controls the `prompt_cache_key` payload independently
- Changed `StreamOptions.streamIdleTimeoutMs` documentation to clarify it is now wired into every built-in provider and the lazy stream forwarder, and that `streamFirstEventTimeoutMs` is honored at both the SDK-request layer and the iterator-watchdog layer
- Changed OpenAI Responses and OpenAI Codex request handling so `sessionId` continues to drive provider routing and state while `promptCacheKey` controls the `prompt_cache_key` payload
- Changed Google Gemini CLI stream forwarding defaults to use a 5-minute first-event floor to avoid premature first-event timeouts on slow startup
- Changed auth-gateway request mapping to preserve incoming `prompt_cache_key` as both `promptCacheKey` and `sessionId` when routing OpenAI-compatible sessions
- Un-deprecated `StreamOptions.streamIdleTimeoutMs`; the option is wired into every built-in provider and the lazy stream forwarder again. `streamFirstEventTimeoutMs` is now honored at both the SDK-request layer (via `createSdkStreamRequestOptions`) and the iterator-watchdog layer, in cooperation.

### Removed

- Removed `installH2Fetch` and the `fetch` patch that forced HTTP/2 on HTTPS requests; callers now use the default Bun `fetch` transport

### Fixed

- Fixed first-item timeout handling so `iterateWithIdleTimeout` no longer keeps first-event timers active after the source throws or the consumer stops before semantic progress
- Fixed silent multi-hour hangs on Codex WebSocket subagent runs when the broker dropped frames between deltas by restoring per-provider stream watchdogs with progress-event filtering
- Fixed z.ai/GLM-via-OpenRouter subagent stalls where no-op keepalive chunks reset the idle watchdog indefinitely by filtering non-progress items before resetting the deadline

## [15.4.0] - 2026-05-26

### Breaking Changes

- Removed `findAnthropicAuth` from `anthropic-auth` and replaced store-driven auth discovery with `buildAnthropicAuthConfig`, requiring callers to provide an already-resolved API key before building Anthropic auth config

### Added

- Added `PI_CODEX_WEBSOCKET_FIRST_EVENT_TIMEOUT_MS` and `PI_CODEX_WEBSOCKET_IDLE_TIMEOUT_MS` options to tune Codex WebSocket timeout behavior before fallback
- Added `AuthStorage.getOAuthAccess` to return a refreshed OAuth access token with identity metadata (`accountId`, `email`, `projectId`, `enterpriseUrl`) for callers that need bearer-token headers together
- Added Codex WebSocket forwarding to the `onSseEvent` observer so the raw provider-stream debug viewer captures the inbound JSON frames and the outbound request frame from the WS transport using the same synthesized SSE-wire shape (`event:` + `data:` lines, prefixed with a `: ws ← <type>` (inbound) or `: ws → <type>` (outbound) comment).

### Changed

- Changed OAuth selection in `AuthStorage` to treat credentials as stale when they are within 60 seconds of expiry and rotate them preemptively
- Changed Google Gemini CLI, Google Gemini usage, Antigravity usage, and Kimi usage flows to stop refreshing OAuth tokens directly and rely on `AuthStorage` for token rotation

### Deprecated

- Deprecated `streamIdleTimeoutMs` in `StreamOptions` as a compatibility-only field that is no longer used by providers

### Removed

- Removed provider-local OAuth refresh helpers from Google Gemini CLI and Google/Kimi/Antigravity usage probes, preventing direct refresh calls from those usage paths

### Fixed

- Dropped truncated, thinking-only assistant turns with only `thinking`/`redacted_thinking` blocks and no `text` or `tool` content during message transformation, preventing Anthropic requests from sending consecutive assistant messages after a `max_tokens`/`error`/`aborted` interruption
- Fixed Amazon Bedrock bearer-token authentication to honor `AWS_BEARER_TOKEN_BEDROCK` before resolving AWS profiles or running `credential_process`, matching Bedrock API-key precedence. ([#1399](https://github.com/can1357/oh-my-pi/issues/1399))
- Updated `isRetryableError` to treat Bun HTTP/2 transport errors (`HTTP2StreamReset`, `HTTP2RefusedStream`) as retryable so transient stream-reset failures can be retried
- Fixed Codex WebSocket streaming to recover from stalled sessions by falling back to SSE when the first event or subsequent progress is delayed beyond the configured websocket timeout
- Fixed expired OAuth handling so provider-level paths no longer attempt direct token refresh calls for expired credentials and instead rely on `AuthStorage` for rotation
- Fixed provider streams aborting slow-but-valid first tokens or silent inter-event gaps with OMP-owned first-event/idle watchdog errors. Built-in lazy streams, OpenAI/Anthropic/Azure/Codex SSE, and Codex WebSocket streams now wait for provider output, provider/socket errors, caller aborts, or explicit request-layer timeouts instead of treating provider silence as failure ([#1392](https://github.com/can1357/oh-my-pi/issues/1392)).
- Fixed Claude Opus 4.7 on Amazon Bedrock streaming no reasoning output (and appearing to hang on long reasoning runs) because Anthropic silently switched the adaptive-thinking display default to `"omitted"`. The Bedrock provider now sends `thinking.display = "summarized"` by default on Opus 4.7+ adaptive models and on budget-based Claude models, mirroring the existing direct-Anthropic behavior. `BedrockOptions.thinkingDisplay` (`"summarized" | "omitted"`) is exposed for callers that want to opt out, and `hideThinkingSummary` now wires through to the Bedrock case ([#1373](https://github.com/can1357/oh-my-pi/issues/1373)).
- Fixed Cursor Composer resume/tool-continuation turns failing with `Cannot send empty user message to Cursor API`. Empty current user turns now use Cursor's `resumeAction` instead of constructing an invalid `userMessageAction` ([#1376](https://github.com/can1357/oh-my-pi/issues/1376)).
- Fixed `pi-ai login moonshot` failing with `invalid temperature: only 1 is allowed for this model` (HTTP 400) because the API-key validator probed `kimi-k2.5` with `temperature: 0`. Moonshot login now validates against `GET /v1/models`, matching the DeepSeek/Fireworks/NanoGPT/ZenMux pattern and authenticating the key without invoking model-specific parameter restrictions.

## [15.3.2] - 2026-05-25

### Added

- Added `GET /v1/snapshot/stream` for live auth-broker snapshot updates via SSE with `snapshot`, `entry`, and `removed` event frames
- Added `AuthBrokerClient.openSnapshotStream()` for consuming SSE snapshot streams from `/v1/snapshot/stream`
- Added `streamSnapshots` option to `RemoteAuthCredentialStore` (default `true`) to enable or disable SSE-based snapshot synchronization
- Added `streamKeepaliveMs` to `startAuthBroker()` to tune heartbeat frequency for the SSE stream
- Added `AuthStorage.checkCredentials({ signal?, timeoutMs?, baseUrlResolver? })` that returns a per-credential `CredentialHealthResult` with tri-state `ok` (`true` / `false` / `null`-unverifiable), the credential's identity (provider, type, email/accountId, broker-refresh flag), and the upstream error string when the probe fails. Iterates sequentially over `listAuthCredentials()`, exercises OAuth refresh on expiry, then calls the per-provider `UsageProvider.fetchUsage` without swallowing errors — so callers can identify which row in a multi-account broker is producing 401s instead of getting a silently-deduplicated `fetchUsageReports` list.
- Added `GET /v1/credentials/check` to `startAuthGateway()` that forwards to `AuthStorage.checkCredentials` and returns `{ generatedAt, credentials }`. Gated by the same bearer as the rest of the gateway.

### Changed

- Changed `RemoteAuthCredentialStore` to prefer SSE snapshot streaming and automatically fall back to long-polling when a broker returns 404 for `/v1/snapshot/stream`
- Changed snapshot write-refresh flow so `RemoteAuthCredentialStore` skips immediate `/v1/snapshot` refreshes when SSE streaming is active
- Changed broker SSE stream behavior to keep connections open with periodic keepalives and an increased server idle timeout

## [15.3.0] - 2026-05-25

### Added

- Added DeepSeek to the built-in API-key login provider catalog so `omp login deepseek` stores a reusable `DEEPSEEK_API_KEY` credential for the bundled DeepSeek models.

## [15.2.4] - 2026-05-22

### Fixed

- Fixed ChatGPT Plus/Pro (Codex) OAuth login returning `Token exchange failed: 403` on Windows. When port 1455 was in use, the callback server silently fell back to a random port; OpenAI's authorization endpoint accepts any localhost redirect URI (loose validation), so the browser callback succeeds and shows "Authentication Successful", but the token endpoint rejects the non-registered port with 403. The `OpenAICodexOAuthFlow` now enforces a fixed `redirectUri` option so a busy port immediately surfaces as "port unavailable" instead of producing a confusing 403 ([#1277](https://github.com/can1357/oh-my-pi/issues/1277)).
- Improved `exchangeCodeForToken` error diagnostics: the 403 response body (`error` / `error_description` fields) is now included in the thrown message, matching the existing `refreshOpenAICodexToken` behaviour.

### Added

- Added `ChatGPT Plus/Pro (Codex, headless/device)` (`openai-codex-device`) as an alternative login method for the Codex provider. Uses OpenAI's device-code flow (`/api/accounts/deviceauth/usercode` → poll `/api/accounts/deviceauth/token`), which avoids a local callback server and port 1455 entirely. Credentials are stored under the existing `openai-codex` provider key so all models and tooling continue to work without reconfiguration ([#1277](https://github.com/can1357/oh-my-pi/issues/1277)).

## [15.2.2] - 2026-05-22

### Fixed

- Fixed `gemini-3.1-pro-high` and `gemini-3.1-pro-low` on the `google-antigravity` provider always returning HTTP 400 from Cloud Code Assist. The `ANTIGRAVITY_SYSTEM_INSTRUCTION` identity header was not injected for these models because the internal check matched the string `"gemini-3-pro-high"` (hyphen) instead of the versioned `"gemini-3.1-pro-..."` form. The guard now matches all `gemini-3` model variants ([#1274](https://github.com/can1357/oh-my-pi/issues/1274)).

## [15.2.0] - 2026-05-21

### Fixed

- Fixed `/login` (and `/logout`, plus any `AuthStorage.set` / `remove` call) against a remote auth-broker throwing `RemoteAuthCredentialStore is read-only on the client. Use 'omp auth-broker login <provider>' to mutate credentials.` Added three optional async write hooks to `AuthCredentialStore` (`upsertAuthCredentialRemote`, `replaceAuthCredentialsRemote`, `deleteAuthCredentialsRemote`); `RemoteAuthCredentialStore` implements them via the broker's `POST /v1/credential` and `POST /v1/credential/:id/disable` endpoints and applies the broker's authoritative post-write entries to the local snapshot. `AuthStorage` routes through the hooks when present, so OAuth and API-key logins (and logouts) initiated from a broker-backed client now persist server-side and surface immediately without waiting for the long-poll snapshot tick.

## [15.1.9] - 2026-05-21

### Fixed

- Fixed Ollama named tool forcing to send only the requested tool when the caller passes a named `toolChoice`, preserving `tool_choice: "required"` while preventing local models from selecting a different tool. ([#1236](https://github.com/can1357/oh-my-pi/issues/1236))
- Fixed `/btw` (and IRC background replies) returning a `BedrockException` 400 (`The toolConfig field must be defined when using toolUse and toolResult content blocks.`) on LiteLLM → Bedrock once the session has tool-call history. Two source fixes in `buildParams`: (1) `if (context.tools)` → `if (context.tools?.length)` so an explicit `context.tools = []` (the /btw opt-out) never routes through `convertTools` and never emits an empty `"tools"` array; (2) `else if (hasToolHistory(...))` → `else if (context.tools === undefined && hasToolHistory(...))` so the Anthropic-proxy sentinel that injects `tools: []` for tool-history turns is suppressed when the caller explicitly opted out, preventing it from re-introducing the empty array. As defence-in-depth, `tool_choice: "none"` is also dropped when the resolved tools list is missing or empty. ([#1227](https://github.com/can1357/oh-my-pi/issues/1227))

## [15.1.8] - 2026-05-20

### Added

- Added Fireworks Fire Pass as a separate `firepass` provider with API-key login flow, bundled `kimi-k2.6-turbo` model entry (Kimi K2.6 Turbo), and wire-id translation from the friendly catalog id to the `accounts/fireworks/routers/kimi-k2p6-turbo` router endpoint. Fire Pass keys (`fpk_…`) authorize only the dedicated router and reject `/v1/models`, so login validation pings chat completions against the router id directly. Extended the openai-completions Kimi-family safety net so the firepass entry inherits the per-Fireworks-docs "always send `max_tokens`" default ([Kimi K2 guide](https://docs.fireworks.ai/models/kimi-k2)); the router's accepted `reasoning_effort` set includes `xhigh`, so it is forwarded verbatim rather than remapped. See https://docs.fireworks.ai/firepass.

### Fixed

- Fixed DeepSeek V4 direct API requests with tools to keep documented thinking mode instead of dropping reasoning: lower OMP efforts now map to DeepSeek's supported `high`, `tool_choice` is omitted, `thinking: { type: "enabled" }` and `max_tokens` are sent, and partial user `reasoningEffortMap` overrides merge with DeepSeek defaults. ([#1207](https://github.com/can1357/oh-my-pi/issues/1207))
- Fixed model cache schema v2 databases so offline refreshes preserve cached provider discoveries after upgrading to schema v3 and subsequent online refreshes can overwrite the cache. ([#1219](https://github.com/can1357/oh-my-pi/issues/1219))
- Fixed Perplexity OAuth credentials being treated as expired one hour after login. `getJwtExpiry` was fabricating `expires = now + 1h` whenever the JWT had no `exp` claim (the common case — Perplexity sessions are server-side). Once the hour elapsed, `getOAuthApiKey` would mark the cred expired and the search provider's loader would silently skip it, surfacing as "logged out". Logins with no `exp` now persist a far-future sentinel; `getOAuthApiKey` also normalizes any stale `expires` written by older builds.

## [15.1.7] - 2026-05-19

### Added

- Added Anthropic realization of `serviceTier: "priority"`. The anthropic-messages provider now sets `speed: "fast"` on the request and appends the `fast-mode-2026-02-01` beta to `Anthropic-Beta` whenever the caller passes `serviceTier: "priority"`. When the server rejects an unsupported model with `invalid_request_error`, the provider transparently retries the same turn without the fast-mode signal (mirroring the strict-tools fallback pattern), persists the disable via a new `providerSessionState.fastModeDisabled` flag so subsequent requests in the session skip the field, and surfaces the action via the new `AssistantMessage.disabledFeatures` array (id `"priority"`) so callers can sync user-facing toggles. A new `clearAnthropicFastModeFallback(providerSessionState)` helper lets callers re-arm priority after the auto-fallback fired.
- Added scoped `ServiceTier` values: `"openai-only"` (priority on `openai`/`openai-codex`, ignored elsewhere) and `"claude-only"` (priority on direct `anthropic`, ignored on Bedrock/Vertex Claude and elsewhere). A new `resolveServiceTier(serviceTier, provider)` helper computes the effective tier for the provider; existing OpenAI/Anthropic provider code routes through it, so `service_tier` and Anthropic fast-mode emission both respect scope. `getPriorityPremiumRequests` now counts Anthropic+priority as one premium request (previously zero) and continues to ignore providers that drop the field on the wire.

### Fixed

- Fixed Anthropic fast mode (`serviceTier: "priority"`) looping on 429 `rate_limit_error: "Extra usage is required for fast mode."` for accounts without the extra-usage entitlement. `isAnthropicFastModeUnsupportedError` now matches the 429 phrasing in addition to the 400 `invalid_request_error` "does not support the `speed` parameter" case, so the provider drops `speed: "fast"` on the in-turn retry, sets `providerSessionState.fastModeDisabled` for the remainder of the session, and surfaces `disabledFeatures: ["priority"]` to the caller instead of retrying with the same payload until `PROVIDER_MAX_RETRIES` is exhausted.

## [15.1.6] - 2026-05-19

### Fixed

- Fixed `{}` (empty JSON Schema, the wire representation of `z.unknown()`) being passed verbatim to grammar-constrained samplers (llama.cpp, etc.) in `additionalProperties`, `items`, and other schema-valued positions across **every provider** (OpenAI, Anthropic, Google, Ollama, Bedrock, Cursor). Grammar builders treat `{}` as "generate an empty object" rather than "any JSON value", causing open-typed fields (e.g. `extra.title` from `z.record(z.string(), z.unknown())`) to always emit `{}` instead of the intended string/number/etc. `toolWireSchema` now applies a new `normalizeEmptySchemas` pass (exported) to both the Zod and TypeBox/raw-JSON-Schema branches, converting `{}` → `true` (semantically identical per JSON Schema draft 2020-12 §4.3.1) in all schema-valued positions. Strict-mode opt-out is preserved across all providers: OpenAI's `hasUnrepresentableStrictObjectMap` hits the `=== true` branch instead of the `isJsonObject({})` branch (same result); Anthropic's `normalizeAnthropicStrictSchemaNode` opts out via `additionalProperties !== false` (still true for `true`); Google's `normalizeSchemaForGoogle` strips `additionalProperties` regardless (pre-existing). ([#1179](https://github.com/can1357/oh-my-pi/issues/1179))
- Fixed `pi-ai login <provider>` crashing with `Unknown provider` for providers that only the `auth-storage` `login()` switch knew about (perplexity, alibaba-coding-plan, gitlab-duo, huggingface, opencode-zen/go, lm-studio, ollama, cerebras, fireworks, qianfan, synthetic, venice, litellm, moonshot, together, cloudflare/vercel ai gateways, vllm, qwen-portal, nvidia, xiaomi, and any custom OAuth provider). The CLI now delegates to `SqliteAuthCredentialStore.login()` instead of duplicating a smaller switch, so the auth-broker `omp auth-broker login <provider>` flow works for every registered OAuth provider.

## [15.1.4] - 2026-05-19

### Changed

- Updated auth-gateway format and pi-native request handling to invalidate the failed API key and retry the provider request with a replacement key when authentication fails

### Fixed

- Fixed OpenAI Responses and Codex tool schema normalization to emit `properties: {}` for no-argument object schemas without rewriting literal payloads. ([#1147](https://github.com/can1357/oh-my-pi/issues/1147))
- Fixed Anthropic 400 (`unexpected tool_use_id found in tool_result blocks ... Each tool_result block must have a corresponding tool_use block in the previous message`) when handoff/compaction folds an assistant `tool_use` into the handoff summary string but leaves the matching user-side `tool_result` message in the history. `transformMessages` now indexes every `tool_use` id surviving the first pass and drops orphan `tool_result` messages whose originator was compacted away, preserving the text payload as a user-level `<stale-tool-result>` note so the model still sees what the tool returned. The note is emitted with `role: "user"` rather than `role: "developer"` so providers that elevate developer-role messages (Ollama: `developer` → `system`; OpenAI chat-completions reasoning models: `developer` → `developer`) cannot lift stale tool output to an instruction-priority tier above the surrounding user/developer messages.
- Fixed streaming authentication retry to trigger when a provider emits a 401 `error` event after a `start` event but before any replay-unsafe content is emitted
- Added `credential_process` support to the Bedrock provider's AWS credential resolver so profiles delegating to external brokers (`aws-vault`, `granted`, in-house tools) resolve instead of falling through to `Unable to resolve AWS credentials`. Parses the AWS SDK `Version: 1` JSON envelope, honors `Expiration` in the per-profile cache, propagates `AbortSignal` to the spawned helper, routes Windows `.cmd`/`.bat` helpers through `cmd.exe /c`, and ships a POSIX-shell-style tokenizer that preserves backslashes inside double quotes so Windows paths survive ([#1142](https://github.com/can1357/oh-my-pi/issues/1142))

## [15.1.3] - 2026-05-17

### Breaking Changes

- Changed `AuthBrokerClient.fetchSnapshot()` to return status-based results (`200` or `304`) instead of always returning a raw snapshot body, so callers now need to branch on `status`
- Renamed public schema utilities in `@pk-nerdsaver-ai/pi-ai/utils/schema` by replacing `sanitizeSchemaForGoogle`, `sanitizeSchemaForCCA`, `prepareSchemaForCCA`, and `sanitizeSchemaForMCP` with `normalizeSchemaForGoogle`, `normalizeSchemaForCCA`, and `normalizeSchemaForMCP`
- Added MCP schema normalization via `normalizeSchemaForMCP` for compatibility checks
- Removed the `StringEnum` helper from `@pk-nerdsaver-ai/pi-ai/utils/schema`. Use `z.enum([...])` directly; Zod's emitted JSON Schema is already wire-compatible with Google and other providers.
- Renamed the concrete SQLite credential store class from `AuthCredentialStore` to `SqliteAuthCredentialStore`. `AuthCredentialStore` is now the persistence interface implemented by both the SQLite store and the new `RemoteAuthCredentialStore`. Update `new AuthCredentialStore(db)` / `AuthCredentialStore.open(...)` call-sites to `SqliteAuthCredentialStore`; type-position uses (`store: AuthCredentialStore`) continue to work unchanged.

### Added

- Added `onAuthError` to `StreamOptions` and wired `streamSimple()` to retry once with a replacement API key when the first provider response is a 401 before any assistant events are emitted
- Added generation-aware snapshot metadata (`generation`, `serverNowMs`, `refresher`, and `rotatesInMs`) to auth-broker snapshot responses to support client-side credential-rotation planning
- Added `transport: "pi-native"` on `Model` and the matching `streamPiNative` client. When `model.transport === "pi-native"`, `streamSimple` short-circuits the per-provider dispatch and POSTs the canonical `Context` to the auth-gateway's `POST /v1/pi/stream` endpoint. The response is SSE-framed `AssistantMessageEvent`s parsed by `readSseJson` and pushed verbatim into the local `AssistantMessageEventStream` — no wire-format translation, no partial-stripping reconstruction. Used by containerized omp installs (robomp slots, swarm extension, etc.) to route every LLM call through a credential-holding sidecar; the slot itself never sees the real provider tokens. Server-controlled fields (`apiKey`, `signal`, `fetch`, lifecycle callbacks, the provider-session map) are stripped from the wire body — `apiKey` rides in the `Authorization` header as the gateway bearer.
- Added `POST /v1/pi/stream` to the auth-gateway. Same auth + abort + model-resolution + codex-compat + prefix-cache plumbing as the foreign-wire routes; only the wire-format translation is skipped. Request body is `{ modelId, context, options?, stream? }` where `context` is the canonical pi-ai `Context` and `options` is `SimpleStreamOptions` with non-serializable fields stripped. Response is SSE-framed `AssistantMessageEvent` (terminated by `data: [DONE]`) when streaming, or `{ message: AssistantMessage }` JSON when `stream: false`.
- Added Vertex AI authentication via Google Application Default Credentials from `GOOGLE_APPLICATION_CREDENTIALS`, `~/.config/gcloud/application_default_credentials.json`, or metadata server tokens, with token caching and refresh skew control via `GOOGLE_VERTEX_REFRESH_SKEW_MS`
- Added support for Anthropic image message parts with `type: "url"` and `type: "file"` sources
- Added `stopSequences` and `frequencyPenalty` to shared stream options and wired them through to OpenAI request translation
- Added optional request cancellation support to auth-broker interactions by propagating `AbortSignal` into health, snapshot, usage, and refresh calls
- Added `AuthStorage.setConfigApiKey` / `removeConfigApiKey` / `clearConfigApiKeys` for config-sourced per-provider bearers (e.g. `models.yml` `providers.<name>.apiKey`). The new tier sits between runtime `--api-key` and stored credentials in `getApiKey`/`peekApiKey` resolution, so a bearer pinned in config now beats the broker's OAuth access token. Also suppresses OAuth `account_uuid` attribution when active, since outbound auth is the explicit config bearer, not OAuth. `describeCredentialSource` reports `"config override (models.yml)"` for visibility.
- Added per-model `additional_rate_limits` parsing to `openaiCodexUsageProvider`. The Codex `wham/usage` endpoint surfaces a separate `GPT-5.3-Codex-Spark` rate limit (`metered_feature: codex_bengalfox`) on Pro accounts; these now emit dedicated `openai-codex:spark:{primary,secondary}` `UsageLimit` entries with `scope.tier = "spark"`, mirroring how Anthropic exposes `anthropic:7d:sonnet` separately from the umbrella `anthropic:7d` bucket. The osx-widgets client already keyed spark detection off `limit.id.includes("spark")`; this populates that contract end-to-end.
- Added `GET /v1/usage` to the auth-broker API to expose aggregated usage reports from `AuthStorage.fetchUsageReports`
- Added auth-broker usage polling response handling that returns normalized usage reports plus generation timestamp for clients (5-min per-credential cache via `AuthStorage`)
- Added the auth-broker subsystem (`@pk-nerdsaver-ai/pi-ai/auth-broker`) for sharing OAuth credentials across machines without leaking refresh tokens.
- `startAuthBroker(...)` boots a `Bun.serve` HTTP server exposing `GET /v1/healthz`, `GET /v1/snapshot`, `POST /v1/credential` (upsert), `POST /v1/credential/:id/refresh`, and `POST /v1/credential/:id/disable`.
- `AuthBrokerClient` is the matching HTTP client used by remote clients.
- `RemoteAuthCredentialStore` is a client-side `AuthCredentialStore` that mirrors a broker snapshot in memory; mutating methods (`replace*`, `upsert*`, `delete*ForProvider`) throw because writes are server-side only.
- `AuthBrokerRefresher` is the background refresh loop that pre-refreshes credentials within `refreshSkewMs` and disables on definitive failure (`invalid_grant` / non-network 401-403).
- Added `AuthStorage.exportSnapshot()`, `AuthStorage.upsertCredential(provider, credential)`, `AuthStorage.forceRefreshCredentialById(id)`, and `AuthStorage.disableCredentialById(id, cause)` public methods consumed by the auth-broker server.
- Added `AuthStorageOptions.refreshOAuthCredential` override so a remote-store client can route every OAuth refresh through the broker instead of the local OAuth endpoint.
- Added `REMOTE_REFRESH_SENTINEL` (`"__remote__"`) — the wire placeholder substituted for OAuth refresh tokens in broker snapshots; clients never see the real refresh token.
- Exposed the OAuth provider catalog (`getOAuthProviders`, `OAuthProvider`, `OAuthProviderInfo`) and `refreshOAuthToken` through the package barrel so the coding-agent CLI can target them without reaching into `utils/oauth`.
- Added the auth-gateway subsystem (`@pk-nerdsaver-ai/pi-ai/auth-gateway`) — a forward-proxy that sits between unauthenticated clients (the macOS usage widget, llm-git, robomp containers, …) and the broker. Clients send standard provider-format requests; the gateway parses them into omp's canonical `Context`, dispatches through pi-ai's `streamSimple()`, and translates the canonical event stream back to the matching wire format. `Authorization` is injected server-side so access tokens never leave the gateway host. Wire surface:
- `GET  /healthz` — unauth liveness.
- `GET  /v1/usage` — aggregated provider usage; 5-min per-credential cache via `AuthStorage.fetchUsageReports`.
- `GET  /v1/models` — model catalog (scoped to providers with credentials).
- `POST /v1/chat/completions` — OpenAI chat-completions in/out.
- `POST /v1/messages` — Anthropic messages in/out (text + thinking + tool_use blocks, SSE event taxonomy preserved).
- `POST /v1/responses` — OpenAI Responses in/out (reasoning items + function_call output items, SSE pass-through).
- Added exports from `@pk-nerdsaver-ai/pi-ai/auth-gateway`: `startAuthGateway`, `AuthGatewayServerOptions`, `AuthGatewayBootOptions`, `AuthGatewayServerHandle`, `ModelResolver`, `DEFAULT_AUTH_GATEWAY_BIND`. Per-format `parseRequest` / `encodeResponse` / `encodeStream` triples are reachable via the `./providers/*` subpath as `openai-chat-server`, `anthropic-messages-server`, and `openai-responses-server`.
- Added `listProvidersWithEnvKey()` to enumerate every provider with an env-var fallback (used by the new migrate command in coding-agent).

### Changed

- Changed `GET /v1/snapshot` to support generation-based polling with `If-None-Match` and `wait` for long-poll updates and to return `304` when no snapshot changes are available
- Changed Bedrock credential resolution for streaming calls to prefer environment keys, AWS profile/SSO credentials, and IMDSv2 fallback when available
- Changed auth-gateway parsing for OpenAI chat-completions and Responses to ignore unsupported SDK-only fields instead of rejecting requests
- Changed auth-gateway protocol handling to include CORS headers on responses and support browser-origin requests
- Changed prompt-cache handling to resolve cache keys from request metadata and headers and preserve them through protocol translation
- Changed Anthropic messages parsing to forward request `metadata` through to downstream execution
- Changed usage report caching to use a 5-minute per-credential TTL with jittered refresh timing to reduce usage endpoint rate-limit collisions
- Changed usage polling failure handling so transient errors continue serving the last known report instead of returning null and dropping the credential from usage aggregates after cache expiry
- Changed `sanitizeSchemaForGoogle` to normalize snake_case schema keys (such as `any_of` and `additional_properties`) to camelCase and auto-generate `propertyOrdering` for multi-property objects
- Changed strict-mode sanitization to resolve `$ref` nodes with sibling keys by inlining and merging referenced local definitions
- Changed strict-mode sanitization to flatten single-entry `allOf` nodes and remove the `allOf` wrapper
- Changed Anthropic tool schema normalization to preserve supported metadata keywords such as `$ref`, `$defs`, `$schema`, `enum`, `const`, `default`, `title`, and `nullable` instead of stripping them
- Changed string schema processing to retain only supported `format` values (`date-time`, `time`, `date`, `duration`, `email`, `hostname`, `uri`, `ipv4`, `ipv6`, `uuid`) and demote unsupported `format` values to `description` hints

### Fixed

- Fixed OAuth credential refresh flow so concurrent manual and background refreshes now share one in-flight attempt per credential, and `RemoteAuthCredentialStore` now re-synchronizes before using near-expiring OAuth credentials
- Fixed stale-credential handling after auth failures by waiting for updated broker snapshots and refreshing suspect credentials through broker endpoints before continuing
- Fixed Google Generative AI startup behavior to throw a clear API-key-required error when no key is configured
- Fixed AWS Bedrock image message serialization to preserve base64 `source.bytes` payloads instead of decoding and rebuilding them
- Fixed Google provider error handling to extract the API-reported `error.message` from JSON response bodies when available
- Fixed `RemoteAuthCredentialStore.getUsageReport` to return the matching credential-specific usage report and coalesce parallel callers into one broker `/v1/usage` fetch
- Fixed auth-broker credential upload validation to reject the remote refresh-token sentinel and prevent storing a non-refresh value
- Fixed OpenAI Responses streaming output to emit `reasoning_summary_text` events and parse/send `summary_text` reasoning payloads
- Fixed Anthropic stop-sequence handling by trimming requests to the API limit of four entries before forwarding
- Fixed prompt caching behavior across protocol translations so cached-token usage is preserved when Anthropic and OpenAI requests are routed through each other
- Fixed Claude usage fetching to retry transient `429` and `5xx` responses with exponential backoff, respecting `Retry-After` before returning failure
- Fixed auth-gateway request translation to preserve OpenAI Responses string/system message content, reasoning replay payloads, completed item text in stream item-done events, Anthropic tool-result ordering, and OpenAI Chat/Responses cached-token usage totals
- Fixed auth-gateway failure handling so unsupported request controls, upstream terminal errors, non-streaming aborts, and already-aborted client requests fail explicitly instead of being accepted, ignored, or encoded as successful HTTP 200 responses
- Fixed Gemini CLI / Antigravity tool schema normalization to run the full Cloud Code Assist pipeline, matching shared Google schema handling for union/object merging and nullable extraction
- Fixed stripped validation hints to be preserved as description spill text (`{key: value}` blocks) when `normalizeSchemaForGoogle` and `normalizeSchemaForCCA` drop unsupported schema keywords
- Fixed `sanitizeSchemaForGoogle` to collapse nullability forms (`type:'null'` and null-bearing `anyOf` variants) into `nullable` while preserving remaining variants
- Fixed `sanitizeSchemaForGoogle` to inline local `$defs` references instead of dropping `$ref`/`$defs` structure during Google schema sanitization
- Fixed `normalizeAnthropicToolSchema` to handle self-referential schemas without infinite recursion
- Fixed object schema normalization so explicit open-map declarations (`additionalProperties: true` and schema-valued `additionalProperties`) are preserved instead of being converted to closed objects
- Fixed unsupported schema constraints on arrays and strings (`maxItems`, `uniqueItems`, `pattern`, `minLength`, `maxLength`, and `minItems` when greater than 1) by demoting them into `description` rather than dropping them

### Security

- Hardened auth-gateway bearer-token checks with constant-time comparison to avoid timing-side-channel leaks

## [15.1.2] - 2026-05-15

### Breaking Changes

- Rejected draft-07 tuple and dependency keywords (`items` arrays, `dependencies`, `additionalItems`) in JSON Schema validation

### Added

- Added `responseHeaders`, `responseStatus`, and `responseRequestId` fields to `MockResponse` so mock providers can provide synthetic `ProviderResponseMetadata`
- Added `onResponse` metadata emission for mocks that sends lowercased headers and a default status of 200 before streaming when response headers are configured
- Added recursive strict-mode sanitization for array `prefixItems` entries so tuple schemas now enforce object constraints per item

### Changed

- Normalized legacy draft-07 JSON Schema constructs used in tool parameters (`items` arrays, `additionalItems`, `definitions`, `dependencies`) to draft 2020-12 before OpenAI/Google/CCA sanitization, wire conversion, and argument validation
- Reworked OpenAI response schema adaptation to rewrite `oneOf` into `anyOf` while preserving existing `anyOf` branches
- Changed tuple array validation to validate per-index schemas from `prefixItems` and apply `items` only to remaining elements

### Fixed

- Fixed validation of plain JSON Schema tool arguments that omitted a `$schema` URI so draft-07-shaped schemas now pass validation instead of being rejected
- Fixed tuple-array validation for legacy JSON Schema tool schemas to enforce `additionalItems: false` and per-position constraints after automatic draft upgrade
- Fixed Anthropic tool schema normalization to recurse into `prefixItems` so unsupported constraints inside tuple items are stripped in the generated input schema
- Fixed Anthropic tool-schema normalization stripping the body of explicit open `additionalProperties` (e.g. Zod's `z.record(z.string(), z.unknown())` compiling to `additionalProperties: {}`) by unconditionally overwriting it with `false`, which closed record-style fields and prevented models from supplying any key. The coding-agent's `resolve` tool exposes plan-approval titles via such a field, so Kimi K2 (and any other Anthropic-shaped provider) could not pass `extra: { title }`, blocking plan mode entirely ([#1104](https://github.com/can1357/oh-my-pi/issues/1104))
- Fixed Anthropic strict tool planning to leave tools with open `additionalProperties` maps non-strict instead of sending schemas Anthropic rejects.

## [15.1.0] - 2026-05-15

### Breaking Changes

- Removed TypeBox root exports (`Type`, `Static`, and `TSchema`) from the package entrypoint, so callers importing those symbols from `@pk-nerdsaver-ai/pi-ai` must migrate to `zod` or `@pk-nerdsaver-ai/pi-ai/types`

### Added

- Added support for defining tool schemas with Zod (`z.object`, `z.string`, etc.) by allowing `Tool.parameters` to be either Zod schemas or legacy JSON Schema objects and converting them to provider wire format automatically
- Added package-level schema helpers in the `zod/v4` style by exporting `z` and `ZodType` from the root entrypoint
- Added a `mock` API provider via `createMockModel` to build `Model<"mock">` instances for fully in-memory, deterministic assistant streams in tests
- Added `streamMock` and `registerMockApi` so mock responses can be consumed through `stream()` and the global custom API registry without an external model backend
- Added async/sync response scripting with optional context-based handlers, and new `push()`/`reset()` controls to drive multi-turn mock interactions and inspect per-call invocation state
- Added support in mock responses for simulating tool calls, usage metadata, custom stop reasons, delayed emissions, and terminal error/aborted outcomes

### Changed

- Changed Azure OpenAI Responses tool schema conversion to sanitize tool parameter schemas and rewrite `oneOf` branches as `anyOf` so tool calls remain compatible with Azure's schema expectations
- Changed `Static<S>` to extract a schema object’s `static` type when present, improving inferred tool argument types for non-Zod parameter definitions
- Changed `Static` typing behavior so it now infers argument types from Zod schemas and defaults to `unknown` for non-Zod JSON Schema parameter definitions
- Restored the default steady-state stream idle timeout to 120s (regressed in 15.0.0). 30s was too aggressive for reasoning models, slow proxies, and tool-call planning gaps, surfacing as repeated `Provider stream stalled while waiting for the next event` errors. Existing `PI_STREAM_IDLE_TIMEOUT_MS` / `PI_OPENAI_STREAM_IDLE_TIMEOUT_MS` overrides are unchanged.

### Fixed

- Preserved top-level unknown fields in validated tool-call arguments so extra root properties are retained after schema coercion
- Fixed coercion for Zod `record` fields by parsing JSON-stringified record arguments into objects
- Validated legacy draft-07 JSON Schema tool parameters directly instead of converting through Zod, improving support for features like `$ref`, `definitions`, `nullable`, and `uniqueItems`
- Fixed Cloud Code Assist schema preparation to strip unsupported `propertyNames` and fall back to a minimal tool schema when schema meta-validation detects malformed keywords
- Fixed OpenAI Completions streaming to avoid treating non-output chunks (including role-only preambles) as progress events so idle-timeout watchdog behavior no longer hangs on no-op streamed chunks
- Fixed Cloud Code Assist schema compatibility checks by replacing strict AJV meta-schema validation with structural JSON Schema validation to avoid rejecting structurally valid tool schemas
- Fixed lazy built-in provider streams (`anthropic-messages`, `bedrock-converse-stream`, `cursor-agent`, `google-*`, `ollama-chat`, `openai-*`) prematurely aborting slow first-token responses with `Provider stream stalled while waiting for the next event`. The lazy-stream watchdog wrapper was treating the synthetic `start` event (yielded immediately by every provider before the model emits any tokens) as the first real item, which caused the watchdog to drop from `firstItemTimeoutMs` (100s) to `idleTimeoutMs` (30s) before the upstream model had produced anything. The shared `iterateWithIdleTimeout` now keeps `awaitingFirstItem` true until a real progress item arrives, and the lazy-stream wrapper marks `start` as a non-progress keepalive ([#1073](https://github.com/can1357/oh-my-pi/pull/1073) regression).
- Heal leaked Kimi K2 chat-template tool-call tokens (`<|tool_calls_section_begin|>` … `<|tool_call_argument_begin|>` … `<|tool_calls_section_end|>`) that some hosts (native `kimi-code` API, OpenRouter, Fireworks, etc.) emit into `delta.content` instead of structured `tool_calls`. The OpenAI-completions stream consumer now strips the markers from visible text, reconstructs the embedded calls as proper `toolCall` content blocks (stream-aware, token-boundary-safe), and promotes `finish_reason: stop` to `toolUse` when calls were healed.
- Fixed OpenAI-completions Kimi K2 healed-call promotion clobbering non-stop terminal finish reasons (`error`, `length`, `aborted`); promotion now only fires when the prior stop reason is the natural-completion `stop`
- Fixed OpenAI-completions duplicate Kimi tool calls when a single chunk delivers both leaked markers and a structured `delta.tool_calls`; the healer now strips visible markers but discards its synthesized calls so structured payloads remain the single source of truth
- Fixed Kimi tool-call healer synthesizing a bogus empty call when assistant text mentions a literal `<|tool_call_end|>` (or `<|tool_call_begin|>` / `<|tool_call_argument_begin|>`) outside an active `<|tool_calls_section_begin|>…<|tool_calls_section_end|>` section; the tokens now survive as text
- Fixed OpenAI-completions ignoring per-request `StreamOptions.streamFirstEventTimeoutMs` when configuring the underlying OpenAI SDK HTTP timeout, causing slow-before-headers providers to be aborted at the env default before the wrapping watchdog armed
- Fixed JSON Schema validator silently accepting values that violate `propertyNames`, `patternProperties`, `dependentRequired`, `dependencies`, `if`/`then`/`else`, `contains`, and `prefixItems`; the in-tree validator now enforces these keywords instead of falling through. `unevaluatedProperties`/`unevaluatedItems` remain permissive but log a one-time warning so tool authors are not surprised.
- Fixed recursive `$ref` schemas being treated as universally valid: the validator previously short-circuited on the second occurrence of any ref it had already seen, so nested values violating the referenced sub-schema passed. Cycle detection now keys on (ref, value-identity) pairs with a depth cap for primitive values, so genuine sub-tree violations are still caught.
- Fixed JSON Schema meta-validator accepting malformed `if`/`then`/`else` and `dependencies` keywords; each conditional sub-schema is now structurally validated and draft-07 `dependencies` accepts either a schema or a string array of dependent keys.
- Fixed Zod-emitted wire schemas dropping null-valued unknown root fields before `preserveUnknownRootFields` could snapshot them, so callers like `task.simple` no longer lose a `schema: null` argument and downstream rejection paths fire as intended.
- Fixed mock provider partial `Usage` to recompute `totalTokens` (and `cost.total` when cost components are supplied) when omitted, instead of reporting 0
- Fixed mock provider auto-generated tool-call IDs to use a per-instance counter (now reset by `reset()`), so test order no longer affects IDs across `createMockModel()` instances

## [15.0.2] - 2026-05-15

### Fixed

- Fixed `StreamOptions.fetch` typing to accept fetch-compatible override functions that do not expose `preconnect`, allowing custom fetch implementations to be used without type errors across runtimes
- Fixed Moonshot Kimi K2.6 forced tool calls to send `thinking: { type: "disabled" }`, avoiding `tool_choice 'specified' is incompatible with thinking enabled` 400s while preserving the requested named tool ([#1077](https://github.com/can1357/oh-my-pi/issues/1077)).

## [15.0.1] - 2026-05-14

### Breaking Changes

- Increased the minimum Bun runtime version to `>=1.3.14` for the `@aws-?` package

### Added

- Added `installH2Fetch` to patch `globalThis.fetch` so HTTPS requests attempt HTTP/2 over ALPN with automatic HTTP/1.1 fallback when HTTP/2 is unsupported
- Added priority service-tier traffic to the `premiumRequests` accounting on OpenAI and OpenAI Codex providers. Sending `serviceTier: "priority"` now increments `usage.premiumRequests` by 1 per request, matching the existing GitHub Copilot premium-request budget semantics so downstream consumers (e.g. the `omp stats` "Premium Reqs" card and `/usage`) reflect priority traffic alongside Copilot premium calls.

## [15.0.0] - 2026-05-13

### Added

- Added `AuthStorage.onCredentialDisabled(listener)` — a multi-subscriber `on/off` API for `credential_disabled` events. Returns an unsubscribe function; calling it more than once is a no-op. Multiple subscribers all receive every disable event, with synchronous and async exceptions isolated per-listener so a misbehaving subscriber cannot starve the rest of the chain. Buffer-and-replay semantics are preserved: events emitted while no listener is subscribed are buffered (FIFO, capped at 32) and replayed once to the listener that triggers the empty→non-empty transition. After every subscriber unsubscribes, subsequent disable events buffer again until the next subscribe.

### Fixed

- Fixed OAuth credentials being silently disabled when two omp processes (or any two `AuthStorage` instances sharing a `agent.db`) race on token refresh. Anthropic rotates refresh tokens on every use, so the loser's `invalid_grant` response previously soft-deleted the row that the winner just rotated, forcing the user to `/login` again. `#tryOAuthCredential` now re-reads the row from disk before declaring a definitive failure: if the persisted `refresh` differs from the snapshot it tried, the peer-rotated credential is reloaded and the request retries against the fresh token instead of disabling the live row.
- Closed a remaining race window in OAuth refresh-failure handling: between re-reading the credential row to check for peer rotation and the subsequent soft-delete, another process could still complete a refresh and rotate the row, leaving us to disable the freshly-rotated credential by `id`. The disable now runs as a single CAS update conditioned on the row's `data` still matching the snapshot we tried to refresh, and on `disabled_cause IS NULL`. If the CAS reports 0 rows changed (peer rotation, or row already disabled by a concurrent failure on the same snapshot), we reload from disk and retry instead of mutating the wrong row or emitting a spurious `credential_disabled` event.

## [14.9.3] - 2026-05-10

### Fixed

- Anthropic provider now retries generic transient connect failures (`unable to connect`, `fetch failed`, `connection error`, etc.) by falling back to the shared `isRetryableError` allowlist after the provider-specific patterns. Previously these errors bypassed the hand-curated regex in `isProviderRetryableError` and aborted the stream on the first attempt, while the OpenAI SDK and Codex `fetchWithRetry` paths already handled them.

## [14.9.0] - 2026-05-10

### Fixed

- Fixed silent forwarding of image content (for example Python plot output rendered in the terminal) to models without vision support, which produced opaque 404 errors from upstream. Image blocks are now stripped and replaced with a `[image omitted: model does not support vision]` placeholder for non-vision models, including tool-result payloads ([#967](https://github.com/can1357/oh-my-pi/issues/967), [#968](https://github.com/can1357/oh-my-pi/issues/968)).
- Added `AuthStorage` `onCredentialDisabled` callback (sync or async) so embedders can react when a credential is automatically disabled (e.g. OAuth refresh fails with `invalid_grant`) — useful for surfacing a banner or auto-launching a re-login flow instead of letting the credential silently disappear. Sync throws and async rejections are both caught and logged so a misbehaving subscriber cannot break the disable path.
- Added Anthropic OAuth `account.uuid` and `account.email_address` extraction from the `/v1/oauth/token` exchange and refresh responses; both `AnthropicOAuthFlow.exchangeToken()` and `refreshAnthropicToken()` now populate `OAuthCredentials.{accountId, email}` so downstream consumers can attribute requests to the authenticated account without a separate `/api/oauth/profile` round-trip.
- Added `onSseEvent` stream diagnostics so HTTP SSE providers can expose raw SSE frames without changing parsed model output.
- Added `streamIdleTimeoutMs` option (and `PI_STREAM_IDLE_TIMEOUT_MS` env override; `PI_OPENAI_STREAM_IDLE_TIMEOUT_MS` remains a backward-compatible alias) for a steady-state inter-event watchdog. Set to `0` to disable.
- Added a semantic-progress predicate to OpenAI Responses and Codex SSE/WebSocket transports so `response.in_progress`-style keepalives no longer reset the idle deadline on stalled tool calls.

### Changed

- Anthropic streams now enforce a steady-state idle timeout (defaults to 120s, same control as `PI_STREAM_IDLE_TIMEOUT_MS`) in addition to the first-event watchdog. Long-running responses that go fully silent between events will now surface as `Anthropic stream stalled while waiting for the next event` instead of hanging.
- Fixed `resolveAnthropicMetadataUserId()` to accept JSON-format `user_id` values that match real Claude Code's payload shape (`{ device_id, account_uuid, session_id, ... }` from `services/api/claude.ts:getAPIMetadata`). Previously only the synthetic `user_<hex>_account_<uuid>_session_<uuid>` cloaking format was accepted on OAuth, which caused stable session-keyed metadata supplied by callers to be discarded and replaced with fresh random entropy on every request — defeating session-count attribution on the Claude OAuth path.

## [14.8.0] - 2026-05-09

### Fixed

- Fixed Gemini 3 Pro thinking metadata so `medium` effort is rejected with the expected error instead of being silently accepted: `ThinkingConfig` now carries an optional explicit `levels` list that survives `expandEffortRange`, letting non-contiguous supported sets (e.g. `[low, high]`) round-trip through enrichment.
- Fixed Kimi Code OAuth expiry handling to refresh access tokens 5 minutes before server expiry, avoiding daily 401s from using tokens right up to the cutoff.

## [14.7.6] - 2026-05-07

### Added

- Added `hideThinkingSummary` option to `SimpleStreamOptions`. When true, `streamSimple` requests that the underlying provider omit reasoning/thinking summaries: Anthropic receives `thinking.display = "omitted"` (where supported), and OpenAI Responses / Azure / Codex providers leave `reasoning.summary` unset so the server skips emitting the human-readable summary stream entirely.

### Changed

- Changed OpenAI Responses, Azure OpenAI Responses, and OpenAI Codex providers to omit `reasoning.summary` from requests when `reasoningSummary` is explicitly `null` (previously fell back to `"auto"`).

## [14.7.5] - 2026-05-07

### Added

- Added `OpenAICompat.supportsMultipleSystemMessages` so chat-completions hosts can opt out of separate leading system blocks. Auto-detected as `true` for OpenAI, Azure, OpenRouter, Cerebras, Together, Fireworks, Groq, DeepSeek, Mistral, xAI, Z.ai, GitHub Copilot, and Zenmux; `false` for MiniMax, Alibaba Dashscope, and Qwen Portal whose chat templates reject follow-up system messages. Unknown OpenAI-compatible hosts (custom vLLM/local) default to `false`; users can opt back in via `compat.supportsMultipleSystemMessages: true`.

### Fixed

- Fixed strict-template OpenAI-compatible hosts (e.g. Qwen 3.5+ via vLLM, MiniMax) rejecting follow-up `system`/`developer` messages by coalescing ordered system prompts into a single block joined by `\n\n` when `compat.supportsMultipleSystemMessages` is false. Canonical hosts continue to receive separate blocks so KV-cache reuse stays effective when only the trailing prompt changes ([#958](https://github.com/can1357/oh-my-pi/issues/958)).

## [14.7.2] - 2026-05-06

### Fixed

- Fixed VLLM model discovery to use `max_model_len` as the context window when the endpoint reports it.
- Fixed custom Ollama Cloud/local-proxy model aliases (for example `deepseek-v4-pro:cloud`) to inherit bundled cache-pricing metadata when the upstream model is known ([#937](https://github.com/can1357/oh-my-pi/issues/937)).
- Fixed local Ollama model discovery to apply `/api/show` thinking and vision capabilities in addition to native context windows ([#928](https://github.com/can1357/oh-my-pi/issues/928)).

## [14.7.0] - 2026-05-04

### Breaking Changes

- Changed `Context.systemPrompt` from a string to `string[]`, so callers must now pass an array of prompts instead of a single string
- Changed behavior will throw at runtime for non-array system prompts because request builders now normalize system prompts as an array

### Added

- Added support for multiple system prompts by changing `Context.systemPrompt` to an ordered string array and preserving provider-appropriate instruction precedence

### Changed

- Changed request builders for Anthropic, OpenAI, Bedrock, Azure, Cursor, Google, and Ollama to propagate every non-empty system prompt entry without demoting durable instructions into ordinary conversation turns

### Fixed

- Filtered out empty normalized system prompts so blank entries are no longer sent to providers
- Removed blank system prompt strings from provider payloads to avoid unnecessary empty instruction messages

## [14.6.6] - 2026-05-04

### Added

- Added always-on OpenRouter response caching (1h TTL) by sending `X-OpenRouter-Cache: true` and `X-OpenRouter-Cache-TTL: 3600` on every OpenRouter request — identical requests replay from OpenRouter's edge cache for free. https://openrouter.ai/docs/features/response-caching

## [14.6.4] - 2026-05-03

### Fixed

- Fixed OpenAI Codex websocket continuations to retry with full context when `previous_response_id` expires server-side instead of surfacing `previous_response_not_found`.

## [14.6.2] - 2026-05-03

### Added

- Added `EventStream.fail(err)` method to terminate the async iterator with an error, enabling consumers to catch stream-level failures via `for await` without hanging

### Fixed

- Fixed OpenAI Responses tool schema conversion to rewrite non-strict `oneOf` unions to `anyOf` before sending tools to the Responses API ([#920](https://github.com/can1357/oh-my-pi/issues/920))

## [14.6.0] - 2026-05-02

### Added

- Added `disableReasoning` to stream and OpenAI completion options to force reasoning off for models that support it, sending `reasoning: { enabled: false }` for OpenRouter-compatible requests
- Added `thinkingDisplay` option to Anthropic options to control whether adaptive and explicit reasoning is returned as `summarized` or `omitted`
- Added Anthropic model compatibility flags `supportsEagerToolInputStreaming` and `supportsLongCacheRetention` for API-capability-specific request behavior

### Changed

- Changed Anthropic request payloads to send `thinking: { type: "disabled" }` when `thinkingEnabled` is explicitly `false` on reasoning-enabled models
- Changed Anthropic cache retention handling so `cacheRetention: "long"` now uses `ttl: "1h"` only for canonical Anthropic endpoints with long-cache support
- Changed Anthropic tool schema generation to include `eager_input_streaming` only on models that advertise support
- Changed Anthropic OAuth login flow to include browser fallback guidance and richer error context when token exchange or refresh fails

### Fixed

- Fixed Anthropic non-thinking requests to include the caller-provided `temperature` value in request payloads
- Fixed Anthropic `claude-opus-4-7` non-thinking payloads to omit sampling fields (`temperature`, `top_p`, and `top_k`)
- Fixed OpenAI Codex base URL normalization so configured base URLs with or without `/codex` or `/codex/responses` now resolve to `/codex/responses`
- Fixed OpenAI Codex websocket handling to parse JSON from non-string message payloads including `ArrayBuffer`, typed arrays, and `Blob` values
- Fixed OpenAI Codex websocket handshakes to replace stale `openai-beta` values with the websocket beta and avoid sending request-body headers over websocket transport
- Fixed abort tracking so caller-initiated cancellations are treated as user aborts even after local watchdog timeouts, preventing unintended automatic retries
- Fixed Anthropic stream handling to parse raw SSE envelopes directly, ignore unrelated events, and repair malformed JSON in SSE payloads
- Fixed Anthropic streaming to emit an explicit error when the SSE stream ends without a `message_stop` event
- Fixed OpenAI Codex websocket continuations to send true `previous_response_id` deltas for `store: false` transcripts, expose request stats, and default text verbosity to `low` unless explicitly overridden.
- Fixed OpenAI Codex websocket append reuse after `response.completed` terminal events.

## [14.5.14] - 2026-05-01

### Added

- Added package-level `google-gemini-headers` exports (`getGeminiCliHeaders`, `getGeminiCliUserAgent`, `getAntigravityHeaders`, `extractRetryDelay`, and `ANTIGRAVITY_SYSTEM_INSTRUCTION`) for header and retry handling reuse without importing full Google providers

### Changed

- Changed package exports and streaming/provider wiring to load heavy Google/Kimi/GitLab/synthetic provider modules lazily through `register-builtins`, reducing startup import overhead from optional provider SDKs

### Fixed

- Fixed DeepSeek V4 tool-call follow-up 400 errors from three root causes:
  - Mapped `reasoning_effort` "xhigh" to "max" for DeepSeek-family models on any provider (NVIDIA, OpenCode-Go, etc.), not just `deepseek`
  - Recovered `reasoning_content` from thinking blocks with valid signatures that were filtered by the non-empty-text check
- Added empty-string fallback when `reasoning_content` is genuinely absent (e.g. proxy-stripped) but the provider requires the field

## [14.5.13] - 2026-05-01

### Breaking Changes

- Removed `utils/oauth` re-exports from the package entrypoint, so OAuth helper imports from the root module must be updated

## [14.5.10] - 2026-04-30

### Added

- Added provider response metadata callbacks for Anthropic and OpenAI streaming requests.

## [14.5.9] - 2026-04-30

### Added

- Added `usage.reasoningTokens` to OpenAI and Google usage output when providers report reasoning/thinking tokens
- Added `usage.cttl.ephemeral5m` and `usage.cttl.ephemeral1h` to report Anthropic cache-write TTL token buckets
- Added `usage.server.webSearch` and `usage.server.webFetch` to report Anthropic server tool-call request counts

### Fixed

- Fixed OpenAI usage attribution to avoid double-counting `reasoning_tokens` in output totals
- Fixed Anthropic streaming usage handling so a previously populated cache TTL breakdown is preserved when later events omit `cache_creation`

## [14.5.4] - 2026-04-28

### Changed

- Changed OpenAI custom Lark grammar payloads to strip comments and blank lines before sending provider requests.

### Fixed

- Fixed OpenAI Codex GPT model pricing by inheriting matching OpenAI catalog rates for zero-priced discovered Codex entries.

## [14.5.3] - 2026-04-27

### Added

- Added `fireworks` as a supported provider with API key login flow and credential storage
- Added Fireworks model catalog support with `fireworks`-scoped openai-completions models `glm-5`, `glm-5.1`, `kimi-k2.5`, `kimi-k2.6`, and `minimax-m2.7`
- Added built-in discovery wiring so providers with base URL `api.fireworks.ai` are recognized as OpenAI-compatible and can use streaming token control

### Changed

- Updated the built-in model catalog to use corrected `contextWindow` and `maxTokens` values for many existing models instead of placeholder limits
- Updated several model cost entries, including cache-read pricing, to corrected values

### Fixed

- Fixed Fireworks request formatting by translating between public model IDs and API wire IDs when sending OpenAI-completions requests
- Fixed OpenAI-compatible model parameter handling for Fireworks by allowing `max_tokens` to be sent during requests

## [14.5.1] - 2026-04-26

### Fixed

- Fixed NVIDIA NIM DeepSeek-V4 models leaking chat-template tool-call markers (e.g. `<｜DSML｜tool_calls｜>`) into visible response text by stripping the special tokens from streamed `delta.content` ([#798](https://github.com/can1357/oh-my-pi/issues/798))

## [14.4.0] - 2026-04-26

### Added

- Added an `examples` option to `StringEnum` to include example values in the generated schema

### Changed

- Changed Anthropic tool schema generation to strip unsupported schema fields (including `patternProperties`), add `additionalProperties: false` for object types, and apply Anthropic strict-mode limits when marking tools as strict
- Changed Anthropic strict tool planning to cap strict `tools` at twenty entries and convert excess optional/union parameters to nullable schemas to stay within provider constraints

### Fixed

- Fixed Anthropic tool schema compilation failures by keeping the `write` tool out of the strict-tool allowlist when the full coding-agent tool set is active
- Fixed Anthropic 400 `tools.*.custom: For 'object' type, property 'minItems' is not supported` by stripping `minItems` from object-shaped JSON schema nodes (array nodes still keep supported `minItems` values)
- Fixed Anthropic tool schemas that used tuple-style arrays by stripping unsupported `maxItems` and only preserving provider-supported `minItems` values
- Fixed Anthropic and OpenRouter Anthropic tool calls that previously failed with `compiled grammar is too large` by retrying automatically without strict tool schemas and reusing non-strict mode for subsequent requests in the same provider session
- Fixed parsing of JSON tool arguments containing raw control characters inside string values (such as embedded newlines) by escaping them before JSON parsing
- Fixed `validateToolArguments` to accept stringified objects and arrays that include literal control characters inside string fields
- Fixed OpenAI Codex Spark OAuth selection to fall back to non-Pro accounts when no ChatGPT Pro account is connected, so users without a Pro account can still attempt Spark requests in case the server permits access.

## [14.3.0] - 2026-04-25

### Added

- Added support for Claude Opus 4.7 (`claude-opus-4-7`) model ([#726](https://github.com/can1357/oh-my-pi/issues/726))
  - Suppresses sampling parameters (temperature/top_p/top_k) that Opus 4.7 rejects
  - Enables `display: "summarized"` for adaptive thinking to restore visible thinking content

### Fixed

- Fixed Cursor provider losing conversation history on follow-up turns (model responding "this appears to be the start of our session") by populating `ConversationStateStructure.rootPromptMessagesJson` with JSON blob IDs for the system prompt plus prior user/assistant/tool-result messages. Cursor's server builds the model prompt from `rootPromptMessagesJson`, not from the protobuf `turns[]` tree, so sending only the system prompt there caused prior turns to be dropped
- Fixed Cursor provider multi-turn conversations failing with `Connect error internal: Blob not found` on the second message by storing `ConversationStateStructure.turns`, `AgentConversationTurnStructure.user_message`, and `AgentConversationTurnStructure.steps` as content-addressed blob IDs in the KV store (matching the existing handling for `rootPromptMessagesJson`) rather than sending the raw serialized bytes inline ([#678](https://github.com/can1357/oh-my-pi/issues/678))

## [14.2.1] - 2026-04-24

### Fixed

- Fixed OpenAI Codex Spark OAuth selection to require a verified ChatGPT Pro account instead of falling back to Plus or unknown-plan accounts.

## [14.2.0] - 2026-04-23

### Added

- Added `gpt-5.5` to the built-in model catalog for both OpenAI Responses (`openai`) and local `litellm` (`openai-completions`) providers
- Added `gpt-image-2` to the `litellm` built-in model catalog
- Added `isCopilotTransientModelError()` and `callWithCopilotModelRetry()` helpers in `utils/retry` that detect GitHub Copilot's intermittent `HTTP 400 model_not_supported` responses for preview models (`gpt-5.3-codex`, `gpt-5.4`, `gpt-5.4-mini`, ...) and retry the request up to three times with backoff. OpenAI Responses, OpenAI Completions, and Anthropic provider paths now participate in this retry when the model is served through Copilot.
- Added OpenAI Responses custom-tool grammar support for Codex-style `apply_patch` calls, including freeform streaming, history replay, and forced tool-choice mapping to the custom wire name.

### Changed

- Updated built-in model metadata with revised `contextWindow`, `maxTokens`, and pricing values for existing entries
- Changed generated model policies to assign `applyPatchToolType: "freeform"` for first-party GPT-5 OpenAI Responses and Codex models, so regenerated `models.json` preserves the `apply_patch` custom-tool metadata.
- Renamed `rewriteCopilotAuthError` to `rewriteCopilotError` and extended it to rewrite `HTTP 400 model_not_supported` after retries are exhausted with guidance about Copilot's OAuth-client-specific rollout gap (see opencode#13313).

### Fixed

- Fixed Amazon Bedrock proxy handling to honor lowercase `http_proxy`, `https_proxy`, and `all_proxy` environment variables when using HTTP/1 fallback
- Fixed Amazon Bedrock streaming behind corporate HTTP proxies by using a proxy-aware HTTP/1 transport when `HTTPS_PROXY`, `HTTP_PROXY`, or `ALL_PROXY` is configured, including AWS SSO credential calls.
- Fixed Amazon Bedrock requests to retry once with HTTP/1 when the AWS SDK's default HTTP/2 transport fails before streaming begins.
- Fixed OpenAI Responses streaming to display thinking tokens from local providers (llama.cpp, etc.) that send raw `reasoning_text.delta` events and empty `summary` arrays in `output_item.done`. Previously, thinking content was silently dropped during streaming while non-streaming mode worked correctly.
- Synced the bundled OpenCode Go catalog with the current docs so `kimi-k2.6`, `mimo-v2.5`, and `mimo-v2.5-pro` appear in offline/default model lists.

## [14.1.3] - 2026-04-17

### Fixed

- Preserved user-provided `session_id` and `x-client-request-id` headers in OpenAI Responses requests instead of overriding them with automatic session-derived values
- Stopped sending `session_id` and `x-client-request-id` headers for OpenAI Responses requests when `cacheRetention` is set to `none`
- Fixed direct OpenAI Responses requests to send `session_id` and `x-client-request-id` from the same session-derived value as `prompt_cache_key`, improving prompt cache affinity for append-only sessions

## [14.1.1] - 2026-04-14

### Added

- Added `toolStrictMode` compatibility option (`"all_strict"` or `"none"`) to OpenAI-compatible model config to force tool schemas to be sent uniformly strict, uniformly non-strict, or keep mixed per-tool behavior

### Changed

- Changed Cerebras OpenAI-compatible providers to default `toolStrictMode` to `"all_strict"` unless explicitly overridden

### Fixed

- Fixed OpenAI Completions handling for providers that reject mixed `strict` flags by automatically retrying with non-strict tool schemas when an initial all-strict tool request fails with strict-format 400/422 errors
- Fixed OpenAI-completions error reporting by including captured JSON error body details such as type, param, and code when a request fails without a body in the thrown SDK error
- Fixed shell execution failure responses to preserve all result fields when sanitizing, preventing truncated metadata in stream results
- Fixed context overflow detection to recognize `model_context_window_exceeded` from z.ai / GLM providers, preventing infinite retry loops when context window is exceeded ([#638](https://github.com/can1357/oh-my-pi/issues/638))
- Fixed strict tool schema enforcement to preserve `additionalProperties: false` and required keys for reused nested object schemas, preventing invalid `todo_write` function schemas in Codex/OpenAI requests

## [14.1.0] - 2026-04-11

### Added

- Added `accountId` to usage report metadata

### Changed

- Changed usage parsing to emit a usage report with available fields when parsing fails, rather than returning null

### Fixed

- Fixed `planType` resolution to fall back to the raw payload `plan_type` when parsed value is absent
- Fixed usage metadata `raw` fallback to preserve the original payload when parsed raw output is missing

## [14.0.5] - 2026-04-11

### Changed

- Replaced GitHub Copilot authentication from VSCode extension impersonation to the opencode OAuth flow, eliminating TOS concerns. Existing users will need to re-authenticate once with `/login github-copilot`.
- Simplified Copilot token handling: GitHub OAuth token is used directly for all API requests (no JWT exchange or refresh cycle).
- Changed GitHub Copilot API base URL from `api.individual.githubcopilot.com` to `api.githubcopilot.com`.
- Updated default OpenAI stream idle timeout to 120,000 milliseconds to keep stream generation alive longer

### Fixed

- Fixed duplicate synthetic tool results being generated when a real tool result appears later in message history
- Fixed GitHub Copilot `/models` discovery to unwrap structured OAuth credentials before sending the bearer token, preserving dynamic catalog refresh for OAuth-backed callers.

### Removed

- Removed Copilot JWT proxy-ep base URL resolution (no longer needed with opencode auth).

## [14.0.3] - 2026-04-09

### Fixed

- Fixed Ollama discovery cache normalization so cached models upgrade to the OpenAI Responses transport after the provider change

## [14.0.0] - 2026-04-08

### Breaking Changes

- Removed `coerceNullStrings` function and its automatic null-string coercion behavior from JSON parsing

### Added

- Added support for OpenRouter provider with strict mode detection
- Added automatic cleaning of literal escape sequences (`\n`, `\t`, `\r`) in JSON parsing to handle LLM encoding confusion
- Added support for healing JSON with trailing junk after balanced containers (e.g., `]\n</invoke>`)
- Added `CODEX_STARTUP_EVENT_CHANNEL` constant and `CodexStartupEvent` type for monitoring Codex provider initialization status
- Added automatic healing of malformed JSON with single-character bracket errors at the end of strings, improving LLM tool argument parsing robustness

## [13.19.0] - 2026-04-05

### Fixed

- Fixed GitHub Copilot model context window detection by correcting fallback priority for maxContextWindowTokens and maxPromptTokens
- Fixed Gemini 2.5 Pro context window detection in GitHub Copilot model limits test
- Fixed Claude Opus 4.6 context window detection in GitHub Copilot model limits test
- Fixed Anthropic streaming to suppress transient SDK console errors for malformed SSE keep-alive frames so the TUI only shows surfaced provider errors
- Added environment-based credential fallback for the OpenAI Codex provider.

## [13.17.6] - 2026-04-01

### Fixed

- Fixed Anthropic first-event timeouts to exclude stream connection setup from the watchdog, preserve timeout-specific retry classification after local aborts, and reset retry state cleanly between attempts

## [13.17.5] - 2026-04-01

### Changed

- Increased default first-event timeout from 15s to 45s to better accommodate longer request setup times
- Modified first-event watchdog to inherit idle timeout when it exceeds the default, ensuring consistent timeout behavior across different configurations

### Fixed

- Fixed first-event watchdog initialization timing so it no longer starts before the actual stream request is created, preventing premature timeouts during request setup
- Fixed first-event watchdog timing so OpenAI-family providers no longer count slow request setup against the first streamed event timeout, and raised the default first-event timeout to avoid false aborts after long tool turns

## [13.17.2] - 2026-04-01

### Fixed

- Fixed OpenAI-family first-event timeouts to preserve provider-specific timeout errors for retry classification instead of flattening them to generic aborts ([#591](https://github.com/can1357/oh-my-pi/issues/591))

## [13.17.1] - 2026-04-01

### Added

- Added `thinkingSignature` field to thinking content blocks to preserve the original reasoning field name (e.g., `reasoning_text`, `reasoning_content`) for accurate follow-up requests
- Added first-event timeout detection for streaming responses to abort stuck requests before user-visible content arrives
- Added `PI_STREAM_FIRST_EVENT_TIMEOUT_MS` environment variable to configure first-event timeout (defaults to 15 seconds or idle timeout, whichever is lower)
- Added Vercel AI Gateway to `/login` providers for interactive API key setup

### Changed

- Changed thinking block handling to track and distinguish between different reasoning field types, enabling proper field name preservation across multiple turns

### Fixed

- Fixed Anthropic stream timeout errors to be properly retried by recognizing first-event timeout messages
- Fixed stream stall detection to distinguish between first-event timeouts and idle timeouts, enabling faster recovery for stuck connections
- Fixed `omp commit` failing with HTTP 400 errors when using reasoning-enabled models on OpenAI-compatible endpoints that don't support the `developer` role (e.g., GitHub Copilot, custom proxies). Now falls back to `system` role when `developer` is unsupported.

## [13.17.0] - 2026-03-30

### Changed

- Bumped zai provider default model from glm-4.6 to glm-5.1

## [13.16.5] - 2026-03-29

### Added

- Added Gemma 3 27B model support for Google Generative AI

### Changed

- Updated Kwaipilot KAT-Coder-Pro V2 model display name and pricing information
- Updated Kwaipilot KAT-Coder-Pro V2 context window from 222,222 to 256,000 tokens and max tokens from 8,888 to 80,000

### Fixed

- Fixed normalizeAnthropicBaseUrl returning empty string instead of undefined when baseUrl is empty

## [13.16.4] - 2026-03-28

### Added

- Added support for Groq Compound and Compound Mini models with extended context window (131K tokens) and configurable thinking levels
- Added support for OpenAI GPT-OSS-Safeguard-20B model with reasoning capabilities across multiple providers
- Added support for Kwaipilot KAT-Coder-Pro V2 model across Kilo, NanoGPT, and OpenRouter providers
- Added support for GLM-5.1 model with extended context window (200K tokens) and max output of 131K tokens
- Added support for Qwen3.5-27B-Musica-v1 model
- Added support for zai-org/glm-5.1 model with reasoning capabilities
- Added support for Sapiens AI Agnes-1.5-Lite model with multimodal input (text and image) and reasoning
- Added support for Venice openai-gpt-54-mini model

### Changed

- Updated Qwen QwQ 32B max tokens from 16,384 to 40,960 across multiple providers
- Updated OpenAI GPT-OSS-Safeguard-20B model name to 'Safety GPT OSS 20B' and enabled reasoning capabilities
- Updated OpenAI GPT-OSS-Safeguard-20B context window from 222,222 to 131,072 tokens and max tokens from 8,888 to 65,536
- Updated OpenRouter Qwen QwQ 32B pricing: input from 0.2 to 0.19, output from 1.17 to 1.15, cache read from 0.1 to 0.095
- Updated OpenRouter Claude 3.5 Sonnet pricing: input from 0.45 to 0.42, cache read from 0.225 to 0.21

## [13.16.3] - 2026-03-28

### Changed

- Modified OAuth credential saving to preserve unrelated identities instead of replacing all credentials for a provider
- Updated credential identity resolution to use provider context for more accurate email deduplication

### Fixed

- Fixed OAuth credential updates to replace matching credentials in-place rather than creating disabled rows, preventing unbounded accumulation of soft-deleted credentials

## [13.15.0] - 2026-03-23

### Added

- Added `isUsageLimitError()` to `rate-limit-utils` as a single source of truth for detecting usage/quota limit errors across all providers

### Fixed

- Fixed lazy stream forwarding to properly handle final results from source streams with `result()` methods
- Fixed lazy stream error handling to convert iterator failures into terminal error results instead of silently failing
- Fixed `parseRateLimitReason` to recognize "usage limit" in error messages and correctly classify them as `QUOTA_EXHAUSTED`
- Fixed Codex `fetchWithRetry` retrying 429 responses for `usage_limit_reached` errors for up to 5 minutes instead of returning immediately for credential switching
- Removed `usage.?limit` from `TRANSIENT_MESSAGE_PATTERN` in retry utils since usage limits are not transient and require credential rotation
- Fixed `parseRateLimitReason` not recognizing "usage limit" in Codex error messages, causing incorrect fallback to `UNKNOWN` classification instead of `QUOTA_EXHAUSTED`

## [13.14.2] - 2026-03-21

### Changed

- Updated thinking configuration format from `levels` array to `minLevel` and `maxLevel` properties for improved clarity
- Corrected context window from 400000 to 272000 tokens for GPT-5.4 mini and nano variants on Codex transport
- Normalized GPT-5.4 variant priority handling to use parsed variant instead of special-casing raw model IDs
- Added support for `mini` variant in OpenAI model parsing regex

### Fixed

- Fixed inconsistent thinking level configuration across multiple model definitions

## [13.14.0] - 2026-03-20

### Fixed

- Fixed resumed OpenAI Responses sessions to avoid replaying stale same-provider native history on the first follow-up after process restart ([#488](https://github.com/can1357/oh-my-pi/issues/488))

### Added

- Added bundled GPT-5.4 mini model metadata for OpenAI, OpenAI Codex, and GitHub Copilot, including low-to-xhigh thinking support and GitHub Copilot premium multiplier metadata
- Added bundled GPT-5.4 nano model metadata for OpenAI and OpenAI Codex, including low-to-xhigh thinking support

## [13.13.2] - 2026-03-18

### Changed

- Modified tool result handling for aborted assistant messages to preserve existing tool results when already recorded, instead of always replacing them with synthetic 'aborted' results

## [13.13.0] - 2026-03-18

### Changed

- Changed tool argument validation to always normalize optional null values before type coercion, ensuring consistent handling of LLM-generated 'null' strings

### Fixed

- Fixed tool argument validation to properly handle string 'null' values from LLMs on optional fields by stripping them during normalization
- Improved type safety of `validateToolCall` and `validateToolArguments` functions by returning properly typed `ToolCall["arguments"]` instead of `any`

## [13.12.9] - 2026-03-17

### Changed

- Extracted OpenAI compatibility detection and resolution logic into dedicated `openai-completions-compat` module for improved maintainability and reusability

### Fixed

- Fixed `openai-responses` manual history replay to strip replay-only item IDs and preserve normalized tool `call_id` values for GitHub Copilot follow-up turns ([#457](https://github.com/can1357/oh-my-pi/issues/457))

## [13.12.0] - 2026-03-14

### Added

- Added support for `qwen-chat-template` thinking format to enable reasoning via `chat_template_kwargs.enable_thinking`
- Added `reasoningEffortMap` option to `OpenAICompat` for mapping pi-ai reasoning levels to provider-specific `reasoning_effort` values
- Added `extraBody` to `OpenAICompat` to support provider-specific request body routing fields in OpenAI-completions requests
- Added support for reading token usage from choice-level `usage` field as fallback when root-level usage is unavailable
- Added new models: DeepSeek-V3.2 (Bedrock), Llama 3.1 405B Instruct, Magistral Small 1.2, Ministral 3 3B, Mistral Large 3, Pixtral Large (25.02), NVIDIA Nemotron Nano 3 30B, and Qwen3-5-9b
- Added `close()` method to `AuthStorage` for properly closing the underlying credential store
- Added `initiatorOverride` option in OpenAI and Anthropic providers to customize message attribution

### Changed

- Changed assistant message content serialization to always use plain string format instead of text block arrays to prevent recursive nesting in OpenAI-compatible backends
- Changed Bedrock Opus 4.6 context window from 1M to 1M and added max tokens limit of 128K
- Changed OpenCode Zen/Go Sonnet 4.0/4.5 context window from 1M to 200K
- Changed GitHub Copilot context windows from 200K to 128K for both gpt-4o and gpt-4o-mini
- Changed Claude 3.5 Sonnet (Anthropic API) pricing: input from $0.5 to $0.25, output from $3 to $1.5, cache read from $0.05 to $0.025, cache write from $0 to $1
- Changed Devstral 2 model name from '135B' to '123B'
- Changed ByteDance Seed 2.0-Lite to support reasoning with effort-based thinking mode and image inputs
- Changed Qwen3-32b (Groq) reasoning effort mapping to normalize all levels to 'default'
- Changed finish_reason 'end' to map to 'stop' for improved compatibility with additional providers
- Changed Anthropic reference model merging to prioritize bundled metadata for known models while using models.dev for newly discovered IDs

### Fixed

- Fixed reasoning_effort parameter handling to use provider-specific mappings instead of raw effort values
- Fixed assistant content serialization for GitHub Copilot and other OpenAI-compatible backends that mirror array payloads
- Fixed token usage calculation to properly extract cached tokens from both root and nested `prompt_tokens_details` fields
- Fixed stop reason mapping to handle string values and unknown finish reasons gracefully
- Fixed resource cleanup in `AuthCredentialStore.close()` to properly finalize all prepared statements before closing the database

## [13.11.1] - 2026-03-13

### Fixed

- Added `llama.cpp` as local provider
- Fixed auth schema V0-to-V1 migration crash when the V0 table lacks a `disabled` column

## [13.11.0] - 2026-03-12

### Added

- Added support for Parallel AI provider with API key authentication
- Added `PARALLEL_API_KEY` environment variable support for Parallel provider configuration
- Added automatic websocket reconnection handling for connection limit errors, with fallback to SSE replay when content has already been emitted

### Changed

- Enhanced `CodexProviderStreamError` to include an optional error code field for better error categorization and handling

### Fixed

- Improved retry logic to handle HTTP/2 stream errors and internal_error responses from Anthropic API

## [13.9.16] - 2026-03-10

### Added

- Support for `onPayload` callback to replace provider request payloads before sending, enabling request interception and modification
- Support for structured text signature metadata with phase information (commentary/final_answer) in OpenAI and Azure OpenAI Responses providers
- Support for OpenAI Codex Spark model selection with plan-based account prioritization
- Added `modelId` option to `getApiKey()` to enable model-specific credential ranking

### Changed

- Enhanced `onPayload` callback signature to accept model parameter and support async payload replacement
- Improved error messages for `response.failed` events to include detailed error codes, messages, and incomplete reasons
- Refactored OpenAI Codex response streaming to improve code organization and maintainability with extracted helper functions and type definitions
- Enhanced websocket fallback logic to safely replay buffered output over SSE when websocket connections fail mid-stream
- Improved error recovery for websocket streams by distinguishing between fatal connection errors and retryable stream errors
- Updated credential ranking strategy to prioritize Pro plan accounts when requesting OpenAI Codex Spark models

### Fixed

- Fixed websocket stream recovery to properly reset output state and clear buffered items when falling back to SSE after partial output
- Fixed handling of malformed JSON messages in websocket streams to trigger immediate fallback to SSE without retry attempts

## [13.9.13] - 2026-03-10

### Added

- Added `isSpecialServiceTier` utility function to validate OpenAI service tier values

## [13.9.12] - 2026-03-09

### Added

- Added Tavily web search provider support with API key authentication

### Fixed

- Fixed OpenAI-family streaming transports to fail with an explicit idle-timeout error instead of hanging indefinitely when the provider stops sending events mid-response
- Fixed OpenAI Codex OAuth refresh and usage-limit lookups to respect request timeouts instead of waiting indefinitely during account selection or rotation
- Fixed OpenAI Codex prewarmed websocket requests to fall back quickly when the socket connects but never starts the response stream

## [13.9.10] - 2026-03-08

### Added

- Added `identity_key` column to auth credentials storage for improved credential deduplication
- Added schema versioning system to auth credentials database for safer migrations
- Added automatic backfilling of identity keys during database schema migrations

### Changed

- Changed credential deduplication logic to use single identity key instead of multiple identifiers for better performance
- Changed database schema to store normalized identity keys alongside credentials
- Changed auth schema migration to support upgrading from legacy database versions with automatic data backfill

### Fixed

- Fixed API key credential matching to correctly identify when the same key is re-stored, preventing unnecessary row duplication on re-login
- Fixed credential deduplication to correctly handle OAuth accounts with matching emails but different account IDs
- Fixed API key replacement to reuse existing stored rows instead of accumulating disabled duplicates
- Fixed auth storage to preserve newer recorded schema versions when opened by older binaries

## [13.9.8] - 2026-03-08

### Fixed

- Fixed WebSocket stream fallback logic to safely replay buffered output over SSE when WebSocket fails after partial content has been streamed

## [13.9.4] - 2026-03-07

### Changed

- Simplified API key credential storage to always replace existing credentials on re-login instead of accumulating multiple keys
- Updated Kagi API key placeholder from `kagi_...` to `KG_...` to match current API key format
- Updated Kagi login instructions to clarify Search API access is beta-only and provide support contact
- Disabled usage reporting in streaming responses for Cerebras models due to compatibility issues

### Fixed

- Fixed Cerebras model compatibility by preventing `stream_options` usage requests in chat completions

## [13.9.3] - 2026-03-07

### Breaking Changes

- Changed `reasoning` parameter from `ThinkingLevel | undefined` to `Effort | undefined` in `SimpleStreamOptions`; 'off' is no longer valid (omit the field instead)
- Removed `supportsXhigh()` function; check `model.thinking?.maxLevel` instead
- Removed `ThinkingLevel` and `ThinkingEffort` types; use `Effort` enum
- Removed `getAvailableThinkingLevels()` and `getAvailableThinkingEfforts()` functions
- Changed `transformRequestBody()` signature to require `Model` parameter as second argument for effort validation
- Removed `thinking.ts` module export; import from `model-thinking.ts` instead

### Added

- Added `incremental` flag to `OpenAIResponsesHistoryPayload` to support building conversation history from multiple assistant messages instead of replacing it
- Added `dt` flag to `OpenAIResponsesHistoryPayload` for transport-level metadata
- Added `ThinkingConfig` interface to models for canonical thinking transport metadata with min/max effort levels and provider-specific mode
- Added `thinking` field to `Model` type containing per-model thinking capabilities used to clamp and map user-facing effort levels
- Added `Effort` enum (minimal, low, medium, high, xhigh) as canonical user-facing thinking levels replacing `ThinkingLevel`
- Added `enrichModelThinking()` function to automatically populate thinking metadata on models based on their capabilities
- Added `mapEffortToAnthropicAdaptiveEffort()` function to map user effort levels to Anthropic adaptive thinking effort
- Added `mapEffortToGoogleThinkingLevel()` function to map user effort levels to Google thinking levels
- Added `requireSupportedEffort()` function to validate and clamp effort levels per model, throwing errors for unsupported combinations
- Added `clampThinkingLevelForModel()` function to clamp thinking levels to model-supported range
- Added `applyGeneratedModelPolicies()` and `linkSparkPromotionTargets()` exports from model-thinking module
- Added `serviceTier` option to control OpenAI processing priority and cost (auto, default, flex, scale, priority)
- Added `providerPayload` field to messages and responses for reconstructing transport-native history
- Added Gemini usage provider for tracking quota and tier information
- Added `getCodexAccountId()` utility to extract account ID from Codex JWT tokens
- Added email extraction from OpenAI Codex OAuth tokens for credential deduplication

### Changed

- Changed credential disabling mechanism from boolean `disabled` flag to `disabled_cause` text field for tracking why credentials were disabled
- Changed `deleteAuthCredential()` and `deleteAuthCredentialsForProvider()` methods to require a `disabledCause` parameter explaining the reason for disabling
- Changed Gemini model parsing to strip `-preview` suffix for consistent model identification
- Changed OpenAI Codex websocket error handling to detect fatal connection errors and immediately fall back to SSE without retrying
- Changed OpenAI Codex to always use websockets v2 protocol (removed v1 support)
- Changed `reasoning` parameter type from `ThinkingLevel` to `Effort` in `SimpleStreamOptions`, removing 'off' value (callers should omit the field instead)
- Changed thinking configuration to use model-specific metadata instead of hardcoded provider logic for effort mapping
- Changed OpenAI Codex request transformer to accept `Model` parameter for effort validation instead of string model ID
- Changed Anthropic provider to use model thinking metadata for determining adaptive thinking support instead of model ID pattern matching
- Changed Google Vertex and Google providers to use shorter variable names for thinking config construction
- Moved thinking-related utilities from `thinking.ts` to new `model-thinking.ts` module with expanded functionality
- Moved model policy functions from `provider-models/model-policies.ts` to `model-thinking.ts`
- Moved `googleGeminiCliUsageProvider` from `providers/google-gemini-cli-usage.ts` to `usage/gemini.ts`
- Changed default OpenAI model from gpt-5.1-codex to gpt-5.4 across all providers
- Changed `UsageFetchContext` to remove cache and now() dependencies—usage fetchers now use Date.now() directly
- Removed `resetInMs` field from usage windows; consumers should calculate from `resetsAt` timestamp
- Changed OpenAI Codex credential ranking to deduplicate by email when accountId matches
- Improved OpenAI Codex error handling with retryable error detection

### Removed

- Removed `thinking.ts` module; use `model-thinking.ts` instead
- Removed `provider-models/model-policies.ts` module; functionality moved to `model-thinking.ts`
- Removed `supportsXhigh()` function from models.ts; use model.thinking metadata instead
- Removed `ThinkingLevel` and `ThinkingEffort` types; use `Effort` enum instead
- Removed `getAvailableThinkingLevels()` and `getAvailableThinkingEfforts()` functions
- Removed `model-policies` export from `provider-models/index.ts`
- Removed hardcoded thinking level clamping logic from OpenAI Codex request transformer; now uses model metadata
- Removed `UsageCache` and `UsageCacheEntry` interfaces—caching is now handled internally by AuthStorage
- Removed `google-gemini-cli-usage` export; use new `gemini` usage provider instead
- Removed `resetInMs` computation from all usage providers
- Removed cache TTL constants and cache management from usage fetchers (claude, github-copilot, google-antigravity, kimi, openai-codex, zai)

### Fixed

- Fixed credential purging to respect disabled credentials when deduplicating by email, preventing re-enablement of intentionally disabled credentials
- Fixed OpenAI Codex websocket error reporting to include detailed error messages from error events
- Fixed conversation history reconstruction to support incremental updates from multiple assistant messages while maintaining backward compatibility with full-snapshot payloads
- Fixed OpenAI Codex to reject unsupported effort levels instead of silently clamping them, providing clear error messages about supported efforts
- Fixed model cache normalization to properly apply thinking enrichment when loading cached models
- Fixed dynamic model merging to apply thinking enrichment to merged model results
- Fixed OpenAI Codex streaming to properly include service_tier in SSE payloads
- Fixed type safety in OpenAI responses by removing unsafe type casts on image content blocks
- Fixed credential purging to respect disabled credentials when deduplicating by email

## [13.9.2] - 2026-03-05

### Added

- Support for redacted thinking blocks in Anthropic messages, enabling secure handling of encrypted reasoning content
- Preservation of latest Anthropic thinking blocks and redacted thinking content during message transformation, even when switching between Anthropic models

### Changed

- Assistant message content now includes `RedactedThinkingContent` type alongside existing text, thinking, and tool call blocks
- Message transformation logic now preserves signed thinking blocks and redacted thinking for the latest assistant message in Anthropic conversations

### Fixed

- Fixed Unicode normalization to consistently apply `toWellFormed()` to all text content, including thinking blocks, ensuring proper handling of malformed UTF-16 sequences

## [13.9.1] - 2026-03-05

### Breaking Changes

- Removed `THINKING_LEVELS`, `ALL_THINKING_LEVELS`, `ALL_THINKING_MODES`, `THINKING_MODE_DESCRIPTIONS`, and `THINKING_MODE_LABELS` exports
- Renamed `formatThinking()` to `getThinkingMetadata()` with changed return type from string to `ThinkingMetadata` object
- Renamed `getAvailableThinkingLevel()` to `getAvailableThinkingLevels()` and added default parameter
- Renamed `getAvailableThinkingEffort()` to `getAvailableThinkingEfforts()` and added default parameter

### Added

- Added `ThinkingMetadata` type to provide structured access to thinking mode information (value, label, description)

## [13.9.0] - 2026-03-05

### Added

- Exported new thinking module with `ThinkingEffort`, `ThinkingLevel`, and `ThinkingMode` types for managing reasoning effort levels
- Added `getAvailableThinkingEffort()` function to determine supported thinking effort levels based on model capabilities
- Added `parseThinkingEffort()`, `parseThinkingLevel()`, and `parseThinkingMode()` functions for parsing thinking configuration strings
- Added `THINKING_LEVELS`, `ALL_THINKING_LEVELS`, and `ALL_THINKING_MODES` constants for iterating over available thinking options
- Added `THINKING_MODE_DESCRIPTIONS` and `THINKING_MODE_LABELS` for displaying thinking modes in user interfaces
- Added `formatThinking()` function to format thinking modes as compact display labels

### Changed

- Refactored thinking level handling to distinguish between `ThinkingEffort` (provider-level, no "off") and `ThinkingLevel` (user-facing, includes "off")
- Updated `ThinkingBudgets` type to use `ThinkingEffort` instead of `ThinkingLevel` for more precise token budget configuration
- Improved reasoning option handling to explicitly support "off" value for disabling reasoning across all providers
- Simplified thinking effort mapping logic by centralizing provider-specific clamping behavior

## [13.7.8] - 2026-03-04

### Added

- Added ZenMux provider support with mixed API routing: Anthropic-owned models discovered from `https://zenmux.ai/api/v1/models` now use the Anthropic transport (`https://zenmux.ai/api/anthropic`), while other ZenMux models use the OpenAI-compatible transport.

## [13.7.7] - 2026-03-04

### Changed

- Modified response ID normalization to preserve existing item ID prefixes when truncating oversized IDs
- Updated tool call ID normalization to use `fc_` prefix for generated item IDs instead of `item_` prefix

### Fixed

- Fixed handling of reasoning item IDs to remain untouched during response normalization while function call IDs are properly normalized

## [13.7.2] - 2026-03-04

### Added

- Added support for Kagi API key authentication via `login kagi` command
- Added Kagi to the list of available OAuth providers

### Fixed

- MCP tool schemas with `$ref`/`$defs` are now dereferenced before being sent to LLM providers, fixing dangling references that left models without type definitions
- Ajv schema validation no longer emits `console.warn()` for non-standard format keywords (e.g. `"uint"`) from MCP servers, preventing TUI corruption
- Tool schema compilation is now cached per schema identity, eliminating redundant recompilation on every tool call

## [13.6.0] - 2026-03-03

### Added

- Added Anthropic Foundry gateway mode controlled by `CLAUDE_CODE_USE_FOUNDRY`, with support for `FOUNDRY_BASE_URL`, `ANTHROPIC_FOUNDRY_API_KEY`, `ANTHROPIC_CUSTOM_HEADERS`, and optional mTLS material (`CLAUDE_CODE_CLIENT_CERT`, `CLAUDE_CODE_CLIENT_KEY`, `NODE_EXTRA_CA_CERTS`)
- Added LM Studio provider support with OpenAI-compatible model discovery and OAuth login.
- Added support for `LM_STUDIO_API_KEY` and `LM_STUDIO_BASE_URL` environment variables for authentication and custom host configuration.

### Changed

- Anthropic key resolution now prefers `ANTHROPIC_FOUNDRY_API_KEY` over `ANTHROPIC_OAUTH_TOKEN` and `ANTHROPIC_API_KEY` when Foundry mode is enabled
- Anthropic auth base-URL fallback now prefers `FOUNDRY_BASE_URL` when `CLAUDE_CODE_USE_FOUNDRY` is enabled

## [13.5.8] - 2026-03-02

### Fixed

- Fixed schema compatibility issue where patternProperties in tool parameters caused failures when converting to legacy Antigravity format

## [13.5.5] - 2026-03-01

### Changed

- Anthropic Claude system-block cloaking now leaves the agent identity block uncached and applies `cache_control: { type: "ephemeral" }` to injected user system blocks without forcing `ttl: "1h"`

### Fixed

- Anthropic request payload construction now enforces a maximum of 4 `cache_control` breakpoints (tools/system/messages priority order) before dispatch
- Anthropic cache-control normalization now removes later `ttl: "1h"` entries when a default/5m block has already appeared earlier in evaluation order

## [13.5.3] - 2026-03-01

### Fixed

- Fixed tool argument coercion to handle malformed JSON with trailing wrapper braces by parsing leading JSON containers

## [13.4.0] - 2026-03-01

### Breaking Changes

- Removed `TInput` generic parameter from `ToolResultMessage` interface and removed `$normative` property

### Added

- `hasUnrepresentableStrictObjectMap()` pre-flight check in `tryEnforceStrictSchema`: schemas with `patternProperties` or schema-valued `additionalProperties` now degrade gracefully to non-strict mode instead of throwing during enforcement
- `generateClaudeCloakingUserId()` generates structured user IDs for Anthropic OAuth metadata (`user_{hex64}_account_{uuid}_session_{uuid}`)
- `isClaudeCloakingUserId()` validates whether a string matches the cloaking user-ID format
- `mapStainlessOs()` and `mapStainlessArch()` map `process.platform`/`process.arch` to Stainless header values; X-Stainless-Os and X-Stainless-Arch in `claudeCodeHeaders` are now runtime-computed
- `buildClaudeCodeTlsFetchOptions()` attaches SNI and default TLS ciphers for direct `api.anthropic.com` connections
- `createClaudeBillingHeader()` generates the `x-anthropic-billing-header` block (SHA-256 payload fingerprint + random build hash)
- `buildAnthropicSystemBlocks()` now injects a billing header block and the Claude Agent SDK identity block with `ephemeral` 1h cache-control when `includeClaudeCodeInstruction` is set
- `resolveAnthropicMetadataUserId()` auto-generates a cloaking user ID for OAuth requests when `metadata.user_id` is absent or invalid
- `AnthropicOAuthFlow` is now exported for direct use
- OAuth callback server timeout extended from 2 min to 5 min
- `parseGeminiCliCredentials()` parses Google Cloud credential JSON with support for legacy (`{token,projectId}`), alias (`project_id`/`refresh`/`expires`), and enriched formats
- `shouldRefreshGeminiCliCredentials()` and proactive token refresh before requests for both Gemini CLI and Antigravity providers (60s pre-expiry buffer)
- `normalizeAntigravityTools()` converts `parametersJsonSchema` → `parameters` in function declarations for Antigravity compatibility
- `ANTIGRAVITY_SYSTEM_INSTRUCTION` is now exported for use by search and other consumers
- `ANTIGRAVITY_LOAD_CODE_ASSIST_METADATA` constant exported from OAuth module with `ANTIGRAVITY` ideType
- Antigravity project onboarding: `onboardProjectWithRetries()` provisions a new project via `onboardUser` LRO when `loadCodeAssist` returns no existing project (up to 5 attempts, 2s interval)
- `getOAuthApiKey` now includes `refreshToken`, `expiresAt`, `email`, and `accountId` in the Gemini/Antigravity JSON credential payload to enable proactive refresh
- Antigravity model discovery now tries the production daily endpoint first, with sandbox as fallback
- `ANTIGRAVITY_DISCOVERY_DENYLIST` filters low-quality/internal models from discovery results

### Changed

- Replaced `sanitizeSurrogates()` utility with native `String.prototype.toWellFormed()` for handling unpaired Unicode surrogates across all providers
- Extended `ANTHROPIC_OAUTH_BETA` constant in the OpenAI-compat Anthropic route with `interleaved-thinking-2025-05-14`, `context-management-2025-06-27`, and `prompt-caching-scope-2026-01-05` beta flags
- `claudeCodeVersion` bumped to `2.1.63`; `claudeCodeSystemInstruction` updated to identify as Claude Agent SDK
- `claudeCodeHeaders`: removed `X-Stainless-Helper-Method`, updated package version to `0.74.0`, runtime version to `v24.3.0`
- `applyClaudeToolPrefix` / `stripClaudeToolPrefix` now accept an optional prefix override and skip Anthropic built-in tool names (`web_search`, `code_execution`, `text_editor`, `computer`)
- Accept-Encoding header updated to `gzip, deflate, br, zstd`
- Non-Anthropic base URLs now receive `Authorization: Bearer` regardless of OAuth status
- Prompt-caching logic now skips applying breakpoints when any block already carries `cache_control`, instead of stripping then re-applying
- `fine-grained-tool-streaming-2025-05-14` removed from default beta set
- Anthropic OAuth token URL changed from `platform.claude.com` to `api.anthropic.com`
- Anthropic OAuth scopes reduced to `org:create_api_key user:profile user:inference`
- OAuth code exchange now strips URL fragment from callback code, using the fragment as state override when present
- Claude usage headers aligned: user-agent updated to `claude-cli/2.1.63 (external, cli)`, anthropic-beta extended with full beta set
- Antigravity session ID format changed to signed decimal (negative int63 derived from SHA-256 of first user message, or random bounded int63)
- Antigravity `requestId` now uses `agent-{uuid}` format; non-Antigravity requests no longer include requestId/userAgent/requestType in the payload
- `ANTIGRAVITY_DAILY_ENDPOINT` corrected to `daily-cloudcode-pa.googleapis.com`; sandbox endpoint kept as fallback only
- Antigravity discovery: removed `recommended`/`agentModelSorts` filter; now includes all non-internal, non-denylisted models
- Antigravity discovery no longer sends `project` in the request body
- Gemini/Antigravity OAuth flows no longer use PKCE (code_challenge removed)
- Antigravity `loadCodeAssist` metadata ideType changed from `IDE_UNSPECIFIED` to `ANTIGRAVITY`
- Antigravity `discoverProject` now uses a single canonical production endpoint; falls back to project onboarding instead of a hardcoded default project ID
- `VALIDATED` tool calling config applied to Antigravity requests with Claude models
- `maxOutputTokens` removed from Antigravity generation config for non-Claude models
- System instruction injection for Antigravity scoped to Claude and `gemini-3-pro-high` models only

### Removed

- Removed `sanitizeSurrogates()` utility function; use native `String.prototype.toWellFormed()` instead

## [13.3.14] - 2026-02-28

### Added

- Exported schema utilities from new `./utils/schema` module, consolidating JSON Schema handling across providers
- Added `CredentialRankingStrategy` interface for providers to implement usage-based credential selection
- Added `claudeRankingStrategy` for Anthropic OAuth credentials to enable smart multi-account selection based on usage windows
- Added `codexRankingStrategy` for OpenAI Codex OAuth credentials with priority boost for fresh 5-hour window starts
- Added `adaptSchemaForStrict()` helper for unified OpenAI strict schema enforcement across providers
- Added schema equality and merging utilities: `areJsonValuesEqual()`, `mergeCompatibleEnumSchemas()`, `mergePropertySchemas()`
- Added Cloud Code Assist schema normalization: `copySchemaWithout()`, `stripResidualCombiners()`, `prepareSchemaForCCA()`
- Added `sanitizeSchemaForGoogle()` and `sanitizeSchemaForCCA()` for provider-specific schema sanitization
- Added `StringEnum()` helper for creating string enum schemas compatible with Google and other providers
- Added `enforceStrictSchema()` and `sanitizeSchemaForStrictMode()` for OpenAI strict mode schema validation
- Added package exports for `./utils/schema` and `./utils/schema/*` subpaths
- Added `validateSchemaCompatibility()` to statically audit a JSON Schema against provider-specific rules (`openai-strict`, `google`, `cloud-code-assist-claude`) and return structured violations
- Added `validateStrictSchemaEnforcement()` to verify the strict-fail-open contract: enforced schemas pass strict validation, failed schemas return the original object identity
- Added `COMBINATOR_KEYS` (`anyOf`, `allOf`, `oneOf`) and `CCA_UNSUPPORTED_SCHEMA_FIELDS` as exported constants in `fields.ts` to eliminate duplication across modules
- Added `tryEnforceStrictSchema` result cache (`WeakMap`) to avoid redundant sanitize + enforce work for the same schema object
- Added comprehensive schema normalization test suite (`schema-normalization.test.ts`) covering strict mode, Google, and Cloud Code Assist normalization paths
- Added schema compatibility validation test suite (`schema-compatibility.test.ts`) covering all three provider targets

### Changed

- Moved schema utilities from `./utils/typebox-helpers` to new `./utils/schema` module with expanded functionality
- Refactored OpenAI provider tool conversion to use unified `adaptSchemaForStrict()` helper across codex, completions, and responses
- Updated `AuthStorage` to support generic credential ranking via `CredentialRankingStrategy` instead of Codex-only logic
- Moved Google schema sanitization functions from `google-shared.ts` to `./utils/schema` module
- Changed export path: `./utils/typebox-helpers` → `./utils/schema` in main index
- `sanitizeSchemaForGoogle()` / `sanitizeSchemaForCCA()` now accept a parameterized `unsupportedFields` set internally, enabling code reuse between the two sanitizers
- `copySchemaWithout()` rewritten using object-rest destructuring for clarity

### Fixed

- Fixed cycle detection: `WeakSet` guards added to all recursive schema traversals (`sanitizeSchemaForStrictMode`, `enforceStrictSchema`, `normalizeSchemaForCCA`, `normalizeNullablePropertiesForCloudCodeAssist`, `stripResidualCombiners`, `sanitizeSchemaImpl`, `hasResidualCloudCodeAssistIncompatibilities`) — circular schemas no longer cause infinite loops or stack overflows
- Fixed `hasResidualCloudCodeAssistIncompatibilities`: cycle detection now returns `false` (not `true`) for already-visited nodes, eliminating false positives that forced the CCA fallback schema on valid recursive inputs
- Fixed `stripResidualCombiners` to iterate to a fixpoint rather than making a single pass, ensuring chained combiner reductions (where one reduction enables another) are fully resolved
- Fixed `mergeObjectCombinerVariants` required-field computation: the flattened object now takes the intersection of all variants' `required` arrays (unioned with own-level required properties that exist in the merged schema), preventing required fields from being silently dropped or over-included
- Fixed `mergeCompatibleEnumSchemas` to use deep structural equality (`areJsonValuesEqual`) instead of `Object.is` when deduplicating object-valued enum members
- Fixed `sanitizeSchemaForGoogle` const-to-enum deduplication to use deep equality instead of reference equality
- Fixed `sanitizeSchemaForGoogle` type inference for `anyOf`/`oneOf`-flattened const enums: type is now derived from all variants (must agree), falling back to inference from enum values; mixed null/non-null infers the non-null type and sets `nullable`
- Fixed `sanitizeSchemaForGoogle` recursion to spread options when descending (previously only `insideProperties`, `normalizeTypeArrayToNullable`, `stripNullableKeyword` were forwarded; new fields `unsupportedFields` and `seen` were silently dropped)
- Fixed `sanitizeSchemaForGoogle` array-valued `type` filtering to exclude non-string entries before processing
- Removed incorrect `additionalProperties: false` stripping from `sanitizeSchemaForGoogle` (the field is valid in Google schemas when `false`)
- Fixed `sanitizeSchemaForStrictMode` to strip the `nullable` keyword and expand it into `anyOf: [schema, {type: "null"}]` in the output, matching what OpenAI strict mode actually expects
- Fixed `sanitizeSchemaForStrictMode` to infer `type: "array"` when `items` is present but `type` is absent
- Fixed `sanitizeSchemaForStrictMode` to infer a scalar `type` from uniform `enum` values when `type` is not explicitly set
- Fixed `sanitizeSchemaForStrictMode` const-to-enum merge to use deep equality, preventing duplicate enum entries when `const` and `enum` both exist with the same value
- Fixed `enforceStrictSchema` to drop `additionalProperties` unconditionally (previously only object-valued `additionalProperties` was recursed into; non-object values were passed through, violating strict schema requirements)
- Fixed `enforceStrictSchema` to recurse into `$defs` and `definitions` blocks so referenced sub-schemas are also made strict-compliant
- Fixed `enforceStrictSchema` to handle tuple-style `items` arrays (previously only single-schema `items` objects were recursed)
- Fixed `enforceStrictSchema` double-wrapping: optional properties already expressed as `anyOf: [..., {type: "null"}]` are not wrapped again
- Fixed `enforceStrictSchema` `Array.isArray` type-narrowing for `type` field to filter non-string entries before checking for `"object"`

## [13.3.8] - 2026-02-28

### Fixed

- Fixed response body reuse error when handling 429 rate limit responses with retry logic

## [13.3.7] - 2026-02-27

### Added

- Added `tryEnforceStrictSchema` function that gracefully downgrades to non-strict mode when schema enforcement fails, enabling better compatibility with malformed or circular schemas
- Added `sanitizeSchemaForStrictMode` function to normalize JSON schemas by stripping non-structural keywords, converting `const` to `enum`, and expanding type arrays into `anyOf` variants
- Added Kilo Gateway provider support with OpenAI-compatible model discovery, OAuth `/login kilo`, and `KILO_API_KEY` environment variable support ([#193](https://github.com/can1357/oh-my-pi/issues/193))

### Changed

- Changed strict mode handling in OpenAI providers to use `tryEnforceStrictSchema` for safer schema enforcement with automatic fallback to non-strict mode
- Enhanced `enforceStrictSchema` to properly handle schemas with type arrays containing `object` (e.g., `type: ["object", "null"]`)

### Fixed

- Fixed `enforceStrictSchema` to properly handle malformed object schemas with required keys but missing properties
- Fixed `enforceStrictSchema` to correctly process nested object schemas within `anyOf`, `allOf`, and `oneOf` combinators

## [13.3.1] - 2026-02-26

### Added

- Added `topP`, `topK`, `minP`, `presencePenalty`, and `repetitionPenalty` options to `StreamOptions` for fine-grained control over model sampling behavior

## [13.3.0] - 2026-02-26

### Changed

- Allowed OAuth provider logins to supply a manual authorization code handler with a default prompt when none is provided

## [13.2.0] - 2026-02-23

### Added

- Added support for GitHub Copilot provider in strict mode for both openai-completions and openai-responses tool schemas

### Fixed

- Fixed tool descriptions being rejected when undefined by providing empty string fallback across all providers

## [12.19.1] - 2026-02-22

### Added

- Exported `isProviderRetryableError` function for detecting rate-limit and transient stream errors
- Support for retrying malformed JSON stream-envelope parse errors from Anthropic-compatible proxy endpoints

### Changed

- Expanded retry detection to include JSON parse errors (unterminated strings, unexpected end of input) in addition to rate-limit errors

## [12.19.0] - 2026-02-22

### Added

- Added GitLab Duo provider with support for Claude, GPT-5, and other models via GitLab AI Gateway
- Added OAuth authentication for GitLab Duo with automatic token refresh and direct access caching
- Added 16 new GitLab Duo models including Claude Opus/Sonnet/Haiku variants and GPT-5 series models
- Added `isOAuth` option to Anthropic provider to force OAuth bearer auth mode for proxy tokens
- Added `streamGitLabDuo` function to route requests through GitLab AI Gateway with direct access tokens
- Added `getGitLabDuoModels` function to retrieve available GitLab Duo model configurations
- Added `clearGitLabDuoDirectAccessCache` function to manually clear cached direct access tokens

### Changed

- Enhanced `getModelMapping()` to support both GitLab Duo alias IDs (e.g., `duo-chat-gpt-5-codex`) and canonical model IDs (e.g., `gpt-5-codex`) for improved model resolution flexibility
- Migrated `AuthCredentialStore` and `AuthStorage` into `@pk-nerdsaver-ai/pi-ai` as shared credential primitives for downstream packages
- Moved Anthropic auth helpers (`findAnthropicAuth`, `isOAuthToken`, `buildAnthropicSearchHeaders`, `buildAnthropicUrl`) into shared AI utilities for reuse across providers
- Replaced `CliAuthStorage` with `AuthCredentialStore` for improved credential management with multiple credentials per provider
- Updated models.json pricing for Claude 3.5 Sonnet (input: 0.23→0.45, output: 3→2.2, added cache read: 0.225) and Claude 3 Opus (input: 0.3→0.95)
- Moved `mapAnthropicToolChoice` function from gitlab-duo provider to stream module for broader reusability
- Enhanced HTTP status code extraction to handle string-formatted status codes in error objects

### Removed

- Removed `CliAuthStorage` class in favor of new `AuthCredentialStore` with enhanced functionality

## [12.17.2] - 2026-02-21

### Added

- Exported `getAntigravityUserAgent()` function for constructing Antigravity User-Agent headers

### Changed

- Updated default Antigravity version from 1.15.8 to 1.18.3
- Unified User-Agent header generation across Antigravity API calls to use centralized `getAntigravityUserAgent()` function

## [12.17.1] - 2026-02-21

### Added

- Added new export paths for provider models via `./provider-models` and `./provider-models/*`
- Added new export paths for Cursor and OpenAI Codex providers via `./providers/cursor/gen/*` and `./providers/openai-codex/*`
- Added new export paths for usage utilities via `./usage/*`
- Added new export paths for discovery and OAuth utilities via `./utils/discovery` and `./utils/oauth` with subpath exports

### Changed

- Simplified main export path to use wildcard pattern `./src/*.ts` for broader module access
- Updated `models.json` export to include TypeScript declaration file at `./src/models.json.d.ts`
- Reorganized package.json field ordering for improved readability

## [12.17.0] - 2026-02-21

### Fixed

- Cursor provider: bind `execHandlers` when passing handler methods to the exec protocol so handlers receive correct `this` context (fixes "undefined is not an object (evaluating 'this.options')" when using exec tools such as web search with Cursor)

## [12.16.0] - 2026-02-21

### Added

- Exported `readModelCache` and `writeModelCache` functions for direct SQLite-backed model cache access
- Added `<turn_aborted>` guidance marker as synthetic user message when assistant messages are aborted or errored, informing the model that tools may have partially executed
- Added support for Sonnet 4.6 models in adaptive thinking detection

### Changed

- Updated model cache schema version to support improved global model fallback resolution
- Improved GitHub Copilot model resolution to prefer provider-specific model definitions over global references when context window is larger, ensuring optimal model capabilities
- Migrated model cache from per-provider JSON files to unified SQLite database (models.db) for atomic cross-process access
- Renamed `cachePath` option to `cacheDbPath` in ModelManagerOptions to reflect database-backed storage
- Improved non-authoritative cache handling with 5-minute retry backoff instead of retrying on every startup
- Modified handling of aborted/errored assistant messages to preserve tool call structure instead of converting to text summaries, with synthetic 'aborted' tool results injected
- Updated tool call tracking to use status map (Resolved/Aborted) instead of separate sets for better handling of duplicate and aborted tool results

## [12.15.0] - 2026-02-20

### Fixed

- Improved error messages for OAuth token refresh failures by including detailed error information from the provider
- Separated rate limit and usage limit error handling to provide distinct user-friendly messages for ChatGPT rate limits vs subscription usage limits

### Changed

- Increased SDK retry attempts to 5 for OpenAI, Azure OpenAI, and Anthropic clients (was SDK default of 2)
- Changed 429 retry strategy for OpenAI Codex and Google Gemini CLI to use a 5-minute time budget when the server provides a retry delay, instead of a fixed attempt cap

## [12.14.0] - 2026-02-19

### Added

- Added `gemini-3.1-pro` model to opencode provider with text and image input support
- Added `trinity-large-preview-free` model to opencode provider
- Added `google/gemini-3.1-pro-preview` model to nanogpt provider
- Added `google/gemini-3.1-pro-preview` model to openrouter provider with text and image input support
- Added `gemini-3.1-pro` model to cursor provider
- Added optional `intent` field to `ToolCall` interface for harness-level intent metadata

### Changed

- Changed `big-pickle` model API from `openai-completions` to `anthropic-messages`
- Changed `big-pickle` model baseUrl from `https://opencode.ai/zen/v1` to `https://opencode.ai/zen`
- Changed `minimax-m2.5-free` model API from `openai-completions` to `anthropic-messages`
- Changed `minimax-m2.5-free` model baseUrl from `https://opencode.ai/zen/v1` to `https://opencode.ai/zen`

### Fixed

- Fixed tool argument validation to iteratively coerce nested JSON strings across multiple passes, enabling proper handling of deeply nested JSON-serialized objects and arrays

## [12.13.0] - 2026-02-19

### Added

- Added NanoGPT provider support with API-key login, dynamic model discovery from `https://nano-gpt.com/api/v1/models`, and text-model filtering for catalog/runtime discovery ([#111](https://github.com/can1357/oh-my-pi/issues/111))

## [12.12.3] - 2026-02-19

### Fixed

- Fixed retry logic to recognize 'unable to connect' errors as transient failures

## [12.11.3] - 2026-02-19

### Fixed

- Fixed OpenAI Codex streaming to fail truncated responses that end without a terminal completion event, preventing partial outputs from being treated as successful completions.
- Fixed Codex websocket append fallback by resetting stale turn-state/model-etag session metadata when request shape diverges from appendable history.

## [12.11.1] - 2026-02-19

### Added

- Added support for Claude 4.6 Opus and Sonnet models via Cursor API
- Added support for Composer 1.5 model via Cursor API
- Added support for GPT-5.1 Codex Mini and GPT-5.1 High models via Cursor API
- Added support for GPT-5.2 and GPT-5.3 Codex variants (Fast, High, Low, Extra High) via Cursor API
- Added HTTP/2 transport support for Cursor API requests (required by Cursor API)

### Changed

- Updated pricing for Claude 3.5 Sonnet model
- Updated Claude 3.5 Sonnet context window from 262,144 to 131,072 tokens
- Simplified Cursor model display names by removing '(Cursor)' suffix
- Changed Cursor API timeout from 15 seconds to 5 seconds
- Switched Cursor API transport from HTTP/1.1 to HTTP/2

## [12.11.0] - 2026-02-19

### Added

- Added `priority` field to Model interface for provider-assigned model prioritization
- Added `CatalogDiscoveryConfig` interface to standardize catalog discovery configuration across providers
- Added type guards `isCatalogDescriptor()` and `allowsUnauthenticatedCatalogDiscovery()` for safer descriptor handling
- Added `DEFAULT_MODEL_PER_PROVIDER` export from descriptors module for centralized default model management
- Support for 11 new AI providers: Cloudflare AI Gateway, Hugging Face Inference, LiteLLM, Moonshot, NVIDIA, Ollama, Qianfan, Qwen Portal, Together, Venice, vLLM, and Xiaomi MiMo
- Login flows for new providers with API key validation and OAuth token support
- Extended `KnownProvider` type to include all newly supported providers
- API key environment variable mappings for all new providers in service provider map
- Model discovery and configuration for Cloudflare AI Gateway, Hugging Face, LiteLLM, Moonshot, NVIDIA, Ollama, Qianfan, Qwen Portal, Together, Venice, vLLM, and Xiaomi MiMo

### Changed

- Refactored OAuth credential retrieval to simplify storage lifecycle management in model generation script
- Parallelized special model discovery sources (Antigravity, Codex) for improved generation performance
- Reorganized model JSON structure to place `contextWindow` and `maxTokens` before `compat` field for consistency
- Added `priority` field to OpenAI Codex models for provider-assigned model prioritization
- Refactored provider descriptors to use helper functions (`descriptor`, `catalog`, `catalogDescriptor`) for reduced code duplication
- Refactored models.dev provider descriptors to use helper functions (`simpleModelsDevDescriptor`, `openAiCompletionsDescriptor`, `anthropicMessagesDescriptor`) for improved maintainability
- Unified provider descriptors into single source of truth in `descriptors.ts` for both runtime model discovery and catalog generation, improving maintainability
- Refactored model generation script to use declarative `CatalogProviderDescriptor` interface instead of separate descriptor types, reducing code duplication
- Reorganized models.dev provider descriptors into logical groups (Bedrock, Core, Coding Plans, Specialized) for better code organization
- Simplified API resolution for OpenCode and GitHub Copilot providers using rule-based matching instead of inline conditionals
- Refactored model generation script to use declarative provider descriptors instead of inline provider-specific logic, improving maintainability and reducing code duplication
- Extracted model post-processing policies (cache pricing corrections, context window normalization) into dedicated `model-policies.ts` module for better testability and clarity
- Removed static bundled models for Ollama and vLLM from `models.json` to rely on dynamic discovery instead, reducing static catalog size
- Updated `OAuthProvider` type to include new provider identifiers
- Expanded model registry (models.json) with thousands of new model entries across all new providers
- Modified environment variable resolution to use `$pickenv` for providers with multiple possible env var names
- Updated README documentation to list all newly supported providers and their authentication requirements

## [12.10.1] - 2026-02-18

- Added Synthetic provider
- Added API-key login helpers for Synthetic and Cerebras providers

## [12.10.0] - 2026-02-18

### Breaking Changes

- Renamed public API functions: `getModel()` → `getBundledModel()`, `getModels()` → `getBundledModels()`, `getProviders()` → `getBundledProviders()`

### Added

- Exported `ModelManager` API for runtime-aware model resolution with dynamic endpoint discovery
- Exported provider-specific model manager configuration helpers for Google, OpenAI-compatible, Codex, and Cursor providers
- Exported discovery utilities for fetching models from Antigravity, Codex, Cursor, Gemini, and OpenAI-compatible endpoints
- Added `createModelManager()` function to manage bundled and dynamically discovered models with configurable refresh strategies
- Added support for on-disk model caching with TTL-based invalidation
- Added `resolveProviderModels()` function for runtime model resolution across multiple providers
- Added EU cross-region inference variants for Claude Haiku 3.5 on Bedrock
- Added Claude Sonnet 4.6 and Claude Sonnet 4.6 Thinking models to Antigravity provider
- Added GLM-5 Free model via OpenCode provider
- Added GLM-4.7-FlashX model via ZAI provider
- Added MiniMax-M2.5-highspeed model across multiple providers (minimax-code, minimax-code-cn, minimax, minimax-cn)
- Added Claude Sonnet 4.6 model to OpenRouter provider
- Added Qwen 3.5 Plus model to Vercel AI Gateway provider
- Added Claude Sonnet 4.6 model to Vercel AI Gateway provider

### Changed

- Renamed `getModel()` to `getBundledModel()` to clarify it returns compile-time bundled models only
- Renamed `getModels()` to `getBundledModels()` for consistency
- Renamed `getProviders()` to `getBundledProviders()` for consistency
- Refactored model generation script to use modular discovery functions instead of monolithic provider-specific logic
- Updated models.json with new model entries and pricing updates across multiple providers
- Updated pricing for deepseek/deepseek-v3 model on OpenRouter
- Updated maxTokens from 65536 to 4096 for deepseek/deepseek-v3 on OpenRouter
- Updated pricing and maxTokens for mistralai/mistral-large-2411 on OpenRouter
- Updated pricing for qwen/qwen-max on Together AI
- Updated pricing for qwen/qwen-vl-plus on Together AI
- Updated pricing for qwen/qwen-plus on Together AI
- Updated pricing for qwen/qwen-turbo on Together AI
- Expanded EU cross-region inference variant support to all Claude models on Bedrock (previously limited to Haiku, Sonnet, and Opus 4.5)

## [12.8.0] - 2026-02-16

### Added

- Added `contextPromotionTarget` model property to specify preferred fallback model when context promotion is triggered
- Added automatic context promotion target assignment for Spark models to their base model equivalents
- Added support for Brave search provider with BRAVE_API_KEY environment variable

### Changed

- Updated Qwen model context window and max token limits for improved accuracy

## [12.7.0] - 2026-02-16

### Added

- Added DeepSeek-V3.2 model support via Amazon Bedrock
- Added GLM-5 model support via OpenCode
- Added MiniMax M2.5 model support via OpenCode

### Changed

- Updated GLM-4.5, GLM-4.5-Air, GLM-4.5-Flash, GLM-4.5V, GLM-4.6, GLM-4.6V, GLM-4.7, GLM-4.7-Flash, and GLM-5 models to use anthropic-messages API instead of openai-completions
- Updated GLM models base URL from https://api.z.ai/api/coding/paas/v4 to https://api.z.ai/api/anthropic
- Updated pricing for multiple models including Mistral, Moonshot, and Qwen variants
- Updated context window and max tokens for several models to reflect accurate specifications

### Removed

- Removed compat field with supportsDeveloperRole and thinkingFormat properties from GLM models

## [12.6.0] - 2026-02-16

### Added

- Added source-scoped custom API and OAuth provider registration helpers for extension-defined providers.

### Changed

- Expanded `Api` typing to allow extension-defined API identifiers while preserving built-in API exhaustiveness checks.

### Fixed

- Fixed custom API registration to reject built-in API identifiers and prevent accidental provider overrides.

## [12.2.0] - 2026-02-13

### Added

- Added automatic retry logic for WebSocket stream closures before response completion, with configurable retry budget to improve reliability on flaky connections
- Added `providerSessionState` option to enable provider-scoped mutable state persistence across agent turns
- Added WebSocket retry logic with configurable retry budget and delay via `PI_CODEX_WEBSOCKET_RETRY_BUDGET` and `PI_CODEX_WEBSOCKET_RETRY_DELAY_MS` environment variables
- Added WebSocket idle timeout detection via `PI_CODEX_WEBSOCKET_IDLE_TIMEOUT_MS` environment variable to fail stalled connections
- Added WebSocket v2 beta header support via `PI_CODEX_WEBSOCKET_V2` environment variable for newer OpenAI API versions
- Added WebSocket handshake header capture to extract and replay session metadata (turn state, models etag, reasoning flags) across SSE fallback requests
- Added `preferWebsockets` option to enable WebSocket transport for OpenAI Codex responses when supported
- Added `prewarmOpenAICodexResponses()` function to establish and reuse WebSocket connections across multiple requests
- Added `getOpenAICodexTransportDetails()` function to inspect transport layer details including WebSocket status and fallback information
- Added `getProviderDetails()` function to retrieve formatted provider configuration and transport information
- Added automatic fallback from WebSocket to SSE when connection fails, with transparent retry logic
- Added session state management to reuse WebSocket connections and enable request appending across turns
- Added support for x-codex-turn-state header to maintain conversation state across SSE requests

### Changed

- Changed WebSocket session state storage from global maps to provider-scoped session state for multi-agent isolation
- Changed WebSocket connection initialization to accept idle timeout configuration and handshake header callbacks
- Changed WebSocket error handling to use standardized transport error messages with `Codex websocket transport error` prefix
- Changed WebSocket retry behavior to retry transient failures before activating sticky fallback, improving reliability on flaky connections
- Changed OpenAI Codex model configuration to prefer WebSocket transport by default with `preferWebsockets: true`
- Changed header handling to use appropriate OpenAI-Beta header values for WebSocket vs SSE transports
- Perplexity OAuth token refresh now uses JWT expiry extraction instead of Socket.IO RPC, improving reliability when server is unreachable
- Removed Socket.IO client implementation for Perplexity token refresh; tokens are now validated using embedded JWT expiry claims

### Removed

- Removed `refreshPerplexityToken` export; token refresh is now handled internally via JWT expiry detection

### Fixed

- Fixed WebSocket stream retry logic to properly handle mid-stream connection closures and retry before falling back to SSE transport
- Fixed `preferWebsockets` option handling to correctly respect explicit `false` values when determining transport preference
- Fixed WebSocket append state not being reset after aborted requests, preventing stale state from affecting subsequent turns
- Fixed WebSocket append state not being reset after stream errors, preventing failed append attempts from blocking future requests
- Fixed Codex model context window metadata to use 272000 input tokens (instead of 400000 total budget) for non-Spark Codex variants

## [12.0.0] - 2026-02-12

### Added

- Added GPT-5.3 Codex Spark model with 128K context window and extended reasoning capabilities
- Added MiniMax M2.5 and M2.5 Lightning models via OpenAI-compatible API (minimax-code provider)
- Added MiniMax M2.5 and M2.5 Lightning models via OpenAI-compatible API (minimax-code-cn provider for China region)
- Added MiniMax M2.5 and M2.5 Lightning models via Anthropic API (minimax and minimax-cn providers)
- Added Llama 3.1 8B model via Cerebras API
- Added MiniMax M2.5 model via OpenRouter
- Added MiniMax M2.5 model via Vercel AI Gateway
- Added MiniMax M2.5 Free model via OpenCode
- Added Qwen3 VL 32B Instruct multimodal model via OpenRouter

### Changed

- Updated Z.ai GLM-5 pricing and context window configuration on OpenRouter
- Updated Qwen3 Max Thinking max tokens from 32768 to 65536 on OpenRouter
- Updated OpenAI GPT-5 Image Mini pricing on OpenRouter
- Updated OpenAI GPT-5 Pro pricing and context window on OpenRouter
- Updated OpenAI o4-mini pricing and context window on OpenRouter
- Updated Claude Opus 4.5 Thinking model name formatting (removed parentheses)
- Updated Claude Opus 4.6 Thinking model name formatting (removed parentheses)
- Updated Claude Sonnet 4.5 Thinking model name formatting (removed parentheses)
- Updated Gemini 2.5 Flash Thinking model name formatting (removed parentheses)
- Updated Gemini 3 Pro High and Low model name formatting (removed parentheses)
- Updated GPT-OSS 120B Medium model name formatting (removed parentheses) and context window to 131072

### Removed

- Removed GLM-5 model from Z.ai provider
- Removed Trinity Large Preview Free model from OpenCode provider
- Removed MiniMax M2.1 Free model from OpenCode provider
- Removed deprecated Anthropic model entries: `claude-3-5-haiku-latest`, `claude-3-5-haiku-20241022`, `claude-3-7-sonnet-20250219`, `claude-3-7-sonnet-latest`, `claude-3-opus-20240229`, `claude-3-sonnet-20240229` ([#33](https://github.com/can1357/oh-my-pi/issues/33))

### Fixed

- Added deprecation filter in model generation script to prevent re-adding deprecated Anthropic models ([#33](https://github.com/can1357/oh-my-pi/issues/33))

## [11.14.1] - 2026-02-12

### Added

- Added prompt-caching-scope-2026-01-05 beta feature support

### Changed

- Updated Claude Code version header to 2.1.39
- Updated runtime version header to v24.13.1 and package version to 0.73.0
- Increased request timeout from 60s to 600s
- Reordered Accept-Encoding header values for compression preference
- Updated OAuth authorization and token endpoints to use platform.claude.com
- Expanded OAuth scopes to include user:sessions:claude_code and user:mcp_servers

### Removed

- Removed claude-code-20250219 beta feature from default models
- Removed fine-grained-tool-streaming-2025-05-14 beta feature

## [11.13.1] - 2026-02-12

### Added

- Added Perplexity (Pro/Max) OAuth login support via native macOS app extraction or email OTP authentication
- Added `loginPerplexity` and `refreshPerplexityToken` functions for Perplexity account integration
- Added Socket.IO v4 client implementation for authenticated WebSocket communication with Perplexity API

## [11.12.0] - 2026-02-11

### Changed

- Increased maximum retry attempts for Codex requests from 2 to 5 to improve reliability on transient failures

### Fixed

- Fixed tool result content handling in Anthropic provider to provide fallback error message when content is empty
- Improved retry delay calculation to parse delay values from error response bodies (e.g., 'Please try again in 225ms')

## [11.11.0] - 2026-02-10

### Breaking Changes

- Replaced `./models.generated` export with `./models.json` - update imports from `import { MODELS } from './models.generated'` to `import MODELS from './models.json' with { type: 'json' }`

### Added

- Added TypeScript type declarations for `models.json` to enable proper type inference when importing the JSON file

### Changed

- Updated available models in google-antigravity provider with new model variants and updated context window/token limits
- Simplified type signatures for `getModel()` and `getModels()` functions for improved usability
- Changed models export from TypeScript module to JSON format for improved performance and reduced bundle size
- Updated `@anthropic-ai/sdk` dependency from ^0.72.1 to ^0.74.0

## [11.10.0] - 2026-02-10

### Added

- Added support for Kimi K2, K2 Turbo Preview, and K2.5 models with reasoning capabilities

### Fixed

- Fixed Claude Opus 4.6 context window to 200K across all providers (was incorrectly set to 1M)
- Fixed Claude Sonnet 4 context window to 200K across multiple providers (was incorrectly set to 1M)

## [11.8.0] - 2026-02-10

### Added

- Added `auto` model alias for OpenRouter with automatic model routing
- Added `openrouter/aurora-alpha` model with reasoning capabilities
- Added `qwen/qwen3-max-thinking` model with extended context window support
- Added support for `parametersJsonSchema` in Google Gemini tool definitions for improved JSON Schema compatibility

### Changed

- Updated Claude Sonnet 4 and 4.5 context window from 1M to 200K tokens to reflect actual limits
- Updated Claude Opus 4.6 context window to 200K tokens across providers
- Changed default `reasoningSummary` for OpenAI Codex from `undefined` to `auto`
- Updated Qwen model pricing and context window specifications across multiple variants
- Modified Google Gemini CLI system instruction to use compact format
- Changed tool parameter handling for Claude models on Google Cloud Code Assist to use legacy `parameters` field for API translation

### Removed

- Removed `glm-4.7-free` model from OpenCode provider
- Removed `qwen3-coder` model from OpenCode provider
- Removed `ai21/jamba-mini-1.7` model from OpenRouter
- Removed `stepfun-ai/step3` model from OpenRouter
- Removed duplicate test suite for Google Antigravity Provider with `gemini-3-pro-high`

### Fixed

- Fixed Amazon Bedrock HTTP/1.1 handler import to use direct import instead of dynamic import
- Fixed Qwen model context window and pricing inconsistencies across OpenRouter
- Fixed cache read pricing for multiple Qwen models
- Fixed OpenAI Codex reasoning effort clamping for `gpt-5.3-codex` model

## [11.7.1] - 2026-02-07

### Added

- Added Claude Opus 4.6 Thinking model for Antigravity provider
- Added Gemini 2.5 Flash, Gemini 2.5 Flash Thinking, and Gemini 2.5 Pro models for Antigravity provider
- Added Pony Alpha model via OpenRouter

### Changed

- Updated Antigravity models to use free tier pricing (0 cost) across all models
- Changed Antigravity model fetching to dynamically load from API when credentials are available, with hardcoded fallback models
- Updated Claude Opus 4.6 context window from 200,000 to 1,000,000 tokens across Bedrock regions
- Updated Claude Opus 4.6 cache pricing from 1.5/18.75 to 0.5/6.25 for EU and US regions
- Updated Antigravity model pricing to free tier (0 cost) for Claude Opus 4.5 Thinking, Claude Sonnet 4.5 Thinking, Gemini 3 Flash, Gemini 3 Pro variants, and GPT-OSS 120B Medium
- Updated GPT-OSS 120B Medium reasoning capability from false to true
- Updated Gemini 3 Flash max tokens from 65,535 to 65,536
- Updated Claude Opus 4.5 Thinking display name formatting to include parentheses
- Updated various model pricing and context window parameters across OpenRouter and other providers
- Removed Claude Opus 4.6 20260205 model from Anthropic provider

### Fixed

- Fixed Claude Opus 4.6 model ID format by removing version suffix (:0) in Bedrock configurations
- Fixed Llama 3.1 70B Instruct pricing and context window parameters
- Fixed Mistral model pricing and cache read costs
- Fixed DeepSeek and other model pricing inconsistencies
- Fixed Qwen model pricing and token limits
- Fixed GLM model pricing and context window specifications

## [11.6.0] - 2026-02-07

### Added

- Added Bedrock cache retention support with `PI_CACHE_RETENTION` env var and per-request `cacheRetention` option
- Added adaptive thinking support for Bedrock Opus 4.6+ models
- Added `AWS_BEDROCK_SKIP_AUTH` env var to support unauthenticated Bedrock proxies
- Added `AWS_BEDROCK_FORCE_HTTP1` env var to force HTTP/1.1 for custom Bedrock endpoints
- Re-exported `Static`, `TSchema`, and `Type` from `@sinclair/typebox`

### Fixed

- Fixed OpenAI Responses storage disabled by default (`store: false`)
- Fixed reasoning effort clamping for gpt-5.3 Codex models (minimal -> low)
- Fixed Bedrock `supportsPromptCaching` to also check model cost fields

## [11.5.1] - 2026-02-07

### Fixed

- Fixed schema normalization to handle array-valued `type` fields by converting them to a single type with nullable flag for Google provider compatibility

## [11.3.0] - 2026-02-06

### Added

- Added `cacheRetention` option to control prompt cache retention preference ('none', 'short', 'long') across providers
- Added `maxRetryDelayMs` option to cap server-requested retry delays and fail fast when delays exceed the limit
- Added `effort` option for Anthropic Opus 4.6+ models to control adaptive thinking effort levels ('low', 'medium', 'high', 'max')
- Added support for Anthropic Opus 4.6+ adaptive thinking mode that lets Claude decide when and how much to think
- Added `PI_AI_ANTIGRAVITY_VERSION` environment variable to customize Antigravity sandbox endpoint version
- Exported `convertAnthropicMessages` function for converting message formats to Anthropic API
- Automatic fallback for Anthropic assistant-prefill requests: appends synthetic user "Continue." message when conversation ends with assistant turn to maintain API compatibility

### Changed

- Changed `supportsXhigh()` to include GPT-5.1 Codex Max and broaden Anthropic support to all Anthropic Messages API models with budget-based thinking capability
- Changed Anthropic thinking mode to use adaptive thinking for Opus 4.6+ models instead of budget-based thinking
- Changed `supportsXhigh()` to support GPT-5.2/5.3 and Anthropic Opus 4.6+ models with adaptive thinking
- Changed prompt caching to respect `cacheRetention` option and support TTL configuration for Anthropic
- Changed OpenAI tool definitions to conditionally include `strict` field only when provider supports it
- Changed Qwen model support to use `enable_thinking` boolean parameter instead of OpenAI-style reasoning_effort

### Fixed

- Fixed indentation and formatting in `convertAnthropicMessages` function
- Fixed handling of conversations ending with assistant messages on Anthropic-routed models that reject assistant prefill requests

## [11.2.3] - 2026-02-05

### Added

- Added Claude Opus 4.6 model support across multiple providers (Anthropic, Amazon Bedrock, GitHub Copilot, OpenRouter, OpenCode, Vercel AI Gateway)
- Added GPT-5.3 Codex model support for OpenAI
- Added `readSseJson` utility import for improved SSE stream handling in Google Gemini CLI provider

### Changed

- Updated Google Gemini CLI provider to use `readSseJson` utility for cleaner SSE stream parsing
- Updated pricing for Llama 3.1 405B model on Vercel AI Gateway (cache read rate adjusted)
- Updated Llama 3.1 405B context window and max tokens on Vercel AI Gateway (256000 for both)

### Removed

- Removed Kimi K2, Kimi K2 Turbo Preview, and Kimi K2.5 models
- Removed Deep Cogito Cogito V2 Preview models from OpenRouter

## [11.0.0] - 2026-02-05

### Changed

- Replaced direct `process.env` access with `getEnv()` utility from `@pk-nerdsaver-ai/pi-utils` for consistent environment variable handling across all providers
- Updated environment variable names from `OMP_*` prefix to `PI_*` prefix for consistency (e.g., `OMP_CODING_AGENT_DIR` → `PI_CODING_AGENT_DIR`)

### Removed

- Removed automatic environment variable migration from `PI_*` to `OMP_*` prefixes via `migrate-env.ts` module

## [10.5.0] - 2026-02-04

### Changed

- Updated @anthropic-ai/sdk to ^0.72.1
- Updated @aws-sdk/client-bedrock-runtime to ^3.982.0
- Updated @google/genai to ^1.39.0
- Updated @smithy/node-http-handler to ^4.4.9
- Updated openai to ^6.17.0
- Updated @types/node to ^25.2.0

### Removed

- Removed proxy-agent dependency
- Removed undici dependency

## [9.4.0] - 2026-01-31

### Added

- Added `getEnv()` function to retrieve environment variables from process.env, cwd/.env, or ~/.env
- Added support for reading .env files from home directory and current working directory
- Added support for `exa` and `perplexity` as known providers in `getEnvApiKey()`

### Changed

- Changed `getEnvApiKey()` to check process.env, cwd/.env, and ~/.env files in order of precedence
- Refactored provider API key resolution to use a declarative service provider map

## [9.2.2] - 2026-01-31

### Added

- Added OpenCode Zen provider with API key authentication for accessing multiple AI models
- Added 4 new free models via OpenCode: glm-4.7-free, kimi-k2.5-free, minimax-m2.1-free, trinity-large-preview-free
- Added glm-4.7-flash model via Zai provider
- Added Kimi Code provider with OpenAI and Anthropic API format support
- Added prompt cache retention support with PI_CACHE_RETENTION env var
- Added overflow patterns for Bedrock, MiniMax, Kimi; reclassified 429 as rate limiting
- Added profile endpoint integration to resolve user emails with 24-hour caching
- Added automatic token refresh for expired Kimi OAuth credentials
- Added Kimi Code OAuth handler with device authorization flow
- Added Kimi Code usage provider with quota caching
- Added 4 new Kimi Code models (kimi-for-coding, kimi-k2, kimi-k2-turbo-preview, kimi-k2.5)
- Added Kimi Code provider integration with OAuth and token management
- Added tool-choice utility for mapping unified ToolChoice to provider-specific formats
- Added ToolChoice type for controlling tool selection (auto, none, any, required, function)

### Changed

- Updated Kimi K2.5 cache read pricing from 0.1 to 0.08
- Updated MiniMax M2 pricing: input 0.6→0.6, output 3→3, cache read 0.1→0.09999999999999999
- Updated OpenRouter DeepSeek V3.1 pricing and max tokens: input 0.6→0.5, output 3→2.8, maxTokens 262144→4096
- Updated OpenRouter DeepSeek R1 pricing and max tokens: input 0.06→0.049999999999999996, output 0.24→0.19999999999999998, maxTokens 262144→4096
- Updated Anthropic Claude 3.5 Sonnet max tokens from 256000 to 65536 on OpenRouter
- Updated Vercel AI Gateway Claude 3.5 Sonnet cache read pricing from 0.125 to 0.13
- Updated Vercel AI Gateway Claude 3.5 Sonnet New cache read pricing from 0.125 to 0.13
- Updated Vercel AI Gateway GPT-5.2 cache read pricing from 0.175 to 0.18 and display name to 'GPT 5.2'
- Updated Zai GLM-4.6 cache read pricing from 0.024999999999999998 to 0.03
- Updated Zai Qwen QwQ max tokens from 66000 to 16384
- Added delta event batching and throttling (50ms, 20 updates/sec max) to AssistantMessageEventStream
- Updated MiniMax-M2 pricing: input 1.2→0.6, output 1.2→3, cacheRead 0.6→0.1

### Removed

- Removed OpenRouter google/gemini-2.0-flash-exp:free model
- Removed Vercel AI Gateway stealth/sonoma-dusk-alpha and stealth/sonoma-sky-alpha models

### Fixed

- Fixed rate limit issues with Kimi models by always sending max_tokens
- Added handling for sensitive stop reason from Anthropic API safety filters
- Added optional chaining for safer JSON schema property access in Anthropic provider

## [8.6.0] - 2026-01-27

### Changed

- Replaced JSON5 dependency with Bun.JSON5 parsing

### Fixed

- Filtered empty user text blocks for OpenAI-compatible completions and normalized Kimi reasoning_content for OpenRouter tool-call messages

## [8.4.0] - 2026-01-25

### Added

- Added Azure OpenAI Responses provider with deployment mapping and resource-based base URL support

### Changed

- Added OpenRouter routing preferences for OpenAI-compatible completions

### Fixed

- Defaulted Google tool call arguments to empty objects when providers omit args
- Guarded Responses/Codex streaming deltas against missing content parts and handled arguments.done events

## [8.2.1] - 2026-01-24

### Fixed

- Fixed handling of streaming function call arguments in OpenAI responses to properly parse arguments when sent via `response.function_call_arguments.done` events

## [8.2.0] - 2026-01-24

### Changed

- Migrated node module imports from named to namespace imports across all packages for consistency with project guidelines

## [8.0.0] - 2026-01-23

### Fixed

- Fixed OpenAI Responses API 400 error "function_call without required reasoning item" when switching between models (same provider, different model). The fix omits the `id` field for function_calls from different models to avoid triggering OpenAI's reasoning/function_call pairing validation
- Fixed 400 errors when reading multiple images via GitHub Copilot's Claude models. Claude requires tool_use -> tool_result adjacency with no user messages interleaved. Images from consecutive tool results are now batched into a single user message

## [7.0.0] - 2026-01-21

### Added

- Added usage tracking system with normalized schema for provider quota/limit endpoints
- Added Claude usage provider for 5-hour and 7-day quota windows
- Added GitHub Copilot usage provider for chat, completions, and premium requests
- Added Google Antigravity usage provider for model quota tracking
- Added Google Gemini CLI usage provider for tier-based quota monitoring
- Added OpenAI Codex usage provider for primary and secondary rate limit windows
- Added ZAI usage provider for token and request quota tracking

### Changed

- Updated Claude usage provider to extract account identifiers from response headers
- Updated GitHub Copilot usage provider to include account identifiers in usage reports
- Updated Google Gemini CLI usage provider to handle missing reset time gracefully

### Fixed

- Fixed GitHub Copilot usage provider to simplify token handling and improve reliability
- Fixed GitHub Copilot usage provider to properly resolve account identifiers for OAuth credentials
- Fixed API validation errors when sending empty user messages (resume with `.`) across all providers:
- Google Cloud Code Assist (google-shared.ts)
- OpenAI Responses API (openai-responses.ts)
- OpenAI Codex Responses API (openai-codex-responses.ts)
- Cursor (cursor.ts)
- Amazon Bedrock (amazon-bedrock.ts)
- Clamped OpenAI Codex reasoning effort "minimal" to "low" for gpt-5.2 models to avoid API errors
- Fixed GitHub Copilot usage fallback to internal quota endpoints when billing usage is unavailable
- Fixed GitHub Copilot usage metadata to include account identifiers for report dedupe
- Fixed Anthropic usage metadata extraction to include account identifiers when provided by the usage endpoint
- Fixed Gemini CLI usage windows to consistently label quota windows for display suppression

## [6.9.69] - 2026-01-21

### Added

- Added duration and time-to-first-token (ttft) metrics to all AI provider responses
- Added performance tracking for streaming responses across all providers

## [6.9.0] - 2026-01-21

### Removed

- Removed openai-codex provider exports from main package index
- Removed openai-codex prompt utilities and moved them inline
- Removed vitest configuration file

## [6.8.4] - 2026-01-21

### Changed

- Updated prompt caching strategy to follow Anthropic's recommended hierarchy
- Fixed token usage tracking to properly handle cumulative output tokens from message_delta events
- Improved message validation to filter out empty or invalid content blocks
- Increased OAuth callback timeout from 120 seconds to 120,000 milliseconds

## [6.8.3] - 2026-01-21

### Added

- Added `headers` option to all providers for custom request headers
- Added `onPayload` hook to observe provider request payloads before sending
- Added `strictResponsesPairing` option for Azure OpenAI Responses API compatibility
- Added `originator` option to `loginOpenAICodex` for custom OAuth flow identification
- Added per-request `headers` and `onPayload` hooks to `StreamOptions`
- Added `originator` option to `loginOpenAICodex`

### Fixed

- Fixed tool call ID normalization for OpenAI Responses API cross-provider handoffs
- Skipped errored or aborted assistant messages during cross-provider transforms
- Detected AWS ECS/IRSA credentials for Bedrock authentication checks
- Detected AWS ECS/IRSA credentials for Bedrock authentication checks
- Normalized Responses API tool call IDs during handoffs and refreshed handoff tests
- Enforced strict tool call/result pairing for Azure OpenAI Responses API
- Skipped errored or aborted assistant messages during cross-provider transforms

### Security

- Enhanced AWS credential detection to support ECS task roles and IRSA web identity tokens

## [6.8.2] - 2026-01-21

### Fixed

- Improved error handling for aborted requests in Google Gemini CLI provider
- Enhanced OAuth callback flow to handle manual input errors gracefully
- Fixed login cancellation handling in GitHub Copilot OAuth flow
- Removed fallback manual input from OpenAI Codex OAuth flow

### Security

- Hardened database file permissions to prevent credential leakage
- Set secure directory permissions (0o700) for credential storage

## [6.8.0] - 2026-01-20

### Added

- Added `logout` command to CLI for OAuth provider logout
- Added `status` command to show logged-in providers and token expiry
- Added persistent credential storage using SQLite database
- Added OAuth callback server with automatic port fallback
- Added HTML callback page with success/error states
- Added support for Cursor OAuth provider

### Changed

- Updated Promise.withResolvers usage for better compatibility
- Replaced custom sleep implementations with Bun.sleep and abortableSleep
- Simplified SSE stream parsing using readLines utility
- Updated test framework from vitest to bun:test
- Replaced temp directory creation with createTempDirSync utility
- Changed credential storage from auth.json to ~/.omp/agent/agent.db
- Changed CLI command examples from npx to bunx
- Refactored OAuth flows to use common callback server base class
- Updated OAuth provider interfaces to use controller pattern

### Fixed

- Fixed OAuth callback handling with improved error states
- Fixed token refresh for all OAuth providers

## [6.7.670] - 2026-01-19

### Changed

- Updated Claude Code compatibility headers and version
- Improved OAuth token handling with proper state generation
- Enhanced cache control for tool and user message blocks
- Simplified tool name prefixing for OAuth traffic
- Updated PKCE verifier generation for better security

## [5.7.67] - 2026-01-18

### Fixed

- Added error handling for unknown OAuth providers

## [5.6.77] - 2026-01-18

### Fixed

- Prevented duplicate tool results for errored or aborted messages when results already exist

## [5.6.7] - 2026-01-18

### Added

- Added automatic retry logic for OpenAI Codex responses with configurable delay and max retries
- Added tool call ID sanitization for Amazon Bedrock to ensure valid characters
- Added tool argument validation that coerces JSON-encoded strings for expected non-string types

### Changed

- Updated environment variable prefix from PI_ to OMP_ for better consistency
- Added automatic migration for legacy PI_ environment variables to OMP_ equivalents
- Adjusted Bedrock Claude thinking budgets to reserve output tokens when maxTokens is too low

### Fixed

- Fixed orphaned tool call handling to ensure proper tool_use/tool_result pairing for all assistant messages
- Fixed message transformation to insert synthetic tool results for errored/aborted assistant messages with tool calls
- Fixed tool prefix handling in Claude provider to use case-insensitive comparison
- Fixed Gemini 3 model handling to treat unsigned tool calls as context-only with anti-mimicry context
- Fixed message transformation to filter out empty error messages from conversation history
- Fixed OpenAI completions provider compatibility detection to use provider metadata
- Fixed OpenAI completions provider to avoid using developer role for opencode provider
- Fixed orphaned tool call handling to skip synthetic results for errored assistant messages

## [5.5.0] - 2026-01-18

### Changed

- Updated User-Agent header from 'opencode' to 'pi' for OpenAI Codex requests
- Simplified Codex system prompt instructions
- Removed bridge text override from Codex system prompt builder

## [5.3.0] - 2026-01-15

### Changed

- Replaced detailed Codex system instructions with simplified pi assistant instructions
- Updated internal documentation references to use pi-internal:// protocol

## [5.1.0] - 2026-01-14

### Added

- Added Amazon Bedrock provider with `bedrock-converse-stream` API for Claude models via AWS
- Added MiniMax provider with OpenAI-compatible API
- Added EU cross-region inference model variants for Claude models on Bedrock

### Fixed

- Fixed Gemini CLI provider retries with proper error handling, retry delays from headers, and empty stream retry logic
- Fixed numbered list items showing "1." for all items when code blocks break list continuity (via `start` property)

## [5.0.0] - 2026-01-12

### Added

- Added support for `xhigh` thinking level in `thinkingBudgets` configuration

### Changed

- Changed Anthropic thinking token budgets: minimal (1024→3072), low (2048→6144), medium (8192→12288), high (16384→24576)
- Changed Google thinking token budgets: minimal (1024), low (2048→4096), medium (8192), high (16384), xhigh (24575)
- Changed `supportsXhigh()` to return true for all Anthropic models

## [4.6.0] - 2026-01-12

### Fixed

- Fixed incorrect classification of thought signatures in Google Gemini responses—thought signatures are now correctly treated as metadata rather than thinking content indicators
- Fixed thought signature handling in Google Gemini CLI and Vertex AI streaming to properly preserve signatures across text deltas
- Fixed Google schema sanitization stripping property names that match schema keywords (e.g., "pattern", "format") from tool definitions

## [4.4.9] - 2026-01-12

### Fixed

- Fixed Google provider schema sanitization to strip additional unsupported JSON Schema fields (patternProperties, additionalProperties, min/max constraints, pattern, format)

## [4.4.8] - 2026-01-12

### Fixed

- Fixed Google provider schema sanitization to properly collapse `anyOf`/`oneOf` with const values into enum arrays
- Fixed const-to-enum conversion to infer type from the const value when type is not specified

## [4.4.6] - 2026-01-11

### Fixed

- Fixed tool parameter schema sanitization to only apply Google-specific transformations for Gemini models, preserving original schemas for other model types

## [4.4.5] - 2026-01-11

### Changed

- Exported `sanitizeSchemaForGoogle` utility function for external use

### Fixed

- Fixed Google provider schema sanitization to strip additional unsupported JSON Schema fields ($schema, $ref, $defs, format, examples, and others)
- Fixed Google provider to ignore `additionalProperties: false` which is unsupported by the API

## [4.4.4] - 2026-01-11

### Fixed

- Fixed Cursor todo updates to bridge update_todos tool calls to the local todo_write tool

## [4.3.0] - 2026-01-11

### Added

- Added debug log filtering and display script for Cursor JSONL logs with follow mode and coalescing support
- Added protobuf definition extractor script to reconstruct .proto files from bundled JavaScript
- Added conversation state caching to persist context across multiple Cursor API requests in the same session
- Added shell streaming support for real-time stdout/stderr output during command execution
- Added JSON5 parsing for MCP tool arguments with Python-style boolean and None value normalization
- Added Cursor provider with support for Claude, GPT, and Gemini models via Cursor's agent API
- Added OAuth authentication flow for Cursor including login, token refresh, and expiry detection
- Added `cursor-agent` API type with streaming support and tool execution handlers
- Added Cursor model definitions including Claude 4.5, GPT-5.x, Gemini 3, and Grok variants
- Added model generation script to automatically fetch and update AI model definitions from models.dev and OpenRouter APIs

### Changed

- Changed Cursor debug logging to use structured JSONL format with automatic MCP argument decoding
- Changed MCP tool argument decoding to use protobuf Value schema for improved type handling
- Changed tool advertisement to filter Cursor native tools (bash, read, write, delete, ls, grep, lsp) instead of only exposing mcp_ prefixed tools

### Fixed

- Fixed Cursor conversation history serialization so subagents retain task context and can call complete

## [4.2.1] - 2026-01-11

### Changed

- Updated `reasoningSummary` option to accept only `"auto"`, `"concise"`, `"detailed"`, or `null` (removed `"off"` and `"on"` values)
- Changed default `reasoningSummary` from `"auto"` to `"detailed"`
- OpenAI Codex: switched to bundled system prompt matching opencode, changed originator to "opencode", simplified prompt handling

### Fixed

- Fixed Cloud Code Assist tool schema conversion to avoid unsupported `const` fields

## [4.0.0] - 2026-01-10

### Added

- Added `betas` option in `AnthropicOptions` for passing custom Anthropic beta feature flags
- OpenCode Zen provider support with 26 models (Claude, GPT, Gemini, Grok, Kimi, GLM, Qwen, etc.). Set `OPENCODE_API_KEY` env var to use.
- `thinkingBudgets` option in `SimpleStreamOptions` for customizing token budgets per thinking level on token-based providers
- `sessionId` option in `StreamOptions` for providers that support session-based caching. OpenAI Codex provider uses this to set `prompt_cache_key` and routing headers.
- `supportsUsageInStreaming` compatibility flag for OpenAI-compatible providers that reject `stream_options: { include_usage: true }`. Defaults to `true`. Set to `false` in model config for providers like gatewayz.ai.
- `GOOGLE_APPLICATION_CREDENTIALS` env var support for Vertex AI credential detection (standard for CI/production)
- Exported OpenAI Codex utilities: `CacheMetadata`, `getCodexInstructions`, `getModelFamily`, `ModelFamily`, `buildCodexPiBridge`, `buildCodexSystemPrompt`, `CodexSystemPrompt`
- Headless OAuth support for all callback-server providers (Google Gemini CLI, Antigravity, OpenAI Codex): paste redirect URL when browser callback is unreachable
- Cancellable GitHub Copilot device code polling via AbortSignal
- Improved error messages for OpenRouter providers by including raw metadata from upstream errors

### Changed

- Changed Anthropic provider to include Claude Code system instruction for all API key types, not just OAuth tokens (except Haiku models)
- Changed Anthropic OAuth tool naming to use `proxy_` prefix instead of mapping to Claude Code tool names, avoiding potential name collisions
- Changed Anthropic provider to include Claude Code headers for all requests, not just OAuth tokens
- Anthropic provider now maps tool names to Claude Code's exact tool names (Read, Write, Edit, Bash, Grep, Glob) instead of using prefixed names
- OpenAI Completions provider now disables strict mode on tools to allow optional parameters without null unions

### Fixed

- Fixed Anthropic OAuth code parsing to accept full redirect URLs in addition to raw authorization codes
- Fixed Anthropic token refresh to preserve existing refresh token when server doesn't return a new one
- Fixed thinking mode being enabled when tool_choice forces a specific tool, which is unsupported
- Fixed max_tokens being too low when thinking budget is set, now auto-adjusts to model's maxTokens
- Google Cloud Code Assist OAuth for paid subscriptions: properly handles long-running operations for project provisioning, supports `GOOGLE_CLOUD_PROJECT` / `GOOGLE_CLOUD_PROJECT_ID` env vars for paid tiers
- `os.homedir()` calls at module load time; now resolved lazily when needed
- OpenAI Responses tool strict flag to use a boolean for LM Studio compatibility
- Gemini CLI abort handling: detect native `AbortError` in retry catch block, cancel SSE reader when abort signal fires
- Antigravity provider 429 errors by aligning request payload with CLIProxyAPI v6.6.89
- Thinking block handling for cross-model conversations: thinking blocks are now converted to plain text when switching models
- OpenAI Codex context window from 400,000 to 272,000 tokens to match Codex CLI defaults
- Codex SSE error events to surface message, code, and status
- Context overflow detection for `context_length_exceeded` error codes
- Codex provider now always includes `reasoning.encrypted_content` even when custom `include` options are passed
- Codex requests now omit the `reasoning` field entirely when thinking is off
- Crash when pasting text with trailing whitespace exceeding terminal width

## [3.37.1] - 2026-01-10

### Added

- Added automatic type coercion for tool arguments when LLMs return JSON-encoded strings instead of native types (numbers, booleans, arrays, objects)

### Changed

- Changed tool argument validation to attempt JSON parsing and type coercion before rejecting mismatched types
- Changed validation error messages to include both original and normalized arguments when coercion was attempted

## [3.37.0] - 2026-01-10

### Changed

- Enabled type coercion in JSON schema validation to automatically convert compatible types

## [3.35.0] - 2026-01-09

### Added

- Enhanced error messages to include retry-after timing information from API rate limit headers

## [3.20.0] - 2026-01-06

### Added

- Added support for kwaipilot/kat-coder-pro model via OpenRouter
- Added OpenAI Codex responses provider with OAuth login support for ChatGPT Plus/Pro accounts
- Added Google Vertex AI provider (Gemini via Vertex) with Application Default Credentials support

### Changed

- Updated model specifications including context windows, max tokens, and pricing for multiple OpenRouter models

### Removed

- Removed alibaba/tongyi-deepresearch-30b-a3b:free model from OpenRouter
- Removed nousresearch/hermes-4-405b model from OpenRouter
- Removed tngtech/tng-r1t-chimera:free model from OpenRouter

## [3.15.0] - 2026-01-05

### Changed

- Made `isError` field optional in `ToolResultMessage` interface, defaulting to non-error state

## [3.5.1337] - 2026-01-03

### Added

- Added localhost URL detection for OpenAI-compatible provider auto-configuration

## [1.337.1] - 2026-01-02

### Changed

- Forked to @pk-nerdsaver-ai scope with unified versioning across all packages

### Fixed

- **Gemini CLI rate limit handling**: Added automatic retry with server-provided delay for 429 errors

## [1.337.0] - 2026-01-02

Initial release under @pk-nerdsaver-ai scope. See previous releases at [badlogic/pi-mono](https://github.com/badlogic/pi-mono).

## [0.50.1] - 2026-01-26

### Fixed

- Fixed OpenCode Zen model generation to exclude deprecated models ([#970](https://github.com/badlogic/pi-mono/pull/970) by [@DanielTatarkin](https://github.com/DanielTatarkin))

## [0.50.0] - 2026-01-26

### Added

- Added OpenRouter provider routing support for custom models via `openRouterRouting` compat field ([#859](https://github.com/badlogic/pi-mono/pull/859) by [@v01dpr1mr0s3](https://github.com/v01dpr1mr0s3))
- Added `azure-openai-responses` provider support for Azure OpenAI Responses API. ([#890](https://github.com/badlogic/pi-mono/pull/890) by [@markusylisiurunen](https://github.com/markusylisiurunen))
- Added HTTP proxy environment variable support for API requests ([#942](https://github.com/badlogic/pi-mono/pull/942) by [@haoqixu](https://github.com/haoqixu))
- Added `createAssistantMessageEventStream()` factory function for use in extensions.
- Added `resetApiProviders()` to clear and re-register built-in API providers.

### Changed

- Refactored API streaming dispatch to use an API registry with provider-owned `streamSimple` mapping.
- Moved environment API key resolution to `env-api-keys.ts` and re-exported it from the package entrypoint.
- Azure OpenAI Responses provider now uses base URL configuration with deployment-aware model mapping and no longer includes service tier handling.

### Fixed

- Fixed Bun runtime detection for dynamic imports in browser-compatible modules (stream.ts, openai-codex-responses.ts, openai-codex.ts) ([#922](https://github.com/badlogic/pi-mono/pull/922) by [@dannote](https://github.com/dannote))
- Fixed streaming functions to use `model.api` instead of hardcoded API types
- Fixed Google providers to default tool call arguments to an empty object when omitted
- Fixed OpenAI Responses streaming to handle `arguments.done` events on OpenAI-compatible endpoints ([#917](https://github.com/badlogic/pi-mono/pull/917) by [@williballenthin](https://github.com/williballenthin))
- Fixed OpenAI Codex Responses tool strictness handling after the shared responses refactor
- Fixed Azure OpenAI Responses streaming to guard deltas before content parts and correct metadata and handoff gating
- Fixed OpenAI completions tool-result image batching after consecutive tool results ([#902](https://github.com/badlogic/pi-mono/pull/902) by [@terrorobe](https://github.com/terrorobe))

## [0.49.3] - 2026-01-22

### Added

- Added `headers` option to `StreamOptions` for custom HTTP headers in API requests. Supported by all providers except Amazon Bedrock (which uses AWS SDK auth). Headers are merged with provider defaults and `model.headers`, with `options.headers` taking precedence.
- Added `originator` option to `loginOpenAICodex()` for custom OAuth client identification
- Browser compatibility for pi-ai: replaced top-level Node.js imports with dynamic imports for browser environments ([#873](https://github.com/badlogic/pi-mono/issues/873))

### Fixed

- Fixed OpenAI Responses API 400 error "function_call without required reasoning item" when switching between models (same provider, different model). The fix omits the `id` field for function_calls from different models to avoid triggering OpenAI's reasoning/function_call pairing validation ([#886](https://github.com/badlogic/pi-mono/issues/886))

## [0.49.2] - 2026-01-19

### Added

- Added AWS credential detection for ECS/Kubernetes environments: `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI`, `AWS_CONTAINER_CREDENTIALS_FULL_URI`, `AWS_WEB_IDENTITY_TOKEN_FILE` ([#848](https://github.com/badlogic/pi-mono/issues/848))

### Fixed

- Fixed OpenAI Responses 400 error "reasoning without following item" by skipping errored/aborted assistant messages entirely in transform-messages.ts ([#838](https://github.com/badlogic/pi-mono/pull/838))

### Removed

- Removed `strictResponsesPairing` compat option (no longer needed after the transform-messages fix)

## [0.49.1] - 2026-01-18

### Added

- Added `OpenAIResponsesCompat` interface with `strictResponsesPairing` option for Azure OpenAI Responses API, which requires strict reasoning/message pairing in history replay ([#768](https://github.com/badlogic/pi-mono/pull/768) by [@nicobako](https://github.com/nicobako))

### Changed

- Split `OpenAICompat` into `OpenAICompletionsCompat` and `OpenAIResponsesCompat` for type-safe API-specific compat settings

### Fixed

- Fixed tool call ID normalization for cross-provider handoffs (e.g., Codex to Antigravity Claude) ([#821](https://github.com/badlogic/pi-mono/issues/821))

## [0.49.0] - 2026-01-17

### Changed

- OpenAI Codex responses now use the context system prompt directly in the instructions field.

### Fixed

- Fixed orphaned tool results after errored assistant messages causing Codex API errors. When an assistant message has `stopReason: "error"`, its tool calls are now excluded from pending tool tracking, preventing synthetic tool results from being generated for calls that will be dropped by provider-specific converters. ([#812](https://github.com/badlogic/pi-mono/issues/812))
- Fixed Bedrock Claude max_tokens handling to always exceed thinking budget tokens, preventing compaction failures. ([#797](https://github.com/badlogic/pi-mono/pull/797) by [@pjtf93](https://github.com/pjtf93))
- Fixed Claude Code tool name normalization to match the Claude Code tool list case-insensitively and remove invalid mappings.

## [0.48.0] - 2026-01-16

### Fixed

- Fixed OpenAI-compatible provider feature detection to use `model.provider` in addition to URL, allowing custom base URLs (e.g., proxies) to work correctly with provider-specific settings ([#774](https://github.com/badlogic/pi-mono/issues/774))
- Fixed Gemini 3 context loss when switching from providers without thought signatures: unsigned tool calls are now converted to text with anti-mimicry notes instead of being skipped
- Fixed string numbers in tool arguments not being coerced to numbers during validation ([#786](https://github.com/badlogic/pi-mono/pull/786) by [@dannote](https://github.com/dannote))
- Fixed Bedrock tool call IDs to use only alphanumeric characters, avoiding API errors from invalid characters ([#781](https://github.com/badlogic/pi-mono/pull/781) by [@pjtf93](https://github.com/pjtf93))
- Fixed empty error assistant messages (from 429/500 errors) breaking the tool_use to tool_result chain by filtering them in `transformMessages`

## [0.47.0] - 2026-01-16

### Fixed

- Fixed OpenCode provider's `/v1` endpoint to use `system` role instead of `developer` role, fixing `400 Incorrect role information` error for models using `openai-completions` API ([#755](https://github.com/badlogic/pi-mono/pull/755) by [@melihmucuk](https://github.com/melihmucuk))
- Added retry logic to OpenAI Codex provider for transient errors (429, 5xx, connection failures). Uses exponential backoff with up to 3 retries. ([#733](https://github.com/badlogic/pi-mono/issues/733))

## [0.46.0] - 2026-01-15

### Added

- Added MiniMax China (`minimax-cn`) provider support ([#725](https://github.com/badlogic/pi-mono/pull/725) by [@tallshort](https://github.com/tallshort))
- Added `gpt-5.2-codex` models for GitHub Copilot and OpenCode Zen providers ([#734](https://github.com/badlogic/pi-mono/pull/734) by [@aadishv](https://github.com/aadishv))

### Fixed

- Avoid unsigned Gemini 3 tool calls ([#741](https://github.com/badlogic/pi-mono/pull/741) by [@roshanasingh4](https://github.com/roshanasingh4))
- Fixed signature support for non-Anthropic models in Amazon Bedrock provider ([#727](https://github.com/badlogic/pi-mono/pull/727) by [@unexge](https://github.com/unexge))

## [0.45.7] - 2026-01-13

### Fixed

- Fixed OpenAI Responses timeout option handling ([#706](https://github.com/badlogic/pi-mono/pull/706) by [@markusylisiurunen](https://github.com/markusylisiurunen))
- Fixed Bedrock tool call conversion to apply message transforms ([#707](https://github.com/badlogic/pi-mono/pull/707) by [@pjtf93](https://github.com/pjtf93))

## [0.45.6] - 2026-01-13

### Fixed

- Export `parseStreamingJson` from main package for tsx dev mode compatibility

## [0.45.4] - 2026-01-13

### Added

- Added Vercel AI Gateway provider with model discovery and `AI_GATEWAY_API_KEY` env support ([#689](https://github.com/badlogic/pi-mono/pull/689) by [@timolins](https://github.com/timolins))

### Fixed

- Fixed z.ai thinking/reasoning: z.ai uses `thinking: { type: "enabled" }` instead of OpenAI's `reasoning_effort`. Added `thinkingFormat` compat flag to handle this. ([#688](https://github.com/badlogic/pi-mono/issues/688))

## [0.45.0] - 2026-01-13

### Added

- MiniMax provider support with M2 and M2.1 models via Anthropic-compatible API ([#656](https://github.com/badlogic/pi-mono/pull/656) by [@dannote](https://github.com/dannote))
- Add Amazon Bedrock provider with prompt caching for Claude models (experimental, tested with Anthropic Claude models only) ([#494](https://github.com/badlogic/pi-mono/pull/494) by [@unexge](https://github.com/unexge))
- Added `serviceTier` option for OpenAI Responses requests ([#672](https://github.com/badlogic/pi-mono/pull/672) by [@markusylisiurunen](https://github.com/markusylisiurunen))
- **Anthropic caching on OpenRouter**: Interactions with Anthropic models via OpenRouter now set a 5-minute cache point using Anthropic-style `cache_control` breakpoints on the last assistant or user message. ([#584](https://github.com/badlogic/pi-mono/pull/584) by [@nathyong](https://github.com/nathyong))
- **Google Gemini CLI provider improvements**: Added Antigravity endpoint fallback (tries daily sandbox then prod when `baseUrl` is unset), header-based retry delay parsing (`Retry-After`, `x-ratelimit-reset`, `x-ratelimit-reset-after`), stable `sessionId` derivation from first user message for cache affinity, empty SSE stream retry with backoff, and `anthropic-beta` header for Claude thinking models ([#670](https://github.com/badlogic/pi-mono/pull/670) by [@kim0](https://github.com/kim0))

## [0.43.0] - 2026-01-11

### Fixed

- Fixed Google provider thinking detection: `isThinkingPart()` now only checks `thought === true`, not `thoughtSignature`. Per Google docs, `thoughtSignature` is for context replay and can appear on any part type. Also removed `id` field from `functionCall`/`functionResponse` (rejected by Vertex AI and Cloud Code Assist), and added `textSignature` round-trip for multi-turn reasoning context. ([#631](https://github.com/badlogic/pi-mono/pull/631) by [@theBucky](https://github.com/theBucky))

## [0.42.3] - 2026-01-10

### Changed

- OpenAI Codex: switched to bundled system prompt matching opencode, changed originator to "pi", simplified prompt handling

## [0.42.2] - 2026-01-10

### Added

- Added `GOOGLE_APPLICATION_CREDENTIALS` env var support for Vertex AI credential detection (standard for CI/production).
- Added `supportsUsageInStreaming` compatibility flag for OpenAI-compatible providers that reject `stream_options: { include_usage: true }`. Defaults to `true`. Set to `false` in model config for providers like gatewayz.ai. ([#596](https://github.com/badlogic/pi-mono/pull/596) by [@XesGaDeus](https://github.com/XesGaDeus))
- Improved Google model pricing info ([#588](https://github.com/badlogic/pi-mono/pull/588) by [@aadishv](https://github.com/aadishv))

### Fixed

- Fixed `os.homedir()` calls at module load time; now resolved lazily when needed.
- Fixed OpenAI Responses tool strict flag to use a boolean for LM Studio compatibility ([#598](https://github.com/badlogic/pi-mono/pull/598) by [@gnattu](https://github.com/gnattu))
- Fixed Google Cloud Code Assist OAuth for paid subscriptions: properly handles long-running operations for project provisioning, supports `GOOGLE_CLOUD_PROJECT` / `GOOGLE_CLOUD_PROJECT_ID` env vars for paid tiers, and handles VPC-SC affected users ([#582](https://github.com/badlogic/pi-mono/pull/582) by [@cmf](https://github.com/cmf))

## [0.42.0] - 2026-01-09

### Added

- Added OpenCode Zen provider support with 26 models (Claude, GPT, Gemini, Grok, Kimi, GLM, Qwen, etc.). Set `OPENCODE_API_KEY` env var to use.

## [0.39.0] - 2026-01-08

### Fixed

- Fixed Gemini CLI abort handling: detect native `AbortError` in retry catch block, cancel SSE reader when abort signal fires ([#568](https://github.com/badlogic/pi-mono/pull/568) by [@tmustier](https://github.com/tmustier))
- Fixed Antigravity provider 429 errors by aligning request payload with CLIProxyAPI v6.6.89: inject Antigravity system instruction with `role: "user"`, set `requestType: "agent"`, and use `antigravity` userAgent. Added bridge prompt to override Antigravity behavior (identity, paths, web dev guidelines) with Pi defaults. ([#571](https://github.com/badlogic/pi-mono/pull/571) by [@ben-vargas](https://github.com/ben-vargas))
- Fixed thinking block handling for cross-model conversations: thinking blocks are now converted to plain text (no `<thinking>` tags) when switching models. Previously, `<thinking>` tags caused models to mimic the pattern and output literal tags. Also fixed empty thinking blocks causing API errors. ([#561](https://github.com/badlogic/pi-mono/issues/561))

## [0.38.0] - 2026-01-08

### Added

- `thinkingBudgets` option in `SimpleStreamOptions` for customizing token budgets per thinking level on token-based providers ([#529](https://github.com/badlogic/pi-mono/pull/529) by [@melihmucuk](https://github.com/melihmucuk))

### Breaking Changes

- Removed OpenAI Codex model aliases (`gpt-5`, `gpt-5-mini`, `gpt-5-nano`, `codex-mini-latest`, `gpt-5-codex`, `gpt-5.1-codex`, `gpt-5.1-chat-latest`). Use canonical model IDs: `gpt-5.1`, `gpt-5.1-codex-max`, `gpt-5.1-codex-mini`, `gpt-5.2`, `gpt-5.2-codex`. ([#536](https://github.com/badlogic/pi-mono/pull/536) by [@ghoulr](https://github.com/ghoulr))

### Fixed

- Fixed OpenAI Codex context window from 400,000 to 272,000 tokens to match Codex CLI defaults and prevent 400 errors. ([#536](https://github.com/badlogic/pi-mono/pull/536) by [@ghoulr](https://github.com/ghoulr))
- Fixed Codex SSE error events to surface message, code, and status. ([#551](https://github.com/badlogic/pi-mono/pull/551) by [@tmustier](https://github.com/tmustier))
- Fixed context overflow detection for `context_length_exceeded` error codes.

## [0.37.6] - 2026-01-06

### Added

- Exported OpenAI Codex utilities: `CacheMetadata`, `getCodexInstructions`, `getModelFamily`, `ModelFamily`, `buildCodexPiBridge`, `buildCodexSystemPrompt`, `CodexSystemPrompt` ([#510](https://github.com/badlogic/pi-mono/pull/510) by [@mitsuhiko](https://github.com/mitsuhiko))

## [0.37.3] - 2026-01-06

### Added

- `sessionId` option in `StreamOptions` for providers that support session-based caching. OpenAI Codex provider uses this to set `prompt_cache_key` and routing headers.

## [0.37.2] - 2026-01-05

### Fixed

- Codex provider now always includes `reasoning.encrypted_content` even when custom `include` options are passed ([#484](https://github.com/badlogic/pi-mono/pull/484) by [@kim0](https://github.com/kim0))

## [0.37.0] - 2026-01-05

### Breaking Changes

- OpenAI Codex models no longer have per-thinking-level variants (e.g., `gpt-5.2-codex-high`). Use the base model ID and set thinking level separately. The Codex provider clamps reasoning effort to what each model supports internally. (initial implementation by [@ben-vargas](https://github.com/ben-vargas) in [#472](https://github.com/badlogic/pi-mono/pull/472))

### Added

- Headless OAuth support for all callback-server providers (Google Gemini CLI, Antigravity, OpenAI Codex): paste redirect URL when browser callback is unreachable ([#428](https://github.com/badlogic/pi-mono/pull/428) by [@ben-vargas](https://github.com/ben-vargas), [#468](https://github.com/badlogic/pi-mono/pull/468) by [@crcatala](https://github.com/crcatala))
- Cancellable GitHub Copilot device code polling via AbortSignal

### Fixed

- Codex requests now omit the `reasoning` field entirely when thinking is off, letting the backend use its default instead of forcing a value. ([#472](https://github.com/badlogic/pi-mono/pull/472))

## [0.36.0] - 2026-01-05

### Added

- OpenAI Codex OAuth provider with Responses API streaming support: `openai-codex-responses` streaming provider with SSE parsing, tool-call handling, usage/cost tracking, and PKCE OAuth flow ([#451](https://github.com/badlogic/pi-mono/pull/451) by [@kim0](https://github.com/kim0))

### Fixed

- Vertex AI dummy value for `getEnvApiKey()`: Returns `"<authenticated>"` when Application Default Credentials are configured (`~/.config/gcloud/application_default_credentials.json` exists) and both `GOOGLE_CLOUD_PROJECT` (or `GCLOUD_PROJECT`) and `GOOGLE_CLOUD_LOCATION` are set. This allows `streamSimple()` to work with Vertex AI without explicit `apiKey` option. The ADC credentials file existence check is cached per-process to avoid repeated filesystem access.

## [0.32.3] - 2026-01-03

### Fixed

- Google Vertex AI models no longer appear in available models list without explicit authentication. Previously, `getEnvApiKey()` returned a dummy value for `google-vertex`, causing models to show up even when Google Cloud ADC was not configured.

## [0.32.0] - 2026-01-03

### Added

- Vertex AI provider with ADC (Application Default Credentials) support. Authenticate with `gcloud auth application-default login`, set `GOOGLE_CLOUD_PROJECT` and `GOOGLE_CLOUD_LOCATION`, and access Gemini models via Vertex AI. ([#300](https://github.com/badlogic/pi-mono/pull/300) by [@default-anton](https://github.com/default-anton))

### Fixed

- **Gemini CLI rate limit handling**: Added automatic retry with server-provided delay for 429 errors. Parses delay from error messages like "Your quota will reset after 39s" and waits accordingly. Falls back to exponential backoff for other transient errors. ([#370](https://github.com/badlogic/pi-mono/issues/370))

## [0.31.0] - 2026-01-02

### Breaking Changes

- **Agent API moved**: All agent functionality (`agentLoop`, `agentLoopContinue`, `AgentContext`, `AgentEvent`, `AgentTool`, `AgentToolResult`, etc.) has moved to `@pk-nerdsaver-ai/pi-agent-core`. Import from that package instead of `@pk-nerdsaver-ai/pi-ai`.

### Added

- **`GoogleThinkingLevel` type**: Exported type that mirrors Google's `ThinkingLevel` enum values (`"THINKING_LEVEL_UNSPECIFIED" | "MINIMAL" | "LOW" | "MEDIUM" | "HIGH"`). Allows configuring Gemini thinking levels without importing from `@google/genai`.
- **`ANTHROPIC_OAUTH_TOKEN` env var**: Now checked before `ANTHROPIC_API_KEY` in `getEnvApiKey()`, allowing OAuth tokens to take precedence.
- **`event-stream.js` export**: `AssistantMessageEventStream` utility now exported from package index.

### Changed

- **OAuth uses Web Crypto API**: PKCE generation and OAuth flows now use Web Crypto API (`crypto.subtle`) instead of Node.js `crypto` module. This improves browser compatibility while still working in Node.js 20+.
- **Deterministic model generation**: `generate-models.ts` now sorts providers and models alphabetically for consistent output across runs. ([#332](https://github.com/badlogic/pi-mono/pull/332) by [@mrexodia](https://github.com/mrexodia))

### Fixed

- **OpenAI completions empty content blocks**: Empty text or thinking blocks in assistant messages are now filtered out before sending to the OpenAI completions API, preventing validation errors. ([#344](https://github.com/badlogic/pi-mono/pull/344) by [@default-anton](https://github.com/default-anton))
- **zAi provider API mapping**: Fixed zAi models to use `openai-completions` API with correct base URL (`https://api.z.ai/api/coding/paas/v4`) instead of incorrect Anthropic API mapping. ([#344](https://github.com/badlogic/pi-mono/pull/344), [#358](https://github.com/badlogic/pi-mono/pull/358) by [@default-anton](https://github.com/default-anton))

## [0.28.0] - 2025-12-25

### Breaking Changes

- **OAuth storage removed** ([#296](https://github.com/badlogic/pi-mono/issues/296)): All storage functions (`loadOAuthCredentials`, `saveOAuthCredentials`, `setOAuthStorage`, etc.) removed. Callers are responsible for storing credentials.
- **OAuth login functions**: `loginAnthropic`, `loginGitHubCopilot`, `loginGeminiCli`, `loginAntigravity` now return `OAuthCredentials` instead of saving to disk.
- **refreshOAuthToken**: Now takes `(provider, credentials)` and returns new `OAuthCredentials` instead of saving.
- **getOAuthApiKey**: Now takes `(provider, credentials)` and returns `{ newCredentials, apiKey }` or null.
- **OAuthCredentials type**: No longer includes `type: "oauth"` discriminator. Callers add discriminator when storing.
- **setApiKey, resolveApiKey**: Removed. Callers must manage their own API key storage/resolution.
- **getApiKey**: Renamed to `getEnvApiKey`. Only checks environment variables for known providers.

## [0.27.7] - 2025-12-24

### Fixed

- **Thinking tag leakage**: Fixed Claude mimicking literal `</thinking>` tags in responses. Unsigned thinking blocks (from aborted streams) are now converted to plain text without `<thinking>` tags. The TUI still displays them as thinking blocks. ([#302](https://github.com/badlogic/pi-mono/pull/302) by [@nicobailon](https://github.com/nicobailon))

## [0.25.1] - 2025-12-21

### Added

- **xhigh thinking level support**: Added `supportsXhigh()` function to check if a model supports xhigh reasoning level. Also clamps xhigh to high for OpenAI models that don't support it. ([#236](https://github.com/badlogic/pi-mono/pull/236) by [@theBucky](https://github.com/theBucky))

### Fixed

- **Gemini multimodal tool results**: Fixed images in tool results causing flaky/broken responses with Gemini models. For Gemini 3, images are now nested inside `functionResponse.parts` per the [docs](https://ai.google.dev/gemini-api/docs/function-calling#multimodal). For older models (which don't support multimodal function responses), images are sent in a separate user message.
- **Queued message steering**: When `getQueuedMessages` is provided, the agent loop now checks for queued user messages after each tool call and skips remaining tool calls in the current assistant message when a queued message arrives (emitting error tool results).
- **Double API version path in Google provider URL**: Fixed Gemini API calls returning 404 after baseUrl support was added. The SDK was appending its default apiVersion to baseUrl which already included the version path. ([#251](https://github.com/badlogic/pi-mono/pull/251) by [@shellfyred](https://github.com/shellfyred))
- **Anthropic SDK retries disabled**: Re-enabled SDK-level retries (default 2) for transient HTTP failures. ([#252](https://github.com/badlogic/pi-mono/issues/252))

## [0.23.5] - 2025-12-19

### Added

- **Gemini 3 Flash thinking support**: Extended thinking level support for Gemini 3 Flash models (MINIMAL, LOW, MEDIUM, HIGH) to match Pro models' capabilities. ([#212](https://github.com/badlogic/pi-mono/pull/212) by [@markusylisiurunen](https://github.com/markusylisiurunen))
- **GitHub Copilot thinking models**: Added thinking support for additional Copilot models (o3-mini, o1-mini, o1-preview). ([#234](https://github.com/badlogic/pi-mono/pull/234) by [@aadishv](https://github.com/aadishv))

### Fixed

- **Gemini tool result format**: Fixed tool result format for Gemini 3 Flash Preview which strictly requires `{ output: value }` for success and `{ error: value }` for errors. Previous format using `{ result, isError }` was rejected by newer Gemini models. Also improved type safety by removing `as any` casts. ([#213](https://github.com/badlogic/pi-mono/issues/213), [#220](https://github.com/badlogic/pi-mono/pull/220))
- **Google baseUrl configuration**: Google provider now respects `baseUrl` configuration for custom endpoints or API proxies. ([#216](https://github.com/badlogic/pi-mono/issues/216), [#221](https://github.com/badlogic/pi-mono/pull/221) by [@theBucky](https://github.com/theBucky))
- **GitHub Copilot vision requests**: Added `Copilot-Vision-Request` header when sending images to GitHub Copilot models. ([#222](https://github.com/badlogic/pi-mono/issues/222))
- **GitHub Copilot X-Initiator header**: Fixed X-Initiator logic to check last message role instead of any message in history. This ensures proper billing when users send follow-up messages. ([#209](https://github.com/badlogic/pi-mono/issues/209))

## [0.22.3] - 2025-12-16

### Added

- **Image limits test suite**: Added comprehensive tests for provider-specific image limitations (max images, max size, max dimensions). Discovered actual limits: Anthropic (100 images, 5MB, 8000px), OpenAI (500 images, ≥25MB), Gemini (~2500 images, ≥40MB), Mistral (8 images, ~15MB), OpenRouter (~40 images context-limited, ~15MB). ([#120](https://github.com/badlogic/pi-mono/pull/120))
- **Tool result streaming**: Added `tool_execution_update` event and optional `onUpdate` callback to `AgentTool.execute()` for streaming tool output during execution. Tools can now emit partial results (e.g., bash stdout) that are forwarded to subscribers. ([#44](https://github.com/badlogic/pi-mono/issues/44))
- **X-Initiator header for GitHub Copilot**: Added X-Initiator header handling for GitHub Copilot provider to ensure correct call accounting (agent calls are not deducted from quota). Sets initiator based on last message role. ([#200](https://github.com/badlogic/pi-mono/pull/200) by [@kim0](https://github.com/kim0))

### Changed

- **Normalized tool_execution_end result**: `tool_execution_end` event now always contains `AgentToolResult` (no longer `AgentToolResult | string`). Errors are wrapped in the standard result format.

### Fixed

- **Reasoning disabled by default**: When `reasoning` option is not specified, thinking is now explicitly disabled for all providers. Previously, some providers like Gemini with "dynamic thinking" would use their default (thinking ON), causing unexpected token usage. This was the original intended behavior. ([#180](https://github.com/badlogic/pi-mono/pull/180) by [@markusylisiurunen](https://github.com/markusylisiurunen))

## [0.22.2] - 2025-12-15

### Added

- **Interleaved thinking for Anthropic**: Added `interleavedThinking` option to `AnthropicOptions`. When enabled, Claude 4 models can think between tool calls and reason after receiving tool results. Enabled by default (no extra token cost, just unlocks the capability). Set `interleavedThinking: false` to disable.

## [0.22.1] - 2025-12-15

_Dedicated to Peter's shoulder ([@steipete](https://twitter.com/steipete))_

### Added

- **Interleaved thinking for Anthropic**: Enabled interleaved thinking in the Anthropic provider, allowing Claude models to output thinking blocks interspersed with text responses.

## [0.22.0] - 2025-12-15

### Added

- **GitHub Copilot provider**: Added `github-copilot` as a known provider with models sourced from models.dev. Includes Claude, GPT, Gemini, Grok, and other models available through GitHub Copilot. ([#191](https://github.com/badlogic/pi-mono/pull/191) by [@cau1k](https://github.com/cau1k))

### Fixed

- **GitHub Copilot gpt-5 models**: Fixed API selection for gpt-5 models to use `openai-responses` instead of `openai-completions` (gpt-5 models are not accessible via completions endpoint)
- **GitHub Copilot cross-model context handoff**: Fixed context handoff failing when switching between GitHub Copilot models using different APIs (e.g., gpt-5 to claude-sonnet-4). Tool call IDs from OpenAI Responses API were incompatible with other models. ([#198](https://github.com/badlogic/pi-mono/issues/198))
- **Gemini 3 Pro thinking levels**: Thinking level configuration now works correctly for Gemini 3 Pro models. Previously all levels mapped to -1 (minimal thinking). Now LOW/MEDIUM/HIGH properly control test-time computation. ([#176](https://github.com/badlogic/pi-mono/pull/176) by [@markusylisiurunen](https://github.com/markusylisiurunen))

## [0.18.2] - 2025-12-11

### Changed

- **Anthropic SDK retries disabled**: Set `maxRetries: 0` on Anthropic client to allow application-level retry handling. The SDK's built-in retries were interfering with coding-agent's retry logic. ([#157](https://github.com/badlogic/pi-mono/issues/157))

## [0.18.1] - 2025-12-10

### Added

- **Mistral provider**: Added support for Mistral AI models via the OpenAI-compatible API. Includes automatic handling of Mistral-specific requirements (tool call ID format). Set `MISTRAL_API_KEY` environment variable to use.

### Fixed

- Fixed Mistral 400 errors after aborted assistant messages by skipping empty assistant messages (no content, no tool calls) ([#165](https://github.com/badlogic/pi-mono/issues/165))
- Removed synthetic assistant bridge message after tool results for Mistral (no longer required as of Dec 2025) ([#165](https://github.com/badlogic/pi-mono/issues/165))
- Fixed bug where `ANTHROPIC_API_KEY` environment variable was deleted globally after first OAuth token usage, causing subsequent prompts to fail ([#164](https://github.com/badlogic/pi-mono/pull/164))

## [0.17.0] - 2025-12-09

### Added

- **`agentLoopContinue` function**: Continue an agent loop from existing context without adding a new user message. Validates that the last message is `user` or `toolResult`. Useful for retry after context overflow or resuming from manually-added tool results.
- Added `validateToolCall(tools, toolCall)` helper that finds the tool by name and validates arguments.
- **OpenAI compatibility overrides**: Added `compat` field to `Model` for `openai-completions` API, allowing explicit configuration of provider quirks (`supportsStore`, `supportsDeveloperRole`, `supportsReasoningEffort`, `maxTokensField`). Falls back to URL-based detection if not set. Useful for LiteLLM, custom proxies, and other non-standard endpoints. ([#133](https://github.com/badlogic/pi-mono/issues/133), thanks @fink-andreas for the initial idea and PR)
- **xhigh reasoning level**: Added `xhigh` to `ReasoningEffort` type for OpenAI codex-max models. For non-OpenAI providers (Anthropic, Google), `xhigh` is automatically mapped to `high`. ([#143](https://github.com/badlogic/pi-mono/issues/143))

### Breaking Changes

- Removed provider-level tool argument validation. Validation now happens in `agentLoop` via `executeToolCalls`, allowing models to retry on validation errors. For manual tool execution, use `validateToolCall(tools, toolCall)` or `validateToolArguments(tool, toolCall)`.

### Changed

- **Updated SDK versions**: OpenAI SDK 5.21.0 → 6.10.0, Anthropic SDK 0.61.0 → 0.71.2, Google GenAI SDK 1.30.0 → 1.31.0

## [0.13.0] - 2025-12-06

### Breaking Changes

- **Added `totalTokens` field to `Usage` type**: All code that constructs `Usage` objects must now include the `totalTokens` field. This field represents the total tokens processed by the LLM (input + output + cache). For OpenAI and Google, this uses native API values (`total_tokens`, `totalTokenCount`). For Anthropic, it's computed as `input + output + cacheRead + cacheWrite`.

## [0.12.10] - 2025-12-04

### Added

- Added `gpt-5.1-codex-max` model support

### Fixed

- **OpenAI Token Counting**: Fixed `usage.input` to exclude cached tokens for OpenAI providers. Previously, `input` included cached tokens, causing double-counting when calculating total context size via `input + cacheRead`. Now `input` represents non-cached input tokens across all providers, making `input + output + cacheRead + cacheWrite` the correct formula for total context size.
- **Fixed Claude Opus 4.5 cache pricing** (was 3x too expensive)
  - Corrected cache_read: $1.50 → $0.50 per MTok
  - Corrected cache_write: $18.75 → $6.25 per MTok
  - Added manual override in `scripts/generate-models.ts` until upstream fix is merged
  - Submitted PR to models.dev: https://github.com/sst/models.dev/pull/439

## [0.9.4] - 2025-11-26

Initial release with multi-provider LLM support.
