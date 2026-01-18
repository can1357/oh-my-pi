# IPython kernel REPL tool plan (research/design)

## Assumptions
- REPL state lives only for the current agent session (no disk persistence, no restore on restart).
- No sandboxing/security constraints (trusted code execution only).
- New NPM dependency is acceptable if required for ZeroMQ (confirm with maintainers).
- Tool surface will be parallel to `bash` (streaming output, truncation, expand/collapse behavior).

## Goals
- Add a Python REPL tool backed by IPython kernels.
- Integrate streaming/truncation behavior with the existing `bash` tool UX and renderer expectations.
- Provide a clean executor adapter that fits the `bash-executor`/`bash.ts` streaming model.
- Support concurrent kernels (parallel REPL sessions) without persistence.

## Non-goals
- Security sandboxing, containerization, or permission gating.
- Kernel persistence across agent restarts.
- Rich notebook UX (no cell metadata editing, no execution history storage).

## Architecture overview
**New components**
1. **KernelManager** (session-scoped registry)
   - Owns kernel lifecycles, keyed by `kernelId` or `sessionId`.
   - Spawns kernels, tracks connection info, routes execute requests.
2. **KernelProcess**
   - Spawns `python -m ipykernel_launcher -f <connection.json>`.
   - Produces `KernelConnection` (ZMQ sockets) and manages shutdown.
3. **KernelConnection**
   - ZMQ sockets: `shell`, `iopub`, `stdin`, `control`, `hb`.
   - Implements Jupyter messaging protocol (JSON frames + HMAC signature).
   - Provides `execute(code)` returning outputs + status.
4. **KernelExecutorAdapter**
   - Implements a streaming executor interface mirroring `BashOperations.exec`.
   - Converts IOPub messages to text chunks for `onChunk` and captures full output.
5. **PythonTool** (new tool surface)
   - Tool name: `python` (or `ipython`), parameters: `code`, optional `kernelId`, `timeout`.
   - Uses `KernelExecutorAdapter` with `executeBashWithOperations`-like flow or parallel executor.

**Integration points**
- Tool execution and streaming should match `packages/coding-agent/src/core/tools/bash.ts` behavior.
- Truncation uses `truncateTail` and `DEFAULT_MAX_BYTES` from `tools/truncate`.
- TUI uses existing renderer logic (collapsed/expanded, visual truncation).

## Kernel lifecycle
1. **Create**
   - Generate `connection.json` (temp dir).
   - Spawn kernel process:
     - `python -m ipykernel_launcher -f /tmp/<kernel-id>.json`
   - Wait for heartbeat (HB) or a `kernel_info_request` response to confirm readiness.
2. **Use**
   - For each `execute_request`, set `parent_header.msg_id` to correlate IOPub messages.
   - Stream IOPub outputs to the tool renderer.
3. **Shutdown**
   - Send `shutdown_request` over control channel.
   - Kill process tree if shutdown fails or on timeout.
4. **Disposal**
   - Remove from registry when agent session ends or user explicitly closes.

**Lifecycle constraints**
- No persistence; kernel is per session.
- A kernel ID can be auto-generated per tool call unless user supplies `kernelId`.
- Kernel cleanup on `AbortSignal`/timeout.

## IPC details (Jupyter protocol essentials)
**Connection file structure** (generated per kernel):
```json
{
  "ip": "127.0.0.1",
  "transport": "tcp",
  "signature_scheme": "hmac-sha256",
  "key": "<random-hex>",
  "shell_port": 57541,
  "iopub_port": 57542,
  "stdin_port": 57543,
  "control_port": 57544,
  "hb_port": 57545
}
```

**Message frames** (ZMQ multipart):
- `identities...` (routing frames)
- `DELIM` (`<IDS|MSG>`)
- `signature`
- `header` (JSON)
- `parent_header` (JSON)
- `metadata` (JSON)
- `content` (JSON)
- `buffers...` (binary)

**Signature**
- HMAC SHA-256 of `header|parent_header|metadata|content` using `key`.

**Channels**
- `shell`: send `execute_request`, receive `execute_reply`.
- `iopub`: receive streamed outputs, status (`busy`/`idle`).
- `stdin`: input requests (can reject/auto-respond as non-interactive).
- `control`: `shutdown_request`, `interrupt_request`.
- `hb`: heartbeat for liveness.

## Execute flow (mapping to current executor interface)
1. **Tool call**: `python` tool receives `{ code, kernelId?, timeout? }`.
2. **Kernel selection**: KernelManager returns existing kernel by id or creates a new one.
3. **Executor adapter**
   - Calls `KernelConnection.execute(code, { onMessage, signal, timeout })`.
   - Emits `onChunk` events by transforming IOPub `stream`, `execute_result`, `display_data`, `error`.
4. **Result capture**
   - Aggregate output in rolling buffer (same behavior as `createOutputSink`).
   - On completion, return final output + `exitCode` equivalent (0/1).

**ExitCode mapping**
- `exitCode = 0` if `execute_reply.status === "ok"`.
- `exitCode = 1` if `status === "error"`.
- `cancelled = true` if `AbortSignal` triggered or timeout.

## Streaming output mapping to renderer expectations
**Source messages → text chunks**
- `iopub: stream`
  - `content.name` in `stdout|stderr` → direct text.
- `iopub: execute_result`
  - Convert `data["text/plain"]` to text chunk.
  - If `image/png` present, surface as image output (kitty image rendering supported).
  - If `application/json` present, surface as a collapsible JSON tree (reuse task renderer tree format).
- `iopub: display_data`
  - Prefer `text/plain`.
  - Render `image/png` and `application/json` the same way as `execute_result` when present.
  - If `text/html` is present without `text/plain`, convert HTML to markdown and emit that as text output (same pattern as tools that return `_rendered` content, e.g. `git-tool` fetch rendering).
- `iopub: error`
  - Join `traceback[]` into lines; stream immediately.

**Mapping to existing tool streaming**
- Use the same `currentOutput += chunk` strategy as `bash.ts`.
- For each chunk, call `onUpdate` with `{ content: [{ type: "text", text: truncateTail(currentOutput).content }] }`.
- Populate `details.truncation` and `details.fullOutput` when truncated (same as bash).

**Collapsed/expanded behavior**
- Render context should match `bashToolRenderer`:
  - `renderContext.output` → truncated text (tail).
  - `details.fullOutput` → full output buffer when expanded.
  - Use same preview line count as `BASH_DEFAULT_PREVIEW_LINES`.
- Expectation: collapsed view shows tail, with expand note; expanded shows full output when available.

## Bun integration notes
- Use `Bun.spawn` to launch `python` kernel process.
- Use `node:fs` for directory creation; use `Bun.write` for connection file contents.
- Use WebCrypto `subtle.importKey` + `subtle.sign` for HMAC signing (avoid `node:crypto`).
- ZMQ library compatibility with Bun must be validated (native deps).

## Tool surface design
**Tool name**: `python` (or `ipy`)

**Prompt updates**
- Update all prompts that mention the bash tool to be rendered via prompt templates so tool availability is dynamic per settings (bash-only vs ipy-only vs both).
- Add a Python tool prompt similar to `prompts/tools/bash.md` explaining:
  - Execution semantics (kernel-backed, persistent within session)
  - Streaming output and truncation
  - Recommended uses vs. when to use other tools
  - Built-in helpers (e.g., `bash()` bridge)
  - Matplotlib note: `plt.show()` is headless; prefer `plt.savefig()` or returning the figure object for display

**Schema**
```ts
Type.Object({
  code: Type.String({ description: "Python code to execute" }),
  kernelId: Type.Optional(Type.String({ description: "Kernel session id" })),
  timeout: Type.Optional(Type.Number({ description: "Timeout in seconds" }))
})
```

**Tool result**
- `{ content: [{ type: "text", text: outputText }], details?: { truncation, fullOutputPath?, fullOutput? } }`
- Use the same detail structure as `BashToolDetails` for consistency.

## Adapter design (data structures)
**KernelSession**
```ts
interface KernelSession {
  id: string;
  connection: KernelConnection;
  process: Subprocess;
  createdAt: number;
  lastUsedAt: number;
}
```

**KernelExecuteResult**
```ts
interface KernelExecuteResult {
  output: string;
  exitCode: number | undefined;
  cancelled: boolean;
  truncated: boolean;
  fullOutputPath?: string;
}
```

**KernelExecutorOptions**
```ts
interface KernelExecutorOptions {
  timeout?: number; // ms
  onChunk?: (chunk: string) => void;
  signal?: AbortSignal;
}
```

**KernelOperations (bash-style adapter)**
```ts
interface KernelOperations {
  exec: (
    code: string,
    kernelId: string,
    options: { onData: (data: Buffer) => void; signal?: AbortSignal; timeout?: number }
  ) => Promise<{ exitCode: number | null }>;
}
```

## Execution state machine
1. `execute_request` sent; status = busy
2. `iopub` stream/output/error messages emitted → `onChunk`
3. `execute_reply` (shell channel) sets `exitCode`
4. `iopub` status = idle → complete

## Concrete implementation steps
1. **KernelManager**
   - Session-scoped registry with `getOrCreateKernel(kernelId?)` and `shutdown(kernelId)`.
2. **KernelProcess**
   - Create connection file (temp), spawn kernel, connect ZMQ sockets.
   - Implement handshake: `kernel_info_request` until response or timeout.
3. **KernelConnection**
   - Implement message signing, send/recv, routing.
   - Correlate `parent_header.msg_id` to filter IOPub outputs per execute.
4. **KernelExecutorAdapter**
   - Provide `exec` method compatible with `executeBashWithOperations` or a parallel executor.
   - Convert IOPub messages → `onData(Buffer.from(text))`.
5. **Python tool**
   - Wire to executor; update `toolRenderers` or reuse bash renderer with context.
6. **Streaming integration**
   - Use `truncateTail` during updates and final output.
   - Provide `details.fullOutput` when truncated.
7. **Shutdown/cleanup**
   - On tool abort or session end, dispose kernel and temp files.

## Open questions (need confirmation)
- Preferred ZMQ dependency (native `zeromq` vs pure JS fallback).
- Whether to reuse `bashToolRenderer` or create a dedicated python renderer.
- How to handle rich outputs (images/HTML) in future iterations.
- Whether to support input requests (stdin channel) or always error.
