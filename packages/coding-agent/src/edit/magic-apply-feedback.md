{{#if truncated}}
The last response hit the output limit. Use smaller `replace` calls, one section at a time.
{{else if syntax}}
The draft no longer parses. {{syntax}}
Use `read` and `replace` to repair the draft; successful edits are still in it.
{{else if callFormat}}
Use native tool calls, or write one JSON object per call in its own fenced block:

```json
{"name":"read","arguments":{"start_line":1,"end_line":5}}
```
{{else if failed}}
At least one replacement failed. Correct the failed change in the draft before replying `DONE`.
{{else}}
Apply the requested changes with `replace` before replying `DONE`. Use `read` or `search` if needed.
{{/if}}
