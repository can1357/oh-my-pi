```
agent(prompt, agent?="{{spawnDefaultAgent}}", label?=None, schema?=None, schema{{#if js}}Mode{{else}}_mode{{/if}}?="permissive", isolated?=None, apply?=None, merge?=None{{#if evalTools}}, tools?=None{{/if}}, model?=None) → AgentHandle
    Spawns a background subagent and returns immediately. `agent` selects a discovered agent's instructions/tools; omit it to use `{{spawnDefaultAgent}}`.{{#if spawnAllowedAgentsText}} Allowed agents: {{spawnAllowedAgentsText}}.{{/if}} Handle: `.id`, `.handle` ("agent://<id>"), `.status`, `.done()`, `.wait(timeout?)` → final text (parsed with `schema`), `.send(message)`, `.cancel()`, `.output()`. Unwaited results auto-deliver like async jobs. `schema` overrides agent/session schemas; `isolated` requests a worktree; `apply`/`merge` control its changes.{{#if evalTools}} `tools`: names of your @tool-defined tools the child may call.{{/if}}
{{#if js}}    JS: ONE trailing object — agent(prompt, { agent, label, schema, schemaMode, isolated, apply, merge{{#if evalTools}}, tools{{/if}}, model }).{{/if}}
workpool(agent?=None, name?=None, context?=None{{#if evalTools}}, tools?=None{{/if}}, model?=None) → WorkPool
    {{#if eagerDelegation}}Default for 2+ independent items.{{else}}Keep-alive worker pool for a batch of independent items.{{/if}} `.push(*items)`; `.status()`; `.peek()`; `.close()`. Pool name = async job id; results auto-deliver.{{#if waitTool}} Completely blocked? Leave `eval` and call `wait`;{{/if}} NEVER poll. `model` applies at worker creation; follow-ups retain that worker's model/effort contract, NEVER per-item rerouting. `eval.workpool.freshAgents=true` uses a new agent per item.
```

# Model routing
- `model`: raw `provider/model[:level]`, configured `@role[:level]`, `@default[:level]`, or ordered non-empty array. `agent` = semantic instructions/tools; `model` = independent routing; effort is distinct.
- Concrete models MUST be authorized by actual operator roles/fallbacks, selected-agent frontmatter/exact override, or actual live parent. Availability, auth, enabled/catalog membership, and recommendations NEVER grant permission.
- Request → exact `task.agentModelOverrides[agentName]` → agent model → live parent, within approved routes. Actual custom configured chat roles support `@role:high`; no automatic-classifier roster allowlist.
- `@default` = exact live parent + actual effort, not `modelRoles.default` or a parent-role fallback chain. `@default:high` changes effort only. NEVER use `@inherit`, bare `default`/`inherit` (also suffixed), unknown roles, empty selections, or invalid suffixes.
- Role aliases retain identity and may use approved configured fallbacks; disclose that behavior. Arrays stay inside requested candidate closure; raw literals NEVER gain unrelated role/default/auth chains. Exact approved `provider/model:high` pins the model.
- Requested fixed suffix outranks agent default/task coarse `effort`; unsupported effort fails, NEVER clamp or discard it. Unqualified routes permit runtime effort selection; configured `auto` remains `auto`.
- Requested selection fails? Stop and report; NEVER drop `model` or substitute another source. Hooks may narrow, NEVER enlarge, the approved closure; retry/revival revalidate current permission within it.
- Project recommendations NEVER grant routing authority.

<dag>
Acyclic waves of handles:
- **Name nodes.** `h = agent(…)` returns at once; `h.handle` is `agent://<id>`.
- **Wire edges.** Put an upstream `.wait()` result or `.handle` in the downstream prompt. Bulk: `write("local://<name>.md", …)`.
- **`wait(hs)`** = wave barrier. Open-ended item streams → `workpool()`.
- **Isolate failure.** `wait(hs, raise_errors=False)` keeps a failure in its slot; only that subtree degrades.
- **Acyclic only.** No node waits on its own descendant.
</dag>
