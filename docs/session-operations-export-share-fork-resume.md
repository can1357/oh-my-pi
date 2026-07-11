# Session Operations: export, dump, share, fresh, fork, resume/continue

This document describes operator-visible behavior for session export/share/fork/resume operations as currently implemented.

## Implementation files

- [`../src/modes/controllers/command-controller.ts`](../packages/coding-agent/src/modes/controllers/command-controller.ts)
- [`../src/session/agent-session.ts`](../packages/coding-agent/src/session/agent-session.ts)
- [`../src/session/session-manager.ts`](../packages/coding-agent/src/session/session-manager.ts)
- [`../src/export/html/index.ts`](../packages/coding-agent/src/export/html/index.ts)
- [`../src/export/custom-share.ts`](../packages/coding-agent/src/export/custom-share.ts)
- [`../src/main.ts`](../packages/coding-agent/src/main.ts)

## Operation matrix

| Operation                               | Entry path                | Session mutation                      | Session file creation/switch                                                       | Output artifact                                                 |
| --------------------------------------- | ------------------------- | ------------------------------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `/dump`                                 | Interactive slash command | No                                    | No                                                                                 | Clipboard text                                                  |
| `/export [path]`                        | Interactive slash command | No                                    | No                                                                                 | HTML file                                                       |
| `--export <session.jsonl> [outputPath]` | CLI startup fast-path     | No runtime session mutation           | No active session; reads target file                                               | HTML file                                                       |
| `/share`                                | Interactive slash command | No                                    | No                                                                                 | Encrypted share link (gist or share server); temp HTML only for custom handlers |
| `/fresh`                               | Interactive slash command | Yes (provider-facing in-memory id/state only) | No; keeps current session file/header                                               | None                                                            |
| `/fork`                                 | Interactive slash command | Yes (active session identity changes) | Creates new session file and switches current session to it (persistent mode only) | Copies artifact directory to new session namespace when present |
| `--fork <id\|path>`                     | CLI startup               | Yes after session creation            | Creates a new session fork from the selected source into current cwd/session dir   | None                                                            |
| `/resume`                               | Interactive slash command | Yes (active in-memory state replaced) | Switches to selected existing session file                                         | None                                                            |
| `--resume`                              | CLI startup picker        | Yes after session creation            | Opens selected existing session file                                               | None                                                            |
| `--resume <id\|path>`                   | CLI startup               | Yes after session creation            | Opens existing session; global cross-project match re-roots (moved dir) or forks into current project   | None                                                            |
| `--continue`                            | CLI startup               | Yes after session creation            | Opens terminal breadcrumb (re-roots it if its dir was moved) or most-recent session; creates new one if none exists   | None                                                            |

## Export and dump

### `/export [outputPath]` (interactive)

Flow:

1. The builtin slash-command registry (`src/slash-commands/builtin-registry.ts`) routes `/export...` to `CommandController.handleExportCommand` in the TUI.
2. The command splits on whitespace and uses only the first argument after `/export` as `outputPath`.
3. `AgentSession.exportToHtml()` calls `exportSessionToHtml(sessionManager, state, { outputPath, themeName })`.
4. On success, UI shows path and opens the file in browser.

Behavior details:

- `--copy`, `clipboard`, and `copy` arguments are explicitly rejected with a warning to use `/dump`.
- Export embeds session header/entries/leaf plus current `systemPrompt` and tool descriptions from agent state.
- Subagent transcripts stored next to the session file (`<session>/<AgentId>.jsonl`, recursively for nested spawns) are embedded as `subSessions` (`collectSubSessions` in `src/export/html/index.ts`; disable with `includeSubSessions: false` in `ExportOptions`). In the page, agent ids in task tool cards open a breadcrumbed sub-session overlay.
- Tool calls render through the `<omp-tool-view>` web component — the React per-tool renderers shared with collab-web (`packages/collab-web/src/tool-render/`), prebuilt into `src/export/html/tool-views.generated.js` by `bun run gen:tool-views`.
- No session entries are appended during export.

Caveat:

- Argument parsing is whitespace-based (`text.split(/\s+/)`), so quoted paths with spaces are not preserved as a single path by this command path.

### `--export <inputSessionFile> [outputPath]` (CLI)

Flow in `main.ts`:

1. Handled early (before interactive/session startup).
2. Calls `exportFromFile(inputPath, outputPath?)`.
3. `SessionManager.open(inputPath)` loads entries, then HTML is generated and written.
4. Process prints `Exported to: ...` and exits.

Behavior details:

- Missing input file surfaces as `File not found: <path>`.
- This path does not create an `AgentSession` and does not mutate any running session.

### `/dump` (interactive clipboard export)

Flow:

1. `CommandController.handleDumpCommand()` calls `session.formatSessionAsText()`.
2. If empty string, reports `No messages to dump yet.`
3. Otherwise copies to clipboard via native `copyToClipboard`.

Dump content includes:

- System prompt
- Active model/thinking level
- Tool definitions + parameters
- User/assistant messages
- Thinking blocks and tool calls
- Tool results and execution blocks (except `excludeFromContext` bash/python entries)
- Custom/hook/file mention/branch summary/compaction summary entries

No session persistence changes are made by dumping.

## Share

`/share` publishes an end-to-end encrypted snapshot of the session and prints
a viewer link. Implementation: [`../packages/coding-agent/src/export/share.ts`](../packages/coding-agent/src/export/share.ts).

### Phase 1: custom share handler (if present)

`loadCustomShare()` checks `~/.omp/agent` for first existing candidate:

- `share.ts`
- `share.js`
- `share.mjs`

Requirements:

- Module must default-export a function `(htmlPath) => Promise<CustomShareResult | string | undefined>`.

If present and valid, the legacy contract is preserved: the session is
exported to a temp HTML file (`${os.tmpdir()}/${Snowflake.next()}.html`),
the handler receives its path, and the temp file is removed afterwards.
Handler result interpretation:

- string => treated as URL, shown and opened
- object => `url` and/or `message` shown; `url` opened
- `undefined`/falsy => generic `Session shared`

Critical fallback behavior:

- If custom handler exists but loading fails, command errors and returns.
- If custom handler executes and throws, command errors and returns.
- In both failure cases, it **does not** fall back to the default flow.
- The default flow runs only when no custom share script exists.

### Phase 2: default encrypted share

Only when no custom share handler is found (`shareSession()`):

1. Builds the session snapshot (`header`, `entries`, `leafId`, plus current
   `systemPrompt` and tool descriptions from agent state).
2. If `share.redactSecrets` is enabled (default) and secrets are configured
   (`secrets.*`), the secret obfuscator deep-walks every string in the
   snapshot, replacing configured/discovered secrets with placeholders.
3. The JSON is gzipped and sealed with a fresh AES-256-GCM key
   (`[12B IV][ciphertext+tag]`).
4. Upload target is chosen by `share.store`:
   - **Share server** (default, `store: "blob"`) — `POST <share.serverUrl>`
     (default `https://my.omp.sh/s`) with the raw blob, capped at 1 MB.
     Oversized snapshots are trimmed until they fit: inline images first,
     then long strings (32 KB → 8 KB → 2 KB → 512 B caps), then oldest
     entries.
   - **Secret gist** (`store: "gist"`) — when `gh` is installed and
     authenticated, the sealed blob is pushed base64-encoded as
     `session.ompshare.txt` (budget 5 MB sealed; gist raw fetches cap at
     10 MB), falling back to the share server when `gh` is unusable.
5. The link is `<share.serverUrl>/<id>#<base64url key>` in both cases. The
   viewer page served there fetches the blob (hex ids via the GitHub gist
   API, anything else from the server's blob store) and decrypts it
   client-side; the key lives only in the URL fragment and never appears in
   any HTTP request.

The UI reports the share URL (plus the underlying gist URL and a truncation
note when applicable). Headless `/share` prints the same lines. Unlike
`/export`, `/share` works for in-memory (`--no-session`) sessions: the
snapshot is built from live entries, no session file required.

Cancellation/abort semantics in share:

- Loader has `onAbort` hook that restores editor UI and reports `Share cancelled`.
- The upload itself is not aborted mid-flight; cancellation is UI-level and
  checked after the upload returns.

## Fork

Interactive `/fork` creates a new session from the current one and switches the active session identity.

### Preconditions and immediate guards

- If agent is streaming, `/fork` is rejected with warning.
- UI status/loading indicators are cleared before operation.

### Session-level flow

`AgentSession.fork()`:

1. Emits `session_before_switch` with `reason: "fork"` (cancellable).
2. Flushes pending writes.
3. Calls `SessionManager.fork()`.
4. Copies artifacts directory from old session namespace to new namespace (best-effort; non-ENOENT copy failures are logged, not fatal).
5. Updates `agent.sessionId`.
6. Emits `session_switch` with `reason: "fork"`.

`SessionManager.fork()` behavior:

- Requires persistent mode and existing session file.
- Creates new session id and new JSONL file path.
- Rewrites header with:
  - new `id`
  - new timestamp
  - `cwd` unchanged
  - `parentSession` set to previous session id
- Keeps all non-header entries unchanged in the new file.

### Non-persistent behavior

- In-memory session manager returns `undefined` from `fork()`.
- `AgentSession.fork()` returns `false`.
- UI reports `Fork failed (session not persisted or cancelled)`.

### CLI `--fork <id|path>`

Startup `--fork` is resolved before normal session creation:

1. `--fork` is rejected with `--no-session`.
2. Path-like values (`/`, `\`, or `.jsonl`) call `SessionManager.forkFrom(path, cwd, sessionDir)`.
3. Other values resolve via `resolveResumableSession(...)`: local sessions first, then global search when `sessionDir` is not forced. Matching accepts lowercased session id prefixes, full JSONL filename prefixes, and timestamp-stripped filename id suffixes.
4. The forked file is created in the current cwd/session-dir scope and becomes the active session manager for startup.

## Resume and continue

## Interactive `/resume`

Flow:

1. Opens session selector populated via `SessionManager.list(currentCwd, currentSessionDir)`. If the current folder has no sessions, `SessionManager.listAll()` is preloaded and the picker opens directly in all-projects scope.
2. On selection, `SelectorController.handleResumeSession(sessionPath)` calls `session.switchSession(sessionPath)`.
3. UI clears/rebuilds chat and todos, then reports `Resumed session` (or `Resumed session in <dir>` when the resumed session belongs to another project, in which case the process cwd and cwd-derived caches are re-pointed via `applyCwdChange`).

Notes:

- The picker starts in current-folder scope; Tab toggles to all-projects scope (lazily loading `SessionManager.listAll()` on first toggle, cached afterwards).

## CLI `--resume`

### `--resume` (no value)

- `main.ts` lists sessions for current cwd/sessionDir and opens picker. When the current folder is empty, it falls back to `SessionManager.listAll()` and opens the picker in all-projects scope; `No sessions found` is printed only when the global list is also empty.
- Selected path is opened with `SessionManager.open(selectedPath)` before session creation. Selecting a session from another project first switches the process into that project's directory and reloads cwd-scoped settings/caches.

### `--resume <value>`

`createSessionManager()` resolution order:

1. If value looks like path (`/`, `\`, or `.jsonl`), open directly.
2. Else `resolveResumableSession(...)` searches:
   - current scope (`SessionManager.list(cwd, sessionDir)`)
   - global sessions (`SessionManager.listAll()`) only when no explicit `sessionDir` was provided
3. Matching accepts case-insensitive session id prefixes, full JSONL filename prefixes, and the id suffix after the timestamp in `<timestamp>_<sessionId>.jsonl`.

Cross-project id match behavior:

- If matched session cwd differs from current cwd, behavior depends on whether the matched session's recorded directory still exists:
  - **Directory gone (moved/renamed, e.g. `git worktree move`)**: CLI asks `Session's directory no longer exists (...). Move (re-root) it into the current directory? [Y/n]`.
    - On yes (default): `SessionManager.open(match.path)` then `manager.moveTo(cwd)` re-roots the existing session into the current directory (no duplicate file).
    - On no: command cancels (returns no session). On non-TTY: command errors.
  - **Directory still exists (genuinely different project)**: CLI asks `Session found in different project ... Fork into current directory? [y/N]`.
    - On yes: `SessionManager.forkFrom(match.path, cwd, sessionDir)` creates a new local forked file.
    - On no: command cancels. On non-TTY: command errors.

## CLI `--continue`

`SessionManager.continueRecent(cwd, sessionDir)`:

1. Resolves session dir for current cwd.
2. Reads the terminal-scoped breadcrumb.
3. If the breadcrumb points at a session recorded under a different cwd whose directory no longer exists (moved/renamed) **and** the current directory has no sessions of its own, re-roots that session into the current directory via `moveTo` instead of starting fresh.
4. Otherwise, if the breadcrumb's cwd matches the current cwd, uses the breadcrumb session; else falls back to the most recently modified session file.
5. Opens the found session; if none exists, creates a new session.

This is startup-only behavior; there is no interactive `/continue` slash command.

## How session switching actually mutates runtime state

`AgentSession.switchSession(sessionPath)` does the runtime transition used by resume-like operations:

1. Emit `session_before_switch` with `reason: "resume"` and `targetSessionFile` (cancellable).
2. Disconnect agent event subscription and abort in-flight work.
3. Flush current session manager writes.
4. Capture rollback state for the current session, agent messages, queued steering/follow-up/next-turn messages, model/thinking/service-tier, MCP selections, tools, and system prompt.
5. Clear queued steering/follow-up/next-turn messages.
6. `sessionManager.setSessionFile(sessionPath)` and update `agent.sessionId`.
7. Build session context from loaded entries.
8. Restore MCP selections/tools/system prompt for the target session.
9. Emit `session_switch` with `reason: "resume"`.
10. Replace agent messages from context and sync todos.
11. Close provider sessions when switching files, or when same-file reload changed replay messages.
12. Restore model (if available in current registry).
13. Restore or initialize thinking level and service tier.
14. Reconnect agent event subscription.
15. Run the registered session-switch reconciler, if any (interactive mode registers `#reconcileModeFromSession()` via `setSessionSwitchReconciler` to re-enter persisted modes such as plan); reconciler errors are logged, not fatal.

If any step after the capture fails, `switchSession()` restores the captured state and reconnects the previous agent subscription before rethrowing.

No new session file is created by `switchSession()` itself.

## Event emissions and cancellation points

### Switch/fork lifecycle hooks

For `newSession`, `fork`, and `switchSession`:

- Before event: `session_before_switch`
  - reasons: `new`, `fork`, `resume`
  - cancellable by returning `{ cancel: true }`
- After event: `session_switch`
  - same reason set
  - includes `previousSessionFile`

`ExtensionRunner.emit()` returns early on the first cancelling before-event result.

### Custom tool `onSession` behavior

SDK bridges extension session events to custom tool `onSession` callbacks:

- `session_switch` -> `onSession({ reason: "switch", previousSessionFile })`
- `session_branch` -> `reason: "branch"`
- `session_start` -> `reason: "start"`
- `session_tree` -> `reason: "tree"`
- `session_shutdown` -> `reason: "shutdown"`

These callbacks are observational; they do not cancel switch/fork.

### Other cancellation surfaces relevant to this doc

- `/fork` is blocked while streaming (user must wait/abort current response first).
- `/resume` selector can be cancelled by user closing selector.
- Cross-project `--resume <id>` can be cancelled by declining fork prompt.
- `/share` has a UI abort path (`Share cancelled`); the upload itself is not killed mid-flight.

## Non-persistent (in-memory) session behavior

When session manager is created with `SessionManager.inMemory()` (`--no-session`):

- Session file path is absent.
- `/export` fails with `Cannot export in-memory session to HTML` (propagated to command error UI). `/share` still works: the snapshot is built from live entries.
- `/fork` fails because `SessionManager.fork()` requires persistence.
- `/dump` still works because it serializes in-memory agent state.
- CLI resume/continue semantics are bypassed if `--no-session` is set, because manager creation returns in-memory immediately.

## Known implementation caveats (as of current code)

- `SelectorController.handleResumeSession()` does not check the boolean result from `session.switchSession(...)`; a hook-cancelled switch can still proceed through UI "Resumed session" repaint/status path.
- `/share` custom-share failures do not degrade to the default encrypted share flow; they terminate the command with error.
- `/export` argument tokenization is simplistic and does not preserve quoted paths with spaces.
