Managed skill: `SKILL.md` in an isolated omp-owned store; surfaced as a normal skill in future sessions.

Use: repeatable procedures worth codifying — setup sequence, debugging recipe, project-specific workflow.
User-authored skills separate; tool NEVER edits them.

`scope` selects one store for this call: `global` across projects or `project` for a project-specific procedure.
Without `scope`, create uses global; update and delete target the visible managed copy (project before global). A linked copy cannot be changed.

- `action: "create"` — fails if skill exists.
- `action: "update"` — overwrites body; fails if skill absent.
- `action: "delete"` — fails if skill absent.

`name`: kebab-case (lowercase letters, digits, hyphens).
`description`: specific; drives discovery.
No frontmatter in `body`; generated from `name` and `description`.
