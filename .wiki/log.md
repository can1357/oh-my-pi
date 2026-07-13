# Bundle Update Log

## 2026-07-13
* **Creation**: Added [Recent History — 2026-07](concepts/recent-history-2026-07.md), covering committed changes from `9ed73a788..1895db95e` and separating current uncommitted work.
* **Update**: Indexed the history synthesis under the knowledge bundle's History section.

## 2026-07-12
* **Creation**: Added [Environments-cloud routing](/concepts/environments-cloud-routing.md) for MSI pkscloudenvs SoT wiring (resolvers, `ompk-remote environments`, coding-agent skill auto-route).
* **Creation**: Added [Remote workspace](/concepts/remote-workspace.md) documenting phase-1 Docker sandbox jobs (`packages/remote-workspace`, `ompk-remote`), lifecycle, and the split from multi-node mesh SoT.
* **Creation**: Added [Task-contract and orchestration runtime](/concepts/task-contract-orchestration.md) covering M1 ephemeral contracts, intent compilation, and Phase 0A evidence/completion modules under `src/orchestration/`.
* **Creation**: Added [Ethereal workspaces](/concepts/ethereal-workspaces.md) documenting session-scoped cwd isolation vs remote-workspace Docker jobs.
* **Creation**: Added [Collab live sessions](/concepts/collab-live-sessions.md) pointing at `/collab` and `packages/collab-web` (long-form in `docs/collab.md`).
* **Update**: Indexed the new concepts under [concepts/index.md](/concepts/index.md).

## 2026-07-09
* **Creation**: Added [Coding-agent reliability hardening](/concepts/coding-agent-reliability-hardening.md) documenting implemented WikiGraph path sandboxing, 9router ID normalization, offload artifact protocol round-trip tests, and bundled-agent check fixes.
* **Creation**: Added [Light context layer](/concepts/light-context-layer.md) documenting the implemented `context_oracle` tool, typed LSP query seam, evidence shape, config, tests, and next compression slice.
* **Update**: Documented `contextLayer.model` as implemented evidence-only answer compression and moved the next slice to session-persistent context cache.
* **Update**: Moved light context layer cache onto `ToolSession.contextOracleCache`, added same-session cache reuse/invalidation coverage, and documented the next diagnostics/symbol cache slice.
* **Update**: Added explicit symbol lookup cache coverage for the light context layer, including same-session reuse and workspace-change invalidation tests.

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