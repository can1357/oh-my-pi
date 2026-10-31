import { type NestedRepoPatch } from "@oh-my-pi/pi-tui/tools/task";
import * as fs from "./isolation-fs";
import * as os from "node:os";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import type { VcsCommitAuthor, VcsGitRepo } from "@oh-my-pi/pi-natives";
import * as natives from "@oh-my-pi/pi-natives";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { formatBytes, getWorktreeDir, logger, Snowflake } from "@oh-my-pi/pi-utils";
import type { SettingValueOf } from "../config/registry";

import { withRepoLock } from "../utils/repo-lock";
import { trackLateCleanup } from "../utils/late-cleanup";
import {
	deferTeardownWhileLeased,
	forgetIsolationWorkspace,
	hasLiveIsolationLease,
	hasUnfinishedWriter,
	registerIsolationWorkspace,
} from "./isolation-lease";
import {
	clearClaimedWorkspace,
	acquireSandboxLockWithNotice,
	holdsSandboxLock,
	requireSandboxLockHeld,
	runHoldingSandboxLock,
	withSandboxLock,
	markIsolationRetired,
	markIsolationRetiring,
	readIsolationClaim,
	resolveSandboxIdentity,
	writeIsolationOwner,
} from "./isolation-ownership";
import { mapWithConcurrencyLimit } from "./parallel";
import type { cfgIsolationBackend } from "./settings";

const { IsoBackendKind } = natives;

const TASK_ISOLATION_DIR_PREFIX = "t";
const TASK_ISOLATION_DIR_DIGEST_CHARS = 9;
const TASK_ISOLATION_MOUNT_DIR = "m";
/** How long an in-place teardown holds the lock for a backend stop before leaving it to reclamation. */
const SANDBOX_STOP_MAX_WAIT_MS = 10_000;
/** How long a teardown holds the lock to capture before it refuses to delete. */
const SANDBOX_CAPTURE_MAX_WAIT_MS = 120_000;
const GIT_NETWORK_TIMEOUT_MS = 30 * 60 * 1000;
type IsoBackendKind = natives.IsoBackendKind;
/**
 * A capture that could not read part of the working tree.
 *
 * It is thrown rather than smoothed into an empty patch, because an empty
 * patch is a statement that there is nothing to save — and the teardown
 * deletes the workspace on the strength of it. A real `chmod 000` untracked
 * file took that path: the diff failed, the capture reported no changes, and
 * the workspace with the unread file in it was removed.
 */
export class IsolationCaptureIncompleteError extends Error {
	/** Paths this capture could not read, when it knows them. */
	readonly unread: readonly string[];
	constructor(message: string, unread: readonly string[] = [], cause?: unknown) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "IsolationCaptureIncompleteError";
		this.unread = unread;
	}
}

/**
 * Diff two trees, failing when git cannot.
 *
 * There is no "or empty" here: a diff that could not be taken is not a diff
 * showing no changes, and every caller below builds either the patch a run is
 * kept for or the commit that carries its work.
 */
async function diffTree(repo: VcsGitRepo, base: string, head: string): Promise<string> {
	try {
		return await repo.diffTree(base, head, true);
	} catch (error) {
		if (vcs.isVcsError(error)) {
			throw new IsolationCaptureIncompleteError(
				`Could not diff ${base}..${head}: ${error.stderr.trim() || error.message}`,
				[],
				error,
			);
		}
		throw error;
	}
}

/** Baseline state for a single git repository. */
export interface RepoBaseline {
	repoRoot: string;
	headCommit: string;
	staged: string;
	unstaged: string;
	untracked: string[];
	untrackedPatch: string;
	/**
	 * Untracked entries the baseline could not read. Absent on hand-built
	 * baselines, which have nothing to say about it.
	 */
	unreadUntracked?: string[];
}

/** Baseline state for the project, including any nested git repos. */
export interface WorktreeBaseline {
	root: RepoBaseline;
	/** Nested git repos (path relative to root.repoRoot). */
	nested: Array<{ relativePath: string; baseline: RepoBaseline }>;
}

export async function getRepoRoot(cwd: string): Promise<string> {
	// Pure-jj check runs first so a jj workspace nested under an unrelated
	// outer Git checkout is rejected at its own root rather than silently
	// mutating the surrounding Git tree behind jj's back.
	if (vcs.isPureJj(cwd)) {
		throw new Error(
			"Isolated task execution requires a Git checkout, but this workspace is pure Jujutsu (`.jj/` without a colocated `.git/`). Run `jj git init --colocate` to add a Git checkout, or set `task.isolation.enabled: false` to disable task isolation.",
		);
	}

	const repoRoot = vcs.git(cwd)?.info().repoRoot;
	if (repoRoot) return repoRoot;

	throw new Error("Git repository not found for isolated task execution.");
}

const GIT_NO_INDEX_NULL_PATH = process.platform === "win32" ? "NUL" : "/dev/null";

export function getGitNoIndexNullPath(): string {
	return GIT_NO_INDEX_NULL_PATH;
}

/** Real path of the git common dir owning `dir`, or `undefined` outside any repo. */
async function realCommonDir(dir: string): Promise<string | undefined> {
	const commonDir = vcs.gitInfo(dir)?.commonDir;
	if (!commonDir) return undefined;
	// git writes realpath'd admin pointers; match them across symlinked
	// prefixes (macOS /var -> /private/var).
	// A path that cannot be resolved has no canonical form, and two callers
	// that fall back to different spellings lock different files.
	const resolved = await fs.realpathLookup(commonDir);
	if (resolved.kind === "found") return resolved.value;
	if (resolved.kind === "absent") return path.resolve(commonDir);
	throw new IsolationCaptureIncompleteError(`Could not resolve ${commonDir}: ${resolved.reason}`, [commonDir]);
}

/**
 * Find nested git repositories (non-submodule) under `repoRoot`.
 *
 * A directory whose common dir belongs to one of `ownRepos` is a linked
 * worktree of the same repository, not a nested repo, and is skipped with
 * everything under it. A copied isolation carries every in-tree linked
 * worktree (e.g. gitignored `.claude/worktrees/*`) whose `.git` pointer still
 * targets the source checkout's admin dir; baselining each one re-hashes its
 * whole tree against a foreign index and froze the host (#16068).
 */
async function discoverNestedRepos(repoRoot: string, ownRepos: readonly string[]): Promise<string[]> {
	// Get submodule paths so we can exclude them
	const submodulePaths = new Set(await vcs.requireGit(repoRoot).submodulePaths());
	const ownCommonDirs = new Set(
		(await Promise.all(ownRepos.map(realCommonDir))).filter((dir): dir is string => dir !== undefined),
	);

	// Find all .git dirs/files that aren't the root or known submodules
	const result: string[] = [];
	async function walk(dir: string): Promise<void> {
		const listing = await fs.readdirTypedLookup(dir);
		if (listing.kind === "absent") return;
		if (listing.kind === "unknown") {
			// Recorded, not raised. This walk looks for nested repositories
			// while the baseline is taken, and git decides what the capture
			// can see: refusing here stopped runs whose unreadable directory
			// was gitignored — `target/`, `.venv`, `dist/`, `__pycache__` —
			// which git never reads and the capture never misses. The capture
			// itself refuses, on git's own report, at the moment that
			// authorises a delete.
			logger.warn("nested-repository scan could not list a directory", { dir, reason: listing.reason });
			return;
		}
		const entries = listing.value;
		for (const entry of entries) {
			if (entry.name === "node_modules" || entry.name === ".git") continue;
			if (!entry.isDirectory()) continue;
			const full = path.join(dir, entry.name);
			const rel = path.relative(repoRoot, full);
			// Check if this directory is itself a git repo. A `.git` that
			// cannot be reached is not a directory without one: read that way,
			// a nested repo's changes never reach the patch.
			const gitDir = path.join(full, ".git");
			const gitEntry = await fs.lstatLookup(gitDir);
			if (gitEntry.kind === "unknown") {
				// Recorded, like the listing above it and for the same reason:
				// this scan runs while the baseline is taken, and an
				// unreadable directory here is usually an ignored one — git
				// never reads it, so the capture never misses it. What the
				// capture can see is decided by git, at the moment that
				// authorises a delete.
				logger.warn("nested-repository scan could not read a .git entry", {
					gitDir,
					reason: gitEntry.reason,
				});
				continue;
			}
			const hasGit = gitEntry.kind === "found";
			if (hasGit && !submodulePaths.has(rel)) {
				const commonDir = await realCommonDir(full);
				if (commonDir && ownCommonDirs.has(commonDir)) continue;
				result.push(rel);
				// Don't recurse into nested repos — they manage their own tree
				continue;
			}
			await walk(full);
		}
	}
	await walk(repoRoot);
	return result;
}

/**
 * Ceiling on the working-tree content a single repo baseline may buffer in
 * memory. Baseline capture embeds every uncommitted byte — staged/unstaged
 * binary diffs plus a `--no-index` binary diff of each untracked file — into
 * in-memory strings (see {@link captureUntrackedPatch}). A binary diff is
 * ~1.3x the raw bytes, so a multi-GB working tree produces a single string
 * that blows past the engine's string limit and the process's memory, taking
 * the whole host down (issue #8939). `git ls-files --others
 * --exclude-standard` already omits gitignored bulk, so this only trips on
 * pathological non-ignored content; when it does we refuse the isolated spawn
 * with an actionable error instead of trapping the host.
 *
 * The staged and unstaged diffs are rendered under this budget inside the
 * native renderer (`diffText({ maxBytes })`): their size is unknowable before
 * rendering and can dwarf the working tree itself (index-vs-HEAD of a jj
 * conflict commit exported to git spans every conflict side), so the cap has
 * to stop the renderer rather than measure its output afterwards. The budget
 * bounds content, not RSS: a patch is briefly held twice while it crosses the
 * native boundary, and each nested repo is captured against its own budget.
 */
export const ISOLATION_BASELINE_MAX_CONTENT_BYTES = 1024 * 1024 * 1024;

/**
 * Thrown when a repo's uncommitted content exceeds the isolation-snapshot
 * budget. Surfaced verbatim so the caller can report the real cause
 * (oversized working tree) rather than masking it as a missing git repository.
 *
 * `contentBytes` is the measured total when the untracked stat pass tripped
 * the budget, and `undefined` when a staged or unstaged diff crossed it while
 * rendering — the renderer stops at the cap, so the full size is unknown.
 */
export class IsolationBaselineTooLargeError extends Error {
	constructor(
		readonly repoRoot: string,
		readonly contentBytes: number | undefined,
		readonly budgetBytes: number = ISOLATION_BASELINE_MAX_CONTENT_BYTES,
	) {
		const measured =
			contentBytes === undefined
				? `more than ${formatBytes(budgetBytes)} of uncommitted content`
				: `${formatBytes(contentBytes)} of uncommitted content, over the ${formatBytes(budgetBytes)} isolation-snapshot budget`;
		super(
			`Working tree at ${repoRoot} carries ${measured}. ` +
				`Isolated task snapshots buffer this content in memory, so proceeding would exhaust the host. ` +
				`Commit or gitignore the bulk (untracked files that aren't ignored are the usual culprit), ` +
				`or set \`task.isolation.enabled: false\` to run tasks without isolation.`,
		);
		this.name = "IsolationBaselineTooLargeError";
	}
}

/** Sum untracked entry sizes without following symlinks, skipping entries that vanished. */
async function sumUntrackedBytes(repoRoot: string, untracked: readonly string[]): Promise<number> {
	if (untracked.length === 0) return 0;
	const { results } = await mapWithConcurrencyLimit([...untracked], 16, async entry => {
		// A budget estimate, not a decision about deletion: an entry that
		// vanished mid-scan is the common case and contributes nothing, and an
		// entry nobody can stat has no size to contribute either. Both are
		// named in the log the budget failure prints rather than silently
		// shrinking the estimate.
		const found = await fs.lstatLookup(path.join(repoRoot, entry));
		if (found.kind === "unknown") {
			logger.warn("isolation baseline could not size an untracked entry", { entry, reason: found.reason });
			return 0;
		}
		if (found.kind === "absent") return 0;
		return found.value.isFile() ? found.value.size : 0;
	});
	return results.reduce((total: number, size) => total + (size ?? 0), 0);
}

/** An untracked-file capture, with the entries it could not read named. */
interface UntrackedCapture {
	patch: string;
	/** Entries whose diff failed: read neither as present nor as absent. */
	unread: string[];
}

async function captureUntrackedPatch(
	repoRoot: string,
	untracked: readonly string[],
	repo: VcsGitRepo = vcs.requireGit(repoRoot),
): Promise<UntrackedCapture> {
	if (untracked.length === 0) return { patch: "", unread: [] };
	const nullPath = getGitNoIndexNullPath();
	// Bound concurrent native encodes so large untracked sets do not hold every
	// file and binary patch in memory at once.
	const { results: untrackedDiffs } = await mapWithConcurrencyLimit([...untracked], 8, async entry => {
		try {
			return { entry, diff: await repo.diffNoIndex(nullPath, entry, true) };
		} catch (error) {
			// Named, not dropped. A file whose permissions deny this process is
			// still the user's work, and it is the one file nobody can
			// reconstruct from the patch.
			if (vcs.isVcsError(error)) return { entry, diff: undefined };
			throw error;
		}
	});
	const unread: string[] = [];
	const patches: string[] = [];
	for (const result of untrackedDiffs) {
		if (result === undefined) continue;
		if (result.diff === undefined) {
			unread.push(result.entry);
			continue;
		}
		if (result.diff.trim()) patches.push(result.diff);
	}
	return { patch: patches.join("\n"), unread };
}

/**
 * Capture a repo's pre-spawn baseline: head, staged and unstaged binary diffs,
 * and the untracked-file patch, keeping the buffered content under
 * `budgetBytes`. The two diffs are rendered natively under the remaining
 * budget, so an oversized change set fails inside the renderer instead of
 * after the whole patch is in memory.
 */
async function captureRepoBaseline(repoRoot: string, budgetBytes: number): Promise<RepoBaseline> {
	const repo = vcs.requireGit(repoRoot);
	const headCommit = (await repo.headSha()) ?? "";
	let staged: string;
	let unstaged: string;
	try {
		staged = await repo.diffText({ binary: true, cached: true, maxBytes: budgetBytes });
		// The renderer's cap and the budget are UTF-8 bytes; a render that
		// succeeded is at most `budgetBytes` of them, so the remainder is never
		// negative.
		unstaged = await repo.diffText({ binary: true, maxBytes: budgetBytes - Buffer.byteLength(staged) });
	} catch (error) {
		if (vcs.isVcsError(error) && error.code === "OutputTooLarge") {
			throw new IsolationBaselineTooLargeError(repoRoot, undefined, budgetBytes);
		}
		throw error;
	}
	const untracked = await repo.lsFiles(true, true);
	// Gate before capturing the untracked patch: that step embeds every
	// untracked byte into one in-memory string, so an oversized tree must be
	// refused here rather than after buffering gigabytes (#8939). Untracked
	// bytes come from stat (no reads); staged/unstaged are already rendered
	// binary diffs, charged at their byte size.
	const untrackedBytes = await sumUntrackedBytes(repoRoot, untracked);
	const contentBytes = untrackedBytes + Buffer.byteLength(staged) + Buffer.byteLength(unstaged);
	if (contentBytes > budgetBytes) {
		throw new IsolationBaselineTooLargeError(repoRoot, contentBytes, budgetBytes);
	}
	const untrackedCapture = await captureUntrackedPatch(repoRoot, untracked, repo);
	if (untrackedCapture.unread.length > 0) {
		// Recorded rather than raised: a baseline that missed a file costs
		// precision in the delta, not a user's work. The delta capture, which
		// is what a deletion rests on, refuses instead.
		logger.warn("isolation baseline could not read some untracked files", {
			repoRoot,
			unread: untrackedCapture.unread.slice(0, 20),
			unreadCount: untrackedCapture.unread.length,
		});
	}
	return {
		repoRoot,
		headCommit,
		staged,
		unstaged,
		untracked,
		untrackedPatch: untrackedCapture.patch,
		unreadUntracked: untrackedCapture.unread,
	};
}

interface SyntheticTreeOptions {
	readonly threeWay?: boolean;
}

async function writeSyntheticTree(
	repoDir: string,
	baseTreeish: string,
	patches: readonly string[],
	options: SyntheticTreeOptions = {},
): Promise<string> {
	const tempIndex = path.join(os.tmpdir(), `omp-task-index-${Snowflake.next()}`);
	const repo = vcs.requireGit(repoDir);
	try {
		await repo.readTree(baseTreeish, tempIndex);
		for (const patch of patches) {
			if (!patch.trim()) continue;
			await repo.applyPatch(patch, {
				cached: true,
				indexPath: tempIndex,
				threeWay: options.threeWay,
			});
		}
		return await repo.writeTree(tempIndex);
	} finally {
		await fs.rm(tempIndex, { force: true });
	}
}

/**
 * Capture the baseline of `repoRoot` and every nested repo under it. Each repo
 * baseline may buffer at most `budgetBytes` of uncommitted content (the
 * isolation-snapshot budget, {@link ISOLATION_BASELINE_MAX_CONTENT_BYTES}).
 * Linked worktrees of any repo in `ownRepos` are not nested repos (see
 * {@link discoverNestedRepos}).
 */
export async function captureBaseline(
	repoRoot: string,
	budgetBytes: number = ISOLATION_BASELINE_MAX_CONTENT_BYTES,
	ownRepos: readonly string[] = [repoRoot],
): Promise<WorktreeBaseline> {
	const [root, nestedPaths] = await Promise.all([
		captureRepoBaseline(repoRoot, budgetBytes),
		discoverNestedRepos(repoRoot, ownRepos),
	]);
	const nested = await Promise.all(
		nestedPaths.map(async relativePath => ({
			relativePath,
			baseline: await captureRepoBaseline(path.join(repoRoot, relativePath), budgetBytes),
		})),
	);
	return { root, nested };
}

/**
 * Capture the baseline of a freshly materialised isolation and rebind it to
 * the parent checkout at `repoRoot`.
 *
 * The isolation is a point-in-time copy of the parent's working tree, so its
 * own state is the only exact baseline: a baseline read from the live parent
 * before or after the copy also absorbs whatever other agents or merges wrote
 * in between, and that drift would surface as this task's changes.
 *
 * Copied linked worktrees may point at either the isolation's or the parent's
 * admin dir, so both count as the root repository.
 */
export async function captureIsolationBaseline(
	isolationDir: string,
	repoRoot: string,
	budgetBytes: number = ISOLATION_BASELINE_MAX_CONTENT_BYTES,
): Promise<WorktreeBaseline> {
	const { root, nested } = await captureBaseline(isolationDir, budgetBytes, [isolationDir, repoRoot]);
	return {
		root: { ...root, repoRoot },
		nested: nested.map(({ relativePath, baseline }) => ({
			relativePath,
			baseline: { ...baseline, repoRoot: path.join(repoRoot, relativePath) },
		})),
	};
}

async function captureRepoDeltaPatch(repoDir: string, rb: RepoBaseline, objectRepoDir = repoDir): Promise<string> {
	const repo = vcs.requireGit(repoDir);
	const objectRepo = objectRepoDir === repoDir ? repo : vcs.requireGit(objectRepoDir);
	const currentHead = (await repo.headSha()) ?? "";
	const currentStaged = await repo.diffText({ binary: true, cached: true });
	const currentUnstaged = await repo.diffText({ binary: true });
	// Git's own report of what it did not look at, through the binding that
	// runs git the way this repository runs git — the stripped environment,
	// the deadline, the cancellation signal and the in-process fallback. A
	// hand-spawned `git -C` inherited `GIT_WORK_TREE` from the caller, listed
	// another tree, and the teardown removed this one on the strength of it.
	const listed = await repo.lsFilesWithWarnings(true, true);
	if (listed.unreadable.length > 0) {
		throw new IsolationCaptureIncompleteError(
			`git could not read ${listed.unreadable.length} ${listed.unreadable.length === 1 ? "directory" : "directories"} ` +
				`in ${repoDir}, so this capture cannot say what is in them: ${listed.unreadable.slice(0, 10).join(", ")}`,
			listed.unreadable,
		);
	}
	const currentUntracked = listed.paths;
	const currentUntracked_ = await captureUntrackedPatch(repoDir, currentUntracked, repo);
	if (currentUntracked_.unread.length > 0) {
		// The whole point of the capture is to decide whether the workspace may
		// go. Returning a patch that silently omits a file this process could
		// not read tells the teardown there is nothing to save, and the file is
		// deleted with the directory.
		throw new IsolationCaptureIncompleteError(
			`Could not read ${currentUntracked_.unread.length} untracked file(s) in ${repoDir}: ` +
				`${currentUntracked_.unread.slice(0, 10).join(", ")}`,
			currentUntracked_.unread,
		);
	}
	const currentUntrackedPatch = currentUntracked_.patch;
	const committedPatch =
		currentHead && currentHead !== rb.headCommit ? await diffTree(repo, rb.headCommit, currentHead) : "";

	const baselineTree = await writeSyntheticTree(objectRepoDir, rb.headCommit, [
		rb.staged,
		rb.unstaged,
		rb.untrackedPatch,
	]);
	const currentTree = await writeSyntheticTree(objectRepoDir, rb.headCommit, [
		committedPatch,
		currentStaged,
		currentUnstaged,
		currentUntrackedPatch,
	]);

	return diffTree(objectRepo, baselineTree, currentTree);
}

function unquoteGitDiffPath(rawPath: string): string {
	let value = rawPath;
	if (value.startsWith('"') && value.endsWith('"')) {
		try {
			value = JSON.parse(value) as string;
		} catch {
			value = value.slice(1, -1);
		}
	}
	return value.replace(/^[ab]\//, "");
}

function parseDiffGitLinePaths(line: string): string[] {
	if (!line.startsWith("diff --git ")) return [];
	const rest = line.slice("diff --git ".length);
	const quoted = rest.match(/^("(?:\\.|[^"])+"|\/dev\/null) ("(?:\\.|[^"])+"|\/dev\/null)$/);
	const parts = quoted ? [quoted[1], quoted[2]] : rest.split(" ");
	if (parts.length < 2) return [];
	const paths = parts
		.slice(0, 2)
		.map(unquoteGitDiffPath)
		.filter(file => file && file !== "/dev/null");
	return [...new Set(paths)];
}

function patchTouchedFiles(patch: string): string[] {
	const files = new Set<string>();
	for (const line of patch.split("\n")) {
		for (const file of parseDiffGitLinePaths(line)) files.add(file);
	}
	return [...files];
}

export interface DeltaPatchResult {
	rootPatch: string;
	nestedPatches: NestedRepoPatch[];
}

async function hasGitEntry(dir: string): Promise<boolean> {
	const found = await fs.lstatLookup(path.join(dir, ".git"));
	if (found.kind === "unknown") {
		throw new IsolationCaptureIncompleteError(`Could not read ${path.join(dir, ".git")}: ${found.reason}`, [dir]);
	}
	return found.kind === "found";
}

export async function captureDeltaPatch(isolationDir: string, baseline: WorktreeBaseline): Promise<DeltaPatchResult> {
	// Synthetic tree construction may read a new gitlink commit before the
	// root patch exists. Keep isolation-local objects in the source ODB first;
	// this does not change its refs, HEAD, or index. Submodules added inside
	// the isolation have no source checkout or `modules/<name>` admin dir (a
	// patch apply never creates one), so their objects go to the source root
	// ODB — the only store that survives isolation cleanup.
	const sourceRoot = baseline.root.repoRoot;
	const relativePaths = new Set([
		...(await vcs.requireGit(sourceRoot).submodulePaths()),
		...(await vcs.requireGit(isolationDir).submodulePaths()),
	]);
	for (const relativePath of relativePaths) {
		const isolatedDir = path.join(isolationDir, relativePath);
		const sourceDir = path.join(sourceRoot, relativePath);
		if (!(await hasGitEntry(isolatedDir))) continue;
		await vcs.copyGitObjects(isolatedDir, (await hasGitEntry(sourceDir)) ? sourceDir : sourceRoot);
	}
	const rootPatch = await captureRepoDeltaPatch(isolationDir, baseline.root, baseline.root.repoRoot);
	const nestedPatches: NestedRepoPatch[] = [];

	for (const { relativePath, baseline: nb } of baseline.nested) {
		const nestedDir = path.join(isolationDir, relativePath);
		// A nested repo whose `.git` cannot be reached is not a nested repo
		// that went away: skipping it drops its work from the patch, and the
		// teardown then deletes the directory holding the only copy.
		const nestedGit = await fs.lstatLookup(path.join(nestedDir, ".git"));
		if (nestedGit.kind === "absent") continue;
		if (nestedGit.kind === "unknown") {
			throw new IsolationCaptureIncompleteError(
				`Could not read ${path.join(nestedDir, ".git")}: ${nestedGit.reason}`,
				[nestedDir],
			);
		}
		const patch = await captureRepoDeltaPatch(nestedDir, nb, nb.repoRoot);
		if (patch.trim()) nestedPatches.push({ relativePath, patch });
	}

	return { rootPatch, nestedPatches };
}

/**
 * Apply nested repo patches directly to their working directories after parent merge.
 *
 * Pre-existing dirty state in a nested repo is stashed before the patch is
 * applied and popped back (with `--index` so staged WIP stays staged) after
 * the commit, so unrelated user edits never get folded into the agent's
 * commit. A failing `git stash pop` (e.g. user edits collide with the patched
 * lines) leaves the stash entry intact, emits a `logger.warn`, and is
 * returned to the caller as a human-readable warning string — the agent
 * commit already landed, so this is a partial success the workflow needs to
 * see, not a thrown failure.
 *
 * Returns the collected stash-restore warnings (empty when every nested repo
 * was restored cleanly). Throws when the patch apply itself fails.
 *
 * @param commitMessage Optional async function to generate a commit message from the combined diff.
 *                      If omitted or returns null, falls back to a generic message.
 */
export async function applyNestedPatches(
	repoRoot: string,
	patches: NestedRepoPatch[],
	commitMessage?: (diff: string) => Promise<string | null>,
): Promise<string[]> {
	const warnings: string[] = [];
	// Group patches by target repo to apply all at once and commit
	const byRepo = new Map<string, NestedRepoPatch[]>();
	for (const p of patches) {
		if (!p.patch.trim()) continue;
		const group = byRepo.get(p.relativePath) ?? [];
		group.push(p);
		byRepo.set(p.relativePath, group);
	}

	for (const [relativePath, repoPatches] of byRepo) {
		const nestedDir = path.join(repoRoot, relativePath);
		const nestedGit = await fs.lstatLookup(path.join(nestedDir, ".git"));
		if (nestedGit.kind === "absent") continue;
		if (nestedGit.kind === "unknown") {
			// This applies a captured patch. Skipping a repo nobody could look
			// at drops the agent's work for it without saying so.
			throw new Error(`Could not read ${path.join(nestedDir, ".git")}: ${nestedGit.reason}`);
		}
		const repository = vcs.requireGit(nestedDir);

		const combinedDiff = repoPatches.map(p => p.patch).join("\n");
		const touchedFiles = [...new Set(repoPatches.flatMap(p => patchTouchedFiles(p.patch)))];

		// Preserve any pre-existing dirty state (tracked + untracked) so we
		// commit only the agent delta, not the user's in-flight work.
		const stashed = (await repository.isDirty())
			? await repository.stashPush(`omp-isolation-${Snowflake.next()}`)
			: false;
		try {
			for (const { patch } of repoPatches) {
				await repository.applyPatch(patch, {});
			}
			if (await repository.isDirty()) {
				if (touchedFiles.length === 0) {
					throw new Error(`Nested repo patch for ${relativePath} did not include stageable file paths.`);
				}
				const msg = (await commitMessage?.(combinedDiff)) ?? "changes from isolated task(s)";
				await repository.stageFiles(touchedFiles);
				await repository.commitCreate(msg, {});
			}
		} finally {
			if (stashed) {
				const restored = await repository.stashTryPop(true).catch(() => false);
				if (!restored) {
					logger.warn("Pre-existing nested-repo dirty state could not be auto-restored", {
						nestedDir,
					});
					warnings.push(
						`Pre-existing dirty state in nested repo \`${relativePath}\` could not be auto-restored after the agent commit; stash entry preserved.`,
					);
				}
			}
		}
	}
	return warnings;
}

// ═══════════════════════════════════════════════════════════════════════════
// Unified isolation lifecycle — picks the best backend via the PAL and
// returns the merged-view path together with the resolved kind.
// ═══════════════════════════════════════════════════════════════════════════

/** User-facing backend names exposed by the `isolation.backend` setting. */
export type IsolationBackendSetting = SettingValueOf<typeof cfgIsolationBackend>;

/**
 * Translate an {@link IsolationBackendSetting} to the native backend hint.
 * `"auto"` returns `undefined`, allowing the PAL resolver to pick.
 */
export function parseIsolationBackend(backend: IsolationBackendSetting): IsoBackendKind | undefined {
	switch (backend) {
		case "auto":
			return undefined;
		case "apfs":
			return IsoBackendKind.Apfs;
		case "btrfs":
			return IsoBackendKind.Btrfs;
		case "zfs":
			return IsoBackendKind.Zfs;
		case "reflink":
			return IsoBackendKind.LinuxReflink;
		case "overlayfs":
			return IsoBackendKind.Overlayfs;
		case "projfs":
			return IsoBackendKind.Projfs;
		case "block-clone":
			return IsoBackendKind.WindowsBlockClone;
		case "rcopy":
			return IsoBackendKind.Rcopy;
	}
}

/** Return the canonical setting label for a resolved native backend. */
export function formatIsolationBackend(backend: IsoBackendKind): Exclude<IsolationBackendSetting, "auto"> {
	switch (backend) {
		case IsoBackendKind.Apfs:
			return "apfs";
		case IsoBackendKind.Btrfs:
			return "btrfs";
		case IsoBackendKind.Zfs:
			return "zfs";
		case IsoBackendKind.LinuxReflink:
			return "reflink";
		case IsoBackendKind.Overlayfs:
			return "overlayfs";
		case IsoBackendKind.Projfs:
			return "projfs";
		case IsoBackendKind.WindowsBlockClone:
			return "block-clone";
		case IsoBackendKind.Rcopy:
			return "rcopy";
	}
}

export interface IsolationHandle {
	/** Merged view materialised by the backend; pass this to the task. */
	mergedDir: string;
	/**
	 * The marker generation this materialisation wrote. `cleanupIsolation`
	 * compares it with what is on disk, so a teardown holding a stale handle
	 * cannot delete a path a later run has since claimed.
	 */
	generation: string;
	/** Backend the PAL actually used. */
	backend: IsoBackendKind;
	/** True when the resolver downgraded from `preferred` to `backend`. */
	fellBack: boolean;
	/** Optional reason associated with `fellBack`. */
	fallbackReason: string | null;
}

/**
 * Materialise `merged` for a single task. `preferred` is a hint — when
 * its prerequisites are missing the PAL silently falls back, and the
 * caller learns about that through `IsolationHandle.fellBack` +
 * `fallbackReason`.
 */

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * The directory name for one materialisation of a task's sandbox.
 *
 * The digest still says which repository and task it belongs to, and the mint
 * after it says *which materialisation*, so a path is never handed out twice.
 * That is what makes a descendant which outlives its owner harmless: a git
 * hook child still running after the owner died writes into a path nobody can
 * take, instead of into the workspace a successor has since built at the same
 * name — which is how a successor's data was read and overwritten. The cost is
 * a directory left for the sweeper; the cost of reuse was a user's work.
 */
function getTaskIsolationSegment(repoRoot: string, id: string): string {
	const key = `${path.resolve(repoRoot)}\0${id}`;
	const digest = fs.hash(key).toString(16).padStart(16, "0").slice(-TASK_ISOLATION_DIR_DIGEST_CHARS);
	// 122 random bits from the system's cryptographic source, not a timestamp and a
	// counter. A timestamp-and-counter mint is a prediction two processes can
	// make identically — same clock, same entropy, same name, and the second
	// materialisation destroyed the first's output — and `mkdir` can only say
	// whether a name is free *now*, which is a different question: ordinary
	// reclamation frees a name while a dead owner's git hook is still writing
	// to it, and the next mint hands that hook a successor's workspace. The
	// property a surviving descendant needs is that the name was never handed
	// out before, which only an unguessably large draw gives. `mkdir` with
	// `EEXIST` below stays as the last guard, not as the mechanism.
	const mint = crypto.randomUUID().replaceAll("-", "");
	if (mint.length !== 32) throw new Error(`randomUUID returned ${mint.length} hex characters, expected 32`);
	return `${TASK_ISOLATION_DIR_PREFIX}${digest}-${mint}`;
}

/**
 * Create a directory for one materialisation, under a name nothing has used.
 *
 * `mkdir` without `recursive` is the test: it creates the name or fails with
 * `EEXIST`, and that answer comes from the kernel rather than from an
 * assumption about clocks and counters. A surviving descendant — a git hook
 * child still running after its owner died — then writes into a path that can
 * never be handed out again, which is the whole point of minting one.
 */
async function mintSandboxDirectory(repoRoot: string, id: string): Promise<string> {
	const parent = getWorktreeDir("");
	await fs.mkdir(parent, { recursive: true });
	let lastError: unknown;
	for (let attempt = 0; attempt < 64; attempt += 1) {
		const candidate = await resolveSandboxIdentity(getWorktreeDir(getTaskIsolationSegment(repoRoot, id)));
		try {
			await fs.mkdir(candidate);
			return candidate;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			lastError = error;
		}
	}
	throw new Error(
		`Could not mint an unused isolation workspace under ${parent}: 64 names in a row already existed ` +
			`(EEXIST). Last error: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
		{ cause: lastError },
	);
}

/**
 * Submodule pointers in copied checkouts may target the source admin directory
 * or one under the root `.git` that detach removes. Materialize missing trees
 * from parents down, then detach admin state from leaves up.
 */
async function detachSubmodules(sourceRoot: string, isolationRoot: string): Promise<void> {
	const paths = await vcs.requireGit(sourceRoot).submodulePaths();
	const initialized: Array<{ sourceDir: string; isolatedDir: string; isFile: boolean }> = [];
	for (const relativePath of paths) {
		const sourceDir = path.join(sourceRoot, relativePath);
		const isolatedDir = path.join(isolationRoot, relativePath);
		const sourceGit = await fs.lstatLookup(path.join(sourceDir, ".git"));
		if (sourceGit.kind === "absent") continue;
		if (sourceGit.kind === "unknown") {
			throw new Error(`Could not read ${path.join(sourceDir, ".git")}: ${sourceGit.reason}`);
		}
		let isolated = await fs.lstatLookup(path.join(isolatedDir, ".git"));
		if (isolated.kind === "unknown") {
			throw new Error(`Could not read ${path.join(isolatedDir, ".git")}: ${isolated.reason}`);
		}
		if (isolated.kind === "absent") {
			// `git worktree add` (rcopy) checks out gitlinks but not their trees.
			await fs.cp(sourceDir, isolatedDir, { recursive: true });
			isolated = await fs.lstatLookup(path.join(isolatedDir, ".git"));
			if (isolated.kind !== "found") {
				throw new Error(`Submodule ${relativePath} has no .git after being copied into the isolation.`);
			}
		}
		initialized.push({ sourceDir, isolatedDir, isFile: isolated.value.isFile() });
	}
	for (const { sourceDir, isolatedDir, isFile } of initialized.reverse()) {
		if (!isFile) continue;
		const info = vcs.requireGit(sourceDir).info();
		// A relative pointer into the copied root `.git/modules` becomes
		// dangling after root detach; read from the source until detached.
		await fs.writeFile(path.join(isolatedDir, ".git"), `gitdir: ${info.gitDir}\n`);
		await vcs.detachGitDir(isolatedDir, info.commonDir);
	}
}

export async function ensureIsolation(
	baseCwd: string,
	id: string,
	preferred?: IsoBackendKind,
): Promise<IsolationHandle> {
	const repoRoot = await getRepoRoot(baseCwd);
	const sourceCommonDir = vcs.requireGit(repoRoot).info().commonDir;
	// The filesystem decides whether a name has been handed out, not a
	// generator: a mint is a prediction — two processes with the same clock and
	// the same entropy produced the same one, and the second materialisation
	// destroyed the first's output — while `mkdir` without `recursive` either
	// creates the directory or says `EEXIST`, which is the fact itself.
	const baseDir = await mintSandboxDirectory(repoRoot, id);
	const mergedDir = path.join(baseDir, TASK_ISOLATION_MOUNT_DIR);
	const resolution = await natives.isoResolve(preferred ?? null);
	const candidates = resolution.candidates.length > 0 ? resolution.candidates : [resolution.kind];
	let fallbackReason = resolution.reason ?? null;

	for (const candidate of candidates) {
		// The whole attempt runs under the sandbox lock, so a teardown cannot
		// retire the directory out from under a materialisation that has already
		// claimed it, and two materialisations of one id cannot interleave.
		const outcome = await withSandboxLock(baseDir, "materialise", async (): Promise<MaterialiseOutcome> => {
			let claimed = false;
			try {
				// Taking this slot destroys what is in it, so the same question the
				// teardown asks is asked here, under the same lock: is anybody still
				// working in this sandbox? A live lease belongs to a session — this
				// process's or another's — whose cwd and whose files would go with
				// the directory, and no replacement is worth that.
				if (await hasLiveIsolationLease(baseDir)) {
					throw new Error(
						`Isolation workspace ${baseDir} is still in use by a live session; refusing to materialise over it.`,
					);
				}
				// A writer that gave up its lease but said it might still be saving
				// into this directory is as much a user of it as a lease holder:
				// taking the slot erases what it is writing.
				if (await hasUnfinishedWriter(baseDir)) {
					throw new Error(
						`Isolation workspace ${baseDir} still has an unfinished writer; refusing to materialise over it.`,
					);
				}
				// A teardown that outran its bound left its backend stop running on
				// this path. Materialising beside it hands the successor to that
				// stop's removal.
				const existingClaim = await readIsolationClaim(baseDir);
				if (existingClaim.kind === "retiring") {
					throw new Error(`Isolation workspace ${baseDir} is being torn down; refusing to materialise over it.`);
				}
				// Claim ownership before anything is destroyed or materialised. The
				// previous contents go only once this generation's marker is on disk,
				// so live data never sits under no marker, and the previous owner's
				// teardown finds a generation that is not its own. Backends only
				// create/replace `mergedDir` (and overlay upper/work), never the base
				// dir, so the marker survives `isoStart` — and a concurrent
				// `omp worktree clear` never sees this sandbox without a live owner,
				// even while a large clone is still in progress.
				await fs.mkdir(baseDir, { recursive: true });
				const generation = await writeIsolationOwner(baseDir, id);
				claimed = true;
				await clearClaimedWorkspace(baseDir);
				await natives.isoStart(candidate, repoRoot, mergedDir);
				// Sever the isolation's git metadata from the source checkout. Copy
				// backends duplicate `repoRoot`'s `.git` verbatim — a linked-worktree
				// pointer file (or the rcopy `git worktree add` registration) leaves
				// the isolation sharing the source's HEAD/index/ref namespace, so a
				// task's git operations would mutate the parent checkout and stack
				// parallel task branches. Detaching gives each isolation a private,
				// frozen repo that still borrows the source object DB via alternates.
				await detachSubmodules(repoRoot, mergedDir);
				await vcs.detachGitDir(mergedDir, sourceCommonDir);
				// Descendants that inherit this cwd without materialising anything of
				// their own are accounted for against this sandbox from here. The
				// owner's own child session leases it too, under this agent id, and
				// that lease does not pin the sandbox against its own run.
				registerIsolationWorkspace(mergedDir, { baseDir, generation, agentId: id });
				return {
					kind: "ready",
					handle: {
						mergedDir,
						generation,
						backend: candidate,
						fellBack: candidate !== resolution.kind || resolution.fellBack,
						fallbackReason,
					},
				};
			} catch (err) {
				// Only a claimed sandbox may be emptied — and only under this
				// hold: a failure before the claim landed leaves whatever was
				// there for its own owner.
				if (claimed) await clearClaimedWorkspace(baseDir).catch(() => undefined);
				const message = errorMessage(err);
				if (!natives.isoIsUnavailableError(message)) throw err;
				return { kind: "unavailable", message };
			}
		});
		if (outcome.kind === "ready") return outcome.handle;
		fallbackReason ??= outcome.message;
	}

	throw new Error(fallbackReason ?? "No isolation backend is available.");
}

/** Result of one backend attempt under the materialisation hold. */
type MaterialiseOutcome =
	| { kind: "ready"; handle: IsolationHandle }
	/** This backend is not available here; the loop tries the next one. */
	| { kind: "unavailable"; message: string };

/**
 * Wait for a backend stop this teardown had to leave running, then put the
 * slot back into service: the directory goes, the retiring marker with it, and
 * the lock — if this teardown had to keep holding it because that marker could
 * not be written — goes back. A slot refused for ever because one stop was
 * slow is a leak of its own.
 */
async function settleAbandonedStop(
	stop: Promise<unknown>,
	teardownBase: string,
	heldLock: { release: () => void } | undefined,
): Promise<void> {
	try {
		await stop;
		await fs.rm(teardownBase, { recursive: true, force: true });
	} catch (error) {
		logger.warn("abandoned isolation stop did not settle cleanly; leaving the sandbox for reclamation", {
			mergedDir: teardownBase,
			error: error instanceof Error ? error.message : String(error),
		});
	} finally {
		heldLock?.release();
	}
}

/**
 * Tear down a handle returned by {@link ensureIsolation}.
 *
 * The workspace path is derived from the task id, so the same path is handed
 * out again to a replacement spawn, to a session the SDK opens on it, or to
 * another omp process entirely, and a teardown can arrive long after its own
 * run — a release that outlived its lifecycle manager's deadline. So ownership
 * is proved at the moment of deletion rather than before it, in three steps,
 * under the sandbox lock:
 *
 * - the marker must still name *this* generation. Anything else — a later
 *   run's generation, a damaged, truncated, unreadable or absent marker —
 *   leaves the directory alone. A handle cannot establish ownership from a
 *   marker nobody can read, and an unreadable marker is `omp worktree clear`'s
 *   problem, not a licence.
 * - the directory is then renamed out of the way, which takes it out of
 *   circulation in one atomic step: a materialisation that starts the instant
 *   the lock is released builds a fresh sandbox at the original path and
 *   cannot be touched by the teardown below, which now names only the retired
 *   copy. A mount the backend still holds refuses the rename (`EBUSY`); that
 *   teardown keeps the lock instead, which blocks the materialisation rather
 *   than racing it.
 * - `capture` — writing this run's patch, and its branch — runs *here*, under
 *   that same lock, immediately before the removal. Capture and the authority
 *   to delete have to be one span: every ordering where they were not left a
 *   window in which something was admitted, replaced or cleaned between them,
 *   and the work written in that window went with the directory. Nothing can
 *   take the lock between the two, and a party that wants it waits and then
 *   fails, which is the right answer.
 * - the capture is bounded, and the bound **refuses**: when it cannot be
 *   completed the workspace is kept and said so, because a workspace that
 *   survives costs disk and a log line while a lost patch costs a user's work.
 * - only then are the directory retired, the backend stopped and the removal
 *   run.
 *
 * A handle with no generation predates claims (a fixture's hand-built handle)
 * and keeps the old unconditional behaviour.
 */

export async function cleanupIsolation(
	handle: IsolationHandle,
	options: { capture?: () => Promise<void> } = {},
): Promise<void> {
	// baseDir is the parent of the merged directory, resolved to the directory
	// itself: a lock on an alias of this path excludes nobody.
	const baseDir = await resolveSandboxIdentity(path.dirname(handle.mergedDir));
	// This lock outlives the decision — an in-place teardown keeps it across
	// the backend stop, and hands it to the continuation when the retiring
	// marker cannot be written — so it is taken as a handle rather than in a
	// `withSandboxLock` body. The hold is still *recorded* for the whole
	// teardown, which is what lets the capture's retention, and everything
	// else under here, detect it instead of queueing behind it.
	//
	// Re-entering would queue this call behind itself for the full wait, so
	// say so immediately instead of hanging: the deferred teardown is run
	// outside the hold that decided to run it, and nothing else may call this
	// while holding the lock.
	if (holdsSandboxLock(baseDir)) {
		throw new Error(`Isolation teardown of ${baseDir} was called while its sandbox lock is already held.`);
	}
	// Waiting for a slow materialisation or teardown is the point of the lock,
	// so wait generously rather than failing the run that needs the sandbox.
	const lock = await acquireSandboxLockWithNotice(baseDir, "tear down");
	let retiredDir: string | undefined;
	let proceed = false;
	await runHoldingSandboxLock(baseDir, lock, async () => {
		try {
			if (handle.generation !== undefined) {
				const claim = await readIsolationClaim(baseDir);
				if (claim.kind !== "claimed" || claim.generation !== handle.generation) {
					logger.warn("isolation cleanup skipped: the workspace is no longer provably this run's", {
						mergedDir: handle.mergedDir,
						expected: handle.generation,
						found: claim.kind === "claimed" ? claim.generation : claim.kind,
					});
					return;
				}
			}
			// Someone is still working in here — a nested child that inherited this
			// cwd, a session another process opened in it. Asked under the lock and
			// after the claim check, so a lease taken while this teardown was
			// deciding still counts. The owner keeps the teardown; the last user to
			// leave runs it. See `isolation-lease`.
			if (
				await deferTeardownWhileLeased(handle.mergedDir, async () => await cleanupIsolation(handle, options), {
					generation: handle.generation,
				})
			) {
				return;
			}
			// A user had to give up its lease while its own shutdown might still be
			// writing here. Removing the directory under that write loses the work
			// just as surely as deleting it with the lease held would have, so the
			// workspace stays and reclamation takes it once that process is gone.
			if (await hasUnfinishedWriter(baseDir)) {
				logger.warn("isolation workspace kept: a user may still be writing into it", {
					mergedDir: handle.mergedDir,
				});
				return;
			}
			// The last thing before the directory goes, and still under the lock
			// that authorises its going.
			//
			// The deadline decides the *outcome*, never the holding. A capture
			// cannot be cancelled once a patch write or a branch commit is under
			// way, so releasing the lock at a deadline while that work continues
			// hands the pathname to the next materialisation and lets the capture
			// land in — or move — a successor's workspace. The lock is held until
			// the capture really stops; past the deadline the only thing that
			// changes is that this teardown no longer deletes.
			if (options.capture) {
				// The capture runs inside this teardown's hold: retention it calls
				// detects that rather than waiting sixty seconds on a lock this
				// very call owns.
				const capturing = options
					.capture()
					.then(() => true)
					.catch(error => {
						logger.warn("isolation capture failed; keeping the workspace", {
							mergedDir: handle.mergedDir,
							error: error instanceof Error ? error.message : String(error),
						});
						return false;
					});
				const deadline = new AbortController();
				const overran = await Promise.race([
					capturing.then(() => false),
					// Aborted the moment the capture settles, so the loser cannot
					// keep this process alive after the work is done.
					scheduler.wait(SANDBOX_CAPTURE_MAX_WAIT_MS, { signal: deadline.signal }).then(
						() => true,
						() => false,
					),
				]);
				deadline.abort();
				if (overran) {
					logger.warn(
						"isolation capture outran its deadline; keeping the workspace and holding it until the capture stops",
						{
							mergedDir: handle.mergedDir,
							waitedMs: SANDBOX_CAPTURE_MAX_WAIT_MS,
						},
					);
					await capturing;
					return;
				}
				if (!(await capturing)) return;
			}
			const candidate = `${baseDir}.retiring-${handle.generation ?? Snowflake.next()}`;
			try {
				// At the act: the capture above may have run long enough for
				// this teardown's hold to have ended under it.
				requireSandboxLockHeld(baseDir, "retire");
				await fs.rename(baseDir, candidate);
				retiredDir = candidate;
				// The copy left behind is nobody's sandbox now. Saying so keeps a
				// failed removal below from looking like a live owner's workspace to
				// `omp worktree clear`, which would then never reclaim it while this
				// process lives.
				await markIsolationRetired(candidate).catch(() => undefined);
			} catch {
				// A live mount pins the directory in place; hold the lock across the
				// teardown instead, so no materialisation can start beside it.
				retiredDir = undefined;
			}
			proceed = true;
		} finally {
			// Held past here only when the directory could not be retired.
			if (!proceed || retiredDir !== undefined) lock.release();
		}
		const teardownBase = retiredDir ?? baseDir;
		const teardownMerged = path.join(teardownBase, path.basename(handle.mergedDir));
		// An in-place teardown holds the lock, so a backend stop that never settles
		// would deny every later materialisation of this id. Bounded: past the
		// bound the stop is left running, the lock goes back, and the directory is
		// left to `omp worktree clear`, which can tell a retired sandbox from a
		// live one.
		let abandoned = false;
		let lockHandedOver = false;
		try {
			try {
				const stop = natives.isoStop(handle.backend, teardownMerged);
				if (retiredDir === undefined) {
					abandoned = !(await Promise.race([
						stop.then(() => true),
						scheduler.wait(SANDBOX_STOP_MAX_WAIT_MS).then(() => false),
					]));
					if (abandoned) {
						logger.warn("isolation backend stop outran its teardown bound", {
							backend: handle.backend,
							mergedDir: teardownMerged,
						});
						// The stop is still running on this exact path and can still
						// delete it, so nothing may take the slot until it settles.
						// The marker is what says so; when it cannot be written the
						// lock stays held instead — a slot nobody can take is the
						// same answer, and releasing it on a failed write is how a
						// successor's data ends up deleted by that stop.
						const marked = await markIsolationRetiring(teardownBase).then(
							() => true,
							(error: unknown) => {
								logger.warn("isolation retiring marker could not be written; holding the sandbox lock", {
									mergedDir: teardownMerged,
									error: error instanceof Error ? error.message : String(error),
								});
								return false;
							},
						);
						// The stop is still this teardown's: when it ends, the slot
						// goes back into service rather than staying refused for the
						// life of the owner.
						// Handed to the continuation when the marker could not be
						// written: it, and not the `finally` below, gives the lock
						// back once the stop settles.
						lockHandedOver = !marked;
						trackLateCleanup(settleAbandonedStop(stop, teardownBase, marked ? undefined : lock), {
							id: path.basename(teardownBase),
							resource: "isolation",
						});
					}
				} else {
					await stop;
				}
			} catch (err) {
				logger.warn("isolation backend stop failed during cleanup", {
					backend: handle.backend,
					mergedDir: teardownMerged,
					error: err instanceof Error ? err.message : String(err),
				});
			}
		} finally {
			try {
				if (!abandoned) await fs.rm(teardownBase, { recursive: true, force: true });
			} catch (err) {
				logger.warn("isolation workspace removal failed; leaving it for reclamation", {
					mergedDir: teardownMerged,
					error: err instanceof Error ? err.message : String(err),
				});
			} finally {
				// Always: a removal that threw must not keep the sandbox locked for
				// the life of this process. Keyed by generation, so an older
				// teardown finishing cannot drop the record — and the pending
				// teardown — of the materialisation that replaced it.
				forgetIsolationWorkspace(handle.mergedDir, handle.generation);
				if (retiredDir === undefined && !lockHandedOver) lock.release();
			}
		}
	});
}

// ═══════════════════════════════════════════════════════════════════════════
// Branch-mode isolation
// ═══════════════════════════════════════════════════════════════════════════

export interface CommitToBranchResult {
	branchName?: string;
	/** Root delta the branch was built from; lets callers detect whether a later capture changed anything. */
	rootPatch: string;
	nestedPatches: NestedRepoPatch[];
	/**
	 * SHA of the parent-repo commit the task branch was created on top of, so
	 * {@link mergeTaskBranches} can cherry-pick the range `baseSha..branchName`
	 * and preserve every agent commit's message and author.
	 */
	baseSha?: string;
}

function baselineHasRootWip(baseline: RepoBaseline): boolean {
	return !!(baseline.staged.trim() || baseline.unstaged.trim() || baseline.untrackedPatch.trim());
}

/**
 * Baseline WIP context needed to safely apply a delta patch whose hunks were
 * captured against `HEAD + WIP` (see {@link captureRepoDeltaPatch}). Passed
 * whenever {@link baselineHasRootWip} is true so {@link patchTree} can replay
 * the WIP first, then rewind WIP-only files after applying the delta.
 */
interface BaselineWipContext {
	readonly staged: string;
	readonly unstaged: string;
	readonly untrackedPatch: string;
}

function collectWipPatches(wip: BaselineWipContext | undefined): string[] {
	if (!wip) return [];
	return [wip.staged, wip.unstaged, wip.untrackedPatch].filter(p => p.trim());
}

/** Keep only the `diff --git` sections of `patch` that touch one of `files`. */
function filterPatchFiles(patch: string, files: ReadonlySet<string>): string {
	const sections = patch.split(/^(?=diff --git )/m);
	return sections.filter(section => parseDiffGitLinePaths(section.split("\n", 1)[0]).some(f => files.has(f))).join("");
}

/**
 * Resolve the tree `parentSha + patchText` in `repoDir` through a temporary
 * index — no checkout, so nothing lingers on disk if the process dies.
 *
 * Tries the two clean paths first; both yield an agent-only tree:
 *   1. Plain apply — works when the WIP context matches the parent.
 *   2. `--3way` — works when the WIP-side blob is tracked and in the ODB
 *      (captureDeltaPatch seeded it while writing the synthetic baseline
 *      tree); the 3-way merge subtracts the WIP.
 *
 * If both fail (untracked WIP files, staged-new WIP files, or overlap that
 * --3way can't resolve — see #4136), replay the WIP first so the delta's
 * context lines match, then rewind WIP-only files to the parent. Files touched
 * by BOTH WIP and delta keep their combined state; merge-back reconciles the
 * WIP side because the cherry-pick refuses to overwrite dirty paths.
 */
async function patchTree(
	repoDir: string,
	parentSha: string,
	taskId: string,
	patchText: string,
	baselineWip?: BaselineWipContext,
): Promise<string> {
	let plainErr: vcs.VcsError;
	try {
		return await writeSyntheticTree(repoDir, parentSha, [patchText]);
	} catch (err) {
		if (!vcs.isVcsError(err)) throw err;
		plainErr = err;
	}
	let threeWayErr: vcs.VcsError;
	try {
		return await writeSyntheticTree(repoDir, parentSha, [patchText], { threeWay: true });
	} catch (err) {
		if (!vcs.isVcsError(err)) throw err;
		threeWayErr = err;
	}
	const wipPatches = collectWipPatches(baselineWip);
	const logContext = {
		taskId,
		threeWayStderr: threeWayErr.stderr.slice(0, 2000),
		initialStderr: plainErr.stderr.slice(0, 2000),
		patchSize: patchText.length,
		patchHead: patchText.slice(0, 500),
	};
	if (wipPatches.length === 0) {
		logger.error("commitToBranch: git apply --3way failed", logContext);
		throw new Error(`git apply --3way failed for task ${taskId}: ${logContext.threeWayStderr}`);
	}
	try {
		const withWip = await writeSyntheticTree(repoDir, parentSha, wipPatches);
		const deltaFiles = new Set(patchTouchedFiles(patchText));
		const wipOnly = new Set(wipPatches.flatMap(patchTouchedFiles).filter(f => !deltaFiles.has(f)));
		// WIP-only files are untouched by the delta, so their post-delta state
		// is the WIP state; diffing it back to the parent rewinds them.
		const rewind =
			wipOnly.size > 0 ? filterPatchFiles(await diffTree(vcs.requireGit(repoDir), withWip, parentSha), wipOnly) : "";
		return await writeSyntheticTree(repoDir, parentSha, [...wipPatches, patchText, rewind]);
	} catch (wipErr) {
		if (!vcs.isVcsError(wipErr)) throw wipErr;
		const stderr = wipErr.stderr.slice(0, 2000);
		logger.error("commitToBranch: git apply with baseline WIP failed", { ...logContext, stderr });
		throw new Error(`git apply with baseline WIP failed for task ${taskId}: ${stderr}`);
	}
}

/** Commit `parentSha + patchText` as a detached commit object; returns its sha. */
async function commitPatch(
	repoDir: string,
	parentSha: string,
	taskId: string,
	patchText: string,
	message: string,
	author?: VcsCommitAuthor,
	baselineWip?: BaselineWipContext,
): Promise<string> {
	const tree = await patchTree(repoDir, parentSha, taskId, patchText, baselineWip);
	return vcs.requireGit(repoDir).commitTree(tree, [parentSha], message, author);
}

interface FilteredAgentReplayOptions {
	baseline: WorktreeBaseline;
	commitMessage?: (diff: string) => Promise<string | null>;
	fallbackMessage: string;
	isolationDir: string;
	isolationHead: string;
	repoRoot: string;
	rootPatch: string;
	taskId: string;
}

/**
 * Rewrite each agent commit against the captured baseline WIP so user
 * staged/unstaged/untracked changes never enter the task history. Returns the
 * tip commit (the baseline sha when nothing survived filtering).
 */
async function replayFilteredAgentCommits(opts: FilteredAgentReplayOptions): Promise<string> {
	const baselineSha = opts.baseline.root.headCommit;
	const repo = vcs.requireGit(opts.repoRoot);
	const isolationRepo = vcs.requireGit(opts.isolationDir);
	const agentCommits = await isolationRepo.revListRange(baselineSha, opts.isolationHead);
	const baselineWip = [opts.baseline.root.staged, opts.baseline.root.unstaged, opts.baseline.root.untrackedPatch];
	// Seed the parent ODB with the dirty-side blobs needed by `git apply
	// --3way`. Isolation repositories can read parent objects, but the parent
	// cannot read objects created only inside isolation.
	await writeSyntheticTree(opts.repoRoot, baselineSha, baselineWip);
	const dirtyBaselineTree = await writeSyntheticTree(opts.isolationDir, baselineSha, baselineWip);
	let tip = baselineSha;
	let previousFilteredTree = baselineSha;

	for (const commitSha of agentCommits) {
		const taskStatePatch = await diffTree(isolationRepo, dirtyBaselineTree, `${commitSha}^{tree}`);
		// The delta is captured against `HEAD + baseline WIP`, so synthesise the
		// filtered tree through `patchTree` with that WIP context: hunks that
		// touch WIP paths — including deletions of untracked WIP the agent never
		// committed — replay against the WIP state and are rewound afterwards
		// instead of failing against the clean baseline tree with
		// "patch does not apply: … does not exist".
		const currentFilteredTree = await patchTree(
			opts.repoRoot,
			baselineSha,
			opts.taskId,
			taskStatePatch,
			opts.baseline.root,
		);
		const commitPatchText = await diffTree(repo, previousFilteredTree, currentFilteredTree);
		if (commitPatchText.trim()) {
			const details = await isolationRepo.commitDetails(commitSha);
			tip = await commitPatch(
				opts.repoRoot,
				tip,
				opts.taskId,
				commitPatchText,
				details.message || commitSha,
				details.author,
			);
		}
		previousFilteredTree = currentFilteredTree;
	}
	if (tip === baselineSha) {
		// No filtered commit landed. Synthesising `HEAD + rootPatch` fails
		// whenever rootPatch's WIP context can't be applied to a HEAD-only
		// index (untracked WIP + agent modifies, staged-new WIP + agent
		// modifies — see #4136), so collapse the isolation output onto a
		// single WIP-seeded commit, matching the no-agent-commit path. This
		// also covers an agent that committed only baseline WIP.
		if (!opts.rootPatch.trim()) return tip;
		const msg = (opts.commitMessage && (await opts.commitMessage(opts.rootPatch))) || opts.fallbackMessage;
		return commitPatch(opts.repoRoot, tip, opts.taskId, opts.rootPatch, msg, undefined, opts.baseline.root);
	}
	// Reconstruct the final HEAD-derived tree with the same dirty-side blobs
	// and 3-way synthesis used above; anything left is uncommitted work. The
	// same WIP context applies: `rootPatch` is captured against `HEAD + WIP`,
	// so synthesise through `patchTree` or hunks touching WIP paths fail on the
	// clean baseline tree ("patch does not apply: … does not exist").
	const finalFilteredTree = await patchTree(
		opts.repoRoot,
		baselineSha,
		opts.taskId,
		opts.rootPatch,
		opts.baseline.root,
	);
	const leftoverPatch = await diffTree(repo, previousFilteredTree, finalFilteredTree);
	if (!leftoverPatch.trim()) return tip;
	const msg = (opts.commitMessage && (await opts.commitMessage(leftoverPatch))) || opts.fallbackMessage;
	return commitPatch(opts.repoRoot, tip, opts.taskId, leftoverPatch, msg);
}

/**
 * Capture task-only changes from the isolation worktree onto a parent-repo
 * branch named `omp/task/${taskId}`. Only root-repo changes go on the branch;
 * nested-repo patches are returned separately because the parent git can't
 * track files inside gitlinks.
 *
 * Commits are built as detached objects through temporary indexes and the
 * branch ref is written once the whole chain exists, so no checkout is ever
 * materialised and a crash mid-capture leaves no branch or worktree behind.
 *
 * If the agent committed inside isolation (HEAD moved past
 * `baseline.root.headCommit`), clean-baseline runs fetch the raw commit range
 * into the parent repo and later cherry-pick `baseSha..branchName`, preserving
 * every message and author verbatim. Dirty-baseline runs rewrite each agent
 * commit against the captured baseline WIP before committing it to the task
 * branch, so user staged/unstaged/untracked changes present at isolation
 * start are not replayed into the parent commit history.
 *
 * If the agent did not commit, the captured delta is collapsed onto a single
 * branch commit with an AI-generated (or fallback) message.
 *
 * Returns `null` when no root or nested changes exist.
 */
export async function commitToBranch(
	isolationDir: string,
	baseline: WorktreeBaseline,
	taskId: string,
	description: string | undefined,
	commitMessage?: (diff: string) => Promise<string | null>,
): Promise<CommitToBranchResult | null> {
	const baselineSha = baseline.root.headCommit;
	const isolationRepo = vcs.requireGit(isolationDir);
	const isolationHead = (await isolationRepo.headSha()) ?? "";
	const agentCommitted = isolationHead !== "" && isolationHead !== baselineSha;

	const { rootPatch, nestedPatches } = await captureDeltaPatch(isolationDir, baseline);
	if (!rootPatch.trim() && nestedPatches.length === 0) return null;
	if (!rootPatch.trim()) return { rootPatch, nestedPatches };

	const repoRoot = baseline.root.repoRoot;
	const repo = vcs.requireGit(repoRoot);
	const branchName = `omp/task/${taskId}`;
	const fallbackMessage = description || taskId;

	let tip: string;
	if (agentCommitted && baselineHasRootWip(baseline.root)) {
		tip = await replayFilteredAgentCommits({
			baseline,
			commitMessage,
			fallbackMessage,
			isolationDir,
			isolationHead,
			repoRoot,
			rootPatch,
			taskId,
		});
	} else if (agentCommitted) {
		// Transfer the agent's commit objects (which live in isolation's `.git`,
		// stranded once `cleanupIsolation` tears the workspace down) into the
		// parent repo's object DB and create the branch at the agent's HEAD.
		// `+HEAD:…` force-overwrites a stale branch from a prior run.
		await repo.fetch(isolationDir, "HEAD", `refs/heads/${branchName}`, GIT_NETWORK_TIMEOUT_MS);
		tip = isolationHead;
		// Leftover = anything still uncommitted in isolation on top of the
		// agent's last commit (staged, unstaged, untracked). The agent didn't
		// commit it, so it goes in as one AI-summarized trailing commit.
		const leftoverPatch = await captureRepoDeltaPatch(isolationDir, {
			repoRoot: isolationDir,
			headCommit: isolationHead,
			staged: "",
			unstaged: "",
			untracked: [],
			untrackedPatch: "",
		});
		if (leftoverPatch.trim()) {
			const msg = (commitMessage && (await commitMessage(leftoverPatch))) || fallbackMessage;
			tip = await commitPatch(repoRoot, tip, taskId, leftoverPatch, msg);
		}
	} else {
		const msg = (commitMessage && (await commitMessage(rootPatch))) || fallbackMessage;
		const wip = baselineHasRootWip(baseline.root) ? baseline.root : undefined;
		tip = await commitPatch(repoRoot, baselineSha, taskId, rootPatch, msg, undefined, wip);
	}

	if (tip === baselineSha) return { rootPatch, baseSha: baselineSha, nestedPatches };
	await repo.createBranch(branchName, tip, true);
	return { branchName, baseSha: baselineSha, rootPatch, nestedPatches };
}

export interface MergeBranchResult {
	merged: string[];
	failed: string[];
	conflict?: string;
}

/**
 * Cherry-pick task branch commits sequentially onto HEAD. When `baseSha` is
 * provided the cherry-pick uses the inclusive range `baseSha..branchName`,
 * replaying every commit individually and preserving each commit's message
 * and author. When omitted, the branch is cherry-picked as a single commit
 * (legacy callers).
 *
 * The working tree is never stashed: each pick rewrites only the paths it
 * changes and is refused when one of them carries uncommitted edits, so
 * unrelated dirty files (and LFS checkouts) are left untouched.
 *
 * Stops on the first conflict and reports which branches succeeded.
 */
export async function mergeTaskBranches(
	repoRoot: string,
	branches: Array<{ branchName: string; taskId: string; description?: string; baseSha?: string }>,
): Promise<MergeBranchResult> {
	// Serialize against other in-process git mutations on this repo: concurrent
	// background merges would race on HEAD and the index.
	return withRepoLock(repoRoot, async () => {
		const repo = vcs.requireGit(repoRoot);
		const merged: string[] = [];
		for (const { branchName, baseSha } of branches) {
			try {
				const revisions = baseSha ? await repo.revListRange(baseSha, branchName) : [branchName];
				for (const revision of revisions) {
					try {
						await repo.cherryPick(revision);
					} catch (error) {
						if (!vcs.isEmptyCherryPick(error)) throw error;
					}
				}
			} catch (error) {
				const stderr = vcs.isVcsError(error)
					? error.stderr.trim()
					: error instanceof Error
						? error.message
						: String(error);
				return {
					merged,
					failed: branches.slice(merged.length).map(b => b.branchName),
					conflict: `${branchName}: ${stderr}`,
				};
			}
			merged.push(branchName);
		}
		return { merged, failed: [] };
	});
}

/** Clean up temporary task branches. */
export async function cleanupTaskBranches(repoRoot: string, branches: string[]): Promise<void> {
	const repo = vcs.requireGit(repoRoot);
	for (const branch of branches) {
		try {
			await repo.deleteBranch(branch, true);
		} catch {
			// Best-effort cleanup matches the old façade's tryDelete semantics.
		}
	}
}
