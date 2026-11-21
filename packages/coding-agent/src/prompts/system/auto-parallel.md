<system-reminder>
A classifier split this request into {{len subtasks}} subtasks that can run concurrently: items within a subtask are coupled; different subtasks touch separate code.
{{#each subtasks}}

Subtask {{add @index 1}}:
{{#each this}}
- {{this}}
{{/each}}
{{/each}}
{{#if context}}

Context every subtask needs:
{{#each context}}
- {{this}}
{{/each}}
{{/if}}
{{#if wrapup}}

After every subtask finishes, do yourself:
{{#each wrapup}}
- {{this}}
{{/each}}
{{/if}}

Settle cross-subtask contracts first, then delegate the subtasks in ONE parallel `{{taskTool}}` call, with the context in each assignment. The split is a guess: merge subtasks you find coupled; NEVER split one further.
</system-reminder>
