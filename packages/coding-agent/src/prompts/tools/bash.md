Runs bash in a shell session — terminal ops: git, bun, cargo, python.

# When to use bash — and when not to

Bash invokes **real binaries** with simple args. It is NOT a scripting surface.

Use bash ONLY for: a single binary call, or one short pipeline that COMPUTES a fact (`wc -l`, `sort | uniq -c`, `comm`, `diff`, a checksum, `git status`).

Anything below → `eval` cell, not bash:
- Inline interpreter scripts (`-e`/`-c`/`--eval`) when an eval runtime exists for that language
- Heredocs (`<<EOF`), `while`/`for`/`if`/`case` shell control flow
- `$(…)` command substitution nested inside another command
- Pipelines with more than two stages, or stages that need control flow or quote/JSON escaping
- Multiline commands, `&&`-chains mixing control flow
- Quote/JSON escaping that fights the shell

<instruction>
- `cwd` sets the working dir, not `cd dir && …`
- `env: { NAME: "…" }` for multiline / quote-heavy / untrusted values; reference `$NAME`
- Quote expansions (`"$NAME"`) to preserve exact content
- `pty: true` only when the command needs a real terminal (`sudo`, `ssh` needing input); default `false`
- `;` only when later commands should run despite earlier failures
- Multiple bash calls per message run concurrently. NEVER split order-dependent commands across parallel calls — chain with `&&` in one call.
- Internal URIs (`skill://`, `agent://`, …) auto-resolve to FS paths
{{#if asyncEnabled}}
- `async: true` for long-running commands when you don't need immediate output: returns a background job ID; result delivered as a follow-up.
{{/if}}
</instruction>

<critical>
- Bash invokes real binaries with simple args; it is NOT a scripting surface. Loops, conditionals, heredocs, inline interpreter scripts (`-e`/`-c`/`--eval`) when an eval runtime exists, several piped stages, or quote/JSON escaping mean you're writing a program → use `eval` cells: restartable, stateful, and free of shell-quoting traps.
- NEVER shell out to search content or files: `grep/rg` → `grep`.
- NEVER use `ls` or `find` to list or locate files — `ls` → `read` (a directory path lists entries), `find` → the `glob` tool (globbing). This is non-negotiable, even for a single quick listing.
- Avoid head/tail/redirections: stderr already merged; long output auto-truncated, FULL capture kept at `artifact://<id>`.
</critical>

<output>
- Returns output; exit code shown on non-zero exit.
- Truncated output → `artifact://<id>` (linked in metadata).
</output>

{{#if asyncEnabled}}
# Timeout and async

- `timeout` (seconds) caps wall-clock duration; the process is killed on elapse.
- `async: true` defers only reporting — it does NOT extend the timeout; a daemon run with `async: true` is still killed when `timeout` elapses.
- Long-running daemons (dev servers, watchers): pass a large explicit `timeout`. The shell session persists across calls, so `cmd &` keeps running between bash calls.
{{/if}}
{{#if autoBackgroundEnabled}}

## Auto-background

- A long-running foreground call may convert to a background job; the final result arrives as a follow-up tool call. NOT a failure — don't retry or wait synchronously.
- Need the result inline (e.g. piping into another command)? Raise `timeout` above expected duration{{#if asyncEnabled}}, or set `async: true` up front{{/if}}.
{{/if}}

# Output minimizer

- Long output truncated; test/lint runner output filtered to failures. When visible text changed, a `[raw output: artifact://<id>]` footer links the full capture — read it if a run looks suspicious or you need exact bytes.
- No footer = what you see is exactly what the command emitted.
