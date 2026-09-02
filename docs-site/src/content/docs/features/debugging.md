---
title: Debugging
description: Drive DAP debug sessions from the agent — launch or attach, set breakpoints, step, and inspect state.
coverage: B
---

The `debug` tool lets the agent drive one DAP (Debug Adapter Protocol) session. It is hidden from the registry unless `debug.enabled` is set; turn it on in your config when you need it. The tool runs exclusively — concurrent debug tool calls are blocked by the scheduler.

## Enable

Set the gating setting:

```yaml
debug:
  enabled: true
```

The tool is only registered when `session.settings.get("debug.enabled")` is true.

## Start a session

### Launch

`launch` starts a new process under a DAP adapter. Required: `program` (the executable path, resolved against the session cwd). Optional: `args` (argv), `cwd`, `adapter` (forces a specific adapter name), and `timeout` (clamped `5..300`, default `30`).

### Attach

`attach` connects to a running process or a remote port. Required: `pid` (local process id) **or** `port` (remote attach port). Optional: `host`, `cwd`, `adapter`. When no adapter is forced and `port` is present, attach prefers `debugpy`, then native debuggers (`gdb`, `lldb-dap`), then the first available adapter.

### Adapter selection

- `launch`: an explicit `adapter` wins; otherwise `selectLaunchAdapter()` ranks available adapters by extension match, root-marker match, then native-debugger preference for extensionless binaries.
- `attach`: an explicit `adapter` wins; otherwise a remote `port` prefers `debugpy`, then native debuggers, then the first available adapter.

Custom adapters can be added or overridden with `dap.json`, `.dap.json`, `dap.yaml`, `.dap.yaml`, `dap.yml`, or `.dap.yml` in the project root, project config dirs (`.omp/`, `.pi/`, `.claude/`), user config dirs, plugin roots, or the home root. Files are merged from lowest to highest priority. The config shape may be `{ "adapters": { ... } }` or a top-level adapter map.

Adapter fields include `command`, `args`, `languages`, `fileTypes`, `rootMarkers`, `launchDefaults`, `attachDefaults`, `connectMode` (`"stdio"` default or `"socket"`), and `acceptsDirectoryProgram` (set `true` for adapters like `dlv` that can launch a package/project directory).

### Custom adapter example

```json
{
  "adapters": {
    "custom-jvm": {
      "command": "kotlin-debug-adapter",
      "args": ["--stdio"],
      "languages": ["java", "kotlin"],
      "fileTypes": [".java", ".kt", ".kts"],
      "rootMarkers": ["pom.xml", "build.gradle", "build.gradle.kts"],
      "launchDefaults": { "request": "launch", "projectRoot": "." },
      "attachDefaults": { "request": "attach", "host": "127.0.0.1" }
    }
  }
}
```

### Transport and lifecycle

- stdio adapters use direct `stdin`/`stdout` framing.
- Socket-mode adapters use a Unix domain socket on Linux, a TCP callback on macOS, and TCP with `${port}` substitution in their args. Child sessions reuse the root TCP server through `DapClient.connect()`.
- Only one root session can be active at a time (`#ensureLaunchSlot()`); recursive adapter-requested children are tracked with `parentSessionId` / `childSessionIds`.
- Idle session cleanup runs every `30` seconds (`CLEANUP_INTERVAL_MS`) and removes sessions idle for `10` minutes (`IDLE_TIMEOUT_MS`).
- Adapter liveness is checked every `5` seconds (`HEARTBEAT_INTERVAL_MS`).

## Breakpoints

### Source and function breakpoints

- `set_breakpoint` — requires `file` + `line` **or** `function`. Optional `condition` (an expression). Returns the current breakpoint list for that target.
- `remove_breakpoint` — same arguments; returns the remaining breakpoint list.

Breakpoint sets are synchronized across the live root/child tree. New children receive the current sets before their `configurationDone` request.

### Instruction and data breakpoints

- `set_instruction_breakpoint` / `remove_instruction_breakpoint` — require `supportsInstructionBreakpoints` and `instruction_reference` plus `offset` and optional `condition` / `hit_condition`.
- `data_breakpoint_info` — requires `supportsDataBreakpoints`; asks the adapter for a `dataId`, access types, and description for `name`.
- `set_data_breakpoint` / `remove_data_breakpoint` — require `supportsDataBreakpoints`; require `data_id` and an `access_type` of `"read" | "write" | "readWrite"`.

## Stepping

- `continue`, `step_over`, `step_in`, `step_out` — return text describing whether execution stopped, terminated, or kept running, plus `details.state` and `details.timedOut`. The tool subscribes for a stop/termination event anywhere in the session tree before sending the DAP request, then `#awaitStopOutcome()` returns the active child's stopped location or reports that the target remains running after timeout.
- `pause` — sends DAP `pause` and waits for a stopped event if needed; reuses cached stop state if the program was already stopped.

## Inspection

Inspection actions default to the current stopped child/thread/frame when the caller omits ids and cached state is available. They declare `read` approval.

- `evaluate` — adapter expression evaluation; `expression` is required and `context` defaults to `"repl"`.
- `stack_trace` — `levels` caps the max stack frames.
- `threads` — fetches the current threads.
- `scopes` — frame scopes for an explicit `frame_id` or the current stopped frame.
- `variables` — `variable_ref` (preferred) or `scope_id`.
- `disassemble` — requires `supportsDisassembleRequest`, `instruction_count`, and either `memory_reference` or a current stopped location with an `instructionPointerReference`. Optional `instruction_offset` and `resolve_symbols`.
- `read_memory` — requires `supportsReadMemoryRequest`, `memory_reference`, and `count`; returns `memoryAddress`, `memoryData` (base64), and `unreadableBytes`.
- `write_memory` — requires `supportsWriteMemoryRequest`, `memory_reference`, and `data` (base64); reports `bytesWritten` and accepts `allow_partial` and `offset`.
- `modules` — requires `supportsModulesRequest`; supports `start_module` / `module_count` pagination.
- `loaded_sources` — requires `supportsLoadedSourcesRequest`.
- `output` — dumps captured stdout/stderr/console text from the session cache (in-memory ring, cap `128 KiB`; over-cap drops whole front chunks, then byte-slices the front chunk to keep the cap, and records `outputTruncated`).

## Direct DAP access and bookkeeping

- `custom_request` — sends any DAP request name with arbitrary `arguments`; the agent's `command` is required.
- `sessions` — lists all cached session summaries (root and children).
- `terminate` — walks from the root through every child, sends best-effort `terminate` / `disconnect`, and disposes the complete tree even when an adapter times out. Returns `No debug session to terminate.` when none exists.

## Limits and errors

- Tool timeout clamp: `default=30`, `min=5`, `max=300`.
- Per-request DAP default timeout: `30_000 ms`.
- Initial stop capture timeout after launch/attach: `5_000 ms`.
- Socket-mode adapter readiness timeout: `10_000 ms`.
- Each DAP request accepts an `AbortSignal`; timeouts and caller cancellation abort the active request, not the whole session lifetime.
- Parameter validation throws `ToolError` with explicit messages: `program is required for launch`, `attach requires pid or port`, `set_breakpoint requires file+line or function`, `variables requires variable_ref or scope_id`, `instruction_count is required for disassemble`, `memory_reference is required for read_memory`, `count is required for read_memory`, `data is required for write_memory`, `command is required for custom_request`, and similar.

## Side effects

- Spawns debug adapters detached (e.g. `gdb`, `lldb-dap`, `python -m debugpy.adapter`, `dlv`).
- Reverse DAP `runInTerminal` requests spawn the debuggee detached.
- Output capture, breakpoints, threads, stack frames, stop location, capabilities, and last-used timestamps are cached in the singleton `DapSessionManager`.

## See also

- [Tools: code execution](/oh-my-pi/features/tools/#code-execution) — `debug` lives next to `bash` and `eval` in the tool registry
- [Settings](/oh-my-pi/configuration/settings/) — `debug.enabled`
