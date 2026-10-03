# Providers

Providers are the model backends `omp` can route requests to: Anthropic, OpenAI, Google Gemini, Groq, OpenRouter, Mistral, xAI, local engines like Ollama, hosted gateways, custom `models.yml` providers, and providers registered by extensions.

A **provider** is the account or backend namespace, such as `anthropic`, `openai`, `google`, or `ollama`. A **model** is a concrete model under that provider, selected as `provider/model-id`, such as `anthropic/claude-opus-4-6`. Disabling a provider removes every model under it from selection; if you only want to narrow individual models, use model settings instead.

This page covers how providers become available, how credentials are resolved, the provider/environment-variable map, local engines, disabling providers, and custom providers. For endpoint-specific request, reasoning, tool, stream, usage, and retry constraints, see [Provider endpoint constraints](./provider-endpoint-constraints.md). For model selection and the full `models.yml` schema, see [Model and Provider Configuration](./models.md). For config-file locations and merge precedence, see [Settings](./settings.md). For credential storage and login flows in depth, see [Secrets and credentials](./secrets.md). For the complete environment-variable reference, see [Environment variables](./environment-variables.md). For local engine setup, see [Local models](./local-models.md). For context-file discovery providers, see [Context files](./context-files.md).

## Factory Droid

The `factory-droid` provider uses Factory's Droid subscription gateway directly. No `droid` binary, daemon, or SDK subprocess is needed for login or inference.

1. Run `omp login factory-droid` or `/login factory-droid` in an interactive session.
2. Open the printed `auth.factory.ai/device` link in your browser, enter the displayed device code, and approve the login.
3. Select a model, for example `factory-droid/kimi-k3`, and send a prompt. The stored WorkOS session refreshes automatically. `omp auth-broker login factory-droid` supports broker-backed credentials.

Use subscription OAuth for this provider. It does not discover credentials from an installed Droid CLI or read `FACTORY_API_KEY`; Factory's separate API-key products are not part of this integration.

The roster ships as KDL (`packages/catalog/src/compat/rules/providers/factory-droid.kdl`, with each model's wire and billing pool in `rules/runtime/behavior.kdl`), maintained by hand against the Droid CLI version pinned by `FACTORY_DROID_CLIENT_VERSION` (`packages/catalog/src/wire/factory-droid.ts`). It contains concrete CLI models, not the Factory Auto Model router or app-only Flex variants. Account feature flags, hard-deprecation gates, organization policy (including explicit opt-in requirements), and serving region narrow it live; new model IDs require a catalog update. Until discovery has succeeded online, feature-gated and consent-gated models stay hidden. Offline or failed discovery can retain a cached snapshot, which is not a guarantee of current entitlement.

Organization identity and residency travel with the credential serving each request, including account rotation, and each account/residency scope has its own model cache. Residency chooses the API host; the independent inference region (`global`, `us`, or `eu`) constrains upstream eligibility.

`/usage` and `omp usage` report Standard Credits and Droid Core quota windows when the account uses token-rate-limit billing. Accounts whose billing response explicitly disables that mode remain visible with a note that no quota windows are exposed; OMP does not invent a remaining balance. The model browser shows each model's base credit rate; dollar figures are upstream list-price references, not Factory billing, and neither includes temporary promotions. Models without a dollar reference display their credit rate rather than `free`. Extra balance alone does not establish that overage billing is enabled.

If account rotation would narrow the selected model's context window, OMP stops before sending that retry rather than guessing whether the existing conversation fits. Refresh discovery with `omp models refresh factory-droid` and select the region-appropriate model before retrying.

Factory's native context limits hold even when extended context is disabled. Factory GPT and Gemini routes omit output-token caps, so bounded ephemeral turns reject a `maxTokens` request instead of silently running uncapped.

## How `omp` decides a provider is available

The model registry composes these sources:

1. The bundled model catalog.
2. Custom provider and model entries from the active agent directory's `models.yml` (default: `~/.omp/agent/models.yml`).
3. Cached and runtime-discovered models for local engines and discovery-enabled hosted providers.
4. Providers and models registered by extensions, including extension-owned discovery.

Startup loads configuration and cached discovery metadata without waiting for every endpoint. Online refresh fills discovery-backed catalogs afterward. Successful authoritative discovery can replace bundled provider rows; explicit custom models and overrides are reapplied to the discovered catalog. Broker-backed gateway mode ignores local `models.yml` routing, credentials, and custom models.

The registry can hold a model even when it is not currently selectable. A model becomes **available** only when both conditions hold:

1. its provider ID is **not** in the effective `disabledProviders` list; **and**
2. the provider is either **keyless** (an implicit local provider, a custom provider with `auth: none`, or an optional-key login saved in keyless mode) **or** has configured authentication.

Availability is a fast configuration check, not a credential validation request: it does not execute command-backed keys or refresh OAuth tokens. An invalid configured key can therefore appear available and fail at inference.

`disabledProviders` is checked _before_ credentials. If a provider ID is disabled, no stored key, OAuth session, environment variable, `.env` entry, or `models.yml` `apiKey` will make it selectable — the provider's models are dropped from availability regardless of credentials. Removing the ID from the effective list restores them.

Implicit `ollama` and `lm-studio` discovery is keyless by default; implicit `llama.cpp` is keyless when no authentication is configured. Apple Foundation Models is also keyless on supported Apple Silicon systems. See [Built-in local engines](#built-in-local-engines).

## Credentials and precedence

When a provider needs an API key, `omp` resolves it in this order (first match wins):

1. **Runtime override**: a key supplied for the current process, for example CLI `--api-key`. Never persisted.
2. **`models.yml` config key**: an `apiKey` pinned on a custom provider, registered as a config-sourced bearer. This deliberately beats stored OAuth, so a key supplied for a custom `baseUrl` or gateway is honored instead of forwarding an upstream OAuth token the proxy would reject.
3. **Stored OAuth credential**: refreshed when needed; multiple accounts are ranked and rotated automatically. For Anthropic and ChatGPT (Codex), each organization or workspace counts as its own account: one email holding both a Team or Enterprise seat and a personal plan can log in once per subscription (pick the workspace on the browser consent page), and rotation treats them as two accounts.
4. **Login-sourced stored API key**: an API-key credential saved by a successful `/login`.
5. **Extension config fallback**: an extension provider registered with both an `apiKey` reference and an OAuth/login flow ranks that reference below stored OAuth and login keys.
6. **Provider environment variable**: including values loaded from `.env` files (see [the env-var table](#environment-variables-and-env-files)).
7. **Other stored API key**: for example, a broker-migrated key. This is a last resort so an explicit environment variable wins.

Local credentials live in the active auth store (default: `~/.omp/agent/agent.db`); broker mode uses the configured shared auth broker. Named profiles and Linux XDG layouts can relocate the store. In the default profile, `PI_CODING_AGENT_DIR` overrides the agent directory. See [Settings](./settings.md) and [Secrets and credentials](./secrets.md) for path resolution.

### OAuth vs API key, and provider-scoped logins

Logins are **provider-scoped**: authenticating `anthropic` does not authenticate `openai`, and each provider tracks its own credentials. A disabled provider stays disabled even with valid stored auth.

Use the interactive slash commands inside a session:

- `/login` — opens the OAuth/key selector. `/login <provider>` jumps straight to one provider (e.g. `/login anthropic`); for an OAuth flow that needs a pasted callback, run `/login <redirect-url>` to complete it.
- `/logout` — opens the provider selector to remove stored credentials.
- `/providers` — opens provider setup. When the highlighted provider has saved credentials, press `Ctrl+D` and confirm with `Enter` to remove all saved accounts and API keys for that provider; `Escape` cancels. The provider stays in the catalog, and environment variables or `models.yml` credentials are not changed. If another source still authenticates the provider, OMP reports that source. Removal uses the active credential store (local or broker-backed); it does not revoke tokens upstream or guarantee physical erasure of database bytes.

Outside a session, `omp login [<provider>]` runs the same login from the terminal, including extension-registered providers: it prints the auth URL (and opens it in your browser), reads any prompts from stdin, and saves to the same store sessions use — local `agent.db`, or the configured auth broker. Without a provider it shows a numbered picker. Successful login refreshes that provider's model catalog online so newly unlocked models are visible.

For headless or remote setups backed by a shared auth broker, the CLI exposes `omp auth-broker login <provider>` / `omp auth-broker logout` (and `status`, `list`, `import`, `migrate`). See [Secrets and credentials](./secrets.md) for the broker model.

When a model has no credentials, `omp` tells you to run `/login` or set the provider's environment variable.

For ClinePass, set `CLINE_API_KEY` or run `/login cline-pass` to open the Cline dashboard and validate a newly created API key against `/users/me`, without a completion probe or subscription-quota charge. OMP refreshes membership from Cline's public recommended-models endpoint and bundles reviewed Cline metadata for offline startup. New live IDs are enriched from upstream references or use conservative metadata without invented reasoning controls. `omp usage` reports five-hour, weekly, and monthly quota windows. Free-tier models are marked `(free)` and use the same key; subscription models show API-equivalent reference pricing, while streamed gateway cost is authoritative for the actual charge. Requests mirror Cline CLI client headers and a stable per-session task ID; reasoning controls remain model-specific.

For Command Code, set `COMMAND_CODE_API_KEY` or run `/login commandcode`; login checks the key against Command Code's `/alpha/whoami` endpoint and rejects it only on a 401, as the Command Code CLI does, so a 403 or an unreachable check keeps the key. Claude models use the Anthropic Messages endpoint, the ten GPT models use the OpenAI Responses endpoint, and every other model uses Chat Completions, the same split the Command Code CLI uses. Thinking levels, image input, output limits, and prices follow the Command Code CLI's model registry; Claude Sonnet 5.5, which that registry does not list yet, takes them from Anthropic's catalog. The GPT models can run hosted web search, but not hosted image generation, which Command Code does not serve. TypeSafe's `typesafe/jev` decision model is available to the `judge` role. `omp usage`, `/usage`, and the status line show the credit balance, plus the five-hour and weekly windows on plans that have them. These figures come from the account endpoints the Command Code CLI uses; the Provider API docs do not document them.

### Pinning a key in `models.yml`

A custom provider's `apiKey` is resolved as **environment-variable-name-or-literal**: if the value names an exact-case environment variable with a non-empty value, that value is used; otherwise the string itself is the key. Prefixing the value with `!` runs it as a shell command and uses the trimmed stdout (see [Model and Provider Configuration](./models.md) for the full value syntax).

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

The variables below supply credentials after runtime/config overrides and stored OAuth/login credentials. Providers authenticated only through login may have no key variable. Ordinary fallback names come from catalog provider KDL; auth policies can override them with ordered names or computed resolvers.

### Core providers

| Provider ID      | Environment variable(s)                                                                                                                          |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `anthropic`      | `ANTHROPIC_OAUTH_TOKEN`, then `ANTHROPIC_API_KEY` (Foundry mode prefers `ANTHROPIC_FOUNDRY_API_KEY` when `CLAUDE_CODE_USE_FOUNDRY=true`)         |
| `openai`         | `OPENAI_API_KEY`                                                                                                                                 |
| `openai-codex`   | `OPENAI_CODEX_OAUTH_TOKEN`                                                                                                                       |
| `google`         | `GEMINI_API_KEY`                                                                                                                                 |
| `google-vertex`  | `GOOGLE_CLOUD_API_KEY`, or ADC (explicit `GOOGLE_APPLICATION_CREDENTIALS` or gcloud's default ADC file, plus project and location variables; see below) |
| `groq`           | `GROQ_API_KEY`                                                                                                                                   |
| `openrouter`     | `OPENROUTER_API_KEY`                                                                                                                             |
| `mistral`        | `MISTRAL_API_KEY`                                                                                                                                |
| `xai`            | `XAI_API_KEY`                                                                                                                                    |
| `xai-oauth`      | `XAI_OAUTH_TOKEN`, then `XAI_API_KEY`                                                                                                            |
| `github-copilot` | `COPILOT_GITHUB_TOKEN`                                                                                                                           |
| `cursor`         | `CURSOR_ACCESS_TOKEN`                                                                                                                            |
| `azure`          | `AZURE_OPENAI_API_KEY`                                                                                                                           |
| `amazon-bedrock` | `AWS_BEARER_TOKEN_BEDROCK`, AWS profiles, `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY`, or an ECS/IRSA/EC2 credential chain                        |

### Additional hosted providers

| Provider ID                      | Environment variable(s)                                                       |
| -------------------------------- | ----------------------------------------------------------------------------- |
| `abliteration`                   | `ABLITERATION_API_KEY`, then `ABLIT_KEY`                                       |
| `aiand`                          | `AIAND_API_KEY`                                                               |
| `cerebras`                       | `CEREBRAS_API_KEY`                                                            |
| `alibaba-token-plan`             | `ALIBABA_TOKEN_PLAN_API_KEY`, then `BAILIAN_TOKEN_PLAN_API_KEY`               |
| `baseten`                        | `BASETEN_API_KEY`                                                             |
| `bedrock-mantle`                 | `AWS_BEARER_TOKEN_BEDROCK` or the AWS credential chain (SigV4)                 |
| `commandcode`                    | `COMMAND_CODE_API_KEY`, then `COMMANDCODE_API_KEY`                            |
| `deepinfra`                      | `DEEPINFRA_API_KEY`                                                           |
| `deepseek`                       | `DEEPSEEK_API_KEY`                                                            |
| `siliconflow`                    | `SILICONFLOW_API_KEY`                                                         |
| `siliconflow-cn`                 | `SILICONFLOW_CN_API_KEY`                                                      |
| `fireworks`                      | `FIREWORKS_API_KEY`                                                           |
| `together`                       | `TOGETHER_API_KEY`                                                            |
| `typesafe`                       | `TYPESAFE_API_KEY`                                                            |
| `coreweave`                      | `COREWEAVE_API_KEY`, then `WANDB_API_KEY`                                     |
| `nvidia`                         | `NVIDIA_API_KEY`                                                              |
| `devin`                          | `DEVIN_API_KEY`                                                               |
| `gmi-cloud`                      | `GMI_API_KEY`                                                                 |
| `huggingface`                    | `HUGGINGFACE_HUB_TOKEN`, then `HF_TOKEN`                                      |
| `moonshot`                       | `MOONSHOT_API_KEY`, then `KIMI_API_KEY`                                       |
| `stepfun`                        | `STEPFUN_API_KEY`                                                             |
| `helmcode`                       | `HELMCODE_API_KEY`                                                            |
| `meta`                           | `MODEL_API_KEY`, then `META_API_KEY`                                          |
| `nanogpt`                        | `NANO_GPT_API_KEY`                                                            |
| `novita`                         | `NOVITA_API_KEY`                                                              |
| `venice`                         | `VENICE_API_KEY`                                                              |
| `vercel-ai-gateway`              | `AI_GATEWAY_API_KEY` (also `VERCEL_AI_GATEWAY_API_KEY` for catalog discovery) |
| `cloudflare-ai-gateway`          | `CLOUDFLARE_AI_GATEWAY_API_KEY` + `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_GATEWAY_ID` |
| `litellm`                        | `LITELLM_API_KEY`; optional `LITELLM_BASE_URL` for the proxy endpoint         |
| `kilo`                           | `KILO_API_KEY`                                                                |
| `zai`                            | `ZAI_API_KEY`                                                                 |
| `zenmux`                         | `ZENMUX_API_KEY`                                                              |
| `zhipu-coding-plan`              | `ZHIPU_API_KEY`                                                               |
| `umans`                          | `UMANS_AI_CODING_PLAN_API_KEY`                                                |
| `qianfan`                        | `QIANFAN_API_KEY`                                                             |
| `qwen-portal`                    | `QWEN_OAUTH_TOKEN`, then `QWEN_PORTAL_API_KEY`                                |
| `synthetic`                      | `SYNTHETIC_API_KEY`                                                           |
| `minimax-code`                   | `MINIMAX_CODE_API_KEY`                                                        |
| `minimax-code-cn`                | `MINIMAX_CODE_CN_API_KEY`                                                     |
| `minimax`                        | `MINIMAX_API_KEY`                                                             |
| `alibaba-coding-plan`            | `ALIBABA_CODING_PLAN_API_KEY`                                                 |
| `sakana`                         | `SAKANA_API_KEY`, then `FUGU_API_KEY`                                         |
| `aimlapi`                        | `AIMLAPI_API_KEY`                                                             |
| `gitlab-duo`, `gitlab-duo-agent` | `GITLAB_TOKEN`                                                                |
| `opencode-zen`, `opencode-go`    | `OPENCODE_API_KEY`                                                            |
| `cline-pass`                     | `CLINE_API_KEY`                                                               |
| `factory-droid`                  | none — use `/login factory-droid`                                             |
| `firepass`                       | `FIREPASS_API_KEY`                                                            |
| `wafer-serverless`               | `WAFER_SERVERLESS_API_KEY`                                                    |
| `xiaomi`                         | `XIAOMI_API_KEY`                                                              |
| `xiaomi-token-plan-ams`          | `XIAOMI_TOKEN_PLAN_AMS_API_KEY`                                               |
| `xiaomi-token-plan-cn`           | `XIAOMI_TOKEN_PLAN_CN_API_KEY`                                                |
| `xiaomi-token-plan-sgp`          | `XIAOMI_TOKEN_PLAN_SGP_API_KEY`                                               |
| `ollama-cloud`                   | `OLLAMA_CLOUD_API_KEY`                                                        |
| `ollama`                         | `OLLAMA_API_KEY` (optional; local discovery is keyless by default)            |
| `lm-studio`                      | `LM_STUDIO_API_KEY` (optional; keyless by default)                            |
| `llama.cpp`                      | `LLAMA_CPP_API_KEY` (only when the server requires auth)                      |
| `vllm`                           | `VLLM_API_KEY` (optional for an unauthenticated local server)                 |
| `yolo-auto`                      | `YOLO_AUTO_API_KEY`                                                            |
| `charm-hyper`                    | `CHARM_HYPER_API_KEY`, then `HYPER_API_KEY`                                   |
| `singularityapi-dev`             | `SINGULARITYAPI_DEV_API_KEY`                                                  |
| `singularityapi-tech`            | `SINGULARITYAPI_TECH_API_KEY`                                                 |

Vertex ADC availability accepts project aliases `GOOGLE_CLOUD_PROJECT`, `GCP_PROJECT`, or `GCLOUD_PROJECT`, and location aliases `GOOGLE_VERTEX_LOCATION`, `GOOGLE_CLOUD_LOCATION`, or `VERTEX_LOCATION`.

For `xai-oauth`, `XAI_API_KEY` is accepted for an explicit request but does not automatically make SuperGrok models available or preferred; automatic availability requires its dedicated `XAI_OAUTH_TOKEN` or stored/configured auth.

`/login cloudflare-ai-gateway` prompts for the gateway token, Cloudflare account ID, and gateway ID, then stores all three together. To use environment variables, set all three values listed above. OMP selects the Anthropic, OpenAI, or Workers AI gateway route for each model; you do not need a `models.yml` base URL override.

`charm-hyper` is Charm's OpenAI-compatible inference gateway for coding agents. Issue or manage a key at `https://hyper.charm.land/`; the model list is discovered live from the provider's public `/v1/models` endpoint, and `HYPER_API_KEY` is accepted as a fallback alias for `CHARM_HYPER_API_KEY`.

SingularityAPI sells two unrelated products behind one brand, so OMP models them as two providers: they share no key, no billing model, and no effort ladder, and neither key is accepted by the other host.

`singularityapi-dev` is the pay-as-you-go universal inference gateway (300+ models: DeepSeek, Kimi, GLM, frontier flagships). Create a key at `https://app.singularityapi.dev` (or run `/login singularityapi-dev`) and set `SINGULARITYAPI_DEV_API_KEY`; the roster, limits, and tariffs are discovered live from `https://api.singularityapi.dev/v1/models`.

`singularityapi-tech` is the reserved DeepSeek lanes gateway. Usage bills against a booked reservation slot rather than prepaid credit, so a valid key with no active slot answers 403 until you book one at `https://app.singularityapi.tech`. Create an `sk-...` key there (or run `/login singularityapi-tech`), set `SINGULARITYAPI_TECH_API_KEY`, and the lane roster is discovered live from `https://api.singularityapi.tech/v1/models`.

OAuth-backed providers such as `anthropic`, `openai-codex`, `github-copilot`, `cursor`, `muse-code`, `ollama-cloud`, `qwen-portal`, `kimi-code`, `xai-oauth`, `wafer-serverless`, `google-gemini-cli`, `google-antigravity`, `devin`, and the GitLab providers (`gitlab-duo`, `gitlab-duo-agent`) are normally reached through `/login` rather than an environment variable. Interactive API-key logins exist too: `/login baseten`, `/login coreweave`, `/login sakana`, `/login singularityapi-dev`, and `/login singularityapi-tech` prompt for a dashboard/API key (`coreweave` additionally requires `COREWEAVE_PROJECT` for the `OpenAI-Project` header). See [Environment variables](./environment-variables.md) for search-tool and configuration variables not listed here.

### `.env` discovery and precedence

`omp` eagerly loads four `.env` files into the process environment before provider lookup. For each variable, the first **non-empty** source wins. Effective precedence, high to low:

1. Non-empty values already in the process environment.
2. `<project>/.env`
3. The active agent directory's `.env` (default: `~/.omp/agent/.env`).
4. The active config root's `.env` (default: `~/.omp/.env`).
5. `~/.env`

Existing non-empty process values are not overwritten; empty values can be filled by a later file. A non-empty project value beats the agent, config-root, and home files. Named profiles use their own config root and agent directory. Bun may also preload project dotenv variants before this loader; values already present are treated as process values.

Project-local `.env` is the simplest way to make one repository use a project-specific gateway, key, or local endpoint:

```dotenv
# <project>/.env
OPENROUTER_API_KEY=sk-or-...
OLLAMA_BASE_URL=http://127.0.0.1:11434
```

`.env` files use Node's `parseEnv` grammar, including comments, quoted/multiline values, and `export` prefixes. After parsing:

- keys must match `[A-Za-z_][A-Za-z0-9_]*` — other names are dropped;
- values containing a NUL byte are dropped;
- an `OMP_`-prefixed key is mirrored to the matching `PI_` name, overriding a same-file `PI_` entry.

## Built-in local engines

Ollama, llama.cpp, and LM Studio are discovered automatically without needing a `models.yml` entry. Each uses a base URL that can be overridden by an environment variable:

| Provider ID | Base URL (env override → default)                                                 | Notes                                           |
| ----------- | --------------------------------------------------------------------------------- | ----------------------------------------------- |
| `ollama`    | `OLLAMA_BASE_URL`, then `OLLAMA_HOST` (normalized), else `http://127.0.0.1:11434` | Keyless by default.                             |
| `llama.cpp` | `LLAMA_CPP_BASE_URL`, else `http://127.0.0.1:8080`                                | Keyless unless authentication is configured.    |
| `lm-studio` | `LM_STUDIO_BASE_URL`, else `http://127.0.0.1:1234/v1`                             | Keyless by default.                             |

Implicit Ollama and llama.cpp models use `openai-responses`; LM Studio uses `openai-completions`. On macOS arm64, `apple` also probes the in-process Apple Foundation Models bridge (`local://apple-foundation-models`). It offers `apple/on-device` only when the bridge reports the model usable; an ineligible device, disabled Apple Intelligence, or build without the bridge yields no models.

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

The project array re-enables `anthropic`, `openai`, and `google` for sessions launched from that project. If you want a project to _add_ to the global set, repeat the global IDs in the project file. See [Settings](./settings.md) for the full precedence chain, including `--config` overlays and runtime overrides.

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

Path scopes are resolved **after** the settings merge. Because a higher-precedence layer replaces the whole array, a project-level `disabledProviders` array drops any scoped entries that only existed in the global array. `enabledModels` and `enabledProviders` also support this form. See [Settings](./settings.md) for details.

## Provider IDs vs discovery provider IDs

`disabledProviders` uses a **single shared ID namespace** that gates two different subsystems:

- **Model providers** — the backends on this page (`anthropic`, `openai`, `ollama`, a custom `models.yml` ID, …). Disabling one removes its models from selection.
- **Discovery providers** — sources of context files, MCP servers, commands, skills, hooks, tools, prompts, and settings. Disabling one stops that source from contributing capability items.

| Entry type            | Examples                                                                      | Effect                                                          |
| --------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Model provider ID     | `anthropic`, `openai`, `google`, `groq`, `openrouter`, `ollama`, `my-gateway` | Removes that provider's models from availability.               |
| Discovery provider ID | `native`, `claude`, `codex`, `gemini`, `agents`, `github`                     | Stops that discovery source from contributing capability items. |

`enabledProviders` controls opt-in user-level foreign discovery sources; it is not a model-provider allowlist. Project-level foreign sources have separate discovery behavior. Use model settings to narrow model selection.

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

### Zhipu BigModel account-balance keys

`/login zai` targets the global Z.AI Coding Plan endpoint, and `/login zhipu-coding-plan` targets the domestic Zhipu Coding Plan endpoint. Neither flow configures the general pay-as-you-go BigModel endpoint at `https://open.bigmodel.cn/api/paas/v4`.

Use a custom provider for an API key issued from a standard BigModel account balance:

```yaml
providers:
  bigmodel:
    baseUrl: https://open.bigmodel.cn/api/paas/v4
    api: openai-completions
    apiKey: BIGMODEL_API_KEY
    models:
      - id: glm-4.6
        name: GLM-4.6 (BigModel)
```

Set `BIGMODEL_API_KEY` to the `<id>.<secret>` key before starting `omp`, then select `bigmodel/glm-4.6`. The key does not use an `sk-` prefix.

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

**A provider's models are not selectable.** Confirm the provider has credentials (`/login <provider>`, an exported environment variable, or a `models.yml` `apiKey`) and that its ID is not in the effective `disabledProviders` list. Remember the rule: not disabled **and** (keyless **or** has credentials). A local engine must respond to populate discovery initially; cached catalog rows may remain visible later, but inference still needs the engine. Apple availability is checked through its in-process bridge.

**The wrong key is being used (a stale key from `.env`).** Resolution favors runtime `--api-key`, then a `models.yml` config key, stored OAuth, a key saved by `/login`, extension config fallbacks, environment or `.env`, and other stored API keys. A non-empty process environment variable also beats every `.env` file, and a non-empty `<project>/.env` value beats `~/.env`. If an unexpected key wins, check for an exported shell variable and the four `.env` files in precedence order, and clear the one that should not apply.

**A provider still appears even though I disabled it.** `disabledProviders` arrays are replaced, not merged: a project `<project>/.omp/config.yml` array fully overrides the global one. Verify the _effective_ list for the directory you are in (path-scoped entries only apply at or under their configured path), and confirm the ID is spelled exactly. Use `omp config get disabledProviders` to inspect the merged value (see [Settings](./settings.md)).

**A discovery provider name had no effect on models (or vice-versa).** The ID namespace is shared. `gemini`, `codex`, `claude`, `native`, and `agents` are discovery-source IDs; the Google model backend is `google`. Make sure you are disabling the right kind of provider.

**A custom `models.yml` provider does not load.** A YAML or schema error makes the registry skip the custom file. Validate the file with `omp models` (use `omp models find <substr>` to scope it to one provider). A provider with custom `models` needs `baseUrl`, authentication (`apiKey`, unless `auth: none` or `auth: oauth`), and `api` at provider level or on every model. A provider with no models is also valid when it defines at least one supported override (`baseUrl`, `headers`, `apiKey`, `auth: none`, `compat`, `disableStrictTools`, `guardrailIdentifier`, `requestMetadata`, `remoteCompaction`, `modelOverrides`, or `discovery`). Discovery providers may omit `models`, but need provider-level `api` unless `discovery.type` is `proxy`. An explicit `ollama`, `lm-studio`, or `llama.cpp` entry intentionally replaces built-in discovery for that ID. See [Model and Provider Configuration](./models.md).
