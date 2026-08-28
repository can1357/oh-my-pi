<system-reminder>
You stopped with {{incompleteCount}} incomplete todo item(s):
{{todoList}}

{{#if afterReminderBudget}}
Do not close with prose. Use the todo tool now to mark work done, blocked, or abandoned, then continue the next actionable task.
{{#unless forcedTodo}}A todo tool call is required before a terminal answer.
{{/unless}}
{{else}}
Please continue working on these tasks or mark them complete if finished.
(Reminder {{reminderCount}}/{{remindersMax}})
{{/if}}
</system-reminder>
