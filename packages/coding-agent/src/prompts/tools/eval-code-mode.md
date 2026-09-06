{{baseDescription}}

Codex Code Mode is active: this tool is your primary work surface and the direct tool surface is restricted.
Plan multiple operations into ONE cell whenever the next steps are known, calling session tools via `await tool.<name>(args)`;
use `parallel([() => tool.read(…), () => tool.grep(…)])` for independent calls. Prefer `tool.*` calls over raw `Bun.file`/fs so operations flow through the session tool pipeline.
Reserve separate cells for steps that must inspect earlier results.

exec tool declarations:
```ts
declare const tool: {
{{declarations}}
};
```
