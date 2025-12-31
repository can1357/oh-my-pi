<p align="center">
  <img src=".github/logo.png?raw=true" alt="Oh My Pi" height="300">
</p>

<p align="center">
  <strong>Plugin manager for <a href="https://github.com/badlogic/pi-mono">pi</a>.</strong>
</p>

<p align="center">
  Like oh-my-zsh, but for your AI coding assistant.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@oh-my-pi/cli"><img src="https://img.shields.io/npm/v/@oh-my-pi/cli?style=flat&colorA=18181B&colorB=F0DB4F" alt="npm version"></a>
  <a href="https://github.com/can1357/oh-my-pi/actions"><img src="https://img.shields.io/github/actions/workflow/status/can1357/oh-my-pi/ci.yml?style=flat&colorA=18181B" alt="CI"></a>
  <a href="https://github.com/can1357/oh-my-pi/blob/main/LICENSE"><img src="https://img.shields.io/github/license/can1357/oh-my-pi?style=flat&colorA=18181B" alt="License"></a>
</p>

---

**Oh My Pi won't make Claude write better code...** but it might make _you_ feel like it does.

Install community plugins with a single command. Themes, custom agents, slash commands, tools — all managed through npm, all a `omp install` away.

No more copy-pasting prompt files. No more manually symlinking configs. Just vibes.

## Installation

```bash
npm install -g @oh-my-pi/cli
```

## Quick Start

```bash
# Initialize a project-local plugin config (optional)
omp init

# Search for plugins
omp search agents

# Install a plugin
omp install @oh-my-pi/subagents

# See what you've got
omp list

# Check for updates
omp outdated

# Update everything
omp update
```

## How It Works

omp installs plugins via npm and symlinks their files into your pi configuration directory:

```
~/.pi/
├── agent/              # Where plugin files get symlinked
│   ├── agents/         # Agent definitions (.md)
│   ├── commands/       # Slash commands (.md)
│   ├── tools/          # Custom tools (.ts)
│   └── themes/         # Theme files (.json)
└── plugins/            # Plugin storage
    ├── package.json    # Installed plugins manifest
    └── node_modules/   # Actual plugin packages
```

Plugins declare which files to install via the `omp.install` field in their `package.json`. omp creates symlinks from the plugin's files into the appropriate `~/.pi/agent/` subdirectories.

## Global vs Local Plugins

omp supports both global and project-local plugin configurations:

| Scope | Config Location | Agent Directory | Use Case |
|-------|-----------------|-----------------|----------|
| Global | `~/.pi/plugins/` | `~/.pi/agent/` | Personal defaults |
| Local | `.pi/` | `.pi/agent/` | Project-specific plugins |

```bash
# Explicit scope
omp install -g @oh-my-pi/subagents   # Global
omp install -l @oh-my-pi/subagents   # Local

# Auto-detect: uses local if .pi/plugins.json exists, otherwise global
omp install @oh-my-pi/subagents
```

Initialize a project-local config with `omp init`.

## Commands

| Command | Alias | Description |
|---------|-------|-------------|
| `omp install [pkg...]` | `i` | Install plugin(s). No args = install from plugins.json |
| `omp uninstall <pkg>` | `rm` | Remove plugin and its symlinks |
| `omp update [pkg]` | `up` | Update to latest within semver range |
| `omp list` | `ls` | Show installed plugins |
| `omp search <query>` | | Search npm for plugins |
| `omp info <pkg>` | | Show plugin details before install |
| `omp outdated` | | List plugins with newer versions |
| `omp doctor` | | Check for broken symlinks, conflicts |
| `omp link <path>` | | Symlink local plugin (dev mode) |
| `omp create <name>` | | Scaffold new plugin from template |
| `omp init` | | Create .pi/plugins.json in current project |
| `omp why <file>` | | Show which plugin installed a file |
| `omp enable <name>` | | Enable a disabled plugin |
| `omp disable <name>` | | Disable plugin without uninstalling |
| `omp features <name>` | | List or configure plugin features |
| `omp config <name>` | | Get or set plugin configuration variables |
| `omp env` | | Print environment variables for shell eval |

Most commands accept `-g`/`--global` or `-l`/`--local` flags to override scope auto-detection.

## Feature Selection

Plugins can expose optional features that you can selectively enable. Use pip-style bracket syntax during install:

```bash
# Install with default features (plugin decides which are on by default)
omp install @oh-my-pi/exa

# Install with specific features only
omp install @oh-my-pi/exa[search]
omp install @oh-my-pi/exa[search,websets]

# Explicitly all features
omp install @oh-my-pi/exa[*]

# No optional features (core only)
omp install @oh-my-pi/exa[]

# Reinstall preserves feature selection unless you specify new ones
omp install @oh-my-pi/exa              # Keeps existing features
omp install @oh-my-pi/exa[search]      # Reconfigures to search only
```

Plugins define which features are enabled by default via `default: true` in their manifest. Features with `default: false` are opt-in.

Manage features after install with `omp features`:

```bash
# List available features and their current state
omp features @oh-my-pi/exa

# Enable/disable specific features
omp features @oh-my-pi/exa --enable websets
omp features @oh-my-pi/exa --disable search

# Set exact feature list
omp features @oh-my-pi/exa --set search,websets
```

## Plugin Configuration

Plugins can define configurable variables. Manage them with `omp config`:

```bash
# List all variables for a plugin
omp config @oh-my-pi/exa

# Get a specific value
omp config @oh-my-pi/exa apiKey

# Set a value
omp config @oh-my-pi/exa apiKey sk-xxx

# Reset to default
omp config @oh-my-pi/exa apiKey --delete
```

Variables with `env` mappings can be exported as environment variables:

```bash
# Print shell exports
eval "$(omp env)"

# Fish shell
omp env --fish | source

# Persist in your shell config
omp env >> ~/.bashrc
```

## Creating Plugins

Plugins are npm packages with an `omp` field in `package.json`:

```json
{
  "name": "my-cool-plugin",
  "version": "1.0.0",
  "keywords": ["omp-plugin"],
  "omp": {
    "install": [
      { "src": "agents/researcher.md", "dest": "agent/agents/researcher.md" },
      { "src": "commands/research.md", "dest": "agent/commands/research.md" }
    ]
  },
  "files": ["agents", "commands", "tools", "themes"]
}
```

### Features and Variables

Plugins can define optional features and configurable variables:

```json
{
  "name": "@oh-my-pi/exa",
  "version": "1.0.0",
  "keywords": ["omp-plugin"],
  "omp": {
    "install": [
      { "src": "tools/core.ts", "dest": "agent/tools/exa/core.ts" }
    ],
    "variables": {
      "apiKey": {
        "type": "string",
        "env": "EXA_API_KEY",
        "description": "Exa API key",
        "required": true
      }
    },
    "features": {
      "search": {
        "description": "Web search capabilities",
        "default": true,
        "install": [
          { "src": "tools/search.ts", "dest": "agent/tools/exa/search.ts" }
        ]
      },
      "websets": {
        "description": "Curated content collections",
        "default": false,
        "install": [
          { "src": "tools/websets.ts", "dest": "agent/tools/exa/websets.ts" }
        ],
        "variables": {
          "defaultCollection": {
            "type": "string",
            "default": "general"
          }
        }
      }
    }
  }
}
```

### Plugin Structure

```
my-cool-plugin/
├── package.json
├── agents/           # Agent definitions
│   └── researcher.md
├── commands/         # Slash commands
│   └── research.md
├── tools/            # Custom tools
│   └── search/
│       └── index.ts
└── themes/           # Theme files
    └── dark.json
```

### Install Mappings

The `omp.install` array maps source files to their destination in the agent directory:

- `src`: Path relative to the plugin root
- `dest`: Path relative to the pi config dir (usually starts with `agent/`)

### Publishing

1. Add `omp-plugin` to your `keywords` array (required for `omp search` discovery)
2. Include source directories in the `files` array
3. Publish to npm: `npm publish`

Your plugin is now discoverable via `omp search`.

### Development Workflow

```bash
# Scaffold a new plugin
omp create my-plugin

# Link for local development (changes reflect immediately)
omp link ./my-plugin

# Test your plugin
omp list

# When ready, publish
cd my-plugin && npm publish
```

## Bundled Plugins

- **[@oh-my-pi/subagents](https://npmjs.com/package/@oh-my-pi/subagents)**: Task delegation with specialized sub-agents (task, planner, explore, reviewer)
- **[@oh-my-pi/metal-theme](https://npmjs.com/package/@oh-my-pi/metal-theme)**: A metal theme
- **[@oh-my-pi/exa](https://npmjs.com/package/@oh-my-pi/exa)**: Exa AI-powered web search and websets tools
- **[@oh-my-pi/user-prompt](https://npmjs.com/package/@oh-my-pi/user-prompt)**: Interactive user prompting for gathering input during agent execution

## Troubleshooting

```bash
# Check for broken symlinks and conflicts
omp doctor

# See which plugin installed a specific file
omp why ~/.pi/agent/agents/researcher.md

# Temporarily disable a plugin
omp disable @oh-my-pi/subagents

# Re-enable it later
omp enable @oh-my-pi/subagents
```

## Credits

Built for [pi](https://github.com/badlogic/pi-mono) by [@badlogic](https://github.com/badlogic).

## License

MIT
