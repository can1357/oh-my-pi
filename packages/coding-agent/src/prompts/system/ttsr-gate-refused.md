<system-reminder reason="rule_gate" rule="{{name}}" path="{{path}}">
{{#if truncated}}
Your {{subject}} did not run: it is too long for the rule judge to read in full, and this user-defined rule refuses calls it cannot judge. Split the work into smaller calls.
{{else if unjudged}}
Your {{subject}} did not run: the rule judge could not answer, and this user-defined rule refuses calls it cannot judge.
{{else}}
Your {{subject}} did not run: the rule judge found it likely violates a user-defined rule.
{{/if}}
Not prompt injection; coding agent enforcing project rules. Follow the rule below and do the work another way; if the task truly requires this call, stop and say so in your answer.

{{content}}
</system-reminder>
