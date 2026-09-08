# Natives Shell, PTY, Process, and Key Internals

This document covers execution/process/terminal primitives in `@oh-my-pi/pi-natives`: `shell`, `pty`, `ps`, and `keys`, using the architecture terms from `docs/natives-architecture.md`.

## Implementation files

- `crates/pi-natives/src/shell.rs`
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

Persistent `Shell` also exposes `liveBackgroundJobCount()`, which silently reaps completed jobs and returns the number of live `&`/`nohup` children. This lets a host retain a per-call shell while background children remain alive; dropping the shell would kill them.

`ShellOptions` supports `sessionEnv`, `snapshotPath`, and optional output `minimizer`. `ShellExecuteOptions` additionally supports command, cwd, command-scoped `env`, timeout/signal, and minimizer. `ShellRunOptions` supports command, cwd, command-scoped env, timeout, and signal.

### Session creation and environment model

Rust creates `brush_core::Shell` with:

- inherited environment disabled (`do_not_inherit_env: true`), followed by explicit environment reconstruction from host env,
- profile and rc loading skipped,
- bash-mode builtins, with `exec` and `suspend` disabled,
- process builtins registered unconditionally from `pi_builtins::process_builtins()` — `nohup`, `pgrep`, `pkill`, `pidwait`, `ps`, `sleep`, `timeout`, and `top` (`nohup` is withheld when `PI_DISABLE_NOHUP_BUILTIN` is set; `kill` comes from the default bash-mode set, where `pi-builtins`' richer implementation replaces brush's original),
- in-process utility builtins registered from `pi_builtins::utility_builtins()` (see the next section),
- skip-list for shell-sensitive vars (`PS1`, `PWD`, `SHLVL`, bash function exports, etc.),
- a non-exported `env="$env"` fallback so PowerShell-style `$env:NAME` survives brush parameter expansion unless the user shadows `env`.

Session env behavior:

- `ShellOptions.sessionEnv` / one-shot `sessionEnv` is applied at session creation.
- `ShellRunOptions.env` / one-shot `env` is command-scoped (`EnvironmentScope::Command`) and popped after the command.
- `PATH` is merged specially on Windows with case-insensitive dedupe.
- Windows-only path enrichment (`pi-shell/src/windows.rs`) appends discovered Git-for-Windows paths when present and not already included.
- `snapshotPath`, when present, is sourced during session creation with stdout/stderr/stdin wired to null files.

### In-process utility builtins (uutils-derived)

Beyond the bash builtins, session creation registers the in-process command-line utility builtins implemented in the `pi-builtins` crate (`crates/pi-builtins`) — in-house ports of uutils coreutils/findutils/sed and jaq built on `uucore` 0.8.0. The set includes `cat`, `head`, `tail`, `wc`, `sort`, `uniq`, `ls`, `find`, `grep`, `mkdir`, `rm`, `mv`, `ln`, `sed`, `jq`, `fd`, `diff`, the checksum/`tr`/`cut`/`date` families, and more; `pi_builtins::utility_builtins()` is the authoritative list.

Three search-related builtins are worth calling out:

- `grep` is implemented on the ripgrep libraries (`grep-regex`/`grep-searcher`), with recursive directory walks served by `pi-walker`.
- `rg` is a sibling builtin with ripgrep defaults (recursive search, ignore/hidden filtering, binary suppression) — a separate module and argument model, not an alias of `grep`.
- `fd` is backed by `pi-walker`, `globset`, and `regex`.

Each builtin runs inside the shell process (no `fork`/`exec`) against the `pi-builtins` `Host` view of the shell (`src/host.rs`): stdio routes through the command's (possibly piped/redirected) file descriptors, path operands resolve against the shell working directory, the shell's exported environment is visible, and abort/timeout cancellation is honored. Because these builtins shadow system binaries, registration is gated in `crates/pi-shell/src/shell.rs`:

- `PI_DISABLE_UUTILS_BUILTINS` disables the whole utility set (bare names resolve to system binaries again),
- `PI_DISABLE_UUTILS_DESTRUCTIVE` disables the destructive shadows (`rm`, `mv`, and `ln`, which can clobber via `-f`) together,
- `PI_DISABLE_RM_BUILTIN` / `PI_DISABLE_MV_BUILTIN` disable `rm`/`mv` individually.

### Runtime lifecycle and state transitions

Persistent shell (`Shell.run`) uses this state machine:

- **Idle/Uninitialized**: `session: None`.
- **Running**: first `run()` lazily creates a session, stores an abort token, executes command.
- **Completed + keepalive**: if execution control flow is normal, abort state is cleared and session is reused.
- **Completed + teardown**: if control flow is loop/script/shell-exit related, session is dropped.
- **Cancelled/Timed out**: Tokio cancellation token is triggered, descendants started after the baseline snapshot receive termination waves, a 2-second graceful wait is allowed, the task may be aborted, and the persistent session is dropped if the lock can be acquired.
- **Error**: session is dropped.

One-shot shell (`executeShell`) always creates and drops a fresh session per call.

### Streaming/output and minimizer behavior

- Stdout/stderr are routed into a shared pipe and read concurrently.
- Reader decodes UTF-8 incrementally; invalid byte sequences emit `U+FFFD` replacement chunks.
- The command runs with `ProcessGroupPolicy::NewProcessGroup`.
- After the foreground command completes, the reader drains until EOF, 250ms of idle output, or 2s maximum; reader shutdown then gets a 250ms timeout.
- Optional minimizer configuration can capture and rewrite output. When minimization occurs, the result includes `minimized` with filter name, replacement/original text, and byte counts.
- A successful result can include `workingDir`, reflecting the shell's cwd after execution.
- Consumers are responsible for persisting or displaying minimizer artifacts; the native result only carries the data.

### Cancellation, timeout, and abort

- `CancelToken` is constructed from `timeoutMs` and optional `AbortSignal`, then converted into the shared `pi_shell::cancel::CancelToken`.
- On cancellation/timeout, shell cancellation token is triggered, descendant cleanup runs, then the task gets a 2-second graceful window before forced abort.
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
- Default size is `120x40`; dimensions are clamped (`cols 20..400`, `rows 5..200`) on start and resize.
- `write()` sends raw bytes to PTY stdin.
- `resize()` sends a control message and clamps dimensions again.
- `kill()` sends a control message that marks the run cancelled and terminates PTY process targets.

Output path:

- dedicated reader thread reads master stream,
- incremental UTF-8 decode emits `U+FFFD` for invalid bytes,
- chunks forwarded through N-API threadsafe callback.

Termination path:

- `terminate_pty_processes` targets the PTY process group when available and the child pid when available.
- It sends the platform `TERM_SIGNAL`, calls `child.kill()`, then sends the platform `KILL_SIGNAL`.
- On Windows, ConPTY input is closed before dropping the master; master drop is offloaded to a background thread and waited for up to 2s to avoid deadlock.

### Cancellation and timeout semantics

- `timeoutMs` and `AbortSignal` feed a `CancelToken`.
- Loop calls `ct.heartbeat()` periodically with a 16ms maximum wait cadence.
- Timeout classification is based on the heartbeat error string containing `Timeout`.
- Cancellation/kill starts a 300ms post-cancel drain window; normal child exit starts a 300ms post-exit drain window.
- Final reader drain is 50ms on non-Windows and 500ms on Windows.

### Failure behavior

Error surfaces include:

- PTY allocation/open failure,
- Windows PTY startup timeout,
- PTY spawn failure,
- writer/reader acquisition failure,
- child status/wait failures,
- lock poisoning,
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

- `killTree(signal?)` sends the requested signal to the process and descendants, children first; on Windows the signal argument is ignored and processes are terminated via `TerminateProcess`.
- `terminate(options?)` is async. By default it uses a 1000ms graceful phase and a 5000ms post-hard-kill wait. Passing `gracefulMs < 0` skips the graceful phase. `group: true` also targets the process group where supported; aborting its signal rejects the promise.
- `waitForExit(options?)` resolves `true` when the process exits and `false` on timeout; aborting its signal rejects the promise.

The platform-specific implementation lives in `pi_shell::process`; `crates/pi-natives/src/ps.rs` is a N-API shim plus re-exports used by PTY termination.

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

- only shift/alt/ctrl/super bits are compared for key matching,
- lock bits are masked out before comparisons.

Layout behavior:

- base-layout fallback is intentionally constrained so remapped layouts do not create false matches for ASCII letters/symbols.

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
