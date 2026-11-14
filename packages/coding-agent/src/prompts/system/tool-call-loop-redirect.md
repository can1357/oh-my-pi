<system-interrupt reason="tool_call_loop_detected">
The `{{tool_name}}` call pattern repeated for {{count}} consecutive turns:
`{{arguments_summary}}`

Last result (truncated): `{{result_summary}}`

NEVER repeat the `{{tool_name}}` call pattern this turn. Change the operation or choose a different tool. Summarize findings and yield if complete.
</system-interrupt>
