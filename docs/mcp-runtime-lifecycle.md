# MCP runtime lifecycle

This document describes how MCP servers are discovered, connected, exposed as tools, refreshed, and torn down in the coding-agent runtime.

## Lifecycle at a glance

1. **SDK startup** kicks off MCP discovery (unless MCP is disabled or tool names are restricted): headless/SDK sessions await `discoverAndLoadMCPTools()`; interactive sessions (`hasUI: true`) create the manager up front and defer `discoverAndConnect()` until the session is live.
2. **Discovery** (`loadAllMCPConfigs`) resolves MCP server configs from capability sources, filters disabled/project/Exa entries and browser MCP servers when the built-in browser prelude is callable, and preserves source metadata.
3. **Manager connect phase** (`MCPManager.connectServers`) starts per-server connect + `tools/list` in parallel.
4. **Fast startup gate** waits up to 250ms, then may return:
   - fully loaded `MCPTool`s,
   - failures per server,
   - or cached `DeferredMCPTool`s for still-pending servers.
5. **SDK wiring** merges MCP tools into runtime tool registry for the session.
6. **Post-connect enrichment** best-effort loads resources, resource templates, prompts, and optional resource subscriptions.
7. **Live session** receives late tool changes through the manager callback; `/mcp reload` does `disconnectAll` + rediscovery + `session.refreshMCPTools`, while transport close and `/mcp reconnect` use the per-server reconnect path.
8. **Teardown** happens on explicit manager disconnects and automatically when an owning `AgentSession` is disposed; borrowed parent managers are not disconnected by subagents.

## Discovery and load phase

### Entry path from SDK

`createAgentSession()` in `src/sdk.ts` performs MCP startup when `enableMCP` is true (default) and tool names are not restricted. A supplied `mcpManager` is reused without discovery. Otherwise there are two paths:

- **Headless/SDK** (no UI, no provided manager): awaits `discoverAndLoadMCPTools(cwd, { ... })` and merges the returned tools into the startup `customTools` set. Print mode alone then waits for configured servers' tool handshakes or failures before its first prompt (bounded by `OMP_MCP_TIMEOUT_MS`, default 30 seconds), refreshes the session's tool registry, and warns per unavailable server; `OMP_MCP_REQUIRE_READY=1` instead exits 1 without sending the prompt. `OMP_MCP_TIMEOUT_MS=0` disables this barrier deadline and may wait indefinitely.
- **Interactive/TUI** (`hasUI: true`, no provided manager): constructs `MCPManager` immediately (with cache + auth storage), defers `discoverAndConnect()` to a background task started after the session exists, then binds tools via `session.refreshMCPTools(...)` (disposing the manager if the session was torn down mid-connect).

Both paths:

- pass `authStorage`, cache storage, `mcp.startupTimeoutMs`, and `mcp.enableProjectConfig`; browser-MCP filtering requires `browser.enabled`, registered and active Eval, and an unrestricted session,
- always set `filterExa: true`,
- log per-server load/connect errors,
- store the manager in `toolSession.mcpManager` and the session result.

If `enableMCP` is false or the session restricts tool names, MCP discovery and manager inheritance are skipped entirely. ACP sessions disable on-disk discovery because their MCP definitions come from the ACP client.

### Config discovery and filtering

`loadAllMCPConfigs()` (`src/mcp/config.ts`) loads canonical MCP server items through capability discovery, then converts to legacy `MCPServerConfig`.

Filtering behavior:

- `enableProjectConfig: false` removes project-level entries (`_source.level === "project"`).
- `enabled: false` entries are suppressed unless the active-profile user `enabledServers` allowlist names them; the user `disabledServers` denylist always suppresses a same-named entry.
- Exa servers are filtered out by default and API keys are extracted for native Exa tool integration, unless the config explicitly requests Exa tools the native integration does not provide (`web_fetch_exa`, `web_search_advanced_exa`); browser automation MCP servers are filtered when `filterBrowser` is true.

Result includes both `configs` and `sources` (metadata used later for provider labeling).

### Discovery-level failure behavior

`discoverAndLoadMCPTools()` distinguishes two failure classes:

- **Discovery hard failure** (exception from `manager.discoverAndConnect`, typically from config discovery): returns an empty tool set and one synthetic error `{ path: ".mcp.json", error }`.
- **Per-server runtime/connect failure**: manager returns partial success with `errors` map; other servers continue.

So startup does not fail the whole agent session when individual MCP servers fail.

## Manager state model

`MCPManager` tracks runtime lifecycle with separate registries:

- `#connections: Map<string, MCPServerConnection>` — fully connected servers.
- `#pendingConnections: Map<string, Promise<MCPServerConnection>>` — handshake in progress.
- `#pendingToolLoads: Map<string, Promise<{ connection, serverTools }>>` — initialized connections whose `tools/list` is still in flight.
- `#tools: CustomTool[]` — current MCP tool view exposed to callers, kept in stable name order.
- `#sources: Map<string, SourceMeta>` — provider/source metadata even before connect completes.
- `#pendingReconnections: Map<string, Promise<MCPServerConnection | null>>` — reconnects in progress after a dropped transport or explicit reconnect.
- `#startupUpdates`, `#startupServers`, and `#startupFailures` — track tool registration/callback completion for startup readiness barriers.
- `#lostRemoteServers` — scheduled recovery state for previously connected HTTP/SSE servers that remain unavailable.
- `#serverConfigs: Map<string, MCPServerConfig>` — original unresolved configs preserved so reconnect can re-resolve credentials without leaking resolved tokens.
- `#reconnectHistory: Map<string, number[]>` plus `#epoch` — per-server crash-window accounting and invalidation of reconnect attempts that outlive a global disconnect.
- listener/callback state, including a bounded pending-notification FIFO and tracked resource subscriptions/refreshes.

`getConnectionStatus(name)` derives status from these maps:

- `connected` if in `#connections`,
- `connecting` if pending connect, pending tool load, or pending reconnect,
- `disconnected` otherwise.

## Connection establishment and startup timing

### Per-server connect pipeline

For each discovered server in `connectServers()`:

1. store/update source metadata,
2. skip if already connected/pending/reconnecting,
3. validate transport fields (`validateServerConfig`),
4. save the unresolved config for possible reconnect,
5. resolve managed OAuth credentials and env/header shell substitutions (`#resolveAuthConfig`),
6. call `connectToServer(name, resolvedConfig)` with manager notification/request handlers,
7. wire HTTP OAuth refresh and transport `onClose` reconnect handling,
8. call `listTools(connection)`,
9. cache tool definitions (`MCPToolCache.set`) best-effort,
10. best-effort load resources, resource templates, prompts, and subscriptions after tools load.

`connectToServer()` behavior (`src/mcp/client.ts`):

- creates stdio or HTTP/SSE transport,
- performs MCP `initialize` using protocol version `2025-11-25` and advertises the `roots` capability,
- answers server-to-client `ping` and `roots/list` requests; unsupported request methods return JSON-RPC `-32601`,
- sends `notifications/initialized` before any further session traffic,
- for Streamable HTTP, starts the background SSE listener only after `notifications/initialized`,
- uses timeout precedence `OMP_MCP_TIMEOUT_MS`, then `config.timeout`, then 30s; `0` disables the client-side timeout,
- records the server's negotiated protocol revision; Streamable HTTP carries it on subsequent requests in `MCP-Protocol-Version`,
- closes transport on init failure.

### Fast startup gate + deferred fallback

`connectServers()` waits on a race between:

- all connect/tool-load tasks settled, and
- `resolveMCPStartupTimeoutMs`: `OMP_MCP_STARTUP_TIMEOUT_MS` env override, else `mcp.startupTimeoutMs`, else 250 ms; `0` waits until initial loads settle.

After the startup window:

- fulfilled tasks become live `MCPTool`s,
- rejected tasks produce per-server errors,
- still-pending tasks:
  - use cached tool definitions if available (`MCPToolCache.get`) to create `DeferredMCPTool`s,
  - otherwise contribute no tools at startup; they stay in flight, and the background continuation registers their tools via `#onToolsChanged` once connect/list finishes (a slow server no longer blocks startup — issue #2100).

This is a hybrid startup model: fast return with deferred handles when cache is available, late background registration when it is not.

### Background completion behavior

Each pending `toolsPromise` also has a background continuation that eventually:

- replaces that server's tool slice in manager state and restores stable name ordering,
- invokes `#onToolsChanged` so a live session can rebind the late tools,
- writes cache,
- logs late failures only after startup (`allowBackgroundLogging`).

## Tool exposure and live-session availability

### Startup registration

`discoverAndLoadMCPTools()` converts manager tools into `LoadedCustomTool[]` and decorates paths (`mcp:<server> via <providerName>` when known).

`createAgentSession()` then pushes these tools into `customTools`, which are wrapped and added to the runtime tool registry with names like `mcp__<server>_<tool>`.

Server and tool name components are lowercased and sanitized to letters, digits, and underscores; repeated/edge underscores are collapsed/trimmed, and a redundant server prefix on the tool is stripped. Names longer than 64 characters are capped with a deterministic hash suffix. If two distinct origins mint the same runtime name, OMP logs the collision and keeps a deterministic winner based on the original server/tool identity, so reconnect ordering cannot change ownership.

Connected manager tools become enabled immediately. Presentation is reconciled with the session's current tool policy: tools may be mounted under `xd://` rather than exposed as top-level function definitions; Code Mode can route them through the Eval bridge. Registry identity and original server/tool ownership remain intact regardless of presentation.

### Tool calls

- `MCPTool` calls tools through an already connected `MCPServerConnection`.
- `DeferredMCPTool` waits for `waitForConnection(server)` before calling; this allows cached tools to exist before connection is ready.
- Both attempt a reconnect + single retry for retriable connection failures.
- A structured tool-result auth challenge can trigger the configured auth handler, reconnect, and one retry. Interactive mode wires this to the `/mcp` OAuth controller; without a handler the challenge remains an MCP error.

Both preserve MCP content and metadata; `structuredContent` is retained in `details.structuredContent` and rendered as text when not already duplicated in a text block. Server `isError` results propagate the error flag. Remaining exceptions become an `MCP failure` diagnostic with server/tool, transport, stage, failure class, retryability, message, optional code/trace/data, and next-step guidance; abort remains abort. Structured stdio/HTTP errors drive retry classification, and failures after an accepted request SSE POST are not replayed.

## Refresh/reload paths (startup vs live reload)

### Initial startup path

- one-time discovery/load in `sdk.ts`,
- tools are registered in initial session tool registry.

### Interactive reload and live-change paths

`/mcp reload` (`src/modes/controllers/mcp-command-controller.ts`) does:

1. `mcpManager.disconnectAll()`,
2. clears stale MCP prompt commands,
3. calls `mcpManager.discoverAndConnect()` with the same project/Exa/browser filters as startup,
4. calls `session.refreshMCPTools(mcpManager.getTools())`.

`session.refreshMCPTools()` delegates to `src/session/session-tools.ts`, which serializes registry mutations, reconciles manager and extension-owned MCP tools, re-wraps the latest tools, and reapplies availability/presentation without restarting. Connected manager tools become enabled; extension-owned MCP tools preserve their previous selection. A failed refresh restores the previous MCP registry. The owning SDK session also installs `setOnToolsChanged`, so late initial connections, server `tools/list_changed` notifications, reconnects, and disconnects can trigger the same rebinding. Explicit `/mcp reconnect <name>` performs one final refresh after the manager reconnect completes.

### Live settings reconciliation

The owning SDK session listens for `mcp.enableProjectConfig` changes: it disconnects affected project entries, restores user definitions they shadowed, or loads newly allowed project entries without `/mcp reload`. Browser-MCP reconciliation is serialized and follows whether the built-in browser prelude is actually callable. Borrowed managers keep the parent's single-slot tools/prompts/resources callbacks; each session still installs its own notification listener.

## Server-initiated notifications

MCP servers may push JSON-RPC notification frames at any point after `initialize` completes. The transport surfaces them via `onNotification`; the manager fans them out in two paths:

1. **Internal refresh** for known methods:
   - `notifications/tools/list_changed` → `refreshServerTools`
   - `notifications/resources/list_changed` → `refreshServerResources`
   - `notifications/resources/updated` → `#onResourcesChanged` (only for currently subscribed URIs)
   - `notifications/prompts/list_changed` → `refreshServerPrompts`
2. **Listener fanout**: every notification (known and server-custom) is delivered after any internal refresh. `MCPManager.addNotificationListener(listener)` returns an unsubscribe function; multiple listeners have independent error isolation.

If no listener is attached, the manager buffers up to 100 frames, dropping the oldest on overflow, then drains the FIFO into the first listener that attaches. `sdk.ts` registers a per-session listener that bridges to the extension runner's `mcp_notification` event with `{ server, method, params }`; the extension runner has its own bounded startup buffer. The listener and debounce timers are released through session postmortem cleanup.

## Health, reconnect, and partial failure behavior

Current runtime behavior is connection-event driven:

- **No autonomous polling health monitor** in manager/client.
- **Automatic reconnect is wired to `transport.onClose`** for managed connections.
- Reconnect retries with backoff (`500`, `1000`, `2000`, `4000` ms), reloads tools, and notifies consumers on success. A crash-storm circuit breaker suspends automatic reconnects for a server after more than 5 reconnect attempts within 30s; manual `/mcp reconnect` resets that history.
- If a previously connected HTTP/SSE server remains unavailable after the retry ladder, quiet scheduled probes continue after 15s, doubling up to 5 minutes until recovery, explicit disconnect, or reconfiguration. Scheduled probes make one full connection attempt and concurrent reconnect callers share it. Stdio and remote servers that never connected stop at the ladder.
- Initial connection timeouts trigger a reconnect attempt; print-mode readiness includes these attempts.
- Tool calls that see retriable connection errors also attempt one reconnect + retry.
- Reconnect is also explicit via `/mcp reconnect <name>` or broader `/mcp reload`.

Operationally:

- one server failing does not remove tools from healthy servers,
- connect/list failures are isolated per server,
- stale tools may remain visible while reconnect is attempted; calls report MCP errors if recovery fails,
- tool cache, resource/prompt loading, subscriptions, and background updates are best-effort (warnings/errors logged, no hard stop).

## Teardown semantics

### Server-level teardown

`disconnectServer(name)`:

- removes pending connect/tool-load/reconnect and startup-readiness entries, source metadata, saved config, reconnect history, scheduled remote recovery, and resource refresh/subscription state,
- detaches `onClose` so explicit close does not trigger reconnect,
- closes the transport if connected,
- removes tools by their exact `mcpServerName` owner (not by a sanitized name prefix) and notifies tool consumers,
- notifies prompt consumers when stale prompt commands need removal.

### Global teardown and ownership

`disconnectAll()`:

- increments a lifecycle epoch so initial connections or reconnects that finish later cannot resurrect old connections, and cancels scheduled remote recovery,
- detaches `onClose` for all active transports, then closes them with `Promise.allSettled`,
- clears pending maps, sources, saved configs, connections, subscriptions, resource refreshes, reconnect history, and manager tools.

Top-level sessions own managers they create. `AgentSession.dispose()` disconnects that owned manager with a 3-second cleanup timeout and logs cleanup failure; a subagent/session given `options.mcpManager` borrows the parent manager and does not disconnect it. `/mcp reload` deliberately reuses the manager object after `disconnectAll`, so installed callbacks/listeners remain available for the next discovery cycle.

## Failure modes and guarantees

| Scenario                                             | Behavior                                                                                                                  | Hard fail vs best-effort       |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| Discovery throws (capability/config load path)       | Loader returns empty tools + synthetic `.mcp.json` error                                                                  | Best-effort session startup    |
| Invalid server config                                | Server skipped with validation error entry                                                                                | Best-effort per server         |
| Connect timeout/init failure                         | Server error recorded; others continue                                                                                    | Best-effort per server         |
| `tools/list` still pending at startup with cache hit | Deferred tools returned immediately                                                                                       | Best-effort fast startup       |
| `tools/list` still pending at startup without cache  | No tools at startup; background continuation registers them via `#onToolsChanged` when ready                              | Best-effort late registration  |
| Late background tool-load failure                    | Logged after startup gate                                                                                                 | Best-effort logging            |
| Runtime dropped transport                            | Manager attempts reconnect; stale tools remain while reconnecting and future calls may retry once or fail with MCP errors | Best-effort automatic recovery |
| Previously connected remote server still unavailable after retry ladder | Quiet single-attempt probes continue from 15s up to 5-minute intervals until recovery/disconnect/reconfiguration | Best-effort background recovery |
| More than 5 reconnect invocations within 30s         | Circuit breaker closes/removes the stale connection but leaves tools registered; manual reconnect resets the history      | Automatic reconnect suspended  |
| Owning session disposal                              | Owned manager disconnect is awaited for up to 3s; failure is logged                                                       | Bounded best-effort cleanup    |

## Public API surface

`src/mcp/index.ts` re-exports client operations, config loader/writer APIs, loader and manager APIs, OAuth discovery, tool bridges/cache, HTTP and stdio transports, protocol types, plus the lightweight HTTP helpers `callMCP`, `readMcpJsonRpcResponse`, and `redactUrlForLog`. `src/sdk.ts` exposes `discoverMCPServers()` as a convenience wrapper over `discoverAndLoadMCPTools`; it returns `{ manager, tools, errors, connectedServers, exaApiKeys }`.

## Implementation files

- [`src/mcp/loader.ts`](../packages/coding-agent/src/mcp/loader.ts) — loader facade, discovery error normalization, `LoadedCustomTool` conversion.
- [`src/mcp/manager.ts`](../packages/coding-agent/src/mcp/manager.ts) — lifecycle state registries, parallel connect/list flow, refresh/disconnect.
- [`src/mcp/client.ts`](../packages/coding-agent/src/mcp/client.ts) — transport setup, initialize handshake, list/call/disconnect.
- [`src/mcp/index.ts`](../packages/coding-agent/src/mcp/index.ts) — MCP module API exports.
- [`src/sdk.ts`](../packages/coding-agent/src/sdk.ts) — startup wiring into session/tool registry.
- [`src/mcp/config.ts`](../packages/coding-agent/src/mcp/config.ts) — config discovery/filtering/validation used by manager.
- [`src/mcp/tool-bridge.ts`](../packages/coding-agent/src/mcp/tool-bridge.ts) — `MCPTool` and `DeferredMCPTool` runtime behavior.
- [`src/session/agent-session.ts`](../packages/coding-agent/src/session/agent-session.ts) — session ownership/disposal and tool-refresh facade.
- [`src/session/session-tools.ts`](../packages/coding-agent/src/session/session-tools.ts) — serialized MCP registry rebinding and tool presentation.
- [`src/mcp/errors.ts`](../packages/coding-agent/src/mcp/errors.ts) — structured transport failures and tool diagnostics.
- [`src/modes/controllers/mcp-command-controller.ts`](../packages/coding-agent/src/modes/controllers/mcp-command-controller.ts) — interactive reload/reconnect flows.
- [`src/task/executor.ts`](../packages/coding-agent/src/task/executor.ts) — subagent MCP proxying via parent manager connections.
