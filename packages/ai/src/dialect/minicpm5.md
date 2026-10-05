## Format guide

Emit each tool call using MiniCPM5's native XML function format:

```text
<function name="function_name"><param name="argument_name">value</param></function>
```

For multiple arguments, emit multiple `<param>...</param>` children inside the
same `<function>...</function>` element. Emit multiple calls as consecutive
`<function>...</function>` elements.

Results arrive later as:

```text
<tool_response>
verbatim tool result
</tool_response>
```

## Rules

- `name` MUST match a function listed in `<tools>`.
- Use `<function>`, `<param>`, `</param>`, and `</function>` exactly. NEVER use
  `<invoke>`, `<parameter>`, or `<tool_call>` for a tool call.
- String parameter values are literal text. Non-string parameter values are JSON.
- If a value contains `<`, `&`, or a newline, wrap the complete value in
  `<![CDATA[...]]>`.
- Do not duplicate parameter names and do not omit required parameters.
- Read each `<tool_response>` in call order. NEVER emit `<tool_response>` yourself.
- Write the complete closing `</function>` before stopping. Never stop halfway
  through a tool call.
