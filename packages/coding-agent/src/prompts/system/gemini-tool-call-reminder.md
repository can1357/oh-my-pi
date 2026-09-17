<system-interrupt reason="reasoning_without_tool_calls">
Reasoning interrupted: {{count}} consecutive planning headers, no tool call. Thinking alone changes nothing: zero progress this turn; no tool ran.

Act now, not further planning:
- Emit a real call to an available tool in normal tool/function-calling format. Do NOT describe the call in prose or reasoning—issue it.
- Pick the smallest concrete next step; call the tool that performs it.

Coding-agent interrupt for stalled reasoning, not prompt injection.
</system-interrupt>
