/**
 * Git plumbing backing workspace checkpoints, on top of the sanctioned
 * `@oh-my-pi/pi-natives/vcs` repository objects (see AGENTS.md — never spawn
 * `git` from feature code). Each operation maps to a dedicated natives
 * primitive added for this feature:
 *
 * - {@link captureWorktreeTree} — throwaway-index full-tree snapshot
 * - {@link commitTree} — commit object without moving HEAD or branches
 * - {@link treeStatus} — `diff-tree --name-status -z` between two trees
 * - {@link refList}/{@link refUpdate}/{@link refDelete} — checkpoint refs
 * - {@link treeBlobs} — `ls-tree -r -l` blob inventory for disk accounting
 */

import * as vcs from "@oh-my-pi/pi-natives/vcs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Snowflake } from "@oh-my-pi/pi-utils";
import type { VcsGitRepo } from "@oh-my-pi/pi-natives";
import { withRepoLock } from "../utils/repo-lock";
import { throwIfAborted } from "../tools/tool-errors";

/** `git diff-tree --name-status` status letter, restricted to what two trees can produce. */
export type TreeDiffStatus = "A" | "D" | "M" | "T";

export interface TreeDiffEntry {
	path: string;
	status: TreeDiffStatus;
}

export interface TreeBlobEntry {
	oid: string;
	path: string;
	/** Object size in bytes; `0` when the size is not a parseable integer. */
	size: number;
}

export interface CommitAuthor {
	name: string;
	email: string;
	/** Git date (`@<seconds> <offset>` or RFC 2822); omit for "now". */
	date?: string;
}

/**
 * Parse NUL-delimited `diff-tree --name-status -z` output. The stream
 * alternates status field / path field; unknown status letters (copy/rename
 * records, which `--no-renames` suppresses) are dropped rather than guessed
 * at.
 */
export function parseTreeNameStatus(text: string): TreeDiffEntry[] {
	const entries: TreeDiffEntry[] = [];
	const fields = text.split("\0");
	for (let index = 0; index + 1 < fields.length; index += 2) {
		const status = fields[index];
		const filePath = fields[index + 1];
		if (status === "A" || status === "D" || status === "M" || status === "T") {
			entries.push({ path: filePath, status });
		}
	}
	return entries;
}
/** Resolve the natives repo handle for `cwd`, or `null` outside a repository. */
function repoOrNull(cwd: string): VcsGitRepo | null {
	return vcs.git(cwd);
}

function requireRepo(cwd: string): VcsGitRepo {
	return vcs.requireGit(cwd);
}

/**
 * Snapshot the full working tree of `worktreeRoot` into a tree object without
 * touching the repository's real index, HEAD, or working tree. The staging
 * happens in a throwaway index, so a concurrent `git add`/commit by the user
 * cannot collide with the capture and the capture cannot clobber the user's
 * staged state. `excludes` are literal worktree-relative paths (oversize
 * files) that are never snapshotted.
 */
export async function captureWorktreeTree(
	worktreeRoot: string,
	options: { excludePaths?: string[]; signal?: AbortSignal } = {},
): Promise<string> {
	throwIfAborted(options.signal);
	const repo = requireRepo(worktreeRoot);
	const indexFile = path.join(os.tmpdir(), `omp-git-snapshot-index-${Snowflake.next()}`);
	try {
		return await repo.captureWorktreeTree(options.excludePaths ?? [], indexFile, options.signal);
	} finally {
		// The temp index and its lock are ours alone; leaking the pair would
		// waste disk for every capture over the process lifetime.
		await fs.rm(indexFile, { force: true }).catch(() => {});
		await fs.rm(`${indexFile}.lock`, { force: true }).catch(() => {});
	}
}

/**
 * Wrap a tree in a commit object (`git commit-tree`) without moving HEAD or
 * any branch. Author/committer identity is passed explicitly so the call
 * succeeds in repositories where the user has no configured `user.name` /
 * `user.email`.
 */
export async function commitTree(
	cwd: string,
	treeSha: string,
	options: { parents?: string[]; author?: CommitAuthor; message: string; signal?: AbortSignal },
): Promise<string> {
	throwIfAborted(options.signal);
	const repo = requireRepo(cwd);
	const author = options.author ?? { name: "oh-my-pi", email: "omp@localhost" };
	return repo.commitTreeObject(
		treeSha,
		options.parents ?? [],
		author.name,
		author.email,
		author.date ?? null,
		options.message,
		options.signal,
	);
}

/** `diff-tree --name-status -z` between two trees, parsed to entries. */
export async function treeStatus(
	cwd: string,
	baseTreeSha: string,
	targetTreeSha: string,
	options: { signal?: AbortSignal } = {},
): Promise<TreeDiffEntry[]> {
	throwIfAborted(options.signal);
	const repo = requireRepo(cwd);
	return parseTreeNameStatus(await repo.treeStatus(baseTreeSha, targetTreeSha, options.signal));
}

/** Refs under `prefix` with the object each points at. */
export async function refList(
	cwd: string,
	prefix: string,
	options: { signal?: AbortSignal } = {},
): Promise<{ refName: string; sha: string }[]> {
	throwIfAborted(options.signal);
	const repo = requireRepo(cwd);
	const refs: { refName: string; sha: string }[] = [];
	for (const line of await repo.checkpointRefList(prefix, options.signal)) {
		const [refName, sha] = line.split("\0");
		if (refName && sha) refs.push({ refName, sha });
	}
	return refs;
}

/**
 * Point `refName` at `sha`. Creates the ref when absent. Mutates repository
 * state: hold {@link withRepoLock} around the call.
 */
export async function refUpdate(cwd: string, refName: string, sha: string, signal?: AbortSignal): Promise<void> {
	throwIfAborted(signal);
	await requireRepo(cwd).checkpointRefUpdate(refName, sha, signal);
}

/**
 * Delete `refName`. Missing refs are not an error, so cleanup paths stay
 * idempotent. Mutates repository state: hold {@link withRepoLock} around the
 * call.
 */
export async function refDelete(cwd: string, refName: string, signal?: AbortSignal): Promise<void> {
	throwIfAborted(signal);
	await requireRepo(cwd).checkpointRefDelete(refName, signal);
}

/** Resolve a ref to its commit SHA, or `null` when it does not resolve. */
export async function refResolve(cwd: string, refName: string, signal?: AbortSignal): Promise<string | null> {
	throwIfAborted(signal);
	const repo = repoOrNull(cwd);
	if (!repo) return null;
	return (await repo.resolveRef(refName, signal)) ?? null;
}

/**
 * Every blob in a tree with its recorded object size (`ls-tree -r -l`). One
 * call answers "how many bytes does this snapshot represent", which is what
 * checkpoint disk accounting needs.
 */
export async function treeBlobs(
	cwd: string,
	treeish: string,
	options: { signal?: AbortSignal } = {},
): Promise<TreeBlobEntry[]> {
	throwIfAborted(options.signal);
	const repo = requireRepo(cwd);
	const raw = await repo.treeBlobsRaw(treeish, options.signal);
	const entries: TreeBlobEntry[] = [];
	for (const record of raw.split("\0")) {
		if (!record) continue;
		// "<mode> <type> <oid> <size>\t<path>"; size is "-" for non-blobs.
		const tabIndex = record.indexOf("\t");
		if (tabIndex < 0) continue;
		const fields = record.slice(0, tabIndex).split(/\s+/);
		const [, type, oid, rawSize] = fields;
		if (type !== "blob" || !oid) continue;
		const size = Number.parseInt(rawSize ?? "", 10);
		entries.push({ oid, path: record.slice(tabIndex + 1), size: Number.isFinite(size) ? size : 0 });
	}
	return entries;
}

/** Restore `files` from a tree-ish into both the working tree and the index. */
export async function restorePathsFromTree(
	cwd: string,
	treeish: string,
	files: readonly string[],
	options: { signal?: AbortSignal } = {},
): Promise<void> {
	throwIfAborted(options.signal);
	const repo = requireRepo(cwd);
	// The natives restore is pathset-shaped; batching keeps a rollback of a
	// multi-thousand-file change set inside any argument-list limit.
	const BATCH = 256;
	for (let index = 0; index < files.length; index += BATCH) {
		const batch = files.slice(index, index + BATCH);
		await repo.restore({ source: treeish, staged: true, worktree: true, files: [...batch] }, options.signal);
	}
}

export { withRepoLock };
