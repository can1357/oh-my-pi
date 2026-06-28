**Tasks referenced by verbatim content string, NEVER an auto-generated ID — no "task-1"/"task-N" exists. Pass the content text in the `task` field.**

On each completion the earliest still-open task (in phase order) auto-promotes to `in_progress`. Completing tasks out of phase order can move this pointer **back** to an earlier phase — that is expected; completed tasks are never reverted.

## Operations

|`op`|Required fields|Effect|
|---|---|---|
|`init`|`list: [{phase, items: string[]}]`|Initialize full list (replaces existing)|
|`init`|`items: string[]`|Flattened single-phase init|
|`start`|`task`|Mark in progress|
|`done`|`task` or `phase`|Mark completed|
|`drop`|`task` or `phase`|Mark abandoned|
|`rm`|`task` or `phase` (optional)|Remove task or phase's tasks; omit both to clear the list|
|`append`|`phase`, `items: string[]`|Append tasks to `phase`; lazily creates phase|
|`view`|—|Read-only: echo the list, no modify|

## Anatomy
- **Task content**: 5–10 words; what, not how. Unique identifier.
- **Phase name**: short noun phrase (e.g. `Foundation`, `Auth`, `Verification`). Unique identifier. NEVER prefix `1.`, `A)`, `Phase 1:`.

## Rules
- Mark tasks done immediately after finishing.
- Complete phases in order.
- Blocked? `append` a task to the active phase to unblock, or `drop`.
- Keep `task`/`phase` strings stable once introduced.
- Lost the exact task text? `view` echoes the list — NEVER guess from memory; a mismatched `task` string is an error.

## When to create a list
- Task requires 3+ distinct steps
- User explicitly requests one
- User provides a set of tasks
- New instructions arrive mid-task — capture before proceeding

<critical>
User hands you a multi-step plan — phased todo, numbered/bulleted checklist, or "N bugs/items/tasks":
- You MUST `init` the list with EVERY item as its own task before working.
- Enumerate all; NEVER summarize into fewer tasks, sample "the important ones", drop items, or track the rest from memory.
</critical>
