# MCP server and tool authoring

This document explains how MCP server definitions become callable `mcp__*` tools in coding-agent, and what operators should expect when configs are invalid, duplicated, disabled, or auth-gated.

## Architecture at a glance

```text
Config sources (.omp/.claude/.cursor/.vscode/mcp.json, mcp.json, etc.)
  -> discovery providers normalize to canonical MCPServer
  -> loadAllMCPConfigs supplies scope filters and user enablement suppression
  -> capability loader dedupes by server name and equivalent connection (higher priority wins)
  -> MCPManager connects/listTools (with auth/header/env resolution)
  -> manager best-effort loads resources/prompts and subscribes to resource updates when enabled
  -> MCPTool/DeferredMCPTool bridge exposes tools as mcp__<server>_<tool>
  -> AgentSession.refreshMCPTools replaces live MCP tools immediately
```

## 1) Server config model and validation

`src/mcp/types.ts` defines the authoring shape used by MCP config writers and runtime:

- `stdio` (writer default when `type` missing): requires `command`, optional `args`, `env`, `cwd`
- `http`: requires `url`, optional `headers`
- `sse`: requires `url`, optional `headers` (legacy HTTP+SSE transport)
- shared fields: `enabled`, `timeout`, `requestIdFormat` (`"number"` or `"string"`), `instructions` (`boolean`, default `true`), `auth`, `oauth`

`timeout` is in milliseconds, defaults to 30,000, and accepts `0` to disable
client-side timeouts. A valid `OMP_MCP_TIMEOUT_MS` environment value overrides
the per-server timeout. `requestIdFormat` and `instructions` are OMP-specific;
native configs, standalone MCP JSON, and OMP plugins parse them, while foreign
tool-format providers generally do not.

`validateServerConfig()` (`src/mcp/config.ts`) enforces transport basics:

- rejects configs that set both `command` and `url`
- requires `command` for stdio
- requires `url` for http/sse
- rejects unknown `type`

`config-writer.ts` applies this validation for add/update operations and also validates server names:

- non-empty
- max 100 chars
- groups of `[a-zA-Z0-9_.:-]` separated by single spaces; no leading/trailing or repeated spaces (for example `cloudflare:cloudflare-api` or `MaaS Slack`)

Connected servers' initialization instructions are appended to the system prompt
under `MCP Server Instructions`, with a server-controlled/unverified notice.
Each server's text is capped at 4,000 characters. Set `instructions: false` to
exclude that server's instruction block; this does not disable its tools.

### Transport pitfalls

- Writer validation treats an omitted `type` as stdio, so add/update requires `command`. Capability discovery instead infers an omitted transport from the endpoint (`command` → stdio, otherwise `url` → http). Use an explicit `type` to avoid this distinction.
- `sse` selects the legacy protocol-revision 2024-11-05 HTTP+SSE transport: a persistent GET stream supplies an `endpoint` event whose URL receives JSON-RPC POSTs. It is distinct from the `"http"` Streamable HTTP transport.
- Outbound JSON-RPC request IDs default to incrementing numbers for ecosystem compatibility. Set `requestIdFormat: "string"` only for a server that requires the older snowflake-string behavior; invalid values are warned about and ignored during discovery.
- Validation is structural, not reachability: a syntactically valid URL can still fail at connect time.

## 2) Discovery, normalization, and precedence

### Capability-based discovery

`loadAllMCPConfigs()` (`src/mcp/config.ts`) loads canonical `MCPServer` items via `loadCapability(mcpCapability.id)`.

The capability layer (`src/capability/index.ts`) then:

1. invokes enabled providers concurrently, then aggregates in priority order
2. dedupes by `server.name` and semantic connection equivalence (first win = highest priority)
3. validates surviving items

Duplicate names are not merged. Differently named definitions can also be
shadowed when `isSameMCPConnection()` finds matching transport inputs: auth,
OAuth, effective request-ID format, and either stdio command/args/env/literal
keys/cwd or remote URL/headers. Name, timeout, and instruction settings do not
distinguish equivalent connections.

Suppressed servers still claim their name, so a disabled higher-priority
definition cannot fall back to a same-named lower-priority server. They do not
shadow differently named equivalent connections. Disabling project config
drops project entries before deduplication.

### `.mcp.json` and related files

The dedicated fallback provider in `src/discovery/mcp-json.ts` reads project-root `mcp.json` and `.mcp.json` (low priority).

In practice MCP servers also come from higher-priority providers (for example native `.omp/...` and tool-specific config dirs). Authoring guidance:

- Prefer `.omp/mcp.json` (project) or `<getAgentDir()>/mcp.json` (user, default `~/.omp/agent/mcp.json`) for explicit control. Native user MCP config follows the active profile.
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

The standalone fallback provider in `src/discovery/mcp-json.ts` reads project-root `mcp.json` and `.mcp.json`, expands the same `${...}` placeholders in endpoint/auth fields, and type-checks `enabled`/`timeout` without coercing string values. Both providers require a finite, non-negative timeout and validate `requestIdFormat` and boolean `instructions`.

Invalid `enabled`/`timeout` values are ignored with warnings rather than failing the whole file.

## 3) Auth and runtime value resolution

`MCPManager.prepareConfig()`/`#resolveAuthConfig()` (`src/mcp/manager.ts`) is the final pre-connect pass.

### OAuth credential injection

For `http`/`sse` servers, an `auth: { type: "oauth", credentialId: "..." }`
block is optional. An explicit `auth.type: "apikey"` disables OAuth credential
lookup. OMP honors an explicit arbitrary or legacy OAuth credential ID when
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

Before connect, manager normally resolves stdio `env` values and HTTP/SSE `headers` values via `resolveConfigValue()` (`src/config/resolve-config-value.ts`):

- value starting with `!` => execute a shell command with a 10-second timeout, use trimmed stdout; successful output is cached, concurrent requests share one execution, and a failed run is retried on the next resolution
- a failed, timed-out, or whitespace-only run falls back to the command's previous output; a command that has never succeeded produces `undefined`, so that entry is omitted
- otherwise, use a non-empty exact-name environment value, falling back to the literal value; empty resolved entries are omitted

Plugin-origin policy markers change this behavior: `envPolicy: "literal"` keeps
all env values verbatim, and `envLiteralKeys` preserves specified keys (including
empty values). `headerPolicy: "origin-locked"` keeps configured headers literal
and limits them to the configured URL's origin; client-generated headers win
case-insensitively. Discovery supplies these markers for applicable package
formats, rather than applying ordinary secret-command resolution to package data.

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
- non-`[a-z0-9_]` chars become `_`
- repeated underscores collapse and leading/trailing underscores are trimmed
- parts that sanitize to nothing become `server` or `tool`
- redundant `<server>_` prefix in tool name is stripped once
- names longer than 64 characters keep a readable prefix and append `_` plus the first eight base-36
  characters of `Bun.hash()` over the full uncapped generated name

Different raw names can still sanitize to the same identifier (for example
`my-server` and `my.server` both sanitize similarly). Before registry
insertion, `deduplicateMCPToolsByName()` chooses one deterministic winner by
lexicographically comparing the original `<server-name>\0<tool-name>` origin
key. The losing origin is logged and omitted, so reconnect or discovery order
cannot change ownership.

Before digits were kept, digit-bearing servers minted digit-stripped names
(`context7` → `mcp__context_query_docs`). User `tools.approval` `deny`/`prompt`
policies keyed on such a legacy name still apply to the renamed tool
(fail-closed); legacy `allow` entries are not inherited and must be re-keyed.

### Schema mapping

`tool-bridge.ts` passes each MCP `inputSchema` through `normalizeSchemaForMCP()` before registering it as a `CustomTool` schema. MCP tools declare `strict: false` and approval tier `"write"`; this disables provider strict-output grammar, not the shared runtime argument validator.

Before dispatch, shared tool-argument validation prefers an already matching
`anyOf`/`oneOf` branch when normalizing null placeholders. Required nullable
properties in that branch retain explicit `null` values; a nonmatching closed
branch cannot remove them as unknown fields. Null cleanup/default substitution
can combine with discriminator whitespace repair and schema-directed type
coercion using the bounded repair pipeline inside a branch-local candidate.
If no branch accepts that candidate, its repairs are discarded. The complete
schema is still validated, including required fields, non-nullable properties,
and `oneOf` exclusivity.
Branch validation retains the complete schema's local-reference context,
speculative-union restrictions on lossy repairs, and content-ancestor protection
against identifier whitespace trimming.
Bounded repair rounds reconsider null cleanup when a later normalization,
such as identifier whitespace trimming, makes a branch viable; an invalid
candidate is never carried forward solely because it changed.

### Outbound argument normalization

Before either live or deferred tools send `tools/call`, the bridge normalizes
the call's arguments in this order:

1. Non-object values, `null`, and arrays at the top level become an empty
   argument object.
2. The harness-injected intent field `i` is removed unless the MCP tool's own
   schema declares or constrains it (including declarations reached through
   schema combiners or local references).
3. For a property declared by the MCP schema but not listed in `required`, a
   value of `undefined`, an empty string, or an empty non-array object is
   omitted. Required properties, undeclared properties, `0`, `false`, `null`,
   and arrays (including empty arrays) are preserved.
4. String values are walked recursively through nested objects and arrays.
   Registered file-backed internal URLs (not only `local://`) are passed
   through `InternalUrlRouter.locate()` and become backing filesystem paths
   when available. Read selectors are peeled before locating. A locator that
   returns `null` leaves the original string; a locator error aborts
   normalization before `tools/call`. For `local://`, existing directories and
   the session root also resolve to paths, missing targets remain unchanged,
   and invalid/escaping paths or absent session context throw.

Server authors should therefore validate against the normalized payload, not
assume that every field present in the model-generated call reaches the server.

### Execution mapping

`MCPTool.execute()` / `DeferredMCPTool.execute()`:

- calls MCP `tools/call`
- combines text/resource content while preserving image blocks
- returns details including `serverName`, `mcpToolName`, raw content, MCP `_meta`, and provider metadata
- preserves `structuredContent` in details and adds a fenced JSON text block unless an existing text block already contains the same JSON value
- maps server-reported `isError` to an `Error:` prefix and `isError: true`
- handles an `isError` result with `_meta["mcp/www_authenticate"]` by reconnecting with the auth challenge and retrying once when a reconnect callback exists
- attempts reconnect + one retry for retriable connection errors; deferred tools can also reconnect after initial connection lookup fails
- formats caught transport/runtime failures as `MCP failure` with server/tool, transport, stage, failure, retryability, message, and next-step fields
- preserves abort semantics by translating AbortError into `ToolAbortError`

## 5) Operator lifecycle: add/edit/remove and live updates

Interactive mode exposes `/mcp` in `src/modes/controllers/mcp-command-controller.ts`.

Supported operations:

- `list`
- `add` (wizard or quick-add)
- `remove` / `rm`
- `enable` / `disable`
- `test`
- `reauth` / `unauth`
- `reconnect`
- `reload`
- `resources`, `prompts`, `notifications`
- Smithery search/login/logout flows

Config writes are atomic (`writeMCPConfigFile`: unique temp file + rename), and
read-modify-write operations hold a per-file lock.

Full reloads use `MCPCommandController.reloadServers()`:

1. `mcpManager.disconnectAll()`
2. clear MCP prompt commands and capability filesystem caches
3. `mcpManager.discoverAndConnect()` with current project/browser filters and session extension roots
4. `session.refreshMCPTools(mcpManager.getTools())`

Some mutations reconnect or disconnect only the affected server and then refresh
tools. `refreshMCPTools()` serializes registry mutations, reconciles
manager-owned and extension-owned MCP tools, and enables connected manager
tools immediately (mounted under `xd://` when applicable). Extension-owned MCP
tools retain their prior selection. Changes take effect without restarting.

### Mode differences

- **Interactive/TUI mode**: `/mcp` gives in-app UX (wizard, OAuth flow, connection status text, immediate runtime rebinding).
- **SDK/headless integration**: `discoverAndLoadMCPTools()` (`src/mcp/loader.ts`) returns the manager, loaded tools, per-server errors, connected server names, and extracted Exa keys; no `/mcp` command UX. Cached definitions may be returned as deferred tools while connections continue in the background.

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
- [`src/mcp/errors.ts`](../packages/coding-agent/src/mcp/errors.ts)
- [`src/mcp/timeout.ts`](../packages/coding-agent/src/mcp/timeout.ts)
- [`src/mcp/oauth-credentials.ts`](../packages/coding-agent/src/mcp/oauth-credentials.ts)
- [`src/session/session-tools.ts`](../packages/coding-agent/src/session/session-tools.ts)
- [`shared argument validation`](../packages/ai/src/utils/validation.ts)
