Run one step of code in a persistent kernel. State persists across calls and `task` subagents.
{{#if spawns}}Eval `agent()` children use independent kernels.{{/if}}

Work incrementally: imports → define → test → use, each its own cell. Re-run setup ONLY after `reset`, kernel crash.
Parallelize *within* a cell with `parallel(thunks)`, not by batching.

{{#if py}}Top-level `await` works; `asyncio.run(…)` raises error.{{/if}}
{{#if js}}JS runs under **Bun**: globals (`Bun.file`, `Bun.write`, `Bun.$`, `fetch`, `Buffer`) available; top-level `await`/`return` work.{{/if}}

On error, fix and re-run only the failing step.

<prelude>
{{#ifAll py js}}Python: sync, kwargs. JS: async, ONE trailing object literal, never positional.{{else}}{{#if py}}Sync; kwargs.{{/if}}{{#if js}}Async; ONE trailing object literal, never positional.{{/if}}{{/ifAll}}{{#if rb}} Ruby: sync, kwargs.{{/if}}{{#if jl}} Julia: sync, kwargs.{{/if}}
```
display(value) → None        print(value, ...) → None
read(path, offset?=1, limit?=None) → str
write(path, content) → str
env(key?=None, value?=None) → str | None | dict
output(*ids, format?="raw", query?=None, offset?=None, limit?=None) → str | dict | list[dict]
tool.<name>(args) → unknown
    Invoke any session tool; `args` = its parameter object.
completion(prompt, model?="default"|"smol"|"slow", system?=None, schema?=None) → str | dict
    Oneshot, stateless (no history/tools). `model`: "smol" fast | "default" session | "slow" most capable. `schema` (JSON-Schema) → parsed object.
{{#if spawns}}agent(prompt, agent?="{{spawnDefaultAgent}}", label?=None, schema?=None, schema{{#if js}}Mode{{else}}_mode{{/if}}?="permissive", isolated?=None, apply?=None, merge?=None, handle?=False) → str | dict
    Run a subagent → final output. `agent` selects a discovered agent; omit it to use `{{spawnDefaultAgent}}`.{{#if spawnAllowedAgentsText}} Allowed agents: {{spawnAllowedAgentsText}}.{{/if}} `schema` overrides agent/session schemas; `schemaMode`/`schema_mode`: "permissive" | "strict". Effective schemas return parsed data. `isolated` requests a worktree; `apply`/`merge` control its changes. Background via `local://` files named in the prompt. `handle` → { text, output, handle: "agent://<id>", id, agent }, parsed `data` when structured.
{{#if js}}    JS: ONE trailing object — agent(prompt, { agent, label, schema, schemaMode, isolated, apply, merge, handle }).{{/if}}
{{/if}}
parallel(thunks) → list     pipeline(items, ...stages) → list
log(message) → None         phase(title) → None
budget → {{#if py}}`budget.total` (ceiling or None), `budget.spent()`, `budget.remaining()`{{/if}}{{#if js}}`await budget.total()`, `await budget.spent()`, `await budget.remaining()`{{/if}}{{#if rb}}`budget.total`, `budget.spent`, `budget.remaining`{{/if}}{{#if jl}}`budget.total`, `budget.spent()`, `budget.remaining()`{{/if}}; ceiling `+Nk` advisory, `+Nk!` hard.
{{#if rlm}}{{#ifAny py js}}llm_query(snippet, instructions?=None, *, model?="default") → str
    Sub-LLM completion; `instructions` (when given) prefixes `snippet`.{{#if js}} `await`.{{/if}}
llm_query_batched(prompts, *, model?="default") → list[str]
    Parallel sub-LLM completions, same order as input.{{#if js}} `await`.{{/if}}
{{#if spawns}}rlm_query(prompt, *, agent?=None) → str
    Recursive subagent (via agent()); `agent` omitted resolves the session's default spawn policy. Returns its text.{{#if js}} `await`.{{/if}}
rlm_query_batched(prompts, *, agent?=None) → list[str]
    Parallel recursive subagents, same order.{{#if js}} `await`.{{/if}}
{{/if}}
chunk(text, *, by?="lines", size?=100) → list[str]
    Split into `size` chunks by "lines" (join "\n") or bounded ~`size`-token windows (~4 chars/token, character-bounded regardless of whitespace). Empty text → [].
search(text, pattern, flags?=0, limit?=100, max_line_chars?=1000) → list[str]
    "L<lineno>: <line>" for each regex-matching line, capped at `limit` matches (default 100; `{ limit }` in JS, `limit=` in Python). Matching lines longer than `max_line_chars` chars (default 1000; `{ max_line_chars }` in JS, `max_line_chars=` in Python) keep a bounded window around the first match — emitted as "L<lineno>@<offset>: <window>" with "..." markers on cut sides and a "... (line truncated)" suffix — so the excerpt always shows the matched region. Appends "... (truncated, more matches may exist)" when the scan stops early. No match → [].
metadata(text) → dict
    str → {chars, lines, words, approx_tokens}; list → {items, chars, approx_tokens}.
{{/ifAny}}{{/if}}
```
</prelude>
{{#if spawns}}
<dag>
Acyclic waves via `agent(…, handle=true)` + `pipeline`/`parallel`:
- **Name nodes.** Capture agent result → `handle` (`agent://<id>`) + `output`.
- **Wire edges.** Put upstream `handle`/`output` in downstream prompt. Bulk: `write("local://<name>.md", …)`.
- **`pipeline`** = staged waves, barrier between stages. **`parallel`** = one wave.
- **Isolate failure.** Wrap risky nodes in try/except; a failure degrades only its subtree.
- **Acyclic only.** No node waits on its own descendant.
</dag>
{{/if}}

<critical>
Prior top-level names survive into the next cell — reuse; NEVER re-import/re-declare. Re-read only if file changed since last read.
</critical>

{{#if autoBackgroundEnabled}}Long-running cells may auto-background by the configured threshold and deliver later; the kernel stays busy until the cell finishes.
`timeout: 0` disables the cell deadline; otherwise `timeout` sets it without extending foreground waiting.{{/if}}
