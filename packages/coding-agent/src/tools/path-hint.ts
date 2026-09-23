import * as fs from "node:fs";
import * as path from "node:path";

const MAX_ANCESTOR_HOPS = 8;
const MAX_LISTED_ENTRIES = 12;

/**
 * On a not-found path, list the nearest existing ancestor's children so the
 * caller can correct the target without separately probing the filesystem.
 *
 * Returns undefined whenever the hint would be noise (existing parent not
 * found within the hop budget, unreadable directory, or a listing failure).
 */
export async function describeNearestExistingDir(missingPath: string, baseDir?: string): Promise<string | undefined> {
	try {
		let current = path.resolve(baseDir ?? process.cwd(), missingPath);
		for (let hops = 0; hops < MAX_ANCESTOR_HOPS; hops++) {
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
			const entries = await fs.promises.readdir(current, { withFileTypes: true });
			if (entries.length === 0) return `Nearest existing directory: ${current}/ (empty)`;
			const dirsFirst = entries.sort(
				(a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name),
			);
			const listed = dirsFirst
				.slice(0, MAX_LISTED_ENTRIES)
				.map(entry => (entry.isDirectory() ? `${entry.name}/` : entry.name));
			const more = entries.length > MAX_LISTED_ENTRIES ? `, … +${entries.length - MAX_LISTED_ENTRIES} more` : "";
			return `Nearest existing directory: ${current}/ contains: ${listed.join(", ")}${more}`;
		}
	} catch {
		// The hint is best-effort; never mask the original not-found error.
	}
	return undefined;
}

/** Append the hint to a not-found error message when one is available. */
export async function withPathHint(message: string, missingPath: string, baseDir?: string): Promise<string> {
	const hint = await describeNearestExistingDir(missingPath, baseDir);
	return hint ? `${message}\n${hint}` : message;
}
