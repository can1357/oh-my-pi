# Providers

Providers are the model backends `omp` can route requests to: Anthropic, OpenAI, Google Gemini, Groq, OpenRouter, Mistral, xAI, local engines like Ollama, hosted gateways, custom `models.yml` providers, and providers registered by extensions.

A **provider** is the account or backend namespace, such as `anthropic`, `openai`, `google`, or `ollama`. A **model** is a concrete model under that provider, selected as `provider/model-id`, such as `anthropic/claude-opus-4-6`. Disabling a provider removes every model under it from selection; if you only want to narrow individual models, use model settings instead.

This page covers how providers become available, how credentials are resolved, the provider/environment-variable map, local engines, disabling providers, and custom providers. For endpoint-specific request, reasoning, tool, stream, usage, and retry constraints, see [Provider endpoint constraints](./provider-endpoint-constraints.md). For model selection and the full `models.yml` schema, see [Model and Provider Configuration](./models.md). For config-file locations and merge precedence, see [Settings](./settings.md). For credential storage and login flows in depth, see [Secrets and credentials](./secrets.md). For the complete environment-variable reference, see [Environment variables](./environment-variables.md). For local engine setup, see [Local models](./local-models.md). For context-file discovery providers, see [Context files](./context-files.md).

## How `omp` decides a provider is available

At startup the model registry assembles its catalog from four sources, in order:

1. The bundled model catalog (every built-in provider and its known models).
2. Custom provider and model entries from `~/.omp/agent/models.yml`.
3. Runtime-discovered models for providers that support discovery (local engines and discovery-enabled gateways).
4. Providers and models registered by extensions.

The registry can hold a model even when it is not currently selectable. A model becomes **available** only when both conditions hold:

1. its provider ID is **not** in the effective `disabledProviders` list; **and**
2. the provider is either **keyless** (an implicit local provider, or a custom provider with `auth: none`) **or** has resolvable credentials.

`disabledProviders` is checked *before* credentials. If a provider ID is disabled, no stored key, OAuth session, environment variable, `.env` entry, or `models.yml` `apiKey` will make it selectable — the provider's models are dropped from availability regardless of credentials. Removing the ID from the effective list restores them.

Keyless local engines are a special case: `ollama`, `llama.cpp`, and `lm-studio` are treated as keyless when no key is configured, so their discovered models are selectable as soon as the engine answers — no login required. See [Built-in local engines](#built-in-local-engines).

## Credentials and precedence

When a provider needs an API key, `omp` resolves it in this order (first match wins):

1. **Runtime override** — a key supplied for the current process, e.g. CLI `--api-key`. Never persisted.
2. **`models.yml` config key** — an `apiKey` pinned on a custom provider, registered as a config-sourced bearer. This deliberately beats stored OAuth, so a key supplied for a custom `baseUrl`/gateway is honored instead of forwarding an upstream OAuth token the proxy would reject.
3. **Stored API key** — an API-key credential saved in the auth store.
4. **Stored OAuth credential** — refreshed when needed; multiple accounts are ranked/rotated automatically.
5. **Provider environment variable** — including values loaded from `.env` files (see [the env-var table](#environment-variables-and-env-files)).
6. **`models.yml` fallback resolver** — keys for custom providers not otherwise registered.

Stored credentials live in the auth store at `~/.omp/agent/agent.db` for local auth, or in the configured auth-broker snapshot when running in broker mode. (`PI_CODING_AGENT_DIR` relocates the `~/.omp/agent` base, and the auth store moves with it.)

### OAuth vs API key, and provider-scoped logins

Logins are **provider-scoped**: authenticating `anthropic` does not authenticate `openai`, and each provider tracks its own credentials. A disabled provider stays disabled even with valid stored auth.

Use the interactive slash commands inside a session:

- `/login` — opens the OAuth/key selector. `/login <provider>` jumps straight to one provider (e.g. `/login anthropic`); for an OAuth flow that needs a pasted callback, run `/login <redirect-url>` to complete it.
- `/logout` — opens the provider selector to remove stored credentials.

For headless or remote setups backed by a shared auth broker, the CLI exposes `omp auth-broker login <provider>` / `omp auth-broker logout` (and `status`, `list`, `import`, `migrate`). See [Secrets and credentials](./secrets.md) for the broker model.

When a model has no credentials, `omp` tells you to run `/login` or set the provider's environment variable.

### Pinning a key in `models.yml`

A custom provider's `apiKey` is resolved as **environment-variable-name-or-literal**: if the value names an existing environment variable, that variable's value is used; otherwise the string itself is the key. Prefixing the value with `!` runs it as a shell command and uses the trimmed stdout (see [Model and Provider Configuration](./models.md) for the full value syntax).

```yaml
# ~/.omp/agent/models.yml
providers:
  my-gateway:
    baseUrl: https://gateway.example.com/v1
    api: openai-completions
    apiKey: MY_GATEWAY_API_KEY # reads this env var if set, else literal text
    models:
      - id: claude-sonnet
        name: Claude Sonnet via Gateway
        contextWindow: 200000
        maxTokens: 8192
```

If `authHeader: true` is set on a custom provider, the resolved key is injected as an `Authorization: Bearer <key>` header on every request to that provider.

## Environment variables and `.env` files

Each provider has one or more environment variables that supply a key when no stored credential exists. The table below is the verified provider → variable map; the full catalog is large, so it is split into core and additional providers. OAuth-backed providers can also accept a token variable in addition to (or instead of) an API key.

### Core providers

| Provider ID | Environment variable(s) |
|---|---|
| `anthropic` | `ANTHROPIC_OAUTH_TOKEN`, then `ANTHROPIC_API_KEY` (Foundry mode prefers `ANTHROPIC_FOUNDRY_API_KEY` when `CLAUDE_CODE_USE_FOUNDRY=true`) |
| `openai` | `OPENAI_API_KEY` |
| `openai-codex` | `OPENAI_CODEX_OAUTH_TOKEN` |
| `google` | `GEMINI_API_KEY` |
| `google-vertex` | `GOOGLE_CLOUD_API_KEY`, or Application Default Credentials (`GOOGLE_APPLICATION_CREDENTIALS` + `GOOGLE_CLOUD_PROJECT` + `GOOGLE_CLOUD_LOCATION`) |
| `groq` | `GROQ_API_KEY` |
| `openrouter` | `OPENROUTER_API_KEY` |
| `mistral` | `MISTRAL_API_KEY` |
| `xai` | `XAI_API_KEY` |
| `xai-oauth` | `XAI_OAUTH_TOKEN`, then `XAI_API_KEY` |
| `github-copilot` | `COPILOT_GITHUB_TOKEN` |
| `cursor` | `CURSOR_ACCESS_TOKEN` |
| `azure` | `AZURE_OPENAI_API_KEY` |
| `amazon-bedrock` | `AWS_PROFILE`, or `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY`, or an ECS/IRSA credential chain |

### Additional hosted providers

| Provider ID | Environment variable(s) |
|---|---|
| `cerebras` | `CEREBRAS_API_KEY` |
| `deepseek` | `DEEPSEEK_API_KEY` |
| `fireworks` | `FIREWORKS_API_KEY` |
| `together` | `TOGETHER_API_KEY` |
| `nvidia` | `NVIDIA_API_KEY` |
| `huggingface` | `HUGGINGFACE_HUB_TOKEN`, then `HF_TOKEN` |
| `moonshot` | `MOONSHOT_API_KEY` |
| `nanogpt` | `NANO_GPT_API_KEY` |
| `venice` | `VENICE_API_KEY` |
| `vercel-ai-gateway` | `AI_GATEWAY_API_KEY` (also `VERCEL_AI_GATEWAY_API_KEY` for catalog discovery) |
| `cloudflare-ai-gateway` | `CLOUDFLARE_AI_GATEWAY_API_KEY` |
| `litellm` | `LITELLM_API_KEY`; optional `LITELLM_BASE_URL` for the proxy endpoint |
| `kilo` | `KILO_API_KEY` |
| `zai` | `ZAI_API_KEY` |
| `zenmux` | `ZENMUX_API_KEY` |
| `zhipu-coding-plan` | `ZHIPU_API_KEY` |
| `umans` | `UMANS_AI_CODING_PLAN_API_KEY` |
| `qianfan` | `QIANFAN_API_KEY` |
| `qwen-portal` | `QWEN_OAUTH_TOKEN`, then `QWEN_PORTAL_API_KEY` |
| `synthetic` | `SYNTHETIC_API_KEY` |
| `minimax` | `MINIMAX_API_KEY` |
| `alibaba-coding-plan` | `ALIBABA_CODING_PLAN_API_KEY` |
| `aimlapi` | `AIMLAPI_API_KEY` |
| `gitlab-duo` | `GITLAB_TOKEN` |
| `opencode-zen`, `opencode-go` | `OPENCODE_API_KEY` |
| `firepass` | `FIREPASS_API_KEY` |
| `wafer-serverless` | `WAFER_SERVERLESS_API_KEY` |
| `xiaomi` | `XIAOMI_API_KEY` |
| `ollama-cloud` | `OLLAMA_CLOUD_API_KEY` |
| `ollama` | `OLLAMA_API_KEY` (optional; local discovery is keyless by default) |
| `lm-studio` | `LM_STUDIO_API_KEY` (optional; keyless by default) |
| `llama.cpp` | `LLAMA_CPP_API_KEY` (only when the server requires auth) |

OAuth-backed providers such as `anthropic`, `github-copilot`, `cursor`, `ollama-cloud`, `qwen-portal`, `kimi-code`, `xai-oauth`, `wafer-serverless`, `google-gemini-cli`, and `google-antigravity` are normally reached through `/login` rather than an environment variable. See [Environment variables](./environment-variables.md) for search-tool and configuration variables not listed here.

### `.env` discovery and precedence

`omp` eagerly loads `.env` files into the process environment before any provider lookup. It reads four files and, for each variable, the **first** source that defines it wins. Effective precedence, high to low:

1. The process environment inherited by `omp` (already-set variables always win).
2. `<cwd>/.env`
3. `~/.omp/agent/.env`
4. `~/.omp/.env`
5. `~/.env`

A variable already present in the process environment is never overwritten by a `.env` file. Among the files, a value set in `<cwd>/.env` wins over `~/.omp/agent/.env`, which wins over `~/.omp/.env`, which wins over `~/.env`. So a shell-exported `OPENAI_API_KEY` beats every `.env` file, and a project's `<cwd>/.env` beats your home `~/.env`.

Project-local `.env` is the simplest way to make one repository use a project-specific gateway, key, or local endpoint:

```dotenv
# <project>/.env
OPENROUTER_API_KEY=sk-or-...
OLLAMA_BASE_URL=http://127.0.0.1:11434
```

`.env` parsing is intentionally minimal:

- blank lines and lines starting with `#` are ignored;
- keys must match `[A-Za-z_][A-Za-z0-9_]*` (shell-identifier shape) — other names are dropped;
- values may be wrapped in single or double quotes, which are stripped;
- values containing a NUL byte are dropped;
- an `OMP_`-prefixed key is also mirrored to the matching `PI_`-prefixed name.

## Built-in local engines

Three local engines are discovered automatically without needing a `models.yml` entry. Each uses a base URL that can be overridden by an environment variable:

| Provider ID | Base URL (env override → default) | Notes |
|---|---|---|
| `ollama` | `OLLAMA_BASE_URL`, then `OLLAMA_HOST` (normalized), else `http://127.0.0.1:11434` | Keyless by default. |
| `llama.cpp` | `LLAMA_CPP_BASE_URL`, else `http://127.0.0.1:8080` | Keyless unless a key is stored for `llama.cpp`. |
| `lm-studio` | `LM_STUDIO_BASE_URL`, else `http://127.0.0.1:1234/v1` | Keyless by default. |

These implicit engines are **skipped** when:

- a provider with the same ID is already configured in `models.yml` (your explicit config wins); or
- the provider ID appears in the effective `disabledProviders` list.

For installing and running these engines, see [Local models](./local-models.md).

## Disabling model providers

Use the `disabledProviders` setting to remove a provider's models from selection:

```yaml
# ~/.omp/agent/config.yml or <project>/.omp/config.yml
disabledProviders:
  - anthropic
  - openai
  - google
  - groq
```

Provider IDs are matched exactly. Disable `google` to hide the Google Gemini API provider; the OAuth-backed Google providers `google-gemini-cli` and `google-antigravity` are separate IDs and must be disabled individually. Disable `ollama`, `llama.cpp`, or `lm-studio` to stop local discovery for that engine.

`disabledProviders` applies uniformly to:

- bundled catalog providers;
- custom `models.yml` providers;
- runtime-discovered provider models;
- extension-registered providers;
- implicit local engines.

Disabling a provider does not delete its stored credentials — re-enable it by removing its ID from the effective list.

## Project-specific provider control

Project settings live in `<project>/.omp/config.yml`. Use them when one repository must allow or hide a different provider set than your global default:

```yaml
# <project>/.omp/config.yml
disabledProviders:
  - openai
  - openrouter
```

Settings arrays are **replaced** wholesale by the higher-precedence layer, not merged or appended. If the global file disables three providers and the project file disables one, the project sees only the project list:

```yaml
# ~/.omp/agent/config.yml
disabledProviders:
  - anthropic
  - openai
  - google

# <project>/.omp/config.yml
disabledProviders:
  - groq
```

Effective result inside the project:

```json
["groq"]
```

The project array re-enables `anthropic`, `openai`, and `google` for sessions launched from that project. If you want a project to *add* to the global set, repeat the global IDs in the project file. See [Settings](./settings.md) for the full precedence chain, including `--config` overlays and runtime overrides.

## Path-scoped `disabledProviders`

`disabledProviders` can mix plain string entries (apply everywhere) with path-scoped entries (apply only when the current working directory matches a configured path):

```yaml
disabledProviders:
  - ollama
  - path: ~/projects/sensitive
    providers:
      - anthropic
      - openai
  - paths:
      - ~/work/client-a
      - ~/work/client-b
    values:
      - openrouter
```

- Bare string entries always apply.
- A scoped entry applies when the current working directory **is** the configured path or sits **under** it. `~` expands to the home directory.
- Accepted path keys: `path`, `paths`, `pathPrefix`, `pathPrefixes`.
- Accepted value keys: `providers`, `values`, `items`.

For the example above:

- `ollama` is disabled everywhere.
- `anthropic` and `openai` are additionally disabled under `~/projects/sensitive`.
- `openrouter` is additionally disabled under `~/work/client-a` and `~/work/client-b`.

Path scopes are resolved **after** the settings merge. Because a higher-precedence layer replaces the whole array, a project-level `disabledProviders` array drops any scoped entries that only existed in the global array. `enabledModels` is the only other setting that supports the same path-scoped form. See [Settings](./settings.md) for details.

## Provider IDs vs discovery provider IDs

`disabledProviders` uses a **single shared ID namespace** that gates two different subsystems:

- **Model providers** — the backends on this page (`anthropic`, `openai`, `ollama`, a custom `models.yml` ID, …). Disabling one removes its models from selection.
- **Discovery providers** — sources of context files, MCP servers, commands, skills, hooks, tools, prompts, and settings. Disabling one stops that source from contributing capability items.

| Entry type | Examples | Effect |
|---|---|---|
| Model provider ID | `anthropic`, `openai`, `google`, `groq`, `openrouter`, `ollama`, `my-gateway` | Removes that provider's models from availability. |
| Discovery provider ID | `native`, `claude`, `codex`, `gemini`, `agents`, `github` | Stops that discovery source from contributing capability items. |

Watch the related names. The Google Gemini **API** models use the model provider ID `google`; `gemini` is a **discovery** provider ID (the source that reads `GEMINI.md`), not the Google model provider. Use discovery IDs only when you intend to disable an entire config source. See [Context files](./context-files.md) for the discovery-provider side.

## Custom providers in `models.yml`

Custom providers live in `~/.omp/agent/models.yml` under `providers:`. A provider ID defined there participates in the same selection, credential resolution, and `disabledProviders` rules as built-in providers.

Minimal OpenAI-compatible provider:

```yaml
providers:
  my-openai-compatible:
    baseUrl: https://api.example.com/v1
    api: openai-completions
    apiKey: MY_OPENAI_COMPATIBLE_KEY # env-var-name or literal
    models:
      - id: fast-chat
        name: Fast Chat
        contextWindow: 128000
        maxTokens: 8192
```

Keyless local provider (no credentials required):

```yaml
providers:
  local-proxy:
    baseUrl: http://127.0.0.1:4000/v1
    api: openai-completions
    auth: none
    models:
      - id: local-model
        name: Local Model
        contextWindow: 32768
        maxTokens: 4096
```

Discovery-enabled provider (models fetched from the endpoint at runtime):

```yaml
providers:
  team-proxy:
    baseUrl: https://models.example.com/v1
    apiKey: TEAM_PROXY_API_KEY
    authHeader: true # send Authorization: Bearer <resolved key>
    disableStrictTools: true
    discovery:
      type: proxy
```

For the full schema, all allowed `api` values, discovery `type`s, model overrides, and equivalence settings, see [Model and Provider Configuration](./models.md).

To disable a custom provider, list its ID exactly:

```yaml
disabledProviders:
  - my-openai-compatible
  - team-proxy
```

## Troubleshooting

**A provider's models are not selectable.** Confirm the provider has credentials (`/login <provider>`, an exported environment variable, or a `models.yml` `apiKey`) and that its ID is not in the effective `disabledProviders` list. Remember the rule: not disabled **and** (keyless **or** has credentials). Keyless local engines only appear once the engine is actually running and responding.

**The wrong key is being used (a stale key from `.env`).** Resolution favors runtime `--api-key`, then a `models.yml` config key, then stored credentials, then environment/`.env`. An already-set process environment variable also beats every `.env` file, and `<cwd>/.env` beats `~/.env`. If an unexpected key wins, check for an exported shell variable and the four `.env` files in precedence order, and clear the one that should not apply.

**A provider still appears even though I disabled it.** `disabledProviders` arrays are replaced, not merged: a project `<project>/.omp/config.yml` array fully overrides the global one. Verify the *effective* list for the directory you are in (path-scoped entries only apply at or under their configured path), and confirm the ID is spelled exactly. Use `omp config get disabledProviders` to inspect the merged value (see [Settings](./settings.md)).

**A discovery provider name had no effect on models (or vice-versa).** The ID namespace is shared. `gemini`, `codex`, `claude`, `native`, and `agents` are discovery-source IDs; the Google model backend is `google`. Make sure you are disabling the right kind of provider.

**A custom `models.yml` provider does not load.** A YAML or schema error makes the registry skip the custom file. Validate the file with `omp models` (use `omp models find <substr>` to scope it to one provider), confirm each provider has a `baseUrl`, a valid `api`, and at least one model entry, and that an implicit local engine is not silently shadowing it (an explicit `ollama`/`lm-studio`/`llama.cpp` entry replaces the built-in discovery for that ID). See [Model and Provider Configuration](./models.md).
