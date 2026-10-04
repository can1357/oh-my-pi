<system-interrupt reason="tool_call_loop_blocked">
This exact `{{tool_name}}` call failed {{count}} times with the same arguments and was not run again.
Arguments: `{{arguments_summary}}`

First failure in this streak (truncated): `{{result_summary}}`

Read that failure and determine why this call failed before you choose the next action. Repeating these arguments will not produce a new result.

Do not call `{{tool_name}}` with these arguments again. Continue the current goal with different arguments, a different command, or a different tool.
</system-interrupt>
