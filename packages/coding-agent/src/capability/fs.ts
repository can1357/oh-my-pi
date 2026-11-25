import * as fs from "node:fs";
import * as path from "node:path";

interface CachedContent {
	content: string | null;
	mtimeMs: number | undefined;
	size: number | undefined;
	missing: boolean;
}

const contentCache = new Map<string, CachedContent>();
const dirCache = new Map<string, fs.Dirent[]>();

function resolvePath(filePath: string): string {
	return path.resolve(filePath);
}

/** Read discovery files through a cache scoped to one scan. */
export function createFileReader(): (filePath: string) => Promise<string | null> {
	const cache = new Map<string, string | null>();
	return filePath => readFileWithCache(filePath, cache);
}

/** Read a discovery file through the process-local content cache. */
export function readFile(filePath: string): Promise<string | null> {
	return readFileValidated(filePath);
}


/**
 * Process-lifetime read with mtime+size validation: advisor @-imports hit this
 * long after startup, so an edit on disk must be picked up instead of served
 * stale for the rest of the process. Entries cached as missing re-check too,
 * so a file created after the first miss is found on the next read.
 */
async function readFileValidated(filePath: string): Promise<string | null> {
	const abs = resolvePath(filePath);
	const cached = contentCache.get(abs);
	if (cached) {
		try {
			const stats = await fs.promises.stat(abs);
			if (!cached.missing && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size && stats.isFile()) {
				return cached.content;
			}
		} catch {
			if (cached.missing) return null;
		}
	}
	try {
		// Same FIFO/device guard as readFileWithCache: `.text()` on a
		// FIFO/socket blocks until EOF, hanging the caller forever.
		const stats = await fs.promises.stat(abs);
		if (!stats.isFile()) {
			contentCache.set(abs, { content: null, mtimeMs: undefined, size: undefined, missing: false });
			return null;
		}
		const content = await Bun.file(abs).text();
		contentCache.set(abs, { content, mtimeMs: stats.mtimeMs, size: stats.size, missing: false });
		return content;
	} catch {
		contentCache.set(abs, { content: null, mtimeMs: undefined, size: undefined, missing: true });
		return null;
	}
}

async function readFileWithCache(filePath: string, cache: Map<string, string | null>): Promise<string | null> {
	const abs = resolvePath(filePath);
	const cached = cache.get(abs);
	if (cached !== undefined) return cached;

	try {
		// Gate on the file type first: discovery scans foreign config dirs
		// (~/.claude, ~/.cursor, project trees), and reading a FIFO/socket/char
		// device with `.text()` blocks until EOF — i.e. forever — hanging
		// startup with zero output. `stat` follows symlinks, so symlinked
		// context files (CLAUDE.md -> AGENTS.md) still resolve.
		const stats = await fs.promises.stat(abs);
		if (!stats.isFile()) {
			cache.set(abs, null);
			return null;
		}
		const content = await Bun.file(abs).text();
		cache.set(abs, content);
		return content;
	} catch {
		cache.set(abs, null);
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
