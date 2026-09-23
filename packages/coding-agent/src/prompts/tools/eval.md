Run one step of code in a persistent kernel. State persists across calls and `task` subagents.
{{#if spawns}}Eval `agent()` children use independent kernels.{{/if}}

Work incrementally: imports → define → test → use, each its own cell. Re-run setup ONLY after `reset`, kernel crash.
{{#if spawns}}{{#if eagerDelegation}}Two or more independent items → named `workpool()` + `.push(…)`; poll outside eval with `hub wait` on the pool name. Handles + `wait()` are for dependency-coupled results.{{/if}}{{/if}}

{{#if py}}Top-level `await` works; `asyncio.run(…)` raises error.{{/if}}
{{#if js}}JS runs under **Bun**: globals (`Bun.file`, `Bun.write`, `Bun.$`, `fetch`, `Buffer`) available; top-level `await`/`return` work.{{/if}}

On error, fix and re-run only the failing step. Earlier statements may already have produced side effects.

<instruction>
- Reusable setup → write a script once, then use `{{#if py}}%load ./setup.py{{else}}%load ./setup.ts{{/if}}` as `code`. Definitions persist; source is not echoed. Quote paths containing spaces; `local://` works.
- `%load` executes again only when explicitly called. Editing a file alone does not reload it.
{{#if py}}- Missing Python dependency → identify its distribution, then use `%pip install pillow` as `code`; it installs into the kernel's interpreter. Import names can differ (`PIL` → `pillow`); do not install an exception's name blindly.{{/if}}
{{#if js}}- Missing JS dependency → use `%bun add csv-parse` as `code`.{{/if}}
- Percent commands are standalone cells. After installation, retry only the failed import/step—not earlier side effects.
{{#if js}}- JS packages go to a managed environment reused across sessions in the same project; kernel variables remain separate. Rare explicit target change → `%environment project` (permits project dependency changes) or `%environment managed`.{{#unless autoProvision}} Automatic environment provisioning is disabled: use an existing environment or `%environment project`.{{/unless}}{{/if}}
- Package installation preserves kernel state. A kernel-loss notice means setup must be loaded again. Compaction alone does not reset a live kernel.
</instruction>

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
await judge(state, questions) → `{id: answer}`
    Typed judgment over one `state` (str | JSON object | JSON array). Every question sees the same state and is answered independently: batch independent questions into one call. Cheap and fast (TypeSafe when credentialed, else the tiny/smol chat model); prefer over `completion()` for classification, yes/no, ranking. Two or more states → `{{#if py}}judge_batch{{else}}judgeBatch{{/if}}`, never a loop of `judge()`.
    `questions`: `{id: q}` where q is one of
      `{type: "choice", instructions, criteria: {label: rubric | None, …}}` → `{choice, probabilities: {label: p}, confidence}` (≥2 labels)
      `{type: "bool", instructions, criteria?: {true?: str, false?: str}}` → `{bool: P(yes)}`
      `{type: "score", instructions, criteria: [lowest, …, highest]}` → `{score, probabilities: {"0": p, …}, confidence}` (≥2 levels; score is the probability-weighted level index)
{{#if py}}judge_batch(states, questions, concurrency?=32, retries?=1, min_ok?=1, intent?=None) → JudgmentBatch{{else}}judgeBatch(states, questions, { intent?, concurrency?, retries?, minOk? }) → JudgmentBatch{{/if}}
    Same `questions` over every state (`{key: state}` or a list keyed by index), run and owned by the host — it outlives the cell. `intent` is an optional nonempty progress/job label (default `"Judging"`). Returns at once; pull settled items in bounded slices across cells: `await b.drain(timeout?)` → `[(key, item)]` settled since the last drain (`[]` on timeout; `item.answers` on success, else `item.error`, never raised); `{{#if py}}async for k, item in b.drain_iter(timeout){{else}}for await (const [k, item] of b.drainIter({ timeout })){{/if}}` until timeout or completion; `b.status()` → `{intent, done, total, failed, cost, running, model}`; `b.results()` → `{key: answers}` so far; `b.failed()` → `{key: error}`; `b.cancel()`; `b.close()` releases it. `drain()` raises only when the run died wholesale (no judge, or fewer than `min_ok` answered). `b.id` is an async job id: completion auto-delivers a summary, `hub wait ids:[b.id]` works, `{{#if py}}judge_batch{{else}}judgeBatch{{/if}}.attach(id)` re-creates the ref after a reset.
{{#if spawns}}agent(prompt, agent?="{{spawnDefaultAgent}}", label?=None, schema?=None, schema{{#if js}}Mode{{else}}_mode{{/if}}?="permissive", isolated?=None, apply?=None, merge?=None{{#if evalTools}}, tools?=None{{/if}}) → AgentHandle
    Spawns a background subagent and returns immediately. `agent` selects a discovered agent; omit it to use `{{spawnDefaultAgent}}`.{{#if spawnAllowedAgentsText}} Allowed agents: {{spawnAllowedAgentsText}}.{{/if}} Handle: `.id`, `.handle` ("agent://<id>"), `.status`, `.done()`, `.wait(timeout?)` → final text (parsed with `schema`), `.send(message)`, `.cancel()`, `.output()`. Unwaited results auto-deliver like async jobs. `schema` overrides agent/session schemas; `isolated` requests a worktree; `apply`/`merge` control its changes.{{#if evalTools}} `tools`: names of your @tool-defined tools the child may call.{{/if}}
{{#if js}}    JS: ONE trailing object — agent(prompt, { agent, label, schema, schemaMode, isolated, apply, merge{{#if evalTools}}, tools{{/if}} }).{{/if}}
workpool(agent?=None, name?=None, context?=None{{#if evalTools}}, tools?=None{{/if}}, units?=False, attempts?=2) → WorkPool
    {{#if eagerDelegation}}Default for 2+ independent items.{{else}}Keep-alive worker pool for a batch of independent items.{{/if}} `.push(*items)`; `.status()`; `.peek()`; `.close()`. Pool name = async job id; results auto-deliver, or poll outside eval with `hub wait` and `ids:[pool.name]`. `eval.workpool.freshAgents=true` uses a new agent per item. `units=True`: each item yields `data` as `{ status: "done"|"unresolved", value, evidence: string[], verification?: { status: "passed"|"failed"|"not_run", commands?, details? }, reason? }`; units left unresolved, malformed, missing, or failing reported verification are retried alone up to `attempts` total, and the pool result is a per-unit ledger (`.peek()["units"]`).
{{/if}}
wait(handles, timeout?=None, raise_errors?=True) → list
    Barrier over agent/completion handles, results in input order. `raise_errors=False` keeps the error in its slot.{{#if js}} JS: wait(handles, { timeout, raiseErrors }).{{/if}}
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
Prior top-level names survive into the next cell — reuse; NEVER repeat successful setup. After installing a missing dependency, retry its failed import, not the whole failed cell. Re-read only if file changed since last read.
</critical>

{{#if autoBackgroundEnabled}}Long-running cells may auto-background by the configured threshold and deliver later; the kernel stays busy until the cell finishes.
`timeout: 0` disables the cell deadline; otherwise `timeout` sets it without extending foreground waiting.{{/if}}
