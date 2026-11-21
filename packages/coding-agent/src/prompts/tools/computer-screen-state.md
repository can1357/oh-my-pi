Note: when this run ended {{#if screenLocked}}the screen is locked{{#if displayAsleep}} and {{/if}}{{/if}}{{#if displayAsleep}}the session's display is asleep{{/if}}.{{#if windows}} Windows reports a locked or disconnected session, or an unavailable input desktop such as the UAC secure desktop. Captures and input cannot confirm the app's state until someone unlocks or reconnects the session, or dismisses the secure desktop.{{else}}
{{#if displayAsleep}}
- Nothing on that display can be captured or clicked until it wakes.
- It is the display the `computer.display` setting names, or every display when that is `active` or `all`.
{{else}}
- A display screenshot shows the lock screen and a window screenshot shows that window's last frame behind it, so neither confirms what this run did.
- A background click still reaches the app behind the lock screen.
{{/if}}
{{#if screenLocked}}
- While locked, apps expose no accessibility windows, so keystrokes, takeover and accessibility actions fail.
- The lock stays until someone unlocks the Mac.
{{/if}}{{/if}}
