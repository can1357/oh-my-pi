# rlm

> Peek, search, or query spilled long context that is not in the neural window.

## Source

- Entry: `packages/coding-agent/src/tools/rlm.ts` (`RlmTool`)
- Store: `packages/coding-agent/src/rlm/`
- Registration: `packages/coding-agent/src/tools/index.ts`

## Registration / Visibility

- Requires `rlm.enabled = true` **or** `context.engine: rlm` (Settings → Context → RLM, or `/rlm on`).
- Defaults **off** (`context.engine: native`). Native compaction stays the default context engine.
- Metadata: `strict = true`, `loadMode = "essential"`, read approval.
- Mid-session `/rlm on` installs the tool via `setRlmToolEnabled` and sets `context.engine=rlm`.

## Settings

| Key | Default | Meaning |
| --- | --- | --- |
| `context.engine` | `native` | `native` \| `rlm` exclusive engine selection |
| `rlm.enabled` | `false` | Session opt-in (also set by `/rlm on`) |
| `rlm.spillBytes` | `20480` | Spill threshold for tool-result text |
| `rlm.maxDepth` | `0` | Depth ≥ 1 not implemented |
| `rlm.maxCalls` | `32` | Hard subcall cap |
| `rlm.maxTotalTokens` | `1000000` | Token charge cap |
| `rlm.maxCost` | `0` | USD-style cost cap (`0` = unlimited) |
| `rlm.wallClockMs` | `0` | Wall-clock budget from store creation (`0` = unlimited) |
| `rlm.subModel` | `""` | Optional sub-model id for query (empty = active model) |

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `op` | `peek` \| `search` \| `query` \| `status` | Yes | Operation |
| `handle` | string | peek/search/query | `rlm://h/<id>` from a spilled stub |
| `start` / `end` | number | No | Slice offsets |
| `pattern` | string | search | Regex |
| `question` | string | query | Question over a capped slice |
| `limit` | number | No | Search hit cap |

## Behavior

Tool results larger than `rlm.spillBytes` are replaced with a stub handle. Original bytes stay in the session `RlmStore` and never enter the next root provider request (`convertToLlm` fixture covered).

- **Runtime guide** is appended *after* the stable system prompt (prompt-cache safe for base bytes). Tool roster may still change when the `rlm` tool is installed mid-session.
- **`query`** is depth-0: completer sees only a capped excerpt via `ToolSession.rlmComplete` → `runEphemeralTurn` (model registry + usage). Missing completer / cancel / `maxCalls` / `maxTotalTokens` / `maxCost` / `wallClockMs` **fail open**.
- **Cancel** leaves handles + trajectory intact (`store.cancel`).
- **Compaction** of root chat must not clear the store (maintenance does not call `resetRlmStoresForTest`).

See RFC [#12400](https://github.com/can1357/oh-my-pi/issues/12400). Offline scorecard: `packages/coding-agent/evals/rlm/`.
