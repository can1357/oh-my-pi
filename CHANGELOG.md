# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.3.378] - 2026-01-01

### Fixed

- `git-status` hook now fires only once at session start instead of every turn

## [1.3.377] - 2026-01-01

### Added

- `rg` tool: ripgrep-based text search for fast regex pattern matching across codebases
- `glob` tool: fd-based file pattern matching with modification time sorting
- `replace_all` tool: sd-based find and replace for literal and regex string replacement across files
- `ast` tool: ast-grep structural search and replace for AST-level code transformations
- `notebook_edit` tool: cell-level editing of Jupyter notebook files
- `git-status` hook: injects repository state at conversation start
- Subagent session persistence: when `persistSessions` is enabled, subagent sessions and outputs are stored alongside the parent session in `<session-dir>/<session-name>/<agent>_<id>.{jsonl,out.md,in.md}`
- Recursive subagent option: agents can now set `recursive: true` in frontmatter to allow nested Task tool invocations

### Fixed

- Runtime config loader now uses deep merge to preserve nested defaults when merging store overrides
- Documentation now correctly states that hooks must use `omp.hooks` field, not `install` (which is only for static files like agents, commands, themes)

## [1.3.376] - 2026-01-01

### Added

- Model fallback aliases (`haiku, flash`) for subagents to improve compatibility across providers
- Windows shell support (`cmd`, `powershell`) in `omp env` command

### Changed

- Build target switched from Bun to Node for broader runtime compatibility

### Fixed

- Cross-platform command detection and Windows path handling in web renderer
- Windows compatibility: npm commands now use `npm.cmd` on Windows
- Windows compatibility: atomic file rename in lockfile now handles EEXIST
- Windows compatibility: `~` path expansion uses `os.homedir()` instead of `$HOME`
- Windows compatibility: LSP plugin uses `where` instead of `which` for command detection
- Windows compatibility: LSP file URIs use correct `file:///C:/` format on Windows
- Windows compatibility: path construction uses proper `path.join()` segments throughout
- Windows compatibility: subagent tasks now passed via temp file instead of CLI args to avoid shell escaping issues
- Windows compatibility: subagent spawns `pi.cmd` with proper shell option on Windows
- Windows compatibility: LSP server spawn uses shell option on Windows
- Windows compatibility: render-web external commands (markitdown, lynx) use shell for proper PATHEXT resolution

## [1.3.372] - 2026-01-01

### Added

- Platform-specific renderers for content extraction
- GitHub URL rendering with API integration
- Binary file conversion and feed parsing support
- Hook loader system for plugin lifecycle event subscriptions
- Browser subagent for LLM-friendly web rendering
- Expandable tree views for tool outputs
- Link color for hyperlink rendering in metal-theme

### Changed

- Improved HTTP fetch headers (Accept, Accept-Language, curl user-agent) for better server compatibility

### Fixed

- Updated Nitter instances with helpful error messages when Twitter/X blocks access
- Corrected scoped npm package name parsing for @scope format
- Optimized npm registry fetch for faster response parsing

## [1.3.371] - 2026-01-01

### Added

- Ctrl+O hint to subagent progress display
- Recent text/thinking output in expanded view for subagents
- Tool duration tracking and recent history in expanded view
- Configurable task limits via runtime.json
- `.claude` directory fallback for agent discovery

### Changed

- Updated formatter config (spaces, no semi, single quotes, 140 cols)

### Fixed

- Dedupe output lines, show relative time, fix tool name duplication in subagents

## [1.3.37] - 2026-01-01

### Added

- Project override support for enable/features/config/env commands via `-l` flag
- Project override merging for env vars

### Changed

- Made install/uninstall/update/list/outdated/link/doctor/why global-only commands
- Removed local install scope, added project overrides support
- Simplified lock and lockfile to global-only
- Global-only symlinks and loader with project store merging
- `omp init` now creates `.pi/overrides.json` (for project config) instead of `.pi/plugins.json`

### Fixed

- Softened empty task call handling in subagents

## [0.9.2] - 2026-01-01

_Documentation updates for npm-based tool loading and config persistence._

## [0.9.1] - 2026-01-01

### Added

- Centralized OMP loader for v0.9.0 plugin system
- LSP plugin for code intelligence and refactoring

### Changed

- Flattened plugin tools structure for simpler module resolution

## [0.8.3] - 2025-12-31

### Fixed

- Model pattern resolution to allow fallback in subagents

## [0.8.2] - 2025-12-31

### Changed

- Subagent default models: `explore` now uses `haiku` (was opus), `planner` and `task` use default model
- Planner agent now has access to all tools (was restricted to read-only)

## [0.8.1] - 2025-12-31

### Added

- Anthropic web search plugin with citations
- Perplexity AI search plugin for web research
- `/init` command plugin to generate AGENTS.md docs

## [0.6.0] - 2025-12-31

### Changed

- Removed package-lock.json to standardize on bun.lock

### Fixed

- Improved tool schema validation and error handling in exa plugin
- Various core issues

## [0.5.1] - 2025-12-31

### Added

- `--push` flag to automate commit, tag, and push in scripts

### Fixed

- Skip release creation when no tag present in CI

## [0.5.0] - 2025-12-31

### Added

- Cross-platform binary builds for standalone distribution
- Fuzzy model matching with comma-separated fallbacks for subagents
- Config validation command, parallel package reads, lockfile integrity
- `model: "default"` option to skip model override in subagents
- Auto-publish all plugins in CI
- Progress spinners with elapsed time for long-running operations

### Changed

- Migrated scripts to TypeScript for cross-platform support
- Task output paths now use `/tmp/pi-task-{runId}/` directory

### Fixed

- Respect `--dry-run` flag for local path installs
- Lock cleanup race conditions, path resolution, uninstall paths, JSON mode warnings
- Conflict resolution reprompt, dry-run mode, ANSI-aware formatting, flexible config
- Transitive conflict detection, symlink comparison, doctor checks, scoped names
- Lazy npm check, error diagnostics, doctor accuracy, recursive deps
- Transactional installs, confirmations, JSON output
- Atomic lock acquisition, lockfile corruption, path resolution

### Security

- Path traversal protection, Windows paths, safe symlink replacement

## [0.4.0] - 2025-12-31

### Added

- Plugin features, config, and env commands
- Feature selection syntax at install time (`omp install plugin[feature1,feature2]`, `[*]` for all, `[]` for core only)
- Plugin runtime variables with environment injection (variables in `omp.variables` can set env vars like `EXA_API_KEY`)
- User-prompt plugin for interactive input gathering
- Exa plugin for AI-powered web search via MCP
- Categorized file display with color-coded labels in list command

### Changed

- Renamed `multiSelect` to `multi` for brevity in user-prompt plugin
- Restructured exa plugin into modular features with runtime config
- Renamed exa tools with prefixes for clarity

### Removed

- Migrate command

## [0.2.0] - 2025-12-31

### Added

- Lock file support (`plugins-lock.json`) for reproducible installs with integrity verification
- File-based locking (`.pi/.lock`) for concurrent CLI invocation protection
- `--local` flag for project-local install/uninstall/update/list operations
- `--save-dev` flag for dev dependency installs
- `--force` flag for `omp link` to allow re-linking
- `--fix` flag for `omp doctor` to auto-repair broken symlinks
- `--all-versions` flag for `omp info` to show full version history
- Circular dependency detection during install
- Install rollback on failed operations
- Missing dependency checks in doctor command for nested omp plugins

### Changed

- Migrated to path aliases for cleaner import statements
- Install conflict detection now runs before npm install (was after)

### Fixed

- Concurrency, npm robustness, windows support, error handling
- Search truncation, create validation, uninstall safety
- Improved doctor, why, link, info, list, migrate, and search commands

### Security

- Shell injection fix via `execFileSync` with array args
- Path traversal protection for symlink destinations

## [0.1.0] - 2025-12-31

### Added

- Initial release of omp plugin manager for pi
- Install plugins globally via npm into `~/.pi/plugins/node_modules/`
- Symlink non-tool files (agents, commands, themes) into `~/.pi/agent/`
- Load tools directly from node_modules via generated loader
- Project-level overrides via `.pi/overrides.json` and `.pi/store/`

[Unreleased]: https://github.com/can1357/oh-my-pi/compare/v1.3.378...HEAD
[1.3.378]: https://github.com/can1357/oh-my-pi/compare/v1.3.377...v1.3.378
[1.3.377]: https://github.com/can1357/oh-my-pi/compare/v1.3.376...v1.3.377
[1.3.376]: https://github.com/can1357/oh-my-pi/compare/v1.3.372...v1.3.376
[1.3.372]: https://github.com/can1357/oh-my-pi/compare/v1.3.371...v1.3.372
[1.3.371]: https://github.com/can1357/oh-my-pi/compare/v1.3.37...v1.3.371
[1.3.37]: https://github.com/can1357/oh-my-pi/compare/v0.9.2...v1.3.37
[0.9.2]: https://github.com/can1357/oh-my-pi/compare/v0.9.1...v0.9.2
[0.9.1]: https://github.com/can1357/oh-my-pi/compare/v0.8.3...v0.9.1
[0.8.3]: https://github.com/can1357/oh-my-pi/compare/v0.8.2...v0.8.3
[0.8.2]: https://github.com/can1357/oh-my-pi/compare/v0.8.1...v0.8.2
[0.8.1]: https://github.com/can1357/oh-my-pi/compare/v0.6.0...v0.8.1
[0.6.0]: https://github.com/can1357/oh-my-pi/compare/v0.5.1...v0.6.0
[0.5.1]: https://github.com/can1357/oh-my-pi/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/can1357/oh-my-pi/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/can1357/oh-my-pi/compare/v0.2.0...v0.4.0
[0.2.0]: https://github.com/can1357/oh-my-pi/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/can1357/oh-my-pi/releases/tag/v0.1.0
