# Small-model orchestration audit selectors

Task: enumerate every implementation seam needed for boundary-resolved execution profiles, deterministic multi-agent collaboration, verifiable assignments, and automatic recovery.

Selectors were tested on commit `1555ecd899ebf0e0742cd90e0389023b10b82691`.

| ID | Concept | Tool and exact selector | Known-positive test | Why it has recall |
|---|---|---|---|---|
| S1 | Spawn/session boundaries | `search` regex `#runSpawn|spawnFusionSidekick|runSubprocess\(|createAgentSession\(|allocate\(` over `packages/coding-agent/src`, `packages/llm-router-agent/src` | `packages/coding-agent/src/task/index.ts:1111 #runSpawn`; `session/fusion-sidekick.ts:176 spawnFusionSidekick`; `task/executor.ts:1737 runSubprocess` | Finds task, Fusion, eval, slash-command, and SDK child-session creation/allocation seams. |
| S2 | Model/role/config resolution | `search` regex `modelAliases|agentModelOverrides|modelRoles|resolveModel|resolve.*Role|getModelRole|modelOverride|sidekickModel` over the same roots, case-insensitive | `config/settings-schema.ts:4230 task.agentModelOverrides`; `:4271 subagent.modelAliases`; `config/model-resolver.ts:1014 resolveModelRoleValue` | Finds selector schema, resolution, overrides, aliases, Fusion model selection, router hooks, and tests. |
| S3 | Tool capability construction | `search` regex `createTools\(|AgentDefinition|\.tools\b|activeToolNames|search-tool-bm25|registerTool|customTools|discoverableTools` over the same roots | `tools/index.ts:createTools`; `discovery/helpers.ts:252 frontmatter.tools`; `extensibility/extensions/loader.ts:150 registerTool` | Finds initial tool lists plus automatic/extension/MCP activation escape paths. |
| S4 | Result, budget, and recovery | `search` regex `schemaOverridden|outputSchema|isError|maxRequests|maxRuntimeMs|requestBudget|retry|escalat|failureStreak|setResult|yield` over `task`, `tools`, `session`, `config`, case-insensitive | `task/executor.ts:178 resolveSubagentRetryFallbackCandidates`; `tools/yield.ts`; `task/types.ts:317 retryState`; `task/render.ts:739 retrying` | Finds output validation, terminal status, fallback, budgets, retries, and UI propagation. |
| S5 | Collaboration/lifecycle control | `search` regex `AgentRegistry|AgentLifecycleManager|ensureLive|deliverIrcMessage|listVisibleTo|busyReply|wake|parked|parentId|recipient` over `packages/coding-agent/src` | `irc/bus.ts:70 AgentRegistry`; `registry/agent-lifecycle.ts`; `main.ts:1380 persisted reviver`; `collab/host.ts:528 ensureLive` | Finds registry topology, wake/revive, IRC, hub, persistence, and remote collaboration paths. |
| S6 | Execution failure observability | `search` regex `timeout|CalledProcessError|stderr|stdout|heredoc|GIT_BASH|process\.platform|win32` over `tools`, `session`, `task`, case-insensitive | `tools/eval.ts:257 default 30`; `tools/bash.ts:441 #throwIfUnfinished`; `tools/bash-command-fixup.ts:17 heredoc` | Finds timeout defaults, stream capture, platform-sensitive shell behavior, and failure rendering. |
| S7 | Grammar/prompt exposure | `find` globs `packages/coding-agent/src/prompts/tools/*.md`, `packages/coding-agent/src/prompts/system/*subagent*.md` | `prompts/tools/read.md`, `replace.md`, `apply-patch.md`, `task.md`, `irc.md`, `job.md` | Captures the actual language presented to models, not only implementation symbols. |
| S8 | Existing contract tests | `find` globs for task/Fusion/IRC/yield/model tests under `packages/coding-agent/test` | `test/task/task-spawn.test.ts`, `test/tools/yield.test.ts`, `test/tools/irc.test.ts`, `test/session/fusion-sidekick.test.ts` | Locates acceptance surfaces and prevents PRD lanes from inventing redundant test homes. |

## Completeness notes

- CodeGraph was attempted first but the MCP server was disconnected.
- TypeScript LSP was unavailable (`typescript-language-server` not installed); installation was not requested, so no symbol-query selector was used.
- Every matched implementation file relevant to the design is assigned exactly once in `small-model-orchestration.batches.json`; tests/prompts are attached to the same conceptual shard as their source.
- Files with no S1–S8 signal are intentionally excluded. Completion is exhaustion of the persisted finite batch list, not an investigator's subjective search stop.
