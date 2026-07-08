Run code in a persistent kernel using a list of cells.

<instruction>
Cells run in array order. State persists per language across cells, tool calls, and `task` subagents — stage helpers/datasets/clients once, subagents reuse directly; NEVER re-import or re-serialize across the task boundary.

Cell fields:

- `language` — required
- `code` — cell body, verbatim; newlines/quotes JSON-encoded; no fences/headers
- `title?` — short transcript label
- `timeout?` — per-cell wall-clock seconds; raise only for heavy compute or long non-agent calls
- `reset?` — wipe this cell's kernel first{{#ifAll py js}} (other languages untouched){{/ifAll}}

Work incrementally — one logical step per cell (imports, define, test, use), many small cells per call. Workflow notes belong in the assistant message or `title`, never in cell code.
{{#if py}}Live event loop: use top-level `await` directly; `asyncio.run(…)` raises "cannot be called from a running event loop".{{/if}}
Errors name the failing cell ("Cell 3 failed") — resubmit the fixed cell + any remaining.
</instruction>

<prelude>
{{#ifAll py js}}Same helpers + arg order, both runtimes. Python: sync, options = trailing kwargs. JS: async/`await`able, options = ONE trailing object literal, never positional (extras throw).{{else}}{{#if py}}Sync; options = trailing kwargs.{{/if}}{{#if js}}Async/`await`able; options = ONE trailing object literal, never positional (extras throw).{{/if}}{{/ifAll}}
```
display(value) → None
    Cell output; figures/images/dataframes shown natively.
print(value, ...) → None
    Text output.
read(path, offset?=1, limit?=None) → str
    File as text; 1-indexed lines. Accepts `local://…`.
write(path, content) → str
    Write file (creates parents) → resolved path. `local://…` persists across turns/subagents.
append(path, content) → str
    Accepts `local://…`.
tree(path?=".", max_depth?=3, show_hidden?=False) → str
    Directory tree.
diff(a, b) → str
    Unified diff.
env(key?=None, value?=None) → str | None | dict
    No args → full env dict; one → value of `key`; two → set `key=value`, return value.
output(*ids, format?="raw", query?=None, offset?=None, limit?=None) → str | dict | list[dict]
    Task/agent output by id; one → text/dict, multiple → list.
tool.<name>(args) → unknown
    Invoke any session tool; `args` = its parameter object.
completion(prompt, model?="default", system?=None, schema?=None) → str | dict
    Oneshot, stateless (no history/tools). `model`: "smol" fast | "default" session | "slow" most capable. `schema` (JSON-Schema) → structured output, parsed object.
{{#if spawns}}agent(prompt, agent_type?="task", model?=None, label?=None, schema?=None, return_handle?=False) → str | dict
    Run a subagent → final output. `agent_type`/`agentType` picks another discovered agent; `schema` as in completion(). Background via `local://` files named in the prompt. `return_handle`/`returnHandle` → DAG node dict { text, output, handle: "agent://<id>", id, agent } (parsed under `data` when `schema` set).
{{#if js}}    JS: options are ONE trailing object — agent(prompt, { agentType, schema, returnHandle }).
{{/if}}{{/if}}parallel(thunks) → list
    Thunks through a bounded pool (wide as a `task` batch), input order kept; returns when all finish; a throwing thunk propagates.
pipeline(items, ...stages) → list
    Map items through one-arg stages left-to-right, barrier between stages; stage 1 gets the item, later stages the previous result.
log(message) → None
    Progress line above the status tree.
phase(title) → None
    Phase grouping subsequent status lines.
budget → per-turn token budget
    {{#if py}}`budget.total` (ceiling or None), `budget.spent()`, `budget.remaining()` (math.inf when no ceiling), `budget.hard`.{{/if}}{{#if js}}`await budget.total()` (ceiling or null), `await budget.spent()`, `await budget.remaining()` (Infinity when no ceiling), `await budget.hard()`.{{/if}} Ceiling: `+Nk` (advisory) or `+Nk!`/Goal Mode (hard — `agent()` won't spawn past it); spend still tracked.
```
</prelude>
{{#if spawns}}<dag>
Pipe handles through stage helpers to build a dependency graph — acyclic waves:
- **Name nodes.** Capture each `agent(…, {{#if py}}return_handle=True{{/if}}{{#if js}}{ returnHandle: true }{{/if}})` result; carries `handle` (`agent://<id>`) + `output`.
- **Wire edges by reference.** Put an upstream node's `handle`/`output` in the dependent stage's prompt — large transcripts never re-inlined. Bulk: `write("local://<name>.md", …)`, pass the URI.
- **`pipeline(items, *stages)` = staged waves**, barrier between stages. **`parallel(thunks)` = one wave** of independent nodes.
- **Isolate failure.** A raising node re-raises the lowest-index error, aborts its wave; wrap risky nodes in try/except so a failure degrades only its dependent subtree.
- **Acyclic only.** A node never waits on its own descendant.
</dag>
{{/if}}
