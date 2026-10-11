# Plugin manager and installer plumbing

This document describes how `omp plugin` npm/git/link and marketplace operations mutate plugin state on disk and become runtime capabilities. Marketplace installs keep their own registries and cache, then register the cached plugin through the same `node_modules` and `omp-plugins.lock.json` runtime surfaces used by npm/git/link installs; see `docs/marketplace.md`.

## Scope and architecture

There are two plugin-management implementations in the codebase:

1. **Active path used by CLI commands**: `PluginManager` (`src/extensibility/plugins/manager.ts`)
2. **Legacy helper module**: installer functions (`src/extensibility/plugins/installer.ts`)

`omp plugin` npm/git/link actions go through `PluginManager`; marketplace actions go through `MarketplaceManager`. `install` classifies each target (`classifyInstallTarget` in `cli/classify-install-target.ts`): local paths route to `PluginManager.link()`, and `name@marketplace` routes to the marketplace manager only when the marketplace is configured. Scoped npm specs, common npm dist-tags, and version-like suffixes remain npm targets. Git and npm specs go to `PluginManager.install()`.

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
  -> `claude-plugins` discovery loads legacy marketplace content; `agent-plugins` handles portable skills/MCP for standard root plugin.json packages
  -> task discovery loads `agents/`; extension loader imports `package.json#omp.extensions`
```

### Command entrypoints

- `src/commands/plugin.ts` defines command/flags and forwards to `runPluginCommand`.
- `src/cli/plugin-cli.ts` maps npm/link subcommands to `PluginManager` methods:
  - `install`, `uninstall`, `list`, `link`, `doctor`, `features`, `config`, `enable`, `disable`, and npm/git `upgrade`
- `discover`, marketplace `upgrade`, and `marketplace ...` subcommands use `MarketplaceManager`.
- `upgrade <package-name>` updates an npm/git plugin; a bare name matching one installed marketplace plugin resolves to that marketplace ID instead. Multiple marketplace matches require qualification. `upgrade` without a target upgrades outdated marketplace plugins only.

## On-disk model

User plugin state lives under the plugins data root (`~/.omp/plugins` by default). On Linux and macOS, `omp config init-xdg` initializes the XDG data, state, and cache roots but does not move existing plugin trees. With `XDG_DATA_HOME` set and its `omp/` directory initialized, default-profile state resolves under `$XDG_DATA_HOME/omp/plugins`. Named profiles use their own roots and require a profile-specific XDG directory to opt into that routing. The marketplace registry helper separately copies a legacy `marketplaces.json` best-effort when its XDG target is absent.

The plugin root contains:

- `package.json` — dependency manifest used by `bun install`/`bun uninstall` for npm-installed plugins
- `node_modules/` — installed npm packages plus link and marketplace-cache symlinks
- `omp-plugins.lock.json` — runtime state for npm/link/marketplace plugins:
  - enabled/disabled per plugin
  - selected feature set per plugin
  - persisted plugin settings

Project-root resolution first walks upward for the nearest `.omp/`; only when none exists does it use the nearest `.git` anchor. Project runtime plugins live in `<anchor>/.omp/plugins/{node_modules,omp-plugins.lock.json}`. Explicit marketplace project installs can create `<cwd>/.omp/plugins/` when neither anchor exists (except when cwd is home). Enabled project packages shadow user packages with the same package name; disabled project packages do not. npm/git/link CLI operations remain user-scoped; their install handler warns and ignores `--scope`.

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

Non-GitHub `https://`/`ssh://` specs are passed to bun with a `git+` prefix (bun only auto-detects git for GitHub-hosted URLs, so without it the spec is misread as an npm tarball); GitHub specs are forwarded unchanged. Inline userinfo credentials (`https://user:token@host/group/repo.git`) are stripped from those `git+` specs: `bun install` persists the spec verbatim into `plugins/package.json` and `bun.lock`, and a long-lived repository token must not land in those user files. Private repositories authenticate via SSH, a git credential helper, or `.netrc` instead — bun honors all of them natively.

`extractPackageName` strips an optional `npm:` prefix and version suffix for on-disk path lookup after install.

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
4. Run `bun install --no-cache <packageSpec>` for npm, or `bun install <gitSpec>` for Git, in the user plugins directory; `--force` is forwarded when requested. Reinstalls prune stale dependency entries first. Reinstalling an existing Git plugin also refreshes Bun's matching Git cache and runs `bun update <resolved-name>` to refresh the lockfile revision.
5. Resolve the installed package name (npm: strip version via `extractPackageName`; git: diff `dependencies` before/after) and read `node_modules/<name>/package.json`.
6. Resolve manifest and compute `enabledFeatures`:
   - `[*]`: all declared features (or `null` if no feature map)
   - `[a,b]`: validates each feature when a manifest features map exists; without a map the names are retained without validation
   - `[]`: empty feature list
   - bare spec: `null` (use defaults policy later in loader)
7. Validate declared extension entries (`#validateInstalledExtensions`): each manifest `extensions` entry must resolve on disk, import to a factory function, and initialize successfully against a throwaway registration surface. On failure, roll back the install — restore the previous `plugins/package.json`, remove the freshly installed package, and restore any prior version from a backup taken before `bun install` — then abort.
8. Upsert lockfile runtime state: `{ version, enabledFeatures, enabled: true }`.

### Update semantics

- `omp plugin install pkg@newVersion` updates the dependency and runtime version. A plain reinstall resets enablement to true and feature selection to defaults unless explicitly supplied; settings remain in the separate settings map.
- `omp plugin upgrade <package-name>` uses the source recorded in `plugins/package.json`: npm moves to the latest published version, while Git re-resolves its recorded ref. It preserves enablement and feature selection, removing selected features absent from a new feature map. Local links and `file:`/`link:`/`workspace:`/`portal:` dependencies have nothing to upgrade and are rejected.
- Upgrade compares both package version and Bun lockfile resolution, so a moving Git ref can report a changed revision without a version bump.
- Install snapshots the prior package tree, `package.json`, and `bun.lock`. Failure during installation, feature/extension validation, or runtime-config save attempts to restore all three.
- No separate npm-plugin startup update check or migration action exists.

## Remove flow (`PluginManager.uninstall`)

1. Validate package name.
2. Run `bun uninstall <name>` in plugin dir.
3. Explicitly remove `node_modules/<name>` after success, including links absent from the dependency manifest.
4. Remove plugin runtime state from lockfile:
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

`PluginManager.getPlugin()` resolves one runtime package directly, including marketplace symlinks intentionally omitted from `list()`. An explicit trusted path wins; otherwise an enabled project package shadows the user package. Config commands use this path for manifest/schema lookup, while settings reads/writes still use the user lockfile plus read-only project overrides. `config validate` includes marketplace packages without duplicating marketplace entries in list/status output.

## Link flow (`PluginManager.link`)

`link` supports local plugin development by symlinking a local package into `~/.omp/plugins/node_modules/<pkg.name>`.

Behavior:

1. Resolve `localPath` against manager cwd.
2. Require local `package.json` and a `name` accepted by the manager's package-name validation.
3. Ensure plugin dirs exist.
4. For scoped names, create scope directory.
5. Remove existing path at target link location.
6. Create a directory symlink (a junction on Windows).
7. Add runtime lockfile entry enabled with default features (`null`).

Caveat: `PluginManager.link` validates the package name but does not restrict the source to cwd as legacy `installer.ts` does. Relative paths resolve against manager cwd; tilde expansion is the shell/caller's responsibility.

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
- when the root has a dependency manifest, skip a lockfile-only entry unless its `node_modules` path is a symlink (links and marketplace registration remain valid)
- skip unreadable roots or individual plugin packages with a warning on `EACCES`/`EPERM`; malformed JSON still propagates

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

Manifest entries may point to a file. Tool/hook/command directories require a direct `index.ts`, `index.js`, `index.mjs`, or `index.cjs`. Extension directories instead use this precedence: their own `package.json` `omp`/`pi.extensions`, then a direct index, then a sorted one-level scan of module files and child directories with indexes. Declaration files are excluded from that scan. Missing paths are omitted during runtime resolution; enabled declared extension entries are validated during install.

## Current runtime wiring

- Manifest-declared **tools** feed `discoverAndLoadCustomTools` through `getAllPluginToolPaths(cwd)`.
- Manifest-declared **extensions** feed `discoverAndLoadExtensions` through `getAllPluginExtensionPaths(cwd)`.
- The `omp-plugins` capability provider separately scans conventional `skills/`, `hooks/pre|post/`, `tools/`, `commands/`, `rules/`, `prompts/`, and `.mcp.json`/`mcp.json` under enabled npm/link plugin roots. Task-agent discovery scans the same roots' `agents/`. Marketplace roots are excluded there and handled through `claude-plugins` plus marketplace task-agent discovery instead.
- Packages whose root `plugin.json` targets Agent Plugins 1.0.0 use `agent-plugins` for portable `skills/` and root `mcp.json`, from both marketplace and extension-package roots. Legacy providers skip those two surfaces but can still load client-specific content from hybrid packages; fatally invalid standard manifests suppress legacy discovery.
- Manifest hook/command path resolvers remain exported, but runtime hook/slash discovery uses the conventional capability-provider scans rather than `getAllPluginHookPaths()` or `getAllPluginCommandPaths()`.
- Direct custom-tool and extension path lists are de-duplicated by resolved absolute path (`seen`, first path wins).

## Lock/state management details

`PluginManager` caches runtime config in memory per instance (`#runtimeConfig`) and lazily loads once.

Manager load behavior:

- lockfile missing -> `{ plugins: {}, settings: {} }`
- lockfile read/parse failure -> warning + the same empty defaults

Enabled-plugin discovery loads each user/project root independently: a missing lockfile is empty, access-denied roots are skipped with a warning, and other read/parse failures propagate. Its per-cwd/home promise cache is cleared by plugin cache invalidation.

Save behavior:

- writes full lockfile JSON pretty-printed each mutation

No cross-process locking or merge strategy exists; concurrent writers can overwrite each other.

## Safety checks and trust boundaries

## Input/package validation

Active manager path enforces package-name validation:

- npm specs: `VALID_PACKAGE_NAME` checks the dependency name after stripping `npm:` and the version suffix; it is not a full version/range validator.
- npm shell-metacharacter denylist: `;`, `&`, `|`, backtick, `$`, `(`, `)`, `{`, `}`, `[`, `]`, `<`, `>`, `\` — applied after `parsePluginSpec` strips the feature brackets, so a normal `pkg[feat]` spec never reaches it.
- git specs: `validateGitSpec` rejects only the shared `SHELL_METACHARS` set (`;`, `&`, `|`, backtick, `$`, `(`, `)`, `{`, `}`, `<`, `>`, `\`, newline, CR, tab) instead of the npm regex, so `:`, `/`, `#`, `+`, `.`, `-`, `_`, `~`, `@` are permitted.

This limits command-injection risk when invoking `bun install/uninstall`.

## Filesystem trust boundary

- Plugin code executes in-process when custom tool modules are imported; no sandboxing.
- Manifest relative paths are joined against plugin package directory and only existence-checked.
- The plugin package itself is trusted code once installed.

## Legacy installer-only checks

`installer.ts` restricts a linked source path to project cwd and applies its own package-name/path checks. `PluginManager.link` applies active package-name validation instead, but permits source paths outside cwd. The legacy cwd restriction is not on the CLI path.

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
- Unknown feature referenced by install spec or feature mutation: hard error with available feature list when the manifest declares a feature map; without a map, names can be retained without validation
- Invalid or unreadable `plugin-overrides.json`: logged with its path and error, then ignored with fallback to the next project config path or `{}`. Missing files remain silent.
- Missing tool/hook/command file paths referenced by manifest: silently ignored during resolver expansion; flagged as errors only by `doctor`

## Mode differences and precedence

- `--dry-run` (install): returns a synthetic install result with no `bun install`, no network, and no lockfile/runtime-state writes (it still ensures the plugins `package.json` skeleton exists).
- `--dry-run` for local link/install paths prints a preview without reading the package; marketplace install/uninstall previews perform local validation without mutation. Other actions do not necessarily consume this flag.
- `--json`: requested output formatting, not a transactional guarantee; marketplace mutation handlers do not all emit JSON.
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
- [`src/discovery/agent-plugins.ts`](../packages/coding-agent/src/discovery/agent-plugins.ts) — portable Agent Plugins skills and MCP discovery
- [`src/extensibility/extensions/directory-resolution.ts`](../packages/coding-agent/src/extensibility/extensions/directory-resolution.ts) — shared extension-directory precedence
- [`src/extensibility/custom-tools/loader.ts`](../packages/coding-agent/src/extensibility/custom-tools/loader.ts) — runtime wiring for manifest-declared plugin tool modules
- [`src/extensibility/extensions/loader.ts`](../packages/coding-agent/src/extensibility/extensions/loader.ts) — runtime wiring for plugin extension modules
