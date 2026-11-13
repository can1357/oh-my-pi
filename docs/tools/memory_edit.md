# memory_edit

> Update, forget, or invalidate Mnemopi or Supermemory long-term memories by id; preview a Supermemory forget by meaning.

## Source

- Entry: `packages/coding-agent/src/tools/memory-edit.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/memory-edit.md`
- Backend collaborators: `packages/coding-agent/src/mnemopi/state.ts` (`editScopedMemory(...)`); `packages/coding-agent/src/supermemory/state.ts` (`save(...)`, `forgetMemory(...)`, `previewForget(...)`) and `packages/coding-agent/src/supermemory/client.ts` (`addDocument`/`forgetMemories`/`previewForget`)

## Registration / Visibility

- Tool metadata: `approval = "read"`, `strict = true`, `loadMode = "discoverable"`, even though successful calls mutate local memory.
- Registration requires `memory.backend = "mnemopi"`, or `"supermemory"` with an API key, an accepted base URL and no invalid `SUPERMEMORY_NAMESPACE` (`isSupermemoryConfigured(...)`, the same gate as `recall`/`retain`); the tool is absent for `"off"`, `"local"`, `"hindsight"`, and an unconfigured Supermemory.
- In an unrestricted session with an explicit tool list, registration auto-includes `memory_edit` for Mnemopi and Supermemory. Restricted lists are not widened.
- In an ordinary `tools.xdev` session, discoverable built-ins may be presented as `xd://memory_edit`; an explicitly requested tool remains top-level.
- Mnemopi execution is synchronous and single-shot. Supermemory `forget`/`invalidate` is one HTTP request and `update` is two (add, then forget); the forget honours the tool call's abort signal.

## Inputs

| Field            | Type                                                       | Required | Description                                                                                         |
| ---------------- | ---------------------------------------------------------- | -------: | --------------------------------------------------------------------------------------------------- |
| `op`             | `"update" \| "forget" \| "invalidate" \| "preview_forget"` |      Yes | Edit operation to apply. `preview_forget` is Supermemory only.                                      |
| `id`             | `string`                                                   |       No | Memory id returned by `recall`; required for every op except `preview_forget`.                      |
| `query`          | `string`                                                   |       No | Natural-language description of what to forget; required for `preview_forget`, ignored otherwise.   |
| `content`        | `string`                                                   |       No | Replacement memory text for `update`.                                                               |
| `importance`     | `number`                                                   |       No | Replacement importance for `update`; clamped to `0..1`.                                             |
| `replacement_id` | `string`                                                   |       No | Superseding memory id recorded for `invalidate` (Mnemopi only; Supermemory accepts and ignores it). |

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
2. Every request goes to the session's namespace (`/ns/{namespace}/…`), the same one recall and retain use.
3. `forget` and `invalidate` → `DELETE /ns/{namespace}/memories` `{ ids: [id] }`. HTTP success does not mean the id changed: the tool succeeds when the id is in the response's `matches`, or when its per-id `errors` entry says it is already forgotten (a retried forget reached the desired state; the output says so), and otherwise maps that entry (see Errors). v5 has no forget reason, so `replacement_id` is accepted but not recorded.
4. `update`: v5 has no memory update. The tool first stores `content` (required, secret-redacted like other Supermemory writes) as a new document with instant processing, `POST /ns/{namespace}/document` `{ content, metadata: { source: "coding-agent-memory-edit", replaces: <id> }, dreaming: "instant" }`, then forgets the old id as in step 3 (already forgotten counts as done). If the add fails nothing changed and the tool throws; if the forget fails after it, the tool throws saying the corrected text was stored (naming the document id) but the memory could not be forgotten, with the reason. Supermemory forms the new memory from the document asynchronously, so it may take a moment and may be worded differently. Only `update` sends `dreaming: "instant"`; retention, `retain` and `learn` keep the server default. `importance` has no Supermemory equivalent: alone it is rejected; next to `content` it is ignored and the output says so. Both requests are tracked by the state's pending-write barrier (`/memory clear` and dispose wait for them).
5. `preview_forget` → `DELETE /ns/{namespace}/memories/semantic` `{ query, dryRun: true }`; `dryRun: false` is never sent, so it changes nothing. The query is secret-redacted, then cut to 2,000 characters; the server returns at most 100 matches. The output lists them as `- <memory> (id: <id>)` (terminal controls stripped) and tells the model to `forget` the ones it is sure about, one call per id (the guide's drift-free preview-then-exact-id flow); `details` is `{ status: "previewed", namespace, matches }`. It is a read, so it is not tracked in the pending-write barrier, but a disposed state still refuses it.
6. Output: `Memory <id> forgotten|invalidated in namespace <ns>.` (or `Memory <id> was already forgotten in namespace <ns>.`), or for `update` `Stored the corrected text as document <docId> in namespace <ns> and forgot memory <id>. Supermemory forms the new memory from the document asynchronously (instant processing), so it may take a moment and may be worded differently.`; `details` is `{ status, namespace, documentId? }`.

## Modes / Variants

- `update` replaces working-memory text and/or importance. Content replacement is wholesale, not a patch, and passes through `redactMemorySecrets(...)` before storage.
- `forget` permanently deletes working-memory rows.
- `invalidate` softly supersedes working or episodic rows and may record `replacement_id`.
- Fact rows are readable but immutable; every operation returns `not_editable`.
- `update`/`forget` against an episodic id returns `not_found` with its bank/store location because those operations only support working memory.
- Supermemory: the API's forget is a soft delete (excluded from search, preserved server-side), which is exactly Mnemopi's `invalidate` semantics, so `invalidate` maps to it. The API has no hard delete and no forget reason, so `forget` and `invalidate` send the same request; `forget` differs from Mnemopi's permanent delete. Only memory ids are editable: recall shows document-chunk results without an id.

## Side Effects

- Filesystem (Mnemopi): mutates the local Mnemopi SQLite database containing the resolved row, which may be a retain, recall, shared, or safely discovered legacy bank.
- Network: none for Mnemopi; edit operations do not invoke embedding or extraction providers. Supermemory sends `DELETE /ns/{namespace}/memories`, preceded for `update` by `POST /ns/{namespace}/document`; `preview_forget` sends one dry-run `DELETE /ns/{namespace}/memories/semantic`.
- Session state: reads the active session's scoped Mnemopi state; it does not rewrite already injected `<memories>` context.

## Limits & Caps

- Availability requires `memory.backend = "mnemopi"` or a configured `"supermemory"`; Hindsight and local file-backed memory do not expose this tool.
- `id` must be supplied directly; the tool does not search by content (Supermemory `preview_forget` only lists candidates).
- Mnemopi recall previews are capped at 500 characters by default. Always fetch `read memory://<id>` before `update`; the URL resolves the full row from the calling session's scoped banks. Supermemory recall shows full memory content; `read memory://<id>` adds its versions, linked memories and source document.
- `update` with neither `content` nor `importance` is rejected before any backend write.
- `importance` values outside `0..1` are clamped rather than rejected.

## Errors

- Throws `Mnemopi backend is not initialised for this session.` when the tool is exposed but session state is missing.
- Throws `memory_edit update requires content or importance.` for an empty update.
- Supermemory throws `Supermemory backend is not initialised for this session.` when state is missing; `memory_edit update requires content.` (or `… requires content: Supermemory memories have no importance.` for an importance-only update) before any request; `Memory <id> was not found in namespace <ns>.` when the id's forget error says not found; otherwise `Memory <id> was not forgotten in namespace <ns>: <server error>.` (control characters stripped, bounded). An already-forgotten id is not an error. A failed `update` forget is reported as `Stored the corrected text as document <docId> in namespace <ns>, but memory <id> could not be forgotten. …`. HTTP, timeout and invalid-JSON failures throw the client's messages, which never include the API key or response body.
- `preview_forget` throws `memory_edit preview_forget requires query.` for an empty query and, under Mnemopi, `memory_edit preview_forget is only available with Supermemory. …` naming `recall` then `forget` by id; other ops without `id` throw `memory_edit <op> requires id.`
- Missing, episodic-for-update/forget, and fact ids are normal results rather than thrown errors; inspect `details.status`.
- `read memory://<id>` throws `Mnemopi memory <id> not found in the calling session's scoped bank` when that session's banks do not contain the row; a row held only by another live session is not reachable. Under Supermemory it throws `Supermemory memory <id> not found in namespace <ns>.` on HTTP 404.

## Notes

- Read the full `memory://<id>` row before every update. Copying a clipped recall preview into `content` would delete the unseen tail.
- Prefer `invalidate` for stale working/episodic memories whose history may remain useful.
- Use `forget` only when a working-memory row should be hard-deleted.
