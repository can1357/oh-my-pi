# MCP configuration in OMP

This guide explains how to add, edit, and validate MCP servers for the OMP coding agent.

Source of truth in code:

- Runtime config types: `packages/coding-agent/src/mcp/types.ts`
- Config writer: `packages/coding-agent/src/mcp/config-writer.ts`
- Loader + validation: `packages/coding-agent/src/mcp/config.ts`
- Standalone `mcp.json` discovery: `packages/coding-agent/src/discovery/mcp-json.ts`
- Schema: `packages/coding-agent/src/config/mcp-schema.json`

## Preferred config locations

OMP can discover MCP servers from multiple tools (`.claude/`, `.cursor/`, `.vscode/`, `opencode.json`, and more), but for OMP-native configuration you should usually use one of these primary files:

- Project: `.ompk/mcp.json`
- User: `~/.ompk/agent/mcp.json` (or `~/.ompk/profiles/<name>/agent/mcp.json` when a named profile is active — see [Profiles](#profiles))

The native provider also reads `.ompk/.mcp.json` and `~/.ompk/agent/.mcp.json` for compatibility, but OMP writes to the primary `mcp.json` paths above.

OMP also accepts fallback standalone files in the project root:

- `mcp.json`
- `.mcp.json`

Use `.ompk/mcp.json` or `~/.ompk/agent/mcp.json` when you want OMP to own the configuration. Use root `mcp.json` / `.mcp.json` only when you want a portable fallback file that other MCP clients may also read.

### Profiles

Named profiles (`oh-my-pk --profile <name>`, the `--alias` shortcut, or `OMP_PROFILE`/`PI_PROFILE`) isolate user-level MCP config. When a profile is active, the **user** scope resolves to the profile's agent directory instead of the default one:

- Default profile: `~/.ompk/agent/mcp.json`
- Profile `<name>`: `~/.ompk/profiles/<name>/agent/mcp.json`

Discovery, the `/mcp` commands, and the config writer all follow the active profile, so a profile sees **only** its own user-level servers — never the default profile's `~/.ompk/agent/mcp.json`. Add a server to a profile by launching under it (`oh-my-pk --profile <name>`) and running `/mcp add` → User level, or by editing `~/.ompk/profiles/<name>/agent/mcp.json` directly.

Project-scoped MCP config (`.ompk/mcp.json`) is keyed to the working directory, not the profile, so it applies under every profile. External-tool configs (`.claude/`, `.cursor/`, etc.) are also profile-independent because they belong to those tools rather than to an OMP profile.

MCP follows the same profile rules as the rest of OMP-native config; see [Configuration Discovery → Profiles](./config-usage.md#profiles).

## Add a schema reference

Add this line at the top of the file for editor autocomplete and validation:

```json
{
  "$schema": "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json",
  "mcpServers": {}
}
```

OMP now writes this automatically when `/mcp add`, `/mcp enable`, `/mcp disable`, `/mcp reauth`, or other config-writing flows create or update an OMP-managed MCP file.

## File shape

OMP supports this top-level structure:

```json
{
  "$schema": "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json",
  "mcpServers": {
    "server-name": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "some-mcp-server"]
    }
  },
  "disabledServers": ["server-name"]
}
```

Top-level keys:

- `$schema` — optional JSON Schema URL for tooling
- `mcpServers` — map of server name to server config
- `disabledServers` — user-level denylist used to turn off discovered servers by name; runtime loading reads this list from the active profile's user MCP file (`~/.ompk/agent/mcp.json`, or `~/.ompk/profiles/<name>/agent/mcp.json` under a named profile)

Server names must match `^[a-zA-Z0-9_.-]{1,100}$`.

## Supported server fields

Shared fields for every transport:

- `enabled?: boolean` — skip this server when `false`
- `timeout?: number` — MCP request timeout in milliseconds; `0` disables client-side MCP timeouts
- `auth?: { ... }` — auth metadata used by OMP for OAuth/API-key flows
- `oauth?: { ... }` — explicit OAuth client settings used during auth/reauth

Set `OMP_MCP_TIMEOUT_MS=0` to disable the client-side timeout for every MCP server in the current process. Set it to a positive millisecond value, such as `OMP_MCP_TIMEOUT_MS=120000`, to apply one global timeout without editing each server entry.

### `stdio` transport

`stdio` is the default when `type` is omitted.

Required:

- `command: string`

Optional:

- `type?: "stdio"`
- `args?: string[]`
- `env?: Record<string, string>`
- `cwd?: string`

Example:

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
  }
}
```

This follows the official Filesystem MCP server package (`@modelcontextprotocol/server-filesystem`).

### `http` transport

Required:

- `type: "http"`
- `url: string`

Optional:

- `headers?: Record<string, string>`

Example:

```json
{
  "$schema": "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json",
  "mcpServers": {
    "github": {
      "type": "http",
      "url": "https://api.githubcopilot.com/mcp/"
    }
  }
}
```

This matches GitHub's hosted GitHub MCP server endpoint.

### `sse` transport

Required:

- `type: "sse"`
- `url: string`

Optional:

- `headers?: Record<string, string>`

Example:

```json
{
  "$schema": "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json",
  "mcpServers": {
    "legacy-remote": {
      "type": "sse",
      "url": "https://example.com/mcp/sse"
    }
  }
}
```

`sse` is still supported for compatibility, but the MCP spec now prefers Streamable HTTP (`type: "http"`) for new servers.

## Auth fields

OMP understands two auth-related objects.

### `auth`

```json
{
  "type": "oauth" | "apikey",
  "credentialId": "optional-stored-credential-id",
  "tokenUrl": "optional-token-endpoint",
  "clientId": "optional-client-id",
  "clientSecret": "optional-client-secret",
  "resource": "optional-mcp-resource-uri"
}
```

Use this when OMP should remember how to rehydrate credentials for a server.

You normally do not need to write this block: when OMP completes an OAuth flow
for an `http`/`sse` server it stores the credential under a deterministic id
derived from the active profile and server URL
(`mcp_oauth:profile:<profile>:<url>`), with the refresh material embedded. Any
config that points at the same URL — including a *definition-only* entry in a
shared project `mcp.json` with no `auth` block at all — resolves the active
profile's own credential automatically, including when auth storage is backed by
a shared auth broker. This is what makes project-scoped servers safe across
profiles: commit the definition, and each profile authorizes (and stays signed
in as) its own account via `/mcp reauth <name>`. An explicit `credentialId` is
still honored when it resolves; if it points at another profile's row, OMP falls
back to the profile-scoped url-keyed binding.

`/mcp reauth` on a definition-only entry leaves the file untouched — the
credential (refresh material included) lives entirely in the active profile's
auth storage (local `agent.db` or broker), so a committed project config never
picks up local auth state. An explicitly
configured `Authorization` header always wins over the url-keyed binding.

The binding is per profile but not per project: once a profile has authorized
a URL, *any* checkout whose `mcp.json` defines a server at that URL connects
with that profile's credential automatically. Committed MCP definitions are
trusted input — the same already applies to `stdio` entries, which run
arbitrary commands — so review a repository's `mcp.json` before opening it
with a profile that holds credentials you care about, or use a dedicated
profile for untrusted checkouts.

### `oauth`

```json
{
  "clientId": "...",
  "clientSecret": "...",
  "redirectUri": "...",
  "callbackPort": 3334,
  "callbackPath": "/oauth/callback",
  "prompt": "consent"
}
```

Use this when the MCP server requires explicit OAuth client settings.

`prompt` controls the OAuth `prompt` parameter sent with the authorization request. It defaults to `"consent"` so the provider always shows its consent/account screen — without it, a provider with an active browser session silently re-approves the same account, making it impossible to switch accounts or workspaces when reauthorizing (e.g. to use a different Linear workspace per OMP profile). Set it to `""` to omit the parameter for providers that reject it, or to another value the provider understands (e.g. `"select_account"`).

Slack is the clearest current example. Slack's MCP server is hosted at `https://mcp.slack.com/mcp`, uses Streamable HTTP, and requires confidential OAuth with your Slack app's client credentials.

Example:

```json
{
  "$schema": "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json",
  "mcpServers": {
    "slack": {
      "type": "http",
      "url": "https://mcp.slack.com/mcp",
      "oauth": {
        "clientId": "YOUR_SLACK_CLIENT_ID",
        "clientSecret": "YOUR_SLACK_CLIENT_SECRET"
      },
      "auth": {
        "type": "oauth",
        "tokenUrl": "https://slack.com/api/oauth.v2.user.access",
        "clientId": "YOUR_SLACK_CLIENT_ID",
        "clientSecret": "YOUR_SLACK_CLIENT_SECRET"
      }
    }
  }
}
```

Relevant Slack endpoints from Slack's docs:

- MCP endpoint: `https://mcp.slack.com/mcp`
- Authorization endpoint: `https://slack.com/oauth/v2_user/authorize`
- Token endpoint: `https://slack.com/api/oauth.v2.user.access`

## Common copy-paste examples

### Filesystem server via stdio

```json
{
  "$schema": "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json",
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/server-filesystem",
        "/absolute/path/one",
        "/absolute/path/two"
      ]
    }
  }
}
```

### GitHub hosted server via HTTP

```json
{
  "$schema": "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json",
  "mcpServers": {
    "github": {
      "type": "http",
      "url": "https://api.githubcopilot.com/mcp/"
    }
  }
}
```

### GitHub local server via Docker

```json
{
  "$schema": "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json",
  "mcpServers": {
    "github": {
      "command": "docker",
      "args": [
        "run",
        "-i",
        "--rm",
        "-e",
        "GITHUB_PERSONAL_ACCESS_TOKEN",
        "ghcr.io/github/github-mcp-server"
      ],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "GITHUB_PERSONAL_ACCESS_TOKEN"
      }
    }
  }
}
```

This matches GitHub's official local Docker image `ghcr.io/github/github-mcp-server`.

### Slack hosted server via OAuth

```json
{
  "$schema": "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json",
  "mcpServers": {
    "slack": {
      "type": "http",
      "url": "https://mcp.slack.com/mcp",
      "oauth": {
        "clientId": "YOUR_SLACK_CLIENT_ID",
        "clientSecret": "YOUR_SLACK_CLIENT_SECRET"
      },
      "auth": {
        "type": "oauth",
        "tokenUrl": "https://slack.com/api/oauth.v2.user.access",
        "clientId": "YOUR_SLACK_CLIENT_ID",
        "clientSecret": "YOUR_SLACK_CLIENT_SECRET"
      }
    }
  }
}
```

## Secrets and variable resolution

This is the part that usually trips people up.

### Discovery-time `${...}` expansion

OMP expands `${VAR}` and `${VAR:-default}` placeholders while discovering MCP configs from OMP-native files and standalone fallback files. Expansion applies recursively to string values in `command`, `args`, `env`, `cwd`, `url`, `headers`, `auth`, and `oauth`; unresolved placeholders remain literal strings.

Example:

```json
{
  "mcpServers": {
    "github": {
      "type": "http",
      "url": "https://api.githubcopilot.com/mcp/",
      "headers": {
        "Authorization": "Bearer ${GITHUB_TOKEN}"
      }
    }
  }
}
```

### Pre-connect env/header resolution

Before OMP launches a stdio server or makes an HTTP/SSE request, it resolves stdio `env` values and HTTP/SSE `headers` values like this:

1. If a value starts with `!`, OMP runs the rest as a shell command with a 10s timeout and uses trimmed stdout.
2. If the command fails, times out, or prints only whitespace, that `env`/`headers` entry is omitted.
3. Otherwise OMP checks whether the value names an environment variable.
4. If that environment variable is set to a non-empty value, OMP uses the environment value; otherwise it uses the string literally.

Examples:

```json
{
  "env": {
    "GITHUB_PERSONAL_ACCESS_TOKEN": "GITHUB_PERSONAL_ACCESS_TOKEN"
  },
  "headers": {
    "X-MCP-Insiders": "true"
  }
}
```

That means this is valid and convenient for local secrets:

- `"GITHUB_PERSONAL_ACCESS_TOKEN": "GITHUB_PERSONAL_ACCESS_TOKEN"` → copy from the current shell environment
- `"Authorization": "Bearer hardcoded-token"` → use the literal value
- `"Authorization": "!printf 'Bearer %s' \"$GITHUB_TOKEN\""` → build the header from a command

## `disabledServers`

`disabledServers` is read from the user config file (`~/.ompk/agent/mcp.json`) when a server is discovered from any source and you want OMP to ignore it without editing that other tool's config.

Example:

```json
{
  "$schema": "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json",
  "disabledServers": ["github", "slack"]
}
```

## `/mcp add` vs editing JSON directly

Use `/mcp add` when you want guided setup.

Use direct JSON editing when:

- you need a transport or auth option the wizard does not prompt for yet
- you want to paste a server definition from another MCP client
- you want schema-backed validation in your editor

After editing, use:

- `/mcp reload` to rediscover and reconnect servers in the current session
- `/mcp list` to see which config file a server came from
- `/mcp test <name>` to test a single server
- `/mcp reconnect <name>` to reconnect one server without rediscovering all configs
- `/mcp resources`, `/mcp prompts`, and `/mcp notifications` to inspect non-tool MCP capabilities

## Validation rules OMP enforces

From `validateServerConfig()` in `packages/coding-agent/src/mcp/config.ts`:

- `stdio` requires `command`
- `http` and `sse` require `url`
- a server cannot set both `command` and `url`
- unknown `type` values are rejected

Practical implications:

- Omitting `type` means `stdio`
- If you paste a remote server config and forget `"type": "http"`, OMP will treat it as `stdio` and complain that `command` is missing
- `sse` remains valid for compatibility, but new hosted servers should usually be configured as `http`

## Discovery and precedence

OMP does not merge duplicate server definitions across files. Discovery providers are prioritized, and the higher-priority definition wins. Separately, `disabledServers` from `~/.ompk/agent/mcp.json` can suppress a discovered server by name.

In practice:

- prefer `.ompk/mcp.json` or `~/.ompk/agent/mcp.json` when you want an OMP-specific override
- keep server names unique across tools when possible
- use `disabledServers` in the user config when a third-party config keeps reintroducing a server you do not want

## Troubleshooting

### `Server "name": stdio server requires "command" field`

You probably omitted `type: "http"` on a remote server.

### `Server "name": both "command" and "url" are set`

Pick one transport. OMP treats `command` as stdio and `url` as http/sse.

### `/mcp add` worked but the server still does not connect

The JSON is valid, but the server may still be unreachable. Use `/mcp test <name>` and check whether:

- the binary or Docker image exists
- required environment variables are set
- the remote URL is reachable
- the OAuth or API token is valid

### The server exists in another tool's config but not in OMP

Run `/mcp list`. OMP discovers many third-party MCP files, but project-level loading can also be disabled via the `mcp.enableProjectConfig` setting, and a user-level `disabledServers` entry can suppress a server by name.

## References

- MCP transport spec: https://modelcontextprotocol.io/specification/2025-03-26/basic/transports
- Filesystem server package: https://www.npmjs.com/package/@modelcontextprotocol/server-filesystem
- GitHub MCP server: https://github.com/github/github-mcp-server
- Slack MCP server docs: https://docs.slack.dev/ai/slack-mcp-server/
