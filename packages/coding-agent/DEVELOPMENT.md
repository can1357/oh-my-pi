# coding-agent Development Guide

This document describes the architecture and development workflow for the coding-agent package.

## Architecture Overview

The coding-agent is structured into distinct layers:

```
┌─────────────────────────────────────────────────────────────┐
│                         CLI Layer                           │
│  cli.ts → main.ts → cli/args.ts, cli/file-processor.ts     │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                       Mode Layer                            │
│  modes/interactive/   modes/print-mode.ts   modes/rpc/     │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                       Core Layer                            │
│  core/agent-session.ts, core/sdk.ts (SDK wrapper)          │
│  core/session-manager.ts, core/model-resolver.ts, etc.     │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                   External Dependencies                     │
│  @oh-my-pi/pi-agent-core (Agent core)                      │
│  @oh-my-pi/pi-ai (models, providers)                   │
│  @oh-my-pi/pi-tui (TUI components)                         │
│  @oh-my-pi/pi-git-tool (Git tool)                          │
└─────────────────────────────────────────────────────────────┘
```

## Directory Structure

```
src/
├── cli.ts                    # CLI entry point (shebang, calls main)
├── main.ts                   # Main orchestration, argument handling, mode routing
├── index.ts                  # Public API exports (SDK)
├── config.ts                 # APP_NAME, VERSION, paths (getAgentDir, etc.)
├── migrations.ts             # Session/config migration logic

├── cli/                      # CLI-specific utilities
│   ├── args.ts               # parseArgs(), printHelp(), Args interface
│   ├── file-processor.ts     # processFileArguments() for @file args
│   ├── list-models.ts        # --list-models implementation
│   ├── plugin-cli.ts         # Plugin management CLI
│   ├── session-picker.ts     # selectSession() TUI for --resume
│   └── update-cli.ts         # Self-update CLI

├── capability/               # Capability system (extension types)
│   ├── index.ts              # Main capability registry and discovery
│   ├── context-file.ts       # Context file capability
│   ├── extension.ts          # Extension capability
│   ├── hook.ts               # Hook capability
│   ├── instruction.ts        # Instruction capability
│   ├── mcp.ts                # MCP capability
│   ├── prompt.ts             # Prompt capability
│   ├── rule.ts               # Rulebook rule capability
│   ├── skill.ts              # Skill capability
│   ├── slash-command.ts      # Slash command capability
│   ├── system-prompt.ts      # System prompt capability
│   └── tool.ts               # Tool capability

├── discovery/                # Extension discovery from multiple sources
│   ├── index.ts              # Main discovery orchestration
│   ├── builtin.ts            # Built-in extensions
│   ├── claude.ts             # Claude.md discovery
│   ├── cline.ts              # Cline .mcp.json discovery
│   ├── codex.ts              # .codex discovery
│   ├── cursor.ts             # Cursor .cursorrules discovery
│   ├── gemini.ts             # Gemini .config discovery
│   ├── github.ts             # GitHub extension discovery
│   ├── mcp-json.ts           # MCP JSON discovery
│   ├── vscode.ts             # VSCode extension discovery
│   ├── windsurf.ts           # Windsurf discovery
│   └── helpers.ts            # Discovery helper functions

├── prompts/                  # Prompt templates
│   ├── system-prompt.md      # Main system prompt
│   ├── task.md               # Task agent prompt
│   ├── init.md               # Initialization prompt
│   ├── compaction-*.md       # Compaction prompts
│   └── tools/                # Tool-specific prompts

├── core/                     # Core business logic (mode-agnostic)
│   ├── index.ts              # Core exports
│   ├── agent-session.ts      # AgentSession class - THE central abstraction
│   ├── sdk.ts                # SDK wrapper for programmatic usage
│   ├── auth-storage.ts       # AuthStorage class - API keys and OAuth tokens
│   ├── bash-executor.ts      # executeBash() with streaming, abort
│   ├── event-bus.ts          # Event bus for tool communication
│   ├── exec.ts               # Process execution utilities
│   ├── file-mentions.ts      # File mention detection
│   ├── keybindings.ts        # Keybinding configuration
│   ├── logger.ts             # Winston-based logging
│   ├── messages.ts           # BashExecutionMessage, messageTransformer
│   ├── model-registry.ts     # Model registry and configuration
│   ├── model-resolver.ts     # resolveModelScope(), restoreModelFromSession()
│   ├── prompt-templates.ts   # Prompt template loading and rendering
│   ├── session-manager.ts    # SessionManager class - JSONL persistence
│   ├── settings-manager.ts   # SettingsManager class - user preferences
│   ├── skills.ts             # loadSkills(), skill discovery from multiple locations
│   ├── slash-commands.ts     # loadSlashCommands() from ~/.omp/agent/commands/
│   ├── system-prompt.ts      # buildSystemPrompt(), loadProjectContextFiles()
│   ├── terminal-notify.ts    # Terminal notification utilities
│   ├── timings.ts            # Performance timing utilities
│   ├── title-generator.ts    # Session title generation
│   ├── ttsr.ts               # Text-to-speech/speech-to-text utilities
│   ├── utils.ts              # Generic utilities
│   ├── voice.ts              # Voice input handling
│   ├── voice-controller.ts   # Voice control logic
│   ├── voice-supervisor.ts   # Voice supervision logic
│   │
│   ├── compaction/           # Context compaction system
│   │   └── index.ts          # Compaction logic, summary generation
│   │
│   ├── custom-commands/      # Custom command loading system
│   │   └── types.ts          # CustomCommand types
│   │
│   ├── custom-tools/         # Custom tool loading system
│   │   ├── index.ts          # Custom tool exports
│   │   ├── types.ts          # CustomToolFactory, CustomToolDefinition
│   │   ├── loader.ts         # loadCustomTools() from multiple locations
│   │   └── wrapper.ts        # Tool wrapper utilities
│   │
│   ├── export-html/          # Session export to HTML
│   │   └── (export logic)
│   │
│   ├── extensions/           # Extension system
│   │   └── (extension loading and execution)
│   │
│   ├── hooks/                # Hook system for extending behavior
│   │   ├── index.ts          # Hook exports
│   │   ├── types.ts          # HookAPI, HookContext, event types
│   │   ├── loader.ts         # loadHooks() from multiple locations
│   │   ├── runner.ts         # runHook() event dispatch
│   │   └── tool-wrapper.ts   # wrapToolsWithHooks() for tool_call events
│   │
│   ├── mcp/                  # MCP (Model Context Protocol) integration
│   │   └── (MCP client/server logic)
│   │
│   ├── plugins/              # Plugin system
│   │   └── (plugin loading and management)
│   │
│   └── tools/                # Built-in tool implementations
│       ├── index.ts          # Tool exports, BUILTIN_TOOLS, createTools
│       ├── ask.ts            # User input tool
│       ├── bash.ts           # Bash command execution
│       ├── bash-interceptor.ts # Bash command interception
│       ├── context.ts        # Tool context utilities
│       ├── edit.ts           # Surgical file editing
│       ├── edit-diff.ts      # Diff-based editing
│       ├── find.ts           # File search by glob
│       ├── gemini-image.ts   # Gemini image generation
│       ├── git.ts            # Git operations
│       ├── grep.ts           # Content search (regex/literal)
│       ├── ls.ts             # Directory listing
│       ├── notebook.ts       # Jupyter notebook editing
│       ├── output.ts         # Output/logging tool
│       ├── read.ts           # File reading (text and images)
│       ├── review.ts         # Code review tools
│       ├── rulebook.ts       # Rulebook tool
│       ├── write.ts          # File writing
│       ├── web-fetch.ts      # Web content fetching
│       ├── exa/              # Exa MCP tools (22 tools)
│       ├── lsp/              # LSP integration tools
│       ├── task/             # Task/subagent spawning
│       ├── web-search/       # Web search tools
│       ├── path-utils.ts     # Path resolution utilities
│       ├── renderers.ts      # Tool output renderers
│       ├── render-utils.ts   # Rendering utilities
│       └── truncate.ts       # Output truncation utilities

├── modes/                    # Run mode implementations
│   ├── index.ts              # Re-exports InteractiveMode, runPrintMode, runRpcMode, RpcClient
│   ├── print-mode.ts         # Non-interactive: process messages, print output, exit
│   │
│   ├── rpc/                  # RPC mode for programmatic control
│   │   ├── rpc-mode.ts       # runRpcMode() - JSON stdin/stdout protocol
│   │   ├── rpc-types.ts      # RpcCommand, RpcResponse, RpcSessionState types
│   │   └── rpc-client.ts     # RpcClient class for spawning/controlling agent
│   │
│   └── interactive/          # Interactive TUI mode
│       ├── interactive-mode.ts   # InteractiveMode class
│       │
│       ├── components/           # TUI components
│       │   ├── assistant-message.ts    # Agent response rendering
│       │   ├── bash-execution.ts       # Bash output display
│       │   ├── compaction.ts           # Compaction status display
│       │   ├── custom-editor.ts        # Multi-line input editor
│       │   ├── dynamic-border.ts       # Adaptive border rendering
│       │   ├── footer.ts               # Status bar / footer
│       │   ├── hook-input.ts           # Hook input dialog
│       │   ├── hook-selector.ts        # Hook selection UI
│       │   ├── model-selector.ts       # Model picker
│       │   ├── oauth-selector.ts       # OAuth provider picker
│       │   ├── queue-mode-selector.ts  # Message queue mode picker
│       │   ├── session-selector.ts     # Session browser for --resume
│       │   ├── show-images-selector.ts # Image display toggle
│       │   ├── theme-selector.ts       # Theme picker
│       │   ├── thinking-selector.ts    # Thinking level picker
│       │   ├── tool-execution.ts       # Tool call/result rendering
│       │   ├── user-message-selector.ts # Message selector for /branch
│       │   └── user-message.ts         # User message rendering
│       │
│       └── theme/
│           ├── theme.ts      # Theme loading, getEditorTheme(), etc.
│           ├── dark.json
│           ├── light.json
│           └── theme-schema.json

└── utils/                    # Generic utilities
    ├── changelog.ts          # parseChangelog(), getNewEntries()
    ├── clipboard.ts          # copyToClipboard()
    ├── fuzzy.ts              # Fuzzy string matching
    ├── image-convert.ts      # Image format conversion
    ├── image-magick.ts       # ImageMagick integration
    ├── image-resize.ts       # Image resizing utilities
    ├── mime.ts               # MIME type detection
    ├── shell.ts              # getShellConfig()
    ├── shell-snapshot.ts     # Shell state snapshotting
    └── tools-manager.ts      # ensureTool() - download fd, etc.
```

## Key Abstractions

### AgentSession (core/agent-session.ts)

The central abstraction that wraps the SDK Agent with:

- Session persistence (via SessionManager)
- Settings persistence (via SettingsManager)
- Model cycling with scoped models
- Context compaction
- Bash command execution
- Message queuing
- Hook integration
- Custom tool loading
- Extension/capability system integration

All three modes (interactive, print, rpc) use AgentSession.

### SDK (core/sdk.ts)

Wrapper around `@oh-my-pi/pi-agent-core` that provides a simplified interface for creating and managing agents programmatically. Used by AgentSession and available as a public API through index.ts exports.

### InteractiveMode (modes/interactive/interactive-mode.ts)

Handles TUI rendering and user interaction:

- Subscribes to AgentSession events
- Renders messages, tool executions, streaming
- Manages editor, selectors, key handlers
- Delegates all business logic to AgentSession

### RPC Mode (modes/rpc/)

Headless operation via JSON protocol over stdin/stdout:

- **rpc-mode.ts**: `runRpcMode()` function that listens for JSON commands on stdin and emits responses/events on stdout
- **rpc-types.ts**: Typed protocol definitions (`RpcCommand`, `RpcResponse`, `RpcSessionState`)
- **rpc-client.ts**: `RpcClient` class for spawning the agent as a subprocess and controlling it programmatically

The RPC mode exposes the full AgentSession API via JSON commands. See [docs/rpc.md](docs/rpc.md) for protocol documentation.

### SessionManager (core/session-manager.ts)

Handles session persistence:

- JSONL format for append-only writes
- Session file location management
- Message loading/saving
- Model/thinking level persistence

### SettingsManager (core/settings-manager.ts)

Handles user preferences:

- Default model/provider
- Theme selection
- Queue mode
- Thinking block visibility
- Compaction settings
- Hook/custom tool paths

### Hook System (core/hooks/)

Extensibility layer for intercepting agent behavior:

- **loader.ts**: Discovers and loads hooks from `~/.omp/agent/hooks/`, `.omp/hooks/`, and CLI
- **runner.ts**: Dispatches events to registered hooks
- **tool-wrapper.ts**: Wraps tools to emit `tool_call` and `tool_result` events
- **types.ts**: Event types (`session`, `tool_call`, `tool_result`, `message`, `error`)

See [docs/hooks.md](docs/hooks.md) for full documentation.

### Custom Tools (core/custom-tools/)

System for adding LLM-callable tools:

- **loader.ts**: Discovers and loads tools from `~/.omp/agent/tools/`, `.omp/tools/`, and CLI
- **types.ts**: `CustomToolFactory`, `CustomToolDefinition`, `CustomToolResult`

See [docs/custom-tools.md](docs/custom-tools.md) for full documentation.

### Skills (core/skills.ts)

On-demand capability packages:

- Discovers SKILL.md files from multiple locations
- Provides specialized workflows and instructions
- Loaded when task matches description

See [docs/skills.md](docs/skills.md) for full documentation.

### Capability System (capability/)

Unified extension system that discovers and loads capabilities from multiple sources:

- **Extension Discovery** (discovery/): Discovers extensions from Claude.md, .cursorrules, .codex, MCP servers, etc.
- **Capability Types**: Hooks, tools, context files, rules, skills, slash commands, system prompts, etc.
- **Multi-source**: Global (~/.omp/), project (.omp/), and built-in capabilities

See [docs/extensions.md](docs/extensions.md) for full documentation.

## Development Workflow

### Running in Development

Run the CLI directly with bun (this is a bun-based project):

```bash
# From monorepo root
bun run dev

# Or run directly
bun packages/coding-agent/src/cli.ts

# With arguments
bun packages/coding-agent/src/cli.ts --help
bun packages/coding-agent/src/cli.ts -p "Hello"

# RPC mode
bun packages/coding-agent/src/cli.ts --mode rpc --no-session
```

### Type Checking

```bash
# From monorepo root (runs biome + tsgo type check)
bun run check

# From packages/coding-agent
bun run check
```

### Building

```bash
# Type check and build (from packages/coding-agent)
bun run build

# Build standalone binary
bun run build:binary
```

### Testing

```bash
# Run tests (from packages/coding-agent)
bun test

# Run specific test pattern
bun test --testNamePattern="RPC"

# Run RPC example interactively
bun test/rpc-example.ts
```

## Adding New Features

### Adding a New Slash Command

1. If it's a UI-only command (e.g., `/theme`), add handler in `interactive-mode.ts` `setupEditorSubmitHandler()`
2. If it needs session logic, add method to `AgentSession` and call from mode

### Adding a New Tool

1. Create tool factory in `core/tools/` following existing patterns (e.g., `createMyTool(session: ToolSession)`)
2. Export factory and types from `core/tools/index.ts`
3. Add to `BUILTIN_TOOLS` map in `core/tools/index.ts`
4. Add tool prompt template to `prompts/tools/` if needed
5. Tool will automatically be included in system prompt

### Adding a New Hook Event

1. Add event type to hook event types in `core/hooks/types.ts`
2. Add emission point in relevant code (AgentSession, tool wrapper, etc.)
3. Update `docs/hooks.md` with the new event type

### Adding a New RPC Command

1. Add command type to `RpcCommand` union in `modes/rpc/rpc-types.ts`
2. Add response type to `RpcResponse` union in `modes/rpc/rpc-types.ts`
3. Add handler case in `handleCommand()` switch in `modes/rpc/rpc-mode.ts`
4. Add client method in `RpcClient` class in `modes/rpc/rpc-client.ts`
5. Update `docs/rpc.md` with the new command

### Adding a New Selector

1. Create component in `modes/interactive/components/`
2. Use `showSelector()` helper in `interactive-mode.ts`:

```typescript
private showMySelector(): void {
    this.showSelector((done) => {
        const selector = new MySelectorComponent(
            // ... params
            (result) => {
                // Handle selection
                done();
                this.showStatus(`Selected: ${result}`);
            },
            () => {
                done();
                this.ui.requestRender();
            },
        );
        return { component: selector, focus: selector.getSelectList() };
    });
}
```

### Adding a New Extension Source

1. Create discovery module in `discovery/` (e.g., `my-source.ts`)
2. Implement discovery functions that return capability objects
3. Add to discovery chain in `discovery/index.ts`
4. Update `docs/extension-loading.md` with the new source

### Adding a New Capability Type

1. Create capability module in `capability/` (e.g., `my-capability.ts`)
2. Define capability type and schema
3. Add to capability registry in `capability/index.ts`
4. Add loader/handler in relevant core module
5. Update `docs/extensions.md` with the new capability type

## Code Style

- TypeScript with strict type checking (tsgo)
- No `any` types unless absolutely necessary
- No inline dynamic imports
- Formatting via Biome (`bun run check` or `bun run fix`)
- Keep InteractiveMode focused on UI, delegate logic to AgentSession
- Use event bus for tool/extension communication

## Package Structure

This is part of a monorepo with the following packages:

- `@oh-my-pi/pi-coding-agent` (this package) - Main CLI and TUI
- `@oh-my-pi/pi-agent-core` - Core agent implementation
- `@oh-my-pi/pi-tui` - TUI components
- `@oh-my-pi/pi-git-tool` - Git tool integration
- `@oh-my-pi/pi-ai` - External AI provider library

## Documentation

See the `docs/` directory for detailed documentation:

- `docs/sdk.md` - SDK usage and examples
- `docs/rpc.md` - RPC protocol documentation
- `docs/hooks.md` - Hook system documentation
- `docs/extensions.md` - Extension system documentation
- `docs/custom-tools.md` - Custom tool development
- `docs/skills.md` - Skill system documentation
- `docs/compaction.md` - Context compaction system
- `docs/session.md` - Session management
- `docs/theme.md` - Theme customization
- `docs/tui.md` - TUI architecture
