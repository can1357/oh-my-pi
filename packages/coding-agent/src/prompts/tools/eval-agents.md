```
agent(prompt, agent?="{{spawnDefaultAgent}}", label?=None, schema?=None, schema{{#if js}}Mode{{else}}_mode{{/if}}?="permissive", isolated?=None, apply?=None, merge?=None{{#if evalTools}}, tools?=None{{/if}}{{#if perCallModel}}, model?=None{{/if}}) → AgentHandle
    Spawns a background subagent and returns immediately. `agent` selects a discovered agent; omit it to use `{{spawnDefaultAgent}}`.{{#if spawnAllowedAgentsText}} Allowed agents: {{spawnAllowedAgentsText}}.{{/if}} Handle: `.id`, `.handle` ("agent://<id>"), `.status`, `.done()`, `.wait(timeout?)` → final text (parsed with `schema`), `.send(message)`, `.cancel()`, `.output()`. Unwaited results auto-deliver like async jobs.{{#if perCallModel}} `model`: one exact `provider/model[:level]` or configured `@role[:level]` for this call only, or an ordered list of them (first available wins); only operator-approved models, with no globs or partial IDs. An agent's `task.agentModelOverrides` entry conflicts with it. Unavailable → stop and report, NEVER substitute. {{#if perCallModelFallbacks}}A failing request may fall back only to later candidates or operator-configured fallback models.{{else}}No runtime model fallback.{{/if}}{{/if}} `schema` overrides agent/session schemas; `isolated` requests a worktree; `apply`/`merge` control its changes.{{#if evalTools}} `tools`: names of your @tool-defined tools the child may call.{{/if}}
{{#if js}}    JS: ONE trailing object — agent(prompt, { agent, label, schema, schemaMode, isolated, apply, merge{{#if evalTools}}, tools{{/if}}{{#if perCallModel}}, model{{/if}} }).{{/if}}
workpool(agent?=None, name?=None, context?=None{{#if evalTools}}, tools?=None{{/if}}{{#if perCallModel}}, model?=None{{/if}}) → WorkPool
    {{#if eagerDelegation}}Default for 2+ independent items.{{else}}Keep-alive worker pool for a batch of independent items.{{/if}} `.push(*items)`; `.status()`; `.peek()`; `.close()`. Pool name = async job id; results auto-deliver.{{#if waitTool}} Completely blocked? Leave `eval` and call `wait`;{{/if}} NEVER poll.{{#if perCallModel}} `model` selects each worker on its first turn; follow-ups reuse that session.{{/if}} `eval.workpool.freshAgents=true` uses a new agent per item.
```

The cell `timeout` counts only the cell's own work, not waits on `agent()`/`wait()`/`tool.task(...)`, so a subagent can outlast it.

<dag>
Acyclic waves of handles:
- **Name nodes.** `h = agent(…)` returns at once; `h.handle` is `agent://<id>`.
- **Wire edges.** Put an upstream `.wait()` result or `.handle` in the downstream prompt. Bulk: `write("local://<name>.md", …)`.
- **`wait(hs)`** = wave barrier. Open-ended item streams → `workpool()`.
- **Isolate failure.** `wait(hs, raise_errors=False)` keeps a failure in its slot; only that subtree degrades.
- **Acyclic only.** No node waits on its own descendant.
</dag>
