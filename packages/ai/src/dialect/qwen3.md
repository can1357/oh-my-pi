## Format guide

Emit each tool call as one `<tool_call>` block wrapping a single-line JSON object with `name` and a nested `arguments` object:

```text
<tool_call>
{"name":"function_name","arguments":{"arg":"value"}}
</tool_call>
```

Do any private reasoning in `<think>...</think>` before your tool calls.

Tool results arrive later in a user turn:

```text
<tool_response>
verbatim tool result
</tool_response>
```

## Rules

- `name` MUST match a listed function; `arguments` is a JSON object, never a JSON string.
- Argument string values use only normal JSON string escaping (`\"`, `\\`, `\n`); never HTML-escape their contents — write `a & b`, not `a &amp; b`.
- Multiple calls = consecutive `<tool_call>...</tool_call>` blocks; keep prose outside them.
- NEVER put tool calls inside `<think>`.
- Read each `<tool_response>` in call order. NEVER emit `<tool_response>` yourself.
- Emit the stop sequence ONLY after the call is fully written — NEVER announce a tool then stop (e.g. halting at "Let's run `cargo clippy`" with no `<tool_call>` emitted). Write the complete call, THEN the stop sequence, THEN halt.
