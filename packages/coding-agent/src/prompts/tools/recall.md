Search long-term memory; return raw relevance-ranked matching entries.

Use proactively before questions about past conversations, user preferences, project decisions, or topics where prior context improves accuracy. When in doubt, recall first.

Narrow the search when the question is specific: `memory_type` (semantic/episodic/procedural/working), `tags` (ANY-match filter), `since`/`until` (created_at window), `min_importance` (0–1 floor). Omit them for a broad recall.

`{{toolRefs.recall}}`: specific facts or entries. `{{toolRefs.reflect}}`: synthesized answer across many memories.

Results: content preview. Trailing `…`: truncation (`truncated: true`; `full_length`: original size). Before any `{{toolRefs.memory_edit}} update`, MUST fetch full row: `read memory://<id>`.
