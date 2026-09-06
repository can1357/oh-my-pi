Chatty progress: lower source verbosity (quiet or warning-only) or filter to actionable lines; safe to retry → stop and relaunch quieter.
{{#if hub}}
Hub: retune a chatty process without stopping it — `op: "monitor"` with `progress: "ambient"` or `"off"`.
{{/if}}
{{#if bash}}
Bash: a job's `progress` is fixed at launch; retry unsafe → let it finish.
{{/if}}
Suppression reports repeat this guidance a few times with increasing spacing, then stop.
