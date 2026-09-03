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

Breadcrumb content is original cwd and session file path, plus an optional third line `fresh`. A fresh breadcrumb preserves a `/new` boundary whose lazily-created JSONL file does not exist yet, preventing `continueRecent()` from reopening the previous session. Writes are synchronous, ordered, and best-effort.

## File Format

Session files are JSONL: one JSON object per line. Current files physically begin with a fixed-width, 256-byte `type: "title"` slot, followed by the session header and then `SessionEntry` values. Legacy files may begin directly with the header. Loaders strip the physical slot and fold its current title/source into the logical header.

- The logical first entry is always the session header (`type: "session"`).
- Remaining logical entries are `SessionEntry` values.
- Entries are append-only at runtime; branch navigation moves a pointer (`leafId`) rather than mutating existing entries.

### Header (`SessionHeader`)

```json
{
  "type": "session",
  "version": 3,
  "id": "1f9d2a6b9c0d1234",
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

`parentId` can be `null` for a root entry (first append, or after `resetLeaf()`).

## Entry Taxonomy

`SessionEntry` is the union of:

- `message`
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
    "provider": "anthropic",
    "model": "claude-sonnet-4-5",
    "content": [{ "type": "text", "text": "Done." }],
    "usage": {
      "input": 100,
      "output": 20,
      "cacheRead": 0,
      "cacheWrite": 0,
      "cost": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0,
        "total": 0
      }
    },
    "timestamp": 1760000000000
  }
}
```

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

`serviceTier` is a per-family map keyed by `openai`/`anthropic`/`google` (each value `auto`/`default`/`flex`/`scale`/`priority`), or `null` when no tier is active. Legacy entries that stored a single string (`"flex"`, `"openai-only"`, `"claude-only"`, …) are normalized to this map on read.

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

`configured` may additionally preserve the selector the user chose (`"auto"` or a concrete level). Readers of older entries fall back to `thinkingLevel`.

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

On resume, a valid latest `session_exit` after a non-terminal conversation tail causes the loader to append a synthetic assistant message with `stopReason: "aborted"` and rebuild the display/agent context. A normal exit only triggers that transition when it recorded pending tool calls; abnormal exit kinds can trigger it without that list. This prevents the restored transcript from presenting an interrupted turn as still live.

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

### `mode_change`

```json
{
  "type": "mode_change",
  "id": "e2f3a4b5",
  "parentId": "d2e3f4a5",
  "timestamp": "2026-02-16T10:30:00.000Z",
  "mode": "plan",
  "data": { "planFile": "/tmp/plan.md" }
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

- Missing file (`ENOENT`) -> returns `[]`.
- Current files at least 8 MiB use a streaming JSONL loader; smaller or non-file storage uses a full text read.
- Non-parseable lines are handled by the lenient JSONL parser.
- The optional fixed-width title slot is removed and folded into the header.
- If the first logical entry is not a valid session header (`type !== "session"` or missing string `id`) -> returns `[]`.

`SessionManager.setSessionFile()` behavior:

- `[]` from the loader is treated as empty/nonexistent session and replaced with a new initialized session at that exact path; its header is materialized immediately.
- Valid files are loaded, migrated if needed, blob refs resolved, then indexed.

## Tree and Leaf Semantics

The underlying model is append-only tree + mutable leaf pointer:

- Every append method creates exactly one new entry whose `parentId` is current `leafId`.
- The new entry becomes the new `leafId`.
- `branch(entryId)` moves only `leafId`; existing entries remain unchanged.
- `resetLeaf()` sets `leafId = null`; next append creates a new root entry (`parentId: null`).
- `branchWithSummary()` sets leaf to branch target and appends a `branch_summary` entry.

`getEntries()` returns all non-header entries in insertion order. Existing entries are not deleted in normal operation; rewrites preserve logical history while updating representation (migrations, move, targeted rewrite helpers).

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

Completed entries update memory and are handed to file/memory storage synchronously in the append call once the lazy file-creation gate has been crossed. There is no `fsync`, so the guarantee covers software crashes, not power loss. Streaming partial text is not persisted until the completed message is appended.

- A new ordinary session remains memory-only until it contains an assistant message or a caller invokes `ensureOnDisk()`.
- Before that gate, entries remain in memory; crossing it writes the full title slot, header, and accumulated entries.
- Afterwards, entries append incrementally.
- Saving an editor draft forces a discoverable header and stores `draft.txt` with a marker; if the draft disappears while only startup metadata remains, close removes that draft-only session. Explicit `ensureOnDisk()` sessions remain resumable.
- Concurrent completed appends supersede an in-flight atomic rewrite with an authoritative full-body rewrite so stale publication cannot clobber them.

### Durability operations

- `flush()` drains async disk/storage queues and the open writer (no `fsync`); `flushSync()` performs synchronous draining/full rewrite where supported.
- Atomic full rewrites use storage `writeTextAtomic` with a commit guard; file storage stages then renames over the target, including an EPERM-safe move-aside fallback.
- Rewrites serve renames, entry rewrites, migrations/sanitization, move/fork, and recovery. Session-title changes normally update the fixed-width title slot and append a `title_change` audit entry instead of rewriting the body.

### Error behavior

- Persistence errors are latched and rethrown by later flush/close/write operations; the first is logged once with session-file context.
- Failed atomic publication attempts authoritative repair. If storage may have published a write and repair cannot be proven durable, `SessionPersistenceIndeterminateError` fails closed with the original and recovery errors.
- Writer close propagates the first meaningful error.

## Data Size Controls and Blob Externalization

Before persisting entries:

- Strings over 500,000 characters are truncated with `"[Session persistence truncated large content]"`, except signed/encrypted provider blocks, signature fields, and complete Anthropic native web-search history blocks, which must remain byte-exact for replay.
- Transient `jsonlEvents` is removed.
- If an object has both string `content` and numeric `lineCount`, line count is recomputed after truncation.
- Image data URLs in `image_url` fields are always content-addressed in the blob store and replaced with `blob:sha256:<hash>`, regardless of length. Other base64 image payloads are externalized at 1,024 characters: image content/data payloads and image-generation results.
- Redundant OpenAI Responses `thinkingSignature` copies are omitted when the authoritative reasoning item already exists in `providerPayload`.

On load, persisted blob references are resolved back to the inline payload shapes expected by downstream transports.

## Storage Abstractions

`SessionStorage` owns filesystem-like operations used by `SessionManager`: synchronous directory/existence/write/stat/list operations; async read, sliced read, write, guarded atomic write, rename, unlink, artifact-aware deletion, title update, writer creation, and backend drain.

Implementations and adapters:

- `FileSessionStorage`: real local files
- `MemorySessionStorage`: map/chunk-backed in-memory storage for non-persistent sessions and tests
- `IndexedSessionStorage`: shared local index plus ordered remote publication used by Redis/SQL-backed storage

`SessionStorageWriter` exposes `append`, optional `appendSync`, `flush`, optional `flushSync`, `isOpen`, `close`, and `getError`.

## Session Discovery Utilities

Discovery helpers live in `session-listing.ts`; `SessionManager` exposes project-scoped wrappers:

- `getRecentSessions(sessionDir, limit?)` -> lightweight welcome metadata, default limit 4
- `findMostRecentSession(sessionDir)` -> newest by mtime
- `listSessions(sessionDir, storage)` / `SessionManager.list(...)` -> project scope with lifecycle status
- `listSessionsReadOnly(...)` -> same metadata without backup recovery
- `listAllSessions(storage)` / `SessionManager.listAll()` -> all project scopes
- `resolveResumableSession(...)` -> local lookup then optional global fallback

Recent/most-recent scans read only a 4 KiB prefix. Full lists read that prefix plus a bounded 32 KiB tail for lifecycle status. Scans are stat-keyed and cached; large sets are processed with bounded parallel workers. Normal per-directory scans also recover the newest orphaned EPERM backup when its primary JSONL is missing. Resume matching is case-insensitive and accepts session id prefixes, full filename prefixes, or the id suffix after the timestamp.

## Related but Distinct: Prompt History Storage

`HistoryStorage` (`history-storage.ts`) is a separate SQLite subsystem for prompt recall/search, not session replay.

- DB: `~/.omp/agent/history.db`
- Table: `history(id, prompt, created_at, cwd, session_id)`
- FTS5 index: `history_fts` with trigger-maintained sync
- Deduplicates consecutive identical prompts using in-memory last-prompt cache
- Inserts are batched through an async drain queue (~100 ms delay) so prompt capture does not block turn execution

Use session files for conversation graph/state replay; use `HistoryStorage` for prompt history UX.
