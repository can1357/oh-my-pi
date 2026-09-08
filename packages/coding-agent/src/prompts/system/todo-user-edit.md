<system-reminder>
The user manually modified the todo list ({{action}}).
{{#if removed}}
{{#if empty}}
The user intentionally cleared the todo list. Do NOT recreate or re-populate it unless the user explicitly asks; continue the current request without a todo list.
{{else}}
The user intentionally removed the entries no longer shown below. Do NOT re-add them unless the user explicitly asks.
{{/if}}
{{/if}}
Current todo list:

{{markdown}}
</system-reminder>
