# Extension Loading (TypeScript/JavaScript Modules)

This document covers how the coding agent discovers and loads extension modules at startup. Scanned native/configured directories auto-discover `.ts` and `.js`; explicitly named files and installed-plugin manifest entries may also use `.mjs` and `.cjs`.

It does **not** cover [`gemini-extension.json` manifest extensions](./gemini-manifest-extensions.md), which are documented separately.

## What this subsystem does

Extension loading builds an ordered list of module entry files, imports the modules concurrently with Bun, then binds their factories sequentially in path order. It returns:

- loaded extension definitions
- per-path import/factory errors (without aborting the other module loads)
- a shared extension runtime object used later by `ExtensionRunner`
- prepared factories that can be rebound to a fresh session without re-evaluating the module graph

## Primary implementation files

- `src/extensibility/extensions/loader.ts` — path discovery + import/execution
- `src/extensibility/extensions/directory-resolution.ts` — shared configured/plugin manifest and directory precedence
- `src/extensibility/extensions/index.ts` — public exports
- `src/extensibility/extensions/runner.ts` — runtime/event execution after load
- `src/discovery/builtin.ts` — native auto-discovery provider for extension modules
- `src/extensibility/plugins/legacy-pi-compat.ts` — in-place module graph loading and host-package compatibility rewriting
- `src/config/settings.ts` — loads merged `extensions` / `disabledExtensions` settings
- `src/sdk.ts` — session-specific discovery, prepared-factory rebinding, and live source reconciliation
- `src/discovery/omp-extension-roots.ts` — sibling capability roots from extension packages

---

## Inputs to extension loading

### 1) Auto-discovered native extension modules

`discoverExtensionPaths()` loads the `extension-module` capability with a `providers: ["native"]` filter. Foreign extension-module providers are not scanned by this loader.

Native `extension-module` discovery comes from:

- Project directory: `<cwd>/.omp/extensions`
- User directory: the active agent directory's `extensions/` (default `~/.omp/agent/extensions`)
- Native legacy/settings JSON entries: `<cwd>/.omp/settings.json#extensions` and the active agent directory's `settings.json#extensions`

The project root is the native provider's `.omp` directory (`SOURCE_PATHS.native.projectDir`), cwd-only; it does not walk ancestors. Native discovery uses its `LoadContext.agentDir` when supplied, otherwise `getAgentDir()`. With the default user config root, `omp --profile <name>` selects `~/.omp/profiles/<name>/agent/extensions`. `PI_CONFIG_DIR` changes that user config root; `PI_CODING_AGENT_DIR` overrides the agent directory only in the default profile, not named profiles. See [Profiles](./config-usage.md#profiles).

Notes:

- Native auto-discovery is currently `.omp` based.
- Legacy `.pi` is still accepted in package manifests (`pi.extensions`) and project override lookup, but `.pi/extensions` is not a native root here.

### 2) Discovered JS/TS hook factories

After native auto-discovery, `discoverAndLoadExtensions()` also appends JS/TS hook factories from the `hook` capability — any hook whose entry path is a `.ts`/`.js` file — so they load through the same module pipeline. The native provider discovers these under `<cwd>/.omp/hooks/pre|post/` and `<agentDir>/hooks/pre|post/` only; see [Hooks: native discovery location](./hooks.md#native-discovery-location) for the required `pre/`/`post/` layout.

Hook-capability loading already applies its own hook-specific disabled ids, so these paths are not additionally filtered by `disabledExtensions` extension-module names.

### 3) Installed plugin extension entries

After hook discovery, `discoverAndLoadExtensions()` appends extension entry points from enabled installed plugins via `getAllPluginExtensionPaths(cwd)`.

Plugin extension entries come from package `omp.extensions` / `pi.extensions` manifests, including enabled feature entries.

Installed-plugin manifest resolution accepts explicit `.ts`, `.js`, `.mjs`, and `.cjs` files. For a manifest entry that names a directory, it recognizes `index.ts`, `index.js`, `index.mjs`, or `index.cjs`; extension-directory expansion uses the same four suffixes. This is broader than native and configured-directory auto-scanning, which remains limited to `.ts` and `.js`.

Installed-plugin extension directory resolution uses the directory's own
non-empty `omp.extensions` / `pi.extensions` manifest first, then a direct index,
then a sorted one-level scan. That scan skips declaration files
(`*.d.ts`, `*.d.mts`, `*.d.cts`); explicitly declared file entries are not
suffix-filtered.

### 4) Explicitly configured paths

After plugin extension entries, configured paths are appended and resolved.

Configured path sources in the main session startup path (`sdk.ts`):

1. CLI-provided paths (`--extension/-e`, and `--hook` is also treated as an extension path)
2. Effective settings `extensions` array (settings layers replace arrays rather than concatenate them)

Native settings files:

- User: the active agent directory's `config.yml`, with `config.yaml` as a fallback (default root `~/.omp/agent`; named profiles use `~/.omp/profiles/<name>/agent`). Agent-directory overrides follow the profile rules above.
- Project/native settings capability: `<cwd>/.omp/config.yml` and `<cwd>/.omp/settings.json`

Other enabled settings providers and `--config` overlays can also supply the
effective `extensions` value. See [Settings](./config-usage.md).

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

### Exact module allowlist

CLI `--trusted-extension <absolute-file>` is repeatable and loads only those
extension module files, bypassing discovery and package-directory expansion.
Paths must be absolute, existing files; symlinks are resolved before loading.
It cannot be combined with `-e`/`--extension` or `--hook`. A load failure aborts
startup rather than silently dropping an allowlisted module.

Unlike an explicit extension package directory, an allowlisted file does not
authorize sibling hooks, tools, commands, skills, rules, prompts, or MCP config.
This is still an in-process module allowlist, not a sandbox or a switch disabling
other discovery subsystems.

### Disable specific extension modules

For ambient extension modules, installed-plugin entries, and entries expanded
from configured directories, `disabledExtensions` filters by extension id format:

- `extension-module:<derivedName>`

`derivedName` is based on entry path (`getExtensionNameFromPath`), for example:

- `/x/foo.ts` -> `foo`
- `/x/bar/index.ts` -> `bar`

Example:

```yaml
disabledExtensions:
  - extension-module:foo
```

An explicitly configured file path bypasses this name filter. Explicit-only
sessions (`--no-extensions` / `disableExtensionDiscovery`) also omit the settings
disable list entirely.

### Live source changes

In the main session, changes to `extensions` or `disabledExtensions` suspend or
resume already-loaded, settings-governed sources: their handlers, commands,
tools, renderers, shortcuts, flags, and file fallbacks stop or resume
participating. A suspended override of a built-in tool restores the native tool.
Modules are not unloaded or re-evaluated, and newly enabled modules that were
not imported at startup require a restart. Inline and caller-preloaded sources
outside the governed discovery set are left alone. Explicit-only sessions ignore
these settings changes.

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
4. Reject schemes handled by the internal URL router (including `local://`); they must be resolved by their protocol handler, not treated as filesystem paths

### If configured path is a file

It is used directly as a module entry candidate. Explicit `.ts`, `.js`, `.mjs`, and `.cjs` files are supported.

### If configured path is a directory

Resolution order:

1. `package.json` in that directory with a non-empty `omp.extensions` (or legacy `pi.extensions`) array -> use declared entries
2. `index.ts`
3. `index.js`
4. Otherwise scan one level for extension entries:
   - direct `*.ts` / `*.js`
   - subdir `index.ts` / `index.js`
   - subdir `package.json` with `omp.extensions` / `pi.extensions`

Rules and constraints:

- no recursive discovery beyond one subdirectory level
- declared `extensions` manifest entries are resolved relative to that package directory
- a non-empty declared array is authoritative: convention-based index/scan fallback stays suppressed even when every declared entry is missing
- `omp` takes precedence over `pi` when both manifest objects exist
- missing or inaccessible declared entries are skipped individually, so existing entries in a partially missing manifest still load
- in `*/index.{ts,js}` pairs, TypeScript is preferred over JavaScript
- symlinks are treated as eligible files/directories

### Ignore behavior differs by source

- Native auto-discovery (`discoverExtensionModulePaths` in discovery helpers) uses native glob with `gitignore: true` and `hidden: false`.
- Explicit configured directory scanning in `loader.ts` uses `readdir` rules and does **not** apply gitignore filtering.

---

## Load order and precedence

`discoverAndLoadExtensions()` composes `discoverExtensionPaths()` and `loadExtensions()`.
The SDK normally discovers paths first and can reuse imported/prepared factories
for child sessions.

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

De-duplication does not use realpaths: different symlink spellings can remain
distinct discovery entries. Module evaluation runs concurrently, so top-level
module side effects have no path-order guarantee. Factory invocation and
registration remain sequential in the discovered order.

---

## Module import and factory contract

Each candidate path is loaded via `loadLegacyPiModule()` (`src/extensibility/plugins/legacy-pi-compat.ts`):

- the entry's realpath is resolved, then dynamically imported with a per-load `?mtime` cache-buster. On POSIX the loader uses filesystem-path specifiers, and the same tag propagates through extension-owned relative imports, package `imports` aliases (`#alias/*`), and extension-local dependencies so same-process re-imports pick up graph edits. Windows uses `file://` specifiers, whose query strings Bun currently ignores, so the same reload guarantee does not apply there. Host-resolved rewrites (pi-package specifiers and the TypeBox shim) stay untagged because they point at in-process host code
- a scoped Bun `onLoad` hook rewrites legacy pi-package specifiers (`@mariozechner/*`, `@earendil-works/*`) and bare `@sinclair/typebox` onto the host-bundled copies before evaluation. Legacy Pi package-root imports resolve through compat shims: catalog symbols that moved to `@oh-my-pi/pi-catalog/models` (`calculateCost`, `modelsAreEqual`, `getBundledProviders`, plus `getModel`/`getModels` aliases) are re-exported by the legacy pi-ai shim (`src/extensibility/legacy-pi-ai-shim.ts`), and legacy `@oh-my-pi/pi-coding-agent` imports — including `DefaultResourceLoader` — resolve to the compat loader in `src/extensibility/legacy-pi-coding-agent-shim.ts`
- graph-owned CommonJS modules use synchronous Bun `onLoad` object modules exposing runtime own-string export keys, including computed and non-enumerable names; `default` remains the complete `module.exports` value. The shared evaluator preserves cycles and `require`/import identity, while required host ESM shims are prepared before synchronous evaluation. No generated facade files or AST named-export reconstruction are needed
- bundled host modules use Bun's native object loader. Modules exporting `theme` add a thin ESM binding bridge so the existing `theme` import follows host assignments synchronously without replacing the UI's change listener
- package `imports` and `exports` patterns prefer the longest prefix before `*`, then the longest complete pattern; exact matches take precedence and excluded targets never fall back to broader patterns
- factory is selected by `getExtensionFactory(module)`: the module itself if it is a function, otherwise `module.default`
- factory must be a function (`ExtensionFactory`) and may return `void` or a promise; loading awaits it before continuing to the next path

If export is not a function, that path fails with a structured error and loading continues.

---

## Failure handling and isolation

### During loading

Per extension path, import and factory failures are captured as `{ path, error }`
and do not stop other paths from loading. A failed factory's changes to the shared
pending provider-registration queue are rolled back. Discovery itself is not
covered by this per-module error result: unexpected filesystem or plugin
enumeration errors can reject path collection before imports begin.

Imports and file-backed factory calls run under `withHostGuard()`: load-time
`process.exit` / `process.reallyExit` calls throw `ExtensionExitError`, and stdin
listeners plus paused/raw input state are restored to their pre-load snapshot. This protects host startup, not arbitrary runtime extension code.

Common cases:

- import failure / missing file
- invalid factory export (non-function)
- exception thrown while executing factory

### Restricted children and revival

Restricted task/eval children rebind the parent's already-imported extension
factories to their own session. Hooks and providers remain available without
ambient extension discovery. Extension tools cannot widen the restricted tool
set or replace built-ins, including through late registration. New extension
paths, loaded parent-bound instances, and additional inline factories remain
excluded.

Revived children inherit the current owning session's extension roots and
prepared factories, not extension authority from a saved transcript. Cold
discovery without prepared factories respects the owner's explicit-only or
merged roots.

Extension factories still execute host code when rebound; tool restrictions are
not an extension sandbox. Existing per-module load-failure handling is unchanged.

### Runtime isolation model

- Extensions are **not sandboxed** (same process/runtime).
- They share one `EventBus` and one `ExtensionRuntime` instance.
- During load, runtime action methods intentionally throw `ExtensionRuntimeNotInitializedError`; action wiring happens later in `ExtensionRunner.initialize()`.

### After loading

When events run through `ExtensionRunner`, handler exceptions are caught and
emitted as extension errors instead of crashing the runner loop. Most dispatched
handlers have a 30-second budget; `session_shutdown` handlers run concurrently
with a 2-second budget. `tool_call` uses
`extensionHandlers.toolCallTimeoutMs` (default 30,000 ms), pauses that budget while
waiting for extension UI dialogs, and fails closed on an error or timeout. An
extension may request a different budget for one of its own events via
`pi.setHandlerTimeout`; the host clamps the request to `extensionHandlers.timeoutMs`
(default 30,000 ms), so raising a budget requires user configuration — the same key
also raises the budget of handlers that made no request, except `session_shutdown`
and `tool_call`, which keep their dedicated caps. Only `tool_call` pauses its budget
for dialog waits.
Raw detached callbacks remain outside this isolation; use the managed timers
described in [Extensions](./extensions.md#background-work-ctxsetinterval--ctxsettimeout).

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
