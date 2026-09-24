import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { shortenPath } from "@oh-my-pi/pi-tui/render/render-utils";
import { formatPathRelativeToCwd } from "./path-utils";

const MAX_ANCESTOR_HOPS = 8;
const MAX_LISTED_ENTRIES = 12;

/**
 * Render an existing directory the way tools spell paths: relative to the
 * session cwd when inside it, otherwise a home-shortened portable absolute
 * path. The filesystem root keeps its single separator instead of doubling it.
 */
export function formatDirectoryDisplay(absoluteDir: string, cwd: string): string {
	const display = formatPathRelativeToCwd(absoluteDir, cwd, { trailingSlash: true });
	if (!path.isAbsolute(display)) return display;
	// The display contract normalizes separators, so match it on the home
	// prefix too instead of relying on the native-separator default.
	return shortenPath(display, os.homedir().replaceAll(path.win32.sep, path.posix.sep));
}

/**
 * On a not-found path, list the nearest existing ancestor's children so the
 * caller can correct the target without separately probing the filesystem.
 *
 * Returns undefined whenever the hint would be noise (existing parent not
 * found within the hop budget, unreadable directory, or a listing failure).
 */
export async function describeNearestExistingDir(
	missingPath: string,
	baseDir?: string,
	signal?: AbortSignal,
): Promise<string | undefined> {
	try {
		const cwd = baseDir ?? process.cwd();
		let current = path.resolve(cwd, missingPath);
		for (let hops = 0; hops < MAX_ANCESTOR_HOPS; hops++) {
			if (signal?.aborted) return undefined;
			const parent = path.dirname(current);
			if (parent === current) break; // reached filesystem root
			current = parent;
			let stat: fs.Stats;
			try {
				stat = await fs.promises.stat(current);
			} catch {
				continue;
			}
			if (!stat.isDirectory()) continue;
			return await describeDirectoryContents(current, cwd, signal);
		}
	} catch {
		// The hint is best-effort; never mask the original not-found error.
	}
	return undefined;
}

/**
 * Describe a directory's children without materializing or sorting all of
 * them: only the leading entries the hint can print are retained, so a typo
 * beneath a huge directory costs a bounded scan instead of unbounded work.
 */
async function describeDirectoryContents(dir: string, cwd: string, signal?: AbortSignal): Promise<string | undefined> {
	const display = formatDirectoryDisplay(dir, cwd);
	const handle = await fs.promises.opendir(dir);
	const dirs: string[] = [];
	const files: string[] = [];
	let total = 0;
	try {
		for await (const entry of handle) {
			if (signal?.aborted) return undefined;
			total++;
			const kept = entry.isDirectory() ? dirs : files;
			const last = kept[kept.length - 1];
			if (kept.length === MAX_LISTED_ENTRIES && last.localeCompare(entry.name) <= 0) continue;
			kept.splice(insertionIndex(kept, entry.name), 0, entry.name);
			if (kept.length > MAX_LISTED_ENTRIES) kept.pop();
		}
	} finally {
		await handle.close().catch(() => {});
	}
	if (total === 0) return `Nearest existing directory: ${display} (empty)`;
	const listed = [...dirs.map(name => `${name}/`), ...files].slice(0, MAX_LISTED_ENTRIES);
	const more = total > MAX_LISTED_ENTRIES ? `, … +${total - MAX_LISTED_ENTRIES} more` : "";
	return `Nearest existing directory: ${display} contains: ${listed.join(", ")}${more}`;
}

/** First index whose element sorts after `name`, for insertion into a sorted array. */
function insertionIndex(sorted: readonly string[], name: string): number {
	let lo = 0;
	let hi = sorted.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (sorted[mid].localeCompare(name) < 0) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}

/** Append the hint to a not-found error message when one is available. */
export async function withPathHint(
	message: string,
	missingPath: string,
	baseDir?: string,
	signal?: AbortSignal,
): Promise<string> {
	const hint = await describeNearestExistingDir(missingPath, baseDir, signal);
	return hint ? `${message}\n${hint}` : message;
}
