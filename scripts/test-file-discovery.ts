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
 * The name under which one `bun test` process holds a directory entry: ASCII letters folded,
 * nothing else. Measured against Bun 1.4.4 with real files: of `A.test.ts`/`a.test.ts`,
 * `a.test.TS`/`a.test.ts` and `Dir`/`dir` it reaches one entry of the pair and runs that one's
 * test, while `É`/`é`, `Σ`/`σ`, `Ж`/`ж`, `é`/`e`+U+0301, `ß`/`ss`, `K`(U+212A)/`k`, `ſ`/`s`,
 * `İ`/`i`, `Ａ`/`A` and `ﬁ`/`fi` are two entries whose tests both run. So the collision to catch is
 * ASCII case folding — neither Unicode case folding nor any normalization form.
 */
function foldedName(name: string): string {
	return name.replace(/[A-Z]/g, letter => letter.toLowerCase());
}

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
	/** How many times the walk lists one real directory (see {@link WalkRules.directoryVisits}). */
	directoryVisits: number;
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
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { root: cwd, ignore: [], directoryVisits: 1 };
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
		directoryVisits: patterns.length === 0 ? 1 : Math.max(...patterns.map(pattern => pattern.split("/").length)) + 2,
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

/**
 * How a collision names a path: relative to `baseDir`, or absolute where that lies outside it, so
 * a directory beside the repository is named by its own path rather than a chain of `../`.
 */
function displayPath(baseDir: string, target: string): string {
	const relative = path.relative(baseDir, target).split(path.sep).join("/");
	return relative.startsWith("../") ? target : relative;
}

/** One entry of a real directory, and what it resolves to. */
interface Entry {
	name: string;
	/** The real path the entry resolves to; `null` for a link that resolves to nothing. */
	realPath: string | null;
	isDirectory: boolean;
	isFile: boolean;
}

/** A real directory's entries, and the entries of it that collide by folded name. */
interface Listing {
	entries: Entry[];
	/**
	 * Folded name -> the entries carrying it, for folded names more than one *distinct* real path
	 * answers to. Two spellings of one real file are no collision: either of them runs that file.
	 */
	collisions: Map<string, Entry[]>;
}

/**
 * Reads real directories once each, so every path that reaches one shares the read and the folded
 * names it holds. One `Listings` serves a walk or a guard run; within it no directory is read twice.
 */
class Listings {
	#byRealDir = new Map<string, Promise<Listing>>();

	get(realDir: string): Promise<Listing> {
		let listing = this.#byRealDir.get(realDir);
		if (!listing) {
			listing = readListing(realDir);
			this.#byRealDir.set(realDir, listing);
		}
		return listing;
	}
}

async function readListing(realDir: string): Promise<Listing> {
	const dirents = await fs.readdir(realDir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
		throw error;
	});
	if (!dirents) return { entries: [], collisions: new Map() };
	const entries: Entry[] = [];
	for (const dirent of dirents.sort((a, b) => a.name.localeCompare(b.name))) {
		const full = path.join(realDir, dirent.name);
		let realPath: string | null = full;
		let isDirectory = dirent.isDirectory();
		let isFile = dirent.isFile();
		if (dirent.isSymbolicLink()) {
			const target = await fs.stat(full).catch(() => null);
			realPath = target ? await fs.realpath(full).catch(() => null) : null;
			isDirectory = target?.isDirectory() ?? false;
			isFile = target?.isFile() ?? false;
		}
		entries.push({ name: dirent.name, realPath, isDirectory, isFile });
	}
	const byFolded = new Map<string, Entry[]>();
	for (const entry of entries) {
		const folded = foldedName(entry.name);
		const group = byFolded.get(folded);
		if (group) group.push(entry);
		else byFolded.set(folded, [entry]);
	}
	const collisions = new Map<string, Entry[]>();
	for (const [folded, group] of byFolded) {
		if (group.length < 2) continue;
		// A link beside its own target, or two links to one file, is no collision: whichever entry the
		// process keeps, it runs that one real file. A link resolving to nothing counts as its own.
		const targets = new Set(group.map((entry, index) => entry.realPath ?? `\0dangling-${index}`));
		if (targets.size > 1) collisions.set(folded, group);
	}
	return { entries, collisions };
}

interface WalkRules {
	/** Skip a directory, and everything below it, by the path it was reached at. */
	pruneDirectory?: (spelling: string) => boolean;
	/** Skip a file by the path it was reached at; another path to the same real file can still take it. */
	skipFile?: (spelling: string) => boolean;
	/**
	 * How many times the walk lists one real directory, over the whole walk — not per path. `bun test`
	 * follows a cycle of links until a path fails with `ELOOP`, and a later spelling can escape a
	 * pattern an earlier one matched (`loop/a.test.ts` for `a.test.ts`). A pattern of `m` segments
	 * matches every spelling `prefix/unit^k/rest` with `k > m` alike: at least one copy of the cycle's
	 * unit then lies wholly inside a `**`, which also absorbs one copy more or less. So `m + 1`
	 * repetitions (`m + 2` entries) decide every spelling; with no pattern, one entry does.
	 */
	directoryVisits?: number;
	/**
	 * Report, for each file taken, the folded-name collisions that decide which real file this command
	 * reads through that path (see {@link WalkResult.collisions}). Off for a caller that needs only
	 * the files.
	 */
	reportCollisions?: boolean;
	/** The directory reads to share with the other walks and checks of the same run. */
	listings?: Listings;
}

/** Paths in one directory that differ only in ASCII letter case, as `/`-separated relative paths. */
type CaseCollision = string[];

/** What one `bun test` command selects, and the case collisions that decide what it then reads. */
interface WalkResult {
	/** The test files taken, as `/`-separated paths relative to the walk's `baseDir`. */
	files: string[];
	/**
	 * Groups of paths that collide by folded name in one real directory and decide what a file this
	 * walk took resolves to: the file's own name, a directory on its path, or its real file's name.
	 * One `bun test` process reaches one entry of such a group in place of the others, so a test
	 * reached through one of them is not the test that runs.
	 */
	collisions: CaseCollision[];
}

/** The chain of real directories a spelling went through, which counts its turns through a cycle. */
interface Ancestors {
	realDir: string;
	parent: Ancestors | null;
}

/** A directory still to list: how it is spelled, what it really is, and how it was reached. */
interface Pending {
	spelling: string;
	realDir: string;
	ancestors: Ancestors | null;
	/** The collision groups on the path to this directory, relative to `baseDir`. */
	onPath: CaseCollision[];
}

function turnsOf(ancestors: Ancestors | null, realDir: string): number {
	let turns = 0;
	for (let node = ancestors; node; node = node.parent) if (node.realDir === realDir) turns++;
	return turns;
}

/**
 * The test files below `start` by name, as `/`-separated paths relative to `baseDir`. Like
 * `bun test` it skips `node_modules` and dot-directories, follows symbolic links to files and
 * directories, and takes each real file once, by the first path `rules` does not skip. A dangling
 * link and a missing `start` are ignored.
 *
 * The walk goes in order of increasing *turns* — how often a spelling re-enters a real directory
 * already on its own path — so through a cycle of links each real file gets the spelling with the
 * fewest turns, and a later turn adds only a file no shorter spelling could take (one whose every
 * shorter spelling a pattern skips). It stops once every real directory it has seen is listed and
 * every test file it has seen is taken: a further turn could then only re-spell files it already
 * has. Each real directory is listed at most `rules.directoryVisits` times over the whole walk, so
 * the work is bounded by the directories rather than by the paths through them: with `D` real
 * directories of at most `E` entries, `P` ignore patterns and paths of at most `h` directories, at
 * most `directoryVisits · D` listings, `O(directoryVisits · D · E · (P + h))` time and
 * `O(directoryVisits · D · E)` memory, whatever the number of links.
 */
async function walkTestFiles(start: string, baseDir: string, rules: WalkRules): Promise<WalkResult> {
	const listings = rules.listings ?? new Listings();
	const visitBudget = rules.directoryVisits ?? 1;
	const relative = (file: string) => path.relative(baseDir, file).split(path.sep).join("/");
	const listed = new Map<string, number>();
	const takenFiles = new Set<string>();
	/** Real test files seen on a path but skipped on every path so far. */
	const pendingFiles = new Set<string>();
	/** Real directories seen as an entry and not yet listed, pruned spellings included. */
	const unlistedDirs = new Set<string>();
	const files: string[] = [];
	const collisions = new Map<string, CaseCollision>();
	const addCollision = (group: CaseCollision) => {
		const sorted = [...group].sort();
		collisions.set(sorted.join("\n"), sorted);
	};

	const realStart = await fs.realpath(start).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
		throw error;
	});
	if (!realStart) return { files, collisions: [] };
	let queue: Pending[] = [{ spelling: start, realDir: realStart, ancestors: null, onPath: [] }];

	// One turn of the whole walk, then the spellings it deferred: entries in order, descending into
	// a directory where it stands, as `bun test` walks, so the spelling a file is taken by is the
	// one reached first among those with the fewest turns.
	let deferred: Pending[] = [];
	const visit = async (pending: Pending): Promise<void> => {
		const visits = listed.get(pending.realDir) ?? 0;
		if (visits >= visitBudget) return;
		// Nothing a further listing could add: every directory seen is listed and every test file
		// seen is taken, so another turn would only re-spell files already taken.
		if (visits > 0 && unlistedDirs.size === 0 && pendingFiles.size === 0) return;
		listed.set(pending.realDir, visits + 1);
		unlistedDirs.delete(pending.realDir);
		const listing = await listings.get(pending.realDir);
		const ancestors: Ancestors = { realDir: pending.realDir, parent: pending.ancestors };
		for (const entry of listing.entries) {
			const spelling = path.join(pending.spelling, entry.name);
			const collision = rules.reportCollisions ? listing.collisions.get(foldedName(entry.name)) : undefined;
			const group = collision?.map(member => displayPath(baseDir, path.join(pending.spelling, member.name)));
			if (entry.isDirectory) {
				if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
				const realDir = entry.realPath;
				if (!realDir) continue;
				// A pruned spelling counts as a directory still unlisted: another spelling of it,
				// around the pattern, may yet have to be listed.
				if ((listed.get(realDir) ?? 0) === 0) unlistedDirs.add(realDir);
				if (rules.pruneDirectory?.(spelling)) continue;
				const onPath = group ? [...pending.onPath, group] : pending.onPath;
				const child: Pending = { spelling, realDir, ancestors, onPath };
				// A link back into a real directory already on this path turns the cycle: it belongs
				// to the next turn, so every spelling with fewer turns is taken before it.
				if (turnsOf(ancestors, realDir) > 0) deferred.push(child);
				else await visit(child);
				continue;
			}
			if (!entry.isFile || !testFilePattern.test(entry.name)) continue;
			const realFile = entry.realPath;
			if (!realFile) continue;
			if (rules.skipFile?.(spelling)) {
				if (!takenFiles.has(realFile)) pendingFiles.add(realFile);
				continue;
			}
			if (takenFiles.has(realFile)) continue;
			takenFiles.add(realFile);
			pendingFiles.delete(realFile);
			files.push(relative(spelling));
			if (!rules.reportCollisions) continue;
			for (const onPathGroup of pending.onPath) addCollision(onPathGroup);
			if (group) addCollision(group);
			// The real file's own directory decides which file this path reads: a link to
			// `t/Helper.ts` beside `t/helper.ts` runs the entry the process keeps, not the one named.
			const realDir = path.dirname(realFile);
			if (realDir === pending.realDir) continue;
			const realGroup = (await listings.get(realDir)).collisions.get(foldedName(path.basename(realFile)));
			if (realGroup) addCollision(realGroup.map(member => displayPath(baseDir, path.join(realDir, member.name))));
		}
	};
	for (let turn = 0; turn < visitBudget && queue.length > 0; turn++) {
		deferred = [];
		for (const pending of queue) await visit(pending);
		queue = deferred;
	}
	return { files, collisions: [...collisions.values()] };
}

function selectionRules(config: BunTestConfig, cwd: string): WalkRules {
	const ignored = (spelling: string) => isIgnored(config, cwd, spelling);
	// From a root above the working directory, `bun test` walks into neither the working directory
	// nor any directory between them: their paths relative to it end in `.` or `..`.
	const prune = (spelling: string) => isWithin(spelling, cwd) || ignored(spelling);
	return { pruneDirectory: prune, skipFile: ignored, directoryVisits: config.directoryVisits };
}

/**
 * What `bun test`, run in `cwd` and naming no file (or only name filters), selects: the test files,
 * as `/`-separated paths relative to `baseDir`, and the case collisions that decide what that one
 * process then reads. For a `dir` other than `cwd`, only the files below `dir`.
 *
 * The command scans below `cwd`'s `[test] root`, inside `cwd` or outside it (a root above `cwd`, or
 * beside it, gives paths starting `../`); a missing root selects nothing, and from a root above
 * `cwd` it skips `cwd` and the directories between them. It prunes directories and skips files
 * `cwd`'s `pathIgnorePatterns` match, each judged by the path it was reached at, so a link around
 * an ignored directory still reaches its tests. Otherwise it walks as {@link walkTestFiles} does.
 */
async function selectTestsUnder(dir: string, baseDir: string, cwd: string, extra: WalkRules): Promise<WalkResult> {
	const config = await bunTestConfig(cwd);
	const rules = { ...selectionRules(config, cwd), ...extra };
	if (path.resolve(dir) === path.resolve(cwd) || isWithin(dir, config.root)) {
		return walkTestFiles(config.root, baseDir, rules);
	}
	if (!isWithin(config.root, dir)) return { files: [], collisions: [] };
	// The directories between root and `dir` are scanned on the way down, so their rules apply too.
	let spelling = config.root;
	for (const segment of path.relative(config.root, dir).split(path.sep).filter(Boolean)) {
		spelling = path.join(spelling, segment);
		if (segment === "node_modules" || segment.startsWith(".") || rules.pruneDirectory?.(spelling)) {
			return { files: [], collisions: [] };
		}
	}
	return walkTestFiles(dir, baseDir, rules);
}

/** The files {@link selectTestsUnder} selects, for a caller that needs no collision report. */
export async function collectTestsUnder(dir: string, baseDir: string, cwd = dir): Promise<string[]> {
	return (await selectTestsUnder(dir, baseDir, cwd, {})).files;
}

/**
 * The test files below `dir` that `bun test ./<file>…`, run in `cwd`, runs when the command names
 * each of them: every test file by name, except one whose own path `cwd`'s `pathIgnorePatterns`
 * match. A named file is not limited to `[test] root`, and a pattern that only matches one of its
 * directories does not skip it. Each real file is named once, by a path Bun does not skip.
 */
export async function namedTestFilesUnder(dir: string, baseDir: string, cwd: string): Promise<string[]> {
	const config = await bunTestConfig(cwd);
	return (await walkTestFiles(dir, baseDir, { ...selectionRules(config, cwd), pruneDirectory: undefined })).files;
}

/**
 * Every test file below `dir` by name, whatever any `bunfig.toml` says: the files that exist and
 * must each be run by some command.
 */
export async function testFilesByName(dir: string, baseDir: string): Promise<string[]> {
	return (await walkTestFiles(dir, baseDir, {})).files;
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
 * The case collisions that decide which real file a command naming `file` reads: the file's own
 * name where it is named, and its real file's name in the real directory holding it. Naming a file
 * does not save it — `bun test ./a.test.ts` beside `A.test.ts` runs the entry the process keeps.
 */
async function namedFileCollisions(listings: Listings, baseDir: string, file: string): Promise<CaseCollision[]> {
	const realFile = await fs.realpath(file).catch(() => null);
	if (!realFile) return [];
	const groups: CaseCollision[] = [];
	for (const [dir, name] of [
		[path.dirname(file), path.basename(file)],
		[path.dirname(realFile), path.basename(realFile)],
	] as const) {
		const realDir = await fs.realpath(dir).catch(() => null);
		if (!realDir) continue;
		const group = (await listings.get(realDir)).collisions.get(foldedName(name));
		if (group) groups.push(group.map(member => displayPath(baseDir, path.join(dir, member.name))));
	}
	return groups;
}

function caseCollisionError(groups: CaseCollision[]): Error {
	const unique = new Map(groups.map(group => [[...group].sort().join("\n"), [...group].sort()]));
	const sorted = [...unique.values()].sort((a, b) => a.join("  ").localeCompare(b.join("  ")));
	return new Error(
		"These paths of one directory differ only in ASCII letter case, and one `bun test` process reaches one of each group in place of the others, so it does not run every test reached through them. Rename them apart:\n" +
			sorted.map(group => group.join("  ")).join("\n"),
	);
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
 * fails there too), and when paths one command reaches collide by ASCII letter case within one
 * directory, because that command reads one of them in place of the other. The collision is per
 * command: each command is its own process with its own directory reads, so two commands reaching
 * `Helper.ts` and `helper.ts` in directories of their own each run their file (measured), and only
 * names meeting in one directory collide.
 */
export async function testFilesWithoutBucket(repoRoot: string, roots: string[], buckets: Buckets): Promise<string[]> {
	const listings = new Listings();
	const real = (file: string) => fs.realpath(path.join(repoRoot, file)).catch(() => undefined);
	const spelled = new Set<string>();
	const realRun = new Set<string>();
	const add = async (file: string) => {
		spelled.add(file);
		const realFile = await real(file);
		if (realFile) realRun.add(realFile);
	};
	const collisions: CaseCollision[] = [];
	for (const entry of buckets.files) {
		const cwd = path.join(repoRoot, entry.cwd);
		if (isIgnored(await bunTestConfig(cwd), cwd, path.join(repoRoot, entry.path))) continue;
		await add(entry.path);
		collisions.push(...(await namedFileCollisions(listings, repoRoot, path.join(repoRoot, entry.path))));
	}
	for (const command of buckets.dirs) {
		const cwd = path.join(repoRoot, command.cwd);
		const selected = await selectTestsUnder(cwd, repoRoot, cwd, { reportCollisions: true, listings });
		collisions.push(...selected.collisions);
		for (const file of selected.files) await add(file);
	}
	if (collisions.length > 0) throw caseCollisionError(collisions);
	const candidates: string[] = [];
	for (const root of roots) {
		candidates.push(...(await walkTestFiles(path.join(repoRoot, root), repoRoot, { listings })).files);
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
