import { ArchiveError } from "./error";
import { type ArchiveLimits, assertEntryCount } from "./limits";
import type { ArchiveIndexEntry } from "./types";

/**
 * Insert `entry` into the index map with archive append/update semantics:
 * files replace directories of the same path, directories never shadow files,
 * and same-kind duplicates keep the later record while earlier metadata fills
 * gaps (matching system tar extraction). Returns the retained entry, or
 * `undefined` when the incoming entry was dropped.
 */
export function upsertArchiveEntry(
	map: Map<string, ArchiveIndexEntry>,
	entry: ArchiveIndexEntry,
): ArchiveIndexEntry | undefined {
	const existing = map.get(entry.path);
	if (!existing) {
		map.set(entry.path, entry);
		return entry;
	}

	if (existing.isDirectory && !entry.isDirectory) {
		map.set(entry.path, entry);
		return entry;
	}

	if (!existing.isDirectory && entry.isDirectory) {
		return undefined;
	}

	const merged = {
		...entry,
		mtimeMs: entry.mtimeMs ?? existing.mtimeMs,
		mode: entry.mode ?? existing.mode,
		storage: entry.storage ?? existing.storage,
	};
	map.set(entry.path, merged);
	return merged;
}

/**
 * Synthesize directory entries for every ancestor of every indexed path, so
 * containers that omit directory records (ZIP, cpio, most tars) still list
 * correctly. Enforces `limits.maxEntries` as the map grows.
 */
export function ensureParentDirectories(map: Map<string, ArchiveIndexEntry>, limits: ArchiveLimits): void {
	assertEntryCount(map.size, limits);
	for (const entry of Array.from(map.values())) {
		const parts = entry.path.split("/");
		const stop = parts.length - 1;
		for (let index = 1; index <= stop; index++) {
			const dirPath = parts.slice(0, index).join("/");
			if (!dirPath || map.has(dirPath)) continue;
			map.set(dirPath, {
				path: dirPath,
				isDirectory: true,
				size: 0,
			});
			assertEntryCount(map.size, limits);
		}
	}
}

/**
 * Rewrite `archivePath` through symlink aliases until it no longer crosses
 * one. Bounded: an exact revisit and an alias chain that keeps growing the
 * path (e.g. `a -> a/b`) both throw a catchable cyclic-symlink error.
 */
export function resolveArchiveLinkPath(
	entries: ReadonlyMap<string, ArchiveIndexEntry>,
	archivePath: string,
	maxLinkDepth: number,
): string {
	let resolvedPath = archivePath;
	const seen = new Set<string>();
	for (let rewrites = 0; !seen.has(resolvedPath);) {
		seen.add(resolvedPath);
		let replacement: string | undefined;
		for (let end = resolvedPath.length; end > 0; end = resolvedPath.lastIndexOf("/", end - 1)) {
			const entry = entries.get(resolvedPath.slice(0, end));
			if (entry?.storage?.type !== "link" || (!entry.isDirectory && !entry.storage.resolveTarget)) continue;
			const suffix = resolvedPath.slice(end + 1);
			replacement = suffix
				? entry.storage.targetPath
					? `${entry.storage.targetPath}/${suffix}`
					: suffix
				: entry.storage.targetPath;
			break;
		}
		if (replacement === undefined) return resolvedPath;
		// The bound counts performed rewrites, so a chain of exactly
		// maxLinkDepth aliases still resolves; only needing one more trips it.
		if (++rewrites > maxLinkDepth) break;
		resolvedPath = replacement;
	}
	throw new ArchiveError(`Archive path '${archivePath}' crosses a cyclic symlink`);
}
