Chatty progress: lower source verbosity (quiet or warning-only) or filter to actionable lines; safe to retry → stop and relaunch quieter.
{{#if hub}}
Hub: retune a chatty process without stopping it — `op: "monitor"` with `progress: "ambient"` or `"off"`.
{{/if}}
{{#ifAll bash hubTool}}
Bash: retune a chatty job without stopping it — `hub` `op: "monitor"` with `ids: ["<job-id>"]` and `progress: "ambient"`. Queued wake output still lands once; a job launched without `progress` cannot gain one, and a job's channel cannot be detached. Retry unsafe → let it finish.
{{else}}
{{#if bash}}
Bash: retry unsafe → let it finish.
{{/if}}
{{/ifAll}}
Suppression reports repeat this guidance a few times with increasing spacing, then stop.
