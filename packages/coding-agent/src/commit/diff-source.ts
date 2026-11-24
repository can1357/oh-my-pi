import type { VcsDiffOptions, VcsGitRepo } from "@oh-my-pi/pi-natives";

/**
 * The changes a generated commit message describes, as `VcsDiffOptions` to spread
 * into `diffText`/`changedFiles`/`numstat`: the staged index against HEAD for a
 * new commit, or a snapshot of the staged index against HEAD's first parent when
 * amending.
 */
export type CommitDiffSource = Pick<VcsDiffOptions, "cached" | "base" | "head">;

/** Staged changes against HEAD: what a new commit will contain. */
export const STAGED_DIFF: CommitDiffSource = { cached: true };

/** Git's empty tree, the base when the amended commit is a root commit. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/**
 * Snapshot the staged index as a tree and diff it against HEAD's first parent, so
 * the message covers everything the amended commit will contain: HEAD's own
 * changes plus whatever is staged now. Writing the tree adds objects only; no ref
 * or index changes. Returns `null` when there is no commit to amend.
 */
export async function resolveAmendDiffSource(repo: VcsGitRepo): Promise<CommitDiffSource | null> {
	const head = await repo.headSha();
	if (!head) return null;
	const [details, tree] = await Promise.all([repo.commitDetails(head), repo.writeTree()]);
	return { base: details.parents[0] ?? EMPTY_TREE, head: tree };
}
