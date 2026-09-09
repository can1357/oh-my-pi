# 0001. Four operating modes are the architecture tests

Status: accepted
Date: 2026-09-02
Area: foundations

## Context

A harness that only ever runs as one local interactive TUI drifts into a specific shape: the
controller lives inside the TUI, state lives in closures, extensions execute in the engine
process, and a human is assumed to be present to recover from an unbounded call. omp v1 and pi both
took that shape. Every later feature (remote clients, subagents, autonomous jobs, spectators) then
had to be bolted on against those assumptions.

Four products were chosen as the envelope every subsystem must survive. They are not personas; they
vary the dimensions that separate a harness from a chat loop:

| Test | Local or remote | Interactive or autonomous | Trust boundary | Concurrency |
| --- | --- | --- | --- | --- |
| Multiplexed workspace | local | interactive | mostly trusted | many agents, one workspace |
| Remote driver | remote | interactive | split host/client | one or many agents |
| Spectator | remote view | observational | untrusted presentation input | many viewers |
| Factorio (software factory) | remote or fleet | autonomous | hostile repository and tool input | many jobs |

## Decision

Every subsystem design MUST be checked against all four modes before it is accepted. A design that
only satisfies the first is rejected.

Five consequences follow and bind the rest of the records:

1. **One authoritative session.** Rewind, fork, resume, replication, and inspection MUST derive
   from the same journaled state (0003, 0004).
2. **A trusted control plane.** Policy and session ownership stay on the host; sandboxes receive
   only bounded execution requests (0006).
3. **Bounded work.** Tool calls, subagents, and background jobs are cancellable streams with
   central limits and observability (0009, 0010, 0011).
4. **Explicit compatibility.** Model and provider quirks are structured knowledge, not branches
   scattered through call sites (0017).
5. **Views are projections.** The TUI, web client, remote client, and subagent inspector render
   the same state; none becomes an additional authority (0005).

## Consequences

- Any feature proposal MUST state how it behaves under the Spectator (untrusted presentation input)
  and Factorio (hostile tool input, no human) rows. "Works locally" is not an acceptance criterion.
- Later subsystems — the session DOM, convars, Directors, the sandbox stub, the component renderer —
  are each justified by one of the five consequences, not introduced for their own sake.
- Cost accepted: local-only shortcuts (in-process extensions, unbounded tool output, controller
  state in the UI) are prohibited even when they would be faster to ship.

## Status in omp

**Implemented.** Primary implementation: `crates/driver/src/headless/kernel.rs`. P0–P7 production modes share the journal-first composition; final P7 integration rerun is tracked in `PLAN.md`.

## References

- The Harness Playbook, "The design envelope"
- `AGENTS.md` — Architecture, Locked Deviations from pi
- 0002 for the complexity-ownership rule that these constraints enforce
