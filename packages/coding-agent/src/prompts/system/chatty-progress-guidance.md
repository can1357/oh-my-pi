Chatty progress: SHOULD lower source verbosity (quiet or warning-only) or filter to actionable lines; safe to retry → stop and relaunch quieter.
{{#if service}}
Service: {{#if procWrite}}retune its monitor without stopping it — write `ambient` or `off` to `proc://<name>/progress`.{{else}}retry unsafe → let it run.{{/if}}
{{/if}}
{{#ifAll bash procWrite}}
Bash: retune the job without stopping it — write `ambient` to `proc://<job-id>/progress`. Queued wake output still lands once; a job launched without `progress` cannot gain one, and a job's channel cannot be detached. Retry unsafe → let it finish.
{{else}}
{{#if bash}}
Bash: retry unsafe → let it finish.
{{/if}}
{{/ifAll}}
Suppression reports repeat this guidance a few times with increasing spacing, then stop.
