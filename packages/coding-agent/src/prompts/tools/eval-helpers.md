<setup>
Reusable setup: write a script, run `%load <path>` in a standalone `code` cell. Quoted paths and `local://` work; source is not echoed. Definitions persist; edited files require another `%load`.
{{#if py}}Missing Python dependency: `%pip install <distribution>` (e.g. `PIL` comes from `pillow`).{{/if}}
{{#if js}}Missing JS dependency: `%bun add <pkg>` installs into a managed per-project environment; `%environment project` selects project dependencies.{{#unless autoProvision}} Automatic provisioning disabled: use an existing environment or `%environment project`.{{/unless}}{{/if}}
Percent commands are standalone cells. Install preserves kernel state; retry only the failed step.
</setup>
```
budget → {{#if py}}budget.total, budget.spent(), budget.remaining(){{/if}}{{#ifAll py js}}; JS: {{/ifAll}}{{#if js}}await budget.total(), await budget.spent(), await budget.remaining(){{/if}}. Ceiling +Nk advisory; +Nk! hard.
{{#if evalTools}}{{#if py}}@tool / tool(fn, name=None, description=None){{/if}}{{#ifAll py js}}; JS: {{/ifAll}}{{#if js}}tool(fn, { name?, description?, parameters? }){{/if}} → kernel-hosted tool{{#if py}} (schema inferred from type hints){{/if}}. Pass its name in task item `tools`{{#if spawns}}, `agent(tools=…)`, or `workpool(tools=…)`{{/if}}; `tool.defined()`, `tool.undefine(name)`.
{{/if}}```
