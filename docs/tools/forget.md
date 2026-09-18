# forget

> Soft-delete one native Mnemon insight.

## Source
- Entry: `packages/coding-agent/src/tools/memory-forget.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/forget.md`
- Backend: `packages/coding-agent/src/mnemon/backend.ts` (`forget(...)`)
- CLI: `mnemon forget <id>`

## Registration / Visibility
- Tool metadata: `approval = "write"`, `strict = true`, `loadMode = "discoverable"`.
- Registered only when `memory.backend = "mnemon"`.
- Unrestricted sessions auto-include it with the other Mnemon tools.

## Inputs

| Field | Type | Required | Description |
|---|---|---:|---|
| `id` | `string` | Yes | Insight UUID to soft-delete. |

## Outputs
- Success: `forgot <id>`.
- Rejection: the backend message, `useless = true`. Non-UUID ids and missing insights are rejections.

## Notes
- Soft-delete only: the row is excluded from recall, not wiped from disk.
- Prefer a new row plus `link type=supersedes` for ordinary corrections.
- `/memory clear` still refuses to wipe the store.
