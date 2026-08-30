# eval

> Execute one Python, JavaScript, Ruby, or Julia cell in a persistent language runtime. One tool call is one cell; state survives later calls.

> **Notice:** Do not shell out to `python -c`, `ruby -e`, `julia -e`, `bun -e`, or `node -e` through `bash` for ad-hoc code. `eval` provides retained state, structured `display()` capture, tool/subagent bridges, streaming, cancellation, and artifact-backed truncation.

## Source
- Entry and dynamic schema: `packages/coding-agent/src/tools/eval.ts`
- Backend enablement: `packages/coding-agent/src/tools/eval-backends.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/eval.md`
- Code Mode transport (Codex `code_mode_only` sessions demote non-essential tools into an eval bridge): `packages/coding-agent/src/tools/eval-format/code-mode-declarations.ts`, prompt `packages/coding-agent/src/prompts/tools/eval-code-mode.md`
- Shared contracts: `packages/coding-agent/src/eval/backend.ts`, `types.ts`, `executor-base.ts`, `kernel-base.ts`
- Host bridges: `packages/coding-agent/src/eval/agent-bridge.ts`, `completion-bridge.ts`, `concurrency-bridge.ts`, `budget-bridge.ts`
- JavaScript: `packages/coding-agent/src/eval/js/`
- Python: `packages/coding-agent/src/eval/py/`
- Ruby: `packages/coding-agent/src/eval/rb/`
- Julia: `packages/coding-agent/src/eval/jl/`
- Output/truncation: `packages/coding-agent/src/session/streaming-output.ts`
- Python internals: `docs/python-repl.md`

## Inputs

The params object is one cell. There is no `cells` array, header parser, language sniffing, or implicit fallback. Run incremental steps as separate tool calls; each language keeps its own state.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `language` | `"py" \| "js" \| "rb" \| "jl"` | Yes | Explicit backend token. Normally the live schema includes only enabled runtimes; see the all-disabled edge case below. |
| `code` | `string` | Yes | Cell body, verbatim. |
| `title` | `string` | No | Short transcript label. |
| `timeout` | `number` | No | Runtime-work timeout in seconds. Default 30; `0` disables the cell timeout. Nonzero values are clamped by the tool timeout policy (`TOOL_TIMEOUTS.eval`: 1–3600 s) and `tools.maxTimeout`. |
| `reset` | `boolean` | No | Recreate this language's retained runtime before execution. Other language runtimes are untouched. Default `false`. |

Example across three calls:

```json
{"language":"py","title":"imports","code":"import json\nfrom pathlib import Path"}
```

```json
{"language":"py","title":"load config","code":"data = json.loads(read('package.json'))\ndisplay(data)"}
```

```json
{"language":"py","title":"reuse state","code":"display(sorted(data['dependencies']))"}
```

## Backend availability

`resolveEvalBackends(...)` combines settings with environment overrides:

| Token | Runtime | Setting/default | Environment override | Additional prerequisite |
| --- | --- | --- | --- | --- |
| `py` | retained IPython-style Python kernel | `eval.py=true` | `PI_PY` | usable configured Python interpreter/kernel |
| `js` | retained Bun worker VM | `eval.js=true` | `PI_JS` | bundled JS runtime |
| `rb` | retained Ruby kernel | `eval.rb=false` | `PI_RB` | usable `ruby.interpreter` or discovered Ruby |
| `jl` | retained Julia kernel | `eval.jl=false` | `PI_JL` | usable `julia.interpreter` or discovered Julia |

Ruby and Julia are opt-in. When at least one runtime is enabled, disabled runtimes are removed from the session-scoped wire schema and model prompt. If **all four** are disabled, the current `parameters` fallback returns the full static union even though every execution is rejected by `resolveBackend(...)`; this contradicts the nearby source comment that disabled backends never reach the model. A requested unavailable runtime raises `ToolError`; the tool never substitutes another language.

## Outputs

`execute()` returns one text content block plus any image blocks. `onUpdate` streams the active cell's output and details while it runs.

- Text is stdout/stderr plus model-visible JSON `display()` values and image dimension notes.
- Image-only success reports `(displayed N image(s); no text output)`; a cell with no visible output reports `(no output)`.
- A nonzero backend exit appends `Command exited with code N`, marks the cell `error`, and sets `details.isError`.
- Cancellation returns the captured output or `Command aborted`, with `details.isError=true`.

`EvalToolDetails`:

- `cells`: a one-element `EvalCellResult[]` with `index`, `title?`, `code`, backend `language`, `output`, `status`, `durationMs?`, `exitCode?`, `statusEvents?`, and `hasMarkdown?`.
- `language`: the backend used; `languages`: the distinct backend list. These retain the historical multi-cell-compatible shape, but a current call has one backend.
- `jsonOutputs`: values captured through structured display.
- `images`: present on live updates when images have arrived; final images are content blocks.
- `statusEvents`: deduplicated helper/tool status events.
- `notice`: optional backend notice.
- `meta`: output truncation/artifact metadata supplied by `toolResult(...)`.
- `async`: present when the cell was auto-backgrounded as an async job (`{ state, jobId, type: "eval" }`).
- `isError`: set for backend failure or cancellation.

The renderer merges call and result inline, syntax-highlights from the declared language, renders markdown and JSON trees specially, and shows timeout/truncation metadata. `session.allocateOutputArtifact?.("eval")` backs spilled output; `artifact://...` in `meta` reaches the full capture.

## Execution flow

1. `EvalTool` builds a session-specific schema from enabled languages. It is essential, strict, `approval="exec"`, and `concurrency="exclusive"` within one agent session.
2. `execute()` maps `py/js/rb/jl` to `python/js/ruby/julia`, resolves availability, and wraps the single input in the renderer-compatible internal cell list.
3. It obtains the retained executor id from `session.getEvalSessionId?.()` or `defaultEvalSessionId(session)`, allocates the output sink/artifact, and registers the run through `trackEvalExecution?.(...)`.
4. The timeout defaults to 30 seconds. `0` creates no watchdog. Otherwise `IdleTimeout` is combined with tool and session abort signals.
5. `agent()`, `parallel()`, and `completion()` emit pause/resume status operations: time spent in those host bridges does not consume the cell's runtime-work budget. Compute, output, status helpers, and ordinary `tool.*` calls do consume it.
6. The selected backend receives cwd, retained session id, session file, kernel owner, reset flag, callbacks, and cancellation signal.
7. Output chunks stream into an artifact-aware `OutputSink` and live tail. Rich displays are separated into JSON, image, markdown, and status channels.
8. Success, nonzero exit, and cancellation are assembled into the result shapes above. The output sink is finalized even when execution fails.

## Auto-backgrounding

With `eval.autoBackground.enabled` (default `false`), a cell that outlives `eval.autoBackground.thresholdMs` (default 60000 ms) is converted into a managed async job instead of blocking the turn:

- The tool foreground-waits for `resolveAutoBackgroundWaitMs(thresholdMs, clampedCellTimeoutMs)`: the threshold, clamped down to the cell's own clamped timeout minus a 1 s buffer so a deadline expiry resolves inline rather than backgrounding moments before it fires. Raising `timeout` therefore does not extend foreground execution beyond the threshold. A threshold of `0` backgrounds immediately.
- On backgrounding, the tool returns the live output tail plus `Backgrounded as job <id>; result will be delivered automatically.`, with `details.async = { state: "running", jobId, type: "eval" }`. The job's completion is delivered later like a backgrounded bash command.
- A queued user/peer message (steer) arriving mid-wait backgrounds the cell immediately ("Backgrounded early to handle an incoming message; the cell keeps running.").
- At the async-job manager's running-job capacity the tool falls through to ordinary foreground execution instead of failing.
- A failed, cancelled, or timed-out cell is reported as a failed background job (an errored execution is re-entered into the job manager's failure path), never as a silent success.

## Runtime behavior

### JavaScript (`js`)

- Persistent worker VM keyed by `js:${sessionId}`; `reset` recreates the VM and is destructive to concurrent users of that session id.
- Runs under Bun and exposes host globals including `Bun`, `Buffer`, `fetch`, `process`, `require`, `createRequire`, `fs`, and Web Crypto.
- Top-level `await` and bare `return` work through async wrapping.
- Static top-level imports and dynamic imports are rewritten through the local module loader. Local filesystem imports are cache-busted between cells; bare package and scheme/URL imports retain normal cache identity.
- Awaited regions can interleave with another session sharing the executor; synchronous code still blocks the worker event loop.

### Python (`py`)

- Retained kernels are keyed by `python:${sessionId}`, normalized cwd, and interpreter. `python.kernelMode="per-call"` instead creates and shuts down a fresh kernel for each invocation.
- The runner uses one persistent asyncio event loop, so top-level `await` works; `asyncio.run(...)` is invalid there.
- MIME frames support status, PNG, JSON, markdown, plain text, and HTML-to-markdown conversion.
- Interactive stdin is rejected with `Kernel requested stdin; interactive input is not supported.`
- Synchronous blocks use the default executor with copied ContextVars; Python bytecode still contends on the GIL.

### Ruby (`rb`)

- Retained kernels are keyed by `ruby:${sessionId}`, normalized cwd, and interpreter.
- Cells evaluate in persistent `TOPLEVEL_BINDING`; locals, methods, and constants survive. A trailing value is displayed like IRB unless it is nil, an assignment, or a definition.
- Rich display supports the OMP MIME convention and IRuby-compatible MIME hooks, using the shared kernel display pipeline.
- `reset` replaces the retained Ruby kernel.

### Julia (`jl`)

- Retained kernels are keyed by `julia:${sessionId}`, normalized cwd, and interpreter.
- Cells evaluate in persistent `Main`; a value-bearing trailing expression is displayed unless suppressed by statement form.
- Julia's display stack is bridged into the same MIME/status pipeline.
- `reset` replaces the retained Julia kernel.

## Prelude helpers

All enabled runtimes expose equivalent helpers where the language permits:

- `display(value)`, `print(...)`
- `read(path, offset?, limit?)`, `write(path, content)`, `env(...)`, `output(...)`
- `tool.<name>(args)` for a normal session tool call
- `completion(...)`, `agent(...)`, `parallel(...)`, `pipeline(...)`
- `log(message)`, `phase(title)`, `budget`

JS filesystem/bridge helpers are asynchronous; Python, Ruby, and Julia helpers are synchronous. `read()` delegates non-`local://` schemes to the registered read tool, resolves `local://` through injected roots, and reads regular paths relative to cwd. `write()` accepts regular and `local://` paths but rejects other protocol URLs.

`display()` captures JSON-compatible structures, images, markdown, or text according to the backend. Ruby and Julia additionally auto-display eligible final expressions.

### `completion()`

A stateless, tool-free one-shot model call:

- JS: `await completion(prompt, { model?, system?, schema? })`
- Python/Ruby/Julia: keyword form with `model`, `system`, and `schema`
- `model`: `"smol"`, `"default"`, or `"slow"` tier; default is the active/default tier.
- `schema`: JSON Schema for a synthetic `respond` tool; successful structured calls return parsed data.
- Unresolved tier, missing credentials, error/abort stop, empty output, and invalid structured output raise into the cell.

### `agent()`

Runs one subagent through `runStructuredSubagent(...)`:

- JS supports the preferred `await agent(prompt, { agent?, label?, schema?, schemaMode?, isolated?, apply?, merge?, handle? })`; legacy positional slots are still implemented.
- Python/Ruby/Julia use keyword arguments (`schema_mode` outside JS).
- `agent` defaults from the current spawn policy; the selected agent's frontmatter model and settings always apply (there is no per-call model override — `model` is not accepted). `schema` overrides agent/session schemas; `schemaMode`/`schema_mode` chooses `permissive` or `strict`.
- `isolated` requests isolation. `apply` controls whether captured changes are integrated; `merge=false` selects patch mode while the normal setting controls branch mode.
- `handle=true` returns `{ text, output, handle, id, agent }`, optional parsed `data`, and isolation metadata instead of only output/data.
- Eval subagents are one-shot (`keepAlive=false`), are unregistered/disposed after completion, and **do not share the caller's eval executor** (`shareEvalSession=false`). Their code mutations therefore do not appear in the caller's retained VM/kernel.
- Spawn policy, discovered-agent availability, the `task.maxRecursionDepth` gate (default `2`; negative values disable the cap), hard turn budget, subagent failure, strict schema failure, and isolation-apply failure are enforced as cell errors.

`parallel(thunks)` runs zero-argument callables in a bounded pool and preserves input order. `pipeline(items, ...stages)` applies each stage as a barriered wave. Pool width is read live from `task.maxConcurrency`; `0` means all items at once. The lowest-index failure is propagated.

## Side effects and cancellation

- Prelude helpers may read/write files and call arbitrary registered tools; JS exposes network-capable `fetch`.
- Python, Ruby, and Julia use retained subprocess kernels speaking framed local IPC. JavaScript uses a worker VM.
- Retained runtimes have no heartbeat or idle timer; they survive calls until reset, owner disposal (`EvalRunner.disposeKernels()` calls the `disposeKernelSessionsByOwner` / `disposeRubyKernelSessionsByOwner` / `disposeJuliaKernelSessionsByOwner` / `disposeVmContextsByOwner` family keyed by `kernelOwnerId`, in `packages/coding-agent/src/session/eval-runner.ts`), or process exit.
- Cancellation is destructive when needed: JS terminates its worker; managed kernels interrupt and may escalate to shutdown. A reset is likewise destructive to concurrent work sharing that backend session.
- Eval-driven `agent()` may run tools and isolated workspaces, but its child is disposed rather than retained for hub follow-up.

## Limits and errors

- Default timeout: 30 seconds; `0` disables. Nonzero timeouts are clamped through `clampTimeout("eval", ..., tools.maxTimeout)`.
- Output sink default window: 50 KiB (`DEFAULT_MAX_BYTES`); live tail: 100 KiB; truncation helpers cap at 3000 lines.
- Each JSON display value included in model-visible text is capped at 8000 characters; the full structured value remains in `jsonOutputs`.
- Transcript preview defaults to 10 lines.
- Eval subagent spawning obeys `task.maxRecursionDepth` (default `2`; negative values allow unlimited depth). Helper fan-out uses `task.maxConcurrency` (default 32, `0` unbounded).
- Malformed params are schema errors; unavailable/disabled backends and missing session are `ToolError`s.
- Runtime exceptions become backend output with nonzero exit. Interactive stdin is an error. Output truncation does not fail the call.
- A dead retained managed kernel may be replaced and the invocation retried once by its executor.

## Notes

- One call is one cell. Use separate calls to exploit persistence and rerun only the failed step.
- State is isolated by language; resetting Python does not reset JS, Ruby, or Julia.
- Current schema tokens are only `py`, `js`, `rb`, and `jl`; long language names are renderer/approval formatting aliases, not wire values.
- The former multi-cell `cells` payload, `*** Cell` parser, sniffing fallback, and constrained `eval.lark` grammar are removed.
- Parent and ordinary task subagents may share an inherited eval executor id; children created by eval's own `agent()` explicitly do not.
