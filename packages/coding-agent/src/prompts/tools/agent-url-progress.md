# {{id}} ({{status}})

No final output yet: `agent://{{id}}` shows progress until the run publishes its output. Full transcript: `history://{{id}}`.
{{#each sections}}

## Yield{{#if labels}} [{{labels}}]{{/if}}

```json
{{data}}
```
{{/each}}
{{#if lastText}}

## Latest assistant text

{{lastText}}
{{/if}}
{{#if empty}}

Nothing produced yet.
{{/if}}
