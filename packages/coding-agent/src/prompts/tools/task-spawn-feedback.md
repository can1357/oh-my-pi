{{#if mixed}}Spawned {{count}} background agent{{#unless singular}}s{{/unless}}.{{scheduleFailureSummary}}{{else}}{{#if singleCall}}Spawned agent `{{agentId}}` (job `{{jobId}}`).{{#if checkout}} Its isolated changes apply to `{{checkout}}`.{{/if}}{{else}}Spawned {{count}} background agent{{#unless singular}}s{{/unless}} using {{agentLabel}}.{{scheduleFailureSummary}}{{/if}}{{/if}}
{{#if showListing}}{{#each started}}- `{{agentId}}` (job `{{jobId}}`){{#if checkout}}, isolated changes apply to `{{checkout}}`{{/if}}
{{/each}}{{/if}}
