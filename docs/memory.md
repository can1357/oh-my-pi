# Autonomous Memory

omp supports six memory modes. Memory is disabled by default; select one backend via `/settings` or `config.yml`:

| `memory.backend` | Storage and behavior                                                   | Guide                                                   |
| ---------------- | ---------------------------------------------------------------------- | ------------------------------------------------------- |
| `off`            | No memory backend                                                      | —                                                       |
| `local`          | Project-scoped summaries and lessons generated from persisted sessions | This page                                               |
| `hindsight`      | Remote, bank-scoped Hindsight memory                                   | [Hindsight](#hindsight-remote-backend)                  |
| `mnemopi`        | Local Mnemopi SQLite memory                                            | [Mnemopi memory backend](./mnemosyne-memory-backend.md) |
| `sharpshooter`   | Friction-gated project decision files (architecture/product/style), consolidated in the background | —                           |
| `dakera`         | Remote, agent-scoped [Dakera](https://dakera.ai) memory                | [Dakera](#dakera-remote-backend)                        |

Enable the local summary pipeline:

```yaml
memory:
  backend: local
```

## Usage

### What gets injected

At session start, if a consolidated summary or manually captured lesson exists for the current project, it is injected into the system prompt as a **Memory Guidance** block. The summary and lessons share `memories.summaryInjectionTokenLimit`.

- Treat memory as heuristic context — useful for process and prior decisions, not authoritative on current repo state.
- Cite the memory artifact path when memory changes the plan, and pair it with current-repo evidence before acting.
- Prefer repo state and user instruction when they conflict with memory; treat conflicting memory as stale.

### Reading memory artifacts

The agent can read memory files directly using `memory://` URLs with the `read` tool:

| URL                                    | Content                              |
| -------------------------------------- | ------------------------------------ |
| `memory://root`                        | Compact summary injected at startup  |
| `memory://root/MEMORY.md`              | Full long-term memory document       |
| `memory://root/learned.md`             | Lessons captured by the `learn` tool |
| `memory://root/skills/<name>/SKILL.md` | A generated skill playbook           |
| `memory://<memory-id>`                 | Full Mnemopi memory row (working or episodic) with a YAML frontmatter metadata header; only available when `memory.backend` is `mnemopi` |

The `memory://<memory-id>` form returns the full stored row rather than the clipped recall preview (recall content that exceeds the preview cap ends with a trailing `…`); agents are instructed to read it before any `memory_edit update`.

The `memory://root[/…]` rows are file-backed and only exist with `memory.backend: local`, which populates the on-disk memory root via the consolidation pipeline. Under `hindsight`, `mnemopi`, or `dakera` the root is never written, so those URLs do not resolve — use `recall`/`reflect` (and `read memory://<memory-id>` on `mnemopi`) instead. Dakera memories are not addressable by id at all: `memory://<id>` returns a corrective pointer to `recall`/`reflect`.

### `/memory` slash command

| Subcommand            | Effect                                                    |
| --------------------- | --------------------------------------------------------- |
| `view`                | Show the current backend injection payload                |
| `stats`               | Show backend-specific memory statistics, when supported   |
| `diagnose`            | Show backend-specific diagnostics, when supported         |
| `queue`               | Show pending memory deltas awaiting consolidation         |
| `sync`                | Run memory consolidation now                              |
| `clear` / `reset`     | Delete active backend memory data/artifacts               |
| `enqueue` / `rebuild` | Force consolidation/retention work for the active backend |
| `mm …`                | Hindsight mental-model maintenance (`list`/`show`/`refresh`/`history`/`seed`/`delete`/`reload`); unsupported in ACP mode |

### Capturing lessons

Enable `autolearn.enabled` to make the `learn` tool available:

```yaml
autolearn:
  enabled: true
```

With the local backend active, `learn` saves explicit durable lessons to the project's `learned.md`. Lessons are newest-first, deduplicated, secret-redacted, capped at 100 entries, and injected starting with the next session; a `learn` call does not mutate the active session's prompt-cache prefix. Each lesson's content is capped at 2,000 characters and optional context at 400 characters. Structured memory search, `recall`, `retain`, `reflect`, and `memory_edit` are not available for the local backend.

## How it works

Local summary memories are built by a background pipeline that runs at startup; `/memory enqueue` marks consolidation work that the next startup picks up. The pipeline is skipped for subagents and for sessions that are not persisted to a session file.

**Phase 1 — per-session extraction:** For each past session that has changed since it was last processed, a model reads the session history and extracts durable signal: technical decisions, constraints, resolved failures, recurring workflows. Sessions that are too recent, too old, currently active, or beyond the configured scan/age limits are skipped. Each extraction produces a raw memory block and a short synopsis for that session.

**Phase 2 — consolidation:** After extraction, a second model pass reads all per-session extractions and produces three generated outputs written to disk:

- `MEMORY.md` — a curated long-term memory document
- `memory_summary.md` — the compact text injected at session start
- `skills/` — reusable procedural playbooks, each in its own subdirectory

The separately maintained `learned.md` is not overwritten by consolidation.

Phase 2 uses a lease and heartbeat to prevent double-running when multiple processes start simultaneously. Stale skill directories from prior runs are pruned automatically.

Consolidated output is redacted for common secret/token patterns before `MEMORY.md`, `memory_summary.md`, or generated skills are written to disk.

### Extraction behavior

Memory extraction and consolidation behavior is driven by static prompt files in `packages/coding-agent/src/prompts/memories/`.

| File                      | Purpose                                          | Variables                                   |
| ------------------------- | ------------------------------------------------ | ------------------------------------------- |
| `stage_one_system.md`     | System prompt for per-session extraction         | —                                           |
| `stage_one_input.md`      | User-turn template wrapping session content      | `{{thread_id}}`, `{{response_items_json}}`  |
| `consolidation_system.md` | System prompt for cross-session consolidation    | —                                           |
| `consolidation.md`        | User-turn prompt for cross-session consolidation | `{{raw_memories}}`, `{{rollout_summaries}}` |
| `read-path.md`            | Memory guidance injected into live sessions      | `{{memory_summary}}`, `{{learned}}`         |

### Model selection

Memory piggybacks on the model role system.

| Phase                   | Role                                                                | Purpose                          |
| ----------------------- | ------------------------------------------------------------------- | -------------------------------- |
| Phase 1 (extraction)    | `default`                                                           | Per-session knowledge extraction |
| Phase 2 (consolidation) | `smol` (falls back to `default`, then current/first registry model) | Cross-session synthesis          |

If the requested memory role is not configured, memory model resolution falls back to the `default` role, then the active session model, then the first model in the registry.

## Configuration

| Setting                               | Default | Description                                                                                                                              |
| ------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `memory.backend`                      | `off`   | Select `local` for this pipeline; legacy `memories.enabled: true` is migrated to `memory.backend: local` when no explicit backend is set |
| `memories.maxRolloutAgeDays`          | `30`    | Sessions older than this are not processed                                                                                               |
| `memories.minRolloutIdleHours`        | `12`    | Sessions active more recently than this are skipped                                                                                      |
| `memories.maxRolloutsPerStartup`      | `64`    | Cap on sessions processed in a single startup                                                                                            |
| `memories.threadScanLimit`            | `300`   | Maximum recent session records scanned at startup                                                                                        |
| `memories.maxRawMemoriesForGlobal`    | `200`   | Maximum per-session extractions supplied to global consolidation                                                                         |
| `memories.stage1Concurrency`          | `8`     | Concurrent per-session extraction jobs                                                                                                   |
| `memories.stage1LeaseSeconds`         | `120`   | Extraction job lease duration                                                                                                            |
| `memories.stage1RetryDelaySeconds`    | `120`   | Delay before a failed extraction becomes claimable again                                                                                 |
| `memories.phase2LeaseSeconds`         | `180`   | Consolidation lease duration                                                                                                             |
| `memories.phase2RetryDelaySeconds`    | `180`   | Delay before failed consolidation is retried                                                                                             |
| `memories.phase2HeartbeatSeconds`     | `30`    | Consolidation lease heartbeat interval                                                                                                   |
| `memories.rolloutPayloadPercent`      | `0.7`   | Fraction of the selected model's context budget available to rollout payloads                                                            |
| `memories.phase1InputTokenLimit`      | `4000`  | Per-session extraction input cap                                                                                                         |
| `memories.fallbackTokenLimit`         | `16000` | Model token budget used when the model has no finite declared context window                                                             |
| `memories.summaryInjectionTokenLimit` | `5000`  | Shared approximate token cap for the summary and captured lessons injected into the system prompt                                        |

## Hindsight remote backend

Hindsight requires a reachable [Hindsight](https://hindsight.vectorize.io/) server. The default endpoint is `http://localhost:8888`; set a token when the server requires authentication:

```yaml
memory:
  backend: hindsight
hindsight:
  apiUrl: http://localhost:8888
  apiToken: ${HINDSIGHT_API_TOKEN}
```

`HINDSIGHT_*` environment variables override `hindsight.*` settings, which override built-in defaults. See the [complete Hindsight environment-variable table](./environment-variables.md#hindsight-memory-backend) for all 18 supported overrides, accepted values, parsing rules, precedence, and defaults.

By default, Hindsight uses `per-project-tagged` scoping: writes go to a shared bank with a project tag, while recall includes project-tagged and untagged global memories. `per-project` isolates each working-directory project in its own bank; `global` uses one shared bank. An explicit `hindsight.bankId` selects the bank base. Changes to the bank ID, prefix, or scoping rebuild the primary session state so later operations use the new scope.

Both project-scoped modes name the project the same way: take the repository's primary checkout root (so every linked worktree of one repository resolves to the same directory), then lowercase its basename. A checkout at `~/code/General` therefore tags `project:general`. Tags are matched literally, so this fold is what keeps one repository in one memory scope no matter how the path is capitalised.

The primary session recalls on its first model turn (`hindsight.autoRecall: true`) and automatically retains completed conversation turns every three user turns by default. `/memory enqueue` flushes queued tool retains and forces retention of the current session. At agent end, the primary state schedules cadence-based retention and flushes the retain queue; session disposal drains that queue before releasing the state. Request failures and configured timeouts are logged and leave the coding session usable. Subagents alias the parent's client, bank, and scope for explicit `recall`, `retain`, and `reflect` calls, but do not run their own automatic recall or retention.

Recall is injected as background context, not instructions, and recalled memory is also available as extra context during compaction. Selecting Hindsight exposes `recall`, `retain`, and `reflect`; `memory_edit` is not available because upstream Hindsight memories are not edited through this backend.

`/memory view`, `/memory stats`, `/memory diagnose`, and `/memory enqueue` operate through the active Hindsight state. `/memory clear` first drains pending retains, then clears only the local session state and recall cache. It **does not delete the server-side bank**; delete that bank with the Hindsight UI or API.

## Dakera remote backend

[Dakera](https://dakera.ai) is a self-hosted memory server with a plain REST API; no SDK or extra dependency is needed on the omp side. The default endpoint is `http://localhost:3000`; set a token when the server requires authentication:

```yaml
memory:
  backend: dakera
dakera:
  apiUrl: http://localhost:3000
  apiToken: ${DAKERA_API_TOKEN}
```

`DAKERA_*` environment variables override `dakera.*` settings, which override built-in defaults. Both `DAKERA_API_TOKEN` and `DAKERA_API_KEY` are accepted for the bearer token (`TOKEN` wins when both are set), so one exported variable covers the server, its MCP surface, and omp. See the [complete Dakera environment-variable table](./environment-variables.md#dakera-memory-backend) for all supported overrides, accepted values, parsing rules, precedence, and defaults.

Dakera has **no bank concept**: the isolation unit is the `agent_id`. `dakera.scoping` therefore offers two modes — `global` (one shared agent id; every project's memories mix, and retains are tagged `project:<label>` so provenance survives) and the default `per-project` (one agent id per repository, hard isolation). There is no `per-project-tagged` mode because Dakera's recall accepts no tag filter, so a shared id with per-project tags would write into a scope it could never read back. An explicit `dakera.agentId` selects the base id (default `omp`), and `dakera.agentIdPrefix` prepends an environment segment (`prod-team` + `alpha` → `prod-team-alpha`). No setup call is needed: storing against an unseen agent id creates it.

Project naming matches Hindsight: the repository's primary checkout root (so every linked worktree resolves to one directory), lowercased basename. Because that derivation names one agent per repository, a multi-repo setup that wants a single logical agent can pin the id in the repository itself: a `dakera.agentId` string in `<repo>/.omp/config.yml` replaces the whole derived id (prefix included). The file is looked up from the working directory up to the repository root — so it applies from subfolders and linked worktrees alike, where project settings are otherwise invisible — and never above it, so sibling checkouts cannot read each other's override.

The primary session recalls on its first model turn (`dakera.autoRecall: true`) and retains the transcript on agent end every three user turns by default (`dakera.autoRetain: true`, `dakera.retainEveryNTurns`). `dakera.retainMode: full-session` keeps **one** growing episodic memory per session and rewrites it in place (`PUT /v1/memory/update/{id}`) instead of piling up duplicates; a new session id or `/memory enqueue` starts a fresh one. `last-turn` stores a chunk sliced at the user-turn boundary instead. Recalled and retained content is secret-redacted on the wire, including the `context` a `retain` item carries in the row's metadata. Subagents resolve the same agent id as their project but run no automatic recall or retention of their own; explicit `recall`, `retain`, and `reflect` calls still work.

A store is not inert: the server runs its own fact extraction over the row it just took, so a retained transcript also yields derived `semantic` rows. Those include bare `[timestamp: …]` lines from the retention format, and they appear in later recall results — expect more rows than writes.

Recall is injected as background context, not instructions, and recalled memory is also available as extra context during compaction. Results are ranked by the server's `smart_score` (falling back to `weighted_score`, then `score`). Selecting Dakera exposes `recall`, `retain`, and `reflect`; `memory_edit` is not available and neither is `read memory://<id>` — Dakera rows are not addressable through the internal URL scheme, and the handler returns a pointer to `recall`/`reflect`.

`reflect` is synthesized **client-side**: Dakera has no generative endpoint, so omp recalls over the question and asks a model to answer across those memories. Nothing is written back — a reflection stored as a memory would feed the next recall. The model comes from `dakera.reflectModel` and otherwise walks the memory role ladder (`smol`, then `default`).

`/memory view`, `/memory stats` (per-`memory_type` counts), and `/memory enqueue` operate through the active Dakera state. Unlike Hindsight, `/memory clear` really does wipe the server: it lists the agent's memories and `POST`s them to `/v1/memory/forget`. Counts rendered as `N+ (listing capped at 1000)` are a page floor, not a total.

Two Dakera endpoints are deliberately not wrapped: `consolidate` and `knowledge_summarize`. Both concatenate their inputs rather than synthesize, `consolidate` ignores `dry_run` (a "preview" merges and deletes for real), and the server's counters (`deleted_count`, `memories_removed`) are inflated, so neither result can be trusted as reported.

If you self-host, note that Dakera ships with telemetry enabled; set `DAKERA_TELEMETRY=off` on the server.

## Key files

- `packages/coding-agent/src/memories/index.ts` — pipeline orchestration, injection, clear/enqueue entry points (the `/memory` command routes here via `packages/coding-agent/src/memory-backend/local-backend.ts`)
- `packages/coding-agent/src/memories/storage.ts` — SQLite-backed job queue and thread registry
- `packages/coding-agent/src/prompts/memories/` — memory prompt templates
- `packages/coding-agent/src/dakera/` — Dakera REST client, agent-id scoping, session state, and client-side `reflect` synthesis
- `packages/coding-agent/src/internal-urls/memory-protocol.ts` — `memory://` URL handler
