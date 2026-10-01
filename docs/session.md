# Session Storage and Entry Model

This document is the source of truth for how coding-agent sessions are represented, persisted, migrated, and reconstructed at runtime.

## Scope

Covers:

- Session JSONL format and versioning
- Entry taxonomy and tree semantics (`id`/`parentId` + leaf pointer)
- Migration/compatibility behavior when loading old or malformed files
- Context reconstruction (`buildSessionContext`)
- Persistence guarantees, failure behavior, truncation/blob externalization
- Storage abstractions (`FileSessionStorage`, `MemorySessionStorage`) and related utilities

Does not cover `/tree` UI rendering behavior beyond semantics that affect session data.

## Implementation Files

- [`src/session/session-manager.ts`](../packages/coding-agent/src/session/session-manager.ts) — orchestration: tree/leaf, appends, persistence, blobs, lifecycle factories
- [`src/session/session-entries.ts`](../packages/coding-agent/src/session/session-entries.ts) — entry/header types, `SessionEntry` union, `CURRENT_SESSION_VERSION`
- [`src/session/session-migrations.ts`](../packages/coding-agent/src/session/session-migrations.ts) — version migrations
- [`src/session/session-loader.ts`](../packages/coding-agent/src/session/session-loader.ts) — file load + blob-ref resolution
- [`src/session/session-context.ts`](../packages/coding-agent/src/session/session-context.ts) — `buildSessionContext`
- [`src/session/session-persistence.ts`](../packages/coding-agent/src/session/session-persistence.ts) — truncation + image blob externalization
- [`src/session/session-paths.ts`](../packages/coding-agent/src/session/session-paths.ts) — on-disk layout, dir encoding, terminal breadcrumbs
- [`src/session/session-listing.ts`](../packages/coding-agent/src/session/session-listing.ts) — discovery (list/recent/resolve)
- [`src/session/session-index.ts`](../packages/coding-agent/src/session/session-index.ts) — indexed titles and idle recap journal in `history.db`
- [`src/session/exit-diagnostics.ts`](../packages/coding-agent/src/session/exit-diagnostics.ts) — pending tools and interrupted-turn diagnostics
- [`src/session/session-storage.ts`](../packages/coding-agent/src/session/session-storage.ts) — storage abstractions
- [`src/session/session-title-slot.ts`](../packages/coding-agent/src/session/session-title-slot.ts) — fixed-width current-title slot
- [`src/session/indexed-session-storage.ts`](../packages/coding-agent/src/session/indexed-session-storage.ts) — local index + ordered remote-backed storage adapter
- [`src/session/messages.ts`](../packages/coding-agent/src/session/messages.ts) — custom-message transformers
- [`src/session/blob-store.ts`](../packages/coding-agent/src/session/blob-store.ts) — content-addressed blob store
- [`src/session/history-storage.ts`](../packages/coding-agent/src/session/history-storage.ts) — prompt history (separate subsystem)

## On-Disk Layout

Default file-session location:

```text
~/.omp/agent/sessions/<encoded-cwd>/<timestamp>_<sessionId>.jsonl
```

`<encoded-cwd>` is derived from the canonicalized cwd (so symlink aliases share a bucket): `-<relative>` for directories under home, `-tmp-<relative>` for directories under the temp root, and `--<encoded-absolute>--` for anything else, with path separators replaced by `-`.

On access, buckets written by the short-lived hashed scheme (`<scope>-<project-basename>-<sha256(canonical-cwd)>`, used in 17.2.5-17.2.8 and reverted in 17.2.9 by #7397) are migrated back into the path-encoded names best-effort, along with older `--<home-encoded>-*--` spellings of home-relative buckets.

Blob store location:

```text
~/.omp/agent/blobs/<sha256>
```

Terminal breadcrumb files are written under:

```text
~/.omp/agent/terminal-sessions/<terminal-id>
```

Breadcrumb content begins with cwd and session file path. Optional extra lines are `fresh` and `cwdstat <device> <inode>`. A fresh breadcrumb preserves an initially created, lazy session whose JSONL file does not exist yet, preventing `continueRecent()` from reopening the previous session. Explicit `newSession()` boundaries materialize their header before returning. The directory identity permits automatic re-rooting after a same-filesystem project rename; a missing cwd alone is not move evidence. Writes are synchronous, ordered, and best-effort.

## File Format

Session files are JSONL: one JSON object per line. Current files physically begin with a fixed-width, 256-byte `type: "title"` slot (including its newline), followed by the session header and then `SessionEntry` values. Legacy files may begin directly with the header. Loaders strip the physical slot and fold its current title/source into the logical header.

- The logical first entry is always the session header (`type: "session"`).
- Remaining logical entries are `SessionEntry` values.
- Ordinary appends extend the tree; branch navigation moves an in-memory pointer (`leafId`). Targeted rewrite/discard helpers can change existing records.

### Header (`SessionHeader`)

```json
{
  "type": "session",
  "version": 3,
  "id": "019c625b-b900-7000-8000-000000000001",
  "timestamp": "2026-02-16T10:20:30.000Z",
  "cwd": "/work/pi",
  "title": "optional session title",
  "titleSource": "auto",
  "additionalDirectories": ["/work/shared"],
  "previousSessionFiles": ["/old/location/session.jsonl"],
  "providerPromptCacheKey": "optional inherited cache identity",
  "parentSession": "optional lineage marker"
}
```

Notes:

- New session ids are UUIDv7 strings; readers also accept older string ids.
- `additionalDirectories` records normalized, deduplicated workspace roots beyond `cwd`.
- `previousSessionFiles` records prior absolute locations after successful moves.
- `providerPromptCacheKey` carries an inherited provider prompt-cache identity for eligible full forks.
- `parentSession` is an opaque lineage string. Current code writes either a session id or a session path depending on flow (`fork`, `forkFrom`, `createBranchedSession`, or explicit `newSession({ parentSession })`). Treat it as metadata, not a typed foreign key.

- `titleSource` is `auto` or `user`; automatic renames cannot overwrite a user title.

### Entry Base (`SessionEntryBase`)

All non-header entries include:

```json
{
  "type": "...",
  "id": "8-char-id",
  "parentId": "previous-or-branch-parent",
  "timestamp": "2026-02-16T10:20:30.000Z"
}
```

`parentId` can be `null` for a root entry (first append, or after `resetLeaf()`). Generated entry ids are normally eight hexadecimal characters, with a full Snowflake id as the collision-exhaustion fallback; consumers must not assume a fixed width.

## Entry Taxonomy

`SessionEntry` is the union of:

- `message`
- `model_usage`
- `thinking_level_change`
- `model_change`
- `service_tier_change`
- `compaction`
- `branch_summary`
- `reset_boundary`
- `custom`
- `custom_message`
- `label`
- `title_change`
- `ttsr_injection`
- `credential_pin`
- `session_init`
- `mode_change`

### `message`

Stores an `AgentMessage` directly.

```json
{
  "type": "message",
  "id": "a1b2c3d4",
  "parentId": null,
  "timestamp": "2026-02-16T10:21:00.000Z",
  "message": {
    "role": "assistant",
    "api": "anthropic-messages",
    "provider": "anthropic",
    "model": "claude-sonnet-4-5",
    "content": [{ "type": "text", "text": "Done." }],
    "usage": {
      "input": 100,
      "output": 20,
      "cacheRead": 0,
      "cacheWrite": 0,
      "totalTokens": 120,
      "cost": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0,
        "total": 0
      }
    },
    "stopReason": "stop",
    "timestamp": 1760000000000
  }
}
```

The persisted `message.role` discriminant is **camelCase**, not the snake_case used by
the LLM wire format or extension hook names. Ordinary conversation records use these
roles under `type: "message"`:

| Persisted `message.role` | Owner package | Notes                                                                             |
| ------------------------ | ------------- | --------------------------------------------------------------------------------- |
| `user`                   | pi-ai         | User/tool-feedback turn.                                                          |
| `developer`              | pi-ai         | Developer-role instruction turn.                                                  |
| `assistant`              | pi-ai         | Model turn; tool calls live in its `content` as `{ "type": "toolCall" }` blocks.  |
| `toolResult`             | pi-ai         | Result of one tool call — **not** `tool_result`. Carries `toolCallId`/`toolName`. |
| `bashExecution`          | pi-tui        | Standalone `!`-bash run.                                                          |
| `pythonExecution`        | pi-tui        | Standalone Python run.                                                            |
| `hookMessage`            | pi-tui        | Legacy hook-injected message, retained for migration; new code uses `custom`.     |
| `fileMention`            | pi-tui        | Inlined `@file` mention contents.                                                 |

Branch and compaction summary roles are synthesized from dedicated top-level entries
during session-context reconstruction. Extension messages sent through `pi.sendMessage`
likewise persist as `custom_message` entries and reconstruct as `custom`:

| Persisted entry type | Reconstructed role  |
| -------------------- | ------------------- |
| `branch_summary`     | `branchSummary`     |
| `compaction`         | `compactionSummary` |
| `custom_message`     | `custom`            |

Internal callers can append a `custom` message directly, so readers must discriminate on
`entry.type` rather than infer the persisted shape from the reconstructed role.

`toolCall` is a **content-block type inside an `assistant` message's `content` array**, not
a message role. An extension keying off `message.role` that matches snake_case constants
(`tool_result`, `tool_call`) or lowercases the role before comparing will silently skip
`toolResult` (and every other camelCase role) — no error is raised. Match the camelCase
values above verbatim. The base roles are `Message` in `packages/ai/src/types.ts`; the rest
are merged into `CustomAgentMessages` (`packages/agent/src/compaction/messages.ts`,
`packages/tui/src/chat/messages.ts`). Coding-agent re-exports the custom types and
converts them for provider context in `packages/coding-agent/src/session/messages.ts`.

### `model_usage`

Records model calls outside the conversation transcript. Fields are `purpose`,
optional model `role`, `api`, `provider`, `model`, `usage`, `stopReason`, and
optional `errorMessage`. These records contribute usage accounting, not model
messages or transcript turns. `appendModelUsage()` attaches the record to the
initiating session/branch and rejects stale session ownership.

### `model_change`

```json
{
  "type": "model_change",
  "id": "b1c2d3e4",
  "parentId": "a1b2c3d4",
  "timestamp": "2026-02-16T10:21:30.000Z",
  "model": "openai/gpt-4o",
  "role": "default"
}
```

`role` is optional; missing is treated as `default` in context reconstruction.
`resolvedModelIsFallback` optionally marks a retry-fallback transition. The
reserved role `fallback` is ephemeral: model restoration prefers the configured
default instead of restoring that role's temporary model.

### `service_tier_change`

```json
{
  "type": "service_tier_change",
  "id": "c1d2e3f4",
  "parentId": "b1c2d3e4",
  "timestamp": "2026-02-16T10:21:45.000Z",
  "serviceTier": { "openai": "priority", "google": "flex" }
}
```

`serviceTier` is a per-family map keyed by `openai`/`anthropic`/`google` (each value `auto`/`default`/`flex`/`scale`/`priority`/`ultrafast`), or `null` when no tier is active. Legacy entries that stored a single string (`"flex"`, `"openai-only"`, `"claude-only"`, …) are coerced to this map during context reconstruction; loading alone does not rewrite their payload.

### `thinking_level_change`

```json
{
  "type": "thinking_level_change",
  "id": "c1d2e3f4",
  "parentId": "b1c2d3e4",
  "timestamp": "2026-02-16T10:22:00.000Z",
  "thinkingLevel": "high"
}
```

`configured` may additionally preserve the selector the user chose (`"auto"` or a concrete level). Readers of older entries fall back to `thinkingLevel`. Both fields can be `null`; a null/missing resolved level reconstructs as `"off"`.

### `compaction`

```json
{
  "type": "compaction",
  "id": "d1e2f3a4",
  "parentId": "c1d2e3f4",
  "timestamp": "2026-02-16T10:23:00.000Z",
  "summary": "Conversation summary",
  "shortSummary": "Short recap",
  "firstKeptEntryId": "a1b2c3d4",
  "tokensBefore": 42000,
  "details": { "readFiles": ["src/a.ts"] },
  "preserveData": { "hookState": true },
  "fromExtension": false
}
```

Optional compaction metadata includes `tokensAfter`, `method`,
`providerReplayThroughEntryId`, and `warning`. `preserveData` can carry native
OpenAI/Anthropic replay state or a snapcompact archive; it is not just extension
state. `providerReplayThroughEntryId` marks the last entry represented by native
replacement history so later entries still replay normally.

### `branch_summary`

```json
{
  "type": "branch_summary",
  "id": "e1f2a3b4",
  "parentId": "a1b2c3d4",
  "timestamp": "2026-02-16T10:24:00.000Z",
  "fromId": "a1b2c3d4",
  "summary": "Summary of abandoned path",
  "details": { "note": "optional" },
  "fromExtension": true
}
```

If branching from root (`branchFromId === null`), `fromId` is the literal string `"root"`.

### `reset_boundary`

A payload-free marker appended by `/clear`. The collapsed live transcript and rebuilt model context begin after the latest applicable boundary; full-history transcript export still retains entries before it.

### `custom`

Opaque, non-LLM records owned by core subsystems or extensions. `buildSessionContext` does not directly turn them into model messages, but subsystem-specific replay code can consume `customType` values to restore runtime state or diagnose an interrupted turn.

```json
{
  "type": "custom",
  "id": "f1a2b3c4",
  "parentId": "e1f2a3b4",
  "timestamp": "2026-02-16T10:25:00.000Z",
  "customType": "com.example.my-extension.state",
  "data": { "state": 1 }
}
```

Current core-owned values include:

| `customType`             | `data` schema                                                                                                                                                                                                                                            | Writer and consumer                                                                                                                                                                                                                                                                                        |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tool_execution_start`   | `{ toolCallId: string, toolName: string, startedAt: string, args?: { command?: string, path?: string }, intent?: string }`                                                                                                                               | `AgentSession` writes a marker immediately before a tool implementation starts. Exit diagnostics combine it with assistant tool calls and tool results to reconstruct calls left pending. Argument summaries are truncated projections; older full argument objects are accepted on read.                  |
| `session_exit`           | `{ reason: string, kind: "normal" \| "signal" \| "fatal" \| "process_exit", recordedAt: string, pendingToolCalls?: Array<{ toolCallId?: string, toolName: string, args?: unknown, intent?: string, assistantTimestamp?: number, startedAt?: string }> }` | Normal disposal and postmortem teardown record the exit when the session has assistant history or pending tool calls. The writer immediately calls `flushSync()` so a subsequent process can inspect the last durable turn; a flush failure is logged. Resume diagnostics consume the latest valid record. |
| `user_todo_edit`         | `{ phases: TodoPhase[] }`                                                                                                                                                                                                                                | SDK/UI todo editing persists the complete phase snapshot. Todo restoration scans backward for the latest snapshot (or a successful `todo` tool result) and restores its phases.                                                                                                                            |
| `vibe-session-lifecycle` | Version-1 event with `{ version: 1, id, ownerId, parentSessionId, action, ... }`; `spawn` adds `cli`, `agent`, `childSessionFile`, and `createdAt`; turn events add `turn`; tombstone events add `reason`.                                               | Vibe runtime persists and replays child spawn, turn-started/settled, tombstone, and tombstone-revoked transitions to recover owned child sessions and in-flight state. Invalid or out-of-scope events are ignored.                                                                                         |
| `autoresearch-control`   | `{ mode: "on" \| "off" \| "clear", goal?: string }`                                                                                                                                                                                                      | The built-in autoresearch command writes mode/goal changes, and experiment-limit shutdown writes `mode: "off"`. `reconstructControlState()` replays valid records on resume to restore whether autoresearch is active and its goal; `clear` removes the goal.                                              |

On resume, a valid latest `session_exit` after a non-terminal conversation tail causes `AgentSession`/SDK initialization to append a synthetic assistant message with `stopReason: "aborted"` and rebuild the display/agent context. A normal exit only triggers that transition when it recorded pending tool calls; abnormal exit kinds can trigger it without that list. This prevents the restored transcript from presenting an interrupted turn as still live.

The strings in the table are reserved for their core consumers. Extensions MUST NOT use them. Use a namespaced identifier such as a reverse-domain or package-qualified name for extension records; a collision can cause core replay logic to interpret extension data as lifecycle state. Unknown namespaced values remain opaque to core session-context reconstruction.

### `custom_message`

Extension-provided message that does participate in LLM context. `content` can be a string or text/image content blocks, and `attribution` records whether the user or agent initiated it.

```json
{
  "type": "custom_message",
  "id": "a2b3c4d5",
  "parentId": "f1a2b3c4",
  "timestamp": "2026-02-16T10:26:00.000Z",
  "customType": "my-extension",
  "content": "Injected context",
  "display": true,
  "details": { "debug": false },
  "attribution": "agent"
}
```

### `label`

```json
{
  "type": "label",
  "id": "b2c3d4e5",
  "parentId": "a2b3c4d5",
  "timestamp": "2026-02-16T10:27:00.000Z",
  "targetId": "a1b2c3d4",
  "label": "checkpoint"
}
```

`label: undefined` clears a label for `targetId`.

### `title_change`

Append-only audit entry for a session rename. It records `title`, `source` (`auto` or `user`), and optionally `previousTitle` and `trigger`. The current title is also updated in the fixed-width title slot so listing does not require a full-file rewrite.

`/rename <title>` sets an explicit title. `/rename` without a title generates one from recent conversation using the title-generation candidates (`tiny`, `commit`, `smol`, then eligible current-model fallbacks). Both are user-requested renames (`source: "user"`), so later automatic titling cannot replace them. Empty conversation or failed generation leaves the current title unchanged. A session switch or newer rename while generation runs discards the stale result. Local tiny-model failures never fall back to an online provider.

### `ttsr_injection`

```json
{
  "type": "ttsr_injection",
  "id": "c2d3e4f5",
  "parentId": "b2c3d4e5",
  "timestamp": "2026-02-16T10:28:00.000Z",
  "injectedRules": ["ruleA", "ruleB"]
}
```

### `credential_pin`

Records the provider and a pseudonymous SHA-256 account/scope hash used to re-pin resumed OAuth traffic to the serving account and preserve account-scoped prompt-cache reuse. It does not store the raw account identity; exported hashes remain linkable and are not anonymous.

### `session_init`

```json
{
  "type": "session_init",
  "id": "d2e3f4a5",
  "parentId": "c2d3e4f5",
  "timestamp": "2026-02-16T10:29:00.000Z",
  "systemPrompt": "...",
  "task": "...",
  "tools": ["read", "edit"],
  "outputSchema": { "type": "object" },
  "outputSchemaMode": "strict",
  "restrictToolNames": true,
  "spawns": "*",
  "readSummarize": false
}
```

The latest `session_init` is also the cold-subagent revival contract. Optional
fields include `agent`, `modelRole`, `resolvedModel`, `retryFallback`, `readOnly`,
`advisor`, and `compactionThreshold` (`thresholdPercent`/`thresholdTokens`).
`isolated: true` marks an isolation-worktree child that cannot be cold-revived.
`extractSessionInit()` and read-only `peekSessionInit()` expose this contract.

### `mode_change`

```json
{
  "type": "mode_change",
  "id": "e2f3a4b5",
  "parentId": "d2e3f4a5",
  "timestamp": "2026-02-16T10:30:00.000Z",
  "mode": "plan",
  "data": { "planFilePath": "local://PLAN.md" }
}
```

## Versioning and Migration

Current session version: `3`.

### v1 -> v2

Applied when header `version` is missing or `< 2`:

- Adds `id` and `parentId` to each non-header entry.
- Reconstructs a linear parent chain using file order.
- Migrates compaction field `firstKeptEntryIndex` -> `firstKeptEntryId` when present.
- Sets header `version = 2`.

### v2 -> v3

Applied when header `version < 3`:

- For `message` entries: rewrites legacy `message.role === "hookMessage"` to `"custom"`.
- Sets header `version = 3`.

### Migration Trigger and Persistence

- Migrations run during session load (`setSessionFile`).
- If any migration ran, the in-memory representation is marked for a full rewrite rather than rewritten immediately.
- The next persistence operation performs the full rewrite before incremental appends continue.

## Load and Compatibility Behavior

`loadEntriesFromFile(path)` behavior:

- Missing file (`ENOENT`) -> returns `[]`, unless `throwIfMissing: true` requests an error.
- Current files at least 8 MiB use a streaming JSONL loader; smaller or non-file storage uses a full text read.
- Malformed records are skipped and counted by the lenient JSONL parser.
- The optional fixed-width title slot is removed and folded into the header.
- If the first logical entry is not a valid session header (`type !== "session"` or missing string `id`) -> returns `[]`.

`SessionManager.setSessionFile()` behavior:

- Missing or genuinely empty files initialize a new session at that exact path and materialize its header immediately. `SessionManager.open(..., { throwIfMissing: true })` instead rejects missing/empty input.
- Non-empty data without a valid leading session header is rejected without modifying the file. An array-only `loadEntriesFromFile()` result of `[]` therefore does not distinguish empty from corrupt input; the manager uses `loadSessionFile()` diagnostics.
- Valid files are loaded, migrated if needed, blob refs resolved, then indexed. Migrations, skipped malformed records, and loaded OpenAI replay sanitization mark the next persistence operation for a full rewrite.
- A recorded cwd is adopted only when it is enterable. Otherwise runtime cwd stays at the launch/current directory while the transcript remains in its original location; workspace-root edits stay runtime-only until relocation.

## Tree and Leaf Semantics

The underlying model is append-only tree + mutable leaf pointer:

- Ordinary append methods create one new entry whose `parentId` is current `leafId`, then advance the leaf.
- `appendMessageToBranch()` appends to an explicit parent without moving the active leaf. `appendModelUsage()` likewise retains a successor branch's leaf when the initiating parent is no longer active.
- `branch(entryId)` moves only `leafId`; existing entries remain unchanged.
- `resetLeaf()` sets `leafId = null`; next append creates a new root entry (`parentId: null`).
- `branchWithSummary()` sets leaf to branch target and appends a `branch_summary` entry.

`getEntries()` returns all non-header entries in insertion order. There is no separate persisted leaf field: loading rebuilds the leaf from the last physical entry. Pointer-only `branch()`/`resetLeaf()` changes therefore need a subsequent append to survive reload. `discardEntryDurably()` appends a metadata branch marker and rewrites the journal to make a discarded path durable.

`createBranchedSession(leafId)` creates a new identity containing only the selected root-to-leaf path. It drops old label records and recreates the resolved labels for retained entries. Unlike a full fork, it does not inherit the provider prompt-cache key.

## Context Reconstruction (`buildSessionContext`)

`buildSessionContext(entries, leafId?, byId?, options?)` resolves what is sent to the model. `options.transcript: true` instead builds a display transcript. Full transcript mode preserves compactions inline; `collapseCompactedHistory` renders only the current compacted tail, and `keepDanglingToolCalls` preserves still-running tool calls during a mid-turn UI rebuild.

Algorithm:

1. Determine leaf:
   - `leafId === null` -> return empty context.
   - explicit `leafId` -> use that entry if found.
   - otherwise fallback to last entry.
2. Walk `parentId` to root, stopping on a repeated id to bound corrupt cycles, then reverse to root->leaf.
3. Derive runtime state across the path:
   - resolved and configured thinking selectors from latest `thinking_level_change`
   - service tier from latest `service_tier_change`
   - model map from `model_change` entries (`role ?? "default"`); assistant-message inference is legacy fallback only until an explicit default is seen
   - deduplicated `injectedTtsrRules`
   - mode/modeData from latest `mode_change` (default mode `"none"`)
4. Choose the emission boundary:
   - a later `reset_boundary` hides everything through that boundary from model context and collapsed live transcript
   - otherwise the latest compaction emits its summary plus kept/post-compaction messages (provider-native replacement history may supply the kept model context)
   - full transcript export retains pre-reset history and renders compactions chronologically
5. Convert `message`, `custom_message`, and `branch_summary` entries into messages. Other entry types only affect replay state or metadata.
6. Remove dangling tool calls from replay (unless explicitly retained for a mid-turn transcript), neutralizing protected reasoning metadata on rewritten turns; drop unsafe aborted/error assistant turns and their paired tool results from model context.

## Persistence Guarantees and Failure Model

### Persist vs in-memory

- `SessionManager.create/open/continueRecent/forkFrom` -> persistent mode (`persist = true`).
- `SessionManager.inMemory` -> non-persistent mode (`persist = false`) with `MemorySessionStorage`.

### Write pipeline

Ordinary completed appends update memory and local file storage synchronously once the lazy file-creation gate has been crossed. There is no `fsync`, so successful local writes protect against software crashes, not power loss. Indexed Redis/SQL backends update their local view immediately but publish remotely in an ordered async queue; `flush()`/backend drain is required to confirm those writes. Title changes and atomic batches have their own awaited persistence paths. Streaming partial text is not persisted until the completed message is appended.

- A new ordinary session remains memory-only until it contains an assistant message or a caller invokes `ensureOnDisk()`.
- Before that gate, entries remain in memory; crossing it writes the full title slot, header, and accumulated entries.
- Explicit `newSession()` (including `/new`) calls `ensureOnDisk()` before returning, preserving an empty session boundary across terminals.
- Afterwards, entries append incrementally.
- Saving an editor draft forces a discoverable header and stores `draft.txt` with a marker; if the draft disappears while only startup metadata remains, close removes that draft-only session. Explicit `ensureOnDisk()` sessions remain resumable.
- Concurrent completed appends supersede an in-flight atomic rewrite with an authoritative full-body rewrite so stale publication cannot clobber them.

### Durability operations

- `flush()` drains async disk/storage queues and the open writer (no `fsync`); `flushSync()` drains synchronously supported work or rewrites a non-current file. It cannot confirm queued remote publication; those backends still require awaited `flush()`/drain.
- Atomic full rewrites use storage `writeTextAtomic` with a commit guard and expected byte-size precondition; file storage stages then renames over the target, including an EPERM-safe move-aside fallback.
- Local appends and publication share a cross-process publish lock. A changed byte size raises `SessionWriteConflictError`; lock contention raises `SessionLockError` without publishing the staged rewrite. This is not a content-hash comparison and cannot protect against non-cooperating external writers.
- `FileSessionStorage` holds a process-owned OS lease on each session file a process writes (`pi-utils` `tryAcquireFileLock` with the name `.<session>.jsonl.owner`: a `flock` on the sidecar `.<session>.jsonl.owner.lock` on macOS and other non-Linux Unix; on Linux an abstract socket and on Windows a named mutex, neither of which creates a file). Only write paths claim it, so the first process to write a file owns it; opening a session to inspect it (`omp share`, `--export`, `render`) never does. Managers in one process share the lease; it is released on close or a session switch, and the kernel drops it when its process exits.
- A process never writes to a file whose lease another live process holds: its first write moves the session to a fresh sibling `<timestamp>_<new-session-id>.jsonl` in the same directory, publishes the whole in-memory transcript there once, and continues appending incrementally. The owner's file is left untouched. Like `fork`, the sibling gets a new session id with `parentSession` pointing at the old one and keeps the provider prompt-cache key, so resume-by-id, the title index, and the picker never see two files for one id. The artifacts directory is copied in the background without overwriting files the moved session has already written; its artifact manager waits for the copy before allocating ids or resolving `artifact://`, and `flush()`/`close()` await it. `local://` and `agent://` reads that bypass the artifact manager can miss pre-move files until the copy finishes.
- On the file and memory backends, a `SessionWriteConflictError` on durable bytes during a full rewrite means a writer without the lease (an older omp, an external tool) changed the file. The manager reads it back, keeps the entries it lacks as a side branch (the active leaf stays its own), and retries against the size it read, up to three times per rewrite. If that writer changes the file inside every retry, the session leaves the file to it and moves to a sibling (`reason: "contested"`) rather than re-serializing the transcript on every later write. A deleted file is recreated; a file that no longer reads as this session is left untouched and the session moves to a sibling. Indexed backends keep reporting the conflict, since there it can be the manager racing its own unconfirmed publish.
- `appendEntriesAtomically()` groups a synchronous callback's appends into one atomic publication. Failure rolls back staged entries and repairs retained concurrent work.
- Rewrites serve renames, entry rewrites, migrations/sanitization, move/fork, and recovery. Session-title changes normally update the fixed-width title slot and append a `title_change` audit entry instead of rewriting the body.

### Error behavior

- Ordinary append failures are latched and logged once with session-file context rather than thrown into the turn loop. Later appends may retry the complete in-memory journal; `flush()`/`flushSync()` and close surface unresolved failures.
- `onPersistenceNotice` reports a session moving to a sibling file as a `SessionPersistenceNotice` (`reason`, `from`, `to`); it latches nothing and never reaches `onPersistenceError`. Every notice raised so far is replayed to each new subscriber, like a latched failure. Interactive mode shows it as a warning, print mode on stderr, RPC as a `warning` notice frame, each with home-relative paths.
- Atomic batch and recovery paths attempt authoritative repair. If publication may have happened and repair cannot be proven durable, `SessionPersistenceIndeterminateError` fails closed with the original and recovery errors.
- Writer close propagates the first meaningful error. Final disposal seals the manager, making late appends/rewrites no-ops, then releases retained entries so a disposed manager cannot overwrite a revived transcript.

## Data Size Controls and Blob Externalization

Before persisting entries:

- Strings over 500,000 characters are truncated with `"[Session persistence truncated large content]"`, except signed/encrypted provider blocks, signature fields, validated Anthropic native web/tool-search history blocks, and Anthropic server-compaction replay carriers, which must remain byte-exact for replay.
- Transient `jsonlEvents` is removed.
- If an object has both string `content` and numeric `lineCount`, line count is recomputed after truncation.
- Image data URLs in `image_url` fields are always content-addressed in the blob store and replaced with `blob:sha256:<hash>`, regardless of length. Base64 payloads at least 1,024 characters are externalized in image `content` blocks, `images[]`, snapcompact `frames[]`, and image-generation results.
- Redundant OpenAI Responses `thinkingSignature` copies are omitted when the authoritative reasoning item already exists in `providerPayload`.
- Spilled MCP tool results omit duplicate `details.structuredContent` when the rendered structured output already lives in their truncation artifact.

These projections leave the live entries unchanged. On load, ordinary persisted image references are resolved back to inline payloads. Snapcompact frames stay lazy until context reconstruction selects them. Archives with frames truncated by older persistence code fall back to their retained text or undamaged frames.

## Storage Abstractions

`SessionStorage` owns filesystem-like operations used by `SessionManager`: synchronous directory/existence/write/stat/list operations; async read, sliced read, write, guarded atomic write, rename, unlink, artifact-aware deletion, title update, writer creation, and backend drain. Optional capabilities include synchronous reads, confirmed remote writes, assistant-turn scans, file locking, session ownership claims, and conditional artifact-aware deletion.

Implementations and adapters:

- `FileSessionStorage`: real local files
- `MemorySessionStorage`: map/chunk-backed in-memory storage for non-persistent sessions and tests
- `IndexedSessionStorage`: shared local index plus ordered remote publication used by Redis/SQL-backed storage

`SessionStorageWriter` exposes `append`, optional `appendSync`, `flush`, optional `flushSync`, `isOpen`, `close`, and `getError`.

### Manual storage maintenance

`omp gc` previews maintenance by default; `--apply` is required to sweep unreferenced blobs, archive eligible cold sessions, checkpoint database WALs, or prune stale state. Storage maintenance is separate from model-context compaction.

The stale-state phase is opt-in: it runs only with `--stale` or when `gc.stale` is enabled (default off), so an unqualified `omp gc --apply` never deletes reports or replicas. It removes `custom-session-files` markers and terminal breadcrumbs whose session file no longer exists once they are a day old (a lazy session's marker names a transcript that is written only on its first turn). A breadcrumb recorded as a fresh `/new` boundary is always kept: `--continue` honors it before its transcript exists, and it is rewritten when the session materializes or replaced by the terminal's next session. For the default agent dir — or a custom agent dir named `agent`, whose parent is treated as the config root — it also expires debug report bundles (`reports/*.tar.gz`) and collab guest replicas (`collab/*.jsonl` plus their artifact directories and custom-session marker) that are both outside the newest `gc.staleRetainNewest` (default 20) and older than `gc.staleRetainDays` (default 30). A replica that a terminal breadcrumb points at, or that a running guest holds open, is kept. Stale state is pruned before the blob sweep, so blobs referenced only by an expired replica are swept in the same run.

Journal payload I/O is streamed during blob-reference scans, archive history/stats reconciliation, gzip creation, and rollback. Active `.jsonl`, recoverable `.jsonl.*.bak`, and archived `.jsonl.gz` records all participate in reference discovery, including references in malformed JSON text. Compressed scans drain and validate the complete stream before their results can authorize deletion. Archives retain the original JSONL bytes when decompressed, and artifact trees keep their existing layout.

Streaming avoids materializing a whole journal; it does not make GC constant-memory. A single long record, reference sets, and history/stats identity collections still consume memory. Original files and temporary compressed output also coexist during archive publication.

## Session Discovery Utilities

Discovery helpers live in `session-listing.ts`; `SessionManager` exposes project-scoped wrappers:

- `getRecentSessions(sessionDir, limit?)` -> lightweight welcome metadata, default limit 4
- `findMostRecentSession(sessionDir)` -> newest by mtime
- `findMostRecentNonEmptySession(sessionDir)` -> newest resumable content, used by `continueRecent`
- `listSessions(sessionDir, storage)` / `SessionManager.list(...)` -> project scope with lifecycle status
- `listSessionsReadOnly(...)` -> same metadata without backup recovery
- `listAllSessions(storage)` / `SessionManager.listAll()` -> project buckets under the managed sessions root, not arbitrary custom directories
- `SessionManager.listForPicker(...)` / `listAllForPicker()` -> pinned-first lists with untitled, prompt-less zero-turn stubs removed; pinned stubs remain selectable
- `resolveResumableSession(...)` -> local lookup then optional global fallback

`getRecentSessions()` sorts file stats and first looks up titles in `history.db`'s `session_titles` index; unindexed files fall back to content scanning and backfill their title. `findMostRecentSession()` reads a 4 KiB prefix. Status-enabled full/non-empty scans read that prefix plus a bounded 32 KiB tail. Scans are stat-keyed and cached; large full lists use bounded parallel workers. Normal per-directory scans also recover the newest orphaned EPERM backup when its primary JSONL is missing.

`SessionManager.list()`/`listAll()` sort pinned sessions first; raw listing helpers sort newest first. Empty filtering is picker/continue-specific, not applied to id lookup or maintenance. Resume matching is case-insensitive and accepts session id prefixes, full filename prefixes, or the id suffix after the timestamp. Explicit `sessionDir` disables global fallback unless `allowGlobalFallback: true` is requested.

## Related but Distinct: Prompt History Storage

`HistoryStorage` (`history-storage.ts`) is a separate SQLite subsystem for prompt recall/search, not session replay.

- DB: `~/.omp/agent/history.db`
- Table: `history(id, prompt, created_at, cwd, session_id, use_count)`, with unique `prompt`
- FTS5 index: `history_fts`; new prompts are indexed by an insert trigger
- Normalizes line endings and surrounding/trailing whitespace, then deduplicates prompts across the database
- Resubmission updates the latest timestamp/cwd/session provenance and increments `use_count`
- `add()` writes synchronously before returning its resolved promise; failures are logged rather than thrown
- The same DB also contains independent `session_titles` and append-only `session_recaps` tables. Idle recaps do not enter the session JSONL or model context.

Use session files for conversation graph/state replay; use `HistoryStorage` for prompt history UX.
