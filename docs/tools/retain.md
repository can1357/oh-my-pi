# retain

> Store durable facts through the active long-term memory backend.

## Source

- Entry: `packages/coding-agent/src/tools/memory-retain.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/retain.md`
- Hindsight collaborators:
   - `packages/coding-agent/src/hindsight/state.ts` — per-session queue, flush scheduling, auto-retain.
   - `packages/coding-agent/src/hindsight/outbox.ts` — durable on-disk outbox for tool retains and its delivery.
   - `packages/coding-agent/src/hindsight/backend.ts` — session bootstrap, prompt injection, subagent aliasing.
   - `packages/coding-agent/src/hindsight/bank.ts` — bank id derivation, tag scoping, first-use bank/mission setup.
   - `packages/coding-agent/src/hindsight/client.ts` — HTTP `retain` / `retainBatch` calls.
   - `packages/coding-agent/src/hindsight/content.ts` — retention transcript shaping, memory-tag stripping.
   - `packages/coding-agent/src/hindsight/mental-models.ts` — bank-scoped mental-model seeding and cache rendering.
   - `packages/coding-agent/src/hindsight/seeds.json` — built-in mental-model seed definitions.
   - `packages/coding-agent/src/hindsight/transcript.ts` — extracts user/assistant turns for auto-retain.
- Mnemopi collaborators:
   - `packages/coding-agent/src/mnemopi/backend.ts` — local backend bootstrap, prompt injection, subagent aliasing, enqueue/clear.
   - `packages/coding-agent/src/mnemopi/state.ts` — scoped recall/retain state and local writes.
   - `packages/coding-agent/src/mnemopi/config.ts` — local SQLite path, bank, scoping, provider settings.
   - `packages/mnemopi/src/core/memory.ts` — local memory runtime used by `remember(...)`.

## Registration / Visibility

- Tool metadata: `strict = true`, `loadMode = "discoverable"`. Approval is dynamic: a call with any `scope: "global"` item has `approval = "write"`, because the write reaches every project's recall; otherwise `approval = "read"`, even though successful calls enqueue or perform memory writes.
- The tool is registered only for `memory.backend = "hindsight"` or `"mnemopi"`; it is absent for `"off"` and `"local"`. Hindsight additionally requires a non-empty configured API URL (`isHindsightConfigured(loadHindsightConfig(...))`).
- In unrestricted sessions with an explicit tool list, registration auto-includes the shared `recall`/`retain`/`reflect` set for either supported backend. Restricted lists are not widened.
- In an ordinary `tools.xdev` session, discoverable built-ins may be presented as `xd://retain`; an explicitly requested tool remains top-level.
- Execution returns one final result and has no progress callback or cancellation parameter.

## Inputs

| Field   | Type                                                                          | Required | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------- | ----------------------------------------------------------------------------- | -------: | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `items` | `Array<{ content: string; context?: string; scope?: "project" \| "global" }>` |      Yes | One or more memories to store. `minItems: 1`. Each item must be self-contained; `context` is optional per-item provenance. `scope` is in the schema and tool description only when the active backend has a destination every project recalls: `memory.backend = "mnemopi"` with `mnemopi.scoping` `global` or `per-project-tagged`, or `memory.backend = "hindsight"` with `hindsight.globalScope = true` (default `false`) and `hindsight.scoping` `global` or `per-project-tagged`; omitted means `project`. For Hindsight both settings are read from the session's Hindsight state, the config the retain queue enforces, so a subagent follows the config its parent had when the subagent started. |

## Outputs

The output depends on the active `memory.backend`.

Hindsight:

- `content[0].type = "text"`
- `content[0].text = "<count> memory queued."` or `"<count> memories queued."`
- `details = { count: number }`
- The items are on disk before the tool returns; server delivery is not confirmed. Delivery failures emit a session warning notice and are not returned to the model.

Mnemopi:

- `content[0].type = "text"`
- `content[0].text = "<count> memory stored."` or `"<count> memories stored."`
- `details = { count: number }`
- The tool writes each item synchronously through `rememberScoped(...)`. A storage failure throws, stops the batch, and reports the failed item, ids of earlier items kept, and whether later items were not attempted. A successful count confirms all synchronous writes, not completion of background extraction.

## Flow

1. `MemoryRetainTool.createIf(...)` exposes the tool when `memory.backend` is either `"hindsight"` or `"mnemopi"`.
2. `execute(...)` re-reads `memory.backend` and dispatches to the matching session state.
3. If the backend is `mnemopi`:
   - it fetches `session.getMnemopiSessionState()` and throws if the backend was not started;
   - if any item has `scope: "global"`, it resolves `state.getGlobalRetainTarget()` first; under `per-project` scoping that throws `Mnemopi global scope requires global or per-project-tagged scoping.` and nothing in the batch is stored;
   - for each item, it calls `state.rememberScoped(item.content, ...)` with `source: "coding-agent-retain"`, `importance: 0.75`, `scope: "bank"`, `extract: true`, `extractEntities: true`, `veracity: "tool"`, `memoryType: "fact"`, and metadata `{ session_id, cwd, context, tool: "retain" }`;
   - project items go to the scoped retain bank and global items to the global target (passed as `rememberScoped`'s third argument); exact duplicate content in the same session updates the existing working-memory row in the Mnemopi core.
   - content and options are passed through `redactRememberWrite(...)` before storage.
4. If the backend is `hindsight`:
   - it fetches `session.getHindsightSessionState()` and throws if the backend was not started;
   - if any item has `scope: "global"`, it calls `state.assertGlobalRetainAvailable()` first, which throws `Hindsight global scope is off; set hindsight.globalScope to true to enable it.` while `hindsight.globalScope` is off and `Hindsight global scope requires global or per-project-tagged scoping.` under `per-project` scoping; either way nothing in the batch is queued;
   - the whole call is handed to `HindsightSessionState.enqueueRetain(toolCallId, items)`; `HindsightRetainQueue.enqueue(...)` runs the same `global` check (the exported queue enforces it too, not only the tool), then `HindsightOutbox.enqueue(...)` writes one event file per item under `<agentDir>/hindsight-outbox/<destination>/`, all or none: each file is synced and atomically renamed into place, then the directory is synced (except on Windows). Event content, context, tags and session id are stripped of terminal controls, the bearer token, and recognizable secrets first;
   - each event id hashes the session id, tool call id, item index, scope, context and content. It becomes the server `document_id` with `update_mode: "replace"`, so a retried call or a resend after an ambiguous response replaces the same document, while a reused tool call id with different content is a new one;
   - the queue flushes immediately once 16 new events are pending, otherwise after a `RETAIN_FLUSH_INTERVAL_MS` debounce; primary-state installation also flushes, delivering events earlier processes left for the same API URL and bank;
   - a flush takes the destination's drain lease (an OS lock released when its process exits; a busy lease defers to the holder and retries after the debounce), best-effort ensures the bank exists, and sends async `retainBatch(...)` requests of up to 16 events per tag set in publication order: project items carry their captured tags, global items none. Each tag set gets its own request, because Hindsight tags a request's generated documents with the union of its items' tags and document-level re-tags cascade to every memory in it. A 2xx response deletes the events; it means server acceptance, not completed extraction.

## Modes / Variants

- Hindsight tool path: durable outbox, delivered in batches.
- Mnemopi tool path: direct local `remember(...)` into the scoped retain bank.
- Hindsight bank scoping from `computeBankScope(...)`:
   - `global` — one shared bank, no project tags.
   - `per-project` — bank id gets `-<project label>` appended, where the label is the git primary checkout root basename (cwd basename outside a repo).
   - `per-project-tagged` — shared bank plus `project:<project label>` tags on retained memories; with `hindsight.globalScope` on, `scope: "global"` items are retained untagged, which recall (`tagsMatch = "any"`) surfaces in every project.
- Mnemopi bank scoping from `computeMnemopiBankScope(...)`:
   - `global` — retain and recall use the shared bank; `scope: "global"` writes there too.
   - `per-project` — retain and recall use a project bank derived from the absolute cwd basename plus a hash of that absolute cwd; `scope: "global"` is not offered.
   - `per-project-tagged` — retain writes to the cwd-derived project bank, or to the shared bank for `scope: "global"` items; recall also reads the shared bank.
   - Per-project recall may add safe legacy banks whose stored working-memory rows all match the active cwd; scanning is capped at 64 candidate bank directories.
- Session scope:
   - tool-called retains are per-session work for the active backend;
   - persisted Hindsight memories are cross-session server-side bank data;
   - persisted Mnemopi memories are local SQLite data;
   - subagents alias parent memory state for both supported backends.

## Side Effects

- Filesystem
   - Hindsight: undelivered tool retains as JSON event files under `<agentDir>/hindsight-outbox/` (directories 0700, files 0600); refused, malformed and expired events move to `hindsight-outbox/quarantine/`, which deletes them 30 days later.
   - Mnemopi: writes to local SQLite under `mnemopi.dbPath`, defaulting beneath the agent memories directory (`mnemopi/mnemopi.db`) with one database file per scoped bank when needed.
- Network
   - Hindsight: `POST /v1/default/banks/{bank_id}/memories` via `retainBatch(...)`, plus optional `PUT /v1/default/banks/{bank_id}` via `ensureBankExists(...)` before the first write per bank per session state (the set is created with the primary session state and shared with subagent aliases).
   - Mnemopi: none unless configured embedding or LLM providers make calls during extraction.
- Session state
   - Hindsight: records each event's scope, captured tags, original timestamp, context and `metadata.session_id` before acknowledging; subagents share the parent's destination.
   - Mnemopi: writes through the session's scoped `Mnemopi` instance, includes `session_id`, `cwd`, and optional `context`, and shares scoped resources with subagents.
- User-visible prompts / interactive UI
   - Hindsight async flush failures emit `session.emitNotice("warning", ...)`; the model is not told.
   - Mnemopi explicit write failures are returned as tool errors with partial-batch information; earlier successful writes are not rolled back.
- Background work / cancellation
   - Hindsight flush runs on the debounce timer, the queue-size threshold, primary-state installation, agent end, and session disposal; backend `enqueue(...)` and `clear(...)` explicitly drain it. Undelivered events survive the session and process; nothing delivers while no omp process runs.
   - Mnemopi fact/entity extraction and embedding may continue after the synchronous row write. Backend `enqueue(...)` requests full consolidation; backend clear disposes scoped instances before deleting their database files.
   - `retain.execute()` itself has no abort-signal handling.

## Limits & Caps

- Input schema requires `items.length >= 1`; item strings have no schema-level minimum length.
- Tool availability requires `memory.backend` to be `"hindsight"` or `"mnemopi"`; default `memory.backend` is `"off"`.
- Hindsight queue flush threshold and request batch size: 16 events.
- Hindsight outbox capacity: 1000 undelivered events per destination; a call that would exceed it fails without writing anything or evicting older events.
- Hindsight outbox retention: undelivered events are quarantined 7 days after they were written; quarantined events are deleted 30 days after quarantine.
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

## Errors

- Throws `Mnemopi backend is not initialised for this session.` when `memory.backend == "mnemopi"` but no state exists.
- Throws `Hindsight backend is not initialised for this session.` when `memory.backend == "hindsight"` but no state exists.
- Hindsight queue enqueue on disposed state throws `Hindsight retain queue is closed.`
- Hindsight enqueue fails the tool call when the outbox is full or cannot be written (`Hindsight outbox full (...)` / `Hindsight outbox write failed; memory NOT queued.`); nothing from the call is kept.
- Hindsight HTTP 400, 413 and 422 refuse the request body: the refused event moves to quarantine with a warning notice; a refused multi-item request is resent item by item so only refused items move. Every other failure (connection errors, timeouts, 401/403/404, 408, 429, 5xx) keeps the events and stops the drain; the queue retries with exponential backoff from 5 seconds up to 30 minutes (±20% jitter) and warns once per outage with the count kept.
- Hindsight bank/mission creation failures are logged at debug level and swallowed in `ensureBankExists(...)`; the later write still runs.
- Mnemopi explicit `rememberScoped(...)` failures stop the batch and throw `Mnemopi did not store item <n> of <total>: <reason>. ...`, identifying earlier stored ids and unattempted items. Background auto-retain instead uses `rememberInScope(...)`, which logs and swallows storage failures.

## Notes

- Hindsight storage is server-side. `hindsightBackend.clear(...)` drains the local queue, clears local cache/state, and warns that upstream deletion must happen in Hindsight UI or `deleteBank`.
- Mnemopi storage is local SQLite. `mnemopiBackend.clear(...)` removes the database files for every active scoped bank and then rehydrates the backend when the session remains active.
- Hindsight auto-retain uses the same bank but a different path than this tool: `retainSession(...)` extracts plain user/assistant transcript, strips `<memories>` / `<mental_models>` blocks, and calls single-item `retain(...)`.
- Mnemopi auto-retain stores prepared transcripts with `source: "coding-agent-transcript"`, `importance: 0.65`, `veracity: "unknown"`, and `memoryType: "episode"`.
- Hindsight mental-model bootstrap lives in the shared backend: `HindsightSessionState.runMentalModelLoad(...)` optionally resolves seeds, creates missing models, then caches a rendered `<mental_models>` block for prompt injection.
- Built-in Hindsight seeds are `user-preferences`, `project-conventions`, and `project-decisions`. `projectTagged: true` seeds inherit the active scope's retain tags; untagged seeds read the whole bank.
- Hindsight mental-model defaults: `hindsight.mentalModelsEnabled = true`, `hindsight.mentalModelAutoSeed = true`, `hindsight.mentalModelMaxRenderChars = 16_000`. The rendered `<mental_models>` block is frozen for the current transcript — a background reflect applies when the next transcript/session boundary reloads it, and `/memory mm reload` forces an explicit in-session refresh. First-turn loading waits up to `MENTAL_MODEL_FIRST_TURN_DEADLINE_MS = 1500`.
- Hindsight seed lifecycle is create-only. Changing `packages/coding-agent/src/hindsight/seeds.json` does not mutate existing server-side models.
- `recall.md` and `reflect.md` rely on the same backend selection and scoping behavior.
