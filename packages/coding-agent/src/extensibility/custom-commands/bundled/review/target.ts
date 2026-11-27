import * as path from "node:path";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { errorMessage } from "@oh-my-pi/pi-utils";
import { parseReviewDiffSnapshot, type ReviewDiffSnapshot } from "./diff";

export type LocalReviewKind = "base-branch" | "uncommitted" | "commit";

/** One frozen diff: the annotation view and the reviewer prompt both read this snapshot. */
export interface ResolvedReviewTarget {
	/** `patch` is a caller-supplied diff (annotations API); `pr` (a PR/MR) never maps to the local checkout. */
	kind: LocalReviewKind | "pr" | "patch";
	mode: string;
	rawDiff: string;
	snapshot: ReviewDiffSnapshot;
	emptyMessage: string;
	filteredMessage?: string;
	diffInstruction?: string;
	contextInstruction?: string;
	/** Exact merge-base SHA for a local PR-style range. */
	rangeBase?: string;
	/** Exact head SHA for a local PR-style range. */
	rangeHead?: string;
	/** Base URL for per-file slices of the original, unfiltered PR/MR diff. */
	prDiffUrl?: string;
	/** Leading `?at=<generation>` when `prDiffUrl` is pinned, otherwise empty. */
	prDiffQuery?: string;
	/** Checkout root of a local review run outside the session cwd; diff paths are relative to it. */
	repository?: string;
}

export interface ReviewTargetUI {
	select(title: string, options: string[]): Promise<string | undefined>;
	notify(message: string, type?: "info" | "warning" | "error"): void;
}

export const LOCAL_REVIEW_CHOICES: ReadonlyArray<{ label: string; kind: LocalReviewKind }> = [
	{ label: "1. Review against a base branch (PR Style)", kind: "base-branch" },
	{ label: "2. Review uncommitted changes", kind: "uncommitted" },
	{ label: "3. Review a specific commit", kind: "commit" },
];

const GIT_UNCOMMITTED_DIFF_INSTRUCTION =
	"MUST run both `git diff -- <path>` and `git diff --cached -- <path>` for assigned files";
const JJ_UNCOMMITTED_DIFF_INSTRUCTION = "MUST run `jj --ignore-working-copy diff --git -- <path>` for assigned files";

export function createResolvedReviewTarget(
	kind: ResolvedReviewTarget["kind"],
	mode: string,
	rawDiff: string,
	emptyMessage: string,
	options: Pick<
		ResolvedReviewTarget,
		| "filteredMessage"
		| "diffInstruction"
		| "contextInstruction"
		| "rangeBase"
		| "rangeHead"
		| "prDiffUrl"
		| "prDiffQuery"
		| "repository"
	> = {},
): ResolvedReviewTarget {
	return {
		kind,
		mode,
		rawDiff,
		snapshot: parseReviewDiffSnapshot(rawDiff),
		emptyMessage,
		...options,
	};
}

export function getReviewTargetIssue(target: ResolvedReviewTarget): string | undefined {
	if (!target.rawDiff.trim()) return target.emptyMessage;
	if (target.snapshot.files.length === 0) {
		return target.filteredMessage ?? "No reviewable files (all changes filtered out)";
	}
	return undefined;
}

/** Checkout root for a review whose cwd differs from the session cwd; `undefined` when they match. */
export function reviewRepository(reviewCwd: string, sessionCwd: string): string | undefined {
	if (path.resolve(reviewCwd) === path.resolve(sessionCwd)) return undefined;
	return vcs.repo(reviewCwd)?.root() ?? reviewCwd;
}

/** Read staged + unstaged (or jj working-copy) changes; throws when no repository is available. */
export async function readUncommittedReviewTarget(cwd: string): Promise<ResolvedReviewTarget> {
	const repository = vcs.require(cwd);
	const diffText = await repository.uncommittedDiff([]);
	const isJj = repository.kind() === "jj";
	return createResolvedReviewTarget(
		"uncommitted",
		isJj ? "Reviewing JJ working-copy changes" : "Reviewing uncommitted changes (staged + unstaged)",
		diffText,
		isJj || !diffText.trim() ? "No uncommitted changes found" : "No diff content found",
		{ diffInstruction: isJj ? JJ_UNCOMMITTED_DIFF_INSTRUCTION : GIT_UNCOMMITTED_DIFF_INSTRUCTION },
	);
}

async function listGitBranches(cwd: string): Promise<string[]> {
	try {
		return await vcs.requireGit(cwd).listBranches(true);
	} catch {
		return [];
	}
}

async function currentGitBranch(cwd: string): Promise<string> {
	try {
		return (await vcs.git(cwd)?.currentBranch()) ?? "HEAD";
	} catch {
		return "HEAD";
	}
}

async function recentCommits(cwd: string, count: number): Promise<string[]> {
	try {
		return await vcs.require(cwd).logOnelines(count);
	} catch {
		return [];
	}
}

/** Resolve a PR-style `base...head` review target without any UI. */
export async function resolveBaseBranchTarget(
	cwd: string,
	baseRef: string,
	headRef = "HEAD",
	/** Headless review pins SHAs; interactive PR Style keeps its working-tree context. */
	options: { pinRange?: boolean } = {},
): Promise<ResolvedReviewTarget> {
	const base = baseRef.trim();
	const head = headRef.trim();
	if (!base) throw new Error("A base ref is required for PR-style review");
	if (!head) throw new Error("A head ref is required for PR-style review");
	const repository = vcs.requireGit(cwd);
	const [baseObject, headObject] = await Promise.all([repository.resolveRef(base), repository.resolveRef(head)]);
	if (!baseObject) throw new Error(`Cannot resolve base ref \`${base}\``);
	if (!headObject) throw new Error(`Cannot resolve head ref \`${head}\``);
	const [baseCommit, headCommit] = await Promise.all([
		repository.commitDetails(`${baseObject}^{commit}`),
		repository.commitDetails(`${headObject}^{commit}`),
	]);
	const baseSha = baseCommit.sha;
	const headSha = headCommit.sha;
	// Resolve both ends once, then diff the merge base to the frozen head SHA.
	// A branch moving during the review cannot change the reviewed patch.
	const mergeBase = await repository.mergeBase(baseSha, headSha);
	if (!mergeBase) throw new Error(`No common history between ${base} and ${head}`);
	const diffText = await repository.diffText({ base: mergeBase, head: headSha });
	const repositoryRoot = options.pinRange ? repository.info().repoRoot : undefined;
	const repositoryDir =
		repositoryRoot && path.resolve(repositoryRoot) !== path.resolve(cwd) ? repositoryRoot : undefined;
	return createResolvedReviewTarget(
		"base-branch",
		`Reviewing changes between \`${base}\` and \`${head}\` (PR-style)`,
		diffText,
		`No changes between ${base} and ${head}`,
		options.pinRange ? { rangeBase: mergeBase, rangeHead: headSha, repository: repositoryDir } : {},
	);
}

export async function resolveLocalReviewTarget(
	kind: LocalReviewKind,
	cwd: string,
	ui: ReviewTargetUI,
): Promise<ResolvedReviewTarget | undefined> {
	switch (kind) {
		case "base-branch": {
			const branches = await listGitBranches(cwd);
			if (branches.length === 0) {
				ui.notify("No git branches found", "error");
				return undefined;
			}
			const baseBranch = await ui.select("Select base branch to compare against", branches);
			if (!baseBranch) return undefined;
			const currentBranch = await currentGitBranch(cwd);
			try {
				return await resolveBaseBranchTarget(cwd, baseBranch, currentBranch);
			} catch (error) {
				const message = errorMessage(error);
				ui.notify(
					message.startsWith("No common history between ") ? message : `Failed to get diff: ${message}`,
					"error",
				);
				return undefined;
			}
		}
		case "uncommitted":
			try {
				return await readUncommittedReviewTarget(cwd);
			} catch (error) {
				ui.notify(`Failed to get diff: ${errorMessage(error)}`, "error");
				return undefined;
			}
		case "commit": {
			const commits = await recentCommits(cwd, 20);
			if (commits.length === 0) {
				ui.notify("No commits found", "error");
				return undefined;
			}
			const selectedCommit = await ui.select("Select commit to review", commits);
			if (!selectedCommit) return undefined;
			const hash = selectedCommit.split(" ")[0];
			let diffText: string;
			try {
				diffText = (await vcs.requireGit(cwd).showCommit(hash)).data.toString("utf8");
			} catch (error) {
				ui.notify(`Failed to get commit: ${errorMessage(error)}`, "error");
				return undefined;
			}
			return createResolvedReviewTarget(
				"commit",
				`Reviewing commit \`${hash}\``,
				diffText,
				"Commit has no diff content",
				{
					filteredMessage: "No reviewable files in commit (all changes filtered out)",
				},
			);
		}
	}
}
