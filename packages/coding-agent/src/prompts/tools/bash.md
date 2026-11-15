Persistent bash 5.3.
cwd will reset after each turn, don't rely on cd; `pty` = interactive.
Internal URIs work as paths for builtins/coreutils, redirects, globs.
In-process builtins, ahead of PATH: {{join builtins ", "}}.
{{#if asyncEnabled}}
`async` defers finite results but keeps the deadline (default {{defaultTimeoutSec}}s); `timeout: 0` for watchers and long jobs.
{{/if}}
Don't trunc output by habit, result will be summarized and saved as an artifact.
{{#if hasLaunch}}
Long-lived services:
- unique name; ready requires name; no async/timeout; pty defaults true.
- ready needs log regex or port (both if given); host defaults 127.0.0.1, ready.timeout 30s.
{{/if}}
{{#if autoBackgroundEnabled}}
Non-`pty` calls still running after {{autoBackgroundSeconds}}s (or 1s before `timeout`, if sooner) usually move to background job `bg_N` and keep running to `timeout`.
No backgrounding when the client terminal runs the command or the job cap is reached.
The result arrives automatically as a follow-up message. NEVER poll.
{{/if}}
