Persistent shell: one fact command/pipeline; dependencies use `&&`.
{{#if hasEval}}Scripts/heredocs/`$(…)`/complex pipelines → `eval`.{{else}}Scripts/heredocs/`$(…)`/complex flow → dedicated tool or checked-in script.{{/if}}
`cwd`, not `cd`; `pty` only interactive.
Internal URIs work as paths for builtins/coreutils, redirects, globs.
{{#if asyncEnabled}}Finite commands: `async: "auto"` stays inline for {{asyncAutoInlineGraceMs}} ms, then promotes the same process; `async: true` backgrounds immediately. Timeout unchanged; `timeout` ≤ grace + 1 s stays inline. Tune `bash.asyncAuto.inlineGraceMs` (`0` = promote immediately). At the job cap: auto runs inline with a notice; true errors. Auto rejects `pty: true`.
Finite `progress` requires async true/auto: `wake` starts an idle follow-up; `ambient` waits for an active turn. Delivery starts only after backgrounding. Write wake/ambient to `proc://<job-id>/progress` to retune; jobs reject off and cannot gain progress after launch.{{/if}}
No `head`/`tail`/redirection; output trunc by default, full result at `artifact://<id>`.
{{#if hasLaunch}}Long-lived services: unique name; ready/env require name; no async/timeout. env adds variables; pty defaults true. ready needs log regex or port (both if given); host defaults 127.0.0.1, ready.timeout 30s.
Service progress: `wake` starts an idle follow-up turn; `ambient` waits for an active turn; `off` (default) starts without monitoring. SHOULD prefer ambient unless output changes your next action; wake spends model requests shared with other session wake-ups.
Write `wake`|`ambient`|`off` to `proc://<name>/progress` to attach/retune/detach this session's monitor. New attachments capture future output only; `off` leaves the service running. Detached services cannot be live-monitored.
Noisy? Lower source verbosity on safe relaunch, or retune to ambient/off. Queued output may still arrive. Use ready at launch when readiness must precede further work.{{/if}}
Truncated/suppressed progress links `artifact://<id>`; inline silence does not prove absence of errors.
NEVER poll `proc://` or call `wait` for wake progress; end the turn. Progress and completion arrive separately.
{{#if autoBackgroundEnabled}}Background results follow; NEVER poll; foreground wait unchanged.{{/if}}
