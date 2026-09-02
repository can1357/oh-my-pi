---
title: Code Intelligence
description: Language Server Protocol integration, AST-based search, and structural rewrites against the agent's project.
coverage: B
---

Code intelligence is the set of tools the agent uses to navigate and refactor code with a real understanding of its structure: language servers, AST pattern search, and AST-driven rewrites. The `lsp` tool is registered only when `lsp.enabled` is set; `ast_grep` and `ast_edit` are always available.

## Language servers (`lsp`)

The `lsp` tool queries language servers through standard JSON-RPC over stdio (or a local socket for socket-mode adapters like `dlv`). One action dispatches one LSP-style request; see [Available actions](#available-actions) for the full list.

### Configuration

No configuration is required for common setups. When no LSP config file is present, OMP auto-detects servers by intersecting two conditions:

1. The project directory contains at least one of the server's `rootMarkers`.
2. The server binary is available — checked in project-local bin directories (`node_modules/.bin/`, `.venv/bin/`) first, then `$PATH`.

Config files are merged in priority order from lowest to highest:

| Priority | Location |
| ---: | --- |
| 5 (lowest) | `~/lsp.json`, `~/.lsp.json`, `~/lsp.yaml`, `~/.lsp.yaml`, `~/lsp.yml`, `~/.lsp.yml` |
| 4 | Plugin LSP configs (marketplace / `--plugin-dir` roots) |
| 3 | User config dirs: `~/.omp/agent/lsp.*`, `~/.claude/lsp.*`, `~/.codex/lsp.*`, `~/.gemini/lsp.*` |
| 2 | Project config dirs: `<project>/.omp/lsp.*`, `<project>/.claude/lsp.*`, `<project>/.codex/lsp.*`, `<project>/.gemini/lsp.*` |
| 1 (highest) | Project root: `<project>/lsp.*` and `<project>/.lsp.*` |

Each location accepts `.json`, `.yaml`, and `.yml`, including hidden variants (`.lsp.json`, `.lsp.yaml`, `.lsp.yml`). Higher-priority files override lower-priority fields for the same server. Auto-detection is skipped only when at least one config file contributes server overrides.

File shape — both forms are equivalent:

```json
{
  "servers": {
    "server-name": { /* ServerConfig */ }
  },
  "idleTimeoutMs": 300000
}
```

or flat:

```json
{
  "server-name": { /* ServerConfig */ },
  "idleTimeoutMs": 300000
}
```

### ServerConfig fields

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `command` | `string` | yes | Binary name (PATH/local bins) or absolute path. |
| `args` | `string[]` | no | Arguments passed to the binary. |
| `fileTypes` | `string[]` | yes | File extensions this server handles, e.g. `[".ts", ".tsx"]`. |
| `rootMarkers` | `string[]` | yes | Files/dirs that indicate a project root; glob patterns supported. |
| `initOptions` | `object` | no | Sent as `initializationOptions` during the LSP handshake. |
| `settings` | `object` | no | Workspace settings pushed via `workspace/didChangeConfiguration`. |
| `disabled` | `boolean` | no | Set `true` to disable this server entirely. |
| `warmupTimeoutMs` | `number` | no | Per-server startup timeout in ms. |
| `isLinter` | `boolean` | no | Mark as linter/formatter only; excluded from type-intelligence operations (hover, go-to-definition, etc.). |
| `capabilities` | `object` | no | Server-specific features (`flycheck`, `ssr`, `expandMacro`, `runnables`, `relatedTests`) — currently used by `rust-analyzer`. |

`idleTimeoutMs` at the top level shuts down idle language servers after the given milliseconds; disabled by default. `resolvedCommand` is populated automatically; do not set it manually.

### Built-in servers

The defaults cover the popular ecosystems: `rust-analyzer`, `clangd`, `zls`, `gopls`, `typescript-language-server`, `denols`, `biome` (linter), `eslint` (linter), `vscode-html/css/json-language-server`, `tailwindcss`, `svelte`, `vue-language-server`, `astro`, `pyright`, `basedpyright`, `pylsp`, `ruff` (linter), `jdtls`, `kotlin-lsp`, `metals`, `hls`, `ocamllsp`, `elixirls`, `expert`, `erlangls`, `gleam`, `solargraph`, `ruby-lsp`, `rubocop` (linter), `bashls`, `lua-language-server`, `intelephense`, `phpactor`, `omnisharp`, `yamlls`, `terraformls`, `dockerls`, `helm-ls`, `nixd`, `nil`, `ols`, `dartls`, `marksman`, `texlab`, `graphql`, `prismals`, `vimls`, `emmet-language-server`, `sourcekit-lsp`, `swiftlint` (linter), `tlaplus`.

### Common recipes

Override a built-in server's settings with a partial config (merged onto the built-in defaults):

```yaml
servers:
  gopls:
    settings:
      gopls:
        gofumpt: false
        staticcheck: false
```

Disable a built-in server for one project while keeping it globally available by placing the override in `<project>/.omp/lsp.json`:

```json
{
  "servers": {
    "pylsp": { "disabled": true }
  }
}
```

Register a custom server. New servers require `command`, `fileTypes`, and `rootMarkers`; everything else is optional.

### Available actions

The `action` enum is:

`diagnostics`, `definition`, `references`, `hover`, `symbols`, `rename`, `rename_file`, `code_actions`, `type_definition`, `implementation`, `status`, `reload`, `capabilities`, `request`.

Highlights:

- **diagnostics** — `file` may be a path, a glob, or `"*"` (workspace mode). For globs, up to `MAX_GLOB_DIAGNOSTIC_TARGETS` (20) files are expanded. Workspace mode detects the project type from root markers and runs one subprocess: `cargo check --message-format=short`, `npx tsc --noEmit`, `go build ./...`, or `pyright`. Output is deduplicated by range+message and severity-sorted; the first 50 messages per file are reported.
- **definition** / **type_definition** / **implementation** — Send the corresponding `textDocument/...` request. For project-aware servers, `symbol` is required when `line` is given (no first-non-whitespace-column fallback).
- **references** — Sends `textDocument/references` with `includeDeclaration: true`. Retries up to 2 times when the only hit is the queried declaration, with 250 ms backoff and a project-load wait between retries. The first 50 references include source context.
- **hover** — Sends `textDocument/hover`; markup content, marked strings, and arrays are flattened to plain text.
- **symbols** — `file: "*"` runs `workspace/symbol` against every non-custom LSP server and post-filters results; the cap is `WORKSPACE_SYMBOL_LIMIT` (200). With a concrete `file` the request is `textDocument/documentSymbol` and the response renders hierarchically when possible.
- **rename** / **rename_file** — Rename operates on a symbol; `rename_file` renames a file or directory and sends `workspace/willRenameFiles` / `workspace/didRenameFiles` to every matching non-custom server. Both default to `apply: true`; pass `apply: false` to preview with `formatWorkspaceEdit()`. Directory renames are capped at `MAX_RENAME_PAIRS` (1,000) file pairs.
- **code_actions** — Lists server actions with `query` as a server-side `context.only` filter; pass `apply: true` with `query` to select an action by zero-based index or case-insensitive title substring.
- **status** — Lists configured servers and labels each `(configured, not started)` or with its live client status; appends `lspmux: active` when `lspmux` is running.
- **reload** — Workspace mode reloads every non-custom LSP server; single-file mode reloads the file's primary server. Tries `rust-analyzer/reloadWorkspace`, then `workspace/didChangeConfiguration`, then cold-starts a new client.
- **capabilities** — Dumps `serverCapabilities` as JSON for one matching file or for all configured servers when `file` is omitted/`"*"`.
- **request** — Generic escape hatch. Send an arbitrary LSP method with `query`; build params from `payload` (verbatim JSON), from `file`+`line`+`symbol`, from `file` alone, or `{}` when neither is supplied.

### Limits and behavior

- Tool timeout: default `20` seconds, clamped `5..300`.
- LSP request default timeout inside the client: `30_000 ms`.
- Warmup initialize timeout: `5_000 ms`. Project-load wait fallback: `15_000 ms`. Single-file diagnostics wait: `3_000 ms`. Batch/glob per-file wait: `400 ms`.
- Startup discovery (`discoverStartupLspServers`) runs when `enableLsp && options.hasUI`; background warmup additionally requires `!settings.get("lsp.lazy")`. `lsp.lazy` defaults to `true`, so discovered servers appear with status `"available"` and cold-start through `getOrCreateClient()` on first use. Print/RPC/ACP/script sessions skip discovery and warmup entirely.
- `lsp.enabled` gates the tool entirely; `lsp.lazy` controls the discovery warmup.
- The diagnostics action is the only one that also queries custom linter clients (`BiomeClient`, `SwiftLintClient`, or `LspLinterClient`).
- Navigation/refactor actions filter out custom linter clients via `getLspServersForFile()` / `getLspServerForFile()`.
- `lspmux` is auto-detected; only `rust-analyzer` is in `DEFAULT_SUPPORTED_SERVERS`. Disable detection with `PI_DISABLE_LSPMUX=1`.
- The `configCache` is per-process and never auto-invalidated; config changes require a fresh process to be observed by `getConfig()` callers.

### Without a server

If no configured or auto-detected server matches a file, single-file actions return a `No matching server` text result with `details.success: false`. Workspace diagnostics and the `lsp status` action are still useful: `status` lists every configured server and whether it has been started, and workspace diagnostics still runs the project-type check (`cargo check`, `npx tsc --noEmit`, `go build`, `pyright`) without a server.

## AST pattern search (`ast_grep`)

`ast_grep` performs structural code search using native [ast-grep](https://ast-grep.github.io/) with metavariable patterns. Inputs are `pat` (one AST pattern, required) and `paths` (files, directories, globs, or internal URLs with a backing file path; required; empty entries rejected). Optional `skip` is a match offset; non-finite or negative values fail.

### Pattern grammar

- `$NAME` — capture one AST node.
- `$_` — match one AST node without binding.
- `$$$NAME` — capture zero or more AST nodes (stops lazily at the next satisfiable node).
- `$$$` — match zero or more AST nodes without binding.
- Metavariable names must be uppercase and must stand for whole AST nodes, not partial tokens or string fragments.
- Reusing the same metavariable requires identical code at each occurrence.
- Patterns must parse as one valid AST node for the inferred target language.

### Languages

The canonical language set is enumerated by `SupportLang::all_langs()` and includes: `astro, bash, c, cmake, cpp, csharp, dart, clojure, css, diff, dockerfile, emacs-lisp, elixir, erlang, go, graphql, haskell, hcl, html, ini, java, javascript, json, just, julia, kotlin, lua, make, markdown, nix, objc, ocaml, odin, perl, php, powershell, protobuf, python, r, regex, ruby, rust, scala, solidity, sql, starlark, svelte, swift, toml, tlaplus, tsx, typescript, verilog, vue, xml, yaml, zig`.

The wrapper always sends a one-element `patterns` array; the model cannot pass multiple patterns per call even though the native binding supports it. Because compilation is per language present in the candidate set, one pattern can succeed for some languages and emit per-file parse errors for others in the same run.

### Output and limits

- Default `MatchStrictness` is `smart`.
- `DEFAULT_AST_LIMIT = 50` matches per call (single-target calls use the native default of 50; multi-target calls fetch `skip + 50 + 1` matches per target and re-page after global sort).
- `PARSE_ERRORS_LIMIT = 20` parse issues are reported; `parseErrorsTotal` carries the pre-cap deduplicated total.
- Directory scans are gitignore-aware, include hidden files, and skip `node_modules` unless the glob text mentions it.
- `*` matches only direct children; `**` recurses.
- Output is grouped by file. Hashline mode renders matches under `[PATH#HASH]` (requires edit tool and hashline edit mode plus a successful whole-file snapshot). Plain mode renders `*LINE|text`.

## AST rewrites (`ast_edit`)

`ast_edit` previews and applies structural rewrites across source files. The tool always previews first; actual file writes happen only after a follow-up `write /xdev/resolve` dispatch (or `/xdev/reject` to discard).

### Inputs

`ops` is an array of `{ pat, out }` rewrite rules. `pat` is the AST pattern; `out` is the replacement, with metavariables from `pat` substituted in. Empty `pat` fails; duplicate `pat` values fail before native execution; empty `out` deletes the matched node. `paths` follows the same rules as `ast_grep`.

```json
{
  "ops": [
    { "pat": "foo($A)", "out": "bar($A)" }
  ],
  "paths": ["src/**/*.ts"]
}
```

### Behavior

- The wrapper sets `PI_MAX_AST_FILES` (default `1000`) as the native `maxFiles` cap for both preview and apply.
- Native behavior defaults to `smart` strictness and best-effort parse (`failOnParseError: false`); per-file parse failures are accumulated in `parseErrors` rather than aborting the run.
- The wrapper does not expose `lang`, `strictness`, `selector`, `maxReplacements`, or `failOnParseError`. Mixed-language rewrites only succeed when every candidate infers to the same canonical language — stricter than `ast_grep`.
- Preview/apply parity is validated by totals and per-file counts after the apply rerun, not by a byte-for-byte diff of every replacement payload.
- Overlapping computed edits abort the run with `Overlapping replacements detected; refine pattern to avoid ambiguous edits`.

### Apply flow

1. `ast_edit` runs with `dryRun: true` and returns a preview result (`applied: false`).
2. A pending resolve action is registered; the agent sees a `SoftToolRequirement` reminder. The runtime forces `write` only if the model declines that turn.
3. The follow-up `write /xdev/resolve` reruns the same rewrite set with `dryRun: false`. If the live result no longer matches the preview (`stalePreview`), the dispatch returns an error result.
4. The `write /xdev/reject` dispatch discards without mutating files.

## See also

- [Tools: search and navigation](/oh-my-pi/features/tools/#search-and-navigation) — `grep`, `glob`
- [Settings](/oh-my-pi/configuration/settings/) — `lsp.enabled`, `lsp.lazy`
