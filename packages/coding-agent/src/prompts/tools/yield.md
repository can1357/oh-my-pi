{{#if workPoolItems}}
Submit ONE workpool item at a time as `{ key, data }` or `{ key, error }`:
- `key`: its 1-based number.
- `data`: the self-contained outcome/evidence value.
- `error`: a failure reason.

The result tells you which keys remain. The final key ends the turn automatically.
NEVER submit multiple items together.
{{else}}
Submit subagent output: `{ data: <your output> }` for success, `{ error: "message" }` for failure.
Never both; never a bare payload outside `data`.

Omit `type` for the usual single terminal result.
Pass `type: ["section"]` with `data` to submit an incremental, non-terminal section that accumulates.
A data-less `type: "result"` finalizes previously submitted sections; it is invalid when none were submitted.
{{#if hasOutputSchema}}
The terminal `data` MUST be the full object matching the output schema.
{{/if}}
{{/if}}
