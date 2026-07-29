# OMPK Prompt Layer Ownership

Which layer owns which rules — avoid duplicating the same instruction in multiple places.

| Layer | Owns | Does not own |
| --- | --- | --- |
| Base system prompt | Permanent behavioral invariants (complete work, verify before yielding, tool-use norms) | Task-specific acceptance, delegation fan-out policy |
| Project `AGENTS.md` / `SYSTEM.md` | Repository conventions, architecture, package boundaries | Per-assignment scope, worker strategy families |
| Task contract (`task-contract/v1`) | Root completion criteria, non-solutions, known failure modes for substantial work | Delegation protocol, child immutable scope |
| `task.md` (tool schema) | Delegation protocol, independence vs fan-out, assignment formatting, work-class verification | Immutable child acceptance checks |
| Assignment contract (`assignment-contract/v1+`) | Immutable child objective, scope, procedures, acceptance | Parent orchestration portfolio, advisor general review |
| Advisor prompt | Adversarial review behavior, contract watchdog when `<active-task-contract>` is present | Executor instructions, child yield schema |
| `.ompk/WATCHDOG.md` | Persistent project-specific reviewer traps (advisor-only) | Task-specific criteria (inject dynamically) |
| Agent templates (`prompts/agents/*.md`) | Worker-mode identity (`explore`, `falsify`, `audit`, …) | Parent batch context policy |
| Triggered rules / hindsight | Rare course correction, durable learned facts | Standing completion criteria |

**Harness note:** `agent-harness.ts` owns tool/skill/decision ceilings at spawn; prompts reference harness kind but do not redefine tool lists.
