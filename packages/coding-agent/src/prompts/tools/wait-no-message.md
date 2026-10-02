No message within {{elapsed}}{{#if peers.length}}; still running: {{#each peers}}`{{this}}`{{#unless @last}}, {{/unless}}{{/each}}{{#if more}} (+{{more}} more){{/if}}{{/if}}.
{{#if awaitedBy}}`{{awaitedBy}}` is blocked waiting on your result: ask it via `agent://{{awaitedBy}}` for what you need, or `yield`.{{else}}{{#if peers.length}}Need something from one? Ask via `agent://<id>`.{{/if}}{{/if}}
