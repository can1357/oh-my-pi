Search long-term memory; return raw relevance-ranked matching entries.

Use proactively before questions about past conversations, user preferences, project decisions, or topics where prior context improves accuracy. When in doubt, recall first.

`{{toolRefs.recall}}`: specific facts or entries.{{#unless supermemory}} `{{toolRefs.reflect}}`: synthesized answer across many memories.{{/unless}}

{{#if supermemory}}
Results: full memory content with `(id: …)` for `{{toolRefs.memory_edit}}`; `[document chunk]` results are not editable.
`[inferred]`: inferred by Supermemory, not stated directly; weigh it below stated facts.
`read memory://<id>`: a memory's earlier/later versions, linked memories and source document; read it before editing when history matters.
{{else}}
Results: content preview. Trailing `…`: truncation (`truncated: true`; `full_length`: original size). Before any `{{toolRefs.memory_edit}} update`, MUST fetch full row: `read memory://<id>`.
{{/if}}
