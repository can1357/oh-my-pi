# Extension Loading (TypeScript/JavaScript Modules)

This document covers how the coding agent discovers and loads **extension modules** (`.ts`/`.js`) at startup.

It does **not** cover `gemini-extension.json` manifest extensions (documented separately).

## What this subsystem does

Extension loading builds a list of module entry files, imports each module with Bun, executes its factory, and returns:

- loaded extension definitions
- per-path load errors (without aborting the whole load)
- a shared extension runtime object used later by `ExtensionRunner`

## Primary implementation files

- `src/extensibility/extensions/loader.ts` — path discovery + import/execution
- `src/extensibility/extensions/index.ts` — public exports
- `src/extensibility/extensions/runner.ts` — runtime/event execution after load
- `src/discovery/builtin.ts` — native auto-discovery provider for extension modules
- `src/config/settings.ts` — loads merged `extensions` / `disabledExtensions` settings

---

## Inputs to extension loading

### 1) Auto-discovered native extension modules

`discoverAndLoadExtensions()` first asks discovery providers for `extension-module` capability items, then keeps only provider `native` items.

Native `extension-module` discovery comes from:

- Project directory: `<cwd>/.ompk/extensions`
- User directory: `~/.ompk/agent/extensions`
- Native legacy/settings JSON entries: `<cwd>/.ompk/settings.json#extensions` and `~/.ompk/agent/settings.json#extensions`

The project root is the native provider's `.ompk` directory (`SOURCE_PATHS.native.projectDir`), cwd-only; it does not walk ancestors. The user root is the active profile's agent directory via `getAgentDir()`, so under `oh-my-pk --profile <name>` it becomes `~/.ompk/profiles/<name>/agent/extensions` (and it honors `PI_CODING_AGENT_DIR`). See [Profiles](./config-usage.md#profiles).

Notes:

- Native auto-discovery is currently `.ompk` based.
- Legacy `.pi` is still accepted in package manifests (`pi.extensions`) and project override lookup, but `.pi/extensions` is not a native root here.

### 2) Discovered JS/TS hook factories

After native auto-discovery, `discoverAndLoadExtensions()` also appends JS/TS hook factories from the `hook` capability — any hook whose entry path is a `.ts`/`.js` file — so they load through the same module pipeline.

Hook-capability loading already applies its own hook-specific disabled ids, so these paths are not additionally filtered by `disabledExtensions` extension-module names.

### 3) Installed plugin extension entries

After hook discovery, `discoverAndLoadExtensions()` appends extension entry points from enabled installed plugins via `getAllPluginExtensionPaths(cwd)`.

Plugin extension entries come from package `omp.extensions` / `pi.extensions` manifests, including enabled feature entries.

### 4) Explicitly configured paths

After plugin extension entries, configured paths are appended and resolved.

Configured path sources in the main session startup path (`sdk.ts`):

1. CLI-provided paths (`--extension/-e`, and `--hook` is also treated as an extension path)
2. Merged settings `extensions` array

Settings files:

- User: `~/.ompk/agent/config.yml` (or custom agent dir via `PI_CODING_AGENT_DIR`)
- Project/native settings capability: `<cwd>/.ompk/config.yml` and `<cwd>/.ompk/settings.json`

Native extension-module discovery also reads legacy JSON extension lists from:

- `~/.ompk/agent/settings.json`
- `<cwd>/.ompk/settings.json`

Examples:

```yaml
# ~/.ompk/agent/config.yml
extensions:
  - ~/my-exts/safety.ts
  - ./local/ext-pack
```

```json
{
  "extensions": ["./.ompk/extensions/my-extra"]
}
```

---

## Enable/disable controls

### Disable discovery

- CLI: `--no-extensions`
- SDK option: `disableExtensionDiscovery`

Behavior split:

- SDK: when `disableExtensionDiscovery=true`, it still loads `additionalExtensionPaths` via `loadExtensions()`.
- CLI path building (`main.ts`) currently clears CLI extension paths when `--no-extensions` is set, so explicit `-e/--hook` are not forwarded in that mode.

### Disable specific extension modules

`disabledExtensions` setting filters by extension id format:

- `extension-module:<derivedName>`

`derivedName` is based on entry path (`getExtensionNameFromPath`), for example:

- `/x/foo.ts` -> `foo`
- `/x/bar/index.ts` -> `bar`

Example:

```yaml
disabledExtensions:
  - extension-module:foo
```

### Disable specific context files

Context files are scoped by location, not by file name, so disabling one `AGENTS.md`
leaves same-named files elsewhere active:

- `context-file:<level>:./<path relative to the repo root>` inside a git repo
- `context-file:<level>:~/<path relative to home>` outside a repo but under home
- `context-file:<level>:<absolute path>` otherwise

```yaml
disabledExtensions:
  - context-file:project:./packages/app/AGENTS.md
  - context-file:user:~/.claude/CLAUDE.md
```

Bare-basename ids (`context-file:project:AGENTS.md`) are the superseded form. They
still disable matching files for back-compat, but they match by file name, so they
suppress every same-named context file at that level. Prefer the path-scoped ids.

---

## Path and entry resolution

### Path normalization

For configured paths:

1. Normalize unicode spaces
2. Expand `~`
3. If relative, resolve against current `cwd`

### If configured path is a file

It is used directly as a module entry candidate.

### If configured path is a directory

Resolution order:

1. `package.json` in that directory with `omp.extensions` (or legacy `pi.extensions`) -> use declared entries
2. `index.ts`
3. `index.js`
4. Otherwise scan one level for extension entries:
   - direct `*.ts` / `*.js`
   - subdir `index.ts` / `index.js`
   - subdir `package.json` with `omp.extensions` / `pi.extensions`

Rules and constraints:

- no recursive discovery beyond one subdirectory level
- declared `extensions` manifest entries are resolved relative to that package directory
- declared entries are included only if file exists/access is allowed
- in `*/index.{ts,js}` pairs, TypeScript is preferred over JavaScript
- symlinks are treated as eligible files/directories

### Ignore behavior differs by source

- Native auto-discovery (`discoverExtensionModulePaths` in discovery helpers) uses native glob with `gitignore: true` and `hidden: false`.
- Explicit configured directory scanning in `loader.ts` uses `readdir` rules and does **not** apply gitignore filtering.

---

## Load order and precedence

`discoverAndLoadExtensions()` builds one ordered list and then calls `loadExtensions()`.

Order:

1. Native auto-discovered modules
2. Discovered JS/TS hook factories
3. Installed plugin extension entries
4. Explicit configured paths (in provided order)

In `sdk.ts`, configured order is:

1. CLI additional paths
2. Settings `extensions`

De-duplication:

- absolute path based
- first seen path wins
- later duplicates are ignored

Implication: if the same module path is both auto-discovered and explicitly configured, it is loaded once at the first position (auto-discovered stage).

---

## Module import and factory contract

Each candidate path is loaded via `loadLegacyPiModule()` (`src/extensibility/plugins/legacy-pi-compat.ts`):

- the entry's realpath is resolved, then dynamically imported with an `?mtime` cache-buster so edited source reloads
- a scoped Bun `onLoad` hook rewrites legacy pi-package specifiers (`@mariozechner/*`, `@earendil-works/*`) and bare `@sinclair/typebox` onto the host-bundled copies before evaluation
- factory is selected by `getExtensionFactory(module)`: the module itself if it is a function, otherwise `module.default`
- factory must be a function (`ExtensionFactory`)

If export is not a function, that path fails with a structured error and loading continues.

---

## Failure handling and isolation

### During loading

Per extension path, failures are captured as `{ path, error }` and do not stop other paths from loading.

Common cases:

- import failure / missing file
- invalid factory export (non-function)
- exception thrown while executing factory

### Runtime isolation model

- Extensions are **not sandboxed** (same process/runtime).
- They share one `EventBus` and one `ExtensionRuntime` instance.
- During load, runtime action methods intentionally throw `ExtensionRuntimeNotInitializedError`; action wiring happens later in `ExtensionRunner.initialize()`.

### After loading

When events run through `ExtensionRunner`, handler exceptions are caught and emitted as extension errors instead of crashing the runner loop.

---

## Minimal user/project layout examples

### User-level

```text
~/.ompk/agent/
  config.yml
  extensions/
    guardrails.ts
    audit/
      index.ts
```

### Project-level

```text
<repo>/
  .ompk/
    settings.json
    extensions/
      checks/
        package.json
      lint-gates.ts
```

`checks/package.json`:

```json
{
  "omp": {
    "extensions": ["./src/check-a.ts", "./src/check-b.js"]
  }
}
```

Legacy manifest key still accepted:

```json
{
  "pi": {
    "extensions": ["./index.ts"]
  }
}
```
