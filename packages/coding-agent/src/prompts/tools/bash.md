Runs commands in a persistent shell.

Use ONLY for one binary or a short fact pipeline (`wc -l`, `sort | uniq -c`, `diff`).
{{#if hasEval}}Scripts, heredocs, `$(…)`, complex flow/quoting, and non-trivial pipelines → `eval`.{{else}}Scripts, heredocs, `$(…)`, and complex flow → a purpose-built tool or checked-in script.{{/if}}

<instruction>
- Use `cwd`, not `cd`; use `env` for multiline/quote-heavy values.
- `pty: true` only for terminal interaction (`sudo`, `ssh`).
- Order-dependent commands: one call with `&&`; independent calls may run concurrently.
- Internal URIs (`skill://`, `agent://`, …) resolve to paths.
{{#if hasShellBuiltins}}- aux utils available: mkdir, wc, sort, comm, diff, uniq, base64, cmp, md5sum, sha{1,224,256,384,512}sum, b2sum, basename, dirname, readlink, realpath, touch, stat, date, mktemp, seq, yes, printenv, truncate, tac, nproc, uname, whoami, hostname, which, ps, pgrep, pkill, pidwait, top, cut, tee, tr, paste, sed, xargs, jq, rm, mv, ln, ts, sponge, ifne, isutf8, combine{{#unless isWindows}}, errno{{/unless}}{{/if}}
{{#if asyncEnabled}}- `async: "auto"` (finite commands): inline for {{asyncAutoInlineGraceMs}} ms, then the same process promotes to a background job. `timeout` ≤ grace + 1 s → stays inline. Tune: `bash.asyncAuto.inlineGraceMs` (`0` = promote at once). At the job cap: auto runs inline with a notice; `true` errors.
- `async: true`: background at once (known long-running).
- `progress` (after backgrounding): `wake` starts an idle follow-up; `ambient` waits for an active turn. Truncated progress links `artifact://<id>`.{{/if}}
</instruction>

<critical>
{{#if hasGrep}}- NEVER use shell `grep`/`rg`; use built-in `grep`.{{/if}}
{{#if hasRead}}{{#if hasGlob}}- List directories with `read` and find paths with `glob`; NEVER use `ls`/`find`.{{/if}}{{/if}}
- Avoid `head`, `tail`, and redirection: captured, truncated output links to `artifact://<id>`.
{{#if hasLaunch}}- Services, watchers, debuggers, and REPLs MUST use `hub` (`op:"start"`); add `progress:"wake"` when pre-exit output may require action.{{/if}}
</critical>

{{#if autoBackgroundEnabled}}Long foreground calls may auto-background after the configured grace.{{/if}}
No truncation footer means the displayed output is complete.
