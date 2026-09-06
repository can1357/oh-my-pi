# Plugin manager and installer plumbing

This document describes how `omp plugin` npm/git/link and marketplace operations mutate plugin state on disk and become runtime capabilities. Marketplace installs keep their own registries and cache, then register the cached plugin through the same `node_modules` and `omp-plugins.lock.json` runtime surfaces used by npm/git/link installs; see `docs/marketplace.md`.

## Scope and architecture

There are two plugin-management implementations in the codebase:

1. **Active path used by CLI commands**: `PluginManager` (`src/extensibility/plugins/manager.ts`)
2. **Legacy helper module**: installer functions (`src/extensibility/plugins/installer.ts`)

`omp plugin` npm/git/link actions go through `PluginManager`; marketplace actions go through `MarketplaceManager`. `install` classifies each target (`classifyInstallTarget` in `cli/classify-install-target.ts`): `name@marketplace` routes to the marketplace manager, local paths route to `PluginManager.link()`, git and npm specs to `PluginManager.install()`.

`installer.ts` still documents important safety checks and filesystem behavior, but it is not the path used by `src/commands/plugin.ts` + `src/cli/plugin-cli.ts`.

## Lifecycle: from CLI invocation to runtime availability

```text
omp plugin <npm/link action> ...
  -> src/commands/plugin.ts
  -> runPluginCommand(...) in src/cli/plugin-cli.ts
  -> PluginManager method (install/list/uninstall/link/...)
  -> mutate user plugins data root {package.json,node_modules,omp-plugins.lock.json}
  -> enabled-plugin enumeration discovers user and nearest project plugin roots
  -> direct loaders resolve manifest-declared tool/extension entries
  -> `omp-plugins` capability discovery scans conventional skills/hooks/tools/commands/rules/prompts/MCP content; task discovery scans `agents/`

omp plugin install name@marketplace / omp install name@marketplace
  -> MarketplaceManager
  -> mutate scope registry and shared cache
  -> symlink the cached package into the scope's node_modules and update omp-plugins.lock.json
  -> `claude-plugins` discovery loads marketplace skills/commands/hooks/tools/MCP; task discovery loads `agents/`; extension loader imports `package.json#omp.extensions`
```

### Command entrypoints

- `src/commands/plugin.ts` defines command/flags and forwards to `runPluginCommand`.
- `src/cli/plugin-cli.ts` maps npm/link subcommands to `PluginManager` methods:
  - `install`, `uninstall`, `list`, `link`, `doctor`, `features`, `config`, `enable`, `disable`
- `discover`, `upgrade`, and `marketplace ...` subcommands use `MarketplaceManager`.
- No explicit npm-plugin `update` action exists; update is done by re-running `install` with a new package/version spec.

## On-disk model

User plugin state lives under the plugins data root (`~/.omp/plugins` by default). On Linux and macOS, `omp config init-xdg` creates the XDG data, state, and cache roots but does not move existing data; after the relevant roots exist and the XDG variables are set, new user plugin state resolves under `$XDG_DATA_HOME/omp/plugins`:

- `package.json` — dependency manifest used by `bun install`/`bun uninstall` for npm-installed plugins
- `node_modules/` — installed npm packages plus link and marketplace-cache symlinks
- `omp-plugins.lock.json` — runtime state for npm/link/marketplace plugins:
  - enabled/disabled per plugin
  - selected feature set per plugin
  - persisted plugin settings

When a project anchor (`.omp/` or `.git/`) exists at or above cwd, project runtime plugins live in `<anchor>/.omp/plugins/{node_modules,omp-plugins.lock.json}`. Marketplace project installs populate this root; enabled project packages shadow user packages with the same package name.

Project-local overrides are searched through project config directories as `plugin-overrides.json` (normally `<project>/.omp/plugin-overrides.json`). Overrides are read-only from manager/loader perspective and can disable plugins or override features/settings.

Marketplace installs add registry and cache state alongside those runtime entries:

- user data root `marketplaces.json` (`~/.omp/marketplaces.json` by default) — configured marketplace catalogs
- user plugins data root `installed_plugins.json` (`~/.omp/plugins/installed_plugins.json` by default) — user-scoped marketplace installs
- `<anchor>/.omp/plugins/installed_plugins.json` — project-scoped marketplace installs
- user plugins data root `cache/{marketplaces,plugins}/` — cached catalogs and plugin directories
- `<scope>/plugins/node_modules/<package>` — symlink to the cached plugin, allowing its `package.json` `omp.extensions` and tools to load
- `<scope>/plugins/omp-plugins.lock.json` — enablement and feature state shared with the runtime plugin loader

## Plugin spec parsing and metadata interpretation

## Install spec grammar

`parsePluginSpec` (`parser.ts`) supports:

- `pkg` -> `features: null` (defaults behavior)
- `pkg[*]` -> enable all manifest features
- `pkg[]` -> enable no optional features
- `pkg[a,b]` -> enable named features
- `@scope/pkg@1.2.3[feat]` -> scoped + versioned package with explicit feature selection

`PluginManager.install` also accepts git sources (validated by `validateGitSpec` instead of the npm regex): namespaced shorthands `github:user/repo[#ref]`, `gitlab:`, `bitbucket:`, `codeberg:`, `sourcehut:`/`srht:`, and full git URLs (`https://github.com/user/repo`, `git@github.com:user/repo`, `ssh://…`, `git+https://…`). Git specs do not encode the package name, so install diffs `plugins/package.json#dependencies` before/after `bun install` to resolve it.

`extractPackageName` strips version suffix for on-disk path lookup after install.

## Manifest source and required fields

Manifest is resolved as:

1. `package.json.omp`
2. fallback `package.json.pi`
3. fallback `{ version: package.version }`

Implications:

- There is no strict schema validation in manager/loader.
- A package missing `omp`/`pi` is still installable and listable.
- Runtime plugin loading (`getEnabledPlugins`) skips packages without `omp`/`pi` manifest.
- `manifest.version` is always overwritten from package `version`.

Malformed `package.json` JSON is a hard failure at read time; malformed manifest shape may fail later only when specific fields are consumed.

## Install/update flow (`PluginManager.install`)

1. Parse feature bracket syntax from install spec.
2. Validate the spec: git specs via `validateGitSpec`; npm specs against the package-name regex + shell-metacharacter denylist.
3. Ensure plugin `package.json` exists (`omp-plugins`, private dependencies map).
4. Run `bun install <packageSpec>` in `~/.omp/plugins`.
5. Resolve the installed package name (npm: strip version via `extractPackageName`; git: diff `dependencies` before/after) and read `node_modules/<name>/package.json`.
6. Resolve manifest and compute `enabledFeatures`:
   - `[*]`: all declared features (or `null` if no feature map)
   - `[a,b]`: validates each feature exists in manifest features map
   - `[]`: empty feature list
   - bare spec: `null` (use defaults policy later in loader)
7. Validate declared extension entries (`#validateInstalledExtensions`): each manifest `extensions` entry must resolve on disk, import to a factory function, and initialize successfully against a throwaway registration surface. On failure, roll back the install — restore the previous `plugins/package.json`, remove the freshly installed package, and restore any prior version from a backup taken before `bun install` — then abort.
8. Upsert lockfile runtime state: `{ version, enabledFeatures, enabled: true }`.

### Update semantics

Because update is install-driven:

- `omp plugin install pkg@newVersion` updates dependency and lockfile version.
- Existing settings remain in the separate settings map; the plugin state entry is replaced with the new version/features and enabled state.
- Install snapshots the prior package tree, `package.json`, and `bun.lock`. Any post-install failure, including feature validation, extension validation, or runtime-config save, attempts to restore all three.
- No separate npm-plugin “check updates” or migration action exists.

## Remove flow (`PluginManager.uninstall`)

1. Validate package name.
2. Run `bun uninstall <name>` in plugin dir.
3. Remove plugin runtime state from lockfile:
   - `config.plugins[name]`
   - `config.settings[name]`

If uninstall command fails, runtime state is not changed.

## List flow (`PluginManager.list`)

1. Read the dependency map and lockfile runtime entries; their union includes npm installs and link-only plugins.
2. Load project overrides.
3. Resolve each package from `node_modules`; skip marketplace runtime symlinks because marketplace summaries are listed separately.
4. Build `InstalledPlugin` records and merge effective state:
   - base from lockfile (or defaults)
   - project overrides can replace feature selection
   - project `disabled` list masks the plugin as disabled

`omp plugin list` combines this result with `MarketplaceManager.listInstalledPlugins()`.

`PluginManager.getPlugin()` resolves one runtime package directly, including a marketplace symlink intentionally omitted from `list()`. Config commands use this path so marketplace settings remain addressable without duplicating marketplace entries in list and status output.

## Link flow (`PluginManager.link`)

`link` supports local plugin development by symlinking a local package into `~/.omp/plugins/node_modules/<pkg.name>`.

Behavior:

1. Resolve `localPath` against manager cwd.
2. Require local `package.json` and `name` field.
3. Ensure plugin dirs exist.
4. For scoped names, create scope directory.
5. Remove existing path at target link location.
6. Create symlink.
7. Add runtime lockfile entry enabled with default features (`null`).

Caveat: current `PluginManager.link` does not enforce the `cwd` path-boundary check present in legacy `installer.ts` (`normalizedPath.startsWith(normalizedCwd)`), so trust is the caller’s responsibility.

## Runtime loading: from installed plugin to callable capabilities

## Discovery gate

`getEnabledPlugins(cwd)` (`plugins/loader.ts`) reads:

- plugin dependency manifest (`package.json`), unioned with lockfile plugin entries so `plugin link`-only plugins without a dependency entry are still discovered
- lockfile runtime state
- project overrides via `getConfigDirPaths("plugin-overrides.json", { user: false, cwd })`

Filtering:

- skip if no plugin package.json
- skip if manifest (`omp`/`pi`) absent
- skip if globally disabled in lockfile
- skip if project-disabled

## Capability path resolution

For each enabled plugin:

- `resolvePluginExtensionPaths(plugin)`
- `resolvePluginToolPaths(plugin)`
- `resolvePluginHookPaths(plugin)`
- `resolvePluginCommandPaths(plugin)`

Each resolver includes base entries plus feature entries:

- base entries are always included
- explicit feature list -> only selected features
- `enabledFeatures === null` -> enable features marked `default: true`

Manifest entries may point to a file or to a directory containing `index.ts`, `index.js`, `index.mjs`, or `index.cjs`. Missing files are silently skipped (`statSync`/`existsSync` guard).

## Current runtime wiring

- Manifest-declared **tools** feed `discoverAndLoadCustomTools` through `getAllPluginToolPaths(cwd)`.
- Manifest-declared **extensions** feed `discoverAndLoadExtensions` through `getAllPluginExtensionPaths(cwd)`.
- The `omp-plugins` capability provider separately scans conventional `skills/`, `hooks/pre|post/`, `tools/`, `commands/`, `rules/`, `prompts/`, and `.mcp.json` under enabled npm/link plugin roots. Task-agent discovery scans the same roots' `agents/`. Marketplace roots are excluded there and handled through `claude-plugins` plus marketplace task-agent discovery instead.
- Manifest hook/command path resolvers remain exported, but runtime hook/slash discovery uses the conventional capability-provider scans rather than `getAllPluginHookPaths()` or `getAllPluginCommandPaths()`.
- Direct custom-tool and extension path lists are de-duplicated by resolved absolute path (`seen`, first path wins).

## Lock/state management details

`PluginManager` caches runtime config in memory per instance (`#runtimeConfig`) and lazily loads once.

Manager load behavior:

- lockfile missing -> `{ plugins: {}, settings: {} }`
- lockfile read/parse failure -> warning + the same empty defaults

Enabled-plugin discovery loads each user/project root independently: a missing lockfile is empty, while a non-ENOENT read/parse failure propagates.

Save behavior:

- writes full lockfile JSON pretty-printed each mutation

No cross-process locking or merge strategy exists; concurrent writers can overwrite each other.

## Safety checks and trust boundaries

## Input/package validation

Active manager path enforces package-name validation:

- npm specs: a package-name regex (`VALID_PACKAGE_NAME`) for scoped/unscoped specs, optionally with version.
- npm shell-metacharacter denylist: `;`, `&`, `|`, backtick, `$`, `(`, `)`, `{`, `}`, `[`, `]`, `<`, `>`, `\` — applied after `parsePluginSpec` strips the feature brackets, so a normal `pkg[feat]` spec never reaches it.
- git specs: `validateGitSpec` rejects only the shared `SHELL_METACHARS` set (`;`, `&`, `|`, backtick, `$`, `(`, `)`, `{`, `}`, `<`, `>`, `\`, newline, CR, tab) instead of the npm regex, so `:`, `/`, `#`, `+`, `.`, `-`, `_`, `~`, `@` are permitted.

This limits command-injection risk when invoking `bun install/uninstall`.

## Filesystem trust boundary

- Plugin code executes in-process when custom tool modules are imported; no sandboxing.
- Manifest relative paths are joined against plugin package directory and only existence-checked.
- The plugin package itself is trusted code once installed.

## Legacy installer-only checks

`installer.ts` includes additional link-time checks not mirrored in `PluginManager.link`:

- local path must resolve inside project cwd
- extra package name/path traversal guards for symlink target naming

Because CLI uses `PluginManager`, these stricter link guards are not currently on the main path.

## Failure, partial success, and rollback behavior

The plugin manager is not transactional.

| Operation stage                                       | Failure behavior           | Rollback                                                                  |
| ----------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------- |
| `bun install` or follow-up git `bun update` fails     | install aborts with stderr | Restores prior `package.json`, `bun.lock`, and package snapshot           |
| Feature or extension validation fails                 | command fails              | Same install rollback                                                     |
| Runtime lockfile write fails                          | command fails              | Same install rollback; rollback failure is appended to the reported error |
| `bun uninstall` succeeds, lockfile write fails        | command fails              | Package removed, stale runtime state may remain                           |
| `link` removes old target then symlink creation fails | command fails              | No restoration of previous link/directory                                 |

Operationally, `doctor --fix` can repair some drift (`bun install`, orphaned config cleanup, invalid-feature cleanup), but it is best-effort.

## Malformed/missing manifest behavior summary

- Missing `omp`/`pi` field:
  - install/list: tolerated (minimal manifest)
  - runtime enabled-plugin discovery: skipped as non-plugin
- Missing feature referenced by install spec or `features --set/--enable`: hard error with available feature list
- Invalid `plugin-overrides.json`: ignored with fallback to `{}` in both manager and loader paths
- Missing tool/hook/command file paths referenced by manifest: silently ignored during resolver expansion; flagged as errors only by `doctor`

## Mode differences and precedence

- `--dry-run` (install): returns a synthetic install result with no `bun install`, no network, and no lockfile/runtime-state writes (it still ensures the plugins `package.json` skeleton exists).
- `--json`: output formatting only, no behavior change.
- Project overrides always take precedence over global lockfile for feature/settings view.
- Effective enablement is `runtimeEnabled && !projectDisabled`.

## Implementation files

- [`src/commands/plugin.ts`](../packages/coding-agent/src/commands/plugin.ts) — CLI command declaration and flag mapping
- [`src/cli/plugin-cli.ts`](../packages/coding-agent/src/cli/plugin-cli.ts) — action dispatch, user-facing command handlers
- [`src/extensibility/plugins/manager.ts`](../packages/coding-agent/src/extensibility/plugins/manager.ts) — active install/remove/list/link/state/doctor implementation
- [`src/extensibility/plugins/installer.ts`](../packages/coding-agent/src/extensibility/plugins/installer.ts) — legacy installer helpers and additional link safety checks
- [`src/extensibility/plugins/loader.ts`](../packages/coding-agent/src/extensibility/plugins/loader.ts) — enabled-plugin discovery and manifest tool/hook/command/extension path resolution
- [`src/extensibility/plugins/parser.ts`](../packages/coding-agent/src/extensibility/plugins/parser.ts) — install spec and package-name parsing helpers
- [`src/extensibility/plugins/types.ts`](../packages/coding-agent/src/extensibility/plugins/types.ts) — manifest/runtime/override type contracts
- [`src/discovery/omp-plugins.ts`](../packages/coding-agent/src/discovery/omp-plugins.ts) — conventional capability discovery for npm/link extension packages
- [`src/task/discovery.ts`](../packages/coding-agent/src/task/discovery.ts) — conventional `agents/` discovery for extension and marketplace plugin roots
- [`src/discovery/claude-plugins.ts`](../packages/coding-agent/src/discovery/claude-plugins.ts) — marketplace-plugin capability discovery
- [`src/extensibility/custom-tools/loader.ts`](../packages/coding-agent/src/extensibility/custom-tools/loader.ts) — runtime wiring for manifest-declared plugin tool modules
- [`src/extensibility/extensions/loader.ts`](../packages/coding-agent/src/extensibility/extensions/loader.ts) — runtime wiring for plugin extension modules
