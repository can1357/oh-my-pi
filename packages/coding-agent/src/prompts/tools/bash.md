Runs commands in a persistent shell.

Use ONLY for one binary or a short pipeline that computes a fact (`wc -l`, `sort | uniq -c`, `diff`).
{{#if hasEval}}Inline scripts, heredocs, `$(…)`, complex control flow/quoting, and non-trivial pipelines → `eval`.{{else}}Inline scripts, heredocs, `$(…)`, and complex control flow → a purpose-built tool or checked-in script.{{/if}}

<instruction>
- Set `cwd` instead of `cd`; use `env: { NAME: "…" }` for multiline/quote-heavy values.
- `pty: true` only for terminal interaction (`sudo`, `ssh`).
- Order-dependent commands use `&&` in one call; independent calls may run concurrently.
- Internal URIs (`skill://`, `agent://`, …) auto-resolve to paths.
{{#if hasShellBuiltins}}- aux utils available: mkdir, wc, sort, comm, diff, uniq, base64, cmp, md5sum, sha{1,224,256,384,512}sum, b2sum, basename, dirname, readlink, realpath, touch, stat, date, mktemp, seq, yes, printenv, truncate, tac, nproc, uname, whoami, hostname, which, ps, pgrep, pkill, pidwait, top, cut, tee, tr, paste, sed, xargs, jq, rm, mv, ln, ts, sponge, ifne, isutf8, combine{{#unless isWindows}}, errno{{/unless}}{{/if}}
{{#if asyncEnabled}}- `async: "auto"` backgrounds the same process after brief inline grace; `true` backgrounds immediately.
- `progress` emits complete lines after backgrounding: `wake` starts idle follow-up; `ambient` waits for active turn.
- Truncated/suppressed progress links complete output at `artifact://<id>`.{{/if}}
</instruction>

<critical>
{{#if hasGrep}}- NEVER use shell `grep`/`rg`; use built-in `grep`.{{/if}}
{{#if hasRead}}{{#if hasGlob}}- List directories with `read` and find paths with `glob`; NEVER use `ls`/`find`.{{/if}}{{/if}}
- Avoid `head`, `tail`, and redirection: captured, truncated output links to `artifact://<id>`.
{{#if hasLaunch}}- Services, watchers, debuggers, and REPLs MUST use `hub` (`op:"start"`).{{/if}}
</critical>

{{#if autoBackgroundEnabled}}Long unmarked calls may auto-background after the configured threshold and deliver later.
`timeout: 0` = no job deadline; otherwise it sets one, not foreground wait.{{/if}}
No truncation footer means the displayed output is complete.
