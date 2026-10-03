{{#if previousHuman}}
<previous-user-message purpose="referent context only, never evidence">
{{previousHuman}}
</previous-user-message>
{{/if}}
{{#if assistantContext}}
<assistant-context purpose="referent context only, never evidence">
{{assistantContext}}
</assistant-context>
{{/if}}
<user-prompt>
{{prompt}}
</user-prompt>
