<p align="center">
  <img src="https://raw.githubusercontent.com/can1357/oh-my-pi/main/assets/banner.png" alt="Pi Monorepo">
</p>

<p align="center">
  <strong>AI coding agent for the terminal</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@oh-my-pi/pi-coding-agent"><img src="https://img.shields.io/npm/v/@oh-my-pi/pi-coding-agent?style=flat&colorA=222222&colorB=CB3837" alt="npm version"></a>
  <a href="https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/CHANGELOG.md"><img src="https://img.shields.io/badge/changelog-keep-E05735?style=flat&colorA=222222" alt="Changelog"></a>
  <a href="https://github.com/can1357/oh-my-pi/actions"><img src="https://img.shields.io/github/actions/workflow/status/can1357/oh-my-pi/ci.yml?style=flat&colorA=222222&colorB=3FB950" alt="CI"></a>
  <a href="https://github.com/can1357/oh-my-pi/blob/main/LICENSE"><img src="https://img.shields.io/github/license/can1357/oh-my-pi?style=flat&colorA=222222&colorB=58A6FF" alt="License"></a>
  <a href="https://www.typescriptlang.org"><img src="https://img.shields.io/badge/TypeScript-3178C6?style=flat&colorA=222222&logo=typescript&logoColor=white" alt="TypeScript"></a>
  <a href="https://bun.sh"><img src="https://img.shields.io/badge/runtime-Bun-f472b6?style=flat&colorA=222222" alt="Bun"></a>
</p>

<p align="center">
  Fork of <a href="https://github.com/badlogic/pi-mono">badlogic/pi-mono</a> by <a href="https://github.com/mariozechner">@mariozechner</a>
</p>

---

## Fork Enhancements

Features added on top of upstream pi:

### MCP & Plugin System

Full Model Context Protocol support with external tool integration:

- Stdio and HTTP transports for connecting to MCP servers
- Plugin CLI (`pi plugin install/enable/configure/doctor`)
- Hot-loadable plugins from `~/.pi/plugins/` with npm/bun integration
- 22 pre-built Exa MCP tools for web research, LinkedIn, fact-finding

### LSP Tool (Language Server Protocol)

IDE-like code intelligence via rust-analyzer and extensible to other languages:

- File diagnostics with error/warning/info classification
- Hover documentation, symbol references, implementations
- Code actions and refactoring suggestions
- Workspace-wide symbol search

### Task Tool (Subagent System)

Parallel execution framework with specialized agents:

- **5 bundled agents**: explore, plan, browser, task, reviewer
- User-level (`~/.pi/agent/agents/`) and project-level (`.pi/agents/`) custom agents
- Concurrency-limited batch execution with progress tracking
- Pre-defined commands: implement, architect-plan, implement-with-critic

### Web Search & Fetch

Multi-provider search and full-page scraping:

- Anthropic and Perplexity search integration with caching
- HTML-to-markdown conversion with link preservation
- JavaScript rendering support, image handling

### TUI Overhaul

- **Welcome screen**: Logo, tips, recent sessions with selection
- **Powerline footer**: Model, cwd, git branch/status, token usage, context %
- **Hotkeys**: `?` displays shortcuts when editor empty
- **Emergency terminal restore**: Crash handlers prevent terminal corruption

### Git Context

System prompt includes repo awareness:

- Current branch, main branch auto-detection
- Git status snapshot (staged/unstaged/untracked)
- Recent 5 commits summary

### Bun Runtime

Migrated from Node.js for native TypeScript:

- Runs `.ts` files directly without build step
- Faster CLI startup times
- All 7 packages converted to Bun APIs

### Additional Tools

- **Ask Tool**: Interactive user questioning (211 lines)
- **AST Tool**: Structural code analysis via ast-grep (271 lines)
- **Replace Tool**: Find & replace across files (297 lines)

---

## Packages

| Package                                                | Description                                                      |
| ------------------------------------------------------ | ---------------------------------------------------------------- |
| **[@oh-my-pi/pi-ai](packages/ai)**                     | Unified multi-provider LLM API (OpenAI, Anthropic, Google, etc.) |
| **[@oh-my-pi/pi-agent-core](packages/agent)**          | Agent runtime with tool calling and state management             |
| **[@oh-my-pi/pi-coding-agent](packages/coding-agent)** | Interactive coding agent CLI                                     |
| **[@oh-my-pi/pi-mom](packages/mom)**                   | Slack bot that delegates messages to the pi coding agent         |
| **[@oh-my-pi/pi-tui](packages/tui)**                   | Terminal UI library with differential rendering                  |
| **[@oh-my-pi/pi-web-ui](packages/web-ui)**             | Web components for AI chat interfaces                            |

---

## Development

### Setup

```bash
bun run dev:install   # Install deps and link all packages
bun run build         # Build all packages
bun run check         # Lint, format, and type check
```

> **Note:** `bun run check` requires `bun run build` first. The web-ui package uses `tsc` which needs compiled `.d.ts` files from dependencies.

### Watch Mode

```bash
bun run dev
```

Then run directly:

```bash
cd packages/coding-agent && bunx tsx src/cli.ts
```

### CI

GitHub Actions runs on push to `main` and on pull requests. The workflow runs `bun run check` and `bun test` for each package in parallel.

**Do not add LLM API keys as secrets.** Tests requiring LLM access use `describe.skipIf()` and run locally.

---

## Versioning

All packages use lockstep versioning:

```bash
bun run version:patch    # 0.7.5 -> 0.7.6
bun run version:minor    # 0.7.5 -> 0.8.0
bun run version:major    # 0.7.5 -> 1.0.0
```

**Never manually edit version numbers.**

---

## Publishing

```bash
bun run release:patch    # Bug fixes
bun run release:minor    # New features
bun run release:major    # Breaking changes
```

Requires an npm token with "Bypass 2FA on publish" enabled.

---

## License

MIT - Original work copyright Mario Zechner
