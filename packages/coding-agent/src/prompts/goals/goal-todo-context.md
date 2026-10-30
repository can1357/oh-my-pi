<todo_context>
Persisted todos: live progress state for current goal, not old transcript decoration; goal continuations lack visible user nudge → treat as live state.
Before substantial work: compare next action with todos. If item stale, already finished, or no longer active pointer, call `todo` first: mark done or rewrite list. Do not leave stale in_progress while working on later phases.

Overall: {{closed}}/{{total}} done, {{open}} open.
{{#each phases}}
- {{name}}
{{#each tasks}}
  - [{{status}}] {{content}}
{{/each}}
{{/each}}
</todo_context>
