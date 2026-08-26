/**
 * Workspace snapshot capture.
 *
 * Capture never mutates the repository the user is working in beyond adding
 * objects and one ref: staging happens in a throwaway index, the snapshot commit
 * is created with `commit-tree`, and HEAD/branch/index stay exactly where they
 * were. Content addressing means two identical workspaces share every object, so
 * repeated checkpoints of an unchanged tree cost nothing on disk.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as git from "../utils/git";
import { CheckpointError, type WorkspaceIdentity } from "./types";

/** Author/committer identity stamped on snapshot commits (never the user's). */
const CHECKPOINT_AUTHOR: git.CommitAuthor = { name: "omp checkpoints", email: "checkpoints@oh-my-pi.local" };

/**
 * Oversize files are excluded one pathspec at a time, so a workspace full of
 * huge files would otherwise produce an unbounded `git add` invocation. Past
 * this many, the capture refuses instead of half-snapshotting the workspace.
 */
const MAX_OVERSIZE_SKIPS = 50;

export interface CaptureOutcome {
	readonly treeSha: string;
	readonly bytesCaptured: number;
	readonly skippedFiles: string[];
}

/**
 * Resolve the workspace identity for `cwd`.
 * @throws CheckpointError when `cwd` is not inside a git repository.
 */
export async function resolveWorkspaceIdentity(cwd: string, signal?: AbortSignal): Promise<WorkspaceIdentity> {
	const repository = await git.repo.resolve(cwd);
	if (!repository) throw new CheckpointError(`not a git repository: ${cwd}`);
	const worktreePath = repository.repoRoot;
	const [primaryRoot, headSha, branch] = await Promise.all([
		git.repo.primaryRoot(worktreePath, signal),
		git.head.sha(worktreePath, signal),
		git.branch.current(worktreePath, signal),
	]);
	return { repoRoot: primaryRoot ?? worktreePath, worktreePath, headSha, branch };
}

/**
 * Paths whose working-tree content is not already in the object database:
 * untracked files plus modified/staged tracked files. These are the only paths a
 * capture can add bytes for, so they are the only ones the size guard needs to
 * probe.
 */
function parseStatusPaths(raw: string): string[] {
	const fields = raw.split("\0");
	const paths: string[] = [];
	for (let index = 0; index < fields.length; index += 1) {
		const record = fields[index];
		// "XY <path>" — shortest possible record is two status chars, a space, one path char.
		if (!record || record.length < 4) continue;
		paths.push(record.slice(3));
		// Rename/copy records carry the origin path in the following field.
		if (record[0] === "R" || record[0] === "C") index += 1;
	}
	return paths;
}

/**
 * Files above `maxFileBytes` that a capture must leave out. Symlinks and
 * directories are never oversize (a symlink's "size" is its target string), and
 * a path that vanished between status and stat contributes nothing.
 */
export async function findOversizeFiles(
	worktreeRoot: string,
	maxFileBytes: number,
	signal?: AbortSignal,
): Promise<string[]> {
	const raw = await git.status(worktreeRoot, { z: true, untrackedFiles: "all", signal });
	const candidates = parseStatusPaths(raw);
	const oversize: string[] = [];
	await Promise.all(
		candidates.map(async candidate => {
			try {
				const stat = await fs.lstat(path.join(worktreeRoot, candidate));
				if (stat.isFile() && stat.size > maxFileBytes) oversize.push(candidate);
			} catch {
				// Deleted or unreadable between status and stat: nothing to exclude.
			}
		}),
	);
	return oversize.sort();
}

/**
 * Snapshot the working tree into a tree object and account for its size.
 *
 * @throws CheckpointError when more files than {@link MAX_OVERSIZE_SKIPS} would
 * have to be excluded — silently dropping that many files would make the
 * checkpoint a misleading restore point.
 */
export async function captureWorkspaceTree(
	worktreeRoot: string,
	options: { maxFileBytes: number; signal?: AbortSignal },
): Promise<CaptureOutcome> {
	const skippedFiles = await findOversizeFiles(worktreeRoot, options.maxFileBytes, options.signal);
	if (skippedFiles.length > MAX_OVERSIZE_SKIPS) {
		throw new CheckpointError(
			`${skippedFiles.length} files exceed the ${options.maxFileBytes}-byte checkpoint limit (max ${MAX_OVERSIZE_SKIPS}); raise checkpoints.maxFileBytes or ignore those paths`,
		);
	}
	const treeSha = await git.captureWorktreeTree(worktreeRoot, {
		excludePaths: skippedFiles,
		signal: options.signal,
	});
	const blobs = await git.ls.treeBlobs(worktreeRoot, treeSha, options.signal);
	let bytesCaptured = 0;
	for (const blob of blobs) bytesCaptured += blob.size;
	return { treeSha, bytesCaptured, skippedFiles };
}

/**
 * Create the snapshot commit and point `refName` at it. Object writes and the
 * ref update share the repo lock so a concurrent git operation in the same
 * process cannot collide on git's ref locks.
 */
export async function writeCheckpointRef(
	worktreeRoot: string,
	options: {
		refName: string;
		treeSha: string;
		parentSha: string | null;
		message: string;
		signal?: AbortSignal;
	},
): Promise<string> {
	return git.withRepoLock(
		worktreeRoot,
		async () => {
			const commitSha = await git.commitTree(worktreeRoot, options.treeSha, {
				author: CHECKPOINT_AUTHOR,
				message: options.message,
				parents: options.parentSha ? [options.parentSha] : [],
				signal: options.signal,
			});
			await git.ref.update(worktreeRoot, options.refName, commitSha, options.signal);
			return commitSha;
		},
		options.signal,
	);
}
