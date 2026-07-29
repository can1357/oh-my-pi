/**
 * Plugin loader - discovers and loads manifest entry points from installed plugins.
 *
 * Reads enabled plugins from the runtime config and loads their
 * tools/hooks/extensions/commands based on manifest entries and enabled features.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { getPluginsLockfile, getPluginsNodeModules, getPluginsPackageJson, isEnoent } from "@pk-nerdsaver-ai/pi-utils";
import { getConfigDirPaths } from "../../config";
import { resolveActiveProjectRegistryPath } from "../../discovery/helpers";
import { installLegacyPiSpecifierShim } from "./legacy-pi-compat";
import { readSupportedPluginManifest } from "./manifest";
import { normalizePluginRuntimeConfig } from "./runtime-config";
import type { InstalledPlugin, PluginManifest, PluginRuntimeConfig, ProjectPluginOverrides } from "./types";

installLegacyPiSpecifierShim();

// =============================================================================
// Runtime Config Loading
// =============================================================================

/**
 * Load plugin runtime config from lock file.
 *
 * `home` controls which `<plugins>/omp-plugins.lock.json` is read — pass it
 * through whenever the caller is loading plugins for a tempdir-rooted
 * scenario (tests, discovery sub-surfaces that need to mirror an alternate
 * `LoadContext.home`).
 */
async function loadRuntimeConfig(home?: string): Promise<PluginRuntimeConfig> {
	return loadRuntimeConfigAt(getPluginsLockfile(home));
}

async function loadRuntimeConfigAt(lockPath: string): Promise<PluginRuntimeConfig> {
	try {
		return normalizePluginRuntimeConfig(await Bun.file(lockPath).json());
	} catch (err) {
		if (isEnoent(err)) return normalizePluginRuntimeConfig({});
		throw err;
	}
}

/**
 * Load project-local plugin overrides (checks .ompk and .pi directories).
 */
async function loadProjectOverrides(cwd: string): Promise<ProjectPluginOverrides> {
	for (const overridesPath of getConfigDirPaths("plugin-overrides.json", { user: false, cwd })) {
		try {
			return await Bun.file(overridesPath).json();
		} catch (err) {
			if (isEnoent(err)) continue;
			// JSON parse error - continue to next path
		}
	}
	return {};
}
/**
 * Get list of enabled plugins with their resolved configurations.
 *
 * Respects both global runtime config and project overrides. Iterates the
 * union of `<plugins>/package.json#dependencies` (`bun install`-installed
 * packages) and `<plugins>/omp-plugins.lock.json#plugins` (so locally
 * `plugin link`-symlinked extensions, which never get a dependency entry,
 * are still discovered). The optional `home` parameter pins the plugins
 * root for callers that need to enumerate plugins relative to a non-default
 * home (tests with a tempdir, discovery loaders threaded with
 * `LoadContext.home`).
 */
export async function getEnabledPlugins(cwd: string, opts: { home?: string } = {}): Promise<InstalledPlugin[]> {
	const { home } = opts;

	interface PluginRootPaths {
		scope: "user" | "project";
		nodeModulesPath: string;
		pkgJsonPath: string;
		lockPath: string;
	}

	// Project-scope installs live under the nearest project's `<config>/plugins`
	// root (resolved the same way the marketplace installer picks its project
	// registry) and shadow user-scope installs of the same name.
	const roots: PluginRootPaths[] = [];
	const projectRegistryPath = await resolveActiveProjectRegistryPath(cwd);
	if (projectRegistryPath) {
		const projectPluginsDir = path.dirname(projectRegistryPath);
		roots.push({
			scope: "project",
			nodeModulesPath: path.join(projectPluginsDir, "node_modules"),
			pkgJsonPath: path.join(projectPluginsDir, "package.json"),
			lockPath: path.join(projectPluginsDir, "omp-plugins.lock.json"),
		});
	}
	roots.push({
		scope: "user",
		nodeModulesPath: getPluginsNodeModules(home),
		pkgJsonPath: getPluginsPackageJson(home),
		lockPath: getPluginsLockfile(home),
	});

	const projectOverrides = await loadProjectOverrides(cwd);
	const plugins: InstalledPlugin[] = [];
	const seen = new Set<string>();

	for (const root of roots) {
		if (!fs.existsSync(root.nodeModulesPath)) {
			continue;
		}

		let depsKeys: string[] = [];
		try {
			const pkg: { dependencies?: Record<string, string> } = await Bun.file(root.pkgJsonPath).json();
			depsKeys = Object.keys(pkg.dependencies ?? {});
		} catch (err) {
			// Linked-only setups may have no `<plugins>/package.json` yet — that's
			// fine, the lockfile still records the link.
			if (!isEnoent(err)) throw err;
		}

		const runtimeConfig = await loadRuntimeConfigAt(root.lockPath);

		// Union: dependencies (npm/marketplace installs) ∪ runtime-config plugins
		// (links + already-recorded installs). Set preserves first-seen order,
		// putting deps before link-only entries for deterministic output.
		const names = new Set<string>(depsKeys);
		for (const name of Object.keys(runtimeConfig.plugins ?? {})) {
			names.add(name);
		}

		for (const name of names) {
			if (seen.has(name)) {
				continue;
			}
			const pluginPath = path.join(root.nodeModulesPath, name);
			const pluginPkgPath = path.join(pluginPath, "package.json");
			let pluginPkg: { version: string; omp?: PluginManifest; pi?: PluginManifest };
			try {
				pluginPkg = await Bun.file(pluginPkgPath).json();
			} catch (err) {
				// Lockfile entry without a corresponding node_modules tree means the
				// link was deleted out from under us; skip silently.
				if (isEnoent(err)) continue;
				throw err;
			}

			const manifest = await readSupportedPluginManifest(pluginPath, pluginPkg);
			if (!manifest) {
				// Not an OMP/Pi-compatible plugin, skip. Codex plugins with
				// `.codex-plugin/plugin.json` are accepted for sub-discovery parity.
				continue;
			}

			const runtimeState = runtimeConfig.plugins[name];

			// Check if disabled globally
			if (runtimeState && !runtimeState.enabled) {
				continue;
			}

			// Check if disabled in project
			if (projectOverrides.disabled?.includes(name)) {
				continue;
			}

			// Resolve enabled features (project overrides take precedence)
			const enabledFeatures = projectOverrides.features?.[name] ?? runtimeState?.enabledFeatures ?? null;
			seen.add(name);
			plugins.push({
				name,
				version: pluginPkg.version,
				path: pluginPath,
				manifest,
				enabledFeatures,
				enabled: true,
				scope: root.scope,
			});
		}
	}

	return plugins;
}

// =============================================================================
// Path Resolution
// =============================================================================

const MANIFEST_ENTRY_MODULE_EXTENSIONS = [".ts", ".js", ".mjs", ".cjs"];
const MANIFEST_ENTRY_INDEX_NAMES = MANIFEST_ENTRY_MODULE_EXTENSIONS.map(ext => `index${ext}`);

/** `.d.ts` / `.d.mts` / `.d.cts` TypeScript declaration files — never loadable as modules. */
const DECLARATION_FILE_RE = /\.d\.[mc]?ts$/;

/** A loadable module file: a .ts/.js/.mjs/.cjs that is not a declaration file. */
function isModuleFile(name: string): boolean {
	return MANIFEST_ENTRY_MODULE_EXTENSIONS.includes(path.extname(name)) && !DECLARATION_FILE_RE.test(name);
}

/** First `index.{ts,js,mjs,cjs}` inside `dir`, or null when none exists. */
function findDirectoryIndex(dir: string): string | null {
	for (const name of MANIFEST_ENTRY_INDEX_NAMES) {
		const candidate = path.join(dir, name);
		if (fs.existsSync(candidate)) return candidate;
	}
	return null;
}

interface DeclaredManifestEntries {
	/** True when the directory's package.json declares a non-empty `omp`/`pi` `extensions` array. */
	declared: boolean;
	/** Resolved, existing module files for the declared entries (may be empty when declared files are missing). */
	files: string[];
}

/**
 * Read the extension entries declared by `dir`'s own package.json `omp`/`pi`
 * manifest. `declared` distinguishes "a manifest explicitly lists extensions"
 * (authoritative — callers must not fall back to index/scan, so a missing
 * declared file surfaces as a missing entry instead of silently loading a stale
 * index) from "no manifest / no extensions field" (callers fall back to
 * convention). Mirrors the manifest branch of the configured-directory (`-e`)
 * scanner: a declared entry that is a file resolves to itself; one that is a
 * directory resolves to its direct index.{ts,js,mjs,cjs}.
 */
function readDeclaredManifestEntries(dir: string): DeclaredManifestEntries {
	let raw: string;
	try {
		raw = fs.readFileSync(path.join(dir, "package.json"), "utf8");
	} catch {
		return { declared: false, files: [] };
	}
	let pkg: { omp?: { extensions?: unknown }; pi?: { extensions?: unknown } };
	try {
		pkg = JSON.parse(raw) as { omp?: { extensions?: unknown }; pi?: { extensions?: unknown } };
	} catch {
		return { declared: false, files: [] };
	}
	const declared = (pkg.omp ?? pkg.pi)?.extensions;
	if (!Array.isArray(declared) || declared.length === 0) {
		return { declared: false, files: [] };
	}
	const files: string[] = [];
	for (const entry of declared) {
		if (typeof entry !== "string") continue;
		const candidate = path.resolve(dir, entry);
		let candidateStats: fs.Stats;
		try {
			candidateStats = fs.statSync(candidate);
		} catch {
			continue;
		}
		if (candidateStats.isDirectory()) {
			const index = findDirectoryIndex(candidate);
			if (index) files.push(index);
		} else {
			files.push(candidate);
		}
	}
	return { declared: true, files };
}

/**
 * Resolve a directory to its loadable extension module files, mirroring the
 * configured-directory (`-e`) scanner in extensions/loader.ts:
 *   1. the directory's own package.json `omp`/`pi` `extensions` entries —
 *      authoritative: a manifest that lists extensions suppresses the index/scan
 *      fallback, so a missing declared file is reported rather than silently
 *      replaced by a decoy index
 *   2. a direct index.{ts,js,mjs,cjs}
 *   3. one level of children: each direct *.{ts,js,mjs,cjs} file plus each
 *      sub-directory resolved by the same precedence (manifest, then index)
 */
function resolveDirectoryEntries(dir: string): string[] {
	const manifest = readDeclaredManifestEntries(dir);
	if (manifest.declared) return manifest.files;

	const directIndex = findDirectoryIndex(dir);
	if (directIndex) return [directIndex];

	let children: string[];
	try {
		children = fs.readdirSync(dir);
	} catch {
		return [];
	}
	const resolved: string[] = [];
	for (const child of children.sort()) {
		const childPath = path.join(dir, child);
		let childStats: fs.Stats;
		try {
			// statSync follows symlinks, matching the configured-dir loader.
			childStats = fs.statSync(childPath);
		} catch {
			continue;
		}
		if (childStats.isDirectory()) {
			const childManifest = readDeclaredManifestEntries(childPath);
			if (childManifest.declared) {
				resolved.push(...childManifest.files);
			} else {
				const index = findDirectoryIndex(childPath);
				if (index) resolved.push(index);
			}
		} else if (isModuleFile(child)) {
			resolved.push(childPath);
		}
	}
	return resolved;
}

/**
 * Resolve a plugin manifest entry to the loadable module files it names:
 * - a file entry → that file
 * - a directory:
 *   - when `expandDirectory` (the `extensions` key), resolved by
 *     {@link resolveDirectoryEntries} — its own package.json `omp`/`pi`
 *     `extensions`, then a direct index, then a one-level scan of
 *     sub-extensions — matching the pi `extensions/<name>/index.ts` convention
 *     and OMP's configured-directory (`-e`) extension loader
 *   - otherwise (tools/hooks/commands) only a direct index.{ts,js,mjs,cjs}.
 *     The sub-extension scan and the `omp`/`pi` `extensions` manifest are
 *     extensions-specific and must not hijack a non-extension directory entry
 *     (e.g. a `tools: "."` entry must still resolve `./index.ts`).
 *
 * Returns an empty array when nothing loadable exists at `joined`, letting
 * callers flag a missing entry instead of silently dropping it.
 */
function resolveManifestEntryFiles(joined: string, expandDirectory: boolean): string[] {
	let stats: fs.Stats;
	try {
		stats = fs.statSync(joined);
	} catch {
		return [];
	}
	if (!stats.isDirectory()) {
		return [joined];
	}
	if (expandDirectory) {
		return resolveDirectoryEntries(joined);
	}
	const index = findDirectoryIndex(joined);
	return index ? [index] : [];
}

/**
 * Generic path resolver for plugin manifest entries (tools, hooks, commands, extensions).
 * Handles both single-string and string[] base entries, plus feature-specific entries.
 */
function resolvePluginPaths(plugin: InstalledPlugin, key: "tools" | "hooks" | "commands" | "extensions"): string[] {
	const resolved: string[] = [];
	for (const entry of resolvePluginManifestEntries(plugin, key)) {
		if (entry.resolvedPath) {
			resolved.push(entry.resolvedPath);
		}
	}
	return resolved;
}

/**
 * Declared manifest entries paired with their resolved file path. Returns one
 * record per declared entry — base entries first, then enabled-feature entries
 * — so callers (e.g. install-time validation) can detect manifest entries that
 * point at missing files instead of silently skipping them like
 * {@link resolvePluginPaths} does.
 */
export function resolvePluginManifestEntries(
	plugin: InstalledPlugin,
	key: "tools" | "hooks" | "commands" | "extensions",
): Array<{ entry: string; resolvedPath: string | null }> {
	const declared: Array<{ entry: string; resolvedPath: string | null }> = [];
	const manifest = plugin.manifest;

	const expandDirectory = key === "extensions";
	const resolveEntry = (entry: string): Array<{ entry: string; resolvedPath: string | null }> => {
		const files = resolveManifestEntryFiles(path.join(plugin.path, entry), expandDirectory);
		return files.length > 0 ? files.map(resolvedPath => ({ entry, resolvedPath })) : [{ entry, resolvedPath: null }];
	};

	const base = manifest[key];
	if (base) {
		const entries = Array.isArray(base) ? base : [base];
		for (const entry of entries) {
			declared.push(...resolveEntry(entry));
		}
	}

	if (manifest.features && plugin.enabledFeatures) {
		const enabledSet = new Set(plugin.enabledFeatures);
		for (const [featName, feat] of Object.entries(manifest.features)) {
			if (!enabledSet.has(featName)) continue;
			if (feat[key]) {
				for (const entry of feat[key]) {
					declared.push(...resolveEntry(entry));
				}
			}
		}
	} else if (manifest.features && plugin.enabledFeatures === null) {
		// null means use defaults - enable features with default: true
		for (const [_featName, feat] of Object.entries(manifest.features)) {
			if (!feat.default) continue;
			if (feat[key]) {
				for (const entry of feat[key]) {
					declared.push(...resolveEntry(entry));
				}
			}
		}
	}

	return declared;
}

export function resolvePluginToolPaths(plugin: InstalledPlugin): string[] {
	return resolvePluginPaths(plugin, "tools");
}

export function resolvePluginHookPaths(plugin: InstalledPlugin): string[] {
	return resolvePluginPaths(plugin, "hooks");
}

export function resolvePluginCommandPaths(plugin: InstalledPlugin): string[] {
	return resolvePluginPaths(plugin, "commands");
}

export function resolvePluginExtensionPaths(plugin: InstalledPlugin): string[] {
	return resolvePluginPaths(plugin, "extensions");
}

// =============================================================================
// Aggregated Discovery
// =============================================================================

/**
 * Get all tool paths from all enabled plugins.
 */
export async function getAllPluginToolPaths(cwd: string): Promise<string[]> {
	const plugins = await getEnabledPlugins(cwd);
	const paths: string[] = [];

	for (const plugin of plugins) {
		paths.push(...resolvePluginToolPaths(plugin));
	}

	return paths;
}

/**
 * Get all hook paths from all enabled plugins.
 */
export async function getAllPluginHookPaths(cwd: string): Promise<string[]> {
	const plugins = await getEnabledPlugins(cwd);
	const paths: string[] = [];

	for (const plugin of plugins) {
		paths.push(...resolvePluginHookPaths(plugin));
	}

	return paths;
}

/**
 * Get all command paths from all enabled plugins.
 */
export async function getAllPluginCommandPaths(cwd: string): Promise<string[]> {
	const plugins = await getEnabledPlugins(cwd);
	const paths: string[] = [];

	for (const plugin of plugins) {
		paths.push(...resolvePluginCommandPaths(plugin));
	}

	return paths;
}

/**
 * Get all extension module paths from all enabled plugins.
 */
export async function getAllPluginExtensionPaths(cwd: string): Promise<string[]> {
	const plugins = await getEnabledPlugins(cwd);
	const paths: string[] = [];

	for (const plugin of plugins) {
		paths.push(...resolvePluginExtensionPaths(plugin));
	}

	return paths;
}

/**
 * Get plugin settings for use in tool/hook contexts.
 * Merges global settings with project overrides.
 */
export async function getPluginSettings(pluginName: string, cwd: string): Promise<Record<string, unknown>> {
	const runtimeConfig = await loadRuntimeConfig();
	const projectOverrides = await loadProjectOverrides(cwd);

	const global = runtimeConfig.settings[pluginName] || {};
	const project = projectOverrides.settings?.[pluginName] || {};

	return { ...global, ...project };
}
