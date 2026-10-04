# Model and Provider Configuration (`models.yml` / `models.yaml`)

This document describes how the coding-agent currently loads models, applies overrides, resolves credentials, and chooses models at runtime.

## What controls model behavior

Primary implementation files:

- `packages/coding-agent/src/config/model-registry.ts` — loads built-in + custom models, provider overrides, runtime discovery, auth integration
- `packages/coding-agent/src/config/model-resolver.ts` — parses model patterns and selects initial/smol/slow models
- `packages/coding-agent/src/config/model-settings.ts` — model selection settings (`modelRoles`, `enabledModels`, `enabledProviders`/`disabledProviders`, `modelProviderOrder`, `cycleOrder`)
- `packages/coding-agent/src/session/settings.ts` — provider transport preferences (`providers.*`)
- `packages/coding-agent/src/config/models-config.ts` and `models-config-schema-bundle.ts` — custom provider/model validation
- `packages/coding-agent/src/session/auth-storage.ts` — re-exports `AuthStorage` from `@oh-my-pi/pi-ai`; credential precedence is implemented in `packages/ai/src/auth/cascade.ts`
- `packages/catalog/src/compat/resolve.ts` and `compat/rules/` — compatibility and model policy resolution
- `packages/catalog/src/models.ts` and `packages/catalog/src/types.ts` — built-in providers/models and public model types

## Config file location and legacy behavior

Default-profile config paths, in precedence order:

- `~/.omp/agent/models.yml`
- `~/.omp/agent/models.yaml`

These are relative to the active agent directory returned by `getAgentDir()`. Named profiles use
`~/.omp/profiles/<name>/agent/`; `PI_CONFIG_DIR` changes the config-root directory name, and
`PI_CODING_AGENT_DIR` can override the default-profile agent directory. A programmatic
`ModelRegistry` path overrides the directory-derived location.

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

`providers` is the only root key the registry consumes. Unknown root keys are not rejected by the current schema, but do not configure model behavior.

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
        maxContextWindow: 256000 # optional extended-context window
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

`maxContextWindow` is available on both `models` entries and `modelOverrides`.
Set `contextWindow` to the normal prompt window and `maxContextWindow` to the
larger prompt window accepted by the provider. `/extended-context on` selects
the larger window; `off` restores the normal one. An override specifying only
`contextWindow` remains fixed in both modes, as before. This changes OMP's
local context budget, not the provider's server-side limit; verify the endpoint
accepts requests of the configured size.
Configured maxima do not replace provider-advertised capacity. Models governed
by a catalog override ceiling (such as Codex Astra) still clamp to that ceiling.
Per-model overrides, including retired variant aliases, are resolved before
selecting the extended window.

Custom `models` entries can set their own `baseUrl`; otherwise they inherit the provider URL.
For built-in models, a provider `baseUrl` override is scoped to the effective APIs of custom models
that inherit it, or to the provider's `api` for an override-only configuration. Without either
scope it applies provider-wide. `transport: pi-native` always applies the gateway URL provider-wide.

`preferWebsockets` (on a model or `modelOverrides` entry) controls whether Codex requests prefer
the WebSocket transport. `omitMaxOutputTokens` omits the model-derived output cap.

### Bedrock request options

Provider-level `guardrailIdentifier`, `guardrailVersion`, and `guardrailTrace` attach a guardrail to
Converse requests. The version defaults to `"DRAFT"` when an identifier is set; trace accepts
`enabled`, `disabled`, or `enabled_full`. `requestMetadata` supplies invocation-log tags. Invalid
entries and entries beyond Bedrock's 16-entry limit are dropped before dispatch; per-request tags
override matching model tags. These fields do not configure the Anthropic Messages route.

### Compaction options

- `compactionModel` (per model, including `modelOverrides`) — preferred compaction model, tried before the active model, chat-role candidates, and a largest-context fallback. It does not switch the active conversation model.
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
- `typesafe`
- `openrouter-decisions`

`typesafe` and `openrouter-decisions` are judgment APIs, not chat transports: a model declared with one answers System One judgment requests (`{baseUrl}/v1/systemone` and `{baseUrl}/decisions` respectively) and is selected by the `judge` model role. Its `headers` carry gateway routing or custom authentication headers for that traffic.

### Allowed auth/discovery values

- `auth`: `apiKey` (default), `none`, or `oauth`. `none` and `oauth` waive the custom-provider `apiKey` requirement, but `oauth` does not create credentials or register a login flow. It forces OAuth-style request shaping; a usable credential must come from stored auth, environment, or a configured key. Custom `anthropic-messages` models also use OAuth-style shaping when `auth` is omitted; set `auth: apiKey` for plain API-key shaping.
- `discovery.type`: `ollama`, `llama.cpp`, `lm-studio`, `openai-models-list`, `proxy`, `litellm`, or `apple-foundation-models`. Apple's transport is registered implicitly on supported Macs; `apple-foundation-models` is not an allowed `api` value in this YAML schema.
- `discovery.injectV1`: optional boolean, default `true`, for `openai-models-list`. Set `false` to fetch the model list from `{baseUrl}/models` without injecting `/v1` — for gateways that root their OpenAI-compatible surface at a versioned path (e.g. `https://api.opper.ai/v3/compat`) where the forced `/v1/models` returns a different, smaller model list. Query strings in `baseUrl` are ignored, matching the default mode.
- `transport`: `pi-native` only. When set, every model under that provider is sent to an `omp auth-gateway` compatible `baseUrl` via `POST /v1/pi/stream`; `apiKey` is the gateway bearer.
- `imageInputDecoder`: `stb` only. Set this on a custom model or `modelOverrides` entry when the serving backend uses an STB-compatible image decoder that cannot accept WebP; OMP converts attached and historical WebP images before provider dispatch.
- `tokenizer`: opt into a specific embedded local tokenizer when a proxy's model id is ambiguous or noncanonical. Allowed values: `claude-v3`, `claude-v47`, `claude-v5`, `claude-v5-sonnet`, `qwen3`, `deepseek-v3`, `kimi-k2`, and `glm5`. Omit it to use catalog identity policy; unknown models retain the fast local estimate.

## Validation rules (current)

### Full custom provider (`models` is non-empty)

Required:

- `baseUrl`
- `apiKey` unless `auth: none` or `auth: oauth`
- `api` at provider level or each model

### Override-only provider (`models` missing or empty)

Must define at least one of:

- `baseUrl`
- `apiKey`
- `auth: none`
- `headers`
- `compat`
- `disableStrictTools: true`
- `guardrailIdentifier`
- `requestMetadata`
- non-empty `modelOverrides`
- `discovery`
- `remoteCompaction`

### Discovery

- `discovery.timeoutMs` overrides that provider's runtime HTTP probe timeout in milliseconds. It must be a positive finite number.
- Without an override, Ollama and llama.cpp loopback probes use short endpoint-specific budgets (150–250 ms); remote/LAN probes use 10 s. Generic model-list and proxy probes default to 10 s.
- `discovery` requires provider-level `api`, except `discovery.type: proxy` (per-model wire auto-detected).

### Remote compaction

`remoteCompaction` is independently sufficient for an override-only provider.
It supports `enabled`, `api`, `endpoint`, `model`, `v2StreamingEnabled`,
`v2Endpoint`, and `streamingEndpoint`.

`openai-responses` models on Amazon Bedrock's OpenAI routes (`/openai/…` on
`bedrock-runtime.<region>.amazonaws.com` or `bedrock-mantle.<region>.api.aws`,
Mantle's `/v1` base, the runtime FIPS host, and PrivateLink hosts of both endpoints)
use native OpenAI compaction without an opt-in, for any provider id. Set
`enabled: false` to turn it off, or `v2StreamingEnabled: false` to keep only
the V1 `/responses/compact` request. See [compaction](./compaction.md).

### Model value checks

- `id` is required and non-empty; optional `name`, model `baseUrl`, `contextPromotionTarget`, and `compactionModel` must also be non-empty
- custom `models` entries require positive `contextWindow` and `maxTokens` when provided; the current auxiliary positivity check does not cover `modelOverrides`
- on both custom models and overrides, `maxContextWindow` must be a positive safe integer no smaller than `contextWindow` when both are set

### Command-resolved secrets

Provider `apiKey` values and provider/model `headers` values may start with `!` to read a secret from command stdout. Commands run asynchronously with a 10 s timeout; stdout is trimmed, and empty/failing commands are omitted. Loading or inspecting the catalog does not execute them: credentials resolve when a request or online credential probe needs them.

```yaml
providers:
  openai:
    apiKey: "!op read op://dev/openai/api-key"
    headers:
      X-Team-Key: "!bw get password omp-team-key"
```

Successful command outputs are cached for the process lifetime, and concurrent requests share an in-flight execution. Failures back off for 30 seconds. When a turn's `apiKey` command produces nothing for a provider that requires a key, the turn fails retryably and auto-retry runs the command again once that backoff has passed, up to 3 times per turn (fewer if `retry.maxRetries` is lower); with `retry.maxDelayMs` below 30 seconds the turn ends without retrying. Other requests, such as title or commit-message generation, still fail at once with a missing key. Refresh callers that request `refreshCommandCredentials` (including the model hub's explicit refresh) and 401 credential recovery invalidate the relevant cached API keys and headers; an ordinary catalog refresh does not. Runtime API-key overrides, including `--api-key`, take precedence over configured credentials.

## Merge and override order

ModelRegistry composition order:

1. Load `models.yml` / `models.yaml` to establish provider overrides, custom models, model overrides, and discovery configuration.
2. Load built-in models from `@oh-my-pi/pi-catalog` (`getBundledProviders` / `getBundledModels`), applying provider overrides and context policies.
3. Merge cached and runtime-discovered rows. Authoritative provider catalogs can replace their bundled chat roster.
4. Merge configured custom `models`, then extension-registered models:
   - a matching `provider + id` replaces transport metadata and patches defined model fields
   - otherwise append a model, filling omitted metadata from a bundled reference or local defaults
5. Collapse effort-tier variants, apply `modelOverrides`, and select configured extended windows.
6. Apply provider Bedrock fields, runtime provider overrides, discovery wire policies, and extension OAuth catalog projections.

Background discovery repeats the merge with custom definitions and model overrides applied after
the discovered rows, so explicit user configuration remains effective.

### Provider-model cache and static fingerprint

Cached per-provider model lists are persisted in `models.db` (schema version 13) as materialized
models. A materialization-policy stamp includes the application version, builder version, and
compiled-rule hash; incompatible rows are invalidated. Request-header values are never persisted
and must be restored from trusted local metadata or configuration.

`static_fingerprint` hashes the current static slice and merge policy. It is recomputed from the
array's current contents, not stored on the array. When a fresh authoritative cache matches and no
headers remain unresolved, `resolveProviderModels` can skip the full merge. Additive shared-catalog
caches still reapply static rows, and returned models pass through variant collapsing.
The model-manager default cache TTL is two hours (individual providers can override it);
non-authoritative snapshots use a five-minute retry interval.

### Shared catalog refresh

The bundled catalog remains the startup and offline baseline. Startup loads configuration and cached rows, materializing provider slices lazily; a local-only credential-scoped hydration pass precedes selector validation. Background refresh fetches the shared models.dev catalog through `https://catalog.stencil.so/models.json.zstd` for supported providers. New model IDs are merged additively into each provider's bundled slice, normalized through that provider's catalog descriptor, and persisted in the model-cache database. This allows newly published models to appear without waiting for a new OMP binary.

Remote rows can supply current limits, pricing, modalities, and capability flags for newly added IDs, but they cannot introduce code, arbitrary headers, or an unregistered provider. Providers whose descriptors declare endpoint discovery authoritative use that result for their available chat roster. The shared catalog is not authoritative: it does not remove bundled models when a remote row disappears.

Fresh cached snapshots avoid a network request. If refresh fails, OMP keeps the last usable cached snapshot and marks it stale; without a cache, it falls back to the bundled catalog. Provider discovery state records `source` (`bundled`, `models.dev`, `provider`, or `cache`) and `fetchedAt` so callers can distinguish current remote data from an offline fallback.

## Provider and model identity

The registry retains concrete `provider` + `id` identities. Use an exact
`provider/modelId` selector when the same model id exists under multiple providers. Session state
and transcripts record the concrete provider/model that executed the turn.

Provider defaults vs per-model overrides:

- Provider `headers`, `compat`, and `remoteCompaction` are baselines.
- Model `headers` override provider header keys.
- `modelOverrides` can override model metadata (`name`, `reasoning`, `thinking`, `input`, `imageInputDecoder`,
  `tokenizer`, `supportsTools`, `cost`, `promptCache`, `premiumMultiplier`, `contextWindow`, `maxContextWindow`, `maxTokens`,
  `omitMaxOutputTokens`, `preferWebsockets`, `headers`, `compat`, `contextPromotionTarget`, `compactionModel`, and
  `remoteCompaction`).
- `compat` is deep-merged for nested routing blocks (`openRouterRouting`, `vercelGatewayRouting`,
  `extraBody`, and `whenThinking`).

## Prompt cache lifetimes

`promptCache` states how long the provider keeps a prompt cache entry alive for each retention tier
OMP can request (`short` is normally the default; Anthropic OAuth subscriber requests default to
`long` where supported, unless an explicit retention setting or `PI_CACHE_RETENTION` overrides it). Values are seconds and are
estimates: providers publish ranges, so pick the conservative end.

```yaml
providers:
  anthropic:
    modelOverrides:
      claude-sonnet-5:
        promptCache: { short: 300, long: 3600 }
```

An explicit `promptCache` replaces the model's catalog lifetimes rather than
merging with them: `promptCache: {}` disables warming for that model, and a
`short`-only value does not inherit a catalog `long` lifetime. For a matching
model, `modelOverrides.promptCache` has highest priority. A runtime-registered
model definition replaces the matching YAML `models` definition for lifetime
selection, even when the runtime `promptCache` is omitted: the actual effective
model's catalog defaults apply instead of the YAML lifetime. Without a runtime
replacement, the matching YAML lifetime applies, or catalog defaults if absent.

The ordinary `bun run gen:models` command recomputes bundled prompt-cache
lifetimes from current catalog policy; there is no separate cache-regeneration
command.

Direct Anthropic keeps its existing 5 min / 1 h lifetimes (`short: 300`, `long: 3600`),
defaulting to 5 min for API keys and 1 h for OAuth subscriber sessions; API keys can
explicitly select `long`. Claude on native Amazon Bedrock Converse has a 5 min TTL; 1 h is
available only where both catalog metadata and the request wire support it. Claude on
Bedrock Runtime or Mantle's Anthropic Messages route has a 5 min lifetime under existing
request support; an explicit `long` request falls back to `short` when unsupported. Other Amazon Bedrock models,
including Nova and GPT, are not enabled for warming. A model without a lifetime for the
retention tier actually used is never warmed; custom models and `modelOverrides` can opt in
with `promptCache` once the backing cache behavior is known. See `providers.cacheWarming` in
[Settings](./settings.md).

## Usage costs and time-based pricing

OMP estimates token costs from the selected provider/model's catalog pricing, preferring server-reported monetary costs when available. Completed messages retain their recorded costs: crossing a pricing boundary, switching models, or reopening a session does not reprice accumulated usage.

For the first-party `deepseek` provider, the catalog follows [DeepSeek's official pricing](https://api-docs.deepseek.com/quick_start/pricing):

- Peak hours are **Monday–Friday, 01:00–04:00 and 06:00–10:00 UTC** (start inclusive, end exclusive). All other times, including weekends, cost **50% of peak rates**.
- Flash pricing covers `deepseek-flash` and the retired-but-still-accepted `deepseek-v4-flash` and `deepseek-v4-flash-vision-exp` ids, all billed at the Flash card. Peak rates per million tokens are $0.30 uncached input, $0.006 cached input, and $1.20 output.
- `deepseek-v4-pro` initially uses peak rates of $1.32 uncached input, $0.044 cached input, and $3.96 output per million tokens. From **2026-09-14 04:00 UTC**, its estimates use the Flash rate card, with the same peak/off-peak schedule.

Local estimates use the assistant message's **request-start timestamp** to choose both the rate card and tariff for the whole request. This is OMP's estimation convention: DeepSeek's pricing page does not specify how its server bills a request spanning a boundary. When importing historical usage without recorded cost, the stats importer leaves scheduled pricing unpriced if no request timestamp can be recovered, rather than choosing a wall-clock tariff.

The status line's `cost` segment appends **↑** for peak or **↓** for off-peak pricing on the **currently active provider/model**, using the current wall clock. It refreshes at tariff boundaries even while idle; the arrow is not a label for the accumulated session total. Models without scheduled pricing, including explicit flat-price overrides, show no arrow.

An explicit model `cost` in `models.yml`, including `modelOverrides`, is a flat-price override and disables inherited time-based pricing for that model. Omitting `cost` preserves catalog pricing. `models.yml` does **not** configure a `timeBased` schedule; that metadata belongs to the catalog's [KDL pricing rules](../packages/catalog/src/compat/rules/README.md#time-based-pricing).

A new custom model in `models.yml` that omits `cost` inherits its bundled reference row's card,
schedule included. References are matched by model id and prefer larger context/output limits,
then complete cache pricing and first-party OpenAI rows. A same-provider, same-id custom entry
instead preserves the existing model's pricing when `cost` is omitted. Generic proxy and
OpenAI-model-list discovery keeps pricing local-unknown (zero) rather than borrowing upstream
prices; rich provider discovery such as LiteLLM can supply its own prices.

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

The provider `api` is the default for discovered models; catalog rules can override it per model class. Qwen-class models on any `discovery.type: llama.cpp` provider (implicit or explicit) are discovered as `openai-completions`, because the Responses API cannot carry the chat template's thinking controls (`enable_thinking` / `chat_template_kwargs`). The override lives in `packages/catalog/src/compat/rules/providers/llama.cpp.kdl` (`discovery-api`).

After a first response loads a lazy llama.cpp model, OMP re-probes its runtime context and input
metadata. Explicit custom-model and `modelOverrides` limits take precedence over that probe.
The implicit provider is keyless only when no credential source is configured.

### Implicit LM Studio discovery

If `lm-studio` is not explicitly configured, registry adds an implicit discoverable provider:

- provider: `lm-studio`
- api: `openai-completions`
- base URL: `LM_STUDIO_BASE_URL` or `http://127.0.0.1:1234/v1`
- auth mode: keyless (`auth: none` behavior)

Runtime discovery fetches the OpenAI-compatible model list and native LM Studio metadata when
available. Native `loaded_context_length` takes precedence over the training window; after a first
response JIT-loads a model, OMP refreshes that runtime metadata. Explicit custom-model and
`modelOverrides` limits remain authoritative. Discovered LM Studio models use `imageInputDecoder: stb`.

This path also works for local OpenAI-compatible servers that are not LM Studio. For example, if oMLX is bound to Ollama's usual port, set `LM_STUDIO_BASE_URL=http://127.0.0.1:11434/v1` to discover it through the existing `/v1/models` flow. Running oMLX and Ollama side by side requires assigning a different port to one of them. Do not configure oMLX as `ollama`: Ollama discovery uses native `/api/tags` and `/api/show` endpoints, not OpenAI `/v1/models`.

### Implicit Apple Foundation Models discovery

On Apple Silicon macOS, an unconfigured, non-disabled `apple` provider is probed through the
in-process Foundation Models bridge. When the bridge reports it usable, `apple/on-device` is
available without credentials, with context size, reasoning, image input, and tool support derived
from bridge metadata. Ineligible devices, disabled Apple Intelligence, and builds without the
bridge yield no models. Its internal API is `apple-foundation-models`; no HTTP endpoint is used.

### LiteLLM provider discovery

When `litellm` is active (for example through `LITELLM_API_KEY` or stored auth), runtime discovery uses the LiteLLM proxy:

- provider: `litellm`
- api: `openai-responses` for OpenAI-backed models; `openai-completions` for other models
- base URL: explicit provider `baseUrl` / `models.yml` config, otherwise `LITELLM_BASE_URL`, otherwise `http://localhost:4000/v1`
- auth mode: `LITELLM_API_KEY` or stored LiteLLM auth when the proxy requires a key

Runtime discovery probes LiteLLM management metadata in order: `GET /model_group/info`, `GET /v2/model/info`, `GET /model/info`, and `GET /v1/model/info`. The configured key must be authorized to read at least one of these routes; on deployments that restrict management endpoints, grant the route through LiteLLM's `allowed_routes` access controls or use a master/admin key for discovery.

If every metadata route is unavailable, discovery falls back to the OpenAI-compatible `GET /models` list. A forbidden or failed metadata request is logged once with its endpoint and status; `404` is treated as an absent route. Both paths exclude models explicitly marked with known task-specific LiteLLM modes: `audio_speech`, `audio_transcription`, `batch`, `embedding`, `guardrail`, `image_edit`, `image_generation`, `moderation`, `ocr`, `rerank`, `search`, `vector_store`, and `video_generation`. Missing, null, and unrecognized modes remain selectable so router aliases continue to work. Rich metadata maps per-model context, capability, and upstream-provider fields. OpenAI-backed models use LiteLLM's Responses route so reasoning summaries remain available; mixed-provider groups stay on Chat Completions. Bare fallback ids use the known OpenAI model families for routing and bundled reference metadata when available. Fallback pricing remains unknown (represented by zero); configured generic discovery uses a 128,000-token context default when neither the endpoint nor a bundled reference supplies a limit. Rich management metadata can supply provider-specific prices. Later probes fill or override reported metadata for models in the first usable roster rather than unioning every endpoint's roster.

### Generic OpenAI-compatible discovery

`openai-models-list` reads `{baseUrl}/v1/models` by default (without adding a second `/v1`).
`discovery.injectV1: false` treats the configured URL as the complete API root. Reported
`max_model_len` wins over `context_length`. If both are absent, nested
`limits.max_input_tokens` and `limits.max_output_tokens` supply their sum as context only when both
are positive safe integers and the sum is safe. A valid `max_output_tokens` independently sets the
chat output cap, clamped to the resolved context; an incomplete or invalid context pair does not
discard a valid output limit. Otherwise, context follows the existing native/reference/default fallback.
Silent endpoints can inherit bundled-reference limits, reasoning, and input modalities; unknown models
use 128,000 context and 32,768 output as generic chat defaults. Output caps are bounded by the resolved context;
Anthropic-routed models use an 8,192-token fallback output cap.

A row advertising only image output becomes an image-generation runner; embedding-only output
becomes an embedding runner. Mixed outputs remain chat models. These runners are visible with
`omp models --kind all`, not the default chat listing.

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
- otherwise -> falls back to provider-level `api`, or `openai-completions` when it is omitted

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
- `fetchDynamicModels` for a credential-aware live roster (cached with a default 24-hour TTL)
- custom usage reporting and OAuth `modifyModels` projections reapplied after catalog rebuilds

## Auth and API key resolution order

When requesting a key for a provider, effective order is:

1. Runtime override (CLI `--api-key`)
2. Config override (`models.yml` `providers.<name>.apiKey`)
3. Stored OAuth credential (with refresh)
4. Login-sourced stored API key
5. Extension-registered config fallback (`keys.setConfig(..., { fallback: true })`)
6. Environment variable mapping (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, etc.)
7. Other stored API key, such as a broker-migrated copy

The fallback tier is for registered providers with their own login flow. Keys explicitly supplied
in `models.yml` belong to tier 2, not this fallback tier.

`models.yml` `apiKey` behavior:

- Value is first treated as an environment variable name.
- If the env var is unset or empty, the literal string is used as the token.

If `authHeader: true` and provider `apiKey` is set, models get:

- `Authorization: Bearer <resolved-key>` header injected.

Resolution does not fail for a missing variable: with `apiKey: MY_PROVIDER_API_KEY`
and `authHeader: true`, an unset or empty `MY_PROVIDER_API_KEY` produces
`Authorization: Bearer MY_PROVIDER_API_KEY`. Launchers using env-backed keys must
check that the variable is set and non-empty before starting OMP.

[Command-resolved secrets](#command-resolved-secrets) do not use this literal
fallback: a failing command or empty trimmed stdout resolves to no value, so it
does not add a derived bearer header.

Keyless providers:

- Providers marked `auth: none`, implicit local providers, and optional-key logins stored in keyless mode can be available without credentials.
- `ModelRegistry.getApiKey*` returns `kNoAuth` when a provider is keyless and no real credential source is configured; configured credentials still take precedence.

### Broker mode

When `OMP_AUTH_BROKER_URL` (or `auth.broker.url`) is set, the local SQLite credential store is replaced by `RemoteAuthCredentialStore`. Layers 3, 4, and 7 above (stored OAuth and API-key credentials) are served from a broker-supplied snapshot whose `refresh` tokens are redacted; expiry triggers `POST /v1/credential/:id/refresh` on the broker rather than a local refresh.

`AuthStorage.keys.setConfig` lets a `models.yml` `apiKey` win over a broker-resolved OAuth token without overriding a runtime `--api-key`. See [`auth-broker-gateway.md`](./auth-broker-gateway.md) for the full broker / gateway design and env surface (`OMP_AUTH_BROKER_URL`, `OMP_AUTH_BROKER_TOKEN`, `auth.broker.url`, `auth.broker.token`).

## Model availability vs all models

- `getAll()` returns chat models by default; `getAll("all")` includes every catalog kind.
- `getAvailable()` is also chat-only by default; a kind or `"all"` includes the corresponding runners.
- Availability excludes `disabledProviders` and requires a keyless provider or configured credential source. It does not execute secret commands or refresh OAuth tokens.

A model can exist in the registry without being available, and a configured credential can still
fail when resolved for a request. `enabledProviders` controls foreign configuration-source discovery,
not an allowlist of model transports.

## Runtime model resolution

### CLI and pattern parsing

`model-resolver.ts` supports:

- exact `provider/modelId`
- exact model id (provider inferred)
- fuzzy/substring matching
- glob scope patterns in `--models` (e.g. `openai/*`, `*sonnet*`)
- optional `:thinkingLevel` suffix (`off|minimal|low|medium|high|xhigh|max|auto|inherit`)
- `@upstream` routing suffix on OpenRouter and Vercel Gateway selectors (for example, `openrouter/anthropic/claude-sonnet-5@anthropic:high`); an exact literal model id still wins

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

The automatic fallback first restricts the pool to providers with concrete credentials (including
keyless locals) when any exist. Ambient AWS/Vertex credential sentinels remain usable, but do not
displace providers with explicit credentials. Session restoration is handled separately and checks
that the saved model still exists and resolves a usable credential.

### Role aliases and settings

Model roles assign model selectors to workloads. Configure them under `modelRoles` in `config.yml`, not in `models.yml`; `models.yml` defines providers and model metadata.

Built-in roles are grouped in the model picker:

- **Chat roles:** `default`, `smol`, `slow`, `vision`, `plan`, `commit`, `tiny`, `memory`, `task`, and `advisor`. The `tiny` and `memory` roles accept both ordinary chat models and `tiny` catalog models.
- **Model-kind roles:** `image`, `web`, `speech`, `dictation`, and `judge`. These select image generation, search/grounded chat, text-to-speech, speech-to-text, and judgment runners respectively. The `judge` role also accepts tiny and chat models.

`vision` and `image` are different workloads: `vision` selects a chat model for image analysis, such as `read screenshot.png?q=...`; `image` selects a model with catalog kind `image` for `generate_image`. Assigning a model to `vision` does not give it image-input support: image questions additionally check that the model can send image input to its provider.

The `tiny` role selects lightweight models for background work such as session titles; when unset, it resolves through `@smol`. The `memory` role resolves through `@tiny` when unset. See [model settings](./settings.md#models) for configuration and fallback-chain examples.

Assigning a non-default role in `/models` normally saves its selector without switching the active conversation model. A workload uses the role when invoked; assigning `plan` does not itself enter plan mode, and calling `todo` does not itself select the plan model. While plan mode is active, changing the `plan` role reapplies its model. Assigning `default` normally also switches the active model, unless a higher-priority settings layer overrides the edited assignment. The session-only model picker changes the active model without rewriting role assignments.

Role aliases like `@smol` expand through `settings.modelRoles`; `*` selects `@default`. Quote `@` aliases in YAML values (`plan: "@slow"`). Chat-role values can append a thinking selector such as `:minimal`, `:low`, `:medium`, or `:high`; model-kind roles do not use chat thinking suffixes.

Role values can contain comma-separated selectors; selection uses the first available match,
not a per-request retry chain. Request-failure fallbacks are configured separately under
`retry.fallbackChains` (role, exact model, or provider-wildcard keys; see [Settings](./settings.md)).
Custom role names
can be introduced through `modelRoles`, `modelTags`, or `cycleOrder`; they use chat models.
Unset `smol` and `slow` inherit an explicitly configured `default` before their built-in priority
lists. The advisor uses an explicitly configured `slow`, otherwise its own strong-model priority
chain rather than inheriting the active conversation model.

If a role points at another role, the target model still inherits normally and any explicit suffix on the referring role wins for that role-specific use.

### Model presets

A model preset is a named snapshot of every role assignment plus `defaultThinkingLevel`, so you can swap a whole setup at once:

```text
/modelpreset save cheap      # save the current roles and thinking level
/modelpreset switch deep     # apply a saved preset
/modelpreset                 # pick one from a list (interactive)
/modelpreset list | delete <name>
```

In `/models`, press `s` in the Roles view to save the current setup under a name. Presets live under `modelPresets` in `config.yml`:

```yaml
modelPresets:
  deep:
    modelRoles:
      default: anthropic/claude-opus-4-5:high
      smol: anthropic/claude-sonnet-4-5
    defaultThinkingLevel: high
```

Switching writes roles the way the model picker does: into the scope chosen by `modelRoleStorage`, clearing roles the preset leaves out and replacing `--model`/`--smol` session overrides. The preset's `defaultThinkingLevel` is written to the global config. It then switches the active model to the resulting `default` (an automatic provider-default selection when the preset has none) and sets the session's thinking level from the `:level` suffix on that selector, or else the preset's `defaultThinkingLevel`; a `:inherit` suffix leaves the level the model switch set. When a preset's `default` model is unavailable, nothing is changed. Roles that another layer still decides — a `--config` file, a project config in `global` storage, or the global config in `project` storage — are listed in the switch message with the layer that wins, instead of being reported as switched. The same goes for a `defaultThinkingLevel` set by a project config or `--config` file: the session still switches to the preset's level, but the message names that layer, whose level returns on the next start.

When several config layers define a preset of the same name, the highest layer (command line, then `--config` file, then project config, then global config) wins whole: entries are never merged across layers, so a project `deep` that only sets `default` applies without the global `deep`'s other roles. A `null` entry in a `--config` file (or a command-line override) hides the preset from lists and switches; a `null` entry in a project config is ignored, so the global preset of that name still applies. Saving always writes the named entry to the global config and reports when a higher layer still takes precedence for that name.

Saving captures the effective assignments — including any `--model` session override — and the configured `defaultThinkingLevel`, not the session's live thinking level.

Related settings:

- `modelRoles` (record)
- `enabledModels` (scoped pattern list)
- `modelProviderOrder` (provider precedence when equivalent concrete choices share an id)
- `providers.kimiApiFormat` (`auto|openai|anthropic`; `auto` follows server-declared model metadata)
- `providers.openaiWebsockets` (`auto|off|on` websocket preference for OpenAI Codex transport)
- `providers.openaiLiveSteering` (deliver mid-response user messages into GPT-6 responses over the Codex WebSocket)

`modelRoles` stores model selectors such as `provider/modelId`; `enabledModels` and CLI `--models`
accept exact selectors, globs, and fuzzy matches. The resulting scope restricts chat models only
(Ctrl+P cycling, the startup model, chat roles in `/model`); judge, search, image, and speech
models stay available for their roles, so entries naming them are accepted but have no effect.

`enabledModels`, `enabledProviders`, and `disabledProviders` entries may also be scoped to a path prefix:

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

String entries apply everywhere. Scoped entries apply when the current working directory is the configured path or one of its subdirectories. Use `path`, `paths`, `pathPrefix`, or `pathPrefixes`; use `models` for `enabledModels`, `providers` for either provider setting, or `values` for any of them.

## `/model` and `omp models`

Both surfaces keep provider-prefixed concrete models visible and selectable.

- `/model` / `/models` opens the model hub with role assignments and provider catalogs; the session-only picker changes the active model without saving a role assignment.
- `omp models` (default `ls` action) prints provider-grouped tables of available **chat** models; `--kind <kind>` selects another catalog kind and `--kind all` includes every kind.
- `omp models find <substring>` filters by provider, id, or name; `omp models refresh` forces an online catalog re-fetch ignoring the model cache TTL; a provider name doubles as an `ls` filter (e.g. `omp models openai-codex`).
- Other flags: `--json`, `-e <path>` / `--extension <path>` (repeatable), `--no-extensions` (skip ambient discovery; explicit `-e` still loads), and `--config <overlay>` (repeatable).

JSON includes `provider`, `kind`, `id`, `selector`, `name`, limits, reasoning/thinking metadata,
declared `input`, and `cost`; it does not expose the model's transport `api`.

Selecting a provider row stores its explicit `provider/modelId`.

The table's `images` column reports what the transport will actually send, so a model whose images are
stripped (`compat.stripImageInput`, see [Image handling](#compatibility-and-routing-fields)) shows `no`
even when its spec declares `input: [text, image]`; `--json` keeps the declared `input`.

## Context promotion (model-level fallback chains)

Context promotion switches to an explicitly configured larger-context model before compaction.
It is attempted on context overflow errors and at pre-prompt or post-turn compaction thresholds.

### Trigger and order

When a turn fails with a context overflow error (e.g. `context_length_exceeded`), `AgentSession` attempts promotion **before** falling back to compaction:

1. If `contextPromotion.enabled` is true, resolve a promotion target (see below).
2. If a target is found, switch to it and retry the request — no compaction needed.
3. If no target is available, fall through to auto-compaction on the current model.

### Target selection

Selection is explicit and model-driven:

1. `currentModel.contextPromotionTarget` (if configured)

Only the configured target is considered; context promotion does not automatically choose a larger same-provider/API sibling. The target must be available, differ from the current model, have a strictly larger known context window, and resolve a usable credential (`ModelRegistry.getApiKey(...)`).

### OpenAI Codex websocket handoff

If switching from/to `openai-codex-responses`, session provider state key `openai-codex-responses` is closed before model switch. This drops websocket transport state so the next turn starts clean on the promoted model.

### Persistence behavior

Promotion uses temporary switching (`setModelTemporary`):

- recorded as a `model_change` with the ephemeral role `"fallback"` (not a durable user model selection)
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

Do not rely on a model-name-derived chain: configure the target explicitly or use a target supplied
by the provider's discovered metadata.

## Compatibility and routing fields

The `compat` block supplies sparse overrides to `packages/catalog/src/compat/resolve.ts`, after
endpoint detection and the KDL provider/model rules in `packages/catalog/src/compat/rules/`.
The YAML schema is constructed in `packages/coding-agent/src/config/models-config-schema-bundle.ts`.
The resolved shape depends on the model's API: `OpenAICompat` is the sparse OpenAI input type, while
chat-completions and Responses transports consume their corresponding resolved records from
`packages/catalog/src/types.ts`.

Endpoint-specific exceptions that interact with these fields are cataloged in [Provider endpoint constraints](./provider-endpoint-constraints.md).

`models.yml` supports the following keys (all optional; unset uses catalog rules and endpoint defaults).
Fields only affect APIs whose resolved compatibility record declares them:

Request shaping:

- `supportsStore` — emit `store: false` on requests. Default: auto (off for non-standard endpoints).
- `supportsDeveloperRole` — use the `developer` system role for reasoning models instead of `system`. Default: auto.
- `supportsMultipleSystemMessages` — preserve separate leading system/developer messages instead of coalescing them. Default: auto (known OpenAI-compatible hosted APIs preserve; strict-template/local hosts coalesce).
- `supportsUsageInStreaming` — send `stream_options: { include_usage: true }` to receive token usage on streaming responses. Default: auto (normally on, off for Cerebras hosts).
- `maxTokensField` — `"max_completion_tokens"` or `"max_tokens"`. Default: auto.
- `supportsToolChoice` — allow the `tool_choice` parameter. Default: auto. Set `false` for endpoints that 400 on `tool_choice` (e.g. DeepSeek when reasoning is on).
- `supportsForcedToolChoice` — accept a forced `tool_choice` that requires a specific tool. Default: auto. When `false`, a forced selector is downgraded to `auto` so the tool stays available for endpoints that reject forced tool calls (e.g. some thinking-required OpenAI-compatible models).
- `disableReasoningOnForcedToolChoice` — drop `reasoning_effort` / OpenRouter `reasoning` whenever `tool_choice` forces a call. Default: auto (Kimi/Anthropic-fronted endpoints).
- `disableReasoningOnToolChoice` — drop reasoning fields whenever any `tool_choice` is sent. Default: auto (DeepSeek reasoning models).
- `disableReasoningWithTools` — suppress reasoning when tools are present even without forced tool choice. Default: `false` unless catalog policy overrides it.
- `alwaysSendMaxTokens` — always send a max-token field when the caller did not provide one. Default: auto (Kimi-family models derive TPM limits from `max_tokens`).
- `strictResponsesPairing` — Responses-API tool-call/result history must be strictly paired. Default: auto (Azure OpenAI, GitHub Copilot).
- `streamIdleTimeoutMs` — stream-watchdog idle-timeout floor in ms for slow reasoning hosts. Default: auto (GLM coding-plan hosts, direct DeepSeek reasoning).
- `streamMarkupHealingPattern` — recover leaked stream control markup with the `kimi`, `dsml`, `qwen`, or `thinking` grammar. Default: endpoint/model policy.
- `cacheControlFormat` — `"anthropic"` to include Anthropic-style prompt-cache markers in chat-completions payloads. Default: auto (OpenRouter `anthropic/*` models).
- `supportsLongPromptCacheRetention` — host honors `prompt_cache_retention: "24h"` on the Responses API. Default: auto (api.openai.com).
- `supportsImageDetailOriginal` — allow the Responses API's nonstandard `detail: "original"` image
  mode where the endpoint supports it.
- `supportsConfigurationUpdate` — let the Responses API change `reasoning.effort` mid-session through a `configuration_update` input item while the request-level effort stays pinned for prompt caching (GPT-6 Astra). Default: auto (`true` for `gpt-6-astra` on every host, `false` otherwise). Set `false` for custom `openai-responses` / `openai-codex-responses` endpoints that reject the item type with HTTP 400; effort changes are then sent as the top-level `reasoning.effort` and no update items are emitted.
- `supportsSteering` — let the Codex WebSocket transport send `response.steer`, so a message typed while the model responds joins that response instead of waiting for the next request. Default: auto (`true` for the GPT-6 family). Set `false` for proxies that reject the event.
- `extraBody` — extra top-level fields merged into every request body (gateway hints, controller selectors, etc.).

Image handling:

- `stripImageInput` — drop image parts before an `openai-completions` request is encoded (including the OpenRouter chat fallback, `PI_OPENROUTER_RESPONSES=0`). The catalog's
  class rules set it for model lines that endpoints commonly serve as text-only (e.g. the DeepSeek class),
  independently of the provider's own `input` declaration, so a model can declare `input: [text, image]`
  and still send no image. Per-model `compat` is deep-merged over those rules and wins: set
  `stripImageInput: false` for an id whose endpoint really accepts `image_url` — a vision-augmenting
  proxy, for example. Default: auto (catalog class and provider rules). The Responses and Anthropic/Google
  encoders ship the modalities the model declares, as does the `pi-native` transport (it forwards the
  original context to the gateway, so the guard never runs client-side and the `images` column reports
  the declared `input`).

Reasoning / thinking:

Custom models and overrides may define `thinking` with required `mode` and `efforts`, plus
`defaultLevel`, `effortMap`, `supportsDisplay`, and `requiresEffort`. Modes are `effort`, `budget`,
`google-level`, `anthropic-adaptive`, and `anthropic-budget-effort`. Efforts are ordered
`minimal|low|medium|high|xhigh|max`. Legacy `levels` or `minLevel`/`maxLevel` shapes are normalized to
`efforts`; explicit `efforts` wins over either.
`requiresEffort` defaults to auto-detection; set it to `false` only when the
configured backend has been verified to accept an explicit reasoning-off
request. This keeps the `:off` selector from being clamped to the lowest effort.

For a custom model with the default `thinkingFormat: openai`, `--thinking off`
has no explicit off payload on `openai-completions`: when `reasoning_effort` is
sent, it requests the first effort listed in `efforts`, even with
`requiresEffort: false` (for example, `efforts: [low, medium, high]` sends
`reasoning_effort: low`), so list efforts lowest-first. Turning reasoning off
requires a request shape the server treats as off; for example,
`thinkingFormat: qwen-chat-template` sends
`chat_template_kwargs: { enable_thinking: false }`.

- `supportsReasoningEffort` — accept `reasoning_effort`. Default: endpoint/model policy; supported dialects can vary within a provider.
- `supportsReasoningParams` — whether request shaping may send reasoning params at all. Default: auto (off for GitHub Copilot chat-completions).
- `supportsReasoningSummary` — allow Responses reasoning summaries. Default: endpoint/model policy; set `false` for endpoints that reject `reasoning.summary`.
- `reasoningEffortMap` — partial map from internal effort levels (`minimal|low|medium|high|xhigh|max`) to provider-specific strings (e.g. Fireworks GLM maps `minimal -> "none"`).
- `thinkingFormat` — request shape for thinking: `"openai"` (`reasoning_effort`), `"openrouter"` (`reasoning: { effort }`), `"zai"` (`thinking: { type: "enabled" }`), `"qwen"` (top-level `enable_thinking`), or `"qwen-chat-template"` (`chat_template_kwargs.enable_thinking`). Default: endpoint/model policy, normally `"openai"`.
- `qwenTemplateReasoningEffort` — route the selected effort onto the Qwen 3.8+ chat template's `reasoning_effort` kwarg (`chat_template_kwargs.reasoning_effort`, plus the top-level field on the `qwen` dialect). Default: catalog policy (enabled for Qwen 3.8+ on LM Studio, llama.cpp discovery, and vLLM). Set `false` for strict servers that reject unknown `chat_template_kwargs`; effort selections are then not sent for the Qwen dialects and the template runs at its own default.
- `reasoningContentField` — assistant field carrying chain-of-thought: `"reasoning_content"`, `"reasoning"`, or `"reasoning_text"`. Default: auto.
- `requiresReasoningContentForToolCalls` — assistant tool-call turns must round-trip the reasoning field. Default: endpoint/model policy (including DeepSeek, Kimi, and reasoning-enabled OpenRouter).
- `allowsSyntheticReasoningContentForToolCalls` — allow a placeholder reasoning field when a prior assistant tool-call turn lacks provider reasoning content. Default: endpoint/model policy; set `false` for providers that validate the exact reasoning value.
- `requiresAssistantContentForToolCalls` — assistant tool-call turns must include non-empty text content. Default: endpoint/model policy (including Kimi and direct DeepSeek reasoning).
- `whenThinking` — partial compat overrides applied only when a request actually engages thinking mode (deep-merged over the baseline compat).

Tool / message normalization:

- `requiresToolResultName` — tool-result messages need a `name` field (Mistral). Default: auto.
- `requiresAssistantAfterToolResult` — a user message after a tool result needs an assistant turn in between. Default: auto.
- `requiresThinkingAsText` — convert thinking blocks to text wrapped in `<thinking>` delimiters (Mistral). Default: auto.
- `requiresMistralToolIds` — normalize tool-call ids to exactly 9 alphanumeric chars. Default: auto.
- `supportsStrictMode` — accept the per-tool `strict` field on tool schemas. Default: conservative auto-detect per provider/baseUrl.
- `toolStrictMode` — `"all_strict"` forces strict on every tool, `"none"` forces it off; unset uses endpoint/model policy (normally mixed, all-strict on Cerebras hosts).

Gateway routing (only applied when `baseUrl` matches the gateway):

- `openRouterRouting.only` / `openRouterRouting.order` — provider routing on `openrouter.ai` (see <https://openrouter.ai/docs/provider-routing>).
- `vercelGatewayRouting.only` / `vercelGatewayRouting.order` — provider routing on `ai-gateway.vercel.sh` (see <https://vercel.com/docs/ai-gateway/models-and-providers/provider-options>).

Provider-level `compat` is the baseline; per-model `compat` is deep-merged on top, with
`openRouterRouting`, `vercelGatewayRouting`, `extraBody`, and `whenThinking` merged as nested objects.

### Anthropic compatibility (`anthropic-messages`)

For `anthropic-messages` models the runtime uses a separate `AnthropicCompat` shape
(`packages/catalog/src/types.ts`). The `models.yml` schema exposes the strict-tools opt-out as a
top-level provider field; inside `compat` it honors every shared key that also names an
`AnthropicCompat` field: `supportsContextManagement`, `supportsEagerToolInputStreaming`,
`supportsForcedToolChoice`, `allowAnthropicHeaderOverrides`, `requiresToolResultId`,
`replayUnsignedThinking`, `bedrockMessagesApi`, `stripImageInput`, and `streamIdleTimeoutMs`. Other Anthropic-side knobs
are supplied by built-in catalog metadata and are not configurable here — `applyCompatOverrides`
drops override keys the resolved shape does not declare.

### Bedrock compatibility (`bedrock-converse-stream`)

The same `compat` slot accepts `promptCacheMode` (`none`, `automatic`, or `explicit`),
`supportsLongPromptCacheRetention`, `promptCacheMinimumTokens`,
`promptCacheMaximumCheckpoints`, and `supportsForcedToolChoice` (forced `any`/`tool` choices
fall back to `auto` when `false`; built in for Claude Opus/Sonnet 5.5) for Bedrock models.

By default `bedrock-converse-stream` requests go to `bedrock-runtime.{region}.amazonaws.com`.
An explicit per-request region or a model ARN's region wins. Otherwise an ambient region from
`AWS_REGION`/`AWS_DEFAULT_REGION`/the AWS profile is used when compatible with the inference
profile's geo prefix; a compatible guardrail ARN region or the geo's default region is the
fallback. Models without a recognized geo prefix use the ambient region, then the guardrail ARN
region, then `us-east-1`. Set `baseUrl` on `providers.amazon-bedrock` (or on a custom provider using
`api: bedrock-converse-stream`) to send requests somewhere else instead — a VPC/PrivateLink
endpoint, a FIPS host, or a gateway. Any path or query string on the `baseUrl` is kept — the path
as a prefix, the query appended to the final URL (and included in SigV4's canonical request when
signing) — so `{baseUrl}/model/{id}/converse-stream[?query]` is the final URL. That covers gateways
that authenticate via a query parameter instead of a header:

```yaml
providers:
  amazon-bedrock:
    baseUrl: https://vpce-0123456789abcdef0.bedrock-runtime.us-east-1.vpce.amazonaws.com
```

One host shape is not taken literally: a `baseUrl` of exactly
`bedrock-runtime.{region}.amazonaws.com` is AWS's own endpoint, and its region segment is replaced
with the resolved region — signing has to match the region it sends to, and every bundled Bedrock
model already carries such a `baseUrl`. Use a distinct host (VPC endpoint, `-fips`, gateway) to
pin an origin exactly.

Region resolution itself is unaffected by `baseUrl`, because SigV4 still signs with a real AWS
region — set `AWS_REGION` or use a region-scoped model id/ARN if the endpoint expects a specific
one. A gateway that accepts a bearer token instead of SigV4 needs no AWS signing credentials: set the
provider's `apiKey` (or `AWS_BEARER_TOKEN_BEDROCK`) and signing is skipped. Region resolution still
controls AWS's default host.

### Claude on Bedrock's Anthropic Messages API (`/anthropic`)

Amazon Bedrock also serves Claude through the Anthropic Messages API, under `/anthropic` on both of
its endpoints. AWS recommends `bedrock-runtime` for new applications
([Inference using Anthropic Messages API](https://docs.aws.amazon.com/bedrock/latest/userguide/inference-messages-api.html)).
Claude Opus 4.7 and later are served here; Opus 4.6 and earlier stay on Converse
([Claude in Amazon Bedrock](https://platform.claude.com/docs/en/build-with-claude/claude-in-amazon-bedrock)).

| Route | Base URL | Provider | Model id |
| --- | --- | --- | --- |
| bedrock-runtime | `https://bedrock-runtime.<region>.amazonaws.com/anthropic` | `amazon-bedrock` | inference profile, e.g. `us.anthropic.claude-opus-5-5` |
| bedrock-mantle | `https://bedrock-mantle.<region>.api.aws/anthropic` | `bedrock-mantle` | `anthropic.claude-opus-5-5` |

The FIPS host (`bedrock-runtime-fips.<region>.amazonaws.com`) and AWS PrivateLink endpoint-specific
hosts (`<vpce-id>[-<az>].bedrock-runtime.<region>.vpce.amazonaws.com`, likewise for
`bedrock-runtime-fips` and `bedrock-mantle`) are recognized as the same routes. A VPC endpoint with
private DNS enabled needs no change: it answers on the public hostnames
([Bedrock VPC endpoints](https://docs.aws.amazon.com/bedrock/latest/userguide/vpc-interface-endpoints.html)).

Define the model under the provider shown in the table, with `api: anthropic-messages`. Those two
provider ids carry the catalog rule that enables Claude's on-demand compaction
([Compaction](./compaction.md)). Set `auth: apiKey` so OMP sends plain API-key requests; without
it, custom `anthropic-messages` models get Claude Code request shaping. The examples authenticate
with an [Amazon Bedrock API key](https://docs.aws.amazon.com/bedrock/latest/userguide/api-keys.html);
OMP does not sign runtime-route requests with SigV4. Write the region into the runtime URL. Mantle
URLs may keep `{region}`, which OMP fills in from your AWS region settings.

```yaml
providers:
  amazon-bedrock:
    baseUrl: https://bedrock-runtime.us-east-1.amazonaws.com
    apiKey: AWS_BEARER_TOKEN_BEDROCK
    auth: apiKey
    models:
      - id: us.anthropic.claude-opus-5-5
        api: anthropic-messages
        baseUrl: https://bedrock-runtime.us-east-1.amazonaws.com/anthropic
        reasoning: true
        input: [text, image]
  bedrock-mantle:
    baseUrl: https://bedrock-mantle.{region}.api.aws/openai/v1
    apiKey: AWS_BEARER_TOKEN_BEDROCK
    auth: apiKey
    models:
      - id: anthropic.claude-opus-5-5
        api: anthropic-messages
        baseUrl: https://bedrock-mantle.{region}.api.aws/anthropic
        reasoning: true
        input: [text, image]
```

Requests on these routes are shaped by `compat.bedrockMessagesApi`, which OMP detects from a Bedrock
`/anthropic` `baseUrl` under any provider id. Both routes reject the tool `strict` field, so OMP drops
it. OMP also fits `metadata.user_id` to
Bedrock's [request-metadata pattern](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_Converse.html),
which the runtime route enforces: a value that fits is kept, otherwise its session id is sent,
otherwise it is left out. Both run after any `onPayload` hook. Both routes verify thinking
signatures, so by default OMP does not replay unsigned thinking to them.

The URL check cannot see a Bedrock route behind a proxy or an `ANTHROPIC_BASE_URL` reroute of the
first-party `anthropic` provider; those keep plain Anthropic requests unless you opt in. Set the flag
in `compat` (provider-wide or under `modelOverrides`) to opt in, or to `false` to opt a Bedrock URL
out:

```yaml
providers:
  anthropic:
    compat:
      bedrockMessagesApi: true # ANTHROPIC_BASE_URL points at bedrock-runtime /anthropic
```

On-demand compaction still needs a model line the catalog grants it to (`amazon-bedrock`,
`bedrock-mantle`, `anthropic`, or `google-vertex` provider ids); an arbitrary proxy provider id does
not acquire that capability just from `bedrockMessagesApi`.

### Strict tool schemas (`disableStrictTools`)

Anthropic's API supports a `strict` field on tool definitions that forces the model to always follow the provided schema exactly. OMP enables it by default for a small allowlist of high-frequency built-in `anthropic-messages` tools (`python`, `edit`, and `find`) whose schemas fit Anthropic's strict grammar limits; other tools still send normalized schemas but omit `strict`. `bash` is left out: strict decoding fixes property order, so once a call has written `async`, the `timeout` declared before it can no longer be emitted.

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
    auth: apiKey
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

Most model configuration now flows through `models.yml` / `models.yaml` via `ModelRegistry`.
Explicit `.json` / `.jsonc` paths remain supported when passed programmatically; the active agent
directory's `models.yml` takes precedence over `models.yaml`.

## Failure mode

If `models.yml` / `models.yaml` fails schema or validation checks:

- registry keeps operating with built-in models
- error is exposed via `ModelRegistry.getError()` and surfaced in UI/notifications
