import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { normalizePathForComparison, sanitizeText } from "@oh-my-pi/pi-utils";
import { shortenPath } from "@oh-my-pi/pi-tui/render/render-utils";
import type { MoveDirectorySource, MoveDirectoryEntry } from "@oh-my-pi/pi-tui/overlays/move-overlay";

/** TTL for the directory listing cache (ms). */
const DIR_CACHE_TTL = 500;
const dirCache = new Map<string, { time: number; entries: fs.Dirent[] }>();

function readDirCached(dir: string): fs.Dirent[] {
	const now = Date.now();
	const cached = dirCache.get(dir);
	if (cached && now - cached.time < DIR_CACHE_TTL) return cached.entries;
	try {
		const entries = fs.readdirSync(dir, { withFileTypes: true });
		dirCache.set(dir, { time: now, entries });
		return entries;
	} catch {
		return [];
	}
}

/**
 * `Dirent.isDirectory()` reports the entry type, not the link target, so a
 * `statSync` fallback is still needed for symlinks that point at a directory.
 * Some filesystems (NFS, FUSE, older SMB) report `UV_DIRENT_UNKNOWN` — every
 * `isX()` returns false — so those entries also fall back to `statSync` rather
 * than being silently dropped from the results.
 */
function entryIsDirectory(dir: string, entry: fs.Dirent): boolean {
	if (entry.isDirectory()) return true;
	// Fast reject only for entry types we can confidently identify as non-directory.
	if (entry.isFile() || entry.isBlockDevice() || entry.isCharacterDevice() || entry.isFIFO() || entry.isSocket()) {
		return false;
	}
	// Symlink (need target type) or unknown (filesystem didn't provide a type) — stat to find out.
	try {
		return fs.statSync(path.join(dir, entry.name)).isDirectory();
	} catch {
		return false;
	}
}

/** Resolve a user-typed path (`~`, absolute, or relative to `cwd`) to an absolute path. */
export function resolveMovePath(input: string, cwd: string): string {
	const trimmed = input.trim();
	if (trimmed === "~") return os.homedir();
	if (trimmed.startsWith("~/")) return path.join(os.homedir(), trimmed.slice(2));
	if (path.isAbsolute(trimmed)) return path.normalize(trimmed);
	return path.resolve(cwd, trimmed);
}

/** If `input` resolves to an existing directory, return it; otherwise `null`. */
export function resolveExistingDirectory(input: string, cwd: string): string | null {
	const resolved = resolveMovePath(input, cwd);
	try {
		return fs.statSync(resolved).isDirectory() ? resolved : null;
	} catch {
		return null;
	}
}

function listChildDirectories(dirPath: string, max: number, includeHidden = false): MoveDirectoryEntry[] {
	const results: MoveDirectoryEntry[] = [];
	const entries = readDirCached(dirPath);
	for (const entry of entries) {
		if (results.length >= max) break;
		const { name } = entry;
		if (!includeHidden && name.startsWith(".")) continue;
		if (!entryIsDirectory(dirPath, entry)) continue;
		results.push({ value: path.join(dirPath, name), label: `${name}/` });
	}
	results.sort((a, b) => a.label.localeCompare(b.label));
	return results;
}

function searchDirectories(prefix: string, cwd: string, max: number): MoveDirectoryEntry[] {
	if (!prefix) return listChildDirectories(cwd, max);

	// Split into base dir + query so dot-prefixed segments can reveal hidden directories.
	const norm = prefix.replace(/\\/g, "/");
	const slashIdx = norm.lastIndexOf("/");
	let baseDir: string;
	let query: string;
	if (slashIdx === -1) {
		baseDir = cwd;
		query = prefix;
	} else {
		const base = norm.slice(0, slashIdx + 1);
		query = norm.slice(slashIdx + 1);
		baseDir = resolveMovePath(base, cwd);
	}

	const includeHidden = query.startsWith(".");

	// If the prefix already resolves to an existing directory, list its children.
	// A dot-prefixed query is treated as a filter so hidden directories become reachable.
	const resolved = includeHidden ? null : resolveExistingDirectory(prefix, cwd);
	if (resolved) return listChildDirectories(resolved, max);

	const lower = query.toLowerCase();
	const results: MoveDirectoryEntry[] = [];
	const entries = readDirCached(baseDir);
	for (const entry of entries) {
		if (results.length >= max) break;
		const { name } = entry;
		if (!includeHidden && name.startsWith(".")) continue;
		if (query && !name.toLowerCase().includes(lower)) continue;
		if (!entryIsDirectory(baseDir, entry)) continue;
		results.push({ value: path.join(baseDir, name), label: `${name}/` });
	}
	return results;
}

/** Filesystem-backed directory suggestions for the move dialog. */
export const moveDirectorySource: MoveDirectorySource = { search: searchDirectories };

/** Maximum recent directories to surface in the picker. */
export const MAX_RECENT_DIRS = 8;

/**
 * Extract recent unique working directories from session metadata.
 *
 * Re-sorts by `modified` descending (overriding `SessionManager.listAll()`'s
 * pinned-first order) so the result is true recency, not session-picker order.
 * Deduplicates by canonical path, excludes the current cwd and non-existent
 * directories.  Scans until {@link MAX_RECENT_DIRS} valid unique dirs are
 * collected or the session list is exhausted.
 */
export async function getRecentWorkingDirectories(
	sessions: { cwd: string; modified: Date }[],
	currentCwd: string,
	dirExists: (p: string) => Promise<boolean>,
): Promise<string[]> {
	const byRecency = [...sessions].sort((a, b) => b.modified.getTime() - a.modified.getTime());
	const seen = new Set([normalizePathForComparison(currentCwd)]);
	const recentDirs: string[] = [];
	for (const session of byRecency) {
		if (recentDirs.length >= MAX_RECENT_DIRS) break;
		const cwd = session.cwd;
		if (!cwd) continue;
		const resolved = path.resolve(cwd);
		const normalized = normalizePathForComparison(resolved);
		if (seen.has(normalized)) continue;
		if (!(await dirExists(resolved))) continue;
		seen.add(normalized);
		recentDirs.push(resolved);
	}
	return recentDirs;
}

/**
 * Create a {@link MoveDirectorySource} that prepends recently used directories
 * to the empty-state results. When the user types a prefix, the composite
 * source delegates entirely to the filesystem source so normal path filtering
 * is unaffected.
 *
 * Recent entries are labeled with a ↺ prefix to distinguish them from
 * filesystem children.  The TUI overlay remains generic — it just renders
 * whatever {@link MoveDirectoryEntry} list the source returns.
 */
export function createRecentAwareSource(recentDirs: string[]): MoveDirectorySource {
	const recentEntries: MoveDirectoryEntry[] = recentDirs.map(d => ({
		value: d,
		label: `↺ ${shortenPath(sanitizeText(d))}`,
	}));
	// A recent dir that is also a direct child of cwd would otherwise render
	// twice in the empty state — once as `↺ <path>` and once as `<name>/`.
	const recentNormalized = new Set(recentDirs.map(d => normalizePathForComparison(path.resolve(d))));
	return {
		search(prefix: string, cwd: string, max: number): MoveDirectoryEntry[] {
			const fsResults = searchDirectories(prefix, cwd, max);
			if (prefix || recentEntries.length === 0) return fsResults;
			// Prepend up to MAX_RECENT_DIRS recent entries, then fill the
			// remaining slots from filesystem results.
			const recentSlice = recentEntries.slice(0, Math.min(recentEntries.length, max));
			const children = fsResults.filter(entry => !recentNormalized.has(normalizePathForComparison(entry.value)));
			return [...recentSlice, ...children].slice(0, max);
		},
	};
}
