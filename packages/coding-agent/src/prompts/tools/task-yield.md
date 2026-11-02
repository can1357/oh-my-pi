Returned early so you can read an incoming message. {{#if singular}}This blocking agent keeps running as a background job{{else}}These blocking agents keep running as background jobs{{/if}}:
{{#each continuing}}- `{{agentId}}` (job `{{jobId}}`)
{{/each}}{{#if singular}}Its result arrives{{else}}Their results arrive{{/if}} on {{#if singular}}its{{else}}their{{/if}} own; NEVER poll.{{#if waitTool}} Call `wait` to block on {{#if singular}}it{{else}}them{{/if}} once the message is handled.{{/if}}
