# bash

> Execute a shell command in the session workspace, with optional PTY, background-job handling, or supervised service mode.

## Source
- Entry: `packages/coding-agent/src/tools/bash.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/bash.md`
- Key collaborators:
  - `packages/coding-agent/src/tools/bash-interactive.ts` — PTY/TUI execution path.
  - `packages/coding-agent/src/tools/bash-interceptor.ts` — blocks tool-better shell patterns.
  - `packages/coding-agent/src/internal-urls/url-filesystem.ts` — router-backed shell filesystem for `scheme://` paths.
  - `packages/coding-agent/src/tools/bash-pty-selection.ts` — `canUseInteractiveBashPty()` decides whether a call may use the local PTY overlay.
  - `packages/coding-agent/src/tools/gh-cache-invalidation.ts` — drops `github-cache` rows for mutating `gh issue`/`gh pr` subcommands.
  - `packages/coding-agent/src/tools/bash-worktree-rewrite.ts` — optional `git worktree add` clone rewrite.
  - `packages/coding-agent/src/launch/services.ts` — named-service validation and launch-broker calls.
  - `packages/coding-agent/src/exec/bash-executor.ts` — non-PTY shell execution.
  - `packages/tui/src/tools/streaming-output.ts` — streaming buffer, truncation, artifact spill.
  - `packages/coding-agent/src/tools/tool-timeouts.ts` — timeout clamp bounds.
  - `packages/coding-agent/src/exec/settings.ts` — default interceptor rules.
  - `docs/bash-tool-runtime.md` — deeper executor/runtime notes; use as the companion doc for shell-session internals.

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `command` | `string` | Yes | Shell command text to execute. A leading `cd <path> && ...` is rewritten into `cwd` only when `cwd` was omitted. |
| `timeout` | `number` | No | Timeout in seconds. Default `300`. `0` disables the deadline. Nonzero values (including the default) are capped by a positive `tools.maxTimeout`, then clamped to `1..3600`. |
| `cwd` | `string` | No | Working directory, resolved against `session.cwd` via `resolveToCwd`, or a registered internal URL directory for embedded-shell execution. Must exist and be a directory. |
| `pty` | `boolean` | No | Request PTY mode. Default `false` for finite commands, `true` for named services. Foreground PTY requires a UI and `PI_NO_PTY !== "1"`; named services forward this setting to the broker. |
| `async` | `boolean` | No | Background execution request. Present only when `async.enabled` is true for the session. Returns immediately with a job id instead of waiting; it does not change the effective deadline, including a disabled deadline from `timeout: 0`. |
| `name` | `string` | No | Project-unique supervised service name: 1–48 letters, numbers, dots, underscores, or hyphens, starting with a letter or number. Present only when `launch.enabled` and Bash is active. Blank names select finite-command mode. A live name restarts using the new spec. Incompatible with `async: true` or any supplied `timeout`. |
| `ready` | `{ log?: string; port?: number; host?: string; timeout?: number }` | No | Service readiness requires a nonblank log regex and/or integer TCP port `1..65535`; all supplied conditions must pass. Host defaults to `127.0.0.1`, timeout to 30 seconds (clamped to `0.05..3600`). Without `name`, a nonempty spec is ignored with a notice. |

There is no `env` input. Named services inherit the configured shell environment; put command-specific assignments in `command`.

Without `name`, `pty`, or a client terminal, commands run in the embedded POSIX-compatible brush shell, even when `shellPath` points to PowerShell or another external shell. `shellPath` selects the external shell for named services, supported terminal routes, and interactive `!` commands; a bash path may still supply environment and rc snapshots to the embedded session. To use PowerShell syntax in a plain tool call, invoke `pwsh -Command '...'` explicitly, quoting so brush preserves PowerShell's `$` variables.

Named service example:
```json
{"command":"python3 -m http.server 8765","name":"web","ready":{"port":8765}}
```

## Outputs
The tool returns a `text` content block plus optional `details` and image blocks decoded from terminal graphics.

- Success, foreground:
  - `content[0].text`: command output, or `(no output)` when the command produced nothing.
  - `details.timeoutSeconds`: effective positive timeout after global/per-tool clamping, or `details.timeoutDisabled: true` when `timeout: 0`.
  - `details.requestedTimeoutSeconds`: present when the requested/default timeout differs from the effective timeout, including `0` when the deadline is disabled.
  - `details.wallTimeMs`: elapsed wall-clock milliseconds for completed local/client-terminal runs.
  - `details.terminalId`: present in streaming updates when execution is routed through a client terminal bridge; not retained in the completed result.
  - `details.exitCode`: present when the command completed with a non-zero exit code.
  - `details.timedOut: true`: present on local, PTY, and client-terminal timeout results.
  - `details.meta.truncation`: present when output was truncated in memory; includes `artifactId` when full output spilled to an artifact.
  - non-zero exits and timeouts return a tool result marked `isError`; definite non-zero output ends with `Command exited with code <n>`.
- Success, background start (`async: true` or auto-background):
  - `content[0].text`: optional preview tail and notices, followed by `Backgrounded as job <id> (killed once it has run <n>s in total; …)` — or `(no deadline)` under `timeout: 0` — and the no-polling instruction (`formatBackgroundNotice` in `packages/tui/src/tools/bash.ts`), so the model sees the job's deadline before it waits on the result. The deadline counts from job start, so an auto-backgrounded command has already spent its foreground wait.
  - `details.async`: `{ state: "running", jobId, type: "bash" }`.
  - `read proc://` lists owned jobs and project services; `read proc://<id>` inspects status/output without consuming result delivery; `write proc://<id>/kill` cancels the job without requiring `content`.
- Success, named service (`name`): executes `command` through the user's shell under the launch broker, returning readiness, exit, or readiness timeout with state and log tail. A live name is stopped and restarted with the new spec; exit notifications still auto-deliver. `read proc://<name>` inspects status/logs; `write proc://<name>` sends stdin (appends Enter unless content already ends with newline, including empty content); `write proc://<name>/kill` stops it. `write proc://<name>/mode` accepts `persist`, `session`, or `detached`.
- Background progress / completion:
  - delivered through `onUpdate` / async job manager, not the initial return.
  - running updates contain tail text and `details.async.state: "running"` only after the job is considered backgrounded.
  - completion/failure updates carry final text and `details.async.state: "completed" | "failed"`. A non-zero exit or timeout is recorded as a failed background job.
- Failure:
  - cancellation, missing exit status, validation failures, and intercepted commands throw `ToolError` / `ToolAbortError`; timeouts return an error result.

Stdout and stderr are merged before the model sees them. Definite non-zero exit codes are appended to the returned error result text as `Command exited with code <n>`.

## Command policy and dedicated-tool routing

Two independent settings can prevent a Bash subprocess from starting. They serve different purposes and run at different points in the tool-call lifecycle.

| Setting | Purpose | Rule syntax | Result when matched |
| --- | --- | --- | --- |
| `bash.patterns` | Command-specific execution policy | Literal text with `*` wildcards | Allows the call, requests human approval, or denies it. |
| `bashInterceptor.patterns` | Prefer a dedicated tool over Bash | JavaScript regular expression, optional flags, tool name, and message | Returns a Bash tool error telling the model to call the named dedicated tool instead. |

### `bash.patterns`: permission policy

`bash.patterns` is for commands that must be allowed, confirmed by a person, or refused regardless of whether another tool could perform the work. Rules are ordered; the first matching rule wins. Each rule has a `match` glob and an `approval` value of `allow`, `prompt`, or `deny`. Whitespace runs in both the glob and the command collapse to a single space before matching, so a newline in a glob matches any whitespace (`"*\n*"` behaves like `"* *"`).

```yaml
bash:
  patterns:
    - match: "git *"
      approval: allow
    - match: "curl *"
      approval: prompt
    - match: "rm -rf *"
      approval: deny
```

- `deny` stops the call before `BashTool.execute()` runs, including in `yolo` mode.
- `prompt` displays an approval request. Only an accepted request proceeds to `BashTool.execute()`.
- By default, `allow` can lower the approval tier for a simple command, but cannot approve a compound command. For example, `match: "git *"` does not approve `git status && rm -rf build`.
- With `bash.allowCompoundCommands: true` (default `false`) and a configured POSIX shell, literal `&&` chains are evaluated per command. Every segment needs an `allow` rule to allow the chain; an unmatched segment retains normal exec-tier approval. Segment rules remain first-match-wins, any segment or chain-wide deny wins, and prompts are retained. Expansions, other shell operators, and critical command patterns do not gain an allow bypass.
- `deny` and `prompt` check the complete command and each shell command segment. A rule such as `match: "rm -rf *"` therefore catches `cd /tmp && rm -rf build`.

Use this setting for safety and user control. It remains useful for commands with no appropriate replacement tool, such as destructive removal, network access, deployment scripts, or project-specific scripts.

### `bashInterceptor.patterns`: dedicated-tool routing

`bashInterceptor` is an opt-in routing layer (`bashInterceptor.enabled` defaults to `false`). It is for commands that are technically valid Bash but are better expressed through an available dedicated tool. Each pattern is a regular expression and includes the name of that replacement tool and the explanation shown to the model.

```yaml
bashInterceptor:
  enabled: true
  patterns:
    - pattern: '^\s*(cat|head|tail)\s+'
      tool: read
      message: "Use the read tool instead; it handles binary files and provides better context."
    - pattern: '^\s*(grep|rg)\s+'
      tool: grep
      message: "Use the grep tool instead; it respects .gitignore and returns structured results."
```

An interceptor rule only applies when its `tool` is available in the current session. If `read` is disabled, a `cat` rule targeting `read` does not block the Bash call. This makes the interceptor a best-effort capability preference rather than an execution-security boundary.

The built-in default rules route common operations such as `cat` to `read`, `rg` to `grep`, in-place `sed` to `edit`, shell redirection to `write`, and unmanaged services/watchers to named `bash` service mode. See `DEFAULT_BASH_INTERCEPTOR_RULES` in `packages/coding-agent/src/exec/settings.ts` for the complete list.

For compatibility with existing custom regexes, the interceptor always checks the complete original command first. It then checks raw, flat command fragments separated by unquoted and unescaped `&&`, `||`, `;`, `|`, `&`, or newlines. It also checks fragments after leading environment assignments are removed:

```bash
git add file && git commit -m "message"
GIT_AUTHOR_NAME=Dev git commit -m "message"
```

An anchored rule such as `^\s*git\s+commit\b` can therefore match the `git commit` command in both examples. A stage that consumes another command's stdout through an unquoted `|` or `|&` (for example `grep x` in `printf 'x\n' | grep x`) is **not** treated as an interception candidate: it reads piped stdin, which the path-based dedicated tools cannot supply, so only a standalone or first-stage command is matched. Blank and comment-only continuation lines after the pipe preserve that context. Quoted, escaped, and commented text is not treated as a command. Heredocs, parameter expansion, command substitution, backticks, grouping, and malformed quoting retain only the complete-command check; the interceptor deliberately does not attempt to become a full shell parser.

### Interaction and selection guide

The approval policy is resolved before execution. A matching `bash.patterns` `deny` never reaches the interceptor. A matching `prompt` reaches the interceptor only after the user accepts the approval request. If an accepted call then matches an interceptor rule, the Bash call still does not run; the model receives the routing error and should invoke the dedicated tool.

Avoid configuring the same operation in both places unless that two-step behavior is intended. For example, a `prompt` rule for `cat *` plus an enabled `cat`-to-`read` interceptor first asks the user to approve Bash, then rejects Bash and asks the model to use `read`.

Choose the setting by the desired outcome:

- Use `bash.patterns` when the question is **whether the command may execute**.
- Use `bashInterceptor.patterns` when the question is **which tool should perform the operation**.

## Flow

1. `BashTool.execute()` in `packages/coding-agent/src/tools/bash.ts` reads `command`. A `name` selects supervised service mode (through the user's shell and launch broker); normal Bash execution defaults `timeout` to `300`.
2. If `cwd` is absent, it rewrites a leading `cd <path> && ...` into the structured `cwd` field and strips that prefix from `command`.
3. If `async: true` is requested while `async.enabled` is off, it throws `ToolError` before any execution.
4. If `bashInterceptor.enabled` is on, `checkBashInterception()` runs against both the original command and the `cd`-stripped command. For each form, configured regexes still check the complete input first, then each flat command separated by unquoted/unescaped `&&`, `||`, `;`, `|`, `|&`, `&`, or newlines (excluding stages that consume piped stdin from `|` or `|&`, including across blank/comment continuations), followed by versions of those fragments without leading `NAME=value` assignments. A matching enabled rule throws before execution.
5. When `worktree.clone` is enabled, recognized literal `git worktree add` commands are rewritten to the clone-backed worktree helper. GitHub cache invalidation then runs. A per-run `InternalUrlFilesystem` is injected into the native shell so `scheme://` paths resolve at operation time.
6. A host `cwd` resolves against `session.cwd` and `fs.stat()` verifies it is a directory; a URL `cwd` is checked through the URL filesystem and handed to the shell as-is (service and PTY modes refuse it).
7. Named services dispatch before finite-command timeout handling, default PTY to `true`, and use `ready.timeout` only for readiness. For finite commands, `timeout: 0` disables the deadline; otherwise `clampTimeout("bash", requestedTimeoutSec, tools.maxTimeout)` applies a positive global ceiling, then `TOOL_TIMEOUTS.bash` (`min: 1`, `max: 3600`). Clamping adds a notice line.
8. Execution path splits:
   1. `async: true` -> `#startManagedBashJob()` registers a session async job and returns immediately.
   2. Non-PTY with `bash.autoBackground.enabled`, an async job manager below its running-job cap, and no client-terminal bridge available (the bridge wins when both apply) -> starts a managed job, waits up to `min(thresholdMs, max(0, timeoutMs - 1000))` when a deadline exists, and either returns the completed result or converts the run into a background job.
   3. Non-PTY client-terminal bridge, when the session advertises terminal capability and `pty` is false -> creates a remote terminal, streams/polls current output, and releases the terminal after completion.
   4. Otherwise runs foreground execution.
9. Foreground non-PTY without client terminal calls `executeBash()` from `packages/coding-agent/src/exec/bash-executor.ts`; that path performs direnv/devenv preflight itself.
10. Foreground PTY and client-terminal paths run the same direnv preflight in `BashTool` before dispatch. With `bash.direnv: "auto"` (the default), an allowed `.envrc` may merge environment changes into the command; `"off"` disables this. `bash.direnvLoadTimeoutMs` defaults to `30_000`, and a positive command timeout also bounds the preflight.
11. Local non-PTY and PTY paths allocate an output artifact first when `session.allocateOutputArtifact` is available. The artifact path/id are passed into the sink so large output can spill to disk.
12. `executeBash()` loads shell settings, optional shell snapshot, and shell minimizer settings, then runs via a persistent native `Shell` session or one-shot `executeShell()`. `docs/bash-tool-runtime.md` covers that path in detail.
13. `runInteractiveBashPty()` creates a `PtySession`, overlays an xterm-backed console UI, forwards user key input into the PTY, captures output through `OutputSink`, and kills the PTY on dismiss/dispose.
14. Client-terminal bridge mode calls `session.getClientBridge().createTerminal(...)`, emits `terminalId` updates, polls output until exit/timeout/abort, maps signal exits to `137`, and releases the handle in `finally`.
15. On completion, `#buildCompletedResult()` formats `(no output)` when needed, attaches truncation metadata from the output summary, appends wall-time/timeout/exit notices, and re-checks unfinished status before returning.
16. Local, PTY, and client-terminal timeout outcomes become `isError` results with `details.timedOut`. Client-terminal allocation/polling races the deadline; on timeout, late allocations are cleaned up or the live terminal is killed before a bounded final output read. Cancellation and missing exit status still throw.

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
   - Registers a job with `session.asyncJobManager` and returns `{ state: "running", jobId }` immediately. `timeout: 0` leaves the job without a tool-imposed deadline.
5. Auto-backgrounded non-PTY job
   - Requires `bash.autoBackground.enabled`, no PTY/client-terminal bridge, and an async job manager below its running-job cap.
   - Starts like a foreground managed job, then backgrounds it when it outlives the wait window; at capacity, Bash falls back to direct foreground execution.
6. Named supervised service
   - Requires `launch.enabled` and an active Bash tool; `async: true` and any supplied `timeout` are incompatible.
   - Runs through the launch broker with project-unique `name`, the configured shell environment, PTY defaulting to `true`, and optional readiness conditions. Reusing a live name restarts it with the new spec.
   - Readiness waits for all supplied log/port conditions, service exit, or timeout. Inspect with `read proc://<name>`.
7. Intercepted command
   - No subprocess created.
   - Returns a `ToolError` pointing the model at the dedicated tool or named service mode.

## Side Effects
- Filesystem
  - Validates `cwd` with `fs.stat()`.
  - May allocate and write artifact files for full local output (`bash`) and minimizer-preserved raw output (`bash-original`).
  - `scheme://` paths are served per operation by `InternalUrlFilesystem`: file-backed schemes redirect to their backing files (writes only for mutable file-written schemes such as `local://`, within the approved tier); rendered resources are read-only; `realpath`/`readlink` print the physical backing path of file-backed URLs.
- Subprocesses / native bindings / client terminal
  - Non-PTY local execution uses native shell execution via `@oh-my-pi/pi-natives` (`Shell.run()` or `executeShell()`).
  - PTY uses native `PtySession.start()`.
  - Client-terminal mode delegates process execution to the connected client terminal capability.
  - Named services run in the project-scoped launch broker and retain logs/status for `proc://`.
- Session state
  - Reads session settings for async, auto-background, interceptor, direnv, global timeout cap, tool availability, and shell configuration.
  - Registers jobs with `session.asyncJobManager` for explicit/auto background runs.
  - Uses `session.getSessionId()` to isolate shell reuse and async session keys.
  - Uses `session.allocateOutputArtifact()` for spill files.
  - Invalidates `github-cache` rows before execution when the command contains a mutating `gh issue`/`gh pr` subcommand, so later `issue://`/`pr://` reads see post-mutation state (`invalidateGithubCacheForBashCommand`).
- User-visible prompts / interactive UI
  - PTY mode opens a TUI overlay titled `Console` and forwards input to the PTY.
  - Background start messages note that the result is delivered automatically; use `wait` only when there is no other work.
- Background work / cancellation
  - Async and auto-background jobs continue after the initial tool return, until completion, cancellation, or their deadline (unless `timeout: 0` disabled it).
  - Cancellation aborts the native run; PTY overlay dismissal also kills the PTY.

## Limits & Caps
- Default timeout: `300s` (`TOOL_TIMEOUTS.bash.default` in `packages/coding-agent/src/tools/tool-timeouts.ts`).
- `timeout: 0` disables the command deadline.
- Positive timeout clamp: `tools.maxTimeout` is an optional global ceiling (`0` means no global ceiling), followed by the Bash `1..3600s` range.
- Auto-background default threshold: `60_000ms` (`cfgBashAutoBackgroundThresholdMs`, `bash.autoBackground.thresholdMs`, in `packages/coding-agent/src/exec/settings.ts`), further capped to `max(0, timeoutMs - 1000)` when a deadline exists; a disabled deadline leaves the threshold uncapped.
- Non-PTY tool execution passes its positive timeout to the native run, which owns deadline enforcement. A host-side watchdog waits `max(1_000, timeoutMs) + 5_000ms` for native cancellation/output draining; if it wins, the result warns that output may be incomplete and quarantines the persistent session. `timeout: 0` arms neither deadline nor watchdog (`packages/coding-agent/src/exec/bash-executor.ts`).
- Streaming-update tail cap: `50 * 1024` bytes (`DEFAULT_MAX_BYTES` in `packages/tui/src/tools/streaming-output.ts`). The local executor's result sink defaults to the same byte budget and preserves an initial head window (`tools.artifactHeadBytes`, default 20 KiB) alongside the rolling tail; set that setting to `0` for tail-only retention.
- Result postprocessing uses `tools.artifactSpillThreshold` (default 50 KiB) and head/tail windows (both default 20 KiB). The final Bash boundary also applies the spill threshold plus 2 KiB of notice slack. `tools.outputMaxColumns` defaults to a 768-byte per-line cap for streaming output.
- Streaming callback throttle in `executeBash()`: `50ms` between `onChunk` calls when streaming is enabled.
- TUI collapsed preview: `10` visual lines (`DEFAULT_TERMINAL_PREVIEW_LINES`) when rendered inline in the agent UI; this is a renderer cap, not a tool output cap.

## Errors
- Input validation:
  - async requested while disabled -> `ToolError("Async bash execution is disabled...")`.
  - missing async job manager -> `ToolError("Background job manager unavailable for this session.")`.
  - missing/bad `cwd` -> `ToolError("Working directory does not exist: ...")` or `ToolError("Working directory is not a directory: ...")`.
- Interceptor:
  - matched command -> `ToolError` with `Blocked: <rule.message>` and the original command.
  - invalid interceptor regexes are silently skipped by `compileRules()`.
- Internal URL filesystem:
  - failures surface inside the command as errno results: missing entries `ENOENT`, writes to immutable or handler-owned schemes `EROFS`, schemes above the approved tier `EACCES`, cross-scheme renames/links `EXDEV`, containment escapes `EACCES`. External programs started in a URL working directory fail instead of running on the host.
- Execution:
  - non-zero exit -> returned tool result marked `isError`, with `details.exitCode` and text ending in `Command exited with code <n>`.
  - missing exit code -> thrown `ToolError` with `Command failed: missing exit status`.
  - timeout -> local, PTY, and client-terminal execution return an `isError` result with `details.timedOut: true` and a timeout notice. Managed background execution records it as a failed job.
  - user abort -> `ToolAbortError` when the caller signal is aborted.
- Artifact allocation/save failures in `saveBashOriginalArtifact()` do not fail the command. Sink artifact failures also permit execution to continue, but return `artifactError` metadata and an incomplete-capture notice instead of advertising an incomplete artifact as full output.

## Notes
- `strict = true` is set on `BashTool`; `concurrency` is resolved per call: `pty: true` is `"exclusive"` (it takes over the terminal UI), everything else is `"shared"`, so multiple non-pty bash calls in one assistant message run in parallel. When parallel calls overlap on the same shell session key, the first owns the persistent `Shell`; the rest run in isolated one-shot shells (see `shellSessionsInUse` in `bash-executor.ts`).
- A bare `skill://<name>` is the skill directory for shell operations; its instructions are `skill://<name>/SKILL.md`.
- `checkBashInterception()` blocks only when the matching rule's `tool` name is present in `ctx.toolNames`; missing tools disable their corresponding rule.
- Interceptor configuration syntax is unchanged. It handles common flat command lists, not full shell parsing: heredocs, parameter expansion, command substitution, backticks, grouping, and malformed quoting only receive the existing whole-input check. This is best-effort routing toward dedicated tools, not a security boundary.
- `bash.direnv` defaults to `"auto"` and honors direnv's allow list; an unallowed `.envrc` is not executed. Set it to `"off"` to bypass preflight. `bash.direnvLoadTimeoutMs` controls the cold-load budget.
- Default interceptor rules come from `DEFAULT_BASH_INTERCEPTOR_RULES` in `packages/coding-agent/src/exec/settings.ts`:
  - `cat|head|tail|less|more` -> `read`
  - `grep|rg|ripgrep|ag|ack` -> `grep`
  - `find|fd|locate` with name/type/glob flags -> `glob`
  - `sed -i`, `perl -i`, `awk -i inplace` -> `edit`
  - `echo|printf|cat <<` with redirection -> `write`
- PTY mode is ignored in non-UI contexts and when `PI_NO_PTY=1` (gated by `canUseInteractiveBashPty()`); the tool falls back to non-PTY execution and appends a `pty requested but unavailable in this environment; ran without a terminal` notice.
- Non-PTY runs layer `NON_INTERACTIVE_ENV` via `buildNonInteractiveEnv()`; PTY runs instead get the shell spawn environment (`getShellConfig().env`) minus `GIT_EDITOR`, `GPG_TTY`, `CI`, and `NO_COLOR`, then `TERM=xterm-256color`, then any direnv-provided values, which win.
- When the shell minimizer rewrites output inside `executeBash()`, the visible output is replaced with minimized text and a `[raw output: artifact://<id>]` footer may be appended if `onMinimizedSave` persisted the original text.
- For executor internals that are not tool-specific — shell session reuse keys, snapshots, prefix handling, and native timeout behavior — see `docs/bash-tool-runtime.md`.
