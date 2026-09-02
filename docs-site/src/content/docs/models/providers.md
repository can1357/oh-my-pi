---
title: Providers
description: Connect omp to 40+ model providers with API keys, OAuth logins, local engines, or custom OpenAI-compatible endpoints.
coverage: A
---

A provider is the account or backend namespace omp routes model requests to — `anthropic`, `openai`, `google`, `ollama`, a custom gateway you define, and so on. A model is a concrete model under a provider, selected as `provider/model-id` (for example `anthropic/claude-opus-4-6`). This page covers which providers ship built in, how credentials are resolved, and how to add your own endpoints.

## How a provider becomes available

At startup the model registry assembles its catalog from four sources, in order:

1. The bundled model catalog (every built-in provider and its known models).
2. Custom provider and model entries from `~/.omp/agent/models.yml`.
3. Runtime-discovered models for providers that support discovery (local engines and discovery-enabled gateways).
4. Providers and models registered by extensions.

A model becomes selectable only when both conditions hold:

1. its provider ID is **not** in the effective `disabledProviders` list; **and**
2. the provider is either **keyless** (an implicit local provider, or a custom provider with `auth: none`) **or** has resolvable credentials.

`disabledProviders` is checked before credentials: no stored key, OAuth session, environment variable, `.env` entry, or `models.yml` `apiKey` makes a disabled provider selectable. Removing the ID from the effective list restores it.

## Supported providers

Each provider supplies its API key through one or more environment variables when no stored credential exists. OAuth-backed providers (tagged below) are normally reached through `/login` instead.

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
| `siliconflow` | `SILICONFLOW_API_KEY` |
| `siliconflow-cn` | `SILICONFLOW_CN_API_KEY` |
| `fireworks` | `FIREWORKS_API_KEY` |
| `together` | `TOGETHER_API_KEY` |
| `nvidia` | `NVIDIA_API_KEY` |
| `huggingface` | `HUGGINGFACE_HUB_TOKEN`, then `HF_TOKEN` |
| `moonshot` | `MOONSHOT_API_KEY` |
| `nanogpt` | `NANO_GPT_API_KEY` |
| `novita` | `NOVITA_API_KEY` |
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

OAuth-backed providers such as `anthropic`, `github-copilot`, `cursor`, `ollama-cloud`, `qwen-portal`, `kimi-code`, `xai-oauth`, `wafer-serverless`, `google-gemini-cli`, and `google-antigravity` are normally reached through `/login` rather than an environment variable. See [Environment variables](/oh-my-pi/configuration/environment-variables/) for the full variable reference.

## Authenticating

Use the interactive slash commands inside a session:

- `/login` opens the OAuth/key selector. `/login <provider>` jumps straight to one provider (for example `/login anthropic`); for an OAuth flow that needs a pasted callback, run `/login <redirect-url>` to complete it.
- `/logout` opens the provider selector to remove stored credentials.

Logins are **provider-scoped**: authenticating `anthropic` does not authenticate `openai`. When a model has no credentials, omp tells you to run `/login` or set the provider's environment variable. For Anthropic and ChatGPT (Codex), each organization or workspace counts as its own account — one email holding both a Team seat and a personal plan can log in once per subscription, and rotation treats them as two accounts.

Stored credentials live in the auth store at `~/.omp/agent/agent.db` (`PI_CODING_AGENT_DIR` relocates the `~/.omp/agent` base, and the auth store moves with it).

### Credential resolution order

When a provider needs an API key, omp resolves it in this order (first match wins):

1. **Runtime override** — a key supplied for the current process, for example CLI `--api-key`. Never persisted.
2. **`models.yml` config key** — an `apiKey` pinned on a custom provider. This deliberately beats stored OAuth, so a key meant for a custom `baseUrl` or gateway is honored instead of forwarding an upstream OAuth token the proxy would reject.
3. **Stored OAuth credential** — refreshed when needed; multiple accounts are ranked and rotated automatically.
4. **Login-sourced stored API key** — saved by a successful `/login`.
5. **Provider environment variable** — including values loaded from `.env` files.
6. **Other stored API key** — for example a broker-migrated key.
7. **`models.yml` fallback resolver** — keys for custom providers not otherwise registered.

### Shared credentials with the auth broker

For headless or remote setups, a shared auth broker holds OAuth refresh tokens and provider access tokens on one host instead of on each laptop. Point a client at it with `OMP_AUTH_BROKER_URL` (or `auth.broker.url` in `config.yml`) and `OMP_AUTH_BROKER_TOKEN` (or `auth.broker.token`); setting the URL puts the client in broker mode and bypasses the local credential store.

The broker itself is managed with the `omp auth-broker` subcommands:

```bash
omp auth-broker serve                  # boot the broker (default 127.0.0.1:8765)
omp auth-broker login anthropic        # run a provider's OAuth flow on the broker host
omp auth-broker login anthropic --via=user@host   # browser callback local, credential written remotely
omp auth-broker logout <provider>
omp auth-broker list                   # every registered OAuth provider
omp auth-broker status                 # health-ping the configured remote broker
omp auth-broker migrate --from-local   # upload local credentials to the broker
```

`migrate --from-local` includes local API keys by default; add `--include-oauth` for OAuth rows and `--include-env` for environment-derived keys. Re-runs are idempotent.

`omp auth-gateway serve` goes one step further: a forward-proxy (default `127.0.0.1:4000`) that accepts OpenAI Chat Completions, Anthropic Messages, OpenAI Responses, and pi-native stream requests and dispatches them with broker-resolved credentials, so clients never see an access token. It requires `OMP_AUTH_BROKER_URL`. Every endpoint except the health check requires a bearer token; transport security (Tailscale, Wireguard, reverse proxy + TLS) is up to the operator.

## Environment variables and `.env` files

omp eagerly loads `.env` files into the process environment before any provider lookup. For each variable, the first source that defines it wins, from high to low precedence:

1. The process environment inherited by omp (already-set variables always win).
2. `<cwd>/.env`
3. `~/.omp/agent/.env`
4. `~/.omp/.env`
5. `~/.env`

So a shell-exported `OPENAI_API_KEY` beats every `.env` file, and a project's `<cwd>/.env` beats your home `~/.env`. A project-local `.env` is the simplest way to make one repository use a project-specific gateway, key, or local endpoint:

```dotenv
# <project>/.env
OPENROUTER_API_KEY=sk-or-...
OLLAMA_BASE_URL=http://127.0.0.1:11434
```

`.env` parsing is intentionally minimal: blank lines and `#` comments are ignored; keys must match shell-identifier shape (`[A-Za-z_][A-Za-z0-9_]*`); values may be wrapped in single or double quotes, which are stripped; values containing a NUL byte are dropped. An `OMP_`-prefixed key is also mirrored to the matching `PI_`-prefixed name.

## Custom and OpenAI-compatible endpoints

Custom providers live in `~/.omp/agent/models.yml` under `providers:`. A provider ID defined there participates in the same selection, credential resolution, and `disabledProviders` rules as built-in providers.

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

Allowed `api` values: `openai-completions`, `openai-responses`, `openai-codex-responses`, `azure-openai-responses`, `anthropic-messages`, `google-generative-ai`, `google-gemini-cli`, and `google-vertex`.

Useful provider-level fields:

| Field | Description |
|---|---|
| `baseUrl` | Required for a full custom provider. Endpoint base URL. |
| `apiKey` | Required unless `auth: none`. Resolved as environment-variable-name-or-literal. |
| `api` | Wire protocol; required at provider level or per model. |
| `auth` | `apiKey` (default), `none`, or `oauth`. `auth: none` makes the provider keyless. |
| `authHeader` | `true` injects the resolved key as `Authorization: Bearer <key>` on every request. |
| `headers` | Extra request headers; values also support the `!command` syntax. |
| `disableStrictTools` | Set `true` for Anthropic-compatible endpoints that reject the `strict` tool field. |
| `discovery` | Fetch the model list from the endpoint at runtime (see below). |
| `modelOverrides` | Per-model metadata overrides (`name`, `reasoning`, `contextWindow`, …). |

A custom provider's `apiKey` value is first treated as an environment variable name; if no such variable exists, the literal string is the key. Prefixing the value with `!` runs it as a shell command and uses the trimmed stdout, with a 10 second timeout:

```yaml
providers:
  openai:
    apiKey: "!op read op://dev/openai/api-key"
```

A keyless local provider needs no credentials at all:

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

To fetch the model list from the endpoint instead of declaring models by hand, add a `discovery` block. Discovery types: `ollama`, `llama.cpp`, `lm-studio`, `openai-models-list`, `proxy`, and `litellm`.

```yaml
providers:
  team-proxy:
    baseUrl: https://models.example.com/v1
    apiKey: TEAM_PROXY_API_KEY
    authHeader: true
    disableStrictTools: true
    discovery:
      type: proxy
```

`discovery.type: proxy` suits Anthropic+OpenAI-compatible proxies (new-api / one-api / similar) that expose both `/v1/messages` and `/v1/chat/completions` behind one host: each discovered model's wire protocol is auto-detected from its `supported_endpoint_types`, so provider-level `api` is optional there.

Validate a custom file with `omp models` (or `omp models find <substr>` to scope it to one provider). A YAML or schema error makes the registry skip the custom file and keep operating on built-in models, surfacing the error in the UI.

## Per-provider constraints you may hit

Most endpoint quirks are handled automatically. The ones that surface as user configuration:

- **Anthropic-fronted proxies** (AWS Bedrock, Azure, self-hosted): third-party endpoints often reject the Anthropic `strict` tool-schema field. Set `disableStrictTools: true` at the provider level. omp retries without strict tools after a strict-grammar-too-large error before the first streamed token, but proxies that reject the field for other reasons need the flag explicitly.
- **Azure OpenAI**: deployment names may differ from model IDs; map them with `AZURE_OPENAI_DEPLOYMENT_NAME_MAP`.
- **DeepSeek reasoning models**: can reject `tool_choice` while thinking is enabled; the built-in compatibility metadata drops reasoning fields for those requests automatically.
- **Kimi Code**: dual-surface provider — the request format is selectable with the `providers.kimiApiFormat` setting (`openai` or `anthropic`).
- **OpenAI Codex**: the caller's max-token caps are intentionally not forwarded (the backend rejects them); websocket transport preference is set with `providers.openaiWebsockets` (`auto`, `off`, or `on`).
- **Ollama**: a `finish_reason: length` with no visible content is reported as a context-window failure.

## Built-in local engines

Three local engines are discovered automatically without a `models.yml` entry, and are keyless by default:

| Provider ID | Base URL (env override → default) |
|---|---|
| `ollama` | `OLLAMA_BASE_URL`, then `OLLAMA_HOST` (normalized), else `http://127.0.0.1:11434` |
| `llama.cpp` | `LLAMA_CPP_BASE_URL`, else `http://127.0.0.1:8080` |
| `lm-studio` | `LM_STUDIO_BASE_URL`, else `http://127.0.0.1:1234/v1` |

Their discovered models are selectable as soon as the engine answers — no login required. See [Local Models](/oh-my-pi/models/local-models/) for setup, discovery behavior, and limitations.

## Disabling providers

Use the `disabledProviders` setting to remove a provider's models from selection:

```yaml
# ~/.omp/agent/config.yml or <project>/.omp/config.yml
disabledProviders:
  - anthropic
  - openai
  - google
  - groq
```

Provider IDs are matched exactly, and disabling applies uniformly to bundled providers, custom `models.yml` providers, discovered models, extension-registered providers, and the implicit local engines. Disabling does not delete stored credentials — re-enable by removing the ID from the effective list.

Settings arrays are **replaced** wholesale by the higher-precedence layer, not merged. If the global file disables three providers and the project file `<project>/.omp/config.yml` disables one, the effective list inside the project is just the project entry — the project array re-enables the other three for sessions launched there. To *add* to the global set, repeat the global IDs in the project file. Inspect the merged value with `omp config get disabledProviders`.

Entries can also mix plain strings with path-scoped blocks that apply only when the working directory is the configured path or under it:

```yaml
disabledProviders:
  - ollama
  - path: ~/projects/sensitive
    providers:
      - anthropic
      - openai
```

Accepted path keys are `path`, `paths`, `pathPrefix`, `pathPrefixes`; accepted value keys are `providers`, `values`, `items`. `~` expands to the home directory. Because a higher-precedence layer replaces the whole array, a project-level array drops scoped entries that only existed in the global one.

:::caution
`disabledProviders` uses a single shared ID namespace that also gates **discovery providers** — sources of context files, MCP servers, commands, skills, and other capability items. The Google Gemini **API** models use the model provider ID `google`; `gemini` is a **discovery** provider ID (the source that reads `GEMINI.md`). Disable `google` to hide the API models; the OAuth-backed `google-gemini-cli` and `google-antigravity` are separate IDs and must be disabled individually.
:::

## Troubleshooting

- **A provider's models are not selectable.** Check the rule: not disabled **and** (keyless **or** has credentials). Keyless local engines only appear once the engine is actually running and responding.
- **The wrong key is used (a stale key from `.env`).** Walk the credential resolution order above: an exported shell variable beats every `.env` file, and `<cwd>/.env` beats `~/.env`. Clear the source that should not apply.
- **A provider still appears after disabling it.** Arrays are replaced, not merged — verify the *effective* list for the directory you are in with `omp config get disabledProviders`, and confirm the ID is spelled exactly.
- **A custom `models.yml` provider does not load.** Validate with `omp models find <substr>`; confirm each provider has a `baseUrl`, a valid `api`, and at least one model entry, and that an implicit local engine is not shadowing it — an explicit `ollama`/`lm-studio`/`llama.cpp` entry replaces the built-in discovery for that ID.
