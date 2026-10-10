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
`solutionSpace`: describe how open-ended the child's problem is: whether the fix or design is given, or which causes or designs remain open. Volume of work does not widen it; NEVER mention sibling agents or coordination. (`one fix: rename, names given`; `one fix: slice end in paginate`; `single-flight cache load; races easy to miss`; `several retry API shapes; error classes to choose`; `deadlock cause open, no repro`)
{{#if evalToolsEnabled}}`tools`: eval-defined, run in your kernel.
{{/if}}{{#if effortEnabled}}`effort`: `"lo"`|`"med"`|`"hi"` runtime hint by problem openness; fixed model suffix wins.
{{/if}}`model`: `provider/model[:level]`, configured `@role[:level]`, `@default[:level]`, or ordered non-empty array{{#if batchEnabled}}; set per `tasks[]` item, NEVER on the batch container{{/if}}. Omit to retain ordinary configured agent routing, authentication fallback, and retries.
`schemaMode`: default permissive warns after retries; strict fails.
{{#if isolationEnabled}}{{#if applyIsolatedChanges}}`isolated`: worktree; successful changes apply to parent.
{{else}}`isolated`: worktree; changes retained, not applied.
{{/if}}{{/if}}Children start blank;{{#if ircEnabled}} parent IRC steers immediately;{{/if}} large payloads via `local://<path>`, NEVER inline.

# Format
{{#if batchEnabled}}`context`: shared (`# Goal`, `# Contract` interfaces); NEVER repeat per task.
{{/if}}`task`: self-contained (`# Target` files/non-goals, `# Change` steps/APIs, `# Acceptance` observable result).

# Model routing
- `agent` selects semantic instructions/tools; `model` selects routing independently; effort is distinct.
- Omitted `model` follows existing agent policy, including coarse effort/AUTO, authentication fallback, configured retries, and prewalk. It is not an explicit pin; do not synthesize a selector just to copy that routing.
- Supplied `model` overrides exact `task.agentModelOverrides[agentName]` and agent frontmatter, and bypasses automatic classification, not permissions. Concrete selections MUST be authorized by actual operator roles/fallbacks, selected-agent frontmatter/exact override, or the actual live parent. Availability, auth, enabled/catalog membership, and recommendations NEVER grant explicit permission.
- Actual custom configured chat roles support `@role:high`; no automatic-classifier roster allowlist.
- `@default` = exact live parent + actual effort, not `modelRoles.default` or a parent-role fallback chain. `@default:high` overrides effort only. NEVER use `@inherit`, bare `default`/`inherit` (also suffixed), unknown roles, empty selections, or invalid suffixes.
- Role aliases retain identity and may use approved configured fallbacks; disclose that behavior. Ordered arrays stay inside the requested candidate closure; raw literals NEVER gain unrelated role/default/auth chains. Exact approved `provider/model:high` pins the model.
- Requested fixed suffix outranks agent default/coarse `effort`; unsupported effort fails, NEVER clamp or discard it. Unqualified routes permit runtime effort selection; configured `auto` remains `auto`.
- Requested selection fails? Stop and report; NEVER drop `model` or substitute another source. Hooks may narrow, NEVER enlarge, the approved closure; retry/revival revalidate current permission within it.
- Project recommendations NEVER grant routing authority.

# Available Agents
{{#if spawningDisabled}}Agent spawning is currently disabled.
{{else}}{{#if hasModelMentions}}`m<N>` = user-tagged model (`<model agent="m<N>" name="…"/>`), not specialist; spawn only when user names it.
{{/if}}{{#list agents join=""}}- `{{name}}`{{#if readOnly}} (READ-ONLY; investigation only, no edits){{/if}}{{#if blocking}} (BLOCKING; inline result){{/if}}: {{description}}
{{/list}}{{/if}}
