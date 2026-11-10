<system-notice id="prelude-extension">
`eval` prelude globals changed. This lists only what changed; any prelude not named here is unaffected.
{{#if added.length}}
Now available in JS/Python `eval`{{#if canRead}}; `read` the linked docs before first use{{#if anyFirstCall}} unless marked{{/if}}{{/if}}:
{{#each added}}
- `{{name}}`{{#if summary}}: {{summary}}{{/if}}{{#if firstCall}} (no `read` needed first: its first call's output carries the guide){{/if}}{{#if ../canRead}} → `xd://eval/{{name}}`{{/if}}
{{/each}}
{{/if}}
{{#if removed.length}}
No longer available; calls fail:
{{#each removed}}
- `{{this}}`
{{/each}}
{{/if}}
{{#each sections}}

{{this}}
{{/each}}
</system-notice>
