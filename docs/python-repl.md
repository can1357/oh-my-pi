# Eval Tool Python Backend

This document describes the Python execution stack in `packages/coding-agent`.
It covers tool behavior, runner lifecycle, environment handling, execution semantics, output rendering, supported magics, and operational failure modes.

## Scope and Key Files

- Tool surface: `src/tools/eval.ts`
- Session/per-call kernel orchestration: `src/eval/py/executor.ts`
- Subprocess kernel client: `src/eval/py/kernel.ts`
- Python wrapper / NDJSON server: `src/eval/py/runner.py`
- Prelude helpers loaded into every kernel: `src/eval/py/prelude.py`
- Host-side subagent helper bridge: `src/eval/agent-bridge.ts`
- MIME bundle renderer (text + structured outputs): `src/eval/py/display.ts`
- Interactive-mode renderer for user-triggered Python runs: `src/modes/components/eval-execution.ts`
- Runtime/env filtering and Python resolution: `src/eval/py/runtime.ts`

## What eval's Python backend is

The `eval` tool executes one Python cell per call inside a retained `python` subprocess that speaks NDJSON over stdin/stdout. No Jupyter gateway and no extra pip dependencies are required. The bundled runner uses Python 3.10 syntax (`str | None`), so the effective requirement is Python 3.10+. Rich `display()` output (PIL, pandas, plotly, matplotlib figures) works because the wrapper implements MIME-bundle dispatch.

Current tool input:

```ts
{
  language: "py";
  code: string;
  title?: string;
  timeout?: number; // seconds; default 30, 0 disables, otherwise clamped to 1..3600
  reset?: boolean;  // wipe the Python kernel before this call
}
```

The session-scoped wire schema advertises only enabled runtimes ("py" and "js"). Python and JavaScript default on. The tool is `concurrency = "exclusive"` for a session, so calls do not overlap. State persists across separate calls to the same language runtime.

## Kernel lifecycle

Each Python kernel is a single subprocess: `<resolved-python> -u <runner.py>`. The runner is bundled with the host binary (Bun text import), written to an `omp-python-runner` cache under the OS temp directory once per script hash, and reused by subsequent spawns.

Kernel startup sequence:

1. Availability check (`checkPythonKernelAvailability`) — verifies that a Python interpreter resolves and runs.
2. Spawn `python -u runner.py` with filtered env and `cwd`.
3. Send an init request that runs `os.chdir(cwd)`, injects env entries, and adds `cwd` to `sys.path`.
4. Execute `PYTHON_PRELUDE` (idempotent — only initializes once per process).

Kernel shutdown:

- Send `{"type": "exit"}` over stdin.
- Wait for process exit with `SHUTDOWN_GRACE_MS` budget.
- Escalate to `SIGTERM` and finally `SIGKILL` if the process does not exit in time.

## Wire protocol (NDJSON, host ↔ runner)

One JSON object per line, UTF-8, `\n` terminated.

Host → runner:

```jsonc
{"id": "<reqId>", "code": "<source>", "silent": false, "storeHistory": true, "cwd": "<optional>", "env": {"KEY": "VAL"}}
{"type": "exit"}
```

Runner → host:

```jsonc
{"type": "started",  "id": "<reqId>"}
{"type": "stdout",   "id": "<reqId>", "data": "..."}
{"type": "stderr",   "id": "<reqId>", "data": "..."}
{"type": "display",  "id": "<reqId>", "bundle": {<mime>: <value>}}
{"type": "result",   "id": "<reqId>", "bundle": {<mime>: <value>}}
{"type": "error",    "id": "<reqId>", "ename": "...", "evalue": "...", "traceback": ["..."]}
{"type": "done",     "id": "<reqId>", "status": "ok"|"error", "executionCount": N, "cancelled": false}
```

Status events the prelude emits (e.g. `_emit_status("find", count=…)`) ship inside display bundles under `application/x-omp-status` so the existing TUI status renderer keeps working.

## Magics

The runner's source transformer rewrites IPython-style magics to plain Python calls before parsing. Supported set:

| Magic                             | Effect                                                                                                                                                      |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `%pip <args>`                     | `python -m pip <args>` with live streaming output. Newly installed packages are evicted from `sys.modules` so the next `import` picks up the fresh install. |
| `%cd <path>`                      | `os.chdir(path)` (with `~` expansion); emits status event.                                                                                                  |
| `%pwd`                            | Returns `os.getcwd()`.                                                                                                                                      |
| `%ls [path]`                      | Returns `sorted(os.listdir(path))`.                                                                                                                         |
| `%env [KEY[=VAL]]`                | List, read, or set env vars (matches prelude `env()` semantics).                                                                                            |
| `%set_env KEY VALUE`              | Set `os.environ[KEY]`.                                                                                                                                      |
| `%time <expr>` / `%timeit <expr>` | Time the expression; emits status event with elapsed ms.                                                                                                    |
| `%who` / `%whos`                  | List user-namespace names.                                                                                                                                  |
| `%reset`                          | Clear user globals and re-inject prelude.                                                                                                                   |
| `%load <path>`                    | Read a file into a fresh cell and execute.                                                                                                                  |
| `%run <path>`                     | `runpy.run_path` and merge globals back.                                                                                                                    |
| `%%bash`                          | Run the cell body via `bash`. The only registered shell cell magic — `%%sh` does not exist, and unregistered names raise `Cell magic function '%%<name>' not found`. |
| `%%capture [name]`                | Run body with stdout/stderr captured into `name`.                                                                                                           |
| `%%timeit`                        | Time the cell body.                                                                                                                                         |
| `%%writefile <path>`              | Write body to file.                                                                                                                                         |
| `!cmd` / `var = !cmd`             | Run command via subprocess shell; returns an SList-style result with `.n` / `.s` helpers.                                                                   |
| `var = %name args`                | Assignment forms work for line magics and `!cmd`.                                                                                                           |

Unknown magic names raise `NameError: UsageError: ...` inside the cell.

## Session persistence semantics

`python.kernelMode` controls retained kernel reuse:

- `session` (default)
  - Reuses kernel sessions keyed by namespaced eval session id plus normalized cwd and interpreter.
  - Multiple owners can share the same retained kernel for that key.
  - Calls through the tool are exclusive, so tool invocations do not overlap.
  - A dead retained subprocess is replaced before execution.
  - If the subprocess dies during execution, it is replaced and the call is retried once.
- `per-call`
  - Spawns a fresh subprocess for each call.
  - Shuts the subprocess down after the call.
  - No cross-call state persistence.

### State across eval calls

Each tool call contains one cell. Python calls run sequentially because the tool is exclusive, and later calls reuse the selected retained kernel in `session` mode.

If a cell fails, definitions and mutations completed before the error can remain in kernel memory. `reset: true` resets only the selected language runtime before that call; other language runtimes are untouched.

## Environment filtering and runtime resolution

Environment is filtered before launching the runner:

- Allowlist includes core vars like `PATH`, `HOME`, locale vars, `VIRTUAL_ENV`, `PYTHONPATH`, etc.
- Allow-prefixes: `LC_`, `XDG_`, `PI_`
- Denylist strips common API keys (OpenAI/Anthropic/Gemini/etc.)

Runtime selection order (skipped entirely when the `python.interpreter` setting names an explicit executable):

1. Active/located venv (`VIRTUAL_ENV`, then `CONDA_PREFIX`, then `<cwd>/.venv`, `<cwd>/venv`)
2. Managed venv at `~/.omp/python-env`
3. `python` or `python3` on PATH

When a venv is selected, its bin/Scripts path is prepended to `PATH`.

The runner additionally receives `PYTHONUNBUFFERED=1` and `PYTHONIOENCODING=utf-8` so streamed output reaches the host promptly.

## Tool availability and mode selection

The backend settings `eval.py` / `eval.js` default to `true`. Optional boolean environment flags `PI_PY` and `PI_JS` override their corresponding setting independently. `eval.tools.enabled` also defaults to `true`; turning it off removes the `tools` spawn fields and kernel-defined-tool guidance.

The tool's session-scoped schema lists only enabled runtimes. If Python preflight fails while another runtime is enabled, `eval` remains available for that runtime and a `py` call reports a Python-backend availability error with enabled alternatives.

Python prelude helpers include `agent(prompt, *, agent=None, label=None, schema=None, schema_mode=None, isolated=None, apply=None, merge=None, tools=None)`, which registers a background subagent job and returns an `AgentHandle` (`.id`, `.handle` = `agent://<id>`, `.status`, `.done()`, `.wait(timeout=None)`, `.send()`, `.cancel()`, `.output()`, awaitable). `completion(...)` likewise returns a `CompletionHandle`. `wait(handles, timeout=None, raise_errors=True)` barriers over handles in input order. `workpool(...)` returns a `WorkPool` (`push`, `status`, `peek`, `close`); its name is the aggregate async-job id used with `hub wait`. `tool.<name>(args)` is a coroutine (`await tool.read({...})`); `@tool` registers a kernel-local function as a tool for subagents (schema inferred from type hints) when `eval.tools.enabled` is on.

The runner accepts a `{"type": "tool", "id", "op": "describe"|"call", ...}` request alongside cell requests. It is served on a dedicated daemon thread (POSIX; between cells on Windows) against the kernel's `__omp_tools__` registry, replies with an `application/json` display bundle (`{ok, tools, missing}` or `{ok, value}`), and reports a raising tool as an `error` frame without touching the running cell. See `docs/tools/eval.md` for the caller-facing contract.

## Execution flow and cancellation/timeout

### Cell timeout

`timeout` is in seconds and defaults to 30. `0` disables the cell timeout; nonzero values are clamped to `1..3600` seconds and by a positive `tools.maxTimeout` ceiling before being passed to `IdleTimeout`. The timeout is suspended while a host-side `wait()` on `agent()` / `completion()` handles is in flight: those calls emit reference-counted pause/resume events through `withBridgeTimeoutPause`, and a fresh timeout window begins when control returns.

The pause/resume events are the sole mechanism that suspends the budget. Compute, `stdout`/`stderr`, `log()`/`phase()`, and ordinary tool calls count against it. The tool combines caller, session, and watchdog abort signals with `AbortSignal.any(...)`; the backend does not arm a competing deadline.

### Kernel execution cancellation

On abort/timeout:

- The host sends `kill("SIGINT")` to the runner subprocess.
- The runner's exec-time signal handler raises `KeyboardInterrupt` inside the user code.
- Result includes `cancelled=true`; a kernel timeout is annotated as `eval cell timed out after <n>s; kernel interrupted but remains running. Reset the kernel via { reset: true } if state appears corrupted.`
- Between requests the runner installs `SIG_IGN` for SIGINT so a stray cancel does not tear down the kernel.

If the runner does not emit `done` within 5s of the interrupt (`INTERRUPT_ESCALATION_MS` — e.g. stuck in C code holding the GIL), the host shuts the subprocess down (escalating `exit` → `SIGTERM` → `SIGKILL`), the cell is annotated as kernel-killed, and the kernel is recreated on the next call.

### stdin behavior

Interactive stdin is not supported. The runner does not forward `input()` prompts; user code that calls `input()` blocks until cancellation.

## Output capture and rendering

### Captured output classes

From runner frames:

- `stdout` / `stderr` → plain text chunks
- `display` / `result` → rich display handling (MIME bundle)
- `error` → traceback text
- `application/x-omp-status` MIME inside `display` → structured status events

Display MIME precedence:

1. `text/markdown`
2. `text/plain`
3. `text/html` (converted to basic markdown)

Additionally captured as structured outputs:

- `application/json` → JSON tree data
- `image/png` / `image/jpeg` → image payloads
- `application/x-omp-status` → status events

### Matplotlib

The runner sets `MPLBACKEND=Agg` as an environ default so figures render off-screen. After every cell, `pyplot.get_fignums()` is iterated; each figure is saved to PNG, emitted as an `image/png` display, and closed.

### Storage and truncation

Output is streamed through `OutputSink` and may be persisted to artifact storage. Tool results can include truncation metadata and `artifact://<id>` for full output recovery.

### Renderer behavior

- Tool renderer (`eval-render.ts`, re-exported from `eval.ts`):
  - shows code-cell blocks with per-cell status
  - collapsed preview defaults to 10 lines
  - supports expanded mode for all output retained in the tool result
- Interactive renderer (`eval-execution.ts`):
  - used for user-triggered Python execution in TUI
  - collapsed preview defaults to 20 lines
  - clamps very long individual lines to 4000 chars for display safety
  - shows cancellation/error/truncation notices

## Operational troubleshooting

- **Python backend not available** — Check `eval.py`, `PI_PY`, and that `python`/`python3` is on PATH. If another backend is enabled, use its advertised language token.
- **No Python on PATH** — Install a system Python 3.10+ or place a compatible venv at `~/.omp/python-env`. `omp setup python --check` reports the resolved interpreter.
- **Execution hangs then times out** — Increase `timeout` for legitimate work or set it to `0` to disable the watchdog. For stuck native code, cancellation sends `SIGINT` first and then escalates; session mode recreates the kernel on the next request if it had to be killed.
- **stdin/input prompts in Python code** — `input()` is not supported; pass data programmatically.
- **Working directory errors** — Python runs in the session cwd. Use `%cd` or `os.chdir()` inside the retained kernel to change it.

## Relevant environment variables

- `PI_PY` / `PI_JS` — per-backend exposure overrides
- `PI_PYTHON_SKIP_CHECK=1` — bypass Python preflight/warm checks
- `PI_PYTHON_INTEGRATION=1` — enable gated integration tests that spawn a real Python
- `PI_PYTHON_IPC_TRACE=1` — log NDJSON frames exchanged with the runner subprocess
