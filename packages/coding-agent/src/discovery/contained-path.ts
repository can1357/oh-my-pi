/**
 * Package-boundary containment for plugin directories (Agent Plugins §4.1).
 *
 * A file or directory supplied by a plugin package may only be discovered,
 * read, or executed when its filesystem-resolved path stays within the
 * filesystem-resolved plugin root. These helpers resolve paths WITHOUT reading
 * them, so callers can prove containment before any read, readdir, or
 * symlink-following stat touches content outside the package.
 *
 * Shared by the Agent Plugins format module and the plugin-root helpers;
 * imports nothing from either to stay cycle-free.
 */
import * as fs from "node:fs";
import { pathIsWithinLexical } from "@oh-my-pi/pi-utils";

/** Resolve symlinks and equivalents; `null` when the path is missing or unresolvable. */
export async function realpathIfExists(p: string): Promise<string | null> {
	try {
		return await fs.promises.realpath(p);
	} catch {
		return null;
	}
}

export type ContainedPathResolution =
	| { status: "missing" }
	| { status: "outside" }
	| { status: "ok"; realPath: string };

/**
 * Resolve a fixed package path WITHOUT reading it: symlinks and equivalent
 * mechanisms are resolved first, and a path escaping the filesystem-resolved
 * plugin root is rejected before any I/O could consume outside content.
 */
export async function resolveContainedPath(realBase: string, target: string): Promise<ContainedPathResolution> {
	if (!pathIsWithinLexical(realBase, target)) return { status: "outside" };
	const real = await realpathIfExists(target);
	if (real === null) return { status: "missing" };
	return pathIsWithinLexical(realBase, real) ? { status: "ok", realPath: real } : { status: "outside" };
}

/**
 * Verify a package path stays within the filesystem-resolved plugin root:
 * lexically, and — when the target exists — after resolving symlinks. Unlike
 * {@link resolveContainedPath}, a missing target passes. ONLY for configured
 * paths that are validated but never read or executed at load time (stdio
 * `command`, `cwd` — including `${PLUGIN_DATA}` paths created after
 * validation); access paths MUST use {@link resolveContainedPath} instead,
 * which fails closed on unresolvable targets.
 */
export async function isContainedResolved(realBase: string, target: string): Promise<boolean> {
	if (!pathIsWithinLexical(realBase, target)) return false;
	const real = await realpathIfExists(target);
	return real === null || pathIsWithinLexical(realBase, real);
}

/**
 * Sync variant of {@link resolveContainedPath} for synchronous callsites
 * (bash `skill://` expansion).
 */
export function resolveContainedPathSync(realBase: string, target: string): ContainedPathResolution {
	if (!pathIsWithinLexical(realBase, target)) return { status: "outside" };
	let real: string | null;
	try {
		real = fs.realpathSync(target);
	} catch {
		real = null;
	}
	if (real === null) return { status: "missing" };
	return pathIsWithinLexical(realBase, real) ? { status: "ok", realPath: real } : { status: "outside" };
}
