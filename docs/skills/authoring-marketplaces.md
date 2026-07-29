---
name: authoring-marketplaces
description: Use when creating a new omp marketplace. Covers marketplace.json schema, source types, install commands, and publishing.
---

# Authoring Marketplaces

A marketplace is a Git repository (or local directory) that contains a catalog file at either `.omp-plugin/marketplace.json` (preferred for omp-specific catalogs) or `.claude-plugin/marketplace.json` (Claude Code-compatible; used as the fallback). Anyone can author one. Users add it with `/marketplace add owner/repo` and then install individual plugins from it.

## Minimum viable marketplace

```
my-marketplace/
  .claude-plugin/
    marketplace.json
  plugins/
    my-plugin/
      skills/
        my-skill/
          SKILL.md
```

```json
{
  "name": "my-marketplace",
  "owner": { "name": "Your Name" },
  "plugins": [
    {
      "name": "my-plugin",
      "description": "What it does",
      "source": "./plugins/my-plugin"
    }
  ]
}
```

Push to GitHub. Users install with:

```
/marketplace add your-github-username/my-marketplace
/marketplace install my-plugin@my-marketplace
```

## marketplace.json schema

The catalog file lives at either `.omp-plugin/marketplace.json` or `.claude-plugin/marketplace.json` in the repository root. omp prefers the `.omp-plugin/` path and falls back to the Claude path; a repository may publish both to expose tool-specific catalogs from a single source tree.

### Top-level fields

| Field | Required | Description |
|---|---|---|
| `name` | yes | Marketplace name. Lowercase alphanumeric, hyphens, dots. Must start and end with alphanumeric. Max 64 chars. |
| `owner` | yes | Object with at minimum `owner.name` (string) |
| `owner.name` | yes | Marketplace owner name |
| `owner.email` | no | Owner contact email |
| `plugins` | yes | Array of plugin entries (see below) |
| `metadata.description` | no | Short description of the marketplace |
| `metadata.version` | no | Catalog metadata version string |
| `metadata.pluginRoot` | no | String prepended to all relative plugin source paths |
| extra top-level fields | no | Preserved by the parser but not used by marketplace install/runtime logic |

### Plugin entry fields

| Field | Required | Description |
|---|---|---|
| `name` | yes | Plugin name (same naming rules as marketplace name) |
| `source` | yes | Where to find the plugin — string or object (see source types below) |
| `description` | no | Short plugin description |
| `version` | no | Version string |
| `author` | no | `{ name, email? }` |
| `homepage` | no | URL |
| `category` | no | e.g. `development`, `productivity`, `security` |
| `tags` / `keywords` | no | Arrays of string tags/keywords |
| `repository` | no | Repository URL |
| `license` | no | License string |
| `strict` | no | Boolean plugin metadata flag |
| `commands`, `agents`, `hooks`, `mcpServers`, `lspServers` | no | Capability metadata used by plugin tooling and selectors |

### Full catalog example

```json
{
  "$schema": "https://anthropic.com/claude-code/marketplace.schema.json",
  "name": "acme-plugins",
  "owner": {
    "name": "Acme Corp",
    "email": "plugins@acme.example"
  },
  "metadata": {
    "description": "Official Acme plugins for oh-my-pi"
  },
  "plugins": [
    {
      "name": "acme-linter",
      "description": "Enforce Acme coding standards",
      "category": "development",
      "source": "./plugins/linter"
    },
    {
      "name": "acme-deploy",
      "description": "One-command deploy to Acme cloud",
      "category": "devops",
      "source": {
        "source": "github",
        "repo": "acme-corp/omp-deploy-plugin",
        "ref": "main"
      }
    }
  ]
}
```

## Plugin source types

### 1. Relative path string

Points to a subdirectory inside the marketplace repository itself. Must start with `./`.

```json
"source": "./plugins/my-plugin"
```

The path is resolved relative to the marketplace repository root. Path traversal outside the repo root is rejected.

Use `metadata.pluginRoot` to avoid repeating a common prefix:

```json
{
  "metadata": { "pluginRoot": "./plugins" },
  "plugins": [
    { "name": "plugin-a", "source": "./plugin-a" },
    { "name": "plugin-b", "source": "./plugin-b" }
  ]
}
```

### 2. Git URL

A full Git repository URL. Optionally pin to a branch/tag (`ref`) or exact commit (`sha`):

```json
"source": {
  "source": "url",
  "url": "https://github.com/org/my-plugin.git",
  "ref": "main",
  "sha": "a1b2c3d4..."
}
```

### 3. GitHub shorthand

Shorthand for GitHub repositories. Functionally equivalent to a Git URL but more concise:

```json
"source": {
  "source": "github",
  "repo": "org/my-plugin",
  "ref": "v2.1.0",
  "sha": "a1b2c3d4..."
}
```

### 4. Git subdirectory (monorepo)

For plugins living inside a subdirectory of a larger repository. `url` accepts a full HTTPS URL or a GitHub `owner/repo` shorthand:

```json
"source": {
  "source": "git-subdir",
  "url": "https://github.com/org/monorepo.git",
  "path": "packages/my-plugin",
  "ref": "main",
  "sha": "a1b2c3d4..."
}
```

The `path` must resolve inside the cloned repository — directory escape is rejected.

### 5. NPM package

Declares the plugin as an npm package. `version` is optional:

```json
"source": {
  "source": "npm",
  "package": "@acme/omp-plugin",
  "version": "1.2.0"
}
```

> Note: npm plugin sources are declared in the schema but installation support is not yet fully implemented. Use Git-based sources for plugins that need to work today.

## Plugin structure

A plugin directory (regardless of source type) ships its content in conventional locations, all optional:

```
my-plugin/
  skills/<name>/SKILL.md   ← skills
  commands/*.md            ← slash commands
  agents/*.md              ← subagent definitions
  hooks/pre/, hooks/post/  ← hooks
  tools/                   ← custom tools
  .mcp.json                ← MCP server definitions
  package.json             ← optional; its version is a fallback when the catalog entry has no version
  README.md                ← recommended: description + usage
```

> Note: extension modules declared via `package.json` `omp.extensions` are **not** loaded from marketplace installs — that mechanism only applies to npm-installed or `oh-my-pk plugin link`ed plugins. Ship marketplace plugin behavior through the conventional directories above.

## Install command

```
/marketplace install name@marketplace-name
/marketplace install --force name@marketplace-name     # reinstall
/marketplace install --scope project name@marketplace  # project-scoped
```

CLI equivalent:

```
oh-my-pk plugin marketplace add owner/repo
oh-my-pk plugin install name@marketplace-name
```

Scope behavior:

- **user** (default) — installed in `~/.ompk/plugins/installed_plugins.json`, available in all projects
- **project** — installed in `<project>/.ompk/plugins/installed_plugins.json`, available only in that project

Project-scoped installs shadow user-scoped installs of the same plugin name.

## Naming rules

Marketplace names and plugin names must:

- Contain only lowercase letters, digits, hyphens (`-`), and dots (`.`)
- Start and end with a lowercase letter or digit
- Be at most 64 characters

Plugin IDs (`name@marketplace`) must be at most 128 characters total.

Valid: `my-plugin`, `code-review`, `acme.tools`, `ai-v2`
Invalid: `-bad-start`, `bad-end-`, `.dot-start`, `Under_score`, `HAS_CAPS`

## Publishing workflow

1. Create `marketplace.json` at `.omp-plugin/marketplace.json` (omp-only) or `.claude-plugin/marketplace.json` (shared with Claude Code) in a new Git repo.
2. Add plugin entries pointing to subdirectories (or external sources).
3. Push to GitHub.
4. Share the `owner/repo` string. Users add it with `/marketplace add owner/repo`.
5. When you update the catalog, users run `/marketplace update your-marketplace-name` to pull the latest.

To test locally before publishing:

```
/marketplace add ./path/to/my-marketplace
```

Local path sources also accept `~/` and absolute paths.

## Further reading

- `docs/marketplace.md` — marketplace system internals, on-disk layout, command reference
- `docs/skills/authoring-extensions.md` — how to author the extension modules inside plugins
- `docs/skills/examples/mini-marketplace/` — minimal working marketplace example
