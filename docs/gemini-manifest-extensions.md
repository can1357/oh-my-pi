# Gemini Manifest Extensions (`gemini-extension.json`)

This document covers how the coding-agent discovers and parses Gemini-style manifest extensions (`gemini-extension.json`) into the `extensions` capability.

It does **not** cover TypeScript/JavaScript extension module loading (`extensions/*.ts`, `index.ts`, `package.json omp.extensions`), which is documented in [Extension Loading](./extension-loading.md).

## Implementation files

- [`packages/coding-agent/src/discovery/gemini.ts`](../packages/coding-agent/src/discovery/gemini.ts)
- [`packages/coding-agent/src/discovery/builtin.ts`](../packages/coding-agent/src/discovery/builtin.ts)
- [`packages/coding-agent/src/discovery/helpers.ts`](../packages/coding-agent/src/discovery/helpers.ts)
- [`packages/coding-agent/src/capability/extension.ts`](../packages/coding-agent/src/capability/extension.ts)
- [`packages/coding-agent/src/capability/extension-module.ts`](../packages/coding-agent/src/capability/extension-module.ts)
- [`packages/coding-agent/src/capability/index.ts`](../packages/coding-agent/src/capability/index.ts)
- [`packages/coding-agent/src/extensibility/extensions/loader.ts`](../packages/coding-agent/src/extensibility/extensions/loader.ts)

---

## What gets discovered

The Gemini provider (`id: gemini`, priority `60`) registers an `extensions` loader that scans two fixed roots:

- User: `~/.gemini/extensions`
- Project: `<cwd>/.gemini/extensions`

Path resolution is direct from `ctx.home` and `ctx.cwd` via `getUserPath()` / `getProjectPath()`.

Important scope rule: project lookup is **cwd-only**. It does not walk parent directories.

---

## Directory scan rules

For each root (`~/.gemini/extensions` and `<cwd>/.gemini/extensions`), discovery does:

1. `readDirEntries(root)`
2. keep only direct child directories (`entry.isDirectory()`)
3. for each child `<name>`, attempt to read exactly:
   - `<root>/<name>/gemini-extension.json`

There is no recursive scan beyond one directory level.

### Hidden directories

Gemini manifest discovery does **not** filter out dot-prefixed directory names. If a hidden child directory exists and contains `gemini-extension.json`, it is considered.

### Missing/unreadable files

If `gemini-extension.json` is missing or unreadable, that directory is skipped silently (no warning).

---

## Manifest shape (as implemented)

The capability type defines this manifest shape:

```ts
interface ExtensionManifest {
  name?: string;
  description?: string;
  mcpServers?: Record<string, Omit<MCPServer, "name" | "_source">>;
  tools?: unknown[];
  context?: unknown;
}
```

Discovery-time behavior is intentionally loose:

- The file must be non-empty and `tryParseJson()` must return a truthy value.
  Invalid JSON and valid JSON literals `null`, `false`, `0`, or `""` therefore
  take the same warning path.
- There is no runtime schema validation for field types/content after that gate.
- The parsed value is stored as `manifest` on the capability item.

### Name normalization

`Extension.name` is set to:

1. `manifest.name` if it is not `null`/`undefined`
2. otherwise the extension directory name

No string-type enforcement is applied here.

---

## Materialization into capability items

A valid parsed manifest creates one `Extension` capability item:

```ts
{
	name: manifest.name ?? <directory-name>,
	path: <extension-directory>,
	manifest: <parsed-json>,
	level: "user" | "project",
	_source: {
		provider: "gemini",
		providerName: "Gemini CLI" // attached by capability registry
		path: <absolute-manifest-path>,
		level: "user" | "project"
	}
}
```

Notes:

- `_source.path` is normalized to an absolute path by `createSourceMeta()`.
- Registry-level capability validation for `extensions` only checks presence of `name` and `path`.
- Manifest internals (`mcpServers`, `tools`, `context`) are not validated during discovery.

---

## Error handling and warning semantics

### Warned

- Invalid JSON, or a syntactically valid falsy JSON literal, in a non-empty
  manifest file:
  - warning format: `Invalid JSON in <manifestPath>`

### Not warned (silent skip)

- `extensions` directory missing
- child directory has no `gemini-extension.json`
- unreadable or empty manifest file
- manifest JSON is truthy but semantically odd/incomplete

This means semantic validity is not enforced; the warning gate is the truthiness
of `tryParseJson()` rather than an `ExtensionManifest` runtime validator.

---

## Precedence and deduplication with other sources

`extensions` capability is aggregated across providers by the capability registry.

Current providers for this capability:

- `native` (`packages/coding-agent/src/discovery/builtin.ts`) priority `100`
- `gemini` (`packages/coding-agent/src/discovery/gemini.ts`) priority `60`

Dedup key is `ext.name` (`extensionCapability.key = ext => ext.name`).

### Cross-provider precedence

Higher-priority provider wins on duplicate extension names.

- If `native` and `gemini` both emit extension name `foo`, the native item is kept.
- Lower-priority duplicate is retained only in `result.all` with `_shadowed = true`.

### Intra-provider order effects

Because dedup is “first seen wins”, provider-local item order matters.

- Gemini loader appends **user first**, then **project**.
- Therefore, duplicate names between `~/.gemini/extensions` and `<cwd>/.gemini/extensions` keep the user entry and shadow the project entry.

By contrast, native provider builds config dir order differently (`project` then `user` in `getConfigDirs()`), so native intra-provider shadowing is the opposite direction.

---

## User vs project behavior summary

For Gemini manifests specifically:

- Both user and project roots are scanned every load.
- Project root is fixed to `<cwd>/.gemini/extensions` (no ancestor walk).
- Duplicate names inside Gemini source resolve to user-first.
- Duplicate names against higher-priority providers (notably native) lose by priority.

---

## Boundary: manifest metadata vs runtime extension modules

`gemini-extension.json` discovery feeds the `extensions` metadata capability. It
does **not** identify a runnable TS/JS entry point.

The Gemini provider separately populates the `extension-module` capability by
scanning the same two extension roots for direct `.ts`/`.js` files,
`<name>/index.ts` / `index.js`, and `package.json` `omp`/`pi` extension entries.
Those module records are independent of `gemini-extension.json`.

The ambient startup path in `discoverExtensionPaths()` currently requests only
the `native` provider, so Gemini-discovered module records are not automatically
executed there. Explicitly configured extension paths can still be loaded.

Practical implication: a Gemini manifest is discoverable metadata, but neither
the manifest itself nor a neighboring module is automatically executed merely
because it appears under `.gemini/extensions`.
