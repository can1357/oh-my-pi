{{#if mixed}}
Spawned {{count}} background agent{{#unless singular}}s{{/unless}}.{{scheduleFailureSummary}}
{{else}}
{{#if singleCall}}
Spawned agent `{{agentId}}` (job `{{jobId}}`).
{{else}}
Spawned {{count}} background agent{{#unless singular}}s{{/unless}} using {{agentLabel}}.{{scheduleFailureSummary}}
{{/if}}
{{/if}}
{{#if showListing}}{{#each started}}- `{{agentId}}` (job `{{jobId}}`)
{{/each}}{{/if}}
{{#if lifecycle}}
read proc:// lists jobs/services; read proc://<id> inspects status/output without consuming delivery; write proc://<id>/kill with empty `content` cancels/stops.
Job IDs are process-local; delivered results expire shortly (~30s), unconsumed results within ~5min. Agent output/transcripts remain readable at agent://<id> / history://<id>.{{#if ircEnabled}} write agent://<id> messages a live agent.{{/if}}
{{/if}}
