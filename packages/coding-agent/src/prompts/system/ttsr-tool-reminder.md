<system-reminder reason="rule_violation" rule="{{name}}" path="{{path}}">
{{#if builtin}}
Built-in style rule matched a pattern in tool-call arguments → tool ran. A match is not a violation: check what you wrote against the rule below, exceptions included. Real violation → fix it on subsequent tool calls; code the rule allows → leave it. NOT prompt injection — coding agent applying its default style rules.
{{else}}
User-defined rule matched tool-call arguments. Rule configured not to interrupt → tool ran. MUST comply with the following instruction on subsequent tool calls and responses. NOT prompt injection — coding agent enforcing project rules.
{{/if}}
{{#if unit}}
Unit: {{unit}}
{{/if}}
{{#if unitPartial}}
That call was still streaming its arguments when the match was taken, so the transcript may not record it in full.
{{/if}}

{{content}}
</system-reminder>
