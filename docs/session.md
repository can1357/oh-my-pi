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
- [`src/session/messages.ts`](../packages/coding-agent/src/session/messages.ts) — custom-message transformers
- [`src/session/blob-store.ts`](../packages/coding-agent/src/session/blob-store.ts) — content-addressed blob store
- [`src/session/history-storage.ts`](../packages/coding-agent/src/session/history-storage.ts) — prompt history (separate subsystem)

## On-Disk Layout

Default session file location:

```text
~/.ompk/agent/sessions/<dir-encoded>/<timestamp>_<sessionId>.jsonl
```

`<dir-encoded>` depends on where the canonicalized cwd lives:

- inside the home directory: `-<relative-path>` with `/`, `\\`, and `:` replaced by `-` (bare `-` for home itself)
- inside the OS temp root: `-tmp-<relative-path>` with the same replacement
- anywhere else: legacy absolute form `--<cwd-without-leading-slash-with-same-replacement>--`

Old `--<home-encoded>-*--` directories are migrated to the new home-relative names once per sessions root on first access (best-effort).

Blob store location:

```text
~/.ompk/agent/blobs/<sha256>
```

Terminal breadcrumb files are written under:

```text
~/.ompk/agent/terminal-sessions/<terminal-id>
```

Breadcrumb content is two lines: original cwd, then session file path. `continueRecent()` prefers this terminal-scoped pointer before scanning most-recent mtime.

## File Format

Session files are JSONL: one JSON object per line.

- Line 1 is always the session header (`type: "session"`).
- Remaining lines are `SessionEntry` values.
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
  "parentSession": "optional lineage marker"
}
```

Notes:

- `version` is optional in v1 files; absence means v1.
- `parentSession` is an opaque lineage string. Current code writes either a session id or a session path depending on flow (`fork`, `forkFrom`, `createBranchedSession`, or explicit `newSession({ parentSession })`). Treat as metadata, not a typed foreign key.

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
- `custom`
- `custom_message`
- `label`
- `ttsr_injection`
- `session_init`
- `mode_change`
- `mcp_tool_selection`

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
  "serviceTier": "flex"
}
```

`serviceTier` can also be `null`.

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

### `custom`

Extension state persistence; ignored by `buildSessionContext`.

```json
{
  "type": "custom",
  "id": "f1a2b3c4",
  "parentId": "e1f2a3b4",
  "timestamp": "2026-02-16T10:25:00.000Z",
  "customType": "my-extension",
  "data": { "state": 1 }
}
```

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

### `mcp_tool_selection`

```json
{
  "type": "mcp_tool_selection",
  "id": "d2e3f4a5",
  "parentId": "c2d3e4f5",
  "timestamp": "2026-02-16T10:28:30.000Z",
  "selectedToolNames": ["server.tool"]
}
```

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
- If any migration ran, the session is flagged for a full rewrite (`#rewriteRequired`) rather than rewritten immediately.
- Migration mutates in-memory entries first; the flagged rewrite persists the updated JSONL on the next write (a synchronous full rewrite on the next append).

## Load and Compatibility Behavior

`loadEntriesFromFile(path)` behavior:

- Missing file (`ENOENT`) -> returns `[]`.
- Non-parseable lines are handled by lenient JSONL parser (`parseJsonlLenient`).
- If first parsed entry is not a valid session header (`type !== "session"` or missing string `id`) -> returns `[]`.

`SessionManager.setSessionFile()` behavior:

- `[]` from loader is treated as empty/nonexistent session and replaced with a new initialized session file at that path.
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

`buildSessionContext(entries, leafId?, byId?, options?)` resolves what is sent to the model. Passing `options.transcript: true` instead builds the full-history display transcript (compactions emitted inline at the position they fired) — display-only, never sent to a provider.

Algorithm:

1. Determine leaf:
   - `leafId === null` -> return empty context.
   - explicit `leafId` -> use that entry if found.
   - otherwise fallback to last entry.
2. Walk `parentId` chain from leaf to root and reverse to root->leaf path.
3. Derive runtime state across path:
   - `thinkingLevel` from latest `thinking_level_change` (default `"off"`)
   - `serviceTier` from latest `service_tier_change`
   - model map from `model_change` entries (`role ?? "default"`)
   - fallback `models.default` from assistant message provider/model if no explicit model change
   - deduplicated `injectedTtsrRules` from all `ttsr_injection` entries
   - selected MCP discovery tools from latest `mcp_tool_selection`
   - mode/modeData from latest `mode_change` (default mode `"none"`)
4. Build message list:
   - `message` entries pass through
   - `custom_message` entries become `custom` AgentMessages via `createCustomMessage`
   - `branch_summary` entries become `branchSummary` AgentMessages via `createBranchSummaryMessage`
   - if a `compaction` exists on path:
     - emit compaction summary first (`createCompactionSummaryMessage`)
     - emit path entries starting at `firstKeptEntryId` up to the compaction boundary
     - emit entries after the compaction boundary

`custom`, `session_init`, `service_tier_change`, `mcp_tool_selection`, and `ttsr_injection` entries do not inject model context directly.

## Persistence Guarantees and Failure Model

### Persist vs in-memory

- `SessionManager.create/open/continueRecent/forkFrom` -> persistent mode (`persist = true`).
- `SessionManager.inMemory` -> non-persistent mode (`persist = false`) with `MemorySessionStorage`.

### Write pipeline

Appends are written synchronously in-body through a `SessionStorageWriter` (from `storage.openWriter`), so an entry is durable the instant the append returns. Async disk work (flush, close, atomic rewrite) is serialized through an internal promise chain (`#diskTail`); appends bypass it.

- `append*` updates in-memory state immediately.
- Persistence is deferred until at least one assistant message exists.
  - Before first assistant: entries are retained in memory; no file append occurs.
  - When first assistant exists: full in-memory session is flushed to file.
  - Afterwards: new entries append incrementally.

Rationale in code: avoid persisting sessions that never produced an assistant response.

### Durability operations

- `flush()` drains the async disk chain and the open writer's queued appends (no `fsync`); `flushSync()` performs a synchronous full rewrite for exit paths that cannot await.
- Atomic full rewrites (`#rewriteAtomically`) delegate to `storage.writeTextAtomic`: temp-write then rename over the target (with an EPERM-safe move-aside fallback).
- Used for `setSessionName`, `rewriteEntries` (tool-output pruning/supersede passes), and move/fork operations. Load-time migrations and other in-memory divergence (`#rewriteRequired`) instead trigger a synchronous full rewrite (`#rewriteSynchronously`) on the next persist.

### Error behavior

- Persistence errors are latched (`#diskFailure`) and rethrown on subsequent operations.
- First error is logged once with session file context.
- Writer close is best-effort but propagates the first meaningful error.

## Data Size Controls and Blob Externalization

Before persisting entries:

- Large strings are truncated to `MAX_PERSIST_CHARS` (500,000 chars) with notice:
  - `"[Session persistence truncated large content]"`
- Transient fields `partialJson` and `jsonlEvents` are removed.
- If object has both `content` and `lineCount`, line count is recomputed after truncation.
- Image blocks in `content` arrays with base64 length >= 1024 are externalized to blob refs:
  - stored as `blob:sha256:<hash>`
  - raw bytes written to blob store (`BlobStore.put`)

On load, blob refs are resolved back to base64 for message/custom_message image blocks.

## Storage Abstractions

`SessionStorage` interface provides all filesystem operations used by `SessionManager`:

- sync: `ensureDirSync`, `existsSync`, `writeTextSync`, `statSync`, `listFilesSync`
- async: `exists`, `readText`, `readTextSlices`, `writeText`, `writeTextAtomic`, `rename`, `unlink`, `deleteSessionWithArtifacts`, `openWriter`

Implementations:

- `FileSessionStorage`: real filesystem (Bun + node fs)
- `MemorySessionStorage`: map-backed in-memory implementation for tests/non-persistent sessions

`SessionStorageWriter` exposes `append`, `flush`, `isOpen`, `close`, `getError`.

## Session Discovery Utilities

Discovery helpers live in `session-listing.ts`; `SessionManager` re-exposes the project-scoped lists as thin static wrappers:

- `getRecentSessions(sessionDir, limit?)` -> lightweight metadata for UI/session picker, capped by `limit` (default 4)
- `findMostRecentSession(sessionDir)` -> newest by mtime
- `listSessions(sessionDir, storage)` (a.k.a. `SessionManager.list(cwd, sessionDir?)`) -> sessions in one project scope
- `listAllSessions(storage)` (a.k.a. `SessionManager.listAll()`) -> sessions across all project scopes under `~/.ompk/agent/sessions`
- `resolveResumableSession(sessionArg, cwd, sessionDir?)` -> local then global resume/fork target lookup

Metadata extraction for `getRecentSessions` reads a prefix via `readTextSlices(..., 4096, 0)`. `listSessions`/`listAllSessions` read a 4KB prefix plus a bounded 32 KiB tail through one `readTextSlices(...)` call per file, using the prefix for metadata and the tail for lifecycle status. Resume matching is case-insensitive and accepts session id prefixes, full filename prefixes, or the id suffix after the timestamp in `<timestamp>_<sessionId>.jsonl`.

## Related but Distinct: Prompt History Storage

`HistoryStorage` (`history-storage.ts`) is a separate SQLite subsystem for prompt recall/search, not session replay.

- DB: `~/.ompk/agent/history.db`
- Table: `history(id, prompt, created_at, cwd, session_id)`
- FTS5 index: `history_fts` with trigger-maintained sync
- Deduplicates consecutive identical prompts using in-memory last-prompt cache
- Inserts are batched through an async drain queue (~100 ms delay) so prompt capture does not block turn execution

Use session files for conversation graph/state replay; use `HistoryStorage` for prompt history UX.
