# MCP server and tool authoring

This document explains how MCP server definitions become callable `mcp__*` tools in coding-agent, and what operators should expect when configs are invalid, duplicated, disabled, or auth-gated.

## Architecture at a glance

```text
Config sources (.omp/.claude/.cursor/.vscode/mcp.json, mcp.json, etc.)
  -> discovery providers normalize to canonical MCPServer
  -> capability loader dedupes by server name (higher provider priority wins)
  -> loadAllMCPConfigs applies user enablement overrides and suppresses disabled servers
  -> MCPManager connects/listTools (with auth/header/env resolution)
  -> manager best-effort loads resources/prompts and subscribes to resource updates when enabled
  -> MCPTool/DeferredMCPTool bridge exposes tools as mcp__<server>_<tool>
  -> AgentSession.refreshMCPTools replaces live MCP tools immediately
```

## 1) Server config model and validation

`src/mcp/types.ts` defines the authoring shape used by MCP config writers and runtime:

- `stdio` (default when `type` missing): requires `command`, optional `args`, `env`, `cwd`
- `http`: requires `url`, optional `headers`
- `sse`: requires `url`, optional `headers` (kept for compatibility)
- shared fields: `enabled`, `timeout`, `requestIdFormat` (`"number"` or `"string"`), `auth`, `oauth`

`validateServerConfig()` (`src/mcp/config.ts`) enforces transport basics:

- rejects configs that set both `command` and `url`
- requires `command` for stdio
- requires `url` for http/sse
- rejects unknown `type`

`config-writer.ts` applies this validation for add/update operations and also validates server names:

- non-empty
- max 100 chars
- only `[a-zA-Z0-9_.:-]` (colon allows namespaced plugin server names, e.g. `cloudflare:cloudflare-api`)

### Transport pitfalls

- `type` omitted means stdio. If you intended HTTP/SSE but omitted `type`, `command` becomes mandatory.
- `sse` selects the legacy protocol-revision 2024-11-05 HTTP+SSE transport: a persistent GET stream supplies an `endpoint` event whose URL receives JSON-RPC POSTs. It is distinct from the `"http"` Streamable HTTP transport.
- Outbound JSON-RPC request IDs default to incrementing numbers for ecosystem compatibility. Set `requestIdFormat: "string"` only for a server that requires the older snowflake-string behavior; invalid values are warned about and ignored during discovery.
- Validation is structural, not reachability: a syntactically valid URL can still fail at connect time.

## 2) Discovery, normalization, and precedence

### Capability-based discovery

`loadAllMCPConfigs()` (`src/mcp/config.ts`) loads canonical `MCPServer` items via `loadCapability(mcpCapability.id)`.

The capability layer (`src/capability/index.ts`) then:

1. loads providers in priority order
2. dedupes by `server.name` (first win = highest priority)
3. validates deduped items

Result: duplicate server names across sources are not merged. One definition wins; lower-priority duplicates are shadowed.

### `.mcp.json` and related files

The dedicated fallback provider in `src/discovery/mcp-json.ts` reads project-root `mcp.json` and `.mcp.json` (low priority).

In practice MCP servers also come from higher-priority providers (for example native `.omp/...` and tool-specific config dirs). Authoring guidance:

- Prefer `.omp/mcp.json` (project) or `~/.omp/agent/mcp.json` (user) for explicit control.
- Use root `mcp.json` / `.mcp.json` when you need fallback compatibility.
- Reusing the same server name in multiple sources causes precedence shadowing, not merge.

### Normalization behavior

`convertToLegacyConfig()` (`src/mcp/config.ts`) maps canonical `MCPServer` to runtime `MCPServerConfig`.

Key behavior:

- transport inferred as `server.transport ?? (command ? "stdio" : url ? "http" : "stdio")`
- `requestIdFormat` is preserved; omitted means numeric IDs
- names in the active-profile user `disabledServers` list are always suppressed; a server with `enabled === false` is suppressed unless the same user config names it in `enabledServers`
- optional fields are preserved when present

### Environment expansion during discovery

OMP-native MCP config (`.omp/mcp.json`, `~/.omp/agent/mcp.json`, plus their `.mcp.json` variants) expands `${VAR}` and `${VAR:-default}` placeholders recursively before converting to runtime config. It also accepts boolean/string forms for `enabled` (`true`, `false`, `1`, `0`) and numeric strings for `timeout`. `requestIdFormat` accepts only `"number"` or `"string"`; other values warn and fall back to numeric IDs.

The standalone fallback provider in `src/discovery/mcp-json.ts` reads project-root `mcp.json` and `.mcp.json`, expands the same `${...}` placeholders, and type-checks `enabled`/`timeout` without coercing string values. It applies the same `requestIdFormat` validation.

Invalid `enabled`/`timeout` values are ignored with warnings rather than failing the whole file.

## 3) Auth and runtime value resolution

`MCPManager.prepareConfig()`/`#resolveAuthConfig()` (`src/mcp/manager.ts`) is the final pre-connect pass.

### OAuth credential injection

For `http`/`sse` servers, an `auth: { type: "oauth", credentialId: "..." }`
block is optional. OMP honors an explicit arbitrary or legacy credential ID when
it resolves. A managed, profile-scoped
`mcp_oauth:profile:<profile>:<url>` ID is accepted only when its profile is
active and its URL matches the server's expanded or literal URL; a mismatch is
ignored. If the accepted explicit ID does not resolve—or if there is no `auth`
block—OMP looks for a credential under deterministic IDs derived from the
expanded and literal server URL. These URL-keyed credentials are scoped to the
active profile, so a shared, definition-only server entry can use each
profile's independently stored OAuth credential.

A case-insensitive, explicitly configured `Authorization` header suppresses
that URL-keyed fallback. `stdio` servers have no URL to bind: their explicit
arbitrary or legacy credential ID must resolve, and a URL-keyed,
profile-scoped ID is ignored.

When lookup succeeds:

- `http`/`sse`: injects `Authorization: Bearer <access_token>` header
- `stdio`: injects `OAUTH_ACCESS_TOKEN` env var

If no credential resolves, OMP connects without injecting an OAuth value.
Refresh or credential-resolution failures are logged; when possible, OMP
continues with the existing access token.

### Header/env value resolution

Before connect, manager resolves stdio `env` values and HTTP/SSE `headers` values via `resolveConfigValue()` (`src/config/resolve-config-value.ts`):

- value starting with `!` => execute shell command, use trimmed stdout (cached)
- failed, timed-out, or whitespace-only commands produce `undefined`, so that entry is omitted
- otherwise, treat value as environment variable name first (`process.env[name]`), fallback to literal value

Operational caveat: a mistyped `!` secret command can silently remove that header/env entry, producing downstream 401/403 or server startup failures. A mistyped environment variable name is sent literally unless that literal happens to be meaningful to the server.

## 4) Tool bridge: MCP -> agent-callable tools

`src/mcp/tool-bridge.ts` converts MCP tool definitions into `CustomTool`s.

### Naming and collision domain

Tool names are generated as:

```text
mcp__<sanitized_server_name>_<sanitized_tool_name>
```

Rules:

- lowercases
- non-`[a-z_]` chars become `_`
- repeated underscores collapse
- redundant `<server>_` prefix in tool name is stripped once
- names longer than 64 characters keep a readable prefix and append `_` plus the first eight base-36
  characters of `Bun.hash()` over the full uncapped generated name

Different raw names can still sanitize to the same identifier (for example
`my-server` and `my.server` both sanitize similarly). Before registry
insertion, `deduplicateMCPToolsByName()` chooses one deterministic winner by
lexicographically comparing the original `<server-name>\0<tool-name>` origin
key. The losing origin is logged and omitted, so reconnect or discovery order
cannot change ownership.

### Schema mapping

`tool-bridge.ts` passes each MCP `inputSchema` through `normalizeSchemaForMCP()` before registering it as a `CustomTool` schema.

### Outbound argument normalization

Before either live or deferred tools send `tools/call`, the bridge normalizes
the call's arguments in this order:

1. Non-object values, `null`, and arrays at the top level become an empty
   argument object.
2. The harness-injected intent field `i` is removed unless the MCP tool's own
   `inputSchema.properties` declares `i`.
3. For a property declared by the MCP schema but not listed in `required`, a
   value of `undefined`, an empty string, or an empty non-array object is
   omitted. Required properties, undeclared properties, `0`, `false`, `null`,
   and arrays (including empty arrays) are preserved.
4. String values are walked recursively through nested objects and arrays.
   A resolvable `local://` file URL becomes the real filesystem path that an
   external MCP server can read. The original string remains when no active
   local-file resolver exists or the URL denotes a directory/root rather than
   a file; invalid, missing, or escaping local-file URLs fail during
   normalization instead of reaching `tools/call`.

Server authors should therefore validate against the normalized payload, not
assume that every field present in the model-generated call reaches the server.

### Execution mapping

`MCPTool.execute()` / `DeferredMCPTool.execute()`:

- calls MCP `tools/call`
- flattens MCP content into displayable text
- returns structured details (`serverName`, `mcpToolName`, provider metadata)
- maps server-reported `isError` to `Error: ...` text result
- attempts reconnect + one retry for retriable connection errors
- maps remaining thrown transport/runtime failures to `MCP error: ...`
- preserves abort semantics by translating AbortError into `ToolAbortError`

## 5) Operator lifecycle: add/edit/remove and live updates

Interactive mode exposes `/mcp` in `src/modes/controllers/mcp-command-controller.ts`.

Supported operations:

- `add` (wizard or quick-add)
- `remove` / `rm`
- `enable` / `disable`
- `test`
- `reauth` / `unauth`
- `reconnect`
- `reload`
- `resources`, `prompts`, `notifications`
- Smithery search/login/logout flows

Config writes are atomic (`writeMCPConfigFile`: temp file + rename).

After changes, controller calls `#reloadMCP()`:

1. `mcpManager.disconnectAll()`
2. `mcpManager.discoverAndConnect()`
3. `session.refreshMCPTools(mcpManager.getTools())`

`refreshMCPTools()` replaces all `mcp__` registry entries and immediately re-activates the latest MCP tool set, so changes take effect without restarting the session.

### Mode differences

- **Interactive/TUI mode**: `/mcp` gives in-app UX (wizard, OAuth flow, connection status text, immediate runtime rebinding).
- **SDK/headless integration**: `discoverAndLoadMCPTools()` (`src/mcp/loader.ts`) returns loaded tools + per-server errors; no `/mcp` command UX.

## 6) User-visible error surfaces

Common error strings users/operators see:

- add/update validation failures:
  - `Invalid server config: ...`
  - `Server "<name>" already exists in <path>`
- quick-add argument issues:
  - `Use either --url or -- <command...>, not both.`
  - `--token requires --url (HTTP/SSE transport).`
- connect/test failures:
  - `Failed to connect to "<name>": <message>`
  - timeout help text suggests increasing timeout
  - auth help text for `401/403`
- auth/OAuth flows:
  - `Authentication required ... OAuth endpoints could not be discovered`
  - `OAuth flow timed out. Please try again.`
  - `OAuth authentication failed: ...`
- disabled server usage:
  - `Server "<name>" is disabled. Run /mcp enable <name> first.`

Bad source JSON in discovery is generally handled as warnings/logs; config-writer paths throw explicit errors.

## 7) Practical authoring guidance

For robust MCP authoring in this codebase:

1. Keep server names globally unique across all MCP-capable config sources.
2. Prefer names that remain distinct after MCP tool-name sanitization to avoid generated `mcp__` collisions.
3. Use explicit `type` to avoid accidental stdio defaults.
4. Use the active-profile user `enabledServers` list when you need to override a discovered server's `enabled: false`; `disabledServers` always wins if the name appears in both lists.
5. For remote OAuth servers, a valid explicit `credentialId` is optional: a definition-only `http`/`sse` entry can use the active profile's credential bound to the same URL. Use an explicit `Authorization` header when that URL-keyed fallback must be suppressed.
6. If using command-based secret resolution (`!cmd`), verify command output is stable and non-empty.

## Implementation files

- [`src/mcp/types.ts`](../packages/coding-agent/src/mcp/types.ts)
- [`src/mcp/config.ts`](../packages/coding-agent/src/mcp/config.ts)
- [`src/mcp/config-writer.ts`](../packages/coding-agent/src/mcp/config-writer.ts)
- [`src/mcp/tool-bridge.ts`](../packages/coding-agent/src/mcp/tool-bridge.ts)
- [`src/discovery/mcp-json.ts`](../packages/coding-agent/src/discovery/mcp-json.ts)
- [`src/modes/controllers/mcp-command-controller.ts`](../packages/coding-agent/src/modes/controllers/mcp-command-controller.ts)
- [`src/mcp/manager.ts`](../packages/coding-agent/src/mcp/manager.ts)
- [`src/capability/index.ts`](../packages/coding-agent/src/capability/index.ts)
- [`src/config/resolve-config-value.ts`](../packages/coding-agent/src/config/resolve-config-value.ts)
- [`src/mcp/loader.ts`](../packages/coding-agent/src/mcp/loader.ts)
