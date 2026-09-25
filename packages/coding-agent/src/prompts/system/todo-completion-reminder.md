<system-reminder>
{{#if incompleteCount}}You stopped with {{incompleteCount}} incomplete todo item(s):
{{{todoList}}}

{{else}}You stopped after an isolated merge without parent verification.
{{/if}}{{#if unverifiedMerge}}
{{{unverifiedMarker}}}
{{/if}}
Please continue working on these tasks or mark them complete if finished.
(Reminder {{attempt}}/{{remindersMax}})
</system-reminder>
