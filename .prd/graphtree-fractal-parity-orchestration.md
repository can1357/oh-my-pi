# GraphTree Fractal parity integration

## Purpose

Close the practical gaps between GraphTree and external recursive-agent systems such as `plasma-ai/fractal` and `TinyAGI/fractals` by adapting oh-my-pk's existing AgentRegistry, AgentLifecycleManager, nested task depth gates, concurrency/runtime limits, parked sessions, and isolated task worktrees. Do not build a second orchestration engine.

## Lanes

| Lane | Scope | Owned files | Depends on |
| --- | --- | --- | --- |
| P1 | Live recursive agent tree, bounded run prompt, stop/steer/revive controls | `packages/coding-agent/src/slash-commands/builtin/graphtree.ts`, `graphtree-run.md` | none |
| P2 | Behavioral contracts for parity capabilities | `packages/coding-agent/test/slash-commands/graphtree.test.ts` | none |
| P3 | Command metadata, README/docs parity matrix, changelog | `builtin-registry.ts`, `README.md`, `docs/graphtree.md`, `packages/coding-agent/CHANGELOG.md` | none |
| P4 | Fresh read-only adversarial audit | no files | P1–P3 |
| P5 | Integration, remediation, wiki, verification | main checkout | P1–P4 |

## Required behavior

- `/graphtree agents` renders the actual recursive AgentRegistry parent/child tree with status, attention, bounded activity, and worktree/CWD context.
- `/graphtree run <objective>` injects configured hard bounds from `task.maxRecursionDepth`, `task.maxConcurrency`, `task.maxRuntimeMs`, and `task.isolation.mode` into a static imported prompt. The prompt tells the model to use the real task/agent primitives, dynamically recurse only within those bounds, and prefer isolated worktrees for editing lanes when isolation is enabled.
- `/graphtree stop <agent-id>` aborts/releases a non-main, non-advisor agent through the existing lifecycle manager.
- `/graphtree steer <agent-id> <guidance>` revives if needed and sends steering through the existing session streaming behavior.
- `/graphtree revive <agent-id>` revives a parked agent through the existing lifecycle manager.
- Unknown, Main, and advisor IDs fail safely. Rendered model-derived text is sanitized/truncated with repository constants.
- Existing worktree commands and safety contracts remain unchanged.

## Acceptance

- Focused tests exercise recursive rendering, configured run bounds, stop, steer, revive, and guardrails.
- Documentation accurately maps each external Fractal capability to a real local primitive and names residual gaps; it must not claim autonomous guarantees that remain prompt-driven.
- `bun run check:ts`, focused tests, parser checks, and `git diff --check` pass.
- No release/version advancement while `docs/graphtree-release-acceptance.md` remains HOLD.
