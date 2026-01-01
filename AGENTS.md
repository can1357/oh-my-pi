# AGENTS.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
bun install          # Install dependencies
bun run build        # Build CLI → dist/cli.js
bun run check        # Lint (biome) + typecheck (no emit)
bun run lint         # Biome check --write (includes formatting TS)
bun run format       # Prettier (markdown only) + biome
bun run dev          # Watch mode: bun --watch src/cli.ts
bun dist/cli.js      # Run built CLI locally
```

Version/publish scripts: `bun scripts/bump-version.ts`, `bun scripts/publish.ts --dry-run`

## Architecture

**oh-my-pi** (`omp`) is a plugin manager for [pi](https://github.com/badlogic/pi-mono) that:

- Installs plugins via npm into `~/.pi/plugins/node_modules/`
- Symlinks non-tool files (agents, commands, themes) into `~/.pi/agent/`
- Loads tools directly from node_modules via a generated loader

### Core Modules (src/)

| File           | Responsibility                                                                                                                    |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `cli.ts`       | Commander.js entry point; wires commands to handlers                                                                              |
| `manifest.ts`  | Plugin manifest types (`omp` field in package.json), loading/saving `plugins.json`, reading plugin package.json from node_modules |
| `symlinks.ts`  | Create/remove/check symlinks for `omp.install` entries (non-tool files only); path traversal protection                           |
| `paths.ts`     | All path constants and scope resolution (global `~/.pi/` vs project-local `.pi/`)                                                 |
| `conflicts.ts` | Detect destination collisions between plugins before install                                                                      |
| `lockfile.ts`  | `omp-lock.json` for integrity verification (tarball hashes)                                                                       |
| `npm.ts`       | npm CLI wrapper (`npm install`, `npm view`, `npm search`)                                                                         |
| `lock.ts`      | File-based mutex for concurrent CLI invocations                                                                                   |
| `progress.ts`  | Spinner/progress output utilities                                                                                                 |
| `output.ts`    | Console output helpers, JSON mode support                                                                                         |
| `errors.ts`    | Error handling wrapper for commands                                                                                               |
| `runtime.ts`   | Runtime config resolution (env vars from plugin variables)                                                                        |
| `loader.ts`    | Generates `~/.pi/agent/tools/omp/index.ts` - loads tools from node_modules, patches runtime configs from store                    |

### Commands (src/commands/)

Each command is a separate file exporting an async handler. Pattern: receive CLI options, resolve scope, load manifests, perform operation, update state.

Key commands:

- `install.ts` — Most complex; handles npm install, transitive omp deps, conflict detection, feature resolution, symlink creation
- `doctor.ts` — Health checks: broken symlinks, orphaned files, config validation
- `features.ts` / `config.ts` — Runtime configuration of installed plugins

### Plugin Structure (plugins/)

Built-in plugins ship in `plugins/` and are published separately. Each has:

- `package.json` with `omp` field defining install mappings, tools, and features
- Source files (agents/_.md, commands/_.md, tools/_.ts, themes/_.json)

**Key `omp` fields:**

- `install`: Array of `{src, dest}` for non-tool files (symlinked to agent dir)
- `tools`: Path to tools factory (e.g., `"tools"`) - loaded directly from node_modules
- `runtime`: Path to runtime config JSON (e.g., `"tools/runtime.json"`) - overridden from store

### Scope Resolution

- Global: `~/.pi/plugins/` (npm), `~/.pi/agent/` (symlinks)
- Local: `.pi/plugins.json` + `.pi/node_modules/`, `.pi/agent/`
- Auto-detection: if `.pi/plugins.json` exists in cwd or parent, use local; else global
- Explicit: `-g`/`--global` or `-l`/`--local` flags override

### Feature System

Plugins can define optional features in `omp.features`. Feature state is:

1. Stored in `plugins.json` config (source of truth for omp)
2. Written to `~/.pi/plugins/store/<plugin>.json` (persistent across npm updates)
3. Injected into the plugin's runtime.json via `Object.assign` at load time

The loader imports the plugin's runtime.json, reads the store, and patches the module cache before tools load.

## Style

- Formatter: Biome (tabs, 120 cols for TS); Prettier for markdown
- TypeScript: strict mode, Bun types, ES2022 target
- Path aliases: `@omp/*` → `src/*`
