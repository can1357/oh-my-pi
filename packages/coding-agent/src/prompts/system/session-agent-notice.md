<system-notice id="session-agents">
User-tagged model agents changed. These `m<N>` pseudonyms are the `agent` names accepted by `task` and eval `agent()`/`workpool()`, each pinned to the model the user tagged; spawn one only when the user names it. To run another listed agent on a tagged model, pass `<agent>@<provider/model>` with the full selector shown in parentheses, not `m<N>`. This lists only what changed; any pseudonym not named here is unaffected.
{{#if added.length}}
Now available:
{{#each added}}
- `{{name}}`: {{description}}
{{/each}}
{{/if}}
{{#if removed.length}}
No longer available; calls fail:
{{#each removed}}
- `{{this}}`
{{/each}}
{{/if}}
</system-notice>
