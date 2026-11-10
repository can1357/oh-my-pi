{{#if supermemory}}
Edit Supermemory long-term memories by id. Only `(id: …)` values returned by `{{toolRefs.recall}}`; `[document chunk]` results have no editable id.

Operations:
- `update`: replace content wholesale with `content` (required); creates a new memory version, old version kept. `importance` unsupported.
- `forget`: soft-forget; hidden from recall, kept server-side.
- `invalidate`: same soft forget, recorded as superseded by optional `replacement_id`.

Prefer `invalidate` for stale memory replaced by a newer one; `forget` for memory that should no longer be recalled. Neither hard-deletes.

`{{toolRefs.recall}}` shows full memory content; pass the complete merged text in `content`.
{{else}}
Edit Mnemopi long-term memories by id. Only ids returned by `{{toolRefs.recall}}`.

Operations:
- `update`: working memory; replace content and/or importance.
- `forget`: permanently delete working memory.
- `invalidate`: softly supersede working or episodic memory; optional `replacement_id`.

Fact ids — `{{toolRefs.recall}}` results marked `[facts]`: read-only. Inspect with `read memory://<id>`; any edit op → `not_editable`.

Prefer `invalidate` for stale memory whose history may still be useful. Use `forget` only for content requiring hard deletion.

MUST read full memory before `update`. Recall previews clipped: trailing `…` marks truncation; `full_length` original size. `update` replaces content wholesale → updating a preview deletes its unseen tail. First `read memory://<id>`; pass merged content in `content`.
{{/if}}
