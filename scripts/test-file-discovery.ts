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

/**
 * The workspace package directories the root `package.json` declares, relative to `repoRoot`. Links
 * are followed, as `bun` follows them when it resolves workspaces, so a linked package is listed too.
 */
export async function workspacePackageDirs(repoRoot: string): Promise<string[]> {
	const manifest = (await Bun.file(path.join(repoRoot, "package.json")).json()) as {
		workspaces: { packages: string[] };
	};
	const dirs: string[] = [];
	for (const pattern of manifest.workspaces.packages) {
		for await (const manifestPath of new Bun.Glob(`${pattern}/package.json`).scan({
			cwd: repoRoot,
			followSymlinks: true,
		})) {
			dirs.push(path.dirname(manifestPath).split(path.sep).join("/"));
		}
	}
	return dirs.sort();
}

/** What CI runs: test files it names, and directories in which it runs every test `bun test` finds. */
export interface Buckets {
	files: string[];
	dirs: string[];
}

/**
 * The test files below `roots` (paths relative to `repoRoot`) that no bucket runs. A file is run when
 * a bucket names it or it lies below a bucketed directory by its own spelling, or when its real path
 * is the real path of a file a bucket runs: a link to a test CI runs is the same test. A link to a
 * file a bucketed directory holds but `bun test` there would not run (not a test name, or in
 * `node_modules` or a dot-directory) is not covered.
 */
export async function testFilesWithoutBucket(repoRoot: string, roots: string[], buckets: Buckets): Promise<string[]> {
	const real = (file: string) => fs.realpath(path.join(repoRoot, file)).catch(() => undefined);
	const run = new Set<string | undefined>(await Promise.all(buckets.files.map(real)));
	for (const dir of buckets.dirs) {
		const files = await collectTestsUnder(path.join(repoRoot, dir), repoRoot).catch(() => []);
		for (const file of await Promise.all(files.map(real))) run.add(file);
	}
	const missing: string[] = [];
	for (const root of roots) {
		for (const file of await collectTestsUnder(path.join(repoRoot, root), repoRoot)) {
			if (buckets.files.includes(file) || buckets.dirs.some(dir => file.startsWith(`${dir}/`))) continue;
			if (run.has(await real(file))) continue;
			missing.push(file);
		}
	}
	return missing;
}
