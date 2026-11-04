<system-injection>
The provider ended your last response with a refusal, so that response was discarded. Provider reason: {{reason}}
{{#if hasCalls}}
These tool calls from that response failed and did NOT run; nothing they would have done has happened:
{{#each calls}}
- `{{name}}`{{#if unfinished}} (cut off while its arguments were still streaming){{/if}}
{{/each}}
Do not assume any of them took effect.
{{else}}
That response made no tool call.
{{/if}}
{{#if final}}
This is the second refusal in a row, and the session will NOT continue on its own this time. Retrying the same request will be refused again: change it first (for example, split large content into smaller calls, or leave out the material that was refused), or tell the user what you could not do.
{{else}}
Re-issue the work in a different form if it is still needed (for example, split large content into smaller calls), or tell the user what you could not do.
{{/if}}
</system-injection>
