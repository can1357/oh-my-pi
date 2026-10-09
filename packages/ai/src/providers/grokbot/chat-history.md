Answer this text-only chat request. Do not execute commands or use tools. Use the supplied conversation as context and respond to its latest user message.

{{#each systemPrompts}}
[System]
{{{this}}}

{{/each}}
{{#each messages}}
[{{role}}]
{{#each parts}}
{{#if text}}{{{text}}}{{/if}}
{{#if toolName}}Tool call: {{{toolName}}}
Arguments: {{{arguments}}}{{/if}}
{{/each}}

{{/each}}
