# rlm

> Peek, search, or query spilled long context that is not in the neural window.

## Source

- Entry: `packages/coding-agent/src/tools/rlm.ts` (`RlmTool`)
- Store: `packages/coding-agent/src/rlm/`
- Registration: `packages/coding-agent/src/tools/index.ts`

## Registration / Visibility

- Requires `rlm.enabled = true` (Settings → Context → RLM, or `/rlm on`).
- Defaults **off**. Native compaction stays the default context engine.
- Metadata: `strict = true`, `loadMode = "essential"`, read approval.

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

Tool results larger than `rlm.spillBytes` (default 20480) are replaced with a stub handle. The original bytes stay in the session RLM store and never enter the next root provider request. `query` is depth-0: the completer sees only a capped excerpt. Missing completer or exhausted `maxCalls` / `maxTotalTokens` fail open.

See RFC [#12400](https://github.com/can1357/oh-my-pi/issues/12400).
