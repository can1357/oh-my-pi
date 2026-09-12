<system-notice>
{{#if multiple}}{{jobs.length}} background jobs have completed. Resume your work using the results below.

{{else}}Background job {{jobs.[0].jobId}} has completed. Resume your work using the result below.
{{/if}}{{#each jobs}}{{#if @root.multiple}}── Job {{this.jobId}}{{#if this.label}} ({{this.label}}){{/if}} ──
{{/if}}{{this.result}}{{#if this.schemaStatus}}

Structured output: schema {{this.schemaStatus}}{{#if this.schemaError}}: {{this.schemaError}}{{/if}}{{#if this.hasStructuredData}}; full payload at agent://{{this.agentUrlId}}, fields via agent://{{this.agentUrlId}}?q=.<field>{{/if}}{{#unless this.schemaValid}}{{#if this.structuredJson}}; preview:
```json
{{this.structuredJson}}
```{{/if}}{{/unless}}{{/if}}{{#unless @last}}
{{/unless}}{{/each}}
</system-notice>
