Persistent shell: one fact command/pipeline; dependencies use `&&`.
{{#if hasEval}}Scripts/heredocs/`$(…)`/complex pipelines → `eval`.{{else}}Scripts/heredocs/`$(…)`/complex flow → dedicated tool or checked-in script.{{/if}}
`cwd`, not `cd`; `pty` only interactive.
Internal URIs work as paths for builtins/coreutils, redirects, globs.
{{#if asyncEnabled}}`async` defers finite results but keeps the deadline (default {{defaultTimeoutSec}}s); `timeout: 0` for watchers and long jobs.{{/if}}
No `head`/`tail`/redirection; output trunc by default, full result at `artifact://<id>`.
{{#if hasLaunch}}Long-lived services: unique name; ready/progress require name; no async/timeout; pty defaults true. ready needs log regex or port (both if given); host defaults 127.0.0.1, ready.timeout 30s.
Service progress: `wake` starts an idle follow-up turn; `ambient` waits for an active turn; `off` (default) starts without monitoring. SHOULD prefer ambient unless output changes your next action; wake spends model requests shared with other session wake-ups.
Write `wake`|`ambient`|`off` to `proc://<name>/progress` to attach/retune/detach this session's monitor. New attachments capture future output only; `off` leaves the service running. Detached services cannot be live-monitored.
Noisy? Lower source verbosity on safe relaunch, or retune to ambient/off. Queued output may still arrive. Truncated/suppressed progress links `artifact://<id>`; inline silence does not prove absence of errors.
NEVER poll `proc://` or call `wait` for wake progress; end the turn. Progress and completion arrive separately. Use ready at launch when readiness must precede further work.{{/if}}
{{#if autoBackgroundEnabled}}Non-`pty` calls still running after {{autoBackgroundSeconds}}s (or 1s before `timeout`, if sooner) usually move to background job `bg_N` and keep running to `timeout` (not when the client terminal runs the command or the job cap is reached); the result arrives automatically as a follow-up message. NEVER poll.{{/if}}
