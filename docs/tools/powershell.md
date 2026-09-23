# powershell

> Execute PowerShell in a persistent `pwsh` host whose runspace state is retained across calls.

## Source
- Entry: `packages/coding-agent/src/tools/powershell.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/powershell.md`
- Key collaborators:
  - `packages/coding-agent/src/tools/pshost-manager.ts` — session-keyed warm-host pool (lazy spawn, reuse, idle eviction)
  - `crates/pi-natives/src/pshost.rs` — `PsHost` native: sidecar spawn, framed protocol, streaming, cancellation, teardown
  - `crates/pi-natives/src/pshost_bootstrap.ps1` — the host loop running inside `pwsh` (shared runspace, object retention, watchdog)
  - `packages/coding-agent/src/session/streaming-output.ts` — tail streaming, truncation, artifact spill
  - `packages/coding-agent/src/tools/tool-timeouts.ts` — timeout clamp rules
  - `packages/coding-agent/src/tools/output-meta.ts` — output width / sink head-bytes resolution

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `command` | `string` | Yes | PowerShell to execute in the shared runspace. |
| `cwd` | `string` | No | Working directory for this command; resolved against the session cwd and persists into the runspace afterward. |
| `timeout` | `number` | No | Timeout in seconds. Default `300`; clamped to `1..3600`. |
| `host` | `"session" \| "ephemeral" \| "new-session"` | No | Which host runs the command. `session` (default): the persistent session host. `ephemeral`: a throwaway host, fully terminated (awaited) before the result returns. `new-session`: dispose the session host first (awaited), then run in a fresh replacement that becomes the session host. |

## Outputs
A standard text tool result built in `packages/coding-agent/src/tools/powershell.ts`:

- `content`: one text block with rendered command output (`Out-String`), or `"(no output)"` when empty. A trailing `Command exited with code N` / `Command reported errors` note is appended on failure.
- `details.host`: which host mode ran the command (`session` / `ephemeral` / `new-session`).
- `details.pid`: PID of the backing `pwsh` host (attach with `Enter-PSHostProcess -Id <pid>`; for ephemeral runs the process has already exited — the PID is only for log correlation).
- `details.execId`: monotonic execution id within the host.
- `details.exitCode` / `details.hadErrors`: native exit status and error-stream flag.
- `details.meta.truncation`: present when output exceeded the in-memory tail window.

Streaming behavior:

- While the command runs, `onUpdate` receives tail-only snapshots from `TailBuffer` via `streamTailUpdates()`; chunks are pushed through one `OutputSink`.

Failure behavior:

- Timeout → thrown `ToolError` (output preserved); the runspace and all retained state survive — only the in-flight pipeline is stopped. If the stop is not acknowledged within 3s (pipeline wedged in an uncooperative native/.NET call), the sidecar is force-killed; the pool detects the dead host via `PsHost.alive` and respawns lazily on the next call.
- Abort signal → thrown `ToolAbortError`.
- Non-zero exit code from a native command run by this call, or error-stream writes → non-thrown `isError` result with output preserved. A stale `$LASTEXITCODE` persisting from an earlier call is never attributed to the current one.

## Flow
1. `loadPowerShellTool()` returns `null` unless a `pwsh` (or configured `powershell.shellPath`) executable resolves via `$which`, so the tool is unregistered when PowerShell is absent.
2. On execute, `clampTimeout("powershell", timeout)` applies the `1..3600` second clamp.
3. Host selection: `host: "ephemeral"` spawns a throwaway host via `spawnEphemeralPsHost()` (never pooled; disposed — awaited — when the run completes). `host: "new-session"` first awaits `disposePsHostSession()` for the session key, then acquires as normal. Otherwise `acquirePsHost()` in `pshost-manager.ts` leases the session's warm host (keyed by `session.getSessionId()`, or a per-`ToolSession` generated key when absent), spawning one on first use and evicting hosts idle beyond `powershell.idleTtlMs`; hosts with an in-flight run are never evicted, and the lease is released when the run completes.
4. A fresh host constructs `PsHost` with `parentPid = process.pid`, the session cwd, and `powershell.historyDepth`, then `start()` spawns the sidecar and waits for the ready handshake.
5. The native writes `pshost_bootstrap.ps1` to a content-addressed temp file and launches `pwsh -NoLogo -NoProfile -NonInteractive -File <bootstrap> -ParentPid <pid> -HistoryDepth <powershell.historyDepth>`.
6. The bootstrap opens one shared runspace and an `$global:__omp` store, then serves length-prefixed JSON frames over stdio.
7. Each `run()` sends an `exec` frame; the bootstrap runs the command at top scope, retaining its live output objects in `$global:__omp.Last`/`.History`, renders them with `Out-String -Width`, and streams the text back as `chunk` frames terminated by `done`. All PowerShell streams are captured: Success and Information (`Write-Host`) verbatim, and Warning/Verbose/Debug/Error labeled and ANSI color-coded (yellow/red) like the console. Each `chunk` frame carries a `stream` tag (`output`/`information`/`warning`/`verbose`/`debug`/`error`).
8. The tool pushes chunks into an `OutputSink` (tail + artifact spill), then `sink.dump()` yields the truncation summary used by the result.
9. Timeout/abort send a `stop` frame that cancels only the running pipeline; the result flags `timedOut` / `cancelled` map to a thrown error.

## Modes / Variants
- **Tool unavailable**: no `pwsh` on PATH → `loadPowerShellTool()` returns `null`.
- **Shared session (default)**: every call reuses the same runspace; variables, modules, location, `$LASTEXITCODE`, and last-result objects persist.
- **Ephemeral host** (`host: "ephemeral"`): one throwaway host per call, isolated in both directions, fully terminated before the result returns so file locks / loaded assemblies are deterministically released. Runs with `shared` tool concurrency.
- **New session** (`host: "new-session"`): the poisoned session host is disposed (awaited) before the replacement spawns; all prior runspace state is lost. If the replacement fails to spawn the session is hostless until the next call lazily re-spawns.
- **Object inspection**: `$__omp.Last` exposes the previous command's live objects for `Get-Member`/`Format-List`/`ConvertTo-Json` without re-running.
- **Truncated vs untruncated output**: small output stays in memory; large output keeps only the tail window and may spill full output to a session artifact.

## Side Effects
- Subprocesses / native bindings
  - Spawns one long-lived `pwsh` sidecar per session via the `PsHost` native; reused across calls.
  - Sanitizes streamed text through `OutputSink`.
- Session state
  - Uses session artifact allocation when available for full-output spill.
  - Tool concurrency is arg-dependent: `exclusive` for session-host runs (the native serializes pipelines on the shared runspace regardless), `shared` for ephemeral runs, which own their process outright.
- Background work / cancellation
  - `run()` receives the tool `AbortSignal`; timeout/abort stop the in-flight pipeline without tearing down the host.
- Lifecycle
  - Hosts are evicted on idle TTL; `disposeAllPsHosts()` is the graceful shutdown hook.
  - The sidecar carries a parent-PID watchdog and self-terminates if the host process dies, so a hard crash cannot orphan it.

## Limits & Caps
- Timeout defaults/clamps: `default=300`, `min=1`, `max=3600` in `packages/coding-agent/src/tools/tool-timeouts.ts`.
- Output tail window: `DEFAULT_MAX_BYTES = 50 * 1024` in `packages/coding-agent/src/session/streaming-output.ts`.
- Retained result history: `powershell.historyDepth` entries (default `20`), capped in the bootstrap ring.
- Render width: `powershell.outputWidth` columns (default `120`).
- Idle host eviction: `powershell.idleTtlMs` (default `600000`).
- Host startup handshake timeout: `15000` ms (native default).

## Settings
- `powershell.enabled` (default `false`, opt-in) — gates tool registration.
- `powershell.shellPath` — override for the `pwsh` executable; defaults to `pwsh` on PATH.
- `powershell.outputWidth` — `Out-String` render width.
- `powershell.historyDepth` — retained-result ring size.
- `powershell.idleTtlMs` — idle eviction window for pooled hosts.

## Errors
- Host startup failure or handshake timeout → thrown `ToolError` from `start()` ("PowerShell host startup timed out" / spawn error).
- Timeout → `ToolError` with preserved output and `Command timed out after N seconds`.
- Abort → `ToolAbortError`.
- Non-zero exit from a native command run by this call / error-stream writes → non-thrown `isError` result.

## Notes
- The process spawn (~1s) is paid once per session; warm per-call cost is ~20–30 ms.
- The bootstrap runs commands at top scope (via an array-subexpression assignment, not a child scope), so `$x = 1` in one call is visible in the next.
- `$env:` assignments persist for the session (process-wide in the sidecar), matching shell-session semantics.
- The tool exposes `command`, `cwd`, `timeout`, and `host`; there is no separate `env` field — set `$env:` inline.
- For simple POSIX-style commands prefer `bash`; for file reads/search/edits use `read`/`search`/`edit`.
