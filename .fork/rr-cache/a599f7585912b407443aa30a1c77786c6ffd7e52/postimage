# MCP protocol and transport internals

How coding-agent speaks MCP: which revision, where each protocol concern lives, and how the host reaches servers.

## Two hops

```
session ── tunnel: NDJSON, MCP 2026-07-28 + omp/* ──► host unit ── upstream transport ──► server
(client.ts, link.ts)                                  (endpoint.ts)  (stdio / http / sse)
```

- **Session → host.** A session speaks MCP 2026-07-28 only. `HostLink` (`src/mcp/link.ts`) is its single transport: newline-delimited JSON-RPC on a tunnel to the server's host unit (a daemon tunnel, or an in-memory pipe to the in-process host). This is the stdio framing, which the specification extends to any byte stream.
- **Host → server.** The unit's peer (`src/mcp/host/peers.ts`) reaches the server over an upstream transport. A modern server is forwarded to as-is. A handshake-era server sits behind the legacy adapter, which holds its `initialize` session and answers in modern terms.

`docs/mcp-runtime-lifecycle.md` covers who owns what and when processes start and stop.

## The session's protocol (2026-07-28)

Constants and helpers are in `src/mcp/protocol.ts`.

- **Stateless requests.** Every request carries `_meta` with `io.modelcontextprotocol/protocolVersion`, `clientCapabilities` (`{ roots: {} }`) and `clientInfo`. There is no `initialize`, `notifications/initialized` or `ping`.
- **Discovery.** `server/discover` returns capabilities, instructions and, in result `_meta`, server info.
- **Results** carry `resultType`; absent means `complete`. An unknown value is an error.
- **Server asks (MRTR).** `tools/call`, `prompts/get` and `resources/read` may answer `input_required`. The client answers `roots/list` from the connection's roots and retries with `inputResponses` and the echoed `requestState`, at most 8 rounds; any other ask fails the call, since no other capability is declared.
- **Subscriptions.** `subscriptions/listen` replaces `resources/subscribe` and the HTTP GET stream. The session opens one list-change subscription per server and, when resource updates are wanted, one resource subscription holding the current URI set; changing the set opens a new one and cancels the old. Each stream starts with `notifications/subscriptions/acknowledged`; its notifications are tagged with the listen request's id.
- **Caching hints.** List and discover results carry `ttlMs` and `cacheScope`; the host's store honours them.
- **Cancellation.** `notifications/cancelled { requestId }`.

### Tunnel extensions

Declared in `src/mcp/host/contract.ts`; the host strips `omp/*` `_meta` keys before anything reaches a server.

| Extension | Direction | Meaning |
| --- | --- | --- |
| `_meta["omp/cache"] = "stale-ok"` | request | answer from the store even past its TTL without starting the server; the host revalidates and notifies on change |
| `_meta["omp/cache"] = "no-store"` | request | ask the server itself and leave the store untouched (connection tests, auth probes) |
| `_meta["omp/stale"] = true` | result | the served entry was past its TTL |
| `omp/status` | host → session | era, state (`idle`, `starting`, `running`, `failed`), pid, attached sessions, last exit |
| `omp/restart` | session → host | stop the upstream now and clear its crash history |
| `omp/roots` | session → host | the session's roots, for a handshake-era server's `roots/list` |

### Errors

A server's JSON-RPC error passes through both hops with its code, message and data. Failures of the upstream itself (spawn failure, exit, HTTP status, timeout) are sent as JSON-RPC error `1001` whose `data` is an `MCPTransportError` field for field (`transport`, `stage`, `failure`, `retryable`, `code`, `data`, `traceId`, and the exit code and stderr tail when a process died); the link rebuilds the same error object. Tool diagnostics and retry classification therefore work as they did when transports lived in the session.

### Deadlines, progress, abort

`HostLink.request` applies the deadline: `OMP_MCP_TIMEOUT_MS`, else the server's `timeout`, else 10 minutes for `tools/call` (raised to a tool's own timeout argument plus 30 s) and 30 s otherwise; `0` disables. Without a configured timeout each progress notification restarts a tool call's deadline, up to one hour. `onProgress` adds `_meta.progressToken`; progress reaches only that request's callback. On abort or deadline the link rejects at once and sends `notifications/cancelled`; a pre-aborted request is never written. A subscription has a deadline only until it is acknowledged.

Requests issued while the link is re-attaching wait for it. When the tunnel is lost, in-flight requests fail as non-retryable (`failure: "closed"`): they may have run.

## Request ids

The link and each upstream allocate their own ids. Upstream ids default to increasing integers, which servers such as Apple's `xcrun mcpbridge` require; `requestIdFormat: "string"` switches a server to snowflake strings. The unit maps each session's id to an upstream id and back, so ids of different sessions never collide on a shared server; progress tokens and subscription ids are isolated the same way.

## Era detection

`mcpUpstreams.probe` decides a server's era once, on a throwaway upstream, and the store remembers it (a handshake-era verdict is rechecked after 7 days, so an upgraded server starts being shared):

- **stdio**: the probe writes `server/discover` and then `initialize`. A discover result or a modern-only error (`-32020`, `-32021`, `-32022`) means modern; otherwise the `initialize` result means handshake-era. The probe process is always killed.
- **http**: a modern `server/discover` POST. A discover result or a modern-only error body means modern. Anything else that is not an auth failure is confirmed with a legacy `initialize`. `401`/`403` surface unchanged so OAuth discovery can read the challenge.
- **sse**: always handshake-era.

## Upstream transports

All implement `MCPTransport` (`src/mcp/types.ts`) and apply no request deadline of their own; they honour the caller's abort signal.

### stdio (`host/stdio-upstream.ts`)

- The child is a daemon `ManagedChild`: own process group, raw pipe fds that survive a daemon re-exec. Command, arguments, cwd and the complete environment come from the session's spec, never from the host's own environment.
- Windows: the command is resolved to its full path (cwd, then `PATH` × `PATHEXT`; npm shims are run through `node` directly) and spawned with plain arguments; arguments containing NUL, CR or LF are rejected for batch targets.
- One JSON-RPC message per line. Non-JSON lines are skipped. The last 4 KiB of stderr are kept and attached to exit and start failures.
- Abort of a written request sends `notifications/cancelled`.
- Shutdown: close stdin, SIGTERM to the process group after 1 s, SIGKILL after 2 s, then one group SIGKILL sweep on POSIX for descendants.
- A request whose frame was written before the process died fails as non-retryable.

### Streamable HTTP (`host/http-upstream.ts`)

Modern mode:

- POST only, `Accept: application/json, text/event-stream`. Every request carries `MCP-Protocol-Version`, `Mcp-Method` and, for `tools/call`, `prompts/get` and `resources/read`, `Mcp-Name`; values that are not plain ASCII are sent as `=?base64?…?=`.
- `Mcp-Param-*` headers follow a tool's `x-mcp-header` annotations; tools with invalid annotations are dropped from `tools/list`.
- Responses are JSON or an SSE stream ending with the response. `subscriptions/listen` is a POST whose stream stays open. Closing the stream is the cancellation.
- No session id, GET stream, DELETE or `Last-Event-ID`.

Legacy mode (handshake-era servers) is the 2025-11-25 binding: `Mcp-Session-Id`, the optional GET listener started after `notifications/initialized`, `Last-Event-ID` resumption that never replays a POST, and DELETE on close.

Both modes: generated headers win over configured ones case-insensitively; origin-locked headers are dropped on cross-origin redirects. A non-OK response becomes `HTTP <status>: <text>` with `WWW-Authenticate` and `Mcp-Auth-Server` hints appended. The transport does not refresh credentials: on `401`/`403` the session's refresh hook resolves new headers, the link retargets to that identity, and the request is retried once.

### Legacy HTTP+SSE (`host/sse-upstream.ts`)

Revision 2024-11-05: GET the configured URL, read the `endpoint` event (same origin required), POST JSON-RPC there, receive responses on the stream. Stream loss fails accepted requests as non-retryable.

## Legacy adapter

For a handshake-era server the peer performs `initialize` (revision 2025-11-25, roots capability) and `notifications/initialized`, then translates:

| Modern request | What the adapter does |
| --- | --- |
| `server/discover` | built from the `initialize` result |
| list methods | forwarded; result completed with `resultType`, a 30-day `ttlMs`, `cacheScope: "private"`; `resources/templates/list` answering `-32601` is an empty list |
| `tools/call`, `prompts/get`, `resources/read` | forwarded without modern-only `_meta` and MRTR fields |
| `subscriptions/listen` | acknowledged with what the server's capabilities support; resource URIs become refcounted `resources/subscribe`/`unsubscribe`; the server's notifications are routed to matching subscriptions |

Server requests are answered in the adapter: `ping` with `{}`, `roots/list` with the session's roots (`omp/roots`), anything else with `-32601`.

## `json-rpc.ts`

`callMCP()` and `readMcpJsonRpcResponse()` are a separate lightweight HTTP helper used by Exa and web-search providers. It is not hosted, manages no sessions, and applies a 60 s timeout when the caller supplies no signal.

## Who retries what

- **Upstream transports**: nothing.
- **Host unit**: starts a stopped or crashed server on the next request, subject to the crash guard.
- **Link**: one retry after a credential refresh on `401`/`403`.
- **Tool bridge**: one reconnect and retry for failures marked retryable; never for a request that may have reached the server.
