import * as fs from "node:fs/promises";
import * as path from "node:path";

/**
 * Bun's own test-file naming: `*.test.*`, `*_test.*`, `*.spec.*` and `*_spec.*` over every
 * extension `bun test` discovers (js, jsx, ts, tsx, mjs, cjs, mts, cts), in any letter case, as
 * Bun matches them. Collecting a narrower set leaves the rest unrun; `test-file-discovery.test.ts`
 * compares this with what `bun test` finds.
 */
export const testFilePattern = /[._](test|spec)\.(?:[jt]sx?|[cm][jt]s)$/i;

/** The `[test]` settings of a `bunfig.toml` that change which files `bun test` selects. */
interface BunTestConfig {
	/** `[test] root`: the directory `bun test` scans when the command names no file. Default: the working directory. */
	root: string;
	/** `[test] pathIgnorePatterns`, one pattern or a list, matched against paths relative to the working directory. */
	ignore: Bun.Glob[];
}

const bunTestConfigs = new Map<string, Promise<BunTestConfig>>();

/**
 * The test settings of the `bunfig.toml` in `cwd`, the only one `bun test` reads when it runs there
 * (it reads neither a parent directory's nor the global one). Read once per directory and process.
 */
function bunTestConfig(cwd: string): Promise<BunTestConfig> {
	let config = bunTestConfigs.get(cwd);
	if (!config) {
		config = readBunTestConfig(cwd);
		bunTestConfigs.set(cwd, config);
	}
	return config;
}

async function readBunTestConfig(cwd: string): Promise<BunTestConfig> {
	const file = path.join(cwd, "bunfig.toml");
	let text: string;
	try {
		text = await Bun.file(file).text();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { root: cwd, ignore: [] };
		throw error;
	}
	let config: { test?: { root?: unknown; pathIgnorePatterns?: unknown } };
	try {
		config = Bun.TOML.parse(text) as typeof config;
	} catch (error) {
		// `bun test` refuses to start on the same file, so no test runs there: report it, not a guess.
		throw new Error(
			`${file} is not valid TOML, and \`bun test\` fails to start there too: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	const { root, pathIgnorePatterns } = config.test ?? {};
	const patterns =
		typeof pathIgnorePatterns === "string"
			? [pathIgnorePatterns]
			: Array.isArray(pathIgnorePatterns)
				? pathIgnorePatterns.filter(pattern => typeof pattern === "string")
				: [];
	return {
		root: typeof root === "string" ? path.resolve(cwd, root) : cwd,
		ignore: patterns.map(pattern => new Bun.Glob(pattern)),
	};
}

/** Whether `config` ignores `spelling`: the path as reached, links not resolved, relative to `cwd`. */
function isIgnored(config: BunTestConfig, cwd: string, spelling: string): boolean {
	const relative = path.relative(cwd, spelling).split(path.sep).join("/");
	return config.ignore.some(glob => glob.match(relative));
}

function isWithin(parent: string, child: string): boolean {
	const relative = path.relative(parent, child);
	return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

interface WalkRules {
	/** Skip a directory, and everything below it, by the path it was reached at. */
	pruneDirectory?: (spelling: string) => boolean;
	/** Skip a file by the path it was reached at; another path to the same real file can still take it. */
	skipFile?: (spelling: string) => boolean;
}

/**
 * The test files below `start` by name, as `/`-separated paths relative to `baseDir`. Like
 * `bun test` it skips `node_modules` and dot-directories, follows symbolic links to files and
 * directories, and takes each real file once, by the first path `rules` does not skip. A link back
 * to a directory being walked (a cycle) is not followed; a dangling link and a missing `start` are
 * ignored.
 */
async function walkTestFiles(start: string, baseDir: string, rules: WalkRules): Promise<string[]> {
	const taken = new Set<string>();
	const ancestors = new Set<string>();
	const files: string[] = [];
	const visit = async (dir: string): Promise<void> => {
		let realDir: string;
		try {
			realDir = await fs.realpath(dir);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw error;
		}
		if (ancestors.has(realDir)) return;
		ancestors.add(realDir);
		try {
			const entries = await fs.readdir(dir, { withFileTypes: true });
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
					if (rules.pruneDirectory?.(filePath)) continue;
					await visit(filePath);
					continue;
				}
				if (!isFile || !testFilePattern.test(entry.name) || rules.skipFile?.(filePath)) continue;
				const realFile = await fs.realpath(filePath);
				if (taken.has(realFile)) continue;
				taken.add(realFile);
				files.push(path.relative(baseDir, filePath).split(path.sep).join("/"));
			}
		} finally {
			ancestors.delete(realDir);
		}
	};
	await visit(start);
	return files;
}

/**
 * The test files below `dir` that `bun test`, run in `cwd` and naming no file (or only name filters),
 * selects, as `/`-separated paths relative to `baseDir`. It scans only inside `cwd`'s `[test] root`,
 * prunes directories and skips files `cwd`'s `pathIgnorePatterns` match, each judged by the path it
 * was reached at, so a link around an ignored directory still reaches its tests. Otherwise it walks
 * as {@link walkTestFiles} does.
 */
export async function collectTestsUnder(dir: string, baseDir: string, cwd = dir): Promise<string[]> {
	const config = await bunTestConfig(cwd);
	const start = isWithin(config.root, dir) ? dir : isWithin(dir, config.root) ? config.root : undefined;
	if (start === undefined) return [];
	const pruned = (spelling: string) => isIgnored(config, cwd, spelling);
	// The directories between root and `start` are scanned on the way down, so their rules apply too.
	let spelling = config.root;
	for (const segment of path.relative(config.root, start).split(path.sep).filter(Boolean)) {
		spelling = path.join(spelling, segment);
		if (segment === "node_modules" || segment.startsWith(".") || pruned(spelling)) return [];
	}
	return walkTestFiles(start, baseDir, { pruneDirectory: pruned, skipFile: pruned });
}

/**
 * The test files below `dir` that `bun test ./<file>…`, run in `cwd`, runs when the command names
 * each of them: every test file by name, except one whose own path `cwd`'s `pathIgnorePatterns`
 * match. A named file is not limited to `[test] root`, and a pattern that only matches one of its
 * directories does not skip it. Each real file is named once, by a path Bun does not skip.
 */
export async function namedTestFilesUnder(dir: string, baseDir: string, cwd: string): Promise<string[]> {
	const config = await bunTestConfig(cwd);
	return walkTestFiles(dir, baseDir, { skipFile: spelling => isIgnored(config, cwd, spelling) });
}

/**
 * Every test file below `dir` by name, whatever any `bunfig.toml` says: the files that exist and
 * must each be run by some command.
 */
export function testFilesByName(dir: string, baseDir: string): Promise<string[]> {
	return walkTestFiles(dir, baseDir, {});
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

/**
 * What CI runs: test files its commands name (`bun test ./<file>`), and directories below which a
 * command naming no file (or only name filters) runs every test `bun test` selects.
 */
export interface Buckets {
	files: BucketEntry[];
	dirs: BucketEntry[];
}

/**
 * The test files below `roots` (paths relative to `repoRoot`) that no bucket runs. The candidates
 * are every test file by name: no `bunfig.toml` applies to them, because no command runs there to
 * read it. A candidate is run when its own path or its real path is that of a file a bucket command
 * runs: a file it names that its working directory's `pathIgnorePatterns` do not skip, or a file
 * {@link collectTestsUnder} finds below a bucketed directory from the command's working directory. A
 * link to a test CI runs is the same test; a link to a file the command skips is not covered. A
 * `bunfig.toml` that is not valid TOML throws, as `bun test` fails there too.
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
		if (!isIgnored(await bunTestConfig(cwd), cwd, path.join(repoRoot, entry.path))) await add(entry.path);
	}
	for (const entry of buckets.dirs) {
		const cwd = path.join(repoRoot, entry.cwd);
		for (const file of await collectTestsUnder(path.join(repoRoot, entry.path), repoRoot, cwd)) await add(file);
	}
	const missing: string[] = [];
	for (const root of roots) {
		for (const file of await testFilesByName(path.join(repoRoot, root), repoRoot)) {
			if (spelled.has(file)) continue;
			const realFile = await real(file);
			if (realFile && realRun.has(realFile)) continue;
			missing.push(file);
		}
	}
	return missing;
}
