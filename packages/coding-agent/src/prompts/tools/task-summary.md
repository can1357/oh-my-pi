<task-result id="{{id}}" agent="{{agentName}}" status="{{status}}" duration="{{duration}}">
{{#if meta}}<meta lines="{{meta.lineCount}}" size="{{meta.charSize}}" />{{/if}}
{{#if abortReason}}
<abort-reason>{{abortReason}}{{#if resumable}} — the agent is still live with its full context; message it via `hub` to resume instead of redoing the work.{{/if}}</abort-reason>
{{/if}}
{{#if modelReceipt}}
<model-receipt>
{{#if modelReceipt.requestedModel}}<requested-model>{{#each modelReceipt.requestedModel}}{{this}}{{#unless @last}}, {{/unless}}{{/each}}</requested-model>
{{/if}}{{#if modelReceipt.requestedRole}}<requested-role>{{modelReceipt.requestedRole}}</requested-role>
{{/if}}{{#if modelReceipt.resolvedModel}}<resolved-model>{{modelReceipt.resolvedModel}}</resolved-model>
{{/if}}{{#if modelReceipt.requestedEffort}}<requested-effort>{{modelReceipt.requestedEffort}}</requested-effort>
{{/if}}{{#if modelReceipt.resolvedEffort}}<resolved-effort>{{modelReceipt.resolvedEffort}}</resolved-effort>
{{/if}}{{#if modelReceipt.overrides}}<overrides>{{#each modelReceipt.overrides}}<reason>{{this}}</reason>{{/each}}</overrides>
{{/if}}</model-receipt>
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
