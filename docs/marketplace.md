# Marketplace plugin system

The marketplace system lets you discover, install, and manage plugins from Git, local, or direct-catalog sources. It is compatible with the Claude Code plugin registry format.

## Quick start

```
/marketplace add anthropics/claude-plugins-official
/marketplace install wordpress.com@claude-plugins-official
```

In the TUI, `/marketplace` with no arguments opens the interactive plugin browser. In non-TUI command handling, `/marketplace` lists configured marketplaces; use `/marketplace discover` to browse.

## Concepts

A **marketplace** is a Git repository (or local directory) containing a catalog file at `.omp-plugin/marketplace.json` (preferred) or `.claude-plugin/marketplace.json` (Claude Code-compatible fallback). The catalog lists available plugins with their sources, descriptions, and metadata.

A **plugin** is a directory containing Claude/OMP plugin content such as skills, commands, agents, hooks, tools, MCP servers, or LSP servers. Extension modules (`package.json` `omp.extensions` entry points) are not loaded from marketplace installs — they only load for npm-installed or `oh-my-pk plugin link`ed plugins. Plugins are identified by `name@marketplace` (e.g. `code-review@claude-plugins-official`).

**Scopes**: marketplace plugins can be installed at two scopes:

- **user** (default) -- available in all projects, stored in `~/.ompk/plugins/installed_plugins.json`
- **project** -- available only in the active project, stored in the nearest project `.ompk/plugins/installed_plugins.json`

Enabled project-scoped installs shadow enabled user-scoped installs of the same plugin. A disabled project install does not shadow the user install.

## Commands

### Interactive mode

| Command        | Effect                                    |
| -------------- | ----------------------------------------- |
| `/marketplace` | Open interactive plugin browser (install) |

### Marketplace management

| Command                      | Effect                                       |
| ---------------------------- | -------------------------------------------- |
| `/marketplace add <source>`  | Add a marketplace source                     |
| `/marketplace remove <name>` | Remove a marketplace                         |
| `/marketplace update [name]` | Re-fetch catalog(s); omit name to update all |
| `/marketplace list`          | List configured marketplaces                 |

### Plugin operations

| Command                                                                   | Effect                                             |
| ------------------------------------------------------------------------- | -------------------------------------------------- |
| `/marketplace discover [marketplace]`                                     | Browse available plugins                           |
| `/marketplace install [--force] [--scope user\|project] name@marketplace` | Install a plugin                                   |
| `/marketplace uninstall [--scope user\|project] name@marketplace`         | Uninstall a plugin; no args opens the TUI selector |
| `/marketplace installed`                                                  | List installed marketplace plugins                 |
| `/marketplace upgrade [--scope user\|project] [name@marketplace]`         | Upgrade one or all plugins                         |
| `/plugins list`                                                           | List npm/link and marketplace plugins              |
| `/plugins enable [--scope user\|project] name@marketplace`                | Enable a marketplace plugin                        |
| `/plugins disable [--scope user\|project] name@marketplace`               | Disable a marketplace plugin                       |

### CLI equivalents

The same operations are available from the command line:

```
oh-my-pk plugin marketplace add <source>
oh-my-pk plugin marketplace remove <name>
oh-my-pk plugin marketplace update [name]
oh-my-pk plugin marketplace list
oh-my-pk plugin discover [marketplace]
oh-my-pk plugin install [--force] [--scope user|project] name@marketplace
oh-my-pk plugin uninstall [--scope user|project] name@marketplace
oh-my-pk plugin upgrade [--scope user|project] [name@marketplace]
oh-my-pk plugin enable [--scope user|project] name@marketplace
oh-my-pk plugin disable [--scope user|project] name@marketplace
```

## Marketplace sources

When you run `/marketplace add <source>`, the system classifies the source:

| Source format                   | Type                                               | Example                                |
| ------------------------------- | -------------------------------------------------- | -------------------------------------- |
| `owner/repo`                    | GitHub shorthand                                   | `anthropics/claude-plugins-official`   |
| `https://...*.json`             | Direct catalog URL                                 | `https://example.com/marketplace.json` |
| `https://...` / `http://...`    | Git repository unless the URL path ends in `.json` | `https://github.com/org/repo`          |
| `git@...` / `ssh://...`         | Git repository                                     | `git@github.com:org/repo.git`          |
| `./path` or `~/path` or `/path` | Local directory                                    | `./my-marketplace`                     |

Git and local sources must contain a catalog at `.omp-plugin/marketplace.json` (preferred) or `.claude-plugin/marketplace.json` (Claude Code-compatible fallback). Direct catalog URLs cache only the JSON catalog; plugins in URL-sourced catalogs cannot use relative string sources like `"./plugins/foo"`.

## Catalog format (marketplace.json)

A marketplace catalog lives at `.omp-plugin/marketplace.json` in the repository root. When omp is the only intended consumer, prefer this path. To remain Claude Code-compatible (omp loads the same shape from either path), publish at `.claude-plugin/marketplace.json` instead — omp uses it as a fallback when `.omp-plugin/marketplace.json` is absent. A repository may ship both: omp reads the `.omp-plugin/` copy, Claude Code reads the `.claude-plugin/` copy. Same catalog format either way:

```json
{
  "$schema": "https://anthropic.com/claude-code/marketplace.schema.json",
  "name": "my-marketplace",
  "owner": {
    "name": "Your Name",
    "email": "you@example.com"
  },
  "metadata": {
    "description": "A collection of plugins",
    "version": "1.0.0",
    "pluginRoot": "plugins"
  },
  "plugins": [
    {
      "name": "my-plugin",
      "description": "What this plugin does",
      "source": "./my-plugin",
      "category": "development",
      "homepage": "https://github.com/you/my-plugin"
    }
  ]
}
```

### Required fields

| Field        | Description                                                                                                      |
| ------------ | ---------------------------------------------------------------------------------------------------------------- |
| `name`       | Marketplace name. Lowercase alphanumeric, hyphens, and dots. Must start and end with alphanumeric. Max 64 chars. |
| `owner.name` | Marketplace owner name                                                                                           |
| `plugins`    | Array of plugin entries                                                                                          |

Top-level `metadata.description`, `metadata.version`, and `metadata.pluginRoot` are optional. When `metadata.pluginRoot` is set, it is prepended to relative plugin `source` paths.

### Plugin entry fields

| Field         | Required | Description                                                                             |
| ------------- | -------- | --------------------------------------------------------------------------------------- |
| `name`        | yes      | Plugin name (same rules as marketplace name)                                            |
| `source`      | yes      | Where to find the plugin (see below)                                                    |
| `description` | no       | Short description                                                                       |
| `version`     | no       | Version string; install version falls back to plugin manifest, source SHA, then `0.0.0` |
| `author`      | no       | `{ name, email? }`                                                                      |
| `homepage`    | no       | URL                                                                                     |
| `repository`  | no       | Repository URL/string                                                                   |
| `license`     | no       | License string                                                                          |
| `keywords`    | no       | Array of string keywords                                                                |
| `category`    | no       | Category string (e.g. `development`, `productivity`, `security`)                        |
| `tags`        | no       | Array of string tags                                                                    |
| `strict`      | no       | Boolean                                                                                 |
| `commands`    | no       | Slash commands provided                                                                 |
| `agents`      | no       | Agents provided                                                                         |
| `hooks`       | no       | Hook definitions                                                                        |
| `mcpServers`  | no       | MCP server definitions                                                                  |
| `lspServers`  | no       | LSP server definitions or path; copied to `.lsp.json` on install                        |

### Plugin source formats

The `source` field supports these formats. String sources must start with `./` and are resolved inside the marketplace root, after optional `metadata.pluginRoot` is prepended:

**Relative path** (within the marketplace repo):

```json
"source": "./my-plugin"
```

**Git repository URL**:

```json
"source": {
  "source": "url",
  "url": "https://github.com/org/repo.git",
  "sha": "abc123..."
}
```

**GitHub shorthand**:

```json
"source": {
  "source": "github",
  "repo": "org/repo",
  "ref": "main",
  "sha": "abc123..."
}
```

**Git subdirectory** (monorepo):

```json
"source": {
  "source": "git-subdir",
  "url": "https://github.com/org/monorepo.git",
  "path": "plugins/my-plugin",
  "ref": "main",
  "sha": "abc123..."
}
```

**npm package** (parsed but not installable yet):

```json
"source": {
  "source": "npm",
  "package": "@scope/my-plugin",
  "version": "1.0.0"
}
```

Current installer behavior rejects npm marketplace sources with `npm plugin sources are not yet supported`; use relative, GitHub, URL, or git-subdir sources.

## On-disk layout

```
~/.ompk/
  marketplaces.json              # Registry of added marketplaces
  plugins/
    installed_plugins.json       # User-scoped marketplace plugins (version: 2)
    cache/
      marketplaces/<name>/       # Cached marketplace clone/catalog
      plugins/<marketplace>___<plugin>___<version>/  # Cached plugin directories

<project>/.ompk/
  plugins/
    installed_plugins.json       # Project-scoped marketplace plugins (version: 2)
```

## Naming rules

Marketplace and plugin names must:

- Start and end with a lowercase letter or digit
- Contain only lowercase letters, digits, hyphens, and dots
- Be at most 64 characters

Plugin IDs (`name@marketplace`) must be at most 128 characters total.

Valid examples: `my-plugin`, `code-review`, `wordpress.com`, `ai-firstify`
Invalid examples: `-bad`, `bad-`, `.bad`, `Bad`, `under_score`
