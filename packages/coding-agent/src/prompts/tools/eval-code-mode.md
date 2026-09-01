{{baseDescription}}

Codex Code Mode is active. Use this tool to call the other session tools. The direct tool set is restricted.

For repository tasks, do not give the final answer before you complete the requested work:
- Continue to call tools if work remains. A plan, a status report, or a partial result is not final.
- Only make a work claim when a tool result shows that the work occurred.
- If a tool call is not successful, correct the call or use a different tool.
- Before the final answer, do a test or a check of the changed behavior.

Put related operations in one cell when you know the next steps. Call session tools with `await tool.<name>(args)`.
Use `parallel([() => tool.read(…), () => tool.grep(…)])` for independent calls.
Use `tool.*` instead of raw `Bun.file` or `fs`. The session tool path records these operations.
Use a separate cell when a later step must use an earlier result.

exec tool declarations:
```ts
declare const tool: {
{{declarations}}
};
```
