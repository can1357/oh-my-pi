# omp-adw

AI developer workflow domain: what a workflow *means*, decided in one place.

A workflow is a set of named phases with declared dependencies. This crate owns
the questions that have exactly one correct answer regardless of how a phase is
executed: which phases may dispatch now, which attempt number a phase is on,
which producer version an attempt consumed, what a rejection invalidates, and
whether the run as a whole was accepted.

## Structural philosophy

The domain is a pure state machine. It performs no I/O, spawns nothing, and
reads no clock — every transition is a total function of the recorded facts.
That is what makes a run replayable: feeding the same transitions back in the
same order reconstructs the same state, so a resumed run cannot silently differ
from the run it continues.

Execution belongs elsewhere. `omp-agent` runs turns, `omp-envd` owns
filesystem and process authority, and `omp-journal` is the durable record. This
crate never reaches for them; a caller drives it, observes the effects through
those systems, and reports outcomes back. The separation is deliberate: the
scheduler stays testable without a provider, a sandbox, or a temp directory.

Acceptance is host-owned. The domain decides what *may* be accepted from the
evidence it was given; it cannot manufacture that evidence, which is why gate
results and review decisions arrive as recorded inputs rather than callbacks
this crate invokes.
