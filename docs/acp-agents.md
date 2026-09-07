# ACP Subagent Activity Extension

`omp acp` exposes subagent lifecycle and usage telemetry to ACP clients through
two `_omp/*` extension methods. They mirror the Agent Hub roster: the same
`AgentRegistry` the TUI, collab, and `history://` surfaces read, serialized for
the wire.

Primary implementation:

- `packages/coding-agent/src/modes/acp/acp-agent.ts` (`AcpAgentSnapshot`,
  `snapshotAcpAgents`, `AcpAgent.#scheduleAgentsBroadcast`)

The extension surface is opt-in: clients declare
`clientCapabilities.extensions.agents` during `initialize`. Connections that do
not declare it receive no `_omp/agents*` frames at all, and `_omp/agents/*`
requests are rejected with a method-not-found error naming the capability.

## Request: `_omp/agents/list`

Returns the current roster. No parameters.

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "_omp/agents/list",
  "params": {}
}
```

Response `result`:

```json
{
  "agents": [
    {
      "id": "Main",
      "displayName": "Main",
      "kind": "main",
      "status": "running",
      "sessionFile": null,
      "createdAt": 1750000000000,
      "lastActivity": 1750000001000
    },
    {
      "id": "AuthLoader",
      "displayName": "AuthLoader",
      "kind": "sub",
      "parentId": "Main",
      "status": "running",
      "sessionFile": "/home/user/.omp/sessions/auth-loader.jsonl",
      "createdAt": 1750000000100,
      "lastActivity": 1750000002000,
      "activity": "grepping call sites of resolve()",
      "resolvedModel": "anthropic/claude-sonnet-4-20250514",
      "metrics": {
        "tokens": 900,
        "requests": 2,
        "tools": 5,
        "cost": 0.01,
        "durationMs": 12000
      }
    }
  ]
}
```

Field reference:

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | string | Registry id (`"Main"` for the driving agent, subagent ids for task spawns). |
| `displayName` | string | Roster display name. |
| `kind` | `"main"` \| `"sub"` | Advisor transcripts are observability-only and never serialized. |
| `parentId` | string? | Parent agent id, when the spawn recorded one. |
| `status` | `"running"` \| `"idle"` \| `"parked"` \| `"aborted"` | Lifecycle state. Finished agents stay `idle`; disposed-but-revivable agents are `parked`; hard-killed agents are `aborted`. |
| `sessionFile` | string \| null | Transcript session file. Clients can resolve it through `history://`/`agent://` on the same machine. |
| `createdAt` | number | Registration timestamp (ms). |
| `lastActivity` | number | Last work/status-change timestamp (ms). |
| `activity` | string? | One-line gist of current work; present only while `status` is `running`. |
| `resolvedModel` | string? | Last resolved model id, when recorded. |
| `metrics` | object? | Persisted usage totals (`tokens`, `requests`, `tools`, `cost`, `durationMs`, optional `contextTokens`/`contextWindow`), present once the agent finished a turn. |

## Notification: `_omp/agents/update`

Pushed after the client's `initialize` completes and again, debounced (100 ms),
on every registry change: subagent spawn, status transition, usage-metadata
record, or removal. The payload is the same full `agents` snapshot as
`_omp/agents/list`, so clients can live-track subagent lifecycle without
polling. A client that subscribes to the notification right after `initialize`
also receives the initial snapshot (in-order JSON-RPC guarantees it lands after
the `initialize` response).

```json
{
  "jsonrpc": "2.0",
  "method": "_omp/agents/update",
  "params": { "agents": [] }
}
```

## Notification: `_omp/agents/progress`

Pushed whenever the task executor reports subagent work over the session's task
event channels — including background spawns whose `task` tool call settles
before any subagent frame arrives, plus terminal lifecycle transitions folded
into the last known snapshot so failures are explicit. Carries one subagent's
live work snapshot:

```json
{
  "jsonrpc": "2.0",
  "method": "_omp/agents/progress",
  "params": {
    "agent": {
      "id": "ReadA",
      "index": 0,
      "agent": "task",
      "status": "running",
      "description": "read a.ts",
      "task": "…",
      "lastIntent": "reading a.ts with the read tool",
      "currentTool": "read",
      "currentToolArgs": "a.ts",
      "recentOutput": ["export const a = 1"],
      "toolCount": 2,
      "requests": 1,
      "tokens": 120,
      "cost": 0.001,
      "durationMs": 5000,
      "resolvedModel": "opencode-go/deepseek-v4-flash"
    }
  }
}
```

`status` is one of `pending | running | completed | failed | aborted`; the
verbose `task`/`description`/`lastIntent` texts are bounded on the wire. The
`id` matches the roster snapshot id, so clients upsert the same card.

## Request: `_omp/agents/messages`

Returns a subagent's transcript (its own messages, including `thinking`
blocks) so clients can render subagent reasoning inside the subagent's card.
Mirrors the RPC `get_subagent_messages` surface.

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "_omp/agents/messages",
  "params": { "agentId": "ReadA", "fromByte": 0 }
}
```

Either `agentId` (registry id from a roster snapshot) or `sessionFile` may be
given; `fromByte` resumes a previous read (byte offset, line-aligned). Only
files claimed by a registered main or sub agent are readable — arbitrary paths
and advisor transcripts are rejected. A single request consumes at most
512 KiB beyond `fromByte`, cut at a complete line on a whole code point
boundary, so continuation reads at `nextByte` never lose or duplicate data.

```json
{
  "sessionFile": "…/ReadA.jsonl",
  "fromByte": 0,
  "nextByte": 4096,
  "reset": false,
  "messages": [
    { "role": "user", "content": [{ "type": "text", "text": "…" }] },
    {
      "role": "assistant",
      "content": [
        { "type": "thinking", "thinking": "Let me read the file…" },
        { "type": "text", "text": "…" }
      ]
    }
  ]
}
```

Poll with `fromByte: nextByte` until `nextByte` stops advancing (or `reset`
appears after a file rotation). A single JSONL record larger than the
512 KiB budget is still delivered whole — the read spans up to 8 MiB to reach
its terminating newline. When pagination reaches a record exceeding even that
internal ceiling, that poll stops advancing the cursor and reports
`pendingOversizedRecord: true` instead of a silent no-progress stall.

## Tool-call classification

`tool_call` and `tool_call_update` notifications carry an extension field
`toolName` (the harness tool name, e.g. `task`), so clients can classify the
task tool beyond the spec `kind` (which maps it to `other`).

## Notes

- The roster is process-global: concurrent ACP sessions (or a simultaneously
  running TUI) share one `AgentRegistry`, so snapshots include subagents spawned
  by other sessions of the same process. Filter by `kind: "sub"` (and
  optionally `parentId`) to scope to subagent work.
- Tool statuses on the wire are terminal: `tool_call_update` emits
  `completed`/`failed` once, and late async progress (task/job callbacks that
  fire after the loop finalized a call) is suppressed so clients never see an
  `in_progress` that reopens a finished tool call.
- `activity` refreshes on status/metadata boundaries, not per tool call, so it
  is a coarse "what is it doing" gist, matching the Agent Hub roster.
- Subagent progress frames cover top-level spawns of a session today; nested
  spawns (a subagent spawning further agents) stream only their own channel
  traffic, and deeper descendants surface through the registry-driven
  `_omp/agents/update` roster once they register.
- The surface is transport-agnostic: `omp acp` over stdio and embedders that
  construct sessions directly share the same `extMethod`/`extNotification`
  dispatch through `AgentSideConnection`.
