Managed skill: `SKILL.md` in isolated `~/.omp/agent/managed-skills`; immediately available via `skill://` after writing. Changes are announced in a hidden notice on the next user request; the cached system listing catches up at the next unrelated rebuild or session start/resume, not compaction.

Use: repeatable procedures worth codifying — setup sequence, debugging recipe, project-specific workflow.
User-authored skills separate; tool NEVER edits them.

- `action: "create"` — fails if skill exists.
- `action: "update"` — overwrites body; fails if skill absent.
- `action: "delete"` — fails if skill absent.

`name`: kebab-case (lowercase letters, digits, hyphens).
`description`: specific; drives discovery.
No frontmatter in `body`; generated from `name` and `description`.
