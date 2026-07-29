# Model and Provider Configuration (`models.yml`)

This document describes how the coding-agent currently loads models, applies overrides, resolves credentials, and chooses models at runtime.

## What controls model behavior

Primary implementation files:

- `src/config/model-registry.ts` — loads built-in + custom models, provider overrides, runtime discovery, auth integration
- `src/config/model-resolver.ts` — parses model patterns and selects initial/smol/slow models
- `src/config/settings-schema.ts` — model-related settings (`modelRoles`, provider transport preferences)
- `src/session/auth-storage.ts` — re-exports `AuthStorage` from `@pk-nerdsaver-ai/pi-ai` (`packages/ai/src/auth-storage.ts`); API key + OAuth resolution order
- `packages/catalog/src/models.ts` and `packages/catalog/src/types.ts` — built-in providers/models (`getBundledModels` / `getBundledProviders`) and `Model`/`compat` types

## Config file location and legacy behavior

Default config path:

- `~/.ompk/agent/models.yml`

Legacy behavior still present:

- If `models.yml` is missing and `models.json` exists at the same location, it is migrated to `models.yml`.
- Explicit `.json` / `.jsonc` config paths are still supported when passed programmatically to `ModelRegistry`.

## `models.yml` shape

```yaml
providers:
  <provider-id>:
    # provider-level config
equivalence:
  overrides:
    <provider-id>/<model-id>: <canonical-model-id>
  exclude:
    - <provider-id>/<model-id>
```

`provider-id` is the canonical provider key used across selection and auth lookup.

`equivalence` is optional and configures canonical model grouping on top of concrete provider models:

- `overrides` maps an exact concrete selector (`provider/modelId`) to an official upstream canonical id
- `exclude` opts a concrete selector out of canonical grouping

## Provider-level fields

```yaml
providers:
  my-provider:
    baseUrl: https://api.example.com/v1
    apiKey: MY_PROVIDER_API_KEY
    api: openai-completions
    headers:
      X-Team: platform
    authHeader: true
    auth: apiKey
    disableStrictTools: false # set true for Anthropic-compatible endpoints that reject the strict field
    discovery:
      type: ollama
    modelOverrides:
      some-model-id:
        name: Renamed model
    models:
      - id: some-model-id
        name: Some Model
        api: openai-completions
        reasoning: false
        input: [text]
        cost:
          input: 0
          output: 0
          cacheRead: 0
          cacheWrite: 0
        contextWindow: 128000
        maxTokens: 16384
        headers:
          X-Model: value
        compat:
          supportsStore: true
          supportsDeveloperRole: true
          supportsReasoningEffort: true
          maxTokensField: max_completion_tokens
          openRouterRouting:
            only: [anthropic]
          vercelGatewayRouting:
            order: [anthropic, openai]
          extraBody:
            gateway: m1-01
            controller: mlx
```

### Allowed provider/model `api` values

- `openai-completions`
- `openai-responses`
- `openai-codex-responses`
- `azure-openai-responses`
- `anthropic-messages`
- `google-generative-ai`
- `google-gemini-cli`
- `google-vertex`

### Allowed auth/discovery values

- `auth`: `apiKey` (default), `none`, or `oauth`; for `models.yml` custom models, `oauth` is accepted by schema but does not waive the `apiKey` requirement
- `discovery.type`: `ollama`, `llama.cpp`, `lm-studio`, `openai-models-list`, or `proxy`
- `transport`: `pi-native` only. When set, every model under that provider is sent to an `omp auth-gateway` compatible `baseUrl` via `POST /v1/pi/stream`; `apiKey` is the gateway bearer.

## Validation rules (current)

### Full custom provider (`models` is non-empty)

Required:

- `baseUrl`
- `apiKey` unless `auth: none`
- `api` at provider level or each model

### Override-only provider (`models` missing or empty)

Must define at least one of:

- `baseUrl`
- `apiKey`
- `auth: none`
- `headers`
- `compat`
- `disableStrictTools`
- `modelOverrides`
- `discovery`

### Discovery

- `discovery` requires provider-level `api`, except `discovery.type: proxy` (per-model wire auto-detected).

### Model value checks

- `id` required
- `contextWindow` and `maxTokens` must be positive if provided

### Command-resolved secrets

Provider `apiKey` values and provider/model `headers` values may start with `!` to read a secret from command stdout. The command is run with a 10 s timeout, stdout is trimmed, and empty/failing commands are omitted:

```yaml
providers:
  openai:
    apiKey: "!op read op://dev/openai/api-key"
    headers:
      X-Team-Key: "!bw get password omp-team-key"
```

Successful command outputs are cached for the process lifetime so the command is not re-run for every model.

## Merge and override order

ModelRegistry pipeline (on refresh):

1. Load built-in providers/models from `@pk-nerdsaver-ai/pi-catalog` (`getBundledProviders` / `getBundledModels`).
2. Load `models.yml` custom config.
3. Apply provider overrides (`baseUrl`, `headers`, `disableStrictTools`) to built-in models.
4. Apply `modelOverrides` (per provider + model id).
5. Merge custom `models`:
   - same `provider + id` replaces existing
   - otherwise append
6. Load cached/runtime-discovered models (Ollama, llama.cpp, LM Studio, plus built-in provider managers), then re-apply model overrides.

### Provider-model cache and static fingerprint

Cached per-provider model lists are persisted in the model-cache SQLite
database (current schema version 6) with a `static_fingerprint` column that
hashes the static catalog slice merged into the row. When `resolveProviderModels`
skips the network fetch and the fingerprint of the in-memory static
catalog matches the cached one, the cached rows are returned verbatim —
the static + dynamic merge is bypassed entirely. The fingerprint is
memoized per process by tagging the static-models array with a symbol
property, so repeated cold-start calls do not re-hash.

## Canonical model equivalence and coalescing

The registry keeps every concrete provider model and then builds a canonical layer above them.

Canonical ids are official upstream ids only, for example:

- `claude-opus-4-6`
- `claude-haiku-4-5`
- `gpt-5.3-codex`

### `models.yml` equivalence config

Example:

```yaml
providers:
  zenmux:
    baseUrl: https://api.zenmux.example/v1
    apiKey: ZENMUX_API_KEY
    api: openai-codex-responses
    models:
      - id: codex
        name: Zenmux Codex
        reasoning: true
        input: [text]
        cost:
          input: 0
          output: 0
          cacheRead: 0
          cacheWrite: 0
        contextWindow: 200000
        maxTokens: 32768

equivalence:
  overrides:
    zenmux/codex: gpt-5.3-codex
    p-codex/codex: gpt-5.3-codex
  exclude:
    - demo/codex-preview
```

Build order for canonical grouping:

1. exact user override from `equivalence.overrides`
2. bundled official-id matches from built-in model metadata
3. conservative heuristic normalization for gateway/provider variants
4. fallback to the concrete model's own id

Current heuristics are intentionally narrow:

- embedded upstream prefixes can be stripped when present, for example `anthropic/...` or `openai/...`
- dotted and dashed version variants can normalize only when they map to an existing official id, for example `4.6 -> 4-6`
- ambiguous families or versions are not merged without a bundled match or explicit override

### Canonical resolution behavior

When multiple concrete variants share a canonical id, resolution uses:

1. availability and auth
2. `config.yml` `modelProviderOrder`
3. existing registry/provider order if `modelProviderOrder` is unset

Disabled or unauthenticated providers are skipped.

Session state and transcripts continue to record the concrete provider/model that actually executed the turn.

Provider defaults vs per-model overrides:

- Provider `headers` are baseline.
- Model `headers` override provider header keys.
- `modelOverrides` can override model metadata (`name`, `reasoning`, `thinking`, `input`, `supportsTools`, `cost`, `premiumMultiplier`, `contextWindow`, `maxTokens`, `omitMaxOutputTokens`, `headers`, `compat`, `contextPromotionTarget`).
- `compat` is deep-merged for nested routing blocks (`openRouterRouting`, `vercelGatewayRouting`, `extraBody`).

## Runtime discovery integration

### Implicit Ollama discovery

If `ollama` is not explicitly configured, registry adds an implicit discoverable provider:

- provider: `ollama`
- api: `openai-responses`
- base URL: `OLLAMA_BASE_URL`, or `OLLAMA_HOST`, or `http://127.0.0.1:11434`
- context window: `OLLAMA_CONTEXT_LENGTH` if set, otherwise Ollama `/api/show` metadata, otherwise `128000`
- auth mode: keyless (`auth: none` behavior)

Runtime discovery calls Ollama endpoints and normalizes discovered OpenAI-compatible models to `openai-responses`.

`OLLAMA_CONTEXT_LENGTH` does not configure Ollama's runtime `num_ctx`; set that in Ollama/model configuration separately.

### Implicit llama.cpp discovery

If `llama.cpp` is not explicitly configured, registry adds an implicit discoverable provider:

- provider: `llama.cpp`
- api: `openai-responses`
- base URL: `LLAMA_CPP_BASE_URL` or `http://127.0.0.1:8080`
- auth mode: keyless (`auth: none` behavior)

Runtime discovery calls llama.cpp model endpoints and synthesizes model entries with local defaults.

### Implicit LM Studio discovery

If `lm-studio` is not explicitly configured, registry adds an implicit discoverable provider:

- provider: `lm-studio`
- api: `openai-completions`
- base URL: `LM_STUDIO_BASE_URL` or `http://127.0.0.1:1234/v1`
- auth mode: keyless (`auth: none` behavior)

Runtime discovery fetches models (`GET /models`) and synthesizes model entries with local defaults.

This path also works for local OpenAI-compatible servers that are not LM Studio. For example, if oMLX is bound to Ollama's usual port, set `LM_STUDIO_BASE_URL=http://127.0.0.1:11434/v1` to discover it through the existing `/v1/models` flow. Running oMLX and Ollama side by side requires assigning a different port to one of them. Do not configure oMLX as `ollama`: Ollama discovery uses native `/api/tags` and `/api/show` endpoints, not OpenAI `/v1/models`.

### LiteLLM provider discovery

When `litellm` is active (for example through `LITELLM_API_KEY` or stored auth), runtime discovery uses the LiteLLM proxy:

- provider: `litellm`
- api: `openai-completions`
- base URL: explicit provider `baseUrl` / `models.yml` config, otherwise `LITELLM_BASE_URL`, otherwise `http://localhost:4000/v1`
- auth mode: `LITELLM_API_KEY` or stored LiteLLM auth when the proxy requires a key

Runtime discovery fetches models (`GET /models`) from the proxy and enriches bare LiteLLM model ids against bundled reference metadata when available.

### Explicit provider discovery

You can configure discovery yourself:

```yaml
providers:
  ollama:
    baseUrl: http://127.0.0.1:11434
    api: openai-responses
    auth: none
    discovery:
      type: ollama

  llama.cpp:
    baseUrl: http://127.0.0.1:8080
    api: openai-responses
    auth: none
    discovery:
      type: llama.cpp
```

### Proxy discovery (`discovery.type: proxy`)

For Anthropic+OpenAI-compatible proxies (new-api / one-api / similar)
that expose both `/v1/messages` and `/v1/chat/completions` behind the same
host. Discovery hits `GET /v1/models` (10s timeout, OpenAI-style payload) and
derives each model's `api` from the entry's `supported_endpoint_types`:

- contains `"anthropic"` -> `api: anthropic-messages` (routes via `/v1/messages`)
- contains `"openai"` -> `api: openai-completions` (routes via `/v1/chat/completions`)
- otherwise -> falls back to provider-level `api` if set, else dropped

Provider-level `api` is **optional** with `discovery.type: proxy` because the
per-model wire is auto-detected. The Anthropic SDK strips a trailing `/v1`
from `baseUrl` before appending `/v1/messages`, so a single discovery `baseUrl`
(ending in `/v1`) round-trips correctly to both wires.

```yaml
providers:
  newapi-reseller:
    baseUrl: https://api.example.com/v1
    apiKey: xxxx
    authHeader: true # injects Authorization: Bearer for openai models
    disableStrictTools: true # most anthropic-fronted proxies reject `strict`
    discovery:
      type: proxy
```

### Extension provider registration

Extensions can register providers at runtime (`pi.registerProvider(...)`), including:

- model replacement/append for a provider
- custom stream handler registration for new API IDs
- custom OAuth provider registration

## Auth and API key resolution order

When requesting a key for a provider, effective order is:

1. Runtime override (CLI `--api-key`)
2. Stored API key credential in `agent.db`
3. Stored OAuth credential in `agent.db` (with refresh)
4. Environment variable mapping (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, etc.)
5. ModelRegistry fallback resolver (provider `apiKey` from `models.yml`, env-name-or-literal semantics)

`models.yml` `apiKey` behavior:

- Value is first treated as an environment variable name.
- If no env var exists, the literal string is used as the token.

If `authHeader: true` and provider `apiKey` is set, models get:

- `Authorization: Bearer <resolved-key>` header injected.

Keyless providers:

- Providers marked `auth: none` are treated as available without credentials.
- `getApiKey*` returns `kNoAuth` for them.

### Broker mode

When `OMP_AUTH_BROKER_URL` (or `auth.broker.url`) is set, the local SQLite credential store is replaced by `RemoteAuthCredentialStore`. Layers 2 and 3 above (stored API key / OAuth in `agent.db`) are served from a broker-supplied snapshot whose `refresh` tokens are redacted; expiry triggers `POST /v1/credential/:id/refresh` on the broker rather than a local refresh.

`AuthStorage.setConfigApiKey` lets a `models.yml` `apiKey` win over a broker-resolved OAuth token without overriding a runtime `--api-key`. See [`auth-broker-gateway.md`](./auth-broker-gateway.md) for the full broker / gateway design and env surface (`OMP_AUTH_BROKER_URL`, `OMP_AUTH_BROKER_TOKEN`, `auth.broker.url`, `auth.broker.token`).

## Model availability vs all models

- `getAll()` returns the loaded model registry (built-in + merged custom + discovered).
- `getAvailable()` filters to models that are keyless or have resolvable auth.

So a model can exist in registry but not be selectable until auth is available.

## Runtime model resolution

### CLI and pattern parsing

`model-resolver.ts` supports:

- exact `provider/modelId`
- exact canonical model id
- exact model id (provider inferred)
- fuzzy/substring matching
- glob scope patterns in `--models` (e.g. `openai/*`, `*sonnet*`)
- optional `:thinkingLevel` suffix (`off|minimal|low|medium|high|xhigh`)

`--provider` is legacy; `--model` is preferred.

Resolution precedence for exact selectors:

1. exact `provider/modelId` bypasses coalescing
2. exact canonical id resolves through the canonical index
3. exact bare concrete id still works
4. fuzzy and glob matching run after the exact paths

### Initial model selection priority

`findInitialModel(...)` uses this order:

1. explicit CLI provider+model
2. first scoped model (if not resuming)
3. saved default provider/model
4. known provider defaults (e.g. OpenAI/Anthropic/etc.) among available models
5. first available model

### Role aliases and settings

Supported model roles:

- `default`, `smol`, `slow`, `vision`, `plan`, `designer`, `commit`, `title`, `task`, `advisor`

Role aliases like `pi/smol` expand through `settings.modelRoles`. Each role value can also append a thinking selector such as `:minimal`, `:low`, `:medium`, or `:high`.

If a role points at another role, the target model still inherits normally and any explicit suffix on the referring role wins for that role-specific use.

Related settings:

- `modelRoles` (record)
- `enabledModels` (scoped pattern list)
- `modelProviderOrder` (global canonical-provider precedence)
- `providers.kimiApiFormat` (`openai` or `anthropic` request format)
- `providers.openaiWebsockets` (`auto|off|on` websocket preference for OpenAI Codex transport)

`modelRoles` may store either:

- `provider/modelId` to pin a concrete provider variant
- a canonical id such as `gpt-5.3-codex` to allow provider coalescing

For `enabledModels` and CLI `--models`:

- exact canonical ids expand to all concrete variants in that canonical group
- explicit `provider/modelId` entries stay exact
- globs and fuzzy matches still operate on concrete models

Global `enabledModels` and `disabledProviders` entries may also be scoped to a path prefix:

```yaml
enabledModels:
  - claude-sonnet-4-5
  - path: ~/work
    models:
      - anthropic/claude-opus-4-5
disabledProviders:
  - ollama
  - path: ~/private
    providers:
      - anthropic
```

String entries apply everywhere. Scoped entries apply when the current working directory is the configured path or one of its subdirectories. Use `path`, `paths`, `pathPrefix`, or `pathPrefixes`; use `models` for `enabledModels`, `providers` for `disabledProviders`, or `values` for either.

### Subagent model aliases

Subagent model aliases allow mapping user-defined names to concrete model selectors for spawned subagents (via `/subagent using <alias>` or `/delegate using <alias>`).

The interactive quick-launch form accepts both the model selector and prompt:

```text
/subagent using <alias-or-model> "Investigate the Agent Hub regression"
```

It resolves the model immediately, pre-fills the quoted task, inherits the parent thinking level, and asks only for an optional name. Press `Enter` on the empty name field to use the generated name and launch. The plain `/subagent` form retains the full model, thinking, name, color, and task wizard.

Built-in subagent model aliases:
- `browser-fast` maps to `google/gemini-2.5-flash-lite`. It is the recommended fast model for bounded browser executor tasks.

You can customize these aliases via the `subagent.modelAliases` setting in your `config.yml` or settings file:

```yaml
subagent:
  modelAliases:
    browser-fast: "google/gemini-2.5-flash-lite"
    my-fast-model: "openrouter/google/gemini-2.5-flash-lite"
```

Aliases can point to any available model selector discovered by `oh-my-pk models find`.

## `/model` and `oh-my-pk models`

Both surfaces keep provider-prefixed models visible and selectable.

They now also expose canonical/coalesced models:

- `/model` includes a canonical view alongside provider tabs
- `oh-my-pk models` prints provider-grouped tables of every concrete model, and `oh-my-pk models canonical` prints the coalesced canonical view

Selecting a canonical entry stores the canonical selector. Selecting a provider row stores the explicit `provider/modelId`.

## Context promotion (model-level fallback chains)

Context promotion is an overflow recovery mechanism for small-context variants (for example `*-spark`) that automatically promotes to a larger-context sibling when the API rejects a request with a context length error.

### Trigger and order

When a turn fails with a context overflow error (e.g. `context_length_exceeded`), `AgentSession` attempts promotion **before** falling back to compaction:

1. If `contextPromotion.enabled` is true, resolve a promotion target (see below).
2. If a target is found, switch to it and retry the request — no compaction needed.
3. If no target is available, fall through to auto-compaction on the current model.

### Target selection

Selection is model-driven, not role-driven:

1. `currentModel.contextPromotionTarget` (if configured)
2. smallest larger-context model on the same provider + API

Candidates are ignored unless credentials resolve (`ModelRegistry.getApiKey(...)`).

### OpenAI Codex websocket handoff

If switching from/to `openai-codex-responses`, session provider state key `openai-codex-responses` is closed before model switch. This drops websocket transport state so the next turn starts clean on the promoted model.

### Persistence behavior

Promotion uses temporary switching (`setModelTemporary`):

- recorded as a temporary `model_change` in session history
- does not rewrite saved role mapping

### Configuring explicit fallback chains

Configure fallback directly in model metadata via `contextPromotionTarget`.

`contextPromotionTarget` accepts either:

- `provider/model-id` (explicit)
- `model-id` (resolved within current provider)

Example (`models.yml`) for an explicit OpenAI fallback:

```yaml
providers:
  openai-codex:
    modelOverrides:
      gpt-5.5:
        contextPromotionTarget: openai-codex/gpt-5.4
```

The built-in model policy currently links OpenAI `codex-spark` variants to `gpt-5.5`, and `gpt-5.5` to `gpt-5.4`, when that target exists on the same provider/API.

## Compatibility and routing fields

The `compat` block on a provider or model overrides the URL-based auto-detection in `packages/catalog/src/compat/openai.ts` (`buildOpenAICompat`). It is validated by `OpenAICompatSchema` in `packages/coding-agent/src/config/models-config-schema.ts` and consumed by every `openai-completions` transport (`packages/ai/src/providers/openai-completions.ts`). The canonical type is `OpenAICompat` in `packages/catalog/src/types.ts`.

Endpoint-specific exceptions that interact with these fields are cataloged in [Provider endpoint constraints](./provider-endpoint-constraints.md).

`models.yml` accepts the following keys (all optional; unset falls back to URL detection):

Request shaping:

- `supportsStore` — emit `store: false` on requests. Default: auto (off for non-standard endpoints).
- `supportsDeveloperRole` — use the `developer` system role for reasoning models instead of `system`. Default: auto.
- `supportsMultipleSystemMessages` — preserve separate leading system/developer messages instead of coalescing them. Default: auto (known OpenAI-compatible hosted APIs preserve; strict-template/local hosts coalesce).
- `supportsUsageInStreaming` — send `stream_options: { include_usage: true }` to receive token usage on streaming responses. Default: `true`.
- `maxTokensField` — `"max_completion_tokens"` or `"max_tokens"`. Default: auto.
- `supportsToolChoice` — emit the `tool_choice` parameter when the caller forces a specific tool. Default: `true`. Set `false` for endpoints that 400 on `tool_choice` (e.g. DeepSeek when reasoning is on).
- `supportsForcedToolChoice` — accept a forced `tool_choice` that requires a specific tool. Default: `true`. When `false`, a forced selector is downgraded to `auto` so the tool stays available for endpoints that reject forced tool calls (e.g. some thinking-required OpenAI-compatible models).
- `disableReasoningOnForcedToolChoice` — drop `reasoning_effort` / OpenRouter `reasoning` whenever `tool_choice` forces a call. Default: auto (Kimi/Anthropic-fronted endpoints).
- `disableReasoningOnToolChoice` — drop reasoning fields whenever any `tool_choice` is sent. Default: auto (DeepSeek reasoning models).
- `alwaysSendMaxTokens` — always send a max-token field when the caller did not provide one. Default: auto (Kimi-family models derive TPM limits from `max_tokens`).
- `strictResponsesPairing` — Responses-API tool-call/result history must be strictly paired. Default: auto (Azure OpenAI, GitHub Copilot).
- `streamIdleTimeoutMs` — stream-watchdog idle-timeout floor in ms for slow reasoning hosts. Default: auto (GLM coding-plan hosts, direct DeepSeek reasoning).
- `cacheControlFormat` — `"anthropic"` to include Anthropic-style prompt-cache markers in chat-completions payloads. Default: auto (OpenRouter `anthropic/*` models).
- `supportsLongPromptCacheRetention` — host honors `prompt_cache_retention: "24h"` on the Responses API. Default: auto (api.openai.com).
- `extraBody` — extra top-level fields merged into every request body (gateway hints, controller selectors, etc.).

Reasoning / thinking:

- `supportsReasoningEffort` — accept `reasoning_effort`. Default: auto (off for Grok, Z.ai/Zhipu, and Xiaomi MiMo).
- `supportsReasoningParams` — whether request shaping may send reasoning params at all. Default: auto (off for GitHub Copilot chat-completions).
- `reasoningEffortMap` — partial map from internal effort levels (`minimal|low|medium|high|xhigh`) to provider-specific strings (e.g. DeepSeek maps `xhigh -> "max"`).
- `thinkingFormat` — request shape for thinking: `"openai"` (`reasoning_effort`), `"openrouter"` (`reasoning: { effort }`), `"zai"` (`thinking: { type: "enabled" }`), `"qwen"` (top-level `enable_thinking`), or `"qwen-chat-template"` (`chat_template_kwargs.enable_thinking`). Default: `"openai"`.
- `reasoningContentField` — assistant field carrying chain-of-thought: `"reasoning_content"`, `"reasoning"`, or `"reasoning_text"`. Default: auto.
- `requiresReasoningContentForToolCalls` — assistant tool-call turns must round-trip the reasoning field (DeepSeek-R1, Kimi, OpenRouter when reasoning is on). Default: `false`.
- `allowsSyntheticReasoningContentForToolCalls` — allow a placeholder reasoning field when a prior assistant tool-call turn lacks provider reasoning content. Default: `true`; set `false` for providers that validate the exact reasoning value.
- `requiresAssistantContentForToolCalls` — assistant tool-call turns must include non-empty text content (Kimi). Default: `false`.
- `whenThinking` — partial compat overrides applied only when a request actually engages thinking mode (deep-merged over the baseline compat).

Tool / message normalization:

- `requiresToolResultName` — tool-result messages need a `name` field (Mistral). Default: auto.
- `requiresAssistantAfterToolResult` — a user message after a tool result needs an assistant turn in between. Default: auto.
- `requiresThinkingAsText` — convert thinking blocks to text wrapped in `<thinking>` delimiters (Mistral). Default: auto.
- `requiresMistralToolIds` — normalize tool-call ids to exactly 9 alphanumeric chars. Default: auto.
- `supportsStrictMode` — accept the per-tool `strict` field on tool schemas. Default: conservative auto-detect per provider/baseUrl.
- `toolStrictMode` — `"all_strict"` forces strict on every tool, `"none"` forces it off; unset keeps the existing per-tool mixed behavior.

Gateway routing (only applied when `baseUrl` matches the gateway):

- `openRouterRouting.only` / `openRouterRouting.order` — provider routing on `openrouter.ai` (see <https://openrouter.ai/docs/provider-routing>).
- `vercelGatewayRouting.only` / `vercelGatewayRouting.order` — provider routing on `ai-gateway.vercel.sh` (see <https://vercel.com/docs/ai-gateway/models-and-providers/provider-options>).

Provider-level `compat` is the baseline; per-model `compat` is deep-merged on top, with `openRouterRouting`, `vercelGatewayRouting`, and `extraBody` merged as nested objects.

### Anthropic compatibility (`anthropic-messages`)

For `anthropic-messages` models the runtime uses a separate `AnthropicCompat` shape (`packages/catalog/src/types.ts`). The `models.yml` schema exposes the strict-tools opt-out as a top-level provider field (see below) plus two Anthropic-side flags in the same `compat` slot — `requiresToolResultId` (non-standard `id` alias on `tool_result` blocks for Z.AI-style proxies) and `replayUnsignedThinking` (replay unsigned thinking blocks as native thinking instead of demoting them to text); the remaining Anthropic-side knobs (`disableAdaptiveThinking`, `supportsEagerToolInputStreaming`, `supportsLongCacheRetention`, `supportsMidConversationSystem`, `supportsForcedToolChoice`, `supportsSamplingParams`, `escapeBuiltinToolNames`) are set by built-in catalog metadata and are not user-configurable from `models.yml`.

### Strict tool schemas (`disableStrictTools`)

Anthropic's API supports a `strict` field on tool definitions that forces the model to always follow the provided schema exactly. OMP enables it by default for a small allowlist of high-frequency built-in `anthropic-messages` tools (`bash`, `python`, `edit`, and `find`) whose schemas fit Anthropic's strict grammar limits; other tools still send normalized schemas but omit `strict`.

Third-party providers that front the Anthropic API (AWS Bedrock, Azure, self-hosted proxies) do not always implement this field and will reject requests that include it. Set `disableStrictTools: true` at the provider level to opt out of strict mode for the allowlisted tools:

```yaml
providers:
  bedrock-anthropic:
    baseUrl: https://bedrock-runtime.us-east-1.amazonaws.com/anthropic
    apiKey: AWS_BEARER_TOKEN
    api: anthropic-messages
    disableStrictTools: true
    models:
      - id: claude-sonnet-4-20250514
        name: Claude Sonnet 4 (Bedrock)
        input: [text, image]
        contextWindow: 200000
        maxTokens: 16384
        cost:
          input: 3.00
          output: 15.00
          cacheRead: 0.30
          cacheWrite: 3.75
```

`disableStrictTools` is a provider-level flag that applies to all models in the provider. It disables the Anthropic `strict` marker only for tools that OMP would otherwise mark strict; it does not change runtime tool argument validation. OMP can automatically retry without strict tools after Anthropic reports a strict-grammar-too-large error before the first streamed token, but proxies that reject the `strict` field for other reasons should set this flag explicitly.

Tool schemas going on the wire are normalized by the unified flow in
`packages/ai/src/utils/schema/normalize.ts` (Google/CCA/MCP dispatchers
plus the OpenAI strict-mode sanitize+enforce pipeline). See
[`ai-schema-normalize.md`](./ai-schema-normalize.md) for the strict-mode
edge cases (local `$ref` inlining, single-item `allOf` collapse,
`anyOf`-wrapper description hoist, enum/const primitive-type inference)
and the per-provider dispatcher mapping.

## Practical examples

### Local OpenAI-compatible endpoint (no auth)

```yaml
providers:
  local-openai:
    baseUrl: http://127.0.0.1:8000/v1
    auth: none
    api: openai-completions
    models:
      - id: Qwen/Qwen2.5-Coder-32B-Instruct
        name: Qwen 2.5 Coder 32B (local)
```

For oMLX or another local OpenAI-compatible server with a discoverable `/v1/models` endpoint, prefer discovery instead of listing models by hand. Set `api` to the endpoint family your server actually exposes: `openai-completions` uses `/v1/chat/completions`; servers that expose `/v1/responses` need `openai-responses` instead.

```yaml
providers:
  omlx:
    baseUrl: http://127.0.0.1:11434/v1
    auth: none
    api: openai-completions
    discovery:
      type: openai-models-list
```

The built-in vLLM provider can be pointed at a non-default endpoint without declaring a custom discovery type. OMP uses vLLM's `/v1/models` metadata and preserves vLLM's `max_model_len` field as the discovered context window.

```yaml
providers:
  vllm:
    baseUrl: http://192.168.5.3:8085/v1
    auth: none
```

For multiple vLLM endpoints, use arbitrary provider IDs with the generic OpenAI-compatible discovery path. Set `auth: none` for local no-auth servers or `apiKey` for authenticated ones. Generic discovery reads `max_model_len` first and then `context_length` as a generic OpenAI-compatible fallback.

```yaml
providers:
  vllm-fast:
    baseUrl: http://host-a:8000/v1
    auth: none
    api: openai-completions
    discovery:
      type: openai-models-list
  vllm-long:
    baseUrl: http://host-b:8000/v1
    auth: none
    api: openai-completions
    discovery:
      type: openai-models-list
```

### Hosted proxy with env-based key

```yaml
providers:
  anthropic-proxy:
    baseUrl: https://proxy.example.com/anthropic
    apiKey: ANTHROPIC_PROXY_API_KEY
    api: anthropic-messages
    authHeader: true
    disableStrictTools: true # if the proxy doesn't support strict tool schemas
    models:
      - id: claude-sonnet-4-20250514
        name: Claude Sonnet 4 (Proxy)
        reasoning: true
        input: [text, image]
```

### Override built-in provider route + model metadata

```yaml
providers:
  openrouter:
    baseUrl: https://my-proxy.example.com/v1
    headers:
      X-Team: platform
    modelOverrides:
      anthropic/claude-sonnet-4:
        name: Sonnet 4 (Corp)
        compat:
          openRouterRouting:
            only: [anthropic]
```

## Legacy consumer caveat

Most model configuration now flows through `models.yml` via `ModelRegistry`. Explicit `.json` / `.jsonc` paths remain supported only when passed programmatically to `ModelRegistry`; the default user config is `~/.ompk/agent/models.yml`.

## Failure mode

If `models.yml` fails schema or validation checks:

- registry keeps operating with built-in models
- error is exposed via `ModelRegistry.getError()` and surfaced in UI/notifications
