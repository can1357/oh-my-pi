Run one step of code in a persistent kernel. State persists across calls and `task` subagents.
{{#if spawns}}Eval `agent()` children use independent kernels.{{/if}}

Work incrementally: imports → define → test → use, each its own cell. Re-run setup ONLY after `reset`, kernel crash.
{{#if spawns}}{{#if eagerDelegation}}Two or more independent items → named `workpool()` + `.push(…)`; poll outside eval with `hub wait` on the pool name. Handles + `wait()` are for dependency-coupled results.{{/if}}{{/if}}

{{#if py}}Top-level `await` works; `asyncio.run(…)` raises error.{{/if}}
{{#if js}}JS runs under **Bun**: globals (`Bun.file`, `Bun.write`, `Bun.$`, `fetch`, `Buffer`) available; top-level `await`/`return` work.{{/if}}

On error, fix and re-run only the failing step.

<prelude>
{{#ifAll py js}}Python: sync, kwargs. JS: async, ONE trailing object literal, never positional.{{else}}{{#if py}}Sync; kwargs.{{/if}}{{#if js}}Async; ONE trailing object literal, never positional.{{/if}}{{/ifAll}}
```
display(value) → None        print(value, ...) → None
read(path, offset?=1, limit?=None) → str
write(path, content) → str
env(key?=None, value?=None) → str | None | dict
output(*ids, format?="raw", query?=None, offset?=None, limit?=None) → str | dict | list[dict]
{{#if js}}await {{/if}}tool.<name>(args) → unknown
    Invoke any session tool; `args` = its parameter object.{{#if py}} Async: `await tool.read({...})`.{{/if}}
completion(prompt, model?="default"|"smol"|"slow", system?=None, schema?=None) → CompletionHandle
    Oneshot, stateless (no history/tools); returns immediately. `.wait()` → str (parsed object with `schema`). `model`: "smol" fast | "default" session | "slow" most capable.
{{#if spawns}}agent(prompt, agent?="{{spawnDefaultAgent}}", label?=None, schema?=None, schema{{#if js}}Mode{{else}}_mode{{/if}}?="permissive", isolated?=None, apply?=None, merge?=None{{#if evalTools}}, tools?=None{{/if}}) → AgentHandle
    Spawns a background subagent and returns immediately. `agent` selects a discovered agent; omit it to use `{{spawnDefaultAgent}}`.{{#if spawnAllowedAgentsText}} Allowed agents: {{spawnAllowedAgentsText}}.{{/if}} Handle: `.id`, `.handle` ("agent://<id>"), `.status`, `.done()`, `.wait(timeout?)` → final text (parsed with `schema`), `.send(message)`, `.cancel()`, `.output()`. Unwaited results auto-deliver like async jobs. `schema` overrides agent/session schemas; `isolated` requests a worktree; `apply`/`merge` control its changes.{{#if evalTools}} `tools`: names of your @tool-defined tools the child may call.{{/if}}
{{#if js}}    JS: ONE trailing object — agent(prompt, { agent, label, schema, schemaMode, isolated, apply, merge{{#if evalTools}}, tools{{/if}} }).{{/if}}
wait(handles, timeout?=None, raise_errors?=True) → list
    Barrier over agent/completion handles, results in input order. `raise_errors=False` keeps the error in its slot.{{#if js}} JS: wait(handles, { timeout, raiseErrors }).{{/if}}
workpool(agent?=None, name?=None, context?=None{{#if evalTools}}, tools?=None{{/if}}) → WorkPool
    {{#if eagerDelegation}}Default for 2+ independent items.{{else}}Keep-alive worker pool for a batch of independent items.{{/if}} `.push(*items)`; `.status()`; `.peek()`; `.close()`. Pool name = async job id; results auto-deliver, or poll outside eval with `hub wait` and `ids:[pool.name]`. `eval.workpool.freshAgents=true` uses a new agent per item.
{{/if}}
{{#if evalTools}}{{#if py}}@tool / tool(fn, name=None, description=None){{/if}}{{#if js}}tool(fn, { name?, description?, parameters? }){{/if}}
    Define a tool that runs in this kernel{{#if py}} (schema inferred from type hints){{/if}}; reference by name in `task` items' `tools`{{#if spawns}}, `agent(tools=…)`, `workpool(tools=…)`{{/if}}. `tool.defined()`, `tool.undefine(name)`.
{{/if}}
log(message) → None         phase(title) → None
budget → {{#if py}}`budget.total` (ceiling or None), `budget.spent()`, `budget.remaining()`{{/if}}{{#if js}}`await budget.total()`, `await budget.spent()`, `await budget.remaining()`{{/if}}; ceiling `+Nk` advisory, `+Nk!` hard.
```
</prelude>
{{#if preludeDocumentation}}

{{{preludeDocumentation}}}
{{/if}}
{{#if spawns}}
<dag>
Acyclic waves of handles:
- **Name nodes.** `h = agent(…)` returns at once; `h.handle` is `agent://<id>`.
- **Wire edges.** Put an upstream `.wait()` result or `.handle` in the downstream prompt. Bulk: `write("local://<name>.md", …)`.
- **`wait(hs)`** = wave barrier. Open-ended item streams → `workpool()`.
- **Isolate failure.** `wait(hs, raise_errors=False)` keeps a failure in its slot; only that subtree degrades.
- **Acyclic only.** No node waits on its own descendant.
</dag>
{{/if}}

<critical>
Prior top-level names survive into the next cell — reuse; NEVER re-import/re-declare. Re-read only if file changed since last read.
</critical>

{{#if autoBackgroundEnabled}}Long-running cells may auto-background by the configured threshold and deliver later; the kernel stays busy until the cell finishes.
`timeout: 0` disables the cell deadline; otherwise `timeout` sets it without extending foreground waiting.{{/if}}
