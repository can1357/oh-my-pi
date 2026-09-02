---
title: Code Execution
description: The bash shell, Python and JavaScript cell runtimes, and how to run code against your project workspace.
coverage: B
---

The agent can run code through the built-in `bash`, `eval`, and `debug` tools. The shell and the cell runtimes share the session's working directory and have their own behavior around non-interactive execution, persistence, and timeouts. Notebooks are not a separate tool: `.ipynb` files are read and edited as cell-marked text, while cell execution uses the Python runtime (see [Notebooks](#notebooks)).

## The `bash` tool

`bash` executes a shell command in the session workspace. The tool surface is `toolName: "bash"` with parameters `command` (required), `env` (optional map), `timeout`, `cwd`, `pty`, and `async` (only honored when `async.enabled` is set for the session).

### Non-interactive execution

The non-PTY execution path builds the child environment through `buildNonInteractiveEnv()`, layering non-interactive hardening defaults **under** any `env` overrides you pass:

- pagers disabled: `PAGER=cat`, `GIT_PAGER=cat`, and `LESS=FRX`
- editors disabled: `GIT_EDITOR=true`, `EDITOR=true`, `VISUAL=true`
- terminal/credential prompts reduced: `TERM=dumb`, `GIT_TERMINAL_PROMPT=0`, `SSH_ASKPASS=/usr/bin/false`, `NO_COLOR=1`, `CI=1`
- package-manager/tooling automation flags for npm, pnpm, yarn, pip, cargo, terraform, and `gh`
- on Windows, UTF-8 locale/codepage defaults are added when absent

PTY mode skips this hardening. It inherits the user environment, sets `TERM=xterm-256color`, and renders an interactive xterm overlay you can drive with the keyboard (`Esc` kills the session).

### Timeouts, backgrounding, and output

- Default timeout is `300` seconds; `clampTimeout("bash", n)` clamps any requested value to `1..3600` seconds.
- `async: true` registers a managed job and returns immediately with a job id; auto-backgrounding can also start a managed job after `bash.autoBackground.thresholdMs` (default 60,000 ms).
- Output is streamed through an `OutputSink` with a 50 KB UTF-8-safe in-memory tail; the head and middle are elided when over a configurable byte threshold, and full output can spill to an `artifact://` reference.
- The native subprocess is killed at `max(1_000, timeoutMs) ms`; cancelled runs surface as `ToolError`, missing exit status as `Command failed: missing exit status`, non-zero exits as `Command exited with code N`.

### Interception

If `bashInterceptor.enabled` is on, common misuses are blocked before they execute and the error points the model at a more appropriate tool. Default rules from `DEFAULT_BASH_INTERCEPTOR_RULES`:

| Pattern | Suggested tool |
| --- | --- |
| `cat|head|tail|less|more` | `read` |
| `grep|rg|ripgrep|ag|ack` | `grep` |
| `find|fd|locate` with name/type/glob flags | `glob` |
| `sed -i`, `perl -i`, `awk -i inplace` | `edit` |
| `echo|printf|cat <<` with redirection | `write` |

A rule fires only when its suggested tool is present in `ctx.toolNames`; missing tools disable the corresponding rule.

### Bundled `jq` compatibility

The non-PTY shell registers a bundled `jq` backed by vendored [jaq](https://github.com/01mf02/jaq). Chained access through a null parent exits with status 5, while `jq` returns `null`. Guard with `[.a.b?][0]` to get a clean `null` while preserving a legitimate `false`. The naive `.a.b? // null` is a syntax error in `jq` and silently rewrites booleans to the fallback in jaq.

## The `eval` tool

`eval` runs ordered cells in either Python or JavaScript. The tool takes a `cells` array with at least one entry; each cell has a `language` (`"py"` or `"js"`), a `code` string, an optional `title`, an optional `timeout` in seconds (default `30`, clamped `1..3600`), and an optional `reset` flag.

### A minimal multi-language call

```json
{
  "cells": [
    { "language": "py", "title": "imports", "code": "import json\nfrom pathlib import Path" },
    { "language": "py", "title": "load config", "code": "data = json.loads(read('package.json'))\ndisplay(data)" },
    { "language": "js", "title": "summary", "code": "const data = JSON.parse(await read('package.json'));\ndisplay(data);\nreturn data.name;" }
  ]
}
```

State persists within each language across cells and across calls. `reset: true` wipes the kernel for that language only; a Python reset does not touch the JS VM and vice versa.

### Output

`display(value)` is rendered by MIME type. Plain objects and arrays become JSON tree outputs; scalars become text; `{ type: "image", data, mimeType }` becomes an image block. Python also captures rich `display(...)` payloads: `text/markdown` and `text/plain` render as text, `text/html` is converted to basic markdown, `image/png` and `image/jpeg` become image blocks, and `application/x-omp-status` produces structured status events.

The cell `timeout` is a wall-clock budget on the cell's own work. It is **suspended** while a host-side `agent()`, `parallel()`, or `completion()` bridge call is in flight (those calls emit pause/resume status events that restart a fresh window when control returns), but it is **not** paused for ordinary compute, `stdout`/`stderr`, `log()`/`phase()`, or non-bridge tool calls.

### Backend selection

Backend choice is explicit per cell; there is no auto-detection. Per-cell dispatch is gated by the `eval.py` and `eval.js` settings (both default `true`) and the `PI_PY` / `PI_JS` environment overrides. A disabled or unavailable backend throws `ToolError` for that cell with no silent fallback.

### JavaScript runtime

A persistent worker-backed VM keyed by the session id. Top-level `await` and `return` are supported; static and dynamic `import` statements are rewritten so the specifier resolves against the session cwd. The module cache is busted for local filesystem imports between cells (relative paths, POSIX-absolute, home-prefixed, or Windows drive-letter specifiers) so edits to source files are picked up without restarting. Bare specifiers and URL/scheme specifiers are left in cache.

Globals installed by the prelude include `display`, `print`, a `console` bridge, `read`, `write`, `env`, `output`, `log(message)`, `phase(title)`, a live `budget` view, `tool.<name>(args)` for arbitrary session tool calls, `completion(prompt, opts?)`, `agent(prompt, opts?)`, and `parallel(...)` / `pipeline(...)` for bounded fan-out.

### Python runtime

The Python backend runs an NDJSON subprocess (`python -u runner.py`) keyed by session id plus normalized cwd and interpreter. Top-level `await` works; `asyncio.run(...)` is not used. The runner sets `MPLBACKEND=Agg` so matplotlib figures render off-screen and are saved to PNG between cells.

Magics supported inside cells:

| Magic | Effect |
| --- | --- |
| `%pip <args>` | `python -m pip <args>` with live streaming; new packages are evicted from `sys.modules`. |
| `%cd <path>` | `os.chdir(path)` with `~` expansion. |
| `%pwd`, `%ls [path]` | Current working directory / `sorted(os.listdir(path))`. |
| `%env [KEY[=VAL]]`, `%set_env KEY VALUE` | List, read, or set environment variables. |
| `%time` / `%timeit` | Time an expression; emit a status event with elapsed ms. |
| `%who` / `%whos` | List user-namespace names. |
| `%reset` | Clear user globals and re-inject the prelude. |
| `%load <path>`, `%run <path>` | Read a file into a cell, or `runpy.run_path` it. |
| `%%bash` / `%%sh` | Run the cell body through `bash`/`sh`. |
| `%%capture [name]` | Capture stdout/stderr into `name`. |
| `%%timeit` | Time the cell body. |
| `%%writefile <path>` | Write the cell body to file. |
| `!cmd`, `var = !cmd` | Subprocess shell; returns an SList-style result with `.n` / `.s` helpers. |

Interactive stdin is not supported. A `Kernel requested stdin; interactive input is not supported.` error is returned for any code that calls `input()`.

### Cell helpers

Both runtimes expose `completion(prompt, opts?)` and `agent(prompt, opts?)`.

- `completion` calls one stateless completion. `model` selects a tier — `"smol"` (the `@smol` role), `"default"` (the session's active model, falling back to `@default`), or `"slow"` (the `@slow` role; requests high reasoning effort on reasoning-capable models). `system` supplies a system prompt. `schema` forces a synthetic `respond` tool call parsed into an object.
- `agent` runs one subagent through the task executor, inheriting the parent eval session's spawn policy and executor id. `agent` defaults to the bundled `task` agent. `model` may pin a per-call selector or fallback chain. `handle: true` returns a DAG node dict with a `handle: "agent://<id>"` URI instead of the bare output. Eval-driven subagent recursion is capped at depth 3.
- `parallel(thunks)` and `pipeline(items, ...stages)` are bounded-pool helpers; their width tracks the `task.maxConcurrency` setting (default `32`; `0` = unbounded), fetched live through the `__concurrency__` bridge.

## Notebooks

Notebook support is file conversion and editing, not notebook execution. The `read` tool treats `.ipynb` files as cell-marked text with `# %% [code|markdown|raw] cell:N` markers; `edit` and `write` round-trip that virtual text back to notebook JSON while preserving existing metadata. Line and multi-range selectors operate on the virtual text.

There is no separate tool that starts or talks to a Python kernel for `.ipynb` files. To execute notebook cells, copy the desired cell source into an `eval` cell with `language: "py"`; the kernel-backed execution path provides the persistent state, display capture, and rich outputs that notebook JSON editing does not.

## See also

- [Tools: files and editing](/oh-my-pi/features/tools/#files-and-editing) — `read`, `write`, `edit`
- [Debugging](/oh-my-pi/features/debugging/) — `debug` for the DAP-driven code-execution path
- [Code intelligence](/oh-my-pi/features/code-intelligence/) — `ast_grep` and `ast_edit` for structural searches and rewrites
