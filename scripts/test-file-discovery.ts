import * as fs from "node:fs/promises";
import * as path from "node:path";

/**
 * Bun's own test-file naming: `*.test.*`, `*_test.*`, `*.spec.*` and `*_spec.*` over every
 * extension `bun test` discovers (js, jsx, ts, tsx, mjs, cjs, mts, cts), in any letter case, as
 * Bun matches them. Collecting a narrower set leaves the rest unrun; `test-file-discovery.test.ts`
 * compares this with what `bun test` finds.
 */
export const testFilePattern = /[._](test|spec)\.(?:[jt]sx?|[cm][jt]s)$/i;

/** Test files below `root`, as `/`-separated paths relative to `baseDir`, skipping `node_modules` and dot-directories. */
export async function collectTestsUnder(root: string, baseDir: string): Promise<string[]> {
	const entries = await fs.readdir(root, { withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
		const filePath = path.join(root, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
			files.push(...(await collectTestsUnder(filePath, baseDir)));
			continue;
		}
		if (!entry.isFile() || !testFilePattern.test(entry.name)) {
			continue;
		}
		files.push(path.relative(baseDir, filePath).split(path.sep).join("/"));
	}
	return files;
}
