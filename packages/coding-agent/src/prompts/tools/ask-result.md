{{#if timedOut}}No answer before the timeout; submitted the form's current values:{{else}}User answers:{{/if}}
{{json}}
{{#if notes}}
Option notes:
{{#each notes}}
- {{question}}: {{option}} [{{name}}={{jsonStringify value}}] — {{text}}
{{/each}}
{{/if}}
