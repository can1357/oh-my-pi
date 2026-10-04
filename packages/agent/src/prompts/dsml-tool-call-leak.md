Tool call failed: your previous response tried to invoke a tool, but the DSML markup was malformed, so it arrived as plain text, no tool was executed, and the broken markup was removed from your response. Usually the opening `<｜DSML｜tool_calls>` and/or `<｜DSML｜invoke name="…">` tags are missing, or the tool name was written as a plain line.

A tool call must be one complete envelope:

```
<｜DSML｜tool_calls>
<｜DSML｜invoke name="TOOL_NAME">
<｜DSML｜parameter name="ARG_NAME" string="true">text value</｜DSML｜parameter>
<｜DSML｜parameter name="OTHER_ARG" string="false">{"json": "value"}</｜DSML｜parameter>
</｜DSML｜invoke>
</｜DSML｜tool_calls>
```

- `<｜DSML｜tool_calls>` wraps every call; put one `<｜DSML｜invoke>` per call inside it.
- The tool name goes in the `name` attribute of `<｜DSML｜invoke>`, never on its own line.
- Use `string="true"` for raw text values and `string="false"` for numbers, booleans, arrays, and objects (JSON).
- Close every tag.

Re-issue the intended call now in this shape, or reply in plain prose if no tool is needed.
