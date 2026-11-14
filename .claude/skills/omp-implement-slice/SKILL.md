---
name: omp-implement-slice
description: Implement and verify one bounded OMP2 plan slice through existing production ownership and repository tooling.
---

# Implement one slice

Read [AGENTS.md](../../../AGENTS.md), the approved task/plan, owning crate
contracts, [ADR status rules](../../../docs/adr/README.md) and
[TASKS.md](../../../docs/adr/TASKS.md). OMP2 supports `.claude/skills` when
its Claude source is enabled; respect host source policy and trust. Explicitly
read this file if the current harness has not loaded it. Installation alone
does not prove a running session refreshed its registry or executed the skill.

1. Inspect worktree state, fetch the target branch and record the base commit.
   Preserve unrelated edits. Start the earliest unblocked task on an isolated
   branch/worktree. If stacking on unmerged work, pin that parent and name the
   dependency; do not report it as remotely merged.
2. Confirm acceptance criteria and native reuse before editing. Driver composes;
   app presents; envd owns project effects; env is its client; tool contracts
   and implementations retain their layer boundaries. Reuse journal/CAS and ADW
   where appropriate instead of creating parallel authority or state.
3. Assign parallel work by disjoint file/module ownership; agree shared types
   first. Coordinator owns integration. Avoid simultaneous edits to shared files.
4. Change source through editing tools. Never use scripts to rewrite tracked
   files; use repository-directed structural/rename tooling for those operations.
   Do not change behavioral contracts, add dependencies or alter lockfiles merely
   to scaffold future work. Use existing `Hash32`, typed errors and workspace deps.
5. Run focused `just check-pkg`/`just test-pkg` recipes, then relevant integration
   proofs. Use repository nextest-plus-doctest recipes; prepare embedded Python
   when required. Test observable behavior at actual driver/envd/session seams.
   TUI changes additionally require real-PTY input, resize and quit verification.
6. Record command, scope and result for every required check. Missing runners,
   missing tools, unsupported hosts, zero tests and unknown effects remain explicit
   blockers or inconclusive results. Never promote compilation alone to completion.
7. Synchronize owning ADR Status in omp, `STATUS.md` and `TASKS.md` when the code
   moves their status. Review the full diff for unrelated changes, then commit
   reviewable work and publish within the user's authorized scope.

Output: changed files, decisions, exact validation results, remaining blockers,
intentionally skipped work and risks. Distinguish local readiness, published PR
and confirmed merge; no unavailable runner changes those facts.
