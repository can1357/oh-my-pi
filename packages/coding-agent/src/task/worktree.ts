import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as natives from "@pk-nerdsaver-ai/pi-natives";
import { getWorktreeDir, hashPath, logger, Snowflake } from "@pk-nerdsaver-ai/pi-utils";
import * as git from "../utils/git";
import * as jj from "../utils/jj";
import { mapWithConcurrencyLimit } from "./parallel";

const { IsoBackendKind } = natives;
type IsoBackendKind = natives.IsoBackendKind;

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
	if (await jj.isPureJjRepo(cwd)) {
		throw new Error(
			"Isolated task execution requires a Git checkout, but this workspace is pure Jujutsu (`.jj/` without a colocated `.git/`). Run `jj git init --colocate` to add a Git checkout, or set `task.isolation.mode: none` to disable task isolation.",
		);
	}

	const repoRoot = await git.repo.root(cwd);
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
	const submodulePaths = new Set(await git.ls.submodules(repoRoot));

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

async function captureUntrackedPatch(repoRoot: string, untracked: readonly string[]): Promise<string> {
	if (untracked.length === 0) return "";
	const nullPath = getGitNoIndexNullPath();
	// Bound concurrent git spawns; large untracked sets would otherwise fork one
	// process per file at once.
	const { results: untrackedDiffs } = await mapWithConcurrencyLimit([...untracked], 8, entry =>
		git.diff(repoRoot, {
			allowFailure: true,
			binary: true,
			noIndex: { left: nullPath, right: entry },
		}),
	);
	return untrackedDiffs.filter((diff): diff is string => !!diff?.trim()).join("\n");
}

async function captureRepoBaseline(repoRoot: string): Promise<RepoBaseline> {
	const headCommit = (await git.head.sha(repoRoot)) ?? "";
	const staged = await git.diff(repoRoot, { binary: true, cached: true });
	const unstaged = await git.diff(repoRoot, { binary: true });
	const untracked = await git.ls.untracked(repoRoot);
	const untrackedPatch = await captureUntrackedPatch(repoRoot, untracked);
	return { repoRoot, headCommit, staged, unstaged, untracked, untrackedPatch };
}

async function writeSyntheticTree(repoDir: string, baseTreeish: string, patches: readonly string[]): Promise<string> {
	const tempIndex = path.join(os.tmpdir(), `omp-task-index-${Snowflake.next()}`);
	try {
		await git.readTree(repoDir, baseTreeish, {
			env: { GIT_INDEX_FILE: tempIndex },
		});
		for (const patch of patches) {
			if (!patch.trim()) continue;
			await git.patch.applyText(repoDir, patch, {
				cached: true,
				env: { GIT_INDEX_FILE: tempIndex },
			});
		}
		return await git.writeTree(repoDir, {
			env: { GIT_INDEX_FILE: tempIndex },
		});
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

async function captureRepoDeltaPatch(repoDir: string, rb: RepoBaseline): Promise<string> {
	const currentHead = (await git.head.sha(repoDir)) ?? "";
	const currentStaged = await git.diff(repoDir, { binary: true, cached: true });
	const currentUnstaged = await git.diff(repoDir, { binary: true });
	const currentUntracked = await git.ls.untracked(repoDir);
	const currentUntrackedPatch = await captureUntrackedPatch(repoDir, currentUntracked);

	const baselineTree = await writeSyntheticTree(repoDir, rb.headCommit, [rb.staged, rb.unstaged, rb.untrackedPatch]);
	const currentTree = await writeSyntheticTree(repoDir, currentHead, [
		currentStaged,
		currentUnstaged,
		currentUntrackedPatch,
	]);

	return git.diff.tree(repoDir, baselineTree, currentTree, {
		allowFailure: true,
		binary: true,
	});
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
	const rootPatch = await captureRepoDeltaPatch(isolationDir, baseline.root);
	const nestedPatches: NestedRepoPatch[] = [];

	for (const { relativePath, baseline: nb } of baseline.nested) {
		const nestedDir = path.join(isolationDir, relativePath);
		try {
			await fs.access(path.join(nestedDir, ".git"));
		} catch {
			continue;
		}
		const patch = await captureRepoDeltaPatch(nestedDir, nb);
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

		const combinedDiff = repoPatches.map(p => p.patch).join("\n");
		const touchedFiles = [...new Set(repoPatches.flatMap(p => patchTouchedFiles(p.patch)))];

		// Preserve any pre-existing dirty state (tracked + untracked) so we
		// commit only the agent delta, not the user's in-flight work.
		const stashed =
			(await git.status(nestedDir)).trim().length > 0
				? await git.stash.push(nestedDir, `omp-isolation-${Snowflake.next()}`)
				: false;
		try {
			for (const { patch } of repoPatches) {
				await git.patch.applyText(nestedDir, patch);
			}
			if ((await git.status(nestedDir)).trim().length > 0) {
				if (touchedFiles.length === 0) {
					throw new Error(`Nested repo patch for ${relativePath} did not include stageable file paths.`);
				}
				const msg = (await commitMessage?.(combinedDiff)) ?? "changes from isolated task(s)";
				await git.stage.files(nestedDir, touchedFiles);
				await git.commit(nestedDir, msg);
			}
		} finally {
			if (stashed) {
				try {
					await git.stash.pop(nestedDir, { index: true });
				} catch (popErr) {
					const message = popErr instanceof Error ? popErr.message : String(popErr);
					logger.warn("Pre-existing nested-repo dirty state could not be auto-restored", {
						nestedDir,
						error: message,
					});
					warnings.push(
						`Pre-existing dirty state in nested repo \`${relativePath}\` could not be auto-restored after the agent commit; stash entry preserved (${message}).`,
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

/**
 * User-facing isolation mode names exposed by the `task.isolation.mode`
 * setting. Mapped to a backend-kind hint via {@link parseIsolationMode};
 * the PAL's `iso_resolve` then falls back through the kind order
 * whenever the hint isn't available on the current host.
 */
export type TaskIsolationMode =
	| "none"
	| "auto"
	| "apfs"
	| "btrfs"
	| "zfs"
	| "reflink"
	| "overlayfs"
	| "projfs"
	| "block-clone"
	| "rcopy"
	// Legacy values, accepted for back-compat with pre-PAL settings files.
	| "worktree"
	| "fuse-overlay"
	| "fuse-projfs";

/**
 * Translate a {@link TaskIsolationMode} string to an [`IsoBackendKind`]
 * the PAL can act on. `"none"` returns `null` (caller skips isolation
 * entirely); `"auto"` returns `undefined` (no hint — let the resolver
 * pick). Anything else returns the matching kind.
 */
export function parseIsolationMode(mode: TaskIsolationMode): IsoBackendKind | undefined {
	switch (mode) {
		case "none":
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
		case "fuse-overlay":
			return IsoBackendKind.Overlayfs;
		case "projfs":
		case "fuse-projfs":
			return IsoBackendKind.Projfs;
		case "block-clone":
			return IsoBackendKind.WindowsBlockClone;
		case "rcopy":
		case "worktree":
			return IsoBackendKind.Rcopy;
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

export async function ensureIsolation(
	baseCwd: string,
	id: string,
	preferred?: IsoBackendKind,
): Promise<IsolationHandle> {
	const repoRoot = await getRepoRoot(baseCwd);
	const baseDir = getWorktreeDir(`${id}-${hashPath(repoRoot)}`);
	const mergedDir = path.join(baseDir, "merged");

	const resolution = natives.isoResolve(preferred ?? null);
	const candidates = resolution.candidates.length > 0 ? resolution.candidates : [resolution.kind];
	let fallbackReason = resolution.reason ?? null;

	for (const candidate of candidates) {
		await fs.rm(baseDir, { recursive: true, force: true });
		try {
			await natives.isoStart(candidate, repoRoot, mergedDir);
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
}

/**
 * Commit task-only changes to a new branch.
 * Only root repo changes go on the branch. Nested repo patches are returned
 * separately since the parent git can't track files inside gitlinks.
 */
export async function commitToBranch(
	isolationDir: string,
	baseline: WorktreeBaseline,
	taskId: string,
	description: string | undefined,
	commitMessage?: (diff: string) => Promise<string | null>,
): Promise<CommitToBranchResult | null> {
	const { rootPatch, nestedPatches } = await captureDeltaPatch(isolationDir, baseline);
	if (!rootPatch.trim() && nestedPatches.length === 0) return null;

	const repoRoot = baseline.root.repoRoot;
	const branchName = `omp/task/${taskId}`;
	const fallbackMessage = description || taskId;

	// Only create a branch if the root repo has changes
	if (rootPatch.trim()) {
		await git.branch.create(repoRoot, branchName);
		const tmpDir = path.join(os.tmpdir(), `omp-branch-${Snowflake.next()}`);
		try {
			await git.worktree.add(repoRoot, tmpDir, branchName);
			try {
				await git.patch.applyText(tmpDir, rootPatch);
			} catch (err) {
				if (err instanceof git.GitCommandError) {
					const stderr = err.result.stderr.slice(0, 2000);
					logger.error("commitToBranch: git apply failed", {
						taskId,
						exitCode: err.result.exitCode,
						stderr,
						patchSize: rootPatch.length,
						patchHead: rootPatch.slice(0, 500),
					});
					throw new Error(`git apply failed for task ${taskId}: ${stderr}`);
				}
				throw err;
			}
			await git.stage.files(tmpDir);
			const msg = (commitMessage && (await commitMessage(rootPatch))) || fallbackMessage;
			await git.commit(tmpDir, msg);
		} finally {
			await git.worktree.tryRemove(repoRoot, tmpDir);
			await fs.rm(tmpDir, { recursive: true, force: true });
		}
	}

	return { branchName: rootPatch.trim() ? branchName : undefined, nestedPatches };
}

export interface MergeBranchResult {
	merged: string[];
	failed: string[];
	conflict?: string;
	/** Set when cherry-picks landed on HEAD but restoring the stashed working tree failed. */
	stashConflict?: string;
}

/**
 * Cherry-pick task branch commits sequentially onto HEAD.
 * Each branch has a single commit that gets replayed cleanly.
 * Stops on first conflict and reports which branches succeeded.
 */
export async function mergeTaskBranches(
	repoRoot: string,
	branches: Array<{ branchName: string; taskId: string; description?: string }>,
): Promise<MergeBranchResult> {
	// Serialize against other in-process git mutations on this repo: concurrent
	// background merges interleaving stash push/pop + cherry-pick would corrupt
	// the working tree (lost uncommitted changes, mixed-up stash entries).
	return git.withRepoLock(repoRoot, async () => {
		const merged: string[] = [];
		const failed: string[] = [];

		// Stash dirty working tree so cherry-pick can operate on a clean HEAD.
		// Without this, cherry-pick refuses to run when uncommitted changes exist.
		const didStash = await git.stash.push(repoRoot, "omp-task-merge");

		let conflictResult: MergeBranchResult | undefined;

		try {
			for (const { branchName } of branches) {
				try {
					await git.cherryPick(repoRoot, branchName);
				} catch (err) {
					try {
						await git.cherryPick.abort(repoRoot);
					} catch {
						/* no state to abort */
					}
					const stderr =
						err instanceof git.GitCommandError
							? err.result.stderr.trim()
							: err instanceof Error
								? err.message
								: String(err);
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
				try {
					await git.stash.pop(repoRoot, { index: true });
				} catch {
					// Stash-pop conflicts mean the replayed changes clash with the user's
					// uncommitted edits. The cherry-picked commits are already on HEAD, so
					// the merged branches DID land — report them as merged and surface the
					// stash conflict separately instead of claiming they are unmerged.
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
	for (const branch of branches) {
		await git.branch.tryDelete(repoRoot, branch);
	}
}
