import * as fs from "node:fs/promises";
import * as path from "node:path";

/**
 * Bun's own test-file naming: `*.test.*`, `*_test.*`, `*.spec.*` and `*_spec.*` over every
 * extension `bun test` discovers (js, jsx, ts, tsx, mjs, cjs, mts, cts), in any letter case, as
 * Bun matches them. Collecting a narrower set leaves the rest unrun; `test-file-discovery.test.ts`
 * compares this with what `bun test` finds.
 */
export const testFilePattern = /[._](test|spec)\.(?:[jt]sx?|[cm][jt]s)$/i;

/**
 * Test files below `root`, as `/`-separated paths relative to `baseDir`, skipping `node_modules` and
 * dot-directories. Like `bun test`, it follows symbolic links to files and directories and runs each
 * real file once: a file or directory already reached by another path, or a link cycle, is skipped,
 * and a dangling link is ignored.
 */
export async function collectTestsUnder(root: string, baseDir: string, seen = new Set<string>()): Promise<string[]> {
	const realRoot = await fs.realpath(root);
	if (seen.has(realRoot)) return [];
	seen.add(realRoot);
	const entries = await fs.readdir(root, { withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
		const filePath = path.join(root, entry.name);
		let isDirectory = entry.isDirectory();
		let isFile = entry.isFile();
		if (entry.isSymbolicLink()) {
			const target = await fs.stat(filePath).catch(() => null);
			if (!target) continue;
			isDirectory = target.isDirectory();
			isFile = target.isFile();
		}
		if (isDirectory) {
			if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
			files.push(...(await collectTestsUnder(filePath, baseDir, seen)));
			continue;
		}
		if (!isFile || !testFilePattern.test(entry.name)) continue;
		const realFile = await fs.realpath(filePath);
		if (seen.has(realFile)) continue;
		seen.add(realFile);
		files.push(path.relative(baseDir, filePath).split(path.sep).join("/"));
	}
	return files;
}
