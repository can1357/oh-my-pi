---
title: Environment Variables
description: Every environment variable omp understands, grouped by subsystem, with the config keys they override.
coverage: A
---

Environment variables are the primary way to give omp API keys and to override runtime behavior without editing config files. This page lists every variable the current runtime reads, grouped by subsystem. Where a variable overrides or defers to a persisted setting, the config key is named.

## How omp loads environment variables

Most runtime lookups go through a layered loader. Values are resolved in this order, and a key already set at an earlier layer is never overwritten by a later one:

1. The process environment.
2. Project `.env` (`$PWD/.env`).
3. Agent `.env` (`~/.omp/agent/.env`, respecting `PI_CONFIG_DIR` / `PI_CODING_AGENT_DIR`).
4. Config-root `.env` (`~/.omp/.env`, respecting `PI_CONFIG_DIR`).
5. Home `.env` (`~/.env`).

Inside each `.env` file, `OMP_*` keys are mirrored to the equivalent `PI_*` keys.

:::caution
Treat provider keys, OAuth tokens, cloud credentials, and Foundry mTLS material (`CLAUDE_CODE_CLIENT_CERT`, `CLAUDE_CODE_CLIENT_KEY`, `NODE_EXTRA_CA_CERTS` when it points at private CA bundles) as secrets. Do not log or commit them, and remember that `.env` files in this chain are read from your project directory.
:::

## Model and provider authentication

### Core provider credentials

| Variable | Used for | Notes |
| --- | --- | --- |
| `ANTHROPIC_OAUTH_TOKEN` | Anthropic auth | Takes precedence over `ANTHROPIC_API_KEY` |
| `ANTHROPIC_API_KEY` | Anthropic auth | Fallback after `ANTHROPIC_OAUTH_TOKEN` |
| `ANTHROPIC_FOUNDRY_API_KEY` | Anthropic via Azure Foundry / enterprise gateway | Takes precedence over both of the above when Foundry mode is enabled |
| `OPENAI_API_KEY` | OpenAI auth | Used by OpenAI Completions/Responses providers |
| `GEMINI_API_KEY` | Google Gemini auth | Primary key for the `google` provider |
| `GOOGLE_API_KEY` | Gemini image tool auth | Fallback for the `gemini_image` tool when `GEMINI_API_KEY` is unset |
| `GROQ_API_KEY` | Groq auth | |
| `CEREBRAS_API_KEY` | Cerebras auth | |
| `FIREWORKS_API_KEY` | Fireworks auth | |
| `FIREPASS_API_KEY` | Fire Pass auth | |
| `TOGETHER_API_KEY` | Together auth | |
| `AIMLAPI_API_KEY` | AIML API auth | OpenAI-compatible endpoint at `https://api.aimlapi.com/v1` |
| `HUGGINGFACE_HUB_TOKEN` | Hugging Face auth | Primary token |
| `HF_TOKEN` | Hugging Face auth | Fallback when `HUGGINGFACE_HUB_TOKEN` is unset |
| `SYNTHETIC_API_KEY` | Synthetic auth | |
| `NVIDIA_API_KEY` | NVIDIA auth | |
| `NANO_GPT_API_KEY` | NanoGPT auth | |
| `NOVITA_API_KEY` | Novita auth | |
| `VENICE_API_KEY` | Venice auth | |
| `LITELLM_API_KEY` | LiteLLM auth | OpenAI-compatible LiteLLM proxy key |
| `LM_STUDIO_API_KEY` | LM Studio auth (optional) | Local LM Studio usually runs without auth; any non-empty token works when a key is required |
| `OLLAMA_API_KEY` | Ollama auth (optional) | Local Ollama usually runs without auth; any non-empty token works when a key is required |
| `LLAMA_CPP_API_KEY` | llama.cpp auth (optional) | Local llama.cpp usually runs without auth; any non-empty token works when a key is configured |
| `XIAOMI_API_KEY` | Xiaomi MiMo auth | |
| `XIAOMI_TOKEN_PLAN_AMS_API_KEY` | Xiaomi MiMo Token Plan (AMS) | |
| `XIAOMI_TOKEN_PLAN_CN_API_KEY` | Xiaomi MiMo Token Plan (CN) | |
| `XIAOMI_TOKEN_PLAN_SGP_API_KEY` | Xiaomi MiMo Token Plan (SGP) | |
| `MOONSHOT_API_KEY` | Moonshot auth | |
| `XAI_API_KEY` | xAI auth | Also fallback for `xai-oauth` |
| `XAI_OAUTH_TOKEN` | xAI OAuth/SuperGrok auth | Takes precedence over `XAI_API_KEY` for `xai-oauth` |
| `OPENROUTER_API_KEY` | OpenRouter auth | Also used by the image tool when the preferred/auto provider is OpenRouter |
| `MISTRAL_API_KEY` | Mistral auth | |
| `ZAI_API_KEY` | z.ai auth | Also used by the z.ai web search provider |
| `ZHIPU_API_KEY` | Zhipu Coding Plan auth | |
| `UMANS_AI_CODING_PLAN_API_KEY` | Umans AI Coding Plan auth | |
| `MINIMAX_API_KEY` | MiniMax auth | |
| `MINIMAX_CODE_API_KEY` | MiniMax Code auth | |
| `MINIMAX_CODE_CN_API_KEY` | MiniMax Code CN auth | |
| `OPENCODE_API_KEY` | OpenCode auth | For `opencode-go` / `opencode-zen` models |
| `QIANFAN_API_KEY` | Qianfan auth | |
| `QWEN_OAUTH_TOKEN` | Qwen Portal auth | Takes precedence over `QWEN_PORTAL_API_KEY` |
| `QWEN_PORTAL_API_KEY` | Qwen Portal auth | Fallback after `QWEN_OAUTH_TOKEN` |
| `ZENMUX_API_KEY` | ZenMux auth | Used for ZenMux OpenAI and Anthropic-compatible routes |
| `VLLM_API_KEY` | vLLM auth/discovery opt-in | Any non-empty value works for no-auth local servers |
| `CURSOR_ACCESS_TOKEN` | Cursor provider auth | |
| `AI_GATEWAY_API_KEY` | Vercel AI Gateway auth | |
| `CLOUDFLARE_AI_GATEWAY_API_KEY` | Cloudflare AI Gateway auth | Base URL must be configured as `https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/anthropic` |
| `ALIBABA_CODING_PLAN_API_KEY` | Alibaba Coding Plan auth | |
| `ALIBABA_TOKEN_PLAN_API_KEY` | QwenCloud Token Plan auth | Preferred provider-specific name |
| `BAILIAN_TOKEN_PLAN_API_KEY` | QwenCloud Token Plan auth | Compatible with Qwen Code's Token Plan preset |
| `DEEPSEEK_API_KEY` | DeepSeek auth | |
| `SILICONFLOW_API_KEY` | SiliconFlow auth | |
| `SILICONFLOW_CN_API_KEY` | SiliconFlow (China) auth | |
| `KILO_API_KEY` | Kilo auth | |
| `OLLAMA_CLOUD_API_KEY` | Ollama Cloud auth | |
| `WAFER_SERVERLESS_API_KEY` | Wafer Serverless auth | Pay-as-you-go Wafer SKU; validated against `https://pass.wafer.ai/v1/models` |
| `GITLAB_TOKEN` | GitLab Duo auth | |

### GitHub and Copilot tokens

| Variable | Used for | Notes |
| --- | --- | --- |
| `COPILOT_GITHUB_TOKEN` | GitHub Copilot provider auth | Generic GitHub tokens are not used here |
| `GITHUB_TOKEN` | GitHub API auth in the web scraper | Checked before `GH_TOKEN` |
| `GH_TOKEN` | GitHub API auth in the web scraper | Fallback after `GITHUB_TOKEN` |

### Auth broker (remote credential vault)

When the broker is enabled, the local SQLite credential store is bypassed and all OAuth refresh/access tokens live on the broker host.

| Variable | Used for | Notes |
| --- | --- | --- |
| `OMP_AUTH_BROKER_URL` | Base URL of the remote auth broker (e.g. `https://broker.tailnet:8765`); selects broker mode | Wins over `auth.broker.url` in `config.yml`. Also required by `omp auth-gateway serve`. When set with no resolvable token, startup hard-errors instead of falling back to local SQLite |
| `OMP_AUTH_BROKER_TOKEN` | Bearer token sent on every broker endpoint except `/v1/healthz` | Resolution: this env var → `auth.broker.token` (`$ENV_NAME` indirection supported) → `<config-dir>/auth-broker.token` (mode `0600`) |
| `OMP_AUTH_BROKER_SNAPSHOT_TTL_MS` | Freshness window for the encrypted local broker snapshot cache | Default `3600000` (1 h); `0` disables cache reads/writes and forces the old blocking fetch every startup |
| `OMP_AUTH_BROKER_SNAPSHOT_CACHE` | Path to the encrypted local broker snapshot cache | Defaults to `~/.omp/cache/auth-broker-snapshot.enc` (or XDG cache equivalent) |
| `OMP_AUTH_BROKER_ACCOUNT_POOL_FILE` | Process-scoped OAuth account routing for a trusted broker client | Path to a JSON object mapping provider IDs to exact broker `identityKey` arrays. Missing providers are unrestricted; `[]` hides that provider's OAuth accounts; API keys remain visible. Parsed once at startup and fails closed on invalid input. Not server authorization |

The auth gateway has no dedicated env vars — it inherits `OMP_AUTH_BROKER_*`. Its own inbound bearer token lives at `<config-dir>/auth-gateway.token` and is managed via `omp auth-gateway token`.

## Provider-specific runtime configuration

### Anthropic Foundry gateway (Azure / enterprise proxy)

When `CLAUDE_CODE_USE_FOUNDRY` is enabled, Anthropic requests switch to Foundry mode: the base URL resolves from `FOUNDRY_BASE_URL`, and API key resolution becomes `ANTHROPIC_FOUNDRY_API_KEY` → `ANTHROPIC_OAUTH_TOKEN` → `ANTHROPIC_API_KEY`.

| Variable | Value type | Behavior |
| --- | --- | --- |
| `CLAUDE_CODE_USE_FOUNDRY` | Boolean-like string (`1`, `true`, `yes`, `on`) | Enables Foundry mode for the Anthropic provider |
| `FOUNDRY_BASE_URL` | URL string | Anthropic endpoint base URL in Foundry mode |
| `ANTHROPIC_FOUNDRY_API_KEY` | Token string | Used for `Authorization: Bearer <token>` |
| `ANTHROPIC_CUSTOM_HEADERS` | Header list string | Extra headers as `header-a: value, header-b: value` or newline-separated. Also forwarded outside Foundry whenever `ANTHROPIC_BASE_URL` points to a non-Anthropic host |
| `NODE_EXTRA_CA_CERTS` | PEM path or inline PEM | Extra CA chain for server certificate validation; honoured for every provider fetch, not just Foundry |
| `CLAUDE_CODE_CLIENT_CERT` | PEM path or inline PEM | mTLS client certificate (Foundry-specific) |
| `CLAUDE_CODE_CLIENT_KEY` | PEM path or inline PEM | mTLS client private key; must be paired with the cert (Foundry-specific) |

The TLS variables accept either a filesystem path to PEM content or inline PEM (including escaped `\n` sequences).

### Amazon Bedrock

| Variable | Behavior |
| --- | --- |
| `AWS_REGION` | Primary region source |
| `AWS_DEFAULT_REGION` | Fallback if `AWS_REGION` is unset |
| `AWS_PROFILE` | Enables named profile auth path |
| `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` | Enables IAM key auth path |
| `AWS_BEARER_TOKEN_BEDROCK` | Highest-precedence bearer token auth path; skips AWS profile/credential-chain lookup when set |
| `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI` / `AWS_CONTAINER_CREDENTIALS_FULL_URI` | Marks Bedrock as available in provider detection |
| `AWS_WEB_IDENTITY_TOKEN_FILE` + `AWS_ROLE_ARN` | Marks Bedrock as available in provider detection |
| `AWS_BEDROCK_SKIP_AUTH` | If `1`, injects dummy credentials (proxy/non-auth scenarios) |
| `HTTPS_PROXY` / `HTTP_PROXY` | Honored via Bun's native fetch proxy support |
| `NO_PROXY` | Excludes matching hosts from proxy routing |

Region fallback: `options.region` → `AWS_REGION` → `AWS_DEFAULT_REGION` → `us-east-1`.

### Azure OpenAI Responses

| Variable | Behavior |
| --- | --- |
| `AZURE_OPENAI_API_KEY` | Required unless an API key is passed as an option |
| `AZURE_OPENAI_API_VERSION` | Default `v1` |
| `AZURE_OPENAI_BASE_URL` | Direct base URL override |
| `AZURE_OPENAI_RESOURCE_NAME` | Used to construct the base URL: `https://<resource>.openai.azure.com/openai/v1` |
| `AZURE_OPENAI_DEPLOYMENT_NAME_MAP` | Optional mapping string: `modelId=deploymentName,model2=deployment2` |

Base URL resolution: option `azureBaseUrl` → `AZURE_OPENAI_BASE_URL` → option/env resource name → `model.baseUrl`.

### Google Vertex AI

| Variable | Required? | Notes |
| --- | --- | --- |
| `GOOGLE_CLOUD_PROJECT` | Yes (unless passed in options) | Primary project ID source |
| `GCP_PROJECT` | Fallback | Alternate project ID source |
| `GCLOUD_PROJECT` | Fallback | Alternate project ID source |
| `GOOGLE_CLOUD_PROJECT_ID` | OAuth login helper only | Used by Gemini CLI OAuth project discovery |
| `GOOGLE_VERTEX_LOCATION` | Yes (unless passed in options) | Primary Vertex location source |
| `GOOGLE_CLOUD_LOCATION` | Fallback | Alternate Vertex location source |
| `VERTEX_LOCATION` | Fallback | Alternate Vertex location source |
| `GOOGLE_CLOUD_API_KEY` | Conditional | Direct Vertex API-key auth; otherwise ADC can authenticate when project and location are set |
| `GOOGLE_APPLICATION_CREDENTIALS` | Conditional | If set, the file must exist; otherwise the ADC fallback path is checked (`~/.config/gcloud/application_default_credentials.json`) |

### Kimi

| Variable | Behavior |
| --- | --- |
| `KIMI_CODE_OAUTH_HOST` | Primary OAuth host override |
| `KIMI_OAUTH_HOST` | Fallback OAuth host override |
| `KIMI_CODE_BASE_URL` | Overrides the Kimi usage endpoint base URL |

OAuth host chain: `KIMI_CODE_OAUTH_HOST` → `KIMI_OAUTH_HOST` → `https://auth.kimi.com`.

### Gemini CLI compatibility

| Variable | Behavior |
| --- | --- |
| `PI_AI_GEMINI_CLI_VERSION` | Overrides the Gemini CLI user-agent version tag (`0.35.3` if unset) |

### OpenAI Codex responses (feature/debug controls)

| Variable | Behavior |
| --- | --- |
| `PI_CODEX_DEBUG` | `1`/`true` enables Codex provider debug logging |
| `PI_CODEX_WEBSOCKET` | `1`/`true` enables websocket transport preference |
| `PI_CODEX_RESPONSES_LITE` | `1`/`true` forces Responses Lite; `0`/`false` forces the standard Responses body; unset uses the model catalog default |
| `PI_OPENAI_STATEFUL` | Overrides the stateful-chaining default for the platform OpenAI Responses API (`previous_response_id`, forces `store: true`): on by default against api.openai.com, off elsewhere |
| `PI_CODEX_WEBSOCKET_IDLE_TIMEOUT_MS` | Positive integer override (default `300000`) |
| `PI_CODEX_WEBSOCKET_RETRY_BUDGET` | Non-negative integer override (default `5`) |
| `PI_CODEX_WEBSOCKET_RETRY_DELAY_MS` | Positive integer base backoff override (default `500`) |
| `PI_OPENAI_STREAM_FIRST_EVENT_TIMEOUT_MS` | Positive integer OpenAI first-event timeout override; `0` disables. Overrides the persisted `providers.streamFirstEventTimeoutSeconds` setting |
| `PI_OPENAI_STREAM_IDLE_TIMEOUT_MS` | Positive integer OpenAI stream idle timeout override; `0` disables. Overrides the persisted `providers.streamIdleTimeoutSeconds` setting |

### Cursor provider debug

| Variable | Behavior |
| --- | --- |
| `DEBUG_CURSOR` | Enables provider debug logs; `2`/`verbose` for detailed payload snippets |
| `DEBUG_CURSOR_LOG` | Optional file path for JSONL debug log output |

### Prompt cache retention

| Variable | Behavior |
| --- | --- |
| `PI_CACHE_RETENTION` | If `long`, enables long retention where supported (`anthropic`, `openai-responses`, Bedrock retention resolution) |

## Web search

### Search provider credentials

| Variable | Used by |
| --- | --- |
| `EXA_API_KEY` | Exa search/MCP; alternatively use `/login exa` |
| `BRAVE_API_KEY` | Brave search provider |
| `PERPLEXITY_API_KEY` | Perplexity search provider API-key mode |
| `PERPLEXITY_COOKIES` | Perplexity cookie-auth search mode |
| `TAVILY_API_KEY` | Tavily search provider |
| `ZAI_API_KEY` | z.ai search provider (also checks stored OAuth in `agent.db`) |
| `OPENAI_API_KEY` / Codex OAuth in DB | Codex search provider availability/auth |
| `PI_CODEX_WEB_SEARCH_MODEL` | Codex search provider model override |
| `GEMINI_SEARCH_MODEL` | Gemini search provider model override; wins over `providers.webSearchGeminiModel` (default `gemini-2.5-flash`) |
| `MOONSHOT_SEARCH_API_KEY` / `KIMI_SEARCH_API_KEY` | Kimi/Moonshot search provider env auth |
| `MOONSHOT_SEARCH_BASE_URL` / `KIMI_SEARCH_BASE_URL` | Kimi/Moonshot search endpoint override |
| `KAGI_API_KEY` | Kagi search provider |
| `JINA_API_KEY` | Jina search provider |
| `PARALLEL_API_KEY` | Parallel search provider |
| `SEARXNG_ENDPOINT`, `SEARXNG_TOKEN` | SearXNG endpoint and optional bearer token |
| `SEARXNG_BASIC_USERNAME`, `SEARXNG_BASIC_PASSWORD` | SearXNG HTTP Basic Auth credentials |

SearXNG also reads the equivalent `searxng.endpoint`, `searxng.token`, `searxng.basicUsername`, and `searxng.basicPassword` settings from `~/.omp/agent/config.yml`; the environment variables are fallbacks.

The Gemini search provider resolves its model as `GEMINI_SEARCH_MODEL` → `providers.webSearchGeminiModel` → `gemini-2.5-flash`. See [Settings — Providers](/oh-my-pi/reference/settings/providers/) and [Web search](/oh-my-pi/features/web-search/).

### Anthropic web search auth chain

The Anthropic search provider resolves credentials in this order:

1. `ANTHROPIC_SEARCH_API_KEY`
2. Stored/fallback Anthropic credentials (runtime and config overrides, stored OAuth, a login-sourced API key, then the generic Anthropic environment fallback: `ANTHROPIC_FOUNDRY_API_KEY` → `ANTHROPIC_OAUTH_TOKEN` → `ANTHROPIC_API_KEY` in Foundry mode, or `ANTHROPIC_OAUTH_TOKEN` → `ANTHROPIC_API_KEY` otherwise)

Base URL resolution for either credential path:

1. `ANTHROPIC_SEARCH_BASE_URL`
2. `FOUNDRY_BASE_URL` when `CLAUDE_CODE_USE_FOUNDRY` is enabled
3. `ANTHROPIC_BASE_URL`
4. `https://api.anthropic.com`

| Variable | Behavior |
| --- | --- |
| `ANTHROPIC_SEARCH_API_KEY` | API key used exclusively for the Anthropic web search provider; overrides `ANTHROPIC_API_KEY` / OAuth / Foundry for search calls without affecting chat completions |
| `ANTHROPIC_SEARCH_BASE_URL` | Base URL used exclusively for the Anthropic web search provider; overrides `ANTHROPIC_BASE_URL` (and `FOUNDRY_BASE_URL` in Foundry mode) for search calls |
| `ANTHROPIC_SEARCH_MODEL` | Search model override; defaults to `claude-haiku-4-5` |
| `ANTHROPIC_BASE_URL` | Generic fallback base URL for Anthropic requests when no search-specific base URL is set |

Use `ANTHROPIC_SEARCH_BASE_URL` (optionally with `ANTHROPIC_SEARCH_API_KEY`) to keep chat routed through an enterprise gateway while pointing web search at a direct Anthropic endpoint, or vice versa.

### Perplexity OAuth flow flag

| Variable | Behavior |
| --- | --- |
| `PI_AUTH_NO_BORROW` | If set, disables the macOS native-app token borrowing path in the Perplexity login flow |

## Python tooling and kernel runtime

| Variable | Behavior |
| --- | --- |
| `PI_PY` | Boolean-like override for the Python eval backend: truthy (`1`/`true`/`yes`/`on`) enables, any other value disables; unset defers to the `eval.py` setting (default enabled) |
| `PI_JS` | Same boolean-like override for the JavaScript eval backend; unset defers to the `eval.js` setting (default enabled) |
| `PI_PYTHON_SKIP_CHECK` | If `1`, skips Python interpreter availability checks (the subprocess runner still starts on demand) |
| `PI_PYTHON_INTEGRATION` | If `1`, opts gated integration tests into running against real Python |
| `PI_PYTHON_IPC_TRACE` | If `1`, logs NDJSON frames exchanged with the Python runner subprocess |
| `VIRTUAL_ENV` | Highest-priority venv path for Python runtime resolution |

If `BUN_ENV=test` or `NODE_ENV=test`, Python availability checks are treated as OK and warming is skipped. The Python runtime also filters the environment before spawning kernel subprocesses: common API-key variables are denied, and safe base vars plus `LC_`, `XDG_`, and `PI_` prefixes are allowed.

## Agent and runtime behavior toggles

| Variable | Behavior |
| --- | --- |
| `PI_SMOL_MODEL` | Ephemeral model-role override for `smol` (CLI `--smol` takes precedence) |
| `PI_SLOW_MODEL` | Ephemeral model-role override for `slow` (CLI `--slow` takes precedence) |
| `PI_PLAN_MODEL` | Ephemeral model-role override for `plan` (CLI `--plan` takes precedence) |
| `PI_NO_TITLE` | If set (any non-empty value), disables auto session title generation on the first user message |
| `PI_TINY_DEVICE` | ONNX execution provider for local tiny models; overrides the `providers.tinyModelDevice` setting (default `cpu`; supports `cpu`, `gpu`, `metal`/`webgpu`, `auto`, `cuda`, `dml`, `coreml`, `wasm`, `webnn`, `webnn-gpu`, `webnn-cpu`, `webnn-npu`) |
| `PI_TINY_DTYPE` | ONNX quantization/precision for local tiny models; overrides the `providers.tinyModelDtype` setting (default: each model's shipped dtype, currently `q4`; supports `auto`, `fp32`, `fp16`, `q8`, `int8`, `uint8`, `q4`, `bnb4`, `q4f16`, `q2`, `q2f16`, `q1`, `q1f16`) |
| `PI_NO_INTERLEAVED_THINKING` | If `1`, disables Anthropic interleaved thinking budget behavior and uses output-token inflation for the older thinking mode |
| `NULL_PROMPT` | If `true`, the system prompt builder returns an empty string |
| `PI_BLOCKED_AGENT` | Blocks a specific subagent type in the task tool |
| `PI_SUBPROCESS_CMD` | Overrides the subagent spawn command (`omp` / `omp.cmd` resolution bypass) |
| `PI_TASK_MAX_OUTPUT_BYTES` | Max captured output bytes per subagent (default `500000`) |
| `PI_TASK_MAX_OUTPUT_LINES` | Max captured output lines per subagent (default `5000`) |
| `PI_TIMING` | If set (any non-empty value), prints a hierarchical timing-span tree to stderr. `PI_TIMING=x` exits with code 0 right after printing in interactive mode (cold-startup measurement); `PI_TIMING=full` lists every module-load entry instead of just the top N |
| `PI_DEBUG_STARTUP` | If set (any non-empty value), streams synchronous `[startup] <phase>:start` / `:done` marker lines to stderr as each startup phase begins/ends; unlike `PI_TIMING`, the markers survive a hard hang, so the last line names the stuck phase |
| `PI_PACKAGE_DIR` | Overrides package asset base dir resolution (`docs/`, `examples/`, `CHANGELOG.md`) |
| `PI_DISABLE_LSPMUX` | If `1`, disables lspmux detection/integration and forces direct LSP server spawning |
| `PI_RPC_EMIT_TITLE` | Boolean-like flag enabling title events in RPC mode |
| `SMITHERY_URL` | Smithery web URL override (default `https://smithery.ai`) |
| `SMITHERY_API_URL` | Smithery API base URL override (default `https://api.smithery.ai`) |
| `SMITHERY_API_KEY` | Smithery API key for managed MCP auth lookup |
| `PUPPETEER_EXECUTABLE_PATH` | Browser tool Chromium executable override |
| `LITELLM_BASE_URL` | LiteLLM proxy base URL fallback (`http://localhost:4000/v1` if unset); explicit `providers.litellm.baseUrl` / `models.yml` config wins |
| `LM_STUDIO_BASE_URL` | Implicit LM Studio discovery base URL override (`http://127.0.0.1:1234/v1` if unset) |
| `OLLAMA_BASE_URL` | Implicit Ollama discovery base URL override (`OLLAMA_HOST` if unset, then `http://127.0.0.1:11434`) |
| `OLLAMA_HOST` | Ollama host used for implicit discovery when `OLLAMA_BASE_URL` is unset; accepts values such as `127.0.0.1:11434` or `http://host:11434` |
| `OLLAMA_CONTEXT_LENGTH` | Positive integer context-window override for implicit Ollama discovery; affects omp context budgeting only and does not change Ollama's runtime `num_ctx` |
| `LLAMA_CPP_BASE_URL` | Implicit llama.cpp discovery base URL override (`http://127.0.0.1:8080` if unset) |
| `PI_EDIT_VARIANT` | Forces the edit tool variant when valid (`patch`, `replace`, `hashline`, `apply_patch`) |
| `PI_STRICT_EDIT_MODE` | If `1`, disables built-in model-specific edit-mode fallbacks, so the configured/global `edit.mode` is used unless `PI_EDIT_VARIANT` or `edit.modelVariants` overrides it |
| `PI_FORCE_IMAGE_PROTOCOL` | Forces the supported image protocol (`kitty`, `iterm2`/`iterm`, `sixel`, `none`) where used |
| `PI_ALLOW_SIXEL_PASSTHROUGH` | Allows SIXEL passthrough when `PI_FORCE_IMAGE_PROTOCOL=sixel` |
| `PI_NO_PTY` | If `1`, disables the interactive PTY path for the bash tool; also set internally by CLI `--no-pty` |
| `OMP_MCP_TIMEOUT_MS` | Overrides the MCP client request timeout (ms) for every MCP server. `0` disables client-side timeouts. Invalid (negative or non-numeric) values are ignored with a warning and the per-server config or default (`30000`) is used |

## Storage and config root paths

| Variable | Behavior |
| --- | --- |
| `OMP_PROFILE` | Named profile for isolated agent state; same as `--profile <name>`. Canonical variable: takes precedence over `PI_PROFILE`, and an explicitly empty value selects the default profile. Profile state lives under `<config-root>/profiles/<name>/` (e.g. `~/.omp/profiles/<name>/agent`). Names must match `^[a-z0-9][a-z0-9._-]{0,63}$`; an invalid value fails at startup with a clean error |
| `PI_PROFILE` | Legacy compatibility alias for `OMP_PROFILE`; consulted only when `OMP_PROFILE` is unset |
| `PI_CONFIG_DIR` | Config root dirname under home (default `.omp`) |
| `PI_CODING_AGENT_DIR` | Full override for the agent directory (default `~/<PI_CONFIG_DIR or .omp>/agent`) |
| `PI_CONFIG_FILES` | Platform path-list of settings overlays (`:` on Unix, `;` on Windows); loaded in order before explicit `--config` overlays |
| `PWD` | Used when matching the canonical current working directory in path helpers |

A named profile relocates the entire OMP user base — settings, auth, sessions, and MCP config — under the profile directory. See [Settings](/oh-my-pi/configuration/settings/) and [MCP servers](/oh-my-pi/extending/mcp/).

## Shell and tool execution environment

| Variable | Behavior |
| --- | --- |
| `PI_BASH_NO_CI` | Suppresses automatic `CI=true` injection into the spawned shell env |
| `CLAUDE_BASH_NO_CI` | Legacy alias fallback for `PI_BASH_NO_CI` |
| `PI_BASH_NO_LOGIN` | Disables login-shell mode; shell args become `['-c']` instead of `['-l','-c']` |
| `CLAUDE_BASH_NO_LOGIN` | Legacy alias fallback for `PI_BASH_NO_LOGIN` |
| `PI_SHELL_PREFIX` | Optional command prefix wrapper |
| `CLAUDE_CODE_SHELL_PREFIX` | Legacy alias fallback for `PI_SHELL_PREFIX` |
| `VISUAL` | Preferred external editor command |
| `EDITOR` | Fallback external editor command |

## UI, theme, and session detection

These are read as runtime signals; they are usually set by the terminal/OS rather than configured manually.

| Variable | Used for |
| --- | --- |
| `COLORTERM`, `TERM`, `WT_SESSION` | Color capability detection (theme color mode) |
| `COLORFGBG` | Terminal background light/dark auto-detection |
| `TERM_PROGRAM`, `TERM_PROGRAM_VERSION`, `TERMINAL_EMULATOR` | Terminal identity in the system prompt/context |
| `TMUX_PANE`, `CMUX_SURFACE_ID`, `KITTY_WINDOW_ID`, `TERM_SESSION_ID`, `WT_SESSION` | Stable per-terminal session breadcrumb IDs |
| `SHELL`, `ComSpec`, `TERM_PROGRAM`, `TERM` | System info diagnostics |
| `APPDATA`, `XDG_CONFIG_HOME` | lspmux config path resolution |
| `HOME` | Path shortening in the MCP command UI |

## TUI runtime flags

| Variable | Behavior |
| --- | --- |
| `PI_NOTIFICATIONS` | `off` / `0` / `false` suppress desktop notifications |
| `PI_TUI_WRITE_LOG` | If set, logs TUI writes to a file |
| `PI_TUI_RAW_BACKSPACE_IS_CTRL` | If `1`, interprets raw `0x08` as Ctrl+Backspace instead of Backspace; use when SSH/container hops hide a Windows Terminal client |
| `PI_HARDWARE_CURSOR` | If `1`, enables hardware cursor mode |
| `PI_NO_SYNC_OUTPUT` | If set (any non-empty value), disables DEC 2026 synchronized-output wrappers while keeping TUI autowrap guards |
| `PI_NO_DECCARA` | If set (truthy), disables Kitty DECCARA rectangular-SGR background fills (forces padded-string rendering) |
| `PI_DEBUG_REDRAW` | If `1`, enables redraw debug logging |
| `PI_FORCE_IMAGE_PROTOCOL` | Forces terminal image protocol detection (`kitty`, `iterm2`/`iterm`, `sixel`, `none`) |
| `PI_TUI_RESIZE_IN_PLACE` | `1`/`true` forces in-place resize (no alt-screen borrow, no ED3 rewrap); `0`/`false` forces the alt-screen fast path. Default-on for Warp, which re-reports its size on alt-screen toggles |

## Commit generation controls

| Variable | Behavior |
| --- | --- |
| `PI_COMMIT_TEST_FALLBACK` | If `true` (case-insensitive), forces the commit fallback generation path |
| `PI_COMMIT_NO_FALLBACK` | If `true`, disables the fallback when the agent returns no proposal |
| `PI_COMMIT_MAP_REDUCE` | If `false`, disables the map-reduce commit analysis path |
| `DEBUG` | If set, commit agent error stack traces are printed |
