<system-interrupt reason="tool_call_loop_detected">
A repeating tool-call pattern reached {{count}} repetitions. Latest call: `{{tool_name}}` with arguments:
`{{arguments_summary}}`

Last result (truncated): `{{result_summary}}`

Choose a step that adds new evidence, or report the verified result if the work is complete. Repeat a call when its underlying state has changed, not merely with different argument wording.
</system-interrupt>
