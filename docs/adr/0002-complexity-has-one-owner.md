# 0002. Push hard problems down into the engine

Status: accepted
Date: 2026-09-02
Area: foundations

## Context

omp v1 and pi were pleasant to extend because the engine was thin. That thinness was not
simplicity; it was displacement. By the law of conservation of complexity, the parts the engine
did not own were carried by extensions and users: every stateful extension hand-rolled its own
journal derivation, every tool invented its own truncation notice, every renderer re-parsed ANSI,
every provider quirk lived in a call-site branch. The evidence is concrete:

- 17 of 78 official pi extension examples hold state; 2 are correct under rewind/resume (Appendix
  A of the playbook; 0003).
- One `.includes` scan for image lines cost ~20% of a session's CPU in pi's renderer (0030).
- OpenAI compatibility had grown to ~880 lines of nested provider-name booleans, duplicated across
  four more files (0017).
- Two "workflow" extensions from one author needed a private mutex protocol to coexist; no third
  party could join it (0015).

The misread of "simple good, complex bad": Dijkstra's simplicity is a prerequisite for the
implementer's reasoning, Brooks's essential complexity cannot be abstracted away, Hickey's
complexity is interleaving — none of them license the engine to make every caller carry a slightly
different copy of the same hard problem. Ousterhout's rule is the operative one: module writers
take on the suffering so that callers do not.

## Decision

Unavoidable complexity MUST have exactly one owner, and that owner is the engine layer that can
enforce the invariant — never the extension author, the tool author, the prompt, or the user.

Applied as a review test:

- If a correctness property (replayability, bounded output, cancellation, sanitized presentation,
  provider compatibility) depends on every extension author remembering to do something, the
  design is wrong. Make the incorrect state unrepresentable instead (0003, 0008, 0009, 0030).
- A helper that fixes a recurring failure MUST become mandatory in the primitive, not remain an
  optional utility beside it (0009, 0010).
- "It's only 30% of the feature" implementations copied into shells, prompts, extensions, and
  failed tool calls count as the same complexity with no owner. Own it once, deep (0027, 0028).
- Documentation is NEVER the fix for a distribution of bugs that the API permits.

## Consequences

- Engine primitives are deliberately deep: `Read`, `Bash`, the tool-call element, the render
  pipeline, the compatibility compiler. Their internals are harder to write and easier to use.
- Extensions get fewer knobs and a smaller surface; the surface they get composes.
- Cost accepted: a first-time contributor sees more machinery in the engine than a "while loop
  around fetch" would show. That is the machinery that used to be scattered.

## Status in omp

**Implemented.** Primary implementation: `crates/agent/src/lib.rs`. The new spine assigns journal/DOM state, dispatch, presentation, and configuration to single engine owners.

## References

- The Harness Playbook, introduction ("Unavoidable complexity needs an owner")
- Ousterhout, CS190 modular design lecture notes ("embrace suffering")
- Brooks, "No Silver Bullet"; Hickey, "Simple Made Easy"
- 0001 for the envelope these owners must satisfy
