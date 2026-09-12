Store ≥1 fact in long-term memory for future sessions.

Use: durable, reusable knowledge—user preferences, project decisions, architectural choices; anything improving future responses. No ephemeral task state.

Each item MUST be specific, self-contained: who, what, when, why. Batch related facts per call; deduplicated and consolidated.

On `memory.backend: mnemon`, set `category` (`preference` · `decision` · `insight` · `fact` · `context`) and `importance` (1–5; default 3; 4+ is prune-immune). Optional `entities` is a comma-separated string. The receipt includes the new insight id and optional candidates. Call `link` when a real relationship exists. For a correction, cite the old id in the text AND `link` with `type: supersedes` (`id1` = new, `id2` = old).

