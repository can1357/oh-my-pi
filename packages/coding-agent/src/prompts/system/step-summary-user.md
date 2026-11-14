{{#if request}}
Request: {{request}}
{{/if}}
{{#if earlier}}
Earlier steps: {{join earlier "; "}}
{{/if}}
{{#if thinking}}
Thinking: {{thinking}}
{{/if}}
{{#if said}}
Said: {{said}}
{{/if}}
{{#each calls}}
Call {{n}}: {{name}}{{#if intent}}, for: {{intent}}{{/if}} {{args}}
{{#if missing}}
Result {{n}}: (none)
{{else}}
Result {{n}}{{#if isError}} (error){{/if}}: {{default result "(empty)"}}
{{/if}}
{{/each}}
