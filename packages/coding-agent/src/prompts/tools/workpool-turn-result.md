Pool `{{pool}}` · agent `{{agent}}` · batch `{{batch}}` {{status}} ({{count}} item{{#if multiple}}s{{/if}}):
{{#each items}}- [{{id}}] {{status}} — {{text}}
{{/each}}
{{output}}
{{#if remaining}}{{remaining}} item(s) still queued or running in this pool.{{else}}Pool queue drained.{{/if}} Transcript: history://{{agent}} · full output: agent://{{agent}}
