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

- Installs plugins globally via npm into `~/.pi/plugins/node_modules/`
- Symlinks non-tool files (agents, commands, themes) into `~/.pi/agent/`
- Loads tools directly from node_modules via a generated loader
- Supports project-level overrides via `.pi/overrides.json` and `.pi/store/`

### Core Modules (src/)

| File           | Responsibility                                                                                                                                 |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `cli.ts`       | Commander.js entry point; wires commands to handlers                                                                                           |
| `manifest.ts`  | Plugin manifest types (`omp` field in package.json), loading/saving global config and project overrides                                        |
| `symlinks.ts`  | Create/remove/check symlinks for `omp.install` entries (non-tool files only); path traversal protection                                        |
| `paths.ts`     | All path constants (global `~/.pi/`) and project override paths (`.pi/overrides.json`, `.pi/store/`)                                           |
| `conflicts.ts` | Detect destination collisions between plugins before install                                                                                   |
| `lockfile.ts`  | `omp-lock.json` for integrity verification (tarball hashes)                                                                                    |
| `npm.ts`       | npm CLI wrapper (`npm install`, `npm view`, `npm search`)                                                                                      |
| `lock.ts`      | File-based mutex for concurrent CLI invocations                                                                                                |
| `progress.ts`  | Spinner/progress output utilities                                                                                                              |
| `output.ts`    | Console output helpers, JSON mode support                                                                                                      |
| `errors.ts`    | Error handling wrapper for commands                                                                                                            |
| `runtime.ts`   | Runtime config resolution (env vars from plugin variables), merges project overrides                                                           |
| `loader.ts`    | Generates `~/.pi/agent/tools/omp/index.ts` and `~/.pi/agent/hooks/omp/index.ts` - loads tools/hooks from node_modules, patches runtime configs |

### Commands (src/commands/)

Each command is a separate file exporting an async handler. Pattern: receive CLI options, load manifests, perform operation, update state.

Key commands:

- `install.ts` — Most complex; handles npm install, transitive omp deps, conflict detection, feature resolution, symlink creation
- `doctor.ts` — Health checks: broken symlinks, orphaned files, config validation
- `features.ts` / `config.ts` — Runtime configuration of installed plugins (supports `-l` for project overrides)
- `enable.ts` / `disable.ts` — Enable/disable plugins globally or per-project with `-l`

### Plugin Structure (plugins/)

Built-in plugins ship in `plugins/` and are published separately. Each has:

- `package.json` with `omp` field defining install mappings, tools, and features
- Source files (agents/_.md, commands/_.md, tools/_.ts, themes/_.json)

**Key `omp` fields:**

- `install`: Array of `{src, dest}` for static files (symlinked to agent dir) — agents, commands, themes
- `tools`: Path to tools factory (e.g., `"tools"`) — loaded directly from node_modules via generated loader
- `hooks`: Path to hooks factory (e.g., `"hooks"`) — loaded directly from node_modules via generated loader
- `runtime`: Path to runtime config JSON (e.g., `"tools/runtime.json"`) — overridden from store

**Important**: Tools and hooks are loaded via their respective fields, NOT via `install`. The `install` field is only for static files that need symlinking (markdown agents, theme JSON, etc.).

### Storage Model

Plugins are installed globally only. Per-project customization uses overrides:

- **Global install**: `~/.pi/plugins/node_modules/`, `~/.pi/plugins/package.json`
- **Global config**: `~/.pi/plugins/store/<plugin>.json` (feature/config state)
- **Project overrides**: `.pi/overrides.json` (disabled list), `.pi/store/<plugin>.json` (feature/config)

The loader merges project store over global store at runtime. Commands with `-l` flag write to project overrides.

### Feature System

Plugins can define optional features in `omp.features`. Feature state is:

1. Stored in global `package.json` omp.config (source of truth for omp)
2. Written to `~/.pi/plugins/store/<plugin>.json` (persistent across npm updates)
3. Optionally overridden by `.pi/store/<plugin>.json` for project-specific config
4. Injected into the plugin's runtime.json via `Object.assign` at load time

The loader imports the plugin's runtime.json, reads the store (global + project merged), and patches the module cache before tools load.

## Style

- Formatter: Biome (tabs, 120 cols for TS); Prettier for markdown
- TypeScript: strict mode, Bun types, ES2022 target
- Path aliases: `@omp/*` → `src/*`
