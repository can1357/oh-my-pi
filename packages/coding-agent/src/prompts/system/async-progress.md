<async-progress>
{{#if bash}}
Finite commands: SHOULD use `{{toolRefs.bash}}` with `async: "auto"`, `progress: "wake"` — quick returns inline, slow promotes to a background job. Known long-running? `async: true` MAY background immediately.
{{/if}}
{{#if hub}}
Process output that may need action: `{{toolRefs.hub}}` with `progress: "wake"` (`op: "start"` new; `op: "monitor"` existing). `wait` with `name` + `pattern`/`for`/`timeout` MAY block for readiness or exit.
{{/if}}
{{#ifAll bash hub}}
Verbose producer? Capture full logs unmonitored; filter one async Bash monitor.
{{/ifAll}}
{{#if bash}}
Waiting on a condition? One sleeping async `until` loop; AVOID repeated tool polls.
{{/if}}
Progress: 200 ms batches, 10-event burst, then 1 permit/2 s; suppressed events stay in the full artifact. Truncated batches show bounded `<head>`/`<tail>` and link `artifact://<id>`.
{{chattyGuidance}}
Progress is pushed while you are idle. NEVER hold the turn open to receive it — no polling{{#if hub}} (`logs`, `ps`, short `wait` loops){{/if}}, no tailing files; end the turn.
</async-progress>
