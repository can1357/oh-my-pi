Resume autoresearch on the active session.

{{branch_status_line}}
{{#if has_resume_context}}

Additional context from the user:

{{resume_context}}
{{/if}}

- Use the active session context above as the source of truth for goal, scope, constraints, and run history.
- Inspect recent git history for context.
- Continue the most promising unfinished direction.
- Keep iterating until interrupted or until the configured iteration cap is reached.
