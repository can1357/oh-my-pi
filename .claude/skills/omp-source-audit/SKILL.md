---
name: omp-source-audit
description: Audit actual OMP2 capabilities and trace claims to pinned source before proposing implementation.
---

# Audit OMP2 source

Use for feasibility investigations, upstream comparisons and capability claims.
Read [AGENTS.md](../../../AGENTS.md), the relevant crate contracts and
[research conventions](../../../docs/research/omp2-hybrid-verification/01-current-capability-audit.md).
OMP2 discovers ancestor `.claude/skills` when its Claude skill source is enabled
(`crates/driver/src/discovery/skills.rs`). Respect host source policy and trust;
explicitly read this file if another harness has not loaded it. Adding a file
does not prove that an already-running session refreshed its skill registry.

1. Record repository, branch, commit, worktree changes and actual target branch.
   Preserve user edits. Pin every external source and distinguish upstream
   implementations from ports available in this checkout.
2. Use bounded `rg` to locate ownership, then read relevant symbols and callers.
   Use available LSP/navigation for known symbols; textual matches alone are not
   semantic proof. Trace production composition, concrete implementations and tests.
3. Classify each material capability: implemented and source-verified; implemented
   but incomplete; interface/stub only; documented/planned only; absent within a
   stated search scope; or unknown. Separately record any executed runtime proof.
4. Record paths, symbols, source ranges, API/types, dependencies, limitations,
   model-independent operation and whether to reuse, extend or implement anew.
   Prefer native facilities to duplicate frameworks, services or runtimes.
5. Delegate independent source areas only with explicit ownership and disjoint
   writes. Keep shared contracts and integration decisions with the coordinator.
6. Write findings in a repository research note. Record exact commands, inputs,
   exit results and blockers. Missing tooling, skipped tests and zero selected
   tests are not a pass; measurements from others remain attributed claims.

Output: a source-pinned capability matrix, confirmed gaps and an actionable
next slice. Never infer implementation from ADR acceptance or infer a merge from
local validation; record actual GitHub state separately.
