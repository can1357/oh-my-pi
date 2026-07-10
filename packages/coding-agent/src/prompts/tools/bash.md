Runs bash in a shell session — terminal ops: git, bun, cargo, python.

<instruction>
- `cwd` sets the working dir; `env: { NAME: "…" }` for multiline/quote-heavy values (reference `$NAME`, quote `"$NAME"` to preserve content). `pty: true` only when a real terminal is needed (`sudo`, interactive `ssh`).
- `;` only when later commands must run despite earlier failures — chain order-dependent commands in ONE call with `&&`; NEVER split across parallel calls. Internal URIs (`skill://`, `agent://`, …) auto-resolve to FS paths.
{{#if asyncEnabled}}
- `async: true` runs in background; result delivered as a follow-up tool call.
{{/if}}
</instruction>

<critical>
- NEVER shell out to fetch, display, list, page, or search what a dedicated tool serves: `cat`/`head`/`tail`/`less`/`more`/`ls` → `read`; `grep`/`rg`/`ag`/`ack` → `search`; `find`/`fd` → `find`; `sed -i`/`perl -i`/`awk -i` → `edit`; `echo >`/heredoc → `write`. Tools keep gitignore semantics, line anchors, structured output shell loses.
- NEVER trim or silence output: no `| head -n N`, `| tail -n N`, `| less`, `2>&1`, `2>/dev/null`. stderr already merged; long output auto-truncated, FULL capture kept at `artifact://<id>`. Test/lint output filtered to failures; a `[raw output: artifact://<id>]` footer links the full capture when visible text changed. No footer = output is unchanged; read the artifact if a run looks suspicious or you need exact bytes.
</critical>
{{#if asyncEnabled}}
# Timeout and async

- `timeout` (seconds) caps wall-clock; process killed on elapse.
- `async: true` defers reporting only — does NOT extend `timeout`; daemons are still killed when `timeout` elapses.
- Long-running daemons (dev servers, watchers): pass a large explicit `timeout`. The session persists, so `cmd &` keeps running across calls.
{{/if}}
{{#if autoBackgroundEnabled}}

## Auto-background

- A foreground call may convert to a background job; the result arrives as a follow-up tool call — NOT a failure, do NOT retry or wait synchronously.
- Need the result inline (e.g. piping into another command)? Raise `timeout` above expected duration{{#if asyncEnabled}}, or set `async: true` up front{{/if}}.
{{/if}}

<windows-heredoc>
On Windows, prefer `write` a script file then execute that file instead of bash heredocs (`<<`). Bound/procedural profiles reject confirmed heredocs before execution with recovery: write script file -> execute file.
</windows-heredoc>
