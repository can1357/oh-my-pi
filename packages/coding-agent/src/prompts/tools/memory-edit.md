{{#if supermemory}}
Edit Supermemory long-term memories by id. Only `(id: …)` values returned by `{{toolRefs.recall}}`, the `<supermemory_profile>` block, or `preview_forget`; `[document chunk]` results have no editable id.

Operations:
- `update`: `content` (required) is the corrected text. Stored as document D, then memory X forgotten. Supermemory forms the new memory from D asynchronously (instant processing): may take a moment, may be worded differently. `importance` unsupported.
- `forget`: soft-forget; hidden from recall, kept server-side. Already forgotten counts as done.
- `invalidate`: same soft forget. `replacement_id` accepted but not recorded (Supermemory keeps no forget reason).
- `preview_forget`: `query` (required, no `id`) describes what to forget in natural language; lists matching memories with ids. Changes nothing: then `forget` each id you are sure about, one call per id.

Prefer `update` for a memory whose content changed; `forget` for memory that should no longer be recalled. Neither hard-deletes.

`{{toolRefs.recall}}` shows full memory content; pass the complete merged text in `content`. `read memory://<id>` shows its versions and source.
{{else}}
Edit Mnemopi long-term memories by id. Only ids returned by `{{toolRefs.recall}}`.

Operations:
- `update`: working memory; replace content and/or importance.
- `forget`: permanently delete working memory.
- `invalidate`: softly supersede working or episodic memory; optional `replacement_id`.
- `preview_forget`: unsupported; `{{toolRefs.recall}}` to find memories, then `forget` by id.

Fact ids — `{{toolRefs.recall}}` results marked `[facts]`: read-only. Inspect with `read memory://<id>`; any edit op → `not_editable`.

Prefer `invalidate` for stale memory whose history may still be useful. Use `forget` only for content requiring hard deletion.

MUST read full memory before `update`. Recall previews clipped: trailing `…` marks truncation; `full_length` original size. `update` replaces content wholesale → updating a preview deletes its unseen tail. First `read memory://<id>`; pass merged content in `content`.
{{/if}}
