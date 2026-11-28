Persistent bash 5.3.
Each call starts in the session cwd with `set -e` off{{#if hasPty}}; `pty` = interactive{{/if}}.
Internal URIs work as paths for builtins/coreutils, redirects, globs.
In-process builtins, ahead of PATH: {{join builtins ", "}}.
{{#if asyncEnabled}}
`async` defers finite results but keeps the deadline (default {{defaultTimeoutSec}}s); `timeout: 0` for watchers and long jobs.
`notify` (regex; implies `async`) sends each matching output line as a follow-up while the job runs, ahead of its result. Match only lines you'd act on: too many matches switch it off.
{{/if}}
Don't trunc output by habit, result will be summarized and saved as an artifact.
{{#if approvalPatternsActive}}
`bash.patterns` allow rules auto-approve only one plain, parseable command. These force a prompt: unquoted `|`, `;`, `&`, `<`, `>`, `(`, `)`, `{a,b}`, `#` comments or line breaks; `$` expansions (`$VAR`, `${…}`, `$(…)`, `$((…))`) or backticks outside single quotes; a `!`/`time` prefix; a glob in the command name{{#if allowCompoundCommands}}. Exception: a one-line `&&` chain of literal commands that each match an allow rule (no globs, leading `~`, `cd`/`export`/other shell-state builtins, or `sh`/`env`/`sudo`-style wrappers){{/if}}. `$'…'` counts as literal. Prefer separate or parallel calls over pipes, loops and redirects; pass multi-line text single-quoted, not via heredoc or `$(…)`.
{{/if}}
{{#if hasLaunch}}
Long-lived services:
- unique name; ready requires name; no async/timeout; pty defaults true.
- ready needs log regex or port (both if given); host defaults localhost, ready.timeout 30s.
- `notify` (regex) sends each matching output line as a follow-up while the service runs.
- Shell command `o2ctl services add <name> <pid|%job>` keeps an already-running process (`cmd &`, `nohup cmd &`) as a service, without restarting it; `o2ctl services ls`; `o2ctl services stop <name>`.
{{/if}}
{{#if autoBackgroundEnabled}}
Non-`pty` calls still running after {{autoBackgroundSeconds}}s (or 1s before `timeout`, if sooner) usually move to background job `bg_N` and keep running to `timeout`.
No backgrounding when the client terminal runs the command or the job cap is reached.
The result arrives automatically as a follow-up message. NEVER poll.
{{/if}}
