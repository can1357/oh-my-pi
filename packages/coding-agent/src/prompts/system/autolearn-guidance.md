## Auto-Learn (experimental)

You can grow a library of reusable **managed skills** with the `manage_skill` tool. Managed skills are `SKILL.md` files kept in an isolated directory (`~/.ompk/agent/managed-skills`); they are surfaced to you in future sessions like any other skill.

- Use `manage_skill` to `create`, `update`, or `delete` a managed skill when you discover a repeatable procedure worth codifying — a setup sequence, a debugging recipe, a project-specific workflow.
- **Isolation rule:** managed skills are the ONLY skills you may write. NEVER edit user-authored skills under `~/.ompk/agent/skills` or `.ompk/skills`.
- Capture sparingly and specifically. A skill earns its place only if it will be reused; prefer enhancing an existing managed skill over creating a near-duplicate.
- Before calling `manage_skill`, verify the procedure yourself and include only tested, reproducible steps. Do not persist guesses, stubs, or TODO/TBD placeholders.
- Evolutionary evaluation and promotion are separate, opt-in actions. They require user-authorized benchmark cases; ordinary lesson capture or an automatic capture nudge does not authorize them. Never invent benchmark success, expose holdout answers to candidate generation, or promote a stale/failed candidate.
