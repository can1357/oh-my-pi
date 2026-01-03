<p align="center">
  <img src="https://github.com/can1357/oh-my-pi/blob/main/assets/hero.png?raw=true" alt="Pi Monorepo">
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

## Installation

### Via Bun (recommended)

Requires [Bun](https://bun.sh) runtime:

```bash
bun install -g @oh-my-pi/pi-coding-agent
```

### Via installer script

**Linux / macOS:**
```bash
curl -fsSL https://raw.githubusercontent.com/can1357/oh-my-pi/main/scripts/install.sh | sh
```

**Windows (PowerShell):**
```powershell
irm https://raw.githubusercontent.com/can1357/oh-my-pi/main/scripts/install.ps1 | iex
```

By default, the installer uses bun if available, otherwise downloads the prebuilt binary.

Options:
- `--source` / `-Source`: Install via bun (installs bun first if needed)
- `--binary` / `-Binary`: Always use prebuilt binary

```bash
# Force bun installation
curl -fsSL .../install.sh | sh -s -- --source
```

### Manual download

Download binaries directly from [GitHub Releases](https://github.com/can1357/oh-my-pi/releases/latest).

---

## + LSP Integration (Language Server Protocol)

<p align="center">
  <img src="https://github.com/can1357/oh-my-pi/blob/main/assets/lspv.webp?raw=true" alt="lsp">
</p>

Full IDE-like code intelligence with automatic formatting and diagnostics:

- **Format-on-write**: Auto-format code using the language server's formatter (rustfmt, gofmt, prettier, etc.)
- **Diagnostics on write/edit**: Immediate feedback on syntax errors and type issues after every file change
- **Workspace diagnostics**: Check entire project for errors (`lsp action=workspace_diagnostics`)
- **40+ language configs**: Out-of-the-box support for Rust, Go, Python, TypeScript, Java, Kotlin, Scala, Haskell, OCaml, Elixir, Ruby, PHP, C#, Lua, Nix, and many more
- **Local binary resolution**: Auto-discovers project-local LSP servers in `node_modules/.bin/`, `.venv/bin/`, etc.
- Hover docs, symbol references, code actions, workspace-wide symbol search

## + Time Traveling Streamed Rules (TTSR)

<p align="center">
  <img src="https://github.com/can1357/oh-my-pi/blob/main/assets/ttsr.webp?raw=true" alt="ttsr">
</p>

Zero context-use rules that inject themselves only when needed:

- **Pattern-triggered injection**: Rules define regex triggers that watch the model's output stream
- **Just-in-time activation**: When a pattern matches, the stream aborts, the rule injects as a system reminder, and the request retries
- **Zero upfront cost**: TTSR rules consume no context until they're actually relevant
- **One-shot per session**: Each rule only triggers once, preventing loops
- Define via `ttsrTrigger` field in rule files (regex pattern)

Example: A "don't use deprecated API" rule only activates when the model starts writing deprecated code, saving context for sessions that never touch that API.

## + Interactive Code Review

<p align="center">
  <img src="https://github.com/can1357/oh-my-pi/blob/main/assets/review.webp?raw=true" alt="review">
</p>

Structured code review with priority-based findings:

- **`/review` command**: Interactive mode selection (branch comparison, uncommitted changes, commit review)
- **Structured findings**: `report_finding` tool with priority levels (P0-P3: critical → nit)
- **Verdict rendering**: `submit_review` aggregates findings into approve/request-changes/comment
- Combined result tree showing verdict and all findings

## + Task Tool (Subagent System)

<p align="center">
  <img src="https://github.com/can1357/oh-my-pi/blob/main/assets/task.webp?raw=true" alt="task">
</p>

Parallel execution framework with specialized agents and real-time streaming:

- **5 bundled agents**: explore, plan, browser, task, reviewer
- **Parallel exploration**: Reviewer agent can spawn explore agents for large codebase analysis
- **Real-time artifact streaming**: Task outputs stream as they're created, not just at completion
- **Output tool**: Read full agent outputs by ID when truncated previews aren't sufficient
- User-level (`~/.omp/agent/agents/`) and project-level (`.omp/agents/`) custom agents
- Concurrency-limited batch execution with progress tracking

## + Model Roles

<p align="center">
  <img src="https://github.com/can1357/oh-my-pi/blob/main/assets/models.webp?raw=true" alt="models">
</p>

Configure different models for different purposes with automatic discovery:

- **Three roles**: `default` (main model), `smol` (fast/cheap), `slow` (comprehensive reasoning)
- **Auto-discovery**: Smol finds haiku → flash → mini; Slow finds codex → gpt → opus → pro
- **Role-based selection**: Task tool agents can use `model: pi/smol` for cost-effective exploration
- CLI args (`--smol`, `--slow`) and env vars (`OMP_SMOL_MODEL`, `OMP_SLOW_MODEL`)
- Configure via `/model` selector with keybindings (Enter=default, S=smol, L=slow)

## + Ask Tool (Interactive Questioning)

<p align="center">
  <img src="https://github.com/can1357/oh-my-pi/blob/main/assets/ask.webp?raw=true" alt="ask">
</p>

Structured user interaction with typed options:

- **Multiple choice questions**: Present options with descriptions for user selection
- **Multi-select support**: Allow multiple answers when choices aren't mutually exclusive

## + Custom TypeScript Slash Commands

<p align="center">
  <img src="https://github.com/can1357/oh-my-pi/blob/main/assets/slash.webp?raw=true" alt="slash">
</p>

Programmable commands with full API access:

- Create at `~/.omp/agent/commands/[name]/index.ts` or `.omp/commands/[name]/index.ts`
- Export factory returning `{ name, description, execute(args, ctx) }`
- Full access to `HookCommandContext` for UI dialogs, session control, shell execution
- Return string to send as LLM prompt, or void for fire-and-forget actions
- Also loads from Claude Code directories (`~/.claude/commands/`, `.claude/commands/`)

## + Universal Config Discovery

<p align="center">
  <img src="https://github.com/can1357/oh-my-pi/blob/main/assets/discovery.webp?raw=true" alt="discovery">
</p>

Unified capability-based discovery that loads configuration from 8 AI coding tools:

- **Multi-tool support**: Claude Code, Cursor, Windsurf, Gemini, Codex, Cline, GitHub Copilot, VS Code
- **Discovers everything**: MCP servers, rules, skills, hooks, tools, slash commands, prompts, context files
- **Native format support**: Cursor MDC frontmatter, Windsurf rules, Cline `.clinerules`, Copilot `applyTo` globs, Gemini `system.md`, Codex `AGENTS.md`
- **Provider attribution**: See which tool contributed each configuration item
- **Discovery settings**: Enable/disable individual providers via `/config` interactive tab
- **Priority ordering**: Multi-path resolution across `.omp`, `.pi`, and `.claude` directories

## + MCP & Plugin System

<p align="center">
  <img src="https://github.com/can1357/oh-my-pi/blob/main/assets/perplexity.webp?raw=true" alt="perplexity">
</p>

Full Model Context Protocol support with external tool integration:

- Stdio and HTTP transports for connecting to MCP servers
- Plugin CLI (`omp plugin install/enable/configure/doctor`)
- Hot-loadable plugins from `~/.omp/plugins/` with npm/bun integration
- Automatic Exa MCP server filtering with API key extraction

## + Web Search & Fetch

<p align="center">
  <img src="https://github.com/can1357/oh-my-pi/blob/main/assets/arxiv.webp?raw=true" alt="arxiv">
</p>

Multi-provider search and full-page scraping:

- Anthropic, Perplexity, and Exa search integration with caching
- HTML-to-markdown conversion with link preservation
- JavaScript rendering support, image handling

## + TUI Overhaul

Modern terminal interface with smart session management:

- **Auto session titles**: Sessions automatically titled based on first message using smol model
- **Welcome screen**: Logo, tips, recent sessions with selection
- **Powerline footer**: Model, cwd, git branch/status, token usage, context %
- **LSP status**: Shows which language servers are active and ready
- **Hotkeys**: `?` displays shortcuts when editor empty
- **Emergency terminal restore**: Crash handlers prevent terminal corruption

## + Edit Fuzzy Matching

Handles whitespace and indentation variance automatically:

- High-confidence fuzzy matching for `oldText` in edit operations
- Fixes the #1 pain point: edits failing due to invisible whitespace differences
- Configurable via `edit.fuzzyMatch` setting (enabled by default)

## ... and many more

- **Git context**: System prompt includes branch, status, recent commits
- **Bun runtime**: Native TypeScript execution, faster startup, all packages migrated
- **Centralized file logging**: Debug logs with daily rotation to `~/.omp/logs/`
- **Clipboard export**: `/export --copy` copies session as formatted text
- **Bash interceptor**: Optionally block shell commands that have dedicated tools
- **Hidden tools**: Custom tools can be excluded from default list unless explicitly requested
- **@file auto-read**: Type `@path/to/file` in prompts to inject file contents inline
- **Additional tools**: AST (structural code analysis), Replace (find & replace across files)

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
bun run install:dev   # Install deps and link all packages
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
