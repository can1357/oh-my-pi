## Format guide

Emit each call as a `<tool_call>` block wrapping a single-line JSON object with `name` and `arguments`:

```text
<tool_call>
{"name":"function_name","arguments":{"arg":"value"}}
</tool_call>
```

Results arrive later as `<tool_response>` blocks:

```text
<tool_response>
verbatim tool result
</tool_response>
```

## Rules

- `name` MUST match a listed function; `arguments` is a JSON object, never a stringified JSON.
- Argument string values use only normal JSON string escaping (`\"`, `\\`, `\n`); never HTML-escape their contents — write `a & b`, not `a &amp; b`.
- Emit multiple calls as consecutive `<tool_call>` blocks; keep any prose outside them.
- Read each `<tool_response>` in call order. NEVER emit `<tool_response>` yourself.
- Emit the stop sequence ONLY after the call is fully written — NEVER announce a tool then stop (e.g. halting at "Let's run `cargo clippy`" with no `<tool_call>` emitted). Write the complete call, THEN the stop sequence, THEN halt.
