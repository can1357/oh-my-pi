<irc>
Incoming IRC message from agent `{{from}}`{{#if replyTo}} (reply to {{replyTo}}){{/if}}{{#if progress}} (progress; its reply follows later){{/if}}:

{{message}}

{{#if interrupting}}Sent while waiting/working. Active interruptible wait stopped early for immediate reading.{{/if}}

{{#unless progress}}{{#if relayOnStop}}If response expected, reply via `write` (`path: "agent://{{from}}"`, `content: "…"`), when available; otherwise what you `yield` or say last this turn is delivered to `{{from}}` when you stop.{{else}}If response expected, reply via `write` (`path: "agent://{{from}}"`, `content: "…"`); may finish current step first. No one replies on your behalf.{{/if}} An acknowledgement or progress note before the real answer goes to `agent://{{from}}?progress`, so `{{from}}` keeps waiting for the answer.{{/unless}}
</irc>
