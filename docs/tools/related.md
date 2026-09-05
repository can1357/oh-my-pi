# related

> Walk typed neighbors of one native Mnemon insight.

## Source
- Entry: `packages/coding-agent/src/tools/memory-related.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/related.md`
- Backend: `packages/coding-agent/src/mnemon/backend.ts` (`related(...)`)
- CLI: `mnemon related <id> [--edge <type>] [--depth <n>]`

## Registration / Visibility
- Tool metadata: `approval = "read"`, `strict = true`, `loadMode = "discoverable"`.
- Registered only when `memory.backend = "mnemon"`.
- Unrestricted sessions auto-include it with `recall` / `retain` / `link` / `forget`.

## Inputs

| Field | Type | Required | Description |
|---|---|---:|---|
| `id` | `string` | Yes | Insight UUID to walk from. |
| `type` | `"causal" \| "semantic" \| "temporal" \| "entity" \| "supersedes"` | No | Edge filter. |
| `depth` | `number` | No | Max hops, clamped to 1–4. Default 2. |

## Outputs
- Matches: a bullet list with category, importance, via-edge, and hop.
- Empty or invalid id/type: the backend message, `useless = true`.

## Notes
- This is the read path for edges written by `link`. Flat `recall` cannot replace it.
- Hindsight and Mnemopi do not mount this tool.
