## Format guide

Emit tool calls as Python inside a fenced ` ```tool_code ` block. Call each function as a method on `default_api`:

````text
```tool_code
default_api.function_name(arg="value", count=2)
```
````

Argument values are Python literals: `"strings"`, numbers, `True`/`False`, `None`, `[lists]`, `{"dicts": 1}`.

Call several functions in parallel as a Python list:

````text
```tool_code
[default_api.first(x="a"), default_api.second(y="b")]
```
````

Tool results arrive later in a ` ```tool_outputs ` block:

````text
```tool_outputs
verbatim tool result
```
````

Put any private reasoning in a fenced ` ```thinking ` block before the ` ```tool_code ` block:

````text
```thinking
brief reasoning
```
````

## Rules

- The function name MUST match a listed function; arguments are keyword form (`name=value`).
- Argument string values use only normal Python string escaping; never HTML-escape their contents — write `"a & b"`, not `"a &amp; b"`.
- Multiple calls = a single `[...]` list (or one `default_api...` call per line) inside one ` ```tool_code ` block.
- Put private reasoning in a ` ```thinking ` block before the ` ```tool_code ` block, never inside ` ```tool_code `.
- Read each ` ```tool_outputs ` block in call order. NEVER write a ` ```tool_outputs ` block yourself.
- Emit the ` ```tool_code ` block in full, THEN stop and halt — NEVER announce a tool then stop (e.g. halting at "Let's run `cargo clippy`" with no ` ```tool_code ` block emitted).
