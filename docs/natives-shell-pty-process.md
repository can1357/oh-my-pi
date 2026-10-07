# Natives Shell, PTY, Process, and Key Internals

This document covers execution/process/terminal primitives in `@oh-my-pi/pi-natives`: `shell`, `pty`, `ps`, and `keys`, using the architecture terms from `docs/natives-architecture.md`.

## Implementation files

- `crates/pi-natives/src/shell.rs`
- `crates/pi-natives/src/shell/vfs.rs` (host-injected filesystem bridge)
- `crates/pi-vfs/` (shared filesystem abstraction)
- `crates/pi-shell/src/shell.rs`
- `crates/pi-shell/src/cancel.rs`
- `crates/pi-builtins` (embedded-shell builtins: bash builtins plus in-process utility/process commands)
- `crates/pi-shell/src/windows.rs` (Windows-only PATH enrichment)
- `crates/pi-shell/src/process.rs`
- `crates/pi-natives/src/pty.rs`
- `crates/pi-natives/src/ps.rs`
- `crates/pi-natives/src/keys.rs`
- `crates/pi-natives/src/task.rs`
- `packages/natives/native/index.d.ts`

## Layer ownership

- **Package entrypoint** (`packages/natives/native/index.js`): loads the `.node` addon and exports generated N-API bindings.
- **Rust N-API module layer** (`crates/pi-natives/src/*`): JS-facing shell/PTY/process/key exports and callback bridging.
- **Runtime core** (`crates/pi-shell/src/*`): brush shell execution, cancellation cleanup, minimizer integration, command fixups, and cross-platform process references.
- **Consumers** (`packages/coding-agent`, `packages/tui`): higher-level session policy, output artifact/minimizer handling, render policy, and UI key handling.

## Shell subsystem (`shell`)

### API model

Shell execution modes:

1. **One-shot** via `executeShell(options, onChunk?)`.
2. **Persistent session** via `new Shell(options?)` then `shell.run(...)` repeatedly.

Both stream merged stdout/stderr text through a threadsafe callback and return `{ exitCode?, cancelled, timedOut, minimized?, workingDir? }`.

Persistent `Shell` also exposes `liveBackgroundJobCount()`, which silently reaps completed jobs and returns the number of live jobs tracked by the session. Hosts can retain per-call shells while ordinary background jobs remain alive. Builtin `nohup <command> &` is special: brush detaches and reparents the operand so it survives shell teardown; this is not the behavior of the system `nohup` binary.

`ShellOptions` supports `sessionEnv`, `snapshotPath`, output `minimizer`, and `filesystem`. `ShellExecuteOptions` additionally supports `command`, `cwd`, command-scoped `env`, `timeoutMs`, and `signal`. `ShellRunOptions` supports `command`, `cwd`, command-scoped `env`, `timeoutMs`, `signal`, and a run-only `filesystem` override.

### Session creation and environment model

Rust creates `brush_core::Shell` with:

- inherited environment disabled (`do_not_inherit_env: true`), followed by explicit environment reconstruction from host env,
- profile and rc loading skipped,
- bash-mode builtins, with `exec` and `suspend` disabled,
- process builtins registered unconditionally from `pi_builtins::process_builtins()` — `nohup`, `pgrep`, `pkill`, `pidwait`, `ps`, `sleep`, `timeout`, and `top` (`nohup` is withheld when `PI_DISABLE_NOHUP_BUILTIN` is set; `kill` comes from the default bash-mode set, where `pi-builtins`' richer implementation replaces brush's original),
- in-process utility builtins registered from `pi_builtins::utility_builtins()` (see the next section),
- an opt-in `git` builtin (`crates/pi-shell/src/git.rs`, gated by `PI_SMART_GIT`) that serves supported `git worktree add` invocations through `pi-vcs`: copy-on-write clone, worktree registration, and reconciliation to the target commit, with an in-process checkout fallback when cloning is unavailable. Unsupported commands/options/repository configurations run the git binary with the original arguments,
- skip-list for shell-sensitive vars (`PS1`, `PWD`, `SHLVL`, bash function exports, etc.),
- a non-exported `env="$env"` fallback so PowerShell-style `$env:NAME` survives brush parameter expansion unless the user shadows `env`.

Session env behavior:

- `ShellOptions.sessionEnv` / one-shot `sessionEnv` is applied at session creation.
- `ShellRunOptions.env` / one-shot `env` is command-scoped (`EnvironmentScope::Command`) and popped after the command.
- `PATH` is merged specially on Windows with case-insensitive dedupe.
- Host and forwarded session environments omit Git repository-location overrides (`GIT_DIR`, `GIT_COMMON_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_OBJECT_DIRECTORY`, `GIT_ALTERNATE_OBJECT_DIRECTORIES`), so Git rediscovers the repository from cwd. Explicit command-scoped `env` can supply them again.
- Windows-only path enrichment (`crates/pi-shell/src/windows.rs`) appends discovered Git-for-Windows paths when present and not already included.
- `snapshotPath`, when present, is sourced during session creation with stdout/stderr/stdin wired to null files.

### Host-injected filesystem

`filesystem` is `{ handler: (error: Error | null, request: ShellFsRequest) => Promise<ShellFsResponse>, nativeLocalPaths?: boolean }`. The bridge covers shell redirections, globs, cwd changes, and in-process utility file operations; paths travel verbatim, including absolute `scheme://` URLs. With `nativeLocalPaths: true`, all host paths bypass the handler and only URL paths are routed to it; otherwise the handler receives host paths too. Ordinary external programs still use the OS filesystem rather than this callback interface.

Requests identify an operation (`metadata`, `readDir`, `open`, `read`, `write`, `close`, mutation operations, and others); generated `ShellFs*` types define the complete wire contract. Binary payloads use `Uint8Array`/`Buffer`; positional request offsets and other `u64` quantities use `bigint`, while responses accept exact `number | bigint`. Return `{ error: { code, message? } }` for filesystem errors; rejected promises or malformed responses are provider failures. `local`/`localTarget` responses can delegate operations to native host paths after the provider applies its access policy.

The session filesystem is restored after a run-only override. Provider waits are scoped to run cancellation. Successful runs wait for dropped virtual-file closes so writes have settled; close failures are reported on stderr and fail otherwise-successful commands.

### In-process utility builtins (uutils-derived)

Beyond the bash builtins, session creation registers the in-process command-line utility builtins implemented in the `pi-builtins` crate (`crates/pi-builtins`) — in-house ports of uutils coreutils/findutils/sed and jaq built on `uucore` 0.8.0. The set includes `cat`, `head`, `tail`, `wc`, `sort`, `uniq`, `ls`, `find`, `grep`, `mkdir`, `rm`, `mv`, `cp`, `ln`, `sed`, `jq`, `fd`, `diff`, the checksum/`tr`/`cut`/`date` families, and more; `pi_builtins::utility_builtins()` is the authoritative list.

Three search-related builtins are worth calling out:

- `grep` is implemented on the ripgrep libraries (`grep-regex`/`grep-searcher`), with recursive directory walks served by `pi-walker`.
- `rg` is a sibling builtin with ripgrep defaults (recursive search, ignore/hidden filtering, binary suppression) — a separate module and argument model, not an alias of `grep`.
- `fd` is backed by `pi-walker`, `globset`, and `regex`.

Each builtin runs inside the shell process (no `fork`/`exec`) against the `pi-builtins` `Host` view of the shell (`src/host.rs`): stdio routes through the command's (possibly piped/redirected) file descriptors, path operands resolve against the shell working directory, the shell's exported environment is visible, and abort/timeout cancellation is honored. Because these builtins shadow system binaries, registration is gated in `crates/pi-shell/src/shell.rs`:

- `PI_DISABLE_UUTILS_BUILTINS` disables the whole utility set (bare names resolve to system binaries again),
- `PI_DISABLE_UUTILS_DESTRUCTIVE` disables the destructive shadows (`rm`, `mv`, `cp`, which overwrites existing files, and `ln`, which can clobber via `-f`) together,
- `PI_DISABLE_RM_BUILTIN` / `PI_DISABLE_MV_BUILTIN` disable `rm`/`mv` individually.

Builtin switches are read from `sessionEnv` first, then the process environment, during session creation. Values are truthy when present and not empty, `"0"`, or case-insensitive `"false"`; command-scoped `env` does not change registration.

### Runtime lifecycle and state transitions

Persistent shell (`Shell.run`) uses this state machine:

- **Idle/Uninitialized**: `session: None`.
- **Running**: first `run()` lazily creates a session, stores an abort token, executes command.
- **Completed + keepalive**: if execution control flow is normal, abort state is cleared and session is reused.
- **Completed + teardown**: if control flow is loop/script/shell-exit related, session is dropped.
- **Cancelled/Timed out**: Tokio cancellation is triggered; a per-run spawn registry targets that run's processes and descendants with TERM/KILL waves. A 2-second graceful task wait is allowed (5 seconds on Windows), the task may be aborted, and the persistent session is dropped if the lock can be acquired.
- **Error**: session is dropped.

One-shot shell (`executeShell`) always creates and drops a fresh session per call.

### Streaming/output and minimizer behavior

- Stdout/stderr are routed into a shared pipe and read concurrently.
- Reader decodes UTF-8 incrementally; invalid byte sequences emit `U+FFFD` replacement chunks.
- The N-API output bridge has a bounded 64-chunk queue and awaits callback execution, backpressuring pipe readers and the child. Queued chunks are coalesced before forwarding. A single callback stalled for 30 seconds disconnects the bridge so readers can continue draining.
- The command runs with `ProcessGroupPolicy::NewProcessGroup`.
- After the foreground command completes, the reader drains until EOF, 250ms of idle output, or 2s maximum; reader shutdown then gets a 250ms timeout.
- The JS forwarding pump then drains accepted output on normal completion/errors; interrupted runs allow at most 2 seconds before aborting that pump. Cancellation delays reader shutdown by 500ms on non-Windows or 2s on Windows so pipeline consumers can flush.
- Optional minimizer configuration can capture and rewrite output. When minimization occurs, the result includes `minimized` with filter name, replacement/original text, and byte counts.
- A successful result can include `workingDir`, reflecting the shell's cwd after execution.
- Consumers are responsible for persisting or displaying minimizer artifacts; the native result only carries the data.

### Cancellation, timeout, and abort

- `CancelToken` is constructed from `timeoutMs` and optional `AbortSignal`, then converted into the shared `pi_shell::cancel::CancelToken`.
- On cancellation/timeout, shell cancellation token is triggered, descendant cleanup runs, then the task gets a 2-second graceful window (5 seconds on Windows) before forced abort.
- Structured result flags are used:
  - timeout -> `exitCode` omitted, `timedOut: true`.
  - abort signal / `Shell.abort()` -> `exitCode` omitted, `cancelled: true`.

`Shell.abort()` behavior:

- aborts the current running command for that `Shell` instance through the stored `AbortToken`,
- resolves successfully even when nothing is running.

### Failure behavior

Common surfaced errors include:

- session init failures (`Failed to initialize shell`),
- cwd errors (`Failed to set cwd`),
- env set/pop failures,
- snapshot source failures (`Failed to source snapshot`),
- pipe creation/clone failures,
- execution failure (`Shell execution failed: ...`),
- task wrapper failures (`Shell execution task failed: ...`).

## PTY subsystem (`pty`)

### API model

`new PtySession()` exposes:

- `start(options, onChunk?, onStart?) -> Promise<{ exitCode?, cancelled, timedOut }>` runs a command string through a shell.
- `startArgv(options, onChunk?, onStart?)` runs an application and argument vector directly, without shell parsing.
- `write(data)`
- `resize(cols, rows)`
- `kill()`

Both start methods invoke `onStart(error, pid)` after spawning (the implementation supplies `0` only if a platform child PID is unavailable). `PtyStartOptions` supports `command`, optional `cwd`, optional `env`, `timeoutMs`, `signal`, `cols`, `rows`, and `shell`; its default shell is `sh`. `PtyArgvStartOptions` instead requires `application` and `args` and has no `shell`.

### Runtime lifecycle and state transitions

`PtySession` state machine:

- **Idle**: `core: None`.
- **Reserved**: `start()` installs control channel synchronously (`core: Some`) before async work begins, so `write/resize/kill` become immediately valid.
- **Running**: blocking PTY loop handles child state, reader events, cancellation heartbeat, and control messages.
- **Terminal closed / drain**: child exit or cancellation starts a short reader drain window.
- **Finalized**: `core` is always reset to `None` after start task completion (success or error).

Concurrency guard:

- starting while already running returns `PTY session already running`.

### Spawn/attach/write/read/terminate patterns

- PTY opened via `portable_pty::native_pty_system().openpty(...)`.
- On Windows, `openpty()` is run on a helper thread with a 5s startup timeout; timeout rejects with `PTY creation timed out (5s). ConPTY may be unavailable on this system.`
- `start()` runs the command through the configured shell:
  - `cmd.exe`/`cmd` gets `/c`,
  - `powershell`/`pwsh` gets `-Command`,
  - other shells get `-lc`.
- `startArgv()` passes each argument directly to `portable_pty::CommandBuilder`.
- PTY commands inherit the process environment after stripping Git repository-location overrides; explicit PTY `env` values can add them back.
- Default size is `120x40`; dimensions are clamped (`cols 20..400`, `rows 5..200`) on start and resize.
- `write(data: string)` sends the string's UTF-8 bytes to PTY stdin.
- `resize()` sends a control message and clamps dimensions again.
- `kill()` sends a control message that marks the run cancelled and terminates PTY process targets.

Output path:

- a dedicated reader thread reads the master stream and incrementally decodes UTF-8, replacing invalid bytes with `U+FFFD`,
- a bounded 64-chunk queue backpressures that reader; a separate async pump coalesces output and awaits N-API callback execution,
- the control loop never waits on JS callback execution, so input, resize, kill, and child-status checks remain live.

Termination path:

- `terminate_pty_processes` targets the PTY process group when available and the child pid when available.
- It sends the platform `TERM_SIGNAL`, calls `child.kill()`, then sends the platform `KILL_SIGNAL`.
- On Windows, ConPTY input is closed before dropping the master; master drop is offloaded to a background thread and waited for up to 2s to avoid deadlock.

### Cancellation and timeout semantics

- `timeoutMs` and `AbortSignal` feed a `CancelToken`.
- Preflight heartbeat checks before `openpty` and spawn reject cancellation as setup errors.
- The running loop calls `ct.heartbeat()` with a 16ms maximum control wait cadence. Timeout classification uses a heartbeat error containing `Timeout`.
- Cancellation, kill, or a lost JS callback terminates process targets and starts a 300ms post-cancel window. The result may still include an exit code observed while reaping.
- On non-Windows, cancelled-child reaping polls for up to 500ms, then delegates an unfinished reap to a detached thread rather than pinning the promise.
- Normal finite runs wait for accepted output to reach JS. A descendant that holds the slave open can end draining after 2s with an empty queue and no callback in flight; backpressure is not treated as an idle slave.
- Interrupted runs abort a slow output pump and wait up to 300ms for it to stop; an already-queued JS callback may still run.

### Failure behavior

Error surfaces include:

- PTY allocation/open failure,
- Windows PTY startup timeout,
- PTY spawn failure,
- writer/reader acquisition failure,
- child status/wait failures,
- control-channel disconnection (`PTY session is no longer available`).

Control call failures when not running:

- `write/resize/kill` return `PTY session is not running`.

## Process subsystem (`ps`)

### API model

Current JS surface is the `Process` class:

- `Process.fromPid(pid) -> Process | null`
- `Process.fromPath(path) -> Process[]`
- getters: `pid`, `ppid`
- methods: `args()`, `killTree(signal?)`, `terminate(options?)`, `waitForExit(options?)`, `groupId()`, `children()`, `status()`

`ProcessTerminateOptions` supports `{ group?, gracefulMs?, timeoutMs?, signal? }`. `ProcessWaitOptions` supports `{ timeoutMs?, signal? }`.

### Behavior

- `killTree(signal?)` defaults to the hard-kill signal, sends it to the process and descendants children-first, and returns the number signalled; on Windows the signal argument is ignored and processes are terminated via `TerminateProcess`.
- `terminate(options?)` is async and resolves whether the tree exited within its wait windows. Defaults are 1000ms graceful wait and 5000ms post-hard-kill wait. `gracefulMs < 0` skips the graceful wait, not the initial polite signal. `group: true` also targets the process group where supported; aborting its signal rejects termination waits.
- `waitForExit(options?)` resolves `true` when the process exits and `false` on timeout; aborting its signal rejects the promise.

The platform-specific implementation lives in `pi_shell::process`; `crates/pi-natives/src/ps.rs` is a N-API shim plus re-exports used by PTY termination.

`execReplace(argv)` is a separate synchronous process handoff: on Unix it calls `execvp`, replacing the host process without JS/native cleanup on success. Callers must restore the terminal and flush logs first. Empty argv, interior NUL bytes, exec failures, and unsupported platforms throw; Windows callers must use spawn-and-wait instead.

`expandWindowsLongPath(path)` and `getWindowsShortPath(path)` are exported from `shell.rs`. They preserve the input when expansion/short-name lookup fails and are identity functions off Windows.

## Key parsing subsystem (`keys`)

### API model

Exposed helpers:

- `parseKey(data, kittyProtocolActive)`
- `matchesKey(data, keyId, kittyProtocolActive)`
- `parseKittySequence(data)`
- `matchesKittySequence(data, expectedCodepoint, expectedModifier)`
- `matchesLegacySequence(data, keyName)`

### Parsing model

The parser combines:

- direct single-byte mappings (`enter`, `tab`, `ctrl+<letter>`, printable ASCII),
- O(1) legacy escape-sequence lookup (PHF map),
- xterm `modifyOtherKeys` parsing,
- Kitty protocol parsing (`CSI u`, `CSI ~`, `CSI 1;...<letter>`),
- normalization to key IDs (`ctrl+c`, `shift+tab`, `pageUp`, `f5`, etc.).

Modifier handling:

- high-level key IDs support shift/alt/ctrl/super,
- Kitty matching masks caps-lock and num-lock bits before comparing modifier masks; unsupported modifier bits are not silently ignored.

Layout behavior:

- base-layout fallback is intentionally constrained so remapped layouts do not create false matches for ASCII letters/symbols.
- `parseKey` and high-level `matchesKey` ignore Kitty release events; `parseKittySequence` preserves the event type (press/repeat/release) for callers that need it.

### Failure behavior

- Unrecognized or invalid sequences produce `null` from parse functions.
- Match functions return `false` on parse failure or mismatch.
- No thrown error surface for malformed key input.

## JS API ↔ Rust export mapping

### Shell + PTY + Process

| JS API                                       | Rust N-API export                  | Notes                                            |
| -------------------------------------------- | ---------------------------------- | ------------------------------------------------ |
| `executeShell(options, onChunk?)`            | `executeShell` (`execute_shell`)   | One-shot shell execution                         |
| `new Shell(options?)`                        | `Shell` class                      | Persistent shell session                         |
| `shell.run(options, onChunk?)`               | `Shell::run`                       | Reuses session on keepalive control flow         |
| `shell.abort()`                              | `Shell::abort`                     | Aborts active run for that shell instance        |
| `shell.liveBackgroundJobCount()`             | `Shell::live_background_job_count` | Reaps jobs, then counts live background children |
| `new PtySession()`                           | `PtySession` class                 | Stateful PTY session                             |
| `pty.start(options, onChunk?, onStart?)`     | `PtySession::start`                | Shell-command PTY run                            |
| `pty.startArgv(options, onChunk?, onStart?)` | `PtySession::start_argv`           | Direct executable/argv PTY run                   |
| `pty.write(data)`                            | `PtySession::write`                | Raw stdin passthrough                            |
| `pty.resize(cols, rows)`                     | `PtySession::resize`               | Clamped terminal dimensions                      |
| `pty.kill()`                                 | `PtySession::kill`                 | Terminates active PTY child/targets              |
| `Process.fromPid(pid)`                       | `Process::from_pid`                | Stable process reference lookup                  |
| `Process.fromPath(path)`                     | `Process::from_path`               | Executable-path process lookup                   |
| `process.killTree(signal?)`                  | `Process::kill_tree`               | Children-first process tree termination          |
| `process.terminate(options?)`                | `Process::terminate`               | Graceful then hard process termination           |
| `process.waitForExit(options?)`              | `Process::wait_for_exit`           | Async exit wait                                  |
| `process.children()`                         | `Process::children`                | Direct children as `Process[]`                   |
| `process.status()`                           | `Process::status`                  | `running` / `exited`                             |

### Keys

| JS API                                         | Rust N-API export                                   | Notes                           |
| ---------------------------------------------- | --------------------------------------------------- | ------------------------------- |
| `matchesKittySequence(data, cp, mod)`          | `matchesKittySequence` (`matches_kitty_sequence`)   | Kitty codepoint+modifier match  |
| `parseKey(data, kittyProtocolActive)`          | `parseKey` (`parse_key`)                            | Normalized key-id parser        |
| `matchesLegacySequence(data, keyName)`         | `matchesLegacySequence` (`matches_legacy_sequence`) | Exact legacy sequence map check |
| `parseKittySequence(data)`                     | `parseKittySequence` (`parse_kitty_sequence`)       | Structured Kitty parse result   |
| `matchesKey(data, keyId, kittyProtocolActive)` | `matchesKey` (`matches_key`)                        | High-level key matcher          |

## Abandoned session cleanup and finalization notes

- **Shell persistent session**: if a run is cancelled/timed out/errors/non-keepalive control flow, Rust drops the internal session state. Successful normal runs keep the session for reuse.
- **PTY session**: `core` is always cleared after `start()` finishes, including failure paths.
- **No explicit JS finalizer-driven kill contract** is exposed by wrappers; cleanup is primarily tied to run completion/cancellation paths. Callers should use `timeoutMs`, `AbortSignal`, `shell.abort()`, or `pty.kill()` for deterministic teardown.
