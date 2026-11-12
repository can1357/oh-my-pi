{{#each steps}}
# Step {{number}} of {{total}}
{{text}}
{{/each}}
{{#if last}}
Last {{#if multiple}}steps{{else}}step{{/if}}: your {{#if structured}}terminal `yield`{{else}}final message{{/if}} is the result of the whole assignment and MUST cover every step.
{{else}}
Do ONLY {{#if multiple}}these steps{{else}}this step{{/if}}, then report {{#if structured}}with a terminal `yield`{{else}}as your final message{{/if}}. Step {{next}} arrives after; NEVER start it early.
{{/if}}
