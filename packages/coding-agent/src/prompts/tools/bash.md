Persistent shell: one fact command/pipeline; dependencies use `&&`.
{{#if hasEval}}Scripts/heredocs/`$(…)`/complex pipelines → `eval`.{{else}}Scripts/heredocs/`$(…)`/complex flow → dedicated tool or checked-in script.{{/if}}
`cwd`, not `cd`; `pty` only interactive.
Internal URIs work as paths for builtins/coreutils, redirects, globs.
{{#if asyncEnabled}}Finite commands: `async: "auto"` stays inline for {{asyncAutoInlineGraceMs}} ms, then promotes the same process; `async: true` backgrounds immediately. Timeout unchanged; `timeout` ≤ grace + 1 s stays inline. Tune `bash.asyncAuto.inlineGraceMs` (`0` = promote immediately). At the job cap: auto runs inline with a notice; true errors. Auto rejects `pty: true`.
Finite `progress` requires async true/auto: `wake` starts an idle follow-up; `ambient` waits for an active turn. Delivery starts only after backgrounding.{{#if hasWrite}} Write wake/ambient to `proc://<job-id>/progress` to retune; jobs reject off and cannot gain progress after launch.{{/if}}{{/if}}
NEVER use `head`/`tail`/redirection; output truncates by default, full result at `artifact://<id>`.
{{#if hasLaunch}}Long-lived services: MUST use a unique name; ready/env require name; no async/timeout. A live name restarts with the new spec. env adds variables; pty defaults true. ready needs log regex or port (both if given); host defaults 127.0.0.1, ready.timeout 30s.
{{#if hasProcessProgress}}Service progress: `wake` starts an idle follow-up turn; `ambient` waits for an active turn; `off` (default) starts without monitoring. SHOULD prefer ambient unless output changes your next action; wake spends model requests shared with other session wake-ups.
{{#if hasWrite}}Write `wake`|`ambient`|`off` to `proc://<name>/progress` to attach/retune/detach this session's monitor. New attachments capture future output only; `off` leaves the service running.{{/if}} Detached services cannot be live-monitored.
Noisy? SHOULD lower source verbosity on safe relaunch{{#if hasWrite}}, or retune to ambient/off{{/if}}. Queued output may still arrive.
{{else}}Live service progress is unavailable in this session; omit progress.{{/if}}
Use ready at launch when readiness must precede further work.{{/if}}
{{#ifAny asyncEnabled hasProcessProgress}}Truncated/suppressed progress links `artifact://<id>`; inline silence does not prove absence of errors.
NEVER poll `proc://` or call `wait` for wake progress; end the turn. Progress and completion arrive separately.{{/ifAny}}
{{#if autoBackgroundEnabled}}Background results follow; NEVER poll; foreground wait unchanged.{{/if}}
