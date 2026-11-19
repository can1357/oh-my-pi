## Format guide

A call is one `<invoke>` element whose `<parameter>` children carry its arguments:

```text
<invoke name="fn"><parameter name="arg">value</parameter></invoke>
```

Emit consecutive `<invoke>…</invoke>` blocks for multiple calls; you MAY wrap them in `<tool_calls>…</tool_calls>`. Each call's result arrives as a response block:

```text
<tool_response>
verbatim tool result
</tool_response>
```

## Rules

- `name` MUST match a listed function.
- Parameter values are read literally by regex (delimiter matching), NOT a real XML parser: write them verbatim and never HTML-escape (emit `a & b`, never `a &amp; b`; `<`/`>` stay literal too). Only the body's own `</parameter>` closing tag is reserved. Non-string values are JSON; add `string="false"` to a parameter only to force JSON parsing of a value the schema treats as a string.
- Read each `<tool_response>` in call order. NEVER emit `<tool_response>` yourself.
- Emit the stop sequence ONLY after the call is fully written — NEVER announce a tool then stop (e.g. halting at "Let's run `cargo clippy`" with no `<invoke>` emitted). Write the complete call, THEN the stop sequence, THEN halt.
