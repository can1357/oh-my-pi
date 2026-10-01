[IMPORTANT: User invoked the "{{name}}" skill; follow its instructions. Full skill below.]

{{body}}

---

[Skill directory: {{baseDir}}]
Resolve relative paths in this skill (e.g. `scripts/foo.js`, `templates/config.yaml`) against this absolute directory; read referenced assets and templates; run scripts with the terminal tool when skill instructions call for it.
{{#if userArgs}}
User: {{userArgs}}
{{/if}}
