## Code Review Request

Mode: headless review request.
{{#if repository}}

Repository: `{{repository}}` — not the session cwd; the reviewer MUST run version-control commands there and resolve `read` paths against it.
{{/if}}

Distribution: Use `task` with a `tasks` array. Set `agent: "reviewer"` inside the `tasks[]` item (`tasks[].agent`), never at the top level or omitted. Create exactly **1 reviewer task** for recent code changes.

{{#if focus}}
Focus: {{focus}}
{{/if}}
