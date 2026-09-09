import * as fs from "node:fs";
import * as path from "node:path";
import type { ChangelogBoundary } from "../../commit/types";

const CHANGELOG_NAME = "CHANGELOG.md";

export async function detectChangelogBoundaries(cwd: string, stagedFiles: string[]): Promise<ChangelogBoundary[]> {
	const boundaries = new Map<string, string[]>();
	for (const file of stagedFiles) {
		if (file.toLowerCase().endsWith("changelog.md")) continue;
		const changelogPath = await findNearestChangelog(cwd, file);
		if (!changelogPath) continue;
		const list = boundaries.get(changelogPath) ?? [];
		list.push(file);
		boundaries.set(changelogPath, list);
	}

	return Array.from(boundaries.entries()).map(([changelogPath, files]) => ({
		changelogPath,
		files,
	}));
}

async function findNearestChangelog(cwd: string, filePath: string): Promise<string | null> {
	let current = path.resolve(cwd, path.dirname(filePath));
	const root = path.resolve(cwd);
	while (true) {
		const candidate = path.resolve(current, CHANGELOG_NAME);
		try {
			await fs.promises.access(candidate);
			return candidate;
		} catch {
			// not found, continue traversal
		}
		if (current === root) return null;
		const parent = path.dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}
