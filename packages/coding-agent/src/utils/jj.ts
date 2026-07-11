import * as fs from "node:fs/promises";
import * as path from "node:path";
import { $which } from "@pk-nerdsaver-ai/pi-utils";
import { LRUCache } from "lru-cache/raw";
import * as git from "./git";

// ════════════════════════════════════════════════════════════════════════════
// Types
// ════════════════════════════════════════════════════════════════════════════

/** Result from a completed `jj` subprocess invocation. */
export interface JjCommandResult {
	/** Process exit code reported by `jj`. */
	exitCode: number;
	/** Captured standard output as UTF-8 text. */
	stdout: string;
	/** Captured standard error as UTF-8 text. */
	stderr: string;
}

/** Resolved Jujutsu workspace metadata. */
export interface JjRepository {
	/** Root directory containing the `.jj` workspace metadata. */
	repoRoot: string;
	/** Path to the shared workspace store directory, resolved through `.jj/repo`'s file indirection for non-default workspaces. */
	storeDir: string;
}

/** Options for `jj diff` invocations. */
export interface DiffOptions {
	/** Optional file paths to restrict the diff with `-- <files>`. */
	readonly files?: readonly string[];
	/** Return only changed file names instead of Git-format diff text. */
	readonly nameOnly?: boolean;
	/** Optional abort signal passed to the spawned `jj` process. */
	readonly signal?: AbortSignal;
}

interface CommandOptions {
	readonly signal?: AbortSignal;
}

// ════════════════════════════════════════════════════════════════════════════
// Error
// ════════════════════════════════════════════════════════════════════════════

/** Error thrown when a checked `jj` command exits non-zero. */
export class JjCommandError extends Error {
	/** Arguments passed after the common `jj --no-pager --color=never` prefix. */
	readonly args: readonly string[];
	/** Captured command result that caused the failure. */
	readonly result: JjCommandResult;

	/** Create an error for a failed checked `jj` command. */
	constructor(args: readonly string[], result: JjCommandResult) {
		super(formatCommandFailure(args, result));
		this.name = "JjCommandError";
		this.args = [...args];
		this.result = result;
	}
}

// ════════════════════════════════════════════════════════════════════════════
// Internal: Core execution
// ════════════════════════════════════════════════════════════════════════════

function ensureAvailable(): void {
	if (!$which("jj")) {
		throw new Error("jj is not installed.");
	}
}

function formatCommandFailure(
	args: readonly string[],
	result: Pick<JjCommandResult, "exitCode" | "stdout" | "stderr">,
): string {
	const stderr = result.stderr.trim();
	if (stderr) return stderr;
	const stdout = result.stdout.trim();
	if (stdout) return stdout;
	return `jj ${args.join(" ")} failed with exit code ${result.exitCode}`;
}

async function jj(cwd: string, args: readonly string[], options: CommandOptions = {}): Promise<JjCommandResult> {
	const child = Bun.spawn(["jj", "--no-pager", "--color=never", ...args], {
		cwd,
		signal: options.signal,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		windowsHide: true,
	});

	if (!child.stdout || !child.stderr) {
		throw new Error("Failed to capture jj command output.");
	}

	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);

	return { exitCode: exitCode ?? 0, stdout, stderr };
}

async function runChecked(
	cwd: string,
	args: readonly string[],
	options: CommandOptions = {},
): Promise<JjCommandResult> {
	ensureAvailable();
	const result = await jj(cwd, args, options);
	if (result.exitCode !== 0) {
		throw new JjCommandError(args, result);
	}
	return result;
}

async function runText(cwd: string, args: readonly string[], options: CommandOptions = {}): Promise<string> {
	return (await runChecked(cwd, args, options)).stdout;
}

function splitLines(text: string): string[] {
	return text
		.split("\n")
		.map(line => line.trim())
		.filter(Boolean);
}

function buildDiffArgs(options: DiffOptions): string[] {
	const args = ["diff"];
	args.push(options.nameOnly ? "--name-only" : "--git");
	if (options.files?.length) args.push("--", ...options.files);
	return args;
}

// ════════════════════════════════════════════════════════════════════════════
// Internal: Repository resolution
// ════════════════════════════════════════════════════════════════════════════

interface WorkspaceRootCacheEntry {
	readonly root?: string;
}

const WORKSPACE_ROOT_CACHE_MAX_ENTRIES = 256;
const workspaceRootCache = new LRUCache<string, WorkspaceRootCacheEntry>({ max: WORKSPACE_ROOT_CACHE_MAX_ENTRIES });

async function hasJjWorkspaceMetadata(dir: string): Promise<boolean> {
	// jj marks a directory as a workspace via `.jj/repo`. In the default workspace
	// it is a directory (containing `store/`, …); in a workspace created by
	// `jj workspace add` it is a FILE whose contents point at the shared repo dir
	// of the default workspace. Either form is a real workspace, so match on
	// `.jj/repo` presence rather than the inner `store/` directory.
	try {
		await fs.stat(path.join(dir, ".jj", "repo"));
		return true;
	} catch {
		return false;
	}
}

function parentOf(dir: string): string | undefined {
	const parent = path.dirname(dir);
	return parent === dir ? undefined : parent;
}

async function findWorkspaceRoot(cwd: string): Promise<string | undefined> {
	const key = path.resolve(cwd);
	if (workspaceRootCache.has(key)) return workspaceRootCache.get(key)?.root;

	for (let dir: string | undefined = key; dir; dir = parentOf(dir)) {
		if (await hasJjWorkspaceMetadata(dir)) {
			workspaceRootCache.set(key, { root: dir });
			return dir;
		}
	}

	workspaceRootCache.set(key, {});
	return undefined;
}

/**
 * Resolve the `.jj/repo` directory backing a workspace root, following the file
 * indirection used by non-default workspaces. `jj workspace add` writes a FILE at
 * `.jj/repo` whose contents are a path — relative to `.jj` — to the shared repo
 * directory of the default workspace; the default workspace keeps `.jj/repo` as a
 * directory.
 */
async function resolveRepoDir(root: string): Promise<string> {
	const jjDir = path.join(root, ".jj");
	const repoPath = path.join(jjDir, "repo");
	if ((await fs.stat(repoPath)).isFile()) {
		const target = (await fs.readFile(repoPath, "utf8")).trim();
		return path.resolve(jjDir, target);
	}
	return repoPath;
}

async function repositoryFromRoot(root: string): Promise<JjRepository> {
	return {
		repoRoot: root,
		storeDir: path.join(await resolveRepoDir(root), "store"),
	};
}

// ════════════════════════════════════════════════════════════════════════════
// API: diff
// ════════════════════════════════════════════════════════════════════════════

/** Run `jj diff --git` for the current workspace commit and return the raw Git-format diff text. */
export const diff = Object.assign(
	async function diff(cwd: string, options: DiffOptions = {}): Promise<string> {
		return runText(cwd, buildDiffArgs(options), { signal: options.signal });
	},
	{
		/** List changed file paths. */
		async changedFiles(cwd: string, options: Pick<DiffOptions, "files" | "signal"> = {}): Promise<string[]> {
			return splitLines(await diff(cwd, { ...options, nameOnly: true }));
		},
	},
);

// ════════════════════════════════════════════════════════════════════════════
// API: repo
// ════════════════════════════════════════════════════════════════════════════

export const repo = {
	/** Clear cached workspace roots. Intended for tests that mutate JJ metadata under an existing path. */
	clearRootCache(): void {
		workspaceRootCache.clear();
	},

	/** Resolve the current Jujutsu workspace root, or `null` when `cwd` is not in a JJ repository. */
	async root(cwd: string): Promise<string | null> {
		return (await findWorkspaceRoot(cwd)) ?? null;
	},

	/** Full Jujutsu workspace metadata. */
	async resolve(cwd: string): Promise<JjRepository | null> {
		const root = await repo.root(cwd);
		return root ? await repositoryFromRoot(root) : null;
	},

	/** Check whether `cwd` is inside a Jujutsu repository. */
	async is(cwd: string): Promise<boolean> {
		return (await repo.root(cwd)) !== null;
	},
};

/**
 * Detect a "pure" Jujutsu workspace — one where Git-mutating automation has
 * no safe Git target. Invoking `git checkout -b`, `git worktree add`, or
 * `git apply` against a pure jj workspace either fails outright (no `.git/`
 * present) or mutates state that jj itself cannot reconcile.
 *
 * `cwd` is "pure jj" iff its nearest jj workspace ancestor is **closer than**
 * its nearest Git checkout ancestor (or no Git checkout is present at all).
 * Both lookups walk upward from `cwd`, so the deeper ancestor is the one the
 * user is actually working inside.
 *
 * Returns:
 * - `false` for plain Git checkouts (no jj metadata anywhere up the tree).
 * - `false` for colocated jj-git workspaces — `jj git init --colocate` keeps
 *   `.jj/` and `.git/` at the same root.
 * - `false` when a nested Git checkout (e.g. a vendored repo or fixture)
 *   lives **under** an outer jj workspace; Git automation targets the inner
 *   repo and never touches the surrounding jj tree.
 * - `true` when jj is the deeper ancestor — either a standalone pure jj
 *   workspace, or a jj workspace nested under an unrelated outer Git
 *   checkout, where Git automation against the outer root would silently
 *   bypass jj.
 * - `false` for directories backed by neither tool.
 */
export async function isPureJjRepo(cwd: string): Promise<boolean> {
	const jjRoot = await repo.root(cwd);
	if (jjRoot === null) return false;
	const gitRoot = await git.repo.root(cwd);
	if (gitRoot === null) return true;
	return isStrictDescendant(path.resolve(jjRoot), path.resolve(gitRoot));
}

/**
 * Return `true` when `child` is a strict descendant of `ancestor` (same path
 * counts as `false`). Both arguments must already be resolved absolute paths.
 */
function isStrictDescendant(child: string, ancestor: string): boolean {
	const rel = path.relative(ancestor, child);
	if (rel === "" || rel === ".") return false;
	if (rel.startsWith("..")) return false;
	// `path.relative` returns an absolute path only when the two arguments
	// live on different filesystem roots (Windows drives, UNC shares); not a
	// real ancestor relationship.
	return !path.isAbsolute(rel);
}
