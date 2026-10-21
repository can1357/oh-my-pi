## Code Review Request

Mode: headless review request.

Distribution: Use `task` with a `tasks` array. Set `agent: "reviewer"` inside the `tasks[]` item (`tasks[].agent`), never at the top level or omitted. Create exactly **1 reviewer task** for recent code changes.

{{#if focus}}
Focus: {{focus}}
{{/if}}
