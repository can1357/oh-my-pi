<irc>
Incoming IRC message from agent `{{from}}`{{#if replyTo}} (reply to {{replyTo}}){{/if}}:

{{message}}

{{#if interrupting}}Sent while waiting/working. Active interruptible wait stopped early for immediate reading.{{/if}}

{{#if autoReplied}}Mid-task: context-generated side-channel auto-reply sent to `{{from}}` on your behalf, recorded after this message. Follow up via `hub` (`op: "send"`, `to: "{{from}}"`) only to correct it.{{else}}{{#if relayOnStop}}If response expected, reply via `hub` (`op: "send"`, `to: "{{from}}"`) when available; otherwise what you `yield` or say last this turn is delivered to `{{from}}` when you stop.{{else}}If response expected, reply via `hub` (`op: "send"`, `to: "{{from}}"`); may finish current step first. No one replies on your behalf.{{/if}}{{/if}}
</irc>
