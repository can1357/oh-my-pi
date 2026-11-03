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
	/**
	 * `[test] root`, resolved against the working directory, inside it or not: the directory `bun test`
	 * scans when the command names no file. Default: the working directory.
	 */
	root: string;
	/**
	 * `[test] pathIgnorePatterns`, one pattern or a list, matched against paths relative to the working
	 * directory (`../` included when the root lies outside it).
	 */
	ignore: Bun.Glob[];
	/**
	 * How many times the walk enters one real directory along one path, so a cycle of links is walked
	 * that often. `bun test` follows a cycle until a path fails with `ELOOP`, and a later spelling can
	 * escape a pattern an earlier one matched (`loop/a.test.ts` for `a.test.ts`). A pattern of `m`
	 * segments matches every spelling `prefix/unit^k/rest` with `k > m` alike: at least one copy of the
	 * cycle's unit then lies wholly inside a `**`, which also absorbs one copy more or less. So `m + 1`
	 * repetitions (`m + 2` entries) decide every spelling; with no pattern, one entry does.
	 */
	cycleVisits: number;
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
		cycleVisits: patterns.length === 0 ? 1 : Math.max(...patterns.map(pattern => pattern.split("/").length)) + 2,
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
	/** How many times one real directory may appear on the walk's stack (see {@link BunTestConfig.cycleVisits}). Default 1. */
	cycleVisits?: number;
}

/**
 * The test files below `start` by name, as `/`-separated paths relative to `baseDir`. Like
 * `bun test` it skips `node_modules` and dot-directories, follows symbolic links to files and
 * directories, and takes each real file once, by the first path `rules` does not skip. A link back
 * to a directory being walked (a cycle) is followed until that directory is on the walk's stack
 * `rules.cycleVisits` times. Each extra time is a further pass that adds only files the passes
 * before it did not take, so a file gets its path with the fewest turns of a cycle. A dangling link
 * and a missing `start` are ignored.
 */
async function walkTestFiles(start: string, baseDir: string, rules: WalkRules): Promise<string[]> {
	const taken = new Set<string>();
	const files: string[] = [];
	const onStack = new Map<string, number>();
	let cutCycle = false;
	const visit = async (dir: string, limit: number): Promise<void> => {
		let realDir: string;
		try {
			realDir = await fs.realpath(dir);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw error;
		}
		const visits = onStack.get(realDir) ?? 0;
		if (visits >= limit) {
			cutCycle = true;
			return;
		}
		onStack.set(realDir, visits + 1);
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
					await visit(filePath, limit);
					continue;
				}
				if (!isFile || !testFilePattern.test(entry.name) || rules.skipFile?.(filePath)) continue;
				const realFile = await fs.realpath(filePath);
				if (taken.has(realFile)) continue;
				taken.add(realFile);
				files.push(path.relative(baseDir, filePath).split(path.sep).join("/"));
			}
		} finally {
			if (visits === 0) onStack.delete(realDir);
			else onStack.set(realDir, visits);
		}
	};
	for (let limit = 1; limit <= (rules.cycleVisits ?? 1); limit++) {
		cutCycle = false;
		await visit(start, limit);
		if (!cutCycle) break;
	}
	return files;
}

function selectionRules(config: BunTestConfig, cwd: string): WalkRules {
	const ignored = (spelling: string) => isIgnored(config, cwd, spelling);
	// From a root above the working directory, `bun test` walks into neither the working directory
	// nor any directory between them: their paths relative to it end in `.` or `..`.
	const prune = (spelling: string) => isWithin(spelling, cwd) || ignored(spelling);
	return { pruneDirectory: prune, skipFile: ignored, cycleVisits: config.cycleVisits };
}

/**
 * The test files `bun test`, run in `cwd` and naming no file (or only name filters), selects, as
 * `/`-separated paths relative to `baseDir`; for a `dir` other than `cwd`, only those below `dir`.
 * The command scans below `cwd`'s `[test] root`, inside `cwd` or outside it (a root above `cwd`, or
 * beside it, gives paths starting `../`); a missing root selects nothing, and from a root above
 * `cwd` it skips `cwd` and the directories between them. It prunes directories and skips files
 * `cwd`'s `pathIgnorePatterns` match, each judged by the path it was reached at, so a link around
 * an ignored directory still reaches its tests. Otherwise it walks as {@link walkTestFiles} does.
 */
export async function collectTestsUnder(dir: string, baseDir: string, cwd = dir): Promise<string[]> {
	const config = await bunTestConfig(cwd);
	const rules = selectionRules(config, cwd);
	if (path.resolve(dir) === path.resolve(cwd) || isWithin(dir, config.root)) {
		return walkTestFiles(config.root, baseDir, rules);
	}
	if (!isWithin(config.root, dir)) return [];
	// The directories between root and `dir` are scanned on the way down, so their rules apply too.
	let spelling = config.root;
	for (const segment of path.relative(config.root, dir).split(path.sep).filter(Boolean)) {
		spelling = path.join(spelling, segment);
		if (segment === "node_modules" || segment.startsWith(".") || rules.pruneDirectory?.(spelling)) return [];
	}
	return walkTestFiles(dir, baseDir, rules);
}

/**
 * The test files below `dir` that `bun test ./<file>…`, run in `cwd`, runs when the command names
 * each of them: every test file by name, except one whose own path `cwd`'s `pathIgnorePatterns`
 * match. A named file is not limited to `[test] root`, and a pattern that only matches one of its
 * directories does not skip it. Each real file is named once, by a path Bun does not skip.
 */
export async function namedTestFilesUnder(dir: string, baseDir: string, cwd: string): Promise<string[]> {
	const config = await bunTestConfig(cwd);
	return walkTestFiles(dir, baseDir, { ...selectionRules(config, cwd), pruneDirectory: undefined });
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

/** A test file a command names: `bun test ./<path>` run in `cwd` (both relative to the repository). */
export interface BucketEntry {
	path: string;
	cwd: string;
}

/** A command that names no file: `bun test` run in `cwd` (relative to the repository). */
export interface BucketCommand {
	cwd: string;
}

/**
 * What CI runs: test files its commands name, and commands that name no file (or only name filters),
 * each of which runs every test `bun test` selects in its working directory, below `[test] root`
 * wherever that lies.
 */
export interface Buckets {
	files: BucketEntry[];
	dirs: BucketCommand[];
}

/**
 * Groups of test files among `spellings` (relative to `repoRoot`) whose paths, or whose real paths,
 * are equal but for letter case. `bun test` runs one file of such a group in place of the others,
 * whether they differ in the file name or in a directory, and even when a command names another one.
 */
async function caseTwins(repoRoot: string, spellings: Iterable<string>): Promise<string[][]> {
	const byKey = new Map<string, Map<string, string>>();
	for (const file of spellings) {
		const spelling = path.resolve(repoRoot, file);
		const realFile = await fs.realpath(spelling).catch(() => undefined);
		if (!realFile) continue;
		for (const key of new Set([spelling.toLowerCase(), realFile.toLowerCase()])) {
			let group = byKey.get(key);
			if (!group) byKey.set(key, (group = new Map()));
			if (!group.has(realFile)) group.set(realFile, file);
		}
	}
	const groups = new Map<string, string[]>();
	for (const group of byKey.values()) {
		if (group.size < 2) continue;
		const files = [...group.values()].sort();
		groups.set(files.join("\n"), files);
	}
	return [...groups.values()];
}

/**
 * The test files below `roots` (paths relative to `repoRoot`) that no bucket runs. The candidates
 * are every test file by name: no `bunfig.toml` applies to them, because no command runs there to
 * read it. A candidate is run when its own path or its real path is that of a file a bucket command
 * runs: a file it names that its working directory's `pathIgnorePatterns` do not skip, or a file
 * {@link collectTestsUnder} finds for a command that names no file. A link to a test CI runs is the
 * same test; a link to a file the command skips is not covered.
 *
 * It throws, naming the files, when a `bunfig.toml` a command reads is not valid TOML (`bun test`
 * fails there too), and when test files differ only in letter case (`bun test` runs one of them).
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
	for (const command of buckets.dirs) {
		const cwd = path.join(repoRoot, command.cwd);
		for (const file of await collectTestsUnder(cwd, repoRoot, cwd)) await add(file);
	}
	const candidates: string[] = [];
	for (const root of roots) candidates.push(...(await testFilesByName(path.join(repoRoot, root), repoRoot)));
	const twins = await caseTwins(repoRoot, [...candidates, ...spelled]);
	if (twins.length > 0) {
		throw new Error(
			`These test files differ only in letter case, and \`bun test\` runs one file of each group in place of the others, so CI does not run them all. Rename them apart:\n${twins.map(group => group.join("  ")).join("\n")}`,
		);
	}
	const missing: string[] = [];
	for (const file of candidates) {
		if (spelled.has(file)) continue;
		const realFile = await real(file);
		if (realFile && realRun.has(realFile)) continue;
		missing.push(file);
	}
	return missing;
}
