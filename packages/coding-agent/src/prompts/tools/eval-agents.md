```
{{#if py}}agent(prompt, *, agent?="{{spawnDefaultAgent}}", label?=None, schema?=None, schema_mode?=None, isolated?=None, apply?=None, merge?=None{{#if evalTools}}, tools?=None{{/if}}) → AgentHandle{{else}}await agent(prompt, { agent?, label?, schema?, schemaMode?, isolated?, apply?, merge?{{#if evalTools}}, tools?{{/if}} }) → AgentHandle{{/if}}
    Spawns a background subagent and returns immediately. `agent` selects a discovered agent; omit it to use `{{spawnDefaultAgent}}`.{{#if spawnAllowedAgentsText}} Allowed agents: {{spawnAllowedAgentsText}}.{{/if}} Handle: `.id`, `.handle` ("agent://<id>"), {{#if py}}`.status`{{else}}`.status()`{{/if}}, `.done()`, `.wait(timeout?)` → final text (parsed with `schema`), `.send(message)`, `.cancel()`, `.output()`. Unwaited results auto-deliver like async jobs. `schema` overrides agent/session schemas; `{{#if py}}schema_mode{{else}}schemaMode{{/if}}`: "permissive" warns after retries, "strict" fails; omitted → session setting, else "permissive". `isolated` runs it in a worktree (requires `task.isolation.enabled`). `{{#if py}}apply=False{{else}}apply: false{{/if}}` keeps its changes as patch/branch artifacts instead of applying them; `{{#if py}}merge=False{{else}}merge: false{{/if}}` forces patch mode, otherwise `task.isolation.merge` decides.{{#if evalTools}} `tools`: names of tools you defined with {{#ifAll py js}}`@tool` / `tool(fn)`{{else}}{{#if py}}`@tool`{{else}}`tool(fn)`{{/if}}{{/ifAll}} that the child may call.{{/if}}{{#ifAll py js}}
    Python: call without `await`; `await agent(…)` returns the final result, not a handle (`await h` = `h.wait()`).
    JS: ONE trailing object — `h = await agent(prompt, { agent, label, schema, schemaMode, isolated, apply, merge{{#if evalTools}}, tools{{/if}} })`; without `await agent(…)`, `.id`/`.handle` are undefined. Every handle method returns a Promise; `.status` is `await h.status()`.{{else}}{{#if js}}
    Without `await agent(…)`, `.id`/`.handle` are undefined. Every handle method returns a Promise.{{/if}}{{/ifAll}}
{{#if py}}workpool(agent?=None, *, name?=None, context?=None{{#if evalTools}}, tools?=None{{/if}}) → WorkPool{{else}}await workpool(agent?, { name?, context?{{#if evalTools}}, tools?{{/if}} }) → WorkPool{{/if}}
    {{#if eagerDelegation}}Default for 2+ independent items.{{else}}Keep-alive worker pool for a batch of independent items.{{/if}} {{#if py}}`.push(*items)` (strings) → item ids; `.status()`; `.peek()`; `.close()`.{{else}}`await` each of `.push(...items)` (strings) → item ids, `.status()`, `.peek()`, `.close()`.{{/if}} Pool name = async job id; results auto-deliver. The first full drain closes the pool: push the whole batch while it is active; next wave → new pool.{{#if waitTool}} Completely blocked? Leave `eval` and call the `wait` tool (not kernel `wait()`);{{/if}} NEVER poll.{{#ifAll py js}}
    JS: `pool = await workpool(agent, { name, context{{#if evalTools}}, tools{{/if}} })`; `await` each pool method.{{/ifAll}}
```

The cell `timeout` counts only the cell's own work, not waits on `agent()`/`wait()`/`tool.task(…)`, so a subagent can outlast it.

<dag>
Acyclic waves of handles:
- **Name nodes.** `h = {{#if py}}agent(…)`{{#if js}} (JS: `await agent(…)`){{/if}}{{else}}await agent(…)`{{/if}} returns at once; `h.handle` is `agent://<id>`.
- **Wire edges.** Put an upstream `.wait()` result or `.handle` in the downstream prompt. Bulk: `write("local://<name>.md", …)`.
- **Kernel `{{#if py}}wait(hs)`{{#if js}} (JS: `await wait(hs)`){{/if}}{{else}}await wait(hs)`{{/if}}** = wave barrier. Open-ended item streams → `workpool()`.
- **Isolate failure.** `{{#if py}}wait(hs, raise_errors=False)`{{#if js}} (JS: `await wait(hs, { raiseErrors: false })`){{/if}}{{else}}await wait(hs, { raiseErrors: false })`{{/if}} keeps a failure in its slot; only that subtree degrades.
- **Acyclic only.** Never feed an agent's handle or result back into one of its own upstream agents.
</dag>
