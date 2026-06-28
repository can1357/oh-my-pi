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

The `eval` tool executes one or more Python cells inside a retained `python` subprocess that speaks NDJSON over stdin/stdout. No Jupyter gateway and no extra pip dependencies are required — a vanilla Python 3.8+ interpreter is enough. Rich `display()` output (PIL, pandas, plotly, matplotlib figures) keeps working because the wrapper implements MIME-bundle dispatch.

Tool params:

```ts
{
  cells: Array<{
    language: "py" | "js";
    code: string;
    title?: string;
    timeout?: number; // seconds, clamped to 1..3600, default 30. Inactivity budget — see "Cell timeout".
    reset?: boolean; // reset this cell's selected runtime before execution
  }>;
}
```

The tool is `concurrency = "exclusive"` for a session, so calls do not overlap.

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
| `%%bash` / `%%sh`                 | Run the cell body via `bash`/`sh`.                                                                                                                          |
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
  - If the subprocess dies during execution, it is replaced and the cell is retried once.
- `per-call`
  - Spawns a fresh subprocess for each request.
  - Shuts the subprocess down after the request.
  - No cross-call state persistence.

### Multi-cell behavior in a single tool call

Python cells run sequentially in the same selected Python kernel instance for that tool call.

If an intermediate cell fails:

- Earlier cell state remains in memory.
- Tool returns a targeted error indicating which cell failed.
- Later cells are not executed.

`reset=true` is per cell and resets that language runtime before the cell executes.

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

`eval.py` / `eval.js` (both default `true`) plus optional boolean env flags `PI_PY` / `PI_JS` control eval backend exposure:

- Python backend only (`eval.py=true`, `eval.js=false`, or `PI_PY=1 PI_JS=0`)
- JavaScript backend only (`eval.py=false`, `eval.js=true`, or `PI_PY=0 PI_JS=1`)
- both backends (`eval.py=true`, `eval.js=true`, or `PI_PY=1 PI_JS=1`)

`PI_PY` and `PI_JS` use normal boolean flag parsing. Each flag, when set, overrides only its own setting; an unset flag falls back to its setting (`eval.py` / `eval.js`, both default `true`).

If Python preflight fails and `eval.js` is enabled, `eval` remains available for `js` cells; `py` cells fail with a Python-backend availability error.

Python prelude helpers include `agent(prompt, *, agent="task", model=None, label=None, schema=None, handle=False)`. It synchronously calls the host bridge, runs one subagent through the task executor, and returns the final text. When `schema` is supplied, the helper parses the subagent's JSON output and returns the object. When `handle=True`, it instead returns a DAG node dict (`{"text", "output", "handle", "id", "agent"}`) whose `handle` is the spawned agent's recoverable `agent://<id>` URI (the parsed object lands under `"data"` when `schema` is also set), so a downstream `pipeline`/`parallel` stage can reference the transcript by handle instead of re-inlining it.

## Execution flow and cancellation/timeout

### Cell timeout

Each eval cell `timeout` is in seconds, defaults to 30, and is clamped to `1..3600`. It is a **wall-clock budget on the cell's own work** that the watchdog (`IdleTimeout`, `src/eval/idle-timeout.ts`) enforces, **but it is suspended while a host-side `agent()`/`parallel()`/`completion()` bridge call is in flight**: those calls emit synthetic pause/resume timeout-control status events (`withBridgeTimeoutPause`, `src/eval/bridge-timeout.ts`) that pause the watchdog entirely and start a fresh timeout window when control returns to the runtime, so a long fanout or a slow completion runs to completion instead of being killed mid-stream. Pause is reference-counted because `parallel()` can have multiple bridge calls in flight at once.

The pause/resume events are the **sole** mechanism that suspends the budget. Everything else the cell does — compute, `stdout`/`stderr`, `log()`/`phase()`, and ordinary (non-agent) tool calls — counts against `timeout`, so a cell that is not delegating to an agent/completion is bounded by a plain wall-clock timeout. The tool combines the caller abort signal, the session abort signal, and the watchdog's signal with `AbortSignal.any(...)`; no wall-clock deadline is passed to the backend, so neither runtime arms a competing fixed timer.

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

- **Python backend not available** — Check `eval.py`, `PI_PY`, and that `python`/`python3` is on PATH. If preflight fails and `eval.js` is enabled, use a `js` cell.
- **No Python on PATH** — Install a system Python 3.8+ or place a venv at `~/.omp/python-env`. `omp setup python --check` reports the resolved interpreter.
- **Execution hangs then times out** — Increase tool `timeout` (max 3600s) if workload is legitimate. For stuck native code, cancellation triggers `SIGINT` first then escalates; the session restarts on the next request.
- **stdin/input prompts in Python code** — `input()` is not supported; pass data programmatically.
- **Working directory errors** — Tool validates `cwd` exists and is a directory before execution.

## Relevant environment variables

- `PI_PY` / `PI_JS` — eval backend exposure overrides
- `PI_PYTHON_SKIP_CHECK=1` — bypass Python preflight/warm checks
- `PI_PYTHON_INTEGRATION=1` — enable gated integration tests that spawn a real Python
- `PI_PYTHON_IPC_TRACE=1` — log NDJSON frames exchanged with the runner subprocess
