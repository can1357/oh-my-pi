# link

> Create a typed edge between two native Mnemon insights.

## Source
- Entry: `packages/coding-agent/src/tools/memory-link.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/link.md`
- Backend: `packages/coding-agent/src/mnemon/backend.ts` (`link(...)`)
- CLI: `mnemon link <id1> <id2> --type <type> --weight <0-1>`

## Registration / Visibility
- Tool metadata: `approval = "write"`, `strict = true`, `loadMode = "discoverable"`. Successful calls write a graph edge.
- Registered only when `memory.backend = "mnemon"`. Absent for `off`, `local`, `hindsight`, and `mnemopi`.
- Unrestricted sessions with an explicit tool list auto-include `recall` / `retain` / `link` / `related` / `forget` for Mnemon. Restricted lists are not widened.
- In an ordinary `tools.xdev` session the tool may appear as `xd://link`.

## Inputs

| Field | Type | Required | Description |
|---|---|---:|---|
| `id1` | `string` | Yes | Source insight UUID. For `supersedes` this is the new memory. |
| `id2` | `string` | Yes | Target insight UUID. For `supersedes` this is the old memory. |
| `type` | `"causal" \| "semantic" \| "temporal" \| "entity" \| "supersedes"` | Yes | Edge type. |
| `weight` | `number` | Yes | `0`–`1`. Use `1` for `supersedes`. |

Do not send `from`, `to`, `relation`, `reason`, or `meta`.

## Outputs
- Success: `linked <id1> → <id2> (<type>, <weight>)` with `details` from the backend.
- Rejection: the backend message, `useless = true`. Self-links, non-UUID ids, invalid type/weight, and missing insights are rejections, not thrown errors.

## Flow
1. `MemoryLinkTool.createIf(...)` exposes the tool only for `memory.backend == "mnemon"`.
2. `execute(...)` calls unbound-safe `mnemonBackend.link(...)`.
3. The backend validates UUIDs, type, and weight, then runs `mnemon link`.

## Notes
- `retain` now returns the new insight id plus candidates. Call `link` only when a real relationship exists.
- A prose citation without a `supersedes` edge leaves the stale row ranked first.
- Hindsight and Mnemopi have no typed graph; they do not mount this tool.
