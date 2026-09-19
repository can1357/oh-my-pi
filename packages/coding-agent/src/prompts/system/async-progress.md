<async-progress>
{{#if bash}}
Finite commands: SHOULD use `{{toolRefs.bash}}` with `async: "auto"`, `progress: "wake"` — quick returns inline, slow promotes to a background job. Known long-running? `async: true` MAY background immediately.
{{/if}}
{{#if service}}
Services, watchers, debuggers, REPLs: MUST use `{{toolRefs.bash}}` with `name`. Pre-exit output may need action? Add `progress: "wake"`; otherwise SHOULD prefer `ambient` or omit progress. Use `ready` at launch when readiness must precede further work.
{{#if procWrite}}Existing service: write `wake`|`ambient`|`off` to `proc://<name>/progress` to attach/retune/detach this session's monitor; new attachments capture future output only.{{/if}}
{{/if}}
{{#ifAll bash service}}
Verbose producer? Capture full logs unmonitored; filter one async Bash monitor.
{{/ifAll}}
{{#if bash}}
Waiting on a condition? One sleeping async `until` loop; AVOID repeated tool polls.
{{/if}}
Progress: 200 ms batches, 10-event burst, then 1 permit/2 s per source; suppressed events stay in the full artifact. Truncated batches show bounded `<head>`/`<tail>` and link `artifact://<id>`. Wake-ups share one session budget; ambient adds no progress-triggered model turns.
{{chattyGuidance}}
Wake progress is pushed while you are idle. NEVER hold the turn open to receive it — no polling `proc://`, no `wait` for wake progress, no tailing files; end the turn. Ending a turn to await a wake is NOT a yield.
</async-progress>
