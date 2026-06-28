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
 * before discovery runs; settings paths are read lazily from
 * `<scope>/settings.json` in {@link listOmpExtensionRoots} to mirror what
 * `loadExtensionModules` already does.
 *
 * @see ./omp-plugins.ts
 * @see ./builtin.ts `loadExtensionModules`
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir, isEnoent, logger, tryParseJson } from "@pk-nerdsaver-ai/pi-utils";
import { readDirEntries, readFile } from "../capability/fs";
import type { LoadContext } from "../capability/types";
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
	level: "user" | "project";
}

let injectedCliRoots: InjectedRoot[] = [];

/**
 * Register CLI-provided extension package paths (e.g. from `--extension`/`-e`)
 * so the sub-discovery providers can find their sibling `skills/`, `hooks/`,
 * etc. Paths that do not resolve to a directory are silently dropped — file
 * entrypoints have no package sub-tree to scan.
 *
 * Call once during startup before any capability load. Repeated calls extend
 * the registered set; {@link clearOmpExtensionCliRoots} resets for tests.
 */
export function injectOmpExtensionCliRoots(paths: readonly string[], home: string, cwd: string): void {
	if (paths.length === 0) return;
	const expanded = paths.map(raw => {
		const tilde = expandTilde(raw, home);
		return path.isAbsolute(tilde) ? tilde : path.resolve(cwd, tilde);
	});
	const merged = new Map<string, InjectedRoot>();
	for (const root of injectedCliRoots) merged.set(root.path, root);
	for (const resolved of expanded) {
		// CLI scope mirrors how `--extension` is treated elsewhere — user-level overrides win.
		if (!merged.has(resolved)) merged.set(resolved, { path: resolved, level: "user" });
	}
	injectedCliRoots = [...merged.values()];
}

/** Drop every CLI-injected root. Tests use this between cases. */
export function clearOmpExtensionCliRoots(): void {
	injectedCliRoots = [];
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

async function readSettingsExtensions(settingsPath: string): Promise<string[]> {
	const content = await readFile(settingsPath);
	if (!content) return [];
	const parsed = tryParseJson<{ extensions?: unknown }>(content);
	const raw = parsed?.extensions;
	if (!Array.isArray(raw)) return [];
	return raw.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
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
 * Sources, in order of precedence (later entries with the same absolute path
 * are dropped):
 *
 * 1. CLI roots injected via {@link injectOmpExtensionCliRoots}
 * 2. Project `<cwd>/.omp/settings.json#extensions`
 * 3. User `~/.omp/agent/settings.json#extensions`
 * 4. Enabled npm/link plugins installed under `<plugins>/node_modules/` (for
 *    `omp install <pkg>` / `omp plugin install` / `omp plugin link`). Marketplace
 *    installs are loaded by the `claude-plugins` provider and are excluded here.
 * Only entries that resolve to a directory on disk are returned; file
 * entrypoints contribute zero sub-discovery surface and are filtered out.
 * Installed-plugin enumeration failures (missing lockfile, unreadable
 * `package.json`, etc.) are logged at `debug` and degrade gracefully — the
 * other sources still surface.
 */
export async function listOmpExtensionRoots(ctx: LoadContext): Promise<OmpExtensionRoot[]> {
	const { project, user } = scopeDirs(ctx);
	const [projectExtensions, userExtensions, installedPlugins] = await Promise.all([
		readSettingsExtensions(path.join(project, "settings.json")),
		readSettingsExtensions(path.join(user, "settings.json")),
		listInstalledPluginRoots(ctx),
	]);

	const candidates: InjectedRoot[] = [
		...injectedCliRoots,
		...projectExtensions.map((raw): InjectedRoot => ({ path: resolveAgainst(raw, ctx), level: "project" })),
		...userExtensions.map((raw): InjectedRoot => ({ path: resolveAgainst(raw, ctx), level: "user" })),
		...installedPlugins,
	];

	// First-seen-wins dedup preserves CLI > project-settings > user-settings > installed precedence.
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
