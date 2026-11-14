---
name: omp-adr-plan
description: Turn OMP2 research into a source-grounded ADR or bounded implementation plan with explicit dependencies and acceptance evidence.
---

# Plan an OMP2 change

Read [AGENTS.md](../../../AGENTS.md),
[ADR format and status rules](../../../docs/adr/README.md),
[STATUS.md](../../../docs/adr/STATUS.md),
[TASKS.md](../../../docs/adr/TASKS.md) and the owning source. For verification
work also read the [roadmap](../../../docs/research/omp2-hybrid-verification/09-implementation-roadmap.md).
OMP2 supports `.claude/skills` discovery when its Claude source is enabled;
respect host source policy and trust. Explicitly read this file if the current
harness has not loaded it; adding a skill does not register an OMP2 extension
or prove an already-running session refreshed its registry.

1. Start from a recorded target commit and identify the earliest unblocked
   task. Check existing ADR decisions and active work before proposing another
   owner, scheduler, storage system or execution path.
2. State the problem and observed evidence, decision/alternatives, consequences,
   real implementation status, risks and references. New ADRs follow the
   documented numbered format. Owner revisions use a dated Amendment; do not
   silently rewrite historical decisions or mark a proposal accepted yourself.
3. Define one reviewable slice: exact owning files, typed API boundary, user-visible
   behavior, dependency order, acceptance criteria, meaningful unit/integration
   tests and excluded later work. Use relative complexity estimates, not invented
   delivery dates or unmeasured performance promises.
4. Plan parallel tracks only when contracts and write ownership are clear. One
   agent owns each file/contract; the coordinator integrates shared changes.
   A dependent branch may use an explicitly identified locally validated parent
   commit. Record its prerequisite and actual remote merge state separately.
5. Preserve driver composition, envd effects authority, session/journal ownership
   and existing approval/sandbox contracts. New control across turns uses the
   Director/Component conventions; do not insert a second production stack.
6. List runnable `just` checks and required host-specific proofs. Record unavailable
   runners/tooling as blocked or not run, never as passed. Explain what can be
   validated locally and what evidence remains necessary for acceptance.

Output: a checked-in ADR or implementation plan with an explicit first slice.
When implementation status changes, update the owning ADR's Status in omp,
`STATUS.md` and `TASKS.md` together. A research recommendation does not itself
change production behavior, complete an ADR or merge a branch.
