# Python REPL via IPython kernel: plan

## Assumptions
- No security/sandboxing requirements.
- No persistence across sessions; kernel lifetime is scoped to the agent session (or explicit reset/close).
- REPL is per agent session (not shared across agents unless explicitly wired).
- Python available locally; IPython/Jupyter kernel deps can be added as runtime deps later.
- Streaming output to TUI should mirror bash tool behavior (chunked, truncation, expandable output).

## Goals
- Add a Python REPL tool backed by IPython kernels.
- Integrate with existing bash tool surface (schema/renderer/streaming/truncation).
- Reuse bash-executor patterns for streaming, cancellation, and output capture.
- Define adapter interfaces to support local and future remote kernel execution.

## Key integration points
### `packages/coding-agent/src/core/tools/bash.ts`
- Pattern to follow: tool schema, execute handler, streaming updates, truncation, error surfacing, renderer.
- Target additions:
  - A new tool module `python.ts` (or `pyrepl.ts`) mirroring bash tool structure.
  - Similar `ToolDetails` with truncation metadata, fullOutputPath, fullOutput.
  - Reuse `truncateTail` + TUI renderer patterns.
- Adapter use: inject a `PythonOperations` (analogous to `BashOperations`) to allow local vs remote kernel implementations.

### `packages/coding-agent/src/core/bash-executor.ts`
- Patterns to reuse:
  - `BashExecutorOptions` fields: `cwd`, `timeout`, `onChunk`, `signal`.
  - `BashResult` shape for output/truncation/cancelled.
  - `createOutputSink` and `pumpStream` for streaming + truncation.
- Target additions:
  - A parallel module `python-executor.ts` or generic `stream-executor.ts` that wraps kernel I/O to match `BashResult` semantics.
  - Option to share `createOutputSink` logic (split into shared module) if preferred.

## Kernel lifecycle
### Lifecycle states
1. **Provisioning**: start kernel process + open IPC channels.
2. **Ready**: kernel info request succeeds; execute requests accepted.
3. **Executing**: process `execute_request` and stream outputs.
4. **Interrupted** (optional): on timeout or cancellation; send interrupt.
5. **Shutdown**: request kernel shutdown; clean IPC; kill if unresponsive.

### Lifecycle management
- Kernel is created at tool invocation start (or on first execution if implementing a multi-call session).
- Kernel must be shut down on:
  - successful completion
  - error (startup failure, exec failure)
  - abort signal
  - timeout
- Use a `KernelController` interface to own lifecycle and cleanup.

## IPC strategy
### IPython/Jupyter protocol
- Use ZeroMQ sockets: `shell`, `iopub`, `control`, `stdin`, `hb`.
- Send `kernel_info_request` to verify readiness.
- Execute with `execute_request` on `shell` channel.
- Stream results from `iopub`:
  - `stream` (stdout/stderr)
  - `execute_result` (repr, display data)
  - `error` (traceback)
  - `status` (idle/busy)
- Treat `status: idle` as execution completion signal.

### Session IDs
- Generate `session_id` and `msg_id` per execute call.
- Filter iopub messages by `parent_header.msg_id` to avoid cross-talk.

## Bun integration
### Process spawn
- Use `Bun.spawn()` for local kernel process: `python -m ipykernel_launcher -f <connection-file>`.
- Allocate free ports, then use `Bun.file()` and `Bun.write()` to create the connection file (JSON) before spawn.
- Use `AbortSignal` to cancel execution and trigger interrupt/termination.

### ZMQ handling
- Use a JS ZMQ library compatible with Bun (investigate `zeromq` Bun support).
- If Bun is incompatible, consider a tiny Node sidecar for ZMQ until Bun support is verified (documented in plan, not implemented now).

## Tool availability settings
- Add a setting to control tool exposure: `bash-only`, `ipy-only`, or `both`.
- Default: `ipy-only` with automatic fallback to `bash-only` if kernel startup fails.
- Tool registration should consult settings and runtime availability per session.

## Shell bridge in Python
- Provide a `bash()` helper in the Python prelude that shells out via `bash -lc` and uses the snapshot path when available.
- Reuse the existing TypeScript `shell-snapshot.ts` to generate the snapshot file, then pass its path to the kernel via an env var.
- Python helper should prefer the snapshot env var if present; otherwise run plain `bash -lc`.

## Execute flow
1. Create kernel controller (spawn process + load connection file).
2. Open ZMQ sockets and send `kernel_info_request`.
3. Send `execute_request` with code.
4. Collect output:
   - `stream` → append to output
   - `execute_result`/`display_data` → serialize as text/plain or JSON text
   - `error` → include traceback, mark as failure
5. Complete when `status: idle` for matching `parent_header.msg_id`.
6. Apply truncation rules and return tool result.
7. Shutdown kernel.

## Streaming to TUI
- Same mechanics as bash tool:
  - incremental `onUpdate` with truncated tail
  - final output includes truncation metadata and `fullOutputPath`
- Use `truncateTail` for preview + `fullOutput` in details for expansion.
- For display data, prefer text/plain; fallback to JSON string.

## Adapter design
### Interfaces
```ts
export interface PythonKernelOperations {
  startKernel(options: { cwd: string; env?: Record<string, string> }): Promise<KernelHandle>;
  sendExecute(handle: KernelHandle, code: string, options: ExecuteOptions): AsyncIterable<KernelMessage>;
  interrupt(handle: KernelHandle): Promise<void>;
  shutdown(handle: KernelHandle): Promise<void>;
}

export interface KernelHandle {
  id: string;
  connectionInfo: KernelConnectionInfo;
}

export interface KernelConnectionInfo {
  transport: "tcp" | "ipc";
  ip: string;
  shellPort: number;
  iopubPort: number;
  controlPort: number;
  stdinPort: number;
  hbPort: number;
  key: string;
  signatureScheme: string; // e.g. "hmac-sha256"
}

export interface ExecuteOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  onChunk?: (text: string) => void; // sanitized
}
```

### Executor adapter
- Create `executePython` that mirrors `executeBash`:
  - input: code + `PythonExecutorOptions` (`cwd`, `timeout`, `signal`, `onChunk`)
  - output: `PythonResult` mirroring `BashResult`
- Use a shared `createOutputSink` (move to `streaming-executor.ts`).

### Mapping to existing executor shape
- `PythonExecutorOptions` mirrors `BashExecutorOptions` for compatibility.
- `PythonResult` mirrors `BashResult` for renderer reuse.
- Tool details/truncation identical to `bash.ts`.

## Tool surface (schema)
- `command` → `code` (string)
- `timeout` (seconds)
- `workdir` (optional)
- `kernel` (optional): for future extension (e.g., python version); unused now.

## Concrete implementation steps (design plan)
1. **Design shared streaming utilities**
   - Factor `createOutputSink` and `pumpStream` into `stream-executor.ts`.
   - Keep bash-executor using it to avoid duplication.
2. **Define kernel operations interface**
   - Create `PythonKernelOperations` + `KernelHandle` types.
   - Provide default local implementation using Bun + ZMQ.
3. **Implement python executor**
   - `executePython(code, options)` to stream outputs and return `PythonResult`.
   - Handle timeouts → interrupt kernel + annotate output.
4. **Implement python tool**
   - Mirror bash tool behavior: interception not needed.
   - Use `executePython` with onUpdate streaming + truncation.
   - Renderer can reuse `bashToolRenderer` logic or clone with label changes.
5. **Integrate into tool registry**
   - Add new tool to tools index with appropriate schema.
   - Ensure tool description prompt is written (new prompt file if required).
6. **Wire into TUI**
   - Ensure `tool-execution` supports expansion via details.fullOutput.
7. **Add unit tests**
   - Mirror `prompt-templates` tests; add REPL output/truncation tests.

## Notes for `docs/ipy-*.md`
Include the following sections:
- Motivation + non-goals
- Kernel lifecycle diagram
- IPC message flow (execute_request → iopub stream/error/result → status idle)
- Executor interface and data structures
- Tool schema and output format
- Timeout/cancel behavior
- TUI streaming and truncation handling
- Future extensions (persistent kernels, multiple executions, rich display handling)
