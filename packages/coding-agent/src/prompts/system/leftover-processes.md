<system-reminder>
Your bash calls left {{count}} process{{#if plural}}es{{/if}} running:
{{#each processes}}
- pid {{pid}} ({{kind}}, started {{age}} ago): `{{command}}`
{{/each}}

For each one, decide now:
- Keep it: register it with `o2ctl services add <name> <pid>` so it is supervised, listed and stoppable like any service.
- Otherwise kill it (`kill <pid>`) if you no longer need it.
{{#if hasAmpersand}}
`&` processes not registered as a service are killed when this session ends.
{{/if}}
{{#if hasNohup}}
`nohup` processes are never killed for you: if you keep one, it must be registered as a service.
{{/if}}
</system-reminder>
