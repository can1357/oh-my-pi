**Reference tasks by verbatim content string, NEVER an auto-generated ID; pass content in `task`.**

Next pending task auto-promotes to `in_progress` on completion; `pending` is a status (not an `op`) — leave not-yet-started tasks implicit in `init`/`append`.

## Operations

|`op`|Required fields|Effect|
|`init`|`list: [{phase, items}]`|Initialize full list (replaces existing)|
|`start`|`task`|Set `in_progress`|
|`done`|`task` or `phase`|Set `completed`|
|`drop`|`task` or `phase`|Set `abandoned`|
|`rm`|`task`/`phase` (omit both → clear)|Remove|
|`append`|`phase`, `items`|Append tasks; lazily creates phase|
|`view`|—|Read-only: echo the list, no modify|

## Anatomy
- **Task content**: 5–10 words; what, not how; unique identifier.
- **Phase name**: short noun phrase (e.g. `Foundation`, `Auth`); unique identifier. NEVER prefix with `1.`, `A)`, or `Phase 1:`.

## Rules
- Create a list for 3+ step tasks, user-provided sets, or mid-task new instructions.
- Complete phases in order; keep `task`/`phase` strings stable.
- Blocked? `append` to active phase, or `drop`.
- Lost exact text? `view` echoes — NEVER guess; mismatched `task` is an error.

<critical>
Multi-step plan (phased todo, numbered/bulleted checklist, or "N bugs/items/tasks"):
- You MUST `init` with EVERY item as its own task before working.
- Enumerate all; NEVER summarize, sample "the important ones", drop items, or track the rest from memory.
</critical>
