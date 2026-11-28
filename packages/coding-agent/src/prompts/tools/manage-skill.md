Managed skill: `SKILL.md` in isolated `~/.omp/agent/managed-skills`; surfaced as a normal skill in future sessions.

Use: repeatable procedures worth codifying — setup sequence, debugging recipe, project-specific workflow.
User-authored skills separate; tool NEVER edits them.

- `action: "create"`: needs `description` and `body`; fails if skill exists.
- `action: "update"`: pass `description`, `body`, or both; an omitted field keeps its stored value. `body` replaces the whole body. Fails if skill absent.
- `action: "delete"`: fails if skill absent.

`name`: kebab-case (lowercase letters, digits, hyphens).
`description`: specific; drives discovery.
No frontmatter in `body`; generated from `name` and `description` (a leading frontmatter block is stripped).
