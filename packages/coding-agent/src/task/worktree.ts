import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { VcsCommitAuthor, VcsGitRepo } from "@oh-my-pi/pi-natives";
import * as natives from "@oh-my-pi/pi-natives";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { formatBytes, getWorktreeDir, logger, Snowflake } from "@oh-my-pi/pi-utils";
import type { SettingValue } from "../config/settings-schema";
import { withRepoLock } from "../utils/repo-lock";
import { writeIsolationOwner } from "./isolation-ownership";
import { mapWithConcurrencyLimit } from "./parallel";

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

async function tryRemoveWorktree(repo: VcsGitRepo, worktreePath: string): Promise<boolean> {
	try {
		return await repo.worktreeRemove(worktreePath, true);
	} catch {
		return false;
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
 */
export const ISOLATION_BASELINE_MAX_CONTENT_BYTES = 1024 * 1024 * 1024;

/**
 * Thrown when a repo's uncommitted content exceeds
 * {@link ISOLATION_BASELINE_MAX_CONTENT_BYTES}. Surfaced verbatim so the
 * caller can report the real cause (oversized working tree) rather than
 * masking it as a missing git repository.
 */
export class IsolationBaselineTooLargeError extends Error {
	constructor(
		readonly repoRoot: string,
		readonly contentBytes: number,
	) {
		super(
			`Working tree at ${repoRoot} carries ${formatBytes(contentBytes)} of uncommitted content, ` +
				`over the ${formatBytes(ISOLATION_BASELINE_MAX_CONTENT_BYTES)} isolation-snapshot budget. ` +
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

async function captureRepoBaseline(repoRoot: string): Promise<RepoBaseline> {
	const repo = vcs.requireGit(repoRoot);
	const headCommit = (await repo.headSha()) ?? "";
	const staged = await repo.diffText({ binary: true, cached: true });
	const unstaged = await repo.diffText({ binary: true });
	const untracked = await repo.lsFiles(true, true);
	// Gate before capturing the untracked patch: that step embeds every
	// untracked byte into one in-memory string, so an oversized tree must be
	// refused here rather than after buffering gigabytes (#8939). Untracked
	// bytes come from stat (no reads); staged/unstaged are already captured
	// binary diffs, so their string length is their in-memory footprint.
	const untrackedBytes = await sumUntrackedBytes(repoRoot, untracked);
	const contentBytes = untrackedBytes + staged.length + unstaged.length;
	if (contentBytes > ISOLATION_BASELINE_MAX_CONTENT_BYTES) {
		throw new IsolationBaselineTooLargeError(repoRoot, contentBytes);
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

export async function captureBaseline(repoRoot: string): Promise<WorktreeBaseline> {
	const [root, nestedPaths] = await Promise.all([captureRepoBaseline(repoRoot), discoverNestedRepos(repoRoot)]);
	const nested = await Promise.all(
		nestedPaths.map(async relativePath => ({
			relativePath,
			baseline: await captureRepoBaseline(path.join(repoRoot, relativePath)),
		})),
	);
	return { root, nested };
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

export interface NestedRepoPatch {
	relativePath: string;
	patch: string;
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
export type IsolationBackendSetting = SettingValue<"isolation.backend">;

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
	const resolution = natives.isoResolve(preferred ?? null);
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
		await writeIsolationOwner(baseDir, id);
		try {
			await natives.isoStart(candidate, repoRoot, mergedDir);
			// Sever the isolation's git metadata from the source checkout. Copy
			// backends duplicate `repoRoot`'s `.git` verbatim — a linked-worktree
			// pointer file (or the rcopy `git worktree add` registration) leaves
			// the isolation sharing the source's HEAD/index/ref namespace, so a
			// task's git operations would mutate the parent checkout and stack
			// parallel task branches. Detaching gives each isolation a private,
			// frozen repo that still borrows the source object DB via alternates.
			await vcs.detachGitDir(mergedDir, sourceCommonDir);
			return {
				mergedDir,
				backend: candidate,
				fellBack: candidate !== resolution.kind || resolution.fellBack,
				fallbackReason,
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
 * whenever {@link baselineHasRootWip} is true so
 * {@link commitPatchToBranchWorktree} can replay the WIP into the temp
 * worktree first, then rewind WIP-only files after applying the delta.
 */
interface BaselineWipContext {
	readonly staged: string;
	readonly unstaged: string;
	readonly untrackedPatch: string;
	/** Untracked file paths present in the baseline (never in HEAD). */
	readonly untracked: readonly string[];
}

function collectWipPatches(wip: BaselineWipContext | undefined): string[] {
	if (!wip) return [];
	return [wip.staged, wip.unstaged, wip.untrackedPatch].filter(p => p.trim());
}

async function commitPatchToBranchWorktree(
	tmpDir: string,
	taskId: string,
	patchText: string,
	message: string,
	author?: VcsCommitAuthor,
	baselineWip?: BaselineWipContext,
): Promise<void> {
	const repo = vcs.requireGit(tmpDir);
	// Try the two clean paths first — they yield an agent-only commit and are
	// the happy case when the temp worktree can resolve the patch against
	// HEAD directly:
	//
	//   1. Plain apply — works when WIP context happens to match HEAD (e.g.
	//      WIP-touched files that the delta patch doesn't reference).
	//   2. `--3way`   — works when the WIP-side blob is tracked in HEAD and
	//      lives in the shared ODB (captureDeltaPatch seeded it while writing
	//      the synthetic baseline tree). The 3-way merge subtracts WIP,
	//      producing an agent-only commit even when WIP and agent modify the
	//      same tracked file at unrelated lines.
	//
	// If both fail (untracked WIP files, staged-new WIP files, or overlap that
	// --3way can't resolve — see #4136), replay the WIP into the worktree
	// first so the delta's context lines match, then rewind WIP-only files so
	// they don't leak into the commit. Files touched by BOTH WIP and delta
	// keep their combined state; the parent's stash-pop reconciles the WIP
	// side via 3-way merge on merge-back.
	let plainErr: vcs.VcsError | undefined;
	try {
		await repo.applyPatch(patchText, {});
	} catch (err) {
		if (!vcs.isVcsError(err)) throw err;
		plainErr = err;
	}
	if (plainErr) {
		let threeWayErr: vcs.VcsError | undefined;
		try {
			await repo.applyPatch(patchText, { threeWay: true });
		} catch (err) {
			if (!vcs.isVcsError(err)) throw err;
			threeWayErr = err;
		}
		if (threeWayErr) {
			const wipPatches = collectWipPatches(baselineWip);
			if (wipPatches.length === 0 || !baselineWip) {
				const stderr = threeWayErr.stderr.slice(0, 2000);
				logger.error("commitToBranch: git apply --3way failed", {
					taskId,
					exitCode: threeWayErr.exitCode,
					stderr,
					initialStderr: plainErr.stderr.slice(0, 2000),
					patchSize: patchText.length,
					patchHead: patchText.slice(0, 500),
				});
				throw new Error(`git apply --3way failed for task ${taskId}: ${stderr}`);
			}
			try {
				// `git apply --3way` leaves conflict markers in `U` files when
				// it can't resolve; reset the worktree so the WIP-seeded retry
				// starts from a clean HEAD tree.
				await repo.reset("hard", "HEAD");
				await applyDeltaOverBaselineWip(tmpDir, taskId, patchText, wipPatches, baselineWip);
			} catch (wipErr) {
				if (!vcs.isVcsError(wipErr)) throw wipErr;
				const stderr = wipErr.stderr.slice(0, 2000);
				logger.error("commitToBranch: git apply with baseline WIP failed", {
					taskId,
					exitCode: wipErr.exitCode,
					stderr,
					threeWayStderr: threeWayErr.stderr.slice(0, 2000),
					initialStderr: plainErr.stderr.slice(0, 2000),
					patchSize: patchText.length,
					patchHead: patchText.slice(0, 500),
				});
				throw new Error(`git apply with baseline WIP failed for task ${taskId}: ${stderr}`);
			}
		}
	}

	await repo.stageFiles([]);
	await repo.commitCreate(message, author ? { author } : {});
}

/**
 * Replay baseline WIP into the temp worktree so the delta patch's HEAD+WIP
 * context matches, apply the delta, then rewind files WIP touched but the
 * delta didn't — HEAD-tracked files are restored via `git restore`, untracked
 * or staged-new WIP files are removed from the worktree. The commit that
 * follows reflects agent's delta plus any overlap with WIP; parent's
 * stash-pop reconciles the WIP side on merge-back.
 */
async function applyDeltaOverBaselineWip(
	tmpDir: string,
	_taskId: string,
	patchText: string,
	wipPatches: readonly string[],
	baselineWip: BaselineWipContext,
): Promise<void> {
	const repo = vcs.requireGit(tmpDir);
	for (const wip of wipPatches) {
		await repo.applyPatch(wip, {});
	}
	await repo.applyPatch(patchText, {});

	const wipFiles = new Set(wipPatches.flatMap(patchTouchedFiles));
	const deltaFiles = new Set(patchTouchedFiles(patchText));
	const wipOnly = [...wipFiles].filter(f => !deltaFiles.has(f));
	if (wipOnly.length === 0) return;

	// Any wipOnly file baselined as untracked cannot be in HEAD.
	// Everything else may or may not — verify against HEAD's tree.
	const untrackedSet = new Set(baselineWip.untracked);
	const candidates = wipOnly.filter(f => !untrackedSet.has(f));
	const inHead = candidates.length > 0 ? new Set(await repo.lsTree("HEAD", candidates)) : new Set<string>();
	const toRestore = candidates.filter(f => inHead.has(f));
	const toRemove = wipOnly.filter(f => !toRestore.includes(f));
	if (toRestore.length > 0) {
		await repo.restore({ source: "HEAD", staged: true, worktree: true, files: toRestore });
	}
	for (const rel of toRemove) {
		await fs.rm(path.join(tmpDir, rel), { force: true });
	}
}

interface FilteredAgentReplayOptions {
	baseline: WorktreeBaseline;
	branchName: string;
	commitMessage?: (diff: string) => Promise<string | null>;
	fallbackMessage: string;
	isolationDir: string;
	isolationHead: string;
	repoRoot: string;
	rootPatch: string;
	taskId: string;
}

async function replayFilteredAgentCommits(opts: FilteredAgentReplayOptions): Promise<void> {
	const baselineSha = opts.baseline.root.headCommit;
	const repo = vcs.requireGit(opts.repoRoot);
	const isolationRepo = vcs.requireGit(opts.isolationDir);
	await repo.createBranch(opts.branchName, baselineSha, false);

	const tmpDir = path.join(os.tmpdir(), `omp-branch-${Snowflake.next()}`);
	try {
		await repo.worktreeAdd(tmpDir, opts.branchName, { detach: false, clone: false });
		const agentCommits = await isolationRepo.revListRange(baselineSha, opts.isolationHead);
		const baselineWip = [opts.baseline.root.staged, opts.baseline.root.unstaged, opts.baseline.root.untrackedPatch];
		// Seed the parent ODB with the dirty-side blobs needed by `git apply
		// --3way`. Isolation repositories can read parent objects, but the parent
		// cannot read objects created only inside isolation.
		await writeSyntheticTree(opts.repoRoot, baselineSha, baselineWip);
		const dirtyBaselineTree = await writeSyntheticTree(opts.isolationDir, baselineSha, baselineWip);
		let previousFilteredTree = baselineSha;
		let filteredCommitsApplied = 0;

		for (const commitSha of agentCommits) {
			const taskStatePatch = await diffTreeOrEmpty(isolationRepo, dirtyBaselineTree, `${commitSha}^{tree}`);
			const currentFilteredTree = await writeSyntheticTree(opts.repoRoot, baselineSha, [taskStatePatch], {
				threeWay: true,
			});
			const commitPatch = await diffTreeOrEmpty(repo, previousFilteredTree, currentFilteredTree);
			if (commitPatch.trim()) {
				const details = await isolationRepo.commitDetails(commitSha);
				await commitPatchToBranchWorktree(
					tmpDir,
					opts.taskId,
					commitPatch,
					details.message || commitSha,
					details.author,
				);
				filteredCommitsApplied++;
			}
			previousFilteredTree = currentFilteredTree;
		}
		if (filteredCommitsApplied === 0) {
			// No filtered commit landed — tmpDir is still pinned at baselineSha.
			// The `finalFilteredTree = writeSyntheticTree(HEAD, [rootPatch])`
			// path here fails hard whenever rootPatch's WIP-context can't be
			// applied to a HEAD-only index (untracked WIP + agent modifies,
			// staged-new WIP + agent modifies — see #4136). Bypass the synthesis
			// entirely and collapse the isolation output onto a single commit
			// with WIP seed, matching the no-agent-commit path in commitToBranch.
			// This also handles the "agent committed only baseline WIP" corner
			// case where every filtered patch collapsed to empty.
			if (opts.rootPatch.trim()) {
				const msg = (opts.commitMessage && (await opts.commitMessage(opts.rootPatch))) || opts.fallbackMessage;
				await commitPatchToBranchWorktree(tmpDir, opts.taskId, opts.rootPatch, msg, undefined, opts.baseline.root);
			}
		} else {
			// A filtered commit landed; reconstruct the final HEAD-derived tree
			// with the same dirty-side blobs and 3-way synthesis used above.
			const finalFilteredTree = await writeSyntheticTree(opts.repoRoot, baselineSha, [opts.rootPatch], {
				threeWay: true,
			});
			const leftoverPatch = await diffTreeOrEmpty(repo, previousFilteredTree, finalFilteredTree);
			if (leftoverPatch.trim()) {
				const msg = (opts.commitMessage && (await opts.commitMessage(leftoverPatch))) || opts.fallbackMessage;
				await commitPatchToBranchWorktree(tmpDir, opts.taskId, leftoverPatch, msg);
			}
		}
	} finally {
		await tryRemoveWorktree(repo, tmpDir);
		await fs.rm(tmpDir, { recursive: true, force: true });
	}
}

/**
 * Capture task-only changes from the isolation worktree onto a parent-repo
 * branch named `omp/task/${taskId}`. Only root-repo changes go on the branch;
 * nested-repo patches are returned separately because the parent git can't
 * track files inside gitlinks.
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
 * branch commit with an AI-generated (or fallback) message — the legacy
 * behaviour.
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
	if (!rootPatch.trim()) return { nestedPatches };

	const repoRoot = baseline.root.repoRoot;
	const repo = vcs.requireGit(repoRoot);
	const branchName = `omp/task/${taskId}`;
	const fallbackMessage = description || taskId;

	let branchCreated = false;

	if (agentCommitted) {
		if (baselineHasRootWip(baseline.root)) {
			await replayFilteredAgentCommits({
				baseline,
				branchName,
				commitMessage,
				fallbackMessage,
				isolationDir,
				isolationHead,
				repoRoot,
				rootPatch,
				taskId,
			});
		} else {
			// Transfer the agent's commit objects (which live in isolation's `.git`,
			// stranded once `cleanupIsolation` tears the overlay down) into the parent
			// repo's object DB and create the branch at the agent's HEAD. `+HEAD:…`
			// force-overwrites a stale branch from a prior run.
			await repo.fetch(isolationDir, "HEAD", `refs/heads/${branchName}`, GIT_NETWORK_TIMEOUT_MS);

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
				const tmpDir = path.join(os.tmpdir(), `omp-branch-${Snowflake.next()}`);
				try {
					await repo.worktreeAdd(tmpDir, branchName, { detach: false, clone: false });
					const msg = (commitMessage && (await commitMessage(leftoverPatch))) || fallbackMessage;
					await commitPatchToBranchWorktree(tmpDir, taskId, leftoverPatch, msg);
				} finally {
					await tryRemoveWorktree(repo, tmpDir);
					await fs.rm(tmpDir, { recursive: true, force: true });
				}
			}
		}
		branchCreated = true;
	} else if (rootPatch.trim()) {
		await repo.createBranch(branchName, baselineSha, false);
		branchCreated = true;
		const tmpDir = path.join(os.tmpdir(), `omp-branch-${Snowflake.next()}`);
		try {
			await repo.worktreeAdd(tmpDir, branchName, { detach: false, clone: false });

			const msg = (commitMessage && (await commitMessage(rootPatch))) || fallbackMessage;
			const wip = baselineHasRootWip(baseline.root) ? baseline.root : undefined;
			await commitPatchToBranchWorktree(tmpDir, taskId, rootPatch, msg, undefined, wip);
		} finally {
			await tryRemoveWorktree(repo, tmpDir);
			await fs.rm(tmpDir, { recursive: true, force: true });
		}
	}

	return {
		branchName: branchCreated ? branchName : undefined,
		baseSha: baselineSha,
		nestedPatches,
	};
}

export interface MergeBranchResult {
	merged: string[];
	failed: string[];
	conflict?: string;
	/** Set when cherry-picks landed on HEAD but restoring the stashed working tree failed. */
	stashConflict?: string;
}

/**
 * Cherry-pick task branch commits sequentially onto HEAD. When `baseSha` is
 * provided the cherry-pick uses the inclusive range `baseSha..branchName`,
 * replaying every commit individually and preserving each commit's message
 * and author. When omitted, the branch is cherry-picked as a single commit
 * (legacy callers).
 *
 * Stops on the first conflict and reports which branches succeeded.
 */
export async function mergeTaskBranches(
	repoRoot: string,
	branches: Array<{ branchName: string; taskId: string; description?: string; baseSha?: string }>,
): Promise<MergeBranchResult> {
	// Serialize against other in-process git mutations on this repo: concurrent
	// background merges interleaving stash push/pop + cherry-pick would corrupt
	// the working tree (lost uncommitted changes, mixed-up stash entries).
	return withRepoLock(repoRoot, async () => {
		const repo = vcs.requireGit(repoRoot);
		const merged: string[] = [];
		const failed: string[] = [];

		// Stash dirty working tree so cherry-pick can operate on a clean HEAD.
		// Without this, cherry-pick refuses to run when uncommitted changes exist.
		const didStash = await repo.stashPush("omp-task-merge");

		let conflictResult: MergeBranchResult | undefined;

		try {
			for (const { branchName, baseSha } of branches) {
				try {
					const revisions = baseSha ? await repo.revListRange(baseSha, branchName) : [branchName];
					for (const revision of revisions) {
						try {
							await repo.cherryPick(revision);
						} catch (error) {
							if (!vcs.isEmptyCherryPick(error)) throw error;
							await repo.cherryPickSkip();
						}
					}
				} catch (error) {
					try {
						await repo.cherryPickAbort();
					} catch {
						/* no state to abort */
					}
					const stderr = vcs.isVcsError(error)
						? error.stderr.trim()
						: error instanceof Error
							? error.message
							: String(error);
					failed.push(branchName);
					conflictResult = {
						merged,
						failed: [...failed, ...branches.slice(merged.length + failed.length).map(b => b.branchName)],
						conflict: `${branchName}: ${stderr}`,
					};
					break;
				}

				merged.push(branchName);
			}
		} finally {
			if (didStash) {
				const restored = await repo.stashTryPop(true).catch(() => false);
				if (!restored) {
					// Stash pop would leave stage 1/2/3 unmerged entries in `.git/index`
					// that overlay-isolated subsequent tasks inherit through the lower
					// layer, corrupting every downstream `captureRepoDeltaPatch`. `tryPop`
					// short-circuits the pop when the WIP would conflict with the
					// cherry-picked HEAD (and reset-cleans up if a rarer conflict slips
					// past). The merged branches DID land — surface a stash-restore
					// warning without claiming the merge failed.
					logger.warn("Failed to restore stashed changes after task merge; stash entry preserved");
					const stashConflict =
						"stash pop: cherry-picked changes conflict with uncommitted edits. The merged commits are on HEAD; run `git stash pop` and resolve manually.";
					if (conflictResult) {
						conflictResult.stashConflict = stashConflict;
					} else {
						conflictResult = { merged, failed: [], stashConflict };
					}
				}
			}
		}

		return conflictResult ?? { merged, failed };
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
