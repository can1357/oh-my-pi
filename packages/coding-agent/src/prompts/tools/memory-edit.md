{{#if supermemory}}
Edit Supermemory long-term memories by id. Only `(id: …)` values returned by `{{toolRefs.recall}}`; `[document chunk]` results have no editable id.

Operations:
- `update`: `content` (required) replaces the memory wholesale. Stored as a new document, then the old memory is forgotten; the new memory appears after Supermemory processes the document. `importance` unsupported.
- `forget`: soft-forget; hidden from recall, kept server-side.
- `invalidate`: same soft forget. `replacement_id` accepted but not recorded (Supermemory keeps no forget reason).

Prefer `update` for a memory whose content changed; `forget` for memory that should no longer be recalled. Neither hard-deletes.

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
