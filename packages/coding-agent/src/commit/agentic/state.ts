import type { VcsHunkSelection } from "@oh-my-pi/pi-natives";
import { type CommitDiffSource, STAGED_DIFF } from "../../commit/diff-source";
import type { CommitType, ConventionalAnalysis, ConventionalDetail, NumstatEntry } from "../../commit/types";

export interface GitOverviewSnapshot {
	files: string[];
	stat: string;
	numstat: NumstatEntry[];
	scopeCandidates: string;
	isWideScope: boolean;
	untrackedFiles?: string[];
	excludedFiles?: string[];
}

export interface CommitProposal {
	analysis: ConventionalAnalysis;
	summary: string;
	warnings: string[];
}

export type FileChange = VcsHunkSelection;

export interface SplitCommitGroup {
	changes: FileChange[];
	type: CommitType;
	scope: string | null;
	summary: string;
	details: ConventionalDetail[];
	issueRefs: string[];
	rationale?: string;
	dependencies: number[];
}

export interface SplitCommitPlan {
	commits: SplitCommitGroup[];
	warnings: string[];
}

export interface ChangelogProposal {
	entries: Array<{
		path: string;
		entries: Record<string, string[]>;
		deletions?: Record<string, string[]>;
	}>;
}

export interface CommitAgentState {
	overview?: GitOverviewSnapshot;
	proposal?: CommitProposal;
	splitProposal?: SplitCommitPlan;
	changelogProposal?: ChangelogProposal;
	diffCache?: Map<string, string>;
	diffText?: string;
	/** Changes the message describes; absent means the staged changes against HEAD. */
	diffSource?: CommitDiffSource;
}

/** Diff options for the tools' `staged` flag: the commit's changes, or the unstaged worktree. */
export function toolDiffOptions(state: CommitAgentState, staged: boolean): CommitDiffSource {
	return staged ? (state.diffSource ?? STAGED_DIFF) : {};
}
