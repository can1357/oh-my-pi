# Session Operations: export, dump, share, fresh, clear, fork, resume/continue

This document describes operator-visible behavior for session export, sharing, conversation reset, lifecycle, fork, and resume operations as currently implemented.

## Implementation files

- [`../src/modes/controllers/command-controller.ts`](../packages/coding-agent/src/modes/controllers/command-controller.ts)
- [`../src/session/agent-session.ts`](../packages/coding-agent/src/session/agent-session.ts)
- [`../src/session/session-manager.ts`](../packages/coding-agent/src/session/session-manager.ts)
- [`../src/export/html/index.ts`](../packages/coding-agent/src/export/html/index.ts)
- [`../src/export/custom-share.ts`](../packages/coding-agent/src/export/custom-share.ts)
- [`../src/main.ts`](../packages/coding-agent/src/main.ts)

## Operation matrix

| Operation                               | Entry path                   | Session mutation                              | Session file creation/switch                                                               | Output artifact                                                                     |
| --------------------------------------- | ---------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| `/dump`                                 | Slash command (TUI/headless) | No                                            | No                                                                                         | Clipboard/command text plus best-effort temporary JSON sidecar                      |
| `/export [--themes] [path]`             | Slash command (TUI/headless) | No                                            | No                                                                                         | HTML file                                                                           |
| `--export <session.jsonl> [outputPath]` | CLI startup fast-path        | No runtime session mutation                   | No active session; reads target file                                                       | HTML file                                                                           |
| `/share`                                | Slash command (TUI/headless) | No                                            | No                                                                                         | Encrypted share link (gist or share server); temp HTML only for TUI custom handlers |
| `/new`                                  | Interactive slash command    | Yes (starts an empty conversation)            | Switches identity; assigns a new transcript path in persistent mode                        | None                                                                                |
| `/fresh`                                | Slash command (TUI/headless) | Yes (provider-facing in-memory id/state only) | No; keeps current session file/header                                                      | None                                                                                |
| `/clear`                                | Interactive slash command    | Yes (clears live/model conversation context)  | No; retains session identity, metadata, transcript file, and full on-disk history          | Appends a durable `reset_boundary`                                                  |
| `/drop`                                 | Interactive slash command    | Yes (starts an empty conversation)            | Attempts to delete the current persisted session and artifacts, then switches to a new one | None                                                                                |
| `/fork`                                 | Interactive slash command    | Yes (active session identity changes)         | Creates new session file and switches current session to it (persistent mode only)         | Copies artifact directory to new session namespace when present                     |
| `--fork <id\|path>`                     | CLI startup                  | Yes after session creation                    | Creates a new session fork from the selected source into current cwd/session dir           | None                                                                                |
| `/resume [id\|@claude\|@codex]`         | Interactive slash command    | Yes (active in-memory state replaced)         | Switches to a selected/matched session, or imports a selected foreign session              | None                                                                                |
| `--resume`                              | CLI startup picker           | Yes after session creation                    | Opens selected existing session file                                                       | None                                                                                |
| `--resume <id\|path>`                   | CLI startup                  | Yes after session creation                    | Opens existing session; a missing recorded cwd may be re-rooted into the current directory | None                                                                                |
| `--continue`                            | CLI startup                  | Yes after session creation                    | Opens terminal breadcrumb or most-recent session; creates new one if none exists           | None                                                                                |

## Export and dump

### `/export [--themes] [outputPath]` (slash command)

Flow:

1. The builtin slash-command registry (`src/slash-commands/builtin-registry.ts`) parses the arguments with `parseExportArgs`; the TUI delegates the same command to `CommandController.handleExportCommand`.
2. `--themes` selects the configured dark/light TUI themes instead of the standalone web palette. After removing that flag, at most one whitespace-delimited path is accepted; extra tokens produce `Usage: /export [--themes] [path]`.
3. `AgentSession.exportToHtml()` calls `exportSessionToHtml(sessionManager, state, { outputPath, palette, themeNames })`.
4. The TUI shows the path and opens the file in a browser. Headless command execution prints the path without opening it.

Behavior details:

- `--copy`, `clipboard`, and `copy` arguments are explicitly rejected with a warning to use `/dump`.
- Export embeds session header/entries/leaf plus current `systemPrompt` and tool descriptions from agent state.
- Subagent transcripts stored next to the session file (`<session>/<AgentId>.jsonl`, recursively for nested spawns) are embedded as `subSessions` (`collectSubSessions` in `src/export/html/index.ts`; disable with `includeSubSessions: false` in `ExportOptions`). In the page, agent ids in task tool cards open a breadcrumbed sub-session overlay.
- Tool calls render through the `<omp-tool-view>` web component — the React per-tool renderers shared with collab-web (`packages/collab-web/src/tool-render/`), prebuilt into `src/export/html/tool-views.generated.js` by `bun run gen:tool-views`.
- No session entries are appended during export.

Caveat:

- Parsing is whitespace-based, so quoted paths with spaces are not preserved. Use a path without spaces.

### `--export <inputSessionFile> [outputPath]` (CLI)

Flow in `main.ts`:

1. Handled early (before interactive/session startup).
2. Calls `exportFromFile(inputPath, outputPath?)`.
3. `SessionManager.open(inputPath)` loads entries, then HTML is generated and written.
4. Process prints `Exported to: ...` and exits.

Behavior details:

- Missing input file surfaces as `File not found: <path>`.
- This path does not create an `AgentSession` and does not mutate any running session.

### `/dump` (clipboard/headless text export)

Flow:

1. The command calls `session.formatSessionAsText()`.
2. If it returns an empty string, the command reports `No messages to dump yet.`
3. Otherwise it also attempts `session.dumpLlmRequestToTmpDir()` and appends the resulting path to the transcript. The TUI copies the combined text to the clipboard; headless/ACP command execution returns it as command output.

Dump transcript content includes:

- System prompt
- Active model/thinking level
- Tool definitions + parameters
- User/assistant messages
- Thinking blocks and tool calls
- Tool results and execution blocks (except `excludeFromContext` bash/python entries)
- Custom/hook/file mention/branch summary/compaction summary entries

The best-effort JSON sidecar is named `omp-llm-request-<id>.json` under the OS temporary directory. It contains the current model, thinking level, service tier, system prompt, wire tool schemas, and LLM-converted messages. It persists after the command and can contain raw context or secrets; protect or remove it accordingly. A sidecar failure does not suppress the transcript (the TUI reports the failure; headless execution silently omits the path).

No session persistence entries are appended by dumping.

## Share

`/share` publishes an end-to-end encrypted snapshot of the session and prints
a viewer link. Implementation: [`../packages/coding-agent/src/export/share.ts`](../packages/coding-agent/src/export/share.ts).

### TUI phase 1: custom share handler (if present)

The interactive TUI's `loadCustomShare()` checks `~/.omp/agent` for the first existing candidate:

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
- Headless/ACP slash-command execution does not load custom share scripts; it always uses the default encrypted flow.

### Default encrypted share

For headless execution, or in the TUI only when no custom share handler is found, `shareSession()`:

1. Builds the session snapshot (`header`, `entries`, `leafId`, plus current
   `systemPrompt` and tool descriptions from agent state).
2. If `share.redactSecrets` is enabled (default) and the obfuscator has configured or regex-discovered secrets, a typed per-field redaction pass rewrites text-bearing header, prompt, tool, entry, sub-session, and message fields. Inline image bytes remain for the later size pass. Opaque provider replay fields and untyped extension payloads (`details`, `data`, `outputSchema`, compaction preserve data) are dropped rather than traversed.
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

## Fresh

Interactive `/fresh` resets the provider-facing stream state of the current
session **without touching the local transcript, session file, or header**. Use
it to recover from a wedged or corrupted provider stream (stale prompt cache,
a mid-turn glitch, or a server-side conversation id that has drifted) while
keeping the conversation you can see.

`AgentSession.freshSession()`:

- Is rejected while the agent is streaming — wait for the response to finish or
  abort it first.
- Closes every cached provider-session state entry (server-side conversation /
  prompt-cache handles) and reports how many were pruned.
- Mints a fresh provider session id and re-keys hindsight and mnemopi memory to
  it, and invalidates the append-only context so the next turn re-sends the full
  local transcript to the provider.
- Leaves the local transcript, session file, and session identity unchanged, so
  nothing you have said or received is lost.

Because it keeps both the visible and model-facing conversation, `/fresh`
differs from `/clear` (clear the live/model conversation in place), `/new`
(start a brand-new empty session), and `/drop` (attempt to delete the current
session and start a new one). Only `/fresh` preserves the existing conversation
while giving the provider stream state a clean slate.

## Clear

Interactive `/clear` clears the current conversation context in place. It is
available only in the TUI and is rejected while a response is streaming or a
foreground bash/Python execution is running. If compaction is active, the
command aborts it and waits for it to stop before resetting.

`AgentSession.resetSessionContext()`:

- Drops live messages, queued steer/follow-up turns, pending tool calls, error
  state, checkpoint/rewind and deferred tool state, and session-stop
  continuation state. It also cancels this agent's queued continuation work and
  async bash/task jobs.
- Rotates provider-side session state, re-primes advisors, invalidates
  append-only model context, and resets memory promotion so the next turn
  rebuilds from the base system prompt and current project instructions.
- Retains the session id, title, cwd, model, settings, active plan path, and
  transcript file.
- Appends a durable `reset_boundary`. The collapsed live transcript and rebuilt
  model context begin after the latest boundary, while the JSONL transcript and
  full-transcript export retain the pre-reset history on disk.

The TUI clears its rendered transcript after a successful clear. This differs
from `/fresh`, which rotates provider stream state without clearing the
conversation; `/new`, which creates a new session identity and transcript file;
and `/drop`, which attempts to delete the old persisted session before starting
a new one.

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
5. Updates `agent.sessionId` and inherits the previous provider prompt-cache key unless an explicit prompt-cache key is already pinned.
6. Emits `session_switch` with `reason: "fork"`.

`SessionManager.fork()` behavior:

- Requires persistent mode and existing session file.
- Creates new session id and new JSONL file path.
- Rewrites header with:
  - new `id`
  - new timestamp
  - `cwd` unchanged
  - `parentSession` set to previous session id
  - `providerPromptCacheKey` set to the previous header's inherited key, or the previous session id when none was pinned
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
5. Full-context forks automatically seed `providerPromptCacheKey` from the source header's inherited key, falling back to the source session id. Startup drops that automatic inheritance when `--model`, `--thinking`, `--system-prompt`, `--append-system-prompt`, `--tools`, or `--no-tools` changes the provider route or prompt/tool shape.

Use `--prompt-cache-key <key>` to pin the provider prompt-cache identity explicitly and independently from both the OMP session id and `--provider-session-id`. `--provider-session-id` continues to control provider session/routing headers and sticky credential selection; `--prompt-cache-key` controls the OpenAI Responses `prompt_cache_key` payload where supported.

## Resume and continue

## Interactive `/resume [value]`

Without an argument:

1. Opens the session selector populated via `SessionManager.list(currentCwd, currentSessionDir)`.
2. The picker starts in current-folder scope; Tab toggles to all-projects scope, lazily loading and caching `SessionManager.listAll()`.
3. On selection, `SelectorController.handleResumeSession(sessionPath)` calls `session.switchSession(sessionPath)`. If the switch is rejected, it returns `false` and the selector stops without applying the new-session UI state.
4. After a successful switch, UI clears/rebuilds chat and todos, then reports `Resumed session` (or `Resumed session in <dir>` when the resumed session belongs to another project, in which case the process cwd and cwd-derived caches are re-pointed via `applyCwdChange`).

With an argument:

- `/resume <id>` resolves an id/filename prefix with local-first, then global fallback and switches directly to the matched file; an unknown value reports `Session "<value>" not found`.
- `/resume @claude` and `/resume @codex` open a foreign-session picker. Selecting one converts and persists it under a fresh OMP session identity, then switches to that new session.

## CLI `--resume`

### `--resume` (no value)

- `main.ts` lists sessions for the current cwd/sessionDir and opens the picker in current-folder scope. When that list is empty it preloads `SessionManager.listAll()` so a user-initiated Tab switch to all-projects scope is immediate; it does not auto-switch scopes. `No sessions found` is printed only when the global list is also empty.
- Selected path is opened with `SessionManager.open(selectedPath)` before session creation. Selecting a session from another project first switches the process into that project's directory and reloads cwd-scoped settings/caches.

### `--resume <value>`

`createSessionManager()` resolution order:

1. If value looks like path (`/`, `\`, or `.jsonl`), open directly.
2. Else `resolveResumableSession(...)` searches:
   - current scope (`SessionManager.list(cwd, sessionDir)`)
   - global sessions (`SessionManager.listAll()`) only when no explicit `sessionDir` was provided
3. Matching accepts case-insensitive session id prefixes, full JSONL filename prefixes, and the id suffix after the timestamp in `<timestamp>_<sessionId>.jsonl`.

Cross-project id match behavior:

- If the matched session's recorded directory no longer exists, CLI asks `Session's directory no longer exists (...). Move (re-root) it into the current directory? [Y/n]`.
  - On yes (default), `SessionManager.open(match.path)` followed by `manager.moveTo(cwd)` re-roots the existing session into the current directory without duplicating it.
  - On no, startup is cancelled. In non-TTY mode, startup fails with an error directing the user to run interactively.
- If the recorded directory still exists, the matched session is opened directly. Startup later changes the process/project scope to the resumed session's cwd and reloads cwd-scoped settings and plugin caches. It is not implicitly forked.

## CLI `--continue`

`SessionManager.continueRecent(cwd, sessionDir)`:

1. Resolves the session directory for the current cwd.
2. Reads the terminal-scoped breadcrumb. If it points into a nested artifact/subagent session, resolution walks up to the top-level interactive parent session (up to eight levels).
3. If the breadcrumb points at a session recorded under a different cwd whose directory no longer exists **and** the current directory has no sessions of its own, re-roots that session into the current directory via `moveTo` instead of starting fresh.
4. Otherwise, if the breadcrumb's cwd matches the current cwd, uses the breadcrumb session; else falls back to the most recently modified session file.
5. Opens the found session; if none exists, creates a new session.

For compatibility, `--continue <full-UUID>` is normalized to `--resume <UUID>` when the UUID is the sole positional message. The `autoResume` setting invokes the same `continueRecent` behavior when no explicit session flag/session directory is supplied, and restores session model/thinking state when a prior transcript was found.

This is startup-only behavior; there is no interactive `/continue` slash command.

## How session switching actually mutates runtime state

`AgentSession.switchSession(sessionPath)` does the runtime transition used by resume-like operations:

1. Emit `session_before_switch` with `reason: "resume"` and `targetSessionFile` (cancellable).
2. Disconnect the agent event subscription, abort in-flight work, and run the optional pre-switch reconciler.
3. Flush pending bash/session writes and capture rollback state: session manager state; agent messages and all queues; model/thinking/service tiers; tools and prompts; provider/cache ids; memory promotion; and checkpoint rewind state.
4. Clear agent and next-turn queues. For a different file, drain/detach advisor recorders.
5. `sessionManager.setSessionFile(sessionPath)`, update provider-cache/session ids and memory keys, build the display context, and rehydrate checkpoint state.
6. Emit `session_switch` with `reason: "resume"`.
7. Replace agent messages, reset advisor state, and synchronize todos. Close cached provider sessions for a different file, or for a same-file reload whose replay messages changed.
8. Restore an available persisted model. If the loaded branch ended with an interrupted turn, append its synthetic abort message and rebuild context.
9. Restore configured/effective thinking and per-family service tiers, falling back to current settings when the target branch has no corresponding entries.
10. For a different transcript, reset memory context; for any conversation rewrite, clear session-scoped tool state.
11. Reconnect agent events, run the optional session-switch reconciler (interactive mode uses it to re-enter persisted modes such as plan), and best-effort refresh the workspace-root system-prompt block. Reconciler/prompt-refresh errors are logged rather than rolling back the committed switch.
12. Restore target advisor cost state, finish the bash transition, notify session-change callbacks when the session id changed, and return `true`.
`switchSession()` returns `false` when a before-switch hook cancels or cwd policy rejects the transition. A cross-project switch without a cwd-change callback is rejected rather than silently adopting the target cwd; callback rejection is also cancellation. The interactive selector checks this result and leaves the existing session/UI unchanged.

If a throwing step in the guarded transition fails, `switchSession()` restores the captured session, agent queues/messages, tools/prompts, model/thinking/service-tier, provider/cache, memory, and checkpoint state; it reconnects the prior agent subscription and re-runs mode reconciliation before rethrowing.

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
When a before-switch hook cancels, `switchSession()` returns `false` and does not emit the after-switch event.

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
- Cross-project `--resume <id>` can be cancelled by declining the missing-directory move/re-root prompt.
- `/share` has a UI abort path (`Share cancelled`); the upload itself is not killed mid-flight.

## Non-persistent (in-memory) session behavior

When session manager is created with `SessionManager.inMemory()` (`--no-session`):

- Session file path is absent.
- `/export` fails with `Cannot export in-memory session to HTML` (propagated to command error UI). `/share` still works: the snapshot is built from live entries.
- `/fork` fails because `SessionManager.fork()` requires persistence.
- `/dump` still works because it serializes in-memory agent state.
- CLI resume/continue semantics are bypassed if `--no-session` is set, because manager creation returns in-memory immediately.

## Known implementation caveats (as of current code)

- `/share` custom-share failures do not degrade to the default encrypted share flow; they terminate the TUI command with an error.
- `/export` argument tokenization does not preserve quoted paths with spaces.
- `/drop` treats deletion as best-effort: it attempts to delete the current
  session JSONL and artifact directory, logs any deletion failure, and still
  creates and switches to a new session. A failed or partial deletion can leave
  the old session or its artifacts on disk, so `/drop` is not a guaranteed
  erasure boundary.
