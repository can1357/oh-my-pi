{{#if aborted}}
{{#if resumable}}
{{agentId}} was stopped but is still resumable — {{#if ircEnabled}}message it via `write agent://{{agentId}}` to resume; {{/if}}{{#if transcriptAvailable}}transcript at history://{{agentId}}{{else}}transcript unavailable{{/if}}
{{else}}
{{agentId}} was aborted — {{#if transcriptAvailable}}transcript at history://{{agentId}}{{else}}transcript unavailable{{/if}}
{{/if}}
{{else}}
{{#if isolated}}
{{agentId}} ran isolated and cannot be resumed or messaged — transcript at history://{{agentId}}
{{else}}
{{#if resumable}}
{{agentId}} is now idle — {{#if ircEnabled}}message it via `write agent://{{agentId}}` to follow up; {{/if}}transcript at history://{{agentId}}
{{else}}
{{agentId}} stopped and cannot be messaged — {{#if transcriptAvailable}}transcript at history://{{agentId}}{{else}}transcript unavailable{{/if}}
{{/if}}
{{/if}}
{{/if}}
