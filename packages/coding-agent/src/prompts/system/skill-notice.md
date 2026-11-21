<system-notice id="skills">
Skills changed this session. Matching skill → MUST read `skill://<name>` first. This lists only what changed; any skill not named here is unaffected.
{{#if added.length}}
Now available:
{{#each added}}
- {{name}}: {{description}}
{{/each}}
{{/if}}
{{#if updated.length}}
Updated (this description replaces the earlier one):
{{#each updated}}
- {{name}}: {{description}}
{{/each}}
{{/if}}
{{#if removed.length}}
No longer available:
{{#each removed}}
- `{{this}}`
{{/each}}
{{/if}}
</system-notice>
