---
title: Settings — Providers
description: Web search, image generation, fetch, voice, tiny-model switches, codex resets, commits, GC, and developer reporting settings.
coverage: A
sidebar:
  label: Settings — Providers
  order: 6
---

Settings that influence how providers and ancillary services behave. Provider credentials and custom model definitions are configured separately — see [Providers](/oh-my-pi/models/providers/) and [Model roles](/oh-my-pi/models/model-roles/).

## Provider selection

| Key | Type | Default | Description |
|---|---|---|---|
| `providers.ollama-cloud.maxConcurrency` | number | `3` | Maximum concurrent Ollama Cloud subagent runs per process; `0` disables the provider-specific limit. |
| `providers.webSearchOrder` | array | `[]` | Provider IDs in priority order for `web_search` (`perplexity`, `gemini`, `anthropic`, `codex`, `zai`, `exa`, `jina`, `kagi`, `tavily`, `brave`, `kimi`, `parallel`, `synthetic`, `searxng`, …). Duplicates and unknown IDs are ignored; unlisted providers retain their built-in relative order afterward. Empty = built-in order. Replaces the removed `providers.webSearch` enum (a legacy value migrates to the head of this list). |
| `providers.webSearchExclude` | array | `[]` | Providers that `web_search` should never use, even as fallbacks. See [Web search](/oh-my-pi/features/web-search/). |
| `providers.webSearchTimeoutSeconds` | number | `60` | Hard timeout in seconds for each provider's search transport before `web_search` advances to the next fallback; maximum `300`. See [Web search](/oh-my-pi/features/web-search/). |
| `providers.webSearchGeminiModel` | string | _(unset)_ | Gemini model ID for Google Search grounding when `web_search` uses Gemini; defaults to `gemini-2.5-flash`, overridden by `GEMINI_SEARCH_MODEL`. See [Web search](/oh-my-pi/features/web-search/). |
| `providers.antigravityEndpoint` | enum | `auto` | Endpoint routing for `google-antigravity` providers (chat, search, image, discovery): `auto` tries the production endpoint and fails over to sandbox on 5xx/429; `production` and `sandbox` force a single endpoint. |
| `providers.imageOrder` | array | `[]` | Image-generation provider IDs in priority order (`openai`, `openai-codex`, `antigravity`, `xai`, `gemini`, `openrouter`). Unlisted providers follow the active session provider and the built-in order. Replaces the removed `providers.image` enum (a legacy value migrates to the head of this list). |
| `providers.fireworksTier` | enum | `standard` | Serving path for Fireworks requests. `priority` sends `service_tier: "priority"` for higher reliability at peak traffic at a higher price; `standard` omits it. Fast (`-fast`) models ignore this — Fast is its own serving path. |
| `providers.fetch` | enum | `auto` | One of `auto`, `native`, `trafilatura`, `lynx`, `parallel`, `jina`. |
| `providers.openaiWebsockets` | enum | `auto` | One of `auto`, `off`, `on`. |
| `providers.openrouterVariant` | enum | `default` | One of `default`, `nitro`, `floor`, `online`, `exacto`. |
| `providers.kimiApiFormat` | enum | `auto` | API format for the Kimi Code provider: `auto` follows the model's server-declared protocol, `openai` targets `api.kimi.com`, `anthropic` targets `api.moonshot.ai`. |
| `provider.appendOnlyContext` | enum | `auto` | One of `auto`, `on`, `off`. |
| `providers.streamFirstEventTimeoutSeconds` | number | `-1` | Seconds to wait for the first model stream event; `-1` uses provider/env defaults, `0` disables the watchdog. |
| `providers.streamIdleTimeoutSeconds` | number | `-1` | Seconds a model stream may stay silent between events; `-1` uses provider/env defaults, `0` disables the watchdog. |

## Tiny and background models

These keys pick the on-device or online model for lightweight background tasks. `online` resolves to the TINY role from `/models` when assigned, else the smol fallback.

| Key | Type | Default | Description |
|---|---|---|---|
| `providers.tinyModel` | enum | `online` | One of `online`, `lfm2-350m`, `qwen3-0.6b`, `gemma-270m`, `qwen2.5-0.5b`, `lfm2-700m`. |
| `providers.tinyModelDevice` | enum | `default` | ONNX execution provider for local tiny models. Overridden by `PI_TINY_DEVICE`. |
| `providers.tinyModelDtype` | enum | `default` | ONNX precision for local tiny models. Overridden by `PI_TINY_DTYPE`. |
| `providers.memoryModel` | enum | `online` | Mnemopi LLM for fact extraction and consolidation: `online` (the TINY role, else smol/remote) or a local on-device model (`qwen3-1.7b`, `llama3.2:3b`, `gemma-3-1b`, `qwen2.5-1.5b`, `lfm2-1.2b`). |
| `providers.autoThinkingModel` | enum | `online` | Difficulty classifier for the `auto` thinking level: `online` (the TINY role, else smol) or a local on-device model (same catalog as `providers.memoryModel`). |
| `providers.unexpectedStopModel` | enum | `online` | Classifier for unexpected-stop detection: `online` (the TINY role, else smol) or a local on-device model (same catalog as `providers.memoryModel`). |

## Search integrations

| Key | Type | Default | Description |
|---|---|---|---|
| `exa.enabled` | boolean | `true` | Enable Exa integration. |
| `exa.enableSearch` | boolean | `true` | Exa search. |
| `exa.searchDelayMs` | number | `1000` | Minimum delay between Exa web search requests in milliseconds; `0` disables pacing. |
| `exa.enableResearcher` | boolean | `false` | Exa researcher. |
| `exa.enableWebsets` | boolean | `false` | Exa websets. |
| `searxng.endpoint` | string | _(unset)_ | Base URL of a self-hosted SearXNG instance used for web search; also `SEARXNG_ENDPOINT`. |
| `searxng.token` | string | _(unset)_ | SearXNG bearer token; also `SEARXNG_TOKEN`. |
| `searxng.basicUsername` | string | _(unset)_ | RFC 7617 basic-auth username for the SearXNG instance (requires `searxng.basicPassword`). |
| `searxng.basicPassword` | string | _(unset)_ | RFC 7617 basic-auth password for the SearXNG instance. |
| `searxng.categories` | string | _(unset)_ | Comma-separated SearXNG categories filter. |
| `searxng.engines` | string | _(unset)_ | Comma-separated SearXNG engine names or shortcuts (for example `duckduckgo, br, sp`); shortcuts resolve via the instance's `/config` endpoint. |
| `searxng.language` | string | _(unset)_ | SearXNG language code (for example `en`, `zh-CN`). |

Search-provider behavior and the fallback chain are documented in [Web search](/oh-my-pi/features/web-search/).

## Voice and speech

See [Voice](/oh-my-pi/features/voice/) for the `tts` tool, `omp say`, and the related `stt.*` settings.

| Key | Type | Default | Description |
|---|---|---|---|
| `live.voice` | enum | `sol` | Voice used by Codex-backed realtime voice sessions: `arbor`, `breeze`, `cove`, `ember`, `juniper`, `maple`, `sol`, `spruce`, `vale`. See [Live voice](/oh-my-pi/features/live-voice/). |
| `providers.tts` | enum | `auto` | Backend for the `tts` tool: `auto` prefers local on-device TTS and routes `.mp3` output to xAI when credentials exist; `local` uses on-device neural TTS (Kokoro-82M, WAV/PCM16 output); `xai` uses xAI Grok Voice (requires xAI OAuth or `XAI_API_KEY`). |
| `tts.localModel` | enum | `kokoro` | On-device neural TTS model used by the local TTS backend (Kokoro-82M). |
| `tts.localVoice` | enum | `af_heart` | Kokoro voice used by the local TTS backend (American/British, female/male catalog, for example `af_heart`, `am_michael`, `bf_emma`, `bm_george`). |
| `speech.enabled` | boolean | `false` | Speak the assistant's output aloud through the speakers as it streams. |
| `speech.mode` | enum | `assistant` | What to speak: `all` (assistant messages + thinking), `assistant` (messages only), `yield` (only the final message at turn end). |
| `speech.enhanced` | boolean | `false` | Rewrite assistant output into natural spoken prose with the tiny/smol model before synthesis (describes code, drops links and markdown); falls back to mechanical cleanup on failure. |
| `speech.voice` | enum | `af_heart` | Kokoro voice used when speaking the assistant's output aloud. |

## Codex rate-limit resets

| Key | Type | Default | Description |
|---|---|---|---|
| `codexResets.autoRedeem` | enum | `unset` | Spend saved Codex rate-limit resets automatically: restore an account blocked by an exhausted 5-hour or weekly window when a turn is stuck and no other account can take over, and salvage credits that are about to expire. `unset` asks before the first spend, `yes` spends without prompting, `no` disables both checks. |
| `codexResets.minBlockedMinutes` | number | `60` | Only auto-redeem when the natural unblock — the latest reset among the exhausted 5-hour/weekly windows — is at least this many minutes away (don't spend a scarce credit to save a short wait). |
| `codexResets.keepCredits` | number | `0` | Never auto-spend below this many saved resets (`0` = the last credit may be spent automatically). Credits about to expire are exempt — a reserved credit that expires preserves nothing. |
| `codexResets.salvageHorizonHours` | number | `12` | Spend a saved Codex reset automatically when it would otherwise expire within this many hours and either chat window (5h or weekly) has meaningful usage to restore (`0` disables expiry salvage). |

## Commits

These keys tune `omp commit`'s map-reduce analysis and changelog flow — see [Atomic Commits](/oh-my-pi/features/atomic-commits/).

| Key | Type | Default | Description |
|---|---|---|---|
| `commit.mapReduceEnabled` | boolean | `true` | Use map-reduce analysis for large diffs: per-file observations with the smol model, then a reduce pass with the primary model. |
| `commit.mapReduceMinFiles` | number | `4` | Use map-reduce when the diff touches at least this many files. |
| `commit.mapReduceMaxFileTokens` | number | `50000` | Use map-reduce when a single file exceeds this many tokens, even below the file-count threshold. |
| `commit.mapReduceTimeoutMs` | number | `120000` | Timeout for the map-reduce analysis phase, in milliseconds. |
| `commit.mapReduceMaxConcurrency` | number | `5` | Maximum parallel per-file observations in the map phase. |
| `commit.changelogMaxDiffChars` | number | `120000` | Maximum diff characters fed to changelog detection and updating. |

## Developer reporting

| Key | Type | Default | Description |
|---|---|---|---|
| `dev.autoqa` | boolean | `true` | Automated tool issue reporting (`xd://report_issue`). On by default; the first report asks for consent, and denying it disables reporting until re-enabled explicitly. |
| `dev.autoqaConsent` | enum | `unset` | User decision on sharing automatic `report_tool_issue` grievances: `unset` (never asked; the first invocation pops a consent dialog and persists the answer here), `granted` (record and, when push is configured, ship grievances), `denied` (silently no-op every call). |
| `dev.autoqaPush.endpoint` | string | `https://qa.omp.sh/v1/grievances` | Full URL receiving Auto QA JSON reports. |
| `dev.autoqaPush.token` | string | _(unset)_ | Token for the Auto QA push endpoint. |

## Session garbage collection

| Key | Type | Default | Description |
|---|---|---|---|
| `gc.blobs` | boolean | `true` | Delete blob files no longer referenced by any session or archive. |
| `gc.archive` | boolean | `true` | Archive inactive sessions: move sessions older than `gc.coldArchiveAfterDays` out of the active store, keeping the newest `gc.retainNewestGlobal` overall and `gc.retainNewestPerCwd` per working directory. |
| `gc.wal` | boolean | `true` | Checkpoint SQLite WAL files (history and model databases). |
| `gc.coldArchiveAfterDays` | number | `30` | Archive sessions not modified for at least this many days; `0` disables the age filter. |
| `gc.retainNewestGlobal` | number | `20` | Keep this many newest inactive sessions overall when archiving. |
| `gc.retainNewestPerCwd` | number | `10` | Keep this many newest inactive sessions per working directory when archiving. |

See [Sessions](/oh-my-pi/features/sessions/) for how sessions are stored and resumed.

## Agent behavior

| Key | Type | Default | Description |
|---|---|---|---|
| `features.unexpectedStopDetection` | boolean | `false` | Use a small model to detect when the assistant says it will continue but stops without tool calls; automatically prompt it to continue. |

## Secrets

| Key | Type | Default | Description |
|---|---|---|---|
| `secrets.enabled` | boolean | `false` | Obfuscate configured secrets and redact credential-shaped tokens before sending to AI providers. See also [Approvals](/oh-my-pi/configuration/approvals/). |

## Auth broker

| Key | Type | Default | Description |
|---|---|---|---|
| `auth.broker.url` | string | _(unset)_ | Auth-broker URL. Overridden by `OMP_AUTH_BROKER_URL`. |
| `auth.broker.token` | string | _(unset)_ | Auth-broker token. Overridden by `OMP_AUTH_BROKER_TOKEN`. |
