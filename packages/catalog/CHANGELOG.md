# Changelog

## [Unreleased]

## [18.1.3] - 2026-09-02

### Added

- Added support for Claude Fable 5.1

### Changed

- Updated pricing and context limits for various Claude models

### Fixed

- Claude Sonnet 5 no longer advertises unsupported mid-conversation system messages.
- Custom GLM 5.2 models on `alibaba-coding-plan` (and other blanket-GLM hosts) no longer crash startup with `AmbiguousOverlapError` ([#10553](https://github.com/can1357/oh-my-pi/issues/10553)).
- Gemini 3.7 Flash no longer offers the `minimal` thinking effort on direct google-level hosts (`google`, `google-vertex`, `opencode-zen`), which reject `thinkingLevel: MINIMAL` with a 400; budget and reasoning-effort resellers keep the tier ([#10543](https://github.com/can1357/oh-my-pi/issues/10543)).
- Fixed Alibaba Token Plan discovery for `qwen3.8-flash` to include its context limits, reasoning support, and image input.
- Z.AI GLM-5.3-Flash now uses the native API instead of failing through the unsupported Anthropic-compatible route ([#10539](https://github.com/can1357/oh-my-pi/issues/10539)).

## [18.1.2] - 2026-09-01

### Added

- Added support for turn-scoped system messages, changing tools during a conversation, and setting effort on individual messages.
- Added support for Claude Fable 5.1 models, with improved thinking-prefix handling across supported Claude models.
- Added DeepSeek V4 Flash Vision Exp, Mercury 2.5 Preview, and Xiaomi MiMo V2.5 Pro UltraSpeed models.

### Changed

- Updated model pricing and context-window limits.

## [18.1.0] - 2026-09-01

### Added

- Added GitLab Duo model support.
- Added provider support for Llama.cpp, LM Studio, and Minimax.
- Added catalog entries for Qwen 3.8 27B, Granite 4.2 8B, Abliterated variants, GLM 5.3, and Qwen 3.8 Flash Next.
- Added compatibility metadata for context management and reasoning summaries on supported provider-compatible model endpoints.
- Added the native ClinePass provider with live model discovery, subscription and free-tier model listings, current limits and pricing, model modalities, and per-model reasoning controls. Subscription models display API-equivalent pricing while free-tier models display as free.
- Added native Devin provider discovery with current Cascade model capabilities, pricing, limits, reasoning controls, selector aliases, and model descriptions and recommendation/beta metadata. Added static SWE-1.6 defaults so the provider can resolve a default model before account-scoped discovery completes.
- Added per-tier model pricing and long-context pricing support, along with expanded catalog metadata for model limits, API routes, input modalities, and provider-specific model aliases.

### Changed

- Updated pricing data across the catalog to reflect current provider rates.
- Standardized model display names for greater consistency.
- Improved model compatibility classification and variant selection using structured model identities, providing more reliable detection of model families, revisions, reasoning variants, and provider-specific capabilities.

### Fixed

- Fixed compatibility detection for vendor-prefixed GLM models on Mistral and Cerebras, restoring the appropriate tokenizer and reasoning-history behavior.
- Removed an obsolete OpenCode provider entry that exposed unavailable Zen models in the model picker.
- Fixed model revision detection for parameterized model IDs, including correct classification of Qwen, Fireworks Kimi, and Cursor-wrapped Grok models.
- Fixed Kimi K3 reasoning-effort handling on OpenAI-compatible hosts such as LiteLLM and vLLM.
- Fixed pricing for Codex Daybreak aliases, including worker variants.
- Fixed reasoning-effort variants for local Ollama models and DeepSeek V4, and corrected prompt-cache support for applicable Bedrock Nova deployments.
- Fixed Devin model variants with separate thinking and context-size options so all supported routing combinations and context limits are preserved.
- Corrected Devin SWE-1.6 and SWE-1.6 Fast capability metadata so image attachments use the appropriate text-only fallback instead of being silently discarded.
- Devin discovery now warns when the service returns an empty native model catalog, helping identify stale or incompatible CLI credentials.

### Removed

- Removed legacy DeepSeek V3 variants from the Novita catalog.

## [18.0.11] - 2026-08-29

### Fixed

- Fixed Baseten GLM models, including GLM-5.3-Flash, being incorrectly classified as non-reasoning models.
- Fixed Cloudflare AI Gateway catalog refreshes so active Workers AI chat models, including newly released models, are discovered correctly.
- Fixed Cursor Kimi K3, Grok 4, and Composer 2.5 models being incorrectly treated as text-only when they support image attachments.
- Fixed OpenRouter routed model variants, including GLM-5.3 and dated DeepSeek V4 Pro, so their reasoning effort options are preserved correctly.
- Fixed MiniMax-M3 max output regressing to the upstream 512K pricing-tier boundary; all MiniMax providers keep the documented 128K output cap.
- Fixed GLM-5.3-Flash bundling the 50%-off launch promotion price; the catalog stays on the documented list price.
- Fixed Synthetic model discovery re-adding image input from the bundled reference when the route advertises text-only modalities.

## [18.0.9] - 2026-08-28

### Added

- Added Z.AI GLM-5.3-Flash to the bundled GLM Coding Plan catalog, with a 1M-token context window, 131,072-token output limit, native image input, and low/high/max thinking levels. It is now available through model discovery and the model picker.

### Fixed

- Fixed Google Antigravity Gemini 3.7 Flash tiered models failing with HTTP 400 errors at minimal or disabled thinking levels; those tiers now use the compatible Gemini 3.7 Flash model routing.
- Fixed OpenCode Go and Zen GLM-5.3 Flash models exposing an unsupported extra-high reasoning level; they now use the supported low/high/max reasoning levels.
- Fixed Cloudflare AI Gateway credential handling so stored credentials and routing metadata are parsed and used correctly.

## [18.0.8] - 2026-08-27

### Fixed

- Fixed the thinking control mode for OpenAI models served over Bedrock Converse (`global.openai.gpt-5.6-luna`, `-sol`, `-terra`), which are now classified as `effort` rather than `budget` so requests use OpenAI's reasoning schema.
- Fixed LiteLLM discovery leaking a colliding bundled model's provider-specific transport onto custom endpoints: a discovered alias (e.g. `kimi-k3`) matching a bundled Fireworks model no longer inherits that model's wire-id transform, which had caused requests to POST a model id the endpoint never advertised and return HTTP 400 ([#9938](https://github.com/can1357/oh-my-pi/issues/9938)).

## [18.0.7] - 2026-08-26

### Added

- Added cached background refresh from the shared models.dev catalog so newly published models for known providers can appear without a new OMP release, while bundled models remain the offline fallback.

### Fixed

- Fixed LiteLLM model discovery so model pricing is correctly populated when pricing information is provided by a later metadata endpoint.

## [18.0.5] - 2026-08-25

### Added

- Added built-in DeepInfra provider support (`deepinfra`, `DEEPINFRA_API_KEY`) with live model discovery, including chat models, context windows, pricing, cache-read pricing, vision input, and reasoning-effort capabilities.
- Added built-in Yolo-Auto provider support with the flat-rate `deepseek-flash-v4` model and live model discovery.

### Fixed

- Fixed the Synthetic provider’s default model to use `hf:zai-org/GLM-5.2` instead of the retired `hf:zai-org/GLM-5.1`.

## [18.0.4] - 2026-08-24

### Fixed

- Fixed default reasoning effort for `cursor/cursor-grok-4.5` and `cursor/cursor-grok-4.6` so requests without an explicit effort setting default to `-medium` instead of `-low`, preventing rate limit rejections on Cursor's Start plan ([#9478](https://github.com/can1357/oh-my-pi/issues/9478)).
- Fixed aliased OpenCode Zen Ox Alpha models exposing incorrect effort levels, ensuring the gateway's native `low`, `high`, and `max` tiers are correctly mapped and reachable ([#9349](https://github.com/can1357/oh-my-pi/issues/9349)).
- Fixed missing rate card tier for public xAI and SuperGrok models with prompt lengths exceeding 200K tokens ([#9512](https://github.com/can1357/oh-my-pi/issues/9512)).

## [18.0.2] - 2026-08-23

### Fixed

- Fixed OpenRouter auxiliary requests (e.g. session-title generation) failing with `400 Reasoning is mandatory for this endpoint and cannot be disabled` on mandatory-reasoning models such as `stealth/ox-alpha`. Live discovery now honors the endpoint's `reasoning.mandatory` flag, clamping thinking-off to the lowest supported effort instead of sending `reasoning: { enabled: false }` ([#9415](https://github.com/can1357/oh-my-pi/issues/9415)).

## [18.0.1] - 2026-08-23

### Added

- Fixed `google-gemini-cli` model refresh returning only bundled models for Gemini Code Assist Standard accounts, whose credential is not authorized for the Antigravity `fetchAvailableModels` endpoint (HTTP 403). Discovery now falls back to the account's own `retrieveUserQuota` list on Cloud Code Assist, surfacing models such as `gemini-3.5-flash` ([#9315](https://github.com/can1357/oh-my-pi/issues/9315)).
- Added Amazon Bedrock guardrail metadata to model definitions for Converse requests.

### Fixed

- Fixed `opencode-go/ox-alpha-free` sending `reasoning_effort: "xhigh"` for the top thinking tier, which the OpenCode Go gateway rejects; the model now uses the gateway's wire-exact `low`/`high`/`max` ladder with mandatory thinking so `--thinking max` reaches the real max tier ([#9349](https://github.com/can1357/oh-my-pi/issues/9349)).
- Fixed Venice-hosted Qwen models (e.g. `venice/qwen3-6-35b-a3b`) failing with `400 Invalid request parameters`. Reasoning levels now use the accepted OpenAI-style `reasoning_effort` field, while Thinking Off sends Venice's explicit `venice_parameters.disable_thinking` flag ([#9345](https://github.com/can1357/oh-my-pi/issues/9345)).
- Fixed gateway-first OpenCode Zen and Go models missing context, output, image, and reasoning metadata by enriching live discovery from the current stencil catalog ([#9272](https://github.com/can1357/oh-my-pi/issues/9272)).
- Fixed `opencode-go/deepseek-v4-flash` exposing the generic `minimal`/`low`/`medium`/`high`/`xhigh` thinking ladder instead of DeepSeek V4's real `low`/`high`/`max` tiers. The model is pinned to the Responses transport (the Go gateway serves it only at `/responses`), which the DeepSeek effort branch did not admit, so it fell through to the default ladder; the branch now covers the `openai-responses` transport like every other host ([#9134](https://github.com/can1357/oh-my-pi/issues/9134)).
- Fixed protobuf map decoding corrupting entries when a key is `__proto__`, which dropped that argument and replayed spurious numeric arguments ([#9394](https://github.com/can1357/oh-my-pi/issues/9394)).

## [18.0.0] - 2026-08-22

### Added

- Added model capability metadata for reversible private-use glyph tokenization on Claude-compatible models, so provider request handling can apply the compatibility layer without inferring from transport details.

## [17.4.2] - 2026-08-21

### Added

- Added identification of provider-side image fetchers (OpenAI, Anthropic, xAI, Google), so a server hosting images by URL can attribute an inbound fetch to the vendor that issued it.

### Fixed

- Fixed Cursor model discovery showing separate picker rows for pure effort-suffixed models beyond GPT-5.6 by collapsing each standard and Fast lane into one reasoning-effort model ([#9237](https://github.com/can1357/oh-my-pi/issues/9237)).

## [17.4.1] - 2026-08-21

### Added

- Added helper functions and constants for reading enterprise ChatGPT workspace data-residency regions from Codex OAuth access tokens and forwarding the residency header to Codex backend endpoints.

### Changed

- Preserved API-advertised `tool_mode` metadata (such as `code_mode_only` for GPT-5.6 Code Mode models) on Codex catalog models and types ([#9069](https://github.com/can1357/oh-my-pi/pull/9069)).
- Added an optional `tokenizer` family field across bundled, discovered, and custom catalog models (`claude-v3`/`v47`/`v5`, Qwen 3.5+, DeepSeek V3/V4/R1, Kimi K2/K3, and GLM-5+), which can also be explicitly overridden in model configuration.
- Updated subscription Codex GPT-5.6 Sol, Terra, and Luna models to include first-party `cost.longContext` pricing tiers for token inputs exceeding 272K tokens.

### Fixed

- Fixed Vercel AI Gateway Muse Spark 1.2 Contributor requests failing with HTTP 400 errors by capping advertised output allowances to the model's 131K limit.
- Fixed LiteLLM model discovery to route OpenAI models through the Responses API for reasoning summaries in thinking blocks ([#9085](https://github.com/can1357/oh-my-pi/pull/9085)).
- Fixed OpenCode Console Go and Zen Responses providers rejecting forced tool choices by automatically downgrading forced or named tool selections to `auto`.
- Fixed OpenCode Go Muse Spark 1.2 and Muse Spark 1.2 Contributor models failing during tool calls or missing reasoning effort levels, ensuring they correctly route to the Responses API with full thinking, context, and multimodal support ([#8957](https://github.com/can1357/oh-my-pi/issues/8957)).
- Improved OpenCode gateway model discovery to automatically infer the Responses API route for unlisted models from sibling gateways and billing base variants.
- Fixed Cursor GPT-5.6 (Luna, Sol, and Terra) model discovery creating duplicate rows for each thinking tier by collapsing tiers into unified models with configurable reasoning effort ([#9025](https://github.com/can1357/oh-my-pi/issues/9025)).
- Fixed Google Gemini CLI model discovery failing with `403 PERMISSION_DENIED` by directing catalog refresh requests to the appropriate Antigravity discovery endpoints ([#8885](https://github.com/can1357/oh-my-pi/issues/8885)).

## [17.4.0] - 2026-08-20

### Added

- Models now include an optional `tokenizer` family field across bundled, discovered, and custom models (supporting Claude, Qwen, DeepSeek, Kimi, and GLM families), with support for explicit overrides in model configuration.
- Added long-context cost tiers (`cost.longContext`) to subscription Codex GPT-5.6 models (Sol, Terra, Luna) matching first-party API pricing above 272K input tokens.

### Changed

- Bundled model metadata is prebuilt during generation, reducing catalog startup work.

### Fixed

- Fixed tool-call turn failures for `opencode-go/muse-spark-1.2` and related variants by ensuring API transport pins apply to live discovery and automatically inferring response routes for gateway-first OpenCode models ([#8957](https://github.com/can1357/oh-my-pi/issues/8957)).

## [17.3.8] - 2026-08-19

### Added

- Added a Cursor variant-collapse table folding the per-effort Grok siblings (`cursor-grok-4.5` low/medium/high and `cursor-grok-4.6` low/medium/high/xhigh, plus their `-fast` service-tier lanes) into one logical model per lane with effort routing onto the live wire ids, matching Devin's `grok-4-5` collapse ([#8803](https://github.com/can1357/oh-my-pi/issues/8803)).
- Regenerated the Cursor agent protobufs to model hosted WebFetch permission queries (`interaction_query` / `interaction_response` field 9) and the matching `ToolCall` variant (field 37).

### Fixed

- Fixed a physically corrupt `models.db` (`SQLITE_CORRUPT*` / `SQLITE_NOTADB`, "database disk image is malformed") permanently disabling the model cache. The shared read/write paths swallowed unrecoverable SQLite corruption as a best-effort miss and cached the broken handle, so a successful live catalog could never overwrite the corrupt cache and every later process repeated the miss — a runtime provider extension with no bundled catalog was left with only its bootstrap model. Corruption now self-heals: the cache closes the handle, quarantines `models.db`(+`-wal`/`-shm`) aside, recreates a fresh database, and retries the operation once; `SQLITE_BUSY`, permission, and unrelated errors keep their existing best-effort paths ([#8867](https://github.com/can1357/oh-my-pi/issues/8867)).
- Fixed local Qwen 3.8+ models (llama.cpp, vLLM, loopback custom providers) exposing the generic `minimal..high` thinking ladder instead of the chat template's real `low`/`medium`/`xhigh` `reasoning_effort` tiers. The derived metadata now marks thinking as mandatory (the official 3.8 template raises on `enable_thinking: false`), vLLM-served Qwen routes through the `chat_template_kwargs` dialect (top-level `enable_thinking` is ignored by vLLM), and vLLM discovery lights up the reasoning dial for Qwen 3.8+ ids its `/v1/models` endpoint reports as non-reasoning.
- Fixed `deepseek-v4-pro-0813` surfacing from Alibaba Token Plan discovery with `contextWindow`/`maxTokens` of `null`. The dated DeepSeek V4 Pro snapshot was missing from `ALIBABA_TOKEN_PLAN_DISCOVERED_MODEL_LIMITS`, so unlike its `deepseek-v4-flash-0731` sibling it fell through to unknown limits ([#8847](https://github.com/can1357/oh-my-pi/issues/8847)).
- Cloud Code Assist Gemini 3.6/3.7 Flash no longer maps user `minimal` to wire `thinkingLevel: MINIMAL` when that effort is aliased onto the `-low` SKU. The request now sends `LOW`, which those SKUs accept.
- Fixed SuperGrok (`xai-oauth`) Grok 4.6 hiding the thinking-level picker: the Responses effort-capable allowlist now includes `grok-4.6`, so `/model` can select the documented `low`/`medium`/`high`/`xhigh` ladder (`max` is rejected by api.x.ai).
- Marked CoreWeave runtime discovery as authoritative so stale bundled model ids that the endpoint no longer serves stop appearing as selectable models.
- ChatGPT Codex discovery that advertises only worker `-wm` SKUs now also registers the plain model route, so a configured `openai-codex/<model>` keeps resolving instead of fuzzy-falling-back to the `-wm` SKU some accounts reject.
- Fixed `opencode-go/muse-spark-1.2` (and `muse-spark-1.2-contributor`) failing every tool-call turn with `OpenAI completions stream closed before a finish_reason was received`. The Go gateway serves these ids only at `/zen/go/v1/responses`, but the `/zen/go/v1/models` discovery omits the `provider.npm` hint, so the resolver fell through to `openai-completions`; both ids are now pinned to `openai-responses` like `deepseek-v4-flash` ([#8957](https://github.com/can1357/oh-my-pi/issues/8957)).
- Fixed GitHub Copilot `grok-4.6` / `grok-4.6-1m` failing with HTTP 400 `unsupported_api_for_model` by routing them through the OpenAI Responses API (`/responses`) instead of `/chat/completions`, matching `grok-4.5`. Stale cached completion routes are invalidated on refresh ([#8807](https://github.com/can1357/oh-my-pi/issues/8807)).
- Fixed Cursor Grok 4.5/4.6 discovery classifying the versioned ids as non-reasoning: `GetUsableModels` ships no `thinkingDetails` and the bundled references read `reasoning: false`, so the picker hid the effort ladder. Discovery now marks `cursor-grok-<version>` ids as reasoning models (the non-reasoning `grok-code-*` ids stay out) ([#8803](https://github.com/can1357/oh-my-pi/issues/8803)).
- Fixed GMI Cloud (`gmi-cloud`) models resolved via `/v1/models` discovery surfacing with `null` context windows, zero pricing, and no reasoning/thinking metadata for every model except the bundled `deepseek-ai/DeepSeek-V4-Flash` seed. GMI's endpoint returns only bare `{id}` rows, so the mapper now recovers intrinsic capability metadata (context window, output limit, reasoning, thinking ladder) for resold open-weight models from the cross-provider canonical reference index — matching the SiliconFlow behavior — while never borrowing another provider's pricing ([#8890](https://github.com/can1357/oh-my-pi/issues/8890)).

## [17.3.6] - 2026-08-17

### Changed

- Changed the paid xAI (XAI_API_KEY) and SuperGrok (xai-oauth) default models to grok-4.6.

### Fixed

- Raised the GPT-5.6 Sol/Terra/Luna context window on the Codex transport (openai-codex) from 372K to 1M tokens: OpenAI enabled the 1M window for subscription Codex on 2026-08-16, but the Codex model registry still reports the stale 272,000, so discovery now floors these SKUs at 1,000,000 instead of trusting the reported value ([openai/codex#38917](https://github.com/openai/codex/issues/38917)).

## [17.3.5] - 2026-08-16

### Added

- Added support for GLM-5.3 on the z.AI provider, featuring a unified low/high/max reasoning-effort ladder across all hosts, mandatory thinking mode, 1M context, and default-model status for the z.AI provider.

### Changed

- Switched the paid xAI provider (xai / XAI_API_KEY) from Chat Completions to the OpenAI Responses API, aligning it with SuperGrok (xai-oauth) for prompt-cache affinity, reasoning-effort handling, and encrypted-reasoning replay.
- Changed the paid xAI (XAI_API_KEY) default model to grok-4.5.
- Changed the SuperGrok (xai-oauth) default model to grok-4.5.
- Improved reasoning continuity for xAI models by requesting and replaying encrypted reasoning content across multi-turn Responses API calls.

### Fixed

- Fixed Codex Daybreak Blue and Red model discovery reporting zero token prices, which incorrectly labeled the models as free in the model picker.
- Fixed Baseten's moonshotai/Kimi-K3 catalog metadata so its low/high/max thinking levels are available.
- Fixed opencode-go/deepseek-v4-flash Responses requests sending forced named tool_choice selectors that are rejected while thinking mode is active.

## [17.3.4] - 2026-08-14

### Added

- Added wire constants for Codex V2 remote-compaction feature negotiation.

### Fixed

- Fixed raw `COPILOT_GITHUB_TOKEN` credentials skipping plan-specific endpoint discovery, which routed GitHub Copilot Business model requests to the personal endpoint and returned HTTP 403. The GitHub Copilot model cache is now scoped per credential, so switching the token no longer serves another account's stale endpoint for the cache TTL ([#8507](https://github.com/can1357/oh-my-pi/issues/8507)).
- Fixed the OpenRouter `deepseek/deepseek-v4-pro-0813` route silently clamping the reasoning effort to `high`: the dated SKU advertises (and accepts) the wire-exact `low`/`high`/`max` ladder, so its effort override no longer collapses to `high`-only. The undated `deepseek/deepseek-v4-pro` OpenRouter route stays `high`-only. ([#8517](https://github.com/can1357/oh-my-pi/issues/8517))

## [17.3.2] - 2026-08-13

### Added

- Added support for the `deepseek-v4-pro:preview` model
- Added support for the `gemini-3.7-flash` model
- Added dynamic Antigravity client-version discovery from the official update manifest (darwin/arm64 channel), so version-gated models appear without a code change; `PI_AI_ANTIGRAVITY_VERSION` remains available as an override.

### Fixed

- Fixed Antigravity discovery missing Gemini 3.7 Flash: Cloud Code Assist gates newer models on the client version in the `User-Agent`, and the pinned `antigravity/hub/2.1.4` was too old. The user-agent now matches the captured 2.8.0 client format (`antigravity/hub/2.8.0 (aidev_client; os_type=darwin; arch=arm64; cl=963137146)`); os_type/arch stay pinned to the darwin/arm64 reference client. Overridable via `PI_AI_ANTIGRAVITY_VERSION` / `PI_AI_ANTIGRAVITY_CL` / `PI_AI_ANTIGRAVITY_OS` / `PI_AI_ANTIGRAVITY_ARCH`.

### Removed

- Removed `ANTIGRAVITY_SYSTEM_INSTRUCTION` from `wire/gemini-headers`; the Antigravity transport and web search no longer inject a fake identity prompt.

## [17.3.1] - 2026-08-13

### Added

- Added dynamic Antigravity and Gemini CLI discovery support for Gemini 3.7 Flash, with low/medium/high thinking-level routing.

### Changed

- Updated model metadata, context windows, pricing, and configurations in the catalog

## [17.3.0] - 2026-08-13

### Breaking Changes

- Removed `OpenAICompat.enableGeminiThinkingLoopGuard`; thinking-loop eligibility is derived solely from the `model.id` family.

### Added

- Added first-party OpenAI Daybreak Blue, Daybreak Red, and GPT-5.6 Cyber models with full support for their documented API pricing (including long-context rates above 272K input), token limits, tools, and reasoning effort controls (off/low/medium/high/xhigh/max).
- Added calculateUncachedInputCost() to calculate prompt pricing against active context-length tiers without prompt caching.

### Fixed

- Fixed Anthropic cache-write pricing to correctly honor mixed 5-minute and 1-hour TTL usage instead of incorrectly charging all writes at the 5-minute rate.
- Fixed Ollama Cloud DeepSeek V4 Flash and older reasoners to correctly apply the DeepSeek effort contract (e.g., low/high/max) instead of the generic effort ladder.
- Added a default request timeout to OpenAI-compatible model discovery to prevent stalled provider endpoints from hanging startup indefinitely.
- Fixed Anthropic cache-write pricing to honor mixed 5-minute and 1-hour TTL usage instead of charging every write at the 5-minute rate.
- Fixed Ollama Cloud DeepSeek V4 Flash (including dated/preview tags like `deepseek-v4-flash:0731`) exposing the generic `minimal`/`low`/`medium`/`high`/`xhigh` effort ladder without `max`; the `ollama-chat` transport now applies the DeepSeek effort contract (Flash → `low`/`high`/`max`, older reasoners → `high`/`max`), matching the direct API and every other host ([#8334](https://github.com/can1357/oh-my-pi/issues/8334)).
- Exposed the `low` reasoning-effort tier for DeepSeek V4 Pro on the direct API and faithful aggregator routes, matching DeepSeek's updated API contract advertising `reasoning_effort` `low`/`high`/`max` for both V4 SKUs; OpenRouter's non-Flash route still exposes only `high`, and the older V3.x/R1 reasoners remain `high`/`max` ([#8405](https://github.com/can1357/oh-my-pi/issues/8405)).
- Bounded OpenAI-compatible model discovery with a default request timeout so a stalled provider `/models` endpoint can no longer hang startup indefinitely in `resolveModelDiscoveryFallback` ([#8315](https://github.com/can1357/oh-my-pi/issues/8315)).
- Fixed Codex-discovered `gpt-daybreak-*` aliases being treated as unknown models, restoring the GPT-5.6 `low`/`medium`/`high`/`xhigh`/`max` effort ladder and its 372K fallback only when the Codex registry omits `context_window`.
- Fixed first-party OpenAI GPT-5.6 aliases to preserve wire-level `off` through generated pro aliases and to price requests above 272K input at each SKU's documented long-context rates.

## [17.2.15] - 2026-08-12

### Fixed

- Fixed classification of model IDs with large minor versions (e.g., `claude-opus-5-11`) or three-part versions, ensuring they no longer fall back to stale default configurations.

## [17.2.13] - 2026-08-11

### Changed

- Standardized catalog discovery User-Agent headers on `omp/<version>` via the shared `USER_AGENT` utility.

### Fixed

- Marked `meta/muse-spark-1.2` and `muse-spark-1.2-contributor` as image-capable (`input: ["text", "image"]`) with the same Responses reasoning, thinking, and cost metadata as `muse-spark-1.1` (contributor uses its discounted 0.1/0.2 pricing), so `omp models` no longer lists them as text-only.
- Fixed GLM-5.2 thinking levels across Baseten, CoreWeave, HuggingFace, and other uppercase-ID resellers, which were getting the generic `xhigh` effort ladder instead of the GLM-5.2-specific tiers. Also added Baseten `zai-org/GLM-5.2-Fast` and Fireworks `glm-5.2-fast` as reasoning models ([#8200](https://github.com/can1357/oh-my-pi/pull/8200) by [@jcfrancisco](https://github.com/jcfrancisco)).

## [17.2.12] - 2026-08-08

### Fixed

- Fixed dynamically discovered `alibaba-token-plan/qwen3.8-max` metadata so thinking controls and image input are available ([#8019](https://github.com/can1357/oh-my-pi/issues/8019)).
- Routed `opencode-go/deepseek-v4-flash` through the OpenAI responses API — the OpenCode Go gateway does not serve this model at `/zen/go/v1/chat/completions`, only at `/zen/go/v1/responses` (`deepseek-v4-pro` keeps chat completions).

## [17.2.11] - 2026-08-07

### Fixed

- Increased the default stream idle-timeout floor on Amazon Bedrock to 900 seconds for reasoning and adaptive-thinking models (such as Claude) to prevent premature watchdog timeouts during long reasoning stretches.
- Fixed Devin model families (including SWE-1.7, Claude 5, Gemini 3.6 Flash, Kimi K3, Grok 4.5, and Inkling) to correctly group as logical models with reasoning-effort routing instead of separate wire variants.
- Added missing context-window and output-token limits for dynamically discovered Alibaba Token Plan models.

## [17.2.10] - 2026-08-06

### Changed

- Removed the zod dependency by migrating GitLab Duo Workflow discovery schemas to omptype.

### Fixed

- Corrected thinking-effort tiers for deepseek-v4-flash to include the low tier alongside high and max.

## [17.2.9] - 2026-08-05

### Fixed

- Fixed Amazon Bedrock catalog generation omitting AWS GovCloud `us-gov.*` Claude inference-profile IDs, so selectors like `amazon-bedrock/us-gov.anthropic.claude-sonnet-4-5-…` resolve instead of failing model lookup (or misrouting commercial `us.*` geos onto `us-east-1` with GovCloud credentials).

## [17.2.7] - 2026-08-03

### Fixed

- Fixed an issue where setting `thinking-level: off` failed to disable reasoning on direct DeepSeek V4 requests.

## [17.2.6] - 2026-08-03

### Added

- Added the `bedrock-mantle` provider with authenticated model discovery for OpenAI GPT-5.4, GPT-5.5, and GPT-5.6 models (including Luna and Terra variants with corrected pricing) served through Amazon Bedrock's Responses endpoint.

### Fixed

- Fixed dynamic discovery for the `deepseek-v4` model family (such as `deepseek-v4-flash-0731`) under `alibaba-token-plan` missing reasoning configuration and maximum thinking effort.
- Fixed GitHub Copilot dynamic discovery retaining stale bundled prices for default-context models instead of using the provider's reported default-tier prices.

## [17.2.5] - 2026-08-03

### Fixed

- Fixed an issue where newly advertised chat models were dropped during dynamic discovery for the `alibaba-token-plan` provider.
- Fixed a `400` error when forcing a specific tool with DeepSeek reasoning models on OpenCode Zen/Go gateways by automatically downgrading the tool selection mode to `auto` while keeping the tool advertised.

## [17.2.4] - 2026-08-01

### Added

- Added `AnthropicCompat.streamIdleTimeoutMs` and propagated it through `buildAnthropicCompat` so direct Anthropic provider streams can configure their inter-event idle watchdog.
- Fixed Ollama Cloud DeepSeek V4 Pro/Flash models (including dated tag variants such as `deepseek-v4-flash:0731`) reporting an incorrect max-output-tokens figure by pinning it to the deployment's enforced 65536-token output ceiling ([#7266](https://github.com/can1357/oh-my-pi/issues/7266)).

### Fixed

- Fixed `gen:models` Codex discovery to union models across every stored OAuth account and fail closed on partial resolution, matching runtime discovery ([#6265](https://github.com/can1357/oh-my-pi/issues/6265)); restored the bundled `gpt-5.4`, `gpt-5.6-sol`, and `gpt-5.3-codex-spark` entries a single-account regen had dropped.
- Fixed `google-antigravity` models always reporting $0 cost: Antigravity discovery carries no pricing, so the generator now back-fills each model with its Google list price (Gemini ids from the `google` provider, including `-preview` id aliases; Claude ids from `google-vertex`, falling back to `anthropic`).
- Fixed OpenRouter `deepseek/deepseek-v4-flash-0731` exposing only `high` thinking effort by consuming the live `reasoning.supported_efforts` and `default_effort` metadata and bundling its `low`/`high`/`max` ladder. ([#7307](https://github.com/can1357/oh-my-pi/issues/7307))

## [17.2.3] - 2026-08-01

### Added

- Added support for the ai& provider (`aiand`), an OpenAI-compatible inference API with dynamic model discovery (context windows, capabilities, reasoning efforts, and USD pricing from `/v1/models`) and API-key authentication via the `AIAND_API_KEY` environment variable.

## [17.2.2] - 2026-07-31

### Added

- Added support for the GMI Cloud provider (`gmi-cloud`), an OpenAI-compatible inference gateway with dynamic model discovery and API-key authentication via the `GMI_API_KEY` environment variable.
- Added optional authoritative context occupancy to usage records for providers with separate checkpoint telemetry and billable token buckets.

### Fixed

- Fixed classification of dynamically discovered Cursor Kimi K3 effort variants as non-reasoning models when `thinkingDetails` is omitted.
- Fixed Google AI Studio OpenAI-compatible requests failing with HTTP 400 by omitting the unsupported `store` field.
- Fixed Synthetic models losing capabilities (such as reasoning/thinking selectors, vision input, output limits, and pricing) by correcting how the discovery mapper parses Synthetic's advertised features, effort vocabularies, and pricing structures.
- Fixed Cursor model discovery to correctly expose the 1M-token context window for supported models (including Claude, GPT, Kimi K3, and GLM 5.2+ families) instead of defaulting to 200k.
- Fixed GitHub Copilot routing for `grok-4.5` to use the correct Responses endpoint instead of the unsupported Chat Completions endpoint.

## [17.2.1] - 2026-07-30

### Fixed

- Fixed Ollama model-manager caches being reused after the configured base URL changed by scoping cache namespaces to the normalized native discovery endpoint, including reverse-proxy path prefixes ([#7087](https://github.com/can1357/oh-my-pi/issues/7087)).

## [17.2.0] - 2026-07-30

### Added

- Regenerated the Cursor agent protobufs (`discovery/cursor-gen/agent_pb.ts`) against the modern `agent.proto`, adding the message and enum families current Cursor CLI builds emit: Pi tool exec frames, hook queries and responses, subagents, allowlist prechecks, MCP state, smart-mode classification, canvas diagnostics, conversation search, agent-store conflicts and git diff. Purely additive — no existing exported symbol changed shape.

### Fixed

- Fixed an issue where LM Studio first turns failed with a 400 Invalid tool_choice error when a named tool was forced, by using the supported tool_choice: "required" string selector.

## [17.1.8] - 2026-07-28

### Added

- Added `resolveVertexEndpointHost(location)` utility to resolve the correct Vertex AI API endpoint hostnames for global, multi-region, and regional locations.

### Fixed

- Fixed an issue where `calculateCost` under-reported Anthropic cache-write costs by honoring the `usage.cttl` breakdown to correctly price 1-hour retention writes at 2x the base input rate.

## [17.1.7] - 2026-07-27

### Added

- Added support for moonshotai/Kimi-K3 and kimi-k3-fast models
- Added umans-kimi-k3 prerelease model configuration

### Changed

- Updated pricing and token limits for selected models

## [17.1.6] - 2026-07-27

### Added

- Added SiliconFlow providers (`siliconflow`, `siliconflow-cn`) with dynamic-only OpenAI-compatible model discovery: no bundled catalog — the model list is fetched live from each region's `/v1/models` endpoint, with non-chat entries (embedding, reranker, image, audio, video) filtered out. Discovery hydrates pricing, context/output limits, and reasoning metadata from the provider's models.dev catalog at runtime (with bundled upstream references as a reasoning-only fallback for ids models.dev has not indexed), so reasoning models keep thinking enabled and sessions compact against real context windows. `SILICONFLOW_API_KEY` / `SILICONFLOW_CN_API_KEY` environment variables are wired into `getEnvApiKey`.

## [17.1.5] - 2026-07-27

### Fixed

- Fixed Kimi Code (`kimi-code`) reporting `maxTokens: 32000` for every model — its `/coding/v1/models` discovery mapper and the bundled catalog applied a blanket constant, truncating `k3`/`k3-256k` output at ~4x below their real 131072 ceiling and `kimi-for-coding`/`kimi-for-coding-highspeed` below their 32768 ceiling. Output caps are now derived per family, and the model cache is invalidated so upgrades drop the stale `maxTokens: 32000` rows (including the discovery-only `k3-256k`) instead of serving them until the next network refresh ([#6711](https://github.com/can1357/oh-my-pi/issues/6711)).
- Fixed Anthropic model discovery 404ing when the registry derived the provider base URL from a bundled model without the `/v1` suffix (`https://api.anthropic.com/models` instead of `/v1/models`), which let a stale text-only cache row shadow fresh models.dev vision metadata — surfacing as snapcompact refusing to run on `claude-opus-5`. Discovery now always targets `/v1/models` while model rows keep the provider base URL ([#6563](https://github.com/can1357/oh-my-pi/issues/6563)).

## [17.1.4] - 2026-07-26

### Added

- Added Claude Opus 5 model entries for Amazon Bedrock: `anthropic.claude-opus-5` plus its `us.`, `eu.`, `au.`, and `global.` regional/geo IDs.

### Fixed

- Fixed `alibaba-token-plan` locking out China (Beijing) 百炼 Token Plan subscribers: the provider hardcoded the international Singapore endpoint, so Beijing-issued `sk-sp-` keys got `401 invalid_api_key`. The wire credential now carries an optional region base URL, and model discovery targets the credential's region ([#6682](https://github.com/can1357/oh-my-pi/issues/6682)).
- Fixed forced `tool_choice` 400s (`tool_choice 'specified' is incompatible with thinking enabled`) on Kimi Code's Anthropic-compatible endpoint for the `kimi-for-coding`, `kimi-for-coding-highspeed`, and `k3` aliases: the Anthropic-surface compat matcher only recognised Moonshot's native `kimi-k2.7-code*` ids, so thinking-locked kimi-code models kept `supportsForcedToolChoice: true` and the forced selector was sent to a host that always thinks. These models now resolve `requiresThinkingEnabled`, keeping thinking on and downgrading forced choices to `auto`.
- Retried empty successful provider discovery responses after the short non-authoritative interval instead of caching them for the full catalog TTL ([#6620](https://github.com/can1357/oh-my-pi/issues/6620)).
- Fixed GitHub Copilot Claude models with no bundled catalog reference (e.g. a freshly served `claude-opus-5`) discovering with `reasoning: false`/`thinking: null` and no effort dial, and disappearing along with their synthesized `-1m` sibling on offline reads: reference-less Copilot models on the anthropic-messages proxy now derive the adaptive reasoning ladder from the model id, and the cache restores their compile-time `COPILOT_API_HEADERS` by value instead of dropping them as unrestorable ([#6664](https://github.com/can1357/oh-my-pi/issues/6664)).

## [17.1.3] - 2026-07-24

### Fixed

- Disabled the first-event watchdog for local OpenAI-compatible backends while retaining the 300-second inter-event watchdog, so long llama.cpp prompt prefill is not canceled and retried ([#6524](https://github.com/can1357/oh-my-pi/issues/6524)).

## [17.1.1] - 2026-07-24

### Added

- Added catalog metadata for models that support native computer-use requests.
- Added resolved Bedrock Converse prompt-cache compatibility limits, including explicit 5-minute checkpoint support for bundled Nova Lite, Micro, Pro, Premier, and Nova 2 Lite models plus their documented in-region, regional, and global IDs, and model-specific 1-hour Claude retention.
- Added resolved Bedrock Converse prompt-cache compatibility limits, including explicit 5-minute checkpoint support for bundled Nova Lite, Micro, Pro, and Premier models plus Nova Premier's documented in-region model ID, and model-specific 1-hour Claude retention.
- Added the native Meta Model API provider and Muse Spark 1.1 with Responses API reasoning replay, image input, and the full supported reasoning-effort ladder ([#4941](https://github.com/can1357/oh-my-pi/issues/4941)).
- Added an opt-in Vercel AI Gateway automatic prompt-cache compatibility option alongside provider routing preferences.
- Added Vercel AI Gateway Responses cache-anchor and cache-lifetime compatibility controls.
- Added resolved OpenAI GPT-5.6 prompt-cache breakpoint capability metadata, keeping older models and compatible endpoints opt-in only.
- Added the native `alibaba-token-plan` provider with QwenCloud Token Plan Individual discovery and a curated chat-model fallback catalog ([#6151](https://github.com/can1357/oh-my-pi/issues/6151)).

## [17.1.0] - 2026-07-24

### Added

- Added Bedrock Converse prompt-cache compatibility limits, including 5-minute checkpoint support for Nova models (Lite, Micro, Pro, Premier, Nova 2 Lite) and 1-hour Claude retention.
- Added native Meta Model API provider and Muse Spark 1.1 support, featuring Responses API reasoning replay, image input, and reasoning-effort controls.
- Added Vercel AI Gateway integration features, including opt-in automatic prompt-cache compatibility, provider routing preferences, and Responses cache-anchor and cache-lifetime controls.
- Added prompt-cache breakpoint capability metadata for OpenAI GPT-5.6, with opt-in support for older models and compatible endpoints.
- Added native alibaba-token-plan provider with QwenCloud Token Plan Individual discovery and a curated chat-model fallback catalog.

## [17.0.9] - 2026-07-23

### Changed

- Renamed `codex-auto-review` model to `GPT-5.3 Codex Spark` with updated pricing and capabilities
- Removed image input support from GPT-5.3 Codex Spark (text-only)
- Reduced GPT-5.3 Codex Spark context window from 272K to 128K tokens
- Changed GPT-5.3 Codex Spark thinking efforts from `["minimal", "low", "medium", "high", "xhigh"]` to `["low", "medium", "high", "xhigh"]`
- Updated pricing for multiple AI models across providers (costs adjusted in models.json)
- Reduced max output tokens for an unspecified model from 16384 to 8192
- Added image input support to Venice AI text model

## [17.0.8] - 2026-07-22

### Added

- Added support for several new models across multiple providers, including MiniMax M3, Gemini 3.5 Flash Lite, Gemini 3.6 Flash (with thinking support), Hy3, Doubao-Seed-Character, LongCat 2.0, Laguna S 2.1 (free and paid tiers), Qwen 3.6 35B A3B, SWE-1.6 Slow (devin agent catalog), and XiaomiMiMo/MiMo-V2.5.

### Changed

- Updated Grok 4.5 API type to "openai-responses" and updated "o3-mini" to support thinking capabilities with the "kimi" thinking format.
- Renamed OpenRouter-specific models and routers to include "OpenRouter" in their names (e.g., "OpenRouter Auto Router (Beta)", "OpenRouter Body Builder (beta)", and "OpenRouter Pareto Code Router").
- Updated context window sizes, costs, and token limits for numerous models.

### Fixed

- Fixed an issue where GPT-5.6 Codex SKUs lost usable context window capacity due to dynamic discovery values overwriting bundled limits.
- Fixed OpenAI Codex discovery dropping account-listed ChatGPT-only models (such as GPT-5.3 Codex Spark) when they are unavailable through the public API.
- Fixed Codex catalog discovery hiding models when multiple OAuth accounts are configured by independently fetching and merging catalogs from all accounts.
- Fixed cached models reusing a bundled request model (such as GitHub Copilot long-context variants) being incorrectly flagged as unrestorable and dropped after a restart.
- Fixed LM Studio discovery reporting a model's theoretical maximum context length instead of the actual loaded context window size of the running instance.

### Removed

- Removed several deprecated model families from the devin catalog, including Claude Fable 5, Claude Opus 4.6/4.7, Claude Sonnet 4.6/5, DeepSeek V4 Pro, Gemini 3.1 Pro, Gemini 3.5 Flash, GLM-5.2, SWE-1.6, and Nemotron 3 Ultra.
- Removed GPT-5 through GPT-5.3 Codex variants and GPT-5.4 nano from the openai-codex catalog.

## [17.0.6] - 2026-07-20

### Added

- Added static fallback seed for Devin's `swe-1-7` model so it is bundled even when catalog generation runs without a Devin session token.

### Fixed

- Collapsed Devin's six GLM-5.2 variants into two logical entries (`glm-5-2` for 200K free, `glm-5-2-1m` for 1M paid). The 200K entry routes every thinking effort to the free `glm-5-2` wire UID — never to the quota-gated `glm-5-2-max` or `glm-5-2-none` — so GLM-5.2 works even when the weekly usage quota is exhausted.

## [17.0.5] - 2026-07-18

### Added

- Added an Anthropic compatibility flag to allow non-official OAuth endpoints to opt into configured Claude Code fingerprint header overrides.

### Fixed

- Fixed a security issue where sensitive provider-defined request headers (such as API keys or credentials) were serialized in plaintext within the model cache (models.db). The cache now omits these headers, securely invalidates older cached rows, and restores or refetches them dynamically.
- Fixed OpenAI Codex discovery to respect caller-supplied fetch configurations (such as proxies or custom CAs) and correctly replace stale bundled models with the authenticated account catalog.
- Fixed stream timeouts and retry loops during long prefills on local loopback or RFC1918 backends (such as litellm proxies fronting local servers) by applying the local stream-timeout floor to these backends.
- Fixed Kimi K3 models served through generic OpenAI-compatible routes exposing unsupported reasoning efforts instead of the mandatory low/high/max scale.

## [17.0.4] - 2026-07-18

### Changed

- Kimi-family models now use MFJS tool schema on all hosts, including proxies like OpenRouter that forward schemas to Moonshot

## [17.0.3] - 2026-07-17

### Fixed

- Logged LiteLLM rich-metadata endpoint failures once with their endpoint and status before falling back to incomplete `/v1/models` data ([#5801](https://github.com/can1357/oh-my-pi/issues/5801)).
- Fixed authenticated Kimi Code discovery to preserve live effort levels, default effort, mandatory-thinking state, and per-model protocol metadata ([#5893](https://github.com/can1357/oh-my-pi/issues/5893)).
- Fixed LiteLLM provider ignoring per-model pricing: `mapLiteLLMRichEntry` now reads `input_cost_per_token` / `output_cost_per_token` (plus cache costs) from LiteLLM rich metadata and maps them to `cost.input` / `cost.output`, falling back to the bundled reference only when LiteLLM omits cost, so proxied models no longer display as free ([#5818](https://github.com/can1357/oh-my-pi/issues/5818)).

## [17.0.2] - 2026-07-17

### Changed

- Increased the maximum output tokens (maxTokens) from 32,768 to 65,536 for Kimi K2.7-Code models on Fireworks.

### Fixed

- Fixed a regression where the context window for openai-codex GPT-5.6 models (Luna, Sol, Terra) incorrectly fell back to 272,000 instead of preserving its 372,000 capacity.
- Fixed Umans PAYG models incorrectly displaying as "Free" in /models by correctly sourcing their published per-token rates.
- Fixed native moonshot/kimi-k3 capabilities and pricing, ensuring it correctly reflects its official pricing, 1M context window, image input support, reasoning capabilities, and 128k output token limit.

## [17.0.1] - 2026-07-16

### Added

- Added GPT-5.6 Luna, Sol, and Terra entries for Amazon Bedrock, Azure, and Cloudflare
- Added KAT-Coder Air/Pro V2.5 entries across Kilo, OpenRouter, NanoGPT, and Vercel
- Added Inkling model entries for Baseten and Vercel AI Gateway
- Added Umans DeepSeek V4 Pro DSpark as an experimental model listing
- Added Claude Opus 4.7 Fast and 4.8 Fast on Vercel AI Gateway
- Added Workers AI GLM-5.2, Muse Spark 1.1, Stealth GPT-5.6 Sol, and nano-gpt-help entries

### Changed

- Added image input and reasoning support to several existing Codeium and Kilo GPT-5.6 models
- Enabled image input and reasoning for Gemini Flash Latest and Grok 4.5
- Renamed many model labels for consistency, including Claude, Grok, DeepSeek, GLM, and Gemi­ni names
- Updated pricing for many existing models, including input, output, and cache cost values
- Updated context window and max token limits for many catalog models across providers

### Fixed

- Fixed Z.AI (GLM) coding-plan token costs all showing as "Free" in `/models`: the `zai` provider descriptor sourced the models.dev `zai-coding-plan` key (all-$0 subscription rates) instead of the `zai` pay-as-you-go key, which carries the real per-token rates for the identical GLM ids ([#5598](https://github.com/can1357/oh-my-pi/issues/5598)).
- Fixed custom Anthropic endpoints receiving the first-party-only `eager_input_streaming` tool field by default ([#5572](https://github.com/can1357/oh-my-pi/issues/5572)).
- Added resolved OpenAI sampling-parameter compatibility metadata for o-series and GPT-5+ models.
- Fixed GitHub Copilot `mai-code-1-flash-picker` (and other `mai-*` models) to route through the `/responses` endpoint instead of `/chat/completions`, which rejected them with `400 unsupported_api_for_model` ([#5612](https://github.com/can1357/oh-my-pi/issues/5612)).
- Extended the reasoning `streamIdleTimeoutMs` floor (300s) to native Kimi K2.7 Code (`kimi-k2.7-code` / `kimi-k2.7-code-highspeed`), which previously fell through to the 120s default and aborted on long reasoning turns ([#4836](https://github.com/can1357/oh-my-pi/issues/4836)).
- Fixed GLM-5.x coding-plan streams via the OpenCode Go/Zen gateways (`opencode.ai/zen/…`) timing out with `OpenAI completions stream stalled while waiting for the next event` during slow plan-writing/reasoning phases. The 600s idle-timeout floor for GLM coding-plan SKUs was gated to the native Z.AI/Zhipu hosts only, so OpenCode-fronted GLM fell back to the 120s default watchdog. ([#4758](https://github.com/can1357/oh-my-pi/issues/4758))

## [16.5.2] - 2026-07-14

### Fixed

- Fixed OpenCode Zen and Go discovery to replace stale bundled models with each provider's live model catalog.

## [16.5.1] - 2026-07-14

### Fixed

- Fixed reasoning effort mapping for Z.ai GLM-5.2 on the Anthropic messages endpoint to correctly use the two-tier scale (high, max) and emit output_config.effort.
- Fixed an issue where stale cached model limits would override updated static catalog limits after a catalog fingerprint mismatch.
- Fixed Cursor discovery to correctly preserve GetUsableModels max-mode metadata for premium models and invalidate stale cache entries.

## [16.4.3] - 2026-07-11

### Fixed

- Fixed parsing of SAP AI Core Claude model IDs in version-first format (e.g., anthropic--claude-4.8-opus), restoring adaptive thinking metadata and capability gates.
- Fixed GitHub Copilot Business and Enterprise model discovery to correctly preserve vision capabilities instead of downgrading models to text-only.

## [16.4.2] - 2026-07-10

### Fixed

- Fixed OpenAI Codex model discovery to include the Codex version header alongside the client_version query parameter.

## [16.4.1] - 2026-07-10

### Added

- Added GPT-5.6 Luna, Sol, and Terra models
- Added perplexity-academic-researcher model

### Changed

- Updated context windows for multiple GPT-5.6 models
- Increased max tokens for several models
- Updated cache write costs for GPT-5.6 variants
- Reduced pricing for select models

### Removed

- Removed the generated GPT-5.6 pro-reasoning aliases (`gpt-5.6-{luna,sol,terra}-pro`) from the `openai-codex` subscription provider — pro reasoning is not offered on subscriptions; the `openai` API-key aliases remain

## [16.4.0] - 2026-07-10

### Breaking Changes

- Redesigned reasoning effort ladders to be wire-exact, removing the shifted five-tier effort mapping. Models now expose exactly the effort tiers their upstream APIs accept, mapped 1:1. Removed SHIFTED_FIVE_TIER_EFFORT_MAP, ANTHROPIC_ADAPTIVE_EFFORT_MAP_4_TIER, and per-host xhigh-to-max alias maps. Selecting an unsupported tier now automatically clamps down via clampThinkingLevelForModel. Devin effort routing is now mapped 1:1 onto per-tier siblings.

### Added

- Added support for new models: Grok 4.5 family, Dolphin Mistral 24b Venice Edition, GLM5.2-Fast, and Zenmux variants for GPT-5.6 (Luna, Sol, and Terra).
- Added Novita as a model provider, including public catalog discovery, pricing, limits, modality, reasoning, and tool metadata.
- Added useResponsesLite to Model and ModelSpec to support the Responses Lite transport, enabled by default for the GPT-5.6 family.
- Added Effort.Max ("max") as a first-class user-facing thinking level above xhigh.

### Changed

- Enabled reasoning effort controls for Grok 4.5 and updated support flags for additional Grok variants
- Standardized reasoning effort levels to use a wire-exact max tier across all model providers, including Devin routing and Ollama configurations.
- Updated costs and context windows for various models in the catalog.

## [16.3.15] - 2026-07-09

### Added

- Added support for Grok 4.5 model
- Added `gpt-5.6` base models and `gpt-5.6-{luna,sol,terra}-pro` variants
- Added `meta/muse-spark-1.1` model support
- Added support for thinking modes on `poolside/laguna` models
- Added generated GPT-5.6 Pro aliases (`gpt-5.6-{luna,sol,terra}-pro`) on the `openai` and `openai-codex` providers: each alias sends the base model id on the wire (`requestModelId`) with the new `reasoningMode: "pro"` marker, and re-derives from the current base rows on every catalog regeneration.

### Changed

- Updated cache read costs for Grok models
- Reduced max token limit for Grok 4.3 model
- Enabled prompt cache affinity for Grok models via the x-grok-conv-id header in OpenAI compatible endpoints
- Enabled prompt cache affinity for Grok models via the x-grok-conv-id header
- Marked direct xAI Grok Chat Completions models for `x-grok-conv-id` prompt-cache affinity.

## [16.3.14] - 2026-07-09

### Added

- Added support for GPT-5.6 (Luna, Sol, Terra) model variants
- Enabled expanded five-tier reasoning effort scale (minimal to xhigh) for GPT-5.6 models
- Added GPT-5.6 (Terra/Luna/Sol) support for the new `max` reasoning tier: on wire-effort APIs (OpenAI Responses, Codex, Azure, openai-compat/OpenRouter models that advertise reasoning) user efforts shift up one notch — `xhigh` sends `max`, `high` sends `xhigh` — mirroring the Claude Fable/Opus 4.7+ five-tier mapping, and the exposed ladder becomes `minimal..xhigh` with `minimal` reaching the native `low` tier. Devin's per-tier GPT-5.6 sibling rows now collapse into `gpt-5-6-{luna,sol,terra}` logical models with the same shifted routing (`xhigh` → `-max`), plus `-fast` families that keep the direct `low..xhigh` `-priority` scale since Devin serves no `-max-priority` tier.

## [16.3.13] - 2026-07-09

### Added

- Added support for Grok 4.5 across multiple providers
- Added support for GPT-5.6 series models (Luna, Sol, Terra)
- Added Aion 3.0 and 3.0 Mini models
- Added Kuaishou KAT-Coder v2.5 models
- Added Nex-N2-Mini and SWE-1.7 series models
- Added Hy3 models and free variants

### Changed

- Updated cost and token configurations for various models across providers
- Renamed several models for consistency (e.g., MiniMax M3, Gemma 4 31B, Qwen variants)

## [16.3.12] - 2026-07-08

### Fixed

- Fixed LiteLLM discovery stopping at `/model_group/info` when that endpoint omitted `supports_vision`; it now continues to `/model/info` and preserves `model_info.supports_vision=true` for vision-capable proxy models. ([#4747](https://github.com/can1357/oh-my-pi/issues/4747))
- Fixed LiteLLM discovery to fall back to bundled catalog metadata when `models.dev` lacks a model reference, preserving reasoning and thinking support for models such as `glm-5.2`. ([#4695](https://github.com/can1357/oh-my-pi/issues/4695))
- Detected Azure AI Inference / Foundry Anthropic routes as strict-tool-incompatible so resolved Anthropic compat disables strict tools before request construction ([#4679](https://github.com/can1357/oh-my-pi/issues/4679)).

## [16.3.11] - 2026-07-06

### Added

- Added Claude Haiku 4.5 (JP) model support
- Added tencent/hy3 model support via ZenMux

### Changed

- Updated naming format for various synthetic models to include provider prefix
- Adjusted context window limit for MiniMax-M3 model
- Updated pricing for select models

## [16.3.10] - 2026-07-06

### Fixed

- Fixed LiteLLM rich discovery to ignore unusable sentinel placeholders and continue to `/v2/model/info` for real models. ([#4655](https://github.com/can1357/oh-my-pi/issues/4655))

## [16.3.9] - 2026-07-06

### Fixed

- Fixed compatibility with OpenCode Go DeepSeek V4 models by sending max_tokens instead of max_completion_tokens to match the provider's API requirements.

## [16.3.7] - 2026-07-05

### Fixed

- Fixed usage cost calculation to correctly account for provider orchestration token sidecars without misclassifying them as standard input, output, or cache tokens.

## [16.3.4] - 2026-07-03

### Added

- Added Baseten as a supported model provider
- Added support for new models from Baseten, including DeepSeek V4 Pro and Kimi series
- Added new Devin agent models: Claude 5 Fable variants
- Added new Github Copilot models: Kimi K2.7 Code and MAI-Code-1-Flash
- Added Poolside Laguna XS 2.1 models via Kilo and OpenRouter providers
- Added support for Claude Fable 5 (Free) via Zenmux provider

### Changed

- Updated priority ordering to include Baseten
- Updated pricing and limits for various existing models in the catalog

## [16.3.3] - 2026-07-02

### Fixed

- Extended Anthropic-compatible signing-endpoint recognition to Cloudflare AI Gateway, Google Vertex, AWS Bedrock, and Azure AI Inference / Foundry to ensure consistent reasoning-replay and signature-stripping behavior, and exposed ResolvedAnthropicCompat.signingEndpoint in the public API.
- Fixed Zhipu Coding Plan runtime discovery to prioritize account-scoped model lists over bundled fallback models, preventing routing errors for valid non-z.ai keys.

## [16.3.2] - 2026-07-02

### Fixed

- Fixed ZenMux model discovery to run without a `ZENMUX_API_KEY`, so newly published ZenMux models (for example `anthropic/claude-fable-5-free`) auto-update into the runtime `models.db` cache instead of waiting on a regenerated `models.json`.
- Fixed ZenMux runtime discovery to query the `/api/v1/models` endpoint even when the resolved provider base URL points at the Anthropic-compatible route, so discovery no longer requests a non-existent `/api/anthropic/models` path.

## [16.3.1] - 2026-07-02

### Removed

- Removed reasoning suppression prompt logic for GPT-5 models

## [16.3.0] - 2026-07-02

### Breaking Changes

- Renamed the `requiresJuiceZeroHack` compatibility flag to `requiresReasoningSuppressionPrompt` (affecting `OpenAICompat` and `ResolvedOpenAIResponsesCompat`) and removed the unused `"juice-zero-developer-message"` member from `OpenAIReasoningDisableMode`.

### Fixed

- Fixed stream markup healing pattern misfires by disabling the healer on the official OpenAI endpoint.
- Updated the Xiaomi provider's default model to the supported `mimo-v2.5` model.
- Fixed model discovery probes (including Ollama and metadata fetches) failing behind private-CA gateways by ensuring they honor the `NODE_EXTRA_CA_CERTS` environment variable.
- Fixed CoreWeave Serverless Inference project-header detection to ensure blank OpenAI-Project overrides do not block the `COREWEAVE_PROJECT` fallback.
- Fixed LiteLLM MiniMax M3 discovery to remove reseller-only display suffixes and invalidated the model cache to clear stale suffixes immediately.
- Fixed ZenMux's `anthropic-messages` proxy being misclassified as a non-signing reasoning endpoint (`replayUnsignedThinking: true`), matching the GitHub Copilot fix (#2851). ZenMux's `zenmux.ai/api/anthropic` route forwards to signature-enforcing Anthropic, so replaying a stripped/unsigned historical `thinking` block as `signature: ""` — most visibly an end_turn-bound checkpoint/branch-return turn whose signature the transform must strip — caused `400 messages.1.content.0: Invalid signature in thinking` on Claude Sonnet 5 and other reasoning models. ([#4192](https://github.com/can1357/oh-my-pi/issues/4192))

## [16.2.13] - 2026-07-01

### Added

- Added support for human-readable reasoning summaries on compatible OpenAI Codex models (v5.4+)

### Fixed

- Fixed discovered OpenAI Codex models to advertise V2 streaming remote compaction, avoiding the legacy compact endpoint timeout path for Codex sessions. ([#4146](https://github.com/can1357/oh-my-pi/issues/4146))

## [16.2.12] - 2026-07-01

### Breaking Changes

- Removed runtime canonical-equivalence APIs from the identity module, including resolveCanonicalVariant, buildCanonicalModelOrder, CanonicalVariantPreferences, and getBundledCanonicalReferenceData. These utilities have been transitioned to a build-time generator script and are no longer exposed in the runtime bundle.

## [16.2.11] - 2026-07-01

### Fixed

- Fixed a potential memory leak caused by dangling timeout timers during model discovery in OpenAI-compatible, vLLM, LiteLLM, and LM Studio catalogs.
- Widened stream watchdogs for local OpenAI-compatible backends (including llama.cpp, LM Studio, vLLM, and Ollama) to prevent premature timeouts during cold model loads.

## [16.2.10] - 2026-06-30

### Added

- Added Claude Sonnet 3.7, Claude Opus 3, and Claude Sonnet 3 model entries to the Anthropic catalog
- Added Anthropic Claude Sonnet 5 model entry to the Kilo provider catalog
- Added first-party catalog discovery support for the Anthropic provider
- Added Gemini 3.1 Flash Lite Image model entry to the Kilo provider catalog
- Added Anthropic Claude Sonnet 5 model variants with low, medium, high, xhigh, and max thinking efforts to the Devin provider catalog
- Added Claude Sonnet 5 model entry to the Anthropic curated catalog.

### Changed

- Updated the base API URL for the Claude Sonnet 5 model in the Anthropic catalog
- Updated pricing metrics for DeepSeek R1 and DeepSeek V3 model entries to reflect new rates

## [16.2.9] - 2026-06-30

### Added

- Added full capability support for Claude Sonnet 5, aligning it with Claude Opus 4.8 and Fable 5. This includes adaptive thinking display, mid-conversation system messages, sampling parameter and thinking omission API restrictions, and 5-tier adaptive reasoning effort mapping (including xhigh and max levels) across direct APIs, OpenRouter, and Bedrock Converse.

### Changed

- Updated input and output costs for models in the catalog.

## [16.2.7] - 2026-06-30

### Fixed

- Fixed compatibility with Kimi K2.7 Code on native endpoints to ensure thinking mode is preserved and tool choice is not forced.
- Fixed Cerebras gemma-4-31b dynamic discovery to correctly identify the model as image-capable, enabling proper serialization of attached images.

## [16.2.6] - 2026-06-29

### Fixed

- Fixed namespaced GLM-5.x model IDs on Z.AI/Zhipu OpenAI-compatible endpoints to inherit the widened stream watchdog, avoiding spurious stalled-stream errors during long thinking phases. ([#3819](https://github.com/can1357/oh-my-pi/issues/3819))

## [16.2.3] - 2026-06-28

### Added

- Added support and configuration parameters for V2 streaming compaction in RemoteCompactionConfig, catalog types, and model/provider metadata.

### Changed

- Enabled automatic content markup healing for all OpenAI-compatible streaming models
- Updated pricing and context window limits for several catalog models.
- Disabled reasoning capability for multiple providers in the catalog.

## [16.2.2] - 2026-06-27

### Removed

- Removed 'pi' from the list of supported dialects.

## [16.2.0] - 2026-06-27

### Added

- Added GitLab Duo Agent catalog discovery, including namespace selection, live model mapping, and a bundled fallback model for fresh installs.
- Added OpenAICompat.supportsNamedToolChoice to support forced tool use on string-only OpenAI-compatible chat servers without emitting the named function-object tool_choice shape.
- Added model metadata support for provider-native remote compaction and compaction-only model selection.

### Changed

- Disabled the thinking-effort selector for GitLab Duo Agent models since the underlying platform parameters are server-fixed.

### Fixed

- Improved GitLab Duo Agent and Duo Workflow namespace and project discovery to robustly handle paginated groups, SSH remotes with custom ports, Git worktrees, self-managed GitLab instances with relative paths, and configuration via GITLAB_DUO_PROJECT_PATH or GITLAB_DUO_PROJECT_ID.
- Fixed built-in LiteLLM discovery to prefer rich proxy metadata from management endpoints and avoid caching stale capability data.
- Fixed GitLab Duo Workflow model specifications to resolve correct static context windows, enabling accurate context usage tracking and auto-compaction.

## [16.1.23] - 2026-06-26

### Added

- Added `OpenAICompat.qwenPreserveThinking` — auto-enabled when the resolved `thinkingFormat` is `"qwen"` or `"qwen-chat-template"` AND `replayReasoningContent` is on (i.e. the four built-in local OpenAI-compatible providers, or a custom provider pointed at a loopback / RFC1918 / `*.local` baseUrl). Pairs with the chat-completions encoder change so the request body carries `preserve_thinking: true` (twin top-level + `chat_template_kwargs` emission), keeping Qwen3.6+ from stripping `<think>...</think>` off older assistant turns and breaking the local slot's KV cache between user messages. Non-Qwen chat templates ignore the parameter, so the flag stays a no-op outside the Qwen path; users on a cloud Qwen host (Alibaba Dashscope / Qwen Portal) can opt in with `compat.qwenPreserveThinking: true`. ([#3541](https://github.com/can1357/oh-my-pi/issues/3541))
- Added CoreWeave Serverless Inference as an OpenAI-compatible provider with models.dev-backed bundled catalog metadata.

## [16.1.22] - 2026-06-26

### Added

- Added `OpenAICompat.replayReasoningContent` — auto-enabled for the built-in local OpenAI-compatible providers (`llama.cpp`, `lm-studio`, `vllm`, `ollama` on `openai-completions`) and for any provider pointed at a loopback / RFC1918 / `*.local` baseUrl. NOT gated on `spec.reasoning`: the runtime discovery paths for `llama.cpp` / `lm-studio` / `openai-models-list` hardcode `reasoning: false` because the upstream `/models` endpoints don't advertise the capability, while the stream parser still records incoming `reasoning_content` deltas as thinking blocks — gating on the spec flag would leave every discovered local Qwen / DeepSeek model re-triggering #3528. The encoder only writes `reasoning_content` when a thinking block actually exists on the turn, so the flag is a no-op on pure-text histories. Built-in proxy providers (currently `litellm`) are excluded from both checks because they forward to an unrelated upstream that gains no KV-cache benefit and may 400 on the extra field; users running a custom proxy in front of a llama.cpp-style backend can opt in via the sparse `compat.replayReasoningContent: true` override. Signals to the `openai-completions` encoder that preserved `thinking` blocks must be re-emitted as `reasoning_content` on every assistant turn so chat templates that reconstruct `<think>…</think>` from the field (Qwen3, DeepSeek-R1, GLM-5.x) keep the prior turn's tokens byte-stable and llama.cpp's prefix KV cache survives. ([#3528](https://github.com/can1357/oh-my-pi/issues/3528))

## [16.1.20] - 2026-06-25

### Fixed

- Fixed direct Anthropic Claude Sonnet/Haiku 4.5 advisor/agent turns crashing every call with HTTP 400 `This model does not support the effort parameter.` The catalog classified the whole Claude 4.5 family on `anthropic-messages` (and `bedrock-converse-stream`) as `anthropic-budget-effort`, which made the Anthropic provider serialize `output_config.effort` alongside `thinking.budget_tokens`. Anthropic only honors `output_config.effort` on Opus 4.5 and adaptive (4.6+) Messages-API models, so Sonnet 4.5 / Haiku 4.5 rejected the field. `inferThinkingControlMode` now gates `anthropic-budget-effort` to the structured Opus family at revision 4.5+ on both Anthropic-routed APIs, so Sonnet 4.5 / Haiku 4.5 on direct Anthropic + Cloudflare-AI-Gateway + Vertex + GitLab-Duo + Copilot + Bedrock fall through to plain `mode: "budget"` (thinking budget still scales with the selected effort tier). Opus 4.5 keeps `anthropic-budget-effort`. `anthropic-budget-effort` also stays in use for Anthropic-compatible third-party backends that natively support the field (Umans GLM 5.2). ([#3497](https://github.com/can1357/oh-my-pi/issues/3497))

## [16.1.17] - 2026-06-24

### Fixed

- Fixed the Umans GLM-5.2 thinking-level picker collapsing to a single `high` tier after dynamic discovery: the `max` upstream level now resolves to the internal `xhigh` effort, the picker shows both `high` and `xhigh`, and the metadata maps `xhigh` back to Umans's native `max` wire tier. ([#3192](https://github.com/can1357/oh-my-pi/issues/3192))
- Fixed GitHub Copilot business and enterprise endpoints accepting image inputs that they reject with `400 vision is not supported`. The Copilot `/models` response advertises `capabilities.supports.vision = true` for Claude/GPT chat models on every host, but only the canonical personal endpoint (`https://api.githubcopilot.com`) actually serves them; `githubCopilotModelManagerOptions` now forces `input: ["text"]` whenever discovery resolves to a non-personal base URL, and `mergeDynamicModel` honours the dynamic value (instead of OR-upgrading) when the merged endpoint differs from the bundled reference. ([#3387](https://github.com/can1357/oh-my-pi/issues/3387))
- Fixed OpenRouter Anthropic compat to strip Responses reasoning history during replay so signed thinking blocks are not sent back to routed Anthropic providers. ([#3399](https://github.com/can1357/oh-my-pi/issues/3399))

## [16.1.14] - 2026-06-22

### Added

- Added Sakana AI provider support with Fugu model integration
- Added Sakana AI/Fugu provider catalog entries with Fugu model discovery and Responses API metadata
- Added support for "xhigh" reasoning tier across model configurations
- Added configuration for new models GCP-5.4 Mini, GPT-5.5, and variants
- Added `devin` variant collapse table to streamline model tiering

### Changed

- Updated reasoning label pattern to include "minimal" and "max" efforts
- Simplified model identification logic for Devin-powered reasoning models
- Refactored variant routing to consolidate and standardize tier definitions

## [16.1.13] - 2026-06-22

### Added

- Added support for Devin as a model provider
- Added capability to fetch dynamic models from the Devin model manager

## [16.1.11] - 2026-06-21

### Fixed

- Fixed Umans `umans-glm-5.1` / `umans-glm-5.2` advertising native image input. The `models/info` endpoint reports `supports_vision: "via-handoff"` for the GLM models, meaning vision routes through a separate handoff pre-analysis step instead of accepting raw image blocks; `umansSupportsVision` treated any non-empty string as native vision support, so image prompts went directly to GLM and were rejected with `400 This model does not support image inputs`. The helper now requires `supports_vision === true`, the bundled GLM 5.1/5.2 rows are corrected to text-only, and stale mismatched Umans cache rows for those ids are dropped so the vision-handoff path runs even before a successful refresh. ([#3184](https://github.com/can1357/oh-my-pi/issues/3184))

## [16.1.9] - 2026-06-21

### Fixed

- Fixed the `moonshot` provider with no path to the Kimi China API: model discovery now honors a `MOONSHOT_BASE_URL` override (redirecting to `api.moonshot.cn`), and `KIMI_API_KEY` resolves as a fallback for `MOONSHOT_API_KEY`. ([#2883](https://github.com/can1357/oh-my-pi/issues/2883))
- Fixed LiteLLM model discovery preserving colliding models.dev transport metadata (for example `ollama-cloud` `deepseek-v4-flash`) instead of keeping the LiteLLM `openai-completions` provider transport. ([#3162](https://github.com/can1357/oh-my-pi/issues/3162))

### Removed

- Removed bundled Wafer Pass (`wafer-pass`) catalog entries and generation support; Wafer Serverless remains available as `wafer-serverless`.

## [16.1.8] - 2026-06-20

### Fixed

- Fixed Fireworks-hosted Qwen turns (e.g. `fireworks/qwen3.7-plus`) failing with `400 Extra inputs are not permitted, field: 'enable_thinking'`. Fireworks serves Qwen3 with controllable thinking via OpenAI-style `reasoning_effort` and rejects the top-level `enable_thinking` boolean that Alibaba DashScope speaks; `buildOpenAICompat` was selecting `thinkingFormat: "qwen"` from the `qwen` id pattern regardless of host. Fireworks-hosted Qwen models now resolve to `thinkingFormat: "openai"`.
- Fixed MiMo models on OpenAI-compatible gateways to expose only accepted `low`, `medium`, and `high` reasoning tiers and map unsupported raw `minimal`/`xhigh` requests to safe wire values. ([#2864](https://github.com/can1357/oh-my-pi/issues/2864))

## [16.1.7] - 2026-06-20

### Fixed

- Fixed MiniMax-M3 catalog context for the MiniMax Coding/Token Plan providers `minimax-code` and `minimax-code-cn` to report the documented 1M long-context tier instead of the upstream 512K pricing boundary; the previous patch only covered `minimax`/`minimax-cn`, so the Coding Plan picker still showed 512K in the status bar ([#3097](https://github.com/can1357/oh-my-pi/issues/3097)).

## [16.1.4] - 2026-06-19

### Fixed

- Fixed Claude 4.6 routing on the `google-antigravity` (and `google-gemini-cli`) Cloud Code Assist providers, whose backend exposes the models asymmetrically: `claude-sonnet-4-6` has no `-thinking` twin and `claude-opus-4-6` has only the `-thinking` twin. The shared `thinkingPair` family was routing thinking efforts on `claude-sonnet-4-6` to a non-existent `claude-sonnet-4-6-thinking` wire id (404 `Requested entity was not found`); replaced both 4.6 entries with bespoke single-wire families so every effort and off resolve to the live wire id. Added `claude-sonnet-4-6` and `claude-opus-4-6-thinking` entries to `ANTIGRAVITY_MODEL_WIRE_PROFILES` capped at the backend's 64000-output-token limit (over-cap requests 400'd with `Request contains an invalid argument`); `modelEnum` is now optional on `AntigravityModelWireProfile` since the Claude wire ids are accepted without a captured `labels.model_enum`. ([#3067](https://github.com/can1357/oh-my-pi/issues/3067))

## [16.1.3] - 2026-06-19

### Fixed

- Marked Ollama Cloud catalog models to omit on-the-wire output-token caps, preventing context-window-sized `num_predict` values from causing HTTP 400s for models whose true output cap is not discoverable. ([#2984](https://github.com/can1357/oh-my-pi/issues/2984))
- Fixed `readModelCache`/`writeModelCache` using a process-global shared database even when a custom `dbPath` was provided. Custom-path cache operations now open and close a per-call database via `withModelCacheDb`, preventing leaked SQLite handles on Windows

## [16.1.2] - 2026-06-19

### Added

- Added support for Gemini 2.5 Flash-Lite, 3.1 Flash-Lite, and 3.5 Flash models
- Added support for Moonshot V1 model family

### Changed

- Updated context window and token limits for various Claude, Gemini, and GPT-OSS models
- Refined thinking mode behaviors and routing for supported LLM families

### Fixed

- Fixed GLM-5.2 `reasoning_effort` so the top thinking tier reaches each host's genuine maximum instead of 400ing, mapping the internal `xhigh` tier per host dialect (verified against live endpoints): Z.ai/Zhipu collapse onto the model's `none`/`high`/`max` scale (`xhigh → max`); Fireworks, resellers, and Ollama Cloud keep their distinct lower tiers and remap only the top `xhigh → max` (merged over host quirks such as Fireworks' `minimal → none`); and OpenRouter — whose API rejects `max` and treats `xhigh` as its own max tier — now exposes the `xhigh` tier and forwards it verbatim. Dialect detection keys off resolved `compat.thinkingFormat`, so custom OpenRouter/Z.ai-format providers are covered too.
- Maintained thinking effort routing when discovery only returns the base model ID
- Improved credential retrieval logic for Antigravity and Codex providers via auth discovery

## [16.0.9] - 2026-06-18

### Fixed

- Fixed GitHub Copilot's `anthropic-messages` proxy being misclassified as a non-signing reasoning endpoint (`replayUnsignedThinking: true`). It forwards to signature-enforcing Anthropic, so replaying a stripped/unsigned historical `thinking` block as `signature: ""` — most visibly an end_turn-bound checkpoint/branch-return turn whose signature the transform must strip — caused a `400 Invalid signature` that corrupted the session and re-tripped on every full history re-send (e.g. after toggling MCP servers). Copilot now degrades such blocks to text like the official API. ([#2851](https://github.com/can1357/oh-my-pi/issues/2851))
- Added a `supportsImageDetailOriginal` compat flag that resolves to `false` for GitHub Copilot, whose Responses endpoint rejects the `detail: "original"` image hint with a 400, and `true` for every other host. ([#2822](https://github.com/can1357/oh-my-pi/issues/2822))

## [16.0.8] - 2026-06-18

### Changed

- Refactored model family ID predicates and capability checkers to use a shared, uniform process-lifetime `memo` utility to eliminate caching boilerplate.

### Fixed

- Fixed LM Studio dynamic discovery to use native `/api/v0/models` metadata so VLM models advertise image input. ([#2945](https://github.com/can1357/oh-my-pi/issues/2945))

## [16.0.7] - 2026-06-18

### Fixed

- Fixed MiniMax Anthropic-compatible M2/M3 thinking metadata to expose the adaptive transport and keep M2 mandatory reasoning floored ([#2928](https://github.com/can1357/oh-my-pi/issues/2928)).

## [16.0.6] - 2026-06-18

### Added

- Added a dedicated `openrouter` API type and `ResolvedOpenRouterCompat` configuration to support unified chat-completions and Responses-API compatibility for OpenRouter models

### Changed

- Migrated bundled OpenRouter models in the catalog from `openai-completions` to the new `openrouter` API type
- Consolidated the resolved OpenAI compat shape: extracted a shared `ResolvedOpenAISharedCompat` core that both `ResolvedOpenAICompat` and `ResolvedOpenAIResponsesCompat` extend (each builder still computes its own per-surface value, preserving chat↔Responses divergence), added internal resolved wire-quirk fields (`wireModelIdMode`, `stripDeepseekSpecialTokens`, `reasoningDeltasMayBeCumulative`, `emptyLengthFinishIsContextError`, `usesOpenAIToolCallIdLimit`, `dropThinkingWhenReasoningEffort`, `supportsObfuscationOptOut`), and replaced `buildOpenRouterCompat`'s cast-and-copy with an exhaustive `pickResponsesOnly` composition that fails to compile if a new Responses-only field is added without handling. The public `OpenAICompat` config vocabulary is unchanged.
- Expanded `OpenAICompat`/`ResolvedOpenAISharedCompat` with shared reasoning/history/stream/request flags (`reasoningDisableMode`, `omitReasoningEffort`, `includeEncryptedReasoning`, `filterReasoningHistory`, `requiresReasoningContentForAllAssistantTurns`, `streamMarkupHealingPattern`, `promptCacheSessionHeader`, etc.) so model/provider/gateway constraints are declared once in catalog compat and then consumed uniformly by Chat Completions and Responses endpoints.

### Fixed

- Changed the default compatibility builder for `openai-completions` to set `requiresAssistantAfterToolResult` to `isMistral`, enabling the synthetic assistant bridge for built-in Mistral and Devstral models.
- Fixed local Ollama (`provider: "ollama"`) reasoning turns still failing with HTTP 400 `invalid reasoning value: "minimal"` when the model was selected from a stale `~/.omp/models.db` cache row or a hand-written config: the `minimal → low` / `xhigh → max` remap was only stamped during fresh discovery, so cached and custom specs reached the wire unmapped. The remap now lives in the OpenAI chat-completions and Responses compat builders, so every `buildModel` (including cache loads, custom specs, and the `whenThinking` variant) backfills it — no `omp models refresh` required. Custom OpenAI-compatible providers registered under a non-`ollama` provider id still need their own `compat.reasoningEffortMap`.
- Advertised Ollama Cloud GLM-5.2 reasoning efforts as high/xhigh-only and mapped `xhigh` to native max effort ([#2911](https://github.com/can1357/oh-my-pi/pull/2911) by [@serverinspector](https://github.com/serverinspector))
- Fixed OpenRouter pseudo-API model construction so bundled OpenRouter models resolve shared OpenAI compatibility metadata instead of an undefined compat record.
- Fixed custom/direct `xai-oauth` Responses model specs (e.g. `grok-build`) emitting `reasoning.effort` and hitting xAI's HTTP 400: `buildOpenAIResponsesCompat` now defaults `supportsReasoningEffort` to `false` for `xai-oauth` Grok models that are off the effort-capable allowlist (`grok-3-mini`/`grok-4.20-multi-agent`/`grok-4.3`), matching the curated discovery path; explicit `compat.supportsReasoningEffort` still overrides. The reviewed allowlist moved into shared compat rules consumed by both the compat builder and provider-model curation so the two cannot drift.

## [16.0.5] - 2026-06-17

### Added

- Added `enableGeminiThinkingLoopGuard` to OpenAI compatibility options to allow explicit opt-in or opt-out of the Gemini thinking-loop guard for OpenAI-compatible model aliases
- Added `LITELLM_BASE_URL` as the LiteLLM provider discovery base URL fallback, with discovery caches scoped by the resolved proxy URL and explicit provider `baseUrl` config kept at higher precedence. ([#2726](https://github.com/can1357/oh-my-pi/issues/2726))
- Added `ThinkingConfig.effortBudgets` (per-effort thinking-budget contract baked into collapsed variants) and `ANTIGRAVITY_MODEL_WIRE_PROFILES` (`maxOutputTokens` + `model_enum` per Antigravity wire id) to mirror the captured Antigravity Cloud Code Assist client request shape.

### Changed

- Defaulted `enableGeminiThinkingLoopGuard` from Gemini family detection for both OpenAI completions and responses compatibility specs so Gemini models now enable the thinking-loop guard automatically
- Updated the default Gemini CLI user-agent version fallback to 0.46.0.
- Changed the Antigravity (`google-antigravity`, daily-cloudcode-pa) gemini-3.x collapse families to the `budget` thinking transport with the client's per-tier `thinkingBudget` (3.5 Flash low/medium/high = 1000/4000/10000, 3.1 Pro low/high = 1001/10001) and corrected 3.5 Flash effort→wire routing (medium → `gemini-3.5-flash-low`, high → `gemini-3-flash-agent`). Split the shared CCA collapse table so `google-gemini-cli` (cloudcode-pa) keeps the `google-level` `thinkingLevel` transport for official Gemini CLI parity. Stale collapsed snapshots (bundled catalog, recycled `gemini-3-flash` alias) self-heal from the hand table at collapse time, and the model cache schema is bumped to v7 to invalidate pre-budget Antigravity rows.
- Changed the Antigravity user-agent to the `antigravity/hub/<version>` format (default `2.1.4`) to match the captured client.

### Fixed

- Fixed `off` effort routing for `claude-opus-4-5` and `claude-opus-4-6` to use their base model IDs when thinking is disabled
- Fixed `gemini-2.5-flash` effort routing so all non-off effort levels resolve to `gemini-2.5-flash-thinking`
- Fixed shared variant alias provider resolution so `resolveBareVariantAlias` reports all matching providers when model aliases are present in both CCA collapse tables
- Routed google-antigravity default baseUrl to the stable primary daily endpoint in the catalog generator and all fallback snapshots, resolving connection drops on heavy queries.
- Fixed MiniMax M3 dialect selection so MiniMax-family OpenAI-compatible models use the MiniMax tool-call dialect instead of generic XML. ([#2759](https://github.com/can1357/oh-my-pi/issues/2759))
- Fixed GitHub Copilot dynamic discovery to honor plan-specific API endpoints stored in structured OAuth credentials. ([#2876](https://github.com/can1357/oh-my-pi/issues/2876))

## [16.0.4] - 2026-06-17

### Fixed

- Fixed GLM-5.2 catalog thinking metadata for Zhipu/BigModel so the top effort is exposed as `xhigh` and maps to provider-native `max`. ([#2833](https://github.com/can1357/oh-my-pi/issues/2833))

## [16.0.2] - 2026-06-16

### Fixed

- Fixed Kimi output caps for Umans AI Coding Plan and Venice so discovery metadata cannot use context-sized token ceilings as request caps.
- Marked Umans Anthropic-compatible models as client-tool escaped so cached and bundled metadata do not expose `web_search` as a provider server tool.

## [16.0.1] - 2026-06-15

### Added

- Added the Umans AI Coding Plan provider catalog with Anthropic-compatible model metadata and dynamic discovery ([#2636](https://github.com/can1357/oh-my-pi/pull/2636) by [@oldschoola](https://github.com/oldschoola)).

## [16.0.0] - 2026-06-15

### Breaking Changes

- Renamed the catalog-owned tool syntax API from `ToolCallSyntax`/`FALLBACK_TOOL_SYNTAX`/`preferredToolSyntax` to `Dialect`/`FALLBACK_DIALECT`/`preferredDialect`.

## [15.13.3] - 2026-06-15

### Added

- Added Azure OpenAI as a catalog provider (`azure`, default model `gpt-5.5`, env var `AZURE_OPENAI_API_KEY`), bundling the OpenAI-family models Azure serves over the Responses API (GPT-4/4.1/4o, GPT-5 family, o-series, Codex). Like Amazon Bedrock it is catalog-only — models ship in the bundle and become selectable once the env key is set, with the deployment base URL resolved at runtime from `AZURE_OPENAI_BASE_URL`/`AZURE_OPENAI_RESOURCE_NAME`.
- Added models.dev-backed bundled catalogs for providers that previously shipped no offline models: Hugging Face, Kilo, Moonshot, NanoGPT, Synthetic, Venice, Ollama Cloud, and the Xiaomi Token Plan regions (ams/cn/sgp). They still discover live when credentialed; the bundle is now a non-empty baseline.

### Changed

- Updated stale provider default models to their latest bundled versions: OpenAI-family providers (`azure`, `github-copilot`, `aimlapi`) → GPT-5.5; Gemini providers (`google`, `google-gemini-cli`, `google-vertex`) → `gemini-3.1-pro-preview`; GLM providers (`zai`, `zhipu-coding-plan`) → `glm-5.2`, `cerebras` → `zai-glm-4.7`; Kimi providers (`fireworks`, `opencode-go`, `moonshot`) → `kimi-k2.7-code`, `kimi-code` → `kimi-for-coding`, `together` → `moonshotai/Kimi-K2.7-Code`; `alibaba-coding-plan` → `qwen3.7-plus`; and Claude-Sonnet defaults (`cloudflare-ai-gateway`, `cursor`, `gitlab-duo`, `kilo`, `opencode-zen`, `vercel-ai-gateway`) → Claude Opus 4.x.
- Restricted models.dev Azure discovery to OpenAI-family IDs (`gpt-`, `o1`, `o3`, `o4`, `codex`, `chatgpt`), excluding Foundry-hosted third parties (Claude/DeepSeek/Llama/Mistral/Phi) that Azure serves through non-Responses APIs.
- Detected the Azure OpenAI Responses compat surface (developer role, strict tool mode, strict tool-result pairing) by provider id as well as base URL, so bundled `azure` models whose deployment host is only known at runtime still get the right wire behavior.
- Renamed the `Qwen3-ASR-Flash` model label to `Qwen3 ASR Flash`

### Fixed

- Fixed tool syntax selection for Gemini-family and Gemma model IDs by routing them to dedicated `gemini` and `gemma` formats instead of generic XML
- Fixed `zhipu-coding-plan` and `together` shipping no bundled models: their descriptors referenced non-existent models.dev keys (`zhipu-coding-plan`, `together`); pointed them at the real keys (`zhipuai-coding-plan`, `togetherai`) so they bundle their GLM and full catalogs respectively.
- Folded the `azure-openai-responses` API into the OpenAI Responses thinking-inference branches so Azure reasoning models (o-series, GPT-5, Codex) resolve the discrete effort vocabulary (including `xhigh`) and effort-control mode instead of falling through to generic defaults.
- Fixed `ollama-cloud` discovery inheriting an unsafe cross-provider `contextWindow`/`maxTokens` when `/api/show` returns no size metadata; it now falls back to the safe 128K context / 8K output caps.
- Dropped internal Fireworks control-plane resource ids (`accounts/fireworks/{models,routers}/…`) from the bundle; only the public request ids ship.

## [15.13.2] - 2026-06-15

### Added

- Added the `ToolCallSyntax` union and `FALLBACK_TOOL_SYNTAX` constant to `@oh-my-pi/pi-catalog/identity` (re-exported from `@oh-my-pi/pi-ai/grammar`).
- Added `preferredToolSyntax(modelId)` to `@oh-my-pi/pi-catalog/identity`, resolving a model's native tool-call syntax affinity from its family token (Claude→`anthropic`, GLM→`glm`, Kimi→`kimi`, Qwen→`qwen3`, DeepSeek→`deepseek`, OpenAI/gpt-oss→`harmony`, else the `xml` fallback).
- Added `flux-1-schnell-fp8` to the Fireworks serverless model catalog
- Added `gpt-oss-20b` to the Fireworks model catalog
- Added `qwen3-embedding-8b` to the Fireworks model catalog
- Added `qwen3-reranker-8b` to the Fireworks model catalog
- Added `Gemma 4 E2B IT` and `Gemma 4 E4B IT` to the Google model catalog
- Added `qwen/qwen3-asr-flash` to the Zenmux model catalog
- Added sparse `supportsTools` model metadata so providers can mark models that require in-band tool-call formatting.

### Changed

- Kept non-tool-capable Fireworks serverless models in discovery results and marked them with `supportsTools: false` for fallback-aware handling
- Extended structured classification to cover older Claude/OpenAI forms such as `claude-3-5-sonnet-20241022` and `gpt-4o`.

## [15.13.1] - 2026-06-15

### Added

- Added coarse vendor-lineage classification (`anthropic`/`openai`/`gemini`/`kimi`/…) to `@oh-my-pi/pi-catalog/identity` for "are two models the same family?" comparisons, with namespace normalization and kind/variant collapse ([#2406](https://github.com/can1357/oh-my-pi/issues/2406))

### Changed

- Changed catalog metadata to update a model’s per-token pricing to input 0.09 and output 0.18
- Changed the same cataloged model’s maximum token limit from 384000 to 65536

### Fixed

- Fixed MiniMax-M3 catalog context for `minimax` and `minimax-cn` to report the documented 1M long-context tier instead of the upstream 512K pricing boundary ([#2576](https://github.com/can1357/oh-my-pi/issues/2576)).
- Fixed OpenCode Go MiMo catalog metadata so title generation and other tool-enabled calls omit unsupported `tool_choice` instead of triggering provider 400s ([#2509](https://github.com/can1357/oh-my-pi/issues/2509)).
- Fixed OpenCode Go `kimi-k2.7-code` catalog metadata so resolve-gate requests use automatic tool selection instead of Moonshot-rejected forced `tool_choice` ([#2546](https://github.com/can1357/oh-my-pi/issues/2546)).
- Fixed Anthropic compat for the `github-copilot` host so `supportsEagerToolInputStreaming` defaults to `false` there, matching the Copilot proxy which rejects the per-tool `eager_input_streaming` field ([#2558](https://github.com/can1357/oh-my-pi/issues/2558)).
- Scoped vLLM model cache validity to the discovery base URL so changed endpoints refetch immediately, and bounded built-in vLLM discovery requests with a timeout.

## [15.12.6] - 2026-06-14

### Added

- Added GLM-5.2 to the bundled zai (GLM Coding Plan) catalog as the selectable 1M served model.

### Changed

- Pinned zai `glm-5.2` to 1M context during catalog generation so endpoint discovery and older fallbacks cannot regress it to 200k.
- Replaced the hand-maintained `zhipu-coding-plan` GLM reasoning allowlist and vision regex with structured GLM class, family, and revision facts. Discovery now derives reasoning/vision capability from the GLM family instead of a per-id list, so newly-bumped integers (`glm-5.3`, `glm-6`, …) are covered automatically while `-flash`/`-preview` and the vision `…v` shape stay correctly classified.

## [15.12.4] - 2026-06-13

### Added

- Added bundled Fireworks models `deepseek-v4-flash`, `kimi-k2.7-code`, `minimax-m2.5`, `minimax-m3`, `nemotron-3-ultra-nvfp4`, `qwen3.6-plus`, and `qwen3.7-plus`
- Changed

### Changed

- Model `contextWindow`/`maxTokens` are now `number | null`; discovery emits `null` when a provider reports no limit, replacing the `222222`/`8888` (`UNK_CONTEXT_WINDOW`/`UNK_MAX_TOKENS`) sentinels (now removed). Bundled `models.json` unknown limits are `null`.
- Changed the `github-copilot` model context window to `524288` tokens
- Changed Fireworks model discovery to source the control-plane `List Models` API (`GET /v1/accounts/fireworks/models?filter=supports_serverless=true`) instead of the OpenAI-compatible `/v1/models` inference listing. The inference endpoint returns a sparse, account-specific subset that omits on-demand serverless models (e.g. `kimi-k2.7-code`), so newly published serverless models stayed invisible in the picker until hand-added to the bundled catalog. The control-plane catalog enumerates every serverless model with capability metadata (`supportsServerless`/`supportsTools`/`supportsImageInput`/`contextLength`/`displayName`), paginated and filtered to tool-capable `READY` entries, then merged with bundled/models.dev references — the Kimi K2 max-output clamp and DeepSeek V4 thinking-toggle strip are preserved, and unbundled models default to reasoning so `buildModel` derives the Fireworks effort map. New serverless releases now surface automatically with no catalog edits.

### Fixed

- Filled missing `contextWindow` and `maxTokens` in generated `models.json` for proxy/reseller variants by inheriting limits from canonical-family and segment-reference models
- Ignored zero-cost `x-ai` subscription entries as reference sources when backfilling limits so inflated values are not propagated
- Fixed the model cache opening with `PRAGMA journal_mode=WAL` before `PRAGMA busy_timeout`, so concurrent omp startups could crash inside `getDb()` on `SQLITE_BUSY` during WAL recovery instead of waiting through the transient lock. The busy handler is now installed before the first lock-taking statement ([#2421](https://github.com/can1357/oh-my-pi/issues/2421)).

## [15.11.8] - 2026-06-12

### Fixed

- Fixed Antigravity `gemini-3.1-pro --thinking high` failing with `Cloud Code Assist API error (400): Request contains an invalid argument.` — the upstream `gemini-3.1-pro-high` deployment rejects every `streamGenerateContent` request on both CCA endpoints while discovery still advertises it. High effort now routes to `gemini-pro-agent` (the same "Gemini 3.1 Pro (High)" model, verified accepting the identical request body), and the model-cache fingerprint version was bumped (`merge-v2` → `merge-v3`) so existing fresh caches refetch discovery and pick up the corrected routing immediately.

## [15.11.7] - 2026-06-12

### Added

- Added effort-tier variant collapsing (`variant-collapse`): providers that expose one logical model as several effort/thinking-suffixed upstream ids (Antigravity CCA `gemini-3.5-flash-extra-low`/`-low`/`gemini-3-flash-agent`, `gemini-3[.1]-pro-low|high`, `claude-*[-thinking]` pairs, `gpt-oss-120b-medium`) collapse into one logical entry carrying per-effort upstream routing in `thinking.effortRouting` (plus `thinking.suppressWhenOff` for Cloud Code Assist ids whose baked server default re-applies when `thinkingConfig` is omitted). Request-time code resolves the outbound id via `resolveWireModelId(model, effort)`; selection, caching, and usage attribution key on the logical id.
- Added the automatic `X`/`X-thinking` pair rule (`deriveThinkingPairFamilies`): any provider's live bare/thinking twin collapses into the bare id, routing thinking-enabled requests to the `-thinking` backing id (trailing or infix token, so `kimi-k2-thinking-turbo` pairs with `kimi-k2-turbo`). Gated on same api and compatible pricing — all-zero cost rows count as unknown, while twins that both carry real, differing prices remain separate SKUs.
- Added `collapseBuiltModelVariants` and wired collapsing at every materialization point — Antigravity discovery, the catalog generator, and the model-manager merge — so stale sources (old static beside collapsed dynamic results, mixed cache rows) converge on logical entries instead of unioning raw tier ids back into the catalog.
- Added `thinking.requiresEffort`, baked for reasoning-only upstreams — Gemini 3.x (levels only, no off), Gemini 2.5 Pro (thinkingBudget floors at 128, rejects 0), OpenAI o-series, MiniMax M2, and thinking-variant SKUs (`*-thinking`/`*-reasoner`/`*-reasoning`, with a negation-aware token grammar so `non-thinking` ids never match). Identity derivation bakes it for new entries and `fillThinkingWireDefaults` backfills explicit/cached metadata; `minimumSupportedEffort` exposes the canonical floor. Pair-collapsed twins drop member flags (their off routes to the bare SKU), while identity re-flags pairs whose logical id is itself mandatory

### Changed

- Changed model display names to drop model-extrinsic decorations: gateway author prefixes (`OpenAI: …`, `Google: …`), `(latest)` alias markers, `(Antigravity)` provider attribution, price tiers (`($$$$)`), and promo/lifecycle tags (`(20% off)`, `(retires …)`). `cleanModelName` is applied in `buildModel` (covers live discovery and stale caches) and as a catalog-generator pass; Antigravity discovery no longer appends `(Antigravity)` to display names. Variant tags that map to distinct wire ids (`(Thinking)`, `(free)`, `(Fast)`, dates, regions) are preserved.
- Changed the `google-antigravity` default model from `gemini-3-pro-high` to `gemini-3.1-pro`
- Changed `gemini-2.5-flash-thinking` handling from discovery-denylist to collapsing into `gemini-2.5-flash` (thinking-enabled requests route to the `-thinking` backing id)
- Bumped the model cache schema to v5 so rows predating effort-tier variant collapsing (raw `-low`/`-high`/`-thinking` member ids) are invalidated

### Fixed

- Fixed catalog generation to apply effort-tier variant collapsing before provider grouping to ensure collapsed model families are consistently materialized without being impacted by in-loop mutation
- Fixed Kimi K2.6 OpenAI-compatible compat metadata to use a 300s stream watchdog floor, covering Fire Pass router ids as well as public `kimi-k2.6` ids so long reasoning starts do not hit the generic first-event timeout ([#2366](https://github.com/can1357/oh-my-pi/issues/2366)).

## [15.11.4] - 2026-06-12

### Fixed

- Fixed MiniMax M2-family and OpenAI gpt-oss model metadata so OpenAI-compatible catalog entries declare only `low|medium|high` thinking efforts. Their upstreams reject `minimal`, `xhigh`, and Fireworks' `minimal → none` wire mapping, so `fireworks/minimax-m2.7` as the smol auto-thinking classifier model 400ed on every turn. OpenAI-compatible provider effort maps (`Groq qwen/qwen3-32b`, DeepSeek-family, OpenRouter Anthropic adaptive, Fireworks `minimal → none`) now bake into `thinking.effortMap` in catalog metadata instead of `buildOpenAICompat`, and request builders read that field directly. Regenerated `models.json` now makes `disableReasoning` choose `low` for those families while leaving GLM-5.x and other Fireworks models on the existing `minimal → none` path ([#2315](https://github.com/can1357/oh-my-pi/issues/2315)).

### Added

- Added `requiresJuiceZeroHack` Responses-API compat flag, resolved by `buildOpenAIResponsesCompat` from GPT-5-family model names and overridable via sparse model `compat` config. Replaces the request-time `model.name.startsWith("gpt-5")` sniff that gated the trailing `# Juice: 0 !important` no-reasoning developer item.

## [15.11.3] - 2026-06-11

### Added

- Added `requestModelId` on `Model` to represent the upstream model id used when a catalog entry is a local variant
- Added synthetic GitHub Copilot long-context model variants with `-1m` suffixes when tiered token pricing is advertised

### Changed

- Changed GitHub Copilot discovery to request `X-GitHub-Api-Version: 2026-06-01` from `api.githubcopilot.com`
- Changed GitHub Copilot discovery to cap base model `contextWindow` to the default token tier and keep long-context access as the separate `-1m` model entry
- Changed Copilot model mapping to omit non-chat `/models` entries and enable image input for models whose capabilities indicate vision support

### Fixed

- Fixed long-context variant pricing to use `billing.token_prices.long_context` rates instead of default model pricing
- Fixed `mapModel` handling in OpenAI-compatible discovery so returning `null` now skips a model entry rather than falling back to defaults
- Fixed model ID precedence so a real upstream Copilot model id is kept when it conflicts with a synthesized `-1m` variant

## [15.11.1] - 2026-06-11

### Fixed

- Fixed NVIDIA NIM Qwen turns failing with `400 Validation: Unsupported parameter(s): enable_thinking`. NIM's chat-completions schema is `additionalProperties: false` and exposes thinking via the vLLM convention `chat_template_kwargs.enable_thinking`; `buildOpenAICompat` was sending top-level `enable_thinking` for every `qwen/*` id regardless of host. Registered `nvidia` as a known host (`integrate.api.nvidia.com`) and routed NVIDIA-hosted Qwen models to `thinkingFormat: "qwen-chat-template"` ([#2299](https://github.com/can1357/oh-my-pi/issues/2299)).
- Fixed Moonshot/Kimi native OpenAI-compatible request metadata so Kimi K2 uses `max_tokens` and omits OpenAI-only `store`, restoring first-turn output with `MOONSHOT_API_KEY` ([#2289](https://github.com/can1357/oh-my-pi/issues/2289)).

## [15.11.0] - 2026-06-10

### Fixed

- Fixed `buildModel` so malformed explicit thinking metadata without `efforts` is treated as sparse input and inferred instead of crashing during model resolution ([#2251](https://github.com/can1357/oh-my-pi/issues/2251)).

## [15.10.12] - 2026-06-10

### Added

- Added `grok-composer-2.5-fast` (Cursor "Composer 2.5 Fast") to the xAI Grok OAuth (SuperGrok) catalog: non-reasoning, text-only, 200K context.

### Changed

- Set every xAI Grok OAuth (SuperGrok) curated model's max output tokens to mirror its context window (`grok-build`, `grok-4.3`, `grok-4.20-0309-{reasoning,non-reasoning}`, `grok-4.20-multi-agent-0309`, `grok-composer-2.5-fast`), replacing the `8888` `UNK_MAX_TOKENS` placeholder (and a stale `30000` on three grok-4.x entries). xAI's OAuth `/v1/models` reports no per-request output limit, so the curated catalog now owns `maxTokens` like `contextWindow`, deterministic on both the static-seed and online-overlay paths; the `openai-responses` wire still clamps the actual request to `OPENAI_MAX_OUTPUT_TOKENS` (64k).

### Fixed

- Excluded zero-cost `xai-oauth` subscription entries from the model reference indexes (`buildModelReferenceIndex`, `createReferenceResolver`), so their zero pricing and context-window-sized `maxTokens` cannot outrank paid/public Grok references when resolving custom-provider model identities.

## [15.10.11] - 2026-06-10

### Added

- Added `hostMatchesUrl`, `modelMatchesHost`, and endpoint-shape helpers in the new `hosts` module for consistent provider/baseUrl matching
- `buildModel(spec)` (`build.ts`) is now the single Model constructor: it materializes the fully-resolved compat record and canonical thinking metadata exactly once (compat first, thinking derived from identity + resolved compat), so `Model.compat` is a required, complete `CompatOf<TApi>` (`ResolvedOpenAICompat`/`ResolvedOpenAIResponsesCompat`/`ResolvedAnthropicCompat`) and request-path code reads fields with zero URL parsing and zero per-request allocation. Sparse user/config overrides live on the new `ModelSpec<TApi>` input shape and survive on `Model.compatConfig` for introspection.
- Added `ResolvedAnthropicCompat.supportsSamplingParams` (Opus 4.7+/Fable/Mythos reject `temperature`/`top_p`/`top_k` with a 400), baked at build time from model identity so the request path stops re-parsing model ids.
- Compat detection gained model-time flags so handlers stop sniffing baseUrl: completions `supportsReasoningParams`, `alwaysSendMaxTokens`, `isOpenRouterHost`, `isVercelGatewayHost`, `streamIdleTimeoutMs`, and a precomputed `whenThinking` alternate view (OpenCode `reasoning_content` gating, #1071/#1484); responses `strictResponsesPairing`, `supportsLongPromptCacheRetention`, `supportsReasoningEffort`; anthropic `officialEndpoint`, `requiresToolResultId`, `replayUnsignedThinking`.
- New `@oh-my-pi/pi-catalog` package: the model catalog extracted from `@oh-my-pi/pi-ai`. Owns the bundled `models.json` and its generation pipeline (`scripts/generate-models.ts`), the core model data types (`Model`, `Api`, `ThinkingConfig`, `Effort`, `Usage`, compat interfaces), thinking metadata enrichment and generated policies (`model-thinking.ts`), the SQLite model cache and model manager, per-provider discovery factories (`provider-models/`), the discovery protocol clients (`discovery/`), and the new `CATALOG_PROVIDERS` table — the single source of truth for provider ids, default models, and discovery wiring (`KnownProvider`, `PROVIDER_DESCRIPTORS`, and `DEFAULT_MODEL_PER_PROVIDER` are derived from it).
- New `identity/` module centralizing model-identity concerns that were previously duplicated across packages: structured taxonomy classification and revisions, proxy/reseller reference lookup (`identity/reference.ts`), bracket-affix and id-segment helpers (`identity/id.ts`), and provider priority ordering (`identity/priority.ts`).
- Memoized bundled-reference accessors (`getBundledCanonicalReferenceData` / `getBundledModelReferenceIndex` in `identity/bundled.ts`): one lazy walk of the bundled catalog feeds both canonical equivalence and proxy-reference lookup, so consumers no longer hand-roll the glue.
- `identity/selection.ts`: pure canonical-variant selection (`resolveCanonicalVariant`, `buildCanonicalModelOrder`, `CanonicalVariantPreferences`) extracted from the coding-agent registry — provider rank, then exact-id match, variant source, id length, and candidate order.

### Changed

- Changed OpenAI compatibility detection to use shared host classifiers (`modelMatchesHost`/`hostMatchesUrl`) with normalized matching instead of raw URL substring checks
- Changed `hostMatchesUrl`/`modelMatchesHost` usage in compatibility detection to reduce mismatches across case variants and provider alias hosts
- Provider catalog entries now carry the runtime API-key env fallback as an ordered `envVars` list; `catalogDiscovery.envVars` became an optional generation-time override (only `cursor` and `vercel-ai-gateway` differ) and `PROVIDER_DESCRIPTORS` materializes the resolved list for `generate-models.ts`.
- `Model`'s api parameter now defaults to `Api` instead of `any` (`Model<TApi extends Api = Api>`), so bare `Model` no longer behaves as `Model<any>` at call sites.
- `ThinkingConfig` is now explicit and total: an ordered `efforts` array replaces the `minLevel`/`maxLevel`/`levels` range encoding, and the wire facts are baked alongside it — `effortMap` (anthropic-adaptive 4-tier vs 5-tier scale, shared with the OpenRouter completions remap) and `supportsDisplay` (adaptive `display` field support). Explicit spec thinking owns the capability surface (`mode`/`efforts`/`defaultLevel`) and wins over inference; missing wire facts are backfilled from identity so configs never need to know Anthropic's tier tables. Reasoning models that reject the wire effort param (`compat.supportsReasoningEffort: false` on openai-responses*) are encoded as `thinking: undefined` ("thinks, no control surface") instead of the removed `modelOmitsReasoningEffort` special case. `models.json` was re-baked in the new vocabulary behind a 3196-model behavioral parity gate, and the model cache schema bumped to v4 to invalidate old-shape rows.
- `mapEffortToGoogleThinkingLevel(effort)` is now a static map (model parameter dropped — validation stays at the `requireSupportedEffort` call sites), and `mapEffortToAnthropicAdaptiveEffort` reads the baked `thinking.effortMap` instead of re-classifying the model id per request.
- Generator-only policy code moved out of the runtime bundle into `scripts/generated-policies.ts`: `applyGeneratedModelPolicies` (now policy fixups + thinking re-bake via the shared deriver), `linkOpenAIPromotionTargets`, the Copilot context-window table, minimax/opencode-go compat fixups, and `CLOUDFLARE_FALLBACK_MODEL`. Anthropic generation checks moved to structured class, family, and revision facts for build-time use by the compat/thinking derivers only.

### Fixed

- Fixed Anthropic official-endpoint detection to require strict HTTPS hostname matching so non-official or lookalike URLs are no longer treated as official Anthropic hosts
- Fixed Ollama Cloud dynamic discovery so same-id matches from other providers no longer supply context-window or max-output-token limits for discovered models.
- Wired `@oh-my-pi/pi-catalog` into the release publish package list, tarball install smoke test, and root `bun generate-models` script.
- Fixed adaptive-display classification only matching dash-form version ids: dotted ids (`claude-opus-4.7`) now classify through the structured taxonomy, so six bundled dotted Opus 4.7/4.8 entries (github-copilot, vercel-ai-gateway, zenmux) regain adaptive `display` support; bare dated ids (`claude-opus-4-20250514` = Opus 4.0) stay excluded.
- Fixed the OpenRouter anthropic adaptive-effort map misclassifying bare dated Opus ids (`claude-opus-4-20250514` parsed as version 4.20 → wrongly adaptive); the map now derives from the shared classifier and the shared 4-/5-tier tables.

### Removed

- Removed the runtime enrichment layer: `enrichModelThinking` (and its non-enumerable memo-slot cache), `refreshModelThinking`, `modelOmitsReasoningEffort`, and the `model-thinking` re-exports of generator-only policies. Thinking metadata is resolved exactly once inside `buildModel`; runtime helpers (`getSupportedEfforts`, `clampThinkingLevelForModel`, `requireSupportedEffort`, the effort mappers) are pure field reads.
