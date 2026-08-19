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
  - `strategyFamily?`: stable identifier for the causal/implementation family (e.g. `persistence`, `concurrency`) — parent tracks portfolio coverage
  - `contextPolicy?`: `shared` (default), `blind` (no favored hypothesis or sibling findings), or `staged` (blind first pass; synthesis reveals later)
  - `revealSiblingFindings?`: with `contextPolicy: staged`, pass `true` on synthesis spawns to include first-pass sibling findings
  - `siblingFindings?`: text summary of sibling worker findings for staged synthesis (required when `revealSiblingFindings` is true)
  - `model?`: explicit model selector; aliases and concrete catalog names resolve before agent defaults
  - `difficulty?`: `low` (bounded/simple), `medium` (normal implementation), `high` (architecture/debugging/review) — routes through fixed `smol`/`task`/`slow` model roles, independent from `agent.tier`; explicit `model` wins when both are set. Fresh spawns only — errors with `fork: true`, which inherits the parent's model
  - `cwd?`: working directory; defaults to parent session cwd
  - `fork?`: inherit the parent's exact context (system prompt, tools, model, and a snapshot of this conversation's history) instead of a fresh one — the provider re-reads the parent's warm prompt cache; agent-specific prompts/tools and output schemas are ignored. Use fresh (default) for independent work
{{#if isolationEnabled}}
  - `isolated?`: run in isolated env; returns patches. Agent is torn down at completion — not addressable afterwards
{{/if}}
{{else}}
- `assignment`: REQUIRED, complete self-contained instructions; one-liners and missing acceptance criteria are PROHIBITED
- `id?`: stable agent id, CamelCase, ≤32 chars; auto-generated if omitted
- `description?`: UI label only — subagent never sees it
- `role?`: specialist identity (e.g. "Parser edge-case tester") — sets system-prompt persona + display name
- `strategyFamily?`: stable identifier for the causal/implementation family (e.g. `persistence`, `concurrency`) — parent tracks portfolio coverage
- `contextPolicy?`: `shared` (default), `blind` (no favored hypothesis or sibling findings), or `staged` (blind first pass; synthesis reveals later)
- `revealSiblingFindings?`: with `contextPolicy: staged`, pass `true` on synthesis spawns to include first-pass sibling findings
- `siblingFindings?`: text summary of sibling worker findings for staged synthesis (required when `revealSiblingFindings` is true)
- `model?`: explicit model selector; aliases and concrete catalog names resolve before agent defaults
- `difficulty?`: `low` (bounded/simple), `medium` (normal implementation), `high` (architecture/debugging/review) — routes through fixed `smol`/`task`/`slow` model roles, independent from `agent.tier`; explicit `model` wins when both are set. Fresh spawns only — errors with `fork: true`, which inherits the parent's model
- `cwd?`: working directory; defaults to parent session cwd
{{#if isolationEnabled}}
- `isolated?`: run in isolated env; returns patches. Agent is torn down at completion — not addressable afterwards
{{/if}}
{{/if}}
</parameters>

<rules>
- **Maximize useful independence, not raw agent count.** For mechanical work, fan out across independent implementation slices. For uncertain or investigative work, assign materially different hypotheses, representations, or attack surfaces; give each strategy family a stable identifier (`strategyFamily`); avoid spawning multiple agents in the same family unless they use a distinct mechanism or one is explicitly adversarial (`falsify`, `audit`).
- **Verification by work class.** Mechanical implementation workers: do not run project-wide gates; MAY run the smallest targeted check required to validate a local assumption; you run shared integration gates once at the end. Exploration and falsification workers: MUST verify every material claim with a concrete read, search, diagnostic, command, reproduction, or counterexample where available. Acceptance auditors: MUST execute or inspect contract-defined checks; NEVER accept the implementer's narrative as verification.
- **Tailor every spawn with a `role`.** A role-less generic `task`/`quick_task` is the exception; decompose into named specialists.
- Subagents have no conversation history. Every fact, file path, and direction MUST be explicit in {{#if batchEnabled}}`context` or each `assignment`{{else}}the `assignment`{{/if}}.
- **Shared background** lives in ONE `local://` file referenced by every assignment. Pass large payloads via `local://<path>` URIs, never inline.
- **Read-only agents** (e.g. `explore`) have no edit/write/exec tools. NEVER assign them work that needs changes; do the edits yourself or delegate to a writing agent (`task`, `oracle`, `designer`).
- **No reasoning offload**: NEVER delegate judgment, analysis, design, or decisions to `quick_task` or `explore` — they handle mechanical lookups only. Use `task`, `plan`, or `oracle` for hard thinking.
- **Harness is parent-chosen.** Orchestration assigns each child a simple / standard / full harness from tier, work class, and agent type (`explore` → simple; `quick_task` → standard/bound). Children do not widen tools, skills, or decision scope.
- Overlap: isolated patches, exclusive owner/path, or named integration owner; else split; disjoint work parallel.
</rules>

<adaptive-portfolio>
For uncertain or investigative work, structure exploration as adaptive rounds rather than a single large batch:
- **Round 1** — Begin with a small diverse portfolio (3–5 strategy families maximum). Assign each family a distinct `strategyFamily` identifier and use `contextPolicy: blind` to preserve independence.
- **Between rounds** — Review which families returned `blocked` or `falsified`. Do not respawn a family with the same blocker; only continue families that produced novel evidence or passed falsification.
- **Stop when** two or more consecutive rounds produce no new unblocked families, or all remaining families share the same blocker fingerprint. Synthesize from the surviving evidence using a `synthesize` agent with `contextPolicy: staged`.
- **Soft cap**: do not exceed 5 initial families unless the problem scope explicitly requires broader coverage.
</adaptive-portfolio>

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
# NonSolutions ← what looks productive but does NOT satisfy the user (optional but recommended for investigative work)
# FailureModes ← concrete classes of false success to reject (optional; e.g. empty input, Windows paths, race)
</assignment-fmt>

<agents>
{{#if spawningDisabled}}Agent spawning is disabled for this context.{{else}}{{#list agents join="\n"}}
# {{name}}{{#if readOnly}} — READ-ONLY (no edit/write/exec tools){{/if}}
{{description}}
{{/list}}{{/if}}
