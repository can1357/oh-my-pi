# LSP configuration in OMP

This guide explains how to configure language servers for the OMP coding agent.

Source of truth in code:

- Server config type: `packages/coding-agent/src/lsp/types.ts` (`ServerConfig`)
- Config loader: `packages/coding-agent/src/lsp/config.ts`
- Built-in server definitions: `packages/coding-agent/src/lsp/defaults.json`

## Auto-detection

When no config file contributes a server override, OMP auto-detects built-in servers by intersecting two conditions:

1. The current working directory contains at least one of the server's `rootMarkers`.
2. The server binary is available — checked in supported project-local bin directories first (for example `node_modules/.bin/`, Python virtual environments, Ruby binstubs, and project `bin/` for Go), then `$PATH`.

Root-marker detection at startup is cwd-only; it does not search parent directories. Wildcard markers such as `*.cabal` match entries directly inside the cwd and do not recurse. No configuration is required for common setups; see [`defaults.json`](../packages/coding-agent/src/lsp/defaults.json) for the full built-in set.

## Config file locations

OMP merges LSP config from multiple sources, lowest to highest precedence:

| Precedence | Location                                                                                                     |
| ---------: | ------------------------------------------------------------------------------------------------------------ |
|     Lowest | `~/lsp.json`, `~/.lsp.json`, `~/lsp.yaml`, `~/.lsp.yaml`, `~/lsp.yml`, `~/.lsp.yml`                          |
|            | Plugin LSP configs (marketplace / `--plugin-dir` roots)                                                      |
|            | User config dirs: active native agent directory, then `~/.claude/lsp.*`, `~/.codex/lsp.*`, `~/.gemini/lsp.*` |
|            | Cwd config dirs: `<cwd>/.omp/lsp.*`, `<cwd>/.claude/lsp.*`, `<cwd>/.codex/lsp.*`, `<cwd>/.gemini/lsp.*`      |
|    Highest | Cwd root: `<cwd>/lsp.*` and `<cwd>/.lsp.*`                                                                   |

Each location accepts `.json`, `.yaml`, and `.yml`, including hidden variants. When multiple variants coexist in one location, precedence from highest to lowest is `lsp.json`, `.lsp.json`, `lsp.yaml`, `.lsp.yaml`, `lsp.yml`, `.lsp.yml`.

Merging is shallow per server: a higher-precedence server object overrides only its top-level fields, but object-valued fields such as `settings`, `initOptions`, `capabilities`, and `workspaceReadyTimings` replace the lower value as a whole rather than deep-merging it. Servers absent from override files remain at built-in defaults.

The native user config directory follows `PI_CONFIG_DIR` and active profiles; `~/.omp/agent/lsp.json` is the default-profile spelling. This shared config lookup does not use `PI_CODING_AGENT_DIR` as an arbitrary replacement base. Project and cwd sources do not walk ancestors.

**Recommended locations:**

- User-wide preferences → active native agent directory's `lsp.json`
- Project-specific overrides → `<cwd>/.omp/lsp.json`

> **Note:** Auto-detection mode is skipped only when at least one readable config contributes a non-empty server map. A config that only sets `idleTimeoutMs` still uses built-in auto-detection. With server overrides, OMP first merges them onto all defaults, then keeps servers whose root markers match the cwd, whose binary resolves, and whose merged config is not `disabled`.

## File shape

Both JSON and YAML are accepted. The top-level object can use either a `servers` wrapper key or a flat map directly:

```json
{
  "servers": {
    "server-name": { ... }
  },
  "idleTimeoutMs": 300000
}
```

or (flat, without the `servers` wrapper):

```json
{
  "server-name": { ... },
  "idleTimeoutMs": 300000
}
```

Top-level keys:

- `servers` — map of server name to `ServerConfig` (optional wrapper; flat form is equivalent)
- `idleTimeoutMs` — shut down idle language servers after this many milliseconds; omitted, zero, and negative values leave idle shutdown disabled

Do not mix wrapped and flat server entries: when `servers` is present, sibling keys other than `idleTimeoutMs` are not treated as servers.

## ServerConfig fields

| Field                   | Type       | Required for a new server | Description                                                                                              |
| ----------------------- | ---------- | ------------------------: | -------------------------------------------------------------------------------------------------------- |
| `command`               | `string`   |                       yes | Binary name (resolved through local bins / PATH) or absolute path                                        |
| `args`                  | `string[]` |                        no | Arguments passed to the binary                                                                           |
| `fileTypes`             | `string[]` |                       yes | File extensions this server handles, for example `[".ts", ".tsx"]`                                       |
| `languageId`            | `string`   |                        no | LSP language id sent in `textDocument/didOpen`; inferred from the file path when omitted                 |
| `rootMarkers`           | `string[]` |                       yes | Files/directories indicating a project root; one-level wildcard patterns such as `*.cabal` are supported |
| `initOptions`           | `object`   |                        no | Sent as `initializationOptions` during the LSP handshake                                                 |
| `settings`              | `object`   |                        no | Pushed via `workspace/didChangeConfiguration`                                                            |
| `disabled`              | `boolean`  |                        no | Set `true` to disable this server                                                                        |
| `warmupTimeoutMs`       | `number`   |                        no | Startup timeout for this server in milliseconds                                                          |
| `isLinter`              | `boolean`  |                        no | Marks a linter/formatter-only server; excludes it from type-intelligence operations                      |
| `capabilities`          | `object`   |                        no | Opt-in server-specific features; see [Capabilities](#capabilities)                                       |
| `workspaceReadyTimings` | `object`   |                        no | Advanced rust-analyzer workspace-readiness timing overrides; see below                                   |

The required fields may be omitted from an override of a built-in server because they are inherited before validation. A genuinely new server needs all three. `resolvedCommand` and `createClient` are runtime-owned fields and must not be configured.

### Capabilities

The `capabilities` object enables optional server-specific features that OMP supports on a per-server basis:

```json
{
  "capabilities": {
    "flycheck": true,
    "ssr": true,
    "expandMacro": true,
    "runnables": true,
    "relatedTests": true
  }
}
```

All fields are boolean and optional. They are currently used by `rust-analyzer`.

### Advanced rust-analyzer readiness timings

`workspaceReadyTimings` tunes rust-analyzer's workspace-ready polling:

```json
{
  "servers": {
    "rust-analyzer": {
      "workspaceReadyTimings": {
        "timeoutMs": 30000,
        "pollMs": 250,
        "settleMs": 2000,
        "statusRequestTimeoutMs": 2000
      }
    }
  }
}
```

All four fields are optional millisecond values. This is an advanced tuning surface; normal configurations should use the defaults.

## Common recipes

### Override a built-in server's settings

Partial overrides are merged onto the built-in defaults. You only need to specify the fields you want to change.

```json
{
  "servers": {
    "typescript-language-server": {
      "args": ["--stdio", "--log-level", "4"]
    }
  }
}
```

```yaml
servers:
  gopls:
    settings:
      gopls:
        gofumpt: false
        staticcheck: false
```

### Disable a built-in server

```json
{
  "servers": {
    "eslint": {
      "disabled": true
    }
  }
}
```

### Register a custom server

New servers require non-empty `command`, `fileTypes`, and `rootMarkers`. Invalid server definitions are ignored with a warning. An unreadable file or invalid JSON/YAML is ignored; the loader continues with the remaining sources.

```json
{
  "servers": {
    "my-lsp": {
      "command": "my-lsp-server",
      "args": ["--stdio"],
      "fileTypes": [".xyz"],
      "rootMarkers": [".xyz-project", ".git"]
    }
  }
}
```

### Set a global idle timeout

Shut down language servers that have been inactive for more than five minutes:

```json
{
  "idleTimeoutMs": 300000
}
```

### Disable a server for one project, keep it globally

Place the override in `<project>/.omp/lsp.json`:

```json
{
  "servers": {
    "pylsp": {
      "disabled": true
    }
  }
}
```

The user-level config in `~/.omp/agent/lsp.json` is unaffected; pylsp is only suppressed in this project.

## Built-in server list

The following servers ship in `defaults.json` and are eligible for auto-detection:

| Server key                    | Language(s)                   | Binary                            |
| ----------------------------- | ----------------------------- | --------------------------------- |
| `rust-analyzer`               | Rust                          | `rust-analyzer`                   |
| `clangd`                      | C, C++, ObjC                  | `clangd`                          |
| `zls`                         | Zig                           | `zls`                             |
| `gopls`                       | Go                            | `gopls`                           |
| `typescript-language-server`  | TypeScript, JavaScript (≤ 6)  | `typescript-language-server`      |
| `typescript-native`           | TypeScript, JavaScript (7+)   | `tsc --lsp --stdio`               |
| `denols`                      | TypeScript, JavaScript (Deno) | `deno`                            |
| `biome`                       | TS/JS/JSON (linter)           | `biome`                           |
| `eslint`                      | TS/JS/Vue/Svelte (linter)     | `vscode-eslint-language-server`   |
| `vscode-html-language-server` | HTML                          | `vscode-html-language-server`     |
| `vscode-css-language-server`  | CSS, SCSS, Less               | `vscode-css-language-server`      |
| `vscode-json-language-server` | JSON                          | `vscode-json-language-server`     |
| `tailwindcss`                 | HTML, CSS, TS/JS              | `tailwindcss-language-server`     |
| `svelte`                      | Svelte                        | `svelteserver`                    |
| `vue-language-server`         | Vue                           | `vue-language-server`             |
| `astro`                       | Astro                         | `astro-ls`                        |
| `pyright`                     | Python                        | `pyright-langserver`              |
| `basedpyright`                | Python                        | `basedpyright-langserver`         |
| `pylsp`                       | Python                        | `pylsp`                           |
| `ty`                          | Python                        | `ty`                              |
| `ruff`                        | Python (linter)               | `ruff`                            |
| `jdtls`                       | Java                          | `jdtls`                           |
| `kotlin-lsp`                  | Kotlin                        | `kotlin-lsp`                      |
| `metals`                      | Scala                         | `metals`                          |
| `hls`                         | Haskell                       | `haskell-language-server-wrapper` |
| `ocamllsp`                    | OCaml                         | `ocamllsp`                        |
| `elixirls`                    | Elixir                        | `elixir-ls`                       |
| `expert`                      | Elixir                        | `expert`                          |
| `erlangls`                    | Erlang                        | `erlang_ls`                       |
| `gleam`                       | Gleam                         | `gleam`                           |
| `solargraph`                  | Ruby                          | `solargraph`                      |
| `ruby-lsp`                    | Ruby                          | `ruby-lsp`                        |
| `rubocop`                     | Ruby (linter)                 | `rubocop`                         |
| `bashls`                      | Bash, Zsh                     | `bash-language-server`            |
| `lua-language-server`         | Lua                           | `lua-language-server`             |
| `intelephense`                | PHP                           | `intelephense`                    |
| `phpactor`                    | PHP                           | `phpactor`                        |
| `omnisharp`                   | C#                            | `omnisharp`                       |
| `yamlls`                      | YAML                          | `yaml-language-server`            |
| `terraformls`                 | Terraform                     | `terraform-ls`                    |
| `dockerls`                    | Dockerfile                    | `docker-langserver`               |
| `helm-ls`                     | Helm                          | `helm_ls`                         |
| `nixd`                        | Nix                           | `nixd`                            |
| `nil`                         | Nix                           | `nil`                             |
| `ols`                         | Odin                          | `ols`                             |
| `dartls`                      | Dart                          | `dart`                            |
| `marksman`                    | Markdown                      | `marksman`                        |
| `texlab`                      | LaTeX                         | `texlab`                          |
| `graphql`                     | GraphQL                       | `graphql-lsp`                     |
| `prismals`                    | Prisma                        | `prisma-language-server`          |
| `vimls`                       | Vim script                    | `vim-language-server`             |
| `emmet-language-server`       | HTML, CSS, JSX                | `emmet-language-server`           |
| `sourcekit-lsp`               | Swift                         | `sourcekit-lsp`                   |
| `swiftlint`                   | Swift (linter)                | `swiftlint`                       |
| `tlaplus`                     | TLA+                          | `tlapm_lsp`                       |

Only one TypeScript server is kept per project: when the resolved `tsc` belongs to a TypeScript install without `lib/tsserver.js` (TypeScript 7+), `typescript-native` wins and `typescript-language-server` is dropped, since it cannot drive that install; otherwise `typescript-native` is dropped because older `tsc` rejects `--lsp`.
