{{#if aborted}}
{{#if resumable}}
{{agentId}} was stopped but is still resumable — {{#if ircEnabled}}message it via `hub` to resume; {{/if}}{{#if transcriptAvailable}}transcript at history://{{agentId}}{{else}}transcript unavailable{{/if}}
{{else}}
{{agentId}} was aborted — {{#if transcriptAvailable}}transcript at history://{{agentId}}{{else}}transcript unavailable{{/if}}
{{/if}}
{{else}}
{{#if isolated}}
{{agentId}} ran isolated and cannot be resumed or messaged — transcript at history://{{agentId}}
{{else}}
{{agentId}} is now idle — {{#if ircEnabled}}message it via `hub` to follow up; {{/if}}transcript at history://{{agentId}}
{{/if}}
{{/if}}
