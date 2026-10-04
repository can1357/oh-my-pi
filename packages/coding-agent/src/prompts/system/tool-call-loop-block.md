<system-interrupt reason="tool_call_loop_blocked">
This exact `{{tool_name}}` call failed {{count}} times with the same arguments and was not run again.
Arguments: `{{arguments_summary}}`

Last result (truncated): `{{result_summary}}`

The same arguments already failed. Running them again will not produce a new result. An exit code with no output means the command found nothing; that check is finished.

Do not call `{{tool_name}}` with these arguments again. Continue the current goal with different arguments, a different command, or a different tool.
</system-interrupt>
