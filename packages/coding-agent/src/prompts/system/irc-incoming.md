<irc>
Incoming IRC message from agent `{{from}}`{{#if replyTo}} (reply to {{replyTo}}){{/if}}:

{{message}}

{{#if interrupting}}Sent while waiting/working. Active interruptible wait stopped early for immediate reading.{{/if}}

{{#if autoReplied}}Mid-task: context-generated side-channel auto-reply sent to `{{from}}` on your behalf, recorded after this message. Follow up via `hub` (`op: "send"`, `to: "{{from}}"`) only to correct it.{{else}}If response expected, reply via `hub` (`op: "send"`, `to: "{{from}}"`); may finish current step first. No one replies on your behalf.{{/if}}
</irc>
