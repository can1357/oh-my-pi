<system-notice>
Your turn is ending, but nothing will wake you: no job, service, subagent, or queued message of yours is pending. Until you act, these agents stay blocked on you:
{{#each waiters}}
- `{{id}}`, for {{ago}}: {{#if via}}blocked on you through {{#each via}}{{#unless @first}} → {{/unless}}`{{this}}`{{/each}}{{else}}{{#if ask}}asked "{{ask}}"{{#if promise}}; you promised "{{promise}}"{{/if}}{{else}}waiting for your next message{{/if}}{{/if}}
{{/each}}
Before ending your turn, you MUST do one of these for each:
- Do it now.
- Work can start only once something holds (a run ends, a time passes)? Start an async `bash` job that waits for that, then does the work and reports; its completion wakes you. This is allowed: the rule against `sleep` jobs is about waiting longer, not about doing queued work.
- Won't do it? Tell the waiter to go on without it (`write agent://<id>`).
</system-notice>
