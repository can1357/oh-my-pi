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
 * The `[test] pathIgnorePatterns` of the `bunfig.toml` in `cwd`, the only one `bun test` reads when
 * it runs there. `bun test` skips a matching file even when the command names it.
 */
async function bunTestIgnorePatterns(cwd: string): Promise<Bun.Glob[]> {
	let text: string;
	try {
		text = await Bun.file(path.join(cwd, "bunfig.toml")).text();
	} catch {
		return [];
	}
	const config = Bun.TOML.parse(text) as { test?: { pathIgnorePatterns?: unknown } };
	const patterns = config.test?.pathIgnorePatterns;
	return Array.isArray(patterns) ? patterns.filter(p => typeof p === "string").map(p => new Bun.Glob(p)) : [];
}

/**
 * The test files `bun test`, run in `cwd`, finds below `root`, as `/`-separated paths relative to
 * `baseDir`. It skips `node_modules`, dot-directories and files `cwd`'s `bunfig.toml` ignores, and
 * like `bun test` it follows symbolic links to files and directories and takes each real file once:
 * a file or directory already reached by another path, or a link cycle, is skipped, and a dangling
 * link is ignored.
 */
export async function collectTestsUnder(root: string, baseDir: string, cwd = root): Promise<string[]> {
	const ignore = await bunTestIgnorePatterns(cwd);
	const ignored = (file: string) => {
		const relative = path.relative(cwd, file).split(path.sep).join("/");
		return ignore.some(glob => glob.match(relative));
	};
	const seen = new Set<string>();
	const walk = async (dir: string): Promise<string[]> => {
		const realDir = await fs.realpath(dir);
		if (seen.has(realDir)) return [];
		seen.add(realDir);
		const entries = await fs.readdir(dir, { withFileTypes: true });
		const files: string[] = [];
		for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
			const filePath = path.join(dir, entry.name);
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
				files.push(...(await walk(filePath)));
				continue;
			}
			if (!isFile || !testFilePattern.test(entry.name) || ignored(filePath)) continue;
			const realFile = await fs.realpath(filePath);
			if (seen.has(realFile)) continue;
			seen.add(realFile);
			files.push(path.relative(baseDir, filePath).split(path.sep).join("/"));
		}
		return files;
	};
	return walk(root);
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

/** A path CI's commands cover, and the directory the covering `bun test` runs in (both relative to the repository). */
export interface BucketEntry {
	path: string;
	cwd: string;
}

/** What CI runs: test files it names, and directories in which it runs every test `bun test` finds. */
export interface Buckets {
	files: BucketEntry[];
	dirs: BucketEntry[];
}

/**
 * The test files below `roots` (paths relative to `repoRoot`) that no bucket runs. A file is run when
 * its own path or its real path is that of a file a bucket command runs: a file it names, or a file
 * `bun test` finds below a bucketed directory, both as `bun test` selects them in the command's
 * working directory (its `bunfig.toml` ignores included). A link to a test CI runs is the same test;
 * a link to a file the command skips is not covered.
 */
export async function testFilesWithoutBucket(repoRoot: string, roots: string[], buckets: Buckets): Promise<string[]> {
	const real = (file: string) => fs.realpath(path.join(repoRoot, file)).catch(() => undefined);
	const spelled = new Set<string>();
	const realRun = new Set<string>();
	const add = async (file: string) => {
		spelled.add(file);
		const realFile = await real(file);
		if (realFile) realRun.add(realFile);
	};
	for (const entry of buckets.files) {
		const cwd = path.join(repoRoot, entry.cwd);
		const ignore = await bunTestIgnorePatterns(cwd);
		const relative = path.relative(cwd, path.join(repoRoot, entry.path)).split(path.sep).join("/");
		if (!ignore.some(glob => glob.match(relative))) await add(entry.path);
	}
	for (const entry of buckets.dirs) {
		const files = await collectTestsUnder(
			path.join(repoRoot, entry.path),
			repoRoot,
			path.join(repoRoot, entry.cwd),
		).catch(() => []);
		for (const file of files) await add(file);
	}
	const missing: string[] = [];
	for (const root of roots) {
		for (const file of await collectTestsUnder(path.join(repoRoot, root), repoRoot, path.join(repoRoot, root))) {
			if (spelled.has(file)) continue;
			const realFile = await real(file);
			if (realFile && realRun.has(realFile)) continue;
			missing.push(file);
		}
	}
	return missing;
}
