# Native Rust task execution and cancellation (`pi-natives`)

This document describes how `crates/pi-natives` schedules native work and how cancellation flows from JS options (`timeoutMs`, `AbortSignal`) into Rust execution.

## Implementation files

- `crates/pi-natives/src/task.rs`
- `crates/pi-natives/src/grep.rs`
- `crates/pi-natives/src/glob.rs`
- `crates/pi-natives/src/fd.rs`
- `crates/pi-natives/src/ast.rs`
- `crates/pi-natives/src/workspace.rs`
- `crates/pi-natives/src/shell.rs`
- `crates/pi-natives/src/pty.rs`
- `crates/pi-natives/src/html.rs`
- `crates/pi-natives/src/sixel.rs`
- `crates/pi-natives/src/clipboard.rs`
- `crates/pi-natives/src/text.rs`
- `crates/pi-natives/src/ps.rs`

## Core primitives (`task.rs`)

`task.rs` defines:

1. `task::blocking(tag, cancel_token, work)`
   - Wraps `napi::AsyncTask` / `Task`.
   - `compute()` runs on libuv worker threads.
   - Returns a JS `Promise<T>` for exported functions.
   - Records a profiling sample through `profile_region(tag)`.

2. `task::future(env, tag, work)`
   - Wraps `env.spawn_future(...)`.
   - Runs async work on Tokio's runtime.
   - Returns `PromiseRaw<'env, T>`.
   - Records a profiling sample through `profile_region(tag)`.

3. `CancelToken` / `AbortToken` / `AbortReason`
   - `CancelToken::new(timeout_ms, signal)` wraps the shared `pi_shell::cancel::CancelToken`, adding an optional JS `AbortSignal` bridge.
   - `CancelToken::heartbeat()` is cooperative cancellation for blocking loops.
   - `CancelToken::wait()` asynchronously waits for signal or timeout.
   - `CancelToken::abort_token()` returns an abort handle backed by the shared flag when one already exists; without a flag, the handle is inert. `emplace_abort_token()` lazily installs the flag and returns a live handle. `CancelToken::new` uses the latter to bridge a JS `AbortSignal` to `AbortReason::Signal`.
   - `CancelToken::aborted()` provides a non-blocking signal/deadline check, and `into_core()` transfers the token to `pi-shell`.
   - `AbortToken::abort(reason)` lets external code request abort. Reasons are `Unknown`, `Timeout`, `Signal`, and `User`.

## `blocking` vs `future`: execution model and selection

### Use `task::blocking`

Use when work is CPU-heavy or fundamentally synchronous/blocking:

- regex/file scanning (`grep`, `glob`, `fuzzyFind`)
- ast-grep search/edit worker work
- HTML conversion
- clipboard image read

Behavior:

- Work closure receives a cloned `CancelToken`.
- Cancellation is only observed where code checks `ct.heartbeat()?`.
- Closure `Err(...)` rejects the JS promise.

### Use `task::future`

Use when work must `await` async operations:

- shell session orchestration (`Shell.run`, `executeShell`)
- PTY outer promise (`PtySession.start`) before it enters `spawn_blocking`
- async task orchestration that must bridge completion and cancellation

Behavior:

- Future code can race normal completion against `ct.wait()`.
- On cancel path, async implementations typically cancel subordinate machinery and may force-abort after a grace timeout.

## JS API ↔ Rust export mapping (task/cancel relevant)

| JS-facing API                                                 | Rust export                 | Scheduler                                                      | Cancellation hookup                                                                                                                  |
| ------------------------------------------------------------- | --------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `grep(options, onMatch?)`                                     | `grep`                      | `task::blocking("grep", ct, ...)`                              | `CancelToken::new(options.timeoutMs, options.signal)` + heartbeat checks                                                             |
| `glob(options, onMatch?)`                                     | `glob`                      | `task::blocking("glob", ct, ...)`                              | `CancelToken::new(...)` + heartbeat checks                                                                                           |
| `fuzzyFind(options)`                                          | `fuzzy_find`                | `task::blocking("fuzzy_find", ct, ...)`                        | `CancelToken::new(...)` + heartbeat checks                                                                                           |
| `astGrep(options)` / `astMatch(options)` / `astEdit(options)` | ast exports                 | blocking worker path                                           | timeout/signal fields are accepted by options and checked cooperatively in worker loops                                              |
| `listWorkspace(options)`                                      | `list_workspace`            | `task::blocking("listWorkspace", ct, ...)`                     | `CancelToken::new(options.timeoutMs, options.signal)` + heartbeat checks                                                             |
| `Shell#run(options, onChunk?)`                                | `Shell::run`                | `task::future(env, "shell.run", ...)`                          | JS `CancelToken` is converted into `pi_shell::cancel::CancelToken`; shell races it against command completion and descendant cleanup |
| `executeShell(options, onChunk?)`                             | `execute_shell`             | `task::future(env, "shell.execute", ...)`                      | same cancellation race and 2s graceful window                                                                                        |
| `Process#terminate(options?)`                                 | `Process::terminate`        | `task::future(env, "process.terminate", ...)`                  | optional signal cancels termination waits; grace and hard-kill timeouts are process policy rather than `CancelToken` deadlines       |
| `Process#waitForExit(options?)`                               | `Process::wait_for_exit`    | `task::future(env, "process.wait_for_exit", ...)`              | optional signal is bridged through `CancelToken`; `timeoutMs` is the wait operation's typed `false` timeout                          |
| `PtySession#start(...)` / `startArgv(...)`                    | PTY methods                 | `task::future(env, "pty.start", ...)` + inner `spawn_blocking` | `CancelToken` checked in sync PTY loop via `heartbeat()`                                                                             |
| `htmlToMarkdown(html, options?)`                              | `html_to_markdown`          | `task::blocking("html_to_markdown", (), ...)`                  | none (`()` token)                                                                                                                    |
| `encodeSixel(...)`                                            | `encode_sixel`              | synchronous native function                                    | none                                                                                                                                 |
| `readImageFromClipboard()`                                    | `read_image_from_clipboard` | `task::blocking("clipboard.read_image", (), ...)`              | none (`()` token)                                                                                                                    |

`text.rs`, `tokens.rs`, `keys.rs`, most synchronous `ps.rs` functions, SIXEL encoding, and synchronous utility exports do not use `task::blocking`/`task::future` cancellation. The async `Process.terminate()` and `Process.waitForExit()` methods do.

## Cancellation lifecycle and state transitions

### `CancelToken` lifecycle

```text
Created
  ├─ no signal + no timeout  -> passive token
  ├─ signal registered        -> AbortSignal callback can set AbortReason::Signal
  └─ deadline set             -> timeout check becomes active

Running
  ├─ heartbeat()/wait() sees signal   -> AbortReason::Signal
  ├─ heartbeat()/wait() sees deadline -> AbortReason::Timeout
  └─ no abort                         -> continue

Aborted
  └─ shared flag wakes waiters; a later abort call can replace the stored reason, while a deadline is evaluated independently
```

### Before-start vs mid-execution cancellation

- **Before start / before first cancellation check**:
  - `task::future` users that race on `ct.wait()` can resolve cancellation once they enter `select!`.
  - `task::blocking` users only observe cancellation when closure code reaches `heartbeat()`.

- **Mid-execution**:
  - `blocking`: next `heartbeat()` returns `Err("Aborted: ...")`.
  - `future`: `ct.wait()` branch wins `select!`, then code cancels subordinate async machinery.
  - shell: cancellation triggers a Tokio cancellation token, sends descendant termination waves, waits up to 2 seconds for the command task, then aborts the task if needed.
  - PTY: heartbeat failure or `kill()` terminates PTY child/process targets and drains output briefly.

## Heartbeat expectations for long-running loops

`heartbeat()` must run at predictable cadence in loops with unbounded or large work sets.

Observed patterns:

- `glob` and `fuzzyFind` pass heartbeat callbacks into `pi-walker` traversal and also check result-processing loops.
- `grep` checks before and during expensive search and passes the token through its scan/search workers.
- `run_pty_sync` checks every loop tick with a maximum 16ms wait cadence.
- `listWorkspace` checks during traversal.

Practical rule: no loop over external-size input should exceed a short bounded interval without a heartbeat.

## Failure behavior and error propagation to JS

### Blocking tasks

Error path:

1. Closure returns `Err(napi::Error)` (including `heartbeat()` abort).
2. `Task::compute()` returns `Err`.
3. `AsyncTask` rejects JS promise.

Typical error strings:

- `Aborted: Timeout`
- `Aborted: Signal`
- domain errors (`Failed to decode image: ...`, `Conversion error: ...`, etc.)

### Future tasks

Error path:

1. Async body returns `Err(napi::Error)` or join failure is mapped (`... task failed: {err}`).
2. `task::future`-spawned promise rejects.
3. Shell and PTY command APIs model cancellation as structured results instead of rejection when the cancellation path wins: `exitCode` omitted, `cancelled` or `timedOut` set.

### Cancellation reporting split

- **Abort as error**: blocking exports using `heartbeat()?`.
- **Abort as typed result**: shell/PTY command APIs that model cancellation in result structs.

Choose one model per API and document it explicitly.

## Common pitfalls

1. **Missing heartbeat in blocking loops**
   - Symptom: timeout/signal appears ignored until loop ends.
   - Fix: add `ct.heartbeat()?` at loop top and before expensive per-item steps.

2. **Long uncancelable sections**
   - Symptom: cancellation latency spikes during single large call (decode, sort, compression, parser invocation, etc.).
   - Fix: split work into chunks with heartbeat boundaries; if impossible, document latency.

3. **Blocking async executor**
   - Symptom: async API stalls when sync-heavy code runs directly in future.
   - Fix: move CPU/sync blocks to `task::blocking` or `tokio::task::spawn_blocking`.

4. **Inconsistent cancel semantics**
   - Symptom: one API rejects on cancel, another resolves with flags, confusing callers.
   - Fix: standardize per domain and keep docs aligned.

5. **Forgetting cancellation bridge in nested async tasks**
   - Symptom: outer token is cancelled but inner readers/subprocess tasks keep running.
   - Fix: bridge cancellation to inner token/signal and enforce grace timeout + forced abort fallback.

## Checklist for new cancellable exports

1. Classify work correctly:
   - CPU-bound or sync blocking -> `task::blocking`.
   - async I/O / `await` orchestration -> `task::future`.

2. Expose cancel inputs when needed:
   - include `timeoutMs` and `signal` in `#[napi(object)]` options,
   - create `let ct = task::CancelToken::new(timeout_ms, signal);`.

3. Wire cancellation through all layers:
   - blocking loops: `ct.heartbeat()?` at stable intervals,
   - async orchestration: race with `ct.wait()` and cancel sub-tasks/tokens.

4. Decide cancellation contract:
   - reject promise with abort error, or
   - resolve typed `{ cancelled, timedOut, ... }`,
   - keep this contract consistent for the API family.

5. Propagate failures with context:
   - map errors via `Error::from_reason(format!("...: {err}"))`,
   - include stage-specific prefixes (`spawn`, `decode`, `wait`, etc.).

6. Handle before-start and mid-flight cancellation:
   - cancellation check/await must happen before expensive body and during long execution.

7. Validate no executor misuse:
   - no long sync work directly inside async futures without `spawn_blocking`/blocking task wrapper.
