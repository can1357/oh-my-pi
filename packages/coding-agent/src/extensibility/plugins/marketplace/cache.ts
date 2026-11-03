/**
 * Plugin cache management.
 *
 * Cache layout: `<cacheDir>/<marketplace>___<pluginName>___<version>/`, and
 * `<cacheDir>/<marketplace>___<pluginName>___<version>___<n>/` for a later copy of a version
 * whose directory still exists (see {@link cachePlugin}).
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

import { isValidNameSegment } from "./types";

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
 * Copy `sourcePath` into a new cache directory and return its absolute path. The first copy of a
 * version goes to {@link getCachedPluginPath}; a copy of a version whose directory still exists
 * goes to a fresh sibling, `<that path>___<n>`. So a reinstall never changes a file a running
 * session reads from the existing copy: the registries move to the new copy, and the old one is
 * retired under the lease rules (`cache-lease.ts`). `beforeCopy(targetPath)` runs before anything
 * is written there (the installer leases the target). The copy is made beside the target and
 * renamed into place, so a failed copy never leaves a partial directory at the target.
 */
export async function cachePlugin(
	sourcePath: string,
	cacheDir: string,
	marketplace: string,
	pluginName: string,
	version: string,
	beforeCopy?: (targetPath: string) => Promise<unknown>,
): Promise<string> {
	const basePath = getCachedPluginPath(cacheDir, marketplace, pluginName, version);
	await fs.mkdir(cacheDir, { recursive: true });
	let targetPath = basePath;
	for (let n = 2; nodeFs.existsSync(targetPath); n++) targetPath = `${basePath}___${n}`;
	await beforeCopy?.(targetPath);

	const stagingPath = `${targetPath}.staging-${Date.now()}`;
	try {
		await fs.cp(sourcePath, stagingPath, { recursive: true });
		await fs.rename(stagingPath, targetPath);
	} catch (err) {
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
