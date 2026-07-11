{{#if asyncEnabled}}{{#if batchEnabled}}Spawn subagents in the background — one per `tasks[]` item; a single spawn is a one-item batch.{{else}}Spawn ONE subagent in the background per call.{{/if}}

- Non-blocking: returns immediately with the agent id{{#if batchEnabled}}s{{/if}} and job id{{#if batchEnabled}}s{{/if}}; results arrive automatically on yield.
- If blocked on a result, `job poll`. `job cancel` terminates a task and **cannot carry a message** — only for stalled work.
{{else}}{{#if batchEnabled}}Run subagents synchronously — one per `tasks[]` item; a single spawn is a one-item batch.{{else}}Run ONE subagent synchronously per call.{{/if}}

- Blocking: returns when all agent{{#if batchEnabled}}s{{/if}} finish; results inline.
{{/if}}
- Parallelism = {{#if batchEnabled}}multiple `tasks[]` items in ONE call{{else}}multiple `task` calls in one assistant message{{/if}}.
- MUST batch into one {{#if batchEnabled}}`tasks[]` (share `context` once){{else}}message{{/if}}. Separate `task` calls ONLY for a different `agent` type or unrelated `context`.
{{#if ircEnabled}}- Coordinate with agents via `irc` using their ids. Agents reach you and your siblings live the same way.
{{/if}}
<parameters>
- `agent`: agent type to spawn
{{#if batchEnabled}}
- `context`: shared background prepended to every assignment — REQUIRED, session-specific only
  - `assignment`: REQUIRED, complete self-contained instructions; one-liners and missing acceptance criteria are PROHIBITED
  - `id?`: stable agent id, CamelCase, ≤32 chars; auto-generated if omitted
  - `description?`: UI label only — subagent never sees it
  - `role?`: specialist identity (e.g. "Parser edge-case tester") — sets system-prompt persona + display name
  - `model?`: explicit model selector; aliases and concrete catalog names resolve before agent defaults
  - `cwd?`: working directory; defaults to parent session cwd
{{#if isolationEnabled}}
  - `isolated?`: run in isolated env; returns patches. Agent is torn down at completion — not addressable afterwards
{{/if}}
{{else}}
- `assignment`: REQUIRED, complete self-contained instructions; one-liners and missing acceptance criteria are PROHIBITED
- `id?`: stable agent id, CamelCase, ≤32 chars; auto-generated if omitted
- `description?`: UI label only — subagent never sees it
- `role?`: specialist identity (e.g. "Parser edge-case tester") — sets system-prompt persona + display name
- `model?`: explicit model selector; aliases and concrete catalog names resolve before agent defaults
- `cwd?`: working directory; defaults to parent session cwd
{{#if isolationEnabled}}
- `isolated?`: run in isolated env; returns patches. Agent is torn down at completion — not addressable afterwards
{{/if}}
{{/if}}
</parameters>

<rules>
- **Maximize fan-out.** Issue the widest {{#if batchEnabled}}`tasks[]` batch{{else}}set of parallel `task` calls{{/if}}; NEVER serialize work that could run concurrently.
- **Subagents do not verify, lint, or format.** Assignments MUST skip gates, formatters, and project-wide build/test/lint; you run them once at the end across the union of changed files.
- **Tailor every spawn with a `role`.** A role-less generic `task`/`quick_task` is the exception; decompose into named specialists.
- Subagents have no conversation history. Every fact, file path, and direction MUST be explicit in {{#if batchEnabled}}`context` or each `assignment`{{else}}the `assignment`{{/if}}.
- **Shared background** lives in ONE `local://` file referenced by every assignment. Pass large payloads via `local://<path>` URIs, never inline.
- **Read-only agents** (e.g. `explore`) have no edit/write/exec tools. NEVER assign them work that needs changes; do the edits yourself or delegate to a writing agent (`task`, `oracle`, `designer`).
- **No reasoning offload**: NEVER delegate judgment, analysis, design, or decisions to `quick_task` or `explore` — they handle mechanical lookups only. Use `task`, `plan`, or `oracle` for hard thinking.
- **Harness is parent-chosen.** Orchestration assigns each child a simple / standard / full harness from tier, work class, and agent type (`explore` → simple; `quick_task` → standard/bound). Children do not widen tools, skills, or decision scope.
- NEVER slow down or serialize because tasks might overlap on some files — agents resolve collisions in real time.
</rules>

<parallelization>
{{#if ircEnabled}}Can task B run without seeing A's output? If no, sequence A → B — unless B can ask A over `irc` for the missing piece (cheap DM beats a serial waterfall).{{else}}Can task B run without seeing A's output? If no, sequence A → B.{{/if}}
- Sequence when one task produces a contract (types, API, schema, core module) the other consumes wholesale.
- Parallel when tasks touch disjoint files, are independent refactors/tests, or only need occasional peer-to-peer clarification.
{{#if ircEnabled}}- Sequenced follow-ups SHOULD message the agent that produced the prerequisite — it already holds the context.
{{/if}}</parallelization>

{{#if batchEnabled}}
<context-fmt>
# Goal         ← one sentence: what the batch accomplishes
# Constraints  ← MUST/NEVER rules and session decisions
# Contract     ← exact types/signatures if tasks share an interface
</context-fmt>
{{/if}}

<assignment-fmt>
# Target       ← exact files and symbols; explicit non-goals
# Change       ← step-by-step add/remove/rename; APIs and patterns
# Acceptance   ← observable result; no project-wide commands
</assignment-fmt>

<agents>
{{#if spawningDisabled}}Agent spawning is disabled for this context.{{else}}{{#list agents join="\n"}}
# {{name}}{{#if readOnly}} — READ-ONLY (no edit/write/exec tools){{/if}}
{{description}}
{{/list}}{{/if}}
