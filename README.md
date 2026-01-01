<p align="center">
  <img src="https://raw.githubusercontent.com/can1357/oh-my-pi/main/assets/banner.png" alt="Oh My Pi" >
</p>

<p align="center">
  <strong>
    Think oh-my-zsh, but for <a href="https://github.com/badlogic/pi-mono">pi</a>.
  </strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@oh-my-pi/cli"><img src="https://img.shields.io/npm/v/@oh-my-pi/cli?style=flat&colorA=18181B&colorB=F0DB4F" alt="npm version"></a>
  <a href="https://github.com/can1357/oh-my-pi/actions"><img src="https://img.shields.io/github/actions/workflow/status/can1357/oh-my-pi/ci.yml?style=flat&colorA=18181B" alt="CI"></a>
  <a href="https://github.com/can1357/oh-my-pi/blob/main/LICENSE"><img src="https://img.shields.io/github/license/can1357/oh-my-pi?style=flat&colorA=18181B" alt="License"></a>
</p>

---

## Built-ins

| Plugin                                                                                       | Description                                                                    |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| **[@oh-my-pi/subagents](https://npmjs.com/package/@oh-my-pi/subagents)**                     | Task delegation with specialized sub-agents (task, planner, explore, reviewer) |
| **[@oh-my-pi/lsp](https://npmjs.com/package/@oh-my-pi/lsp)**                                 | Language Server Protocol for code intelligence, diagnostics, and refactoring   |
| **[@oh-my-pi/anthropic-websearch](https://npmjs.com/package/@oh-my-pi/anthropic-websearch)** | Claude web search using Anthropic's built-in web_search tool                   |
| **[@oh-my-pi/exa](https://npmjs.com/package/@oh-my-pi/exa)**                                 | Exa AI-powered web search, company/people lookup, and websets                  |
| **[@oh-my-pi/perplexity](https://npmjs.com/package/@oh-my-pi/perplexity)**                   | Perplexity AI search with Sonar models (fast and pro)                          |
| **[@oh-my-pi/user-prompt](https://npmjs.com/package/@oh-my-pi/user-prompt)**                 | Interactive user prompting for gathering input during execution                |
| **[@oh-my-pi/init](https://npmjs.com/package/@oh-my-pi/init)**                               | `/init` command to generate AGENTS.md documentation for a codebase             |
| **[@oh-my-pi/metal-theme](https://npmjs.com/package/@oh-my-pi/metal-theme)**                 | A metal theme 🤘                                                               |

---

Install community plugins with a single command. Themes, custom agents, slash commands, tools — sourced through npm/git, all a `omp install` away.

## Installation

```bash
npm install -g @oh-my-pi/cli
```

## Quick Start

```bash
# Install a plugin
omp install @oh-my-pi/subagents

# See what you've got
omp list

# Search for more
omp search agents

# Check for updates
omp outdated

# Update everything
omp update
```

## How It Works

omp installs plugins via npm and sets up your pi configuration:

```
~/.pi/
├── agent/                    # Pi's agent directory
│   ├── agents/               # Agent definitions (.md) - symlinked
│   ├── commands/             # Slash commands (.md) - symlinked
│   ├── tools/omp/            # Tool loader
│   │   └── index.ts          # Generated loader - imports tools from node_modules
│   └── themes/               # Theme files (.json) - symlinked
└── plugins/
    ├── package.json          # Installed plugins manifest
    ├── node_modules/         # Plugin packages (tools loaded directly from here)
    └── store/                # Runtime configs (survives npm updates)
```

**Non-tool files** (agents, commands, themes) are symlinked via `omp.install` entries.

**Tools** are loaded directly from node_modules via a generated loader. Plugins specify `omp.tools` pointing to their tool factory. This allows tools to use npm dependencies without workarounds.

## Global vs Local Plugins

omp supports both global and project-local plugin configurations:

| Scope  | Config Location  | Agent Directory | Use Case                 |
| ------ | ---------------- | --------------- | ------------------------ |
| Global | `~/.pi/plugins/` | `~/.pi/agent/`  | Personal defaults        |
| Local  | `.pi/`           | `.pi/agent/`    | Project-specific plugins |

```bash
# Explicit scope
omp install -g @oh-my-pi/subagents   # Global
omp install -l @oh-my-pi/subagents   # Local

# Auto-detect: uses local if .pi/plugins.json exists, otherwise global
omp install @oh-my-pi/subagents
```

Initialize a project-local config with `omp init`.

## Commands

| Command                | Alias | Description                                            |
| ---------------------- | ----- | ------------------------------------------------------ |
| `omp install [pkg...]` | `i`   | Install plugin(s). No args = install from plugins.json |
| `omp uninstall <pkg>`  | `rm`  | Remove plugin and its symlinks                         |
| `omp update [pkg]`     | `up`  | Update to latest within semver range                   |
| `omp list`             | `ls`  | Show installed plugins                                 |
| `omp search <query>`   |       | Search npm for plugins                                 |
| `omp info <pkg>`       |       | Show plugin details before install                     |
| `omp outdated`         |       | List plugins with newer versions                       |
| `omp doctor`           |       | Check for broken symlinks, conflicts                   |
| `omp link <path>`      |       | Symlink local plugin (dev mode)                        |
| `omp create <name>`    |       | Scaffold new plugin from template                      |
| `omp init`             |       | Create .pi/plugins.json in current project             |
| `omp why <file>`       |       | Show which plugin installed a file                     |
| `omp enable <name>`    |       | Enable a disabled plugin                               |
| `omp disable <name>`   |       | Disable plugin without uninstalling                    |
| `omp features <name>`  |       | List or configure plugin features                      |
| `omp config <name>`    |       | Get or set plugin configuration variables              |
| `omp env`              |       | Print environment variables for shell eval             |

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
	"files": ["agents", "commands"]
}
```

### Tools

For plugins with custom tools, use the `tools` field instead of `install`:

```json
{
	"name": "@oh-my-pi/my-tools",
	"version": "1.0.0",
	"keywords": ["omp-plugin"],
	"omp": {
		"tools": "tools"
	},
	"files": ["tools"],
	"dependencies": {
		"some-npm-package": "^1.0.0"
	}
}
```

The `tools` field points to a directory containing an `index.ts` that exports a tool factory. Tools are loaded directly from node_modules, so npm dependencies work normally.

### Features and Variables

Plugins can define optional features and configurable variables:

```json
{
	"name": "@oh-my-pi/exa",
	"version": "1.0.0",
	"keywords": ["omp-plugin"],
	"omp": {
		"tools": "tools",
		"runtime": "tools/runtime.json",
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
				"default": true
			},
			"websets": {
				"description": "Curated content collections",
				"default": false,
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

The `runtime` field points to a JSON file that the plugin imports to check feature state. omp stores user's feature selections in `~/.pi/plugins/store/` and injects them at load time, so they persist across npm updates.

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
