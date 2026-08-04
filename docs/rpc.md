# RPC Protocol Reference

RPC mode runs the coding agent as a newline-delimited JSON protocol over stdio.

- **stdin**: commands (`RpcCommand`), extension UI responses, and host-tool updates/results
- **stdout**: a ready frame, command responses (`RpcResponse`), session/agent events, extension UI requests, host-tool requests/cancellations

Primary implementation:

- `packages/coding-agent/src/modes/rpc/rpc-mode.ts`
- `packages/coding-agent/src/modes/rpc/rpc-types.ts`
- `packages/coding-agent/src/session/agent-session.ts`
- `packages/agent/src/agent.ts`
- `packages/agent/src/agent-loop.ts`

## Startup

```bash
omp --mode rpc [regular CLI options]
```

Behavior notes:

- `@file` CLI arguments are rejected in RPC mode.
- RPC mode disables automatic session title generation by default to avoid an extra model call.
- RPC/ACP host defaults cover task isolation/execution, memory, advisor, tier, async-job, and bash auto-background settings. They are applied only when a path is not explicitly configured; project/global config, `--config`, and isolated settings remain authoritative. Todo settings are not host-defaulted.
- The process claims stdin before extension discovery, then parses it one non-empty JSONL line at a time. Malformed JSON emits a recoverable `command: "parse"` failure and does not terminate the loop.
- At startup it writes a `ready` frame before processing commands. The frame advertises supported protocol versions and transport limits.
- When stdin closes, pending extension UI, host-tool, and host-URI requests are rejected; accepted commands are drained, the session is disposed, and the process exits with code `0`.
- Responses/events are written as one JSON object per line.

## Transport and Framing

Protocol v1 stdout frames are a single JSON object followed by `\n`. The server caps each physical stdout frame at 1 MiB. Inbound commands are always one unchunked JSONL object; clients SHOULD keep them within the advertised physical-frame limit.

The initial ready frame uses protocol v1 and advertises the opt-in lossless transport:

```json
{
  "type": "ready",
  "protocolVersion": 1,
  "supportedProtocolVersions": [1, 2],
  "maxFrameBytes": 1048576,
  "maxReassembledFrameBytes": 67108864
}
```

Clients that support protocol v2 SHOULD immediately send:

```json
{ "id": "protocol-1", "type": "negotiate_protocol", "protocolVersion": 2 }
```

After the success response, oversized stdout objects are emitted losslessly as an uninterrupted sequence of `rpc_chunk` frames. Each chunk carries a base64 segment of the original UTF-8 JSON object:

```json
{
  "type": "rpc_chunk",
  "chunkId": "rpc-1",
  "index": 0,
  "count": 7,
  "byteLength": 1600042,
  "data": "eyJ0eXBlIjoicmVzcG9uc2UiLC4uLn0="
}
```

Clients MUST validate `chunkId`, `index`, `count`, and `byteLength`, reject interleaved or interrupted sequences, enforce the advertised reassembly limit, concatenate decoded bytes in index order, decode them as strict UTF-8, and parse the result as one JSON object. The TypeScript `RpcFrameDecoder`, exported from `@oh-my-pi/pi-coding-agent/modes/rpc/rpc-frame`, implements this validation. The bundled TypeScript and Python `RpcClient` implementations negotiate v2 automatically when the ready frame advertises it.

Legacy clients may ignore the added ready fields and remain on v1. V1 retains its bounded fallback behavior for oversized output. Frames above the v2 reassembly ceiling still fail explicitly; large history APIs should use pagination rather than depending on arbitrarily large logical frames.

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

### Inbound frame categories (stdin)

1. `RpcCommand`
2. `RpcExtensionUIResponse` (`{ type: "extension_ui_response", ... }`)
3. Host tool updates/results (`host_tool_update`, `host_tool_result`)
4. Host URI results (`host_uri_result`)

## Request/Response Correlation

All commands accept optional `id?: string`.

- If provided, normal command responses echo the same `id`.
- `RpcClient` relies on this for pending-request resolution.

Important edge behavior from runtime:

- Unknown command responses are emitted with `id: undefined` (even if the request had an `id`).
- Malformed JSON and synchronous dispatch failures emit `command: "parse"` with `id: undefined`. Exceptions while handling a recognized command emit a failure with that command's `type` and `id`.
- `prompt` and `abort_and_prompt` return immediate success, then may emit a later error response with the **same** id if async prompt scheduling fails.
- `prompt` success responses may include `data.agentInvoked`. `false` means the prompt completed locally without an agent turn; `true` means the prompt produced agent lifecycle events; omitted means the host must rely on session events for completion.
- `abort_and_prompt` does not currently emit `data.agentInvoked` or `prompt_result`; hosts should treat it as the legacy abort-then-schedule path and rely on session events or same-id scheduling errors.

## Command Schema (canonical)

`RpcCommand` is defined in `packages/coding-agent/src/modes/rpc/rpc-types.ts`:

### Prompting

- `{ id?, type: "prompt", message: string, images?: ImageContent[], streamingBehavior?: "steer" | "followUp" }`
- `{ id?, type: "steer", message: string, images?: ImageContent[] }`
- `{ id?, type: "follow_up", message: string, images?: ImageContent[] }`
- `{ id?, type: "abort" }`
- `{ id?, type: "abort_and_prompt", message: string, images?: ImageContent[] }`
- `{ id?, type: "new_session", parentSession?: string }`

### Protocol

- `{ id?, type: "negotiate_protocol", protocolVersion: 2 }`

### State

- `{ id?, type: "get_state" }`
- `{ id?, type: "set_fast_mode", enabled: boolean }`
- `{ id?, type: "get_available_commands" }`
- `{ id?, type: "set_todos", phases: TodoPhase[] }`
- `{ id?, type: "set_host_tools", tools: RpcHostToolDefinition[] }`
- `{ id?, type: "set_host_uri_schemes", schemes: RpcHostUriSchemeDefinition[] }`
- `{ id?, type: "set_subagent_subscription", level: "off" | "progress" | "events" }`
- `{ id?, type: "get_subagents" }`
- `{ id?, type: "get_subagent_messages", subagentId?: string, sessionFile?: string, fromByte?: number }`

### Model

- `{ id?, type: "set_model", provider: string, modelId: string }`
- `{ id?, type: "cycle_model" }`
- `{ id?, type: "get_available_models" }`

### Thinking

- `{ id?, type: "set_thinking_level", level: ThinkingLevel }`
- `{ id?, type: "cycle_thinking_level" }`

### Queue modes

- `{ id?, type: "set_steering_mode", mode: "all" | "one-at-a-time" }`
- `{ id?, type: "set_follow_up_mode", mode: "all" | "one-at-a-time" }`
- `{ id?, type: "set_interrupt_mode", mode: "immediate" | "wait" }`

### Compaction

- `{ id?, type: "compact", customInstructions?: string }`
- `{ id?, type: "set_auto_compaction", enabled: boolean }`

### Retry

- `{ id?, type: "set_auto_retry", enabled: boolean }`
- `{ id?, type: "abort_retry" }`

### Bash

- `{ id?, type: "bash", command: string }`
- `{ id?, type: "abort_bash" }`

`bash` is dispatched concurrently: the RPC server continues reading commands
while the shell command runs, so `abort_bash` (or any other command) sent
during a long-running `bash` is handled without waiting for it to finish on
its own. The `bash` response is emitted when the command completes; hosts
correlate it via `id`. Ordering across concurrent commands is not guaranteed
— clients MUST match responses on `id`, not on emission order.

### Session

- `{ id?, type: "get_session_stats" }`
- `{ id?, type: "export_html", outputPath?: string }`
- `{ id?, type: "switch_session", sessionPath: string }`
- `{ id?, type: "branch", entryId: string }`
- `{ id?, type: "get_branch_messages" }`
- `{ id?, type: "get_last_assistant_text" }`
- `{ id?, type: "set_session_name", name: string }`
- `{ id?, type: "handoff", customInstructions?: string }`

### Messages

- `{ id?, type: "get_messages" }`
- `{ id?, type: "get_messages_page", cursor?: string, limit?: number }`

`get_messages_page` returns a stable chronological page with `messages`, `totalMessages`, and an opaque `nextCursor` when more messages remain. Cursors are bound to the session ID, durable leaf, and message count. The server rejects stale cursors if the session changes between requests, and refuses to start a paging walk while the session is streaming or compacting. Failed page requests carry a machine-readable `code` on the error response — `session_busy` (session is streaming or compacting) or `stale_cursor` (the snapshot behind the cursor changed, e.g. a background bash appended a message between pages) — so clients can react without matching error-message text. Pages contain at most 256 messages and normally stay below the v1 physical-frame ceiling. A v1 caller can page ordinary histories, but an individual message whose response exceeds that ceiling produces an overflow error; retrieving it losslessly requires negotiated v2 framing.

The bundled TypeScript `RpcClient.getMessages()` and Python `RpcClient.get_messages()` drain this paged endpoint automatically after negotiating v2. They retain the legacy monolithic command when connected to a v1 server, and on either `session_busy` or `stale_cursor` they discard partial pages and fall back to the legacy best-effort snapshot. Direct `getMessagesPage()` and `get_messages_page()` calls remain strict so incremental hosts never mix snapshots silently.

### Login

- `{ id?, type: "get_login_providers" }`
- `{ id?, type: "login", providerId: string }`

## Response Schema

All command results use `RpcResponse`:

- Success: `{ id?, type: "response", command: <command>, success: true, data?: ... }`
- Failure: `{ id?, type: "response", command: string, success: false, error: string, code?: string }`

Data payloads are command-specific and defined in `rpc-types.ts`.

### `prompt` payload

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

`data.agentInvoked: false` is a completion signal for local-only prompts, including slash commands that produce output without starting an agent turn. `data.agentInvoked: true` means the prompt produced agent lifecycle events; those events can be emitted before or after the prompt response depending on the command path. Older runtimes may omit `data`; hosts should then rely on `agent_end`, custom message completion, or `prompt_result`.

`prompt_result` is emitted when a prompt was accepted immediately but later resolves as local-only:

```json
{ "type": "prompt_result", "id": "req_1", "agentInvoked": false }
```

Local-only slash commands may emit `command_output` frames before completing via `data.agentInvoked: false` or a later `prompt_result`. They do not emit `agent_end`.

### `get_state` payload

`tokensPerSecond` is a number when output throughput is available and `null`
otherwise. `fastModeEnabled` reports the session setting, while
`fastModeActive` reports the actual computed active state. For Fireworks,
`providers.fireworksTier: priority` is a provider-level setting independent of
the `/fast` family setting, so `fastModeActive` may remain `true` for an
unsupported Fireworks model.

For direct Anthropic, a provider rejection of `speed: "fast"` uses a sticky
fallback scoped by the resolved endpoint and exact model: `fastModeEnabled` may
remain `true` while `fastModeActive` is `false`. An explicit `set_fast_mode`
enable expresses retry intent and clears that fallback so the provider attempt
is re-armed.

`fastModeActive` is also `false` while priority is requested but known not to
land: the newest usage report says the account cannot use priority (Anthropic
reports this when usage credits are off), or the provider refused the last
turn — Anthropic dropping `speed: "fast"`, OpenAI echoing a lower
`service_tier`. The TUI paints that case as a red fast-mode icon and `/fast
status` reports `blocked`. What the provider did last outranks the account
snapshot, so a served priority turn restores `true` without an explicit
re-arm. `tier.autoFastMode` skips the request entirely when the account is
known to be ineligible; an explicit `set_fast_mode` enable always attempts it.

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
  "todoPhases": [
    {
      "id": "phase-1",
      "name": "Todos",
      "tasks": [
        {
          "id": "task-1",
          "content": "Map the tool surface",
          "status": "in_progress"
        }
      ]
    }
  ],
  "systemPrompt": ["..."],
  "dumpTools": [
    {
      "name": "read",
      "description": "Read files and URLs",
      "parameters": {}
    }
  ],
  "contextUsage": {
    "tokens": 1100,
    "contextWindow": 200000,
    "percent": 0.55
  }
}
```

### `set_fast_mode` payload

`set_fast_mode` changes whether fast mode is enabled for the session. The
request is:

```json
{ "id": "req_fast_on", "type": "set_fast_mode", "enabled": true }
```

On success, `data` always contains both `enabled` and `active`. These are the
actual computed values: `enabled` reports the session setting, and `active`
reports the resulting active state, including any provider-level Fireworks
priority setting:

For direct Anthropic, an explicit enable also re-arms a provider attempt after
the sticky rejection fallback, even when fast mode was already enabled.

```json
{
  "id": "req_fast_on",
  "type": "response",
  "command": "set_fast_mode",
  "success": true,
  "data": { "enabled": true, "active": true }
}
```

Enabling fast mode on a model without a service-tier family fails with the
exact error below:

```json
{
  "id": "req_fast_on",
  "type": "response",
  "command": "set_fast_mode",
  "success": false,
  "error": "Fast mode is unavailable for the current model."
}
```

Disabling fast mode is idempotent, including on an unsupported model. It
succeeds as an off/no-op result, but disabling `/fast` does not override
provider-level settings, so a successful disable does not guarantee
`active: false`. For example, with an unsupported
`fireworks/deepseek-v4-flash` model and `providers.fireworksTier: priority`,
the response reports the session setting as disabled while the provider
priority keeps the computed active state true:

```json
{
  "id": "req_fast_off",
  "type": "response",
  "command": "set_fast_mode",
  "success": true,
  "data": { "enabled": false, "active": true }
}
```

The corresponding `get_state` result reports the same computed state:

```json
{
  "fastModeEnabled": false,
  "fastModeActive": true
}
```

### `set_todos` payload

Replaces the in-memory todo state for the current session and returns the normalized phase list:

```json
{
  "id": "req_2",
  "type": "set_todos",
  "phases": [
    {
      "id": "phase-1",
      "name": "Evaluation",
      "tasks": [
        {
          "id": "task-1",
          "content": "Map the read tool surface",
          "status": "in_progress"
        },
        {
          "id": "task-2",
          "content": "Exercise edit operations",
          "status": "pending"
        }
      ]
    }
  ]
}
```

This is useful for hosts that want to pre-seed a plan before the first prompt.

### `set_host_tools` payload

Replaces the current set of host-owned tools that the RPC server may call back
into over stdio:

```json
{
  "id": "req_3",
  "type": "set_host_tools",
  "tools": [
    {
      "name": "echo_host",
      "label": "Echo Host",
      "description": "Echo a value from the embedding host",
      "parameters": {
        "type": "object",
        "properties": {
          "message": { "type": "string" }
        },
        "required": ["message"],
        "additionalProperties": false
      }
    }
  ]
}
```

The response payload is:

```json
{
  "toolNames": ["echo_host"]
}
```

These tools are added to the active session tool registry before the next model
call. Re-sending `set_host_tools` replaces the previous host-owned set.

Definitions also accept `hidden?: boolean` and
`loadMode?: "essential" | "discoverable"`. An explicit mode wins. When omitted,
known essential built-in names remain `"essential"`; other host tools default
to `"discoverable"`. `toolNames` in the response lists the registered names.

### `set_host_uri_schemes` payload

Replaces the current set of host-owned URL schemes the RPC server should
dispatch reads/writes through:

```json
{
  "id": "req_4",
  "type": "set_host_uri_schemes",
  "schemes": [
    {
      "scheme": "db",
      "description": "Virtual db row files",
      "writable": true,
      "immutable": false
    }
  ]
}
```

The response payload is:

```json
{
  "schemes": ["db"]
}
```

Schemes are case-insensitive on the wire and normalized to lowercase before
the response is sent. Re-sending `set_host_uri_schemes` replaces the entire
previous set — schemes missing from the new list are unregistered.

`security://` is reserved for OMP's producer-neutral software-security resource
store. RPC hosts cannot register or shadow that scheme.

## Event Stream Schema

RPC mode forwards `AgentSessionEvent` objects from `AgentSession.subscribe(...)`.

Common event types:

- `agent_start`, `agent_end`
- `turn_start`, `turn_end`
- `message_start`, `message_update`, `message_end`
- `tool_execution_start`, `tool_execution_update`, `tool_execution_end`
- `auto_compaction_start`, `auto_compaction_end`
- `auto_retry_start`, `auto_retry_end`
- `retry_fallback_applied`, `retry_fallback_succeeded`
- `model_changed`, `thinking_level_changed`
- `ttsr_triggered`
- `todo_reminder`, `todo_auto_clear`
- `irc_message`, `notice`, `goal_updated`

Extension runner errors are emitted separately as:

```json
{
  "type": "extension_error",
  "extensionPath": "...",
  "event": "...",
  "error": "..."
}
```

`message_update` includes streaming deltas in `assistantMessageEvent` (text/thinking/toolcall deltas).

`agent_end` has this session-level shape (in addition to optional telemetry fields):

```ts
{
  type: "agent_end";
  messages: AgentMessage[];
  isTerminal?: boolean;
}
```

`isTerminal: false` means maintenance or async delivery has scheduled more work,
so the session will resume before its true final settle. Treat an `agent_end` as
run completion only when `isTerminal !== false`; the field is optional so frames
from older runtimes, where it is absent, remain terminal-compatible.

### Available commands

`get_available_commands` returns `{ commands }`, and the same array is pushed
in `available_commands_update` frames at startup and after command metadata
changes. Each command has `name`, `source`, and optional `aliases`,
`description`, `input.hint`, and `subcommands`.

### Subagent subscriptions

Subagent forwarding defaults to `"off"`. `set_subagent_subscription` selects:

- `"off"`: no forwarded subagent frames
- `"progress"`: lifecycle and progress frames
- `"events"`: lifecycle, progress, and full subagent event frames

`get_subagents` returns the registry snapshot sorted by subagent index and id.
`get_subagent_messages` selects a transcript by `subagentId` or `sessionFile`;
`fromByte` supports incremental reads. Its result contains `sessionFile`,
`fromByte`, `nextByte`, `reset`, raw transcript `entries`, and converted
`messages`. If `fromByte` exceeds the current file size, reading restarts at
byte zero and reports `reset: true`.

## Prompt/Queue Concurrency and Ordering

This is the most important operational behavior.

### Immediate ack vs completion

`prompt` and `abort_and_prompt` are **acknowledged immediately**:

```json
{ "id": "req_1", "type": "response", "command": "prompt", "success": true }
```

That means:

- command acceptance != run completion
- agent turns complete only on `agent_end` frames where `isTerminal !== false`
- local-only prompts complete via `data.agentInvoked: false` on the response or via a later `prompt_result`

### While streaming

`AgentSession.prompt()` requires `streamingBehavior` during active streaming:

- `"steer"` => queued steering message (interrupt path)
- `"followUp"` => queued follow-up message (post-turn path)

If omitted during streaming, prompt fails.

### Queue defaults

From `packages/agent/src/agent.ts` defaults:

- `steeringMode`: `"one-at-a-time"`
- `followUpMode`: `"one-at-a-time"`
- `interruptMode`: `"immediate"`

### Mode semantics

- `set_steering_mode` / `set_follow_up_mode`
  - `"one-at-a-time"`: dequeue one queued message per turn
  - `"all"`: dequeue entire queue at once
- `set_interrupt_mode`
  - `"immediate"`: tool execution checks steering between tool calls; pending steering can abort remaining tool calls in the turn
  - `"wait"`: defer steering until turn completion

## Extension UI Sub-Protocol

Extensions in RPC mode use request/response UI frames.

### Outbound request

`RpcExtensionUIRequest` (`type: "extension_ui_request"`) methods:

- `select`, `confirm`, `input`, `editor`, `cancel`
  - `select` keeps labels in `options: string[]` and, when any option has a
    description, emits a positionally aligned
    `optionDetails: Array<{ description?: string }>` array. Hosts that do not
    render descriptions can continue using `options` alone.
- `notify`, `setStatus`, `setWidget`, `setTitle`, `set_editor_text`
- `open_url` (emitted by RPC login flows)

Runtime note:

- Automatic session title generation is disabled in RPC mode, and `setTitle` UI
  requests are also suppressed by default because most hosts do not have a
  meaningful terminal-title surface. Set `PI_RPC_EMIT_TITLE=1` to opt back in to
  the UI event only.

Example:

```json
{
  "type": "extension_ui_request",
  "id": "123",
  "method": "confirm",
  "title": "Confirm",
  "message": "Continue?",
  "timeout": 30000
}
```

### Inbound response

`RpcExtensionUIResponse` (`type: "extension_ui_response"`):

- `{ type: "extension_ui_response", id: string, value: string }`
- `{ type: "extension_ui_response", id: string, confirmed: boolean }`
- `{ type: "extension_ui_response", id: string, cancelled: true, timedOut?: boolean }`

If a dialog has a timeout, RPC mode resolves to a default value when timeout/abort fires.

## Host Tool Sub-Protocol

RPC hosts can expose custom tools to the agent by sending `set_host_tools`, then
serving execution requests over the same transport.

### Outbound request

When the agent wants the host to execute one of those tools, RPC mode emits:

```json
{
  "type": "host_tool_call",
  "id": "host_1",
  "toolCallId": "toolu_123",
  "toolName": "echo_host",
  "arguments": { "message": "hello" }
}
```

If the tool execution is later aborted, RPC mode emits:

```json
{
  "type": "host_tool_cancel",
  "id": "host_cancel_1",
  "targetId": "host_1"
}
```

### Inbound updates and completion

Hosts can optionally stream progress:

```json
{
  "type": "host_tool_update",
  "id": "host_1",
  "partialResult": {
    "content": [{ "type": "text", "text": "working" }]
  }
}
```

Completion uses:

```json
{
  "type": "host_tool_result",
  "id": "host_1",
  "result": {
    "content": [{ "type": "text", "text": "done" }]
  }
}
```

Set top-level `isError: true` on `host_tool_result` to reject the pending host tool call and surface the returned text content as a tool error.

## Host URI Sub-Protocol

RPC hosts can also own custom URL schemes (virtual files). After
`set_host_uri_schemes`, every read of `<scheme>://…` and write of
`<scheme>://…` (when registered as `writable`) is bounced back to the host
over the same transport.

### Outbound request

When a session tool resolves a host-owned URL, RPC mode emits:

```json
{
  "type": "host_uri_request",
  "id": "uri_1",
  "operation": "read",
  "url": "db://users/42"
}
```

Writes look the same with `"operation": "write"` and an additional
`"content": "..."` field carrying the full replacement bytes.

If the request is later aborted (caller cancels, session ends), RPC mode
emits:

```json
{
  "type": "host_uri_cancel",
  "id": "uri_cancel_1",
  "targetId": "uri_1"
}
```

### Inbound result

For successful reads:

```json
{
  "type": "host_uri_result",
  "id": "uri_1",
  "content": "id=42\nname=Alice\n",
  "contentType": "text/plain",
  "notes": ["fresh from cache"],
  "immutable": false
}
```

For successful writes, omit content:

```json
{ "type": "host_uri_result", "id": "uri_1" }
```

To reject the request, set `isError: true` and either populate `error` with
a message or fall back to `content` for textual error surfacing:

```json
{
  "type": "host_uri_result",
  "id": "uri_1",
  "isError": true,
  "error": "row 42 not found"
}
```

### Constraints

- The agent's `edit` tool does not target host URIs. Hosts that want to
  mutate virtual files expose `write` and let the model use the `write` tool
  with replacement content.
- Schemes are global to the process; `set_host_uri_schemes` replaces the
  previous set, unregistering anything not in the new list.
- Schemes are normalized to lowercase before registration.
- Successful reads require `content`. `contentType` defaults to `text/plain`
  and, when supplied, is `"text/plain"`, `"text/markdown"`, or
  `"application/json"`. A result-level `immutable` overrides the registered
  scheme's value for that read.

## Error Model and Recoverability

### Command-level failures

Failures are `success: false` with string `error`.

```json
{
  "id": "req_2",
  "type": "response",
  "command": "set_model",
  "success": false,
  "error": "Model not found: provider/model"
}
```

### Recoverability expectations

- Most command failures are recoverable; process remains alive.
- Malformed JSONL / parse-loop exceptions emit a `parse` error response and continue reading subsequent lines.
- Empty `set_session_name` is rejected (`Session name cannot be empty`).
- Extension UI responses with unknown `id` are ignored.
- Process termination conditions are stdin close or explicit extension-triggered shutdown after the current command.

## Compact Command Flows

### 1) Prompt and stream

stdin:

```json
{ "id": "req_1", "type": "prompt", "message": "Summarize this repo" }
```

stdout sequence (typical):

```json
{ "id": "req_1", "type": "response", "command": "prompt", "success": true }
{ "type": "agent_start" }
{ "type": "message_update", "assistantMessageEvent": { "type": "text_delta", "delta": "..." }, "message": { "role": "assistant", "content": [] } }
{ "type": "agent_end", "messages": [], "isTerminal": true }
```

### 2) Prompt during streaming with explicit queue policy

stdin:

```json
{
  "id": "req_2",
  "type": "prompt",
  "message": "Also include risks",
  "streamingBehavior": "followUp"
}
```

### 3) Inspect and tune queue behavior

stdin:

```json
{ "id": "q1", "type": "get_state" }
{ "id": "q2", "type": "set_steering_mode", "mode": "all" }
{ "id": "q3", "type": "set_interrupt_mode", "mode": "wait" }
```

### 4) Extension UI round trip

stdout:

```json
{
  "type": "extension_ui_request",
  "id": "ui_7",
  "method": "input",
  "title": "Branch name",
  "placeholder": "feature/..."
}
```

stdin:

```json
{ "type": "extension_ui_response", "id": "ui_7", "value": "feature/rpc-host" }
```

## Client libraries

### TypeScript helper

`packages/coding-agent/src/modes/rpc/rpc-client.ts` is a convenience wrapper, not the protocol definition.

Current helper characteristics:

- Spawns `bun <cliPath> --mode rpc`
- Correlates responses by generated `req_<n>` ids
- Dispatches recognized core `AgentEvent` types to listeners
- Supports host-owned custom tools via `setCustomTools()` and automatic handling of `host_tool_call` / `host_tool_cancel`
- Wraps common protocol commands including OAuth `getLoginProviders()` / `login(...)`; use raw protocol frames for any surface not wrapped by the helper.

### Python package

The bundled [`omp-rpc`](../python/omp-rpc/pyproject.toml) distribution provides the process-backed Python client. Its import package is `omp_rpc`; the package API, typed commands and events, host-tool/host-URI helpers, and orchestration examples are maintained in the [`omp-rpc` README](../python/omp-rpc/README.md).

```python
from omp_rpc import RpcClient

with RpcClient(provider="anthropic", model="claude-sonnet-4-5") as client:
    state = client.get_state()
    turn = client.prompt_and_wait("Reply with just the word hello")
    print(turn.require_assistant_text())
```

By default, `RpcClient` starts `omp --mode rpc`; pass `command=[...]` to own the exact child command. It handles request correlation, typed notifications, v2 negotiation and chunk reassembly, message pagination, extension UI, and host-owned tools and URI schemes. The Python package owns that client API and process lifecycle; this document and `rpc-types.ts` remain the canonical wire contract. Use raw protocol frames when a client library does not wrap the surface you need.
