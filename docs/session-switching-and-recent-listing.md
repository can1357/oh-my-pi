# Session switching and recent session listing

This document describes how coding-agent discovers recent sessions, resolves `--resume` targets, presents session pickers, and switches the active runtime session.

It focuses on current implementation behavior, including fallback paths and caveats.

## Implementation files

- [`../src/session/session-manager.ts`](../packages/coding-agent/src/session/session-manager.ts)
- [`../src/session/session-listing.ts`](../packages/coding-agent/src/session/session-listing.ts)
- [`../src/session/session-paths.ts`](../packages/coding-agent/src/session/session-paths.ts)
- [`../src/session/agent-session.ts`](../packages/coding-agent/src/session/agent-session.ts)
- [`packages/tui/src/apps/session-picker.ts`](../packages/tui/src/apps/session-picker.ts)
- [`packages/tui/src/overlays/session-selector.ts`](../packages/tui/src/overlays/session-selector.ts)
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

1. `getRecentSessions(sessionDir, limit = 4)` (welcome/summary view)
   - Lists files and sorts by `mtime` descending.
   - Uses the `history.db` session-title index to avoid reading indexed files.
   - For files without an indexed title, uses the same prefix/tail scan and assistant-detection fallback as full listings, skips untitled empty stubs, and backfills discovered titles into the index.
   - Understands current fixed-width title-slot files and legacy header-first files.
   - Returns lightweight `RecentSessionInfo` (`path`, `name`, `timeAgo`).

2. `SessionManager.list(...)` / `SessionManager.listAll()` (resume pickers and ID matching)
   - Normally reads a 4 KiB prefix plus a bounded 32 KiB tail per file. If neither window finds an assistant turn, a storage-provided fallback may scan body lines until it finds one, avoiding false empty-session classification.
   - Builds `SessionInfo` (`path`, `id`, `cwd`, title/parent metadata, dates, size, message previews/count, and lifecycle status).
   - Uses prefix parsing plus marker counting for list text, and tail parsing for final-message lifecycle status; later messages beyond the prefix may not be present in `allMessagesText`.
   - Status is `complete`, `interrupted`, `aborted`, `error`, `pending`, or `unknown`.
   - The underlying scans sort by `modified` descending; manager APIs put pinned sessions first. Stat-keyed scan results are cached; large listings use bounded parallel workers.

Picker callers use `listForPicker(...)` / `listAllForPicker()`, which also drop untitled empty stubs unless pinned. Titles or discoverable first prompts preserve zero-turn sessions; tail lifecycle status prevents an answered session from being mistaken for an empty stub. Explicit ID resolution keeps the unfiltered scan.

Normal per-directory scans repair the newest orphaned `.bak` created by the EPERM atomic-rewrite fallback when its primary JSONL is absent. `listSessionsReadOnly` is the non-mutating variant.

### Metadata fallback behavior

For recent summaries (`RecentSessionInfo`):

- display name preference (`sessionDisplayName`): `title` -> first user message -> an `Untitled · <time>` label (the raw `id` is intentionally never used)
- the welcome screen truncates the rendered name to the available column width (no fixed length)
- only the first line is kept and control characters are stripped from title/message-derived names (`sanitizeSessionName`)

For `SessionInfo` list entries:

- `title` is the fixed title-slot value when present, otherwise `header.title`, otherwise the last compaction `shortSummary` seen in the prefix
- `firstMessage` is first user message text discoverable from the prefix or `"(no messages)"`
- the picker also shows modified time, file size, a `current` marker on the live session, lifecycle status (except `unknown`), fork marker, and cwd in all-projects scope

## `--continue` resolution and terminal breadcrumb preference

`SessionManager.continueRecent(cwd, sessionDir?)` resolves the target in this order:

1. Read terminal-scoped breadcrumb (`~/.omp/agent/terminal-sessions/<terminal-id>`)
2. Validate the breadcrumb. A materialized target is usable; a missing target is usable only when its optional third line is `fresh`, denoting a lazily-unmaterialized `/new` boundary.
3. A missing fresh target starts a new session instead of falling back and resurrecting the prior transcript.
4. Resolve stale pre-fix subagent breadcrumbs to their interactive parent session.
5. If the breadcrumb's cwd differs, no longer exists, and no genuine current-cwd session takes precedence, re-root only when its recorded device/inode matches the current directory (`open` + `moveTo`). A deleted, unmounted, or cross-filesystem-moved project is not positive evidence of a rename.
6. Otherwise use a breadcrumb whose cwd matches current cwd (and is within an explicit `sessionDir`, when supplied); for a cwd mismatch use the newest non-empty current-bucket session.
7. Without a usable breadcrumb, choose the newest non-empty session by mtime; if none exists, create a new session.

Terminal ID derivation prefers TTY path and falls back to env-based identifiers (`ZELLIJ_PANE_ID`, `TMUX_PANE`, `CMUX_SURFACE_ID`, `KITTY_WINDOW_ID`, `WEZTERM_PANE`, `TERM_SESSION_ID`, `WT_SESSION`). Zellij IDs also include `ZELLIJ_SESSION_NAME` when present, with path separators normalized.

Breadcrumb writes are best-effort and non-fatal.

`-c <value>` is normalized to an explicit resume target when the sole positional value matches the session-id shape; other positional text remains the initial prompt for `--continue`.

## Startup-time resume target resolution (`main.ts`)

### `--resume <value>`

`createSessionManager(...)` handles string-valued `--resume` in two modes:

1. Path-like value (contains `/`, `\\`, or ends with `.jsonl`)
   - direct `SessionManager.open(sessionArg, parsed.sessionDir, undefined, { throwIfMissing: true })`; a missing path fails with `Session "<path>" not found.` instead of creating a session there

2. Resume key value
   - `resolveResumableSession(...)` searches local sessions first, then all sessions unless a custom `sessionDir` disables global fallback
   - matching is case-insensitive and accepts `id` prefix, full JSONL filename prefix, or session-id suffix after the timestamp
   - first match in modified-descending order is used (no ambiguity prompt)

If a matched session's recorded cwd no longer exists, CLI prompts `Move (re-root) it into the current directory? [Y/n]`. Acceptance opens it and `moveTo(cwd)` relocates it; decline exits cleanly. A non-TTY cannot answer and raises `SessionResolutionError`.

Otherwise the session is opened in its recorded project, including global matches; startup switches process cwd, reloads project-scoped settings/plugins, and re-resolves enabled models before constructing the agent. It does **not** fork merely because the match is cross-project.

No match throws `Session "..." not found.`.

### `--resume` (no value)

Handled after initial session-manager construction:

1. list current-folder sessions with `SessionManager.listForPicker(cwd, parsed.sessionDir)`
2. if empty, probe `SessionManager.listAllForPicker()` only to distinguish globally empty state and preload the Tab scope; the picker itself never auto-switches into all-projects scope
3. if both lists are empty, print `No sessions found` and exit
4. open the fullscreen TUI picker (`selectSession`)
5. if canceled, print `No session selected` and exit
6. on selection, `SessionManager.open(selected.path)`, then switch process/project-scoped state to the session's cwd (`switchToResumedProject`: `setProjectDir`, plugin-cache resets, settings reload) and re-resolve scoped models

### `--continue`

Uses `SessionManager.continueRecent(...)` directly (breadcrumb-first behavior above).

## Picker-based selection internals

## CLI picker (`packages/tui/src/apps/session-picker.ts`)

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

1. fetch current-folder sessions via `SessionManager.listForPicker(currentCwd, currentSessionDir)`; the all-projects list remains lazy even when folder scope is empty
2. present `SessionSelectorComponent` as a fullscreen alternate-screen overlay via `ctx.ui.showOverlay` (anchored top-left at full size; the transcript underneath is untouched), wired with lazy all-project loading (`loadAllSessions`), a `history.db` prompt matcher, deletion, pinned-session markers, and a current-session marker
3. callbacks:
   - select -> lock picker input and call `handleResumeSession(sessionPath)`; on success hide the overlay and restore editor focus, a recoverable pre-switch failure unlocks the picker and keeps it open
   - cancel -> hide overlay, restore editor focus, rerender
   - exit -> hide overlay, then `ctx.shutdown()`

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
- the live session (when `currentSessionPath` is supplied) is labeled `current` on its metadata line and focused on open and after a Tab scope toggle

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
6. sync session id, memory key, inherited provider-cache key, and display context; resolve the recorded model (see below); rehydrate checkpoint/rewind state
7. emit `session_switch`, replace messages, reset advisor session state, and sync todos
8. close provider sessions for a different session, or for a same-session reload whose replay changed
9. apply the resolved model, or the caller's explicit `model`
10. if the loaded branch ended with an interrupted tool flow, append a synthetic abort message and rebuild display context
11. restore configured thinking (`auto` survives as auto) and per-family service tiers, falling back to current settings when no corresponding entry exists
12. reset memory/tool session state as required, reconnect listeners, run mode reconciliation, and refresh the workspace-aware base system prompt
13. restore advisor cost for a different session, finish the bash transition, notify session-change callbacks, and return `true` on success
`switchSession()` returns `false` when a before-switch hook cancels or cwd policy rejects the transition. A cross-project switch without a cwd-change callback is rejected rather than silently adopting the target cwd; callback rejection is also cancellation.

Failures after the snapshot restore the previous manager and runtime state, reconnect/reconcile it, and mark the bash transition failed. Cwd-policy rejection returns `false`; other failures rethrow. Mode-reconciliation and base-prompt-refresh failures on the success path are logged without rolling back the switch.

The recorded model resolves as in startup resume: the first role/default candidate that is registered, enabled, and has credentials configured, retried once after a provider-scoped discovery refresh. When none resolves for a different session, the switch throws `Could not restore model <provider/id>` before `session_switch` and rolls back. A session created with `hasUI` and `allowSessionModelFallback` (the TUI) instead keeps its current model when `retry.modelFallback` is on, and reports `Could not restore model <provider/id>. Using <provider/id>` through `onModelFallback` or a `notice` event. A same-file reload keeps the current model. Callers that choose the model pass `model` (RPC `open_session`/`switch_session` with `provider`/`modelId`); collab replicas pass `keepModel`, since the host's state supplies theirs.

## UI state rebuild after interactive switch

`SelectorController.handleResumeSession` invokes `switchSession` first. If it returns `false`, the selector stops before applying any new-session UI updates and leaves the existing session/UI unchanged. After a successful switch, it:

- stop loading animation
- clear status container
- clear pending-message UI and pending tool map
- reset streaming component/message references
- if the resumed session's cwd differs from the previous one, re-point the process and cwd-derived caches at it (`applyCwdChange`)
- clear chat container and rerender from session context (`renderInitialMessages`)
- reload todos from new session artifacts
- show `Resumed session` (or `Resumed session in <dir>` for a cross-project resume), then the model fallback warning, if any

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
- Unrestorable saved model without fallback permission -> `switchSession()` throws `Could not restore model <provider/id>`; the picker and `/resume <id>` show the error and keep the old session.

### Empty list paths

- CLI `--resume` (no value): only an empty current-folder **and** global list prints `No sessions found` and exits; otherwise the empty folder-scope picker invites Tab.
- Interactive selector: empty folder scope renders the Tab hint and remains cancellable.

### Missing/invalid target session file

When opening/switching to a specific path (`setSessionFile`):

- Missing or empty explicit paths passed to `setSessionFile` initialize and persist a fresh session at that path.
- A missing/malformed header in a non-empty file throws `Cannot resume session "...": the session header is missing or malformed. The file was not modified.`
- Strict open/resume paths may reject files with no entries instead of creating them.
- Malformed body records after a valid header are recovered leniently and mark the loaded file for rewrite.

Invalid-header recovery never overwrites the original file.

### Hard failures

Switch/open can still throw on true I/O failures (permission errors, rewrite failures, etc.), which propagate to callers.

### ID prefix matching caveats

- Matching uses `startsWith` on the lowercased session id, lowercased JSONL filename, and lowercased id suffix after the filename timestamp.
- First match in modified-descending order wins; there is no ambiguity UI if multiple sessions share a prefix.
- Prefix-listing metadata is intentionally lightweight, so search text may not include messages outside the first 4KB of the session file.
