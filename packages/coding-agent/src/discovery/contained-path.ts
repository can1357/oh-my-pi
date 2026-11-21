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
import * as path from "node:path";

/** Lexical containment: `target` is `base` itself or a descendant of it. */
function isContained(base: string, target: string): boolean {
	const relative = path.relative(base, target);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

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
	if (!isContained(realBase, target)) return { status: "outside" };
	const real = await realpathIfExists(target);
	if (real === null) return { status: "missing" };
	return isContained(realBase, real) ? { status: "ok", realPath: real } : { status: "outside" };
}

/**
 * Write-path variant of {@link resolveContainedPath}: a missing leaf is only
 * accepted when the deepest existing ancestor resolves inside `realBase`.
 * {@link resolveContainedPath} reports `missing` for a target whose parent
 * chain escapes the root through a symlink, which a following `mkdir`/write
 * would then follow outside the base. Callers that create the target resolve
 * the existing prefix first, so an escaping or dangling link fails closed.
 */
export async function resolveContainedPathForWrite(realBase: string, target: string): Promise<ContainedPathResolution> {
	if (!isContained(realBase, target)) return { status: "outside" };
	const real = await realpathIfExists(target);
	if (real !== null) return isContained(realBase, real) ? { status: "ok", realPath: real } : { status: "outside" };
	// The leaf is missing. Find the deepest existing ancestor and resolve it:
	// realpath follows every symlink in the existing prefix, so a link that
	// escapes (or dangles) is rejected before the caller's mkdir/write follows
	// it. `realBase` is the boundary — the caller creates it when absent.
	let ancestor = path.dirname(target);
	for (;;) {
		try {
			await fs.promises.lstat(ancestor);
		} catch {
			if (ancestor === realBase) return { status: "missing" };
			ancestor = path.dirname(ancestor);
			continue;
		}
		const resolved = await realpathIfExists(ancestor);
		return resolved !== null && isContained(realBase, resolved) ? { status: "missing" } : { status: "outside" };
	}
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
	if (!isContained(realBase, target)) return false;
	const real = await realpathIfExists(target);
	return real === null || isContained(realBase, real);
}

/**
 * Sync variant of {@link resolveContainedPath} for synchronous callsites
 * (bash `skill://` expansion).
 */
export function resolveContainedPathSync(realBase: string, target: string): ContainedPathResolution {
	if (!isContained(realBase, target)) return { status: "outside" };
	let real: string | null;
	try {
		real = fs.realpathSync(target);
	} catch {
		real = null;
	}
	if (real === null) return { status: "missing" };
	return isContained(realBase, real) ? { status: "ok", realPath: real } : { status: "outside" };
}
