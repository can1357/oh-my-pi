Run one step of code in a persistent kernel.

<instruction>
**One eval call = one cell = one logical step.** State persists per language across separate eval calls, tool calls, and `task` subagents — define helpers/datasets/clients in one call, then later calls reuse them directly.

Work incrementally: imports in one call, define in the next, test, then use — each its own eval call. Re-run setup ONLY after `reset`, a kernel crash, or a `NameError`/`ReferenceError` proving the state is gone. Parallelize work *within* a cell with the `parallel(thunks)` helper, not by batching steps.

Fields:

- `language` — {{#if py}}`"py"` IPython kernel{{/if}}{{#ifAll py js}}, {{/ifAll}}{{#if js}}`"js"` persistent JavaScript VM{{/if}}{{#if rb}}{{#ifAny py js}}, {{/ifAny}}`"rb"` persistent Ruby kernel{{/if}}{{#if jl}}{{#ifAny py js rb}}, {{/ifAny}}`"jl"` persistent Julia kernel{{/if}}.
- `code` — cell body, verbatim. Newlines/quotes JSON-encoded; no fences, no headers.
- `title` (optional) — short transcript label (e.g. `"imports"`).
- `timeout` (optional) — seconds. Raise only for heavy compute or long non-agent tool calls.
- `reset` (optional) — wipe this language's kernel first.{{#ifAll py js}} Per-language: a `py` reset never touches the JS VM.{{/ifAll}}

{{#if py}}Live event loop: use top-level `await` directly; `asyncio.run(…)` raises "cannot be called from a running event loop".{{/if}}
{{#if js}}JS runs under **Bun**: Bun globals/APIs are available (`Bun.file`, `Bun.write`, `Bun.$`, `fetch`, `Buffer`); top-level `await`/`return` work directly.{{/if}}
{{#if rb}}Ruby: synchronous; helper options are keyword args (e.g. `output("id", limit: 2)`); the last expression auto-displays unless it is `nil`, an assignment, or a definition (like IRB).{{/if}}
{{#if jl}}Julia: synchronous; helper options are standard keyword args (e.g. `output("id", limit=2)`); the last expression auto-displays unless it is an assignment or a definition (like the Julia REPL).{{/if}}
On error, fix and re-run only the failing step — prior calls' state survives.
</instruction>

<prelude>
{{#ifAll py js}}Same helpers + arg order, both runtimes. Python: sync, options = trailing kwargs. JS: async/`await`able, options = ONE trailing object literal, never positional (extras throw).{{else}}{{#if py}}Sync; options = trailing kwargs.{{/if}}{{#if js}}Async/`await`able; options = ONE trailing object literal, never positional (extras throw).{{/if}}{{/ifAll}}{{#if rb}} Ruby: sync, options = trailing keyword args.{{/if}}{{#if jl}} Julia: sync, options = trailing keyword args.{{/if}}
```
display(value) → None
    Cell output; figures/images/dataframes shown natively.
print(value, ...) → None
    Text output.
read(path, offset?=1, limit?=None) → str
    File as text; offset/limit 1-indexed lines. Accepts `local://…`.
write(path, content) → str
    Write file (creates parents) → resolved path. `local://…` persists across turns/subagents.
env(key?=None, value?=None) → str | None | dict
    No args → full env dict; one → value of `key`; two → set `key=value`, return value.
output(*ids, format?="raw", query?=None, offset?=None, limit?=None) → str | dict | list[dict]
    Task/agent output by id; one → text/dict, multiple → list.
tool.<name>(args) → unknown
    Invoke any session tool; `args` = its parameter object.
completion(prompt, model?="default", system?=None, schema?=None) → str | dict
    Oneshot, stateless (no history/tools). `model`: "smol" fast | "default" session | "slow" most capable. `schema` (JSON-Schema) → structured output, parsed object.
{{#if spawns}}agent(prompt, agent?="task", model?=None, label?=None, schema?=None, handle?=False) → str | dict
    Run a subagent → final output. `agent` picks another discovered agent; `schema` as in completion(). Background via `local://` files named in the prompt. `handle` → DAG node dict { text, output, handle: "agent://<id>", id, agent } (parsed under `data` when `schema` set).
{{#if js}}    JS: options are ONE trailing object — agent(prompt, { agent, schema, handle }).
{{/if}}
{{/if}}
parallel(thunks) → list
    Thunks through a bounded pool (wide as a `task` batch — don't pre-shrink), input order kept; returns when all finish, a throwing thunk propagates.
pipeline(items, ...stages) → list
    Map items through one-arg stages left-to-right, barrier between stages; stage 1 gets the item, later stages the previous result.
log(message) → None
    Progress line above the status tree.
phase(title) → None
    Phase grouping subsequent status lines.
budget → per-turn token budget
    {{#if py}}`budget.total` (ceiling or None), `budget.spent()`, `budget.remaining()` (math.inf when no ceiling), `budget.hard`.{{/if}}{{#if js}}`await budget.total()` (ceiling or null), `await budget.spent()`, `await budget.remaining()` (Infinity when no ceiling), `await budget.hard()`.{{/if}}{{#if rb}} Ruby: `budget.total` (ceiling or nil), `budget.spent`, `budget.remaining` (Float::INFINITY when no ceiling), `budget.hard`.{{/if}}{{#if jl}} Julia: `budget.total` (ceiling or nothing), `budget.spent()`, `budget.remaining()` (Inf when no ceiling), `budget.hard`.{{/if}} Ceiling: `+Nk` (advisory) or `+Nk!`/Goal Mode (hard — `agent()` won't spawn past it); spend still tracked.
```
</prelude>
{{#if spawns}}
<dag>
Pipe handles through stage helpers to build a dependency graph — acyclic waves:
- **Name nodes.** Capture each `agent(…, {{#if py}}handle=True{{/if}}{{#if js}}{ handle: true }{{/if}}{{#if jl}}handle=true{{/if}})` result; carries `handle` (`agent://<id>`) + `output`.
- **Wire edges by reference.** Put an upstream node's `handle`/`output` in the dependent stage's prompt — large transcript never re-inlined. Bulk: `write("local://<name>.md", …)`, pass the URI.
- **`pipeline(items, *stages)` = staged waves**, barrier between stages (every item clears stage N before any enters N+1). **`parallel(thunks)` = one wave** of independent nodes.
- **Isolate failure.** A raising node re-raises the lowest-index error, aborts its wave; wrap risky nodes in try/except so a failure degrades only its dependent subtree, independent branches finish.
- **Acyclic only.** A node never waits on its own descendant.
</dag>
{{/if}}

<critical>
Prior top-level names (`data`, `sessions`, helpers, imports) survive into the next eval call — reuse them; NEVER re-import, re-require, or re-declare a helper. Re-read a file only if it may have changed since the last read. Re-run setup only after `reset`, a crash, or a `NameError`/`ReferenceError`.
</critical>
