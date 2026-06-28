## Format guide

Emit each call as a `<tool_call>` block. The function name goes on the same line as the opening tag, followed by one `<arg_key>`/`<arg_value>` pair per argument, closed by `</tool_call>`:

```text
<tool_call>get_weather
<arg_key>location</arg_key>
<arg_value>Beijing</arg_value>
<arg_key>days</arg_key>
<arg_value>3</arg_value>
</tool_call>
```

Tool results return in an observation block:

```text
<observation>
<tool_response>
verbatim tool result
</tool_response>
</observation>
```

## Rules

- The name after `<tool_call>` must match a listed function and sit on the same line.
- Emit one `<arg_key>name</arg_key>` + `<arg_value>value</arg_value>` pair per argument; omit unset optional args.
- `<arg_value>` bodies are read by regex (delimiter matching), NOT a real XML parser: write string values as raw literal text and never HTML-escape them (emit `a & b`, not `a &amp; b`; `<`/`>` stay literal); only the body's own `</arg_value>` closing tag is reserved. Non-string values are valid JSON.
- Multiple calls are consecutive `<tool_call>…</tool_call>` blocks.
- Private reasoning goes in `<think>…</think>`; NEVER put tool calls inside `<think>`.
- Read each `<tool_response>` in call order. NEVER emit `<tool_response>` yourself.
- Emit the stop sequence ONLY after the call is fully written — NEVER announce a tool then stop (e.g. halting at "Let's run `cargo clippy`" with no `<tool_call>` emitted). Write the complete call, THEN the stop sequence, THEN halt.
