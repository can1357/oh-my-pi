<task-result id="{{id}}" agent="{{agentName}}" status="{{status}}" duration="{{duration}}">
{{#if meta}}<meta lines="{{meta.lineCount}}" size="{{meta.charSize}}" />{{/if}}
{{#if modelReceipt}}
<model-receipt{{#if modelReceipt.requestedModel}} requested-model="{{modelReceipt.requestedModel}}"{{/if}}{{#if modelReceipt.requestedEffort}} requested-effort="{{modelReceipt.requestedEffort}}"{{/if}}{{#if modelReceipt.model}} model="{{modelReceipt.model}}"{{/if}}{{#if modelReceipt.thinking}} thinking="{{modelReceipt.thinking}}"{{/if}} reasons="{{modelReceipt.reasons}}" />
{{/if}}
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
