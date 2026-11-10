# memory_edit

> Update, forget, or invalidate Mnemopi or Supermemory long-term memories by id.

## Source

- Entry: `packages/coding-agent/src/tools/memory-edit.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/memory-edit.md`
- Backend collaborators: `packages/coding-agent/src/mnemopi/state.ts` (`editScopedMemory(...)`); `packages/coding-agent/src/supermemory/state.ts` (`updateMemory(...)`) and `packages/coding-agent/src/supermemory/client.ts` (`updateMemory`/`forgetMemory`)

## Registration / Visibility

- Tool metadata: `approval = "read"`, `strict = true`, `loadMode = "discoverable"`, even though successful calls mutate local memory.
- Registration requires `memory.backend = "mnemopi"`, or `"supermemory"` with an API key and accepted base URL (`isSupermemoryConfigured(...)`, the same gate as `recall`/`retain`); the tool is absent for `"off"`, `"local"`, `"hindsight"`, and an unconfigured Supermemory.
- In an unrestricted session with an explicit tool list, registration auto-includes `memory_edit` for Mnemopi and Supermemory. Restricted lists are not widened.
- In an ordinary `tools.xdev` session, discoverable built-ins may be presented as `xd://memory_edit`; an explicitly requested tool remains top-level.
- Mnemopi execution is synchronous and single-shot. Supermemory execution is one HTTP request that honours the tool call's abort signal.

## Inputs

| Field            | Type                                   | Required | Description                                             |
| ---------------- | -------------------------------------- | -------: | ------------------------------------------------------- |
| `op`             | `"update" \| "forget" \| "invalidate"` |      Yes | Edit operation to apply.                                |
| `id`             | `string`                               |      Yes | Memory id returned by `recall`.                         |
| `content`        | `string`                               |       No | Replacement memory text for `update`.                   |
| `importance`     | `number`                               |       No | Replacement importance for `update`; clamped to `0..1`. |
| `replacement_id` | `string`                               |       No | Superseding memory id recorded for `invalidate`.        |

## Outputs

- `content[0].type = "text"`
- Successful mutations render `Memory <id> updated|deleted|invalidated in bank <bank> (<store>).`
- Unknown or operation-ineligible ids render `Memory <id> was not found...`; this is a normal result with status `not_found`.
- Fact ids render `Memory <id> is a read-only fact...; it cannot be edited. Read it with memory://<id>.`; this is a normal result with status `not_editable`.
- `details` is `{ status, bank?, store? }`, where status is `"updated" | "deleted" | "invalidated" | "not_found" | "not_editable"` and store is `"working" | "episodic" | "fact"` when a row was resolved.

## Flow

### Mnemopi

1. `MemoryEditTool.createIf(...)` exposes the tool only when `memory.backend == "mnemopi"`.
2. `execute(...)` fetches `session.getMnemopiSessionState()` and fails if the backend is not initialized.
3. `update` requires at least one of `content` or `importance`.
4. `importance` is clamped to `0..1` before the backend call.
5. The tool calls `state.editScopedMemory(op, id, { content, importance, replacementId })`.
6. The backend searches the deduplicated retain, recall, and global targets in that order. It returns the first successful editable result, otherwise the first resolved ineligible result, otherwise `not_found`.
7. The tool renders the returned status and passes the backend result through unchanged in `details`.

### Supermemory

1. `execute(...)` fetches `session.getSupermemorySessionState()` and fails if the backend is not initialized.
2. Every request is scoped to the session's container tag (`containerTag`), the same one recall and retain use.
3. `update` → `PATCH /v4/memories` `{ id, containerTag, newContent }`. `content` is required and secret-redacted like other Supermemory writes. Supermemory creates a new memory version (the old one is kept as non-latest) and the output names the new version id. `importance` has no Supermemory equivalent: alone it is rejected; next to `content` it is ignored and the output says so.
4. `forget` → `DELETE /v4/memories` `{ id, containerTag }`.
5. `invalidate` → `DELETE /v4/memories` `{ id, containerTag, reason }`, where `reason` is `superseded by <replacement_id>` or `invalidated`.
6. Output: `Memory <id> updated|forgotten|invalidated in container <tag>.`; `details` is `{ status, container, newId? }`.

## Modes / Variants

- `update` replaces working-memory text and/or importance. Content replacement is wholesale, not a patch, and passes through `redactMemorySecrets(...)` before storage.
- `forget` permanently deletes working-memory rows.
- `invalidate` softly supersedes working or episodic rows and may record `replacement_id`.
- Fact rows are readable but immutable; every operation returns `not_editable`.
- `update`/`forget` against an episodic id returns `not_found` with its bank/store location because those operations only support working memory.
- Supermemory: the API's forget is a soft delete (excluded from search, preserved server-side), which is exactly Mnemopi's `invalidate` semantics, so `invalidate` maps to it and records the replacement in the forget reason. The API has no hard delete, so `forget` is the same soft forget without a reason; it differs from Mnemopi's permanent delete. Only memory ids are editable: recall shows document-chunk results without an id.

## Side Effects

- Filesystem (Mnemopi): mutates the local Mnemopi SQLite database containing the resolved row, which may be a retain, recall, shared, or safely discovered legacy bank.
- Network: none for Mnemopi; edit operations do not invoke embedding or extraction providers. Supermemory sends one `PATCH` or `DELETE /v4/memories` request.
- Session state: reads the active session's scoped Mnemopi state; it does not rewrite already injected `<memories>` context.

## Limits & Caps

- Availability requires `memory.backend = "mnemopi"` or a configured `"supermemory"`; Hindsight and local file-backed memory do not expose this tool.
- `id` must be supplied directly; the tool does not search by content.
- Mnemopi recall previews are capped at 500 characters by default. Always fetch `read memory://<id>` before `update`; the URL resolves the full row from the calling session's scoped banks. Supermemory recall shows full memory content; `memory://` does not resolve Supermemory ids.
- `update` with neither `content` nor `importance` is rejected before any backend write.
- `importance` values outside `0..1` are clamped rather than rejected.

## Errors

- Throws `Mnemopi backend is not initialised for this session.` when the tool is exposed but session state is missing.
- Throws `memory_edit update requires content or importance.` for an empty update.
- Supermemory throws `Supermemory backend is not initialised for this session.` when state is missing; `memory_edit update requires content.` (or `… requires content: Supermemory memories have no importance.` for an importance-only update) before any request; `Memory <id> was not found in container <tag>.` for HTTP 404; `Memory <id> is already forgotten in container <tag>.` for HTTP 409. Other HTTP, timeout and invalid-JSON failures throw the client's messages, which never include the API key or response body.
- Missing, episodic-for-update/forget, and fact ids are normal results rather than thrown errors; inspect `details.status`.
- `read memory://<id>` throws `Mnemopi memory <id> not found in the calling session's scoped bank` when that session's banks do not contain the row; a row held only by another live session is not reachable.

## Notes

- Read the full `memory://<id>` row before every update. Copying a clipped recall preview into `content` would delete the unseen tail.
- Prefer `invalidate` for stale working/episodic memories whose history may remain useful.
- Use `forget` only when a working-memory row should be hard-deleted.
