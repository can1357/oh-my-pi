<todo-state>
Canonical todo state restored from the session journal. This state is authoritative, independent of any conversation summary. Preserve phase grouping and blocked/abandoned status; a successful child run alone does not prove that parent work was accepted.
{{#if empty}}
The todo list is intentionally empty. Do not recreate cleared work unless the user explicitly asks.
{{else}}
Overall: {{counts.in_progress}} in progress, {{counts.pending}} pending, {{counts.blocked}} blocked; {{counts.completed}} completed and {{counts.abandoned}} abandoned.
{{#each phases}}
- {{name}}: {{inProgress}} in progress, {{pending}} pending, {{blocked}} blocked; {{completed}} completed, {{abandoned}} abandoned.
{{#each tasks}}
  - [{{status}}] {{content}}{{#if blocker}} — blocker: {{blocker}}{{/if}}
{{/each}}
{{#if omitted}}
  - {{omitted}} additional open item(s) omitted.
{{/if}}
{{/each}}
{{#if omittedPhases}}
{{omittedPhases}} additional phase(s) omitted.
{{/if}}
This is a bounded reminder, not a replacement list. Labels and blocker notes may be shortened. Use `{{toolRefs.todo}}` with `op: "view"` for the complete canonical state before changing omitted or shortened work. Do not reopen abandoned items or treat blocked items as actionable without resolving their blocker.
{{/if}}
</todo-state>
