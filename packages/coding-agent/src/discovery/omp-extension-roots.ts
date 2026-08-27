/**
 * OMP extension package roots.
 *
 * An "extension package root" is a directory configured via either
 * `extensions:` in user/project settings or the `--extension`/`-e` CLI flag
 * that points to a packaged extension on disk. The package's standard
 * sub-directories (`skills/`, `hooks/`, `tools/`, `commands/`, `rules/`,
 * `prompts/`, `.mcp.json`) are wired into discovery by `omp-plugins.ts`.
 *
 * CLI-provided paths are injected via {@link injectOmpExtensionCliRoots}
 * before discovery runs. Capability loads supply the effective `extensions`
 * setting; direct callers reconstruct its array-replacement precedence from
 * canonical YAML config and legacy `settings.json`.
 *
 * @see ./omp-plugins.ts
 * @see ./builtin.ts `loadExtensionModules`
 */
import { AsyncLocalStorage } from "node:async_hooks";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir, isEnoent, logger, MAIN_CONFIG_FILENAMES, tryParseJson } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import { readDirEntries, readFile } from "../capability/fs";
import type { ExtensionRootMode, LoadContext } from "../capability/types";
import { getEnabledPlugins } from "../extensibility/plugins/loader";
import { expandTilde } from "../tools/path-utils";
import { listClaudePluginRoots } from "./helpers";

/** A resolved extension package directory wired into the discovery surfaces. */
export interface OmpExtensionRoot {
	/** Absolute path to the package directory. */
	path: string;
	/** Stable display name (basename of the package directory). */
	name: string;
	/** Scope from which the path was sourced. */
	level: "user" | "project";
}

interface InjectedRoot {
	path: string;
	/** Relative CLI spelling, rebound against the active project on discovery. */
	relativePath?: string;
	level: "user" | "project";
}

/** Extension sub-discovery mode; re-exported alias of {@link ExtensionRootMode}. */
export type OmpExtensionRootMode = ExtensionRootMode;

interface InvocationRootScope {
	/** Raw SDK spellings, resolved against the LoadContext that performs discovery. */
	paths: readonly string[];
	mode: OmpExtensionRootMode;
	/**
	 * Effective `extensions` setting for the owning session, captured once its
	 * `Settings` instance is loaded. Session-local so concurrent SDK sessions
	 * never observe each other's configured roots. `undefined` until
	 * {@link setInvocationConfiguredExtensions} runs; discovery then falls back
	 * to reading the persisted config from disk.
	 */
	configuredExtensions?: readonly string[];
	/** Provenance of {@link configuredExtensions}, from `Settings`. Defaults to `user` when unset. */
	configuredLevel?: "user" | "project";
}

const invocationRootScope = new AsyncLocalStorage<InvocationRootScope>();

let injectedCliRoots: InjectedRoot[] = [];
let injectedCliRootMode: OmpExtensionRootMode = "merge";

export interface InjectOmpExtensionCliRootOptions {
	/**
	 * `explicit-only` exposes only roots named by this CLI invocation. Use it
	 * with `--no-extensions` so configured and installed packages cannot
	 * contribute sibling capabilities through the `omp-plugins` provider.
	 */
	mode?: OmpExtensionRootMode;
	/** Replace roots from an earlier invocation instead of extending them. */
	replace?: boolean;
}

/**
 * Run one SDK invocation with its own extension-package roots. Async resources
 * started inside `callback` retain this scope, including discovery deliberately
 * deferred until the end of session startup. Raw relative paths are resolved by
 * {@link listOmpExtensionRoots} against that invocation's active cwd.
 */
export function withOmpExtensionRootScope<T>(
	paths: readonly string[],
	mode: OmpExtensionRootMode,
	callback: () => T,
): T {
	return invocationRootScope.run({ paths: [...paths], mode }, callback);
}

/**
 * Record the owning session's effective `extensions` setting (and its
 * `Settings`-resolved provenance) on the active invocation scope so
 * sub-discovery honors overlays/runtime overrides and foreign project
 * providers without reading the process-global settings singleton. No-op
 * outside a {@link withOmpExtensionRootScope} callback.
 */
export function setInvocationConfiguredExtensions(paths: readonly string[], level: "user" | "project" = "user"): void {
	const scope = invocationRootScope.getStore();
	if (scope) {
		scope.configuredExtensions = [...paths];
		scope.configuredLevel = level;
	}
}

/**
 * Register CLI-provided extension package paths (e.g. from `--extension`/`-e`)
 * so the sub-discovery providers can find their sibling `skills/`, `hooks/`,
 * etc. Paths that do not resolve to a directory are silently dropped — file
 * entrypoints have no package sub-tree to scan.
 *
 * Call once during startup before any capability load. Repeated calls extend
 * the registered set; {@link clearOmpExtensionCliRoots} resets for tests.
 */
export function injectOmpExtensionCliRoots(
	paths: readonly string[],
	home: string,
	cwd: string,
	options: InjectOmpExtensionCliRootOptions = {},
): void {
	if (options.mode) injectedCliRootMode = options.mode;
	if (options.replace) injectedCliRoots = [];
	if (paths.length === 0) return;
	const expanded = paths.map(raw => {
		const tilde = expandTilde(raw, home);
		return {
			path: path.isAbsolute(tilde) ? tilde : path.resolve(cwd, tilde),
			relativePath: path.isAbsolute(tilde) ? undefined : tilde,
		};
	});
	const merged = new Map<string, InjectedRoot>();
	for (const root of injectedCliRoots) merged.set(root.path, root);
	for (const { path: resolved, relativePath } of expanded) {
		// CLI scope mirrors how `--extension` is treated elsewhere — user-level overrides win.
		if (!merged.has(resolved)) merged.set(resolved, { path: resolved, relativePath, level: "user" });
	}
	injectedCliRoots = [...merged.values()];
}

/** Drop every CLI-injected root. Tests use this between cases. */
export function clearOmpExtensionCliRoots(): void {
	injectedCliRoots = [];
	injectedCliRootMode = "merge";
}

/** Inspect currently-injected CLI roots (read-only). Exposed for diagnostics + tests. */
export function getInjectedOmpExtensionCliRoots(): readonly OmpExtensionRoot[] {
	return injectedCliRoots.map(({ path: p, level }) => ({ path: p, level, name: path.basename(p) }));
}

interface ScopeDirs {
	project: string;
	user: string;
}

function scopeDirs(ctx: LoadContext): ScopeDirs {
	return {
		project: path.join(ctx.cwd, ".omp"),
		user: getAgentDir(),
	};
}

function readExtensionsArray(raw: unknown): string[] | null {
	if (!Array.isArray(raw)) return null;
	return raw.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

async function readSettingsExtensions(settingsPath: string): Promise<string[] | null> {
	const content = await readFile(settingsPath);
	if (!content) return null;
	const parsed = tryParseJson<{ extensions?: unknown }>(content);
	return readExtensionsArray(parsed?.extensions);
}

/** Project native config filename; matches the single `.omp/config.yml` the settings loader reads. */
const PROJECT_CONFIG_FILENAMES = ["config.yml"] as const;

interface YamlExtensions {
	exists: boolean;
	entries: string[] | null;
}

/**
 * Read the first present YAML config filename, matching the settings loader's
 * `config.yml` before `config.yaml` selection.
 */
async function readYamlExtensions(scopeDir: string, filenames: readonly string[]): Promise<YamlExtensions> {
	for (const filename of filenames) {
		const content = await readFile(path.join(scopeDir, filename));
		if (content === null) continue;
		let parsed: unknown;
		try {
			parsed = YAML.parse(content);
		} catch {
			return { exists: true, entries: null };
		}
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
			return { exists: true, entries: null };
		}
		const raw = "extensions" in parsed ? parsed.extensions : undefined;
		return { exists: true, entries: readExtensionsArray(raw) };
	}
	return { exists: false, entries: null };
}

interface ConfiguredExtensions {
	entries: string[];
	level: "user" | "project";
}

/**
 * Select the persisted `extensions` array with the same array-replacement
 * precedence as `Settings`: project YAML, project legacy settings, user YAML,
 * then user legacy settings. A present user YAML config suppresses its legacy
 * migration source even when it omits `extensions`.
 */
async function readConfiguredExtensions(ctx: LoadContext): Promise<ConfiguredExtensions | null> {
	const { project, user } = scopeDirs(ctx);
	const [projectYaml, projectSettings, userYaml, userSettings] = await Promise.all([
		readYamlExtensions(project, PROJECT_CONFIG_FILENAMES),
		readSettingsExtensions(path.join(project, "settings.json")),
		readYamlExtensions(user, MAIN_CONFIG_FILENAMES),
		readSettingsExtensions(path.join(user, "settings.json")),
	]);
	if (projectYaml.entries !== null) return { entries: projectYaml.entries, level: "project" };
	if (projectSettings !== null) return { entries: projectSettings, level: "project" };
	if (userYaml.entries !== null) return { entries: userYaml.entries, level: "user" };
	if (userYaml.exists) return null;
	if (userSettings !== null) return { entries: userSettings, level: "user" };
	return null;
}

function resolveAgainst(raw: string, ctx: LoadContext): string {
	const tilde = expandTilde(raw, ctx.home);
	return path.isAbsolute(tilde) ? tilde : path.resolve(ctx.cwd, tilde);
}

async function isDirectory(p: string): Promise<boolean> {
	const entries = await readDirEntries(p);
	if (entries.length > 0) return true;
	// Empty directory still counts; cache returns [] for both empty and missing.
	// Disambiguate with a single stat — only hit when the cached listing is empty.
	try {
		const stat = await fs.stat(p);
		return stat.isDirectory();
	} catch (err) {
		if (isEnoent(err)) return false;
		throw err;
	}
}

/**
 * Resolve every configured extension package directory for the given context.
 *
 * Sources are threaded as one `EffectiveExtensionRoots` value — from
 * `ctx.extensionRoots` (a post-startup reload), else the invocation scope
 * (a construction-time load), else the process defaults (CLI injection + disk).
 * The three lanes stay separate so no dimension is lost:
 *
 * 1. Explicit lane — `explicit` roots (SDK `additionalExtensionPaths` / CLI
 *    `--extension`). Always active, always user-level.
 * 2. Configured lane — the effective `extensions:` setting, added only in
 *    `merge` mode. Its provenance (`configuredLevel`) is carried from
 *    `Settings` (the authority that merges every project provider, incl.
 *    `.claude/settings.json`, and honors overlays/overrides), never re-derived
 *    from a partial `.omp` disk scan; scopeless callers read the persisted
 *    `.omp` config, which supplies its own level.
 * 3. Installed npm/link plugins under `<plugins>/node_modules/`, added only in
 *    `merge` mode. Marketplace installs load via the `claude-plugins` provider.
 *
 * `explicit-only` mode (an SDK `disableExtensionDiscovery` session) contributes
 * the explicit lane alone — no ambient `extensions:`, installed plugins, or
 * disk config — identically inside and outside the construction scope.
 *
 * Only entries that resolve to a directory on disk are returned; file
 * entrypoints contribute zero sub-discovery surface and are filtered out.
 * Installed-plugin enumeration failures degrade gracefully at `debug`.
 */
export async function listOmpExtensionRoots(ctx: LoadContext): Promise<OmpExtensionRoot[]> {
	const scopedRoots = invocationRootScope.getStore();
	// Explicit lane, in precedence order: caller-provided reload value, then the
	// construction-time invocation scope, then process-level CLI injection.
	const explicitSeed: InjectedRoot[] = ctx.extensionRoots
		? ctx.extensionRoots.explicit.map(raw => ({ path: resolveAgainst(raw, ctx), level: "user" }))
		: scopedRoots
			? scopedRoots.paths.map(raw => ({ path: resolveAgainst(raw, ctx), level: "user" }))
			: injectedCliRoots.map(root =>
					root.relativePath ? { ...root, path: path.resolve(ctx.cwd, root.relativePath) } : root,
				);
	const rootMode: OmpExtensionRootMode = ctx.extensionRoots?.mode ?? scopedRoots?.mode ?? injectedCliRootMode;
	let candidates: InjectedRoot[] = explicitSeed;
	if (rootMode === "merge") {
		const installedPlugins = await listInstalledPluginRoots(ctx);
		// Configured lane. When a session supplies the effective value (reload
		// struct or invocation-scoped snapshot), its provenance came from
		// `Settings` — the authority that merges every project provider (incl.
		// `.claude/settings.json`) and honors overlays/overrides — so trust the
		// carried `configuredLevel` verbatim. When no session value is present,
		// read the persisted `.omp` config on disk, which is the authoritative
		// source (and its own provenance) in that scopeless path.
		const configuredEntries = ctx.extensionRoots?.configured ?? scopedRoots?.configuredExtensions;
		const configured =
			configuredEntries !== undefined
				? {
						entries: [...configuredEntries],
						level: ctx.extensionRoots?.configuredLevel ?? scopedRoots?.configuredLevel ?? ("user" as const),
					}
				: await readConfiguredExtensions(ctx);
		candidates = [
			...candidates,
			...(configured?.entries.map(
				(raw): InjectedRoot => ({ path: resolveAgainst(raw, ctx), level: configured.level }),
			) ?? []),
			...installedPlugins,
		];
	}

	// First-seen-wins dedup preserves invocation/CLI > configured settings > installed precedence.
	const seen = new Set<string>();
	const unique: InjectedRoot[] = [];
	for (const candidate of candidates) {
		if (seen.has(candidate.path)) continue;
		seen.add(candidate.path);
		unique.push(candidate);
	}

	const directoryFlags = await Promise.all(unique.map(c => isDirectory(c.path)));
	const roots: OmpExtensionRoot[] = [];
	for (let i = 0; i < unique.length; i++) {
		if (!directoryFlags[i]) continue;
		const { path: p, level } = unique[i];
		roots.push({ path: p, level, name: path.basename(p) });
	}
	return roots;
}

/**
 * Enumerate every enabled npm/link plugin's package directory so its conventional
 * `skills/`, `hooks/`, `tools/`, `commands/`, `rules/`, `prompts/`, and
 * `.mcp.json` are wired into discovery — mirrors how `getAllPluginExtensionPaths`
 * already feeds the extension factory loader.
 *
 * Marketplace installs also create runtime symlinks for enable-state persistence,
 * but their resources are discovered through the `claude-plugins` provider.
 * Filtering them here prevents `/status` from showing the same plugin under both
 * "Claude Code Marketplace" and "OMP Extension Packages".
 */
async function realpathOrResolved(p: string): Promise<string> {
	try {
		return await fs.realpath(p);
	} catch (err) {
		if (isEnoent(err)) return path.resolve(p);
		throw err;
	}
}

async function listInstalledPluginRoots(ctx: LoadContext): Promise<InjectedRoot[]> {
	try {
		const [plugins, marketplaceRoots] = await Promise.all([
			getEnabledPlugins(ctx.cwd, { home: ctx.home }),
			listClaudePluginRoots(ctx.home, ctx.cwd),
		]);
		const marketplaceRealpaths = new Set(
			await Promise.all(marketplaceRoots.roots.map(root => realpathOrResolved(root.path))),
		);
		const installedRoots = await Promise.all(
			plugins.map(async plugin => ({
				path: plugin.path,
				scope: plugin.scope,
				realpath: await realpathOrResolved(plugin.path),
			})),
		);
		return installedRoots
			.filter(root => !marketplaceRealpaths.has(root.realpath))
			.map(({ path: p, scope }) => ({ path: p, level: scope }));
	} catch (err) {
		logger.debug("listInstalledPluginRoots: enumeration failed", { error: String(err) });
		return [];
	}
}
