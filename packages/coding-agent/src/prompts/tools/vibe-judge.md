Asks the session's judge model typed questions about one `state` text — a worker result, a file excerpt, a diff. Cheap and fast; runs no code and touches no files.

Use for triage you would otherwise eyeball: did a worker's report claim tests passed, which of several results best meets the brief, how risky a change reads. Batch independent questions into one call; each sees the same `state` and is answered independently.

- `state` — the text to judge.
- `questions` — list; each has a unique `id` (its answer key) and is one of:
  - `{ id, type: "choice", instructions, criteria: [{ label, rubric? }, …] }` → `{ choice, probabilities, confidence }` (≥2 labels)
  - `{ id, type: "bool", instructions, criteria?: { true?, false? } }` → `{ bool: P(yes) }`
  - `{ id, type: "score", instructions, criteria: [lowest, …, highest] }` → `{ score, probabilities, confidence }` (≥2 levels)

Returns `{ answers: { id: answer }, model }`.

Judgments are probabilistic triage, not verification: still `read` the files a decision depends on.
