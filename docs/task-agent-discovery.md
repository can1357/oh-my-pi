# Task Agent Discovery and Selection

This document describes how the task subsystem discovers agent definitions, merges multiple sources, and resolves a requested agent at execution time.

It covers runtime behavior as implemented today, including precedence, invalid-definition handling, and spawn/depth constraints that can make an agent effectively unavailable.

## Implementation files

- [`src/task/discovery.ts`](../packages/coding-agent/src/task/discovery.ts)
- [`src/task/agents.ts`](../packages/coding-agent/src/task/agents.ts)
- [`src/task/types.ts`](../packages/coding-agent/src/task/types.ts)
- [`src/task/index.ts`](../packages/coding-agent/src/task/index.ts)
- [`src/task/structured-subagent.ts`](../packages/coding-agent/src/task/structured-subagent.ts)
- [`src/task/spawn-policy.ts`](../packages/coding-agent/src/task/spawn-policy.ts)
- [`src/task/commands.ts`](../packages/coding-agent/src/task/commands.ts)
- [`src/prompts/agents/task.md`](../packages/coding-agent/src/prompts/agents/task.md)
- [`src/prompts/tools/task.md`](../packages/coding-agent/src/prompts/tools/task.md)
- [`src/discovery/helpers.ts`](../packages/coding-agent/src/discovery/helpers.ts)
- [`src/discovery/omp-extension-roots.ts`](../packages/coding-agent/src/discovery/omp-extension-roots.ts)
- [`src/config.ts`](../packages/coding-agent/src/config.ts)
- [`src/task/executor.ts`](../packages/coding-agent/src/task/executor.ts)

---

## Agent definition shape

Task agents normalize into `AgentDefinition` (`src/task/types.ts`):

- required `name`, `description`, and `systemPrompt`
- optional `tools`, `spawns`, prioritized `model` list, `thinkingLevel`, `output`, `blocking`, `structured`, `autoloadSkills`, `readSummarize`, `prewalk`, `advisor`
- `source`: `"bundled" | "user" | "project"` (extension agents are tagged with their extension root's project/user level)
- optional `filePath`

Parsing comes from frontmatter via `parseAgentFields()` (`src/discovery/helpers.ts`):

- missing/non-string `name` or `description` => invalid (`null`), caller treats as parse failure
- `main` and `sub` are reserved names (checked after trimming and lowercasing); definitions using them are invalid
- `tools` accepts CSV or array; legacy tool aliases are normalized and mixed arrays retain their string entries. Omitted or YAML-null `tools` selects the default built-in toolset. Any other declaration with no tool names (including `tools: []`, empty CSV, or malformed scalar/array values) selects no built-ins. Structured children still receive the required `yield` tool; MCP, extension, and custom tools remain additive.
- `spawns` accepts `*`, CSV, or array
- backward-compat behavior: if `spawns` missing but `tools` includes `task`, `spawns` becomes `*`
- `output` is passed through as opaque schema data
- `read-summarize: false` (normalized to `readSummarize`) disables structural summaries for the subagent's `read` tool — `runSubprocess` applies a `read.summarize.enabled: false` override on the child's isolated settings (`src/task/executor.ts`). `scout` ships with it disabled. When absent, the child inherits the parent's read-summary setting.
- `model` accepts one selector, CSV, or an array. Entries are tried in order after role aliases are expanded.
- `thinking-level` / `thinking` selects the agent's configured effort. When `task.enableEffort` (default `false`) exposes it, a task item's coarse `effort` (`lo`, `med`, `hi`) takes precedence at launch. OMP maps that hint to the selected model's lowest, middle, or highest supported effort, then clamps it to `task.maxEffort` (default `max`). The ceiling is carried across retry-fallback model switches. If the selected model has no supported effort at or below the ceiling, the spawn fails; models without a controllable effort surface instead fall back to their normal selector.
- `blocking: true` makes the parent wait for that agent even when async task execution is enabled
- `structured: true` keeps structured results for that agent while `task.structured` (default `false`) is off: its task spawns get the `yield` tool and resolve their output schema exactly as with `task.structured: true` (see [structured-output precedence](#model-and-structured-output-precedence)). With `task.structured` on, the field changes nothing; `false` or absent follows the setting. The caller-side `outputSchema`/`schemaMode` task parameters stay hidden while the setting is off. The decision is made from the resolved agent in `resolveEffectiveSubagentPolicy()`, so plan-mode spawns keep it, and cold revival restores `yield` from the child's persisted tool list.
- `autoloadSkills` names skills from the parent session to inject before the first child prompt; unknown names are ignored
- `prewalk: true` starts the subagent on its resolved model and hands off to the default prewalk target (the `smol` role) at its first edit/write, exactly like the session-level `--prewalk`; a string value (e.g. `prewalk: "@smol"` or `prewalk: "openai/gpt-5-mini"`) picks a custom target. The `task.agentPrewalk` settings record (agent name → `"on"` / `"off"` / pattern, configured per agent from the `/agents` hub via its prewalk strip) overrides the frontmatter. Resolution happens in `runSubprocess` (`src/task/executor.ts`). An unavailable target is skipped instead of failing the spawn. A resolved target is skipped only when both its model identity and its effective thinking mode/level match the starting selection after model clamping; a same-model effort downgrade is a real hand-off and still arms and switches at the first edit/write.
- `advisor: true` pairs spawned sessions of the agent with an advisor running the model resolved for the `advisor` role; a string value (e.g. `advisor: "deepseek/deepseek-v4-flash"` or `advisor: "@smol:high"`) sets an explicit advisor model pattern (optional `:level` suffix), applied as the spawned session's `modelRoles.advisor`. The `task.agentAdvisor` settings record (agent name → `"on"` / `"off"` / pattern, configured per agent from the `/agents` hub via its advisor strip) overrides the frontmatter. Resolution happens in `runSubprocess` (`src/task/executor.ts`); subagents default to no advisor, and the effective opt-in is persisted in `session_init` so cold revival restores it.

## Role-backed custom agents

OMP discovers user agents from `~/.omp/agent/agents/*.md` and project agents from `.omp/agents/*.md`.

Give the agent a role alias in frontmatter, then dispatch it by name. For model routing, task dispatch sets only `agent`; it does not set a worker model:

`~/.omp/agent/agents/reviewer.md`:

```md
---
name: reviewer
description: Review a change for correctness.
model: "@review"
---

Review the assigned change and report concrete findings.
```

Set the role mapping in `~/.omp/agent/config.yml`:

```yaml
modelRoles:
   review: openai/gpt-5.4:high
```

`@review` resolves through `modelRoles.review`. Each `modelRoles.<role>` value stores a concrete model selector and may append a thinking suffix such as `:high` (`src/config/model-resolver.ts`). Changing that mapping affects subsequent task resolutions without editing agent definitions. Task/eval preflight reloads the current global, project, and explicit overlay settings before rediscovering agents, so agent files and their role aliases added during a live session resolve from one refreshed configuration state.

With the default batched task schema, supply shared `context` and per-item `task` and `solutionSpace`. `solutionSpace` describes how open-ended the assignment is, rather than its size. Set `agent` only when choosing a non-default agent:

```json
{
	"context": "Review the current change in this repository.",
	"tasks": [
		{
			"agent": "reviewer",
			"task": "Report concrete correctness findings.",
			"solutionSpace": "Review cause and failure modes are open; no known defect."
		}
	]
}
```

`/model`'s Roles view can assign and persist custom role mappings such as `review`, `fast`, and `good`. Changing only the active or default session selection does not remap those roles.

## User-tagged model agents

Type `^` in the composer to choose a model from the same scope and ranking as the `Alt+P` session picker. Accepting a completion inserts an atomic chip showing its display name. For example, type `Have ^`, pick a model, then finish with `review this change`.

On submit, each first-mentioned model receives a branch-local pseudonym (`m1`, `m2`, …). The user message carries `<model agent="m1" name="Display Name"/>`; the task description lists its provider/model selector. `task`, eval `agent()`, and `workpool()` accept that pseudonym as their `agent`. These agents use the bundled general-purpose task template, not a specialist template, and are intended only for requests explicitly naming the tagged model.

Tagging a model never rewrites the model-facing `task` description mid-session: the description lists the pseudonyms baked into the current base prompt, and later tags arrive as a hidden `session-agents` system notice on the next user turn. The notice rides the same channel as the eval-prelude and tool-roster deltas, so the provider cache prefix stays byte-stable. The next base-prompt rebuild absorbs the live set into the description.

Pseudonyms survive `/resume`; rewinding before a model's first mention frees its number. Repeating a selector reuses its pseudonym. Unknown selectors remain literal, as do mentions in `!`/`$` local-execution drafts. Tokens require whitespace boundaries: autocomplete adds the trailing space. When two models share a display name in one draft, the second remains a literal selector to avoid ambiguous expansion.

Session definitions are appended after discovered agents, so an existing agent with the same name wins. Normal spawn restrictions and model-override precedence still apply. Synthetic prompts cannot register models.

## Watch running agents

After dispatch, press `Alt+A` to open [Agent Hub](./agent-hub.md). Its live roster shows each task agent's status, current activity, model, age, and usage. Select an agent to read its transcript and steer it directly; parked agents can be revived from the same view. Enable `tui.mouse` to click live task cards and jump-list rows instead, or watch the pinned `Subagents` block above the editor.

### `vibe_spawn` tier routing

`vibe_spawn` maps `fast` to bundled `sonic` and `good` to bundled `task`. Both resolve through `task.agentModelOverrides` before their bundled agent model defaults (`src/vibe/runtime.ts`, `src/task/agents.ts`).

Route these tiers through roles by keeping aliases in `task.agentModelOverrides` and concrete selectors only in `modelRoles`:

```yaml
task:
   agentModelOverrides:
      sonic: "@fast_worker"
      task: "@good_worker"
modelRoles:
   fast_worker: openai/gpt-5-mini
   good_worker: openai/gpt-5.4:high
```

The `vibe_spawn` `cli` remains `fast` or `good`; update `modelRoles` to change the worker model.

## Bundled agents

Bundled agents are embedded at build time (`src/task/agents.ts`) using text imports.

`EMBEDDED_AGENT_DEFS` defines:

- `scout`, `reviewer`, and `security-reviewer` from prompt files
- `task` and `sonic` from the shared `task.md` body plus injected frontmatter; no bundled agent sets `prewalk` — the generic `task` agent's hand-off is armed by the `task.prewalk` setting (default off), or per agent via `/agents` / `task.agentPrewalk` / user agent frontmatter

Loading path:

1. `loadBundledAgents()` parses embedded markdown with `parseAgent(..., "bundled", "fatal")`
2. results are cached in-memory (`bundledAgentsCache`)
3. `clearBundledAgentsCache()` is test-only cache reset

Because bundled parsing uses `level: "fatal"`, unrecoverable YAML errors or invalid required fields throw and can fail discovery entirely.

## Filesystem and plugin discovery

`discoverAgents(cwd, home, extensionRoots?)` (`src/task/discovery.ts`) merges agents from OMP-native roots, OMP extension packages, and Claude marketplace plugin roots before appending bundled definitions. Direct cross-harness roots such as `.claude/agents`, `.codex/agents`, and `.gemini/agents` are intentionally skipped — their frontmatter schema is not the OMP task-agent contract (`TASK_AGENT_CONFIG_SOURCE = ".omp"` filters the native config-dir lists).

### Discovery inputs and precedence

1. Nearest project `.omp/agents` dir from `findAllNearestProjectConfigDirs("agents", cwd)` (first `.omp` hit only)
2. User `.omp/agents` dir from `getConfigDirs("agents", { project: false })` (first `.omp` hit only)
3. `<extension-root>/agents` for every enabled OMP extension package returned by `listOmpExtensionRoots(...)`, in this order:
   - explicit CLI `--extension` / SDK `additionalExtensionPaths` directory roots
   - the session's effective `extensions:` array, in its configured order
   - installed npm/link plugins
     Project and user `extensions:` arrays are not concatenated: settings use array-replacement precedence. Session overlays/runtime overrides and the configured array's project/user provenance are preserved. In `explicit-only` mode (`--no-extensions` or SDK `disableExtensionDiscovery`), only explicit roots contribute this package surface; file entrypoints have no `agents/` subdirectory to scan.
4. Claude marketplace plugin roots (`listClaudePluginRoots(home, cwd)`) with `agents/` subdirs — only when `isProviderEnabled("claude-plugins")`; project-scope plugins sort before user-scope. User-scope roots additionally require the `claude-plugins` or `claude` user source to be enabled (`isUserSourceEnabled`: normally via `enabledProviders`, e.g. `["claude-plugins"]`; `claude` is also enabled implicitly when `CLAUDE_CONFIG_DIR` is set), except roots whose origin is not the foreign `~/.claude/plugins` tree (omp's own installs with `origin: "omp"` and `--plugin-dir` roots) — mirroring the skills path's exemption.
5. Bundled agents (`loadBundledAgents()`)

The OMP extension-package surface is disabled when the `omp-plugins` capability provider is disabled. Marketplace roots are excluded from `listOmpExtensionRoots` and enter only through the separately gated Claude-plugin path.

Claude-dialect plugin agents discard their frontmatter `model` so Claude aliases are not misread as OMP selectors. This applies to foreign Claude roots and packages whose manifest declares the Claude format, including OMP installs or `--plugin-dir` roots. OMP-native and Agent-Plugins-standard packages retain their model selectors.

## Merge and collision rules

Discovery uses first-wins dedup by exact `agent.name`:

- A `Set<string>` tracks seen names.
- Loaded agents are flattened in directory order and kept only if name unseen.
- Bundled agents are filtered against the same set and only added if still unseen.

Implications:

- Project `.omp` overrides user `.omp`.
- Earlier extension roots override later extension roots, Claude marketplace plugins, and bundled agents.
- Non-bundled agents override bundled agents with the same name.
- Name matching is case-sensitive (`Task` and `task` are distinct).
- Within one directory, markdown files are read in lexicographic filename order before dedup.

## Invalid/missing agent file behavior

Per directory (`loadAgentsFromDir`):

- unreadable/missing directory: treated as empty (`readdir(...).catch(() => [])`)
- file read or parse failure: warning logged, file skipped
- parse path uses `parseAgent(..., level: "warn")`

Frontmatter failure behavior comes from `parseFrontmatter`:

- the default lenient parser normalizes line endings and kebab-case keys, replaces tabs in YAML, and can repair ambiguous plain scalars before reporting failure
- an unrecovered parse error at `warn` level logs a warning, then falls back to top-level `key: value` lines
- fallback values are individually parsed as YAML when possible, preserving scalar/array types
- if required fields remain invalid, `parseAgentFields` fails, then `AgentParsingError` is thrown and caught by the directory loader (file skipped)

Net effect: one bad custom agent file does not abort discovery of other files.

## Agent lookup and selection

Lookup is exact-name linear search:

- `getAgent(agents, name)` => `agents.find(a => a.name === name)`
- unrestricted sessions default an omitted `agent` field to `task`
- a restricted parent `spawns` list defaults an omitted `agent` field to the first listed agent

`resolveEffectiveSubagentPolicy()` is shared by task and eval-backed subagent launches. Before allocating artifacts it:

1. atomically reloads the live session's persisted global, project, and explicit overlay settings while preserving runtime overrides
2. resolves the omitted or explicit agent name from the parent spawn policy
3. enforces depth, blocked-self-recursion, and parent spawn-policy guards
4. rediscovers agents with the session's cwd and effective extension-root configuration, appends user-tagged session agents, and performs exact lookup
5. checks `task.disabledAgents`
6. resolves plan-mode restrictions, output schema, model policy, and isolation policy

A missing name fails preflight with `Unknown agent "...". Available: ...`; no subprocess runs.

### Description vs execution-time discovery

`TaskTool.create()` memoizes discovery by resolved working directory plus the complete effective extension-root configuration when building the model-facing tool description. Each description read also includes the user-tagged model agents frozen into the current base prompt surface (see [user-tagged model agents](#user-tagged-model-agents)) rather than the live set, so tagging a model mid-session cannot mutate the provider tool prefix. Execution rediscovers agents and merges the live session agents, so the runtime set can differ from the earlier description if agent or extension files changed mid-session. Blocking behavior is determined after policy resolution rather than from a stale description-time agent object.

## Model and structured-output precedence

For task dispatch, model precedence is:

1. `task.agentModelOverrides[agentName]`
2. the agent frontmatter's prioritized `model` list
3. the parent's active model, then its configured/default model fallback

A call's per-call `model` (task item / flat call, eval `agent()` / `workpool()`; see below) replaces steps 2 and 3 when it is approved, and is a conflict error for an agent with a step-1 entry rather than outranking it. Role aliases in steps 1 and 2 are expanded through `modelRoles`. Host callers (SDK `runStructuredSubagent({ model })`, `omp cleanse --model`) supply an ungated model ahead of the settings override; the bundled seance agent's `model` overrides its source session's saved model as before.

### Per-call `model`

`task.perCallModel` decides where a model-facing call may pick its model:

| Value           | Behavior                                                                                                                                                                                                    |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `off` (default) | A task item, flat call, `agent()` or `workpool()` that passes `model` fails preflight (the bundled seance agent's own `model` is separate; see below). The field stays in the task schema.                  |
| `eval`          | Accepted by eval `agent()` and `workpool()` only; task items behave as `off`. Use it to route a specialist (e.g. a pinned `reviewer`) from a script while ordinary delegation keeps its configured routing. |
| `on`            | Accepted everywhere.                                                                                                                                                                                        |

Only the operator's layers can turn it on: a project's `task.perCallModel` can lower the mode (`on` → `eval` → `off`) but never raise it.

A per-call `model` is exactly one `provider/model-id[@upstream][:level]` (for example `anthropic/claude-sonnet-4-5:high`). The optional `@upstream` pin is supported only by aggregators and is part of the model identity: pinned and unpinned routes are different models for approval. The optional `:level` is clamped to a level the model supports, still bounded by `task.maxEffort`; a literal catalog id wins over splitting a level-shaped suffix. Role aliases (including `@default` and a legacy `pi/<role>` naming a built-in or configured custom role), arrays, comma lists, globs and partial ids fail preflight; when `task.perCallModel` refuses the call, that error is reported first. It is matched literally against the available chat models; there is no fuzzy resolution, and a non-chat model is rejected with that reason.

The model must be one the operator already routes to:

- a configured chat role's `modelRoles` value from the operator's layers (global config, `--config` files, runtime overrides or an SDK host's settings, never project settings; non-chat roles such as `image`, `web` and `judge` grant nothing, and role aliases inside a value are not expanded into built-in defaults),
- the selected agent's own frontmatter `model`, only when that agent is bundled or user-level, still discovered and not disabled (a project agent's frontmatter never grants directly and a repository agent file cannot add entries to `task.perCallModelAllow`, but its frontmatter model, like any agent's live model, becomes approvable for its per-call children and transitively below them; another agent's frontmatter grants nothing),
- the parent's live model, only when its routing can be written as one exact selector (several `only` upstreams, an `order` list or any other routing field grants nothing).

User-tagged `^provider/model` mention agents (`m<N>`) use the bundled task template with their tagged model as their own frontmatter, so selecting one grants that model too, subject to the same discovery, disabled-agent and allowlist checks.

How grant values match:

- A literal id is checked against the full catalog, including unavailable models. An unavailable `x:low` id never grants the base `x`, and brackets in an id (`[1m]`) are literal.
- A value containing `*` or `?` never grants, in a role or in agent frontmatter. It still routes the role or agent as before; to allow a per-call model the operator names it exactly.
- Any other value grants the one model it resolves to, using the most-recently-used order and the operator's `modelProviderOrder` captured at spawn or revival; later model switches do not change that resolution.

Catalog membership, credentials, built-in role defaults and saved transcripts grant nothing. `task.perCallModelAllow`, when set, narrows the result: each trimmed entry is compared literally to the model's canonical `provider/id[@upstream]` (no resolution, `:level` split, glob or bare id), and the model must be granted and listed. A project's list narrows it further: the model must be listed by both, so a project list, including an empty one, never replaces the operator's.

Grants come from the operator's settings or an SDK host's settings instance; a plain `Settings.overlay()` created by a host is its own authority, including its roles and allowlist. Project settings (`.omp/config.yml`, `.omp/settings.json`, `.claude/settings.json` and the other project providers) and settings overlays derived for subagents never grant and defer to the operator's authority; they can only narrow it through `task.perCallModel`, `task.perCallModelAllow` and `task.disabledAgents`. The agent can write a repository's files, and settings are reloaded before every spawn, so a role written there mid-session would otherwise approve its own model. Role and allowlist edits apply live, so removing a role stops it granting.

The operator's own files stay trusted: the global config, `--config` files and user-level agent files grant as written, and anything able to edit them can change grants like any other setting. The gate covers only calls that pass `model`; a call without it routes through `task.agentModelOverrides`, agent frontmatter and `modelRoles`, project layers included, as before.

When per-call selection is enabled for a surface, the task/eval tool descriptions list approved role models and the narrowing allowlist. Provider-qualified role values are listed as configured, without checking availability; bare values are resolved through the current registry to exact `provider/model-id` selectors and omitted without one. Glob role values grant nothing and are not listed. The advertisement uses the same literal allowlist comparison as dispatch.

A `model` for an agent with a `task.agentModelOverrides` entry fails preflight with a conflict error, so the operator's override is never silently replaced. Per-call `model` is not supported for the bundled seance agent, whose own `model` overrides its source session's saved model as before. A project or user agent that shadows the `seance` name is an ordinary agent: its `model` is a per-call `model`, held to every rule here.

A per-call worker never moves to an unapproved main-loop model. Retry fallback, context promotion and agent prewalk are off, and an unavailable requested model or missing working credentials fails the call rather than using the parent's model. Its requests never carry a server-side fallback chain, including one a caller supplies. Factory models whose provider attaches a server-side fallback chain are not refused: the per-call request omits the chain, and a response served by another model (or carrying a fallback handoff block) fails the worker before any of its content is forwarded. Every main-loop request is checked against the current operator grants, so an extension replacement or settings change cannot move the worker to an unapproved model; a decision is reused until the settings or the model catalog change. A cold registry at preflight, or a model not yet found during background discovery, is checked again before child-session creation once discovery settles.

Cold revival waits for model discovery, restores only the exact saved `perCallModelIdentity` route and `perCallThinkingLevel` selector, and rechecks current grants before creating the child session and again on every main-loop request. The selected agent is rediscovered through the live real parent's session, including that parent's local mention agents; root discovery supplies only file-defined agents when a nested worker's parent is not live, never the root's local mention agents. Current configured roles and discovered, enabled bundled/user frontmatter can still grant without a live parent. The parent's model grants only from the worker's real parent while it is live (the root session for its direct children); missing parent-local grants refuse revival with an error directing the operator to revive the parent first. Revival never wakes the parent automatically or treats saved grant metadata as authorization. Legacy per-call records missing either canonical field refuse revival rather than guessing from `resolvedModel`. Changing `task.perCallModel` affects new calls only.

Side requests the session makes for maintenance (compaction summaries and advisor calls) are not covered by the main-loop approval check: compaction tries the model's `compactionModel`, the session model and the built-in chat roles' models, then also the available model with the largest context window.

For a per-call `model`, `task.maxEffort` bounds every per-call-model spawn, not the endpoint's eventual behavior: an explicit `:level` is clamped to the highest supported effort at or below the cap, and an omitted `:level` inherits the agent's thinking level capped at this value. Unset, `:inherit` and `:off` keep their existing meaning; the ceiling does not replace them with an explicit effort or change provider defaults. A model with no supported effort under the cap fails the spawn and every later request. Cold revival reapplies the live cap to the saved effort selector. An endpoint's own effort-negotiation retry can still round to the nearest supported tier, including above the request (for example `minimal` → `low` or `xhigh` → `max`).

After policy resolution, the `before_subagent_spawn` extension hook runs once for the actual dispatch. It can block the spawn or replace the resolved model patterns; a routing note is carried into progress metadata.

The `Alt+P` task model pick is session-only; saving a model in `/agents` replaces that runtime selection for the current session and persists the new value for future sessions.

Compaction triggers are separate from model and service-tier selection: an exact, case-sensitive
`task.agentCompactionThresholdOverrides[agentName]` entry (`90000` or `"80%"`) replaces the
`compaction.threshold*` settings for that agent only; agents without an entry, including agents it
spawns, use the main session's thresholds. See [Settings](./settings.md#context-compaction-and-memory).

Request budgets follow the same exact-name pattern: a `task.agentSoftRequestBudget[agentName]` entry
(a non-negative integer) is that agent's soft request budget, replacing both `task.softRequestBudget`
and the bundled scout/sonic ceiling, so it can raise a budget the global setting can only lower; `0`
disables that agent's guard, and `null` clears an entry from a lower settings layer. Agents without an
entry keep the global setting capped by their bundled ceiling. See [task](./tools/task.md#limits--caps).

Service-tier precedence is independent of model selection: an exact, case-sensitive
`task.agentServiceTierOverrides[agentName]` entry overrides `tier.subagent`; an absent entry preserves
the global behavior. `inherit` snapshots the parent session's live per-family tiers (including
`/fast` changes) for the next spawn. The child session resolves a concrete value against the model
it finally settles on — after auth fallback and after patterns only the session can resolve, such as
extension-registered models — and populates only that model's provider family when the family
supports the value, so same-family retry fallbacks retain the tier and cross-family fallbacks never
inherit it. The resolved map is persisted with the child's session, even when it is empty, so a
parked agent revived after a restart keeps its per-agent tier instead of re-deriving
`tier.subagent`. The entry is looked up by task/eval dispatch only; Vibe workers launched through
the same executor keep `tier.subagent`. Service tiers are configuration-only; agent frontmatter and
the task/eval wire formats do not expose a tier field or automatic Fast policy.

Account selection is independent of model and service-tier selection: an exact, case-sensitive
`task.agentAccountPools[agentName]` entry maps provider ids to OAuth identity keys (the `identityKey`
values broker [client account pools](./auth-broker-gateway.md#client-account-pools-routing-not-authorization)
use, such as `email:<address>|org:<id>` for Anthropic; [`omp usage accounts`](./cli-reference.md)
lists them). For each listed provider the child authenticates
only with those accounts: ranking, the parent's copied account affinity, restored pins, fallback
passes, credential rotation, and saved-reset restores stay inside the pool, and runtime,
environment, and stored API keys
are not used; a `models.yml` `apiKey` for the provider fails the request instead of sending a pooled
token to that endpoint. When no pooled account can serve, the request fails with `No API key for
provider: … restricted to its OAuth account pool` instead of borrowing another account; an empty
list allows no account. Saved resets about to expire are still salvaged on every account, because
salvage serves the account that holds the reset. Pools do not pick models, so model and retry-fallback policy still decide
which provider the child calls. The pool covers every key lookup the agent makes, whatever provider
session id it carries: fresh or reset sessions, advisors, title generation, skill compression, and
subagents it spawns without their own entry (an entry of their own replaces it). Vibe workers take
the pool from their first turn, and a parked agent revived in the same process or after a restart
takes the live entry for its agent name. A custom SDK `getApiKey` resolver bypasses pools.

Runtime output schema precedence is:

1. the task item's explicit `outputSchema`
2. agent frontmatter `output`
3. parent session `outputSchema`

The task item's optional `schemaMode` overrides the parent session mode; the default is `permissive`.

These schemas apply only to structured runs. With `task.structured` off (the default), task spawns get no output schema and no `yield` tool and return their final assistant message, except for agents whose definition sets `structured: true`; those resolve the agent `output`, then the parent session schema, because the task item's `outputSchema` is not exposed. Eval `agent()` and workpool spawns are always structured.

Explicit caller schemas are validated during preflight in both modes. Agent/session schemas are preflight-validated when the effective mode is `strict`. Invalid schemas fail before child execution.

The model-facing prompt (`src/prompts/tools/task.md`) tags read-only agents and warns against offloading reasoning to `scout`/`sonic`.

## Workloads

A `prompt` step in a declarative workload ([Workloads](./workloads.md)) is spawned through `runStructuredSubagent`. The step's `model` is the spawn request's own selector — above `task.agentModelOverrides[agentName]` and the agent definition — and `output_schema` occupies the same caller `outputSchema` slot. `effort` is the coarse `lo` / `med` / `hi` hint documented above.

## Command discovery interaction

`src/task/commands.ts` is parallel infrastructure for workflow commands (not agent definitions), but it follows the same overall pattern:

- discover from capability providers first
- deduplicate by name with first-wins
- append bundled commands if still unseen
- exact-name lookup via `getCommand`

In `src/task/index.ts`, command helpers are re-exported with agent discovery helpers. Agent discovery itself does not depend on command discovery at runtime.

## Availability constraints beyond discovery

An agent can be discoverable but still unavailable to run because of execution guardrails.

### Disabled-agent settings

`resolveEffectiveSubagentPolicy()` checks `task.disabledAgents` after resolving the agent. A disabled name fails preflight and lists enabled alternatives when available.

### Parent spawn policy

The resolver checks `session.getSessionSpawns()`:

- `"*"` (also `true`, `null`, or absent) => allow any; omitted `agent` defaults to `task`
- `""` or `false` => deny all
- CSV list => allow only listed names; omitted `agent` defaults to its first name

If denied: `Cannot spawn '...'. Allowed: ...`.

### Blocked self-recursion env guard

`PI_BLOCKED_AGENT` (or the internal request override) rejects an attempt to spawn the same blocked agent before discovery.

### Recursion-depth gating

`task.maxRecursionDepth` defaults to `2`; a negative value disables the cap. The shared policy rejects a spawn when the current task depth has already reached the cap. When a child reaches the cap, `runSubprocess` also removes `task` from its tool list and sets its spawn policy empty.

For an explicit agent tool list, `runSubprocess` auto-adds `task` when `spawns` is declared and depth permits it. The legacy `exec` entry expands to `bash` plus `eval` when an eval backend is available. A list containing `task` or `bash` also gains `wait` unless the parent requires an exact restricted tool list; tool construction still omits `wait` when there is no async, IRC, or service wake source. Outbound peer messaging requires `write` in the child tool list and IRC enabled; inbound steering does not.

## Plan mode behavior

When parent plan mode is enabled, `resolveEffectiveSubagentPolicy()` builds an `effectiveAgent` before launching subprocesses:

- prepends the plan-mode subagent system prompt
- restricts tools to `read`, `grep`, `glob`, and `web_search`, plus `ast_grep` when the agent's own tool list declares it
- clears child spawns
- clears `prewalk` (read-only exploration must not receive the prewalk plan/implement nudges)

Plan mode also rejects eval-defined tools and per-spawn isolation, apply, and merge controls. The same `effectiveAgent` is used for subprocess launch, model/thinking overrides, and output-schema selection.
