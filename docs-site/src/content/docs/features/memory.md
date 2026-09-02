---
title: Memory
description: Long-term memory backends (local, hindsight, mnemopi) and the retain, recall, reflect, and memory_edit tools that interact with them.
coverage: B
---

omp can carry knowledge forward between sessions through a long-term memory backend. With one enabled, the agent writes durable facts from finished work into a store and pulls relevant context back into the system prompt of future sessions — so recurring decisions, project conventions, and pitfalls don't have to be re-derived every time.

Memory is disabled by default (`memory.backend: off`).

## Enabling a backend

Set the backend in `config.yml`:

```yaml
memory:
  backend: local      # or "hindsight", "mnemopi"
```

Three backends are available:

| Backend | Storage | Notes |
| --- | --- | --- |
| `local` | Local summary pipeline (`MEMORY.md`, `memory_summary.md`, generated skills) | Default pipeline; project-scoped, two-phase extraction+consolidation. |
| `hindsight` | Server-side bank (HTTP) | Cross-session memories, project scoping via bank ids and tags, built-in mental models. |
| `mnemopi` | Local SQLite (via `@oh-my-pi/pi-mnemopi`) | Project-local banks, optional remote embeddings/LLM, FTS-only mode available. |

Legacy `memories.enabled: true` is migrated to `memory.backend: local` when no explicit backend is set.

## The four tools

Four tools cover the user-facing memory operations. They are only available when the active backend supports them — `memory_edit` is mnemopi-only; `retain`, `recall`, and `reflect` work with both `hindsight` and `mnemopi`.

### retain — store durable facts

```yaml
items:
  - content: "Project uses Bun, not Node, for the test runner."
    context: "Discovered while debugging the CI matrix."
```

Each item is self-contained; `context` is optional per-item provenance. The tool hands items to the active backend: Hindsight queues them and flushes asynchronously (default batch 16, debounce 5 s); Mnemopi writes them to the local scoped bank. Per-item write failures are logged and not surfaced to the model.

### recall — search stored memories

```yaml
query: "How do we configure the provider prompt-cache key?"
```

Returns either a formatted bullet list (`Found N relevant memories…`) or `No relevant memories found.` Recall results include memory ids when the backend is mnemopi — save those for `memory_edit`. Hindsight returns `text`-typed bullets with optional `[type]` and `(mentioned_at)` suffixes.

This tool does not auto-compose context from recent turns and does not refresh the system-prompt memory block; it just returns a snapshot of recall hits. Use `reflect` if you want a synthesized answer.

### reflect — synthesize an answer over memory

```yaml
query: "What was the original reason we picked pnpm over npm?"
context: "We're re-evaluating this for the new monorepo."
```

Hindsight sends `query` (with `context` as a separate field) to the server-side `/reflect` endpoint, which returns a synthesized answer. Mnemopi's path is local: it runs recall scoped to the active banks and renders the results into a `Based on recalled memories:` context block.

### memory_edit — update, forget, or invalidate (mnemopi only)

```yaml
op: invalidate      # "update" | "forget" | "invalidate"
id: "<id from recall>"
replacement_id: "<id of the memory that supersedes this one>"
```

`update` replaces memory text and/or importance (`importance` is clamped to `0..1`). `forget` hard-deletes a memory. `invalidate` softly supersedes one and may point at a `replacement_id`. The `id` must come from a previous `recall` — the tool does not search by content. Available only when `memory.backend == "mnemopi"`.

## Auto-learn and managed skills

Auto-learn is an experimental companion to memory. With `autolearn.enabled: true`, after a substantive turn omp nudges the agent — or, with `autolearn.autoContinue`, runs one private capture turn — to codify anything reusable from that turn as a managed skill, and to store durable facts with the `learn` tool when a memory backend is active.

A turn counts as substantive when it used at least `autolearn.minToolCalls` tools (default 5), did not start in goal mode, was not in plan mode, and was not aborted. The capture turn decides what is worth keeping: a repeatable procedure becomes a managed skill, a durable fact, convention, or preference goes to memory — and then it stops without touching further work.

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `autolearn.enabled` | boolean | `false` | Master switch. Enables the `manage_skill` tool (and `learn` when a memory backend is active) and the post-stop capture behavior. |
| `autolearn.autoContinue` | boolean | `false` | Auto-run one private capture turn at stop (uses extra tokens). Off means only the standing auto-learn guidance remains in the system prompt. |
| `autolearn.minToolCalls` | number | `5` | Only capture after a turn that used at least this many tools. |

These keys are listed in [Settings — Context](/oh-my-pi/reference/settings/context/).

### Managed skills

Managed skills are `SKILL.md` files kept in an isolated directory, `~/.omp/agent/managed-skills`. They are surfaced to the agent in future sessions like any other skill, and they are the only skills the agent may write — user-authored skills under `~/.omp/agent/skills` and `.omp/skills` are never edited by it. Skill names are lowercase kebab-case, and a generated skill is capped at 64,000 bytes.

The `manage_skill` tool creates, updates, and deletes managed skills (`action: create | update | delete`, with `description` and `body` required for create/update). It requires write approval and is available when `autolearn.enabled` is on.

### The `learn` tool

`learn` persists a self-contained lesson to the active memory backend and can mint or enhance a managed skill in the same call:

```yaml
memory: "Project uses Bun, not Node, for the test runner."
context: "Discovered while debugging the CI matrix."
skill:
  action: create
  name: bun-test-runner
  description: "Run the project test suite with Bun"
  body: "…"
```

It is gated behind `autolearn.enabled` plus a live memory backend — `hindsight`, `mnemopi`, or `local`. A call that writes (`skill` present, or the `local` backend) requires approval.

Tool availability is decided at session start: enable the `autolearn.*` settings, then start a new session. A mid-session disable is honored, but a mid-session enable does not retroactively install the tools.

## The `/memory` slash command

| Subcommand | Effect |
| --- | --- |
| `/memory view` | Show the current backend's injection payload (what would be added to the system prompt). |
| `/memory stats` | Show backend-specific memory statistics, when supported. |
| `/memory diagnose` | Show backend-specific diagnostics, when supported. |
| `/memory clear` / `/memory reset` | Delete active backend memory data/artifacts. |
| `/memory enqueue` / `/memory rebuild` | Force consolidation/retention work for the active backend. |

## Reading memory artifacts

The agent can read memory files directly with the `read` tool using `memory://` URLs:

| URL | Content |
| --- | --- |
| `memory://root` | Compact summary injected at startup (the "Memory Guidance" block). |
| `memory://root/MEMORY.md` | Full long-term memory document. |
| `memory://root/skills/<name>/SKILL.md` | A generated skill playbook. |

The injected "Memory Guidance" block instructs the agent to treat memory as heuristic context — useful for process and prior decisions, not authoritative on current repo state — and to pair it with current-repo evidence before acting. When memory conflicts with current repo state or a user instruction, current state wins and the conflicting memory is treated as stale.

## Local backend tuning

The local summary pipeline builds a project-scoped store through a two-phase background process. Extraction runs per-session; consolidation runs across sessions, writing `MEMORY.md`, `memory_summary.md`, and skill playbooks. Output is redacted for common secret/token patterns before being written to disk.

| Setting | Default | Description |
| --- | --- | --- |
| `memory.backend` | `off` | Select `local` for this pipeline. |
| `memories.maxRolloutAgeDays` | `30` | Sessions older than this are not processed. |
| `memories.minRolloutIdleHours` | `12` | Sessions active more recently than this are skipped. |
| `memories.maxRolloutsPerStartup` | `64` | Cap on sessions processed in a single startup. |
| `memories.summaryInjectionTokenLimit` | `5000` | Max tokens of summary injected into the system prompt. |

## Hindsight settings

Settings used by the `retain`/`recall`/`reflect` tools when `memory.backend == "hindsight"`:

| Setting | Default | Description |
| --- | --- | --- |
| `hindsight.recallBudget` | `mid` | Budget passed to Hindsight recall/reflect requests. |
| `hindsight.recallMaxTokens` | `1024` | Token cap for `recall` results. |
| `hindsight.recallTypes` | `["world", "experience"]` | Memory types surfaced by `recall`. |
| `hindsight.retainEveryNTurns` | `3` | Auto-retain cadence (turns between runs). |
| `hindsight.retainOverlapTurns` | `2` | Overlap kept between auto-retain runs. |
| `hindsight.retainContext` | `omp` | Provenance label attached to retained items. |
| `hindsight.retainMode` | `full-session` | Auto-retain scope. |
| `hindsight.mentalModelsEnabled` | `true` | Whether to seed and render mental models. |
| `hindsight.mentalModelAutoSeed` | `true` | Auto-create built-in mental-model seeds on first use. |
| `hindsight.mentalModelRefreshIntervalMs` | `300000` | Five minutes; mental-model cache refresh interval. |
| `hindsight.mentalModelMaxRenderChars` | `16000` | Cap on the rendered `<mental_models>` block. |

Hindsight bank scoping (computed per project):

- `global` — one shared bank, no project tags.
- `per-project` — bank id gets `-<project label>` appended (git primary checkout root basename, or cwd basename outside a repo).
- `per-project-tagged` — shared bank id plus `project:<project label>` tags on retained memories.

## Mnemopi settings

Mnemopi stores memories in a local SQLite database (`mnemopi.dbPath`, defaulting to `mnemopi/mnemopi.db` under the agent memories directory).

| Setting | Default | Description |
| --- | --- | --- |
| `mnemopi.dbPath` | agent memories dir | Optional SQLite database path. |
| `mnemopi.bank` | unset | Optional shared bank base name; per-project modes derive a project bank from the working-directory basename plus a stable hash of the absolute path. |
| `mnemopi.scoping` | `per-project` | `global` / `per-project` / `per-project-tagged` (project-local writes plus global recall visibility). |
| `mnemopi.autoRecall` | `true` | Recall on the first turn of a session. |
| `mnemopi.autoRetain` | `true` | Retain completed turns automatically. |
| `mnemopi.polyphonicRecall` | `false` | Enable 4-voice polyphonic recall (vector, graph, fact, temporal) with reciprocal rank fusion. `MNEMOPI_POLYPHONIC_RECALL` overrides when set. |
| `mnemopi.enhancedRecall` | `false` | Enable the tiered query result cache for repeated/similar recall queries. `MNEMOPI_ENHANCED_RECALL` overrides when set. |
| `mnemopi.retainEveryNTurns` | `4` | Minimum user turns between automatic retain writes. |
| `mnemopi.recallLimit` | `8` | Maximum recalled memories in the prompt block. |
| `mnemopi.recallContextTurns` | `3` | Prior user-bounded turns included in recall queries. |
| `mnemopi.recallMaxQueryChars` | `4000` | Maximum composed recall query length. |
| `mnemopi.injectionTokenLimit` | `5000` | Approximate token budget for memory prompt injection. |
| `mnemopi.debug` | `false` | Enable debug logging for backend failures. |
| `mnemopi.noEmbeddings` | `false` | Force FTS-only recall (passes `noEmbeddings` to `Mnemopi`). |
| `mnemopi.embeddingVariant` | `en` | Local embedding model variant: `en` (BAAI/bge-base-en-v1.5, 768d) or `multilingual` (intfloat/multilingual-e5-large, 1024d). Changing it rebuilds stored embeddings on the next writable start. |
| `mnemopi.embeddingModel` | variant default | Explicit embedding model id; overrides `mnemopi.embeddingVariant`. |
| `mnemopi.embeddingApiUrl` | env/default | OpenAI-compatible embedding endpoint. |
| `mnemopi.embeddingApiKey` | env/default | Embedding API key. |
| `mnemopi.llmMode` | `smol` | `smol` (configured pi-ai smol model), `remote` (use the `llmBaseUrl`/`llmApiKey`/`llmModel` settings), or `none` (disable LLM calls). |
| `mnemopi.llmBaseUrl` | env/default | OpenAI-compatible LLM endpoint for `llmMode: remote`. |
| `mnemopi.llmApiKey` | env/default | LLM API key for `llmMode: remote`. |
| `mnemopi.llmModel` | env/default | LLM model id for `llmMode: remote`. |

Mnemopi bank scoping (set via `mnemopi.scoping`):

- `global` — recall and writes use the shared bank.
- `per-project` — writes and reads use the project bank derived from cwd basename plus a stable hash.
- `per-project-tagged` — writes go to the project bank; recall reads both project and shared banks, then merges results.

Subagents do not own separate mnemopi retain loops — they alias the parent state when a parent exists, and otherwise remain inert.

## Operational notes

- Recalled memory is background context, not instructions. Current user messages and tool output take precedence when they conflict.
- The local summary pipeline is skipped for subagents and for sessions that are not persisted to a session file.
- Mnemopi `/memory clear` removes every scoped database and sidecar WAL/SHM files for the active configuration.
- Hindsight storage is server-side. The `hindsightBackend.clear(...)` action only clears local cache and state; upstream deletion must happen in the Hindsight UI or via `deleteBank`.
