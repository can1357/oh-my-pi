# Bash tool runtime

This document describes the **`bash` tool** runtime path used by agent tool calls, from command normalization to execution, truncation/artifacts, and rendering.

It also calls out where behavior diverges in interactive TUI, print mode, RPC mode, and user-initiated bang (`!`) shell execution.

## Scope and runtime surfaces

There are two different bash execution surfaces in coding-agent:

1. **Tool-call surface** (`toolName: "bash"`): used when the model calls the bash tool.
   - Entry point: `BashTool.execute()`.
   - Parameters include `command`, optional `env`, `timeout`, `cwd`, `pty`, and, when `async.enabled` is true, `async` (`true` or `"auto"`) plus `progress` (`"wake"` or `"ambient"`).
2. **User bang-command surface** (`!cmd` from interactive input or RPC `bash` command): session-level helper path.
   - Entry point: `AgentSession.executeBash()`.

Both eventually use `executeBash()` in `src/exec/bash-executor.ts` for non-PTY execution, but only the tool-call path runs normalization/interception, optional managed background-job handling, and tool renderer logic.

Set `bash.enabled: false` in settings to remove the model-facing `bash` tool from the active tool registry. This does not disable user-initiated bang commands or RPC `bash` requests.

## End-to-end tool-call pipeline

## 1) Input handling and parameter merge

`BashTool.execute()` currently handles input as follows:

- validates optional `env` names against shell-variable syntax,
- extracts a leading single-line `cd <path> && ...` into `cwd` when `cwd` was not supplied, unless the path needs shell expansion,
- rejects `async: true` and `async: "auto"` when `async.enabled` is false,
- rejects `progress` unless the same call uses `async: true` or `async: "auto"`,
- defaults `timeout` to 300 seconds; `0` explicitly disables the command deadline.

There are no structured `head` or `tail` parameters. Before execution, internal URLs in the command and environment values are expanded to backing filesystem paths; an internal URL used as `cwd` is also resolved. Expansion can create parent directories for writable `local://` paths. The configured direnv/devenv preflight can then merge project environment changes, with explicit `env` values taking precedence.

### Approval policy

The bash tool has the `exec` approval tier. `bash.patterns` rules can explicitly `allow`, `deny`, or `prompt`. By default, allow rules must match the entire command and cannot approve shell-control syntax. The opt-in `bash.allowCompoundCommands: true` additionally recognizes only flat chains of two or more literal commands separated by unquoted `&&`. It resolves the ordered rules independently against each original raw segment, with the first matching rule winning for that segment.

Restrictions are combined conservatively across the chain: any explicit segment or whole-chain `deny` wins, otherwise any explicit `prompt` wins. A `deny` or `prompt` pattern matching the full chain but no individual segment remains a whole-chain restriction, while later broad restrictions do not override an earlier match for a segment. These restrictions resolve before the existing raw and canonical critical-command checks.

Whole-chain restrictions are scanned with deny precedence, even when a matching prompt appears earlier. The centralized positive shell classifier permits compound recognition only for known POSIX-quoting shells (`sh`, `bash`, `dash`, `ash`, `ksh`, and `zsh`, including `.exe` names). Cmd, PowerShell, fish, and unknown shells retain legacy approval behavior; merely accepting `-c` for execution does not establish compatible quoting.

After those checks, the chain receives an explicit `write`-tier allow only when every segment explicitly resolves to `allow`. If any segment is unmatched, bash retains its standalone `exec` tier with no explicit policy, so the generic approval resolver applies `tools.approval.bash` and then the active mode. Unmatched segments therefore inherit existing policy rather than always prompting.

Literal quoted arguments are accepted, but expansions, assignments, other control operators, redirections, globbing, newlines, malformed syntax, and shell-state-changing builtins (`cd`, `source`, `eval`, and similar) do not qualify. These inputs retain legacy approval behavior. Critical destructive and remote-fetch-and-execute checks still inspect the whole raw and canonical input and its segments, so an allowed prefix cannot conceal a critical later segment. Approval does not rewrite execution: the shell receives the original command, preserving native `&&` short-circuiting.

Pattern approval is not containment. Once approved, a process keeps the shell's ambient filesystem, network, and subprocess access. Interception and approval are also separate mechanisms: interception routes misuse toward dedicated tools; approval governs whether execution may proceed.

These rules govern the **`bash` tool only**. They do not constrain shells started through other tools — notably `eval`, which can spawn a shell via subprocess (`subprocess.run(["bash", "-c", ...])`, `Bun.$`, etc.). A `bash.patterns` `deny` rule therefore does nothing when the same command is issued through `eval`. To harden against destructive commands across both surfaces, pair `bash.patterns` with a `tools.approval.eval` policy (`prompt` or `deny`); see [Tool approval mode](./approval-mode.md).

## 2) Optional interception (blocked-command path)

If `bashInterceptor.enabled` is true, `BashTool` loads rules from settings (`getBashInterceptorRules()`) and runs `checkBashInterception()` against the command — checking both the original and the cwd-normalized form (after a leading `cd … &&` is extracted) when they differ. Rule syntax is unchanged: each rule checks the complete input first, then raw flat command fragments separated by unquoted/unescaped `&&`, `||`, `;`, `|`, `|&`, `&`, or newlines, then those fragments with leading `NAME=value` assignments removed. Fragments that receive piped stdin from `|` or `|&` are excluded from the fragment candidates, including across blank/comment continuation lines, because a stdin-consuming stage cannot be replaced by a path-based dedicated tool.

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

### Caveat

`InterceptionResult` includes `suggestedTool`, but `BashTool` currently surfaces only the message text (no structured suggested-tool field in `details`).

## 3) CWD validation and timeout resolution

`cwd` is resolved relative to session cwd (`resolveToCwd`), then validated via `stat`:

- missing path -> `ToolError("Working directory does not exist: ...")`
- non-directory -> `ToolError("Working directory is not a directory: ...")`

The default timeout is 300 seconds. `timeout: 0` disables the deadline. Other values are clamped to `[1, 3600]` seconds and by a positive `tools.maxTimeout` ceiling; a clamp notice and both requested/resolved values are recorded when they differ.

## 4) Artifact allocation

Before execution, the tool allocates an artifact path/id (best-effort) for truncated output storage.

- artifact allocation failure is non-fatal (execution continues without artifact spill file),
- artifact id/path are passed into execution path for full-output persistence on truncation.

## 5) PTY vs non-PTY execution selection

PTY eligibility is decided by `canUseInteractiveBashPty(pty, ctx)` (`src/tools/bash-pty-selection.ts`); the local PTY overlay runs only when all are true:

- tool input `pty === true`
- `PI_NO_PTY !== "1"`
- tool context has UI (`ctx.hasUI === true` and `ctx.ui` set)

If `pty` is requested but unavailable, the call falls back to non-PTY and appends a `pty requested but unavailable …` notice.

Before the local PTY/non-PTY choice, a foreground (`async: false`) call can route to a managed background job (auto-backgrounding; see below) or — when the session's client advertises a terminal capability (`clientBridge.capabilities.terminal` + `createTerminal`, with `pty` false) — to a **client-bridge editor terminal** that runs the command remotely (streaming `terminalId` updates, killing on timeout, mapping a signal kill to exit code `137`). Otherwise it uses non-interactive `executeBash()`.

That means print mode and non-UI RPC/tool contexts always use non-PTY.

## Non-interactive execution engine (`executeBash`)

## Shell session reuse model

`executeBash()` caches native `Shell` instances in a process-global map keyed by:

- shell path,
- configured command prefix,
- snapshot path,
- serialized shell env,
- optional agent session key,
- minimizer configuration.

Session-level bang-command executions pass `sessionKey: this.sessionId`.

Tool-call executions pass `sessionKey: this.session.getSessionId?.()`, when available. In both surfaces, a session key isolates shell reuse per session; without one, reuse falls back to shell config/snapshot/env.
Concurrent calls never share one `Shell`: the native session runs one command at a time and `Shell.abort()` kills every in-flight run on it. `executeBash()` tracks in-flight keys in `shellSessionsInUse`; while a key is busy, overlapping calls skip the cache and run through one-shot `executeShell()` (same isolation as quarantined sessions). Only the owning call releases the in-use flag or deletes the cached session in its `finally`.

## Bundled `jq` compatibility

Unless `PI_DISABLE_UUTILS_BUILTINS` is truthy, the non-PTY native shell registers a bundled `jq` command backed by vendored [jaq](https://github.com/01mf02/jaq), not the system `jq`. Setting that flag disables the in-process uutils command set and falls back to system binaries. The bundled jaq errors when chained access indexes through a null or missing intermediate: `.a.b` over `{}` exits 5, whereas jq returns `null`.

Guard the access with `[.a.b?][0]` when the parent may be null or absent. The `?` suppresses jaq's traversal error (jq never raises it), and `[…][0]` maps the suppressed empty output to `null` while preserving a legitimate `false` or `null` value:

```jq
{"c": [.a.b?][0]}
```

Avoid the naive `.a.b? // null`: `//` treats a legitimate `false` (and `null`) as absent, so it silently rewrites boolean data to the fallback. It also diverges on parse — `{"c": .a.b? // null}` is accepted by jaq but is a syntax error in jq (the value needs parentheses: `{"c": (.a.b? // null)}`).

## Shell config, direnv, and snapshot behavior

At each call, the executor loads settings shell config (`shell`, `env`, optional `prefix`) and runs `applyDirenvPreflight()`.

Unless `bash.direnv` is `"off"`, preflight attempts to load the cwd's direnv/devenv changes within `bash.direnvLoadTimeoutMs`, additionally bounded by a positive command timeout. Direnv-provided variables are merged below explicit caller `env`; safe variables removed by direnv are prepended as `unset -v ...`. ACP-terminal and PTY routes run the same preflight before their backend; the non-PTY executor runs it internally.

If the selected shell includes `bash`, it attempts `getOrCreateSnapshot()`:

- snapshot captures aliases/functions/options from user rc,
- snapshot creation is best-effort,
- failure falls back to no snapshot.

If `prefix` is configured, it wraps the command after any direnv unset prefix.

The per-command child environment is then built by `buildNonInteractiveEnv()` (`src/exec/non-interactive-env.ts`), which layers non-interactive hardening defaults **under** the caller and direnv overrides:

- pagers disabled (`PAGER=cat`, `GIT_PAGER=cat`, … and `LESS=FRX`),
- editor prompts disabled (`GIT_EDITOR=true`, `EDITOR=true`, `VISUAL=true`),
- terminal/credential prompts reduced (`TERM=dumb`, `GIT_TERMINAL_PROMPT=0`, `SSH_ASKPASS=/usr/bin/false`, `NO_COLOR=1`, `CI=true` unless `PI_BASH_NO_CI`/`CLAUDE_BASH_NO_CI` is set),
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

Unlike the non-PTY engine, the interactive PTY path does **not** apply the non-interactive hardening. It inherits the user's environment and sets a real `TERM=xterm-256color` (applied as an override on the Rust side) so editors, pagers, and TUIs behave like a normal terminal.

PTY output is normalized (`CRLF`/`CR` to `LF`, `sanitizeText`) and written into `OutputSink`, including artifact spill support.

On PTY startup/runtime error, sink receives `PTY error: ...` line and command finalizes with undefined exit code.

## Output handling: streaming, truncation, artifact spill

Both PTY and non-PTY paths use `OutputSink`.

## OutputSink semantics

The bash executor builds the sink with `headBytes` and `maxColumns` from settings (`resolveOutputSinkHeadBytes` / `resolveOutputMaxColumns`).

- keeps a UTF-8-safe rolling **tail** window (`spillThreshold`, `DEFAULT_MAX_BYTES`, currently 50KB); on overflow it trims to the tail (UTF-8 boundary safe) and marks `truncated`,
- when `headBytes > 0` (`tools.artifactHeadBytes`, default 20KB) it also retains a **head** window and elides the middle, splicing an elision marker between head and tail in `dump()`,
- per-line column cap: when `maxColumns > 0` (`tools.outputMaxColumns`, default 768 bytes) over-wide lines are ellipsis-truncated at write time and the rest of the line is dropped,
- tracks total bytes/lines seen,
- mirrors the **raw, uncapped** stream to the artifact file when output overflows, a column cap dropped bytes, or the file is already active,
- mirrors from the first byte for async Bash with model-facing progress, so a truncated progress event can cite the same stable artifact as the final result,
- marks `truncated` on tail overflow, middle elision, column-cap drops, or file spill.

`dump()` returns:

- `output` (possibly annotated prefix),
- `truncated`,
- `totalLines/totalBytes`,
- `outputLines/outputBytes`,
- `elidedBytes/elidedLines` when the middle was elided,
- `columnDroppedBytes/columnTruncatedLines` when the per-line cap fired,
- `artifactId` if artifact file was active.

### Long-output caveat

Runtime truncation is byte-threshold based in `OutputSink` (50KB tail window by default, plus an optional head window for middle elision). It does not enforce a hard line-count cap in this code path.

### Shell output minimizer

Non-PTY execution also passes shell-minimizer settings into the native `Shell` session. When the minimizer rewrites verbose output, the executor replaces the sink's visible text with the minimized text and, when possible, saves the raw original capture as a separate `bash-original` artifact referenced by a `[raw output: artifact://<id>]` footer.

## Live tool updates and async jobs

For non-PTY foreground execution, `BashTool` uses a separate `TailBuffer` for partial updates and emits `onUpdate` snapshots while command is running.

For PTY execution, live rendering is handled by custom UI overlay, not by `onUpdate` text chunks.

When `async.enabled` is true and the call passes `async: true`, `BashTool` starts a managed bash job immediately, returns a running result with a job id, and stores completion through the session job manager; at the running-job cap it throws. With `async: "auto"`, the same process starts inline: it waits for `bash.asyncAuto.inlineGraceMs` (one second by default), then promotes if still running. A command whose deadline is at or below the grace plus a 1 s buffer never promotes and runs inline to completion. Promotion first drains in-flight chunk deliveries into the inline preview, bounded to 1 s; a stalled delivery or a preview that outgrew its tail buffer promotes anyway with progress coverage marked gapped, so completion keeps the terminal text. Requested progress activates only at promotion, so output already shown inline is not also pushed. The explicit auto mode works even when settings-driven auto-backgrounding is disabled; at the job limit it runs inline to completion and appends a notice instead of failing. Unmarked calls can use the same lifecycle when `bash.autoBackground.enabled` is on; that route retains the separate `bash.autoBackground.thresholdMs`, is skipped for PTY/client-bridge terminals, and falls back to foreground at the job limit. A queued steering message can promote a still-running candidate early.

`progress: "wake"` opts that managed job into model-facing progress. The Bash output sampler carries partial lines across chunks, reports each complete non-empty merged stdout/stderr line, and flushes a final unterminated line on exit. The shared delivery channel groups output into 200 ms windows, permits a 10-event burst, and refills one event permit every two seconds. Rate-limited notifications are suppressed from model context but remain in the complete artifact. Permitted output produced while the model is busy stays queued for the next batch; no newer event replaces an older one. Wake delivery starts a follow-up turn when the model is idle. `progress: "ambient"` uses the same capture and batching path but is injected only at an already-active step boundary.

Rate limiting drops complete post-batch events by timing, not severity. Suppression counts events rather than lines. When delivery resumes—or a terminal suppression summary is emitted—the batch retains bounded previews from the first and last suppressed events while omitting text from the events between them. Delivered progress therefore cannot prove that an error or transition did not occur. The full artifact is authoritative. Buckets are per job.

Progress and job completion are independent, ordered notifications: any final progress batch is delivered before the async result. The progress choice does not change the command timeout; `timeout: 0` is still the explicit way to disable the deadline.

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
- line clamp at 4000 chars per line,
- shows truncation + artifact warnings when metadata is present,
- marks cancelled/error/exit state separately.

This component is wired by `CommandController.handleBashCommand()` and fed from `AgentSession.executeBash()`.

## Mode-specific behavior differences

| Surface                        | Entry path                                            | PTY eligible                                          | Live output UX                                                           | Error surfacing                                  |
| ------------------------------ | ----------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------ |
| Interactive tool call          | `BashTool.execute`                                    | Yes, when `pty=true` and UI exists and `PI_NO_PTY!=1` | PTY overlay (interactive) or streamed tail updates                       | Tool errors become `toolResult.isError`          |
| Print mode tool call           | `BashTool.execute`                                    | No (no UI context)                                    | No TUI overlay; output appears in event stream/final assistant text flow | Same tool error mapping                          |
| RPC tool call (agent tooling)  | `BashTool.execute`                                    | Usually no UI -> non-PTY                              | Structured tool events/results                                           | Same tool error mapping                          |
| Interactive bang command (`!`) | `AgentSession.executeBash` + `BashExecutionComponent` | No (uses executor directly)                           | Dedicated bash execution component                                       | Controller catches exceptions and shows UI error |
| RPC `bash` command             | `rpc-mode` -> `session.executeBash`                   | No                                                    | Returns `BashResult` directly                                            | Consumer handles returned fields                 |

## Operational caveats

- Interceptor only blocks commands when suggested tool is currently available in context.
- If artifact allocation fails, truncation still occurs but no `artifact://` back-reference is available.
- Shell session cache has no explicit eviction in this module; lifetime is process-scoped.
- Timeout shaping is backend-specific: local non-PTY and interactive-PTY timeouts return error results with `details.timedOut`; the client-bridge terminal creation/execution timeout paths throw `ToolError`. Non-timeout cancellations throw across these tool-call routes.

## Implementation files

- [`src/tools/bash.ts`](../packages/coding-agent/src/tools/bash.ts) — tool entrypoint, input handling/interception, async and PTY/non-PTY selection, result/error mapping, bash tool renderer.
- [`src/tools/bash-pty-selection.ts`](../packages/coding-agent/src/tools/bash-pty-selection.ts) — `canUseInteractiveBashPty` predicate for choosing the local PTY overlay.
- [`src/tools/bash-interceptor.ts`](../packages/coding-agent/src/tools/bash-interceptor.ts) — interceptor rule matching and blocked-command messages.
- [`src/tools/bash-skill-urls.ts`](../packages/coding-agent/src/tools/bash-skill-urls.ts) — internal-URL expansion for commands, env values, and cwd.
- [`src/exec/bash-executor.ts`](../packages/coding-agent/src/exec/bash-executor.ts) — non-PTY executor, shell session reuse, cancellation wiring, output sink integration.
- [`src/exec/non-interactive-env.ts`](../packages/coding-agent/src/exec/non-interactive-env.ts) — non-interactive child-process env defaults (`buildNonInteractiveEnv`) used by the non-PTY executor.
- [`src/exec/direnv.ts`](../packages/coding-agent/src/exec/direnv.ts) — direnv/devenv environment loading used by executor preflight.
- [`src/tools/bash-interactive.ts`](../packages/coding-agent/src/tools/bash-interactive.ts) — PTY runtime, overlay UI, input normalization, and interactive `TERM` setup.
- [`src/session/streaming-output.ts`](../packages/coding-agent/src/session/streaming-output.ts) — `OutputSink`, `TailBuffer`, truncation/artifact spill, and summary metadata.
- [`src/tools/output-meta.ts`](../packages/coding-agent/src/tools/output-meta.ts) — truncation metadata shape + notice injection wrapper.
- [`src/session/agent-session.ts`](../packages/coding-agent/src/session/agent-session.ts) — session-level `executeBash`, message recording, abort lifecycle.
- [`src/modes/components/bash-execution.ts`](../packages/coding-agent/src/modes/components/bash-execution.ts) — interactive `!` command execution component.
- [`src/modes/controllers/command-controller.ts`](../packages/coding-agent/src/modes/controllers/command-controller.ts) — wiring for interactive `!` command UI stream/update completion.
- [`src/modes/rpc/rpc-mode.ts`](../packages/coding-agent/src/modes/rpc/rpc-mode.ts) — RPC `bash` and `abort_bash` command surface.
- [`src/internal-urls/artifact-protocol.ts`](../packages/coding-agent/src/internal-urls/artifact-protocol.ts) — `artifact://<id>` resolution.
