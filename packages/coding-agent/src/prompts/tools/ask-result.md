{{#if interrupted}}Ask interrupted by message. Answers the user gave before it:{{else}}{{#if timedOut}}No answer before the timeout; submitted the form's current values:{{else}}User answers:{{/if}}{{/if}}
{{json}}
{{#if notes}}
Option notes:
{{#each notes}}
- {{question}}: {{option}} [{{name}}={{jsonStringify value}}] — {{text}}
{{/each}}
{{/if}}
