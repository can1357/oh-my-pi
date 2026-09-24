Persistent shell: one fact command/pipeline; dependencies use `&&`.
{{#if hasEval}}Scripts/heredocs/`$(…)`/complex pipelines → `eval`.{{else}}Scripts/heredocs/`$(…)`/complex flow → dedicated tool or checked-in script.{{/if}}
`cwd`, not `cd`; `pty` only interactive.
{{#if hasSkills}}`skill://<name>` resolves instructions; other URIs paths.{{else}}Internal URIs paths.{{/if}}
{{#if asyncEnabled}}`async` defers finite results; timeout unchanged.{{/if}}
No `head`/`tail`/redirection; output trunc by default, full result at `artifact://<id>`.
{{#if hasLaunch}}Long-lived services: unique name; ready/env require name; no async/timeout. env adds variables; pty defaults true. ready needs log regex or port (both if given); host defaults 127.0.0.1, ready.timeout 30s.{{/if}}
{{#if autoBackgroundEnabled}}Background results follow; NEVER poll; foreground wait unchanged.{{/if}}
