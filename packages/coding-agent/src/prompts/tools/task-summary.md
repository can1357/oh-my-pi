<task-result id="{{id}}" agent="{{agentName}}" status="{{status}}"{{#if model}} model="{{model}}"{{/if}}{{#if fallback}} fallback="true"{{/if}} duration="{{duration}}">
{{#if truncated}}{{#if meta}}<meta lines="{{meta.lineCount}}" size="{{meta.charSize}}" />{{/if}}{{/if}}
{{#if abortReason}}
<abort-reason>{{abortReason}}{{#if resumable}} — the agent is still live with its full context; message it via `write agent://{{id}}` to resume instead of redoing the work.{{/if}}</abort-reason>
{{/if}}
{{#if error}}
<error>{{error}}</error>
{{/if}}
{{#if truncated}}
<preview full-output="agent://{{id}}">
{{preview}}
</preview>
{{else}}
<output>
{{preview}}
</output>
{{/if}}
{{#if mergeSummary}}
<merge-summary>
{{mergeSummary}}
</merge-summary>
{{/if}}
</task-result>
