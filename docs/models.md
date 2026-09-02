# Model and Provider Configuration (`models.yml` / `models.yaml`)

This document describes how the coding-agent currently loads models, applies overrides, resolves credentials, and chooses models at runtime.

## What controls model behavior

Primary implementation files:

- `packages/coding-agent/src/config/model-registry.ts` — loads built-in + custom models, provider overrides, runtime discovery, auth integration
- `packages/coding-agent/src/config/model-resolver.ts` — parses model patterns and selects initial/smol/slow models
- `packages/coding-agent/src/config/settings-schema.ts` — model-related settings (`modelRoles`, provider transport preferences)
- `packages/coding-agent/src/session/auth-storage.ts` — re-exports `AuthStorage` from `@oh-my-pi/pi-ai`; API key + OAuth resolution order
- `packages/catalog/src/models.ts` and `packages/catalog/src/types.ts` — built-in providers/models and public model types

## Config file location and legacy behavior

Default config paths, in precedence order:

- `~/.omp/agent/models.yml`
- `~/.omp/agent/models.yaml`

Legacy behavior still present:

- If both YAML files are missing and `models.json` exists at the same location, it is migrated to `models.yml`.
- Explicit `.json` / `.jsonc` config paths are still supported when passed programmatically to `ModelRegistry`.

## `models.yml` / `models.yaml` shape

```yaml
providers:
  <provider-id>:
    # provider-level config
```

`provider-id` is the canonical provider key used across selection and auth lookup.

The root object currently contains only `providers`; unknown root keys fail schema validation.

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
      timeoutMs: 10000 # optional per-provider HTTP probe timeout in milliseconds
    modelOverrides:
      some-model-id:
        name: Renamed model
    models:
      - id: some-model-id
        name: Some Model
        api: openai-completions
        reasoning: false
        input: [text]
        imageInputDecoder: stb # local STB decoder; OMP converts WebP before dispatch
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

### Compaction options

- `compactionModel` (per model, including `modelOverrides`) — selector for the model used to summarize/compact context when this model's session is compacted, instead of the model itself.
- `remoteCompaction` (provider level or per model) — opts eligible models into provider-native compaction. Supported keys: `enabled`, `api`, `endpoint`, `model`, `v2StreamingEnabled`, `v2Endpoint`, `streamingEndpoint`. Provider-level settings are the baseline; per-model keys override them.

### Allowed provider/model `api` values

- `openai-completions`
- `openai-responses`
- `openai-codex-responses`
- `azure-openai-responses`
- `anthropic-messages`
- `bedrock-converse-stream`
- `google-generative-ai`
- `google-gemini-cli`
- `google-vertex`

### Allowed auth/discovery values

- `auth`: `apiKey` (default), `none`, or `oauth`; for `models.yml` custom models, `oauth` is accepted by schema but does not waive the `apiKey` requirement
- `discovery.type`: `ollama`, `llama.cpp`, `lm-studio`, `openai-models-list`, `proxy`, or `litellm`
- `discovery.injectV1`: optional boolean, default `true`, for `openai-models-list`. Set `false` to fetch the model list from `{baseUrl}/models` without injecting `/v1` — for gateways that root their OpenAI-compatible surface at a versioned path (e.g. `https://api.opper.ai/v3/compat`) where the forced `/v1/models` returns a different, smaller model list. Query strings in `baseUrl` are ignored, matching the default mode.
- `transport`: `pi-native` only. When set, every model under that provider is sent to an `omp auth-gateway` compatible `baseUrl` via `POST /v1/pi/stream`; `apiKey` is the gateway bearer.
- `imageInputDecoder`: `stb` only. Set this on a custom model or `modelOverrides` entry when the serving backend uses an STB-compatible image decoder that cannot accept WebP; OMP converts attached and historical WebP images before provider dispatch.
- `tokenizer`: opt into a specific embedded local tokenizer when a proxy's model id is ambiguous or noncanonical. Allowed values: `claude-v3`, `claude-v47`, `claude-v5`, `claude-v5-sonnet`, `qwen3`, `deepseek-v3`, `kimi-k2`, and `glm5`. Omit it to use catalog identity policy; unknown models retain the fast local estimate.

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
- `remoteCompaction`

### Discovery

- `discovery.timeoutMs` overrides that provider's runtime HTTP probe timeout in milliseconds. It must be a positive finite number.
- `discovery` requires provider-level `api`, except `discovery.type: proxy` (per-model wire auto-detected).

### Remote compaction

`remoteCompaction` is independently sufficient for an override-only provider.
It supports `enabled`, `api`, `endpoint`, `model`, `v2StreamingEnabled`,
`v2Endpoint`, and `streamingEndpoint`.

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

1. Load built-in providers/models from `@oh-my-pi/pi-catalog` (`getBundledProviders` / `getBundledModels`).
2. Load `models.yml` / `models.yaml` custom config.
3. Apply provider overrides (`baseUrl`, `headers`, `disableStrictTools`) to built-in models.
4. Apply `modelOverrides` (per provider + model id).
5. Merge custom `models`:
   - same `provider + id` replaces existing
   - otherwise append
6. Load cached and runtime-discovered models. This includes local servers, built-in provider managers, and the shared models.dev catalog for known providers. Re-apply model overrides after the merge.

### Provider-model cache and static fingerprint

Cached per-provider model lists are persisted in the model-cache SQLite
database (current schema version 12) with a `static_fingerprint` column that
hashes the static catalog slice merged into the row. When `resolveProviderModels`
skips the network fetch and the fingerprint of the in-memory static
catalog matches the cached one, the cached rows are returned verbatim —
the static + dynamic merge is bypassed entirely. The fingerprint is
memoized per process by tagging the static-models array with a symbol
property, so repeated cold-start calls do not re-hash.

### Shared catalog refresh

The bundled catalog remains the startup and offline baseline. After startup loads bundled and cached rows synchronously, the existing background refresh lifecycle fetches the current shared models.dev catalog for known providers. New model IDs are merged additively into each provider's bundled slice, normalized through that provider's catalog descriptor, and persisted in the model-cache database. This allows newly published models to appear without waiting for a new OMP binary.

Remote rows can supply current limits, pricing, modalities, and capability flags for newly added IDs, but they cannot introduce code, arbitrary headers, or an unregistered provider. A successful provider endpoint discovery remains authoritative for account availability. The shared catalog is not authoritative: it does not remove bundled models when a remote row disappears.

Fresh cached snapshots avoid a network request. If refresh fails, OMP keeps the last usable cached snapshot and marks it stale; without a cache, it falls back to the bundled catalog. Provider discovery state records `source` (`bundled`, `models.dev`, `provider`, or `cache`) and `fetchedAt` so callers can distinguish current remote data from an offline fallback.

## Provider and model identity

The registry retains concrete `provider` + `id` identities. Use an exact
`provider/modelId` selector when the same model id exists under multiple providers. Session state
and transcripts record the concrete provider/model that executed the turn.

Provider defaults vs per-model overrides:

- Provider `headers`, `compat`, and `remoteCompaction` are baselines.
- Model `headers` override provider header keys.
- `modelOverrides` can override model metadata (`name`, `reasoning`, `thinking`, `input`, `imageInputDecoder`,
  `tokenizer`, `supportsTools`, `cost`, `premiumMultiplier`, `contextWindow`, `maxTokens`,
  `omitMaxOutputTokens`, `headers`, `compat`, `contextPromotionTarget`, `compactionModel`, and
  `remoteCompaction`).
- `compat` is deep-merged for nested routing blocks (`openRouterRouting`, `vercelGatewayRouting`,
  `extraBody`, and `whenThinking`).

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
- api: `openai-responses` for OpenAI-backed models; `openai-completions` for other models
- base URL: explicit provider `baseUrl` / `models.yml` config, otherwise `LITELLM_BASE_URL`, otherwise `http://localhost:4000/v1`
- auth mode: `LITELLM_API_KEY` or stored LiteLLM auth when the proxy requires a key

Runtime discovery probes LiteLLM management metadata in order: `GET /model_group/info`, `GET /v2/model/info`, `GET /model/info`, and `GET /v1/model/info`. The configured key must be authorized to read at least one of these routes; on deployments that restrict management endpoints, grant the route through LiteLLM's `allowed_routes` access controls or use a master/admin key for discovery.

If every metadata route is unavailable, discovery falls back to the OpenAI-compatible `GET /models` list. A forbidden or failed metadata request is logged once with its endpoint and status; `404` is treated as an absent route. Rich metadata maps per-model context, capability, and upstream-provider fields. OpenAI-backed models use LiteLLM's Responses route so reasoning summaries remain available; mixed-provider groups stay on Chat Completions. Bare fallback ids use the known OpenAI model families for routing and bundled reference metadata when available. Models absent from the bundled catalog can therefore have unknown context and pricing after fallback.

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

Custom LiteLLM gateways can use the same rich discovery path:

```yaml
providers:
  litellm-gateway:
    baseUrl: http://gateway.example:4000/v1
    apiKey: LITELLM_API_KEY
    api: openai-completions
    discovery:
      type: litellm
```

LiteLLM metadata endpoints use the configured base URL with a trailing `/v1` stripped for discovery only, preserving any preceding proxy path. Runtime model calls keep the configured OpenAI-compatible `/v1` base URL.

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
2. Config override (`models.yml` `providers.<name>.apiKey`)
3. Stored OAuth credential (with refresh)
4. Login-sourced stored API key
5. Environment variable mapping (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, etc.)
6. Other stored API key, such as a broker-migrated copy
7. ModelRegistry fallback resolver (`models.yml` custom providers, using env-name-or-literal semantics)

`models.yml` `apiKey` behavior:

- Value is first treated as an environment variable name.
- If no env var exists, the literal string is used as the token.

If `authHeader: true` and provider `apiKey` is set, models get:

- `Authorization: Bearer <resolved-key>` header injected.

Keyless providers:

- Providers marked `auth: none` are treated as available without credentials.
- `getApiKey*` returns `kNoAuth` for them.

### Broker mode

When `OMP_AUTH_BROKER_URL` (or `auth.broker.url`) is set, the local SQLite credential store is replaced by `RemoteAuthCredentialStore`. Layers 3, 4, and 6 above (stored OAuth and API-key credentials) are served from a broker-supplied snapshot whose `refresh` tokens are redacted; expiry triggers `POST /v1/credential/:id/refresh` on the broker rather than a local refresh.

`AuthStorage.setConfigApiKey` lets a `models.yml` `apiKey` win over a broker-resolved OAuth token without overriding a runtime `--api-key`. See [`auth-broker-gateway.md`](./auth-broker-gateway.md) for the full broker / gateway design and env surface (`OMP_AUTH_BROKER_URL`, `OMP_AUTH_BROKER_TOKEN`, `auth.broker.url`, `auth.broker.token`).

## Model availability vs all models

- `getAll()` returns the loaded model registry (built-in + merged custom + discovered).
- `getAvailable()` filters to models that are keyless or have resolvable auth.

So a model can exist in registry but not be selectable until auth is available.

## Runtime model resolution

### CLI and pattern parsing

`model-resolver.ts` supports:

- exact `provider/modelId`
- exact model id (provider inferred)
- fuzzy/substring matching
- glob scope patterns in `--models` (e.g. `openai/*`, `*sonnet*`)
- optional `:thinkingLevel` suffix (`off|minimal|low|medium|high|xhigh|max`)

`--provider` is legacy; `--model` is preferred. An exact `provider/modelId` is unambiguous; bare ids
and fuzzy patterns are resolved against the available concrete models.

Resolution precedence for exact selectors:

1. exact `provider/modelId` reference
2. exact bare id (case-insensitive); when several providers carry the same id, a preference ranking picks the winner (see below)
3. retired effort-tier variant alias (collapsed catalog entries, e.g. `X`/`X-thinking` twins)
4. provider-scoped fuzzy match, then substring matching with an alias-vs-dated pick

Glob scope patterns (used by `enabledModels` and CLI `--models`) run separately over concrete models after exact matching.

When a bare id matches models from multiple providers, preference order is:

1. recently used model variants
2. provider priority (`modelProviderOrder` setting, then built-in catalog provider priority)
3. recently used providers
4. registry order

### Initial model selection priority

`findInitialModel(...)` uses this order:

1. explicit CLI provider+model
2. first scoped model (if not resuming)
3. saved default provider/model
4. known provider defaults (e.g. OpenAI/Anthropic/etc.) among available models
5. first available model

### Role aliases and settings

Supported model roles:

- `default`, `smol`, `slow`, `vision`, `plan`, `designer`, `commit`, `tiny`, `task`, `advisor`

The `tiny` role overrides the online model used for lightweight background tasks (session titles, memory, `auto`-thinking difficulty classification, unexpected-stop detection); when unset, these fall back to `@smol`. Pick one in `/models`.

Role aliases like `@smol` expand through `settings.modelRoles`; `*` selects `@default`. Quote `@` aliases in YAML values (`fable: "@slow"`). Each role value can also append a thinking selector such as `:minimal`, `:low`, `:medium`, or `:high`.

If a role points at another role, the target model still inherits normally and any explicit suffix on the referring role wins for that role-specific use.

Related settings:

- `modelRoles` (record)
- `enabledModels` (scoped pattern list)
- `modelProviderOrder` (provider precedence when equivalent concrete choices share an id)
- `providers.kimiApiFormat` (`openai` or `anthropic` request format)
- `providers.openaiWebsockets` (`auto|off|on` websocket preference for OpenAI Codex transport)

`modelRoles` stores model selectors such as `provider/modelId`; `enabledModels` and CLI `--models`
accept exact selectors, globs, and fuzzy matches.

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

## `/model` and `omp models`

Both surfaces keep provider-prefixed concrete models visible and selectable.

- `/model` shows an all-models view plus one view per provider
- `omp models` (default `ls` action) prints provider-grouped tables of every available model; `omp models find <substring>` filters by provider, id, or name; `omp models refresh` forces an online catalog re-fetch ignoring the model cache TTL; any provider name doubles as an `ls` filter (e.g. `omp models openai-codex`). Flags: `--json`, `-e <path>` (load extension, repeatable), `--no-extensions`, `--config <overlay>` (extra config overlay, repeatable)

Selecting a provider row stores its explicit `provider/modelId`.

## Context promotion (model-level fallback chains)

Context promotion is an overflow recovery mechanism for small-context variants (for example `*-spark`) that automatically promotes to a larger-context sibling when the API rejects a request with a context length error.

### Trigger and order

When a turn fails with a context overflow error (e.g. `context_length_exceeded`), `AgentSession` attempts promotion **before** falling back to compaction:

1. If `contextPromotion.enabled` is true, resolve a promotion target (see below).
2. If a target is found, switch to it and retry the request — no compaction needed.
3. If no target is available, fall through to auto-compaction on the current model.

### Target selection

Selection is explicit and model-driven:

1. `currentModel.contextPromotionTarget` (if configured)

Only the configured target is considered; context promotion does not automatically choose a larger same-provider/API sibling. Configured targets are ignored unless credentials resolve (`ModelRegistry.getApiKey(...)`).

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
- `supportsImageDetailOriginal` — allow the Responses API's nonstandard `detail: "original"` image
  mode where the endpoint supports it.
- `extraBody` — extra top-level fields merged into every request body (gateway hints, controller selectors, etc.).

Reasoning / thinking:

Custom model entries may define `thinking: { mode, efforts, defaultLevel, requiresEffort }`.
`requiresEffort` defaults to auto-detection; set it to `false` only when the
configured backend has been verified to accept an explicit reasoning-off
request. This keeps the `:off` selector from being clamped to the lowest effort.

- `supportsReasoningEffort` — accept `reasoning_effort`. Default: auto (off for Grok, Z.ai/Zhipu, and Xiaomi MiMo).
- `supportsReasoningParams` — whether request shaping may send reasoning params at all. Default: auto (off for GitHub Copilot chat-completions).
- `reasoningEffortMap` — partial map from internal effort levels (`minimal|low|medium|high|xhigh|max`) to provider-specific strings (e.g. Fireworks GLM maps `minimal -> "none"`).
- `thinkingFormat` — request shape for thinking: `"openai"` (`reasoning_effort`), `"openrouter"` (`reasoning: { effort }`), `"zai"` (`thinking: { type: "enabled" }`), `"qwen"` (top-level `enable_thinking`), or `"qwen-chat-template"` (`chat_template_kwargs.enable_thinking`). Default: `"openai"`.
- `qwenTemplateReasoningEffort` — route the selected effort onto the Qwen 3.8+ chat template's `reasoning_effort` kwarg (`chat_template_kwargs.reasoning_effort`, plus the top-level field on the `qwen` dialect). Default: auto (on for Qwen 3.8+ ids on local non-Ollama backends). Set `false` for strict servers that reject unknown `chat_template_kwargs`; effort selections are then not sent for the Qwen dialects and the template runs at its own default.
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

Provider-level `compat` is the baseline; per-model `compat` is deep-merged on top, with
`openRouterRouting`, `vercelGatewayRouting`, `extraBody`, and `whenThinking` merged as nested objects.

### Anthropic compatibility (`anthropic-messages`)

For `anthropic-messages` models the runtime uses a separate `AnthropicCompat` shape
(`packages/catalog/src/types.ts`). The `models.yml` schema exposes the strict-tools opt-out as a
top-level provider field plus `requiresToolResultId`, `replayUnsignedThinking`,
`supportsEagerToolInputStreaming`, and `allowAnthropicHeaderOverrides` in `compat`. Other
Anthropic-side knobs are supplied by built-in catalog metadata and are not configurable here.

### Bedrock compatibility (`bedrock-converse-stream`)

The same `compat` slot accepts `promptCacheMode` (`none`, `automatic`, or `explicit`),
`supportsLongPromptCacheRetention`, `promptCacheMinimumTokens`, and
`promptCacheMaximumCheckpoints` for Bedrock models.

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

Most model configuration now flows through `models.yml` / `models.yaml` via `ModelRegistry`. Explicit `.json` / `.jsonc` paths remain supported only when passed programmatically to `ModelRegistry`; the default user config prefers `~/.omp/agent/models.yml`, then falls back to `~/.omp/agent/models.yaml`.

## Failure mode

If `models.yml` / `models.yaml` fails schema or validation checks:

- registry keeps operating with built-in models
- error is exposed via `ModelRegistry.getError()` and surfaced in UI/notifications
