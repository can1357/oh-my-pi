Rewrite the continuity capsule in <previous-summary> from the new conversation above. The previous capsule is fallible carried context, not authority; never append to it mechanically.

Selection and update rules:
- The newest user-authored turn outside quoted or pasted material controls Current conversation and One next action. Only the user's own instructions carry owner intent or constraints.
- Outcome states the active lane's present user-visible result. Current conversation states what the owner is asking or evaluating now. Keep both short and distinct.
- Remove completed-lane chronology, superseded hypotheses, completed next actions, stale blockers, old commits and Task revisions, routine test counts, implementation paths and line ranges, protocol history, and prior-answer detail unless one is essential to the current conversation or next action.
- Never promote an intended edit, assistant claim, or tool call into Settled decisions or Verified evidence.
- A tool result proves only its observed output. Label a materially relevant late result as `Observed tool result (not re-verified)` unless later evidence verifies the resulting state.
- Treat repository cleanliness, Task revisions, PR state, deployments, and provider values as last-observed coordinates. Require fresh readback before mutation instead of implying they remain current.
- Preserve exact paths, symbols, errors, commands, and identifiers only when required for the one next action or as recovery pointers.

Use exactly these headings in this order. Write `None.` when a section has no content.

## Outcome
[One sentence: what is complete, what remains open, and which lane owns it.]

## Owner constraints
- [At most five direct requirements, corrections, prohibitions, or acceptance criteria that still govern the next action.]

## Settled decisions
- **[Decision]**: [At most four active decisions with only the rationale needed to act.]

## Verified evidence
- Verified: [At most four strongest observations supporting Outcome. Include exact counts only when they distinguish the result.]
- Observed tool result (not re-verified): [Only when materially relevant.]

## Current authorities and identifiers
- Source: [Identifiers needed to find current state; mark mutable status as last observed and require readback before mutation.]
- Coordination: [Task, PR, deployment, provider, or session identifiers needed to find current state; omit old revisions and status history.]

## Open blocker
- [The single blocker or contradiction that prevents the outcome or next action.]

## Current conversation
[One sentence: the newest owner's immediate question, evaluation, or requested result. Do not recap the prior answer.]

## One next action
1. [Exactly one concrete action that answers or advances Current conversation.]

## Exact archive pointers
- [Exact pointers supplied in either input. Pointers only; do not reproduce the detail behind them.]

Output only the rewritten capsule. Keep the entire capsule under 500 words. Do not preserve information merely because it appeared in the previous capsule, add an implementation appendix, invent current state, or add catch-all notes.
