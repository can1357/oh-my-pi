import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getDocumentConversionCacheDir, isEnoent, logger } from "@oh-my-pi/pi-utils";
import packageJson from "../../package.json" with { type: "json" };

/**
 * Cache schema/format revision. Bumping it changes the on-disk key prefix
 * (`v<N>-...`), so old entries become unreachable and are pruned naturally.
 * Bump when the cache *file* shape changes (entry JSON layout, key scheme).
 *
 * Converter *output* changes are handled separately: the package version is
 * folded into the key (see {@link markitConversionCacheKey}), so any release
 * that ships new markdown from `src/markit/converters/*` auto-invalidates the
 * cache without a manual bump here.
 */
export const MARKIT_CONVERSION_CACHE_VERSION = 1;
export const MAX_MARKIT_CONVERSION_CACHE_BYTES = 256 * 1024 * 1024;
/** `.tmp` files older than this are treated as orphaned writes and swept. */
const TMP_ORPHAN_MAX_AGE_MS = 5 * 60 * 1000;
export type MarkitConversionCacheStatus = "hit" | "miss" | "skipped";

export type MarkitConversionCacheReadResult = { status: "hit"; content: string } | { status: "miss" };

interface MarkitConversionCacheEntry {
	version: number;
	content: string;
}

export function markitConversionCacheKey(bytes: Uint8Array, extension: string): string {
	const normalizedExtension = extension.trim().toLowerCase().replace(/^\.+/, "") || "bin";
	const safeExtension = normalizedExtension.replace(/[^a-z0-9]+/g, "_") || "bin";
	const safeVersion = packageJson.version.replace(/[^a-z0-9]+/gi, "_");
	const digest = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
	return `v${MARKIT_CONVERSION_CACHE_VERSION}-${safeVersion}-${safeExtension}-${digest}`;
}

function cacheEntryPath(key: string): string {
	return path.join(getDocumentConversionCacheDir(), `${key}.json`);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function parseCacheEntry(raw: string): MarkitConversionCacheEntry | null {
	const parsed: unknown = JSON.parse(raw);
	if (typeof parsed !== "object" || parsed === null) return null;
	if (!("version" in parsed) || parsed.version !== MARKIT_CONVERSION_CACHE_VERSION) return null;
	if (!("content" in parsed) || typeof parsed.content !== "string" || parsed.content.length === 0) return null;
	return { version: MARKIT_CONVERSION_CACHE_VERSION, content: parsed.content };
}

export async function readMarkitConversionCache(key: string): Promise<MarkitConversionCacheReadResult> {
	const target = cacheEntryPath(key);
	let raw: string;
	try {
		raw = await Bun.file(target).text();
	} catch (error) {
		if (!isEnoent(error)) {
			logger.debug("document conversion cache read failed", { error: errorMessage(error) });
		}
		return { status: "miss" };
	}

	let entry: MarkitConversionCacheEntry | null;
	try {
		entry = parseCacheEntry(raw);
	} catch (error) {
		logger.debug("document conversion cache read failed", { error: errorMessage(error) });
		entry = null;
	}

	if (!entry) {
		await fs.rm(target, { force: true }).catch(() => undefined);
		return { status: "miss" };
	}

	return { status: "hit", content: entry.content };
}

export async function pruneMarkitConversionCache(cacheDir: string): Promise<void> {
	let names: string[];
	try {
		names = await fs.readdir(cacheDir);
	} catch (error) {
		if (!isEnoent(error)) {
			logger.debug("document conversion cache prune failed", { error: errorMessage(error) });
		}
		return;
	}

	const now = Date.now();
	// Eviction is FIFO by mtime (not LRU): reads do not bump mtime, so a hot
	// entry written long ago is evicted before a cold recent miss. The cap is a
	// coarse disk-footprint safety valve, so the cheaper policy is intentional.
	const entries: { path: string; size: number; mtimeMs: number }[] = [];
	let totalBytes = 0;
	for (const name of names) {
		const entryPath = path.join(cacheDir, name);
		let stat: Stats;
		try {
			stat = await fs.stat(entryPath);
		} catch (error) {
			if (!isEnoent(error)) {
				logger.debug("document conversion cache prune failed", { error: errorMessage(error) });
			}
			continue;
		}
		if (!stat.isFile()) continue;

		// Sweep orphaned `.tmp` files left by a crash/SIGKILL between writeFile
		// and rename; they never become `.json` entries, so the size cap would
		// otherwise never see them.
		if (name.endsWith(".tmp")) {
			if (now - stat.mtimeMs > TMP_ORPHAN_MAX_AGE_MS) {
				await fs.rm(entryPath, { force: true }).catch(() => undefined);
			}
			continue;
		}

		if (!name.endsWith(".json")) continue;
		entries.push({ path: entryPath, size: stat.size, mtimeMs: stat.mtimeMs });
		totalBytes += stat.size;
	}

	if (totalBytes <= MAX_MARKIT_CONVERSION_CACHE_BYTES) return;

	entries.sort((a, b) => a.mtimeMs - b.mtimeMs);
	for (const entry of entries) {
		if (totalBytes <= MAX_MARKIT_CONVERSION_CACHE_BYTES) break;
		try {
			await fs.rm(entry.path, { force: true });
			totalBytes -= entry.size;
		} catch (error) {
			if (!isEnoent(error)) {
				logger.debug("document conversion cache prune failed", { error: errorMessage(error) });
			}
		}
	}
}

export async function writeMarkitConversionCache(key: string, content: string): Promise<void> {
	const cacheDir = getDocumentConversionCacheDir();
	const target = path.join(cacheDir, `${key}.json`);
	// The random suffix keeps concurrent writers (same pid + same ms) from
	// colliding on one temp path before the atomic rename.
	const tempPath = path.join(cacheDir, `${key}.${process.pid}.${Date.now()}.${crypto.randomUUID()}.tmp`);
	const payload = JSON.stringify({ version: MARKIT_CONVERSION_CACHE_VERSION, content });
	try {
		await fs.mkdir(cacheDir, { recursive: true });
		await Bun.write(tempPath, payload);
		await fs.rename(tempPath, target);
	} catch (error) {
		await fs.rm(tempPath, { force: true }).catch(() => undefined);
		logger.debug("document conversion cache write failed", { error: errorMessage(error) });
		return;
	}

	// Prune is just GC: the entry is already on disk under its final name, so
	// fire-and-forget rather than make the caller wait on a readdir + N×stat
	// sweep on every miss (the slow path the cache exists to amortise).
	void pruneMarkitConversionCache(cacheDir).catch(error => {
		logger.debug("document conversion cache prune failed", { error: errorMessage(error) });
	});
}
