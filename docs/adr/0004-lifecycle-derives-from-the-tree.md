# 0004. Rewind, fork, resume, replication, and prompts derive from the tree

Status: accepted
Date: 2026-09-02
Area: state

## Context

With two authorities (0003), every lifecycle operation is a hand-written reconciler, and every
stateful feature adds a call site to each of them. pi exposes `session_tree`, `getBranch()`, and
`session_shutdown` hooks and expects each extension to wire them correctly. The official examples
show what that costs:

- `plan-mode/index.ts` reads plan state from the whole file instead of the selected branch:
  rewind leaves tool restrictions active; resume can resurrect a dead branch's snapshot.
- `snake.ts` and `bookmark.ts` scan `sessionManager.getEntries()` from the end: a save from an
  abandoned branch returns; "last assistant message" is one the user cannot see.
- `kimi-deferred-tools.ts` activates `Calculator` through `setActiveTools` and never re-derives
  the roster: after rewinding before discovery, `Calculator` is still active.
- `auto-commit-on-exit.ts` treats `session_shutdown` as process exit: `/new`, `/resume`, and
  `/fork` commit the dirty worktree.

Each is a different reconciler missing a different hook. Prompts had the same shape: a 100-line
state object assembled and passed into every template, itself a third copy of state.
Replication (remote driver, spectator in 0001) meant tailing a `.jsonl` and re-implementing the
derivation on the client. Rendering meant one bespoke renderer per tool, each deciding how to
show partial arguments and partial output.

## Decision

Every lifecycle and view operation MUST be defined as a function of the session tree, never as
a per-feature hook set.

**Rewind and fork are a DOM diff.** Diff the current materialization against the target
materialization. The delta is the complete lifecycle work list:

- an element disappeared (`<subagent>`, `<job>`, a tool call) → terminate it by destroying the
  element;
- an element appeared → spawn or resume it by creating the element;
- an attribute changed → apply the property change.

Resume is the same operation with an empty current tree. Fork is the same operation onto a new
journal. Terminating a subagent because its element vanished is the engine's job; no extension
registers for it.

> Adding a stateful feature never adds a call site to rewind, fork, resume, or replication.

**Prompts are projections.** Templates read the same tree as everything else through selectors;
there is no state object threaded into templates.

```text
- {{ count(select("todo item[status!=completed]")) }} open items
```

**Replication is subscription.** A remote client (driver or spectator) consumes the patch stream
(0003) and applies it to its own materialization with the same derivation the host uses. It does
not tail a file, and it does not carry separate state plumbing.

**Rendering is projection.** A component registry renders `Read`, `Bash`, a message, or a
subagent from element state. Streaming arguments mutate `<input>`; streaming output mutates
`<result>`; the renderer re-projects. No tool ships its own renderer for partial state (0008,
0031).

Rules:

1. Lifecycle code MUST consume the diff, not feature-specific events. A feature that needs
   custom teardown expresses it as an element type whose destruction the engine handles.
2. Any reader of session state (prompt, renderer, replica, inspector) MUST select from the tree
   or apply its patch stream. Reading the raw journal file is prohibited outside the journal owner.
3. "Last", "current", and "active" MUST mean the selected branch of the tree, never file order.
4. Process exit and session switch are different transitions in the tree; hooks that
   conflate them are not offered.

## Consequences

- One diff engine replaces N reconcilers; correctness of rewind is a property of the engine, tested
  once, instead of a property of each extension.
- Remote driver and spectator (0001) fall out of replication for free; inspecting a subagent is
  projecting a different tree (0005).
- Prohibited: extension hooks whose purpose is to re-derive state after navigation; prompt state
  objects; client-side journal parsing.
- Cost accepted: the engine must materialize the target state to diff against it, which is more
  work than moving a leaf pointer; element lifecycles (spawn, resume, terminate) must be
  expressible as element create/destroy for every stateful kind.

## Status in omp

**Implemented.** Primary implementation: `crates/session/src/rewind.rs`. Rewind lifecycle work, projections, components, and subscriptions derive from the session tree. Global runtime pause is likewise materialized as `<meta><pause>` by `crates/agent/src/pause.rs`; replay and session switches select that element rather than restoring a controller flag. Blob collection scans every committed branch of every project/session namespace under an exclusive writer lease, so rewindable media survives until explicit journal pruning, child jobs and imported sessions retain their own roots, a session switch keeps both journals' roots, and deleting one session cannot evict blobs still retained by another; GC dry-run derives the same post-prune root set without mutating it. Exploration checkpoints materialize named workspace/session pairs on `<meta><rewind-checkpoint>`, including checkpoint and workspace ancestry; `checkpoint@3` lists the selected branch newest first and `rewind@4` selects an exact token or unique label. Rewind restores modified, deleted, and non-ignored untracked paths through document authority before committing the journal `prior` branch, fences the dry-run-to-commit generation, retains an undo generation on conflicts/failure, applies the resulting lifecycle diff to job cancellation/restart, and re-derives the disposable checkpoint index from the selected DOM after resume, rewind, or session switch. Typed session exits are materialized under `<meta><con><session-transitions>` by `crates/session/src/exit_diagnostics.rs`: clean, signal, provider, tool, worker, panic, and unobserved-crash boundaries retain only a bounded redacted active-work tail, replay synthesizes an unobserved crash before settling orphaned calls, and chat/render/export/print project the same record while ordinary clean exits remain silent. Collaboration replication in `crates/driver/src/collab/{session,observer}.rs` now derives both the remote agent roster and every child transcript from DOM snapshots plus ordered events; parked journals are folded controller-side, reconnect installs a fresh snapshot, and remote actors never tail a transcript file.

## References

- The Harness Playbook, "The state" — "What one authority buys"; Appendix A items 2, 5, 6, 7, 8
- 0001 (remote driver, spectator), 0003 (the tree and its patch stream), 0005 (controller and
  actor), 0008 (tool call as one element), 0010 (jobs), 0031 (typed component model)
- `docs/architecture/agent-loop.md` — "Durable turn flow", "Events, storage, and presentation"
- Source Engine `.dem` replay: seek to a tick and re-derive
