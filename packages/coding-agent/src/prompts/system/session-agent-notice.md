<system-notice id="session-agents">
Session agents changed. These are `agent` values for `task` and eval `agent()`/`workpool()`. Named agent definitions and spawn restrictions still take precedence.
{{#if added.length}}
Now available (`m<N>` names are user-tagged models, use only when the user names them):
{{#each added}}
- `{{name}}`: {{description}}
{{/each}}
{{/if}}
{{#if addedModels.length}}
Now available model agents (general-purpose, pinned to the exact `provider/model`): {{#list addedModels join=", "}}`{{this}}`{{/list}}
{{/if}}
{{#if removed.length}}
Session model agents removed (a separately configured agent with the same name is unaffected):
{{#each removed}}
- `{{this}}`
{{/each}}
{{/if}}
</system-notice>
