{{#if eagerTasksAlways}}
TASK_BRANCH=always
{{else}}
{{#if eagerTasks}}
TASK_BRANCH=eager
{{else}}
TASK_BRANCH=default
{{/if}}
{{/if}}
