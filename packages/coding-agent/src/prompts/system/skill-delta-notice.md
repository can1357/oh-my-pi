<system-notice id="skill-delta">
The available skills changed. This notice supersedes the cached <skills> listing only for the names below; other skills are unaffected.
{{#if added.length}}
New or updated skills (read `skill://<name>` before use):
{{#each added}}
- {{name}}: {{description}}
{{/each}}
{{/if}}
{{#if removed.length}}
No longer available; do not load:
{{#each removed}}
- {{this}}
{{/each}}
{{/if}}
</system-notice>
