# bash

> Execute a shell command in the session workspace, with optional PTY or background-job handling.

## Source
- Entry: `packages/coding-agent/src/tools/bash.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/bash.md`
- Key collaborators:
  - `packages/coding-agent/src/tools/bash-interactive.ts` — PTY/TUI execution path.
  - `packages/coding-agent/src/tools/bash-interceptor.ts` — blocks tool-better shell patterns.
  - `packages/coding-agent/src/tools/bash-skill-urls.ts` — expands internal URLs to paths.
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
| `timeout` | `number` | No | Timeout in seconds. Default `300`. `0` disables the deadline. Positive values are capped by `tools.maxTimeout` when that setting is positive, then clamped to the Bash range `1..3600`. |
| `cwd` | `string` | No | Working directory, resolved against `session.cwd` via `resolveToCwd`. Must exist and be a directory. |
| `pty` | `boolean` | No | Request PTY mode. Default `false`. PTY is used only when `pty: true`, `PI_NO_PTY !== "1"`, and the tool context has a UI. |
| `async` | `boolean \| "auto"` | No | `true` starts a background job immediately. `"auto"` starts inline, waits for `bash.asyncAuto.inlineGraceMs` (default one second), then promotes the same process if it is still running; a `timeout` at or below the grace plus a 1 s buffer never promotes and runs inline to completion. Present only when `async.enabled` is true. Neither mode changes the command deadline, including `timeout: 0`. |
| `progress` | `"ambient" \| "wake"` | No | With `async: true` or `async: "auto"`, deliver complete non-empty output-line events to the model. In auto mode, delivery activates only after promotion: earlier output appears in the foreground/background-start result instead. `wake` pushes a follow-up turn while idle; `ambient` delivers only during an active turn. Lines collect into trailing 200 ms events. A token bucket permits a 10-event burst and refills one event permit every two seconds; this is a rate-limiter permit, not an LLM token. Suppressed inline events remain in the full artifact. Oversized lines retain their first and last 250 characters. A model-facing preview retains at most 3,000 UTF-8 bytes per job, split between its head and tail, and links the complete capture as `artifact://<id>`. |

## Agent-facing guidance

When async execution is enabled, the Bash tool description recommends `async: "auto"` for finite commands: quick work still returns inline, while slow work crosses the turn boundary without restarting the process. `async: true` remains the immediate-background mode and is the right choice when the agent already knows the command is long-running. `progress: "wake"` is waking, permitted events produced while the model is busy arrive together in order, ambient progress never wakes, oversized lines and batches retain bounded head/tail previews, and completion is a separate notification. Persistent services and watchers are routed to `hub` instead.

A command that finishes within `bash.asyncAuto.inlineGraceMs` returns one ordinary Bash result. It does not emit separate progress or completion notifications. If the command outlives the grace, the same process is promoted without a restart. Settings-driven auto-backgrounding of an unmarked call can still deliver completion, but it does not enable progress; progress requires explicit `async: "auto"` or `async: true`.

`wake` is a harness push, not a reason to hold the current turn open. Agents should not poll (`hub logs`/`ps`, short `wait` loops), follow logs, or block to receive progress; they end the turn and the push starts the next one. A `hub wait` with `name` plus `pattern`/`for`/`timeout` remains a legitimate readiness or exit wait. If output arrives while the model is busy, the harness buffers every rate-limit-permitted event and places them together in the next follow-up turn. Progress is a lossy preview selected by timing; use the artifact to determine whether omitted output contained an error or state transition. A one-job wake message rendered for the model has this form:

```xml
<system-notice>
<job-progress id="<job-id>" type="bash" elapsed="<elapsed>">
<output>
<all output events queued for this job>
</output>
</job-progress>
Resume your work using this update.
</system-notice>
```

When either async Bash or Hub process monitoring is available, the system prompt includes one terse selection rule under `§ Tool Policy`. With both tools active it renders as:

```text
<async-progress>
Finite commands: SHOULD use `bash` with `async: "auto"`, `progress: "wake"` — quick returns inline, slow promotes to a background job. Known long-running? `async: true` MAY background immediately.
Process output that may need action: `hub` with `progress: "wake"` (`op: "start"` new; `op: "monitor"` existing). `wait` with `name` + `pattern`/`for`/`timeout` MAY block for readiness or exit.
Verbose producer? Capture full logs unmonitored; filter one async Bash monitor.
Waiting on a condition? One sleeping async `until` loop; AVOID repeated tool polls.
Progress: 200 ms batches, 10-event burst, then 1 permit/2 s; suppressed events stay in the full artifact. Truncated batches show bounded `<head>`/`<tail>` and link `artifact://<id>`.
Chatty progress: lower source verbosity (quiet or warning-only) or filter to actionable lines; safe to retry → stop and relaunch quieter.
Hub: retune a chatty process without stopping it — `op: "monitor"` with `progress: "ambient"` or `"off"`.
Bash: a job's `progress` is fixed at launch; retry unsafe → let it finish.
Suppression reports repeat this guidance a few times with increasing spacing, then stop.
Progress is pushed while you are idle. NEVER hold the turn open to receive it — no polling (`logs`, `ps`, short `wait` loops), no tailing files; end the turn.
</async-progress>
```

Each delivered progress batch is a harness-injected `async-progress` message in the model's conversation. Rate limiting suppresses whole post-batch events by timing, not severity. A suppression count names events, not lines. When delivery resumes—or a terminal suppression summary is emitted—the batch retains bounded previews from the first and last suppressed events while omitting text from the events between them; delivered progress therefore cannot prove that an error or state transition did not occur. The artifact is authoritative. The resumed event or terminal summary includes `<suppressed events="N" reason="rate-limit" full-output="artifact://<id>" />`. A `<system-reminder>` carrying the same chatty-progress instructions as the system prompt is appended to a few suppression-bearing progress messages with increasing spacing, then never again for that job.

When a batch was rate-limited or its preview exceeded the size bound, `<output>` instead carries a structured split: a `<head>` block, a `<suppressed reason="rate-limit|preview-limit" [events="N"] [full-output="artifact://<id>"] />` marker, and a `<tail>` block. The `<output>` element itself never carries attributes. Bash uses the same artifact as its final command output, so the URI stays stable for the job.

### Choosing a progress mode

Both modes use the same per-job batching and rate limiter. Their difference is when the model runs; the artifact retains the complete raw output in either mode. Concurrent jobs have independent buckets, so aggregate wake traffic grows with the number of monitored jobs.

| Mode | When the agent receives it | Cost and tradeoff | Use it for |
| --- | --- | --- | --- |
| `wake` | Starts a follow-up turn when the agent is idle | May add model requests, thinking tokens, and latency, but the agent can act immediately | Readiness, failures, requests for input, or a newly available artifact |
| `ambient` | Waits for the next turn caused by completion, a user message, or another event | Several batches can share one model request; reaction to intermediate output may be delayed | Test, build, install, download, benchmark, or low-priority diagnostic progress |

Ambient does not change batching, rate limiting, or artifact capture. It avoids spending an inference turn on updates that would produce no useful action, such as another passing test file or download percentage. When completion starts the next turn, queued ambient progress is delivered before the completion result.

For noisy output, first look for a quieter source setting, such as quiet mode or a warning/error log level. Otherwise, filter the stream to lines that may change the next action. If the command is safe to retry, cancel it and relaunch with the quieter configuration. Bash progress cannot be changed after launch, so let it finish when retrying would repeat side effects or discard expensive work.

Hub has another option: use `monitor` to switch the current process to `ambient` or `off`. This changes only the notification subscription and does not stop the process. If quieter output is still needed, stop and start it again with new arguments or environment; `restart` alone reuses the old launch specification.

Use ambient for a long test suite when only the final status changes the plan:

```json
{
  "command": "bun test",
  "async": "auto",
  "progress": "ambient"
}
```

Use wake when an intermediate line should change the agent's next action:

```json
{
  "command": "bun scripts/wait-for-preview.ts",
  "async": "auto",
  "progress": "wake"
}
```

The same choice applies to Hub processes. A low-priority diagnostic stream can remain ambient, while a readiness or failure monitor should wake the agent:

```json
{"op":"monitor","name":"benchmark","progress":"ambient"}
{"op":"monitor","name":"preview","progress":"wake"}
```

### Capability compared with Claude Code Monitor

This comparison uses the observed Claude Code 2.1.233 Monitor contract. Each surface pushes events from the harness to the agent; the model does not poll after arming the work.

| Capability | OMP async Bash | OMP Hub monitoring | Claude Code Monitor |
| --- | --- | --- | --- |
| Intended workload | Finite command spanning turns | Shared long-running process, watcher, service, debugger, or REPL | Command or WebSocket watcher |
| Start operation | `bash` with `async: "auto"`, `progress: "wake"` (or `async: true` for immediate background) | `hub` `op:"start"`, `progress:"wake"` | Top-level `Monitor` call with a command or WebSocket URL |
| Attach or retune | No; progress belongs to the command | `hub` `op:"monitor"` by stable process name | No attach/retune operation observed |
| Detach without stopping work | No separate subscription | `progress:"off"` | Persistent monitor is stopped through task control |
| Harness push while idle | Starts a follow-up turn | Starts a follow-up turn | Starts a follow-up turn |
| Events received while busy | Permitted events buffered and delivered together; suppressed events remain in the artifact | Same shared batching contract | Permitted events buffered and delivered together; suppressed events remain in the output file |
| Burst/rate limit | 10 events, then one event permit every 2s | Same shared meter | Observed: about 10 events, then one event permit every 2s |
| Command event boundary | Complete non-empty merged stdout/stderr line | Complete non-empty merged stdout/stderr line | Stdout line |
| WebSocket event boundary | Not supported | Not supported | Text frame |
| Termination | Separate async-job completion/failure | Separate process completion | Separate monitor termination |
| Non-waking delivery | `progress:"ambient"` | `progress:"ambient"` | No native ambient mode observed |
| Native regex, cadence, or stop-on-match controls | None; filtering belongs in the command | None; filtering belongs in the supervised process | None; filtering and polling belong in the monitor command |
| Lifetime | Command lifetime; `timeout:0` disables its deadline | Monitoring is session-scoped; process lifetime is independently controlled by `persist`/`detached` | Optional `persistent:true` |

OMP Hub monitoring is the persistent-process counterpart to Claude Code Monitor's `persistent:true`. Hub's `persist:true` is not a monitoring flag: it makes the process survive the last omp client, while `progress` controls only the current session's notification subscription. Fully detached Hub daemons cannot be live-monitored.

## Live model behavioral eval

The opt-in eval runs a real authenticated model through the normal `AgentSession`. Its Bash wake scenario requires `async: "auto"` with `progress: "wake"`; its Hub scenario requires a persistent `start` with `progress: "wake"`. In both cases the harness must inject the marker before completion, a later assistant message must acknowledge the pushed event, and the model must avoid blocking/polling calls. The quick-command case requires one Bash call made with `async: "auto"` and `progress: "wake"` that still finishes inline, no async notification, and a reported result. The user prompts do not mention these selection rules, so the criteria measure agent-facing policy rather than parroting eval instructions.

```bash
bun --cwd=packages/coding-agent run eval:async-progress --model <provider/model> --runs 3
bun --cwd=packages/coding-agent run eval:async-progress --case quick --model <provider/model> --runs 3
```

The default wake case runs both surfaces; pass `--surface bash` or `--surface hub` to isolate one. The quick case is Bash-only. Omit `--model` to use the configured default. The command exits non-zero if any run fails and prints the selected tool arguments plus each criterion. It is opt-in because it uses external credentials, incurs provider cost, and measures stochastic model behavior; deterministic queue, batching, and wake semantics remain covered by the regular test suite.
## Outputs
The tool returns a single `text` content block plus optional `details`.

- Success, foreground:
  - `content[0].text`: command output, or `(no output)` when the command produced nothing.
  - `details.timeoutSeconds`: effective positive timeout after global/per-tool clamping, or `details.timeoutDisabled: true` when `timeout: 0`.
  - `details.requestedTimeoutSeconds`: present when a positive requested timeout differed from the effective timeout.
  - `details.wallTimeMs`: elapsed wall-clock milliseconds for completed local/client-terminal runs.
  - `details.terminalId`: present when execution was routed through a client terminal bridge.
  - `details.exitCode`: present when the command completed with a non-zero exit code.
  - `details.timedOut: true`: present on local/PTY timeout results.
  - `details.meta.truncation`: present when output was truncated in memory; includes `artifactId` when full output spilled to an artifact.
  - non-zero exits and local/PTY timeouts return a tool result marked `isError`; definite non-zero output ends with `Command exited with code <n>`.
- Success, background start (`async: true`, promoted `async: "auto"`, or settings-driven auto-background):
  - `content[0].text`: optional preview tail and notices, followed by `Backgrounded as job <id>; result will be delivered automatically.`
  - `details.async`: `{ state: "running", jobId, type: "bash" }`.
- Background progress / completion:
  - delivered through `onUpdate` / async job manager, not the initial return.
  - running updates contain tail text and `details.async.state: "running"` only after the job is considered backgrounded.
  - with `progress: "wake"`, complete output lines push `async-progress` follow-up turns even while the agent is idle; `progress: "ambient"` uses non-waking step-boundary asides instead. Lines emitted while the agent is busy are retained and delivered together rather than replaced by the newest line. Partial lines are held until completed, including the final unterminated line.
  - completion/failure updates carry final text and `details.async.state: "completed" | "failed"`. A non-zero exit or timeout is recorded as a failed background job.
- Failure:
  - cancellation, missing exit status, validation failures, intercepted commands, and client-terminal-bridge timeouts throw `ToolError` / `ToolAbortError`.

Stdout and stderr are merged before the model sees them. Definite non-zero exit codes are appended to the returned error result text as `Command exited with code <n>`.

## Command policy and dedicated-tool routing

Two independent settings can prevent a Bash subprocess from starting. They serve different purposes and run at different points in the tool-call lifecycle.

| Setting | Purpose | Rule syntax | Result when matched |
| --- | --- | --- | --- |
| `bash.patterns` | Command-specific execution policy | Literal text with `*` wildcards | Allows the call, requests human approval, or denies it. |
| `bashInterceptor.patterns` | Prefer a dedicated tool over Bash | JavaScript regular expression, optional flags, tool name, and message | Returns a Bash tool error telling the model to call the named dedicated tool instead. |

### `bash.patterns`: permission policy

`bash.patterns` is for commands that must be allowed, confirmed by a person, or refused regardless of whether another tool could perform the work. Rules are ordered; the first matching rule wins. Each rule has a `match` glob and an `approval` value of `allow`, `prompt`, or `deny`.

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
- `allow` can lower the approval tier for a simple command, but it cannot approve a compound command. For example, `match: "git *"` does not approve `git status && rm -rf build`.
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

The built-in default rules route common operations such as `cat` to `read`, `rg` to `grep`, in-place `sed` to `edit`, shell redirection to `write`, and unmanaged services/background processes to `hub`. See `DEFAULT_BASH_INTERCEPTOR_RULES` in `packages/coding-agent/src/config/settings-schema.ts` for the complete list.

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

1. `BashTool.execute()` in `packages/coding-agent/src/tools/bash.ts` reads `command`, validates `env`, and defaults `timeout` to `300`.
2. If `cwd` is absent, it rewrites a leading `cd <path> && ...` into the structured `cwd` field and strips that prefix from `command`.
3. `pty: true` combined with `async: "auto"` throws `ToolError`. If `async: true` or `async: "auto"` is requested while `async.enabled` is off, it throws `ToolError` before any execution. `progress` is rejected unless the same call selects one of those modes.
4. If `bashInterceptor.enabled` is on, `checkBashInterception()` runs against both the original command and the `cd`-stripped command. For each form, configured regexes still check the complete input first, then each flat command separated by unquoted/unescaped `&&`, `||`, `;`, `|`, `|&`, `&`, or newlines (excluding stages that consume piped stdin from `|` or `|&`, including across blank/comment continuations), followed by versions of those fragments without leading `NAME=value` assignments. A matching enabled rule throws before URL expansion or execution.
5. `expandInternalUrls()` rewrites supported internal URLs inside `command`, each `env` value, and protocol-looking `cwd` values. Command replacements are shell-escaped; `env` and `cwd` replacements use raw filesystem/string values because they are not interpolated into shell text.
6. `resolveToCwd()` resolves `cwd` against `session.cwd`; `fs.stat()` verifies that the target exists and is a directory.
7. `timeout: 0` disables the deadline. Otherwise `clampTimeout("bash", requestedTimeoutSec, tools.maxTimeout)` applies a positive global ceiling (when configured), then `TOOL_TIMEOUTS.bash` (`min: 1`, `max: 3600`). When clamped, `#buildCompletedResult()` / `#buildBackgroundStartResult()` append a notice line.
8. Execution path splits:
   1. `async: true` -> `#startManagedBashJob()` registers a session async job and returns immediately.
   2. `async: "auto"` -> starts a managed job, waits up to the configured `bash.asyncAuto.inlineGraceMs`, returns completed work inline, or promotes the same process and activates requested progress delivery. When the command's deadline is at or below the grace plus a 1 s buffer (`resolveAutoBackgroundWaitMs` returns `undefined`), no job is registered and the call runs inline to completion. The explicit mode works independently of `bash.autoBackground.enabled`. At the running-job cap it runs inline to completion and appends `Background job limit reached; ran inline to completion instead of promoting to a background job.` to the result, whereas `async: true` at the cap throws `ToolError`.
   3. Non-PTY with `bash.autoBackground.enabled`, an async job manager below its running-job cap, and no client-terminal bridge available (the bridge wins when both apply) -> applies the same inline-then-promote lifecycle (and the same deadline rule) to unmarked foreground calls, without model-facing progress.
   4. Non-PTY client-terminal bridge, when the session advertises terminal capability and `pty` is false -> creates a remote terminal, streams/polls current output, and releases the terminal after completion.
   5. Otherwise runs foreground execution.
9. Foreground non-PTY without client terminal calls `executeBash()` from `packages/coding-agent/src/exec/bash-executor.ts`; that path performs direnv/devenv preflight itself.
10. Foreground PTY and client-terminal paths run the same direnv preflight in `BashTool` before dispatch. With `bash.direnv: "auto"` (the default), an allowed `.envrc` may merge environment changes into the command; `"off"` disables this. `bash.direnvLoadTimeoutMs` defaults to `30_000`, and a positive command timeout also bounds the preflight.
11. Local non-PTY and PTY paths allocate an output artifact first when `session.allocateOutputArtifact` is available. The artifact path/id are passed into the sink so large output can spill to disk.
12. `executeBash()` loads shell settings, optional shell snapshot, and shell minimizer settings, then runs via a persistent native `Shell` session or one-shot `executeShell()`. `docs/bash-tool-runtime.md` covers that path in detail.
13. `runInteractiveBashPty()` creates a `PtySession`, overlays an xterm-backed console UI, forwards user key input into the PTY, captures output through `OutputSink`, and kills the PTY on dismiss/dispose.
14. Client-terminal bridge mode calls `session.getClientBridge().createTerminal(...)`, emits `terminalId` updates, polls output until exit/timeout/abort, maps signal exits to `137`, and releases the handle in `finally`.
15. On completion, `#buildCompletedResult()` formats `(no output)` when needed, attaches truncation metadata from the output summary, appends wall-time/timeout/exit notices, and re-checks unfinished status before returning.
16. Local/PTY timeout outcomes become `isError` results with `details.timedOut`; client-terminal timeout and cancellation/missing exit status paths throw with captured output when available.

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
5. Explicit auto job
   - Requires `async: "auto"` and `async.enabled`; a missing job manager throws.
   - Starts inline, returns short work directly, and activates progress only if it outlives the grace window and becomes a background job. Promotion first drains chunk deliveries still in flight into the inline preview, bounded to five progress batch windows (1 s); a delivery stalled past that bound (or a preview that outgrew its 50 KiB tail) promotes anyway with progress coverage marked gapped, so the completion keeps the terminal text instead of claiming it was already shown.
   - At the running-job cap, or when the deadline cannot outlive the grace, runs inline to completion (the cap case appends a notice).
6. Settings-driven auto-backgrounded non-PTY job
   - Requires `bash.autoBackground.enabled`, no PTY/client-terminal bridge, and an async job manager below its running-job cap.
   - Applies the same promotion lifecycle to unmarked calls; at capacity, Bash falls back to direct foreground execution.
7. Intercepted command
   - No subprocess created.
   - Returns a `ToolError` pointing the model at `read`, `grep`, `glob`, `edit`, or `write`.

## Side Effects
- Filesystem
  - Validates `cwd` with `fs.stat()`.
  - May allocate and write artifact files for full local output (`bash`) and minimizer-preserved raw output (`bash-original`).
  - `expandInternalUrls(..., { ensureLocalParentDirs: true })` creates parent directories for `local://` paths before execution.
- Subprocesses / native bindings / client terminal
  - Non-PTY local execution uses native shell execution via `@oh-my-pi/pi-natives` (`Shell.run()` or `executeShell()`).
  - PTY uses native `PtySession.start()`.
  - Client-terminal mode delegates process execution to the connected client terminal capability.
- Session state
  - Reads session settings for async, auto-background, interceptor, direnv, global timeout cap, tool availability, and shell configuration.
  - Registers jobs with `session.asyncJobManager` for explicit/auto background runs.
  - Uses `session.getSessionId()` to isolate shell reuse and async session keys.
  - Uses `session.allocateOutputArtifact()` for spill files.
  - Invalidates `github-cache` rows before execution when the command contains a mutating `gh issue`/`gh pr` subcommand, so later `issue://`/`pr://` reads see post-mutation state (`invalidateGithubCacheForBashCommand`).
- User-visible prompts / interactive UI
  - PTY mode opens a TUI overlay titled `Console` and forwards input to the PTY.
  - Background start messages note that the result is delivered automatically when complete and that the `hub` tool can wait on it until then.
- Background work / cancellation
  - Async and auto-background jobs continue after the initial tool return, until completion, cancellation, or their deadline (unless `timeout: 0` disabled it).
  - Cancellation aborts the native run; PTY overlay dismissal also kills the PTY.

## Limits & Caps
- Default timeout: `300s` (`TOOL_TIMEOUTS.bash.default` in `packages/coding-agent/src/tools/tool-timeouts.ts`).
- `timeout: 0` disables the command deadline.
- Positive timeout clamp: `tools.maxTimeout` is an optional global ceiling (`0` means no global ceiling), followed by the Bash `1..3600s` range.
- Auto-background default threshold: `60_000ms` (`DEFAULT_AUTO_BACKGROUND_THRESHOLD_MS` in `packages/coding-agent/src/async/auto-background.ts`); explicit-auto grace default `1_000ms` (`bash.asyncAuto.inlineGraceMs`). A deadline at or below the threshold plus `AUTO_BACKGROUND_TIMEOUT_BUFFER_MS` (1 s) disables backgrounding for that call; a disabled deadline never does.
- Non-PTY executor with a deadline arms a host-side timer at `max(1_000, timeoutMs)` and passes the same positive timeout to the native run; `timeout: 0` passes no deadline. A timed-out persistent shell session is quarantined (`packages/coding-agent/src/exec/bash-executor.ts`).
- In-memory output tail cap: `50 * 1024` bytes (`DEFAULT_MAX_BYTES` in `packages/coding-agent/src/session/streaming-output.ts`). Once exceeded, the sink keeps only the tail window in memory.
- Streaming callback throttle in `executeBash()`: `50ms` between `onChunk` calls when streaming is enabled.
- TUI collapsed preview: `10` visual lines (`BASH_DEFAULT_PREVIEW_LINES`) when rendered inline in the agent UI; this is a renderer cap, not a tool output cap.

## Errors
- Input validation:
  - invalid env key -> `ToolError("Invalid bash env name: <key>")`.
  - async requested while disabled -> `ToolError("Async bash execution is disabled...")`.
  - missing async job manager -> `ToolError("Background job manager unavailable for this session.")`.
  - missing/bad `cwd` -> `ToolError("Working directory does not exist: ...")` or `ToolError("Working directory is not a directory: ...")`.
- Interceptor:
  - matched command -> `ToolError` with `Blocked: <rule.message>` and the original command.
  - invalid interceptor regexes are silently skipped by `compileRules()`.
- Internal URL expansion:
  - unsupported scheme, unknown skill, path traversal, missing router support, or router resolution failures all throw `ToolError` from `packages/coding-agent/src/tools/bash-skill-urls.ts`.
- Execution:
  - non-zero exit -> returned tool result marked `isError`, with `details.exitCode` and text ending in `Command exited with code <n>`.
  - missing exit code -> thrown `ToolError` with `Command failed: missing exit status`.
  - timeout -> local/PTY execution returns an `isError` result with `details.timedOut: true` and a timeout notice; the client-terminal bridge throws `ToolError` after killing the terminal and attempting a final output read. Managed background execution records either form as a failed job.
  - user abort -> `ToolAbortError` when the caller signal is aborted.
- Artifact allocation / artifact save failures are swallowed in `saveBashOriginalArtifact()` and `OutputSink.#createFileSink()`; execution continues without that artifact.

## Notes
- `strict = true` is set on `BashTool`; `concurrency` is resolved per call: `pty: true` is `"exclusive"` (it takes over the terminal UI), everything else is `"shared"`, so multiple non-pty bash calls in one assistant message run in parallel. When parallel calls overlap on the same shell session key, the first owns the persistent `Shell`; the rest run in isolated one-shot shells (see `shellSessionsInUse` in `bash-executor.ts`).
- `command` URL expansions shell-escape replacements; `env` and `cwd` expansion use `noEscape: true` because they become environment values / filesystem paths, not shell text.
- `checkBashInterception()` blocks only when the matching rule's `tool` name is present in `ctx.toolNames`; missing tools disable their corresponding rule.
- Interceptor configuration syntax is unchanged. It handles common flat command lists, not full shell parsing: heredocs, parameter expansion, command substitution, backticks, grouping, and malformed quoting only receive the existing whole-input check. This is best-effort routing toward dedicated tools, not a security boundary.
- `bash.direnv` defaults to `"auto"` and honors direnv's allow list; an unallowed `.envrc` is not executed. Set it to `"off"` to bypass preflight. `bash.direnvLoadTimeoutMs` controls the cold-load budget.
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
