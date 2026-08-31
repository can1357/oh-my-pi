Rewrite the continuity capsule in <previous-summary> from the new conversation above. The previous capsule is fallible carried context, not authority; never append to it mechanically.

Update rules:
- The newest user-authored instruction outside quoted or pasted material controls intent. Preserve still-applicable owner constraints exactly enough to act.
- Remove superseded hypotheses, completed next actions, stale blockers, obsolete cleanup reminders, and implementation chronology.
- Never promote an intended edit, assistant claim, or tool call into Settled decisions or Verified evidence.
- A tool result proves only its observed output. Label a materially relevant late result as `Observed tool result (not re-verified)` unless later evidence verifies the resulting state.
- Treat source, Task, PR, deployment, and provider values as last-observed coordinates. Do not imply they remain current without live readback.
- If the newest messages end with an unanswered user request, preserve it exactly as the single Next action.
- Preserve exact paths, symbols, errors, commands, and identifiers only when needed to resume or verify the lane.

Use exactly these headings in this order. Write `None.` when a section has no content.

## Current outcome
[One short statement of the user-visible outcome and current lane state.]

## Owner constraints
- [Direct owner requirements, corrections, prohibitions, and acceptance criteria.]

## Settled decisions
- **[Decision]**: [Short rationale.]

## Verified evidence
- Verified: [Observed behavior, test, command, or provider result.]
- Observed tool result (not re-verified): [Only when relevant.]

## Working identities
- Source: [repository, checkout, branch, commit, and dirty state last observed.]
- Coordination: [Task, PR, deployment, provider, or session coordinates last observed.]

## Unresolved contradictions
- [Conflict, uncertainty, blocker, or stale state that still matters.]

## Next action
1. [Exactly one concrete action that advances the active lane.]

## Archive pointers
- [Exact artifact, transcript, history, or other evidence pointers supplied in either input.]

Output only the rewritten capsule. Keep it under 1,200 words. Do not preserve information merely because it appeared in the previous capsule, copy large tool outputs, invent current state, or add catch-all notes.
