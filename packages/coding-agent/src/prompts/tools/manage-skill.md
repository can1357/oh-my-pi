Create, update, or delete a managed skill — a `SKILL.md` written to an isolated directory (`~/.ompk/agent/managed-skills`) and surfaced like a normal skill in future sessions.

Managed skills are for repeatable procedures worth codifying: a setup sequence, a debugging recipe, a project-specific workflow. They are kept separate from user-authored skills and this tool NEVER edits those.

- `action: "create"` — fails if the skill already exists.
- `action: "update"` — overwrites the body; fails if the skill does not exist.
- `action: "delete"` — fails if the skill does not exist.
- `action: "evolve"` — requires the opt-in evolution setting and an `evolution` object with `lessons`, disjoint `training` and `holdout` arrays of `{id, prompt, expected}`. Uses the current model for a bounded text-only candidate search (no tools). Optional rounds/candidates are 1–3 each. This uses extra model calls: only start when the user requests evaluation and supplies/approves independent cases. Expected answers are exact-match after trimming; do not invent passing evidence or put held-out answers in lessons or training prompts. Returns an audit run ID; NEVER installs candidates automatically.
- `action: "promote"` — requires `name` and the eligible `runId`. Explicitly installs only a training improvement without training/holdout regressions, and only if the original managed skill is unchanged. Rejects authored names, stale baselines and repeat promotions. Keep the old skill in the local evaluation audit for recovery; do not retry a partial promotion blindly.

`name` is kebab-case (lowercase letters, digits, hyphens). The `description` drives discovery, so make it specific. Do not include frontmatter in `body`; it is generated from `name` and `description`.

Before calling, verify the procedure and include only tested, reproducible steps in `body`. Reject stubs and TODO/TBD/placeholder-only content.

When configured, captured lessons and evaluation/promotion summaries are mirrored to an existing Obsidian vault. A failed mirror is reported separately from retained local evidence or an already-completed promotion. Benchmark results establish only performance on the supplied cases, not universal correctness. Do not use evolve/promote during an automatic capture nudge; that nudge is not authorization for paid evaluation or promotion.
