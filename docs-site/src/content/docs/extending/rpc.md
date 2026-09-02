---
title: RPC
description: Drive omp from another process — a newline-delimited JSON protocol over stdio with ready-frame negotiation, host-owned tools, and TypeScript/Python client libraries.
coverage: A
---

**RPC mode** runs omp as a separate process you talk to over newline-delimited JSON on stdio — useful for cross-language drivers, IDE integrations, and isolated workers. For in-process embedding use the [SDK](/oh-my-pi/extending/sdk/) instead; for a side-by-side comparison of the two surfaces see [RPC vs SDK](/oh-my-pi/extending/rpc-vs-sdk/).

- **stdin**: commands (`RpcCommand`), extension UI responses, host-tool updates/results
- **stdout**: a ready frame, command responses (`RpcResponse`), session/agent events, extension UI requests, host-tool requests/cancellations

The canonical wire contract lives in `packages/coding-agent/src/modes/rpc/rpc-types.ts` and `docs/rpc.md` (dev docs). The bundled `RpcClient` (TypeScript and Python) handles framing, negotiation, and message pagination so most callers never see raw frames.

## Startup

```bash
omp --mode rpc [regular CLI options]
```

Behavior notes:

- `@file` CLI arguments are rejected in RPC mode.
- Automatic session-title generation is disabled by default to avoid an extra model call.
- Workflow-altering settings — `task.*` isolation/eager/batch/concurrency/agent limits, `memory.backend`/`memories.enabled`, `advisor.*`/`tier.advisor`, `async.*`, and `bash.autoBackground.*` — are reset to built-in defaults instead of inheriting user overrides; `todo.*` is deliberately caller-controlled and never host-defaulted. Explicit configuration (project/global config, `--config`, isolated settings) remains authoritative.
- The process claims stdin before extension discovery, then parses it one non-empty JSONL line at a time. Malformed JSON emits a recoverable `command: "parse"` failure and does not terminate the loop.
- At startup omp writes a `ready` frame before processing commands; the frame advertises supported protocol versions and transport limits.
- When stdin closes, pending extension UI, host-tool, and host-URI requests are rejected; accepted commands are drained, the session is disposed, and the process exits with code `0`.

### Ready frame and protocol negotiation

```json
{
  "type": "ready",
  "protocolVersion": 1,
  "supportedProtocolVersions": [1, 2],
  "maxFrameBytes": 1048576,
  "maxReassembledFrameBytes": 67108864
}
```

Clients that support protocol v2 should send a negotiation request immediately:

```json
{ "id": "protocol-1", "type": "negotiate_protocol", "protocolVersion": 2 }
```

After the success response, oversized stdout objects are emitted losslessly as an uninterrupted sequence of `rpc_chunk` frames carrying base64 segments of the original UTF-8 JSON. Clients must validate `chunkId`, `index`, `count`, and `byteLength`, reject interleaved or interrupted sequences, enforce the reassembly limit, concatenate decoded bytes in index order, decode them as strict UTF-8, and parse the result as one JSON object. The exported TypeScript `RpcFrameDecoder` implements this validation; the bundled TypeScript and Python `RpcClient` implementations negotiate v2 automatically when the ready frame advertises it. Legacy clients may ignore the added ready fields and remain on v1.

## Transport and framing

Protocol v1 stdout frames are a single JSON object followed by `\n`. The server caps each physical stdout frame at 1 MiB (`MAX_RPC_FRAME_BYTES`); logical frames reassembled by protocol v2 are capped at 64 MiB (`MAX_RPC_REASSEMBLED_BYTES`). Inbound commands are always one unchunked JSONL object.

### Outbound frame categories (stdout)

1. Ready frame (`{ type: "ready" }`)
2. `RpcResponse` (`{ type: "response", ... }`)
3. `AgentSessionEvent` objects (`agent_start`, `message_update`, etc.)
4. `RpcExtensionUIRequest` (`{ type: "extension_ui_request", ... }`)
5. Host tool requests/cancellations (`host_tool_call`, `host_tool_cancel`)
6. Host URI requests/cancellations (`host_uri_request`, `host_uri_cancel`)
7. Extension errors (`{ type: "extension_error", extensionPath, event, error }`)
8. Available-commands updates (`{ type: "available_commands_update", commands }`), emitted at startup and whenever command metadata changes
9. Prompt lifecycle hints (`{ type: "prompt_result", id?, agentInvoked }`) for scheduled prompts that later resolve without invoking the agent
10. Subagent frames (`subagent_lifecycle`, `subagent_progress`, `subagent_event`), gated by `set_subagent_subscription`
11. Builtin slash-command side channels (`command_output`, `session_info_update`, `config_update`)
12. Overflow/error frames (`rpc_frame_error` carrying the original frame type, or a shrunk error response / empty `agent_end`) when a frame still exceeds the 1 MiB v1 cap after shrinking, or exceeds the 64 MiB v2 ceiling

### Inbound frame categories (stdin)

1. `RpcCommand`
2. `RpcExtensionUIResponse` (`{ type: "extension_ui_response", ... }`)
3. Host tool updates/results (`host_tool_update`, `host_tool_result`)
4. Host URI results (`host_uri_result`)

## Request/response correlation

All commands accept optional `id?: string`. If provided, normal command responses echo the same `id`.

- Unknown command responses are emitted with `id: undefined` (even if the request had an `id`).
- Malformed JSON and synchronous dispatch failures emit `command: "parse"` with `id: undefined`. Exceptions while handling a recognized command emit a failure with that command's `type` and `id`.
- `prompt` and `abort_and_prompt` return immediate success, then may emit a later error response with the **same** id if async prompt scheduling fails.
- `prompt` success responses may include `data.agentInvoked`: `false` means the prompt completed locally without an agent turn; `true` means it produced agent lifecycle events; omitted means rely on session events.

## Command reference

All 42 commands, grouped:

| Group | Command | Shape |
| --- | --- | --- |
| Prompting | `prompt` | `{ message: string, images?: ImageContent[], streamingBehavior?: "steer" \| "followUp" }` |
| | `steer` | `{ message: string, images?: ImageContent[] }` |
| | `follow_up` | `{ message: string, images?: ImageContent[] }` |
| | `abort` | — |
| | `abort_and_prompt` | `{ message: string, images?: ImageContent[] }` |
| | `new_session` | `{ parentSession?: string }` |
| Protocol | `negotiate_protocol` | `{ protocolVersion: 2 }` |
| State | `get_state` | — |
| | `set_fast_mode` | `{ enabled: boolean }` |
| | `get_available_commands` | — |
| | `set_todos` | `{ phases: TodoPhase[] }` |
| | `set_host_tools` | `{ tools: RpcHostToolDefinition[] }` |
| | `set_host_uri_schemes` | `{ schemes: RpcHostUriSchemeDefinition[] }` |
| | `set_subagent_subscription` | `{ level: "off" \| "progress" \| "events" }` |
| | `get_subagents` | — |
| | `get_subagent_messages` | `{ subagentId?, sessionFile?, fromByte? }` |
| Model | `set_model` | `{ provider: string, modelId: string }` |
| | `cycle_model` | — |
| | `get_available_models` | — |
| Thinking | `set_thinking_level` | `{ level: ThinkingLevel }` |
| | `cycle_thinking_level` | — |
| Queue modes | `set_steering_mode` | `{ mode: "all" \| "one-at-a-time" }` |
| | `set_follow_up_mode` | `{ mode: "all" \| "one-at-a-time" }` |
| | `set_interrupt_mode` | `{ mode: "immediate" \| "wait" }` |
| Compaction | `compact` | `{ customInstructions?: string }` |
| | `set_auto_compaction` | `{ enabled: boolean }` |
| Retry | `set_auto_retry` | `{ enabled: boolean }` |
| | `abort_retry` | — |
| Bash | `bash` | `{ command: string }` |
| | `abort_bash` | — |
| Session | `get_session_stats` | — |
| | `export_html` | `{ outputPath?: string }` |
| | `switch_session` | `{ sessionPath: string }` |
| | `branch` | `{ entryId: string }` |
| | `get_branch_messages` | — |
| | `get_last_assistant_text` | — |
| | `set_session_name` | `{ name: string }` |
| | `handoff` | `{ customInstructions?: string }` |
| Messages | `get_messages` | — |
| | `get_messages_page` | `{ cursor?: string, limit?: number }` |
| Login | `get_login_providers` | — |
| | `login` | `{ providerId: string }` |

`bash` is dispatched concurrently: the RPC server keeps reading commands while the shell runs, so `abort_bash` (or any other command) sent during a long-running `bash` is handled without waiting for it to finish on its own. Ordering across concurrent commands is not guaranteed — match responses on `id`, not on emission order.

`get_messages_page` returns a stable chronological page with `messages`, `totalMessages`, and an opaque `nextCursor` when more messages remain. Cursors are bound to the session ID, durable leaf, and message count. The server rejects stale cursors if the session changes between requests, and refuses to start a paging walk while the session is streaming or compacting. Failed page requests carry a machine-readable `code` on the error response — `session_busy` (session is streaming or compacting) or `stale_cursor` (the snapshot behind the cursor changed, e.g. a background bash appended a message between pages). Pages contain at most 256 messages.

## Response schema

Every command returns an `RpcResponse`:

```json
// success
{ "id": "req_1", "type": "response", "command": "prompt", "success": true, "data": { … } }

// failure
{ "id": "req_1", "type": "response", "command": "compact", "success": false, "error": "…", "code": "…" }
```

`prompt` is acknowledged after the command is accepted, not after a model turn finishes:

```json
{
  "id": "req_1",
  "type": "response",
  "command": "prompt",
  "success": true,
  "data": { "agentInvoked": false }
}
```

`data.agentInvoked: false` is a completion signal for local-only prompts, including slash commands that produce output without starting an agent turn. `prompt_result` is emitted when a prompt was accepted immediately but later resolves as local-only:

```json
{ "type": "prompt_result", "id": "req_1", "agentInvoked": false }
```

Local-only slash commands may emit `command_output` frames before completing via `data.agentInvoked: false` or a later `prompt_result`. They do not emit `agent_end`.

### `get_state` payload

```json
{
  "model": { "provider": "...", "id": "..." },
  "thinkingLevel": "off|minimal|low|medium|high|xhigh|max",
  "isStreaming": false,
  "isCompacting": false,
  "steeringMode": "all|one-at-a-time",
  "followUpMode": "all|one-at-a-time",
  "interruptMode": "immediate|wait",
  "sessionFile": "...",
  "sessionId": "...",
  "sessionName": "...",
  "fastModeEnabled": false,
  "tokensPerSecond": null,
  "fastModeActive": false,
  "autoCompactionEnabled": true,
  "messageCount": 0,
  "queuedMessageCount": 0,
  "todoPhases": [ { "id": "phase-1", "name": "Todos", "tasks": [ { "id": "task-1", "content": "…", "status": "in_progress" } ] } ],
  "systemPrompt": ["..."],
  "dumpTools": [ { "name": "read", "description": "…", "parameters": {} } ],
  "contextUsage": { "tokens": 1100, "contextWindow": 200000, "percent": 0.55 }
}
```

`tokensPerSecond` is a number when output throughput is available and `null` otherwise. `fastModeEnabled` reports the session setting while `fastModeActive` reports the actual computed active state (a provider rejection may keep `fastModeEnabled` true while `fastModeActive` is false).

## Events

RPC mode forwards every `AgentSessionEvent` from `AgentSession.subscribe(...)`. Common types: `agent_start` / `agent_end`, `turn_start` / `turn_end`, `message_start` / `message_update` / `message_end`, `tool_execution_start` / `tool_execution_update` / `tool_execution_end`, `auto_compaction_start` / `auto_compaction_end`, `auto_retry_start` / `auto_retry_end`, `retry_fallback_applied` / `retry_fallback_succeeded`, `ttsr_triggered`, `todo_reminder`, `todo_auto_clear`, `model_changed`, `thinking_level_changed`, `goal_updated`, `notice`, `irc_message`. Extension runner errors arrive separately as `{ "type": "extension_error", "extensionPath", "event", "error" }`.

Subagent frames (`subagent_lifecycle`, `subagent_progress`, `subagent_event`) are gated by `set_subagent_subscription` (`"off" | "progress" | "events"`).

## Hosting tools and URI schemes

A driver can register host-owned tools with `set_host_tools`. The server may call them back via `host_tool_call`/`host_tool_cancel`, and the driver responds on stdin with `host_tool_update` / `host_tool_result`. The same pattern applies to URL schemes with `set_host_uri_schemes`, `host_uri_request`, `host_uri_cancel`, and `host_uri_result`. Re-sending either replaces the previous set.

Extension UI requests (`extension_ui_request` with methods `select`, `confirm`, `input`, `editor`, `cancel`, `notify`, `setStatus`, `setWidget`, `setTitle` — opt-in via `PI_RPC_EMIT_TITLE=1` — `set_editor_text`, and `open_url`) are answered with `extension_ui_response` values; the RPC client surfaces them through callbacks or a headless UI queue.

## Client libraries

### TypeScript

`@oh-my-pi/pi-coding-agent/modes/rpc` exports `RpcClient` — spawns `omp --mode rpc`, handles request correlation, typed notifications, v2 negotiation and chunk reassembly, message pagination, extension UI, and host-owned tools (host URI schemes are wrapped by the Python client only):

```ts
import { RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc";

const client = new RpcClient();
await client.start();
await client.prompt("Summarize this repo.");
const state = await client.getState();
await client.stop();
```

Key methods: `start()` / `stop()`, `prompt` / `steer` / `followUp` / `abort` / `abortAndPrompt` / `newSession`, `getState`, `setFastMode`, `getAvailableCommands`, `setModel` / `cycleModel` / `getAvailableModels`, `setThinkingLevel` / `cycleThinkingLevel`, `setSteeringMode` / `setFollowUpMode` (the `set_interrupt_mode` command has no TypeScript wrapper), `compact` / `setAutoCompaction` / `setAutoRetry` / `abortRetry`, `bash` / `abortBash`, session ops (`getSessionStats`, `exportHtml`, `switchSession`, `branch`, `getBranchMessages`, `getLastAssistantText`, `handoff` — `setSessionName` has no TypeScript wrapper), messages (`getMessages` — drains stable pages automatically on v2; `getMessagesPage` — strict), login (`getLoginProviders`, `login`), `setCustomTools` (host-owned tools), subagents (`setSubagentSubscription` / `getSubagents` / `getSubagentMessages`), `waitForIdle` / `collectEvents` / `promptAndWait`, `getStderr`, and `onEvent` / `onSessionEvent` / `onSubagent*` / `onAvailableCommandsUpdate` listeners. `RpcCommandError` carries the server's machine-readable `code`. `RpcFrameDecoder` / `RpcFrameEncoder` implement raw v2 framing for custom clients.

### Python

The `omp-rpc` package provides the same client in Python:

```python
from omp_rpc import RpcClient

client = RpcClient()
client.start()
client.prompt("Summarize this repo.")
state = client.get_state()
client.stop()
```

Thread-based; spawns `omp` in RPC mode. Surface parallels the TypeScript client: `on_event`/typed `on_*` listeners, `install_headless_ui`/`next_ui_request`/`send_ui_value`/`send_ui_confirmation`/`cancel_ui_request` for extension UI, `get_messages`/`get_messages_page`, `get_todos`/`set_todos`/`clear_todos`, `set_custom_tools` (`HostTool` decorator), `set_host_uris` (`HostUri`), `prompt_and_wait`, `request_raw`, and typed exceptions (`RpcError`, `RpcTimeoutError`, `RpcProcessExitError`, `RpcConcurrencyError`, `RpcCommandError`, `RpcProtocolError`). The mirror is not exact: Python additionally wraps `set_interrupt_mode`, `set_session_name`, and host URI schemes, while TypeScript additionally wraps `login`, `handoff`, `get_available_commands`, and the subagent commands. The Python package owns that client API and process lifecycle; the wire contract in `rpc-types.ts` remains canonical. Use raw protocol frames when a client library does not wrap the surface you need.

## Sharp edges

:::caution
**RPC mode runs an in-process agent.** The process holds MCP and LSP child processes open for the lifetime of the session — close stdin (or stop the client) to dispose the session and let the process exit cleanly.
:::

- **`prompt` and `abort_and_prompt` ack immediately**, not on turn completion. Track completion via `agent_end`, custom-message completion, `data.agentInvoked`, or `prompt_result`.
- **Concurrent RPC commands are unordered.** Correlate responses by `id`, not by emission order.
- **Hosts that don't speak v2 still work** — v1 retains its bounded fallback. Frames above the v2 reassembly ceiling still fail explicitly; paginate history rather than relying on arbitrarily large logical frames.
- **In-memory sessions are not addressable by file.** Resume/fork paths that depend on session files do not apply to in-memory `SessionManager` instances.
- **`get_messages_page` is strict** — on `session_busy` or `stale_cursor` it fails with a machine-readable `code`; the bundled clients discard partial pages and fall back to the legacy best-effort snapshot.
