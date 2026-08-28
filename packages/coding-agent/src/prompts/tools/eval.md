One cell per call; top-level state persists, including across compaction.{{#if spawns}} Subagents have separate kernels.{{/if}}
A cell without `timeout` stops after {{timeoutDefault}}s{{#if timeoutRaisable}}; pass a larger `timeout` for slow subprocesses, network calls or large scans{{/if}}.
{{#if spawns}}
{{#if eagerDelegation}}
For 2+ independent items, use a named `workpool()`; results auto-deliver.
{{#if waitTool}}
If blocked, leave `eval` and call `wait`.
{{/if}}
{{/if}}
{{/if}}
{{#if py}}
Python: plain Python subprocess, not IPython (no `get_ipython()`, `obj?`, or %matplotlib).
Magics like %pip, %load, %time and `!cmd` are rewritten to Python.
Top-level `await` works; `asyncio.run(…)` fails.
{{/if}}
{{#if js}}JS: Bun (Bun.file, Bun.write, Bun.$); top-level `await`/`return` work.{{/if}}
On error, retry only the failed step; earlier steps may have taken effect.
Printing an image{{#if py}} or figure{{/if}} attaches it.

<prelude>
{{#ifAll py js}}
Python helpers take kwargs; JS helpers take the same parameters (camelCase) as positional args or ONE trailing options object.
`await` marks async helpers; the rest are sync.
```
print(value, ...)  log(message)  phase(title)  env(key?, value?)
read(path, offset?, limit?)  write(path, content)  output(*ids, format?, query?, offset?, limit?); JS: await read(…)  await write(…)  await output(…)
wait(handles, timeout?=None, raise_errors?=True); JS: await wait(…) — agent/completion barrier, ordered results; raise_errors=False retains failures
await tool.<name>(args) — session tool; `args` is its parameter object
sh(command, timeout?); JS: await sh(…) or await sh`cmd ${arg}` — embedded bash engine, runs to completion (never backgrounded)
  returns stdout+stderr; non-zero exit raises ShellError (.exit_code/.exitCode, .output)
  JS interpolations are shell-quoted; each call starts in the session cwd
```
{{else}}
`await` marks async helpers; the rest are sync.
{{#if py}}
Python (kwargs):
```py
print(value, ...)  log(message)  phase(title)  env(key?, value?)
read(path, offset?, limit?)  write(path, content)  output(*ids, format?, query?, offset?, limit?)
wait(handles, timeout?=None, raise_errors?=True) — agent/completion barrier, ordered results; `raise_errors=False` retains failures.
await tool.<name>(args) — session tool; `args` is its parameter object
sh(command, timeout?) — embedded bash engine, runs to completion (never backgrounded)
  returns stdout+stderr; non-zero exit raises ShellError (`.exit_code`, `.output`); each call starts in the session cwd
```
{{/if}}
{{#if js}}
JS (positional args or ONE trailing options object):
```js
print(value, ...)  log(message)  phase(title)  env(key?, value?)
await read(path, offset?, limit?)  await write(path, content)  await output(...ids, { format?, query?, offset?, limit? })
await wait(handles, { timeout?, raiseErrors? }) — agent/completion barrier, ordered results; `raiseErrors: false` retains failures.
await tool.<name>(args) — session tool; `args` is its parameter object
await sh(command, { timeout? })  await sh`cmd ${arg}` — embedded bash engine, runs to completion (never backgrounded)
  resolves to stdout+stderr; non-zero exit throws ShellError (`.exitCode`, `.output`)
  interpolations are shell-quoted; each call starts in the session cwd
```
{{/if}}
{{/ifAll}}
{{#if toolNames}}Session tool names: {{#each toolNames}}{{this}}{{#unless @last}}, {{/unless}}{{/each}}.{{/if}}
</prelude>

{{#if inlineTopics}}
{{{inlineTopics}}}
{{else}}
<namespaces>
More globals; `read` the linked docs before first use:
- `judge`, {{#ifAll py js}}`judge_batch` (Py) / `judgeBatch` (JS){{else}}{{#if py}}`judge_batch`{{else}}`judgeBatch`{{/if}}{{/ifAll}}, `completion`: classification, bulk judgment, model calls → help://eval/judge
- `%load`{{#if py}}, `%pip`{{/if}}{{#if js}}, `%bun add`{{/if}}, `budget`{{#if evalTools}}, `@tool`/`tool(fn)`{{/if}}: setup, installs, utilities → help://eval/helpers
- Bulk per-chunk semantic work (label/extract/summarize every slice of a long input): one `completion` per slice{{#if spawns}}, not `workpool`/`agent`{{/if}} → help://eval/map-reduce
{{#if spawns}}
- `agent`, `workpool`: background subagents, DAG waves → help://eval/agents
{{/if}}
{{#each preludes}}
- `{{name}}`{{#if summary}}: {{summary}}{{/if}} → help://eval/{{name}}
{{/each}}
{{#if firstCallPreludes}}
No `read` needed before first use; the guide follows the first call's result (full reference linked):
{{#each firstCallPreludes}}
- `{{name}}`{{#if summary}}: {{summary}}{{/if}} → `help://eval/{{name}}`
{{/each}}
{{/if}}
</namespaces>
{{#each inlinePreludes}}

<{{name}}>
Global `{{name}}`, documented here in full (no `read` needed):
{{{documentation}}}
</{{name}}>
{{/each}}
{{/if}}

<critical>
NEVER repeat successful setup. Kernel-loss notice means reload setup.
</critical>

{{#if autoBackgroundEnabled}}
Long cells may auto-background and deliver later; the kernel stays busy.
`timeout: 0` disables the cell deadline, not the foreground wait.
{{/if}}
