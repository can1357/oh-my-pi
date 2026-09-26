# retain

> Store durable facts through the active long-term memory backend.

## Source
- Entry: `packages/coding-agent/src/tools/memory-retain.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/retain.md`
- Hindsight collaborators:
  - `packages/coding-agent/src/hindsight/state.ts` — per-session queue, flush, auto-retain.
  - `packages/coding-agent/src/hindsight/backend.ts` — session bootstrap, prompt injection, subagent aliasing.
  - `packages/coding-agent/src/hindsight/bank.ts` — bank id derivation, tag scoping, first-use bank/mission setup.
  - `packages/coding-agent/src/hindsight/client.ts` — HTTP `retain` / `retainBatch` calls.
  - `packages/coding-agent/src/hindsight/content.ts` — retention transcript shaping, memory-tag stripping.
  - `packages/coding-agent/src/hindsight/mental-models.ts` — bank-scoped mental-model seeding and cache rendering.
  - `packages/coding-agent/src/hindsight/seeds.json` — built-in mental-model seed definitions.
  - `packages/coding-agent/src/hindsight/transcript.ts` — extracts user/assistant turns for auto-retain.
- Dakera collaborators:
  - `packages/coding-agent/src/dakera/state.ts` — session state, synchronous retain path, auto-retain cadence.
  - `packages/coding-agent/src/dakera/backend.ts` — session bootstrap, prompt injection, clear/enqueue.
  - `packages/coding-agent/src/dakera/bank.ts` — agent-id derivation and retain tags.
  - `packages/coding-agent/src/dakera/client.ts` — HTTP `store` / `storeBatch` / `update` calls.
  - `packages/coding-agent/src/hindsight/content.ts` and `packages/coding-agent/src/hindsight/transcript.ts` — transcript extraction and shaping, reused rather than copied.
- Mnemopi collaborators:
  - `packages/coding-agent/src/mnemopi/backend.ts` — local backend bootstrap, prompt injection, subagent aliasing, enqueue/clear.
  - `packages/coding-agent/src/mnemopi/state.ts` — scoped recall/retain state and local writes.
  - `packages/coding-agent/src/mnemopi/config.ts` — local SQLite path, bank, scoping, provider settings.
  - `packages/mnemopi/src/core/memory.ts` — local memory runtime used by `remember(...)`.

## Registration / Visibility
- Tool metadata: `strict = true`, `loadMode = "discoverable"`. Approval is dynamic: a call with any `scope: "global"` item has `approval = "write"`, because the write reaches every project's recall; otherwise `approval = "read"`, even though successful calls enqueue or perform memory writes.
- The tool is registered only for `memory.backend = "hindsight"`, `"mnemopi"`, or `"dakera"`; it is absent for `"off"` and `"local"`.
- In unrestricted sessions with an explicit tool list, registration auto-includes the shared `recall`/`retain`/`reflect` set for any of those backends. Restricted lists are not widened.
- In an ordinary `tools.xdev` session, discoverable built-ins may be presented as `xd://retain`; an explicitly requested tool remains top-level.
- Execution returns one final result and has no progress callback or cancellation parameter.

## Inputs

| Field | Type | Required | Description |
|---|---|---:|---|
| `items` | `Array<{ content: string; context?: string; scope?: "project" \| "global" }>` | Yes | One or more memories to store. `minItems: 1`. Each item must be self-contained; `context` is optional per-item provenance. `scope` is in the schema and tool description only when `memory.backend = "mnemopi"` and `mnemopi.scoping` is `global` or `per-project-tagged`; omitted means `project`. |

## Outputs
The output depends on the active `memory.backend`.

Hindsight:
- `content[0].type = "text"`
- `content[0].text = "<count> memory queued."` or `"<count> memories queued."`
- `details = { count: number }`
- The write is not confirmed before the tool returns. The queue flushes later; flush failures emit a session warning notice and are not returned to the model.

Mnemopi:
- `content[0].type = "text"`
- `content[0].text = "<count> memory stored."` or `"<count> memories stored."`
- `details = { count: number }`
- The tool invokes local writes synchronously, but `rememberScoped(...)` catches each write failure and returns `undefined`; `retain` ignores that return and still reports the requested count. The response is therefore not a per-item durability receipt.

Dakera:
- `content[0].type = "text"`
- `content[0].text = "<count> memory stored."` or `"<count> memories stored."`
- `details = { count: number }`
- The batch is stored before the call returns, and `<count>` is the number of rows the server answered with a usable `id` — not the number requested. Items whose content is blank after trimming are dropped without a request, and a server that returns rows without ids reports `0 memories stored.` rather than a flattering count.

## Flow
1. `MemoryRetainTool.createIf(...)` exposes the tool when `memory.backend` is `"hindsight"`, `"mnemopi"`, or `"dakera"`.
2. `execute(...)` re-reads `memory.backend` and dispatches to the matching session state.
3. If the backend is `dakera`:
   - it fetches `session.getDakeraSessionState()` and throws if the backend was not started;
   - `state.retainItems(...)` maps each item to `memory_type: "semantic"`, `importance: dakera.retainImportance`, and `metadata.context` (provenance is never merged into the content);
   - every field the server persists is passed through `redactMemoryTextFields(...)`, so a secret in `context` cannot ride in via metadata;
   - one `POST /v1/memories/store/batch` carries the whole batch, stamped with the scope's retain tags and `session_id`.
4. If the backend is `mnemopi`:
   - it fetches `session.getMnemopiSessionState()` and throws if the backend was not started;
   - if any item has `scope: "global"`, it resolves `state.getGlobalRetainTarget()` first; under `per-project` scoping that throws `Mnemopi global scope requires global or per-project-tagged scoping.` and nothing in the batch is stored;
   - for each item, it calls `state.rememberScoped(item.content, ...)` with `source: "coding-agent-retain"`, `importance: 0.75`, `scope: "bank"`, `extract: true`, `extractEntities: true`, `veracity: "tool"`, `memoryType: "fact"`, and metadata `{ session_id, cwd, context, tool: "retain" }`;
   - project items go to the scoped retain bank and global items to the global target (passed as `rememberScoped`'s third argument); exact duplicate content in the same session updates the existing working-memory row in the Mnemopi core.
5. If the backend is `hindsight`:
   - it fetches `session.getHindsightSessionState()` and throws if the backend was not started;
   - any `scope: "global"` item rejects the batch with `Global memory scope is only available with the Mnemopi backend.` before anything is queued (untagged Hindsight retains are not supported yet);
   - each input item is handed to `HindsightSessionState.enqueueRetain(...)`;
   - `HindsightRetainQueue.enqueue(...)` appends the item and either flushes immediately when the queue reaches `RETAIN_FLUSH_BATCH_SIZE`, or starts a debounce timer for `RETAIN_FLUSH_INTERVAL_MS`;
   - on flush, `HindsightRetainQueue.#doFlush(...)` verifies ownership, best-effort ensures the bank exists via `ensureBankExists(...)`, maps items to `MemoryItemInput` with `context ?? config.retainContext`, `metadata.session_id`, and bank-scope tags, then sends one async `retainBatch(...)` request.

## Modes / Variants
- Hindsight tool path: queued batch write only.
- Mnemopi tool path: direct local `remember(...)` into the scoped retain bank.
- Dakera tool path: direct synchronous `storeBatch(...)`; there is no local queue, so the reported count is what the server stored.
- Hindsight bank scoping from `computeBankScope(...)`:
  - `global` — one shared bank, no project tags.
  - `per-project` — bank id gets `-<project label>` appended, where the label is the git primary checkout root basename (cwd basename outside a repo).
  - `per-project-tagged` — shared bank plus `project:<project label>` tags on retained memories.
- Mnemopi bank scoping from `computeMnemopiBankScope(...)`:
  - `global` — retain and recall use the shared bank; `scope: "global"` writes there too.
  - `per-project` — retain and recall use a project bank derived from the absolute cwd basename plus a hash of that absolute cwd; `scope: "global"` is not offered.
  - `per-project-tagged` — retain writes to the cwd-derived project bank, or to the shared bank for `scope: "global"` items; recall also reads the shared bank.
  - Per-project recall may add safe legacy banks whose stored working-memory rows all match the active cwd; scanning is capped at 64 candidate bank directories.
- Dakera agent-id scoping from `computeAgentScope(...)` (no bank concept — the `agent_id` is the isolation unit):
  - `global` — one shared agent id; every retain is tagged `project:<project label>` for provenance, which recall cannot filter on.
  - `per-project` — `[<prefix>-]<agentId|omp>-<project label>`, so another project cannot read it back at all.
  - No setup call precedes the first write: storing against an unseen `agent_id` creates it server-side.
- Session scope:
  - tool-called retains are per-session work for the active backend;
  - persisted Hindsight and Dakera memories are cross-session server-side data;
  - persisted Mnemopi memories are local SQLite data;
  - subagents alias parent memory state for Hindsight and Mnemopi; a Dakera subagent gets its own state object but resolves the same agent id as its project, and runs no automatic recall or retention.

## Side Effects
- Filesystem
  - Hindsight: none for retained memories. No local memory file is written.
  - Dakera: none. The server holds the only copy.
  - Mnemopi: writes to local SQLite under `mnemopi.dbPath`, defaulting beneath the agent memories directory (`mnemopi/mnemopi.db`) with one database file per scoped bank when needed.
- Network
  - Hindsight: `POST /v1/default/banks/{bank_id}/memories` via `retainBatch(...)`, plus optional `PUT /v1/default/banks/{bank_id}` via `ensureBankExists(...)` before the first write per bank per session state (the set is created with the primary session state and shared with subagent aliases).
  - Dakera: `POST /v1/memories/store/batch` via `storeBatch(...)` (single item: `POST /v1/memory/store`), awaited before the tool returns.
  - Mnemopi: none unless configured embedding or LLM providers make calls during extraction.
- Session state
  - Hindsight: appends to the in-memory `HindsightRetainQueue`, includes `metadata.session_id`, and shares parent state for subagents.
  - Dakera: stamps `session_id` and the scope's tags on each row; the in-flight write is tracked so disposal and a backend switch await it instead of dropping it.
  - Mnemopi: writes through the session's scoped `Mnemopi` instance, includes `session_id`, `cwd`, and optional `context`, and shares scoped resources with subagents.
- User-visible prompts / interactive UI
  - Hindsight async flush failures emit `session.emitNotice("warning", ...)`; the model is not told.
  - Mnemopi write failures are logged by `rememberInScope(...)`; the tool response does not expose per-item failures.
  - Dakera write failures surface to the model as a failed tool call; there is no queue that could swallow them. Auto-retain failures emit `session.emitNotice("warning", ...)` instead.
- Background work / cancellation
  - Hindsight flush runs later on the debounce timer or queue-size threshold; backend `enqueue(...)` and `clear(...)` explicitly drain it. A session-ownership mismatch at flush time logs and drops the batch.
  - Mnemopi fact/entity extraction and embedding may continue after the synchronous row write. Backend `enqueue(...)` requests full consolidation; backend clear disposes scoped instances before deleting their database files.
  - `retain.execute()` itself has no abort-signal handling.

## Limits & Caps
- Input schema requires `items.length >= 1`; item strings have no schema-level minimum length.
- Tool availability requires `memory.backend` to be `"hindsight"`, `"mnemopi"`, or `"dakera"`; default `memory.backend` is `"off"`.
- Hindsight queue flush threshold: `RETAIN_FLUSH_BATCH_SIZE = 16`.
- Hindsight queue debounce: `RETAIN_FLUSH_INTERVAL_MS = 5_000`.
- Hindsight queue writes use `retainBatch(..., { async: true })`; the client request timeout defaults to `hindsight.retainTimeoutMs = 60_000`, but it does not wait for server-side consolidation.
- Hindsight auto-retain settings:
  - `hindsight.autoRetain = true`
  - `hindsight.retainEveryNTurns = 3`
  - `hindsight.retainOverlapTurns = 2`
  - `hindsight.retainContext = "omp"`
  - `hindsight.retainMode = "full-session"`
- Mnemopi retain settings:
  - `mnemopi.autoRetain = true`
  - `mnemopi.retainEveryNTurns = 4`
  - `mnemopi.scoping = "per-project"`
- Dakera retain settings:
  - `dakera.autoRetain = true`
  - `dakera.retainEveryNTurns = 3`
  - `dakera.retainMode = "full-session"`
  - `dakera.retainImportance = 0.5` (the `importance` stamped on every stored row; Dakera raises it on each read)
  - `dakera.scoping = "per-project"`
  - `dakera.retainTimeoutMs = 60_000`

## Errors
- Throws `Mnemopi backend is not initialised for this session.` when `memory.backend == "mnemopi"` but no state exists.
- Throws `Hindsight backend is not initialised for this session.` when `memory.backend == "hindsight"` but no state exists.
- Throws `Dakera backend is not initialised for this session.` when `memory.backend == "dakera"` but no state exists.
- Hindsight queue enqueue on disposed state throws `Hindsight retain queue is closed.`
- Hindsight flush-time API failures are caught, logged, and converted into a warning notice instead of a tool error.
- Hindsight bank/mission creation failures are logged at debug level and swallowed in `ensureBankExists(...)`; the later write still runs.
- Mnemopi `remember(...)` failures are caught in `MnemopiSessionState.rememberInScope(...)`, logged, and not rethrown to the tool caller.
- Dakera store failures propagate as `DakeraError` — nothing is queued, so there is no later flush that could absorb them.

## Notes
- Hindsight storage is server-side. `hindsightBackend.clear(...)` drains the local queue, clears local cache/state, and warns that upstream deletion must happen in Hindsight UI or `deleteBank`.
- Dakera storage is server-side and holds the only copy, so `dakeraBackend.clear(...)` really deletes: it lists the agent's memories and posts them to `POST /v1/memory/forget`. Only the first 1000 rows are listed, and a count of exactly that is rendered as `1000+`.
- Mnemopi storage is local SQLite. `mnemopiBackend.clear(...)` removes the database files for every active scoped bank and then rehydrates the backend when the session remains active.
- Dakera auto-retain keeps one `memory_type: "episodic"` row per transcript in `full-session` mode and rewrites it with `PUT /v1/memory/update/{id}?agent_id=…`; if the server never returned an id for that row, the next retain stores a new one instead of losing the transcript.
- Hindsight auto-retain uses the same bank but a different path than this tool: `retainSession(...)` extracts plain user/assistant transcript, strips `<memories>` / `<mental_models>` blocks, and calls single-item `retain(...)`. Dakera auto-retain reuses that same shaping through `retainTranscript(...)`.
- Mnemopi auto-retain stores prepared transcripts with `source: "coding-agent-transcript"`, `importance: 0.65`, `veracity: "unknown"`, and `memoryType: "episode"`.
- Hindsight mental-model bootstrap lives in the shared backend: `HindsightSessionState.runMentalModelLoad(...)` optionally resolves seeds, creates missing models, then caches a rendered `<mental_models>` block for prompt injection.
- Built-in Hindsight seeds are `user-preferences`, `project-conventions`, and `project-decisions`. `projectTagged: true` seeds inherit the active scope's retain tags; untagged seeds read the whole bank.
- Hindsight mental-model defaults: `hindsight.mentalModelsEnabled = true`, `hindsight.mentalModelAutoSeed = true`, `hindsight.mentalModelMaxRenderChars = 16_000`. The rendered `<mental_models>` block is frozen for the current transcript — a background reflect applies when the next transcript/session boundary reloads it, and `/memory mm reload` forces an explicit in-session refresh. First-turn loading waits up to `MENTAL_MODEL_FIRST_TURN_DEADLINE_MS = 1500`.
- Hindsight seed lifecycle is create-only. Changing `packages/coding-agent/src/hindsight/seeds.json` does not mutate existing server-side models.
- `recall.md` and `reflect.md` rely on the same backend selection and scoping behavior.
