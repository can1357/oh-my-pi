# Oh My Pi (omp)

Plugin manager for pi configuration. Like oh-my-zsh, but for pi.

**v1.0 - npm-Native Architecture**

Plugins are npm packages with an `omp` field in package.json. Discover plugins via npm, install with semver, and enjoy a familiar package management experience.

## Installation

```bash
npm install -g @oh-my-pi/cli
```

## Quick Start

```bash
# Search for plugins
omp search agents

# Install a plugin
omp install @oh-my-pi/subagents

# List installed plugins
omp list

# Check for updates
omp outdated

# Update all plugins
omp update
```

## Commands

### Core Commands

| Command              | Description                                            |
|----------------------|--------------------------------------------------------|
| `omp install [pkg...]` | Install plugin(s). No args = install from plugins.json |
| `omp uninstall <pkg>`  | Remove plugin and its symlinks                         |
| `omp update [pkg]`     | Update to latest within semver range                   |
| `omp list`             | Show installed plugins                                 |
| `omp link <path>`      | Symlink local plugin (dev mode)                        |

### Discovery & Info

| Command                | Description                                |
|------------------------|--------------------------------------------|
| `omp search <query>`   | Search npm for omp-plugin keyword          |
| `omp info <pkg>`       | Show plugin details before install         |
| `omp outdated`         | List plugins with newer versions           |

### Maintenance

| Command                  | Description                              |
|--------------------------|------------------------------------------|
| `omp init`               | Create .pi/plugins.json in current project |
| `omp doctor`             | Check for broken symlinks, conflicts     |
| `omp why <file>`         | Show which plugin installed a file       |
| `omp enable/disable <pkg>` | Toggle plugin without uninstall        |

### Plugin Development

| Command            | Description                    |
|--------------------|--------------------------------|
| `omp create <name>`| Scaffold new plugin from template |
| `omp link <path>`  | Symlink local plugin for dev   |

### Flags

- `--global / -g`: Install to ~/.pi (default)
- `--save / -S`: Add to plugins.json
- `--json`: Machine-readable output
- `--force`: Overwrite conflicts

## Plugin Format

Plugins are npm packages with an `omp` field in package.json:

```json
{
  "name": "@oh-my-pi/subagents",
  "version": "1.0.0",
  "description": "Task delegation agents for pi-agent",
  "keywords": ["omp-plugin", "agents"],
  "omp": {
    "install": [
      { "src": "agents/task.md", "dest": "agent/agents/task.md" },
      { "src": "tools/task/", "dest": "agent/tools/task/" }
    ]
  },
  "files": ["agents", "tools"]
}
```

### Convention

- Include `omp-plugin` keyword for discoverability
- No namespace required (but `omp-` prefix is recommended)
- Use semver for versioning

## Directory Structure

### Global (default)

```
~/.pi/
├── plugins/
│   ├── node_modules/          # npm-managed
│   │   ├── @oh-my-pi/subagents/
│   │   └── @oh-my-pi/metal-theme/
│   ├── package.json           # Global plugin manifest
│   └── package-lock.json      # Lock file
├── agent/                     # Symlink targets
│   ├── agents/
│   ├── tools/
│   ├── themes/
│   └── commands/
```

### Project-Local

```
.pi/
├── plugins.json               # Project plugin config
├── plugins-lock.json          # Lock file
└── node_modules/              # Project-scoped installs
    └── omp-my-plugin/
```

Project plugins.json:
```json
{
  "plugins": {
    "@oh-my-pi/subagents": "^2.0.0",
    "@oh-my-pi/metal-theme": "^1.0.0"
  }
}
```

## Install Flow

```bash
omp install @oh-my-pi/subagents
```

1. Resolve version from npm registry
2. Check for conflicts (same dest from different plugins)
3. `npm install --prefix ~/.pi/plugins omp-subagents`
4. Read package.json → omp.install
5. For each {src, dest}: symlink to ~/.pi/{dest}
6. Recursively process dependencies with omp field
7. Update package.json

### Conflict Detection

```
⚠ Conflict: omp-dark-theme and omp-nord-theme both install agent/themes/dark.json
  Choose: [1] dark-theme  [2] nord-theme  [3] abort
```

## Creating Plugins

```bash
omp create my-plugin
```

Creates:
```
omp-my-plugin/
├── package.json
├── README.md
├── agents/
│   └── example.md
├── tools/
├── themes/
└── commands/
```

### Publishing

1. Create a package with an `omp` field in package.json
2. Add `omp-plugin` to keywords
3. Publish to npm: `npm publish`
4. Users install with: `omp install your-package-name`

## Migration from v0.x

If you have plugins installed with the old manifest.json format:

```bash
omp migrate
```

This will:
1. Convert manifest.json → package.json format
2. Move plugins to node_modules structure
3. Re-create symlinks
4. Archive old manifest.json

## Bundled Example Plugins

This package includes example plugins in the `plugins/` directory:

- **@oh-my-pi/subagents** - Task delegation system with specialized subagents
- **@oh-my-pi/metal-theme** - Metal theme for pi

Install bundled plugins:
```bash
# After npm install -g @oh-my-pi/cli
omp install $(npm root -g)/@oh-my-pi/cli/plugins/subagents
omp install $(npm root -g)/@oh-my-pi/cli/plugins/metal-theme
```

Or link for development:
```bash
omp link ./plugins/subagents
omp link ./plugins/metal-theme
```

## License

MIT
