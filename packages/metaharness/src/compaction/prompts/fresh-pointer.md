Your context was reset to keep it small. The {{archivedTurns}} turns moved out of it are archived in `{{transcript}}`: every message in order, with each tool output and every large tool-call argument stored as a separate file under `{{dir}}` that the transcript links to. Your work in `/workspace` is unchanged.{{#if selected}} Some older turns judged still relevant follow below verbatim, then the most recent turns.{{else}} The most recent turns follow below verbatim.{{/if}} Read the transcript or the linked files whenever you need earlier details.
{{#if index}}

Archived turns (numbered as in the transcript; ✗ marks a failed tool call):
{{index}}
{{/if}}
