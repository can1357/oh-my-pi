{{#if asyncEnabled}}{{#if batchEnabled}}Spawn `tasks[]` concurrently; IDs return immediately.{{else}}Spawn one agent; ID returns immediately.{{/if}}{{#if hasBlockingAgents}} BLOCKING agents return inline.{{/if}}{{else}}{{#if batchEnabled}}Run `tasks[]` synchronously.{{else}}Run one agent synchronously.{{/if}}{{/if}}
{{#if asyncEnabled}}

# Results
`outputSchema` parsed payload, even invalid: `agent://<id>` (field `/<field>`, nested `/reports/0/data`); invalid preview inline.
{{/if}}

# Delegation
Use most specific agent.{{#if scoutAvailable}} Read-only research MUST use `scout` only when files unknown.{{/if}} Prefer one agent to investigate + edit. Omit `agent` only for default (`{{defaultAgent}}`); NEVER specify it.
Shared edits need one integration owner{{#if ircEnabled}}; siblings coordinate via `write agent://<id>`{{/if}}. Set interfaces in {{#if batchEnabled}}`context`{{else}}the task{{/if}}. Every task MUST skip build/lint/tests/formatters mid-flight; run once afterward.

# Inputs
`name`: CamelCase ≤32, auto-generated if omitted; address agent by name. `outputSchema` overrides agent/session schemas.
`model`: optional selector or ordered candidate list per spawn (batch: per item). Candidates are tried in order; if none is usable, dispatch fails without fallback outside the list.
{{#if evalToolsEnabled}}`tools`: eval-defined, run in your kernel.
{{/if}}{{#if effortEnabled}}`effort`: `"lo"`|`"med"`|`"hi"` by complexity.
{{/if}}`schemaMode`: default permissive warns after retries; strict fails.
{{#if isolationEnabled}}{{#if applyIsolatedChanges}}`isolated`: worktree; successful changes apply to parent.
{{else}}`isolated`: worktree; changes retained, not applied.
{{/if}}{{/if}}Children start blank;{{#if ircEnabled}} parent IRC steers immediately;{{/if}} large payloads via `local://<path>`, NEVER inline.

# Format
{{#if batchEnabled}}`context`: shared (`# Goal`, `# Constraints`, `# Contract` interfaces); NEVER repeat per task.
{{/if}}`task`: self-contained (`# Target` files/non-goals, `# Change` steps/APIs, `# Acceptance` observable result).

# Available Agents
{{#if spawningDisabled}}Agent spawning is currently disabled.
{{else}}{{#if hasModelMentions}}`m<N>` = user-tagged model (`<model agent="m<N>" name="…"/>`), not specialist; spawn only when user names it.
{{/if}}{{#list agents join=""}}- `{{name}}`{{#if readOnly}} (READ-ONLY; investigation only, no edits){{/if}}{{#if blocking}} (BLOCKING; inline result){{/if}}: {{description}}
{{/list}}{{/if}}
