# memory_edit

> Update, forget, or invalidate Mnemopi long-term memories by id.

## Source
- Entry: `packages/coding-agent/src/tools/memory-edit.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/memory-edit.md`
- Backend collaborator: `packages/coding-agent/src/mnemopi/state.ts` (`editScopedMemory(...)`)

## Registration / Visibility
- Tool metadata: `approval = "read"`, `strict = true`, `loadMode = "discoverable"`, even though successful calls mutate local memory.
- Registration requires `memory.backend = "mnemopi"`; the tool is absent for `"off"`, `"local"`, and `"hindsight"`.
- In an unrestricted session with an explicit tool list, registration auto-includes `memory_edit` for Mnemopi. Restricted lists are not widened.
- In an ordinary `tools.xdev` session, discoverable built-ins may be presented as `xd://memory_edit`; an explicitly requested tool remains top-level.
- Execution is synchronous and single-shot, with no progress callback or cancellation parameter.

## Inputs

| Field | Type | Required | Description |
|---|---|---:|---|
| `op` | `"update" \| "forget" \| "invalidate"` | Yes | Edit operation to apply. |
| `id` | `string` | Yes | Memory id returned by `recall`. |
| `content` | `string` | No | Replacement memory text for `update`. |
| `importance` | `number` | No | Replacement importance for `update`; clamped to `0..1`. |
| `replacement_id` | `string` | No | Superseding memory id recorded for `invalidate`. |

## Outputs
- `content[0].type = "text"`
- Successful mutations render `Memory <id> updated|deleted|invalidated in bank <bank> (<store>).`
- Unknown or operation-ineligible ids render `Memory <id> was not found...`; this is a normal result with status `not_found`.
- Fact ids render `Memory <id> is a read-only fact...; it cannot be edited. Read it with memory://<id>.`; this is a normal result with status `not_editable`.
- `details` is `{ status, bank?, store? }`, where status is `"updated" | "deleted" | "invalidated" | "not_found" | "not_editable"` and store is `"working" | "episodic" | "fact"` when a row was resolved.

## Flow
1. `MemoryEditTool.createIf(...)` exposes the tool only when `memory.backend == "mnemopi"`.
2. `execute(...)` fetches `session.getMnemopiSessionState()` and fails if the backend is not initialized.
3. `update` requires at least one of `content` or `importance`.
4. `importance` is clamped to `0..1` before the backend call.
5. The tool calls `state.editScopedMemory(op, id, { content, importance, replacementId })`.
6. The backend searches the deduplicated retain, recall, and global targets in that order. It returns the first successful editable result, otherwise the first resolved ineligible result, otherwise `not_found`.
7. The tool renders the returned status and passes the backend result through unchanged in `details`.

## Modes / Variants
- `update` replaces working-memory text and/or importance. Content replacement is wholesale, not a patch.
- `forget` permanently deletes working-memory rows.
- `invalidate` softly supersedes working or episodic rows and may record `replacement_id`.
- Fact rows are readable but immutable; every operation returns `not_editable`.
- `update`/`forget` against an episodic id returns `not_found` with its bank/store location because those operations only support working memory.

## Side Effects
- Filesystem: mutates the local Mnemopi SQLite database containing the resolved row, which may be a retain, recall, shared, or safely discovered legacy bank.
- Network: none; edit operations do not invoke embedding or extraction providers.
- Session state: reads the active session's scoped Mnemopi state; it does not rewrite already injected `<memories>` context.

## Limits & Caps
- Availability requires `memory.backend = "mnemopi"`; Hindsight and local file-backed memory do not expose this tool.
- `id` must be supplied directly; the tool does not search by content.
- Recall previews are capped at 500 characters by default. Always fetch `read memory://<id>` before `update`; the URL resolves the full row from the calling session's scoped banks.
- `update` with neither `content` nor `importance` is rejected before any backend write.
- `importance` values outside `0..1` are clamped rather than rejected.

## Errors
- Throws `Mnemopi backend is not initialised for this session.` when the tool is exposed but session state is missing.
- Throws `memory_edit update requires content or importance.` for an empty update.
- Missing, episodic-for-update/forget, and fact ids are normal results rather than thrown errors; inspect `details.status`.
- `read memory://<id>` throws `Mnemopi memory <id> not found in the calling session's scoped bank` when that session's banks do not contain the row; a row held only by another live session is not reachable.

## Notes
- Read the full `memory://<id>` row before every update. Copying a clipped recall preview into `content` would delete the unseen tail.
- Prefer `invalidate` for stale working/episodic memories whose history may remain useful.
- Use `forget` only when a working-memory row should be hard-deleted.
