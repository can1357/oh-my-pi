Capture a reusable lesson into the configured long-term memory backend and/or an existing Obsidian vault, and optionally mint or enhance a managed skill in the same call.

Use after solving something whose insight will pay off again: a non-obvious fix, a project convention you had to discover, a workflow that worked.

Provide the optional `skill` object when the lesson is a repeatable *procedure* worth codifying as a `SKILL.md` (not just a fact). Managed skills are written to an isolated directory (`~/.ompk/agent/managed-skills`) and are surfaced like normal skills next session. They NEVER touch user-authored skills. Frontmatter is generated from `name` and `description`.

Capture sparingly and specifically. One strong, reusable lesson beats several vague ones.

When `autolearn.vaultPath` is configured, a secret-redacted learning note is stored under `Skills/Auto-Learn/Lessons` in that vault, even when the memory backend is off. Captured lessons are observations, not independently verified facts. Missing/unsafe vault destinations are reported; they are never implicitly created or replaced with a host-storage fallback. Memory may already be stored/queued when a mirror fails. Do not include credentials or unnecessary private data.

Learning capture does not run evolutionary evaluation or promote a candidate. `manage_skill evolve` and `promote` are separate opt-in, explicitly requested actions.
