<system-interrupt reason="tool_call_loop_detected">
Your last {{count}} turns called only tools that do not exist. Latest: `{{tool_name}}` with
`{{arguments_summary}}`

Last result (truncated): `{{result_summary}}`

NEVER call a tool name that is not in your tool definitions. Call one of your defined tools by its exact name, or summarize findings and yield if complete.
</system-interrupt>
