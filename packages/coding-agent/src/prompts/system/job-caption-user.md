<job>
{{#if intent}}
Why it was started: {{intent}}
{{/if}}
{{#if timeoutSec}}
Killed after: {{timeoutSec}}s
{{else}}
Timeout: none
{{/if}}
Command:
```
{{command}}
```
</job>
