# MCP configuration in OMP

This guide explains how to add, edit, and validate MCP servers for the OMP coding agent.

Source of truth in code:

- Runtime config types: `packages/coding-agent/src/mcp/types.ts`
- Config writer: `packages/coding-agent/src/mcp/config-writer.ts`
- Loader + validation: `packages/coding-agent/src/mcp/config.ts`
- Standalone `mcp.json` discovery: `packages/coding-agent/src/discovery/mcp-json.ts`
- Schema: `packages/coding-agent/src/config/mcp-schema.json`
- Managed credential lookup: `packages/coding-agent/src/mcp/oauth-credentials.ts`
- Portable plugin MCP discovery: `packages/coding-agent/src/discovery/agent-plugins.ts`

## Preferred config locations

OMP can discover MCP servers from multiple tools (`.claude/`, `.cursor/`, `.vscode/`, `opencode.json`, and more), but for OMP-native configuration you should usually use one of these primary files:

- Project: `.omp/mcp.json`
- User: `~/.omp/agent/mcp.json` (or `~/.omp/profiles/<name>/agent/mcp.json` when a named profile is active — see [Profiles](#profiles))

The native provider also reads `.omp/.mcp.json` and `~/.omp/agent/.mcp.json` for compatibility, but OMP writes to the primary `mcp.json` paths above.

These user paths are defaults: `PI_CONFIG_DIR` changes the home config root, and `PI_CODING_AGENT_DIR` can override the default-profile agent directory. Named profiles derive their own agent directory rather than inheriting that override. Project config remains in `.omp/`.

OMP also accepts fallback standalone files in the project root:

- `mcp.json`
- `.mcp.json`

Use `.omp/mcp.json` or `~/.omp/agent/mcp.json` when you want OMP to own the configuration. Use root `mcp.json` / `.mcp.json` only when you want a portable fallback file that other MCP clients may also read.

### Imported tool configs

OMP also translates these current tool-native sources:

- Claude Code: `~/.claude.json`, `~/.claude/mcp.json`, and project `.claude/.mcp.json` / `.claude/mcp.json`
- Codex: `~/.codex/config.toml` and `.codex/config.toml` (`[mcp_servers.*]`)
- Gemini CLI: `~/.gemini/settings.json` and `.gemini/settings.json`
- OpenCode: `opencode.json` / `opencode.jsonc` in `~/.config/opencode/`, the project root, and project `.opencode/` (the `mcp` map)
- Cursor: `~/.cursor/mcp.json` and `.cursor/mcp.json`
- Windsurf: `~/.codeium/windsurf/mcp_config.json` and `.windsurf/mcp_config.json`
- VS Code: project-only `.vscode/mcp.json` using `mcp.servers`
- installed Claude marketplace plugins, OMP extension packages, and portable Agent Plugins (`plugin.json` plus root `mcp.json`) that declare MCP servers

For Claude Code, Codex, Gemini CLI, Cursor, and Windsurf, the project entry is encountered before its same-named user entry — matching OMP-native config, whose project entry precedes its active-profile user entry — so a project `enabled: false` suppresses a same-named user server. OpenCode deep-merges each server across layers: project overrides user, `.opencode/` overrides the project root, and `.jsonc` overrides `.json` within a directory. Partial overrides inherit fields from lower layers. Cross-provider priority is listed in [Discovery and precedence](#discovery-and-precedence).

### Profiles

Named profiles (`omp --profile <name>` or `OMP_PROFILE`/`PI_PROFILE`) isolate user-level MCP config. `omp --profile <name> --alias <command>` creates a shell shortcut that selects that profile. When a profile is active, the **user** scope resolves to the profile's agent directory instead of the default one:

- Default profile: `~/.omp/agent/mcp.json`
- Profile `<name>`: `~/.omp/profiles/<name>/agent/mcp.json`

Discovery, the `/mcp` commands, and the config writer all follow the active profile, so a profile sees **only** its own user-level servers — never the default profile's `~/.omp/agent/mcp.json`. Add a server to a profile by launching under it (`omp --profile <name>`) and running `/mcp add` → User level, or by editing `~/.omp/profiles/<name>/agent/mcp.json` directly.

Project-scoped MCP config (`.omp/mcp.json`) is keyed to the working directory, not the profile, so it applies under every profile. External-tool configs (`.claude/`, `.cursor/`, etc.) are also profile-independent because they belong to those tools rather than to an OMP profile.

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
- `disabledServers` — active-profile user denylist; it hides a discovered server by name regardless of the source entry's `enabled` value
- `enabledServers` — active-profile user allowlist; it can force-enable a same-named entry whose source says `enabled: false`, but `disabledServers` still wins

The config writer accepts names up to 100 characters containing letters, numbers, `_`, `-`, `.`, `:`, and single spaces between non-space name segments. The bundled schema omits colons and spaces from its name pattern, so names such as `cloudflare:cloudflare-api` or `MaaS Slack` may be valid at runtime while an editor reports a schema error.

## Supported server fields

Shared fields for every transport:

- `enabled?: boolean` — skip this server when `false`, unless the active-profile user `enabledServers` allowlist names it
- `timeout?: number` — MCP request timeout in milliseconds; `0` disables client-side MCP timeouts
- `requestIdFormat?: "number" | "string"` — outgoing JSON-RPC request-id encoding; defaults to per-transport integers. `"string"` uses collision-resistant snowflake IDs. This OMP-specific field is read only from OMP-native files, root `mcp.json` / `.mcp.json`, and OMP extension packages; configs translated from other tools ignore it.
- `instructions?: boolean` — include server-provided instructions in the system prompt (default: `true`). Set `false` to omit that server's instructions without disabling its tools. Like `requestIdFormat`, this is OMP-specific and is ignored in configs translated from other tools.
- `auth?: { ... }` — stored-credential metadata; managed credential injection is implemented for OAuth
- `oauth?: { ... }` — explicit OAuth client and callback settings used during auth/reauth

Disable instructions when a server's guidance conflicts with your tool policy or adds unwanted context to every request, including subagent requests. If no connected server contributes instructions, the MCP Server Instructions section is omitted entirely. `instructions` does not distinguish connections: when two entries under different names describe the same endpoint, only the higher-priority entry is kept, together with its own `instructions` value, so set the option on the entry that wins (see `/mcp list`). A changed value applies to an already-connected server after `/mcp reload`.

`OMP_MCP_TIMEOUT_MS` has process-wide precedence over every per-server `timeout`. Set it to `0` to disable client-side timeouts, or to a positive millisecond value such as `120000`. If it is unset or invalid, OMP uses the server value and then the 30-second default; invalid values are logged and ignored.

Claude marketplace plugins follow [Claude Code's per-server timeout rule](https://code.claude.com/docs/en/mcp): their `.mcp.json` values are milliseconds, and values below `1000` are ignored with a discovery warning so OMP's normal timeout fallback applies. This restriction does not change OMP-native configurations, where `0` still disables timeouts.

These request deadlines also govern subagent MCP calls over borrowed parent connections. The proxy adds no independent timeout; caller cancellation still stops the subagent's wait.

Initial MCP discovery returns after a 250 ms window while slower connections continue in the background. Set `mcp.startupTimeoutMs` or override it with `OMP_MCP_STARTUP_TIMEOUT_MS` to change the window; `0` waits for the initial connection attempts to settle. In print mode (`-p`, `--mode text|json`), OMP additionally waits for all configured servers to load tools or fail before the first turn, up to `OMP_MCP_TIMEOUT_MS` (default 30 seconds). `OMP_MCP_TIMEOUT_MS=0` disables this barrier deadline too, so an unresponsive server can block print mode indefinitely. Servers still unavailable at the deadline are named on stderr; `OMP_MCP_REQUIRE_READY=1` instead exits with code 1 before the turn. These print-mode waits do not affect interactive, RPC, or ACP startup.

Client-generated remote protocol headers take precedence over configured headers case-insensitively. Streamable HTTP owns `MCP-Protocol-Version`: it ignores configured copies and sends the negotiated version after initialization. Portable Agent Plugins' configured headers are origin-locked and are not forwarded to another origin on redirects.

Remote HTTP and SSE transports do not impose an additional socket-idle timeout. Without an applicable MCP deadline, a silent connection can wait indefinitely; cancel the call or close the transport to stop it. A quiet stream alone does not prove that its peer is still reachable.

### `stdio` transport

Direct runtime configs and the config writer default to `stdio` when `type` is omitted. Discovery infers `http` for a URL-only entry and `stdio` for a command entry; use an explicit `type` for portable, schema-valid configuration.

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
  "type": "oauth",
  "credentialId": "optional-stored-credential-id",
  "tokenUrl": "optional-token-endpoint",
  "clientId": "optional-client-id",
  "clientSecret": "optional-client-secret",
  "resource": "optional-mcp-resource-uri"
}
```

For managed OAuth, `auth` tells OMP how to find and refresh a stored credential. Although `"apikey"` is an accepted `type`, it does not load or inject an API key from auth storage. Put API keys directly in stdio `env` or remote `headers` (prefer an environment-variable or `!command` indirection described below).

You normally do not need to write this block: when OMP completes an OAuth flow for an `http`/`sse` server, it stores the credential under a deterministic id derived from the active profile and server URL (`mcp_oauth:profile:<profile>:<url>`), with the refresh material embedded. Any
config that points at the same URL — including a _definition-only_ entry in a
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
configured `Authorization` header (case-insensitive) disables automatic URL-keyed fallback. An explicitly resolved `auth.credentialId` can still supply managed OAuth and replace that header.

The binding is per profile but not per project: once a profile has authorized
a URL, _any_ checkout whose `mcp.json` defines a server at that URL connects
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
  "scope": "optional space-separated scopes",
  "redirectUri": "...",
  "callbackPort": 3334,
  "callbackPath": "/oauth/callback",
  "prompt": "consent"
}
```

Use `oauth` when the MCP server requires explicit OAuth client, scope, or callback settings. The callback listener defaults to port `3000` and path `/callback`; an HTTP loopback `redirectUri` supplies its own port/path unless explicitly overridden. An HTTPS loopback redirect requires a distinct `callbackPort` for the local HTTP listener behind your TLS terminator.

`prompt` controls the OAuth `prompt` authorization parameter. By default OMP omits it, except that a requested `offline_access` scope defaults to `"consent"` so the provider can issue refresh access. Set it explicitly to a provider-supported value such as `"consent"` or `"select_account"`, or to `""` to force omission.

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

Portable Agent Plugins use different secret semantics: only `${PLUGIN_ROOT}` and `${PLUGIN_DATA}` are expanded. Their environment/header values remain literal, including empty strings; `!command` and bare environment-variable names are not evaluated. Provider-expanded marketplace environment keys also stay literal.

Before OMP launches a stdio server or makes an HTTP/SSE request, it resolves stdio `env` values and HTTP/SSE `headers` values like this:

1. If a value starts with `!`, OMP runs the rest as a shell command in the project directory with a 10s timeout and uses trimmed stdout. Successful results are process-cached until invalidated; concurrent resolutions share the same command execution.
2. If the command fails, times out, or prints only whitespace, that `env`/`headers` entry is omitted. Failed commands are retried on a later resolution after a 30s backoff.
3. Otherwise OMP checks whether the whole value names an environment variable.
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

## User-level enable and disable overrides

The active profile's user file supplies two cross-source overrides:

- `disabledServers` is the highest-precedence denylist. It hides a same-named server from any source.
- `enabledServers` force-enables a same-named entry whose source has `enabled: false`; it cannot override `disabledServers`.

```json
{
  "$schema": "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json",
  "disabledServers": ["github"],
  "enabledServers": ["tool-owned-server"]
}
```

`/mcp enable` and `/mcp disable` update `enabled` directly when the definition is in an OMP-owned writable file. OMP does not mutate another tool's config: for such sources, those commands maintain the user-level allowlist or denylist instead and remove a conflicting stale override.

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
- `/mcp reauth <name>` to replace managed OAuth credentials, or `/mcp unauth <name>` to remove them
- `/mcp resources`, `/mcp prompts`, and `/mcp notifications` to inspect non-tool MCP capabilities

## Validation rules OMP enforces

From `validateServerConfig()` in `packages/coding-agent/src/mcp/config.ts`:

- `stdio` requires `command`
- `http` and `sse` require `url`
- a server cannot set both `command` and `url`
- unknown `type` values are rejected

These rules apply to direct configs passed to the validator/writer. Discovery first converts canonical entries: it infers `http` for a URL-only entry and `stdio` for a command entry, and keeps the fields for the selected transport. Do not rely on discovery to reject conflicting raw fields or an unknown type; write explicit, schema-valid transport definitions.

`sse` remains valid for compatibility, but new hosted servers should usually be configured as `http`.

## Discovery and precedence

OMP loads providers in descending priority. The MCP-capable order is:

1. OMP native config
2. OMP extension packages
3. Claude Code
4. Agent Plugins
5. Claude marketplace plugins and Codex
6. Gemini CLI
7. OpenCode
8. Cursor and Windsurf
9. VS Code
10. root `mcp.json` / `.mcp.json` fallback files

Across providers, the first definition wins. Duplicate names are not merged; OpenCode's internal config layers are the exception described above. A differently named definition is also shadowed when its transport, endpoint/command inputs, auth, and request-id mode are equivalent to a higher-priority definition.

Within OMP native config, project `.omp/mcp.json` precedes `.omp/.mcp.json`, then the active profile's user `mcp.json` and `.mcp.json`. Root fallback `mcp.json` precedes root `.mcp.json`. In practice:

- prefer `.omp/mcp.json` or the active profile's user `mcp.json` for an OMP-specific override
- keep names and endpoint definitions unique across tools when possible
- use the user `disabledServers` list when a third-party config keeps reintroducing an unwanted server
- set `mcp.enableProjectConfig: false` to exclude every project-level source before deduplication, allowing a same-named user entry to survive

## Troubleshooting

### `Server "name": stdio server requires "command" field`

For a remote config passed directly to the writer/client, set `type: "http"`. Discovered URL-only entries infer HTTP; an explicitly stdio entry still needs a command.

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

### A browser MCP server is configured but never loads

OMP drops recognized browser-automation servers at config load, before any connection attempt, whenever the built-in browser prelude is callable: `browser.enabled` is true (the default), Eval is registered and active, and the session is not restricted to explicitly named tools. The filter matches servers named `playwright`, `puppeteer`, `browserbase`, `browser-tools`, `browser-use` or `browser`, stdio servers whose command or args match one of a fixed set of recognized browser-MCP package patterns (`@playwright/mcp`, `@modelcontextprotocol/server-puppeteer`, `@browserbasehq/mcp-server-browserbase`, `@agentdeskai/browser-tools-mcp`, `@agent-infra/mcp-server-browser`, `puppeteer-mcp`, `playwright-mcp`, `pptr-mcp`, `browser-use-mcp`, `mcp-browser-use`), or HTTP/SSE servers whose URL points at browserbase.com or browser-use.com. Any other package (for example `chrome-devtools-mcp` under a server name outside the list above) is not matched. This filter is separate from `disabledServers`.

The drop is quiet, but not equally visible everywhere: servers from any source other than the two primary files (`~/.omp/agent/mcp.json` and `.omp/mcp.json`) never reach `/mcp list`. Third-party configs, root `mcp.json` / `.mcp.json` fallbacks, and servers from OMP extension packages all vanish once filtered. An entry in one of the two primary files still shows up there as `not connected`, so a missing server with a primary-file entry may have been filtered. No error or warning is recorded either way.

To run a browser MCP server instead of the native browser tool, set `browser.enabled: false` in your settings. `omp read` does not apply this filter.

### A namespaced server works but the editor rejects its name

The runtime/config writer accepts `:` and single internal spaces in names. The bundled JSON schema's `propertyNames` pattern currently does not; this is a schema/runtime mismatch rather than a connection failure.

### A config file is silently absent from the list

Malformed JSON or a missing/invalid server map makes that provider contribute no entries from the file; depending on the provider, OMP records a discovery warning or logs the parse failure rather than failing the session. Correct the JSON shape, then run `/mcp reload` and `/mcp list`.

## References

- MCP transport spec: https://modelcontextprotocol.io/specification/2025-11-25/basic/transports
- Filesystem server package: https://www.npmjs.com/package/@modelcontextprotocol/server-filesystem
- GitHub MCP server: https://github.com/github/github-mcp-server
- Slack MCP server docs: https://docs.slack.dev/ai/slack-mcp-server/
