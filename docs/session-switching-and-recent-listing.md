# Session switching and recent session listing

This document describes how coding-agent discovers recent sessions, resolves `--resume` targets, presents session pickers, and switches the active runtime session.

It focuses on current implementation behavior, including fallback paths and caveats.

## Implementation files

- [`../src/session/session-manager.ts`](../packages/coding-agent/src/session/session-manager.ts)
- [`../src/session/session-listing.ts`](../packages/coding-agent/src/session/session-listing.ts)
- [`../src/session/session-paths.ts`](../packages/coding-agent/src/session/session-paths.ts)
- [`../src/session/agent-session.ts`](../packages/coding-agent/src/session/agent-session.ts)
- [`../src/cli/session-picker.ts`](../packages/coding-agent/src/cli/session-picker.ts)
- [`../src/modes/components/session-selector.ts`](../packages/coding-agent/src/modes/components/session-selector.ts)
- [`../src/modes/controllers/selector-controller.ts`](../packages/coding-agent/src/modes/controllers/selector-controller.ts)
- [`../src/main.ts`](../packages/coding-agent/src/main.ts)
- [`../src/sdk.ts`](../packages/coding-agent/src/sdk.ts)
- [`../src/modes/interactive-mode.ts`](../packages/coding-agent/src/modes/interactive-mode.ts)
- [`../src/modes/utils/ui-helpers.ts`](../packages/coding-agent/src/modes/utils/ui-helpers.ts)

## Recent-session discovery

### Directory scope

`SessionManager` stores sessions under a cwd-scoped directory by default:

- `~/.ompk/agent/sessions/<dir-encoded>/*.jsonl` (home-relative `-<rel>` names, `-tmp-<rel>` for temp paths, legacy `--<abs>--` otherwise)

`SessionManager.list(cwd, sessionDir?)` reads only that directory unless an explicit `sessionDir` is provided.

### Two listing paths with different payloads

There are two different listing pipelines:

1. `getRecentSessions(sessionDir, limit)` (welcome/summary view)
   - Reads only a 4KB prefix (`readTextSlices(..., 4096, 0)[0]`) from each file.
   - Parses header + earliest user text preview.
   - Returns lightweight `RecentSessionInfo` (`path`, `name`, `timeAgo`); `name` and `timeAgo` are computed eagerly (`sessionDisplayName` / `formatTimeAgo`), not lazy getters.
   - Sorts by file `mtime` descending.

2. `SessionManager.list(...)` / `SessionManager.listAll()` (resume pickers and ID matching)
   - Reads a 4KB prefix plus a bounded 32 KiB tail in one `readTextSlices(...)` call per file, not the full JSONL file.
   - Builds `SessionInfo` objects (`id`, `cwd`, `title`, `messageCount`, `firstMessage`, `allMessagesText`, timestamps, lifecycle status).
   - Uses prefix parsing plus marker counting for list text, and tail parsing for the final-message lifecycle status; later messages beyond the prefix may not be present in `allMessagesText`.
   - Sorts by `modified` descending.

### Metadata fallback behavior

For recent summaries (`RecentSessionInfo`):

- display name preference (`sessionDisplayName`): `title` -> first user message -> an `Untitled · <time>` label (the raw `id` is intentionally never used)
- the welcome screen truncates the rendered name to the available column width (no fixed length)
- only the first line is kept and control characters are stripped from title/message-derived names (`sanitizeSessionName`)

For `SessionInfo` list entries:

- `title` is `header.title` or the last compaction `shortSummary` seen in the 4KB prefix
- `firstMessage` is first user message text discoverable from the prefix or `"(no messages)"`

## `--continue` resolution and terminal breadcrumb preference

`SessionManager.continueRecent(cwd, sessionDir?)` resolves the target in this order:

1. Read terminal-scoped breadcrumb (`~/.ompk/agent/terminal-sessions/<terminal-id>`)
2. Validate breadcrumb:
   - current terminal can be identified
   - referenced file still exists
3. If the breadcrumb's cwd differs from the current cwd, that cwd no longer exists (moved/renamed dir), and the current directory has no sessions of its own, the breadcrumb session is re-rooted into the current directory (`SessionManager.open` + `moveTo`) instead of starting fresh
4. Otherwise, if the breadcrumb cwd matches the current cwd (resolved path compare), use the breadcrumb session; else fall back to newest file by mtime in the session dir (`findMostRecentSession`)
5. If none found, create a new session

Terminal ID derivation prefers TTY path and falls back to env-based identifiers (`ZELLIJ_PANE_ID`, `TMUX_PANE`, `CMUX_SURFACE_ID`, `KITTY_WINDOW_ID`, `WEZTERM_PANE`, `TERM_SESSION_ID`, `WT_SESSION`).

Breadcrumb writes are best-effort and non-fatal.

## Startup-time resume target resolution (`main.ts`)

### `--resume <value>`

`createSessionManager(...)` handles string-valued `--resume` in two modes:

1. Path-like value (contains `/`, `\\`, or ends with `.jsonl`)
   - direct `SessionManager.open(sessionArg, parsed.sessionDir)`

2. Resume key value
   - `resolveResumableSession(...)` searches local sessions first, then all sessions when `sessionDir` is not forced
   - matching is case-insensitive and accepts `id` prefix, full JSONL filename prefix, or the session-id suffix after the timestamp
   - first match in modified-descending order is used (no ambiguity prompt)

Cross-project match behavior:

- if the matched session's recorded cwd no longer exists (moved/renamed dir), CLI prompts `Move (re-root) it into the current directory? [Y/n]`; yes opens the session and `moveTo(cwd)` re-roots it (this also applies to local-scope matches whose recorded cwd is gone)
- otherwise, if a global match's cwd differs from the current cwd, CLI prompts `Fork into current directory? [y/N]`
- fork accepted -> `SessionManager.forkFrom(...)`
- either prompt declined -> command cancels (`Resume cancelled: session is in another project.`)
- non-TTY -> throws `SessionResolutionError` instead of prompting

No match -> throws error (`Session "..." not found.`).

### `--resume` (no value)

Handled after initial session-manager construction:

1. list local sessions with `SessionManager.list(cwd, parsed.sessionDir)`
2. if empty: preload `SessionManager.listAll()` and open the picker in all-projects scope; print `No sessions found` and exit early only when the global list is also empty
3. open TUI picker (`selectSession`, with optional preloaded `allSessions`/`startInAllScope`)
4. if canceled: print `No session selected` and exit early
5. if selected: when the session belongs to another project, switch the process into that project's directory (`setProjectDir`, cache resets, settings reload) first; then `SessionManager.open(selected.path)`

### `--continue`

Uses `SessionManager.continueRecent(...)` directly (breadcrumb-first behavior above).

## Picker-based selection internals

## CLI picker (`src/cli/session-picker.ts`)

`selectSession(sessions, { allSessions?, startInAllScope? })` creates a standalone TUI with `SessionSelectorComponent` and resolves exactly once:

- selection -> resolves selected `SessionInfo` (caller uses `.path` / `.cwd`)
- cancel (Esc) -> resolves `null`
- hard exit (Ctrl+C path) -> stops TUI and `process.exit(0)`
- Tab toggles current-folder / all-projects scope; the all-projects list is loaded lazily via `SessionManager.listAll` (or preloaded via `allSessions`)
- search ranking is augmented with prompt-history matches from `history.db` (`HistoryStorage.matchingSessionIds`) when available

## Interactive in-session picker (`SelectorController.showSessionSelector`)

Flow:

1. fetch sessions from current session dir via `SessionManager.list(currentCwd, currentSessionDir)`; if empty, preload `SessionManager.listAll()` and open in all-projects scope
2. mount `SessionSelectorComponent` in editor area using `showSelector(...)`, wired with `loadAllSessions: () => SessionManager.listAll()` and a `history.db` prompt matcher
3. callbacks:
   - select -> close selector and call `handleResumeSession(sessionPath)`
   - cancel -> restore editor and rerender
   - exit -> `ctx.shutdown()`

## Session selector component behavior

`SessionList` supports:

- arrow/page navigation
- Enter to select
- Delete to delete after confirmation
- Esc to cancel
- Ctrl+C to exit
- Tab to toggle current-folder / all-projects scope
- ranked fuzzy search across session id/title/cwd/first message/all messages/path, merged with prompt-history matches from `history.db`

Empty-list render behavior:

- current-folder scope renders `No sessions in current folder. Press Tab to view all.`; all-projects scope renders `No sessions found`
- Enter/Delete on empty do nothing (no callback)
- Esc/Ctrl+C still work

## Runtime switch execution (`AgentSession.switchSession`)

`switchSession(sessionPath)` is the core in-process switch path.

Lifecycle/state transition:

1. capture `previousSessionFile`
2. emit `session_before_switch` hook event (`reason: "resume"`, cancellable)
3. if canceled -> return `false` with no switch
4. disconnect from current agent event stream
5. abort active generation/tool flow
6. flush session writer (`sessionManager.flush()`) to persist pending writes, then capture rollback state
7. clear queued steering/follow-up/next-turn message buffers
8. `sessionManager.setSessionFile(sessionPath)`
   - updates session file pointer
   - writes terminal breadcrumb
   - loads entries / migrates / blob-resolves / reindexes
   - if missing/invalid file data: initializes a new session at that path and rewrites header
9. update `agent.sessionId`
10. rebuild display context via `buildDisplaySessionContext()`
11. restore persisted/discovered MCP tool selections and rebuild active tools/system prompt when discovery is enabled
12. emit `session_switch` hook event (`reason: "resume"`, `previousSessionFile`)
13. replace agent messages with rebuilt context and sync todos
14. close provider sessions when switching to a different session or when same-session reload changed replay messages
15. restore model via `getRestorableSessionModels(sessionContext.models, lastModelChangeRole)` — tries the recorded models in fallback order and uses the first one present in the model registry
16. restore thinking level and service tier:
    - thinking uses persisted `thinking_level_change`, otherwise the configured default clamped to model capability
    - service tier uses persisted `service_tier_change`, otherwise the configured `serviceTier` setting (`"none"` becomes unset)
17. reconnect agent listeners, run the registered session-switch reconciler if any (interactive mode re-enters persisted modes; errors logged, not fatal), and return `true`

## UI state rebuild after interactive switch

`SelectorController.handleResumeSession` rebuilds the interactive UI only after `switchSession` succeeds:

- call `session.switchSession(...)` while leaving the current conversation and transient state intact
- if `switchSession` throws `SessionAlreadyOwnedError` (another process holds the writer guard), show a sanitized, recoverable UI error and keep the current session
- for any other switch failure, show a sanitized error message and keep the current session
- if a `session_before_switch` hook cancels the switch (`false`), show `Session resume cancelled` and keep the current conversation rendered
- after a successful switch, stop loading animation, clear the status container, clear pending-message UI and the pending tool map, and reset streaming component/message references
- if the resumed session's cwd differs from the previous one, re-point the process and cwd-derived caches at it (`applyCwdChange`)
- clear the chat container and rerender from session context (`renderInitialMessages`)
- reload todos from new session artifacts
- show `Resumed session` (or `Resumed session in <dir>` for a cross-project resume)

So visible conversation/todo state is rebuilt from the new session file.

## Startup resume vs in-session switch

### Startup resume (`--continue`, `--resume`, direct open)

- Session file is chosen before `createAgentSession(...)`.
- `sdk.ts` builds `existingSession = sessionManager.buildSessionContext()`.
- Agent messages are restored once during session creation.
- Model/thinking are selected during creation (including restore/fallback logic).
- Interactive mode then runs `#reconcileModeFromSession()` to re-enter persisted mode state (e.g. plan mode).

### In-session switch (`/resume`-style selector path)

- Uses `AgentSession.switchSession(...)` on an already-running `AgentSession`.
- Messages/model/thinking are rebuilt immediately in place.
- Hook `session_before_switch`/`session_switch` events are emitted.
- UI chat/todos are refreshed.
- Mode re-entry is symmetric with startup: interactive mode registers `#reconcileModeFromSession()` as the session-switch reconciler (`setSessionSwitchReconciler`), and `switchSession()` invokes it after reconnecting.

## Failure and edge-case behavior

### Cancellation paths

- CLI picker cancel -> returns `null`, caller prints `No session selected`, process exits early.
- Interactive picker cancel -> editor restored, no session change.
- Hook cancellation (`session_before_switch`) -> `switchSession()` returns `false`.

### Empty list paths

- CLI `--resume` (no value): empty list prints `No sessions found` and exits.
- Interactive selector: empty list renders message and remains cancellable.

### Missing/invalid target session file

When opening/switching to a specific path (`setSessionFile`):

- ENOENT -> treated as empty -> new session initialized at that exact path and persisted.
- malformed/invalid header (or effectively unreadable parsed entries) -> treated as empty -> new session initialized and persisted.

This is recovery behavior, not hard failure.

### Hard failures

Switch/open can still throw on true I/O failures (permission errors, rewrite failures, etc.), which propagate to callers.

### ID prefix matching caveats

- Matching uses `startsWith` on the lowercased session id, lowercased JSONL filename, and lowercased id suffix after the filename timestamp.
- First match in modified-descending order wins; there is no ambiguity UI if multiple sessions share a prefix.
- Prefix-listing metadata is intentionally lightweight, so search text may not include messages outside the first 4KB of the session file.
