# 0034. Blocks, exactly-once history, append-only scrollback; TLA+-checked

Status: accepted
Date: 2026-09-02
Area: interface

## Context

The transcript is the part of a TUI that users file issues about, and the perfect version they
expect (every component fully up to date at every location, dynamically mutated, in native
scrollback) is impossible: a terminal has no addressable area below the viewport, and rows pushed
into native scrollback cannot be rewritten. Attempts to clear and rewrite scrollback produce
exactly the behavior users complain about. omp v1 reached a stable transcript only by writing a
fuzzer against its ad hoc commit logic.

The post separates three things that get conflated into "the transcript":

- mutable presentation in the viewport,
- width-independent logical history,
- irreversible native terminal rows.

## Decision

### Blocks

The canonical transcript is a list of blocks. A block produces rows and moves through
`active → finalized → committed`. While active, block *i* shows a current snapshot *W_i*; on
finalization it freezes to an immutable *F_i*. Two modes:

- **Mutable** (spinners, progress): a new snapshot may replace the previous one wholesale.
  Snapshots are speculative and NEVER become history; only *F_i* does.
- **Append-only** (streaming text): every snapshot is a prefix of the next and the last is a prefix
  of *F_i*, so a stable prefix MAY begin committing while the block still streams.

### Terminal and logical history

A terminal at width *W*, height *H* has a viewport *V* (*H* rows) and native scrollback *S*
(unbounded, append-only). *S* is NEVER rewritten; this is an invariant, not a preference.
Wrapping *wrap_W* maps logical rows to physical rows and depends on width.

Logical history *L* is kept in unwrapped rows and is width-independent. With *c* the last committed
block and *j = c+1*:

    L = F_1 · F_2 ⋯ F_c · W_j[1..e_j]

where *e_j* is the number of rows of the streaming head already let through (*e_j = 0* unless block
*j* is append-only and mid-stream). Five properties MUST hold:

1. committed finals occur in *L* exactly once, consecutively, in block order;
2. mutable speculative snapshots never enter *L*;
3. an append-only head may enter *L* row by row while streaming;
4. finalization writes nothing;
5. commitment appends only the rows of *F_j* not yet emitted.

### Resize

Resize changes nothing logical: every *W_i*, every *F_i*, and *c* survive. Only wrapping and
viewport allocation are recomputed. Because rows already in *S* cannot be rewritten, resize has one
explicit policy for them: **Preserve** (keep emulator-wrapped history), **Append** (append a
re-rendered history, possibly duplicating physical rows), or **Rebuild** (start a new physical
epoch and replay history into it).

### Viewport geometry (cutover plan)

Under height pressure every active block contracts through one geometry:
`full card (h ≥ 3) → compact card (h = 2) → quiet pulse row (h = 1)`, and on finalization
`pulse (h = 1) → hidden finalized block (h = 0)`. Finalized-but-waiting blocks consume zero
viewport rows; the host retires the maximal contiguous finalized prefix into *S* in creation order.
There is one presentation model: no retained inline transcript frame, no inferred stable-row
boundary, no height watermarks, no width epochs or scrollback reflow, no rewind by rewriting
scrollback, no user-selectable resize scrollback mode. Export, replay, and history inspection read
the canonical journal (0003), not a second presentation-side transcript.

### Specification

The protocol is modeled in TLA+ (`ElasticSlots.tla`, "Elastic Speculative Slots") as three layers
related by invariants: semantic block state (phase/mode/want/final/emitted per block), the logical
history ledger (width-independent, exactly-once), and physical native rows (width-rendered,
source-tagged). Any change to commit, finalization, truncation, or resize behavior MUST be made in
the spec and model-checked first; a counterexample trace is the review artifact. No fuzzer.

## Consequences

- Streaming and resize become policy choices with names instead of folklore; a report that "the
  transcript is broken" is answered by pointing at which invariant the request would violate.
- Rewind cannot erase retired rows; it emits a finalized rewind marker and continues.
- Committed rows do not reflow on resize; only active and pending content re-renders.
- A stalled head block delays later finalized output; the fix is timeout/cancellation, never
  premature commit.
- Prohibited: writing above the viewport, inferring durable output from scene geometry, any
  second transcript store, graphics as durable native-history content (commit a cell/text
  fallback).
- Cost accepted: a formal model to maintain, and a UI that visibly refuses to do the impossible
  thing users ask for.

## Status in omp

**Implemented.** Primary implementation: `crates/tui/src/slots.rs`. Elastic slots, delivery transactions, resize policies, TLA+ artifacts, and law tests implement the transcript protocol.

## References

- The Harness Playbook, "The interface": "The transcript is a protocol", "Specify the impossible
  part"; Appendix B "Elastic Speculative Slots" (paper and `ElasticSlots.tla`)
- Lamport, TLA+ (lamport.azurewebsites.net/tla)
- `PLAN.md`, `crates/chat/src/blocks.rs`, `crates/chat/src/scene.rs`,
  `crates/tui/src/renderer.rs`, `crates/tui/README.md`
- 0003 (the journal is the canonical record the transcript projects), 0005 (views are
  projections), 0033 (how the protocol is exercised on a real PTY), 0030
