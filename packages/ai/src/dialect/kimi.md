## Format guide

Emit every call of a turn inside one section. Each call is an id of the fixed form `functions.NAME:INDEX` followed by one JSON arguments object:

```text
<|tool_calls_section_begin|><|tool_call_begin|>functions.NAME:INDEX<|tool_call_argument_begin|>{"arg":"value"}<|tool_call_end|><|tool_calls_section_end|>
```

Tool results arrive later as turns whose body is a `## Return of functions.NAME:INDEX` header then the verbatim result:

```text
<|im_system|>NAME<|im_middle|>## Return of functions.NAME:INDEX
verbatim tool result<|im_end|>
```

## Rules

- `NAME` MUST match a listed function exactly.
- Arguments MUST be one JSON object with double-quoted keys.
- Argument string values use only normal JSON string escaping (`\"`, `\\`, `\n`); never HTML-escape their contents — write `a & b`, not `a &amp; b`.
- Multiple calls = consecutive `<|tool_call_begin|>…<|tool_call_end|>` blocks in the same section; `INDEX` increments from `0`.
- Private reasoning, when supported, goes in `<think>…</think>` before the tool-call section; NEVER put tool calls inside `<think>`.
- Read each result turn in call order. NEVER emit result turns yourself.
- Emit the stop sequence ONLY after the call is fully written — NEVER announce a tool then stop (e.g. halting at "Let's run `cargo clippy`" with no `<|tool_call_begin|>` emitted). Write the complete call, THEN the stop sequence, THEN halt.
