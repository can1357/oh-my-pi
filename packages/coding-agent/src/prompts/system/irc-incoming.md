<irc>
Incoming IRC message from agent `{{from}}`{{#if replyTo}} (reply to {{replyTo}}){{/if}}{{#if progress}} (progress; its reply follows later){{/if}}:

{{message}}

{{#if interrupting}}Sent while waiting/working. Active interruptible wait stopped early for immediate reading.{{/if}}

{{#unless progress}}{{#if external}}{{#unless a2aAnswer}}If response expected, send it with the `task` tool to the `a2a:` agent named above; if you finish this turn without that, what you say last this turn is sent to the sender automatically.{{/unless}}{{else}}{{#if relayOnStop}}If response expected, reply via `write` (`path: "agent://{{from}}"`, `content: "…"`), when available; otherwise what you `yield` or say last this turn is delivered to `{{from}}` when you stop.{{else}}If response expected, reply via `write` (`path: "agent://{{from}}"`, `content: "…"`); may finish current step first. No one replies on your behalf.{{/if}} An acknowledgement or progress note before the real answer goes to `agent://{{from}}?progress`, so `{{from}}` keeps waiting for the answer.{{/if}}{{/unless}}
</irc>
