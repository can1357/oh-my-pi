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

`SessionManager` stores file sessions under a canonical-cwd bucket by default:

- `~/.omp/agent/sessions/<encoded-cwd>/*.jsonl`

`<encoded-cwd>` is the path-encoded canonical cwd (`-<relative>` under home, `-tmp-<relative>` under the temp root, `--<encoded-absolute>--` otherwise; see [session.md](session.md#on-disk-layout)). Buckets from the reverted 17.2.5-17.2.8 hashed scheme are migrated best-effort. `SessionManager.list(cwd, sessionDir?)` reads only the resolved bucket unless an explicit `sessionDir` is provided.

### Two listing paths with different payloads

There are two different listing pipelines:

1. `getRecentSessions(sessionDir, limit)` (welcome/summary view)
   - Reads only a 4 KiB prefix from each file.
   - Understands both current fixed-width title-slot files and legacy header-first files.
   - Parses header + earliest user text preview.
   - Returns lightweight `RecentSessionInfo` (`path`, `name`, `timeAgo`).
   - Sorts by file `mtime` descending.

2. `SessionManager.list(...)` / `SessionManager.listAll()` (resume pickers and ID matching)
   - Reads a 4 KiB prefix plus a bounded 32 KiB tail per file, not the full JSONL body.
   - Builds `SessionInfo` (`path`, `id`, `cwd`, title/parent metadata, dates, size, message previews/count, and lifecycle status).
   - Uses prefix parsing plus marker counting for list text, and tail parsing for final-message lifecycle status; later messages beyond the prefix may not be present in `allMessagesText`.
   - Status is `complete`, `interrupted`, `aborted`, `error`, `pending`, or `unknown`.
   - Sorts by `modified` descending. Stat-keyed scan results are cached; large listings use bounded parallel workers.

Normal per-directory scans repair the newest orphaned `.bak` created by the EPERM atomic-rewrite fallback when its primary JSONL is absent. `listSessionsReadOnly` is the non-mutating variant.

### Metadata fallback behavior

For recent summaries (`RecentSessionInfo`):

- display name preference (`sessionDisplayName`): `title` -> first user message -> an `Untitled · <time>` label (the raw `id` is intentionally never used)
- the welcome screen truncates the rendered name to the available column width (no fixed length)
- only the first line is kept and control characters are stripped from title/message-derived names (`sanitizeSessionName`)

For `SessionInfo` list entries:

- `title` is the fixed title-slot value when present, otherwise `header.title`, otherwise the last compaction `shortSummary` seen in the prefix
- `firstMessage` is first user message text discoverable from the prefix or `"(no messages)"`
- the picker also shows modified time, file size, lifecycle status (except `unknown`), fork marker, and cwd in all-projects scope

## `--continue` resolution and terminal breadcrumb preference

`SessionManager.continueRecent(cwd, sessionDir?)` resolves the target in this order:

1. Read terminal-scoped breadcrumb (`~/.omp/agent/terminal-sessions/<terminal-id>`)
2. Validate the breadcrumb. A materialized target is usable; a missing target is usable only when its optional third line is `fresh`, denoting a lazily-unmaterialized `/new` boundary.
3. A missing fresh target starts a new session instead of falling back and resurrecting the prior transcript.
4. Resolve stale pre-fix subagent breadcrumbs to their interactive parent session.
5. If the breadcrumb's cwd differs from current cwd, no longer exists, and the current location has no session of its own, re-root the breadcrumb session into current cwd (`open` + `moveTo`).
6. Otherwise use a breadcrumb whose cwd matches current cwd; for a cwd mismatch use the newest current-bucket session.
7. Without a usable breadcrumb, choose newest file by mtime; if none exists, create a new session.

Terminal ID derivation prefers TTY path and falls back to env-based identifiers (`ZELLIJ_PANE_ID`, `TMUX_PANE`, `CMUX_SURFACE_ID`, `KITTY_WINDOW_ID`, `WEZTERM_PANE`, `TERM_SESSION_ID`, `WT_SESSION`).

Breadcrumb writes are best-effort and non-fatal.

`-c <value>` is normalized to an explicit resume target when the sole positional value matches the session-id shape; other positional text remains the initial prompt for `--continue`.

## Startup-time resume target resolution (`main.ts`)

### `--resume <value>`

`createSessionManager(...)` handles string-valued `--resume` in two modes:

1. Path-like value (contains `/`, `\\`, or ends with `.jsonl`)
   - direct `SessionManager.open(sessionArg, parsed.sessionDir)`

2. Resume key value
   - `resolveResumableSession(...)` searches local sessions first, then all sessions unless a custom `sessionDir` disables global fallback
   - matching is case-insensitive and accepts `id` prefix, full JSONL filename prefix, or session-id suffix after the timestamp
   - first match in modified-descending order is used (no ambiguity prompt)

If a matched session's recorded cwd no longer exists, CLI prompts `Move (re-root) it into the current directory? [Y/n]`. Acceptance opens it and `moveTo(cwd)` relocates it; decline exits cleanly. A non-TTY cannot answer and raises `SessionResolutionError`.

Otherwise the session is opened in its recorded project, including global matches; startup switches process cwd, reloads project-scoped settings/plugins, and re-resolves enabled models before constructing the agent. It does **not** fork merely because the match is cross-project.

No match throws `Session "..." not found.`.

### `--resume` (no value)

Handled after initial session-manager construction:

1. list current-folder sessions with `SessionManager.list(cwd, parsed.sessionDir)`
2. if empty, probe `SessionManager.listAll()` only to distinguish globally empty state and preload the Tab scope; the picker still opens in current-folder scope
3. if both lists are empty, print `No sessions found` and exit
4. open the fullscreen TUI picker (`selectSession`)
5. if canceled, print `No session selected` and exit
6. on selection, switch process/project-scoped state to the session's cwd, then `SessionManager.open(selected.path)`

### `--continue`

Uses `SessionManager.continueRecent(...)` directly (breadcrumb-first behavior above).

## Picker-based selection internals

## CLI picker (`src/cli/session-picker.ts`)

`selectSession(sessions, options)` creates a fullscreen alternate-screen TUI with `SessionSelectorComponent` and resolves exactly once:

- selection -> resolves selected `SessionInfo`
- cancel (Esc) -> resolves `null`
- hard exit (Ctrl+C path) -> stops TUI and exits
- Tab toggles current-folder / all-projects scope; the all-projects list is loaded lazily or supplied preloaded
- search combines session metadata/prefix text with prompt-history matches from `history.db` after a short debounce
- mouse wheel changes selection and left click selects in the fullscreen picker
- Delete, or Backspace with an empty search, opens confirmation and deletes the JSONL plus session artifacts

## Interactive in-session picker (`SelectorController.showSessionSelector`)

Flow:

1. fetch current-folder sessions via `SessionManager.list(currentCwd, currentSessionDir)`; the all-projects list remains lazy even when folder scope is empty
2. mount `SessionSelectorComponent` in the editor area with lazy all-project loading and a `history.db` prompt matcher
3. callbacks:
   - select -> lock picker input and call `handleResumeSession(sessionPath)`; a recoverable pre-switch failure unlocks the picker
   - cancel -> restore editor and rerender
   - exit -> `ctx.shutdown()`

`/resume <id-prefix>` resolves local then global matches and switches directly. `/resume @claude` and `/resume @codex` instead open read-only-source import pickers: the selected foreign transcript is persisted as an OMP session, then switched to; deletion, history augmentation, and all-project scope are not offered in those pickers.

## Session selector component behavior

`SessionList` supports:

- Up/Down and Page Up/Page Down navigation (clamped, not wrapped)
- Enter to select
- Delete, or Backspace on an empty search, to delete after confirmation
- Esc to cancel; Ctrl+C to exit
- Tab to toggle current-folder / all-projects scope
- mouse wheel/click in the fullscreen picker
- multi-token search across id/title/cwd/first message/prefix message text/path: literal matches lead by recency, then sufficiently strong fuzzy matches; prompt-history matches from `history.db` may be promoted after typing pauses

Empty-list render behavior:

- current-folder scope renders `No sessions in current folder. Press Tab to view all.`; all-projects scope renders `No sessions found`
- Enter/Delete/Backspace on empty do nothing
- Esc/Ctrl+C still work

## Runtime switch execution (`AgentSession.switchSession`)

`switchSession(sessionPath)` is the core in-process switch path.

Lifecycle/state transition:

1. capture the previous file and emit cancellable `session_before_switch` (`reason: "resume"`, target file)
2. disconnect agent listeners, abort active work, run the pre-switch reconciler, and flush pending bash/session writes
3. snapshot rollback state (manager, queues, messages, model/thinking/tier, tools/prompts, provider-cache identity, and checkpoint/rewind state), then clear message queues
4. for a different session, drain/detach advisor recorders
5. `sessionManager.setSessionFile(sessionPath)`: update breadcrumb, load/migrate/blob-resolve/index entries, and adopt an existing recorded cwd when permitted by cwd policy
6. sync session id, memory key, inherited provider-cache key, display context, and checkpoint/rewind state
7. emit `session_switch`, replace messages, reset advisor session state, and sync todos
8. close provider sessions for a different session, or for a same-session reload whose replay changed
9. restore the first available recorded model in role/default fallback order
10. if the loaded branch ended with an interrupted tool flow, append a synthetic abort message and rebuild display context
11. restore configured thinking (`auto` survives as auto) and per-family service tiers, falling back to current settings when no corresponding entry exists
12. reset memory/tool session state as required, reconnect listeners, run mode reconciliation, and refresh the workspace-aware base system prompt
13. restore advisor cost for a different session, finish the bash transition, notify session-change callbacks, and return `true` on success
`switchSession()` returns `false` when a before-switch hook cancels or cwd policy rejects the transition. A cross-project switch without a cwd-change callback is rejected rather than silently adopting the target cwd; callback rejection is also cancellation.

Any failure after the snapshot restores the previous manager and runtime state, reconnects/reconciles it, marks the bash transition failed, then rethrows.

## UI state rebuild after interactive switch

`SelectorController.handleResumeSession` invokes `switchSession` first. If it returns `false`, the selector stops before applying any new-session UI updates and leaves the existing session/UI unchanged. After a successful switch, it:

- stop loading animation
- clear status container
- clear pending-message UI and pending tool map
- reset streaming component/message references
- if the resumed session's cwd differs from the previous one, re-point the process and cwd-derived caches at it (`applyCwdChange`)
- clear chat container and rerender from session context (`renderInitialMessages`)
- reload todos from new session artifacts
- show `Resumed session` (or `Resumed session in <dir>` for a cross-project resume)

So visible conversation/todo state is rebuilt from the new session file.

## Startup resume vs in-session switch

### Startup resume (`--continue`, `--resume`, direct open)

- Session file is chosen before `createAgentSession(...)`.
- `sdk.ts` builds the existing session context during creation.
- Agent messages and replay state are restored once during construction.
- Model/thinking/service tier use persisted state with current configuration fallbacks.
- Interactive mode then reconciles persisted mode state.

### In-session switch (`/resume`-style selector path)

- Uses `AgentSession.switchSession(...)` on an already-running session.
- Messages/model/thinking/tier and session-scoped runtime state are rebuilt in place.
- `session_before_switch`/`session_switch` hooks are emitted.
- UI chat/todos are refreshed.
- Interactive mode reconciliation runs through the registered session-switch reconciler.

## Failure and edge-case behavior

### Cancellation paths

- CLI picker cancel -> returns `null`, caller prints `No session selected`, process exits.
- Interactive picker cancel -> closes the overlay with no session change.
- Core hook or cwd-policy cancellation -> `switchSession()` returns `false`; the interactive selector stops before its UI refresh/status path, preserving the old session and UI. Callback-free cross-project switches are rejected rather than silently adopting the target cwd.

### Empty list paths

- CLI `--resume` (no value): only an empty current-folder **and** global list prints `No sessions found` and exits; otherwise the empty folder-scope picker invites Tab.
- Interactive selector: empty folder scope renders the Tab hint and remains cancellable.

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
