<system-notice>
Record only: the user's side agent `{{agentId}}` {{#if failed}}failed{{else}}finished{{/if}}; the user already sees its outcome.
Request: {{request}}
Output: {{#if showAgentUrl}}agent://{{agentId}}, {{/if}}history://{{agentId}}
Its edits MAY appear in the working tree. Read its output only when the user's message refers to it.
</system-notice>
