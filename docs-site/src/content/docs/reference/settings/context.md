---
title: Settings — Context
description: Compaction, context overflow, memory backends, and autolearn.
coverage: A
sidebar:
  label: Settings — Context
  order: 3
---

Settings that govern how the context window is filled, summarized, and remembered across sessions. For the workflow and the layered config model, see [Settings](/oh-my-pi/configuration/settings/). For the exhaustive schema, run `omp config list`.

## Context, compaction, and memory

| Key | Type | Default | Description |
|---|---|---|---|
| `contextPromotion.enabled` | boolean | `false` | Promote to the active model's explicit `contextPromotionTarget` on context overflow. |
| `compaction.enabled` | boolean | `true` | Automatic conversation compaction. |
| `compaction.midTurnEnabled` | boolean | `true` | Check thresholds at safe mid-turn tool-loop boundaries before the next provider request. |
| `compaction.strategy` | enum | `snapcompact` | One of `context-full`, `handoff`, `shake`, `snapcompact`, `off`. |
| `compaction.thresholdPercent` | number | `-1` | Percent-of-context trigger; `-1` = reserve-based default. |
| `compaction.thresholdTokens` | number | `-1` | Fixed token trigger when `> 0`. |
| `compaction.reserveTokens` | number | unset | Tokens reserved for the next turn. When unset, the effective reserve is the larger of `16384` and 15% of the context window. |
| `compaction.keepRecentTokens` | number | `20000` | Recent tokens always preserved. |
| `compaction.remoteEnabled` | boolean | `true` | Allow remote compaction service. |
| `compaction.autoContinue` | boolean | `true` | Continue automatically after compaction. |
| `memory.backend` | enum | `off` | One of `off`, `local`, `hindsight`, `mnemopi`. Each backend has its own `hindsight.*` / `mnemopi.*` / `memories.*` tuning keys. |
| `autolearn.enabled` | boolean | `false` | Experimental: after the agent stops, nudge it to capture lessons to memory and create/enhance isolated managed skills under `~/.omp/agent/managed-skills`. Enables the `manage_skill` tool (and `learn` when a memory backend is active). |
| `autolearn.autoContinue` | boolean | `false` | When `autolearn.enabled`, auto-run one capture turn at stop (uses extra tokens). Off = a passive reminder rides your next turn. |
| `autolearn.minToolCalls` | number | `5` | Only nudge after a turn that used at least this many tools. |

`compaction` has additional tuning keys (idle compaction, supersede/drop heuristics) visible in `omp config list`. See [Compaction](/oh-my-pi/features/compaction/) for the full strategy reference.

## Mnemopi memory (SQLite)

With `memory.backend: mnemopi`, the agent stores and recalls memories from local SQLite banks via `@oh-my-pi/pi-mnemopi`. Recalled memory is injected as background context on the first turn of a session, and `recall`, `retain`, `reflect`, and `memory_edit` become available. See [Memory](/oh-my-pi/features/memory/) for the backend overview.

| Key | Type | Default | Description |
|---|---|---|---|
| `mnemopi.scoping` | enum | `per-project` | Memory visibility: `global` (one shared bank), `per-project` (isolated bank per working directory), `per-project-tagged` (project-local writes plus global recall visibility). |
| `mnemopi.dbPath` | string | unset | SQLite database path; defaults to the agent memories directory. |
| `mnemopi.bank` | string | unset | Shared bank base name; per-project modes derive project-local banks from it. |
| `mnemopi.autoRecall` | boolean | `true` | Recall local memories into the first turn of each session. |
| `mnemopi.autoRetain` | boolean | `true` | Retain completed conversation turns into local memory. |
| `mnemopi.retainEveryNTurns` | number | `4` | Minimum user turns between automatic retain writes. |
| `mnemopi.recallLimit` | number | `8` | Maximum recalled memories in the prompt block. |
| `mnemopi.recallContextTurns` | number | `3` | Prior user-bounded turns included in recall queries. |
| `mnemopi.recallMaxQueryChars` | number | `4000` | Maximum composed recall query length. |
| `mnemopi.injectionTokenLimit` | number | `5000` | Approximate token budget for memory prompt injection. |
| `mnemopi.noEmbeddings` | boolean | `false` | Force deterministic FTS-only recall instead of vector embeddings. |
| `mnemopi.embeddingVariant` | enum | `en` | Local embedding family: `en` (bge-base-en-v1.5, 768d) or `multilingual` (multilingual-e5-large, 1024d). Changing it rebuilds stored embeddings on the next start. |
| `mnemopi.embeddingModel` | string | unset | Explicit embedding model id; overrides `mnemopi.embeddingVariant`. |
| `mnemopi.embeddingApiUrl` | string | unset | Optional OpenAI-compatible embedding endpoint. |
| `mnemopi.embeddingApiKey` | string | unset | Optional embedding API key. |
| `mnemopi.llmMode` | enum | `smol` | `none` disables LLM-backed extraction, `smol` uses the online tiny model, `remote` uses the endpoint settings below. |
| `mnemopi.llmBaseUrl` | string | unset | OpenAI-compatible LLM endpoint for `llmMode: remote`. |
| `mnemopi.llmApiKey` | string | unset | LLM API key for `llmMode: remote`. |
| `mnemopi.llmModel` | string | unset | LLM model name for `llmMode: remote`. |
| `mnemopi.polyphonicRecall` | boolean | `false` | 4-voice recall (vector, graph, fact, temporal) fused with reciprocal rank fusion. |
| `mnemopi.enhancedRecall` | boolean | `false` | Tiered query result cache for repeated and similar recall queries. |
| `mnemopi.proactiveLinking` | boolean | `false` | Ingest new memories into the episodic graph, linking them to related entities and memories as they are stored. |
| `mnemopi.debug` | boolean | `false` | Enable debug logging for backend failures. |

## Hindsight memory (server bank)

With `memory.backend: hindsight`, memories live on a [Hindsight](https://hindsight.vectorize.io/) server (cloud or self-hosted). Recall is injected as background context on the first model turn, and `recall`, `retain`, and `reflect` become available. See [Memory](/oh-my-pi/features/memory/) for the backend overview.

| Key | Type | Default | Description |
|---|---|---|---|
| `hindsight.apiUrl` | string | `http://localhost:8888` | Hindsight server URL (cloud or self-hosted). |
| `hindsight.apiToken` | string | unset | Bearer token for authenticated Hindsight servers. |
| `hindsight.bankId` | string | unset | Memory bank identifier; defaults to the project name. |
| `hindsight.bankIdPrefix` | string | unset | Bank name prefix; changing the bank id, prefix, or scoping rebuilds the session state. |
| `hindsight.bankMission` | string | unset | Mission text sent to the server when creating the bank (used as the reflect mission). |
| `hindsight.scoping` | enum | `per-project-tagged` | `global` (one shared bank), `per-project` (isolated bank per working directory), `per-project-tagged` (shared bank with project tags so global and project memories merge on recall). |
| `hindsight.autoRecall` | boolean | `true` | Recall memories on the first turn of each session. |
| `hindsight.autoRetain` | boolean | `true` | Retain the transcript every N turns and at session boundaries. |
| `hindsight.retainMode` | enum | `full-session` | `full-session` upserts one document per session; `last-turn` chunks by turn boundaries. |
| `hindsight.retainEveryNTurns` | number | `3` | User turns between automatic retain writes. |
| `hindsight.retainOverlapTurns` | number | `2` | Overlap turns included with each retained chunk. |
| `hindsight.retainContext` | string | `omp` | Context label attached to retained memories. |
| `hindsight.retainMission` | string | unset | Retain mission text sent to the server when creating the bank. |
| `hindsight.recallBudget` | enum | `mid` | Recall budget sent with recall requests: `low`, `mid`, or `high`. |
| `hindsight.recallMaxTokens` | number | `1024` | Token cap per recalled memory. |
| `hindsight.recallContextTurns` | number | `1` | Prior turns included in recall queries. |
| `hindsight.recallMaxQueryChars` | number | `800` | Maximum composed recall query length. |
| `hindsight.recallTypes` | array | `["world", "experience"]` | Memory types included in recall. |
| `hindsight.mentalModelsEnabled` | boolean | `true` | Read curated reflect summaries (mental models) into developer instructions at boot; loads existing models on the bank, does not write. |
| `hindsight.mentalModelAutoSeed` | boolean | `true` | At session start, create built-in mental models (`project-conventions`, `project-decisions`, `user-preferences`) that do not yet exist on the bank. |
| `hindsight.mentalModelRefreshIntervalMs` | number | `300000` | Mental-model refresh interval. |
| `hindsight.mentalModelMaxRenderChars` | number | `16000` | Character cap when rendering mental models. |
| `hindsight.requestTimeoutMs` | number | `30000` | General request timeout. |
| `hindsight.recallTimeoutMs` | number | `30000` | Recall request timeout. |
| `hindsight.retainTimeoutMs` | number | `60000` | Retain request timeout. |
| `hindsight.reflectTimeoutMs` | number | `120000` | Reflect request timeout. |
| `hindsight.debug` | boolean | `false` | Enable debug logging for backend failures. |

## Local memory pipeline

With `memory.backend: local`, a background pipeline extracts durable signal from past sessions and consolidates it into `MEMORY.md`, `memory_summary.md`, and generated skill playbooks. The legacy `memories.enabled` flag is migration input only. See [Memory](/oh-my-pi/features/memory/) for the pipeline walkthrough.

| Key | Type | Default | Description |
|---|---|---|---|
| `memories.enabled` | boolean | `false` | Legacy local-memory enable flag, migrated to `memory.backend: local` when no explicit backend is set. |
| `memories.maxRolloutAgeDays` | number | `30` | Sessions older than this are not processed. |
| `memories.minRolloutIdleHours` | number | `12` | Sessions active more recently than this are skipped. |
| `memories.maxRolloutsPerStartup` | number | `64` | Cap on sessions processed in a single startup. |
| `memories.threadScanLimit` | number | `300` | Maximum recent session records scanned at startup. |
| `memories.maxRawMemoriesForGlobal` | number | `200` | Maximum per-session extractions supplied to global consolidation. |
| `memories.stage1Concurrency` | number | `8` | Concurrent per-session extraction jobs. |
| `memories.stage1LeaseSeconds` | number | `120` | Extraction job lease duration. |
| `memories.stage1RetryDelaySeconds` | number | `120` | Delay before a failed extraction becomes claimable again. |
| `memories.phase2LeaseSeconds` | number | `180` | Consolidation lease duration. |
| `memories.phase2RetryDelaySeconds` | number | `180` | Delay before failed consolidation is retried. |
| `memories.phase2HeartbeatSeconds` | number | `30` | Consolidation lease heartbeat interval. |
| `memories.rolloutPayloadPercent` | number | `0.7` | Fraction of the selected model's context budget available to rollout payloads. |
| `memories.phase1InputTokenLimit` | number | `4000` | Per-session extraction input cap. |
| `memories.fallbackTokenLimit` | number | `16000` | Model token budget used when the model has no finite declared context window. |
| `memories.summaryInjectionTokenLimit` | number | `5000` | Shared approximate token cap for the summary and captured lessons injected into the system prompt. |

## Compaction tuning

Additional compaction keys beyond the table above. See [Compaction](/oh-my-pi/features/compaction/) for the full strategy reference.

| Key | Type | Default | Description |
|---|---|---|---|
| `compaction.handoffSaveToDisk` | boolean | `false` | Automatically triggered handoffs also write `handoff-<timestamp>.md` into the persisted session's artifact directory. Manual handoffs are not written. |
| `compaction.remoteEndpoint` | string | unset | Remote compaction endpoint: a custom omp summarizer receives `{ systemPrompt, prompt }` and must return `{ summary }`; an OpenAI-compatible path ending in `/chat/completions` receives a chat request and uses `choices[0].message.content`. |
| `compaction.remoteStreamingV2Enabled` | boolean | `true` | Use Responses streaming compaction for compatible remote compaction models. |
| `compaction.v2RetainedMessageBudget` | number | `64000` | Token budget for retained real user messages in V2 streaming replacement history. |
| `compaction.idleEnabled` | boolean | `false` | Compact context while idle when the token count exceeds the threshold. |
| `compaction.idleThresholdTokens` | number | `200000` | Token count above which idle compaction triggers. |
| `compaction.idleTimeoutSeconds` | number | `300` | Seconds to wait while idle before compacting. |
| `compaction.supersedeReads` | boolean | `true` | Prune older read results when the same file is read again (cache-aware, runs every turn). |
| `compaction.dropUseless` | boolean | `true` | Prune tool results flagged contextually useless (no matches, timed-out waits) once consumed (cache-aware). |

## Branch summaries

During `/tree` navigation, the abandoned branch can be summarized at the new leaf; `Shift+Enter` requests summarization directly regardless of the prompt setting.

| Key | Type | Default | Description |
|---|---|---|---|
| `branchSummary.enabled` | boolean | `false` | Prompt to summarize when leaving a branch. |
| `branchSummary.reserveTokens` | number | `16384` | Tokens reserved from the model's context window for the branch-summary token budget. |

## Stream rules (TTSR)

Time-Traveling Stream Rules interrupt the agent mid-stream when output matches rule patterns. Rules are discovered from the rules capability; see [Stream rules](/oh-my-pi/features/stream-rules/) for authoring.

| Key | Type | Default | Description |
|---|---|---|---|
| `ttsr.enabled` | boolean | `true` | Master switch for stream-rule interruption. |
| `ttsr.builtinRules` | boolean | `true` | Load the default rules shipped with the agent (override individually with `ttsr.disabledRules`). |
| `ttsr.disabledRules` | array | `[]` | Rule names to ignore entirely (applies to bundled defaults and your own rules). |
| `ttsr.contextMode` | enum | `discard` | What to do with partial output when TTSR triggers: `discard` removes it before retry, `keep` leaves it in context. |
| `ttsr.interruptMode` | enum | `always` | When to interrupt mid-stream: `always` (prose and tool streams), `prose-only`, `tool-only`, or `never` (inject a warning after completion). |
| `ttsr.repeatMode` | enum | `once` | How rules can repeat: `once` per session or `after-gap` after a message gap. |
| `ttsr.repeatGap` | number | `10` | Completed turns before a rule can trigger again (used with `ttsr.repeatMode: after-gap`). |

## Snapcompact

`compaction.strategy: snapcompact` archives discarded history onto dense bitmap frames the model reads back, with no LLM call. See [Compaction](/oh-my-pi/features/compaction/) for the strategy reference.

| Key | Type | Default | Description |
|---|---|---|---|
| `snapcompact.shape` | enum | `auto` | Frame shape snapcompact prints text with (compaction archive and inline imaging). `auto` picks a shape tuned for the current model, falling back to its provider family. |
| `snapcompact.systemPrompt` | enum | `none` | Experimental: render selected system prompt text as dense PNG images attached to the first user message (vision models only). `none`, `agents-md` (loaded context-file instructions), or `all`. Saves tokens but loses prompt caching for imaged text. |
| `snapcompact.toolResults` | boolean | `false` | Experimental: render large historical tool results as dense PNG images instead of text (vision models only). Saves tokens on accumulated read/search output. |

## Tool calling format

| Key | Type | Default | Description |
|---|---|---|---|
| `tools.format` | enum | `auto` | How tools are exposed to the model: `auto` uses provider-native tool calls unless the model is marked as not supporting them, then the model-family owned dialect (falling back to `glm`); `native` forces provider-native calls; the other values force that owned in-band dialect (`glm`, `hermes`, `kimi`, `xml`, `anthropic`, `deepseek`, `harmony`, `qwen3`, `gemini`, `gemma`, `minimax`). Applies on session start. |
