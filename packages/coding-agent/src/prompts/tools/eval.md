One cell per call; top-level state persists, including across compaction.{{#if spawns}} Subagents have separate kernels.{{/if}}
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
sh(command, cwd?, timeout?); JS: await sh(…) or await sh`cmd ${arg}` — embedded bash engine, runs to completion (never backgrounded)
  returns stdout+stderr; non-zero exit raises ShellError (.exit_code/.exitCode, .output)
  JS interpolations are shell-quoted; starts in the session cwd unless cwd is given
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
sh(command, cwd?, timeout?) — embedded bash engine, runs to completion (never backgrounded)
  returns stdout+stderr; non-zero exit raises ShellError (`.exit_code`, `.output`); starts in the session cwd unless `cwd` is given
```
{{/if}}
{{#if js}}
JS (positional args or ONE trailing options object):
```js
print(value, ...)  log(message)  phase(title)  env(key?, value?)
await read(path, offset?, limit?)  await write(path, content)  await output(...ids, { format?, query?, offset?, limit? })
await wait(handles, { timeout?, raiseErrors? }) — agent/completion barrier, ordered results; `raiseErrors: false` retains failures.
await tool.<name>(args) — session tool; `args` is its parameter object
await sh(command, { cwd?, timeout? })  await sh`cmd ${arg}` — embedded bash engine, runs to completion (never backgrounded)
  resolves to stdout+stderr; non-zero exit throws ShellError (`.exitCode`, `.output`)
  interpolations are shell-quoted; starts in the session cwd unless `cwd` is given
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
- `judge`, `{{#if py}}judge_batch{{else}}judgeBatch{{/if}}`, `completion`: classification, bulk judgment, model calls → xd://eval/judge
- `%load`{{#if py}}, `%pip`{{/if}}{{#if js}}, `%bun add`{{/if}}, `budget`{{#if evalTools}}, `@tool`/`tool(fn)`{{/if}}: setup, installs, utilities → xd://eval/helpers
{{#if spawns}}
- `agent`, `workpool`: background subagents, DAG waves → xd://eval/agents
{{/if}}
{{#each preludes}}
- `{{name}}`: {{summary}} → xd://eval/{{name}}
{{/each}}
{{#if firstCallPreludes}}
No `read` needed before first use; the first call's output carries the guide (full reference linked):
{{#each firstCallPreludes}}
- `{{name}}`: {{summary}} → `xd://eval/{{name}}`
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
