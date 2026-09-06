<system-notice>
{{#if multiple}}{{jobs.length}} background jobs have finished. Resume your work using the results below.

{{else}}Background job {{escapeXml jobs.[0].jobId}}{{#if jobs.[0].label}} ({{escapeXml jobs.[0].label}}){{/if}} {{#if jobs.[0].failed}}failed{{else}}completed{{/if}}{{#if jobs.[0].bash}}{{#if jobs.[0].hasExitCode}} with exit code {{jobs.[0].exitCode}}{{else}}{{#if jobs.[0].failed}} without an exit code{{#if jobs.[0].timedOut}} (timed out){{/if}}{{/if}}{{/if}}{{/if}}. Resume your work using the result below.
{{/if}}{{#each jobs}}{{#if @root.multiple}}── Job {{escapeXml this.jobId}}{{#if this.label}} ({{escapeXml this.label}}){{/if}}: {{#if this.failed}}failed{{else}}completed{{/if}}{{#if this.bash}}{{#if this.hasExitCode}}, exit {{this.exitCode}}{{else}}{{#if this.failed}}, no exit code{{#if this.timedOut}} (timed out){{/if}}{{/if}}{{/if}}{{/if}} ──
{{/if}}{{#if this.progressSummarized}}Full output: artifact://{{this.artifactId}}{{#if this.hasLeftover}}
<output>
{{#if this.leftoverHead}}<head>
{{this.leftoverHead}}
</head>
{{#if this.leftoverSuppressed}}<suppressed reason="rate-limit" events="{{this.leftoverSuppressed}}" full-output="artifact://{{this.artifactId}}" />
{{else}}<suppressed reason="preview-limit" full-output="artifact://{{this.artifactId}}" />
{{/if}}<tail>
{{this.leftoverTail}}
</tail>
{{else}}{{this.leftoverText}}{{#if this.leftoverTruncated}}
<suppressed reason="preview-limit" full-output="artifact://{{this.artifactId}}" />{{/if}}
{{/if}}</output>
Remaining output since the last progress update; earlier output was already delivered.{{else}}
All output was already delivered as progress updates.{{/if}}{{#if this.terminalText}}
<result>
{{this.terminalText}}
</result>{{/if}}{{else}}{{this.result}}{{/if}}{{#if this.schemaStatus}}

Structured output: schema {{this.schemaStatus}}{{#if this.schemaError}}: {{this.schemaError}}{{/if}}{{#if this.hasStructuredData}}; full payload at agent://{{this.agentUrlId}}, fields via agent://{{this.agentUrlId}}?q=.<field>{{/if}}{{#unless this.schemaValid}}{{#if this.structuredJson}}; preview:
```json
{{this.structuredJson}}
```{{/if}}{{/unless}}{{/if}}{{#unless @last}}
{{/unless}}{{/each}}
</system-notice>
