# Extension Loading (TypeScript/JavaScript Modules)

This document covers how the coding agent discovers and loads extension modules at startup. Scanned native/configured directories auto-discover `.ts` and `.js`; explicitly named files and installed-plugin manifest entries may also use `.mjs` and `.cjs`.

It does **not** cover [`gemini-extension.json` manifest extensions](./gemini-manifest-extensions.md), which are documented separately.

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
- `src/extensibility/plugins/legacy-pi-compat.ts` — in-place module graph loading and host-package compatibility rewriting
- `src/config/settings.ts` — loads merged `extensions` / `disabledExtensions` settings

---

## Inputs to extension loading

### 1) Auto-discovered native extension modules

`discoverAndLoadExtensions()` first asks discovery providers for `extension-module` capability items, then keeps only provider `native` items.

Native `extension-module` discovery comes from:

- Project directory: `<cwd>/.omp/extensions`
- User directory: the active agent directory's `extensions/` (default `~/.omp/agent/extensions`)
- Native legacy/settings JSON entries: `<cwd>/.omp/settings.json#extensions` and the active agent directory's `settings.json#extensions`

The project root is the native provider's `.omp` directory (`SOURCE_PATHS.native.projectDir`), cwd-only; it does not walk ancestors. The user root is the active profile's agent directory via `getAgentDir()`, so under `omp --profile <name>` it becomes `~/.omp/profiles/<name>/agent/extensions` (and it honors `PI_CODING_AGENT_DIR`). See [Profiles](./config-usage.md#profiles).

Notes:

- Native auto-discovery is currently `.omp` based.
- Legacy `.pi` is still accepted in package manifests (`pi.extensions`) and project override lookup, but `.pi/extensions` is not a native root here.

### 2) Discovered JS/TS hook factories

After native auto-discovery, `discoverAndLoadExtensions()` also appends JS/TS hook factories from the `hook` capability — any hook whose entry path is a `.ts`/`.js` file — so they load through the same module pipeline.

Hook-capability loading already applies its own hook-specific disabled ids, so these paths are not additionally filtered by `disabledExtensions` extension-module names.

### 3) Installed plugin extension entries

After hook discovery, `discoverAndLoadExtensions()` appends extension entry points from enabled installed plugins via `getAllPluginExtensionPaths(cwd)`.

Plugin extension entries come from package `omp.extensions` / `pi.extensions` manifests, including enabled feature entries.

Installed-plugin manifest resolution accepts explicit `.ts`, `.js`, `.mjs`, and `.cjs` files. For a manifest entry that names a directory, it recognizes `index.ts`, `index.js`, `index.mjs`, or `index.cjs`; extension-directory expansion uses the same four suffixes. This is broader than native and configured-directory auto-scanning, which remains limited to `.ts` and `.js`.

### 4) Explicitly configured paths

After plugin extension entries, configured paths are appended and resolved.

Configured path sources in the main session startup path (`sdk.ts`):

1. CLI-provided paths (`--extension/-e`, and `--hook` is also treated as an extension path)
2. Merged settings `extensions` array

Settings files:

- User: the active agent directory's `config.yml` (default `~/.omp/agent/config.yml`; with `--profile <name>`, `~/.omp/profiles/<name>/agent/config.yml`; `PI_CODING_AGENT_DIR` can override the agent directory)
- Project/native settings capability: `<cwd>/.omp/config.yml` and `<cwd>/.omp/settings.json`

Native extension-module discovery also reads legacy JSON extension lists from:

- The active agent directory's `settings.json` (default `~/.omp/agent/settings.json`)
- `<cwd>/.omp/settings.json`

Examples:

```yaml
# ~/.omp/agent/config.yml
extensions:
  - ~/my-exts/safety.ts
  - ./local/ext-pack
```

```json
{
  "extensions": ["./.omp/extensions/my-extra"]
}
```

---

## Enable/disable controls

### Disable discovery

- CLI: `--no-extensions`
- SDK option: `disableExtensionDiscovery`

Behavior split:

- SDK: when `disableExtensionDiscovery=true`, ambient extension factories are
  excluded, while `additionalExtensionPaths` are still resolved normally
  (including package directories with `package.json#omp.extensions`).
- CLI: `--no-extensions` follows the same explicit-only contract. Explicit
  `-e/--extension` and `--hook` paths still load, and only sibling capability
  roots from explicitly named extension packages remain eligible. Project/user
  `extensions:` settings and installed OMP extension packages are excluded from
  that sibling surface.

This flag governs extension factories and OMP extension-package sibling roots;
it is not a whole-process capability-isolation switch. Skills, MCP servers,
tools, prompts, and rules owned by other discovery subsystems retain their own
enable/disable controls.

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

### Disable specific items of other capabilities

`disabledExtensions` is not limited to extension modules. Every capability that
defines `toExtensionId` contributes ids to the same list, and loading filters
them out before the item reaches the session.

Context files use `context-file:<level>:<basename>`, where `<level>` is `user`
or `project`:

```yaml
disabledExtensions:
  - context-file:user:CLAUDE.md
```

The id carries no directory and no depth, so a `project` entry disables files of
that name at every depth the discovery walk reaches. See
[Context files](./context-files.md#disabling-a-single-context-file).

---

## Path and entry resolution

### Path normalization

For configured paths:

1. Normalize Unicode spaces and supported path shorthands (including `file://`, `@/absolute/path`, and a stray `:` before an absolute/relative path)
2. Expand `~`
3. If relative, resolve against current `cwd`
4. Reject the internal `local://` scheme; it must be resolved by its protocol handler, not treated as a filesystem path

### If configured path is a file

It is used directly as a module entry candidate. Explicit `.ts`, `.js`, `.mjs`, and `.cjs` files are supported.

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
- factory must be a function (`ExtensionFactory`) and may return `void` or a promise; loading awaits it before continuing to the next path

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
~/.omp/agent/
  config.yml
  extensions/
    guardrails.ts
    audit/
      index.ts
```

### Project-level

```text
<repo>/
  .omp/
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
