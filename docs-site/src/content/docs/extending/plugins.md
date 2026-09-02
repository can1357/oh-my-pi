---
title: Plugins
description: Install and manage marketplace, npm, and local plugins with the omp plugin command.
coverage: B
---

A plugin bundles omp capabilities — skills, commands, agents, hooks, tools, MCP servers, LSP servers, and extension modules — into a single package that you can install from a marketplace, npm, or a local directory. The `omp plugin` command manages install/uninstall, enable/disable, marketplace sources, discovery, upgrade, and config.

## Quick start

```bash
# Add a marketplace
omp plugin marketplace add anthropics/claude-plugins-official

# Install a plugin from it
omp plugin install wordpress.com@claude-plugins-official

# List, enable, disable
omp plugin list
omp plugin disable --scope user wordpress.com@claude-plugins-official
omp plugin enable --scope user wordpress.com@claude-plugins-official

# Browse what's available
omp plugin discover

# Inspect a plugin
omp plugin doctor wordpress.com@claude-plugins-official
omp plugin features wordpress.com@claude-plugins-official
omp plugin config wordpress.com@claude-plugins-official
```

The same flows are available as `/marketplace` and `/plugins` slash commands in interactive mode. `/marketplace` with no arguments opens an interactive plugin browser.

## Concepts

A **marketplace** is a Git repository or local directory containing a catalog at `.omp-plugin/marketplace.json` (preferred) or `.claude-plugin/marketplace.json` (Claude Code-compatible fallback). The catalog lists available plugins with their sources, descriptions, and metadata.

A **plugin** is a directory containing Claude/OMP plugin content such as skills, commands, agents, hooks, tools, MCP servers, or LSP servers. Marketplace installs also load extension modules declared by `package.json` `omp.extensions`: installation symlinks the cached plugin into the scope's `node_modules` tree and records it in `omp-plugins.lock.json`, the same runtime surfaces used by npm-installed and `omp plugin link`ed plugins.

Plugins are identified by `name@marketplace`, for example `code-review@claude-plugins-official`.

### Scopes

Marketplace plugins can be installed at two scopes:

| Scope | Default | Stored in |
| --- | --- | --- |
| `user` | yes | `~/.omp/plugins/installed_plugins.json` |
| `project` | — | `<project>/.omp/plugins/installed_plugins.json` |

Enabled project-scoped installs shadow enabled user-scoped installs of the same plugin. A disabled project install does *not* shadow the user install — you can stop a plugin for one project without affecting others.

## `omp plugin` subcommands

`packages/coding-agent/src/commands/plugin.ts` registers these actions:

| Action | Effect |
| --- | --- |
| `install` | Install one or more plugins (npm/git specs, paths, marketplace refs) |
| `uninstall` | Remove one or more plugins |
| `list` | List installed plugins (default when no action is given) |
| `link` | Link a local plugin directory |
| `doctor` | Inspect a plugin for problems; `--fix` attempts repairs |
| `features` | List plugin features |
| `config` | Show plugin config |
| `enable` | Enable a plugin |
| `disable` | Disable a plugin |
| `marketplace` | Marketplace management (`add`/`remove`/`update`/`list`) |
| `discover` | Browse available plugins |
| `upgrade` | Upgrade plugins |

The full CLI grammar:

```bash
omp plugin <action> [targets...] [--json] [--fix] [--force] [--dry-run] [-l|--local]
                          [--enable <feature>] [--disable <feature>] [--set key=value]
                          [--scope user|project]
```

Flags:

| Flag | Short | Effect |
| --- | --- | --- |
| `--json` | | Output JSON |
| `--fix` | | Attempt to fix issues (doctor) |
| `--force` | | Force install |
| `--dry-run` | | Show actions without applying changes |
| `--local` | `-l` | Operate on a local plugin directory |
| `--enable <feature>` | | Enable a feature |
| `--disable <feature>` | | Disable a feature |
| `--set key=value` | | Set plugin config |
| `--scope <scope>` | | Install scope: `user` (default) or `project` |

### Marketplace management

```bash
omp plugin marketplace add <source>
omp plugin marketplace remove <name>
omp plugin marketplace update [name]      # omit name to update all
omp plugin marketplace list
```

`omp plugin discover [marketplace]` browses plugins available to install.

### Plugin operations

```bash
omp plugin install [--force] [--scope user|project] <name@marketplace>
omp plugin uninstall [--scope user|project] <name@marketplace>
omp plugin upgrade [--scope user|project] [name@marketplace]
omp plugin enable [--scope user|project] <name@marketplace>
omp plugin disable [--scope user|project] <name@marketplace>
```

## Marketplace sources

When you run `omp plugin marketplace add <source>`, the source is classified by its format:

| Source format | Type | Example |
| --- | --- | --- |
| `owner/repo` | GitHub shorthand | `anthropics/claude-plugins-official` |
| `https://...*.json` | Direct catalog URL | `https://example.com/marketplace.json` |
| `https://...` or `http://...` | Git repository (unless URL path ends in `.json`) | `https://github.com/org/repo` |
| `git@...` or `ssh://...` | Git repository | `git@github.com:org/repo.git` |
| `./path`, `~/path`, `/path` | Local directory | `./my-marketplace` |

Git and local sources must contain a catalog at `.omp-plugin/marketplace.json` (preferred) or `.claude-plugin/marketplace.json` (Claude Code-compatible fallback). Direct catalog URLs cache only the JSON catalog; plugins in URL-sourced catalogs cannot use relative string sources like `"./plugins/foo"`.

## On-disk layout

```text
~/.omp/
  marketplaces.json                       # Registry of added marketplaces
  plugins/
    installed_plugins.json                # User-scoped marketplace plugins (version: 2)
    omp-plugins.lock.json                  # Runtime enable/feature state
    node_modules/<package>                # Symlink to the cached plugin
    cache/
      marketplaces/<name>/                # Cached marketplace clone/catalog
      plugins/<marketplace>___<plugin>___<version>/  # Cached plugin directories

<project>/.omp/
  plugins/
    installed_plugins.json                # Project-scoped marketplace plugins (version: 2)
    omp-plugins.lock.json                  # Project runtime enable/feature state
    node_modules/<package>                # Symlink to the cached plugin
```

`omp-plugins.lock.json` is the shared runtime record used by marketplace installs, `npm install`-ed plugins, and `omp plugin link`ed plugins. Extension modules declared by `package.json` `omp.extensions` are loaded from `node_modules` entries the same way regardless of how they were installed.

## Naming rules

Marketplace and plugin names must:

- Contain only lowercase letters, digits, hyphens (`-`), and dots (`.`)
- Start and end with a lowercase letter or digit
- Be at most 64 characters

Plugin IDs (`name@marketplace`) must be at most 128 characters total.

| Valid | Invalid |
| --- | --- |
| `my-plugin`, `code-review`, `wordpress.com`, `ai-firstify` | `-bad`, `bad-`, `.bad`, `Bad`, `under_score` |

## Sharp edges

:::caution
**npm plugin sources are not yet supported.** A catalog entry that uses `"source": { "source": "npm", ... }` is parsed but the installer rejects it with `npm plugin sources are not yet supported`. Use relative, GitHub, URL, or git-subdir sources for plugins that need to work today.
:::

- **Project-scoped installs shadow user-scoped only when enabled.** A disabled project install does not shadow the user install — your global plugin keeps running in that project until you enable the project install.
- **Path traversal is rejected** for relative and `git-subdir` sources. `metadata.pluginRoot` and the resolved source must stay inside the marketplace repository.
- **Direct-catalog URLs cannot use relative plugin sources.** Plugins in a URL-sourced catalog need a fully-qualified `source` (`url`, `github`, `git-subdir`).
- **`.md` and `.json` plugin manifests are not executable.** Marketplace plugin manifests are metadata; only declared entry points run. Use `omp plugin doctor <name>` to surface missing files or malformed config.
