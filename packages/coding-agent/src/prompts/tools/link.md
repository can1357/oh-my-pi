Create a typed edge between two native Mnemon insights.

Use after `retain` returns an id plus candidates, or when a recalled row is the real cause/correction of another. Do not link on keyword overlap alone.

Required: `id1`, `id2`, `type`, `weight`.
- Types: `causal` · `semantic` · `temporal` · `entity` · `supersedes`
- Weight: 0–1. Use `1` for `supersedes`.
- For a correction: `id1` = new memory, `id2` = old memory. Prose citation without this edge leaves the stale row ranked first.

Do not send `from`, `to`, `relation`, `reason`, or `meta`.
