# Changelog

## [Unreleased]

## [16.4.13] - 2026-09-06

### Added

- Added the `alibaba-token-plan` provider catalog (QwenCloud Token Plan) with a curated static model seed aligned to the official Personal Edition "Supported models" table — `qwen3.8-max`, `qwen3.8-max-preview`, `qwen3.7-max`, `qwen3.7-plus`, `qwen3.6-flash`, `glm-5.2`, `deepseek-v4-pro`, `deepseek-v4-pro-0813`, and `deepseek-v4-flash-0731` — with region-locked discovery honoring the credential base URL, generation-time seeding plus name pinning, and a non-chat prefix filter for the multimodal (image/video/audio) APIs.
- Added `deepseek-v4-pro-0813` to the `alibaba-coding-plan` catalog seed with OpenAI-compatible completions and reasoning support.

### Fixed

- Fixed the Hugging Face integration to run any live router model: dynamic discovery now reads `router.huggingface.co/v1/models` with a dedicated mapper (per-provider `context_length`/`pricing`/modalities/`supports_tools`, cheapest live price, free deployments at zero cost, bundled-reference overlay for known ids) instead of the generic flat-field OpenAI-compatible parse that dropped all router metadata; the router list is now `dynamicModelsAuthoritative`, so a successful refresh prunes the 25 bundled-but-dead models instead of listing picks that 404 at request time; `generate-models.ts` bakes the same live snapshot into `models.json` (136 live models, 9 new ids added).

## [16.4.5] - 2026-08-21

### Fixed

- Added Antigravity variant collapse families and wire profiles for Anthropic models and GPT-OSS 120B.

## [16.4.4] - 2026-08-19

### Fixed

- Fixed `openai-codex/gpt-5.6-sol` to expose its 1,050,000-token context window and 128,000-token output limit instead of inheriting the generic 272,000-token Codex default.

## [16.4.3] - 2026-08-19

> **Note on `.omp` paths below.** The configuration directory was renamed to
> `~/.ompk` (and project-local `.omp/` to `.ompk/`). Entries dated before that
> rename still say `.omp` because that is what those releases actually shipped;
> they are left unedited so this history stays accurate. When following an older
> entry today, read `.omp` as `.ompk`.

## [16.4.2] - 2026-08-19

### Added

- Added the separate `cline-pass` subscription provider on Cline's OpenAI-compatible API, with a deterministic subscription-model seed and live refresh from Cline's recommended-models feed.

## [16.3.0] - 2026-07-23

### Added

- Added the Devin (`devin-agent`) catalog descriptor, credentialed runtime discovery, and an offline `swe-1-6` fallback model for startup before discovery completes.

## [16.2.3] - 2026-07-02

### Added

- Added the Cline gateway (`cline`) as an OpenAI-compatible model provider at `https://api.cline.bot/api/v1` with OpenRouter-style author-prefixed model ids and `CLINE_API_KEY` support. Cline is absent from models.dev and its `/v1/models` listing is auth-gated, so the bundle ships a small curated seed (default `anthropic/claude-sonnet-4-6`) that live discovery overlays after `/login cline`.

## [16.1.8] - 2026-06-20

### Added

- Added NVIDIA Diffusion Gemma (`google/diffusiongemma-26b-a4b-it`) to the bundled catalog for experimentation.

## [16.1.7] - 2026-06-20

### Fixed

- Fixed MiniMax-M3 catalog context for the MiniMax Coding/Token Plan providers `minimax-code` and `minimax-code-cn` to report the documented 1M long-context tier instead of the upstream 512K pricing boundary; the previous patch only covered `minimax`/`minimax-cn`, so the Coding Plan picker still showed 512K in the status bar ([#3097](https://github.com/can1357/oh-my-pi/issues/3097)).

## [16.1.4] - 2026-06-19

### Fixed

- Fixed Claude 4.6 routing on the `google-antigravity` (and `google-gemini-cli`) Cloud Code Assist providers, whose backend exposes the models asymmetrically: `claude-sonnet-4-6` has no `-thinking` twin and `claude-opus-4-6` has only the `-thinking` twin. The shared `thinkingPair` family was routing thinking efforts on `claude-sonnet-4-6` to a non-existent `claude-sonnet-4-6-thinking` wire id (404 `Requested entity was not found`); replaced both 4.6 entries with bespoke single-wire families that declare the dead ids as `retiredMembers` so `reconcileRetiredRouting` re-points stale bundled-catalog and SQLite-cache rows away from the 404 wire id. Refreshed the bundled `models.json` Sonnet 4.6 entry whose stored `effortRouting` still targeted the dead `-thinking` id. Added `claude-sonnet-4-6` and `claude-opus-4-6-thinking` entries to `ANTIGRAVITY_MODEL_WIRE_PROFILES` capped at the backend's 64000-output-token limit (over-cap requests 400'd with `Request contains an invalid argument`); `modelEnum` is now optional on `AntigravityModelWireProfile` since the Claude wire ids are accepted without a captured `labels.model_enum`. ([#3067](https://github.com/can1357/oh-my-pi/issues/3067))

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
- Fixed custom/direct `xai-oauth` Responses model specs (e.g. `grok-build`) emitting `reasoning.effort` and hitting xAI's HTTP 400: `buildOpenAIResponsesCompat` now defaults `supportsReasoningEffort` to `false` for `xai-oauth` Grok models that are off the effort-capable allowlist (`grok-3-mini`/`grok-4.20-multi-agent`/`grok-4.3`), matching the curated discovery path; explicit `compat.supportsReasoningEffort` still overrides. The allowlist moved to a shared `isGrokReasoningEffortCapable` identity helper consumed by both the compat builder and provider-model curation so the two cannot drift.

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

- Added the `ToolCallSyntax` union and `FALLBACK_TOOL_SYNTAX` constant to `@pk-nerdsaver-ai/pi-catalog/identity` (re-exported from `@pk-nerdsaver-ai/pi-ai/grammar`).
- Added `preferredToolSyntax(modelId)` to `@pk-nerdsaver-ai/pi-catalog/identity`, resolving a model's native tool-call syntax affinity from its family token (Claude→`anthropic`, GLM→`glm`, Kimi→`kimi`, Qwen→`qwen3`, DeepSeek→`deepseek`, OpenAI/gpt-oss→`harmony`, else the `xml` fallback).
- Added `flux-1-schnell-fp8` to the Fireworks serverless model catalog
- Added `gpt-oss-20b` to the Fireworks model catalog
- Added `qwen3-embedding-8b` to the Fireworks model catalog
- Added `qwen3-reranker-8b` to the Fireworks model catalog
- Added `Gemma 4 E2B IT` and `Gemma 4 E4B IT` to the Google model catalog
- Added `qwen/qwen3-asr-flash` to the Zenmux model catalog
- Added sparse `supportsTools` model metadata so providers can mark models that require in-band tool-call formatting.

### Changed

- Kept non-tool-capable Fireworks serverless models in discovery results and marked them with `supportsTools: false` for fallback-aware handling
- Extended `modelFamilyToken(modelId)` to classify Claude/OpenAI ids the structured parser misses (older dated forms such as `claude-3-5-sonnet-20241022` and `gpt-4o`), returning `anthropic`/`openai` instead of an empty token.

## [15.13.1] - 2026-06-15

### Added

- Added `modelFamilyToken(modelId)` to `@pk-nerdsaver-ai/pi-catalog/identity`: a coarse vendor-lineage token (`anthropic`/`openai`/`gemini`/`kimi`/…) for "are two models the same family?" comparisons, backed by `parseKnownModel` canonical-id normalization. Opaque and comparison-only; kind/variant collapsed onto the vendor token ([#2406](https://github.com/can1357/oh-my-pi/issues/2406))

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
- Replaced the hand-maintained `zhipu-coding-plan` GLM reasoning allowlist and vision regex with a `parseGlmModel` family classifier in `identity/classify.ts` (variant + vision + version), surfaced as `isReasoningGlmModelId` / `isGlmVisionModelId`. Discovery now derives reasoning/vision capability from the GLM family instead of a per-id list, so newly-bumped integers (`glm-5.3`, `glm-6`, …) are covered automatically while `-flash`/`-preview` and the vision `…v` shape stay correctly classified.

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
- New `@pk-nerdsaver-ai/pi-catalog` package: the model catalog extracted from `@pk-nerdsaver-ai/pi-ai`. Owns the bundled `models.json` and its generation pipeline (`scripts/generate-models.ts`), the core model data types (`Model`, `Api`, `ThinkingConfig`, `Effort`, `Usage`, compat interfaces), thinking metadata enrichment and generated policies (`model-thinking.ts`), the SQLite model cache and model manager, per-provider discovery factories (`provider-models/`), the discovery protocol clients (`discovery/`), and the new `CATALOG_PROVIDERS` table — the single source of truth for provider ids, default models, and discovery wiring (`KnownProvider`, `PROVIDER_DESCRIPTORS`, and `DEFAULT_MODEL_PER_PROVIDER` are derived from it).
- New `identity/` module centralizing model-identity concerns that were previously duplicated across packages: family classification and version parsing (`identity/classify.ts`, extracted from pi-ai's `model-thinking` internals), canonical model equivalence with injected reference data (`identity/equivalence.ts`, from coding-agent's `model-equivalence`), proxy/reseller reference lookup (`identity/reference.ts`, from coding-agent's `model-registry`), bracket-affix and id-segment helpers (`identity/id.ts`), a single trailing-marker vocabulary with canonical vs reference flavors (`identity/markers.ts` — `search` stays reference-only so Perplexity's `sonar-pro-search` remains canonical-distinct), and provider priority ordering (`identity/priority.ts`).
- Memoized bundled-reference accessors (`getBundledCanonicalReferenceData` / `getBundledModelReferenceIndex` in `identity/bundled.ts`): one lazy walk of the bundled catalog feeds both canonical equivalence and proxy-reference lookup, so consumers no longer hand-roll the glue.
- `identity/selection.ts`: pure canonical-variant selection (`resolveCanonicalVariant`, `buildCanonicalModelOrder`, `CanonicalVariantPreferences`) extracted from the coding-agent registry — provider rank, then exact-id match, variant source, id length, and candidate order.

### Changed

- Changed OpenAI compatibility detection to use shared host classifiers (`modelMatchesHost`/`hostMatchesUrl`) with normalized matching instead of raw URL substring checks
- Changed `hostMatchesUrl`/`modelMatchesHost` usage in compatibility detection to reduce mismatches across case variants and provider alias hosts
- Provider catalog entries now carry the runtime API-key env fallback as an ordered `envVars` list; `catalogDiscovery.envVars` became an optional generation-time override (only `cursor` and `vercel-ai-gateway` differ) and `PROVIDER_DESCRIPTORS` materializes the resolved list for `generate-models.ts`.
- `Model`'s api parameter now defaults to `Api` instead of `any` (`Model<TApi extends Api = Api>`), so bare `Model` no longer behaves as `Model<any>` at call sites.
- `ThinkingConfig` is now explicit and total: an ordered `efforts` array replaces the `minLevel`/`maxLevel`/`levels` range encoding, and the wire facts are baked alongside it — `effortMap` (anthropic-adaptive 4-tier vs 5-tier scale, shared with the OpenRouter completions remap) and `supportsDisplay` (adaptive `display` field support). Explicit spec thinking owns the capability surface (`mode`/`efforts`/`defaultLevel`) and wins over inference; missing wire facts are backfilled from identity so configs never need to know Anthropic's tier tables. Reasoning models that reject the wire effort param (`compat.supportsReasoningEffort: false` on openai-responses*) are encoded as `thinking: undefined` ("thinks, no control surface") instead of the removed `modelOmitsReasoningEffort` special case. `models.json` was re-baked in the new vocabulary behind a 3196-model behavioral parity gate, and the model cache schema bumped to v4 to invalidate old-shape rows.
- `mapEffortToGoogleThinkingLevel(effort)` is now a static map (model parameter dropped — validation stays at the `requireSupportedEffort` call sites), and `mapEffortToAnthropicAdaptiveEffort` reads the baked `thinking.effortMap` instead of re-classifying the model id per request.
- Generator-only policy code moved out of the runtime bundle into `scripts/generated-policies.ts`: `applyGeneratedModelPolicies` (now policy fixups + thinking re-bake via the shared deriver), `linkOpenAIPromotionTargets`, the Copilot context-window table, minimax/opencode-go compat fixups, and `CLOUDFLARE_FALLBACK_MODEL`. The anthropic id predicates (`hasOpus47ApiRestrictions`, `supportsMidConversationSystemMessages`, `isAnthropicFableOrMythosModel`) moved to `identity/family` for build-time use by the compat/thinking derivers only.

### Fixed

- Fixed Anthropic official-endpoint detection to require strict HTTPS hostname matching so non-official or lookalike URLs are no longer treated as official Anthropic hosts
- Fixed Ollama Cloud dynamic discovery so same-id matches from other providers no longer supply context-window or max-output-token limits for discovered models.
- Wired `@pk-nerdsaver-ai/pi-catalog` into the release publish package list, tarball install smoke test, and root `bun generate-models` script.
- Fixed `supportsAdaptiveThinkingDisplay` only matching dash-form version ids: dotted ids (`claude-opus-4.7`) now classify through `identity/classify` like every other anthropic predicate, so six bundled dotted Opus 4.7/4.8 entries (github-copilot, vercel-ai-gateway, zenmux) regain adaptive `display` support; bare dated ids (`claude-opus-4-20250514` = Opus 4.0) stay excluded.
- Fixed the OpenRouter anthropic adaptive-effort map misclassifying bare dated Opus ids (`claude-opus-4-20250514` parsed as version 4.20 → wrongly adaptive); the map now derives from the shared classifier and the shared 4-/5-tier tables.

### Removed

- Removed the runtime enrichment layer: `enrichModelThinking` (and its non-enumerable memo-slot cache), `refreshModelThinking`, `modelOmitsReasoningEffort`, and the `model-thinking` re-exports of generator-only policies. Thinking metadata is resolved exactly once inside `buildModel`; runtime helpers (`getSupportedEfforts`, `clampThinkingLevelForModel`, `requireSupportedEffort`, the effort mappers) are pure field reads.
