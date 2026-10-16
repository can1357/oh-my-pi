/**
 * Plugin cache management.
 *
 * Cache layout: `<cacheDir>/<marketplace>___<pluginName>___<version>/`
 *
 * All three components are validated before any filesystem operation:
 *   - marketplace / pluginName: isValidNameSegment (alnum + . - , max 64)
 *   - version: isValidVersionForCache (alnum + ._+-, max 128)
 *
 * This ensures cache paths cannot be crafted to escape the cache directory.
 */

import * as nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { isEnoent } from "@oh-my-pi/pi-utils";

import { isValidNameSegment } from "./types";

type GitCopyPaths = {
	listed: Set<string>;
	directories: Set<string>;
};

async function gitCopyPaths(sourcePath: string): Promise<GitCopyPaths | null> {
	try {
		const repository = vcs.git(sourcePath);
		if (!repository) return null;

		const repoRoot = repository.info().repoRoot;
		const sourcePrefix = path.relative(repoRoot, path.resolve(sourcePath)).replaceAll(path.sep, "/");
		const prefix = sourcePrefix === "" ? "" : `${sourcePrefix}/`;
		const pathspecs = sourcePrefix === "" ? [] : [sourcePrefix];
		const [tracked, status, submodules] = await Promise.all([
			repository.lsTree("HEAD", pathspecs).catch(() => []),
			repository.statusPorcelain({ untracked: "all", pathspecs, nulTerminated: true }),
			repository.submodulePaths().catch(() => []),
		]);
		const listed = new Set<string>();
		const directories = new Set<string>();
		const addPath = async (repoPath: string, directory = false): Promise<void> => {
			const normalized = repoPath.replaceAll(path.sep, "/").replace(/^\.\//, "").replace(/\/+$/, "");
			if (prefix && !normalized.startsWith(prefix)) return;
			const relative = prefix ? normalized.slice(prefix.length) : normalized;
			if (!relative) return;
			listed.add(relative);
			if (
				directory ||
				(await fs
					.stat(path.join(repoRoot, normalized))
					.then(stat => stat.isDirectory())
					.catch(() => false))
			) {
				directories.add(relative);
			}
			let parent = path.posix.dirname(relative);
			while (parent !== ".") {
				listed.add(parent);
				parent = path.posix.dirname(parent);
			}
		};
		await Promise.all(tracked.map(repoPath => addPath(repoPath)));
		for (const entry of status.split("\0")) {
			if (entry.length < 4 || entry[2] !== " ") continue;
			await addPath(entry.slice(3));
		}
		await Promise.all(submodules.map(repoPath => addPath(repoPath, true)));
		return { listed, directories };
	} catch {
		// A missing Git backend or an incomplete checkout should retain the
		// historical unfiltered-copy behavior.
		return null;
	}
}

// Reject anything that could be used for path traversal or shell injection in
// version strings. Only printable, unambiguous characters are allowed.
const VERSION_RE = /^[a-zA-Z0-9._+-]+$/;

/** Return true when `version` is safe for use as a cache path component. */
export function isValidVersionForCache(version: string): boolean {
	// prevent path-traversal sequences like ".." or "1..2"
	return version.length > 0 && version.length <= 128 && VERSION_RE.test(version) && !version.includes("..");
}

function validateCacheComponents(marketplace: string, pluginName: string, version: string): void {
	if (!isValidNameSegment(marketplace)) {
		throw new Error(`Invalid marketplace name for cache: "${marketplace}"`);
	}
	if (!isValidNameSegment(pluginName)) {
		throw new Error(`Invalid plugin name for cache: "${pluginName}"`);
	}
	if (!isValidVersionForCache(version)) {
		throw new Error(`Invalid version for cache: "${version}"`);
	}
}

/**
 * Return the absolute path for a cached plugin directory.
 * Throws if any component fails validation.
 */
export function getCachedPluginPath(
	cacheDir: string,
	marketplace: string,
	pluginName: string,
	version: string,
): string {
	validateCacheComponents(marketplace, pluginName, version);
	return path.join(cacheDir, `${marketplace}___${pluginName}___${version}`);
}

/**
 * Copy `sourcePath` into the cache, returning the absolute cache path.
 *
 * Idempotent: if the target already exists it is removed before copying,
 * so a partial previous cache is never silently reused.
 */
export async function cachePlugin(
	sourcePath: string,
	cacheDir: string,
	marketplace: string,
	pluginName: string,
	version: string,
): Promise<string> {
	const targetPath = getCachedPluginPath(cacheDir, marketplace, pluginName, version);

	// Ensure cache directory exists before writing into it
	await fs.mkdir(cacheDir, { recursive: true });

	// Copy to a staging directory first, then atomically rename into place.
	// This prevents destroying an active install if fs.cp fails mid-copy.
	const stagingPath = `${targetPath}.staging-${Date.now()}`;
	try {
		const copyPaths = await gitCopyPaths(sourcePath);
		const filter =
			copyPaths === null
				? undefined
				: (source: string): boolean => {
						const relative = path.relative(sourcePath, source).replaceAll(path.sep, "/");
						if (relative === "") return true;
						if (copyPaths.listed.has(relative) || copyPaths.directories.has(relative)) return true;
						let parent = path.posix.dirname(relative);
						while (parent !== ".") {
							if (copyPaths.directories.has(parent)) return true;
							parent = path.posix.dirname(parent);
						}
						return false;
					};
		await fs.cp(sourcePath, stagingPath, filter ? { recursive: true, filter } : { recursive: true });
		await fs.rm(targetPath, { recursive: true, force: true });
		await fs.rename(stagingPath, targetPath);
	} catch (err) {
		// Clean up staging dir on any failure; leave existing targetPath intact
		await fs.rm(stagingPath, { recursive: true, force: true }).catch(() => {});
		throw err;
	}

	return targetPath;
}

/**
 * Synchronous check — true when the cache directory exists on disk.
 * Uses `existsSync` because callers may need to run this check inline without async.
 */
export function isCached(cacheDir: string, marketplace: string, pluginName: string, version: string): boolean {
	const targetPath = getCachedPluginPath(cacheDir, marketplace, pluginName, version);
	return nodeFs.existsSync(targetPath);
}

/** Remove a single cached plugin directory. No-op if it does not exist. */
export async function removeCachedPlugin(
	cacheDir: string,
	marketplace: string,
	pluginName: string,
	version: string,
): Promise<void> {
	const targetPath = getCachedPluginPath(cacheDir, marketplace, pluginName, version);
	await fs.rm(targetPath, { recursive: true, force: true });
}

/**
 * Remove all cache entries whose full path is not in `installedPaths`.
 *
 * Returns the count of removed directories. If `cacheDir` does not exist,
 * returns `{ removed: 0 }` rather than throwing.
 */
export async function cleanOrphanedCache(cacheDir: string, installedPaths: Set<string>): Promise<{ removed: number }> {
	let entries: string[];
	try {
		entries = await fs.readdir(cacheDir);
	} catch (err) {
		if (isEnoent(err)) return { removed: 0 };
		throw err;
	}

	let removed = 0;
	for (const entry of entries) {
		const fullPath = path.join(cacheDir, entry);
		if (!installedPaths.has(fullPath)) {
			await fs.rm(fullPath, { recursive: true, force: true });
			removed++;
		}
	}

	return { removed };
}
