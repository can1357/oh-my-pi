import { type NestedRepoPatch } from "@oh-my-pi/pi-tui/tools/task";
import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { VcsCommitAuthor, VcsGitRepo } from "@oh-my-pi/pi-natives";
import * as natives from "@oh-my-pi/pi-natives";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { formatBytes, getWorktreeDir, logger, postmortem, Snowflake } from "@oh-my-pi/pi-utils";
import type { SettingValueOf } from "../config/registry";

import { withRepoLock } from "../utils/repo-lock";
import { getNestedLinkedWorktrees, inspectIsolationUniqueWork, writeIsolationOwner } from "./isolation-ownership";
import { mapWithConcurrencyLimit } from "./parallel";
import type { cfgIsolationBackend } from "./settings";

const { IsoBackendKind } = natives;

const TASK_ISOLATION_DIR_PREFIX = "t";
const TASK_ISOLATION_DIR_DIGEST_CHARS = 9;
const TASK_ISOLATION_MOUNT_DIR = "m";
const GIT_NETWORK_TIMEOUT_MS = 30 * 60 * 1000;
type IsoBackendKind = natives.IsoBackendKind;
async function diffTreeOrEmpty(repo: VcsGitRepo, base: string, head: string): Promise<string> {
	try {
		return await repo.diffTree(base, head, true);
	} catch (error) {
		if (vcs.isVcsError(error)) return "";
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

/** Find nested git repositories (non-submodule) under the given root. */
async function discoverNestedRepos(repoRoot: string): Promise<string[]> {
	// Get submodule paths so we can exclude them
	const submodulePaths = new Set(await vcs.requireGit(repoRoot).submodulePaths());

	// Find all .git dirs/files that aren't the root or known submodules
	const result: string[] = [];
	async function walk(dir: string): Promise<void> {
		let entries: Dirent[];
		try {
			entries = await fs.readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (entry.name === "node_modules" || entry.name === ".git") continue;
			if (!entry.isDirectory()) continue;
			const full = path.join(dir, entry.name);
			const rel = path.relative(repoRoot, full);
			// Check if this directory is itself a git repo
			const gitDir = path.join(full, ".git");
			let hasGit = false;
			try {
				await fs.access(gitDir);
				hasGit = true;
			} catch {}
			if (hasGit && !submodulePaths.has(rel)) {
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
		try {
			const stat = await fs.lstat(path.join(repoRoot, entry));
			return stat.isFile() ? stat.size : 0;
		} catch {
			return 0;
		}
	});
	return results.reduce((total: number, size) => total + (size ?? 0), 0);
}

async function captureUntrackedPatch(
	repoRoot: string,
	untracked: readonly string[],
	repo: VcsGitRepo = vcs.requireGit(repoRoot),
): Promise<string> {
	if (untracked.length === 0) return "";
	const nullPath = getGitNoIndexNullPath();
	// Bound concurrent native encodes so large untracked sets do not hold every
	// file and binary patch in memory at once.
	const { results: untrackedDiffs } = await mapWithConcurrencyLimit([...untracked], 8, async entry => {
		try {
			return await repo.diffNoIndex(nullPath, entry, true);
		} catch (error) {
			if (vcs.isVcsError(error)) return "";
			throw error;
		}
	});
	return untrackedDiffs.filter((diff): diff is string => !!diff?.trim()).join("\n");
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
	const untrackedPatch = await captureUntrackedPatch(repoRoot, untracked, repo);
	return { repoRoot, headCommit, staged, unstaged, untracked, untrackedPatch };
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
 */
export async function captureBaseline(
	repoRoot: string,
	budgetBytes: number = ISOLATION_BASELINE_MAX_CONTENT_BYTES,
): Promise<WorktreeBaseline> {
	const [root, nestedPaths] = await Promise.all([
		captureRepoBaseline(repoRoot, budgetBytes),
		discoverNestedRepos(repoRoot),
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
 */
export async function captureIsolationBaseline(
	isolationDir: string,
	repoRoot: string,
	budgetBytes: number = ISOLATION_BASELINE_MAX_CONTENT_BYTES,
): Promise<WorktreeBaseline> {
	const { root, nested } = await captureBaseline(isolationDir, budgetBytes);
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
	const currentUntracked = await repo.lsFiles(true, true);
	const currentUntrackedPatch = await captureUntrackedPatch(repoDir, currentUntracked, repo);
	const committedPatch =
		currentHead && currentHead !== rb.headCommit ? await diffTreeOrEmpty(repo, rb.headCommit, currentHead) : "";

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

	return diffTreeOrEmpty(objectRepo, baselineTree, currentTree);
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

export async function captureDeltaPatch(isolationDir: string, baseline: WorktreeBaseline): Promise<DeltaPatchResult> {
	const rootPatch = await captureRepoDeltaPatch(isolationDir, baseline.root, baseline.root.repoRoot);
	const nestedPatches: NestedRepoPatch[] = [];

	for (const { relativePath, baseline: nb } of baseline.nested) {
		const nestedDir = path.join(isolationDir, relativePath);
		try {
			await fs.access(path.join(nestedDir, ".git"));
		} catch {
			continue;
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
		try {
			await fs.access(path.join(nestedDir, ".git"));
		} catch {
			continue;
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
	/** Backend the PAL actually used. */
	backend: IsoBackendKind;
	/** True when the resolver downgraded from `preferred` to `backend`. */
	fellBack: boolean;
	/** Optional reason associated with `fellBack`. */
	fallbackReason: string | null;
	/** Cancel function for postmortem termination cleanup registration. */
	cancelCleanup?: () => void;
}

/**
 * Remove from the cloned mergedDir any directory that is a linked worktree
 * registered to repoRoot that lies inside repoRoot.
 *
 * Never touches the parent checkout's copies.
 */
export async function removeNestedLinkedWorktrees(repoRoot: string, mergedDir: string): Promise<string[]> {
	const nested = await getNestedLinkedWorktrees(repoRoot);
	const removed: string[] = [];
	for (const rel of nested) {
		const copyDir = path.join(mergedDir, rel);
		try {
			const stat = await fs.lstat(copyDir).catch(() => null);
			if (stat) {
				await fs.rm(copyDir, { recursive: true, force: true });
				removed.push(rel);
			}
		} catch (err) {
			logger.warn("failed to remove cloned nested worktree from sandbox", {
				rel,
				copyDir,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}
	return removed;
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

function getTaskIsolationSegment(repoRoot: string, id: string): string {
	const key = `${path.resolve(repoRoot)}\0${id}`;
	const digest = Bun.hash(key).toString(16).padStart(16, "0").slice(-TASK_ISOLATION_DIR_DIGEST_CHARS);
	return `${TASK_ISOLATION_DIR_PREFIX}${digest}`;
}

export async function ensureIsolation(
	baseCwd: string,
	id: string,
	preferred?: IsoBackendKind,
): Promise<IsolationHandle> {
	const repoRoot = await getRepoRoot(baseCwd);
	const sourceCommonDir = vcs.requireGit(repoRoot).info().commonDir;
	const baseDir = getWorktreeDir(getTaskIsolationSegment(repoRoot, id));
	const mergedDir = path.join(baseDir, TASK_ISOLATION_MOUNT_DIR);
	const resolution = await natives.isoResolve(preferred ?? null);
	const candidates = resolution.candidates.length > 0 ? resolution.candidates : [resolution.kind];
	let fallbackReason = resolution.reason ?? null;

	for (const candidate of candidates) {
		await fs.rm(baseDir, { recursive: true, force: true });
		// Claim ownership before the backend materialises `m`. Backends only
		// create/replace `mergedDir` (and overlay upper/work), never the base
		// dir, so the marker survives `isoStart` — and a concurrent
		// `omp worktree clear` never sees this sandbox without a live owner,
		// even while a large clone is still in progress.
		await fs.mkdir(baseDir, { recursive: true });
		await writeIsolationOwner(baseDir, id, repoRoot);
		try {
			await natives.isoStart(candidate, repoRoot, mergedDir);
			await removeNestedLinkedWorktrees(repoRoot, mergedDir);
			// Sever the isolation's git metadata from the source checkout. Copy
			// backends duplicate `repoRoot`'s `.git` verbatim — a linked-worktree
			// pointer file (or the rcopy `git worktree add` registration) leaves
			// the isolation sharing the source's HEAD/index/ref namespace, so a
			// task's git operations would mutate the parent checkout and stack
			// parallel task branches. Detaching gives each isolation a private,
			// frozen repo that still borrows the source object DB via alternates.
			await vcs.detachGitDir(mergedDir, sourceCommonDir);
			const cancelCleanup = postmortem.register(`task-isolation:${baseDir}`, async () => {
				try {
					const stat = await fs.stat(baseDir).catch(() => null);
					if (!stat?.isDirectory()) return;
					const check = await inspectIsolationUniqueWork(baseDir);
					if (!check.hasUniqueWork) {
						try {
							await natives.isoStop(candidate, mergedDir);
						} catch {}
						await fs.rm(baseDir, { recursive: true, force: true });
					} else {
						logger.warn("Preserving interrupted isolation sandbox with unique work", {
							baseDir,
							reason: check.reason,
						});
					}
				} catch (err) {
					logger.warn("postmortem task-isolation cleanup failed", {
						baseDir,
						error: err instanceof Error ? err.message : String(err),
					});
				}
			});
			return {
				mergedDir,
				backend: candidate,
				fellBack: candidate !== resolution.kind || resolution.fellBack,
				fallbackReason,
				cancelCleanup,
			};
		} catch (err) {
			await fs.rm(baseDir, { recursive: true, force: true });
			const message = errorMessage(err);
			if (!natives.isoIsUnavailableError(message)) {
				throw err;
			}
			fallbackReason ??= message;
		}
	}

	throw new Error(fallbackReason ?? "No isolation backend is available.");
}

/** Tear down a handle returned by {@link ensureIsolation}. */
export async function cleanupIsolation(handle: IsolationHandle): Promise<void> {
	handle.cancelCleanup?.();
	try {
		try {
			await natives.isoStop(handle.backend, handle.mergedDir);
		} catch (err) {
			logger.warn("isolation backend stop failed during cleanup", {
				backend: handle.backend,
				mergedDir: handle.mergedDir,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	} finally {
		// baseDir is the parent of the merged directory
		const baseDir = path.dirname(handle.mergedDir);
		await fs.rm(baseDir, { recursive: true, force: true });
	}
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
			wipOnly.size > 0
				? filterPatchFiles(await diffTreeOrEmpty(vcs.requireGit(repoDir), withWip, parentSha), wipOnly)
				: "";
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
		const taskStatePatch = await diffTreeOrEmpty(isolationRepo, dirtyBaselineTree, `${commitSha}^{tree}`);
		const currentFilteredTree = await writeSyntheticTree(opts.repoRoot, baselineSha, [taskStatePatch], {
			threeWay: true,
		});
		const commitPatchText = await diffTreeOrEmpty(repo, previousFilteredTree, currentFilteredTree);
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
	// and 3-way synthesis used above; anything left is uncommitted work.
	const finalFilteredTree = await writeSyntheticTree(opts.repoRoot, baselineSha, [opts.rootPatch], {
		threeWay: true,
	});
	const leftoverPatch = await diffTreeOrEmpty(repo, previousFilteredTree, finalFilteredTree);
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
