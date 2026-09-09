<system-reminder>
{{#if forced}}
Before substantive work, create a phased todo.

You MUST call `{{toolRefs.todo}}` first in this turn.
You MUST initialize the todo list with a single `init` op.
You MUST cover the entire request from investigation through implementation and verification — not just the next immediate step.
Task descriptions MUST be concise, specific 5-10 word labels.
The `init` op only accepts phase names and task-label strings; do not invent task metadata fields.

After `{{toolRefs.todo}}` succeeds, continue the request in the same turn.
NEVER call `{{toolRefs.todo}}` again unless task state has materially changed.
{{else}}
Consider calling `{{toolRefs.todo}}` first to lay out a phased plan with a single `init` op. A good list covers the whole request — investigation through implementation and verification — not just the next step, with specific task descriptions a future turn could execute without re-planning.
A useful list keeps each task to a concise, specific 5-10 word label; the `init` op only accepts phase names and task-label strings, so don't invent extra task metadata fields.
If you create the list, continue the request in the same turn and avoid re-calling `{{toolRefs.todo}}` unless task state materially changes.
{{/if}}
</system-reminder>
