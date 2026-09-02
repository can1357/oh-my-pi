---
title: MCP Servers
description: Configure Model Context Protocol servers and the tools they expose.
coverage: B
---

MCP (Model Context Protocol) servers let omp call external tools over JSON-RPC. Each server contributes a set of tools the model can invoke; the runtime exposes them with names of the form `mcp__<server>_<tool>`. omp discovers server configs from several sources, then connects, lists tools, and replaces the live tool set on `/mcp reload` without restarting the session.

## Configure servers

Add a `$schema` reference at the top of the file for editor autocomplete and validation. omp writes this line automatically when `/mcp add`, `/mcp enable`, `/mcp disable`, `/mcp reauth`, or other config-writing flows create or update a managed MCP file.

```json
{
  "$schema": "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json",
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/server-filesystem",
        "/Users/alice/projects",
        "/Users/alice/Documents"
      ]
    }
  },
  "disabledServers": ["other-server"]
}
```

Top-level keys:

| Key | Purpose |
| --- | --- |
| `$schema` | Optional JSON Schema URL for editor tooling |
| `mcpServers` | Map of server name to server config |
| `disabledServers` | User-level denylist — disables discovered servers by name; runtime loading reads this list from the active profile's user MCP file |

Server names must match `^[a-zA-Z0-9_.-]{1,100}$`. Server-name validation in the config writer additionally accepts the colon (`:`) character so plugin server names like `cloudflare:cloudflare-api` are allowed.

### Where the file lives

Prefer the OMP-native paths so omp owns the configuration:

| Scope | Path |
| --- | --- |
| Project | `.omp/mcp.json` |
| User (default profile) | `~/.omp/agent/mcp.json` |
| User (named profile) | `~/.omp/profiles/<name>/agent/mcp.json` |

omp also accepts the project-root fallbacks `mcp.json` and `.mcp.json` for portable configs that other MCP clients also read.

Named profiles (`omp --profile <name>`, `--alias`, or `OMP_PROFILE`/`PI_PROFILE`) isolate user-level MCP config: when a profile is active, the user scope resolves to that profile's agent directory instead of `~/.omp/agent/mcp.json`. Project-scoped `.omp/mcp.json` is keyed to the working directory and applies under every profile. Discovery, the `/mcp` commands, and the config writer all follow the active profile.

## Transports

Three transports are supported. If `type` is omitted the server is treated as `stdio`.

| Transport | Required | Optional | Notes |
| --- | --- | --- | --- |
| `stdio` (default) | `command: string` | `args`, `env`, `cwd`, `type` | Newline-delimited JSON over subprocess stdio |
| `http` | `type: "http"`, `url: string` | `headers` | Streamable HTTP JSON-RPC; preferred for new servers |
| `sse` | `type: "sse"`, `url: string` | `headers` | Legacy HTTP+SSE (protocol revision 2024-11-05); accepted for compatibility |

Shared fields for every transport:

| Field | Default | Purpose |
| --- | --- | --- |
| `enabled` | `true` | Set `false` to skip this server entirely |
| `timeout` | `30000` | MCP request timeout in milliseconds; `0` disables client-side timeouts |
| `auth` | — | Auth metadata (`type`, `credentialId`, `tokenUrl`, `clientId`, `clientSecret`, `resource`) for OAuth/API-key flows |
| `oauth` | — | Explicit OAuth client settings (`clientId`, `clientSecret`, `redirectUri`, `callbackPort`, `callbackPath`, `prompt`) |

Validation is structural — a syntactically valid URL can still fail to connect at runtime, and configs that set both `command` and `url` are rejected.

Set `OMP_MCP_TIMEOUT_MS=0` to disable the client-side timeout for every MCP server in the current process. Set it to a positive millisecond value, such as `OMP_MCP_TIMEOUT_MS=120000`, to apply one global timeout without editing each server entry.

### `auth` and OAuth

The `auth` block tells omp how to rehydrate credentials for a server. When omp completes an OAuth flow for an `http`/`sse` server it stores the credential under a deterministic id derived from the active profile and server URL (`mcp_oauth:profile:<profile>:<url>`), with the refresh material embedded. Any config that points at the same URL — including a *definition-only* entry in a shared project `mcp.json` with no `auth` block — resolves the active profile's own credential automatically. `/mcp reauth` on a definition-only entry leaves the file untouched.

The binding is per profile but not per project: once a profile has authorized a URL, any checkout whose `mcp.json` defines a server at that URL connects with that profile's credential. Committed MCP definitions are trusted input — the same already applies to `stdio` entries, which run arbitrary commands — so review a repository's `mcp.json` before opening it with a profile that holds credentials you care about.

The `oauth.prompt` field controls the OAuth `prompt` parameter sent with the authorization request. It defaults to `"consent"` so the provider always shows its consent/account screen — without it, a provider with an active browser session silently re-approves the same account, making it impossible to switch accounts or workspaces when reauthorizing. Set it to `""` to omit the parameter for providers that reject it, or to another value the provider understands (e.g. `"select_account"`).

## Tool naming

Once connected, each server tool is registered with a sanitized name:

```text
mcp__<sanitized_server_name>_<sanitized_tool_name>
```

Sanitization rules:

- The name is lowercased.
- Non-`[a-z_]` characters become `_`.
- Repeated underscores collapse.
- A redundant `<server>_` prefix in the tool name is stripped once.

Different raw names can still sanitize to the same identifier (for example `my-server` and `my.server` both sanitize similarly). Prefer names that remain distinct after sanitization to avoid generated `mcp__` collisions; the tool registry is last-write-wins.

## Runtime lifecycle

Startup runs in parallel for every discovered server:

1. **Discovery** resolves configs from capability sources, filters disabled/project/Exa entries and browser MCP servers when `browser.enabled` is on, and preserves source metadata.
2. **Connect** spawns the transport, runs the MCP `initialize` handshake, and sends `notifications/initialized`.
3. **`tools/list`** fetches each server's tool definitions.
4. **Fast startup gate** races everything against a 250ms timeout:
   - Connected servers become live `MCPTool`s.
   - Still-pending servers return cached `DeferredMCPTool`s if available.
   - Otherwise the manager continues in the background and registers tools via `session.refreshMCPTools(...)` when ready.

Per-server connect/list failures are isolated — one failing server does not stop the others. Discovery-level exceptions degrade to an empty tool set plus a synthetic error; they do not abort session startup.

### Live reload and reconnect

`/mcp reload` in interactive mode does, atomically from the user's perspective:

1. `mcpManager.disconnectAll()`
2. `mcpManager.discoverAndConnect()`
3. `session.refreshMCPTools(mcpManager.getTools())`

`refreshMCPTools()` removes every `mcp__` tool from the registry, re-wraps the latest MCP tool set, and immediately re-activates it. Changes take effect without restarting the session.

When a managed transport closes unexpectedly the manager reconnects with backoff `500, 1000, 2000, 4000` ms, reloads tools, and notifies consumers on success. A crash-storm circuit breaker suspends automatic reconnects for a server after more than 5 attempts within 30 seconds; `/mcp reconnect <name>` resets that history. Tool calls that see retriable connection errors attempt one reconnect + retry themselves.

### `/mcp` operator commands

Interactive mode exposes the full management UX in `modes/controllers/mcp-command-controller.ts`:

- `add` — wizard or quick-add
- `remove` / `rm`
- `enable` / `disable`
- `test`
- `reauth` / `unauth`
- `reconnect`
- `reload`
- `resources`, `prompts`, `notifications`
- Smithery search/login/logout flows

Config writes are atomic (temp file + rename). After every write the controller runs the `#reloadMCP()` flow above.

## Authoring pointers

- Keep server names globally unique across every MCP-capable config source. Reusing a name in multiple sources causes precedence shadowing, not merging — the highest-priority definition wins and lower-priority duplicates are dropped.
- Prefer names that remain distinct after MCP tool-name sanitization to avoid generated `mcp__` collisions.
- Use explicit `type` so an omitted `type` does not silently turn an HTTP server into stdio (which then requires `command`).
- Treat `enabled: false` as hard-off: the server is omitted from the runtime connect set.
- For OAuth configs, store a valid `credentialId`; otherwise auth injection is skipped with a warning.
- For shell-based secret resolution (`!cmd` headers/env), verify command output is stable and non-empty — a mistyped `!` silently removes that header/env entry and produces downstream 401/403 or startup failures.

## Sharp edges

- **Stdio is the implicit default.** Omitting `type` makes `command` mandatory; if you intended HTTP, the server will fail to start.
- **Validation is structural.** A syntactically valid URL can still fail at connect time, and there is no reachability check at config-load.
- **Mistyped `!cmd` is silent.** Header/env values starting with `!` are resolved by running a shell command and using trimmed stdout; failures, timeouts, and whitespace-only output all produce `undefined` and that entry is omitted.
- **Discovery-order shadowing.** A project-level server with the same name as a user-level one wins regardless of where the server was added.
- **Disabled lists live in the user file only.** `disabledServers` is read from the active profile's user MCP file, not from project configs.
