import * as fs from "node:fs";
import * as path from "node:path";

const contentCache = new Map<string, string | null>();
const dirCache = new Map<string, fs.Dirent[]>();

function resolvePath(filePath: string): string {
	return path.resolve(filePath);
}

export interface ReadFileOptions {
	/**
	 * Cache `null` results. Disable for optional files that may be created between
	 * discovery passes without an explicit filesystem cache invalidation.
	 * @default true
	 */
	cacheMisses?: boolean;
}

export async function readFile(filePath: string, options: ReadFileOptions = {}): Promise<string | null> {
	const abs = resolvePath(filePath);
	if (contentCache.has(abs)) {
		const cached = contentCache.get(abs) ?? null;
		if (cached !== null || options.cacheMisses !== false) return cached;
	}

	try {
		// Gate on the file type first: discovery scans foreign config dirs
		// (~/.claude, ~/.cursor, project trees), and reading a FIFO/socket/char
		// device with `.text()` blocks until EOF — i.e. forever — hanging
		// startup with zero output. `stat` follows symlinks, so symlinked
		// context files (CLAUDE.md -> AGENTS.md) still resolve.
		const stats = await fs.promises.stat(abs);
		if (!stats.isFile()) {
			if (options.cacheMisses !== false) contentCache.set(abs, null);
			return null;
		}
		const content = await Bun.file(abs).text();
		contentCache.set(abs, content);
		return content;
	} catch {
		if (options.cacheMisses !== false) contentCache.set(abs, null);
		return null;
	}
}

export async function readDirEntries(dirPath: string): Promise<fs.Dirent[]> {
	const abs = resolvePath(dirPath);
	if (dirCache.has(abs)) {
		return dirCache.get(abs) ?? [];
	}

	try {
		const entries = await fs.promises.readdir(abs, { withFileTypes: true });
		dirCache.set(abs, entries);
		return entries;
	} catch {
		dirCache.set(abs, []);
		return [];
	}
}

export interface ReadDirEntriesWithinLimitOptions {
	/**
	 * Ignore and replace any cached listing. A truncated or failed refresh
	 * removes the stale cache entry instead of preserving outdated results.
	 * @default false
	 */
	refresh?: boolean;
}

/**
 * Read and sort a directory while bounding the number of entries retained.
 *
 * Returns `null` when the directory contains more than `maxEntries`; truncated
 * results are never cached. `refresh` bypasses any cached listing and replaces
 * it after a complete read. Filesystem errors are left to the caller.
 */
export async function readDirEntriesWithinLimit(
	dirPath: string,
	maxEntries: number | undefined,
	options: ReadDirEntriesWithinLimitOptions = {},
): Promise<fs.Dirent[] | null> {
	const abs = resolvePath(dirPath);
	if (options.refresh) {
		dirCache.delete(abs);
	} else {
		const cached = dirCache.get(abs);
		if (cached) {
			if (maxEntries !== undefined && cached.length > maxEntries) return null;
			return [...cached].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
		}
	}

	let entries: fs.Dirent[];
	if (maxEntries === undefined) {
		entries = await fs.promises.readdir(abs, { withFileTypes: true });
	} else {
		entries = [];
		const directory = await fs.promises.opendir(abs);
		for await (const entry of directory) {
			if (entries.length >= maxEntries) {
				// A deterministic subset cannot be selected without reading the entire
				// directory. Reject it instead of exposing filesystem-order-dependent data.
				return null;
			}
			entries.push(entry);
		}
	}

	dirCache.set(abs, entries);
	return [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export async function readDir(dirPath: string): Promise<string[]> {
	const entries = await readDirEntries(dirPath);
	return entries.map(entry => entry.name);
}

export async function walkUp(
	startDir: string,
	name: string,
	opts: { file?: boolean; dir?: boolean } = {},
): Promise<string | null> {
	const { file = true, dir = true } = opts;
	let current = resolvePath(startDir);

	while (true) {
		const entries = await readDirEntries(current);
		const entry = entries.find(e => e.name === name);
		if (entry) {
			if (file && entry.isFile()) return path.join(current, name);
			if (dir && entry.isDirectory()) return path.join(current, name);
		}
		const parent = path.dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

/**
 * Walk up from startDir looking for a `.git` entry (file or directory).
 * Returns the directory containing `.git` (the repo root), or null if not in a git repo.
 * Results are based on the cached readDirEntries, so repeated calls are cheap.
 */
export async function findRepoRoot(startDir: string): Promise<string | null> {
	let current = resolvePath(startDir);
	while (true) {
		const entries = await readDirEntries(current);
		if (entries.some(e => e.name === ".git")) {
			return current;
		}
		const parent = path.dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

export function cacheStats(): { content: number; dir: number } {
	return {
		content: contentCache.size,
		dir: dirCache.size,
	};
}

export function clearCache(): void {
	contentCache.clear();
	dirCache.clear();
}

export function invalidate(filePath: string): void {
	const abs = resolvePath(filePath);
	contentCache.delete(abs);
	dirCache.delete(abs);
	const parent = path.dirname(abs);
	if (parent !== abs) {
		dirCache.delete(parent);
	}
}
