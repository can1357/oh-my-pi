# LSP configuration in OMP

This guide explains how to configure language servers for the OMP coding agent.

Source of truth in code:

- Server config type: `packages/coding-agent/src/lsp/types.ts` (`ServerConfig`)
- Config loader: `packages/coding-agent/src/lsp/config.ts`
- Built-in server definitions: `packages/coding-agent/src/lsp/defaults.json`

## Auto-detection

When no LSP config file is present, OMP auto-detects servers by intersecting two conditions:

1. The project directory contains at least one of the server's `rootMarkers`.
2. The server binary is available — checked in project-local bin directories first (e.g., `node_modules/.bin/`, `.venv/bin/`), then `$PATH`.

No configuration is required for common setups. The built-in server list covers most popular languages; see [`defaults.json`](../packages/coding-agent/src/lsp/defaults.json) for the full set.

## Config file locations

OMP merges LSP config from multiple files, lowest to highest priority:

| Priority    | Location                                                                                                                    |
| ----------- | --------------------------------------------------------------------------------------------------------------------------- |
| 5 (lowest)  | `~/lsp.json`, `~/.lsp.json`, `~/lsp.yaml`, `~/.lsp.yaml`, `~/lsp.yml`, `~/.lsp.yml`                                         |
| 4           | Plugin LSP configs (marketplace / `--plugin-dir` roots)                                                                     |
| 3           | User config dirs: `~/.ompk/agent/lsp.*`, `~/.claude/lsp.*`, `~/.codex/lsp.*`, `~/.gemini/lsp.*`                              |
| 2           | Project config dirs: `<project>/.ompk/lsp.*`, `<project>/.claude/lsp.*`, `<project>/.codex/lsp.*`, `<project>/.gemini/lsp.*` |
| 1 (highest) | Project root: `<project>/lsp.*` and `<project>/.lsp.*`                                                                      |

Each location accepts `.json`, `.yaml`, and `.yml` variants, including hidden-file versions (`.lsp.json`, `.lsp.yaml`, `.lsp.yml`). Files are merged in order: higher-priority files override lower-priority fields for the same server. Servers not mentioned in any override file remain at their built-in defaults.

**Recommended locations:**

- User-wide preferences → `~/.ompk/agent/lsp.json`
- Project-specific overrides → `<project>/.ompk/lsp.json`

> **Note:** Auto-detection is skipped only when at least one config file contributes server overrides. A config file that only sets `idleTimeoutMs` still lets OMP auto-detect built-in servers. When server overrides exist, OMP merges them with defaults and then loads servers that have matching `rootMarkers`, an available binary, and are not explicitly `disabled`.

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
- `idleTimeoutMs` — shut down idle language servers after this many milliseconds; disabled by default

## ServerConfig fields

| Field             | Type       | Required | Description                                                                                                      |
| ----------------- | ---------- | -------- | ---------------------------------------------------------------------------------------------------------------- |
| `command`         | `string`   | yes      | Binary name (resolved via PATH/local bins) or absolute path                                                      |
| `args`            | `string[]` | no       | Arguments passed to the binary                                                                                   |
| `fileTypes`       | `string[]` | yes      | File extensions this server handles, e.g. `[".ts", ".tsx"]`                                                      |
| `rootMarkers`     | `string[]` | yes      | Files/dirs that indicate a project root; glob patterns (e.g. `*.cabal`) are supported                            |
| `initOptions`     | `object`   | no       | Sent as `initializationOptions` during LSP handshake                                                             |
| `settings`        | `object`   | no       | Workspace settings pushed via `workspace/didChangeConfiguration`                                                 |
| `disabled`        | `boolean`  | no       | Set to `true` to disable this server entirely                                                                    |
| `warmupTimeoutMs` | `number`   | no       | Startup timeout in ms for this server (overrides the global default)                                             |
| `isLinter`        | `boolean`  | no       | Mark server as linter/formatter only; excluded from type-intelligence operations (hover, go-to-definition, etc.) |
| `capabilities`    | `object`   | no       | Opt-in server-specific features; see [Capabilities](#capabilities)                                               |

`resolvedCommand` is populated automatically at runtime — do not set it manually.

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

New servers require `command`, `fileTypes`, and `rootMarkers`. All other fields are optional.

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

Place the override in `<project>/.ompk/lsp.json`:

```json
{
  "servers": {
    "pylsp": {
      "disabled": true
    }
  }
}
```

The user-level config in `~/.ompk/agent/lsp.json` is unaffected; pylsp is only suppressed in this project.

## Built-in server list

The following servers ship in `defaults.json` and are eligible for auto-detection:

| Server key                    | Language(s)                   | Binary                            |
| ----------------------------- | ----------------------------- | --------------------------------- |
| `rust-analyzer`               | Rust                          | `rust-analyzer`                   |
| `clangd`                      | C, C++, ObjC                  | `clangd`                          |
| `zls`                         | Zig                           | `zls`                             |
| `gopls`                       | Go                            | `gopls`                           |
| `typescript-language-server`  | TypeScript, JavaScript        | `typescript-language-server`      |
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
