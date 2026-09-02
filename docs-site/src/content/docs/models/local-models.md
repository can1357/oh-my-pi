---
title: Local Models
description: Run omp against local model servers — Ollama, llama.cpp, LM Studio, vLLM, LiteLLM — plus embedded tiny models for background tasks.
coverage: B
---

"Local" covers two complementary paths: connecting omp to a locally-hosted model server (Ollama, llama.cpp, LM Studio, vLLM, LiteLLM, or any OpenAI-compatible endpoint) and running the small embedded models that handle session-title generation, memory extraction, and thinking-level difficulty classification.

## Local engines at a glance

Three engines are discovered automatically without a `models.yml` entry and are keyless by default. Their discovered models become selectable as soon as the engine answers.

| Provider ID | Base URL (env override → default) |
|---|---|
| `ollama` | `OLLAMA_BASE_URL`, then `OLLAMA_HOST` (normalized), else `http://127.0.0.1:11434` |
| `llama.cpp` | `LLAMA_CPP_BASE_URL`, else `http://127.0.0.1:8080` |
| `lm-studio` | `LM_STUDIO_BASE_URL`, else `http://127.0.0.1:1234/v1` |

An implicit engine is skipped when a provider with the same ID is already configured in `models.yml` (your explicit config wins) or when that ID is in the effective `disabledProviders` list. Each engine can be pointed at a non-default host by exporting the corresponding `_BASE_URL` variable or by writing the base URL into the project's `.env`:

```dotenv
# <project>/.env
OLLAMA_BASE_URL=http://127.0.0.1:11434
```

## Ollama

When `ollama` is not explicitly configured, the registry adds an implicit discoverable provider:

- provider `ollama`
- wire format `openai-responses`
- base URL `OLLAMA_BASE_URL`, or `OLLAMA_HOST`, or `http://127.0.0.1:11434`
- context window `OLLAMA_CONTEXT_LENGTH` if set, otherwise Ollama `/api/show` metadata, otherwise `128000`
- keyless by default (`auth: none` behavior)

Runtime discovery calls Ollama endpoints and normalizes the OpenAI-compatible models it returns to `openai-responses`. `OLLAMA_CONTEXT_LENGTH` does not configure Ollama's runtime `num_ctx` — set that in Ollama/model configuration separately. `OLLAMA_API_KEY` is optional; local discovery is keyless by default.

## llama.cpp

When `llama.cpp` is not explicitly configured, the registry adds an implicit discoverable provider:

- provider `llama.cpp`
- wire format `openai-responses`
- base URL `LLAMA_CPP_BASE_URL` or `http://127.0.0.1:8080`
- keyless by default

Runtime discovery calls llama.cpp model endpoints and synthesizes model entries with local defaults. `LLAMA_CPP_API_KEY` is only needed when the server requires auth.

## LM Studio and other OpenAI-compatible servers

When `lm-studio` is not explicitly configured, the registry adds an implicit discoverable provider:

- provider `lm-studio`
- wire format `openai-completions`
- base URL `LM_STUDIO_BASE_URL` or `http://127.0.0.1:1234/v1`
- keyless by default

Discovery fetches the model list via `GET /models` and synthesizes model entries with local defaults. This path also works for any other OpenAI-compatible server. For example, to discover oMLX bound to Ollama's usual port:

```dotenv
LM_STUDIO_BASE_URL=http://127.0.0.1:11434/v1
```

Do not configure oMLX as `ollama` — Ollama discovery uses native `/api/tags` and `/api/show`, not OpenAI `/v1/models`.

## vLLM

The built-in vLLM provider can be pointed at a non-default endpoint without declaring a custom discovery type. omp reads vLLM's `/v1/models` metadata and preserves `max_model_len` as the discovered context window:

```yaml
providers:
  vllm:
    baseUrl: http://192.168.5.3:8085/v1
    auth: none
```

For multiple vLLM endpoints, use arbitrary provider IDs with the generic OpenAI-compatible discovery path. Set `auth: none` for local no-auth servers or `apiKey` for authenticated ones. Generic discovery reads `max_model_len` first and then `context_length` as a fallback.

## LiteLLM

When `litellm` is active (for example through `LITELLM_API_KEY` or stored auth), runtime discovery uses the LiteLLM proxy:

- provider `litellm`
- wire format `openai-completions`
- base URL from explicit provider `baseUrl` / `models.yml`, otherwise `LITELLM_BASE_URL`, otherwise `http://localhost:4000/v1`
- auth mode `LITELLM_API_KEY` or stored LiteLLM auth

Runtime discovery probes the metadata endpoints in order: `GET /model_group/info`, `GET /v2/model/info`, `GET /model/info`, then `GET /v1/model/info`. The configured key must be authorized to read at least one of these; on deployments that restrict management endpoints, grant the route through LiteLLM's `allowed_routes` access controls or use a master/admin key for discovery.

If every metadata route is unavailable, discovery falls back to the OpenAI-compatible `GET /models`. Rich metadata maps per-model context and capability fields, while bare fallback ids are enriched against bundled reference metadata when available — models absent from the bundled catalog can therefore have unknown context and pricing after fallback.

## Configuring discovery explicitly

For non-default endpoints, declare a `discovery:` block on a custom provider in `~/.omp/agent/models.yml`:

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

  litellm-gateway:
    baseUrl: http://gateway.example:4000/v1
    apiKey: LITELLM_API_KEY
    api: openai-completions
    discovery:
      type: litellm
```

Discovery types: `ollama`, `llama.cpp`, `lm-studio`, `openai-models-list`, `proxy`, and `litellm`. The `proxy` type suits Anthropic+OpenAI-compatible proxies that expose both `/v1/messages` and `/v1/chat/completions` behind one host — each discovered model's wire protocol is auto-detected.

## Catalog behavior

On every registry refresh the catalog pipeline runs in this order:

1. Load built-in providers and models.
2. Load `models.yml` custom config.
3. Apply provider overrides (`baseUrl`, `headers`, `disableStrictTools`) to built-in models.
4. Apply `modelOverrides` per provider + model id.
5. Merge custom `models`: same `provider + id` replaces existing, otherwise append.
6. Load cached / runtime-discovered models (Ollama, llama.cpp, LM Studio, plus built-in provider managers), then re-apply model overrides.

So a discovered model appears in `/model` and `omp models` automatically once its engine responds, and explicit overrides in `models.yml` always take precedence over what discovery returns. Validate the merged catalog with `omp models`; if a custom provider does not load, `omp models find <substr>` scopes the validation to one provider.

## Embedded tiny models

Three settings accept a small on-device model for background work. All three default to `online`, so existing users incur no downloads or on-device inference cost unless they opt in:

- `providers.tinyModel` — session-title generation. The winning recipe prefill-assistant `<title>`, stops at `</title>`, and takes the first line.
- `providers.memoryModel` — Mnemopi memory extraction and consolidation (needs 1B–1.7B models for usable quality).
- `providers.autoThinkingModel` — the `auto` thinking-level difficulty classifier; reuses the memory-model registry.

Shipped local options for `providers.tinyModel`:

| Model | Verdict |
|---|---|
| `lfm2-350m` | Best speed/quality balance (~212MB) |
| `qwen3-0.6b` | Most robust |
| `gemma-270m` | Smallest viable |
| `qwen2.5-0.5b` | Acceptable |
| `lfm2-700m` | Acceptable |

Shipped local options for `providers.memoryModel` and `providers.autoThinkingModel`:

| Model | Verdict |
|---|---|
| `llama3.2:3b` | Acceptable |
| `qwen3-1.7b` | Most disciplined extraction (recommended) |
| `gemma-3-1b` | Best consolidation; leaks small talk |
| `qwen2.5-1.5b` | Best extraction granularity |
| `lfm2-1.2b` | Fastest to load |

First-run download from the Hugging Face Hub caches weights on disk (~200MB–1.1GB depending on model); warm loads are sub-second to ~3s. Inference runs in a worker, off the main thread, and is async and background-friendly for memory tasks.

### Device and dtype overrides

Local tiny models default to CPU-only inference and retry once on CPU if an explicit accelerated provider cannot initialize. Override the device persistently with the `providers.tinyModelDevice` setting (`default` keeps CPU), or per-run with the `PI_TINY_DEVICE` env var (which overrides the setting). Accepted values: `cpu`, `gpu`, `metal`, `webgpu`, `auto`, `cuda`, `dml`, `coreml`, `wasm`, `webnn`, `webnn-gpu`, `webnn-cpu`, `webnn-npu`. Direct `coreml` remains opt-in because cached decoder-LLM ONNX loads can fail during session initialization; the production worker also forces Darwin `gpu`/`webgpu`/`auto` requests back to CPU because ONNX Runtime under Bun currently hard-crashes on worker teardown after WebGPU inference.

Quantization defaults to `q4`. Override the precision persistently with the `providers.tinyModelDtype` setting (`default` keeps `q4`; for example `fp16` for higher fidelity), or per-run with the `PI_TINY_DTYPE` env var (which overrides the setting). Accepted values: `auto`, `fp32`, `fp16`, `q8`, `int8`, `uint8`, `q4`, `bnb4`, `q4f16`, `q2`, `q2f16`, `q1`, `q1f16`. An unrecognized value fails loudly at worker startup.

## Limitations and gotchas

- **Engines must be running.** Keyless local engines only appear in selection once the engine is actually running and responding.
- **Ollama length failures.** A `finish_reason: length` with no visible content is treated as a context-window failure and mapped to an error rather than surfaced as empty output.
- **Ollama `num_ctx` is separate.** `OLLAMA_CONTEXT_LENGTH` only affects omp's discovered context window; Ollama's runtime context length (`num_ctx`) is set in Ollama / model configuration separately.
- **Bare fallback ids can be sparse.** If a LiteLLM metadata route is unavailable and omp falls back to the OpenAI-compatible `GET /models`, models absent from the bundled catalog can have unknown context window and pricing.
- **oMLX must use the lm-studio path.** Do not configure oMLX as `ollama` — Ollama discovery uses native `/api/tags` and `/api/show`, not OpenAI `/v1/models`. Run oMLX and Ollama side by side only after assigning a different port to one of them.
- **Discovery skips implicit engines.** An explicit `ollama`, `lm-studio`, or `llama.cpp` entry in `models.yml` replaces built-in discovery for that ID. The implicit engine does not merge with your explicit config — your entry wins outright.
- **`disableStrictTools` for Anthropic-fronted proxies.** When you put a local Anthropic-format proxy behind a custom provider, set `disableStrictTools: true` to stop the proxy from rejecting strict tool schemas.
- **Tiny-model defaults are conservative.** The defaults sidestepped WebGPU worker teardown crashes and slow q8/int8 loads; change `providers.tinyModelDevice` or `PI_TINY_DEVICE` only when you are explicitly opting out of CPU inference.
