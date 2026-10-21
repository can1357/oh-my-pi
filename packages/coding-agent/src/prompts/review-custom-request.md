## Code Review Request

Mode: custom instructions.

## Distribution

Use `task` with a `tasks` array. Set `agent: "reviewer"` inside the `tasks[]` item (`tasks[].agent`), never at the top level or omitted. Create exactly **1 reviewer task**; assignment MUST include custom instructions.

## Reviewer Instructions

Reviewer MUST:
1. Follow custom instructions.
2. Read referenced files/workspace context needed to evaluate them.
3. Use incremental `yield` sections for findings and verdict fields; do NOT call a separate finding tool.

## Custom Instructions

{{instructions}}
