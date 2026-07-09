# Bundle Update Log

## 2026-07-09
* **Creation**: Added [Coding-agent reliability hardening](/concepts/coding-agent-reliability-hardening.md) documenting implemented WikiGraph path sandboxing, 9router ID normalization, offload artifact protocol round-trip tests, and bundled-agent check fixes.
* **Creation**: Added [Light context layer](/concepts/light-context-layer.md) documenting the implemented `context_oracle` tool, typed LSP query seam, evidence shape, config, tests, and next compression slice.
* **Update**: Documented `contextLayer.model` as implemented evidence-only answer compression and moved the next slice to session-persistent context cache.
* **Update**: Moved light context layer cache onto `ToolSession.contextOracleCache`, added same-session cache reuse/invalidation coverage, and documented the next diagnostics/symbol cache slice.

## 2026-07-08
* **Creation**: Added [Offload trace](/concepts/offload-trace.md) documenting the implemented opt-in progressive-disclosure compaction memory layer (`offloadTrace.*` settings, preserveData seam, artifact:// drill-down).

## 2026-07-03
* **Creation**: Added [Recent prompt markdown files](/concepts/recent-prompt-markdown-files.md) capturing the prompt markdown inventory observed in-session, including the absence of `type: prompt(s)` frontmatter matches.

## 2026-07-01
* **Creation**: Added [Fork update channel](/concepts/fork-update-channel.md) documenting how updates and installers are routed to our fork.
* **Creation**: Added [Launch agent slash command](/concepts/launch-agent-slash-command.md) documenting the new `/agent` slash command.
* **Creation**: Created the `.omp/commands/agent.md` slash command definition to run a task agent autonomously.

## 2026-06-20
* **Initialization**: Created the `.wiki` OKF bundle for the oh-my-pi fork.
* **Creation**: Added [Spiral `/loop` design](/concepts/spiral-loop-design.md) capturing the verifier/synthesis loop-enhancement design.
* **Creation**: Added [Agent loop pattern survey](/concepts/agent-loop-patterns.md) comparing Self-Refine, Reflexion, ToT, and ReAct.
* **Creation**: Mirrored external sources under [references/](/references/index.md): Self-Refine, Reflexion, Tree-of-Thoughts, ReAct, and Claude Code subagents/compaction docs.

* **Update**: Implemented the spiral `/loop` design — `loop.mode: "spiral"` shipped with synthesis module, runtime wiring, prompts, and tests. Marked [Spiral `/loop` design](/concepts/spiral-loop-design.md) as `status: implemented`.