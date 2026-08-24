<system-notice>
{{#each jobs}}<job-progress id="{{escapeXml jobId}}"{{#if type}} type="{{type}}"{{/if}} elapsed="{{elapsed}}">
{{#if head}}<output>
<head>
{{escapeXml head}}
</head>
{{#if suppressedEvents}}<suppressed reason="rate-limit" events="{{suppressedEvents}}"{{#if artifactId}} full-output="artifact://{{artifactId}}"{{/if}} />
{{else}}<suppressed reason="preview-limit"{{#if artifactId}} full-output="artifact://{{artifactId}}"{{/if}} />
{{/if}}<tail>
{{escapeXml tail}}
</tail>
</output>
{{else}}{{#if hasOutput}}<output>
{{#if truncated}}{{#if suppressedEvents}}<suppressed reason="rate-limit" events="{{suppressedEvents}}"{{#if artifactId}} full-output="artifact://{{artifactId}}"{{/if}} />
{{else}}<suppressed reason="preview-limit"{{#if artifactId}} full-output="artifact://{{artifactId}}"{{/if}} />
{{/if}}{{/if}}{{escapeXml text}}
</output>
{{else}}{{#if suppressedEvents}}<output>
<suppressed reason="rate-limit" events="{{suppressedEvents}}"{{#if artifactId}} full-output="artifact://{{artifactId}}"{{/if}} />
</output>
{{/if}}{{/if}}{{/if}}
</job-progress>{{#unless @last}}
{{/unless}}{{/each}}{{#if wake}}
Resume your work using {{#if multiple}}these updates{{else}}this update{{/if}}.
{{/if}}
</system-notice>{{#if chattyGuidance}}
<system-reminder>
{{chattyGuidance}}
</system-reminder>{{/if}}
