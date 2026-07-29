# Task Agent Discovery and Selection

This document describes how the task subsystem discovers agent definitions, merges multiple sources, and resolves a requested agent at execution time.

It covers runtime behavior as implemented today, including precedence, invalid-definition handling, and spawn/depth constraints that can make an agent effectively unavailable.

## Implementation files

- [`src/task/discovery.ts`](../packages/coding-agent/src/task/discovery.ts)
- [`src/task/agents.ts`](../packages/coding-agent/src/task/agents.ts)
- [`src/task/types.ts`](../packages/coding-agent/src/task/types.ts)
- [`src/task/index.ts`](../packages/coding-agent/src/task/index.ts)
- [`src/task/commands.ts`](../packages/coding-agent/src/task/commands.ts)
- [`src/prompts/agents/task.md`](../packages/coding-agent/src/prompts/agents/task.md)
- [`src/prompts/tools/task.md`](../packages/coding-agent/src/prompts/tools/task.md)
- [`src/discovery/helpers.ts`](../packages/coding-agent/src/discovery/helpers.ts)
- [`src/config.ts`](../packages/coding-agent/src/config.ts)
- [`src/task/executor.ts`](../packages/coding-agent/src/task/executor.ts)

---

## Agent definition shape

Task agents normalize into `AgentDefinition` (`src/task/types.ts`):

- `name`, `description`, `systemPrompt` (required for a valid loaded agent)
- optional `tools`, `spawns`, `model`, `thinkingLevel`, `output`, `blocking`, `autoloadSkills`, `readSummarize`
- `source`: `"bundled" | "user" | "project"`
- optional `filePath`

Parsing comes from frontmatter via `parseAgentFields()` (`src/discovery/helpers.ts`):

- missing `name` or `description` => invalid (`null`), caller treats as parse failure
- `tools` accepts CSV or array; if provided, `yield` is auto-added
- `spawns` accepts `*`, CSV, or array
- backward-compat behavior: if `spawns` missing but `tools` includes `task`, `spawns` becomes `*`
- `output` is passed through as opaque schema data
- `read-summarize: false` (parsed as `readSummarize`) forces the subagent's `read` tool to return verbatim file content instead of structural summaries — `runSubprocess` applies it as a `read.summarize.enabled: false` override on the subagent's isolated settings (`src/task/executor.ts`). `explore` and `librarian` ship with it disabled. Defaults to enabled when the field is absent.

## Bundled agents

Bundled agents are embedded at build time (`src/task/agents.ts`) using text imports.

`EMBEDDED_AGENT_DEFS` defines:

- `explore`, `plan`, `designer`, `reviewer`, `librarian`, `oracle`, `ix-browser-fast`, `mr-worker`, `mr-reducer`, `tot-reasoner` from prompt files
- `task` and `quick_task` from shared `task.md` body plus injected frontmatter

Loading path:

1. `loadBundledAgents()` parses embedded markdown with `parseAgent(..., "bundled", "fatal")`
2. results are cached in-memory (`bundledAgentsCache`)
3. `clearBundledAgentsCache()` is test-only cache reset

Because bundled parsing uses `level: "fatal"`, malformed bundled frontmatter throws and can fail discovery entirely.

## Filesystem and plugin discovery

`discoverAgents(cwd, home)` (`src/task/discovery.ts`) merges agents from OMP-native roots and Claude plugin roots before appending bundled definitions. Cross-harness roots such as `.claude/agents`, `.codex/agents`, and `.gemini/agents` are intentionally skipped — their frontmatter schema is not the OMP task-agent contract (`TASK_AGENT_CONFIG_SOURCE = ".ompk"` filters both dir lists).

### Discovery inputs

1. Nearest project `.ompk` agents dir from `findAllNearestProjectConfigDirs("agents", cwd)` (filtered to `.ompk`; first hit only)
2. User `.ompk` agents dir from `getConfigDirs("agents", { project: false })` (filtered to `.ompk`; first hit only)
3. Claude plugin roots (`listClaudePluginRoots(home, cwd)`) with `agents/` subdirs — only when `isProviderEnabled("claude-plugins")`; project-scope plugins sort before user-scope
4. Bundled agents (`loadBundledAgents()`)

### Actual source order

1. project `.ompk/agents`
2. user `~/.ompk/agent/agents`
3. plugin `agents/` dirs (project-scope first, then user-scope)
4. bundled agents last

## Merge and collision rules

Discovery uses first-wins dedup by exact `agent.name`:

- A `Set<string>` tracks seen names.
- Loaded agents are flattened in directory order and kept only if name unseen.
- Bundled agents are filtered against the same set and only added if still unseen.

Implications:

- Project `.ompk` overrides user `.ompk`.
- Non-bundled agents override bundled agents with the same name.
- Name matching is case-sensitive (`Task` and `task` are distinct).
- Within one directory, markdown files are read in lexicographic filename order before dedup.

## Invalid/missing agent file behavior

Per directory (`loadAgentsFromDir`):

- unreadable/missing directory: treated as empty (`readdir(...).catch(() => [])`)
- file read or parse failure: warning logged, file skipped
- parse path uses `parseAgent(..., level: "warn")`

Frontmatter failure behavior comes from `parseFrontmatter`:

- parse error at `warn` level logs warning
- parser falls back to a simple `key: value` line parser
- if required fields are still missing, `parseAgentFields` fails, then `AgentParsingError` is thrown and caught by caller (file skipped)

Net effect: one bad custom agent file does not abort discovery of other files.

## Agent lookup and selection

Lookup is exact-name linear search:

- `getAgent(agents, name)` => `agents.find(a => a.name === name)`

In spawn execution (`TaskTool.#executeSync` → `#runSpawn`):

1. agents are rediscovered at execution time (`discoverAgents(this.session.cwd)`)
2. requested `params.agent` is resolved through `getAgent`
3. missing agent returns immediate tool response:
   - `Unknown agent "...". Available: ...`
   - no subprocess runs

### Description vs execution-time discovery

`TaskTool.create()` builds the tool description from discovery results at initialization time. `#executeSync` rediscovers agents, so the runtime set can differ from what was listed in the earlier tool description if agent files changed mid-session. The async entry path still uses the initialization-time list to decide whether an agent is marked `blocking` before scheduling.

## Structured-output guardrails and schema precedence

Runtime output schema precedence in `TaskTool.#runSpawn`:

1. agent frontmatter `output`
2. parent session `outputSchema`

(`effectiveOutputSchema = effectiveAgent.output ?? this.session.outputSchema` — the task call itself never carries a schema; ad-hoc structured workflows go through the eval bridge's `agent(prompt, schema)`.)

The model-facing prompt (`src/prompts/tools/task.md`) no longer carries the old structured-output mismatch warning; it tags read-only agents and warns against offloading reasoning to `explore`/`quick_task` instead.

## Command discovery interaction

`src/task/commands.ts` is parallel infrastructure for workflow commands (not agent definitions), but it follows the same overall pattern:

- discover from capability providers first
- deduplicate by name with first-wins
- append bundled commands if still unseen
- exact-name lookup via `getCommand`

In `src/task/index.ts`, command helpers are re-exported with agent discovery helpers. Agent discovery itself does not depend on command discovery at runtime.

## Availability constraints beyond discovery

An agent can be discoverable but still unavailable to run because of execution guardrails.

### Execution-profile policy

Every spawn resolves an immutable `AgentExecutionProfile` across independent tier, autonomy, collaboration, work-class, edit-mode, request-budget, runtime-budget, and model-pool axes. `task.agentPolicies` supplies workflow/default, agent-type, and stable agent-id layers; restrictive composition prevents a more-specific policy from widening an earlier ceiling.

Interactive sessions can add a global tier ceiling with `/tier light|mid|frontier|auto`, or through `/settings` → **Model** → **Agent Model Profiles** → **Default Spawn Tier**. This `agent.tier` setting is deliberately independent from model selection, so a stronger model can run with the simpler light or mid tool/edit grammar. The task tool reads settings for each spawn, so changes apply immediately to subsequent child launches in the same TUI. Already-running children keep their frozen profile.

### Disabled-agent settings

`TaskTool.#executeSync` checks `task.disabledAgents` after resolving the agent. If the requested name is disabled, execution returns an immediate error listing enabled alternatives when available.

### Parent spawn policy

`TaskTool.#executeSync` checks `session.getSessionSpawns()`:

- `"*"` => allow any
- `""` => deny all
- CSV list => allow only listed names

If denied: immediate `Cannot spawn '...'. Allowed: ...` response.

### Blocked self-recursion env guard

`PI_BLOCKED_AGENT` is read at tool construction. If request matches, execution is rejected with recursion-prevention message.

### Recursion-depth gating (task tool availability inside child sessions)

In `runSubprocess` (`src/task/executor.ts`):

- depth computed from `taskDepth`
- `task.maxRecursionDepth` controls cutoff
- when at max depth:
  - `task` tool is removed from child tool list
  - child `spawns` env is set to empty

So deeper levels cannot spawn further tasks even if the agent definition includes `spawns`.

## Plan mode behavior

When parent plan mode is enabled, `TaskTool.#runSpawn` builds an `effectiveAgent` before launching subprocesses:

- prepends the plan-mode subagent system prompt
- restricts tools to `read`, `search`, `find`, `lsp`, and `web_search`, plus `ast_grep`/`report_finding` when the agent's own tool list declares them (`PLAN_MODE_AGENT_TOOL_ALLOWLIST`)
- clears child spawns

The same `effectiveAgent` is used for subprocess launch, model/thinking overrides, and output-schema selection.
