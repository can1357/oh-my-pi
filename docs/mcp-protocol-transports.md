# MCP Protocol and Transport Internals

This document describes how coding-agent implements MCP JSON-RPC messaging and how protocol concerns are split from transport concerns.

## Scope

Covers:

- JSON-RPC request/response and notification flow
- Server-to-client request handling (`ping`, `roots/list`)
- Request correlation and lifecycle for stdio and HTTP/SSE transports
- Timeout, cancellation, and auth-refresh behavior
- Error propagation and malformed payload handling
- Transport selection boundaries (`stdio` vs `http` vs `sse`)
- Which reconnect/retry responsibilities are transport-level vs manager/tool-bridge-level

Does not cover extension authoring UX or command UI.

## Implementation files

- [`src/mcp/types.ts`](../packages/coding-agent/src/mcp/types.ts)
- [`src/mcp/transports/stdio.ts`](../packages/coding-agent/src/mcp/transports/stdio.ts)
- [`src/mcp/transports/http.ts`](../packages/coding-agent/src/mcp/transports/http.ts)
- [`src/mcp/transports/sse.ts`](../packages/coding-agent/src/mcp/transports/sse.ts)
- [`src/mcp/transports/index.ts`](../packages/coding-agent/src/mcp/transports/index.ts)
- [`src/mcp/json-rpc.ts`](../packages/coding-agent/src/mcp/json-rpc.ts)
- [`src/mcp/client.ts`](../packages/coding-agent/src/mcp/client.ts)
- [`src/mcp/manager.ts`](../packages/coding-agent/src/mcp/manager.ts)

## Layer boundaries

### Protocol layer (JSON-RPC + MCP methods)

- Message shapes are defined in `types.ts` (`JsonRpcRequest`, `JsonRpcNotification`, `JsonRpcResponse`, `JsonRpcMessage`).
- MCP client logic (`client.ts`) decides method order and session handshake:
  1. `initialize` request
  2. `notifications/initialized` notification, sent before any further session traffic
  3. for Streamable HTTP transports, start the optional background SSE listener once the initialize response has established any session id
  4. method calls like `tools/list`, `tools/call`

### Transport layer (`MCPTransport`)

`MCPTransport` abstracts delivery and lifecycle:

- `request(method, params, options?) -> Promise<T>`
- `notify(method, params?) -> Promise<void>`
- `close()`
- `connected`
- optional callbacks: `onClose`, `onError`, `onNotification`, `onRequest`

Transport implementations own framing and I/O details:

- `StdioTransport`: newline-delimited JSON over subprocess stdio
- `HttpTransport`: Streamable HTTP JSON-RPC over POST, with optional SSE responses/listening
- `LegacySseTransport`: protocol revision 2024-11-05 HTTP+SSE, with a persistent GET stream and POST endpoint discovered from the `endpoint` event

### Manager/client wiring

`connectToServer()` always installs an `onRequest` handler for standard server-to-client requests. `MCPManager` installs notification handlers, OAuth refresh hooks for HTTP-like OAuth servers, and `onClose` reconnect handling for managed connections.

## Transport selection

`client.ts:createTransport()` chooses transport from config:

- `type` omitted or `"stdio"` -> `createStdioTransport`
- `"http"` -> `createHttpTransport`
- `"sse"` -> `createSseTransport`

`"sse"` uses the legacy HTTP+SSE transport: it opens the configured URL with GET, reads the `endpoint` event's plain-text URL/path, POSTs JSON-RPC requests to that endpoint, and receives JSON-RPC responses on the stream.

## JSON-RPC message flow and correlation

## Request IDs

Each transport owns a `RequestIdAllocator`. Outbound IDs default to monotonically increasing integers starting at `1`, which matches the wider MCP ecosystem and servers such as Apple's `xcrun mcpbridge`. A server config can set `requestIdFormat: "string"` to use collision-resistant `Snowflake.next()` strings instead. IDs remain transport-local correlation tokens.

## Stdio correlation path

- Outbound request is serialized as one JSON object + `\n`.
- `#pendingRequests: Map<id, {resolve,reject}>` stores in-flight requests.
- Read loop parses JSONL from stdout and calls `#handleMessage`.
- If inbound message has matching `id`, request resolves/rejects.
- If inbound message has `method` and no `id`, treated as notification and sent to `onNotification`.
- If inbound message has both `method` and `id`, treated as a server-to-client request and answered through `onRequest`; without a handler the transport replies with JSON-RPC `-32601 Method not found`.

Unknown response IDs are ignored (no rejection, no error callback).

## HTTP correlation path

- Outbound request is HTTP `POST` with JSON body and generated `id`.
- Non-SSE response path: parse one JSON-RPC response and return `result`/throw on `error`.
- SSE response path (`Content-Type: text/event-stream`): stream events, return first message whose `id` matches expected request ID and has `result` or `error`.
- SSE messages with `method` and no `id` are treated as notifications.
- SSE messages with both `method` and `id` are treated as server-to-client requests and answered with a POSTed JSON-RPC response.

If SSE stream ends before matching response, request fails with `No response received for request ID ...`. After the matching response is captured, the transport drains remaining SSE messages in the background.

## Notifications

Client emits JSON-RPC notifications via `transport.notify(...)`.

- Stdio: writes a notification frame to stdin (`jsonrpc`, `method`, `params`) plus newline via `writeFrame()`. A synchronous write failure closes the transport and throws; asynchronous `FileSink` rejections are neutralized because notifications have no response promise to reject.
- HTTP: sends POST body without `id`; success accepts any `2xx` response, including `202 Accepted`.

Server-initiated notifications are surfaced through transport `onNotification`; `MCPManager` consumes known MCP list/update notifications and can forward all notifications through its own callback.

## Stdio transport internals

## Lifecycle and state transitions

- Initial: `connected=false`, `process=null`, pending map empty
- `connect()`:
  - spawn subprocess with configured command/args/env/cwd
  - mark connected
  - start stdout read loop (`readJsonl`)
  - start stderr loop (read/discard; currently silent)
- `close()`:
  - `#handleClose()`: mark disconnected, reject all pending requests (`Transport closed`), emit `onClose`
  - kill subprocess
  - detach read loop without awaiting (it can hang indefinitely)

If read loop exits unexpectedly, `finally` triggers `#handleClose()` which performs the same pending-request rejection and close callback.

## Timeout and cancellation

Per request:

- timeout from `resolveMCPTimeoutMs`: `OMP_MCP_TIMEOUT_MS` env override, else `config.timeout ?? 30000`; `0` disables
- optional `AbortSignal` from caller
- abort and timeout both reject the pending promise and clean its map entry; a late write rejection is ignored after settlement

Cancellation is local only: transport does not send protocol-level cancellation notification to the server.

## Malformed payload handling

In read loop:

- each parsed JSONL line is passed to `#handleMessage` in `try/catch`
- malformed/invalid message handling exceptions are dropped (`Skip malformed lines` comment)
- loop continues, so one bad message does not kill the connection

If the underlying stream parser throws, `onError` is invoked (when still connected), then connection closes.

## Disconnect/failure behavior

When process exits or stream closes:

- all in-flight requests are rejected with `Transport closed`
- no automatic restart or reconnect
- higher layers must reconnect by creating a new transport

## Backpressure/streaming notes

- `request()` deliberately does **not** await `stdin.write()` or `flush()`: awaiting a full pipe can strand the async function before it returns the response promise, preventing its timeout/abort rejection from reaching the caller. Synchronous throws and asynchronous write/flush rejections instead reject that pending response promise. `notify()` writes through `writeFrame()`, which detects synchronous failure but neutralizes asynchronous EPIPE rejections.
- There is no explicit queue or high-watermark management in the transport.
- Inbound processing is stream-driven (`for await` over `readJsonl`), one parsed message at a time.

## Streamable HTTP transport internals

## Lifecycle and connection semantics

HTTP transport has logical connection state, but request path is stateless per HTTP call:

- `connect()` sets `connected=true` (no socket/session handshake)
- optional server session tracking via `Mcp-Session-Id` header
- `close()` optionally sends `DELETE` with `Mcp-Session-Id`, aborts SSE listener, emits `onClose`

So `connected` means "transport usable", not "persistent stream established".

## Session header behavior

- On POST response, if `Mcp-Session-Id` header is present, transport stores it.
- Subsequent requests/notifications include `Mcp-Session-Id`.
- `close()` tries to terminate server session with HTTP DELETE; termination failures are ignored.

## Timeout, cancellation, and auth refresh

For `request()`:

- timeout uses `AbortController` via `createMCPTimeout` (`OMP_MCP_TIMEOUT_MS` override, else `config.timeout ?? 30000`; `0` disables)
- external signal, if provided, is merged via `AbortSignal.any([...])`
- AbortError handling distinguishes caller abort vs timeout

For `notify()`:

- timeout uses an internal `AbortController` with the same resolved timeout
- there is no external abort option on the transport interface

For HTTP-like OAuth configs managed by `MCPManager`, outbound requests and best-effort server-request responses retry once on `HTTP 401`/`403` if token refresh returns replacement headers.

## HTTP error propagation

On non-OK response:

- response text is included in thrown error (`HTTP <status>: <text>`)
- if present, auth hints from `WWW-Authenticate` and `Mcp-Auth-Server` are appended

On JSON-RPC error object:

- throws `MCP error <code>: <message>`

Malformed JSON body (`response.json()` failure) propagates as parse exception.

## SSE behavior and modes

Two SSE paths exist:

1. **Per-request SSE response** (`#parseSSEResponse`)
   - used when POST response content type is `text/event-stream`
   - consumes stream until matching response id found
   - can process interleaved notifications during same stream

2. **Background SSE listener** (`startSSEListener()`)
   - optional GET listener for server-initiated notifications and server-to-client requests
   - `connectToServer()` starts it for Streamable HTTP transports after the `notifications/initialized` notification
   - listener startup waits up to one second, or less for very small request timeouts; `timeout: 0` / `OMP_MCP_TIMEOUT_MS=0` disables that startup deadline
   - if GET returns `405`, another non-OK status, no body, or times out, listener silently disables itself

## Malformed payload and disconnect handling

SSE JSON parsing errors bubble out of `readSseJson` and reject request/listener.

- Request SSE parse errors reject the active request.
- Background listener errors trigger `onError` (except AbortError), and an established listener ending while still connected triggers `onClose` so the manager can reconnect.
- Transport does not restart the listener itself; managed connections may reconnect through manager `onClose` handling.

## Legacy HTTP+SSE transport internals

`LegacySseTransport` implements MCP protocol revision 2024-11-05:

- `connect()` opens the configured URL with `GET Accept: text/event-stream`.
- The first `endpoint` event is control data, not JSON; its `data` value is resolved against the configured URL and stored as the JSON-RPC POST endpoint.
- `request()` and `notify()` POST JSON-RPC frames to the discovered endpoint.
- JSON-RPC responses, notifications, and server-to-client requests are read from `event: message` stream events and correlated by request id.
- If the stream ends, pending requests fail with `Transport closed: legacy SSE stream closed`; managed connections may reconnect through `onClose`.

## `json-rpc.ts` utility vs transport abstraction

`src/mcp/json-rpc.ts` provides `callMCP()` and `parseSSE()` helpers for direct HTTP MCP calls (used by Exa integration), not the `MCPTransport` abstraction used by `MCPClient`/`MCPManager`.

Notable differences from `HttpTransport`:

- parses entire response text first, then extracts first `data: ` line (`parseSSE`), with JSON fallback
- optional caller `AbortSignal` (`CallMcpOptions`), with a hard 60s `AbortSignal.timeout` default when none is given; no session-id handling, no transport lifecycle
- returns raw JSON-RPC envelope object

This path is lightweight but less robust than full transport implementation.

## Retry/reconnect responsibilities

## Transport-level

Current transport implementations do **not**:

- retry ordinary failed requests, except HTTP-like transports' single OAuth-refresh retry when `onAuthError` is wired
- reconnect after stdio process exit
- reconnect SSE listeners by themselves
- resend in-flight requests after disconnect

They fail fast and propagate errors.

## Manager/tool-bridge level

`MCPManager` wires `transport.onClose` for managed connections and runs `reconnectServer(name)` when a transport closes unexpectedly. Reconnect tears down the stale connection, re-resolves auth/config values, retries with backoff (`500`, `1000`, `2000`, `4000` ms), reloads tools, and preserves stale tools while reconnecting.

`MCPTool` and `DeferredMCPTool` also attempt one reconnect + retry for retriable connection errors during a tool call. This is tool availability recovery, not transport-level retry.

## Failure scenarios summary

- **Malformed stdio message line**: dropped; stream continues.
- **Stdio stream/process ends**: transport closes; pending requests rejected as `Transport closed`; manager-managed connections trigger reconnect.
- **HTTP non-2xx**: request/notify throws HTTP error; managed OAuth requests can refresh auth and retry once on 401/403.
- **Invalid JSON response**: parse exception propagated.
- **Legacy SSE stream ends**: pending requests fail with `Transport closed: legacy SSE stream closed`; manager-managed connections trigger reconnect.
- **SSE ends without matching id**: request fails with `No response received for request ID ...`.
- **Timeout**: transport-specific timeout error.
- **Caller abort**: AbortError/reason propagated from caller signal where the method accepts one.

## Practical boundary rule

If the concern is message shape, id correlation, or MCP method ordering, it belongs to protocol/client logic.

If the concern is framing (JSONL vs HTTP/SSE), stream parsing, fetch/spawn lifecycle, timeout clocks, or connection teardown, it belongs to transport implementation.
