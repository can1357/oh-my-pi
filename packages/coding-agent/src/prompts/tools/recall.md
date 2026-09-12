Search long-term memory; return raw relevance-ranked matching entries.

Use proactively before questions about past conversations, user preferences, project decisions, or topics where prior context improves accuracy. When in doubt, recall first.

`recall`: specific facts or entries. `reflect`: synthesized answer across many memories. On `memory.backend: mnemon`, optional `limit` caps results (default 10); use `related` to walk the graph around an id.

Results: content preview. Trailing `…`: truncation (`truncated: true`; `full_length`: original size). Before any `memory_edit update`, MUST fetch full row: `read memory://<id>`.

