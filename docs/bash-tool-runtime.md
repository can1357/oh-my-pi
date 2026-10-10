# Bash tool runtime

This document describes the **`bash` tool** runtime path used by agent tool calls, from command normalization to execution, truncation/artifacts, and rendering.

It also calls out where behavior diverges in interactive TUI, print mode, RPC mode, and user-initiated bang (`!`) shell execution.

## Scope and runtime surfaces

There are two different bash execution surfaces in coding-agent:

1. **Tool-call surface** (`toolName: "bash"`): used when the model calls the bash tool.
   - Entry point: `BashTool.execute()`.
   - Parameters include `command`, optional `timeout`, `cwd`, `pty`, and, when `async.enabled` is true, `async`. With `launch.enabled` (default `true`), `name` and `ready` select managed service execution. There is no model-facing `env` parameter.
2. **User bang-command surface** (`!cmd` from interactive input or RPC `bash` command): session-level helper path.
   - Entry point: `AgentSession.executeBash()`.

Both eventually use `executeBash()` in `src/exec/bash-executor.ts` for non-PTY execution, but only the tool-call path runs normalization/interception, optional managed background-job handling, and tool renderer logic.

Set `bash.enabled: false` in settings to remove the model-facing `bash` tool from the active tool registry. This does not disable user-initiated bang commands or RPC `bash` requests.

## End-to-end tool-call pipeline

## 1) Input handling and mode selection

`BashTool.execute()` currently handles input as follows:

- trims service names and normalizes empty readiness fields,
- extracts a leading single-line `cd <path> && ...` into `cwd` when `cwd` was not supplied, unless the path needs shell expansion,
- rejects `async: true` when `async.enabled` is false,
- defaults finite-command `timeout` to 300 seconds; `0` explicitly disables the command deadline,
- rejects `async: true` or any supplied `timeout` in named-service mode; readiness uses `ready.timeout`,
- ignores `ready` without a nonblank `name`, adding a notice.

There are no structured `head` or `tail` parameters. Command text is never rewritten for internal URLs. The embedded shell and its in-process coreutils resolve `scheme://` paths through an injected async filesystem (`InternalUrlFilesystem`) at the moment of each operation, so URLs built from variables, redirections, globs, `cd`, and a URL `cwd` all work. File-backed schemes operate on their backing files; rendered resources are read-only; external programs never see virtual paths and cannot start in a virtual working directory. `xargs`, `find -exec`/`-execdir`, and `ifne` run their commands through the shell's own dispatch in a subshell, so `… | xargs cat` reaches the in-process `cat` and its URL arguments. The finite-command routes also load configured direnv/devenv changes. SDK callers of the executor can supply an `env` overlay; the bash tool itself uses shell assignments for per-command variables.

### Approval policy

The bash tool has the `exec` approval tier. `bash.patterns` rules can explicitly `allow`, `deny`, or `prompt`. By default, allow rules must match the entire command and cannot approve shell-control syntax. The opt-in `bash.allowCompoundCommands: true` additionally recognizes only flat chains of two or more literal commands separated by unquoted `&&`. It resolves the ordered rules independently against each original raw segment, with the first matching rule winning for that segment.

Restrictions are combined conservatively across the chain: any explicit segment or whole-chain `deny` wins, otherwise any explicit `prompt` wins. A `deny` or `prompt` pattern matching the full chain but no individual segment remains a whole-chain restriction, while later broad restrictions do not override an earlier match for a segment. These restrictions resolve before the existing raw and canonical critical-command checks.

Whole-chain restrictions are scanned with deny precedence, even when a matching prompt appears earlier. The centralized positive shell classifier permits compound recognition only for known POSIX-quoting shells (`sh`, `bash`, `dash`, `ash`, `ksh`, and `zsh`, including `.exe` names). Cmd, PowerShell, fish, and unknown shells retain legacy approval behavior; merely accepting `-c` for execution does not establish compatible quoting.

After those checks, the chain receives an explicit `write`-tier allow only when every segment explicitly resolves to `allow`. If any segment is unmatched, bash retains its standalone `exec` tier with no explicit policy, so the generic approval resolver applies `tools.approval.bash` and then the active mode. Unmatched segments therefore inherit existing policy rather than always prompting.

Literal quoted arguments are accepted, but expansions, assignments, other control operators, redirections, globbing, newlines, malformed syntax, and shell-state-changing builtins (`cd`, `source`, `eval`, and similar) do not qualify. These inputs retain legacy approval behavior. Critical destructive and remote-fetch-and-execute checks still inspect the whole raw and canonical input and its segments, so an allowed prefix cannot conceal a critical later segment. Approval does not rewrite execution: the shell receives the original command, preserving native `&&` short-circuiting.

Pattern approval is not containment. Once approved, a process keeps the shell's ambient filesystem, network, and subprocess access. Interception and approval are also separate mechanisms: interception routes misuse toward dedicated tools; approval governs whether execution may proceed.

These rules govern the **`bash` tool only**. They do not constrain shells started through other tools — notably `eval`, which can spawn a shell via subprocess (`subprocess.run(["bash", "-c", ...])`, `Bun.$`, etc.). A `bash.patterns` `deny` rule therefore does nothing when the same command is issued through `eval`. To harden against destructive commands across both surfaces, pair `bash.patterns` with a `tools.approval.eval` policy (`prompt` or `deny`); see [Tool approval mode](./approval-mode.md).

## 2) Optional interception (blocked-command path)

If `bashInterceptor.enabled` is true (default `false`), `BashTool` loads `bashInterceptor.patterns` and runs `checkBashInterception()` against the command — checking both the original and the cwd-normalized form (after a leading `cd … &&` is extracted) when they differ. Rule syntax is unchanged: each rule checks the complete input first, then raw flat command fragments separated by unquoted/unescaped `&&`, `||`, `;`, `|`, `|&`, `&`, or newlines, then those fragments with leading `NAME=value` assignments removed. Fragments that receive piped stdin from `|` or `|&` are excluded from the fragment candidates, including across blank/comment continuation lines, because a stdin-consuming stage cannot be replaced by a path-based dedicated tool.

Interception behavior:

- command is blocked **only** when:
  - regex rule matches, and
  - the suggested tool is present in `ctx.toolNames`.
- invalid regex rules are silently skipped.
- on block, `BashTool` throws `ToolError` with message:
  - `Blocked: ...`
  - original command included.
- heredocs, parameter expansion, command substitutions, backticks, grouping, and malformed quoting do not produce extra fragments; they retain only the complete-input check. Interception is best-effort routing to dedicated tools, not a shell-security policy.

Default rule patterns (defined in code) target common misuses:

- file readers (`cat`, `head`, `tail`, ...)
- search tools (`grep`, `rg`, ...)
- file finders (`find`, `fd`, ...)
- in-place editors (`sed -i`, `perl -i`, `awk -i inplace`)
- shell redirection writes (`echo ... > file`, heredoc redirection)
- unmanaged background syntax and common services/watchers/debuggers (suggesting `bash` with `name`)

Named-service calls omit the rules whose suggested tool is `bash`, so service commands do not intercept themselves.

### Caveat

`InterceptionResult` includes `suggestedTool`, but `BashTool` currently surfaces only the message text (no structured suggested-tool field in `details`).

## 3) CWD validation and timeout resolution

A host `cwd` is resolved relative to session cwd (`resolveToCwd`) and validated via filesystem `stat`. A recognized internal-URL cwd is normalized and validated through `InternalUrlFilesystem`; it is usable only by the embedded shell, not services or an interactive PTY. Client-terminal routing is skipped for a virtual cwd.

- missing path -> `ToolError("Working directory does not exist: ...")`
- non-directory -> `ToolError("Working directory is not a directory: ...")`

The default timeout is 300 seconds. `timeout: 0` disables the deadline. Other values are clamped to `[1, 3600]` seconds and by a positive `tools.maxTimeout` ceiling; a clamp notice and both requested/resolved values are recorded when they differ.

## 4) Artifact allocation

Local finite-command execution allocates an artifact path/id (best-effort) for truncated output storage; managed jobs allocate inside the job. Service logs use the broker, and client-terminal output uses the final inline-cap recovery path instead.

- artifact allocation failure is non-fatal (execution continues without artifact spill file),
- artifact id/path are passed into execution path for full-output persistence on truncation.

## 5) PTY vs non-PTY execution selection

PTY eligibility is decided by `canUseInteractiveBashPty(pty, ctx)` (`src/tools/bash-pty-selection.ts`); the local PTY overlay runs only when all are true:

- tool input `pty === true`
- `PI_NO_PTY !== "1"`
- tool context has UI (`ctx.hasUI === true` and `ctx.ui` set)

If `pty` is requested but unavailable, the call falls back to non-PTY and appends a `pty requested but unavailable …` notice.

Before the local PTY/non-PTY choice, a foreground (`async: false`) call can route to a managed background job (auto-backgrounding; see below) or — when the session's client advertises a terminal capability (`clientBridge.capabilities.terminal` + `createTerminal`, with `pty` false) — to a **client-bridge editor terminal** that runs the command remotely (streaming `terminalId` updates, killing on timeout, mapping a signal kill to exit code `137`). Otherwise it uses non-interactive `executeBash()`.

Print mode and non-UI RPC/tool contexts cannot use the local interactive overlay. Named services have their own broker-owned PTY and do not require a TUI.

## Managed service execution

A nonblank `name` routes to `startService()` before finite-command timeout, async, terminal, or output-sink selection.

- Names are 1–48 characters: an initial letter or digit, followed by letters, digits, dots, underscores, or hyphens. Names are project-broker scoped; starting an existing live name replaces that process.
- Services execute the configured external shell with its args, prefix, and shell environment, not the embedded shell or finite-command direnv preflight.
- `pty` defaults to `true`; no command deadline is imposed.
- `ready` must include a log regex or TCP port (1–65535). When both are present, both must pass. TCP host defaults to `127.0.0.1`; readiness timeout defaults to 30 seconds and is clamped to 0.05–3600 seconds.
- Without a readiness condition, startup returns the running service. With one, startup waits for readiness, exit, or the readiness deadline. A readiness timeout is reported without stopping the process.
- New services use session lifetime, no automatic restart, and are not detached. Completion notifications are associated with their owning session.
- `read proc://<name>` inspects state and logs; `write proc://<name>` sends input (empty content sends Enter), `write proc://<name>/kill` stops it, and `/mode` accepts `persist`, `session`, or `detached`.

The result carries `details.service` (`name`, `state`, `ready`, `timedOut`, optional `pid`), not finite-command timeout/async metadata.

## Non-interactive execution engine (`executeBash`)

## Shell session reuse model

`executeBash()` caches native `Shell` instances in a process-global map keyed by:

- shell path,
- configured command prefix,
- snapshot path,
- serialized shell env,
- optional agent session key,
- minimizer configuration.

Session-level bang-command executions pass the session ID captured when execution starts, preserving result ownership across a branch or session transition.

Tool-call executions pass `sessionKey: this.session.getSessionId?.()`, when available. In both surfaces, a session key isolates shell reuse per session; without one, reuse falls back to shell config/snapshot/env.
Concurrent calls never share one `Shell`: the native session runs one command at a time and `Shell.abort()` kills every in-flight run on it. `executeBash()` tracks in-flight keys in `shellSessionsInUse`; while a key is busy, overlapping calls skip the cache and create a one-shot `Shell` (the same isolation as quarantined sessions). Only the owning call releases the in-use flag or deletes the cached session in its `finally`.

## Bundled `jq` compatibility

Unless `PI_DISABLE_UUTILS_BUILTINS` is truthy, the non-PTY native shell registers a bundled `jq` command backed by [jaq](https://github.com/01mf02/jaq) 3.1.1, not the system `jq`; `jq --version` prints `jaq 3.1.1`. Setting that flag disables the in-process uutils command set and falls back to system binaries. `env jq …` runs the system `jq` for one command.

The bundled jaq follows jq where scripts commonly rely on it: indexing `null` or a missing key yields `null` (`.a.b` over `{}`), `IN`, `input_filename`, `input_line_number` and `--unbuffered` are defined, `tonumber` reads one number literal (`"021"`, `"+1"`), file operands form one input stream (`-s` slurps all of them into one array, and `input` reads on into the next file), an error in one input does not stop the next, and output is always JSON (`nan` prints `null`).

Known differences from jq 1.8: slicing `null` errors (`.a[1:]` over `{}`), indexing an object with a number yields `null` instead of an error (`.[0]` over `{"a":1}`), assignment does not create missing parents (`{} | .a.b = 1`), `del` moves the last key into the deleted key's place, `scan` yields only its first match and no capture arrays, `join` renders `null` as `"null"`, array indices must be integers (`.[1.5]` errors), floats print in jaq's notation (`3/1` prints `3.0`), `todate` keeps fractional seconds, `from_entries` reads only `key`/`value`, and `tostream`, `$__loc__`, `trimstr`, `INDEX`, `JOIN`, `--seq` and `--stream` are missing.

## Shell config, direnv, and snapshot behavior

At each call, the executor loads settings shell config (`shell`, `env`, optional `prefix`) and runs `applyDirenvPreflight()`.

Unless `bash.direnv` is `"off"`, preflight attempts to load the cwd's direnv/devenv changes within `bash.direnvLoadTimeoutMs`, additionally bounded by a positive command timeout. Direnv-provided variables are merged below explicit caller `env`; safe variables removed by direnv are prepended as `unset -v ...`. ACP-terminal and PTY routes run the same preflight before their backend; the non-PTY executor runs it internally.

Successful exports retain their loaded environment and `DIRENV_*` state per `.envrc` directory. Each call still runs `direnv export json` to check direnv's watched inputs and authorization state, but an unchanged environment avoids re-running `.envrc` and devenv setup. OMP returns the complete diff relative to its process environment. A change to that process environment, or to the nanosecond timestamp, size, or existence of the `.envrc` or any direnv-watched path (including direnv's allow/deny files), restarts the load from a clean baseline; so does a warm export that reports any change. This cache does not modify OMP's process environment.

If the selected shell includes `bash`, it attempts `getOrCreateSnapshot()`:

- snapshot captures aliases/functions/options from user rc,
- snapshot creation is best-effort,
- failure falls back to no snapshot; a failed snapshot is retried after 60 s, or sooner when the rc file's mtime or size or the shell environment changes.

If `prefix` is configured, it wraps the command after any direnv unset prefix.

The per-command child environment is then built by `buildNonInteractiveEnv()` (`src/exec/non-interactive-env.ts`), which layers non-interactive hardening defaults **under** the caller and direnv overrides:

- pagers disabled (`PAGER=cat`, `GIT_PAGER=cat`, … and `LESS=FRX`),
- editor prompts disabled (`GIT_EDITOR=true`, `EDITOR=true`, `VISUAL=true`),
- terminal/credential prompts reduced (`TERM=dumb`, `GIT_TERMINAL_PROMPT=0`, `SSH_ASKPASS` set to the resolved `false` executable or `"false"`, `NO_COLOR=1`, `CI=true` unless `PI_BASH_NO_CI`/`CLAUDE_BASH_NO_CI` is set),
- package-manager/tooling automation flags for non-interactive behavior (npm/pnpm/yarn/pip/cargo/terraform/gh, …),
- on Windows, UTF-8 locale/codepage defaults are added when absent.

## Streaming and cancellation

`Shell.run()` streams chunks to `OutputSink` and optional `onChunk` callback.

Cancellation:

- aborted signal triggers `shellSession.abort(...)`,
- timeout from native result is mapped to `cancelled: true` + annotation text,
- explicit cancellation similarly returns `cancelled: true` + annotation.

No exception is thrown inside executor for timeout/cancel; it returns structured `BashResult` and lets caller map error semantics.

## Interactive PTY path (`runInteractiveBashPty`)

When PTY is enabled, tool runs `runInteractiveBashPty()` which opens an overlay console component and drives a native `PtySession`.

Behavior highlights:

- xterm-headless virtual terminal renders viewport in overlay,
- keyboard input is normalized (including Kitty sequences and application cursor mode handling),
- `esc` while running kills the PTY session,
- terminal resize propagates to PTY (`session.resize(cols, rows)`).

Unlike the non-PTY engine, the interactive PTY path does **not** apply the non-interactive hardening. The Rust side starts from the process's native environment and applies the env it is handed as overrides; Bun's `process.env` writes never reach that base, so the PTY is handed the shell spawn environment (`getShellConfig().env`) minus its non-interactive guards (`GIT_EDITOR`, `GPG_TTY`, `CI`) and `NO_COLOR`, then a real `TERM=xterm-256color` so editors, pagers, and TUIs behave like a normal terminal, then the direnv values, which win over both. A key left out keeps the inherited value.

PTY output is normalized (`CRLF`/`CR` to `LF`, `sanitizeText`) and written into `OutputSink`, including artifact spill support.

On PTY startup/runtime error, sink receives `PTY error: ...` line and command finalizes with undefined exit code.

## Output handling: streaming, truncation, artifact spill

Both PTY and non-PTY paths use `OutputSink`.

## OutputSink semantics

The bash executor builds the sink with `headBytes` and `maxColumns` from settings (`resolveOutputSinkHeadBytes` / `resolveOutputMaxColumns`).

- keeps the inline body within `spillThreshold` (`DEFAULT_MAX_BYTES`, 50 KiB by default), using UTF-8-safe boundaries,
- when `headBytes > 0` (`tools.artifactHeadBytes`, default 20 KiB) it reserves a **head** window within that same budget and uses the remainder for a rolling **tail**; head retention is capped at half the total budget, and `dump()` splices in a middle-elision marker when necessary,
- per-line column cap: when `maxColumns > 0` (`tools.outputMaxColumns`, default 768 bytes) over-wide lines are ellipsis-truncated at write time and the rest of the line is dropped,
- tracks total bytes/lines seen,
- mirrors the sanitized, uncapped text stream to the artifact file when output overflows, a column cap dropped bytes, or the file is already active; the artifact file is capped at `tools.artifactMaxBytes` (default 16 MB: the first 3 MB plus a rolling tail, joined by an `[ARTIFACT TRUNCATED: …]` notice; `0` = unbounded),
- marks `truncated` on tail overflow, middle elision, column-cap drops, or file spill.

`dump()` returns:

- `output` (possibly annotated prefix),
- `truncated`,
- `totalLines/totalBytes`,
- `outputLines/outputBytes`,
- `elidedBytes/elidedLines` when the middle was elided,
- `columnDroppedBytes/columnTruncatedLines` when the per-line cap fired,
- `columnMax` when the per-line cap fired,
- `artifactId` if capture succeeded,
- `artifactError` (`open`, `write`, `flush`, or `end`) when artifact I/O failed; a failed capture withholds its artifact ID.

### Long-output caveat

Runtime truncation is byte-threshold based in `OutputSink` (50 KiB shared head/tail budget by default, plus marker text). It does not enforce a hard line-count cap in this code path.

Kitty direct-image and Sixel frames are extracted before text sanitization/truncation and returned as image content. Their control bytes are not preserved as ordinary artifact text.

### Shell output minimizer

Non-PTY execution also passes shell-minimizer settings into the native `Shell` session. When the minimizer rewrites verbose output, the executor substitutes the minimized text only after the original capture has been saved as a separate `bash-original` artifact, referenced by a `[raw output: artifact://<id>]` footer. If saving returns no artifact ID, the lossless sink output is retained instead.

## Live tool updates and async jobs

For non-PTY foreground execution, `BashTool` passes an `onPreview` callback to `executeBash()`, which streams the `OutputSink`'s own inline view (`OutputSink.preview()`) as `onUpdate` snapshots while the command is running; there is no separate partial-update buffer.

For PTY execution, live rendering is handled by custom UI overlay, not by `onUpdate` text chunks.

When `async.enabled` is true and the call passes `async: true`, `BashTool` starts a managed bash job immediately, returns a running result with a job id, and stores completion through the session job manager. Auto-backgrounding (`bash.autoBackground.enabled`, default `true`) can also use this path after `bash.autoBackground.thresholdMs` (default 60,000 ms); it is skipped for PTY and client-bridge terminal routes and falls back to foreground execution when the job manager is at capacity. A queued steering message can background a still-running auto-background candidate early.

## Result shaping, metadata, and error mapping

After execution:

1. A cancellation or missing exit status throws a tool error. The client-bridge
   terminal route also throws `ToolError` for timeout before structured result
   shaping.
2. Local non-PTY and interactive-PTY timeouts return an error result with
   `details.timedOut = true` so the renderer can distinguish them from an
   ordinary failure.
3. Empty output becomes `(no output)`.
4. A final inline byte cap protects routes that bypass `OutputSink`; it reuses the sink artifact when available or saves a `bash-original` artifact.
5. Truncation metadata is attached from the sink summary.
6. A nonzero exit returns an error result with `details.exitCode`; zero returns success.

Result details can also include resolved/requested timeout, `timeoutDisabled`, client `terminalId`, wall time, async job state, and truncation metadata. Truncation includes direction/reason, total and shown line/byte counts, shown range, and `artifactId` when persistence succeeded.

Built-in tool wrapping appends the model-facing recovery notice automatically, for example `Read artifact://<id> for full output`.

## Rendering paths

## Tool-call renderer (`bashToolRenderer`)

`bashToolRenderer` is used for tool-call messages (`toolCall` / `toolResult`):

- collapsed mode shows visual-line-truncated preview,
- expanded mode shows all currently available output text,
- warning line includes truncation reason and `artifact://<id>` when truncated,
- timeout value (from args) is shown in footer metadata line.

### Caveat: full artifact expansion

`BashRenderContext` has `isFullOutput`, but current renderer context builder does not set it for bash tool results. Expanded view still uses the text already in result content (tail/truncated output) unless another caller provides full artifact content.

## User bang-command component (`BashExecutionComponent`)

`BashExecutionComponent` is for user `!` commands in interactive mode (not model tool calls):

- streams chunks live,
- collapsed preview keeps last 20 logical lines,
- line clamp at 4000 visible columns per line,
- shows truncation + artifact warnings when metadata is present,
- marks cancelled/error/exit state separately.

This component is wired by `CommandController.handleBashCommand()` and fed from `AgentSession.executeBash()`.

Interactive `!` calls request configured user-shell execution. zsh/fish commands can run on a headless PTY and replay ANSI output in the component; bash uses the snapshot/embedded-shell path. A simple successful `cd` command runs through the persistent shell and can relocate the OMP session cwd; this relocation is refused while an agent response is streaming. `!!` excludes the execution message from model context.

## Mode-specific behavior differences

This table covers finite-command execution; named-service routing is described separately above.

| Surface                        | Entry path                                            | PTY eligible                                          | Live output UX                                                           | Error surfacing                                  |
| ------------------------------ | ----------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------ |
| Interactive tool call          | `BashTool.execute`                                    | Yes, when `pty=true` and UI exists and `PI_NO_PTY!=1` | PTY overlay (interactive) or streamed tail updates                       | Tool errors become `toolResult.isError`          |
| Print mode tool call           | `BashTool.execute`                                    | No (no UI context)                                    | No TUI overlay; output appears in event stream/final assistant text flow | Same tool error mapping                          |
| RPC tool call (agent tooling)  | `BashTool.execute`                                    | Usually no UI -> non-PTY                              | Structured tool events/results                                           | Same tool error mapping                          |
| Interactive bang command (`!`) | `AgentSession.executeBash` + `BashExecutionComponent` | Headless PTY for supported zsh/fish user shells; not the interactive overlay | Dedicated bash execution component with PTY replay when used | Controller catches exceptions and shows UI error |
| RPC `bash` command             | `rpc-server` -> `session.executeBash`                 | No                                                    | Returns `BashResult` directly                                            | Consumer handles returned fields                 |

## Operational caveats

- Interceptor only blocks commands when suggested tool is currently available in context.
- If artifact allocation fails, truncation still occurs but no `artifact://` back-reference is available.
- Ordinary shell session cache entries are process-scoped with no size-based eviction. Cancelled/broken sessions are removed and quarantined; per-job `:async:` entries are removed after completion. Shells with live background children can be retained until those children exit.
- Timeout shaping is backend-specific: local non-PTY and interactive-PTY timeouts return error results with `details.timedOut`; the client-bridge terminal creation/execution timeout paths throw `ToolError`. Non-timeout cancellations throw across these tool-call routes.

## Implementation files

- [`src/tools/bash.ts`](../packages/coding-agent/src/tools/bash.ts) — tool entrypoint, normalization/interception, service/async/PTY selection, result/error mapping.
- [`packages/tui/src/tools/bash.ts`](../packages/tui/src/tools/bash.ts) — bash tool renderer and result detail types.
- [`src/launch/services.ts`](../packages/coding-agent/src/launch/services.ts) — named-service validation and project-broker supervision.
- [`src/internal-urls/proc-protocol.ts`](../packages/coding-agent/src/internal-urls/proc-protocol.ts) — service/job inspection, input, stop, and lifetime controls.
- [`src/tools/bash-pty-selection.ts`](../packages/coding-agent/src/tools/bash-pty-selection.ts) — `canUseInteractiveBashPty` predicate for choosing the local PTY overlay.
- [`src/tools/bash-interceptor.ts`](../packages/coding-agent/src/tools/bash-interceptor.ts) — interceptor rule matching and blocked-command messages.
- [`src/internal-urls/url-filesystem.ts`](../packages/coding-agent/src/internal-urls/url-filesystem.ts) — router-backed shell filesystem for `scheme://` paths.
- [`src/exec/bash-executor.ts`](../packages/coding-agent/src/exec/bash-executor.ts) — non-PTY executor, shell session reuse, cancellation wiring, output sink integration.
- [`src/exec/non-interactive-env.ts`](../packages/coding-agent/src/exec/non-interactive-env.ts) — non-interactive child-process env defaults (`buildNonInteractiveEnv`) used by the non-PTY executor.
- [`src/exec/direnv.ts`](../packages/coding-agent/src/exec/direnv.ts) — direnv/devenv environment loading used by executor preflight.
- [`src/tools/bash-interactive.ts`](../packages/coding-agent/src/tools/bash-interactive.ts) — PTY runtime, overlay UI, input normalization, and interactive `TERM` setup.
- [`packages/tui/src/tools/streaming-output.ts`](../packages/tui/src/tools/streaming-output.ts) — `OutputSink`, `TailBuffer`, truncation/artifact spill, and summary metadata.
- [`src/tools/output-meta.ts`](../packages/coding-agent/src/tools/output-meta.ts) — settings-to-output-budget helpers.
- [`packages/tui/src/tools/output-meta.ts`](../packages/tui/src/tools/output-meta.ts) — truncation metadata and recovery notices.
- [`src/session/agent-session.ts`](../packages/coding-agent/src/session/agent-session.ts) — session-level `executeBash` surface.
- [`src/session/bash-runner.ts`](../packages/coding-agent/src/session/bash-runner.ts) — bang-command execution, result ownership, message recording, and abort lifecycle.
- [`packages/tui/src/chat/bash-execution.ts`](../packages/tui/src/chat/bash-execution.ts) — interactive `!` command execution component.
- [`src/modes/controllers/command-controller.ts`](../packages/coding-agent/src/modes/controllers/command-controller.ts) — wiring for interactive `!` command UI stream/update completion.
- [`src/modes/rpc/rpc-server.ts`](../packages/coding-agent/src/modes/rpc/rpc-server.ts) — RPC `bash` and `abort_bash` command surface.
- [`src/internal-urls/artifact-protocol.ts`](../packages/coding-agent/src/internal-urls/artifact-protocol.ts) — `artifact://<id>` resolution.
