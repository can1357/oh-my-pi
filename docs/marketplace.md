# Marketplace plugin system

The marketplace system lets you discover, install, and manage plugins from Git, local, or direct-catalog sources. It is compatible with the Claude Code plugin registry format.

## Quick start

```
/marketplace add anthropics/claude-plugins-official
/marketplace install wordpress.com@claude-plugins-official
```

In the TUI, `/marketplace` with no arguments opens the interactive plugin browser. In ACP/RPC command handling, `/marketplace` lists configured marketplaces; use `/marketplace discover` to browse.

## Concepts

A **marketplace** is a Git repository (or local directory) containing a catalog file at `.omp-plugin/marketplace.json` (preferred) or `.claude-plugin/marketplace.json` (Claude Code-compatible fallback). The catalog lists available plugins with their sources, descriptions, and metadata.

A **plugin** is a directory containing Claude/OMP plugin content such as skills, commands, agents, rules, hooks, tools, MCP servers, or LSP servers. Marketplace installs also load extension modules declared by `package.json` `omp.extensions`: installation symlinks the cached plugin into the scope's `node_modules` tree and records it in `omp-plugins.lock.json`, the same runtime surfaces used by npm-installed and `omp plugin link`ed plugins. Plugins are identified by `name@marketplace` (e.g. `code-review@claude-plugins-official`).

**Scopes**: marketplace plugins can be installed at two scopes:

- **user** (default) -- available in all projects, stored in the user plugins data root's `installed_plugins.json` (`~/.omp/plugins/installed_plugins.json` by default)
- **project** -- available only in the active project, stored in the nearest project `.omp/plugins/installed_plugins.json`

Enabled project-scoped installs shadow enabled user-scoped installs of the same plugin. A disabled project install does not shadow the user install.

On Linux and macOS, `omp config init-xdg` creates the XDG data, state, and cache roots; it does not move existing data. Once the relevant roots exist and `XDG_DATA_HOME`, `XDG_STATE_HOME`, and `XDG_CACHE_HOME` are set, new user marketplace/plugin state resolves under `$XDG_DATA_HOME/omp` (including `marketplaces.json` and `plugins/`). The `~/.omp` paths below are the non-XDG defaults.

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
omp plugin marketplace add <source>
omp plugin marketplace remove <name>
omp plugin marketplace update [name]
omp plugin marketplace list
omp plugin discover [marketplace]
omp plugin install [--force] [--scope user|project] name@marketplace
omp plugin uninstall [--scope user|project] name@marketplace
omp plugin upgrade [--scope user|project] [name@marketplace]
omp plugin enable [--scope user|project] name@marketplace
omp plugin disable [--scope user|project] name@marketplace
omp plugin list

```

TUI marketplace mutations (explicit commands and the selector) update disk state and invalidate discovery caches but do not refresh the active session. Run `/reload-plugins` to refresh skills, slash commands, and MCP servers; restart the session for newly installed tools, hooks, or extension modules. ACP/RPC marketplace handlers refresh skills and slash commands automatically, but likewise do not rebuild every initialized capability set.

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

| Field         | Required | Description                                                                                    |
| ------------- | -------- | ---------------------------------------------------------------------------------------------- |
| `name`        | yes      | Plugin name (same rules as marketplace name)                                                   |
| `source`      | yes      | Where to find the plugin (see below)                                                           |
| `description` | no       | Short description                                                                              |
| `version`     | no       | Version string; install version falls back to plugin manifest, source SHA, then `0.0.0`        |
| `author`      | no       | `{ name, email? }`                                                                             |
| `homepage`    | no       | URL                                                                                            |
| `repository`  | no       | Repository URL/string                                                                          |
| `license`     | no       | License string                                                                                 |
| `keywords`    | no       | Array of string keywords                                                                       |
| `category`    | no       | Category string (e.g. `development`, `productivity`, `security`)                               |
| `tags`        | no       | Array of string tags                                                                           |
| `strict`      | no       | Boolean metadata flag; preserved but not used by install/runtime logic                         |
| `commands`    | no       | Command metadata; preserved but runtime commands are discovered from the installed plugin tree |
| `agents`      | no       | Agent metadata; preserved but not consumed by marketplace installation                         |
| `hooks`       | no       | Hook metadata; preserved but runtime hooks are discovered from the installed plugin tree       |
| `mcpServers`  | no       | MCP metadata; preserved here; runtime MCP configuration comes from the plugin manifest/tree    |
| `lspServers`  | no       | Inline map or in-plugin path; copied to `.lsp.json` during installation                        |
| `dapAdapters` | no       | Inline map or in-plugin JSON/YAML path; copied to `.dap.json`, `.dap.yaml`, or `.dap.yml`      |

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

Invalid catalog JSON or invalid required top-level fields reject the catalog. An invalid plugin entry is logged and skipped so other valid entries remain available.

## Updates, removal, and scope

- `/marketplace update [name]` refreshes catalogs only; it does not reinstall plugins.
- `omp plugin upgrade name@marketplace` reinstalls every installed scope when `--scope` is omitted. `/marketplace upgrade name@marketplace`, uninstall, and enable/disable require `--scope user|project` when the plugin exists in both scopes.
- Upgrading all plugins compares only catalog entries that declare `version`. Semver versions must be newer; non-semver versions are treated as changed when unequal. Per-plugin failures are skipped, so an all-plugin upgrade can partially succeed.
- `marketplace.autoUpdate` controls startup checks: `off`, `notify` (default), or `auto`. Catalogs older than 24 hours are refreshed best-effort before version checks. Despite its name, current `notify` mode writes update availability only to the debug log; it does not show a user-facing notification.
- Removing a marketplace removes its registry entry and catalog cache; it does not uninstall plugins already cached and registered.

## On-disk layout

```
~/.omp/
  marketplaces.json              # Registry of added marketplaces
  plugins/
    installed_plugins.json       # User-scoped marketplace plugins (version: 2)
    omp-plugins.lock.json         # Runtime enable/feature state
    node_modules/<package>        # Symlink to the cached plugin
    cache/
      marketplaces/<name>/       # Cached marketplace clone/catalog
      plugins/<marketplace>___<plugin>___<version>/  # Cached plugin directories

<project>/.omp/
  plugins/
    installed_plugins.json       # Project-scoped marketplace plugins (version: 2)
    omp-plugins.lock.json         # Project runtime enable/feature state
    node_modules/<package>        # Symlink to the cached plugin
```

## Naming rules

Marketplace and plugin names must:

- Start and end with a lowercase letter or digit
- Contain only lowercase letters, digits, hyphens, and dots
- Be at most 64 characters

Plugin IDs (`name@marketplace`) must be at most 128 characters total.

Valid examples: `my-plugin`, `code-review`, `wordpress.com`, `ai-firstify`
Invalid examples: `-bad`, `bad-`, `.bad`, `Bad`, `under_score`
