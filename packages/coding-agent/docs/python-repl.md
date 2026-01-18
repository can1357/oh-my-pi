# Python REPL (Jupyter Kernel Gateway)

## Requirements

- Python 3 available on PATH (or via an active virtualenv)
- `jupyter-kernel-gateway` (`kernel_gateway` module) and `ipykernel` installed in the selected Python environment

Install:
```bash
python -m pip install jupyter_kernel_gateway ipykernel
```

## How It Works

The Python tool starts a Jupyter Kernel Gateway process locally, which manages an IPython kernel. All code execution goes through the gateway's REST and WebSocket APIs.

Startup flow:
1. Spawn `python -m kernel_gateway` on a random available port
2. Wait for gateway to become ready (`GET /api/kernelspecs`)
3. Create a kernel (`POST /api/kernels`)
4. Connect WebSocket for execution messages
5. Run prelude code (helper functions)

## External Gateway Support

Instead of spawning a local gateway, you can connect to an already-running Jupyter Kernel Gateway:

```bash
# Connect to external gateway
export OMP_PYTHON_GATEWAY_URL="http://127.0.0.1:8888"

# Optional: auth token if gateway requires it (KG_AUTH_TOKEN)
export OMP_PYTHON_GATEWAY_TOKEN="your-token-here"
```

When `OMP_PYTHON_GATEWAY_URL` is set:
- No local gateway process is spawned
- Kernels are created on the external gateway
- The gateway process is not killed on shutdown
- Availability check uses `/api/kernelspecs` endpoint instead of local module check

This is useful for:
- Remote kernel execution
- Shared kernel environments
- Pre-configured gateway setups

## Environment Propagation

- The kernel inherits a filtered environment (explicit allowlist + denylist)
- `PYTHONPATH` includes the working directory and any existing `PYTHONPATH` value
- Virtual environments are detected via `VIRTUAL_ENV`, `.venv/`, or `venv/` and preferred when present

## Kernel Modes

Settings under `python` control exposure and reuse:
- `toolMode`: `ipy-only` (default), `bash-only`, `both`
- `kernelMode`: `session` (default, queued), `per-call`

## Shell Bridge

The Python prelude exposes `bash()` which:
- Sources the shell snapshot when `OMP_SHELL_SNAPSHOT` is set
- Runs via `bash -lc` when available, with OS fallbacks

## Output Handling

- Streams `stdout`/`stderr` as text
- `image/png` display data renders inline in TUI
- `application/json` display data renders as a collapsible tree
- `text/html` display data is converted to basic markdown

## Troubleshooting

- **Kernel unavailable**: Ensure `python` + `jupyter-kernel-gateway` + `ipykernel` are installed; the session will fall back to bash-only.
- **External gateway unreachable**: Check the URL is correct and the gateway is running. If auth is required, set `OMP_PYTHON_GATEWAY_TOKEN`.
- **IPC tracing**: Set `OMP_PYTHON_IPC_TRACE=1` to log kernel message flow.
- **Stdin requests**: Interactive input is not supported; refactor code to avoid `input()` or provide data programmatically.
