# bash

> Execute a shell command in the session workspace, with optional PTY or background-job handling.

## Source
- Entry: `packages/coding-agent/src/tools/bash.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/bash.md`
- Key collaborators:
  - `packages/coding-agent/src/tools/bash-interactive.ts` — PTY/TUI execution path.
  - `packages/coding-agent/src/tools/bash-interceptor.ts` — blocks tool-better shell patterns.
  - `packages/coding-agent/src/tools/bash-skill-urls.ts` — expands internal URLs to paths.
  - `packages/coding-agent/src/tools/bash-command-fixup.ts` — strips trailing `| head`/`| tail` pipes and redundant `2>&1` (thin wrapper over native `pi_shell::fixup`).
  - `packages/coding-agent/src/tools/bash-pty-selection.ts` — `canUseInteractiveBashPty()` decides whether a call may use the local PTY overlay.
  - `packages/coding-agent/src/tools/gh-cache-invalidation.ts` — drops `github-cache` rows for mutating `gh issue`/`gh pr` subcommands.
  - `packages/coding-agent/src/exec/bash-executor.ts` — non-PTY shell execution.
  - `packages/coding-agent/src/session/streaming-output.ts` — tail buffer, truncation, artifact spill.
  - `packages/coding-agent/src/tools/tool-timeouts.ts` — timeout clamp bounds.
  - `packages/coding-agent/src/config/settings-schema.ts` — default interceptor rules.
  - `docs/bash-tool-runtime.md` — deeper executor/runtime notes; use as the companion doc for shell-session internals.

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `command` | `string` | Yes | Shell command text to execute. A leading `cd <path> && ...` is rewritten into `cwd` only when `cwd` was omitted. |
| `env` | `Record<string, string>` | No | Extra environment variables. Keys must match `^[A-Za-z_][A-Za-z0-9_]*$` or the tool throws. Values go through internal-URL expansion and are passed as environment values, not shell text. |
| `timeout` | `number` | No | Timeout in seconds. Default `300`; clamped to `1..3600` by `clampTimeout("bash", ...)`. |
| `cwd` | `string` | No | Working directory, resolved against `session.cwd` via `resolveToCwd`. Must exist and be a directory. |
| `pty` | `boolean` | No | Request PTY mode. Default `false`. PTY is used only when `pty: true`, `PI_NO_PTY !== "1"`, and the tool context has a UI. |
| `async` | `boolean` | No | Background execution request. Present only when `async.enabled` is true for the session. Returns immediately with a job id instead of waiting. |

## Outputs
The tool returns a single `text` content block plus optional `details`.

- Success, foreground:
  - `content[0].text`: command output, or `(no output)` when the command produced nothing.
  - `details.timeoutSeconds`: effective timeout after clamping.
  - `details.requestedTimeoutSeconds`: present when the requested timeout differed from the effective timeout.
  - `details.wallTimeMs`: elapsed wall-clock milliseconds for completed local/client-terminal runs.
  - `details.terminalId`: present when execution was routed through a client terminal bridge.
  - `details.exitCode`: present when the command completed with a non-zero exit code.
  - `details.meta.truncation`: present when output was truncated in memory; includes `artifactId` when full output spilled to an artifact.
  - non-zero exits return a tool result marked `isError` with output plus `Command exited with code <n>`; they are not thrown.
- Success, background start (`async: true` or auto-background):
  - `content[0].text`: optional preview tail, timeout notice if any, then `Background job <id> started: <label>` with follow-up instructions.
  - `details.async`: `{ state: "running", jobId, type: "bash" }`.
- Background progress / completion:
  - delivered through `onUpdate` / async job manager, not the initial return.
  - running updates contain tail text and `details.async.state: "running"` only after the job is considered backgrounded.
  - completion/failure updates carry final text and `details.async.state: "completed" | "failed"`. A non-zero exit is recorded as a failed background job.
- Failure:
  - unfinished execution (`cancelled`, timeout, missing exit status), validation failures, and intercepted commands throw `ToolError` / `ToolAbortError`.

Stdout and stderr are merged before the model sees them. Definite non-zero exit codes are appended to the returned error result text as `Command exited with code <n>`.

## Flow
1. `BashTool.execute()` in `packages/coding-agent/src/tools/bash.ts` reads `command`, normalizes `env`, and defaults `timeout` to `300`. When `bash.stripTrailingHeadTail` is enabled (default), `applyBashFixups()` from `packages/coding-agent/src/tools/bash-command-fixup.ts` first strips safe trailing `| head`/`| tail` pipes and redundant trailing `2>&1` from single-line commands.
2. If `cwd` is absent, it rewrites a leading `cd <path> && ...` into the structured `cwd` field and strips that prefix from `command`.
3. If `async: true` is requested while `async.enabled` is off, it throws `ToolError` before any execution.
4. If `bashInterceptor.enabled` is on, `checkBashInterception()` runs against both the original command and the `cd`-stripped command. A matching enabled rule throws before URL expansion or execution.
5. `expandInternalUrls()` rewrites supported internal URLs inside `command`, each `env` value, and protocol-looking `cwd` values. Command replacements are shell-escaped; `env` and `cwd` replacements use raw filesystem/string values because they are not interpolated into shell text.
6. `resolveToCwd()` resolves `cwd` against `session.cwd`; `fs.stat()` verifies that the target exists and is a directory.
7. `clampTimeout("bash", requestedTimeoutSec)` enforces `TOOL_TIMEOUTS.bash` (`default: 300`, `min: 1`, `max: 3600`). When clamped, `#buildCompletedResult()` / `#buildBackgroundStartResult()` append a notice line.
8. Execution path splits:
   1. `async: true` -> `#startManagedBashJob()` registers a session async job and returns immediately.
   2. Non-PTY with `bash.autoBackground.enabled`, an async job manager below its running-job cap, and no client-terminal bridge available (the bridge wins when both apply) -> starts a managed job, waits up to `min(thresholdMs, timeoutMs - 1000)`, and either returns the completed result or converts the run into a background job.
   3. Non-PTY client-terminal bridge, when the session advertises terminal capability and `pty` is false -> creates a remote terminal, streams/polls current output, and releases the terminal after completion.
   4. Otherwise runs foreground execution.
9. Foreground non-PTY without client terminal calls `executeBash()` from `packages/coding-agent/src/exec/bash-executor.ts`.
10. Foreground PTY calls `runInteractiveBashPty()` from `packages/coding-agent/src/tools/bash-interactive.ts`.
11. Local non-PTY and PTY paths allocate an output artifact first when `session.allocateOutputArtifact` is available. The artifact path/id are passed into the sink so large output can spill to disk.
12. `executeBash()` loads shell settings, optional shell snapshot, and shell minimizer settings, then runs via a persistent native `Shell` session or one-shot `executeShell()`. `docs/bash-tool-runtime.md` covers that path in detail.
13. `runInteractiveBashPty()` creates a `PtySession`, overlays an xterm-backed console UI, forwards user key input into the PTY, captures output through `OutputSink`, and kills the PTY on dismiss/dispose.
14. Client-terminal bridge mode calls `session.getClientBridge().createTerminal(...)`, emits `terminalId` updates, polls output until exit/timeout/abort, maps signal exits to `137`, and releases the handle in `finally`.
15. On completion, `#buildCompletedResult()` formats `(no output)` when needed, attaches truncation metadata from the output summary, appends wall-time/timeout/exit notices, and re-checks unfinished status before returning.
16. On timeout, missing exit status, or cancellation, the tool throws with captured output included when available.

## Modes / Variants
1. Foreground non-PTY local
   - Default path when no client terminal bridge is available.
   - Uses `executeBash()`.
   - Streams tail-only updates through `streamTailUpdates()` and `TailBuffer(DEFAULT_MAX_BYTES)`.
2. Foreground non-PTY client terminal
   - Used when `session.getClientBridge()?.capabilities.terminal` is true, `createTerminal` exists, and `pty` is false.
   - Streams current terminal output via polling updates with `details.terminalId`.
   - Enforces the same timeout and abort behavior, then releases the terminal handle.
3. Foreground PTY
   - Requires `pty: true`, UI context, and `PI_NO_PTY !== "1"`.
   - Uses `runInteractiveBashPty()` and a `PtySession` overlay.
   - Supports interactive input; `Esc` kills the session from the overlay.
4. Explicit background job
   - Requires `async: true` and `async.enabled`.
   - Registers a job with `session.asyncJobManager` and returns `{ state: "running", jobId }` immediately.
5. Auto-backgrounded non-PTY job
   - Requires `bash.autoBackground.enabled`, no PTY, and an async job manager.
   - Starts like a foreground managed job, then backgrounds it when it outlives the wait window.
6. Intercepted command
   - No subprocess created.
   - Returns a `ToolError` pointing the model at `read`, `grep`, `glob`, `edit`, or `write`.

## Side Effects
- Filesystem
  - Validates `cwd` with `fs.stat()`.
  - May allocate and write artifact files for full local output (`bash`) and minimizer-preserved raw output (`bash-original`).
  - `expandInternalUrls(..., { ensureLocalParentDirs: true })` creates parent directories for `local://` paths before execution.
- Subprocesses / native bindings / client terminal
  - Non-PTY local execution uses native shell execution via `@pk-nerdsaver-ai/pi-natives` (`Shell.run()` or `executeShell()`).
  - PTY uses native `PtySession.start()`.
  - Client-terminal mode delegates process execution to the connected client terminal capability.
- Session state
  - Reads session settings for async, auto-background, interceptor, tool availability, and shell configuration.
  - Registers jobs with `session.asyncJobManager` for explicit/auto background runs.
  - Uses `session.getSessionId()` to isolate shell reuse and async session keys.
  - Uses `session.allocateOutputArtifact()` for spill files.
  - Invalidates `github-cache` rows before execution when the command contains a mutating `gh issue`/`gh pr` subcommand, so later `issue://`/`pr://` reads see post-mutation state (`invalidateGithubCacheForBashCommand`).
- User-visible prompts / interactive UI
  - PTY mode opens a TUI overlay titled `Console` and forwards input to the PTY.
  - Background start messages note that the result is delivered automatically when complete and that the `job` tool can poll until then.
- Background work / cancellation
  - Async and auto-background jobs continue after the initial tool return.
  - Cancellation aborts the native run; PTY overlay dismissal also kills the PTY.

## Limits & Caps
- Default timeout: `300s` (`TOOL_TIMEOUTS.bash.default` in `packages/coding-agent/src/tools/tool-timeouts.ts`).
- Timeout clamp: `1..3600s` (`TOOL_TIMEOUTS.bash.min/max`).
- Auto-background default threshold: `60_000ms` (`DEFAULT_AUTO_BACKGROUND_THRESHOLD_MS` in `packages/coding-agent/src/tools/bash.ts`), further capped to `timeoutMs - 1000` by `#resolveAutoBackgroundWaitMs()`.
- Non-PTY executor timeout: `executeBash()` arms a host-side timer at `max(1_000, timeoutMs)` that aborts the run and quarantines the persistent shell session; the same timeout is also passed to the native run as `timeoutMs` (`packages/coding-agent/src/exec/bash-executor.ts`).
- In-memory output tail cap: `50 * 1024` bytes (`DEFAULT_MAX_BYTES` in `packages/coding-agent/src/session/streaming-output.ts`). Once exceeded, the sink keeps only the tail window in memory.
- Streaming callback throttle in `executeBash()`: `50ms` between `onChunk` calls when streaming is enabled.
- TUI collapsed preview: `10` visual lines (`BASH_DEFAULT_PREVIEW_LINES`) when rendered inline in the agent UI; this is a renderer cap, not a tool output cap.

## Errors
- Input validation:
  - invalid env key -> `ToolError("Invalid bash env name: <key>")`.
  - async requested while disabled -> `ToolError("Async bash execution is disabled...")`.
  - missing async job manager -> `ToolError("Async job manager unavailable for this session.")`.
  - missing/bad `cwd` -> `ToolError("Working directory does not exist: ...")` or `ToolError("Working directory is not a directory: ...")`.
- Interceptor:
  - matched command -> `ToolError` with `Blocked: <rule.message>` and the original command.
  - invalid interceptor regexes are silently skipped by `compileRules()`.
- Internal URL expansion:
  - unsupported scheme, unknown skill, path traversal, missing router support, or router resolution failures all throw `ToolError` from `packages/coding-agent/src/tools/bash-skill-urls.ts`.
- Execution:
  - non-zero exit -> returned tool result marked `isError`, with `details.exitCode` and text ending in `Command exited with code <n>`.
  - missing exit code -> thrown `ToolError` with `Command failed: missing exit status`.
  - timeout -> thrown `ToolError`; PTY/client-terminal modes use `Command timed out after <n> seconds`, non-PTY executor returns cancelled output that `BashTool` converts to an error.
  - user abort -> `ToolAbortError` when the caller signal is aborted.
- Artifact allocation / artifact save failures are swallowed in `saveBashOriginalArtifact()` and `OutputSink.#createFileSink()`; execution continues without that artifact.

## Notes
- `strict = true` is set on `BashTool`; `concurrency` is resolved per call: `pty: true` is `"exclusive"` (it takes over the terminal UI), everything else is `"shared"`, so multiple non-pty bash calls in one assistant message run in parallel. When parallel calls overlap on the same shell session key, the first owns the persistent `Shell`; the rest run in isolated one-shot shells (see `shellSessionsInUse` in `bash-executor.ts`).
- `command` URL expansions shell-escape replacements; `env` and `cwd` expansion use `noEscape: true` because they become environment values / filesystem paths, not shell text.
- `checkBashInterception()` blocks only when the matching rule's `tool` name is present in `ctx.toolNames`; missing tools disable their corresponding rule.
- Default interceptor rules come from `DEFAULT_BASH_INTERCEPTOR_RULES` in `packages/coding-agent/src/config/settings-schema.ts`:
  - `cat|head|tail|less|more` -> `read`
  - `grep|rg|ripgrep|ag|ack` -> `grep`
  - `find|fd|locate` with name/type/glob flags -> `glob`
  - `sed -i`, `perl -i`, `awk -i inplace` -> `edit`
  - `echo|printf|cat <<` with redirection -> `write`
- PTY mode is ignored in non-UI contexts and when `PI_NO_PTY=1` (gated by `canUseInteractiveBashPty()`); the tool falls back to non-PTY execution and appends a `pty requested but unavailable in this environment; ran without a terminal` notice.
- Non-PTY runs merge `NON_INTERACTIVE_ENV` with `env` via `buildNonInteractiveEnv()`; PTY runs instead inherit the user environment with `TERM=xterm-256color` prepended before the custom `env` values.
- When the shell minimizer rewrites output inside `executeBash()`, the visible output is replaced with minimized text and a `[raw output: artifact://<id>]` footer may be appended if `onMinimizedSave` persisted the original text.
- The TUI renderer parses partial JSON to recover `env` assignments early in streaming previews; that behavior is display-only.
- For executor internals that are not tool-specific — shell session reuse keys, snapshots, prefix handling, and native timeout behavior — see `docs/bash-tool-runtime.md`.
