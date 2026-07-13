# Concepts

* [Spiral `/loop` design](spiral-loop-design.md) - design for a `loop.mode: "spiral"` that adds a verifier/synthesis step between iterations so context compounds until a plan completes.
* [Agent loop pattern survey](agent-loop-patterns.md) - comparison of Self-Refine, Reflexion, Tree-of-Thoughts, and ReAct, and which to lift for sequential plan refinement.
* [Fork update channel](fork-update-channel.md) - how oh-my-pk/omp installers and updates are routed to the fork's distribution endpoint.
* [Launch agent slash command](launch-agent-slash-command.md) - how the new /agent slash command launches the agent on a specified task.
* [Recent prompt markdown files](recent-prompt-markdown-files.md) - session-observed inventory of recent `packages/coding-agent/src/prompts/**/*.md` files and the `type: prompt(s)` frontmatter caveat.
* [Context and token optimization](context-optimization.md) - how the system prompt, tool schemas, and context files contribute to the LLM context window, and tunables to keep the baseline small.
* [Offload trace](offload-trace.md) - opt-in progressive-disclosure compaction memory: raw evidence offloaded to artifact:// with a bounded Mermaid trace canvas preserved across context rebuilds.
* [Coding-agent reliability hardening](coding-agent-reliability-hardening.md) - implemented safety and verification fixes for WikiGraph path reads, 9router ID normalization, offload artifact drill-down, and bundled-agent checks.
* [Light context layer](light-context-layer.md) - implemented `context_oracle` tool and typed LSP evidence seam for compact cited repository answers.
* [Remote workspace](remote-workspace.md) - phase-1 Docker sandbox jobs (`ompk-remote`); durable lifecycle, not multi-node mesh.
* [Environments-cloud routing](environments-cloud-routing.md) - MSI pkscloudenvs SoT for mesh/cloud skills and handoff CLIs.
* [Task-contract and orchestration runtime](task-contract-orchestration.md) - ephemeral root task contracts, evidence ledger, completion-gate modules under `src/orchestration/`.
* [Ethereal workspaces](ethereal-workspaces.md) - session-scoped isolated cwd so agent edits do not mutate the source checkout.
* [Collab live sessions](collab-live-sessions.md) - `/collab` multi-client live session sharing and collab-web guest client.
