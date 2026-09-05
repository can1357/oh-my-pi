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
| `async` | `boolean` | No | Background execution request. Present only when `async.enabled` is true for the session. Returns immediately with a job id instead of waiting; it does not change the effective deadline, including a disabled deadline from `timeout: 0`. |

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
- Success, background start (`async: true` or auto-background):
  - `content[0].text`: optional preview tail and notices, followed by `Backgrounded as job <id>; result will be delivered automatically.`
  - `details.async`: `{ state: "running", jobId, type: "bash" }`.
- Background progress / completion:
  - delivered through `onUpdate` / async job manager, not the initial return.
  - running updates contain tail text and `details.async.state: "running"` only after the job is considered backgrounded.
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

`bash.patterns` is for commands that must be allowed, confirmed by a person, or refused regardless of whether another tool could perform the work. Rules are ordered; the first matching rule wins. Each rule has a `match` glob and an `approval` value of `allow`, `prompt`, or `deny`. It is the command-granularity counterpart to the tool-granularity `tools.approval.<tool>` setting described in [Tool approval mode](../approval-mode.md#user-overrides).

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

#### Preset policies

Three ready-made rule sets. Paste one into `~/.omp/agent/config.yml` or a project config and edit from there. They are ordinary `bash.patterns` lists — there is no tier setting and no separate schema. Conservative and Balanced end with an explicit `match: "*"` fallback rule, the same technique Permissive already uses for its own fallback, so a command matching no other rule is at least prompted under every `tools.approvalMode` — including the default `yolo`. The one exception is a built-in critical pattern: closing that gap in `yolo` needs a non-`yolo` mode or an explicit `tools.approval.bash: prompt`/`deny` policy — `allow` does not qualify — since no `bash.patterns` rule can supply it — see the last matcher property below.

**Conservative** — nothing runs unattended except Git inspection commands.

```yaml
bash:
  patterns:
    - match: "rm -rf *"
      approval: deny
    - match: "sudo *"
      approval: deny
    - match: "git push --force*"
      approval: deny
    - match: "git reset --hard*"
      approval: deny
    - match: "curl *"
      approval: prompt
    - match: "wget *"
      approval: prompt
    - match: "git push*"
      approval: prompt
    - match: "git diff*--output*"
      approval: prompt
    - match: "git log*--output*"
      approval: prompt
    - match: "git show*--output*"
      approval: prompt
    - match: "git status"
      approval: allow
    - match: "git status *"
      approval: allow
    - match: "git diff"
      approval: allow
    - match: "git diff *"
      approval: allow
    - match: "git log"
      approval: allow
    - match: "git log *"
      approval: allow
    - match: "git show"
      approval: allow
    - match: "git show *"
      approval: allow
    - match: "*"
      approval: prompt
```

`git diff`, `git log`, and `git show` accept `--output=<file>`, which writes (and truncates an existing file at) `<file>` — the one way those three otherwise-read-only commands have a side effect from their own flags, which is why they get a dedicated prompt rule above instead of a bare allowance. These presets gate the literal command line; they cannot see or override the local Git configuration or a repository's own hooks. A `diff.external` helper, `core.pager`, `core.editor`, a credential helper, or a hook such as `pre-commit`/`post-checkout` can all execute arbitrary code as a side effect of an otherwise ordinary invocation like `git diff` — audit your own `git config --list` and hooks if that matters for your threat model, and pass an override such as `--no-ext-diff` on the command itself where you need one. This preset is not an exhaustive audit of every Git subcommand, flag, or configuration hook; add further `deny`/`prompt` rules for anything else your workflow needs to gate.

"Inspection" here is narrower than "no filesystem write". `git status` and `git diff` refresh the index when a tracked file's stat data is stale, which rewrites `.git/index` and takes the index lock — verified on Git 2.55.0 by `touch`ing an unmodified tracked file and observing the `.git/index` mtime advance after each of the two commands, while `git log` and `git show` leave it alone. No working-tree file, object, ref, or commit changes, but the write can contend with a concurrent Git process. Where the allowance has to be a strict no-write, replace those two rules with forms that disable the refresh — `GIT_OPTIONAL_LOCKS=0 git status`/`GIT_OPTIONAL_LOCKS=0 git status *` and `git -c diff.autoRefreshIndex=false diff`/`git -c diff.autoRefreshIndex=false diff *` — keeping the same exact-plus-space-suffixed boundary as the preset itself, since a bare trailing `*` on these forms would still let `GIT_OPTIONAL_LOCKS=0 git status-pwn` or `git -c diff.autoRefreshIndex=false difftool -x <command>` dispatch to a `PATH`-resolved external command. This accepts that the allowance then applies only when the command line carries that exact prefix, and note that `GIT_OPTIONAL_LOCKS=0` suppresses the refresh for `git status` but not for `git diff`.

**Balanced** — routine development commands run unattended; network egress, publishing, and history rewrites stop for a person.

The `git *` allowance below is an explicit blocklist, not an allowlist: it permits every Git subcommand except the network, history-rewrite, and publishing forms named above. Git's subcommand and flag surface is too large to enumerate exhaustively — treat the guarded list as covering the common cases, not a guarantee, and use Conservative (which allows only four `git` inspection subcommands) wherever an incomplete blocklist is not an acceptable risk.

```yaml
bash:
  patterns:
    - match: "rm -rf *"
      approval: deny
    - match: "sudo *"
      approval: deny
    - match: "*git*push*--force*"
      approval: deny
    - match: "curl *"
      approval: prompt
    - match: "wget *"
      approval: prompt
    - match: "*git*push*"
      approval: prompt
    - match: "npm publish*"
      approval: prompt
    - match: "*git*reset --hard*"
      approval: prompt
    - match: "*git*rebase*"
      approval: prompt
    - match: "*git*fetch*"
      approval: prompt
    - match: "*git*pull*"
      approval: prompt
    - match: "*git*clone*"
      approval: prompt
    - match: "*git*ls-remote*"
      approval: prompt
    - match: "*git*commit*--amend*"
      approval: prompt
    - match: "*git*branch*-f*"
      approval: prompt
    - match: "*git*archive*--remote*"
      approval: prompt
    - match: "*git*submodule*update*"
      approval: prompt
    - match: "*git*checkout*-B*"
      approval: prompt
    - match: "*git*switch*-C*"
      approval: prompt
    - match: "*git*switch*--force-create*"
      approval: prompt
    - match: "git *"
      approval: allow
    - match: "bun*publish*"
      approval: prompt
    - match: "bun *"
      approval: allow
    - match: "make*publish*"
      approval: prompt
    - match: "make"
      approval: allow
    - match: "make *"
      approval: allow
    - match: "*"
      approval: prompt
```

The `git` rules above cover Git's own network, history-rewrite, force-branch-move, submodule-network, and amend/reset-form subcommands, including a leading global option such as `-C <path>`; other subcommands (`add`, `diff`, `log`, `merge`, plain `checkout`/`switch`, …) still fall through to the broad `git *` allowance. This list targets the risk categories the preset's own description names — network egress, publishing, and history rewrites — not every Git subcommand or config-driven side effect (a repository hook or a helper such as `diff.external` can still run arbitrary code; see the note under Conservative); add further rules for anything else you want gated. "Network egress" here means ad hoc network commands — `curl`, `wget`, and Git's own remote operations (`fetch`, `pull`, `clone`, `ls-remote`, `push`, `archive --remote`, `submodule update --init`/`--remote`) — not a project's own declared package-manager operations. `bun install` and `bun add` also contact a registry, and this preset auto-approves them on purpose rather than because a committed lockfile constrains them: `bun add <pkg>` resolves a brand-new dependency straight from the npm registry and persists it to both `package.json` and the lockfile, since `--save` is the default and `--frozen-lockfile` is opt-in. The allowance therefore covers introducing and recording a new dependency unattended, not just reinstalling what is already committed — the same posture as `bun *`/`make *` running whatever a project defines under that name (this preset has no `npm *` allowance, so a bare `npm install` falls to the trailing prompt rule, not to an allowance). Narrow this preset (or use Conservative) if package-manager network access needs a prompt too. `bun *` and `make *` allow whatever a project defines under `package.json` scripts or a `Makefile` target of that name. The `bun*publish*` prompt rule also catches a script invocation containing the word `publish` (`bun run publish`), since the matcher only sees the literal command line — but not a differently-named script whose implementation happens to call `npm publish` (`bun run release`), or a destructive command hidden behind an unrelated script name; `bash.patterns` cannot see inside a script.

**Permissive** — in the default `yolo` approval mode, everything runs unattended except a short refusal list.

```yaml
bash:
  patterns:
    - match: "rm -rf *"
      approval: deny
    - match: "rm -fr *"
      approval: deny
    - match: "rm -r -f *"
      approval: deny
    - match: "rm -f -r *"
      approval: deny
    - match: "rm --recursive --force*"
      approval: deny
    - match: "rm --force --recursive*"
      approval: deny
    - match: "sudo *"
      approval: deny
    - match: "*git*push*--force*"
      approval: prompt
    - match: "*git*push*-f*"
      approval: prompt
    - match: "*git*push*-uf*"
      approval: prompt
    - match: "*git*push*-fu*"
      approval: prompt
    - match: "*"
      approval: allow
```

The `rm` and `git push` rules above cover the common flag orderings and global-option placement, not every possible invocation — `rm` accepts further equivalent short/long flag permutations, and a command can still be built to evade a literal-plus-wildcard matcher. `git push -uf` is a real, commonly-used bundled short form of `--set-upstream --force` (verified with Git 2.55.0), so it needs its own rule alongside `-uf`'s less common reordering `-fu`: neither contains `-f` or `--force` as a matched substring on its own without them. Treat Permissive as a fast default, not a security boundary; use Conservative or Balanced where that distinction matters. The "everything unattended" framing describes `yolo` specifically: the trailing `match: "*"` allowance never applies to a command containing shell control syntax (see the matcher properties below), so `echo $HOME` gets no `bash.patterns` verdict at all and falls back to the Bash tool's own `exec` tier — auto-approved under `yolo`, but prompted under `tools.approvalMode: write`/`always-ask`. A critical-pattern command prompts in those non-`yolo` modes too, regardless of any `bash.patterns` policy.

Four properties of the matcher decide whether a preset behaves as written:

- **Order the refusals first.** The first matching rule wins, and `allow` is checked by the same scan. `match: "git *"` placed above `match: "git push --force*"` allows the force-push, because the `allow` rule matches first.
- **`*` is the only wildcard and it matches any run of characters, including none.** `match: "git status*"` covers both `git status` and `git status --short`; `match: "git status"` covers only the exact command. The glob is anchored to the whole command line after runs of whitespace are collapsed to single spaces. There is no subcommand word boundary: `match: "git diff*"` also covers `git difftool` (a real Git subcommand that shells out to an external diff viewer) *and* `git status-pwn` or any other `git <status-suffix>` string, because an unrecognized subcommand name is dispatched by Git itself to a `git-<name>` executable found on `PATH` — Git's own "external commands" mechanism. An `allow` rule meant for one inspection subcommand needs the exact form plus a space-suffixed variant (`match: "git diff"` and `match: "git diff *"`), not a bare trailing `*`; the Conservative preset above does this for all four of `git status`/`git diff`/`git log`/`git show` so a same-prefixed subcommand or a `PATH`-installed `git-<name>` helper can't slip through as an auto-approved inspection command.
- **`allow` never applies to a command line containing shell control syntax.** Any of `;`, `&`, `|`, `<`, `>`, `` ` ``, `$`, `(`, `)`, or a newline disqualifies every `allow` rule for that call, so a narrow allowance cannot be used to smuggle an extra segment. `git status && rm -rf build` is not allowed by `match: "git *"`, and neither is `echo $HOME`. `deny` and `prompt` are unaffected: they match the whole line and each shell segment.
- **Critical patterns force a prompt only outside `yolo` mode, or with an explicit `prompt`/`deny` tool policy — an explicit `allow` does not qualify.** A command matching a built-in critical pattern — `rm -rf /`, fork bombs, remote-fetch-then-execute, writes to `/etc/passwd`, host shutdown — carries a safety override, but `BashTool.approval()` returns that override *before* it reads any matching `bash.patterns` `allow`/`prompt` rule (`bash.ts:501-502` runs before `:504`), so the override itself carries no `bash.patterns` policy. `resolveApproval()` ignores an override with no policy in the default `yolo` mode (`approval.ts:132-147`), so a critical command not covered by an earlier `bash.patterns` `deny` rule still runs unattended under `yolo` — including when `tools.approval.bash` is explicitly `allow`. A `bash.patterns` `deny` rule still takes priority in every mode, since the deny check (`bash.ts:493`) runs before the critical check. To make the override itself stop a critical command, run a non-`yolo` `tools.approvalMode` (see [Modes](../approval-mode.md#modes)) or set `tools.approval.bash: prompt`/`deny`, consistent with [Safety overrides](../approval-mode.md#safety-overrides).

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
3. If `async: true` is requested while `async.enabled` is off, it throws `ToolError` before any execution.
4. If `bashInterceptor.enabled` is on, `checkBashInterception()` runs against both the original command and the `cd`-stripped command. For each form, configured regexes still check the complete input first, then each flat command separated by unquoted/unescaped `&&`, `||`, `;`, `|`, `|&`, `&`, or newlines (excluding stages that consume piped stdin from `|` or `|&`, including across blank/comment continuations), followed by versions of those fragments without leading `NAME=value` assignments. A matching enabled rule throws before URL expansion or execution.
5. `expandInternalUrls()` rewrites supported internal URLs inside `command`, each `env` value, and protocol-looking `cwd` values. Command replacements are shell-escaped; `env` and `cwd` replacements use raw filesystem/string values because they are not interpolated into shell text.
6. `resolveToCwd()` resolves `cwd` against `session.cwd`; `fs.stat()` verifies that the target exists and is a directory.
7. `timeout: 0` disables the deadline. Otherwise `clampTimeout("bash", requestedTimeoutSec, tools.maxTimeout)` applies a positive global ceiling (when configured), then `TOOL_TIMEOUTS.bash` (`min: 1`, `max: 3600`). When clamped, `#buildCompletedResult()` / `#buildBackgroundStartResult()` append a notice line.
8. Execution path splits:
   1. `async: true` -> `#startManagedBashJob()` registers a session async job and returns immediately.
   2. Non-PTY with `bash.autoBackground.enabled`, an async job manager below its running-job cap, and no client-terminal bridge available (the bridge wins when both apply) -> starts a managed job, waits up to `min(thresholdMs, timeoutMs - 1000)`, and either returns the completed result or converts the run into a background job.
   3. Non-PTY client-terminal bridge, when the session advertises terminal capability and `pty` is false -> creates a remote terminal, streams/polls current output, and releases the terminal after completion.
   4. Otherwise runs foreground execution.
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
5. Auto-backgrounded non-PTY job
   - Requires `bash.autoBackground.enabled`, no PTY/client-terminal bridge, and an async job manager below its running-job cap.
   - Starts like a foreground managed job, then backgrounds it when it outlives the wait window; at capacity, Bash falls back to direct foreground execution.
6. Intercepted command
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
- Auto-background default threshold: `60_000ms` (`DEFAULT_AUTO_BACKGROUND_THRESHOLD_MS` in `packages/coding-agent/src/tools/bash.ts`), further capped to `timeoutMs - 1000` when a deadline exists; a disabled deadline leaves the threshold uncapped.
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
