# @oh-my-pi/lsp

Language Server Protocol (LSP) tool for Pi - provides code intelligence, diagnostics, refactoring, and more.

## Installation

```bash
omp install @oh-my-pi/lsp
```

## How It Works

The tool **auto-detects** available language servers based on:

1. **Project markers** (Cargo.toml, package.json, go.mod, etc.)
2. **Installed binaries** (rust-analyzer, typescript-language-server, etc.)

Only detected servers are exposed. For example:

- In a Rust project: Rust-analyzer actions appear
- In a TypeScript project: Only standard LSP actions (no Rust-specific)
- No project markers + no servers: Tool shows setup instructions

## Actions

### Standard LSP (all languages)

| Action              | Description                                         |
| ------------------- | --------------------------------------------------- |
| `diagnostics`       | Get errors/warnings for files                       |
| `references`        | Find all references to a symbol                     |
| `definition`        | Go to definition of a symbol                        |
| `rename`            | Smart rename across codebase                        |
| `actions`           | List/apply code actions (refactorings, quick fixes) |
| `hover`             | Get type info and documentation                     |
| `symbols`           | List symbols in a file                              |
| `workspace_symbols` | Search symbols across workspace                     |
| `status`            | Show detected/active servers                        |

### Rust-Analyzer Specific

These only appear when rust-analyzer is detected:

| Action             | Description                     |
| ------------------ | ------------------------------- |
| `flycheck`         | Run clippy/check on workspace   |
| `expand_macro`     | Expand macro at cursor position |
| `ssr`              | Structural search-replace       |
| `runnables`        | List runnable tests/binaries    |
| `related_tests`    | Find tests for a function       |
| `reload_workspace` | Reload Cargo.toml changes       |

## Supported Languages

| Language      | Server                       | Root Markers                    | Install                                          |
| ------------- | ---------------------------- | ------------------------------- | ------------------------------------------------ |
| Rust          | `rust-analyzer`              | `Cargo.toml`                    | `rustup component add rust-analyzer`             |
| TypeScript/JS | `typescript-language-server` | `package.json`, `tsconfig.json` | `npm i -g typescript-language-server typescript` |
| Go            | `gopls`                      | `go.mod`                        | `go install golang.org/x/tools/gopls@latest`     |
| Python        | `pylsp`                      | `pyproject.toml`, `setup.py`    | `pip install python-lsp-server`                  |
| Zig           | `zls`                        | `build.zig`                     | Download from zigtools/zls                       |
| C/C++         | `clangd`                     | `compile_commands.json`         | Package manager                                  |
| Lua           | `lua-language-server`        | `.luarc.json`                   | Download from LuaLS                              |

## Custom Configuration

Override or add servers via `~/.pi/lsp.json` or `.pi/lsp.json`:

```json
{
   "rust": {
      "command": "rust-analyzer",
      "args": [],
      "fileTypes": [".rs"],
      "rootMarkers": ["Cargo.toml"],
      "initOptions": {
         "checkOnSave": { "command": "clippy", "extraArgs": ["--all-targets"] }
      }
   },
   "ocaml": {
      "command": "ocamllsp",
      "args": [],
      "fileTypes": [".ml", ".mli"],
      "rootMarkers": ["dune-project"]
   },
   "typescript": {
      "disabled": true
   }
}
```

## Examples

```bash
# Check files for errors
lsp action=diagnostics files=["src/main.rs", "src/lib.rs"]

# Find all references
lsp action=references file="src/lib.rs" line=42 character=10

# Smart rename
lsp action=rename file="src/lib.rs" line=42 character=10 new_name="better_name" apply=true

# Get refactoring options
lsp action=actions file="src/lib.rs" line=10 character=5

# Apply a specific refactoring
lsp action=actions file="src/lib.rs" line=10 character=5 apply=0

# Run clippy (Rust only)
lsp action=flycheck

# Structural search-replace (Rust only)
lsp action=ssr pattern="unwrap()" replacement="expect(\"msg\")" apply=true
```
