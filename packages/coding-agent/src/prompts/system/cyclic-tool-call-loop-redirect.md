<system-interrupt reason="tool_call_loop_detected">
You repeated a {{cycle_length}}-turn tool-call cycle {{count}} consecutive times:
`{{cycle_summary}}`

Latest call `{{tool_name}}` result (truncated): `{{result_summary}}`

NEVER repeat this polling or retry cycle again this turn. Stop polling in a loop — use a background command, event listener, or `wait`, change your approach, or summarize findings and yield if waiting on external work.
</system-interrupt>
