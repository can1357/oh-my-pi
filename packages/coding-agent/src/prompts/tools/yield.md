{{#if workPoolItems}}Submit ONE workpool item at a time as `{ key, data }` or `{ key, error }`: `key` is its 1-based number; `data` is the self-contained outcome/evidence value, `error` is a failure reason. The result tells you which keys remain. The final key ends the turn automatically. NEVER submit multiple items together.
{{else}}Submit subagent output. Always wrap the payload: `result: { data: <your output> }` for success, `result: { error: "message" }` for failure. `data`/`error` at the top level or a bare payload is invalid.

Omit `type` for the usual single terminal structured result. Pass `type: ["section"]` to submit an incremental, non-terminal section that accumulates.
{{/if}}
{{#unless workPoolItems}}
{{#if hasOutputSchema}}
This task declares an output schema: the terminal `result.data` MUST be the full object matching it. A data-less `type: "result"` finalizes previously submitted incremental sections; it is invalid when no sections were submitted — prose in your last turn can never satisfy the schema.
{{else}}
Pass `type: "result"` to finalize; when `data` is omitted, your last assistant turn becomes the raw final result.
{{/if}}
{{/unless}}
