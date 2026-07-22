# P3 — GraphTree parity documentation and command metadata

Own only:
- `packages/coding-agent/src/slash-commands/builtin-registry.ts`
- `README.md`
- `docs/graphtree.md`
- `packages/coding-agent/CHANGELOG.md`

Update command metadata for `agents`, `stop`, `steer`, and `revive`. Expand the canonical README GraphTree section and `docs/graphtree.md` with an evidence-based parity matrix against `plasma-ai/fractal` and `TinyAGI/fractals`: recursive dynamic decomposition, isolated worktrees, bounded execution, lifecycle visibility/control, persistence, and tree UX. Map these to existing local primitives (AgentRegistry, nested task recursion, settings gates, AgentLifecycleManager, parked session files, task isolation). Clearly label `/graphtree run` as prompt-driven and state residual gaps rather than claiming a standalone autonomous scheduler. Add an Unreleased changelog entry. Run format/checks, commit as `docs(graphtree): document Fractal parity and controls`, and report sources/caveats.
