# IPython Kernel REPL Tool (coding-agent)

## Implementation Status: COMPLETE

The Python REPL tool has been implemented using **Jupyter Kernel Gateway** for IPC instead of direct ZeroMQ connections. This avoids Bun's incompatibility with the zeromq NAPI module (libuv `uv_async_init` not supported).

## Architecture

```
TypeScript (coding-agent)
    │
    ├── REST API (kernel lifecycle)
    │   POST /api/kernels → create kernel
    │   DELETE /api/kernels/{id} → shutdown kernel
    │   POST /api/kernels/{id}/interrupt → interrupt execution
    │
    └── WebSocket (message passing)
        ws://host:port/api/kernels/{id}/channels
        └── Multiplexed Jupyter protocol (shell, iopub, stdin, control)
                │
                ▼
        Jupyter Kernel Gateway (Python process)
                │
                └── ZeroMQ (internal, handled by pyzmq)
                        │
                        ▼
                    ipykernel (Python kernel)
```

## Key Files

- `packages/coding-agent/src/core/python-kernel.ts` - Kernel Gateway client
- `packages/coding-agent/src/core/python-executor.ts` - Execution wrapper
- `packages/coding-agent/src/core/tools/python.ts` - Tool definition

## Dependencies

**Python (user must install):**
```bash
pip install jupyter_kernel_gateway ipykernel
```

**TypeScript:** No native dependencies. Uses standard WebSocket API.

## WebSocket Wire Protocol

The Jupyter Kernel Gateway uses a binary WebSocket protocol:

```
┌─────────────┬──────────┬──────────┬─────┬─────────┬──────────┬─────┐
│ offset_count│ offset_0 │ offset_1 │ ... │ msg     │ buffer_0 │ ... │
│ (4 bytes)   │ (4 bytes)│ (4 bytes)│     │ (JSON)  │ (binary) │     │
└─────────────┴──────────┴──────────┴─────┴─────────┴──────────┴─────┘
```

Message JSON structure:
```json
{
  "channel": "shell|iopub|stdin|control",
  "header": { "msg_id", "session", "username", "date", "msg_type", "version" },
  "parent_header": {},
  "metadata": {},
  "content": {}
}
```

## Kernel Lifecycle

1. **Start Gateway**: Spawn `python -m jupyter_kernel_gateway --port=<port>`
2. **Wait for Ready**: Poll `GET /api/kernelspecs` until 200
3. **Create Kernel**: `POST /api/kernels` with `{ "name": "python3" }`
4. **Connect WebSocket**: `ws://host:port/api/kernels/{id}/channels`
5. **Execute Code**: Send `execute_request` on shell channel
6. **Receive Output**: Handle `stream`, `execute_result`, `display_data`, `error` on iopub
7. **Shutdown**: `DELETE /api/kernels/{id}`, then kill gateway process

## Settings

| Setting | Values | Default | Description |
|---------|--------|---------|-------------|
| `python.toolMode` | `ipy-only`, `bash-only`, `both` | `ipy-only` | How Python code is executed |
| `python.kernelMode` | `session`, `per-call` | `session` | Whether to keep kernel alive |

## Previous Approach (Deprecated)

The original plan used direct ZeroMQ connections from TypeScript to ipykernel. This was abandoned because:

1. The `zeromq` npm package uses NAPI with libuv internals
2. Bun doesn't support `uv_async_init` (see https://github.com/oven-sh/bun/issues/18546)
3. No pure-JS ZeroMQ implementation exists

Jupyter Kernel Gateway solves this by handling ZeroMQ internally (via Python's pyzmq) and exposing a standard HTTP/WebSocket interface.
