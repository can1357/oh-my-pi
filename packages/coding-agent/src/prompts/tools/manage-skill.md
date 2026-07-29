Create, update, or delete a managed skill — a `SKILL.md` written to an isolated directory (`~/.ompk/agent/managed-skills`) and surfaced like a normal skill in future sessions.

Managed skills are for repeatable procedures worth codifying: a setup sequence, a debugging recipe, a project-specific workflow. They are kept separate from user-authored skills and this tool NEVER edits those.

- `action: "create"` — fails if the skill already exists.
- `action: "update"` — overwrites the body; fails if the skill does not exist.
- `action: "delete"` — fails if the skill does not exist.

`name` is kebab-case (lowercase letters, digits, hyphens). The `description` drives discovery, so make it specific. Do not include frontmatter in `body`; it is generated from `name` and `description`.

Before calling, verify the procedure and include only tested, reproducible steps in `body`. Reject stubs and TODO/TBD/placeholder-only content.
